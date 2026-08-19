import { describe, it, expect } from "vitest";
import { snippet, splice } from "../src/format.js";

describe("splice", () => {
  it("appends on a new line without piling up whitespace", () => {
    expect(splice("- milk\n- eggs\n\n", { append: "- bread" })).toBe("- milk\n- eggs\n- bread");
  });

  it("prepends on a new line", () => {
    expect(splice("- eggs", { prepend: "- milk" })).toBe("- milk\n- eggs");
  });

  it("uses the added text as-is when the note is empty", () => {
    expect(splice("", { append: "first line" })).toBe("first line");
    expect(splice("   ", { prepend: "first line" })).toBe("first line");
  });

  it("applies prepend and append together", () => {
    expect(splice("middle", { prepend: "top", append: "bottom" })).toBe("top\nmiddle\nbottom");
  });

  it("leaves the body alone when there is nothing to add", () => {
    expect(splice("unchanged", {})).toBe("unchanged");
  });
});

describe("snippet", () => {
  it("centres the window on the first matching term", () => {
    const body = `${"filler ".repeat(60)}kubernetes ingress${" tail".repeat(60)}`;
    const result = snippet(body, "kubernetes");

    expect(result).toContain("kubernetes ingress");
    expect(result.startsWith("…")).toBe(true);
  });

  it("collapses whitespace and starts at the top when nothing matches", () => {
    expect(snippet("line one\n\n  line two", "zzz")).toBe("line one line two");
  });

  it("ignores search operators when picking the window", () => {
    const result = snippet("shopping list contents here", 'title:"shopping"');
    expect(result).toContain("shopping list");
  });

  it("returns empty for an empty body", () => {
    expect(snippet("", "anything")).toBe("");
  });
});
