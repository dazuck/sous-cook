import { describe, expect, it } from "vitest";
import {
  finishWords,
  layoutMealLines,
  LINES_TYPE,
  mergeColumns,
  moreSteps,
  SHORT_POT_MIN,
  SMALL_SIZE,
  SMALL_WORDS,
  STOP_TARGET_PX,
  type ColumnsDrawing,
  type ListDrawing,
} from "./meal-lines-layout";
import { mealLines, runsOf } from "./meal-lines";
import { initialCookState, next, prepPages, type CookState } from "./cook-view";
import { parseCookPlan, type CookPlan } from "./cook-plan";
import { strip } from "./cook-strip";
import { advanceMeasure as measure } from "./__tests__/advance-measure";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "./__tests__/load-cook-plan-fixtures";
import { loadKitchenPlans } from "./__tests__/load-kitchen-plans";

function corpusPlan(name: string): CookPlan {
  const fixture = loadCookPlanFixtures().find((f) => f.name === name);
  const raw = loadCookPlanSnapshots().get(name)?.raw;
  if (!fixture || !raw) throw new Error(`no corpus plan ${name}`);
  const parsed = parseCookPlan(raw, fixture.recipe);
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return parsed.plan;
}
const kitchenPlan = (name: string) => loadKitchenPlans().find((p) => p.name === name)!.plan;
function at(plan: CookPlan, mode: "first" | "go", pos: number): CookState {
  let s = initialCookState(mode);
  while (s.pos < pos) s = next(plan, s);
  return s;
}
const cpx = (W: number, H: number) => Math.min(Math.max(W, H) / 960, Math.min(W, H) / 600);
const cols = (d: ReturnType<typeof layoutMealLines>) => d as ColumnsDrawing;

/**
 * The whole cook's room as the page lays it (`layoutWholeCook`, `wholeLinesBottom`): the foot 100 cpx
 * off the bottom, the lines 14 cpx over it, the chart 110 cpx under the sheet's top (its header), so
 * 224 cpx off the height; the gutters (44 cpx, a little more than the sheet's 35) off each side.
 */
const WHOLE_OFF_H = 100 + 14 + 110;
const wholeRoom = (W: number, H: number) => ({ W: W - 2 * 44 * cpx(W, H), H: H - WHOLE_OFF_H * cpx(W, H), c: cpx(W, H), narrow: false });
/** The whole meal's room in the sheet on the tablet: 501 px at 1280×800. */
const sheet1280 = wholeRoom(1280, 800);
/** The opening's right column on the tablet as drawn (Get out 200 cpx beside it), below its toggle. */
const opening1280 = { W: 650 * cpx(1280, 800), H: 560, c: cpx(1280, 800), narrow: false };
const upright = { W: 800 - 2 * 44 * cpx(800, 1280), H: 900, c: cpx(800, 1280), narrow: true };
const phone = { W: 390 - 2 * 44 * cpx(390, 844), H: 600, c: cpx(390, 844), narrow: true };

const roast = corpusPlan("sunday-roast-dinner");
const pita = kitchenPlan("chicken-pita-wraps");
const openingOf = (plan: CookPlan, mode: "first" | "go" = "first") => mealLines(plan, strip(plan, initialCookState(mode)), { opening: true });
const midOf = (plan: CookPlan, pos: number, mode: "first" | "go" = "first") => {
  const st = at(plan, mode, pos);
  return mealLines(plan, strip(plan, st));
};

type Touch = { target: { x: number; y: number; w: number; h: number }; top: number; bottom: number; what: string };
/**
 * The stops' touches: each covers its own words, stands inside the drawing, takes no other stop's
 * room, and is 48 px tall unless a neighbour's touch or the drawing's edge is right there.
 */
function checkTouches(ts: Touch[], height: number) {
  const meets = (a: Touch["target"], b: Touch["target"]) =>
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && (Math.abs(a.y + a.h - b.y) < 0.5 || Math.abs(b.y + b.h - a.y) < 0.5);
  for (const t of ts) {
    const b = t.target;
    expect(b.y, t.what).toBeGreaterThanOrEqual(-0.5);
    expect(b.y + b.h, t.what).toBeLessThanOrEqual(height + 0.5);
    expect(b.y, t.what).toBeLessThanOrEqual(t.top + 0.5);
    expect(b.y + b.h, t.what).toBeGreaterThanOrEqual(t.bottom - 0.5);
    for (const o of ts) {
      if (o === t) continue;
      const ox = Math.min(b.x + b.w, o.target.x + o.target.w) - Math.max(b.x, o.target.x);
      const oy = Math.min(b.y + b.h, o.target.y + o.target.h) - Math.max(b.y, o.target.y);
      expect(ox > 0.5 && oy > 0.5, `${t.what} overlaps ${o.what}`).toBe(false);
    }
    if (b.h < STOP_TARGET_PX - 0.5) {
      const edge = b.y < 0.5 || b.y + b.h > height - 0.5;
      expect(edge || ts.some((o) => o !== t && meets(b, o.target)), `${t.what}: ${b.h} px with room to spare`).toBe(true);
    }
  }
}

