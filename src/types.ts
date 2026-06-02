export interface Env {
  JOPLIN_MCP: DurableObjectNamespace;
  // R2 bucket: Joplin sync data (read-only by this Worker)
  JOPLIN_NOTES: R2Bucket;
  // R2 bucket: shared AI Search sink (write for indexer)
  SINK_BUCKET: R2Bucket;
  // KV: notebook allowlist config
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

// Shape of the message body Cloudflare R2 sends to a Queue on object change
export interface R2EventNotificationMessage {
  account: string;
  bucket: string;
  object: {
    key: string;
    size: number;
    eTag: string;
  };
  action: "PutObject" | "DeleteObject" | "CopyObject" | "CompleteMultipartUpload";
  eventTime: string;
}

// Joplin sync bucket paths that are not note/folder item files
export const JOPLIN_SKIP_PREFIXES = [".sync/", "locks/", "temp/"] as const;
// info.json is an exact top-level key (not a prefix)
export const JOPLIN_INFO_KEY = "info.json";
