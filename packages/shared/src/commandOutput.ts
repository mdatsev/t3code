function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function commandResultContent(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;

  const directContent = Array.isArray(value) ? value : null;
  const record = asRecord(value);
  const content = record?.content;
  const contentText = nonEmptyString(content);
  if (contentText) return contentText;
  const blocks = directContent ?? (Array.isArray(content) ? content : null);
  if (!blocks) return null;

  const chunks = blocks.flatMap((entry) => {
    const text = nonEmptyString(entry) ?? nonEmptyString(asRecord(entry)?.text);
    return text ? [text] : [];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

/** Returns provider command output before it is formatted for a work-log row. */
export function extractCommandOutputText(dataValue: unknown): string | null {
  const data = asRecord(dataValue);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const outputStreams = [
    nonEmptyString(rawOutput?.stdout),
    nonEmptyString(rawOutput?.stderr),
  ].filter((value): value is string => value !== null);
  const acpContent = Array.isArray(data?.content)
    ? data.content
        .flatMap((entryValue) => {
          const entry = asRecord(entryValue);
          const content = asRecord(entry?.content);
          const text = entry?.type === "content" ? nonEmptyString(content?.text) : null;
          return text ? [text] : [];
        })
        .join("\n")
    : null;

  const candidates = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    acpContent,
    data?.result,
  ];
  for (const candidate of candidates) {
    const text = commandResultContent(candidate);
    if (text) return text;
  }
  return null;
}

/** Stored edit contents, read only on expansion; never include these in chat snapshots. */
export function extractFileChangeOutputText(dataValue: unknown) {
  const data = asRecord(dataValue);
  const changes = asRecord(data?.item)?.changes;
  if (Array.isArray(changes)) {
    const patches = changes.flatMap((value) => {
      const change = asRecord(value);
      if (typeof change?.path !== "string" || typeof change.diff !== "string") return [];
      const kind = asRecord(change.kind);
      const action =
        kind?.type === "add" ? "Added" : kind?.type === "delete" ? "Deleted" : "Updated";
      const destination = typeof kind?.movePath === "string" ? ` → ${kind.movePath}` : "";
      return [`${action}: ${change.path}${destination}\n\n${change.diff}`];
    });
    if (patches.length > 0) return patches.join("\n\n");
  }

  // Claude and OpenCode retain Edit/Write inputs rather than a unified patch.
  const input = asRecord(data?.input);
  const path = nonEmptyString(input?.file_path) ?? nonEmptyString(input?.filePath);
  const before = input?.old_string ?? input?.oldString;
  const after = input?.new_string ?? input?.newString;
  if (path && typeof before === "string" && typeof after === "string") {
    return `Updated: ${path}\n\nBefore:\n${before}\n\nAfter:\n${after}`;
  }
  if (path && typeof input?.content === "string") {
    return `Written: ${path}\n\n${input.content}`;
  }

  // Cursor, Grok, and Antigravity can supply ACP diff content blocks.
  if (Array.isArray(data?.content)) {
    const patches = data.content.flatMap((value) => {
      const block = asRecord(value);
      if (
        block?.type !== "diff" ||
        typeof block.path !== "string" ||
        typeof block.newText !== "string"
      )
        return [];
      const before = typeof block.oldText === "string" ? `Before:\n${block.oldText}\n\n` : "";
      return [`${block.path}\n\n${before}After:\n${block.newText}`];
    });
    if (patches.length > 0) return patches.join("\n\n");
  }
  return null;
}