/** Every word inside its box, no type under the floor, every stop's touch its own, inside the drawing's width. */
function checkColumns(d: ColumnsDrawing, g: { W: number; c: number }) {
  expect(d.width).toBeLessThanOrEqual(g.W + 0.5);
  // The floor, 22 cpx, save the ladder's last level: 20 cpx, the one exception (2026-11-23).
  if (d.level === 2) expect(d.type.size).toBeCloseTo(SMALL_SIZE * g.c);
  else expect(d.type.size).toBeGreaterThanOrEqual(22 * g.c - 1e-6);
  for (const s of d.stops) {
    for (const ln of s.lines) expect(measure(ln, d.type.size, s.state === "now" ? 600 : 500)).toBeLessThanOrEqual(s.w + 0.5);
    for (const ln of s.more ?? []) expect(measure(ln, d.type.size, 500), ln).toBeLessThanOrEqual(s.w + 0.5);
    expect(s.x + s.w).toBeLessThanOrEqual(d.width + 0.5);
  }
  checkTouches(
    d.stops.map((s) => ({
      target: s.target!,
      top: Math.min(s.y, s.dotY - s.dotR),
      bottom: Math.max(s.y + (s.lines.length + (s.more?.length ?? 0)) * d.type.line, s.dotY + s.dotR),
      what: s.lines.join(" ") || s.key,
    })),
    d.height,
  );
  for (const h of d.heads) for (const ln of h.lines) expect(measure(ln, d.type.size, 600)).toBeLessThanOrEqual(h.w + 0.5);
}
function checkList(d: ListDrawing, g: { W: number; c: number }) {
  expect(Math.min(d.type.label, d.type.meta, d.type.ruled)).toBeGreaterThanOrEqual(22 * g.c - 1e-6);
  for (const r of d.rows) {
    if (r.kind === "step") {
      for (const ln of r.lines) expect(d.cols.label + measure(ln, d.type.label, 600)).toBeLessThanOrEqual(g.W + 0.5);
    } else if (r.kind === "break") {
      for (const ln of r.lines) expect(d.cols.label + measure(ln, d.type.ruled, 500)).toBeLessThanOrEqual(g.W + 0.5);
    } else {
      for (const ln of r.lines) expect(measure(ln, d.type.meta, 500)).toBeLessThanOrEqual(g.W + 0.5);
    }
  }
  checkTouches(
    d.rows.flatMap((r) => (r.kind === "step" ? [{ target: r.target!, top: r.y, bottom: r.y + r.h, what: r.lines.join(" ") }] : [])),
    d.height,
  );
  // What a stop says to a screen reader starts with its words, never the dot's glyph (review: touch 5).
  for (const r of d.rows) if (r.kind === "step") expect(r.said).not.toMatch(/[○●]/);
}

describe("the words", () => {
  it("count a run one way everywhere, the prototype's: 'then 1 more', 'then 9 more'", () => {
    expect(moreSteps(1)).toBe("then 1 more");
    expect(moreSteps(9)).toBe("then 9 more");
  });
  it("say the finish as drawn", () => {
    expect(finishWords({ minutes: 27, going: 4, afterLong: true }).replace(/ /g, " ")).toBe("then the last 27 min: four things going");
  });
});

