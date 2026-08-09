# Joplin MCP

An [MCP](https://modelcontextprotocol.io) server that exposes a [Joplin](https://joplinapp.org/)
note collection as a tool set, running as a stateful agent on Cloudflare Workers. Point an MCP
client (Claude, etc.) at the deployed endpoint and it can browse notebooks and notes, and
create/update/delete notes and notebooks directly against your own Joplin instance.

## How it works

Every tool call goes straight to the Joplin Data API on your live instance — there's no index or
cache in between.

```
MCP client ──HTTP/SSE──► Worker (/mcp) ──► JoplinMCP (Durable Object)
                                                  │
                                    JoplinClient ──► Joplin Data API
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
wrangler secret put JOPLIN_API_TOKEN   # Joplin Data API token
```

Before deploying, set `vars.JOPLIN_CLIENT_URL` in `wrangler.jsonc` to the base URL of your Joplin
Data API.

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
