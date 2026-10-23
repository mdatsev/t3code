import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  type VoiceDiagnosticsInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import { ServerConfig } from "../config.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

export const VOICE_DIAGNOSTICS_LOG_FILE = "voice-diagnostics.ndjson";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const voice = yield* VoiceTranscription.VoiceTranscription;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const diagnosticsLogPath = path.join(config.logsDir, VOICE_DIAGNOSTICS_LOG_FILE);
    const recordDiagnostics = (payload: VoiceDiagnosticsInput) =>
      Effect.gen(function* () {
        const receivedAt = DateTime.formatIso(yield* DateTime.now);
        const lines = payload.events.map((event) =>
          JSON.stringify({
            receivedAt,
            sessionId: payload.sessionId,
            ...(payload.userAgent ? { userAgent: payload.userAgent } : {}),
            ...event,
          }),
        );
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        yield* fs.writeFileString(diagnosticsLogPath, `${lines.join("\n")}\n`, { flag: "a" });
        yield* Effect.logInfo("voice diagnostics", {
          sessionId: payload.sessionId,
          events: payload.events.map((event) => event.event).join(","),
        });
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Could not save voice diagnostics.", cause)),
      );
    return handlers
      .handle(
        "transcribe",
        Effect.fnUntraced(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* voice.transcribe(payload).pipe(
            Effect.map((text) => ({ status: "transcribed" as const, text })),
            Effect.catchTags({
              VoiceTranscriptionError: ({ reason }) =>
                Effect.succeed({ status: "failed" as const, reason }),
            }),
          );
        }),
      )
      .handle(
        "recordingOutcome",
        Effect.fnUntraced(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* voice.recordOutcome(payload);
        }),
      )
      .handle(
        "diagnostics",
        Effect.fnUntraced(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* recordDiagnostics(payload);
        }),
      );
  }),
);
