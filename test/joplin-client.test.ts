import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JoplinApiError, JoplinClient } from "../src/joplin-client.js";

const BASE_URL = "https://joplin.example.com";
const TOKEN = "test-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("JoplinClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
        deleted_time: 0,
      })
    );

    const client = new JoplinClient(BASE_URL, TOKEN);
    const note = await client.getNote("n1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`${BASE_URL}/notes/n1?`);
    expect(url).toContain("token=test-token");
    expect(url).toContain("fields=id,parent_id,title,body,created_time,updated_time,deleted_time");
    expect(note?.title).toBe("Hello");
  });

  it("getNote: returns null on 404", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const client = new JoplinClient(BASE_URL, TOKEN);
    const note = await client.getNote("missing");

    expect(note).toBeNull();
  });

  it("getNote: throws JoplinApiError on other non-ok responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const client = new JoplinClient(BASE_URL, TOKEN);
    await expect(client.getNote("n1")).rejects.toThrow(JoplinApiError);
  });

  it("listNotebooks: walks pagination until has_more is false", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "a", title: "A", deleted_time: 0 }],
          has_more: true,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "b", title: "B", deleted_time: 0 }],
          has_more: false,
        })
      );

    const client = new JoplinClient(BASE_URL, TOKEN);
    const notebooks = await client.listNotebooks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("page=1");
    expect(fetchMock.mock.calls[1][0]).toContain("page=2");
    expect(notebooks).toEqual([
      { id: "a", title: "A", deleted_time: 0 },
      { id: "b", title: "B", deleted_time: 0 },
    ]);
  });

  it("listNotes: filters out trashed items", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { id: "a", title: "Active", deleted_time: 0 },
          { id: "b", title: "Trashed", deleted_time: 1748000000000 },
        ],
        has_more: false,
      })
    );

    const client = new JoplinClient(BASE_URL, TOKEN);
    const notes = await client.listNotes("folder1");

    expect(notes).toEqual([{ id: "a", title: "Active", deleted_time: 0 }]);
  });

  it("createNote: posts the expected payload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "n1", title: "New" }));

    const client = new JoplinClient(BASE_URL, TOKEN);
    await client.createNote("New", "body text", "folder1");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${BASE_URL}/notes?`);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      title: "New",
      body: "body text",
      parent_id: "folder1",
    });
  });

  it("deleteNotebook: sends permanent=0 so it trashes instead of purging", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const client = new JoplinClient(BASE_URL, TOKEN);
    await client.deleteNotebook("f1");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${BASE_URL}/folders/f1?permanent=0`);
    expect(options.method).toBe("DELETE");
  });

  it("mutating calls throw JoplinApiError with the response body on failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("validation failed", { status: 400 }));

    const client = new JoplinClient(BASE_URL, TOKEN);
    await expect(client.createNotebook("x")).rejects.toMatchObject({
      status: 400,
      message: "validation failed",
    });
  });
});
