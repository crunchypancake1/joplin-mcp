import { describe, it, expect } from "vitest";
import { normalize, rank, resolveByTitle, scoreTitle } from "../src/fuzzy.js";

const titled = (title: string) => ({ title });

describe("normalize", () => {
  it("strips case, accents and punctuation", () => {
    expect(normalize("  TODO-List!  ")).toBe("todo list");
    expect(normalize("Café Notes")).toBe("cafe notes");
  });
});

describe("scoreTitle", () => {
  it("ranks structural matches above edit-distance guesses", () => {
    const exact = scoreTitle("Grocery List", "Grocery List");
    const prefix = scoreTitle("Grocery", "Grocery List");
    const contains = scoreTitle("List", "Grocery List");
    const typo = scoreTitle("Grocry Lst", "Grocery List");

    expect(exact).toBe(1);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(contains);
    expect(contains).toBeGreaterThan(typo);
    expect(typo).toBeGreaterThan(0);
  });

  it("matches word-by-word regardless of order", () => {
    expect(scoreTitle("list grocery", "Grocery List")).toBeGreaterThanOrEqual(0.78);
  });

  it("ignores case and punctuation differences", () => {
    expect(scoreTitle("todo list", "TODO-List")).toBe(1);
  });

  it("returns 0 for unrelated titles", () => {
    expect(scoreTitle("kubernetes", "Grocery List")).toBe(0);
  });
});

describe("rank", () => {
  it("orders by score and breaks ties towards the shorter title", () => {
    const items = [titled("Recipes archive 2019"), titled("Recipes")];
    const ranked = rank("recipes", items, (item) => item.title);

    expect(ranked[0].item.title).toBe("Recipes");
    expect(ranked[1].item.title).toBe("Recipes archive 2019");
  });
});

describe("resolveByTitle", () => {
  it("resolves a confident, clear winner", () => {
    const result = resolveByTitle(
      "grocery",
      [titled("Grocery List"), titled("Kubernetes notes")],
      (item) => item.title
    );

    expect(result).toEqual({ kind: "one", item: titled("Grocery List") });
  });

  it("reports ambiguity when two titles tie", () => {
    const result = resolveByTitle(
      "notes",
      [titled("Notes"), titled("notes")],
      (item) => item.title
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(2);
  });

  it("reports none when nothing is close", () => {
    expect(resolveByTitle("zebra", [titled("Grocery List")], (i) => i.title)).toEqual({
      kind: "none",
    });
  });

  it("tolerates a typo when there is only one plausible target", () => {
    const result = resolveByTitle(
      "grocry list",
      [titled("Grocery List"), titled("Kubernetes notes")],
      (item) => item.title
    );

    expect(result).toEqual({ kind: "one", item: titled("Grocery List") });
  });

  it("still asks when a typo could plausibly mean either of two notes", () => {
    const result = resolveByTitle(
      "grocry list",
      [titled("Grocery List"), titled("Grocery Lists")],
      (item) => item.title
    );

    expect(result.kind).toBe("ambiguous");
  });
});
