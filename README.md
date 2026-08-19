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

Every tool that takes a note or notebook accepts a **name** as readily as a 32-hex ID, so a
calling agent doesn't have to spend a round trip looking an ID up. Names are fuzzy-matched
(case, accents, punctuation and word order are all forgiven); when a name is genuinely
ambiguous the tool returns the candidates with their IDs instead of guessing.

| Tool | Description |
|---|---|
| `get_note` | Read a note by title (fuzzy) or ID |
| `search_notes` | Full-text search across all notes, with snippets |
| `recent_notes` | Most recently updated notes across every notebook |
| `list_notebooks` | List notebooks as full paths with IDs |
| `list_notes` | List notes in a notebook — the default notebook if none is named |
| `create_note` | Create a note, in the default notebook unless told otherwise |
| `update_note` | Replace the body, or `append`/`prepend` to it without reading it first |
| `delete_note` | Move a note to trash (`permanent` purges it) |
| `create_notebook` | Create a notebook, optionally nested |
| `update_notebook` | Rename or move a notebook |
| `delete_notebook` | Move a notebook (and its notes) to trash |

Trashed notes and notebooks are excluded from every result — listings, search, and direct
reads alike.

### Fewer round trips

The tool surface is shaped so an agent can reach the note it wants in as few calls as
possible. Reading a note by name is one call instead of three:

```
list_notebooks → list_notes → get_note      ⟶   get_note { note: "grocery list" }
```

and adding a line to it is one call instead of two, because `append` does the
read-modify-write server-side:

```
get_note → update_note { body: <whole note> }  ⟶  update_note { note: "grocery list", append: "- milk" }
```

Name resolution goes through Joplin's own search index, so it normally costs a single API
call; a local title index is built only when search comes up empty (typos, or titles the
full-text index tokenises oddly). The notebook list is cached in the Durable Object, so
resolving a notebook name is usually free.

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

### Default notebook

Tools that take a notebook fall back to the one named by the `JOPLIN_DEFAULT_NOTEBOOK` var in
`wrangler.jsonc` (`"Default"` out of the box). Point it at whichever notebook new notes should
land in; if no notebook by that name exists, the tools say so rather than picking one.

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
