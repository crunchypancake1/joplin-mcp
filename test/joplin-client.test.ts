import { describe, it, expect, vi, beforeEach } from "vitest";
import { JoplinApiError, JoplinClient } from "../src/joplin-client.js";

const TOKEN = "test-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("JoplinClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let fakeVpc: Fetcher;

  beforeEach(() => {
    fetchMock = vi.fn();
    fakeVpc = { fetch: fetchMock } as unknown as Fetcher;
  });

  it("getNote: appends the token and fields to the request URL", async () => {
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

    const client = new JoplinClient(fakeVpc, TOKEN);
    const note = await client.getNote("n1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`http://joplin/notes/n1?`);
    expect(url).toContain("token=test-token");
    expect(url).toContain("fields=id,parent_id,title,body,created_time,updated_time");
    expect(note?.title).toBe("Hello");
  });

  it("getNote: returns null on 404", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const client = new JoplinClient(fakeVpc, TOKEN);
    const note = await client.getNote("missing");

    expect(note).toBeNull();
  });

  it("getNote: throws JoplinApiError on other non-ok responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const client = new JoplinClient(fakeVpc, TOKEN);
    await expect(client.getNote("n1")).rejects.toThrow(JoplinApiError);
  });

  it("listNotebooks: walks pagination until has_more is false", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "a", title: "A" }],
          has_more: true,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "b", title: "B" }],
          has_more: false,
        })
      );

    const client = new JoplinClient(fakeVpc, TOKEN);
    const notebooks = await client.listNotebooks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("page=1");
    expect(fetchMock.mock.calls[1][0]).toContain("page=2");
    expect(notebooks).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
  });

  it("listNotes: returns items from the response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [{ id: "a", title: "Active" }],
        has_more: false,
      })
    );

    const client = new JoplinClient(fakeVpc, TOKEN);
    const notes = await client.listNotes("folder1");

    expect(notes).toEqual([{ id: "a", title: "Active" }]);
  });

  it("createNote: posts the expected payload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "n1", title: "New" }));

    const client = new JoplinClient(fakeVpc, TOKEN);
    await client.createNote("New", "body text", "folder1");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`http://joplin/notes?`);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      title: "New",
      body: "body text",
      parent_id: "folder1",
    });
  });

  it("deleteNotebook: sends permanent=0 so it trashes instead of purging", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const client = new JoplinClient(fakeVpc, TOKEN);
    await client.deleteNotebook("f1");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`http://joplin/folders/f1?permanent=0`);
    expect(options.method).toBe("DELETE");
  });

  it("mutating calls throw JoplinApiError with the response body on failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("validation failed", { status: 400 }));

    const client = new JoplinClient(fakeVpc, TOKEN);
    await expect(client.createNotebook("x")).rejects.toMatchObject({
      status: 400,
      message: "validation failed",
    });
  });
});
