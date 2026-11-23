import { describe, it, expect } from "vitest";
import {
  COOK_PLAN_VERSION,
  identityPlan,
  parseCookPlan,
  type CookPlan,
  type CookTask,
  type PrepMode,
} from "./cook-plan";
import { flow, timeline } from "./cook-schedule";
import {
  lanes,
  type LanesLayout,
} from "./cook-lanes";
import { randomCookPlan, seeded } from "./__tests__/random-cook-plan";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE } from "./__tests__/zucchini-wraps";
import {
  loadCookPlanFixtures,
  loadCookPlanSnapshots,
} from "./__tests__/load-cook-plan-fixtures";

const NONE = new Set<string>();

function layoutOf(plan: CookPlan, mode: PrepMode, ticked: ReadonlySet<string> = NONE) {
  return lanes(timeline(plan, mode, ticked), flow(plan, mode, ticked));
}

/** Bars as "label lane.depth start–end", in flow order. */
function barsOf(layout: LanesLayout) {
  return layout.bars.map((b) => `${b.label} ${b.lane}.${b.depth} ${b.start}–${b.end}`);
}

function t(
  id: string,
  kind: CookTask["kind"],
  minutes: CookTask["minutes"] | null,
  needs: string[],
  branch: string,
  sourceStep: number | null = null,
): CookTask {
  return {
    id,
    kind,
    text: id,
    label: id,
    ingredientIdx: [],
    sourceStep,
    implied: sourceStep === null,
    needs,
    branch,
    ...(minutes ? { minutes } : {}),
  };
}

const on = (est: number) => ({ est, handsOff: false });
const off = (est: number) => ({ est, handsOff: true });
const planOf = (tasks: CookTask[]): CookPlan => ({ version: COOK_PLAN_VERSION, tasks });

/**
 * The duck fat heats from a minute before the potatoes finish simmering until
 * after they're roughed up: in prep first, simmer 6–24, fat 23–28, rough 24–28.
 */
const POTATOES = planOf([
  t("simmer", "cook", off(18), [], "Pot", 0),
  t("fat", "cook", off(5), [], "Pot", 1),
  t("rough", "cook", on(4), ["simmer"], "Pot", 2),
  t("coat", "cook", on(2), ["rough", "fat"], "Pot", 3),
  t("roast", "cook", off(30), [], "Main", 4),
  t("serve", "cook", on(2), ["coat", "roast"], "Main", 5),
]);

/**
 * As I go, the cheese is grated while the water boils, filling the boil: in
 * as I go, boil 6–9 and grate 6–9.
 */
const PASTA = planOf([
  t("boil", "cook", off(3), [], "Pasta", 0),
  t("grate", "mise", on(3), [], "Pasta"),
  t("cook", "cook", on(3), ["boil", "grate"], "Pasta", 1),
  t("sauce", "cook", off(12), [], "Sauce", 2),
  t("toss", "cook", on(2), ["cook", "sauce"], "Pasta", 3),
]);

/**
 * The water boils while the onion is chopped, which takes longer: in either
 * mode, boil 3–6 and chop 3–9.
 */
const ONION = planOf([
  t("boil", "cook", off(3), [], "Pasta", 0),
  t("chop", "cook", on(6), [], "Pasta", 1),
  t("cook", "cook", on(3), ["boil", "chop"], "Pasta", 2),
  t("sauce", "cook", off(12), [], "Sauce", 3),
  t("toss", "cook", on(2), ["cook", "sauce"], "Pasta", 4),
]);

function byLabel(layout: LanesLayout) {
  return Object.fromEntries(layout.bars.map((b) => [b.label, b]));
}

