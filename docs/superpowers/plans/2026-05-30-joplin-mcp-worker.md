# Joplin MCP Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cloudflare Worker that exposes Joplin notes as MCP read tools (`search_notes`, `get_note`, `list_notebooks`) plus a Cron-triggered indexer that pushes notes from the `joplin-notes` R2 sync bucket into a shared AI Search (AutoRAG) sink.

**Architecture:** `JoplinMCP` extends `McpAgent` (Durable Object) and serves the `/mcp` SSE endpoint. A parallel `scheduled` handler runs the indexer on a cron schedule. The indexer reads the `joplin-notes` R2 bucket, parses Joplin's sync format, and writes normalized markdown files to a shared "sink" R2 bucket that Cloudflare AI Search auto-indexes. Search queries go via `env.AI.autorag()`.

**Tech Stack:** Cloudflare Workers (TypeScript), Cloudflare Agents SDK (`McpAgent`), `@modelcontextprotocol/sdk`, `zod`, R2 (read: `joplin-notes`; write: shared sink), KV (cursor + notebook allowlist config), Cloudflare AI (AutoRAG), Vitest for unit tests.

---

## File Map

| File | Responsibility |
|------|----------------|
| `src/types.ts` | `Env`, `NormalizedDoc`, `SearchSink`, `JoplinItem` interfaces |
| `src/parser.ts` | Parse Joplin sync-format `.md` files into `JoplinItem` |
| `src/sink.ts` | `R2SearchSink implements SearchSink` — write/delete from sink R2 bucket |
| `src/indexer.ts` | `runIndexer(env)` — full Cron indexer logic |
| `src/agent.ts` | `JoplinMCP extends McpAgent` — registers all 5 MCP tools |
| `src/index.ts` | Worker entry point — exports `JoplinMCP` + `default { fetch, scheduled }` |
| `test/parser.test.ts` | Vitest unit tests for the parser |
| `wrangler.jsonc` | Wrangler config — bindings, cron, DO migrations |
| `package.json` | Dependencies and scripts |
| `tsconfig.json` | TypeScript config |
| `vitest.config.ts` | Vitest config |

---

## Task 1: Scaffold the project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `wrangler.jsonc`
- Create: `src/types.ts`
- Create: `src/index.ts` (stub)

- [ ] **Step 1: Install dependencies**

Run in `/home/crunchypancake/projects/joplin-mcp`:
```bash
npm init -y
npm install agents @modelcontextprotocol/sdk zod
npm install --save-dev wrangler typescript @cloudflare/workers-types vitest
```

- [ ] **Step 2: Write `package.json` scripts**

Replace the generated `package.json` with:
```json
{
  "name": "joplin-mcp",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "agents": "^0.0.81",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "wrangler": "^4.0.0",
    "typescript": "^5.8.0",
    "@cloudflare/workers-types": "^4.20250525.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 5: Write `wrangler.jsonc`**

```jsonc
{
  "name": "joplin-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2025-05-01",
  "compatibility_flags": ["nodejs_compat"],

  "durable_objects": {
    "bindings": [
      { "name": "JoplinMCP", "class_name": "JoplinMCP" }
    ]
  },

  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["JoplinMCP"] }
  ],

  "r2_buckets": [
    { "binding": "JOPLIN_NOTES", "bucket_name": "joplin-notes" },
    { "binding": "SINK_BUCKET", "bucket_name": "ai-search-sink" }
  ],

  "kv_namespaces": [
    { "binding": "JOPLIN_KV", "id": "REPLACE_WITH_KV_NAMESPACE_ID" }
  ],

  "ai": {
    "binding": "AI"
  },

  "vars": {
    "AI_SEARCH_INSTANCE": "REPLACE_WITH_AI_SEARCH_INSTANCE_NAME"
  },

  "triggers": {
    "crons": ["0 * * * *"]
  }
}
```

- [ ] **Step 6: Write `src/types.ts`**

```typescript
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
  rawId: string;
  title: string;
  body: string;
  // Parsed metadata fields
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
```

- [ ] **Step 7: Write stub `src/index.ts`**

```typescript
export { JoplinMCP } from "./agent.js";

