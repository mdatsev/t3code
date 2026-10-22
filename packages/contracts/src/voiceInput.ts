import * as Schema from "effect/Schema";

export const MAX_VOICE_RECORDING_BYTES = 4 * 1024 * 1024;
export const VoiceRecordingId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{8,64}$/));
export const VoiceRecordingContext = Schema.Struct({
  id: VoiceRecordingId,
  threadId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  draftKey: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  microphone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  durationMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type VoiceRecordingContext = typeof VoiceRecordingContext.Type;
export const VoiceRecordingOutcomeInput = Schema.Struct({
  recordingIds: Schema.Array(VoiceRecordingId).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  sentText: Schema.String.check(Schema.isMaxLength(200_000)),
});
export type VoiceRecordingOutcomeInput = typeof VoiceRecordingOutcomeInput.Type;
export const VoiceTranscriptionInput = Schema.Struct({
  audio: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isMaxLength(Math.ceil(MAX_VOICE_RECORDING_BYTES / 3) * 4),
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
  mimeType: Schema.Literals(["audio/webm", "audio/ogg", "audio/mp4"]),
  recording: Schema.optionalKey(VoiceRecordingContext),
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