describe("lanes: zucchini wraps", () => {
  it("prep first: a prep band, Wrappers beside Filling, Assemble after Filling in its lane", () => {
    const layout = layoutOf(ZUCCHINI_PLAN, "first");
    expect(layout.lanes).toEqual([
      [
        { name: "Filling", start: 6, end: 22 },
        { name: "Assemble", start: 22, end: 26 },
      ],
      [{ name: "Wrappers", start: 13, end: 21 }],
    ]);
    expect(layout.prepEnd).toBe(6);
    expect(layout.total).toBe(26);
    expect(barsOf(layout)).toEqual([
      "sauté 0.0 6–21",
      "fry parathas 1.0 13–21",
      "stir in greens 0.0 21–22",
      "stuff wraps 0.0 22–25",
      "add chili oil 0.0 25–26",
    ]);
    expect(layout.bars.map((b) => b.handsOff)).toEqual([true, false, false, false, false]);
  });

  it("as I go: one bar for the merged mise, and the greens inset in the sauté", () => {
    const layout = layoutOf(ZUCCHINI_PLAN, "go");
    expect(layout.prepEnd).toBeNull();
    expect(layout.lanes).toEqual([
      [
        { name: "Filling", start: 5, end: 21 },
        { name: "Assemble", start: 21, end: 25 },
      ],
      [{ name: "Wrappers", start: 12, end: 20 }],
    ]);
    expect(barsOf(layout)).toEqual([
      "slice onion, mince scape, cut zucchini 0.0 0–5",
      "sauté 0.0 5–20",
      "chop greens 0.1 11–12",
      "fry parathas 1.0 12–20",
      "stir in greens 0.0 20–21",
      "stuff wraps 0.0 21–24",
      "add chili oil 0.0 24–25",
    ]);
    // Bars index the flow cards, so a tap can find its screen.
    expect(layout.bars.map((b) => b.item)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("as I go with mise ticked: the ticked mise becomes the prep band", () => {
    const layout = layoutOf(ZUCCHINI_PLAN, "go", new Set(["onion", "scape", "zuc"]));
    expect(layout.prepEnd).toBe(5);
    expect(barsOf(layout)[0]).toBe("sauté 0.0 5–20");
  });
});

describe("lanes: one lane, or none", () => {
  it("a recipe run as written has one branch, so one lane", () => {
    const layout = layoutOf(identityPlan(ZUCCHINI_RECIPE), "first");
    expect(layout.lanes).toHaveLength(1);
    expect(layout.bars.every((b) => b.lane === 0)).toBe(true);
  });

  it("branches that never overlap share one lane", () => {
    const plan = planOf([
      t("a", "cook", on(5), [], "Sauce", 0),
      t("b", "cook", on(5), ["a"], "Pasta", 1),
    ]);
    expect(layoutOf(plan, "first").lanes.map((lane) => lane.map((b) => b.name))).toEqual([
      ["Sauce", "Pasta"],
    ]);
  });

  it("an empty plan has no lanes and no bars", () => {
    expect(layoutOf(planOf([]), "first")).toMatchObject({ lanes: [], bars: [] });
  });
});

describe("lanes: lane assignment", () => {
  it("gives overlapping branches their own lanes and a later one the first free lane", () => {
    // Stock simmers 0–30 while the sauce is made; the garnish comes after the
    // sauce, still inside the simmer, so it takes the sauce's lane.
    const plan = planOf([
      t("stock", "cook", off(30), [], "Stock", 0),
      t("sauce", "cook", on(10), [], "Sauce", 1),
      t("garnish", "cook", on(5), ["sauce"], "Garnish", 2),
      t("plate", "cook", on(3), ["stock", "garnish"], "Plate", 3),
    ]);
    const layout = layoutOf(plan, "first");
    expect(layout.lanes.map((lane) => lane.map((b) => b.name))).toEqual([
      ["Stock", "Plate"],
      ["Sauce", "Garnish"],
    ]);
  });

  it("spans a branch over its cooking only, so mise done early doesn't widen it", () => {
    // In "As I go" the sauce's shallot is chopped while the stock simmers,
    // long before the sauce starts: the sauce still fits after the stock.
    const plan = planOf([
      t("stock", "cook", off(20), [], "Stock", 0),
      t("strain", "cook", on(2), ["stock"], "Stock", 1),
      t("shallot", "mise", on(2), [], "Sauce"),
      t("sauce", "cook", on(6), ["strain", "shallot"], "Sauce", 2),
    ]);
    const layout = layoutOf(plan, "go");
    expect(layout.lanes.map((lane) => lane.map((b) => b.name))).toEqual([["Stock", "Sauce"]]);
  });

  it("falls back to a branch's mise when it has no cooking", () => {
    const plan = planOf([
      t("roast", "cook", off(40), [], "Roast", 0),
      t("slaw", "mise", on(10), [], "Slaw"),
      t("serve", "cook", on(2), ["roast", "slaw"], "Roast", 1),
    ]);
    const layout = layoutOf(plan, "go");
    expect(layout.lanes.map((lane) => lane.map((b) => b.name))).toEqual([
      ["Roast"],
      ["Slaw"],
    ]);
    expect(layout.lanes[1][0]).toEqual({ name: "Slaw", start: 30, end: 40 });
  });

  it("orders lanes as the chapters order their branches, by first card", () => {
    // As I go, the shrimp is prepped before the onions go in to pickle, so
    // the chapters read Shrimp, Pickled Onion, Tacos, though the pickling
    // starts cooking first.
    const f = loadCookPlanFixtures().find((x) => x.name === "lime-shrimp-tacos")!;
    const parsed = parseCookPlan(loadCookPlanSnapshots().get(f.name)?.raw, f.recipe);
    if (!parsed.ok) throw new Error(parsed.detail);
    const items = flow(parsed.plan, "go", NONE);
    const chapters = [...new Set(items.map((i) => i.tasks[0].branch))];
    expect(chapters).toEqual(["Shrimp", "Pickled Onion", "Tacos"]);
    const layout = layoutOf(parsed.plan, "go");
    expect(layout.lanes.map((lane) => lane.map((b) => b.name))).toEqual([
      ["Shrimp"],
      ["Pickled Onion"],
      ["Tacos"],
    ]);
  });

  it("gives every bar in a lane a depth, so none overlaps another at its depth", () => {
    // Two hands-off tasks in one branch overlap, and hands-on work runs
    // inside both: each nests one deeper.
    const plan = planOf([
      t("braise", "cook", off(60), [], "Main", 0),
      t("rest-dough", "cook", off(30), [], "Main", 1),
      t("chop", "cook", on(5), [], "Main", 2),
      t("side", "cook", on(10), [], "Side", 3),
      t("serve", "cook", on(2), ["braise", "rest-dough", "chop", "side"], "Main", 4),
    ]);
    const layout = layoutOf(plan, "first");
    const byLabel = Object.fromEntries(layout.bars.map((b) => [b.label, b]));
    expect(byLabel["braise"].depth).toBe(0);
    expect(byLabel["rest-dough"].depth).toBe(1);
    expect(byLabel["chop"].depth).toBe(2);
    expect(byLabel["serve"].depth).toBe(0);
  });

  it("draws a bar inside the deepest bar still running when it starts, even one outliving its own", () => {
    const bars = byLabel(layoutOf(POTATOES, "first"));
    expect([bars.simmer, bars.fat, bars.rough].map((b) => `${b.start}–${b.end}`)).toEqual([
      "6–24",
      "23–28",
      "24–28",
    ]);
    // The roughing starts as the simmer ends, inside the heating fat: drawn
    // on the lane's line it would run under the fat and lose its label.
    expect(bars.fat).toMatchObject({ parent: bars.simmer.item, depth: 1 });
    expect(bars.rough).toMatchObject({ parent: bars.fat.item, depth: 2 });
    expect(bars.coat).toMatchObject({ parent: null, depth: 0 });
    expect(bars.simmer).toMatchObject({ parent: null, depth: 0 });
  });

  it("counts the labels above a bar that starts with the bar it is drawn inside", () => {
    const bars = byLabel(layoutOf(PASTA, "go"));
    expect([bars.boil, bars.grate].map((b) => `${b.start}–${b.end}`)).toEqual(["6–9", "6–9"]);
    expect(bars.boil).toMatchObject({ parent: null, labelsAbove: 0 });
    expect(bars.grate).toMatchObject({ parent: bars.boil.item, depth: 1, labelsAbove: 1 });
    expect(bars.cook).toMatchObject({ parent: null, labelsAbove: 0 });
  });

  it("of two bars starting together, draws the one ending later outside, so the other ends within it", () => {
    const bars = byLabel(layoutOf(ONION, "first"));
    expect([bars.boil, bars.chop].map((b) => `${b.start}–${b.end}`)).toEqual(["3–6", "3–9"]);
    expect(bars.chop).toMatchObject({ parent: null, depth: 0 });
    expect(bars.boil).toMatchObject({ parent: bars.chop.item, depth: 1, labelsAbove: 1 });
  });
});

describe("lanes: properties", () => {
  const rnd = seeded(20260926);
  const random = Array.from({ length: 400 }, () => randomCookPlan(rnd));
  const snapshots = loadCookPlanSnapshots();
  const corpus = loadCookPlanFixtures().flatMap((f) => {
    const raw = snapshots.get(f.name)?.raw;
    if (!raw) return [];
    const parsed = parseCookPlan(raw, f.recipe);
    return parsed.ok ? [parsed.plan] : [];
  });
  const cases = [ZUCCHINI_PLAN, ...corpus, ...random].flatMap((plan) => {
    const mise = plan.tasks.filter((x) => x.kind === "mise").map((x) => x.id);
    return (["first", "go"] as const).flatMap((mode) =>
      [NONE, new Set(mise.slice(0, 2))].map((ticked) => ({ plan, mode, ticked })),
    );
  });

  it("the corpus gives some plans lanes side by side and others one lane", () => {
    const mapped = corpus.filter((p) => layoutOf(p, "first").lanes.length >= 2);
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped.length).toBeLessThan(corpus.length);
  });

  it("draws every card once, in its branch's lane, with no two bars overlapping at a depth", () => {
    for (const c of cases) {
      const items = flow(c.plan, c.mode, c.ticked);
      const layout = lanes(timeline(c.plan, c.mode, c.ticked), items);
      expect(layout.lanes.length > 0).toBe(items.length > 0);
      for (const lane of layout.lanes) expect(lane.length).toBeGreaterThan(0);
      expect(layout.bars.map((b) => b.item)).toEqual(items.map((_, i) => i));
      for (const b of layout.bars) {
        const branch = items[b.item].tasks[0].branch;
        const names = layout.lanes[b.lane].map((x) => x.name);
        // A branch always has a lane; the bar sits in it.
        const home = layout.lanes.findIndex((lane) => lane.some((x) => x.name === branch));
        expect(home).toBe(b.lane);
        expect(names).toContain(branch);
      }
      for (const b of layout.bars) {
        // A bar is drawn inside the deepest bar in its lane running when it
        // starts, one deeper; it drops below the labels of those starting
        // with it.
        // Of bars starting together, the ones placed first are shallower.
        const before = (o: typeof b) =>
          o.start < b.start || (o.start === b.start && o.depth < b.depth);
        const running = layout.bars.filter(
          (o) => o !== b && o.lane === b.lane && before(o) && b.start < o.end,
        );
        const deepest = Math.max(-1, ...running.map((o) => o.depth));
        if (b.parent === null) {
          expect(deepest, b.label).toBe(-1);
          expect([b.depth, b.labelsAbove], b.label).toEqual([0, 0]);
          continue;
        }
        const p = layout.bars[b.parent];
        expect(running, b.label).toContain(p);
        expect(p.depth, b.label).toBe(deepest);
        expect(b.depth, b.label).toBe(p.depth + 1);
        expect(b.labelsAbove, b.label).toBe(p.start === b.start ? p.labelsAbove + 1 : 0);
        // Starting with the one it is inside, it ends within it.
        if (p.start === b.start) expect(b.end, b.label).toBeLessThanOrEqual(p.end);
      }
      for (const a of layout.bars) {
        for (const b of layout.bars) {
          if (a === b || a.lane !== b.lane || a.depth !== b.depth) continue;
          const overlap = a.start < b.end && b.start < a.end;
          expect(overlap, `${a.label} and ${b.label} overlap`).toBe(false);
        }
      }
      // Branches sharing a lane follow one another.
      for (const lane of layout.lanes) {
        for (let i = 1; i < lane.length; i++) {
          expect(lane[i].start).toBeGreaterThanOrEqual(lane[i - 1].end);
        }
      }
      // Lanes read left to right as the chapters do: each lane's first
      // chapter comes after the lane to its left's.
      const firstCard = (name: string) => items.findIndex((i) => i.tasks[0].branch === name);
      const laneKeys = layout.lanes.map((lane) => Math.min(...lane.map((x) => firstCard(x.name))));
      expect(laneKeys).toEqual([...laneKeys].sort((a, b) => a - b));
    }
  });
});
