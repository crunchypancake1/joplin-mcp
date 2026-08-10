import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JoplinApiError, JoplinClient } from "./joplin-client.js";
import type { Env } from "./types.js";

function errorContent(err: unknown) {
  const text = err instanceof JoplinApiError ? `Error ${err.status}: ${err.message}` : String(err);
  return { content: [{ type: "text" as const, text }], isError: true };
}

export class JoplinMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Joplin Notes", version: "1.0.0" });

  private client!: JoplinClient;

  async init() {
    const token = await this.env.JOPLIN_API_TOKEN.get();
    this.client = new JoplinClient(this.env.JOPLIN_CLIENT_URL, token);

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
        let note;
        try {
          note = await this.client.getNote(id);
        } catch (err) {
          return errorContent(err);
        }

        if (!note) {
          return {
            content: [{ type: "text" as const, text: `Note not found: ${id}` }],
            isError: true,
          };
        }

        const result = [
          `# ${note.title}`,
          "",
          note.body || "_No content_",
          "",
          "---",
          `ID: ${note.id}`,
          `Notebook ID: ${note.parent_id}`,
          `Created: ${new Date(note.created_time).toISOString()}`,
          `Updated: ${new Date(note.updated_time).toISOString()}`,
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
        let notebooks;
        try {
          notebooks = await this.client.listNotebooks();
        } catch (err) {
          return errorContent(err);
        }

        notebooks.sort((a, b) => a.title.localeCompare(b.title));

        const text =
          notebooks.length === 0
            ? "No notebooks found."
            : notebooks.map((n) => `${n.title} (${n.id})`).join("\n");

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
        let notes;
        try {
          notes = await this.client.listNotes(notebookId);
        } catch (err) {
          return errorContent(err);
        }

        notes.sort((a, b) => a.title.localeCompare(b.title));

        const text =
          notes.length === 0
            ? `No notes found in notebook ${notebookId}.`
            : notes.map((n) => `${n.title} (${n.id})`).join("\n");

        return { content: [{ type: "text" as const, text }] };
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
        try {
          const note = await this.client.createNote(title, body ?? "", notebookId);
          return { content: [{ type: "text" as const, text: `Created note "${note.title}" (${note.id})` }] };
        } catch (err) {
          return errorContent(err);
        }
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

        try {
          const note = await this.client.updateNote(id, payload);
          return { content: [{ type: "text" as const, text: `Updated note "${note.title}" (${note.id})` }] };
        } catch (err) {
          return errorContent(err);
        }
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
        try {
          await this.client.deleteNote(id);
          return { content: [{ type: "text" as const, text: `Deleted note ${id}` }] };
        } catch (err) {
          return errorContent(err);
        }
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
        try {
          const notebook = await this.client.createNotebook(title, parentId);
          return { content: [{ type: "text" as const, text: `Created notebook "${notebook.title}" (${notebook.id})` }] };
        } catch (err) {
          return errorContent(err);
        }
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

        try {
          const notebook = await this.client.updateNotebook(id, payload);
          return { content: [{ type: "text" as const, text: `Updated notebook "${notebook.title}" (${notebook.id})` }] };
        } catch (err) {
          return errorContent(err);
        }
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
        try {
          await this.client.deleteNotebook(id);
          return { content: [{ type: "text" as const, text: `Moved notebook ${id} to trash` }] };
        } catch (err) {
          return errorContent(err);
        }
      }
    );
  }
}
