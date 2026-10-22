import {
  type VoiceRecordingOutcomeInput,
  MAX_VOICE_RECORDING_BYTES,
  VoiceTranscriptionFailure,
  type VoiceTranscriptionInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerSettings from "../serverSettings.ts";
import * as VoiceRecordingArchive from "./VoiceRecordingArchive.ts";

export class VoiceTranscriptionError extends Schema.TaggedError<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  { reason: VoiceTranscriptionFailure },
) {}

const Transcript = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(100_000)),
  language_code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  language_probability: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const PROVIDER = "elevenlabs";
const MODEL = "scribe_v2";
const decodeTranscript = HttpClientResponse.schemaBodyJson(Transcript);

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly transcribe: (
      input: VoiceTranscriptionInput,
    ) => Effect.Effect<string, VoiceTranscriptionError>;
    readonly recordOutcome: (input: VoiceRecordingOutcomeInput) => Effect.Effect<void>;
  }
>()("t3/voice/VoiceTranscription") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  const archive = yield* VoiceRecordingArchive.VoiceRecordingArchive;
  const semaphore = yield* Semaphore.make(1);
  // No retries: repeating a transcription can incur another charge.
  const transcribe = (input: VoiceTranscriptionInput) =>
    Effect.gen(function* () {
      const config = yield* settings.getSettings.pipe(
        Effect.mapError(() => new VoiceTranscriptionError({ reason: "unavailable" })),
      );
      const bytes = Buffer.from(input.audio, "base64");
      if (
        !bytes.length ||
        bytes.length > MAX_VOICE_RECORDING_BYTES ||
        bytes.toString("base64") !== input.audio
      ) {
        return yield* new VoiceTranscriptionError({ reason: "invalid-audio" });
      }
      const language = config.voiceInput.language || null;
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const result = yield* requestTranscript(
        bytes,
        input,
        config.voiceInput.apiKey,
        language,
      ).pipe(
        Effect.timeoutOrElse({
          duration: "90 seconds",
          orElse: () => Effect.fail(new VoiceTranscriptionError({ reason: "unavailable" })),
        }),
        Effect.result,
      );
      const finishedAt = DateTime.formatIso(yield* DateTime.now);
      yield* archive.recordAttempt(input, bytes, {
        provider: PROVIDER,
        model: MODEL,
        requestedLanguage: language,
        startedAt,
        finishedAt,
        ...(result._tag === "Success"
          ? {
              status: "transcribed",
              text: result.success.text,
              failureReason: null,
              detectedLanguage: result.success.language_code ?? null,
              languageProbability: result.success.language_probability ?? null,
            }
          : {
              status: "failed",
              text: null,
              failureReason: result.failure.reason,
              detectedLanguage: null,
              languageProbability: null,
            }),
      });
      if (result._tag === "Failure") return yield* result.failure;
      return result.success.text;
    }).pipe(semaphore.withPermits(1));
  const requestTranscript = (
    bytes: Buffer,
    input: VoiceTranscriptionInput,
    apiKey: string,
    language: string | null,
  ) =>
    Effect.gen(function* () {
      if (!apiKey) return yield* new VoiceTranscriptionError({ reason: "not-configured" });
      const form = new FormData();
      form.set(
        "file",
        new Blob([bytes], { type: input.mimeType }),
        `recording.${input.mimeType.split("/")[1]}`,
      );
      form.set("model_id", MODEL);
      form.set("tag_audio_events", "false");
      form.set("diarize", "false");
      form.set("timestamps_granularity", "none");
      if (language) form.set("language_code", language);
      const response = yield* http
        .execute(
          HttpClientRequest.post("https://api.elevenlabs.io/v1/speech-to-text").pipe(
            HttpClientRequest.setHeader("xi-api-key", apiKey),
            HttpClientRequest.bodyFormData(form),
          ),
        )
        .pipe(Effect.mapError(() => new VoiceTranscriptionError({ reason: "unavailable" })));
      if (response.status === 401 || response.status === 403)
        return yield* new VoiceTranscriptionError({ reason: "credentials" });
      if (response.status === 429)
        return yield* new VoiceTranscriptionError({ reason: "rate-limit" });
      if (response.status === 400 || response.status === 422)
        return yield* new VoiceTranscriptionError({ reason: "invalid-audio" });
      if (response.status < 200 || response.status >= 300)
        return yield* new VoiceTranscriptionError({ reason: "unavailable" });
      const transcript = yield* decodeTranscript(response).pipe(
        Effect.mapError(() => new VoiceTranscriptionError({ reason: "unavailable" })),
      );
      if (!transcript.text.trim()) return yield* new VoiceTranscriptionError({ reason: "empty" });
      return { ...transcript, text: transcript.text.trim() };
    });
  return VoiceTranscription.of({ transcribe, recordOutcome: archive.recordOutcome });
});

export const layer = Layer.effect(VoiceTranscription, make).pipe(
  Layer.provide(VoiceRecordingArchive.layer),
);
