# Joplin MCP

An [MCP](https://modelcontextprotocol.io) server that exposes a [Joplin](https://joplinapp.org/)
note collection as a tool set, running as a stateful agent on Cloudflare Workers. Point an MCP
client (Claude, etc.) at the deployed endpoint and it can browse notebooks and notes, and
create/update/delete notes and notebooks directly against your own Joplin instance.

## How it works

Every tool call goes straight to the Joplin Data API on your live instance — there's no index or
cache in between. The Joplin Data API itself is never exposed to the public internet: the Worker
reaches it privately through a [Workers VPC Service](https://developers.cloudflare.com/workers-vpc/)
binding over a Cloudflare Tunnel.

```
MCP client ──HTTP/SSE──► Worker (/mcp) ──► JoplinMCP (Durable Object)
                                                  │
                          JoplinClient ──► JOPLIN_VPC (Workers VPC Service)
                                                  │
                          Cloudflare Tunnel ──► Joplin Data API (LAN-only)
```

`JoplinMCP` is a [`McpAgent`](https://github.com/cloudflare/agents) hosted on a Durable Object.

## Tools

| Tool | Description |
|---|---|
| `get_note` | Fetch a single note by ID — title, body, metadata |
| `list_notebooks` | List all notebooks with IDs and names |
| `list_notes` | List notes in a given notebook |
| `create_note` | Create a note in a notebook |
| `update_note` | Update a note's title, body, or notebook |
| `delete_note` | Permanently delete a note |
| `create_notebook` | Create a notebook, optionally nested |
| `update_notebook` | Rename or move a notebook |
| `delete_notebook` | Move a notebook (and its notes) to trash |

## Setup

```bash
npm install
```

Before deploying, your Joplin Data API needs to be reachable from a Cloudflare Tunnel, registered as
a [Workers VPC Service](https://developers.cloudflare.com/workers-vpc/get-started/):

```bash
npx wrangler vpc service create joplin-data-api \
  --type http \
  --tunnel-id <YOUR_TUNNEL_ID> \
  --hostname <JOPLIN_HOST_ON_YOUR_LAN> \
  --http-port <JOPLIN_PORT>
```

Then bind the resulting service ID in `wrangler.jsonc`:

```jsonc
"vpc_services": [
  { "binding": "JOPLIN_VPC", "service_id": "<service-id-from-above>", "remote": true }
]
```

`JOPLIN_API_TOKEN` (a Joplin Data API token) is read from Cloudflare's
[Secrets Store](https://developers.cloudflare.com/secrets-store/), not a plain Wrangler secret.
Create it once per account and it's reusable across Workers:

```bash
wrangler secrets-store secret create <store-id> \
  --name joplin-token --scopes workers --remote
```

`wrangler.jsonc` then binds it via `secrets_store_secrets`:

```jsonc
"secrets_store_secrets": [
  { "binding": "JOPLIN_API_TOKEN", "store_id": "<store-id>", "secret_name": "joplin-token" }
]
```

For local dev, create a local-only secret with the same name (omit `--remote`) so `wrangler dev`
has something to read.

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

Or connect this repository to a Cloudflare Worker for git-based deploys. Either way, the
`joplin-token` secret must exist in the account's Secrets Store — it is never stored in the repo.

## Stack

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) + Durable Objects (SQLite-backed)
- [Cloudflare Agents SDK](https://github.com/cloudflare/agents) (`agents/mcp`)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- TypeScript, [Zod](https://zod.dev/) for tool input schemas, [Vitest](https://vitest.dev/)
