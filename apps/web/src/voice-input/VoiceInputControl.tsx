import { useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "@tanstack/react-router";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useStableCallback } from "../hooks/useStableCallback";
import { useAtomCommand } from "../state/use-atom-command";
import { transcribeVoice } from "../state/voiceInput";
import { Button } from "../components/ui/button";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useEnvironmentPresentation } from "../state/presentation";
import { BrowserVoiceRecorder } from "./browserRecorder";

const failureMessages = {
  "not-configured": "Add an ElevenLabs API key in General → Voice input.",
  credentials: "ElevenLabs rejected the API key. Check it in General → Voice input.",
  "rate-limit": "ElevenLabs usage limit reached. Check your account or try again later.",
  "invalid-audio": "ElevenLabs could not read this recording. Try recording again.",
  unavailable: "Transcription is unavailable. Check the connection and try again.",
  empty: "No speech was detected. Try recording again.",
};

type VoiceInputControlProps = {
  environmentId: EnvironmentId;
  ownerKey: string;
  disabled: boolean;
  readDraft: () => VoiceDraftSnapshot | null;
  commitDraft: (text: string, selection: { start: number; end: number }) => void;
  onBusyChange: (busy: boolean) => void;
  controllerRef: RefObject<VoiceInputController | null>;
};

export function VoiceInputControl(props: VoiceInputControlProps) {
  const voiceSettings = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.voiceInput,
  );
  const configured = voiceSettings.apiKey.length > 0;
  const language = voiceSettings.language;
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const available =
    presentation?.serverConfig?.environment.capabilities.voiceTranscription === true;
  if (!available) return null;
  return (
    <VoiceInputSession
      key={`${props.ownerKey}:${configured}:${language}`}
      {...props}
      configured={configured}
      language={language}
    />
  );
}