export default {
  fetch: (_req: Request) => new Response("stub"),
  async scheduled(_event: ScheduledEvent, _env: unknown, _ctx: ExecutionContext) {},
};
```

- [ ] **Step 8: Verify project structure compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: errors about missing modules (`./agent.js`) — that's fine at this stage.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: scaffold joplin-mcp worker project"
```

---

## Task 2: Implement the Joplin sync-format parser + unit tests

**Files:**
- Create: `src/parser.ts`
- Create: `test/parser.test.ts`

- [ ] **Step 1: Write the failing parser test**

Create `test/parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseJoplinItem } from "../src/parser.js";

const EMPTY_BODY_FIXTURE = `Test Note

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
type_: 1`;

const WITH_BODY_FIXTURE = `My Note With Content

This is the note body.
It has multiple lines.

And a blank line in the middle.

id: aaaabbbbccccdddd00001111222233334444
parent_id: 7736fb661409465e827bbe0d8b57ac4c
created_time: 2026-01-01T00:00:00.000Z
updated_time: 2026-01-02T00:00:00.000Z
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
source_application: net.cozic.joplin-desktop
application_data: 
order: 0
user_created_time: 2026-01-01T00:00:00.000Z
user_updated_time: 2026-01-02T00:00:00.000Z
encryption_cipher_text: 
encryption_applied: 0
markup_language: 1
is_shared: 0
share_id: 
conflict_original_id: 
master_key_id: 
user_data: 
deleted_time: 0
type_: 1`;

const FOLDER_FIXTURE = `My Notebook

id: 7736fb661409465e827bbe0d8b57ac4c
parent_id: 
created_time: 2026-01-01T00:00:00.000Z
updated_time: 2026-01-01T00:00:00.000Z
user_created_time: 2026-01-01T00:00:00.000Z
user_updated_time: 2026-01-01T00:00:00.000Z
encryption_applied: 0
deleted_time: 0
type_: 2`;

const DELETED_NOTE_FIXTURE = `Deleted Note

id: deadbeef00000000000000000000000000
parent_id: 7736fb661409465e827bbe0d8b57ac4c
created_time: 2026-01-01T00:00:00.000Z
updated_time: 2026-01-05T00:00:00.000Z
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
source_application: net.cozic.joplin-desktop
application_data: 
order: 0
user_created_time: 2026-01-01T00:00:00.000Z
user_updated_time: 2026-01-05T00:00:00.000Z
encryption_cipher_text: 
encryption_applied: 0
markup_language: 1
is_shared: 0
share_id: 
conflict_original_id: 
master_key_id: 
user_data: 
deleted_time: 1746393600000
type_: 1`;

describe("parseJoplinItem", () => {
  it("parses a note with empty body", () => {
    const item = parseJoplinItem(EMPTY_BODY_FIXTURE);
    expect(item.title).toBe("Test Note");
    expect(item.body).toBe("");
    expect(item.id).toBe("29847587f24a4319bc6aaae7226e79e0");
    expect(item.parent_id).toBe("7736fb661409465e827bbe0d8b57ac4c");
    expect(item.type_).toBe(1);
    expect(item.deleted_time).toBe(0);
    expect(item.created_time).toBe("2026-05-30T13:53:52.848Z");
    expect(item.updated_time).toBe("2026-05-30T13:53:57.242Z");
  });

  it("parses a note with a multi-line body", () => {
    const item = parseJoplinItem(WITH_BODY_FIXTURE);
    expect(item.title).toBe("My Note With Content");
    expect(item.body).toBe(
      "This is the note body.\nIt has multiple lines.\n\nAnd a blank line in the middle."
    );
    expect(item.id).toBe("aaaabbbbccccdddd00001111222233334444");
    expect(item.type_).toBe(1);
    expect(item.deleted_time).toBe(0);
  });

  it("parses a folder item (type_ == 2)", () => {
    const item = parseJoplinItem(FOLDER_FIXTURE);
    expect(item.title).toBe("My Notebook");
    expect(item.type_).toBe(2);
    expect(item.id).toBe("7736fb661409465e827bbe0d8b57ac4c");
    expect(item.body).toBe("");
  });

  it("parses a deleted note (deleted_time != 0)", () => {
    const item = parseJoplinItem(DELETED_NOTE_FIXTURE);
    expect(item.type_).toBe(1);
    expect(item.deleted_time).not.toBe(0);
    expect(item.deleted_time).toBeGreaterThan(0);
  });

  it("preserves unknown/future metadata keys without throwing", () => {
    const withFutureKey = EMPTY_BODY_FIXTURE + "\nfuture_key: some_value";
    expect(() => parseJoplinItem(withFutureKey)).not.toThrow();
    const item = parseJoplinItem(withFutureKey);
    expect(item.meta["future_key"]).toBe("some_value");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run test/parser.test.ts 2>&1 | tail -10
```