describe("the Sunday roast at the opening, in the tablet's right column", () => {
  const L = openingOf(roast);
  const d = layoutMealLines(L, opening1280, measure) as ColumnsDrawing;

  it("draws four columns, every word inside its box, at the drawing's size", () => {
    expect(d.form).toBe("columns");
    expect(d.heads.map((h) => h.lines.join(" "))).toEqual(["Chicken", "Potatoes", "Gravy", "Beans"]);
    checkColumns(d, opening1280);
  });

  it("sets the heads on one baseline", () => {
    const bottoms = d.heads.map((h) => h.y + h.lines.length * d.type.line);
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(1e-6);
  });

  it("says when the cook can walk away and for how long: the ruled breaks with their words (the opening keeps them)", () => {
    expect(d.breaks.map((b) => b.words)).toEqual(["10 min free", "10 min free", "50 min free"]);
    const fifty = d.breaks[2];
    const ten = d.breaks[0];
    expect(fifty.h).toBeGreaterThan(ten.h);
    for (const b of d.breaks) expect(b.w).toBe(d.width);
  });

  it("puts every stop in cook order down the screen, a break between the stops it parts", () => {
    // By each stop's top (a quiet pot's dot sits higher in its row than a labelled one's).
    const ys = L.stops.map((q) => d.stops.find((s) => s.key === q.key && !s.term)?.y).filter((y): y is number => y !== undefined);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-6);
    const byLabel = (label: string) => d.stops.find((s) => s.key === L.stops.find((q) => q.label === label)!.key)!;
    const roastStop = byLabel("Roast chicken and potatoes");
    const crisp = byLabel("Crisp potatoes");
    expect(d.breaks.some((b) => b.y > roastStop.dotY && b.y < crisp.dotY)).toBe(true);
  });

  it("draws the shared roast on both lines with a bar, and bends every other line into the carve", () => {
    expect(d.shares.map((s) => s.dots.length)).toEqual([1]);
    expect(d.bends.map((b) => b.col).sort()).toEqual([1, 2, 3]);
    const carve = d.stops.find((s) => s.term)!;
    expect(carve.lines.join(" ")).toBe("Carve and serve");
  });

  it("has no ember on the board before Start", () => {
    expect(d.stops.some((s) => s.state === "now")).toBe(false);
    expect(d.nowY).toBeNull();
  });
});

describe("the roast's whole meal mid-cook, in the sheet", () => {
  const P = prepPages(roast, "first").length;
  const L = midOf(roast, P + 6);
  const d = layoutMealLines(L, sheet1280, measure) as ColumnsDrawing;

  it("a running pot whose words run past four lines keeps its minutes left on the last line (review: bug 6)", () => {
    const long = "roasts with the lid off and the potatoes turned once halfway so every side takes colour in the fat";
    const M = { ...L, stops: L.stops.map((q) => (q.state === "running" ? { ...q, words: long } : q)) };
    const r = cols(layoutMealLines(M, sheet1280, measure)).stops.find((s) => s.state === "running")!;
    expect(r.lines.length).toBeLessThanOrEqual(4);
    expect(r.lines.at(-1)).toMatch(/\d+\u00a0min left$/);
  });

  it("a shared step's touch reaches every line it stands on, its own line right of the other's included (review: bug 7b)", () => {
    // Stored plans give a shared step the left-most line as its own; the roast's, turned round.
    const k = L.stops.findIndex((q) => q.also.length > 0 && q.state !== "done");
    const q0 = L.stops[k];
    const M = { ...L, stops: L.stops.map((q, i) => (i === k ? { ...q, col: q0.also[0], also: [q0.col] } : q)) };
    const D = cols(layoutMealLines(M, sheet1280, measure));
    const t = D.stops.find((x) => x.key === q0.key)!.target!;
    const bar = D.shares.find((x) => x.key === q0.key)!;
    expect(t.x).toBeLessThanOrEqual(bar.x0);
    expect(t.x + t.w).toBeGreaterThanOrEqual(bar.x1);
  });

  it("a step shared across a column between its lines stands below that column's words, its bar crossing none (review: bug 7c)", () => {
    // No stored plan shares across a middle line yet: the roast's shared step, moved to share with the
    // line two over, the potatoes' step in hand before it worded long enough to reach past it.
    const k = L.stops.findIndex((q) => q.also.length > 0 && q.state !== "done");
    const q0 = L.stops[k];
    const far = L.columns.length - 1;
    expect(far - q0.col).toBeGreaterThanOrEqual(2);
    const long = "Coat the potatoes in the hot duck fat, turning each one so every side is slick";
    const M = {
      ...L,
      stops: L.stops.map((q, i) =>
        i === k ? { ...q, also: [far] } : q.state === "now" && q.col > q0.col && q.col < far ? { ...q, label: long, words: long } : q,
      ),
    };
    expect(M.stops.some((q) => q.words === long)).toBe(true);
    for (const level of [0, 1] as const) {
      const D = cols(layoutMealLines(M, sheet1280, measure, { level }));
      const bar = D.shares.find((x) => x.key === q0.key)!;
      for (const s of D.stops.filter((x) => x.col > q0.col && x.col < far && x.lines.length)) {
        const bottom = s.y + (s.lines.length + (s.more?.length ?? 0)) * D.type.line;
        expect(bar.y > s.y && bar.y < bottom, `level ${level}: the bar crosses ${s.lines.join(" ")}`).toBe(false);
      }
    }
  });

  it("budgets a shared step's words in the column they stand in, the right-most of its lines (review: bug 1)", () => {
    const k = L.stops.findIndex((q) => q.also.length > 0 && q.state !== "done");
    expect(k).toBeGreaterThanOrEqual(0);
    const long = "Carve-rest-and-plate-everything";
    const M = { ...L, stops: L.stops.map((q, i) => (i === k ? { ...q, label: long, words: long } : q)) };
    const D = cols(layoutMealLines(M, sheet1280, measure));
    expect(D.stops.find((s) => s.key === M.stops[k].key)!.lines.join(" ")).toBe(long);
    checkColumns(D, sheet1280);
  });

  it("fits without scrolling, the step in hand ember and in view", () => {
    checkColumns(d, sheet1280);
    expect(d.scroll).toBe(false);
    const now = d.stops.filter((s) => s.state === "now");
    expect(now.map((s) => s.lines.join(" "))).toEqual(["Coat potatoes"]);
    expect(now[0].dotR).toBeCloseTo((LINES_TYPE.nowDot * sheet1280.c) / 2);
  });

  it("folds work done to one quiet dot per line, and says how long a pot from before has left", () => {
    expect(new Set(d.done.map((x) => x.col)).size).toBe(d.done.length);
    const running = d.stops.find((s) => s.state === "running")!;
    expect(running.until).not.toBeNull();
    expect(running.lines.join(" ")).toMatch(/min left$/);
  });
});

