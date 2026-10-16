import * as Schema from "effect/Schema";

export const MAX_VOICE_RECORDING_BYTES = 4 * 1024 * 1024;
export const VoiceTranscriptionInput = Schema.Struct({
  audio: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isMaxLength(Math.ceil(MAX_VOICE_RECORDING_BYTES / 3) * 4),
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
  mimeType: Schema.Literals(["audio/webm", "audio/ogg", "audio/mp4"]),
});
export type VoiceTranscriptionInput = typeof VoiceTranscriptionInput.Type;
export const VoiceTranscriptionFailure = Schema.Literals([
  "not-configured",
  "invalid-audio",
  "credentials",
  "rate-limit",
  "unavailable",
  "empty",
]);
export const VoiceTranscriptionResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("transcribed"), text: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), reason: VoiceTranscriptionFailure }),
]);
export type VoiceTranscriptionResult = typeof VoiceTranscriptionResult.Type;