Expected: FAIL — "Cannot find module '../src/parser.js'"

- [ ] **Step 3: Implement `src/parser.ts`**

```typescript
import type { JoplinItem } from "./types.js";

export function parseJoplinItem(text: string): JoplinItem {
  const lines = text.split("\n");

  // Title is always line 0
  const title = lines[0];

  // Find the metadata block by scanning from the end.
  // The metadata block is a contiguous run of "key: value" lines at the bottom.
  // It ends (bottom-up) at the first line that is NOT a "key: value" pattern.
  // We stop collecting once we find "type_:" — that is always the last metadata field.
  const metaLines: string[] = [];
  let metaStart = lines.length; // index of first metadata line

  for (let i = lines.length - 1; i >= 2; i--) {
    const line = lines[i];
    // A metadata line matches "key: value" where key has no spaces
    if (/^[a-z_]+: /.test(line) || /^[a-z_]+:$/.test(line)) {
      metaLines.unshift(line);
      metaStart = i;
    } else {
      // First non-metadata line from the bottom — stop
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
      // "key:" with no value
      const key = line.slice(0, -1).trim();
      meta[key] = "";
    }
  }

  // Body is everything between line 2 (after the blank line after title) and metaStart,
  // excluding the trailing blank line that separates body from metadata.
  const bodyLines = lines.slice(2, metaStart);
  // Trim trailing blank lines from body
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
    bodyLines.pop();
  }
  const body = bodyLines.join("\n");

  const rawId = meta["id"] ?? "";

  return {
    rawId,
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
```

- [ ] **Step 4: Run the tests and confirm they all pass**

```bash
npx vitest run test/parser.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts test/parser.test.ts
git commit -m "feat: implement Joplin sync-format parser with unit tests"
```

---

## Task 3: Implement the SearchSink (R2-backed)

**Files:**
- Create: `src/sink.ts`

The AI Search instance is configured in the Cloudflare dashboard to auto-index an R2 bucket (the "sink bucket"). The `SearchSink` implementation writes markdown files to this R2 bucket so AI Search picks them up on its next 6-hour cycle.

File layout in sink bucket: `joplin/<notebookId>/<noteId>.md`

This layout enables notebook-scoped filtering via AI Search's `folder` filter (using `operator: "gte"` as a prefix match).

- [ ] **Step 1: Write `src/sink.ts`**

```typescript
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
    // ids are in "joplin:<noteId>" format; derive the key prefix and delete
    // We don't know the notebookId at removal time, so we list by prefix and delete.
    await Promise.all(
      ids.map(async (id) => {
        const noteId = id.replace(/^joplin:/, "");
        // List objects whose key contains this noteId (under joplin/ prefix)
        const listed = await this.bucket.list({ prefix: `joplin/` });
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
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "agent\|index"
```

Expected: no errors in `sink.ts` or `types.ts`

- [ ] **Step 3: Commit**

```bash
git add src/sink.ts
git commit -m "feat: add R2-backed SearchSink for AI Search indexing"
```

---

## Task 4: Implement the Cron indexer

**Files:**
- Create: `src/indexer.ts`

- [ ] **Step 1: Write `src/indexer.ts`**

