import { MAX_VOICE_RECORDING_BYTES } from "@t3tools/contracts";
import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";

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

  constructor(private readonly onStatus: (status: VoiceRecorderStatus) => void) {}

  async requestPermission() {
    const generation = ++this.generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return { granted: false, canAskAgain: true };
      }
      this.stream = stream;
      for (const track of stream.getAudioTracks()) {
        track.addEventListener(
          "ended",
          () =>
            this.onStatus({
              isFinished: false,
              hasError: true,
              error: "The microphone disconnected.",
              url: null,
            }),
          { once: true },
        );
      }
      return { granted: true, canAskAgain: true };
    } catch {
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
    this.timer = setTimeout(() => {
      void this.stop().catch(() => {});
    }, forDuration * 1000);
  }

  async stop() {
    clearTimeout(this.timer);
    if (!this.recorder || !this.started) return;
    if (this.recorder.state !== "inactive") this.recorder.stop();
    await this.stopped;
    if (this.failed) throw new Error("Could not finish this recording.");
  }

  releaseMicrophone() {
    ++this.generation;
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
  }
}
