import {
  createVoiceDiagnosticsCommand,
  createVoiceRecordingOutcomeCommand,
  createVoiceTranscriptionCommand,
} from "@t3tools/client-runtime/voice-input";
import { connectionAtomRuntime } from "../connection/runtime";

export const transcribeVoice = createVoiceTranscriptionCommand(connectionAtomRuntime);
export const reportVoiceRecordingOutcome =
  createVoiceRecordingOutcomeCommand(connectionAtomRuntime);
export const reportVoiceDiagnostics = createVoiceDiagnosticsCommand(connectionAtomRuntime);
