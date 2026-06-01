import type { NormalizedDoc, SearchSink } from "./types.js";

export class R2SearchSink implements SearchSink {
  constructor(private readonly bucket: R2Bucket) {}

  async upsert(docs: NormalizedDoc[]): Promise<void> {
    await Promise.all(
      docs.map((doc) =>
        this.bucket.put(sinkKey(doc.id), serialize(doc), {
          httpMetadata: { contentType: "text/plain" },
        })
      )
    );
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => this.bucket.delete(sinkKey(id))));
  }
}

function sinkKey(id: string): string {
  const bareId = id.replace(/^joplin:/, "");
  return `joplin/${bareId}.txt`;
}

function serialize(doc: NormalizedDoc): string {
  return [
    `Title: ${doc.title}`,
    `URL: ${doc.url ?? ""}`,
    `Notebook: ${doc.metadata.notebook ?? ""}`,
    "",
    doc.content,
  ].join("\n");
}
