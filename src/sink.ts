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
    // ids are "joplin:<noteId>" — we don't know notebookId at removal time,
    // so list objects under "joplin/" and find by noteId suffix
    await Promise.all(
      ids.map(async (id) => {
        const noteId = id.replace(/^joplin:/, "");
        const listed = await this.bucket.list({ prefix: "joplin/" });
        const matches = listed.objects.filter((o) => o.key.endsWith(`/${noteId}.md`));
        await Promise.all(matches.map((o) => this.bucket.delete(o.key)));
      })
    );
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
