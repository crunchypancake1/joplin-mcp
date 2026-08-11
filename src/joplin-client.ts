export interface JoplinNote {
  id: string;
  parent_id: string;
  title: string;
  body: string;
  created_time: number;
  updated_time: number;
}

export interface JoplinListItem {
  id: string;
  title: string;
}

export class JoplinApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Thin wrapper around the Joplin Data API (https://joplinapp.org/api/references/rest_api/),
// reached via a Workers VPC Service binding rather than a public hostname.
export class JoplinClient {
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

  // Walks every page of a list endpoint.
  private async paginateItems(path: string): Promise<JoplinListItem[]> {
    const sep = path.includes("?") ? "&" : "?";
    const items: JoplinListItem[] = [];
    let page = 1;
    for (;;) {
      const res = await this.request(`${path}${sep}fields=id,title&page=${page}`);
      if (!res.ok) {
        throw new JoplinApiError(res.status, await res.text());
      }
      const data = (await res.json()) as { items: JoplinListItem[]; has_more: boolean };
      items.push(...data.items);
      if (!data.has_more) break;
      page++;
    }
    return items;
  }

  async getNote(id: string): Promise<JoplinNote | null> {
    const res = await this.request(
      `/notes/${id}?fields=id,parent_id,title,body,created_time,updated_time`
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new JoplinApiError(res.status, await res.text());
    }
    return res.json();
  }

  listNotebooks(): Promise<JoplinListItem[]> {
    return this.paginateItems("/folders");
  }

  listNotes(notebookId: string): Promise<JoplinListItem[]> {
    return this.paginateItems(`/folders/${notebookId}/notes`);
  }

  async createNote(title: string, body: string, notebookId: string): Promise<{ id: string; title: string }> {
    const res = await this.request("/notes", {
      method: "POST",
      body: JSON.stringify({ title, body, parent_id: notebookId }),
    });
    if (!res.ok) {
      throw new JoplinApiError(res.status, await res.text());
    }
    return res.json();
  }

  async updateNote(id: string, payload: Record<string, string>): Promise<{ id: string; title: string }> {
    const res = await this.request(`/notes/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new JoplinApiError(res.status, await res.text());
    }
    return res.json();
  }

  async deleteNote(id: string): Promise<void> {
    const res = await this.request(`/notes/${id}`, { method: "DELETE" });
    if (!res.ok) {
      throw new JoplinApiError(res.status, await res.text());
    }
  }

  async createNotebook(title: string, parentId?: string): Promise<{ id: string; title: string }> {
    const payload: Record<string, string> = { title };
    if (parentId !== undefined) payload.parent_id = parentId;
    const res = await this.request("/folders", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new JoplinApiError(res.status, await res.text());
    }
    return res.json();
  }

  async updateNotebook(id: string, payload: Record<string, string>): Promise<{ id: string; title: string }> {
    const res = await this.request(`/folders/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new JoplinApiError(res.status, await res.text());
    }
    return res.json();
  }

  async deleteNotebook(id: string): Promise<void> {
    const res = await this.request(`/folders/${id}?permanent=0`, { method: "DELETE" });
    if (!res.ok) {
      throw new JoplinApiError(res.status, await res.text());
    }
  }
}
