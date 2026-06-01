# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # wrangler dev — local development with hot reload
npm run deploy       # wrangler deploy — deploy to Cloudflare Workers
npm run test         # vitest run — run all tests once
npm run typecheck    # tsc --noEmit — type-check without emitting
```

Run a single test file:
```bash
npx vitest run test/parser.test.ts
```

## Architecture

This is a Cloudflare Workers project that exposes Joplin notes as an MCP (Model Context Protocol) server and indexes them into an AI search sink.

### Data flow

```
Joplin mobile/desktop
    → sync to R2 (JOPLIN_NOTES bucket, raw .md files per note/folder)
    → hourly cron → runIndexer() → R2SearchSink (SINK_BUCKET)
    → Workers AI AutoRAG (AI_SEARCH_INSTANCE = "personal-search")
    → MCP search_notes tool queries AutoRAG
```

### Key modules

- **`src/index.ts`** — Worker entrypoint: mounts the DO as an MCP server at `/mcp` via `JoplinMCP.serve()`, wires the hourly cron to `runIndexer`.
- **`src/agent.ts`** — `JoplinMCP` Durable Object (extends `McpAgent`). Registers five MCP tools: `search_notes`, `get_note`, `list_notebooks`, `get_indexed_notebooks`, `set_indexed_notebooks`.
- **`src/indexer.ts`** — `runIndexer()`: paginate JOPLIN_NOTES R2 bucket, parse all items, apply notebook allow/denylist (stored in KV as `config:joplin:indexed-notebooks`), upsert changed notes and remove deleted ones to SINK_BUCKET. Uses a KV cursor (`cursor:joplin:updated_time`) to skip unchanged items.
- **`src/parser.ts`** — `parseJoplinItem()`: parses the Joplin sync file format (title on line 0, blank line, body, then `key: value` metadata block at the end).
- **`src/sink.ts`** — `R2SearchSink`: implements `SearchSink` interface; writes docs to SINK_BUCKET at path `joplin/<notebookId>/<noteId>.md`.
- **`src/types.ts`** — Shared types: `Env`, `NormalizedDoc`, `SearchSink`, `JoplinItem`, `NotebookConfig`, and skip-prefix constants.

### Bindings (wrangler.jsonc)

| Binding | Type | Purpose |
|---|---|---|
| `JOPLIN_MCP` | Durable Object | McpAgent instance (with SQLite) |
| `JOPLIN_NOTES` | R2 | Joplin sync bucket (read-only by this worker) |
| `SINK_BUCKET` | R2 | Shared AI search sink (`ai-search-sink` bucket) — written by indexer |
| `JOPLIN_KV` | KV | Cursor + notebook config |
| `AI` | Workers AI | AutoRAG queries |

### Shared sink contract

`SINK_BUCKET` (`ai-search-sink`) is shared with other workers (e.g. linkwarden-mcp). Keys are source-prefixed: `joplin/<notebookId>/<noteId>.md`. The `NormalizedDoc` interface in `src/types.ts` is the cross-worker document contract — changes to it must be coordinated across all workers writing to this bucket.

### Notebook allow/denylist

Stored in KV as JSON at key `config:joplin:indexed-notebooks` with shape `{ mode: "allowlist"|"denylist", notebookIds: string[] }`. Empty `notebookIds` means "index all" in either mode.

### Joplin sync file format

Each Joplin item (note or folder) is a `.md` file in R2 with:
- Line 0: title
- Line 1: blank
- Lines 2..N-1: note body (may be empty)
- Lines N..: metadata block (`key: value` pairs, one per line, contiguous at the end)

`type_: 1` = note, `type_: 2` = folder/notebook. `deleted_time != 0` means the item is soft-deleted.
