# Joplin MCP

An [MCP](https://modelcontextprotocol.io) server that exposes a [Joplin](https://joplinapp.org/)
note collection as a tool set, running as a stateful agent on Cloudflare Workers. Point an MCP
client (Claude, etc.) at the deployed endpoint and it can semantically search your notes, browse
notebooks, and create/update/delete notes and notebooks directly against your own Joplin instance.

## How it works

Notes reach this Worker two ways:

**Read path** — Joplin syncs to an R2 bucket (raw sync `.md` files). R2 event notifications push
each change onto a Queue; a queue handler parses the changed item and upserts or removes it from a
shared AI search sink, which Workers AI AutoRAG indexes for semantic search.

```
Joplin mobile/desktop
    → sync to R2 (JOPLIN_NOTES bucket)
    → R2 event notifications (put/delete) → joplin-events Queue
    → queue handler → processR2Event() → search sink (R2)
    → Workers AI AutoRAG
    → MCP search_notes tool queries AutoRAG
```

**Write path** — the mutating tools (`create_note`, `update_note`, ...) skip the index and call the
Joplin Data API on your live instance directly, over a token-authenticated `joplinFetch()` helper.

```
MCP client ──HTTP/SSE──► Worker (/mcp) ──► JoplinMCP (Durable Object)
                                                  │
                                    read: R2 + AutoRAG   write: Joplin Data API
```

`JoplinMCP` is a [`McpAgent`](https://github.com/cloudflare/agents) hosted on a Durable Object.

## Tools

| Tool | Description |
|---|---|
| `search_notes` | Semantic search over indexed notes (AutoRAG) |
| `get_note` | Fetch a single note by ID — title, body, metadata |
| `list_notebooks` | List all notebooks with IDs and names |
| `list_notes` | List notes in a given notebook |
| `get_indexed_notebooks` | Read the current notebook allow/denylist config |
| `set_indexed_notebooks` | Set which notebooks get indexed (allowlist or denylist) |
| `create_note` | Create a note in a notebook |
| `update_note` | Update a note's title, body, or notebook |
| `delete_note` | Permanently delete a note |
| `create_notebook` | Create a notebook, optionally nested |
| `update_notebook` | Rename or move a notebook |
| `delete_notebook` | Move a notebook (and its notes) to trash |

## Setup

```bash
npm install
wrangler secret put JOPLIN_API_TOKEN   # Joplin Data API token
```

Before deploying, configure in `wrangler.jsonc`:
- `vars.JOPLIN_CLIENT_URL` — base URL of your Joplin Data API
- `vars.AI_SEARCH_INSTANCE` — name of the AutoRAG instance backing `search_notes`
- R2 buckets (`JOPLIN_NOTES` for the Joplin sync target, `SINK_BUCKET` for the shared search sink)
- the `JOPLIN_KV` namespace and `joplin-events` Queue consumer

See `CLAUDE.md` for the full architecture and binding reference.

## Development

```bash
npm run dev         # wrangler dev — local development with hot reload
npm run test        # vitest run
npm run typecheck   # tsc --noEmit
```

## Deploy

```bash
npm run deploy
```

Or connect this repository to a Cloudflare Worker for git-based deploys. Either way,
`JOPLIN_API_TOKEN` must be set as a Wrangler secret in the target environment — it is never stored
in the repo.

## Stack

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) + Durable Objects (SQLite-backed)
- [Cloudflare Agents SDK](https://github.com/cloudflare/agents) (`agents/mcp`)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- TypeScript, [Zod](https://zod.dev/) for tool input schemas, [Vitest](https://vitest.dev/)
