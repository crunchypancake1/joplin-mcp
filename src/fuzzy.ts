// Fuzzy title matching. Lets tools accept a human-typed note/notebook name where they
// used to demand a 32-hex ID, so a calling agent doesn't have to list everything first
// just to look up an ID it will immediately throw away.

export interface Scored<T> {
  item: T;
  score: number;
}

export type Resolution<T> =
  | { kind: "one"; item: T }
  | { kind: "ambiguous"; candidates: Scored<T>[] }
  | { kind: "none" };

// Score at or above which the best match is trusted without asking the caller.
const CONFIDENT = 0.78;
// How far the best match must beat the runner-up to count as unambiguous.
const MARGIN = 0.08;
// A lone plausible candidate is accepted at a lower bar: with nothing to confuse it
// with, bouncing a typo back to the caller costs a round trip and teaches them nothing.
const LENIENT_SOLO = 0.6;
// Candidates listed back to the caller when a name is ambiguous.
const MAX_CANDIDATES = 8;

// Case, accents and punctuation are all noise when matching a title someone typed
// from memory ("todo-list" should find "TODO List").
export function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

// 0 = no match, 1 = exact. The tiers are ordered so a structural match (prefix,
// substring, all words present) always outranks an edit-distance guess.
export function scoreTitle(query: string, title: string): number {
  const q = normalize(query);
  const t = normalize(title);
  if (!q || !t) return 0;

  if (q === t) return 1;
  if (t.startsWith(q)) return 0.92;
  if (t.includes(q)) return 0.85;

  const queryWords = q.split(" ");
  const titleWords = t.split(" ");
  const covered = queryWords.filter((qw) => titleWords.some((tw) => tw.startsWith(qw))).length;
  if (covered === queryWords.length) return 0.8;

  // Typo tolerance. Capped at 0.75 so it never outranks the tiers above.
  const similarity = 1 - levenshtein(q, t) / Math.max(q.length, t.length);
  if (similarity >= 0.6) return similarity * 0.75;

  return covered > 0 ? 0.4 * (covered / queryWords.length) : 0;
}

export function rank<T>(
  query: string,
  items: T[],
  titleOf: (item: T) => string,
  limit = MAX_CANDIDATES
): Scored<T>[] {
  return items
    .map((item) => ({ item, score: scoreTitle(query, titleOf(item)) }))
    .filter((scored) => scored.score > 0)
    // Ties break towards the shorter title: "Recipes" beats "Recipes archive 2019".
    .sort((a, b) => b.score - a.score || titleOf(a.item).length - titleOf(b.item).length)
    .slice(0, limit);
}

export function resolveByTitle<T>(
  query: string,
  items: T[],
  titleOf: (item: T) => string
): Resolution<T> {
  const ranked = rank(query, items, titleOf);
  if (ranked.length === 0) return { kind: "none" };

  const [best, runnerUp] = ranked;
  if (!runnerUp) {
    return best.score >= LENIENT_SOLO
      ? { kind: "one", item: best.item }
      : { kind: "ambiguous", candidates: ranked };
  }
  if (best.score >= CONFIDENT && best.score - runnerUp.score >= MARGIN) {
    return { kind: "one", item: best.item };
  }
  return { kind: "ambiguous", candidates: ranked };
}
