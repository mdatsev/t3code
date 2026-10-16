import { createVoiceTranscriptionCommand } from "@t3tools/client-runtime/voice-input";
import { connectionAtomRuntime } from "../connection/runtime";

export const transcribeVoice = createVoiceTranscriptionCommand(connectionAtomRuntime);
