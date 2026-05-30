# Joplin Notes Domain — Worker-based MCP + Indexer (read-only)

## Terminology — read this first

- **Cloudflare AI Search** = the managed Cloudflare search/RAG product (formerly AutoRAG,
  https://developers.cloudflare.com/ai-search/), the semantic-search **sink** this domain
  feeds. Not a generic phrase; not Joplin's full-text search.
- **Sync bucket** = the Cloudflare **R2** bucket `joplin-notes`, read through a native R2
  binding. This is the **only** backend for this domain. It stores Joplin's internal *sync
  format*, not plain markdown.
- **Adapter / indexer** = our Worker code that reads the bucket, normalizes notes, and
  pushes them into the sink.

## Scope (read-only)

A Cloudflare **Worker** that owns the Joplin notes integration as a **read-only** domain:
1. **Read MCP tools** — semantic search + fetch + notebook listing.
2. **Indexer** — a Cron-triggered routine that indexes selected notebooks into the shared
   AI Search sink.

**No write tools** (add/edit/delete) are in scope. See "Deferred" at the end.

Context: end-to-end encryption is **off** (confirmed: sample note has
`encryption_applied: 0`), so bucket content is readable. Bucket name: `joplin-notes`.

## Architecture

Single backend: the `joplin-notes` bucket, accessed read-only. No running Joplin client is
required for this scope. The Worker lists/gets objects from the bucket, the indexer pushes
normalized notes into the AI Search sink, and read tools serve queries from the sink (and
direct bucket gets where needed). Clean and self-contained.

## Tech stack
- Cloudflare Workers (TypeScript)
- Cloudflare Agents SDK — `McpAgent` (remote MCP at `/mcp`)
- `@modelcontextprotocol/sdk`, `zod`
- **Native R2 binding** to read the `joplin-notes` R2 bucket.
- Cloudflare AI Search — semantic-search sink
- KV — sync cursor + notebook-allowlist config
- `wrangler.jsonc` likely needs `compatibility_flags: ["nodejs_compat"]`

## Part A — read MCP tools
- `search_notes` — semantic search via the sink (optionally hybrid keyword); the main
  retrieval tool. Supports a `notebook` filter.
- `get_note` — fetch one note by id from the bucket.
- `list_notebooks` — enumerate notebooks (folder items), useful for choosing what to index.
- `get_indexed_notebooks` / `set_indexed_notebooks` — manage the notebook allowlist
  (Part C) from an agent.

**`McpAgent` skeleton:**
```ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export class JoplinMCP extends McpAgent {
  server = new McpServer({ name: "Joplin Notes", version: "1.0.0" });
  async init() {
    this.server.registerTool("search_notes", {
      description: "Semantic search over indexed Joplin notes",
      inputSchema: { query: z.string(), notebook: z.string().optional(), topK: z.number().optional() },
    }, async (args) => {
      // query the AI Search sink; return ranked hits
    });
    // get_note (bucket), list_notebooks (bucket), get/set_indexed_notebooks (KV)
  }
}
export default { fetch: JoplinMCP.mount("/mcp") };
```

## Part B — indexer (Cron)

Runs on a schedule; reads the bucket and pushes to the sink.

Shared contracts (same as other domains):
```ts
interface NormalizedDoc {
  id: string;        // "joplin:<itemId>"
  source: string;    // "joplin"
  title: string;
  url?: string;      // optional, e.g. joplin://x-callback-url/openNote?id=<id>
  content: string;   // note body (markdown)
  metadata: { notebook?: string; createdAt?: string; updatedAt?: string };
}
interface SearchSink {
  upsert(docs: NormalizedDoc[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
}
```

**Run logic:**
1. Load the notebook allowlist config from KV (Part C).
2. List objects in `joplin-notes`, skipping non-item paths (`.sync/`, `locks/`, `temp/`,
   `info.json`).
3. For each item file: parse the sync format (below); keep only notes (`type_ == 1`) whose
   `parent_id` is in the allowlist.
4. **Soft-delete handling:** if `deleted_time != 0`, the note is a tombstone — call
   `sink.remove(["joplin:<id>"])` and skip. (Covers deletion reconciliation for free.)
5. Otherwise normalize → `sink.upsert(...)`.
6. Cursor: store the max `updated_time` processed in KV; on each run only reprocess items
   newer than the cursor (or use the R2 object's `uploaded` timestamp).

**Notebook name resolution:** `parent_id` references a folder item (`type_ == 2`). Build a
folder-id → name map by reading folder items, then resolve for metadata.

## The Joplin sync-format parser

Item files are named by 32-char hex id (`<id>.md`). Format (confirmed against a real
sample): **first line is the title**, then a blank line, then the body (which may be
empty), then a **trailing block of `key: value` metadata lines** ending at `type_:`.

**Exact on-bucket example** — object key `29847587f24a4319bc6aaae7226e79e0.md` (this
particular note has an empty body, so it goes straight from the title's blank line into the
metadata block):

```
Test Note

id: 29847587f24a4319bc6aaae7226e79e0
parent_id: 7736fb661409465e827bbe0d8b57ac4c
created_time: 2026-05-30T13:53:52.848Z
updated_time: 2026-05-30T13:53:57.242Z
is_conflict: 0
latitude: 0.00000000
longitude: 0.00000000
altitude: 0.0000
author: 
source_url: 
is_todo: 0
todo_due: 0
todo_completed: 0
source: joplin
source_application: net.cozic.joplin-mobile
application_data: 
order: 1780149232848
user_created_time: 2026-05-30T13:53:52.848Z
user_updated_time: 2026-05-30T13:53:57.242Z
encryption_cipher_text: 
encryption_applied: 0
markup_language: 1
is_shared: 0
share_id: 
conflict_original_id: 
master_key_id: 
user_data: 
deleted_time: 0
type_: 1
```

A note *with* a body looks the same but with the body text occupying the lines between the
title's blank line and the metadata block.

Parse from the END for robustness:
1. Take line 1 as `title`.
2. Identify the trailing contiguous block of `key: value` lines as metadata. Be
   **tolerant of unknown/added keys** — Joplin adds fields over time (the sample already
   includes newer `user_data` and `deleted_time`).
3. Everything between the title's blank line and the metadata block is `body` (trim; may
   be empty — handle title-only notes, as in the example above).

Key metadata fields used: `id`, `parent_id` (notebook), `created_time`, `updated_time`,
`markup_language` (1 = Markdown), `deleted_time` (0 = live, non-zero = deleted),
`type_` (1 = note, 2 = folder/notebook, others = tag/resource/revision → ignore).

> Write a parser unit test using the example above as a fixture, including its empty-body
> case.

## Part C — notebook-selection config (one allowlist, same as Linkwarden)

Selects which notebooks are indexed — the direct equivalent of the Linkwarden collection
allowlist (`config:linkwarden:indexed-collections`).
- **KV key** `config:joplin:indexed-notebooks`:
  ```json
  { "mode": "allowlist", "notebookIds": ["7736fb661409465e827bbe0d8b57ac4c"] }
  ```
  Use notebook (folder) IDs. Default `allowlist`; optionally support `denylist`.
- **Default = all:** if the key is unset or `notebookIds` is empty, index all notebooks.
- The indexer loads this first and filters by `parent_id` membership before normalizing.
- Editable via `wrangler kv key put` / dashboard or the `get/set_indexed_notebooks` tools.
- Reconciliation on deselection: remove indexed items whose `notebook` is no longer
  selected (query the sink by `notebook` metadata and `sink.remove(...)`, or track per-item
  state in D1). `deleted_time` already handles per-note deletions for free.

## Bucket access from the Worker
`joplin-notes` is a Cloudflare R2 bucket. Bind it in `wrangler.jsonc`:
```jsonc
"r2_buckets": [{ "binding": "JOPLIN_NOTES", "bucket_name": "joplin-notes" }]
```
Then use the R2 Workers API: `env.JOPLIN_NOTES.list(...)`, `env.JOPLIN_NOTES.get(key)`.
The Worker reads the bucket but never writes to it.

## Auth
Deploy the Worker authless, protect `/mcp` with Cloudflare Access, register in the MCP
Portal. Secrets (if any) stay server-side as Worker secrets.

## Build order
1. Scaffold Worker + `McpAgent`; add the R2 binding for `joplin-notes`.
2. Implement the sync-format parser + unit test against the sample fixture.
3. Build the Cron indexer (list → parse → filter `type_==1` & `deleted_time==0` → notebook
   allowlist → normalize → `sink.upsert`; tombstones → `sink.remove`); KV cursor.
4. Implement read tools (`search_notes` via sink, `get_note`, `list_notebooks`) + the
   `get/set_indexed_notebooks` config tools.
5. Deploy authless behind Access; register in the MCP Portal.

## Deferred — write tools (out of scope, documented for later)
If add/edit/delete is added later, **do not write to the sync bucket directly** (Joplin
sync maintains client-side state and a lock protocol; direct writes risk corruption).
Instead, route writes through the Joplin **Data API** exposed by a running headless Joplin
client, with the Worker proxying to it.

## Open questions for the implementing agent
- Listing/pagination behavior of the R2 bucket and whether object `uploaded`/`LastModified`
  or item `updated_time` is the better incremental cursor.
- Confirm current AI Search binding/method names for the `SearchSink` implementation.
- Reconciliation state: KV-only vs a D1 table tracking indexed items per notebook.
