import { describe, expect, it } from "vitest";
import { extractCommandOutputText } from "./commandOutput";

describe("extractCommandOutputText", () => {
  const output = "first line\nsecond line\n" + "long output ".repeat(100);
  it.each([
    { item: { aggregatedOutput: output } },
    { item: { result: { content: output } } },
    { rawOutput: output },
    { rawOutput: { content: output } },
    { rawOutput: { stdout: output } },
    { rawOutput: { output } },
    { content: [{ type: "content", content: { type: "text", text: output } }] },
    { result: [{ type: "text", text: output }] },
  ])("preserves multiline provider output: %j", (payload) => {
    expect(extractCommandOutputText(payload)).toBe(output);
  });
  it("preserves both stdout and stderr", () => {
    expect(
      extractCommandOutputText({ rawOutput: { stdout: "out\nline", stderr: "err\nline" } }),
    ).toBe("out\nline\nerr\nline");
  });
  it("does not turn command input into output", () => {
    expect(extractCommandOutputText({ item: { command: "ls" } })).toBeNull();
  });
});
