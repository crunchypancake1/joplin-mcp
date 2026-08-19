export interface JoplinNoteMeta {
  id: string;
  parent_id: string;
  title: string;
  created_time: number;
  updated_time: number;
  deleted_time?: number;
}

export interface JoplinNote extends JoplinNoteMeta {
  body: string;
}

export interface JoplinFolder {
  id: string;
  parent_id: string;
  title: string;
  deleted_time?: number;
  children?: JoplinFolder[];
}

export class JoplinApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Joplin's trash is a virtual folder with this fixed ID (leetspeak "delete"). Items in
// it are never returned by any tool here.
export const TRASH_FOLDER_ID = "de1e7ede1e7ede1e7ede1e7ede1e7ede";

const NOTE_FIELDS = "id,parent_id,title,body,created_time,updated_time";
const NOTE_META_FIELDS = "id,parent_id,title,created_time,updated_time";
const FOLDER_FIELDS = "id,parent_id,title";

// The Joplin Data API caps a page at 100 items.
const PAGE_SIZE = 100;
// Backstop so a misbehaving has_more can't spin forever.
const MAX_PAGES = 100;

export function isTrashed(item: { id?: string; parent_id?: string; deleted_time?: number }): boolean {
  return (
    Boolean(item.deleted_time) ||
    item.id === TRASH_FOLDER_ID ||
    item.parent_id === TRASH_FOLDER_ID
  );
}

// Joplin ≥3.1 can return /folders as a tree under `children`; older versions return a
// flat page. Handle both, and drop trashed subtrees whole.
function flattenFolders(folders: JoplinFolder[], out: JoplinFolder[] = []): JoplinFolder[] {
  for (const folder of folders) {
    if (isTrashed(folder)) continue;
    const { children, ...rest } = folder;
    out.push(rest as JoplinFolder);
    if (children?.length) flattenFolders(children, out);
  }
  return out;
}

// An instance that predates the trash feature has no deleted_time column and answers
// with a raw SQLite error rather than a clean 4xx.
function isMissingColumnError(body: string): boolean {
  return /SQLITE_ERROR|no such column|unknown field/i.test(body);
}

// Thin wrapper around the Joplin Data API (https://joplinapp.org/api/references/rest_api/),
// reached via a Workers VPC Service binding rather than a public hostname.
export class JoplinClient {
  // null = not yet probed. Joplin gained trash (and deleted_time) in ~v3.1; the first
  // request that asks for the field doubles as feature detection, and the answer is
  // cached for the lifetime of the client.
  private trashFieldSupported: boolean | null = null;

