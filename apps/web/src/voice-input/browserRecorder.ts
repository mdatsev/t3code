import { MAX_VOICE_RECORDING_BYTES } from "@t3tools/contracts";
import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
import {
  describeDevices,
  describeError,
  describeTrack,
  microphonePermissionState,
  type VoiceDiagnosticLogger,
} from "./voiceDiagnostics";

const EXTERNAL_MICROPHONE = /bluetooth|hands-?free|headset|airpods|buds|\bcar\b|\bsco\b/i;
const BUILT_IN_MICROPHONE = /speakerphone|earpiece|built-?in|internal/i;

function isExternalMicrophone(label: string): boolean {
  return EXTERNAL_MICROPHONE.test(label) && !BUILT_IN_MICROPHONE.test(label);
}

const UNPROCESSED_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} satisfies MediaTrackConstraints;

async function openPhoneMicrophone(log: VoiceDiagnosticLogger): Promise<MediaStream> {
  log("getUserMedia.request", { constraints: JSON.stringify({ audio: UNPROCESSED_AUDIO }) });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: UNPROCESSED_AUDIO });
  const current = stream.getAudioTracks()[0];
  log("getUserMedia.opened", describeTrack(current));
  const devices = await navigator.mediaDevices.enumerateDevices().catch((error: unknown) => {
    log("enumerateDevices.error", describeError(error));
    return [];
  });
  log("devices", describeDevices(devices));
  const inputs = devices.filter((device) => device.kind === "audioinput" && device.label);
  const usesExternal =
    isExternalMicrophone(current?.label ?? "") ||
    inputs.some((device) => isExternalMicrophone(device.label));
  log("microphone.route", {
    externalDetected: usesExternal,
    currentIsExternal: isExternalMicrophone(current?.label ?? ""),
  });
  if (!usesExternal) return stream;
  const candidates = inputs.filter(
    (device) =>
      !isExternalMicrophone(device.label) &&
      device.deviceId !== "default" &&
      device.deviceId !== "communications",
  );
  const preferred =
    candidates.find((device) => /speakerphone/i.test(device.label)) ??
    candidates.find((device) => BUILT_IN_MICROPHONE.test(device.label)) ??
    candidates[0];
  log("microphone.preferred", {
    label: preferred?.label ?? null,
    alreadyInUse: preferred ? preferred.deviceId === current?.getSettings().deviceId : null,
    candidates: candidates.map((device) => device.label).join(" | "),
  });
  if (!preferred || preferred.deviceId === current?.getSettings().deviceId) return stream;
  try {
    const phoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { ...UNPROCESSED_AUDIO, deviceId: { exact: preferred.deviceId } },
    });
    stream.getTracks().forEach((track) => track.stop());
    log("microphone.switched", describeTrack(phoneStream.getAudioTracks()[0]));
    return phoneStream;
  } catch (error) {
    log("microphone.switchFailed", describeError(error));
    return stream;
  }
}

const SILENCE_PEAK = 0.0005;
const SILENCE_WARNING_MS = 2500;

export type MicrophoneDiagnostics = {
  readonly onMicrophone: (label: string | null) => void;
  readonly onProblem: (problem: string | null) => void;
  readonly onEvent: VoiceDiagnosticLogger;
};

function microphoneOpenProblem(error: unknown): string | null {
  const name = error instanceof DOMException ? error.name : null;
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError")
    return "The microphone is busy or unavailable. Close other apps or keyboards using it and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No microphone was found.";
  return null;
}

