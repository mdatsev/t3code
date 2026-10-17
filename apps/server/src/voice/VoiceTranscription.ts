import {
  MAX_VOICE_RECORDING_BYTES,
  VoiceTranscriptionFailure,
  type VoiceTranscriptionInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerSettings from "../serverSettings.ts";

export class VoiceTranscriptionError extends Schema.TaggedError<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  { reason: VoiceTranscriptionFailure },
) {}

const Transcript = Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(100_000)) });
const decodeTranscript = HttpClientResponse.schemaBodyJson(Transcript);

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly transcribe: (
      input: VoiceTranscriptionInput,
    ) => Effect.Effect<string, VoiceTranscriptionError>;
  }
>()("t3/voice/VoiceTranscription") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  const semaphore = yield* Semaphore.make(1);
  // No retries: repeating a transcription can incur another charge.
  const transcribe = (input: VoiceTranscriptionInput) =>
    Effect.gen(function* () {
      const config = yield* settings.getSettings.pipe(
        Effect.mapError(() => new VoiceTranscriptionError({ reason: "unavailable" })),
      );
      if (!config.voiceInput.apiKey)
        return yield* new VoiceTranscriptionError({ reason: "not-configured" });
      const bytes = Buffer.from(input.audio, "base64");
      if (
        !bytes.length ||
        bytes.length > MAX_VOICE_RECORDING_BYTES ||
        bytes.toString("base64") !== input.audio
      ) {
        return yield* new VoiceTranscriptionError({ reason: "invalid-audio" });
      }
      const form = new FormData();
      form.set(
        "file",
        new Blob([bytes], { type: input.mimeType }),
        `recording.${input.mimeType.split("/")[1]}`,
      );
      form.set("model_id", "scribe_v2");
      form.set("tag_audio_events", "false");
      form.set("diarize", "false");
      form.set("timestamps_granularity", "none");
      if (config.voiceInput.language) form.set("language_code", config.voiceInput.language);
      const response = yield* http
        .execute(
          HttpClientRequest.post("https://api.elevenlabs.io/v1/speech-to-text").pipe(
            HttpClientRequest.setHeader("xi-api-key", config.voiceInput.apiKey),
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
      return transcript.text.trim();
    }).pipe(
      semaphore.withPermits(1),
      Effect.timeoutOrElse({
        duration: "90 seconds",
        orElse: () => Effect.fail(new VoiceTranscriptionError({ reason: "unavailable" })),
      }),
    );
  return VoiceTranscription.of({ transcribe });
});

export const layer = Layer.effect(VoiceTranscription, make);
