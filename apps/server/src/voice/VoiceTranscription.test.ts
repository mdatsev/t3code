import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import { VoiceTranscriptionInput, MAX_VOICE_RECORDING_BYTES } from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

const input = {
  audio: Buffer.from("recorded audio").toString("base64"),
  mimeType: "audio/webm" as const,
};
const decodeInput = Schema.decodeUnknownSync(VoiceTranscriptionInput);
function harness(status: number, body: unknown, apiKey: string, language: string) {
  const requests: Array<{ url: string; key: string | undefined; form: FormData }> = [];
  const http = HttpClient.make((request) => {
    if (request.body._tag !== "FormData") throw new Error("Expected multipart audio.");
    requests.push({
      url: request.url,
      key: request.headers["xi-api-key"],
      form: request.body.formData,
    });
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
    );
  });
  const layer = VoiceTranscription.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ voiceInput: { apiKey, language } })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  const run = (recording: VoiceTranscriptionInput) =>
    Effect.gen(function* () {
      return yield* (yield* VoiceTranscription.VoiceTranscription).transcribe(recording);
    }).pipe(Effect.result, Effect.provide(layer));
  return { run, requests };
}

describe("voice transcription", () => {
  it.effect("forwards audio and the selected language and returns trimmed text", () =>
    Effect.gen(function* () {
      const h = harness(200, { text: "  Hello world  " }, "test-key", "bg");
      expect(yield* h.run(input)).toMatchObject({ _tag: "Success", success: "Hello world" });
      expect(h.requests).toHaveLength(1);
      const request = h.requests[0]!;
      expect(request.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
      expect(request.key).toBe("test-key");
      expect(request.form.get("model_id")).toBe("scribe_v2");
      expect(request.form.get("language_code")).toBe("bg");
      expect(request.form.get("tag_audio_events")).toBe("false");
      expect(yield* Effect.promise(() => (request.form.get("file") as Blob).text())).toBe(
        "recorded audio",
      );
    }),
  );
  it.effect("omits language for automatic detection", () =>
    Effect.gen(function* () {
      const h = harness(200, { text: "Hello" }, "test-key", "");
      yield* h.run(input);
      expect(h.requests[0]!.form.has("language_code")).toBe(false);
    }),
  );
  it.effect("does not forward audio without a configured key", () =>
    Effect.gen(function* () {
      const h = harness(200, { text: "Hello" }, "", "");
      expect(yield* h.run(input)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "not-configured" },
      });
      expect(h.requests).toHaveLength(0);
    }),
  );
  it.effect.each([
    [401, "credentials"],
    [403, "credentials"],
    [429, "rate-limit"],
    [422, "invalid-audio"],
    [503, "unavailable"],
  ])("maps status %s to a bounded error without retrying", ([status, reason]) =>
    Effect.gen(function* () {
      const h = harness(Number(status), { detail: "untrusted upstream response" }, "test-key", "");
      const result = yield* h.run(input);
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason } });
      expect(JSON.stringify(result)).not.toContain("untrusted upstream response");
      expect(h.requests).toHaveLength(1);
    }),
  );
  it.effect.each([{ text: "  " }, { unexpected: "response" }])(
    "rejects empty or malformed transcripts",
    (body) =>
      Effect.gen(function* () {
        const h = harness(200, body, "test-key", "");
        expect(yield* h.run(input)).toMatchObject({ _tag: "Failure" });
      }),
  );
  it.effect("rejects invalid encoding and oversized audio before forwarding", () =>
    Effect.gen(function* () {
      expect(() => decodeInput({ ...input, audio: "not base64" })).toThrow();
      expect(() => decodeInput({ ...input, mimeType: "text/html" })).toThrow();
      const h = harness(200, { text: "Hello" }, "test-key", "");
      expect(
        yield* h.run({
          ...input,
          audio: Buffer.alloc(MAX_VOICE_RECORDING_BYTES + 1).toString("base64"),
        }),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-audio" } });
      expect(h.requests).toHaveLength(0);
    }),
  );
});
