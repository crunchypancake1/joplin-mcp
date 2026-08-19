import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JoplinClient, JoplinFolder, JoplinNoteMeta } from "../src/joplin-client.js";
import { JoplinResolver, isJoplinId } from "../src/resolver.js";

const NOTE_ID = "0123456789abcdef0123456789abcdef";

const folder = (id: string, title: string, parent_id = ""): JoplinFolder => ({ id, title, parent_id });
const note = (id: string, title: string, parent_id: string): JoplinNoteMeta => ({
  id,
  title,
  parent_id,
  created_time: 1,
  updated_time: 2,
});

function stubClient(overrides: Partial<JoplinClient> = {}) {
  return {
    listNotebooks: vi.fn().mockResolvedValue([]),
    listAllNotes: vi.fn().mockResolvedValue([]),
    searchNotes: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as JoplinClient;
}

describe("isJoplinId", () => {
  it("accepts 32-hex IDs and rejects titles", () => {
    expect(isJoplinId(NOTE_ID)).toBe(true);
    expect(isJoplinId(NOTE_ID.toUpperCase())).toBe(true);
    expect(isJoplinId("Grocery List")).toBe(false);
    expect(isJoplinId("abc")).toBe(false);
  });
});

describe("JoplinResolver.resolveNotebook", () => {
  it("falls back to the configured default notebook when none is given", async () => {
    const client = stubClient({
      listNotebooks: vi.fn().mockResolvedValue([folder("f1", "Default"), folder("f2", "Work")]),
    });
    const resolver = new JoplinResolver(client, "Default");

    const lookup = await resolver.resolveNotebook();

    expect(lookup.usedDefault).toBe(true);
    expect(lookup.resolution).toEqual({ kind: "one", item: folder("f1", "Default") });
  });

  it("reports a missing default rather than silently picking a notebook", async () => {
    const client = stubClient({ listNotebooks: vi.fn().mockResolvedValue([folder("f2", "Work")]) });
    const resolver = new JoplinResolver(client, "Default");

    const lookup = await resolver.resolveNotebook();

    expect(lookup.usedDefault).toBe(true);
    expect(lookup.resolution.kind).toBe("none");
  });

  it("matches a notebook by fuzzy name", async () => {
    const client = stubClient({
      listNotebooks: vi.fn().mockResolvedValue([folder("f1", "Default"), folder("f2", "Work Notes")]),
    });
    const resolver = new JoplinResolver(client, "Default");

    const lookup = await resolver.resolveNotebook("work");

    expect(lookup.resolution).toEqual({ kind: "one", item: folder("f2", "Work Notes") });
  });

  it("caches the folder list across lookups", async () => {
    const listNotebooks = vi.fn().mockResolvedValue([folder("f1", "Default")]);
    const resolver = new JoplinResolver(stubClient({ listNotebooks }), "Default");

    await resolver.resolveNotebook();
    await resolver.resolveNotebook();

    expect(listNotebooks).toHaveBeenCalledOnce();
  });

  it("dedupes concurrent lookups into a single fetch", async () => {
    const listNotebooks = vi.fn().mockResolvedValue([folder("f1", "Default")]);
    const resolver = new JoplinResolver(stubClient({ listNotebooks }), "Default");

    await Promise.all([
      resolver.resolveNotebook(),
      resolver.folderPath("f1"),
      resolver.folderList(),
    ]);

    expect(listNotebooks).toHaveBeenCalledOnce();
  });

  it("does not cache a failed fetch", async () => {
    const listNotebooks = vi
      .fn()
      .mockRejectedValueOnce(new Error("tunnel down"))
      .mockResolvedValue([folder("f1", "Default")]);
    const resolver = new JoplinResolver(stubClient({ listNotebooks }), "Default");

    await expect(resolver.resolveNotebook()).rejects.toThrow("tunnel down");
    const retry = await resolver.resolveNotebook();

    expect(retry.resolution).toEqual({ kind: "one", item: folder("f1", "Default") });
    expect(listNotebooks).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after invalidation", async () => {
    const listNotebooks = vi.fn().mockResolvedValue([folder("f1", "Default")]);
    const resolver = new JoplinResolver(stubClient({ listNotebooks }), "Default");

    await resolver.resolveNotebook();
    resolver.invalidateFolders();
    await resolver.resolveNotebook();

    expect(listNotebooks).toHaveBeenCalledTimes(2);
  });
});

describe("JoplinResolver.folderPath", () => {
  it("builds a slash-separated path from the folder tree", async () => {
    const client = stubClient({
      listNotebooks: vi
        .fn()
        .mockResolvedValue([folder("a", "Work"), folder("b", "Projects", "a"), folder("c", "Q3", "b")]),
    });
    const resolver = new JoplinResolver(client, "Default");

    expect(await resolver.folderPath("c")).toBe("Work/Projects/Q3");
  });

  it("falls back to the raw ID for an unknown folder", async () => {
    const resolver = new JoplinResolver(stubClient(), "Default");
    expect(await resolver.folderPath("nope")).toBe("nope");
  });

  it("does not hang on a cyclic parent reference", async () => {
    const client = stubClient({
      listNotebooks: vi.fn().mockResolvedValue([folder("a", "A", "b"), folder("b", "B", "a")]),
    });
    const resolver = new JoplinResolver(client, "Default");

    expect(await resolver.folderPath("a")).toBe("B/A");
  });
});

describe("JoplinResolver.resolveNote", () => {
  it("passes a 32-hex ID straight through without any API call", async () => {
    const client = stubClient();
    const resolver = new JoplinResolver(client, "Default");

    expect(await resolver.resolveNote(NOTE_ID)).toEqual({ kind: "one", id: NOTE_ID });
    expect(client.searchNotes).not.toHaveBeenCalled();
  });

  it("resolves a title through Joplin's search in a single call", async () => {
    const searchNotes = vi.fn().mockResolvedValue([note("n1", "Grocery List", "f1")]);
    const listAllNotes = vi.fn().mockResolvedValue([]);
    const resolver = new JoplinResolver(stubClient({ searchNotes, listAllNotes }), "Default");

    const lookup = await resolver.resolveNote("grocery list");

    expect(lookup).toMatchObject({ kind: "one", id: "n1", title: "Grocery List" });
    expect(searchNotes).toHaveBeenCalledWith('title:"grocery list"', { limit: 50 });
    expect(listAllNotes).not.toHaveBeenCalled();
  });

  it("falls back to a local title index when search finds nothing", async () => {
    const searchNotes = vi.fn().mockResolvedValue([]);
    const listAllNotes = vi.fn().mockResolvedValue([note("n1", "Grocery List", "f1")]);
    const resolver = new JoplinResolver(stubClient({ searchNotes, listAllNotes }), "Default");

    const lookup = await resolver.resolveNote("grocry lst");

    expect(lookup).toMatchObject({ kind: "one", id: "n1" });
    expect(listAllNotes).toHaveBeenCalledOnce();
  });

  it("survives a search backend error by using the local index", async () => {
    const searchNotes = vi.fn().mockRejectedValue(new Error("search index rebuilding"));
    const listAllNotes = vi.fn().mockResolvedValue([note("n1", "Grocery List", "f1")]);
    const resolver = new JoplinResolver(stubClient({ searchNotes, listAllNotes }), "Default");

    expect(await resolver.resolveNote("grocery list")).toMatchObject({ kind: "one", id: "n1" });
  });

  it("restricts matching to a notebook when one is given", async () => {
    const searchNotes = vi
      .fn()
      .mockResolvedValue([note("n1", "Notes", "f1"), note("n2", "Notes", "f2")]);
    const resolver = new JoplinResolver(stubClient({ searchNotes }), "Default");

    expect(await resolver.resolveNote("notes")).toMatchObject({ kind: "ambiguous" });
    expect(await resolver.resolveNote("notes", "f2")).toMatchObject({ kind: "one", id: "n2" });
  });

  it("returns the candidates when a title is ambiguous", async () => {
    const searchNotes = vi
      .fn()
      .mockResolvedValue([note("n1", "Meeting Notes", "f1"), note("n2", "Meeting Notes", "f2")]);
    const resolver = new JoplinResolver(stubClient({ searchNotes }), "Default");

    const lookup = await resolver.resolveNote("meeting notes");

    expect(lookup.kind).toBe("ambiguous");
    if (lookup.kind === "ambiguous") {
      expect(lookup.candidates.map((c) => c.item.id)).toEqual(["n1", "n2"]);
    }
  });

  it("reports none when nothing matches anywhere", async () => {
    const resolver = new JoplinResolver(stubClient(), "Default");
    expect(await resolver.resolveNote("nonexistent")).toEqual({ kind: "none" });
  });
});
