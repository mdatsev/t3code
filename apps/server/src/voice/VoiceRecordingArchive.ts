import type { VoiceRecordingOutcomeInput, VoiceTranscriptionInput } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../config.ts";

export type VoiceTranscriptionAttempt = {
  readonly provider: string;
  readonly model: string;
  readonly requestedLanguage: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "transcribed" | "failed";
  readonly text: string | null;
  readonly failureReason: string | null;
  readonly detectedLanguage: string | null;
  readonly languageProbability: number | null;
};

type RecordingMetadata = {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly audioFile: string;
  readonly mimeType: string;
  readonly audioBytes: number;
  readonly durationMs: number | null;
  readonly microphone: string | null;
  readonly threadId: string | null;
  readonly draftKey: string | null;
  readonly attempts: ReadonlyArray<VoiceTranscriptionAttempt>;
  readonly outcome: {
    readonly sentAt: string;
    readonly sentText: string;
    readonly transcriptSentUnedited: boolean;
  } | null;
};

const AUDIO_EXTENSIONS = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a" } as const;

export class VoiceRecordingArchive extends Context.Service<
  VoiceRecordingArchive,
  {
    readonly directory: string | null;
    readonly recordAttempt: (
      input: VoiceTranscriptionInput,
      audio: Uint8Array,
      attempt: VoiceTranscriptionAttempt,
    ) => Effect.Effect<void>;
    readonly recordOutcome: (input: VoiceRecordingOutcomeInput) => Effect.Effect<void>;
  }
>()("t3/voice/VoiceRecordingArchive") {}

const make = Effect.gen(function* () {
  const enabled = yield* Config.Boolean("T3CODE_VOICE_RECORDINGS").pipe(Config.withDefault(false));
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const semaphore = yield* Semaphore.make(1);
  const directory = path.join(config.stateDir, "voice-recordings");

  const metadataPath = (id: string) => path.join(directory, `${id}.json`);
  const readMetadata = (id: string) =>
    fs.readFileString(metadataPath(id)).pipe(
      Effect.map((contents) => JSON.parse(contents) as RecordingMetadata),
      Effect.orElseSucceed(() => null),
    );
  const writeMetadata = (metadata: RecordingMetadata) =>
    writeFileStringAtomically({
      filePath: metadataPath(metadata.id),
      contents: `${JSON.stringify(metadata, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const logFailure = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.asVoid,
      semaphore.withPermits(1),
      Effect.catchCause((cause) => Effect.logWarning("Could not save voice recording.", cause)),
    );

  const recordAttempt = (
    input: VoiceTranscriptionInput,
    audio: Uint8Array,
    attempt: VoiceTranscriptionAttempt,
  ) => {
    const recording = input.recording;
    if (!enabled || !recording) return Effect.void;
    return logFailure(
      Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true });
        const existing = yield* readMetadata(recording.id);
        const audioFile =
          existing?.audioFile ?? `${recording.id}.${AUDIO_EXTENSIONS[input.mimeType]}`;
        if (!(yield* fs.exists(path.join(directory, audioFile)))) {
          yield* fs.writeFile(path.join(directory, audioFile), audio);
        }
        yield* writeMetadata({
          version: 1,
          id: recording.id,
          createdAt: existing?.createdAt ?? attempt.startedAt,
          audioFile,
          mimeType: input.mimeType,
          audioBytes: audio.byteLength,
          durationMs: recording.durationMs ?? existing?.durationMs ?? null,
          microphone: recording.microphone ?? existing?.microphone ?? null,
          threadId: recording.threadId ?? existing?.threadId ?? null,
          draftKey: recording.draftKey ?? existing?.draftKey ?? null,
          attempts: [...(existing?.attempts ?? []), attempt],
          outcome: existing?.outcome ?? null,
        });
      }),
    );
  };

  const recordOutcome = (input: VoiceRecordingOutcomeInput) => {
    if (!enabled) return Effect.void;
    return logFailure(
      Effect.gen(function* () {
        const sentAt = DateTime.formatIso(yield* DateTime.now);
        yield* Effect.forEach(
          input.recordingIds,
          (id) =>
            Effect.gen(function* () {
              const existing = yield* readMetadata(id);
              if (!existing) return;
              const transcript = existing.attempts.findLast(
                (attempt) => attempt.status === "transcribed",
              )?.text;
              yield* writeMetadata({
                ...existing,
                outcome: {
                  sentAt,
                  sentText: input.sentText,
                  transcriptSentUnedited: transcript ? input.sentText.includes(transcript) : false,
                },
              });
            }),
          { discard: true },
        );
      }),
    );
  };

  return VoiceRecordingArchive.of({
    directory: enabled ? directory : null,
    recordAttempt,
    recordOutcome,
  });
});

export const layer = Layer.effect(VoiceRecordingArchive, make);
