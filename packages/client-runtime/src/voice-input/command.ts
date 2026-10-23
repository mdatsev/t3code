import type {
  VoiceDiagnosticsInput,
  VoiceRecordingOutcomeInput,
  VoiceTranscriptionInput,
} from "@t3tools/contracts";
import { createEnvironmentCommand } from "../state/runtime.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelayDpopSigner from "../relay/managedRelay.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Atom from "effect/reactivity/Atom";

export function createVoiceTranscriptionCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:voice:transcribe",
    execute: (input: { recording: VoiceTranscriptionInput; signal: AbortSignal }) =>
      Effect.gen(function* () {
        if (input.signal.aborted) return yield* Effect.interrupt;
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: "The environment is not connected.",
          });
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          prepared: prepared.value,
          signer: yield* Effect.serviceOption(ManagedRelayDpopSigner.ManagedRelayDpopSigner),
          remoteAuthorization: yield* Effect.serviceOption(
            RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          ),
          group: "voice",
          method: "POST",
          url: (urls) => urls.transcribe(),
          timeoutMs: 100_000,
          request: ({ client, headers }) =>
            client.transcribe({ payload: input.recording, headers }),
        }).pipe(
          Effect.raceFirst(
            Effect.callback<never>((resume) => {
              const cancel = () => resume(Effect.interrupt);
              input.signal.addEventListener("abort", cancel, { once: true });
              if (input.signal.aborted) cancel();
              return Effect.sync(() => input.signal.removeEventListener("abort", cancel));
            }),
          ),
        );
      }),
  });
}

export function createVoiceRecordingOutcomeCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:voice:recording-outcome",
    execute: (input: VoiceRecordingOutcomeInput) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: "The environment is not connected.",
          });
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          prepared: prepared.value,
          signer: yield* Effect.serviceOption(ManagedRelayDpopSigner.ManagedRelayDpopSigner),
          remoteAuthorization: yield* Effect.serviceOption(
            RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          ),
          group: "voice",
          method: "POST",
          url: (urls) => urls.recordingOutcome(),
          timeoutMs: 30_000,
          request: ({ client, headers }) => client.recordingOutcome({ payload: input, headers }),
        });
      }),
  });
}

export function createVoiceDiagnosticsCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:voice:diagnostics",
    execute: (input: VoiceDiagnosticsInput) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: "The environment is not connected.",
          });
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          prepared: prepared.value,
          signer: yield* Effect.serviceOption(ManagedRelayDpopSigner.ManagedRelayDpopSigner),
          remoteAuthorization: yield* Effect.serviceOption(
            RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          ),
          group: "voice",
          method: "POST",
          url: (urls) => urls.diagnostics(),
          timeoutMs: 30_000,
          request: ({ client, headers }) => client.diagnostics({ payload: input, headers }),
        });
      }),
  });
}
