import { describe, expect, it } from "vitest";
import { layoutPeek, PEEK_TYPE, type PeekDrawing } from "./peek-layout";
import { peekOf, type PeekInput, type PeekScreen } from "./cook-peek";
import { initialCookState, next, prepPages, type CookState } from "./cook-view";
import { parseCookPlan, type CookPlan } from "./cook-plan";
import { strip } from "./cook-strip";
import { advanceMeasure } from "./__tests__/advance-measure";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "./__tests__/load-cook-plan-fixtures";

const measure = advanceMeasure;

function corpusPlan(name: string): CookPlan {
  const fixture = loadCookPlanFixtures().find((f) => f.name === name);
  const raw = loadCookPlanSnapshots().get(name)?.raw;
  if (!fixture || !raw) throw new Error(`no corpus plan ${name}`);
  const parsed = parseCookPlan(raw, fixture.recipe);
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return parsed.plan;
}
function at(plan: CookPlan, mode: "first" | "go", pos: number): CookState {
  let s = initialCookState(mode);
  while (s.pos < pos) s = next(plan, s);
  return s;
}

/** The three shapes the app is held to: the tablet both ways, and a phone. */
const SCREENS = [
  { name: "tablet 1280×800", W: 1280, H: 800 },
  { name: "tablet upright 800×1280", W: 800, H: 1280 },
  { name: "phone 390×844", W: 390, H: 844 },
];
const geoOf = (W: number, H: number, maxH = 10_000) => {
  const c = Math.min(Math.max(W, H) / 960, Math.min(W, H) / 600);
  return { W, c, E: 44 * c, narrow: H > W, maxH };
};

/** Every row's words, as drawn: none wider than its room, none under the floor. */
function checkFits(d: PeekDrawing, W: number, E: number) {
  for (const r of d.rows) {
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.h).toBeLessThanOrEqual(d.height + 1e-6);
    if (r.kind === "step") {
      for (const ln of r.lines) expect(d.cols.label + measure(ln, d.type.label, 600)).toBeLessThanOrEqual(d.cols.labelRight(r) + 0.5);
    } else if (r.kind === "break" || r.kind === "table" || r.kind === "after") {
      for (const ln of r.lines) expect(d.cols.label + measure(ln, d.type.ruled, 500)).toBeLessThanOrEqual(W - E + 0.5);
    }
  }
}

describe("layoutPeek on the Sunday roast, Coat potatoes (the approved drawing's frame)", () => {
  const roast = corpusPlan("sunday-roast-dinner");
  const P = prepPages(roast, "first").length;
  const st = at(roast, "first", P + 6);
  const input = peekOf(roast, st, strip(roast, st));

  it("on the tablet the rows are no smaller than the approved drawing (32 px rows, 29 px words beside them)", () => {
    const d = layoutPeek(input, geoOf(1280, 800), measure);
    expect(d.type.label).toBeGreaterThanOrEqual(32 - 1e-6);
    expect(d.type.meta).toBeGreaterThanOrEqual(29 - 0.1);
    expect(d.type.ruled).toBeGreaterThanOrEqual(32 - 1e-6);
  });

  it("on a phone the rows are no smaller than the drawing's phone (19 px rows, 16 px words)", () => {
    const d = layoutPeek(input, geoOf(390, 844), measure);
    expect(d.type.label).toBeGreaterThanOrEqual(19);
    expect(d.type.meta).toBeGreaterThanOrEqual(16);
    expect(d.type.ruled).toBeGreaterThanOrEqual(16);
  });

  for (const s of SCREENS) {
    it(`at ${s.name}: four rows, each step on one line with its dish, the ruled row and the after row; nothing over its room`, () => {
      const g = geoOf(s.W, s.H);
      const d = layoutPeek(input, g, measure);
      expect(d.rows.map((r) => r.kind)).toEqual(["step", "step", "break", "after"]);
      const steps = d.rows.filter((r) => r.kind === "step");
      for (const r of steps) expect(r.kind === "step" && r.dish).toBeTruthy();
      // Nothing is under the 22 cpx floor, anywhere.
      for (const px of [d.type.label, d.type.meta, d.type.ruled]) expect(px).toBeGreaterThanOrEqual(22 * g.c - 1e-6);
      checkFits(d, s.W, g.E);
      // The rows stack without overlapping.
      for (let i = 1; i < d.rows.length; i++) expect(d.rows[i].y).toBeGreaterThanOrEqual(d.rows[i - 1].y + d.rows[i - 1].h - 1e-6);
      // The rail joins the first dot to the last.
      expect(d.rail).not.toBeNull();
    });
  }
});