  constructor(
    private readonly vpc: Fetcher,
    private readonly token: string
  ) {}

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `http://joplin${path}${sep}token=${this.token}`;
    return this.vpc.fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
  }

  private fieldsFor(base: string): string {
    return this.trashFieldSupported === false ? base : `${base},deleted_time`;
  }

  // GET that asks for deleted_time, transparently retrying without it on pre-trash
  // instances. Returns null on 404 when allowNotFound is set.
  private async getJson<T>(
    build: (fields: string) => string,
    baseFields: string,
    allowNotFound = false
  ): Promise<T | null> {
    let retried = false;
    for (;;) {
      const res = await this.request(build(this.fieldsFor(baseFields)));
      if (res.ok) {
        this.trashFieldSupported ??= true;
        return (await res.json()) as T;
      }
      if (allowNotFound && res.status === 404) return null;

      const text = await res.text();
      if (!retried && this.trashFieldSupported !== false && isMissingColumnError(text)) {
        this.trashFieldSupported = false;
        retried = true;
        continue;
      }
      throw new JoplinApiError(res.status, text);
    }
  }

  // Walks pages of a list endpoint, dropping trashed items, stopping at `cap` results.
  private async paginate<T extends { id?: string; parent_id?: string; deleted_time?: number }>(
    path: string,
    baseFields: string,
    params: Record<string, string> = {},
    cap = Number.POSITIVE_INFINITY
  ): Promise<T[]> {
    const pageSize = Math.max(1, Math.min(PAGE_SIZE, cap));
    const items: T[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const build = (fields: string) =>
        `${path}?${new URLSearchParams({
          ...params,
          fields,
          page: String(page),
          limit: String(pageSize),
          // Honoured by Joplin ≥3.1; harmlessly ignored by older versions, which is why
          // the deleted_time filtering below is belt-and-braces rather than redundant.
          include_deleted: "0",
          include_conflicts: "0",
        })}`;

      const data = await this.getJson<{ items: T[]; has_more: boolean }>(build, baseFields);
      const page_items = data?.items ?? [];
      items.push(...page_items.filter((item) => !isTrashed(item)));

      if (!data?.has_more || items.length >= cap) break;
    }

    return items.length > cap ? items.slice(0, cap) : items;
  }

  async getNote(id: string): Promise<JoplinNote | null> {
    const note = await this.getJson<JoplinNote>(
      (fields) => `/notes/${encodeURIComponent(id)}?fields=${fields}`,
      NOTE_FIELDS,
      true
    );
    // A trashed note is treated exactly like a missing one.
    return note && !isTrashed(note) ? note : null;
  }

  async listNotebooks(): Promise<JoplinFolder[]> {
    return flattenFolders(await this.paginate<JoplinFolder>("/folders", FOLDER_FIELDS));
  }

  listNotes(
    notebookId: string,
    opts: { limit?: number; orderBy?: string; orderDir?: "ASC" | "DESC" } = {}
  ): Promise<JoplinNoteMeta[]> {
    return this.paginate<JoplinNoteMeta>(
      `/folders/${encodeURIComponent(notebookId)}/notes`,
      NOTE_META_FIELDS,
      { order_by: opts.orderBy ?? "updated_time", order_dir: opts.orderDir ?? "DESC" },
      opts.limit
    );
  }

  // Every note across every notebook, newest first.
  listAllNotes(
    opts: { limit?: number; orderBy?: string; orderDir?: "ASC" | "DESC" } = {}
  ): Promise<JoplinNoteMeta[]> {
    return this.paginate<JoplinNoteMeta>(
      "/notes",
      NOTE_META_FIELDS,
      { order_by: opts.orderBy ?? "updated_time", order_dir: opts.orderDir ?? "DESC" },
      opts.limit
    );
  }

  // Full-text search. Joplin's own search already excludes trashed notes; paginate()
  // filters again in case the instance is old enough not to.
  searchNotes(
    query: string,
    opts: { limit?: number; includeBody?: boolean } = {}
  ): Promise<JoplinNote[]> {
    return this.paginate<JoplinNote>(
      "/search",
      opts.includeBody ? `${NOTE_META_FIELDS},body` : NOTE_META_FIELDS,
      { query, type: "note" },
      opts.limit ?? 20
    );
  }

  private async mutate<T>(path: string, method: string, payload?: unknown): Promise<T> {
    const res = await this.request(path, {
      method,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!res.ok) {
      throw new JoplinApiError(res.status, await res.text());
    }
    return res.json() as Promise<T>;
  }

  createNote(title: string, body: string, notebookId: string): Promise<JoplinNoteMeta> {
    return this.mutate("/notes", "POST", { title, body, parent_id: notebookId });
  }

  updateNote(id: string, payload: Record<string, string>): Promise<JoplinNoteMeta> {
    return this.mutate(`/notes/${encodeURIComponent(id)}`, "PUT", payload);
  }

  // Joplin ≥3.1 moves the note to trash unless permanent=1. Older instances have no
  // trash for notes and delete outright whatever this says.
  async deleteNote(id: string, permanent = false): Promise<void> {
    const res = await this.request(
      `/notes/${encodeURIComponent(id)}?permanent=${permanent ? 1 : 0}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      throw new JoplinApiError(res.status, await res.text());
    }
  }

  createNotebook(title: string, parentId?: string): Promise<JoplinFolder> {
    const payload: Record<string, string> = { title };
    if (parentId !== undefined) payload.parent_id = parentId;
    return this.mutate("/folders", "POST", payload);
  }

  updateNotebook(id: string, payload: Record<string, string>): Promise<JoplinFolder> {
    return this.mutate(`/folders/${encodeURIComponent(id)}`, "PUT", payload);
  }

  // permanent=0 moves the notebook to trash, recoverable from Joplin.
  async deleteNotebook(id: string): Promise<void> {
    const res = await this.request(`/folders/${encodeURIComponent(id)}?permanent=0`, {
      method: "DELETE",
    });
    if (!res.ok) {
      throw new JoplinApiError(res.status, await res.text());
    }
  }
}
