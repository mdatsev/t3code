import { MAX_VOICE_RECORDING_BYTES } from "@t3tools/contracts";
import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";

const EXTERNAL_MICROPHONE = /bluetooth|hands-?free|headset|airpods|buds|\bcar\b|\bsco\b/i;
const BUILT_IN_MICROPHONE = /speakerphone|earpiece|built-?in|internal/i;

function isExternalMicrophone(label: string): boolean {
  return EXTERNAL_MICROPHONE.test(label) && !BUILT_IN_MICROPHONE.test(label);
}

async function openPhoneMicrophone(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const current = stream.getAudioTracks()[0];
  const inputs = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(
    (device) => device.kind === "audioinput" && device.label,
  );
  const usesExternal =
    isExternalMicrophone(current?.label ?? "") ||
    inputs.some((device) => isExternalMicrophone(device.label));
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
  if (!preferred || preferred.deviceId === current?.getSettings().deviceId) return stream;
  try {
    const phoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: preferred.deviceId } },
    });
    stream.getTracks().forEach((track) => track.stop());
    return phoneStream;
  } catch {
    return stream;
  }
}

const SILENCE_PEAK = 0.0005;
const SILENCE_WARNING_MS = 2500;

export type MicrophoneDiagnostics = {
  readonly onMicrophone: (label: string | null) => void;
  readonly onProblem: (problem: string | null) => void;
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
    },
  ) {}

  async requestPermission() {
    const generation = ++this.generation;
    try {
      const stream = await openPhoneMicrophone();
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return { granted: false, canAskAgain: true };
      }
      this.stream = stream;
      this.diagnostics.onMicrophone(stream.getAudioTracks()[0]?.label || null);
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("mute", () =>
          this.diagnostics.onProblem(
            "The microphone was muted by the system or another app. Nothing is being recorded.",
          ),
        );
        track.addEventListener("unmute", () => this.diagnostics.onProblem(null));
        track.addEventListener(
          "ended",
          () => {
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
    recorder.addEventListener("error", () => {
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
    this.monitorSilence(this.recorder.stream);
    this.timer = setTimeout(() => {
      void this.stop().catch(() => {});
    }, forDuration * 1000);
  }

  private monitorSilence(stream: MediaStream) {
    this.stopMonitor();
    const AudioContextClass = globalThis.AudioContext;
    if (!AudioContextClass) return;
    let context: AudioContext;
    try {
      context = new AudioContextClass();
    } catch {
      return;
    }
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let silentSince = Date.now();
    let warned = false;
    const interval = setInterval(() => {
      if (context.state !== "running") {
        silentSince = Date.now();
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      if (peak > SILENCE_PEAK) {
        silentSince = Date.now();
        if (warned) {
          warned = false;
          this.diagnostics.onProblem(null);
        }
      } else if (!warned && Date.now() - silentSince >= SILENCE_WARNING_MS) {
        warned = true;
        this.diagnostics.onProblem(
          "The microphone is silent. Another app may be using it, or the wrong microphone is selected.",
        );
      }
    }, 250);
    void context.resume().catch(() => {});
    this.stopMonitor = () => {
      clearInterval(interval);
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
