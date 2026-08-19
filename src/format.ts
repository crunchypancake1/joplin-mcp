// Pure text helpers shared by the tool handlers. Kept out of agent.ts so they can be
// tested without pulling in the Workers runtime.

// Characters of body text shown per search hit.
const SNIPPET_CHARS = 200;

export function timestamp(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().replace(".000", "") : "unknown";
}

// Joins added text onto an existing body with exactly one newline separator, so
// appending a list item doesn't accumulate stray whitespace.
export function splice(body: string, edit: { append?: string; prepend?: string }): string {
  let result = body;
  if (edit.prepend !== undefined) {
    result = result.trim()
      ? `${edit.prepend.replace(/\s+$/, "")}\n${result.replace(/^\s+/, "")}`
      : edit.prepend;
  }
  if (edit.append !== undefined) {
    result = result.trim()
      ? `${result.replace(/\s+$/, "")}\n${edit.append.replace(/^\s+/, "")}`
      : edit.append;
  }
  return result;
}

// A window of body text around the first query term that appears in it.
export function snippet(body: string, query: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";

  const terms = query
    // Drop search operators like `title:` and `tag:` — they aren't body text.
    .replace(/\b\w+:/g, " ")
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((term) => term.length > 2);

  const haystack = flat.toLowerCase();
  const hit = terms
    .map((term) => haystack.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  const start = hit === undefined ? 0 : Math.max(0, hit - SNIPPET_CHARS / 4);
  const window = flat.slice(start, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${window}${start + SNIPPET_CHARS < flat.length ? "…" : ""}`;
}
