import { describe, expect, it } from "vitest";
import { advanceMeasure as measure } from "@/lib/kitchen/__tests__/advance-measure";
import { aheadFolds, foldedCount, foldedWidthCpx, headRowCpx, listRowsCpx, noteFoldedCpx, noteFullCpx, noteRuns, wrapRuns, COLUMN } from "./get-out-room";

/**
 * The column's sum against the browser (Chromium at 1280×800 and 1280×680, measured 2026-11-24 on the
 * four seeded meals with make-ahead work, before the fold): each note's lines, Get out's head row with
 * the stepper "serves 4 (Sous's estimate)", and a list's first two rows.
 */
const SEEDED = [
  { name: "roast", ahead: [["Dry-brine chicken.", "overnight"], ["Temper chicken.", "1 hour before"]], ask: "Missed these?", lines: 6 },
  { name: "yogurt chicken", ahead: [["Grate garlic, juice lemon, mix marinade, and marinate chicken.", "at least 4 hours before"]], ask: "Missed these?", lines: 8 },
  {
    name: "cookies",
    ahead: [
      ["Soften butter.", "at least 3 hours before"],
      ["Warm eggs.", "at least 2½ hours before"],
      ["Whisk dry ingredients, cream butter and sugar, add eggs and vanilla, mix dough, and chill dough.", "at least 2 hours before"],
    ],
    ask: "Missed these?",
    lines: 14,
  },
  { name: "chickpea stew", ahead: [["Soak chickpeas.", "the night before"]], ask: "Missed it?", lines: 4 },
] as const;
const runsOf = (m: (typeof SEEDED)[number]) =>
  noteRuns(
    m.ahead.map(([summary, lead]) => ({ summary, lead })),
    [],
    "Ahead",
    m.ask,
  );

describe("Get out keeps room for two rows: the column's sum (DS v1.66)", () => {
  it("sets each seeded note in the lines the browser draws it in", () => {
    for (const m of SEEDED) expect(wrapRuns(runsOf(m), COLUMN - 24, measure), m.name).toBe(m.lines);
  });

  it("a note's height is its lines and padding, a 48 px target at least with its ask; folded, one line", () => {
    const c = 4 / 3;
    // The roast's six lines: 6 × 26 + 12, as drawn (225 px).
    expect(noteFullCpx(runsOf(SEEDED[0]), c, measure, true)).toBe(168);
    expect(noteFullCpx(runsOf(SEEDED[0]), c, measure, true) * c).toBeCloseTo(224, 0);
    // One line: 38 cpx at 1280×800 (51 px); where a unit is under 1.263 px the 48 px floor.
    expect(noteFoldedCpx(c)).toBe(38);
    expect(noteFoldedCpx(680 / 600) * (680 / 600)).toBeCloseTo(48, 6);
  });

  it("Get out's head row as the browser draws it: the stepper's words on two lines, its − and +, Show amounts (174 cpx)", () => {
    const head = headRowCpx({ heading: "Get out", scaleNote: null, stepper: { words: "serves 4 (Sous's estimate)", scales: true }, amounts: true }, measure);
    expect(head).toBeCloseTo(174, 0);
    // No stepper: "Get out" over "Show amounts" (they don't fit side by side in 210 cpx).
    expect(headRowCpx({ heading: "Get out", scaleNote: null, stepper: null, amounts: true }, measure)).toBe(28 + 26);
    expect(headRowCpx({ heading: "Get out", scaleNote: null, stepper: null, amounts: false }, measure)).toBe(28);
  });

  it("two rows of things to get out: a group's heading is no row; a short first group runs on into the next; a list of one row is all of it", () => {
    const long = { items: ["Whole chicken", "Maris Piper potatoes", "Butter", "Garlic", "Lemon", "Thyme"] };
    // A heading (25), the 1 under it, two rows (26 each): 78 cpx, as drawn (the roast's 104 px).
    expect(listRowsCpx([long], measure)).toBe(25 + 1 + 26 + 26);
    // The chickpea stew's shape: one row in the first group, then the next group's heading and row.
    const one = { items: ["Chickpeas"] };
    expect(listRowsCpx([one, long], measure)).toBe(25 + 1 + 26 + 6 + 25 + 1 + 26);
    // A list of one row: all of it.
    expect(listRowsCpx([one], measure)).toBe(25 + 1 + 26);
    expect(listRowsCpx([], measure)).toBe(0);
  });

  it("folded, the line reads 'Ahead · 3 jobs' and its chevron, and fits the 210 cpx column whole with a two-digit count", () => {
    expect(foldedCount(1)).toBe("· 1 job");
    expect(foldedCount(3)).toBe("· 3 jobs");
    // In cpx the column is 210 at 1280×800 and at 1280×680 alike: the sum holds at both.
    for (const jobs of [1, 9, 10, 99]) expect(foldedWidthCpx(jobs, "Ahead", measure), `${jobs} jobs`).toBeLessThanOrEqual(COLUMN);
  });

  it("folds where the note at its full height leaves the list less than its two rows, and only there", () => {
    // The roast at 1280×800: 168 + 6 + 174 + 6 + 78 = 432 in a 420 cpx column.
    expect(aheadFolds({ avail: 420, noteFull: 168, folded: 38, head: 174, rows: 78 })).toBe(true);
    expect(aheadFolds({ avail: 432, noteFull: 168, folded: 38, head: 174, rows: 78 })).toBe(false);
  });

  it("never folds a note no taller than its folded line, however tight the column: it would gain the list nothing", () => {
    // One line without its ask (26 + 12 = 38 cpx): at 1280×800 the folded line is 38 too, and at
    // 1280×680 it is taller (48 px is 42.35 cpx there), so folding would take room from the list.
    for (const c of [4 / 3, 680 / 600]) {
      const folded = noteFoldedCpx(c);
      expect(aheadFolds({ avail: 100, noteFull: 38, folded, head: 174, rows: 78 }), `c ${c}`).toBe(false);
      expect(aheadFolds({ avail: 100, noteFull: folded, folded, head: 174, rows: 78 }), `c ${c}`).toBe(false);
      // A line taller than the folded one still folds where it crowds the list.
      expect(aheadFolds({ avail: 100, noteFull: 64, folded, head: 174, rows: 78 }), `c ${c}`).toBe(true);
    }
  });
});