function VoiceInputSession(
  props: VoiceInputControlProps & { configured: boolean; language: string },
) {
  const { configured, language } = props;
  const [state, setState] = useState<VoiceInputState>({
    phase: "idle",
    error: null,
    errorAction: null,
  });
  const [failure, setFailure] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [microphone, setMicrophone] = useState<string | null>(null);
  const [microphoneProblem, setMicrophoneProblem] = useState<string | null>(null);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const readDraft = useStableCallback(props.readDraft);
  const commitDraft = useStableCallback(props.commitDraft);
  const onBusyChange = useStableCallback(props.onBusyChange);
  const transcribe = useAtomCommand(transcribeVoice, { reportFailure: false, reportDefect: false });
  const supported =
    typeof MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";

  useEffect(() => {
    if (!supported) return;
    const recorder = new BrowserVoiceRecorder(
      (status) => {
        void controller.handleRecorderStatus(status);
      },
      {
        onMicrophone: (label) => {
          if (mounted) setMicrophone(label);
        },
        onProblem: (problem) => {
          if (mounted) setMicrophoneProblem(problem);
        },
      },
    );
    let mounted = true;
    const controller = new VoiceInputController({
      recorder,
      readDraft,
      commitDraft,
      requestPermission: () => recorder.requestPermission(),
      configureRecording: () => Promise.resolve(),
      releaseRecording: () => {
        recorder.releaseMicrophone();
        return Promise.resolve();
      },
      deleteRecording: (uri) => URL.revokeObjectURL(uri),
      getTranscriber: () =>
        configured
          ? {
              prepare: async () => ({
                locale: language || navigator.language,
                transcribe: async (uri, { signal }) => {
                  const blob = await fetch(uri, { signal }).then((response) => response.blob());
                  const audio = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    const abort = () => reader.abort();
                    reader.addEventListener(
                      "load",
                      () => resolve(String(reader.result).split(",")[1]!),
                      { once: true },
                    );
                    reader.addEventListener(
                      "error",
                      () => reject(new Error("Could not read recording.")),
                      { once: true },
                    );
                    reader.addEventListener(
                      "abort",
                      () => reject(new Error("Recording cancelled.")),
                      { once: true },
                    );
                    reader.addEventListener(
                      "loadend",
                      () => signal.removeEventListener("abort", abort),
                      { once: true },
                    );
                    signal.addEventListener("abort", abort, { once: true });
                    reader.readAsDataURL(blob);
                    if (signal.aborted) reader.abort();
                  });
                  const mime = blob.type.split(";")[0];
                  if (mime !== "audio/webm" && mime !== "audio/ogg" && mime !== "audio/mp4")
                    throw new Error("Unsupported audio.");
                  const result = await transcribe({
                    environmentId: props.environmentId,
                    input: { recording: { audio, mimeType: mime }, signal },
                  });
                  if (signal.aborted) throw new Error("Recording cancelled.");
                  if (result._tag === "Failure") {
                    if (mounted) setFailure(failureMessages.unavailable);
                    throw new Error("Transcription failed.");
                  }
                  if (result.value.status === "failed") {
                    if (mounted) setFailure(failureMessages[result.value.reason]);
                    throw new Error("Transcription failed.");
                  }
                  return result.value.text;
                },
              }),
            }
          : null,
      onStateChange: (next) => {
        if (next.phase === "idle" || next.phase === "error") recorder.releaseMicrophone();
        if (!mounted) return;
        if (next.phase === "recording") setElapsed(0);
        if (next.phase === "idle") setMicrophoneProblem(null);
        setState(next);
        onBusyChange(voiceInputBlocksSubmission(next));
      },
    });
    controllerRef.current = controller;
    const sharedControllerRef = props.controllerRef;
    sharedControllerRef.current = controller;
    const background = () => {
      if (document.hidden) void controller.appMovedToBackground();
    };
    document.addEventListener("visibilitychange", background);
    return () => {
      mounted = false;
      controller.dispose();
      recorder.releaseMicrophone();
      controllerRef.current = null;
      if (sharedControllerRef.current === controller) sharedControllerRef.current = null;
      onBusyChange(false);
      document.removeEventListener("visibilitychange", background);
    };
  }, [
    supported,
    props.environmentId,
    props.controllerRef,
    configured,
    language,
    readDraft,
    commitDraft,
    onBusyChange,
    transcribe,
  ]);

  useEffect(() => {
    if (state.phase !== "recording") return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);

  const busy = voiceInputBlocksSubmission(state);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {!busy && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={props.disabled || !supported || !configured}
          title={
            !supported
              ? "Voice input needs a browser with microphone access over HTTPS."
              : !configured
                ? failureMessages["not-configured"]
                : "Record voice input"
          }
          aria-label="Record voice input"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            setFailure(null);
            setMicrophoneProblem(null);
            void controllerRef.current?.start();
          }}
        >
          <MicIcon />
        </Button>
      )}
      {state.phase === "recording" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void controllerRef.current?.stop();
          }}
        >
          <SquareIcon /> Stop · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
        </Button>
      )}
      {state.phase === "recording" && microphoneProblem && (
        <span role="alert" className="text-xs text-destructive">
          {microphoneProblem}
        </span>
      )}
      {state.phase === "recording" && microphone && (
        <span className="max-w-28 truncate text-xs text-muted-foreground">{microphone}</span>
      )}
      {(state.phase === "preparing" || state.phase === "transcribing") && (
        <span role="status" className="text-xs text-muted-foreground">
          {state.phase === "preparing" ? "Starting microphone…" : "Transcribing…"}
        </span>
      )}
      {busy && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel voice input"
          onClick={() => controllerRef.current?.cancel()}
        >
          <XIcon />
        </Button>
      )}
      {state.error && (
        <span role="alert" className="text-xs text-destructive">
          {failure ?? microphoneProblem ?? state.error}{" "}
          {state.errorAction === "retry-transcription" && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setFailure(null);
                void controllerRef.current?.retryTranscription();
              }}
            >
              Retry
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setFailure(null);
              controllerRef.current?.cancel();
            }}
          >
            {state.errorAction === "retry-transcription" ? "Discard" : "Dismiss"}
          </Button>
        </span>
      )}
      {!configured && supported && (
        <Link to="/settings/general" className="text-xs text-muted-foreground underline">
          Set up voice
        </Link>
      )}
    </div>
  );
}
