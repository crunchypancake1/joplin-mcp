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
npx vitest run test/joplin-client.test.ts
```

## Architecture

This is a Cloudflare Workers project that exposes a live Joplin instance as an MCP (Model Context
Protocol) server. There is no index or cache — every tool call goes straight to the Joplin Data API
on the user's own Joplin instance.

### Data flow

```
MCP client ──HTTP/SSE──► Worker (/mcp) ──► JoplinMCP (Durable Object)
                                                  │
                                    JoplinClient ──► Joplin Data API (JOPLIN_CLIENT_URL)
```

### Key modules

- **`src/index.ts`** — Worker entrypoint: mounts the DO as an MCP server at `/mcp` via `JoplinMCP.serve()`.
- **`src/agent.ts`** — `JoplinMCP` Durable Object (extends `McpAgent`). Registers MCP tools
  (`get_note`, `list_notebooks`, `list_notes`, `create_note`, `update_note`, `delete_note`,
  `create_notebook`, `update_notebook`, `delete_notebook`) that call a `JoplinClient` and format
  results as MCP tool responses.
- **`src/joplin-client.ts`** — `JoplinClient`: thin wrapper around the Joplin Data API. Handles
  token-authenticated requests, list-endpoint pagination, and filtering trashed items out of list
  results. Throws `JoplinApiError` on non-2xx responses.
- **`src/types.ts`** — `Env` binding shape.

### Bindings (wrangler.jsonc)

| Binding | Type | Purpose |
|---|---|---|
| `JOPLIN_MCP` | Durable Object | McpAgent instance (with SQLite) |

`vars.JOPLIN_CLIENT_URL` (base URL of the live Joplin Data API) and `JOPLIN_API_TOKEN` are the only
configuration this Worker needs — both are used by `JoplinClient`. `JOPLIN_API_TOKEN` is a Secrets
Store binding (`secrets_store_secrets` in `wrangler.jsonc`), pointing at the `joplin-token` secret
in the account's Secrets Store. It's an async binding — read via `await env.JOPLIN_API_TOKEN.get()`
(done once in `agent.ts#init`), not a plain string like a `vars` entry.

### Notes on the Joplin Data API

- List endpoints (`/folders`, `/folders/:id/notes`) are paginated (`page`, `has_more`); `JoplinClient`
  walks every page and returns everything. It does **not** filter by `deleted_time` — the live
  Joplin instance this Worker talks to predates the Trash feature (~v3.1), so `notes`/`folders`
  have no `deleted_time` column at all, and requesting that field throws a raw `SQLITE_ERROR`.
  If the target instance is ever upgraded past v3.1, trash filtering could be reintroduced.
- `delete_notebook` calls `DELETE /folders/:id?permanent=0`, which moves the notebook to trash
  (recoverable from Joplin) rather than purging it.
- `delete_note` permanently deletes — Joplin's Data API has no trash for notes.
