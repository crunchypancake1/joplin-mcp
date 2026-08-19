import { JoplinClient, type JoplinFolder, type JoplinNoteMeta } from "./joplin-client.js";
import { resolveByTitle, type Resolution, type Scored } from "./fuzzy.js";

const ID_PATTERN = /^[0-9a-f]{32}$/i;

export function isJoplinId(value: string): boolean {
  return ID_PATTERN.test(value.trim());
}

// The Durable Object is long-lived, so these caches survive across tool calls within a
// client session — name resolution usually costs zero API calls after the first.
const FOLDER_TTL_MS = 5 * 60_000;
const NOTE_INDEX_TTL_MS = 60_000;
// Ceiling on the local title index built only when Joplin's own search comes up empty.
const NOTE_INDEX_CAP = 2000;
// Candidates pulled from search before ranking them locally.
const SEARCH_CANDIDATES = 50;

// The in-flight promise is what gets cached, not the resolved value: several tool
// handlers render folder paths concurrently, and caching only the result would let them
// all miss and refetch at once.
interface Cached<T> {
  at: number;
  value: Promise<T>;
}

interface FolderIndex {
  list: JoplinFolder[];
  // id -> "Work/Projects/Q3", precomputed once per fetch.
  paths: Map<string, string>;
}

export interface NotebookLookup {
  resolution: Resolution<JoplinFolder>;
  // What was actually matched against — the caller's argument, or the configured
  // default notebook name when they passed nothing.
  query: string;
  usedDefault: boolean;
}

export type NoteLookup =
  | { kind: "one"; id: string; title?: string; parentId?: string }
  | { kind: "ambiguous"; candidates: Scored<JoplinNoteMeta>[] }
  | { kind: "none" };

// Turns the names an agent actually has ("my grocery list", "Work") into Joplin IDs,
// with caching so that costs at most one API call and usually none.
export class JoplinResolver {
  private folders: Cached<FolderIndex> | null = null;
  private noteTitles: Cached<JoplinNoteMeta[]> | null = null;

  constructor(
    private readonly client: JoplinClient,
    public readonly defaultNotebookName: string
  ) {}

  invalidateFolders(): void {
    this.folders = null;
  }

  invalidateNotes(): void {
    this.noteTitles = null;
  }

  private folderIndex(): Promise<FolderIndex> {
    if (this.folders && Date.now() - this.folders.at < FOLDER_TTL_MS) {
      return this.folders.value;
    }
    const value = this.client.listNotebooks().then(buildFolderIndex);
    this.folders = { at: Date.now(), value };
    // A failed fetch must not be cached, or the TTL would pin the error in place.
    return value.catch((err) => {
      this.folders = null;
      throw err;
    });
  }

  async folderList(): Promise<JoplinFolder[]> {
    return (await this.folderIndex()).list;
  }

  private noteIndex(): Promise<JoplinNoteMeta[]> {
    if (this.noteTitles && Date.now() - this.noteTitles.at < NOTE_INDEX_TTL_MS) {
      return this.noteTitles.value;
    }
    const value = this.client.listAllNotes({ limit: NOTE_INDEX_CAP });
    this.noteTitles = { at: Date.now(), value };
    return value.catch((err) => {
      this.noteTitles = null;
      throw err;
    });
  }

  // "Work/Projects/Q3" — far more useful to an agent than a bare title when several
  // notebooks share a name.
  async folderPath(id: string): Promise<string> {
    return (await this.folderIndex()).paths.get(id) ?? id;
  }

  async resolveNotebook(ref?: string): Promise<NotebookLookup> {
    const usedDefault = !ref?.trim();
    const query = (usedDefault ? this.defaultNotebookName : ref!).trim();
    const folders = await this.folderList();

    if (!usedDefault && isJoplinId(query)) {
      const match = folders.find((folder) => folder.id.toLowerCase() === query.toLowerCase());
      // An ID we don't recognise is still worth passing through — the folder cache may
      // simply be stale — so let the API be the judge.
      return {
        resolution: { kind: "one", item: match ?? { id: query, parent_id: "", title: query } },
        query,
        usedDefault,
      };
    }

    return {
      resolution: resolveByTitle(query, folders, (folder) => folder.title),
      query,
      usedDefault,
    };
  }

  async resolveNote(ref: string, notebookId?: string): Promise<NoteLookup> {
    const query = ref.trim();
    if (isJoplinId(query)) return { kind: "one", id: query };

    // Joplin's own title search resolves the common case in a single API call.
    let candidates = await this.searchTitles(query);
    if (notebookId) candidates = candidates.filter((note) => note.parent_id === notebookId);

    const fromSearch = this.pick(resolveByTitle(query, candidates, (note) => note.title));
    if (fromSearch.kind !== "none") return fromSearch;

    // Only when search finds nothing — typos, or a title whose words don't tokenise the
    // way FTS expects — fall back to ranking every title locally.
    let all = await this.noteIndex();
    if (notebookId) all = all.filter((note) => note.parent_id === notebookId);

    return this.pick(resolveByTitle(query, all, (note) => note.title));
  }

  private async searchTitles(query: string): Promise<JoplinNoteMeta[]> {
    // Quotes would terminate the title: phrase early; the words are what matter.
    const phrase = query.replace(/"/g, " ").trim();
    if (!phrase) return [];
    try {
      return await this.client.searchNotes(`title:"${phrase}"`, { limit: SEARCH_CANDIDATES });
    } catch {
      // A search-index hiccup shouldn't sink the lookup — the local fallback covers it.
      return [];
    }
  }

  private pick(resolution: Resolution<JoplinNoteMeta>): NoteLookup {
    if (resolution.kind === "one") {
      return {
        kind: "one",
        id: resolution.item.id,
        title: resolution.item.title,
        parentId: resolution.item.parent_id,
      };
    }
    return resolution.kind === "ambiguous"
      ? { kind: "ambiguous", candidates: resolution.candidates }
      : { kind: "none" };
  }
}

function buildFolderIndex(list: JoplinFolder[]): FolderIndex {
  const byId = new Map(list.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();

  for (const folder of list) {
    const parts: string[] = [];
    let current: JoplinFolder | undefined = folder;
    // `seen` bounds the walk, so a cyclic parent_id can't hang this.
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.unshift(current.title);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    paths.set(folder.id, parts.join("/"));
  }

  return { list, paths };
}
