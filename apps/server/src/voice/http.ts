import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const voice = yield* VoiceTranscription.VoiceTranscription;
    return handlers.handle(
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
    );
  }),
);
