import { describe, it, expect, vi, beforeEach } from "vitest";
import { JoplinApiError, JoplinClient, TRASH_FOLDER_ID } from "../src/joplin-client.js";

const TOKEN = "test-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function page(items: unknown[], has_more = false): Response {
  return jsonResponse({ items, has_more });
}

describe("JoplinClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let fakeVpc: Fetcher;
  let client: JoplinClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    fakeVpc = { fetch: fetchMock } as unknown as Fetcher;
    client = new JoplinClient(fakeVpc, TOKEN);
  });

  const urls = () => fetchMock.mock.calls.map((call) => call[0] as string);

  it("TRASH_FOLDER_ID is a well-formed Joplin item ID", () => {
    expect(TRASH_FOLDER_ID).toMatch(/^[0-9a-f]{32}$/);
  });

  it("getNote: appends the token, fields and deleted_time to the request URL", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "n1",
        parent_id: "f1",
        title: "Hello",
        body: "World",
        created_time: 1,
        updated_time: 2,
      })
    );

    const note = await client.getNote("n1");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(urls()[0]).toContain("http://joplin/notes/n1?");
    expect(urls()[0]).toContain("token=test-token");
    expect(urls()[0]).toContain("fields=id,parent_id,title,body,created_time,updated_time,deleted_time");
    expect(note?.title).toBe("Hello");
  });

  it("getNote: returns null on 404", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await client.getNote("missing")).toBeNull();
  });

  it("getNote: treats a trashed note as missing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "n1", parent_id: "f1", title: "Gone", body: "", deleted_time: 1700000000000 })
    );
    expect(await client.getNote("n1")).toBeNull();
  });

  it("getNote: throws JoplinApiError on other non-ok responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(client.getNote("n1")).rejects.toThrow(JoplinApiError);
  });

  it("retries without deleted_time on instances that predate the trash feature", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("SQLITE_ERROR: no such column: deleted_time", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ id: "n1", parent_id: "f1", title: "Old", body: "" }));

    const note = await client.getNote("n1");

    expect(note?.title).toBe("Old");
    expect(urls()[0]).toContain(",deleted_time");
    expect(urls()[1]).not.toContain("deleted_time");
  });

  it("remembers that deleted_time is unsupported instead of re-probing", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("SQLITE_ERROR: no such column", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ id: "n1", parent_id: "f1", title: "Old", body: "" }))
      .mockResolvedValueOnce(jsonResponse({ id: "n2", parent_id: "f1", title: "Also old", body: "" }));

    await client.getNote("n1");
    await client.getNote("n2");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urls()[2]).not.toContain("deleted_time");
  });

  it("listNotebooks: walks pagination and asks Joplin to exclude deleted items", async () => {
    fetchMock
      .mockResolvedValueOnce(page([{ id: "a", parent_id: "", title: "A" }], true))
      .mockResolvedValueOnce(page([{ id: "b", parent_id: "", title: "B" }]));

    const notebooks = await client.listNotebooks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urls()[0]).toContain("page=1");
    expect(urls()[0]).toContain("include_deleted=0");
    expect(urls()[0]).toContain("include_conflicts=0");
    expect(urls()[1]).toContain("page=2");
    expect(notebooks.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("listNotebooks: drops trashed folders, the trash folder itself, and trashed subtrees", async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        { id: "keep", parent_id: "", title: "Keep" },
        { id: "gone", parent_id: "", title: "Gone", deleted_time: 1 },
        { id: TRASH_FOLDER_ID, parent_id: "", title: "Trash" },
        {
          id: "deadparent",
          parent_id: "",
          title: "Dead",
          deleted_time: 1,
          children: [{ id: "orphan", parent_id: "deadparent", title: "Orphan" }],
        },
      ])
    );

    const notebooks = await client.listNotebooks();

    expect(notebooks.map((n) => n.id)).toEqual(["keep"]);
  });

  it("listNotebooks: flattens a folder tree returned under `children`", async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        {
          id: "root",
          parent_id: "",
          title: "Root",
          children: [{ id: "child", parent_id: "root", title: "Child" }],
        },
      ])
    );

    const notebooks = await client.listNotebooks();

    expect(notebooks.map((n) => n.id)).toEqual(["root", "child"]);
    expect(notebooks[0]).not.toHaveProperty("children");
  });

  it("listNotes: filters trashed notes out of the page", async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        { id: "a", parent_id: "f1", title: "Active" },
        { id: "b", parent_id: "f1", title: "Trashed", deleted_time: 1700000000000 },
      ])
    );

    const notes = await client.listNotes("f1");

    expect(notes.map((n) => n.id)).toEqual(["a"]);
    expect(urls()[0]).toContain("order_by=updated_time");
    expect(urls()[0]).toContain("order_dir=DESC");
  });

  it("listNotes: stops paginating once the limit is reached", async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        { id: "a", parent_id: "f1", title: "A" },
        { id: "b", parent_id: "f1", title: "B" },
      ], true)
    );

    const notes = await client.listNotes("f1", { limit: 2 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(urls()[0]).toContain("limit=2");
    expect(notes).toHaveLength(2);
  });

  it("searchNotes: searches notes only and requests the body when asked", async () => {
    fetchMock.mockResolvedValueOnce(page([{ id: "a", parent_id: "f1", title: "Hit", body: "text" }]));

    await client.searchNotes('title:"grocery list"', { includeBody: true });

    expect(urls()[0]).toContain("http://joplin/search?");
    expect(urls()[0]).toContain("type=note");
    // URLSearchParams form-encodes the space as "+", which Joplin decodes back.
    expect(urls()[0]).toContain('query=title%3A%22grocery+list%22');
    expect(urls()[0]).toContain("body");
  });

  it("createNote: posts the expected payload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "n1", title: "New" }));

    await client.createNote("New", "body text", "folder1");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("http://joplin/notes?");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      title: "New",
      body: "body text",
      parent_id: "folder1",
    });
  });

  it("deleteNote: trashes by default and purges only when asked", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await client.deleteNote("n1");
    await client.deleteNote("n2", true);

    expect(urls()[0]).toContain("/notes/n1?permanent=0");
    expect(urls()[1]).toContain("/notes/n2?permanent=1");
  });

  it("deleteNotebook: sends permanent=0 so it trashes instead of purging", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await client.deleteNotebook("f1");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("http://joplin/folders/f1?permanent=0");
    expect(options.method).toBe("DELETE");
  });

  it("mutating calls throw JoplinApiError with the response body on failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("validation failed", { status: 400 }));

    await expect(client.createNotebook("x")).rejects.toMatchObject({
      status: 400,
      message: "validation failed",
    });
  });
});
