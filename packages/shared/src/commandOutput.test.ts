import { describe, expect, it } from "vitest";
import { extractCommandOutputText, extractFileChangeOutputText } from "./commandOutput";

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

describe("extractFileChangeOutputText", () => {
  it("preserves added-file contents and whitespace from the saved Codex event", () => {
    const diff = "# Repository policy\n\n1. Merge pull requests after verification.\n\n";
    expect(
      extractFileChangeOutputText({
        item: { changes: [{ path: "/repo/AGENTS.md", kind: { type: "add" }, diff }] },
      }),
    ).toBe(`Added: /repo/AGENTS.md\n\n${diff}`);
  });

  it("keeps each patch, its operation, and rename destination", () => {
    expect(
      extractFileChangeOutputText({
        item: {
          changes: [
            {
              path: "old.ts",
              kind: { type: "update", movePath: "new.ts" },
              diff: "@@ -1 +1 @@\n-old\n+new\n",
            },
            { path: "gone.ts", kind: { type: "delete" }, diff: "deleted content\n" },
            { path: "empty.ts", kind: { type: "add" }, diff: "" },
          ],
        },
      }),
    ).toBe(
      "Updated: old.ts → new.ts\n\n@@ -1 +1 @@\n-old\n+new\n\n\nDeleted: gone.ts\n\ndeleted content\n\n\nAdded: empty.ts\n\n",
    );
  });

  it.each([
    { input: { file_path: "a.ts", old_string: "before\n", new_string: "" } },
    { input: { filePath: "a.ts", oldString: "before\n", newString: "" } },
  ])("preserves Claude/OpenCode replacements, including an empty replacement", (payload) => {
    expect(extractFileChangeOutputText(payload)).toBe(
      "Updated: a.ts\n\nBefore:\nbefore\n\n\nAfter:\n",
    );
  });

  it("does not trim whitespace-only Write content", () => {
    expect(extractFileChangeOutputText({ input: { file_path: "a.ts", content: " \n" } })).toBe(
      "Written: a.ts\n\n \n",
    );
  });

  it("reads ACP diff blocks without treating other content as edits", () => {
    expect(
      extractFileChangeOutputText({
        content: [
          { type: "content", content: { text: "done" } },
          { type: "diff", path: "a.ts", oldText: "old", newText: "new" },
          { type: "diff", path: "b.ts", newText: "new file" },
        ],
      }),
    ).toBe("a.ts\n\nBefore:\nold\n\nAfter:\nnew\n\nb.ts\n\nAfter:\nnew file");
  });

  it.each([
    null,
    {},
    { files: [{ path: "a.ts" }] },
    { item: { changes: [{ path: "a.ts" }] } },
    { input: { command: "echo hello" } },
  ])("does not invent edit contents from paths or unrelated input: %j", (payload) => {
    expect(extractFileChangeOutputText(payload)).toBeNull();
  });
});