```typescript
import { parseJoplinItem } from "./parser.js";
import { R2SearchSink } from "./sink.js";
import type { Env, NormalizedDoc, NotebookConfig } from "./types.js";

const CURSOR_KEY = "cursor:joplin:updated_time";
const CONFIG_KEY = "config:joplin:indexed-notebooks";

// Prefixes to skip — Joplin sync metadata, not note content
const SKIP_PREFIXES = [".sync/", "locks/", "temp/", "info.json"];

export async function runIndexer(env: Env): Promise<void> {
  const sink = new R2SearchSink(env.SINK_BUCKET);

  // Load notebook allowlist config (default: index all)
  const configRaw = await env.JOPLIN_KV.get(CONFIG_KEY);
  const config: NotebookConfig = configRaw
    ? JSON.parse(configRaw)
    : { mode: "allowlist", notebookIds: [] };

  // Load cursor: the uploaded timestamp of the most recently processed object
  const cursorRaw = await env.JOPLIN_KV.get(CURSOR_KEY);
  const cursorMs = cursorRaw ? parseInt(cursorRaw, 10) : 0;

  // Paginate through ALL objects in the sync bucket
  const allObjects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listed: R2Objects = await env.JOPLIN_NOTES.list(
      cursor ? { cursor } : {}
    );
    allObjects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // Filter out Joplin internal paths
  const itemObjects = allObjects.filter(
    (o) => !SKIP_PREFIXES.some((p) => o.key.startsWith(p))
  );

  // Download and parse all objects to separate folders from notes
  // (We need ALL folders for name resolution, but only NEW notes for efficiency)
  const folderObjects = itemObjects.filter((o) => {
    // We can't know type_ without downloading, so fetch all — they're small
    return true;
  });

  const parsed = await Promise.all(
    itemObjects.map(async (obj) => {
      const r2obj = await env.JOPLIN_NOTES.get(obj.key);
      if (!r2obj) return null;
      const text = await r2obj.text();
      return { item: parseJoplinItem(text), uploadedMs: obj.uploaded.getTime() };
    })
  );

  const validParsed = parsed.filter(Boolean) as Array<{
    item: ReturnType<typeof parseJoplinItem>;
    uploadedMs: number;
  }>;

  // Build folder (notebook) id → name map
  const folderMap = new Map<string, string>();
  for (const { item } of validParsed) {
    if (item.type_ === 2) {
      folderMap.set(item.id, item.title);
    }
  }

  // Process notes
  const toUpsert: NormalizedDoc[] = [];
  const toRemove: string[] = [];
  let maxUpdatedMs = cursorMs;

  for (const { item, uploadedMs } of validParsed) {
    if (item.type_ !== 1) continue; // skip folders, tags, resources, revisions

    // Skip items not newer than cursor (optimization: skip re-indexing unchanged notes)
    if (uploadedMs <= cursorMs) continue;

    maxUpdatedMs = Math.max(maxUpdatedMs, uploadedMs);

    const docId = `joplin:${item.id}`;

    if (item.deleted_time !== 0) {
      toRemove.push(docId);
      continue;
    }

    // Apply notebook allowlist/denylist
    if (!isNotebookAllowed(item.parent_id, config)) continue;

    const notebookName = folderMap.get(item.parent_id);
    toUpsert.push(normalizeNote(item, notebookName));
  }

  // Flush to sink
  if (toRemove.length > 0) await sink.remove(toRemove);

  // Upsert in batches of 50 to avoid overwhelming R2
  for (let i = 0; i < toUpsert.length; i += 50) {
    await sink.upsert(toUpsert.slice(i, i + 50));
  }

  // Persist cursor
  if (maxUpdatedMs > cursorMs) {
    await env.JOPLIN_KV.put(CURSOR_KEY, String(maxUpdatedMs));
  }

  console.log(
    `[joplin-indexer] upserted=${toUpsert.length} removed=${toRemove.length} cursor=${maxUpdatedMs}`
  );
}

function isNotebookAllowed(notebookId: string, config: NotebookConfig): boolean {
  if (config.notebookIds.length === 0) return true; // empty list = all notebooks
  if (config.mode === "allowlist") return config.notebookIds.includes(notebookId);
  if (config.mode === "denylist") return !config.notebookIds.includes(notebookId);
  return true;
}

function normalizeNote(
  item: ReturnType<typeof parseJoplinItem>,
  notebookName: string | undefined
): NormalizedDoc {
  return {
    id: `joplin:${item.id}`,
    source: "joplin",
    title: item.title,
    url: `joplin://x-callback-url/openNote?id=${item.id}`,
    content: item.body,
    metadata: {
      notebook: notebookName,
      notebookId: item.parent_id,
      createdAt: item.created_time,
      updatedAt: item.updated_time,
    },
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "indexer\|sink\|parser\|types"
```

Expected: no errors in these files

- [ ] **Step 3: Commit**

```bash
git add src/indexer.ts
git commit -m "feat: implement cron indexer for joplin notes → AI Search sink"
```

---

## Task 5: Implement the JoplinMCP agent with all tools

**Files:**
- Create: `src/agent.ts`

The agent exposes 5 tools:
1. `search_notes` — semantic search via AI Search (AutoRAG)
2. `get_note` — fetch one note from joplin-notes bucket, parse and return
3. `list_notebooks` — enumerate all folder items from bucket
4. `get_indexed_notebooks` — read the notebook allowlist from KV
5. `set_indexed_notebooks` — write the notebook allowlist to KV

- [ ] **Step 1: Write `src/agent.ts`**

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseJoplinItem } from "./parser.js";
import type { Env, NotebookConfig } from "./types.js";

const CONFIG_KEY = "config:joplin:indexed-notebooks";
const SKIP_PREFIXES = [".sync/", "locks/", "temp/", "info.json"];

export class JoplinMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Joplin Notes", version: "1.0.0" });

  async init() {
    // ── search_notes ──────────────────────────────────────────────────────
    this.server.registerTool(
      "search_notes",
      {
        description:
          "Semantic search over indexed Joplin notes. Returns ranked note snippets relevant to the query.",
        inputSchema: {
          query: z.string().describe("Search query"),
          notebook: z
            .string()
            .optional()
            .describe("Optional notebook ID to restrict search scope"),
          topK: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Max number of results (default 5)"),
        },
      },
      async ({ query, notebook, topK }) => {
        const filters = notebook
          ? {
              column: "folder" as const,
              operator: "gte" as const,
              value: `joplin/${notebook}/`,
            }
          : {
              column: "folder" as const,
              operator: "gte" as const,
              value: "joplin/",
            };

        const results = await this.env.AI.autorag(
          this.env.AI_SEARCH_INSTANCE
        ).search({
          query,
          max_num_results: topK ?? 5,
          filters,
          ranking_options: { score_threshold: 0.3 },
        });

        if (!results.data || results.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No results found." }],
          };
        }

        const text = results.data
          .map(
            (r, i) =>
              `[${i + 1}] ${r.metadata?.filename ?? r.id} (score: ${r.score.toFixed(3)})\n${r.content}`
          )
          .join("\n\n---\n\n");

        return { content: [{ type: "text" as const, text }] };
      }
    );

    // ── get_note ──────────────────────────────────────────────────────────
    this.server.registerTool(
      "get_note",
      {
        description: "Fetch a single Joplin note by its ID. Returns title, body, and metadata.",
        inputSchema: {
          id: z.string().describe("32-character hex note ID"),
        },
      },
      async ({ id }) => {
        const obj = await this.env.JOPLIN_NOTES.get(`${id}.md`);
        if (!obj) {
          return {
            content: [{ type: "text" as const, text: `Note not found: ${id}` }],
            isError: true,
          };
        }

        const text = await obj.text();
        const item = parseJoplinItem(text);

        if (item.type_ !== 1) {
          return {
            content: [
              { type: "text" as const, text: `Item ${id} is not a note (type_: ${item.type_})` },
            ],
            isError: true,
          };
        }

        const result = [
          `# ${item.title}`,
          "",
          item.body || "_No content_",
          "",
          "---",
          `ID: ${item.id}`,
          `Notebook ID: ${item.parent_id}`,
          `Created: ${item.created_time}`,
          `Updated: ${item.updated_time}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    // ── list_notebooks ────────────────────────────────────────────────────
    this.server.registerTool(
      "list_notebooks",
      {
        description: "List all Joplin notebooks (folders) with their IDs and names.",
        inputSchema: {},
      },
      async () => {
        const allObjects: R2Object[] = [];
        let cursor: string | undefined;
        do {
          const listed: R2Objects = await this.env.JOPLIN_NOTES.list(
            cursor ? { cursor } : {}
          );
          allObjects.push(...listed.objects);
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);

        const itemObjects = allObjects.filter(
          (o) => !SKIP_PREFIXES.some((p) => o.key.startsWith(p))
        );

        const notebooks: Array<{ id: string; name: string }> = [];

        await Promise.all(
          itemObjects.map(async (obj) => {
            const r2obj = await this.env.JOPLIN_NOTES.get(obj.key);
            if (!r2obj) return;
            const text = await r2obj.text();
            const item = parseJoplinItem(text);
            if (item.type_ === 2) {
              notebooks.push({ id: item.id, name: item.title });
            }
          })
        );

        notebooks.sort((a, b) => a.name.localeCompare(b.name));

        const text =
          notebooks.length === 0
            ? "No notebooks found."
            : notebooks.map((n) => `${n.name} (${n.id})`).join("\n");

        return { content: [{ type: "text" as const, text }] };
      }
    );

    // ── get_indexed_notebooks ─────────────────────────────────────────────
    this.server.registerTool(
      "get_indexed_notebooks",
      {
        description:
          "Get the current notebook indexing configuration (allowlist or denylist of notebook IDs).",
        inputSchema: {},
      },
      async () => {
        const raw = await this.env.JOPLIN_KV.get(CONFIG_KEY);
        const config: NotebookConfig = raw
          ? JSON.parse(raw)
          : { mode: "allowlist", notebookIds: [] };

        const text = JSON.stringify(config, null, 2);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // ── set_indexed_notebooks ─────────────────────────────────────────────
    this.server.registerTool(
      "set_indexed_notebooks",
      {
        description:
          "Set which notebooks are indexed. Use mode='allowlist' to index only listed IDs, or mode='denylist' to exclude listed IDs. Empty notebookIds array = all notebooks.",
        inputSchema: {
          mode: z
            .enum(["allowlist", "denylist"])
            .describe("Whether notebookIds is an allowlist or denylist"),
          notebookIds: z
            .array(z.string())
            .describe("Array of notebook (folder) IDs"),
        },
      },
      async ({ mode, notebookIds }) => {
        const config: NotebookConfig = { mode, notebookIds };
        await this.env.JOPLIN_KV.put(CONFIG_KEY, JSON.stringify(config));
        return {
          content: [
            {
              type: "text" as const,
              text: `Saved: ${mode} with ${notebookIds.length} notebook(s).`,
            },
          ],
        };
      }
    );
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "agent"
```

