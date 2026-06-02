import { describe, it, expect, vi, beforeEach } from "vitest";
import { processR2Event } from "../src/indexer.js";
import type { Env } from "../src/types.js";

function noteFixture(overrides: Partial<{
  title: string;
  body: string;
  id: string;
  parent_id: string;
  deleted_time: number;
  type_: number;
}> = {}): string {
  const {
    title = "Test Note",
    body = "Note body here.",
    id = "aaaa1111bbbb2222cccc3333dddd4444",
    parent_id = "ffff0000ffff0000ffff0000ffff0000",
    deleted_time = 0,
    type_ = 1,
  } = overrides;
  return [
    title,
    "",
    body,
    "",
    `id: ${id}`,
    `parent_id: ${parent_id}`,
    `created_time: 2026-01-01T00:00:00.000Z`,
    `updated_time: 2026-01-02T00:00:00.000Z`,
    `deleted_time: ${deleted_time}`,
    `type_: ${type_}`,
  ].join("\n");
}

function folderFixture(id: string, title: string): string {
  return [
    title,
    "",
    "",
    `id: ${id}`,
    `parent_id: `,
    `created_time: 2026-01-01T00:00:00.000Z`,
    `updated_time: 2026-01-02T00:00:00.000Z`,
    `deleted_time: 0`,
    `type_: 2`,
  ].join("\n");
}

function makeR2Object(text: string): R2ObjectBody {
  return { text: () => Promise.resolve(text) } as unknown as R2ObjectBody;
}

function makeEnv(overrides: {
  notesGet?: (key: string) => Promise<R2ObjectBody | null>;
  sinkPut?: ReturnType<typeof vi.fn>;
  sinkDelete?: ReturnType<typeof vi.fn>;
  kvGet?: (key: string) => Promise<string | null>;
} = {}): Env {
  const {
    notesGet = async () => null,
    sinkPut = vi.fn().mockResolvedValue(undefined),
    sinkDelete = vi.fn().mockResolvedValue(undefined),
    kvGet = async () => null,
  } = overrides;

  return {
    JOPLIN_NOTES: { get: vi.fn(notesGet) } as unknown as R2Bucket,
    SINK_BUCKET: {
      put: sinkPut,
      delete: sinkDelete,
    } as unknown as R2Bucket,
    JOPLIN_KV: { get: vi.fn(kvGet) } as unknown as KVNamespace,
    AI: {} as Ai,
    AI_SEARCH_INSTANCE: "personal-search",
    JOPLIN_MCP: {} as DurableObjectNamespace,
  };
}

describe("processR2Event", () => {
  it("DeleteObject: removes the note from sink using the key as ID", async () => {
    const sinkDelete = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ sinkDelete });

    await processR2Event("aaaa1111bbbb2222cccc3333dddd4444.md", "DeleteObject", env);

    expect(sinkDelete).toHaveBeenCalledWith(["joplin:aaaa1111bbbb2222cccc3333dddd4444"]);
  });

  it("PutObject on a .sync/ path: does nothing", async () => {
    const sinkPut = vi.fn();
    const sinkDelete = vi.fn();
    const env = makeEnv({ sinkPut, sinkDelete });

    await processR2Event(".sync/somefile.md", "PutObject", env);

    expect(sinkPut).not.toHaveBeenCalled();
    expect(sinkDelete).not.toHaveBeenCalled();
  });

  it("PutObject on info.json: does nothing", async () => {
    const sinkPut = vi.fn();
    const sinkDelete = vi.fn();
    const env = makeEnv({ sinkPut, sinkDelete });

    await processR2Event("info.json", "PutObject", env);

    expect(sinkPut).not.toHaveBeenCalled();
    expect(sinkDelete).not.toHaveBeenCalled();
  });

  it("PutObject for a folder item (type_ 2): does nothing", async () => {
    const sinkPut = vi.fn();
    const sinkDelete = vi.fn();
    const folderId = "ffff0000ffff0000ffff0000ffff0000";
    const env = makeEnv({
      notesGet: async () => makeR2Object(folderFixture(folderId, "My Notebook")),
      sinkPut,
      sinkDelete,
    });

    await processR2Event(`${folderId}.md`, "PutObject", env);

    expect(sinkPut).not.toHaveBeenCalled();
    expect(sinkDelete).not.toHaveBeenCalled();
  });

  it("PutObject for a soft-deleted note: removes from sink", async () => {
    const sinkDelete = vi.fn().mockResolvedValue(undefined);
    const noteId = "aaaa1111bbbb2222cccc3333dddd4444";
    const env = makeEnv({
      notesGet: async () => makeR2Object(noteFixture({ id: noteId, deleted_time: 1748000000000 })),
      sinkDelete,
    });

    await processR2Event(`${noteId}.md`, "PutObject", env);

    expect(sinkDelete).toHaveBeenCalledWith([`joplin:${noteId}`]);
  });

  it("PutObject for a note excluded by denylist: does nothing", async () => {
    const sinkPut = vi.fn();
    const sinkDelete = vi.fn();
    const noteId = "aaaa1111bbbb2222cccc3333dddd4444";
    const parentId = "ffff0000ffff0000ffff0000ffff0000";
    const config = JSON.stringify({ mode: "denylist", notebookIds: [parentId] });
    const env = makeEnv({
      notesGet: async () => makeR2Object(noteFixture({ id: noteId, parent_id: parentId })),
      kvGet: async (key) => key === "config:joplin:indexed-notebooks" ? config : null,
      sinkPut,
      sinkDelete,
    });

    await processR2Event(`${noteId}.md`, "PutObject", env);

    expect(sinkPut).not.toHaveBeenCalled();
    expect(sinkDelete).not.toHaveBeenCalled();
  });

  it("PutObject for a valid note: resolves notebook name and upserts to sink", async () => {
    const sinkPut = vi.fn().mockResolvedValue(undefined);
    const noteId = "aaaa1111bbbb2222cccc3333dddd4444";
    const parentId = "ffff0000ffff0000ffff0000ffff0000";
    const env = makeEnv({
      notesGet: async (key: string) => {
        if (key === `${noteId}.md`) return makeR2Object(noteFixture({ id: noteId, parent_id: parentId }));
        if (key === `${parentId}.md`) return makeR2Object(folderFixture(parentId, "My Notebook"));
        return null;
      },
      sinkPut,
    });

    await processR2Event(`${noteId}.md`, "PutObject", env);

    expect(sinkPut).toHaveBeenCalledOnce();
    const [key, body] = sinkPut.mock.calls[0] as [string, string, unknown];
    expect(key).toBe(`joplin/${noteId}.txt`);
    expect(body).toContain("Title: Test Note");
    expect(body).toContain("Notebook: My Notebook");
    expect(body).toContain("Note body here.");
  });

  it("PutObject for a valid note with missing parent folder: upserts without notebook name", async () => {
    const sinkPut = vi.fn().mockResolvedValue(undefined);
    const noteId = "aaaa1111bbbb2222cccc3333dddd4444";
    const parentId = "ffff0000ffff0000ffff0000ffff0000";
    const env = makeEnv({
      notesGet: async (key: string) => {
        if (key === `${noteId}.md`) return makeR2Object(noteFixture({ id: noteId, parent_id: parentId }));
        return null;
      },
      sinkPut,
    });

    await processR2Event(`${noteId}.md`, "PutObject", env);

    expect(sinkPut).toHaveBeenCalledOnce();
    const [, body] = sinkPut.mock.calls[0] as [string, string, unknown];
    expect(body).toContain("Title: Test Note");
    expect(body).toContain("Notebook: ");
  });
});
