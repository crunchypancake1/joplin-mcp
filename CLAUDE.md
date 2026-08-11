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
| `JOPLIN_VPC` | VPC Service (`vpc_services`) | Private route to the Joplin Data API over Cloudflare Tunnel — no public hostname |
| `JOPLIN_API_TOKEN` | Secrets Store (`secrets_store_secrets`) | Joplin Data API token |

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

- List endpoints (`/folders`, `/folders/:id/notes`) are paginated (`page`, `has_more`); `JoplinClient`
  walks every page and returns everything. It does **not** filter by `deleted_time` — the live
  Joplin instance this Worker talks to predates the Trash feature (~v3.1), so `notes`/`folders`
  have no `deleted_time` column at all, and requesting that field throws a raw `SQLITE_ERROR`.
  If the target instance is ever upgraded past v3.1, trash filtering could be reintroduced.
- `delete_notebook` calls `DELETE /folders/:id?permanent=0`, which moves the notebook to trash
  (recoverable from Joplin) rather than purging it.
- `delete_note` permanently deletes — Joplin's Data API has no trash for notes.