Expected: no errors in `agent.ts`

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts
git commit -m "feat: implement JoplinMCP agent with all 5 MCP tools"
```

---

## Task 6: Wire up the Worker entry point and finalize

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Write the final `src/index.ts`**

```typescript
import { runIndexer } from "./indexer.js";
import type { Env } from "./types.js";

export { JoplinMCP } from "./agent.js";

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    // McpAgent.mount returns a fetch handler; import it dynamically to avoid
    // circular issues with the Durable Object export above.
    const { JoplinMCP } = require("./agent.js");
    return JoplinMCP.mount("/mcp")(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runIndexer(env));
  },
} satisfies ExportedHandler<Env>;
```

Actually, `require()` is not available in ESM Workers. Rewrite using a static import and a local wrapper:

```typescript
import { JoplinMCP } from "./agent.js";
import { runIndexer } from "./indexer.js";
import type { Env } from "./types.js";

export { JoplinMCP };

const mcpFetch = JoplinMCP.mount("/mcp");

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return mcpFetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIndexer(env));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 2: Full typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: all parser tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up worker entry point with fetch + scheduled handlers"
```

---

## Task 7: Cloudflare resource setup (manual steps)

These steps require the Cloudflare dashboard or Wrangler CLI. Document them here so the implementer knows exactly what to create before deploying.

- [ ] **Step 1: Create the KV namespace**

```bash
npx wrangler kv namespace create JOPLIN_KV
```

Copy the returned `id` and replace `"REPLACE_WITH_KV_NAMESPACE_ID"` in `wrangler.jsonc`.

- [ ] **Step 2: Confirm the `joplin-notes` R2 bucket exists**

The sync bucket should already exist (it's where Joplin syncs to). Verify:
```bash
npx wrangler r2 bucket list
```

Expected: `joplin-notes` appears in the list.

- [ ] **Step 3: Create the shared sink R2 bucket (if it doesn't exist)**

```bash
npx wrangler r2 bucket create ai-search-sink
```

If the bucket already exists from another domain (e.g., Linkwarden), skip this step and confirm the bucket name matches what's in `wrangler.jsonc`.

- [ ] **Step 4: Create the AI Search (AutoRAG) instance**

In the Cloudflare Dashboard:
1. Go to **AI** → **AI Search** → **Create**
2. Name: pick a name (e.g., `personal-search`)
3. Data source: **R2 bucket** → select `ai-search-sink`
4. Configure path prefix filter: `joplin/` (optional, to scope to joplin notes)
5. Save

Copy the instance name and replace `"REPLACE_WITH_AI_SEARCH_INSTANCE_NAME"` in `wrangler.jsonc`.

- [ ] **Step 5: Update `wrangler.jsonc` with real values**

Fill in the two placeholder values:
- `"id"` in `kv_namespaces` → real KV namespace ID from Step 1
- `"AI_SEARCH_INSTANCE"` var → real AutoRAG instance name from Step 4

- [ ] **Step 6: Commit the updated config**

```bash
git add wrangler.jsonc
git commit -m "chore: fill in KV namespace ID and AI Search instance name"
```

---

## Task 8: Deploy and smoke-test

- [ ] **Step 1: Deploy to Cloudflare**

```bash
npx wrangler deploy
```

Expected: deployment succeeds, Worker URL printed.

- [ ] **Step 2: Trigger the indexer manually**

```bash
npx wrangler cron trigger joplin-mcp
```

Expected: logs show `[joplin-indexer] upserted=N removed=0 cursor=<timestamp>`.

Verify with `wrangler tail`:
```bash
npx wrangler tail --format pretty
```

- [ ] **Step 3: Check a note was written to the sink bucket**

```bash
npx wrangler r2 object list ai-search-sink --prefix joplin/
```

Expected: markdown files appear under the `joplin/` prefix.

- [ ] **Step 4: Force-sync AI Search**

In the Cloudflare Dashboard → AI Search → your instance → **Force Sync**.

- [ ] **Step 5: Test the MCP endpoint**

Use `npx @modelcontextprotocol/inspector` or `curl` to send an MCP `tools/call` to the deployed Worker URL at `/mcp`:

```bash
# List available tools
curl -N -H "Accept: text/event-stream" https://<worker-url>/mcp
```

- [ ] **Step 6: Set up Cloudflare Access protection**

In the Cloudflare Dashboard → Access → Applications → Add:
- Application type: **Self-hosted**
- Domain: `<worker-url>/mcp*`
- Policy: restrict to your email / team

- [ ] **Step 7: Commit nothing (deploy-only step) — log the Worker URL**

Record the Worker URL for use in MCP client configuration:
`https://joplin-mcp.<your-subdomain>.workers.dev/mcp`

