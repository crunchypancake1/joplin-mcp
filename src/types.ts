export interface Env {
  // Durable Object namespace (auto-created by McpAgent.mount)
  JoplinMCP: DurableObjectNamespace;
  // R2 bucket: Joplin sync data (read-only by this Worker)
  JOPLIN_NOTES: R2Bucket;
  // R2 bucket: shared AI Search sink (write for indexer)
  SINK_BUCKET: R2Bucket;
  // KV: cursor + notebook allowlist config
  JOPLIN_KV: KVNamespace;
  // Workers AI binding (for AutoRAG queries)
  AI: Ai;
  // Name of the AI Search (AutoRAG) instance
  AI_SEARCH_INSTANCE: string;
}

export interface NormalizedDoc {
  id: string;       // "joplin:<itemId>"
  source: string;   // "joplin"
  title: string;
  url?: string;     // joplin://x-callback-url/openNote?id=<id>
  content: string;  // note body as markdown
  metadata: {
    notebook?: string;
    notebookId?: string;
    createdAt?: string;
    updatedAt?: string;
  };
}

export interface SearchSink {
  upsert(docs: NormalizedDoc[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

export interface JoplinItem {
  title: string;
  body: string;
  // id is the bare 32-char hex item ID; prefix with "joplin:" when building NormalizedDoc.id
  id: string;
  parent_id: string;
  created_time: string;
  updated_time: string;
  deleted_time: number;
  type_: number;   // 1=note, 2=folder/notebook
  // All raw metadata key-values for forward-compatibility
  meta: Record<string, string>;
}

export interface NotebookConfig {
  mode: "allowlist" | "denylist";
  notebookIds: string[];
}
