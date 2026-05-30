import type { NormalizedDoc, SearchSink } from "./types.js";

export class R2SearchSink implements SearchSink {
  constructor(private readonly bucket: R2Bucket) {}

  async upsert(docs: NormalizedDoc[]): Promise<void> {
    await Promise.all(
      docs.map((doc) => {
        const key = sinkKey(doc);
        const content = renderMarkdown(doc);
        return this.bucket.put(key, content, {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        });
      })
    );
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    // Build a Set of bare note IDs for O(1) lookup
    const noteIds = new Set(ids.map((id) => id.replace(/^joplin:/, "")));

    // Paginate through all objects under "joplin/" to find matches
    const keysToDelete: string[] = [];
    let cursor: string | undefined;
    do {
      const listed: R2Objects = await this.bucket.list(
        cursor ? { prefix: "joplin/", cursor } : { prefix: "joplin/" }
      );
      for (const obj of listed.objects) {
        // Key format: joplin/<notebookId>/<noteId>.md
        const segments = obj.key.split("/");
        const filename = segments[segments.length - 1];
        const noteId = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
        if (noteIds.has(noteId)) {
          keysToDelete.push(obj.key);
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    await Promise.all(keysToDelete.map((key) => this.bucket.delete(key)));
  }
}

function sinkKey(doc: NormalizedDoc): string {
  const noteId = doc.id.replace(/^joplin:/, "");
  const notebookId = doc.metadata.notebookId ?? "unknown";
  return `joplin/${notebookId}/${noteId}.md`;
}

function renderMarkdown(doc: NormalizedDoc): string {
  const lines: string[] = [`# ${doc.title}`, ""];
  if (doc.url) {
    lines.push(`[Open in Joplin](${doc.url})`, "");
  }
  if (doc.content) {
    lines.push(doc.content);
  }
  return lines.join("\n");
}