---

## Manual Configuration Reference

After deployment, the following can be managed via MCP tools or directly:

**Set notebook allowlist (index only specific notebooks):**
```bash
npx wrangler kv key put --namespace-id=<KV_ID> "config:joplin:indexed-notebooks" \
  '{"mode":"allowlist","notebookIds":["7736fb661409465e827bbe0d8b57ac4c"]}'
```

**Reset cursor (force full re-index on next cron run):**
```bash
npx wrangler kv key delete --namespace-id=<KV_ID> "cursor:joplin:updated_time"
```

---

## Spec Coverage Check

| Spec requirement | Covered by |
|-----------------|-----------|
| `search_notes` MCP tool with notebook filter | Task 5 |
| `get_note` MCP tool (fetch from bucket) | Task 5 |
| `list_notebooks` MCP tool | Task 5 |
| `get_indexed_notebooks` / `set_indexed_notebooks` | Task 5 |
| Cron indexer with notebook allowlist | Task 4 |
| Soft-delete handling (deleted_time != 0) | Task 4 |
| Joplin sync-format parser | Task 2 |
| Parser unit test with empty-body fixture | Task 2 |
| R2 native binding for joplin-notes | Task 1 |
| KV for cursor + config | Task 1, 4 |
| AI Search sink upsert/remove | Task 3 |
| `type_==1` filter (notes only) | Task 4 |
| Skip `.sync/`, `locks/`, `temp/`, `info.json` | Task 4 |
| Notebook name resolution from parent_id | Task 4 |
| nodejs_compat compatibility flag | Task 1 |
| Deploy behind Cloudflare Access | Task 8 |