describe("five dishes: the chicken pita wraps at the opening", () => {
  it("keeps every word in its box: merging the dishes with the fewest stops when the least widths do not fit, else scrolling", () => {
    const d = layoutMealLines(openingOf(pita), opening1280, measure) as ColumnsDrawing;
    checkColumns(d, opening1280);
    expect(d.heads.length + d.merged.length).toBe(5);
    if (d.scroll) expect(d.height).toBeGreaterThan(opening1280.H);
  });

  it("in a narrower room shares a column, named by both dishes", () => {
    const g = { ...opening1280, W: 420 };
    const d = layoutMealLines(openingOf(pita), g, measure) as ColumnsDrawing;
    expect(d.merged.length).toBeGreaterThan(0);
    checkColumns(d, g);
    expect(d.heads.some((h) => / and /.test(h.lines.join(" ")))).toBe(true);
  });

  it("mergeColumns keeps every stop, renames and renumbers", () => {
    const L = openingOf(pita);
    const m = mergeColumns(L, 3, 4);
    expect(m.columns.length).toBe(4);
    expect(m.columns[3].name).toBe("Slaw and pickles");
    expect(m.stops.length).toBe(L.stops.length);
    expect(m.stops.every((q) => q.col < 4 && !q.also.includes(q.col))).toBe(true);
  });
});