describe("layoutPeek: the edges", () => {
  const screen = (key: string, label: string, i: number, dish: string | null = null): PeekScreen => ({ key, label, dish, start: i, end: i + 1, pot: false, stretch: 0 });

  it("a long label wraps (two lines on the tablet), and past that is cut at a word with an ellipsis, never mid-word", () => {
    const long = "Whisk the eggs with the cream, the grated parmesan, a good pinch of salt and plenty of black pepper until smooth and pale, then set it aside somewhere cool while you bring a large pot of well salted water to a rolling boil";
    const input: PeekInput = { screens: [screen("a", long, 0), screen("b", "Serve", 1)], at: 0, frees: [], toTable: 2, asWritten: false };
    const g = geoOf(1280, 800);
    const d = layoutPeek(input, g, measure);
    const r = d.rows[0];
    expect(r.kind).toBe("step");
    if (r.kind !== "step") return;
    expect(r.lines.length).toBe(2);
    expect(r.lines[1].endsWith("…")).toBe(true);
    const shownWords = r.lines.join(" ").replace("…", "").split(" ");
    const allWords = long.split(" ");
    shownWords.forEach((w, i) => expect(w.replace(/[,;:]$/, "")).toBe(allWords[i].replace(/[,;:]$/, "")));
    checkFits(d, 1280, g.E);
  });

  it("drops the dish on a row where it would not fit beside the label on one line", () => {
    const label = "Fold the whipped egg whites gently into the chocolate base in three";
    const input: PeekInput = { screens: [screen("a", label, 0, "Chocolate mousse"), screen("b", "Chill", 1, "Mousse")], at: 0, frees: [], toTable: 2, asWritten: false };
    const d = layoutPeek(input, geoOf(1280, 800), measure);
    const [a, b] = d.rows;
    expect(a.kind === "step" && a.dish).toBeNull();
    expect(b.kind === "step" && b.dish).toBe("Mousse");
  });

  it("a peek too tall for its room folds sooner, down to the step in hand and the ruled row", () => {
    const screens = Array.from({ length: 6 }, (_, i) => screen(`s${i}`, `Step number ${i}`, i));
    const input: PeekInput = { screens, at: 0, frees: [], toTable: 6, asWritten: false };
    const g = geoOf(1280, 800);
    const roomy = layoutPeek(input, g, measure);
    expect(roomy.limit).toBe(3);
    const tight = layoutPeek(input, { ...g, maxH: roomy.height - 1 }, measure);
    expect(tight.limit).toBeLessThan(3);
    expect(tight.height).toBeLessThanOrEqual(roomy.height - 1);
    const tiny = layoutPeek(input, { ...g, maxH: 10 }, measure);
    expect(tiny.limit).toBe(0);
    expect(tiny.rows.map((r) => r.kind)).toEqual(["step", "table"]);
  });

  it("on a phone a ruled row too long for one line drops its 'while' before it wraps", () => {
    const screens = [
      { key: "a", label: "Coat", dish: null, start: 0, end: 2, pot: false, stretch: 0 },
      { key: "b", label: "Roast chicken", dish: null, start: 2, end: 60, pot: true, stretch: 0 },
      { key: "c", label: "Carve", dish: null, start: 60, end: 62, pot: false, stretch: 1 },
    ];
    const input: PeekInput = { screens, at: 0, frees: [{ stretch: 0, from: 2, to: 60, minutes: 55 }], toTable: 62, asWritten: false };
    const g = geoOf(390, 844);
    const d = layoutPeek(input, g, measure);
    const brk = d.rows.find((r) => r.kind === "break");
    expect(brk).toBeDefined();
    checkFits(d, 390, g.E);
  });

  it("with no rows the peek is empty", () => {
    const d = layoutPeek({ screens: [], at: 0, frees: [], toTable: null, asWritten: false }, geoOf(1280, 800), measure);
    expect(d.rows).toEqual([]);
  });

  it("type sizes as cpx: 24 and 22 on the tablet's landscape, 30 and 26 upright and on a phone", () => {
    expect(PEEK_TYPE.wide).toMatchObject({ label: 24, meta: 22, ruled: 24 });
    expect(PEEK_TYPE.narrow).toMatchObject({ label: 30, meta: 26, ruled: 28 });
  });
});