/** Owns the microphone even when permission resolves after cancellation. */
export class BrowserVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  durationMs: number | null = null;
  private startedAt = 0;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private failed = false;
  private started = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = Promise.resolve();
  private resolveStopped = () => {};
  private stopMonitor = () => {};

  constructor(
    private readonly onStatus: (status: VoiceRecorderStatus) => void,
    private readonly diagnostics: MicrophoneDiagnostics = {
      onMicrophone: () => {},
      onProblem: () => {},
      onEvent: () => {},
    },
  ) {}

  async requestPermission() {
    const generation = ++this.generation;
    const log = this.diagnostics.onEvent;
    const visibility = document.visibilityState;
    void microphonePermissionState().then((state) => log("permission", { state, visibility }));
    try {
      const stream = await openPhoneMicrophone(log);
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return { granted: false, canAskAgain: true };
      }
      this.stream = stream;
      this.diagnostics.onMicrophone(stream.getAudioTracks()[0]?.label || null);
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("mute", () => {
          log("track.mute", describeTrack(track));
          this.diagnostics.onProblem(
            "The microphone was muted by the system or another app. Nothing is being recorded.",
          );
        });
        track.addEventListener("unmute", () => {
          log("track.unmute", describeTrack(track));
          this.diagnostics.onProblem(null);
        });
        track.addEventListener(
          "ended",
          () => {
            log("track.ended", { recorderState: this.recorder?.state ?? null });
            if (this.recorder?.state === "recording" && this.recorder.stream === stream) {
              void this.stop().catch(() => {});
              return;
            }
            this.onStatus({
              isFinished: false,
              hasError: true,
              error: "The microphone disconnected.",
              url: null,
            });
          },
          { once: true },
        );
      }
      return { granted: true, canAskAgain: true };
    } catch (error) {
      log("getUserMedia.error", describeError(error));
      const problem = microphoneOpenProblem(error);
      if (problem) {
        this.diagnostics.onProblem(problem);
        throw error;
      }
      return { granted: false, canAskAgain: true };
    }
  }

  async prepareToRecordAsync() {
    if (!this.stream) throw new Error("Microphone unavailable.");
    this.chunks = [];
    this.bytes = 0;
    this.failed = false;
    this.started = false;
    this.uri = null;
    const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (!mimeType) throw new Error("This browser cannot record supported audio.");
    const recorder = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 64_000 });
    this.recorder = recorder;
    const log = this.diagnostics.onEvent;
    log("recorder.prepared", { mimeType, state: recorder.state });
    for (const type of ["start", "pause", "resume"] as const) {
      recorder.addEventListener(type, () => log(`recorder.${type}`, { state: recorder.state }));
    }
    this.stopped = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });
    recorder.addEventListener("dataavailable", ({ data }) => {
      this.bytes += data.size;
      if (this.bytes > MAX_VOICE_RECORDING_BYTES) {
        this.failed = true;
        this.onStatus({
          isFinished: false,
          hasError: true,
          error: "The recording is too large. Try a shorter recording.",
          url: null,
        });
        return;
      }
      if (data.size) this.chunks.push(data);
    });
    recorder.addEventListener("error", (event) => {
      log("recorder.error", {
        state: recorder.state,
        ...describeError((event as Event & { error?: unknown }).error ?? event.type),
      });
      this.failed = true;
      this.onStatus({
        isFinished: false,
        hasError: true,
        error: "Voice recording was interrupted.",
        url: null,
      });
    });
    recorder.addEventListener(
      "stop",
      () => {
        clearTimeout(this.timer);
        this.durationMs = Date.now() - this.startedAt;
        log("recorder.stop", {
          durationMs: this.durationMs,
          bytes: this.bytes,
          chunks: this.chunks.length,
          failed: this.failed,
          visibility: document.visibilityState,
        });
        this.uri = URL.createObjectURL(new Blob(this.chunks, { type: mimeType }));
        this.chunks = [];
        this.releaseMicrophone();
        this.resolveStopped();
        this.onStatus({
          isFinished: true,
          hasError: this.failed,
          error: this.failed ? "Could not finish this recording." : null,
          url: this.uri,
        });
      },
      { once: true },
    );
  }

  record({ forDuration }: { forDuration: number }) {
    if (!this.recorder) throw new Error("Recorder not prepared.");
    this.recorder.start(1000);
    this.started = true;
    this.startedAt = Date.now();
    this.durationMs = null;
    this.monitorSilence(this.recorder.stream);
    this.timer = setTimeout(() => {
      void this.stop().catch(() => {});
    }, forDuration * 1000);
  }

  private monitorSilence(stream: MediaStream) {
    this.stopMonitor();
    const log = this.diagnostics.onEvent;
    const AudioContextClass = globalThis.AudioContext;
    if (!AudioContextClass) {
      log("audio.monitorUnavailable", { reason: "no AudioContext" });
      return;
    }
    let context: AudioContext;
    try {
      context = new AudioContextClass();
    } catch (error) {
      log("audio.monitorUnavailable", describeError(error));
      return;
    }
    log("audio.monitorStart", { contextState: context.state, sampleRate: context.sampleRate });
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let silentSince = Date.now();
    let warned = false;
    const level = {
      windows: 0,
      suspendedWindows: 0,
      zeroWindows: 0,
      quietWindows: 0,
      maxPeak: 0,
      sumSquares: 0,
      sampleCount: 0,
    };
    const interval = setInterval(() => {
      if (context.state !== "running") {
        level.suspendedWindows += 1;
        silentSince = Date.now();
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) {
        peak = Math.max(peak, Math.abs(sample));
        level.sumSquares += sample * sample;
      }
      level.windows += 1;
      level.sampleCount += samples.length;
      level.maxPeak = Math.max(level.maxPeak, peak);
      if (peak === 0) level.zeroWindows += 1;
      if (peak <= SILENCE_PEAK) level.quietWindows += 1;
      if (peak > SILENCE_PEAK) {
        silentSince = Date.now();
        if (warned) {
          warned = false;
          this.diagnostics.onProblem(null);
        }
      } else if (!warned && Date.now() - silentSince >= SILENCE_WARNING_MS) {
        warned = true;
        log("audio.silenceWarning", { peak, digitalSilence: peak === 0 });
        this.diagnostics.onProblem(
          "The microphone is silent. Another app may be using it, or the wrong microphone is selected.",
        );
      }
    }, 250);
    void context.resume().catch(() => {});
    this.stopMonitor = () => {
      clearInterval(interval);
      const toDb = (value: number) =>
        value > 0 ? Math.round(20 * Math.log10(value) * 10) / 10 : null;
      log("audio.level", {
        contextState: context.state,
        windows: level.windows,
        suspendedWindows: level.suspendedWindows,
        zeroWindows: level.zeroWindows,
        quietWindows: level.quietWindows,
        maxPeakDb: toDb(level.maxPeak),
        rmsDb: level.sampleCount ? toDb(Math.sqrt(level.sumSquares / level.sampleCount)) : null,
        digitalSilence: level.windows > 0 && level.zeroWindows === level.windows,
      });
      void context.close().catch(() => {});
      this.stopMonitor = () => {};
    };
  }

  async stop() {
    this.stopMonitor();
    clearTimeout(this.timer);
    if (!this.recorder || !this.started) return;
    if (this.recorder.state !== "inactive") this.recorder.stop();
    await this.stopped;
    if (this.failed) throw new Error("Could not finish this recording.");
  }

  releaseMicrophone() {
    this.stopMonitor();
    ++this.generation;
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
  }
}
