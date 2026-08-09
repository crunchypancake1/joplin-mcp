import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseJoplinItem } from "./parser.js";
import type { Env, NotebookConfig } from "./types.js";
import { JOPLIN_SKIP_PREFIXES, JOPLIN_INFO_KEY } from "./types.js";

const CONFIG_KEY = "config:joplin:indexed-notebooks";

export class JoplinMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Joplin Notes", version: "1.0.0" });

  private async joplinFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.env.JOPLIN_CLIENT_URL}${path}${sep}token=${this.env.JOPLIN_API_TOKEN}`;
    return fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
  }

  async init() {
    // ── search_notes ──────────────────────────────────────────────────────
    this.server.registerTool(
      "search_notes",
      {
        description:
          "Semantic search over indexed Joplin notes. Returns ranked note snippets relevant to the query.",
        inputSchema: {
          query: z.string().describe("Search query"),
          topK: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Max number of results (default 5)"),
        },
      },
      async ({ query, topK }) => {
        // autorag API works at runtime; cast to any to avoid deprecated-type noise
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const results = await (this.env.AI as any).autorag(
          this.env.AI_SEARCH_INSTANCE
        ).search({
          query,
          max_num_results: topK ?? 5,
          ranking_options: { score_threshold: 0.3 },
          filters: { folder: "joplin/" },
        }) as { data: Array<{ filename: string; score: number; content: Array<{ type: string; text: string }> }> };

        if (!results.data || results.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No results found." }],
          };
        }

        const text = results.data
          .map(
            (r, i) => {
              const body = r.content.map((c) => c.text).join("\n");
              return `[${i + 1}] ${r.filename} (score: ${r.score.toFixed(3)})\n${body}`;
            }
          )
          .join("\n\n---\n\n");

        return { content: [{ type: "text" as const, text }] };
      }
    );

    // ── get_note ──────────────────────────────────────────────────────────
    this.server.registerTool(
      "get_note",
      {
        description:
          "Fetch a single Joplin note by its ID. Returns title, body, and metadata.",
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
              {
                type: "text" as const,
                text: `Item ${id} is not a note (type_: ${item.type_})`,
              },
            ],
            isError: true,
          };
        }

        if (item.deleted_time !== 0) {
          return {
            content: [{ type: "text" as const, text: `Note ${id} is in trash` }],
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
        description:
          "List all Joplin notebooks (folders) with their IDs and names.",
        inputSchema: {},
      },
      async () => {
        const allObjects: R2Object[] = [];
        let listCursor: string | undefined;
        do {
          const listed: R2Objects = await this.env.JOPLIN_NOTES.list(
            listCursor ? { cursor: listCursor } : {}
          );
          allObjects.push(...listed.objects);
          listCursor = listed.truncated ? listed.cursor : undefined;
        } while (listCursor);

        const itemObjects = allObjects.filter(
          (o) => !JOPLIN_SKIP_PREFIXES.some((p) => o.key.startsWith(p)) && o.key !== JOPLIN_INFO_KEY
        );

        const notebooks: Array<{ id: string; name: string }> = [];

        await Promise.all(
          itemObjects.map(async (obj) => {
            const r2obj = await this.env.JOPLIN_NOTES.get(obj.key);
            if (!r2obj) return;
            const text = await r2obj.text();
            try {
              const item = parseJoplinItem(text);
              if (item.type_ === 2 && item.deleted_time === 0) {
                notebooks.push({ id: item.id, name: item.title });
              }
            } catch {
              // skip malformed items
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

    // ── list_notes ────────────────────────────────────────────────────────
    this.server.registerTool(
      "list_notes",
      {
        description:
          "List all notes in a given Joplin notebook by notebook ID. Returns note titles and IDs.",
        inputSchema: {
          notebookId: z.string().describe("32-character hex notebook (folder) ID"),
        },
      },
      async ({ notebookId }) => {
        const allObjects: R2Object[] = [];
        let listCursor: string | undefined;
        do {
          const listed: R2Objects = await this.env.JOPLIN_NOTES.list(
            listCursor ? { cursor: listCursor } : {}
          );
          allObjects.push(...listed.objects);
          listCursor = listed.truncated ? listed.cursor : undefined;
        } while (listCursor);

        const itemObjects = allObjects.filter(
          (o) => !JOPLIN_SKIP_PREFIXES.some((p) => o.key.startsWith(p)) && o.key !== JOPLIN_INFO_KEY
        );

        const notes: Array<{ id: string; title: string }> = [];

        await Promise.all(
          itemObjects.map(async (obj) => {
            const r2obj = await this.env.JOPLIN_NOTES.get(obj.key);
            if (!r2obj) return;
            const text = await r2obj.text();
            try {
              const item = parseJoplinItem(text);
              if (item.type_ === 1 && item.parent_id === notebookId && item.deleted_time === 0) {
                notes.push({ id: item.id, title: item.title });
              }
            } catch {
              // skip malformed items
            }
          })
        );

        notes.sort((a, b) => a.title.localeCompare(b.title));

        const text =
          notes.length === 0
            ? `No notes found in notebook ${notebookId}.`
            : notes.map((n) => `${n.title} (${n.id})`).join("\n");

        return { content: [{ type: "text" as const, text }] };
      }
    );

    // ── get_indexed_notebooks ─────────────────────────────────────────────
    this.server.registerTool(
      "get_indexed_notebooks",
      {
        description:
          "Get the current notebook indexing configuration (allowlist or denylist).",
        inputSchema: {},
      },
      async () => {
        const raw = await this.env.JOPLIN_KV.get(CONFIG_KEY);
        let config: NotebookConfig;
        try {
          config = raw ? JSON.parse(raw) : { mode: "allowlist", notebookIds: [] };
        } catch {
          return {
            content: [{ type: "text" as const, text: "Error: stored config is malformed JSON. Use set_indexed_notebooks to reset it." }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }],
        };
      }
    );

    // ── create_note ───────────────────────────────────────────────────────
    this.server.registerTool(
      "create_note",
      {
        description: "Create a new note in Joplin. Returns the new note's ID.",
        inputSchema: {
          title: z.string().describe("Note title"),
          body: z.string().optional().describe("Note body (markdown)"),
          notebookId: z.string().describe("ID of the notebook to create the note in"),
        },
      },
      async ({ title, body, notebookId }) => {
        const res = await this.joplinFetch("/notes", {
          method: "POST",
          body: JSON.stringify({ title, body: body ?? "", parent_id: notebookId }),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }], isError: true };
        }
        const note = await res.json() as { id: string; title: string };
        return { content: [{ type: "text" as const, text: `Created note "${note.title}" (${note.id})` }] };
      }
    );

    // ── update_note ───────────────────────────────────────────────────────
    this.server.registerTool(
      "update_note",
      {
        description: "Update an existing Joplin note's title, body, or notebook.",
        inputSchema: {
          id: z.string().describe("32-character hex note ID"),
          title: z.string().optional().describe("New title"),
          body: z.string().optional().describe("New body (markdown)"),
          notebookId: z.string().optional().describe("Move note to this notebook ID"),
        },
      },
      async ({ id, title, body, notebookId }) => {
        const payload: Record<string, string> = {};
        if (title !== undefined) payload.title = title;
        if (body !== undefined) payload.body = body;
        if (notebookId !== undefined) payload.parent_id = notebookId;

        if (Object.keys(payload).length === 0) {
          return { content: [{ type: "text" as const, text: "No fields to update." }], isError: true };
        }

        const res = await this.joplinFetch(`/notes/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }], isError: true };
        }
        const note = await res.json() as { id: string; title: string };
        return { content: [{ type: "text" as const, text: `Updated note "${note.title}" (${note.id})` }] };
      }
    );

    // ── delete_note ───────────────────────────────────────────────────────
    this.server.registerTool(
      "delete_note",
      {
        description: "Permanently delete a Joplin note by ID.",
        inputSchema: {
          id: z.string().describe("32-character hex note ID"),
        },
      },
      async ({ id }) => {
        const res = await this.joplinFetch(`/notes/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Deleted note ${id}` }] };
      }
    );

    // ── create_notebook ───────────────────────────────────────────────────
    this.server.registerTool(
      "create_notebook",
      {
        description: "Create a new Joplin notebook (folder). Returns the new notebook's ID.",
        inputSchema: {
          title: z.string().describe("Notebook title"),
          parentId: z.string().optional().describe("ID of the parent notebook (for nested notebooks)"),
        },
      },
      async ({ title, parentId }) => {
        const payload: Record<string, string> = { title };
        if (parentId !== undefined) payload.parent_id = parentId;
        const res = await this.joplinFetch("/folders", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }], isError: true };
        }
        const notebook = await res.json() as { id: string; title: string };
        return { content: [{ type: "text" as const, text: `Created notebook "${notebook.title}" (${notebook.id})` }] };
      }
    );

    // ── update_notebook ───────────────────────────────────────────────────
    this.server.registerTool(
      "update_notebook",
      {
        description: "Update an existing Joplin notebook's title or move it under a new parent.",
        inputSchema: {
          id: z.string().describe("32-character hex notebook ID"),
          title: z.string().optional().describe("New title"),
          parentId: z.string().optional().describe("Move notebook under this parent ID"),
        },
      },
      async ({ id, title, parentId }) => {
        const payload: Record<string, string> = {};
        if (title !== undefined) payload.title = title;
        if (parentId !== undefined) payload.parent_id = parentId;

        if (Object.keys(payload).length === 0) {
          return { content: [{ type: "text" as const, text: "No fields to update." }], isError: true };
        }

        const res = await this.joplinFetch(`/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }], isError: true };
        }
        const notebook = await res.json() as { id: string; title: string };
        return { content: [{ type: "text" as const, text: `Updated notebook "${notebook.title}" (${notebook.id})` }] };
      }
    );

    // ── delete_notebook ───────────────────────────────────────────────────
    this.server.registerTool(
      "delete_notebook",
      {
        description: "Move a Joplin notebook (and all its notes) to trash. Recoverable from Joplin.",
        inputSchema: {
          id: z.string().describe("32-character hex notebook ID"),
        },
      },
      async ({ id }) => {
        const res = await this.joplinFetch(`/folders/${id}?permanent=0`, { method: "DELETE" });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text" as const, text: `Error ${res.status}: ${err}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Moved notebook ${id} to trash` }] };
      }
    );

    // ── set_indexed_notebooks ─────────────────────────────────────────────
    this.server.registerTool(
      "set_indexed_notebooks",
      {
        description:
          "Set which notebooks are indexed. mode='allowlist' indexes only listed IDs; mode='denylist' excludes listed IDs. Empty notebookIds = all notebooks.",
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
