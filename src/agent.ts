import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JoplinApiError, JoplinClient, type JoplinNote, type JoplinNoteMeta } from "./joplin-client.js";
import { JoplinResolver, type NoteLookup, type NotebookLookup } from "./resolver.js";
import { snippet, splice, timestamp } from "./format.js";
import type { Env } from "./types.js";

const DEFAULT_NOTEBOOK_FALLBACK = "Default";

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

function errorContent(err: unknown) {
  return failure(
    err instanceof JoplinApiError ? `Error ${err.status}: ${err.message}` : String(err)
  );
}

// A schema shared by every tool that takes a notebook: name or ID, both fine.
const notebookArg = z
  .string()
  .optional()
  .describe(
    "Notebook name (fuzzy-matched, e.g. 'work' finds 'Work Notes') or 32-hex ID. " +
      "Omit to use the default notebook."
  );

export class JoplinMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Joplin Notes", version: "2.0.0" });

  private client!: JoplinClient;
  private resolver!: JoplinResolver;

  // Renders the "couldn't pin this down to one notebook" cases as an actionable message.
  private notebookError(lookup: NotebookLookup): string {
    if (lookup.resolution.kind === "ambiguous") {
      const options = lookup.resolution.candidates
        .map((c) => `- ${c.item.title} (${c.item.id})`)
        .join("\n");
      return `"${lookup.query}" matches several notebooks. Retry with one of:\n${options}`;
    }
    return lookup.usedDefault
      ? `No default notebook found. Expected a notebook named "${lookup.query}" — ` +
          `create it, set JOPLIN_DEFAULT_NOTEBOOK to an existing one, or pass 'notebook' explicitly.`
      : `No notebook matches "${lookup.query}". Use list_notebooks to see what exists.`;
  }

  private async noteError(lookup: NoteLookup, ref: string): Promise<string> {
    if (lookup.kind === "ambiguous") {
      const options = await Promise.all(
        lookup.candidates.map(
          async (c) =>
            `- ${c.item.title} (${c.item.id}) in ${await this.resolver.folderPath(c.item.parent_id)}`
        )
      );
      return `"${ref}" matches several notes. Retry with one of these IDs:\n${options.join("\n")}`;
    }
    return `No note matches "${ref}". Try search_notes to find it by content.`;
  }

  // Resolves a notebook argument, returning either its ID or a ready-to-return error.
  private async notebookId(ref?: string): Promise<{ id: string } | { error: string }> {
    const lookup = await this.resolver.resolveNotebook(ref);
    return lookup.resolution.kind === "one"
      ? { id: lookup.resolution.item.id }
      : { error: this.notebookError(lookup) };
  }

  private async noteId(ref: string, notebookId?: string): Promise<{ id: string } | { error: string }> {
    const lookup = await this.resolver.resolveNote(ref, notebookId);
    return lookup.kind === "one" ? { id: lookup.id } : { error: await this.noteError(lookup, ref) };
  }

  private async renderNote(note: JoplinNote, maxChars?: number): Promise<string> {
    let body = note.body || "_No content_";
    if (maxChars && body.length > maxChars) {
      body = `${body.slice(0, maxChars)}\n\n[truncated — ${body.length} chars total; call again without maxChars for the rest]`;
    }
    const path = await this.resolver.folderPath(note.parent_id);
    return [
      `# ${note.title}`,
      `ID: ${note.id} · Notebook: ${path} (${note.parent_id}) · Updated: ${timestamp(note.updated_time)}`,
      "",
      body,
    ].join("\n");
  }

  private async renderList(notes: JoplinNoteMeta[], showNotebook: boolean): Promise<string> {
    const lines = await Promise.all(
      notes.map(async (note) => {
        const where = showNotebook ? ` — ${await this.resolver.folderPath(note.parent_id)}` : "";
        return `- ${note.title} (${note.id})${where} — updated ${timestamp(note.updated_time)}`;
      })
    );
    return lines.join("\n");
  }

  async init() {
    const token = await this.env.JOPLIN_API_TOKEN.get();
    this.client = new JoplinClient(this.env.JOPLIN_VPC, token);
    this.resolver = new JoplinResolver(
      this.client,
      this.env.JOPLIN_DEFAULT_NOTEBOOK?.trim() || DEFAULT_NOTEBOOK_FALLBACK
    );

    // ── get_note ──────────────────────────────────────────────────────────
    this.server.registerTool(
      "get_note",
      {
        description:
          "Read a note by name or ID. Accepts the note's title (fuzzy-matched, so " +
          "'grocery list' finds 'Grocery List') — no need to list notes first to find an ID. " +
          "Returns the full body. Trashed notes are never returned.",
        inputSchema: {
          note: z.string().describe("Note title (fuzzy) or 32-hex note ID"),
          notebook: notebookArg.describe(
            "Optional: restrict the title search to this notebook (name or ID). " +
              "Only needed to disambiguate notes that share a title."
          ),
          maxChars: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Truncate the body to this many characters. Omit for the whole note."),
        },
      },
      async ({ note, notebook, maxChars }) => {
        try {
          let scope: string | undefined;
          if (notebook !== undefined) {
            const resolved = await this.notebookId(notebook);
            if ("error" in resolved) return failure(resolved.error);
            scope = resolved.id;
          }

          const target = await this.noteId(note, scope);
          if ("error" in target) return failure(target.error);

          const found = await this.client.getNote(target.id);
          if (!found) return failure(`Note not found (or in trash): ${note}`);

          return text(await this.renderNote(found, maxChars));
        } catch (err) {
          return errorContent(err);
        }
      }
    );

    // ── search_notes ──────────────────────────────────────────────────────
    this.server.registerTool(
      "search_notes",
      {
        description:
          "Full-text search across all notes (title and body). Use this when you know what a " +
          "note is about but not its exact title. Supports Joplin search syntax: 'title:budget', " +
          "'tag:work', 'any:1 cat dog', '-excluded', trailing wildcards like 'kube*'. " +
          "Returns matches with IDs and a snippet; trashed notes are excluded.",
        inputSchema: {
          query: z.string().describe("Search query"),
          notebook: notebookArg.describe("Optional: limit results to this notebook (name or ID)"),
          limit: z.number().int().positive().max(100).optional().describe("Max results (default 20)"),
          includeBody: z
            .boolean()
            .optional()
            .describe("Return each match's full body instead of a snippet (default false)"),
        },
      },
      async ({ query, notebook, limit, includeBody }) => {
        try {
          let scope: string | undefined;
          if (notebook !== undefined) {
            const resolved = await this.notebookId(notebook);
            if ("error" in resolved) return failure(resolved.error);
            scope = resolved.id;
          }

          const wanted = limit ?? 20;
          // Scoping happens here rather than via Joplin's `notebook:` filter, which
          // matches on title and can't distinguish same-named notebooks. Over-fetch so
          // the filter still has a full page's worth to return.
          const hits = (
            await this.client.searchNotes(query, {
              limit: scope ? Math.min(100, wanted * 5) : wanted,
              includeBody: true,
            })
          )
            .filter((hit) => !scope || hit.parent_id === scope)
            .slice(0, wanted);

          if (hits.length === 0) return text(`No notes match "${query}".`);

          const rendered = await Promise.all(
            hits.map(async (hit) => {
              const path = await this.resolver.folderPath(hit.parent_id);
              const head = `- ${hit.title} (${hit.id}) — ${path} — updated ${timestamp(hit.updated_time)}`;
              const body = includeBody ? hit.body || "" : snippet(hit.body ?? "", query);
              return body ? `${head}\n  ${body.replace(/\n/g, "\n  ")}` : head;
            })
          );

          return text(`${hits.length} match(es) for "${query}":\n${rendered.join("\n")}`);
        } catch (err) {
          return errorContent(err);
        }
      }
    );

    // ── list_notebooks ────────────────────────────────────────────────────
    this.server.registerTool(
      "list_notebooks",
      {
        description:
          "List all notebooks as full paths with IDs. Trashed notebooks are excluded. " +
          "You rarely need this — other tools accept notebook names directly.",
        inputSchema: {},
      },
      async () => {
        try {
          const notebooks = await this.resolver.folderList();
          if (notebooks.length === 0) return text("No notebooks found.");

          const lines = await Promise.all(
            notebooks.map(async (nb) => `${await this.resolver.folderPath(nb.id)} (${nb.id})`)
          );
          lines.sort((a, b) => a.localeCompare(b));

          return text(
            `${lines.join("\n")}\n\nDefault notebook: ${this.resolver.defaultNotebookName}`
          );
        } catch (err) {
          return errorContent(err);
        }
      }
    );

    // ── list_notes ────────────────────────────────────────────────────────
    this.server.registerTool(
      "list_notes",
      {
        description:
          "List notes in a notebook, most recently updated first. Defaults to the default " +
          "notebook when none is given. Titles only — use get_note or search_notes to read content.",
        inputSchema: {
          notebook: notebookArg,
          limit: z.number().int().positive().max(200).optional().describe("Max notes to return"),
          sort: z
            .enum(["updated", "created", "title"])
            .optional()
            .describe("Sort order (default 'updated', newest first)"),
        },
      },
      async ({ notebook, limit, sort }) => {
        try {
          const resolved = await this.notebookId(notebook);
          if ("error" in resolved) return failure(resolved.error);

          const orderBy = sort === "title" ? "title" : sort === "created" ? "created_time" : "updated_time";
          const notes = await this.client.listNotes(resolved.id, {
            limit,
            orderBy,
            orderDir: sort === "title" ? "ASC" : "DESC",
          });

          const path = await this.resolver.folderPath(resolved.id);
          if (notes.length === 0) return text(`No notes in ${path}.`);

          return text(`${notes.length} note(s) in ${path}:\n${await this.renderList(notes, false)}`);
        } catch (err) {
          return errorContent(err);
        }
      }
    );

    // ── recent_notes ──────────────────────────────────────────────────────
    this.server.registerTool(
      "recent_notes",
      {
        description:
          "Most recently updated notes across every notebook. The fastest way to find " +
          "the note the user was just working on.",
        inputSchema: {
          limit: z.number().int().positive().max(100).optional().describe("Max notes (default 20)"),
        },
      },
      async ({ limit }) => {
        try {
          const notes = await this.client.listAllNotes({ limit: limit ?? 20 });
          if (notes.length === 0) return text("No notes found.");
          return text(await this.renderList(notes, true));
        } catch (err) {
          return errorContent(err);
        }
      }
    );

    // ── create_note ───────────────────────────────────────────────────────
    this.server.registerTool(
      "create_note",
      {
        description:
          "Create a note. Goes in the default notebook unless 'notebook' says otherwise.",
        inputSchema: {
          title: z.string().describe("Note title"),
          body: z.string().optional().describe("Note body (markdown)"),
          notebook: notebookArg,
        },
      },
      async ({ title, body, notebook }) => {
        try {
          const resolved = await this.notebookId(notebook);
          if ("error" in resolved) return failure(resolved.error);

          const note = await this.client.createNote(title, body ?? "", resolved.id);
          this.resolver.invalidateNotes();

          const path = await this.resolver.folderPath(resolved.id);
          return text(`Created "${note.title}" (${note.id}) in ${path}`);
        } catch (err) {
          return errorContent(err);
        }
      }
    );

    // ── update_note ───────────────────────────────────────────────────────
    this.server.registerTool(
      "update_note",
      {
        description:
          "Update a note, identified by title (fuzzy) or ID. Use 'append' or 'prepend' to add " +
          "text without reading the note first — that turns a read-then-write into one call. " +
          "Use 'body' only when replacing the whole note.",
        inputSchema: {
          note: z.string().describe("Note title (fuzzy) or 32-hex note ID"),
          title: z.string().optional().describe("New title"),
          body: z.string().optional().describe("Replace the entire body with this"),
          append: z.string().optional().describe("Add this to the end of the existing body"),
          prepend: z.string().optional().describe("Add this to the start of the existing body"),
          notebook: notebookArg.describe("Optional: move the note to this notebook (name or ID)"),
        },
      },
      async ({ note, title, body, append, prepend, notebook }) => {
        if (body !== undefined && (append !== undefined || prepend !== undefined)) {
          return failure("Use either 'body' (full replace) or 'append'/'prepend', not both.");
        }
        if ([title, body, append, prepend, notebook].every((value) => value === undefined)) {
          return failure("Nothing to update — pass at least one of title, body, append, prepend, notebook.");
        }

        try {
          const target = await this.noteId(note);
          if ("error" in target) return failure(target.error);

          const payload: Record<string, string> = {};
          if (title !== undefined) payload.title = title;
          if (body !== undefined) payload.body = body;

          if (append !== undefined || prepend !== undefined) {
            const current = await this.client.getNote(target.id);
            if (!current) return failure(`Note not found (or in trash): ${note}`);
            payload.body = splice(current.body ?? "", { append, prepend });
          }

          if (notebook !== undefined) {
            const resolved = await this.notebookId(notebook);
            if ("error" in resolved) return failure(resolved.error);
            payload.parent_id = resolved.id;
          }

          const updated = await this.client.updateNote(target.id, payload);
          this.resolver.invalidateNotes();
          return text(`Updated "${updated.title}" (${updated.id})`);
        } catch (err) {
          return errorContent(err);
        }
      }
    );

    // ── delete_note ───────────────────────────────────────────────────────
    this.server.registerTool(
      "delete_note",
      {
        description:
          "Move a note to trash (recoverable from Joplin). Set permanent to delete outright. " +
          "Note: on Joplin versions older than 3.1 there is no trash for notes and this always " +
          "deletes permanently.",
        inputSchema: {
          note: z.string().describe("Note title (fuzzy) or 32-hex note ID"),
          permanent: z.boolean().optional().describe("Purge instead of trashing (default false)"),
        },
      },
      async ({ note, permanent }) => {
        try {
          const target = await this.noteId(note);
          if ("error" in target) return failure(target.error);

          await this.client.deleteNote(target.id, permanent ?? false);
          this.resolver.invalidateNotes();
          return text(permanent ? `Permanently deleted note ${target.id}` : `Moved note ${target.id} to trash`);
        } catch (err) {
          return errorContent(err);
        }
      }
    );

    // ── create_notebook ───────────────────────────────────────────────────
    this.server.registerTool(
      "create_notebook",
      {
        description: "Create a notebook, optionally nested under an existing one.",
        inputSchema: {
          title: z.string().describe("Notebook title"),
          parent: z
            .string()
            .optional()
            .describe("Parent notebook name (fuzzy) or ID. Omit to create at the top level."),
        },
      },
      async ({ title, parent }) => {
        try {
          let parentId: string | undefined;
          if (parent !== undefined) {
            const resolved = await this.notebookId(parent);
            if ("error" in resolved) return failure(resolved.error);
            parentId = resolved.id;
          }

          const notebook = await this.client.createNotebook(title, parentId);
          this.resolver.invalidateFolders();
          return text(`Created notebook "${notebook.title}" (${notebook.id})`);
        } catch (err) {
          return errorContent(err);
        }
      }
    );

    // ── update_notebook ───────────────────────────────────────────────────
    this.server.registerTool(
      "update_notebook",
      {
        description: "Rename a notebook or move it under a different parent.",
        inputSchema: {
          notebook: z.string().describe("Notebook name (fuzzy) or 32-hex ID"),
          title: z.string().optional().describe("New title"),
          parent: z.string().optional().describe("Move under this parent notebook (name or ID)"),
        },
      },
      async ({ notebook, title, parent }) => {
        if (title === undefined && parent === undefined) {
          return failure("Nothing to update — pass title and/or parent.");
        }

        try {
          const target = await this.notebookId(notebook);
          if ("error" in target) return failure(target.error);

          const payload: Record<string, string> = {};
          if (title !== undefined) payload.title = title;
          if (parent !== undefined) {
            const resolvedParent = await this.notebookId(parent);
            if ("error" in resolvedParent) return failure(resolvedParent.error);
            payload.parent_id = resolvedParent.id;
          }

          const updated = await this.client.updateNotebook(target.id, payload);
          this.resolver.invalidateFolders();
          return text(`Updated notebook "${updated.title}" (${updated.id})`);
        } catch (err) {
          return errorContent(err);
        }
      }
    );

    // ── delete_notebook ───────────────────────────────────────────────────
    this.server.registerTool(
      "delete_notebook",
      {
        description: "Move a notebook and all its notes to trash. Recoverable from Joplin.",
        inputSchema: {
          notebook: z.string().describe("Notebook name (fuzzy) or 32-hex ID"),
        },
      },
      async ({ notebook }) => {
        try {
          const target = await this.notebookId(notebook);
          if ("error" in target) return failure(target.error);

          await this.client.deleteNotebook(target.id);
          this.resolver.invalidateFolders();
          this.resolver.invalidateNotes();
          return text(`Moved notebook ${target.id} to trash`);
        } catch (err) {
          return errorContent(err);
        }
      }
    );
  }
}
