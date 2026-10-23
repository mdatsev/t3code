import type { VoiceDiagnosticEvent, VoiceDiagnosticsInput } from "@t3tools/contracts";
import { randomUUID } from "../lib/utils";

export type VoiceDiagnosticDetails = Record<string, string | number | boolean | null>;
export type VoiceDiagnosticLogger = (event: string, details?: VoiceDiagnosticDetails) => void;

const MAX_QUEUED_EVENTS = 199;

function shortDeviceId(deviceId: string | undefined): string | null {
  if (!deviceId) return null;
  if (deviceId === "default" || deviceId === "communications") return deviceId;
  return deviceId.slice(0, 8);
}

export function describeTrack(track: MediaStreamTrack | undefined): VoiceDiagnosticDetails {
  if (!track) return { track: null };
  const settings = track.getSettings();
  return {
    label: track.label || null,
    kind: track.kind,
    readyState: track.readyState,
    muted: track.muted,
    enabled: track.enabled,
    deviceId: shortDeviceId(settings.deviceId),
    sampleRate: settings.sampleRate ?? null,
    channelCount: settings.channelCount ?? null,
    echoCancellation:
      typeof settings.echoCancellation === "boolean" ? settings.echoCancellation : null,
    noiseSuppression: settings.noiseSuppression ?? null,
    autoGainControl: settings.autoGainControl ?? null,
  };
}

export function describeDevices(devices: ReadonlyArray<MediaDeviceInfo>): VoiceDiagnosticDetails {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  return {
    audioInputCount: inputs.length,
    audioOutputCount: devices.filter((device) => device.kind === "audiooutput").length,
    audioInputs: inputs
      .map((device) => `${device.label || "(no label)"} [${shortDeviceId(device.deviceId)}]`)
      .join(" | ")
      .slice(0, 2_000),
  };
}

export function describeError(error: unknown): VoiceDiagnosticDetails {
  if (error instanceof DOMException || error instanceof Error) {
    const constraint =
      "constraint" in error && typeof error.constraint === "string" ? error.constraint : null;
    return { errorName: error.name, errorMessage: error.message.slice(0, 500), constraint };
  }
  return { errorName: typeof error, errorMessage: String(error).slice(0, 500) };
}

export async function microphonePermissionState(): Promise<string> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.name : String(error)}`;
  }
}

export class VoiceDiagnosticsQueue {
  private sessionId = randomUUID();
  private events: VoiceDiagnosticEvent[] = [];
  private dropped = 0;

  constructor(private readonly send: (input: VoiceDiagnosticsInput) => void) {}

  startSession() {
    this.flush();
    this.sessionId = randomUUID();
  }

  readonly log = (event: string, details?: VoiceDiagnosticDetails, recordingId?: string) => {
    if (this.events.length >= MAX_QUEUED_EVENTS) {
      this.dropped += 1;
      return;
    }
    this.events.push({
      at: new Date().toISOString(),
      event: event.slice(0, 64),
      ...(recordingId ? { recordingId } : {}),
      ...(details ? { details } : {}),
    });
  };

  flush() {
    if (this.dropped) {
      this.events.push({
        at: new Date().toISOString(),
        event: "diagnostics.dropped",
        details: { count: this.dropped },
      });
      this.dropped = 0;
    }
    if (!this.events.length) return;
    const events = this.events;
    this.events = [];
    this.send({
      sessionId: this.sessionId,
      userAgent: navigator.userAgent.slice(0, 512),
      events,
    });
  }
}
