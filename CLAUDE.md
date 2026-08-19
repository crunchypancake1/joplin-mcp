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
on the user's own Joplin instance. The Joplin Data API itself is never reachable from the public
internet — it's LAN-only, reached from the Worker via a private Workers VPC Service binding.

### Data flow

```
MCP client ──HTTP/SSE──► Worker (/mcp) ──► JoplinMCP (Durable Object)
                                                  │
                          JoplinClient ──► JOPLIN_VPC (Workers VPC Service binding)
                                                  │
                          Cloudflare Tunnel ("Home Network", runs on the GL.iNet router)
                                                  │
                          Joplin Data API (mediaserver.lan:41184, LAN-only)
```

### Key modules

- **`src/index.ts`** — Worker entrypoint: mounts the DO as an MCP server at `/mcp` via `JoplinMCP.serve()`.
- **`src/agent.ts`** — `JoplinMCP` Durable Object (extends `McpAgent`). Registers MCP tools
  (`get_note`, `search_notes`, `recent_notes`, `list_notebooks`, `list_notes`, `create_note`,
  `update_note`, `delete_note`, `create_notebook`, `update_notebook`, `delete_notebook`), resolves
  their name-or-ID arguments via `JoplinResolver`, and formats results as MCP tool responses.
- **`src/joplin-client.ts`** — `JoplinClient`: thin wrapper around the Joplin Data API. Handles
  token-authenticated requests, list-endpoint pagination, and filtering trashed items out of every
  result. Throws `JoplinApiError` on non-2xx responses.
- **`src/resolver.ts`** — `JoplinResolver`: turns note/notebook *names* into IDs, and caches the
  folder list and (as a fallback) a note-title index in the Durable Object.
- **`src/fuzzy.ts`** — title scoring and match resolution. Pure functions, no I/O.
- **`src/format.ts`** — pure text helpers (`timestamp`, `splice`, `snippet`). Kept separate from
  `agent.ts` so tests can import them without pulling in the Workers runtime (`agents/mcp` imports
  `cloudflare:workers`, which the Vitest node loader can't resolve).
- **`src/types.ts`** — `Env` binding shape.

### Tool design: minimising agent round trips

The tool surface is optimised for a calling agent, not for a 1:1 mapping onto the Data API:

- **Names, not just IDs.** Every note/notebook argument accepts a title or a 32-hex ID.
  `JoplinResolver` resolves titles through Joplin's own `/search` (one API call), falling back to a
  locally-ranked title index only when search returns nothing. Ambiguous names return the candidate
  list with IDs rather than a guess — `src/fuzzy.ts` decides confident vs. ambiguous.
- **`update_note` has `append`/`prepend`.** The read-modify-write happens server-side, so adding a
  line to a note is one tool call rather than `get_note` + `update_note` with the whole body.
- **A default notebook.** Omitting `notebook` uses the one named by the `JOPLIN_DEFAULT_NOTEBOOK`
  var (default `"Default"`). If no such notebook exists the tool says so rather than picking one.
- **Caching.** The DO is long-lived, so the folder list (5 min TTL) and note-title index (1 min TTL)
  are cached on the resolver, keyed on the in-flight *promise* so concurrent handlers don't
  stampede. Mutations invalidate the relevant cache.

### Bindings (wrangler.jsonc)

| Binding | Type | Purpose |
|---|---|---|
| `JOPLIN_MCP` | Durable Object | McpAgent instance (with SQLite) |
| `JOPLIN_VPC` | VPC Service (`vpc_services`) | Private route to the Joplin Data API over Cloudflare Tunnel — no public hostname |
| `JOPLIN_API_TOKEN` | Secrets Store (`secrets_store_secrets`) | Joplin Data API token |
| `JOPLIN_DEFAULT_NOTEBOOK` | `vars` | Notebook used when a tool call names none (default `"Default"`) |

`JOPLIN_VPC` and `JOPLIN_API_TOKEN` are the only configuration this Worker needs — both are used by
`JoplinClient`, which takes the VPC binding directly (typed as `Fetcher`) instead of a base URL
string and calls `vpc.fetch(...)` instead of the global `fetch()`. `JOPLIN_API_TOKEN` points at the
`joplin-token` secret in the account's Secrets Store and is an async binding — read via
`await env.JOPLIN_API_TOKEN.get()` (done once in `agent.ts#init`), not a plain string like a `vars`
entry.

The VPC Service (`joplin-data-api`) is registered against the Joplin host (`mediaserver.lan:41184`)
through the "Home Network" Cloudflare Tunnel — see
[Workers VPC](https://developers.cloudflare.com/workers-vpc/) for the underlying mechanism. That
tunnel also carries a few unrelated services on other hostnames (home assistant, music, linkwarden,
bitwarden) — don't touch those when working on this project's tunnel config.

The Worker's public `/mcp` route (`joplin.crunchypancake.com`) is a Workers **Custom Domain**
(`{ "pattern": "joplin.crunchypancake.com", "custom_domain": true }` in `wrangler.jsonc`), which
Cloudflare provisions and owns the DNS record for directly — it has no dependency on the tunnel or
any manually-managed DNS record. This matters: an earlier zone-Route version of this config shared
its DNS record with the tunnel's Public Hostname entry for Joplin, and removing that entry (as part
of retiring the public Joplin API path) deleted the DNS record and took `/mcp` down with it. Custom
Domains route the whole hostname to the Worker (no path scoping) — safe here because the MCP
handler already returns a clean 404 for any path other than `/mcp`.

### Notes on the Joplin Data API

- List endpoints (`/folders`, `/folders/:id/notes`, `/notes`, `/search`) are paginated
  (`page`, `has_more`, `limit` max 100); `JoplinClient.paginate` walks them, honouring an optional
  result cap.
- **Trash handling is version-negotiated at runtime.** Joplin gained trash (and the `deleted_time`
  column) in ~v3.1. Older instances have no such column and answer a request for it with a raw
  `SQLITE_ERROR` rather than a clean 4xx. `JoplinClient` therefore asks for `deleted_time` on the
  first request, and on that specific error retries without it and remembers the answer for the
  lifetime of the client. Don't hardcode either behaviour — the live instance's version is not
  pinned by this repo. Trashed items are filtered out three ways: `include_deleted=0` /
  `include_conflicts=0` on list calls (ignored by old versions), a `deleted_time` check, and the
  fixed trash folder ID `de1e7ede1e7ede1e7ede1e7ede1e7ede`.
- `delete_notebook` calls `DELETE /folders/:id?permanent=0`, which moves the notebook to trash
  (recoverable from Joplin) rather than purging it. `delete_note` does the same unless `permanent`
  is set — but on pre-3.1 instances there is no trash for notes and the delete is always permanent.
- `GET /folders` may return a tree (sub-notebooks under `children`) or a flat page depending on
  version; `flattenFolders` handles both and prunes trashed subtrees whole.
- Search syntax (`title:`, `tag:`, `any:1`, `-term`, trailing `*`) is documented at
  <https://joplinapp.org/help/apps/search/>. Wildcards only work at the *end* of a word, which is
  why fuzzy title matching is done locally rather than pushed into the query.
