import type { JoplinItem } from "./types.js";

export function parseJoplinItem(text: string): JoplinItem {
  const lines = text.split("\n");

  // Title is always line 0
  const title = lines[0];

  // Find the metadata block by scanning from the end.
  // Metadata lines match "key: value" where key is lowercase letters/underscores.
  const metaLines: string[] = [];
  let metaStart = lines.length;

  for (let i = lines.length - 1; i >= 2; i--) {
    const line = lines[i];
    if (/^[a-z_]+: /.test(line) || /^[a-z_]+:$/.test(line)) {
      metaLines.unshift(line);
      metaStart = i;
    } else {
      break;
    }
  }

  // Parse metadata into a record
  const meta: Record<string, string> = {};
  for (const line of metaLines) {
    const colonIdx = line.indexOf(": ");
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 2).trim();
      meta[key] = value;
    } else {
      const key = line.slice(0, -1).trim();
      meta[key] = "";
    }
  }

  // Body: lines between the title blank line (index 2) and metaStart
  // Trim trailing blank lines
  const bodyLines = lines.slice(2, metaStart);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
    bodyLines.pop();
  }
  const body = bodyLines.join("\n");

  const rawId = meta["id"] ?? "";

  return {
    title,
    body,
    id: rawId,
    parent_id: meta["parent_id"] ?? "",
    created_time: meta["created_time"] ?? "",
    updated_time: meta["updated_time"] ?? "",
    deleted_time: parseInt(meta["deleted_time"] ?? "0", 10),
    type_: parseInt(meta["type_"] ?? "0", 10),
    meta,
  };
}
