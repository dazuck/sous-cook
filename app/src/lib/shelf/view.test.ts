import { describe, expect, it } from "vitest";
import {
  chapterAnchors,
  contentsColumns,
  kitchenDate,
  missingRows,
  rowFact,
  searchRows,
  type ContentsEntry,
  type PackChapterView,
  type PackRowView,
} from "./view";

const row = (title: string, over: Partial<PackRowView> = {}): PackRowView => ({
  id: title.toLowerCase().replace(/\W+/g, "-"),
  title,
  times: null,
  serves: null,
  tags: [],
  missing: null,
  ...over,
});

const BOOK: PackChapterView[] = [
  {
    anchor: "indian",
    title: "indian",
    rows: [
      row("Chicken thighs (Indian)", { serves: "serves 4" }),
      row("Goat curry", { missing: "refused" }),
    ],
  },
  {
    anchor: "baking",
    title: "baking",
    rows: [row("Carrot cupcakes"), row("Seeded rye crackers", { missing: "unread" })],
  },
  { anchor: null, title: null, rows: [row("Chickpea salad")] },
];

describe("rowFact", () => {
  it("says the stated time, the count and the title tags, joined by dots bound to the part before", () => {
    const parts = rowFact(
      row("Dal and rice", { times: ["Recipe says 40 min"], serves: "serves 2", tags: ["New Year's"] }),
    );
    expect(parts).toEqual(["Recipe says 40 min ·", "serves 2 ·", "New Year's"]);
  });

  it("keeps the time line's own parts whole", () => {
    expect(
      rowFact(row("Lamb stew", { times: ["Recipe says 2 h 30 ·", "30 min hands-on"], serves: "serves 6" })),
    ).toEqual(["Recipe says 2 h 30 ·", "30 min hands-on ·", "serves 6"]);
  });

  it("passes an estimated count through as servingsText wrote it", () => {
    expect(rowFact(row("Tuna salad", { serves: "serves 4 (Sous's estimate)" }))).toEqual([
      "serves 4 (Sous's estimate)",
    ]);
  });

  it("says nothing for a row with nothing to say", () => {
    expect(rowFact(row("Garlic chutney"))).toEqual([]);
  });

  it("leads with the chapter in a flat list", () => {
    expect(rowFact(row("Chana masala", { serves: "serves 4" }), "indian")).toEqual(["indian ·", "serves 4"]);
  });

  it("says why a missing row is missing, in place of its facts", () => {
    expect(rowFact(row("Goat curry", { missing: "refused", serves: "serves 4" }))).toEqual([
      "Sous couldn't read this one",
    ]);
    expect(rowFact(row("Crackers", { missing: "unread" }), "baking")).toEqual([
      "baking ·",
      "Didn't come through on the last Refresh",
    ]);
  });
});

describe("searchRows", () => {
  it("finds titles holding the query in any case, in book order, missing ones included", () => {
    expect(searchRows(BOOK, "  CHICK").map((r) => [r.row.title, r.chapter])).toEqual([
      ["Chicken thighs (Indian)", "indian"],
      ["Chickpea salad", null],
    ]);
    expect(searchRows(BOOK, "curry").map((r) => r.row.missing)).toEqual(["refused"]);
  });

  it("finds nothing for a query no title holds", () => {
    expect(searchRows(BOOK, "zzz")).toEqual([]);
  });
});

describe("missingRows", () => {
  it("lists the rows that didn't come through, with their chapters", () => {
    expect(missingRows(BOOK).map((r) => [r.row.title, r.chapter])).toEqual([
      ["Goat curry", "indian"],
      ["Seeded rye crackers", "baking"],
    ]);
  });
});

describe("chapterAnchors", () => {
  it("makes a chapter's name an anchor", () => {
    expect(chapterAnchors(["indian", "east asian", "quick & easy", "Crème brûlée"])).toEqual([
      "indian",
      "east-asian",
      "quick-easy",
      "creme-brulee",
    ]);
  });

  it("keeps anchors unique and never empty", () => {
    expect(chapterAnchors(["Baking", "baking!", "***", "—"])).toEqual(["baking", "baking-2", "chapter", "chapter-2"]);
  });
});

describe("contentsColumns", () => {
  const entries = (n: number): ContentsEntry[] =>
    Array.from({ length: n }, (_, i) => ({ anchor: `c${i}`, title: `c${i}`, count: i }));

  it("splits up to ten chapters across two columns, the first one longer", () => {
    const { columns, more } = contentsColumns(entries(9));
    expect(columns.map((c) => c.length)).toEqual([5, 4]);
    expect(more).toBe(0);
    expect(contentsColumns(entries(10)).columns.map((c) => c.length)).toEqual([5, 5]);
    expect(contentsColumns(entries(1)).columns.map((c) => c.length)).toEqual([1, 0]);
    expect(contentsColumns([]).columns).toEqual([[], []]);
  });

  it("past ten, ends the second column on the count of the rest", () => {
    const { columns, more } = contentsColumns(entries(20));
    expect(columns.map((c) => c.length)).toEqual([5, 4]);
    expect(columns[1]!.at(-1)!.title).toBe("c8");
    expect(more).toBe(11);
  });
});

describe("kitchenDate", () => {
  it("says the day in the kitchen's time zone", () => {
    expect(kitchenDate("2026-10-04T15:00:00Z", "America/New_York")).toBe("Oct 4");
    // 1 a.m. UTC on the 5th is still the 4th in New York, and already the 5th in Tokyo.
    expect(kitchenDate("2026-10-05T01:00:00Z", "America/New_York")).toBe("Oct 4");
    expect(kitchenDate("2026-10-05T01:00:00Z", "Asia/Tokyo")).toBe("Oct 5");
  });

  it("reads the day in the default place's zone when no kitchen zone is set", () => {
    // 23:30 UTC on 4 July is already the 5th at the placeholder place, on summer time.
    expect(kitchenDate("2026-07-04T23:30:00Z")).toBe("Jul 5");
  });
});