describe("the fit ladder: the lowest level that fits, the walk-away words at every level", () => {
  /**
   * The opening's lines on the tablet at 1280 × 800 as the sheet lays it out for "Sunday Roast
   * Dinner" with the controls as measured in Chromium (mic and Start 227 px wide and 107 tall, More
   * 187 px): the title on one line beside them, the chart at 166 cpx, Get out's 210 cpx and its gap
   * off the width: 883 × 560 px.
   */
  const roomRoast = { W: 882.67, H: 560, c: cpx(1280, 800), narrow: false };
  /** The roast at the opening, "Prep first", at level 2 (20 cpx). */
  const ROAST_SMALL = 555;
  /** The pita at the opening, "Prep first", at level 2 (20 cpx); and its whole cook's tries, levels 0 to 2. */
  const PITA_SMALL = 740;
  const PITA_WHOLE = [787, 656, 576];

  it("the dal fits at level 0, full detail and 22 cpx, its first try", () => {
    const d = cols(layoutMealLines(openingOf(corpusPlan("indian-dal-tadka")), roomRoast, measure));
    expect(d.level).toBe(0);
    expect(d.scroll).toBe(false);
    expect(d.tries).toEqual([{ level: 0, height: d.tries[0].height, fits: true }]);
    expect(d.type.size).toBeCloseTo(22 * roomRoast.c);
    expect(d.stops.every((s) => s.lines.length > 0)).toBe(true);
  });

  it("every meal that fits keeps 22 cpx: the smaller words are only for one the folds leave scrolling", () => {
    const at22 = { "crispy-skin-salmon": 0, "indian-dal-tadka": 0, "lime-shrimp-tacos": 0, "multi-component-mole": 0, "yogurt-marinated-chicken": 0 } as const;
    for (const [name, level] of Object.entries(at22)) {
      for (const mode of ["first", "go"] as const) {
        const d = cols(layoutMealLines(openingOf(corpusPlan(name), mode), roomRoast, measure));
        expect([d.level, d.scroll], `${name} ${mode}`).toEqual([level, false]);
        expect(d.type.size).toBeCloseTo(22 * roomRoast.c);
      }
    }
    for (const mode of ["first", "go"] as const) {
      const butternut = cols(layoutMealLines(openingOf(kitchenPlan("butternut-chickpea-salad"), mode), roomRoast, measure));
      expect([butternut.level, butternut.type.size / roomRoast.c]).toEqual([0, 22]);
      const tomato = cols(layoutMealLines(openingOf(kitchenPlan("tomato-beans-greens"), mode), roomRoast, measure));
      expect([tomato.level, tomato.type.size / roomRoast.c]).toEqual([1, 22]);
    }
  });

  it("a meal that fits only once short pots join their runs draws level 1, not a scroll (tomato, beans and greens: five dishes)", () => {
    const g = roomRoast;
    const d = cols(layoutMealLines(openingOf(kitchenPlan("tomato-beans-greens")), g, measure));
    expect(d.tries.map((t) => [t.level, t.fits])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(d.level).toBe(1);
    expect(d.scroll).toBe(false);
    checkColumns(d, g);
  });

  it("the roast at the tablet's real column: no fold fits at 22 cpx, so it draws level 2, 20 cpx, and fits on both lanes (heights pinned)", () => {
    expect(SMALL_WORDS).toBe(true);
    for (const [mode, heights] of [
      ["first", [768, 678, 555]],
      ["go", [689, 620, 533]],
    ] as const) {
      const d = cols(layoutMealLines(openingOf(roast, mode), roomRoast, measure));
      expect(d.tries.map((t) => t.height), mode).toEqual(heights);
      expect(d.tries.map((t) => [t.level, t.fits])).toEqual([
        [0, false],
        [1, false],
        [2, true],
      ]);
      expect(d.level).toBe(2);
      expect(d.scroll).toBe(false);
      expect(d.type.size).toBeCloseTo(SMALL_SIZE * roomRoast.c);
      checkColumns(d, roomRoast);
    }
  });

  it("level 2, forced: level 1's folds with the words at 20 cpx and the rows with them, the breaks' rows (the time scale) unchanged", () => {
    const L = openingOf(roast);
    const two = cols(layoutMealLines(L, roomRoast, measure, { level: 1 }));
    const three = cols(layoutMealLines(L, roomRoast, measure, { level: 2 }));
    expect(three.level).toBe(2);
    expect(three.tries).toEqual([{ level: 2, height: ROAST_SMALL, fits: true }]);
    expect(three.type.size).toBeCloseTo(SMALL_SIZE * roomRoast.c);
    expect(three.type.line / two.type.line).toBeCloseTo(SMALL_SIZE / 22);
    // The same stops folded the same way: only the words are smaller.
    expect(three.stops.map((s) => [s.key, s.folded ?? null, s.lines.length === 0])).toEqual(
      two.stops.map((s) => [s.key, s.folded ?? null, s.lines.length === 0]),
    );
    expect(three.breaks.map((b) => [b.words, Math.round(b.h)])).toEqual(two.breaks.map((b) => [b.words, Math.round(b.h)]));
    expect(three.finish?.text).toBe(two.finish?.text);
    checkColumns(three, roomRoast);
    // Forced on a meal that fits at level 0, it still draws: the level is a pure function of its inputs.
    const dal = cols(layoutMealLines(openingOf(corpusPlan("indian-dal-tadka")), roomRoast, measure, { level: 2 }));
    expect([dal.level, dal.type.size / roomRoast.c]).toEqual([2, SMALL_SIZE]);
  });

  it("never takes even columns when a word is wider than its even share: the columns go to their words (review: ladder 1)", () => {
    // The dal, its first job's words one long word: even columns would stand it past its line.
    const L0 = openingOf(corpusPlan("indian-dal-tadka"));
    const k = L0.stops.findIndex((q) => q.state !== "done" && !q.pot && q.col === 0);
    const long = "Pick-over-rinse-and-soak-the-lentils";
    const L = { ...L0, stops: L0.stops.map((q, i) => (i === k ? { ...q, label: long, words: long } : q)) };
    const d = cols(layoutMealLines(L, roomRoast, measure));
    expect(d.stops.find((s) => s.key === L.stops[k].key)!.lines.join(" ")).toBe(long);
    checkColumns(d, roomRoast);
  });

  it("at level 1 a short pot whose stretch of free time starts as it goes in joins the run before it (review: bug 4; the cookies' bake)", () => {
    const cookies = corpusPlan("chewy-oat-cookies");
    for (const mode of ["first", "go"] as const) {
      const L = openingOf(cookies, mode);
      const bake = L.stops.find((q) => q.label === "Bake cookies")!;
      // The free 10 minutes start as the cookies go in.
      expect(L.breaks.some((b) => Math.abs(b.from - bake.start) < 1e-6)).toBe(true);
      const run = runsOf(L.stops, L.columns.length, L.breaks, SHORT_POT_MIN).find((r) => r.keys.includes(bake.key))!;
      expect(run.keys.map((k) => L.stops.find((q) => q.key === k)!.label), mode).toEqual(["Scoop dough", "Bake cookies"]);
    }
  });

  it("after two dishes share a column, a run never folds across the other dish's step on that line (review: bug 5; the pita)", () => {
    for (const mode of ["first", "go"] as const) {
      const L = openingOf(pita, mode);
      for (const level of [0, 1] as const) {
        const d = cols(layoutMealLines(L, roomRoast, measure, { level }));
        expect(d.merged.length).toBeGreaterThan(0);
        let M = L;
        for (const [a, b] of d.merged) M = mergeColumns(M, M.columns.findIndex((k) => k.dish === a), M.columns.findIndex((k) => k.dish === b));
        for (const s of d.stops.filter((x) => x.folded.length)) {
          const idx = s.folded.map((label) => M.stops.findIndex((q) => q.label === label && q.col === s.col));
          expect(idx.every((i) => i >= 0)).toBe(true);
          const between = M.stops.filter((q, i) => q.col === s.col && i > Math.min(...idx) && i < Math.max(...idx) && !s.folded.includes(q.label));
          expect(between.map((q) => q.label), `${mode} level ${level}: ${s.folded.join(", ")}`).toEqual([]);
        }
      }
    }
  });

  it("a folded run says its jobs, not its first pot's minutes (review: bug 10; the roast's duck fat)", () => {
    const d = cols(layoutMealLines(openingOf(roast), roomRoast, measure, { level: 1 }));
    const rough = d.stops.find((s) => s.lines.join(" ") === "Rough potatoes")!;
    expect(rough.said).toBe(`${rough.folded.slice(0, -1).join(", ")} and ${rough.folded.at(-1)}`);
    // A pot alone still says its minutes.
    const pot = d.stops.find((s) => s.pot && !s.folded.length && /\u00a0min$/.test(s.lines.join(" ")))!;
    expect(pot.said).toMatch(/, \d+\u00a0min$/);
  });

  it("at level 1 a short pot joins its run (counted) and a short pot alone keeps its dot with no words", () => {
    const L = openingOf(roast);
    const d = cols(layoutMealLines(L, roomRoast, measure, { level: 1 }));
    const crisp = d.stops.find((s) => s.key === L.stops.find((q) => q.label === "Crisp potatoes")!.key)!;
    expect(crisp.lines).toEqual([]);
    expect(crisp.pot).toBe(true);
    // "Rough potatoes" names the run the duck fat's 5 minutes start: its dot is the hands' (filled).
    const rough = d.stops.find((s) => s.lines.join(" ") === "Rough potatoes")!;
    expect(rough.more!.join(" ")).toBe("then 2 more");
    expect(rough.pot).toBe(false);
    expect(rough.folded).toHaveLength(3);
    expect(rough.folded).toContain("Heat duck fat");
  });

  it("five dishes (the pita) still scroll at 20 cpx, so they keep 22 cpx and scroll at level 2, every word in its box", () => {
    for (const [mode, small] of [
      ["first", PITA_SMALL],
      ["go", 609],
    ] as const) {
      const d = cols(layoutMealLines(openingOf(pita, mode), roomRoast, measure));
      expect(d.tries.at(-1), mode).toEqual({ level: 2, height: small, fits: false });
      expect(d.level).toBe(1);
      expect(d.type.size).toBeCloseTo(22 * roomRoast.c);
      expect(d.scroll).toBe(true);
      checkColumns(d, roomRoast);
    }
    // At the whole cook too: 656 px at level 1, 576 at 20 cpx in the sheet's 560, so 22 cpx and a scroll.
    const whole = cols(layoutMealLines(midOf(pita, prepPages(pita, "first").length + 2), sheet1280, measure));
    expect(whole.tries.map((t) => [t.level, t.height, t.fits])).toEqual([
      [0, PITA_WHOLE[0], false],
      [1, PITA_WHOLE[1], false],
      [2, PITA_WHOLE[2], false],
    ]);
    expect([whole.level, whole.scroll, whole.type.size / sheet1280.c]).toEqual([1, true, 22]);
  });

  it("never folds the breaks' words or the finish line, on any stored plan, at any level", () => {
    for (const plan of storedPlans()) {
      for (const mode of ["first", "go"] as const) {
        const L = openingOf(plan, mode);
        if (L.oneDish) continue;
        const base = cols(layoutMealLines(L, roomRoast, measure, { level: 0 }));
        for (const level of [1, 2] as const) {
          const d = cols(layoutMealLines(L, roomRoast, measure, { level }));
          expect(d.breaks.map((b) => b.words)).toEqual(base.breaks.map((b) => b.words));
          expect(d.breaks.map((b) => b.words)).toEqual(L.breaks.map((b) => `${b.minutes} min free`));
          expect(d.finish?.text ?? null).toEqual(base.finish?.text ?? null);
        }
      }
    }
  });
});

function storedPlans(): CookPlan[] {
  return [
    ...loadCookPlanFixtures().flatMap((f) => {
      const raw = loadCookPlanSnapshots().get(f.name)?.raw;
      const p = raw ? parseCookPlan(raw, f.recipe) : null;
      return p && p.ok ? [p.plan] : [];
    }),
    ...loadKitchenPlans().map((k) => k.plan),
  ];
}

describe("the list (portrait, and a one-dish meal)", () => {
  const P = prepPages(roast, "first").length;

  it("upright and on a phone: Done in one line, then each step with its dish, the breaks ruled as the peek says them", () => {
    for (const g of [upright, phone]) {
      const d = layoutMealLines(midOf(roast, P + 6), g, measure) as ListDrawing;
      expect(d.form).toBe("list");
      checkList(d, g);
      expect(d.rows[0].kind).toBe("done");
      expect(d.rows[0].lines[0]).toMatch(/^Done: prep potatoes/);
      const brk = d.rows.find((r) => r.kind === "break")!;
      expect(brk.said).toBe("then 50 min free while it roasts");
      expect(d.rows.filter((r) => r.state === "now").map((r) => r.lines.join(" "))).toEqual(["Coat potatoes"]);
    }
  });

  it("names both dishes on a shared step", () => {
    const d = layoutMealLines(openingOf(roast), upright, measure) as ListDrawing;
    const shared = d.rows.find((r) => r.kind === "step" && r.lines.join(" ") === "Roast chicken and potatoes")!;
    expect(shared.dish).toEqual(["Chicken", "Potatoes"]);
  });

  it("a one-pan meal is the list in landscape too, with no dish column", () => {
    const d = layoutMealLines(openingOf(kitchenPlan("skillet-eggs-potatoes-greens")), sheet1280, measure) as ListDrawing;
    expect(d.form).toBe("list");
    expect(d.cols.dish).toBeNull();
    checkList(d, sheet1280);
  });
});

describe("every stored plan, at every shape", () => {
  const all: CookPlan[] = [
    ...loadCookPlanFixtures().flatMap((f) => {
      const raw = loadCookPlanSnapshots().get(f.name)?.raw;
      const p = raw ? parseCookPlan(raw, f.recipe) : null;
      return p && p.ok ? [p.plan] : [];
    }),
    ...loadKitchenPlans().map((k) => k.plan),
  ];
  it("keeps every word inside its room and every stop a 48 px target", () => {
    for (const plan of all) {
      for (const mode of ["first", "go"] as const) {
        const L = openingOf(plan, mode);
        for (const g of [sheet1280, opening1280, upright, phone]) {
          const d = layoutMealLines(L, g, measure);
          if (d.form === "columns") checkColumns(d, g);
          else checkList(d, g);
        }
      }
    }
  });

  /**
   * The shorter windows the browser's fit checks used to walk meal by meal (the tablet's Chrome tab
   * at 1280×680, a wide short window at 1000×545, a 4:3 one at 1024×768): the whole cook's room as
   * the page lays it (`wholeRoom`), the opening's the 650 cpx column beside Get out, both at the
   * window's counter scale.
   */
  const short = (W: number, H: number) => {
    const c = cpx(W, H);
    return [wholeRoom(W, H), { W: 650 * c, H: H - 180 * c, c, narrow: false }];
  };
  const shortRooms = [...short(1280, 680), ...short(1000, 545), ...short(1024, 768)];

  it("at the shorter windows too: the Chrome tab, a wide short window and a 4:3 one", () => {
    for (const plan of all) {
      for (const mode of ["first", "go"] as const) {
        const L = openingOf(plan, mode);
        for (const g of shortRooms) {
          const d = layoutMealLines(L, g, measure);
          if (d.form === "columns") checkColumns(d, g);
          else checkList(d, g);
        }
      }
    }
  });

  it("upright at 800×1280, at the whole cook on a prep page and mid-cook, every stored meal is drawn whole in its box or says it scrolls there (never drawn taller than its box unscrolled)", () => {
    // The upright whole cook's room on a prep page as the page lays it (read off the browser run:
    // the box at 47, 272, 707 × 861 px): the lines start 204 cpx down (the header's rows and the mode
    // toggle) and end 110 cpx over the window's foot.
    const c = cpx(800, 1280);
    const g = { W: 800 - 2 * 35 * c, H: 1280 - (204 + 110) * c, c, narrow: true };
    let scrolls = 0;
    for (const plan of all) {
      for (const mode of ["first", "go"] as const) {
        // Every screen of the cook, the prep pages first.
        for (let s = initialCookState(mode), n = 0; n < 200; n++) {
          const d = layoutMealLines(mealLines(plan, strip(plan, s)), g, measure);
          if (d.scroll) scrolls++;
          else expect(d.height, `${plan.tasks[0]?.id} (${mode}) at screen ${s.pos}`).toBeLessThanOrEqual(g.H + 0.5);
          const after = next(plan, s);
          if (after.pos === s.pos) break;
          s = after;
        }
      }
    }
    // Some meals are taller than an upright box (the dal on its first prep page): they scroll in it.
    expect(scrolls).toBeGreaterThan(0);
  });

  it("the roast mid-cook in the whole cook's real room at 1280×800 (501 px) is drawn whole, at the ladder's 20 cpx words at the most, never a scroll", () => {
    for (const pos of [5, 6]) {
      const d = cols(layoutMealLines(midOf(roast, pos, "first"), sheet1280, measure));
      expect(d.form).toBe("columns");
      expect(d.scroll, `screen ${pos}`).toBe(false);
      checkColumns(d, sheet1280);
    }
  });

  it("mid-cook as well as at the opening: a third of the way in and on the last screen, at every room", () => {
    for (const plan of all) {
      for (const mode of ["first", "go"] as const) {
        let s = initialCookState(mode);
        let n = 0;
        for (let after = next(plan, s); after.pos !== s.pos && n < 200; after = next(plan, s)) {
          s = after;
          n = s.pos;
        }
        expect(n, "the cook has screens to walk").toBeGreaterThan(0);
        for (const pos of [...new Set([Math.floor(n / 3), n])]) {
          const L = midOf(plan, pos, mode);
          for (const g of [sheet1280, upright, phone, ...shortRooms.filter((_, i) => i % 2 === 0)]) {
            const d = layoutMealLines(L, g, measure);
            if (d.form === "columns") checkColumns(d, g);
            else checkList(d, g);
          }
        }
      }
    }
  });
});

describe("the pasta: one strand, the rigatoni boiling while the sauce is made (hotfix after N3)", () => {
  const pasta = corpusPlan("spicy-harissa-pasta");
  it("draws the boil as its own stop, its pot's span holding the sauce's hand jobs, at the opening and as the cook starts", () => {
    for (const mode of ["first", "go"] as const) {
      for (const L of [openingOf(pasta, mode), midOf(pasta, 0, mode)]) {
        const boil = L.stops.find((s) => s.key === "boil-rigatoni");
        expect(boil, mode).toBeDefined();
        expect(boil!.pot).toBe(true);
        const beside = L.stops.filter((s) => !s.pot && s.start >= boil!.start && s.end <= boil!.end);
        expect(beside.map((s) => s.key), "the sauce made while it boils").toEqual(expect.arrayContaining(["warm-harissa-oil", "cook-garlic"]));
        for (const g of [sheet1280, opening1280, upright, phone]) {
          const d = layoutMealLines(L, g, measure);
          const keys = d.form === "columns" ? d.stops.filter((s) => s.lines.length).map((s) => s.key) : d.rows.filter((r) => r.kind === "step" && r.lines.length).map((r) => r.key);
          expect(keys, `${mode}: the boil has words at ${g.W.toFixed(0)}×${g.H}`).toContain("boil-rigatoni");
          expect(keys.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});
