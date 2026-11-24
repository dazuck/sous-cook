import { describe, it, expect } from "vitest";
import {
  COOK_PLAN_VERSION,
  parseCookPlan,
  type CookPlan,
  type CookTask,
  type PrepMode,
} from "./cook-plan";
import { flow, type FlowItem } from "./cook-schedule";
import {
  BREAK_MINUTES,
  freeAfter,
  freeMinutes,
  idleAfter,
  stretchesOf,
  type Stretch,
} from "./cook-chapters";
import {
  cookView,
  hasPrep,
  prepScreenCount,
  initialCookState,
  miseBefore,
  next,
} from "./cook-view";
import {
  loadCookPlanFixtures,
  loadCookPlanSnapshots,
} from "./__tests__/load-cook-plan-fixtures";

function corpusPlan(name: string): CookPlan {
  const fixture = loadCookPlanFixtures().find((f) => f.name === name);
  const raw = loadCookPlanSnapshots().get(name)?.raw;
  if (!fixture || !raw) throw new Error(`no corpus plan ${name}`);
  const parsed = parseCookPlan(raw, fixture.recipe);
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return parsed.plan;
}

/** The screens after Prep, as the cook steps through them once Prep is left. */
function stepsAfterPrep(plan: CookPlan, mode: PrepMode): FlowItem[] {
  return flow(plan, mode, miseBefore(plan, mode));
}

/**
 * The plan's notation: "P·" for Prep, stretch sizes in screens, "‖n‖" for a
 * break of n idle minutes.
 */
function notation(stretches: Stretch[], prep: boolean): string {
  const body = stretches
    .map((s, i) => {
      const size = String(s.end - s.start);
      return i === 0 ? size : `‖${Math.round(s.breakBefore ?? Number.NaN)}‖${size}`;
    })
    .join("");
  return prep ? `P·${body}` : body;
}

function corpusNotation(name: string, mode: PrepMode): string {
  const plan = corpusPlan(name);
  // "P·" is the Prep chapter: the Prep screen, or in Prep first its prep pages (DS v1.59).
  return notation(stretchesOf(stepsAfterPrep(plan, mode)), hasPrep(plan));
}

let counter = 0;

function task(t: Partial<CookTask> = {}): CookTask {
  const id = t.id ?? `t${counter++}`;
  return {
    id,
    kind: "cook",
    text: id,
    label: id,
    ingredientIdx: [],
    sourceStep: 0,
    implied: false,
    needs: [],
    branch: "Main",
    ...t,
  };
}

/** A screen from `start` to `end`; hands-off only when asked. */
function screen(
  start: number,
  end: number,
  opts: { handsOff?: boolean; branch?: string } = {},
): FlowItem {
  return {
    tasks: [
      task({
        branch: opts.branch ?? "Main",
        minutes: { est: end - start, handsOff: opts.handsOff ?? false },
      }),
    ],
    start,
    end,
    during: null,
    lead: null,
  };
}

/** `n` back-to-back hands-on screens of 2 minutes each, no waits anywhere. */
function noWaits(n: number, branchOf: (i: number) => string = () => "Main"): FlowItem[] {
  return Array.from({ length: n }, (_, i) =>
    screen(i * 2, i * 2 + 2, { branch: branchOf(i) }),
  );
}

/** Back-to-back screens with the given idle minutes before each one after the first. */
function withIdle(idle: number[]): FlowItem[] {
  const items: FlowItem[] = [];
  let at = 0;
  for (let i = 0; i <= idle.length; i++) {
    if (i > 0) at += idle[i - 1];
    items.push(screen(at, at + 2));
    at += 2;
  }
  return items;
}

const sizes = (stretches: Stretch[]) => stretches.map((s) => s.end - s.start);

describe("cook stretches: the constant", () => {
  it("breaks at 10 idle minutes", () => {
    expect(BREAK_MINUTES).toBe(10);
  });
});

describe("idleAfter", () => {
  it("frees the cook's hands at the start of a hands-off screen", () => {
    // Oven on at 0 for 15 minutes; the next screen is at 15.
    expect(idleAfter([screen(0, 15, { handsOff: true }), screen(15, 17)])).toEqual([15]);
  });

  it("keeps the hands busy to the end of a hands-on screen", () => {
    expect(idleAfter([screen(0, 15), screen(15, 17)])).toEqual([0]);
  });

  it("counts a wait filled with chopping as no wait: busy-until is a running maximum", () => {
    // A 25-minute simmer, chopping through it, then the next step at 27.
    const items = [
      screen(0, 25, { handsOff: true }),
      screen(0, 10),
      screen(10, 25),
      screen(25, 27),
    ];
    expect(idleAfter(items)).toEqual([0, 0, 0]);
  });

  it("never goes below 0 when two screens overlap", () => {
    expect(idleAfter([screen(8, 12), screen(10, 18, { handsOff: true })])).toEqual([0]);
  });

  it("has one entry fewer than the screens", () => {
    expect(idleAfter([])).toEqual([]);
    expect(idleAfter([screen(0, 2)])).toEqual([]);
  });

  it("counts a merged screen of mise as busy to its end", () => {
    const merged: FlowItem = {
      tasks: [
        task({ kind: "mise", minutes: { est: 2, handsOff: false } }),
        task({ kind: "mise", minutes: { est: 3, handsOff: false } }),
      ],
      start: 0,
      end: 5,
      during: null,
      lead: null,
    };
    expect(idleAfter([merged, screen(5, 7)])).toEqual([0]);
  });
});

describe("stretchesOf: breaks only", () => {
  it("breaks at exactly 10 idle minutes, not at 9", () => {
    expect(sizes(stretchesOf(withIdle([0, 10, 0])))).toEqual([2, 2]);
    expect(stretchesOf(withIdle([0, 10, 0]))[1].breakBefore).toBe(10);
    expect(sizes(stretchesOf(withIdle([0, 9, 0])))).toEqual([4]);
  });

  it("lets a break leave a one-screen stretch: heat the oven, then wait", () => {
    const items = [screen(0, 15, { handsOff: true }), screen(15, 17), screen(17, 19)];
    expect(stretchesOf(items)).toEqual([
      { start: 0, end: 1, breakBefore: null, breakAfter: 15 },
      { start: 1, end: 3, breakBefore: 15, breakAfter: null },
    ]);
  });

  it("cuts at every break, however short the stretches", () => {
    expect(sizes(stretchesOf(withIdle([12, 15, 40])))).toEqual([1, 1, 1, 1]);
  });

  it("gives each stretch the break after it, the next one's break before", () => {
    const stretches = stretchesOf(withIdle([0, 12, 0, 0, 40]));
    expect(stretches.map((s) => [s.breakBefore, s.breakAfter])).toEqual([
      [null, 12],
      [12, 40],
      [40, null],
    ]);
  });

  it("has no cap: twelve screens with no waits are one stretch", () => {
    expect(sizes(stretchesOf(noWaits(12)))).toEqual([12]);
    expect(sizes(stretchesOf(noWaits(34)))).toEqual([34]);
  });

  it("never cuts at a wait under 10, however long the run", () => {
    expect(sizes(stretchesOf(withIdle([0, 0, 0, 6, 0, 0, 9, 0])))).toEqual([9]);
  });

  it("keeps a run of mixed parts of the dish in one stretch", () => {
    const branches = ["Sauce", "Pasta", "Sauce", "Pasta", "Sauce", "Pasta", "Sauce"];
    expect(sizes(stretchesOf(noWaits(7, (i) => branches[i])))).toEqual([7]);
  });

  it("has no stretches for no screens and one for one", () => {
    expect(stretchesOf([])).toEqual([]);
    expect(stretchesOf([screen(0, 2)])).toEqual([
      { start: 0, end: 1, breakBefore: null, breakAfter: null },
    ]);
  });

  it("never breaks on a plan with no estimates: each step is 2 minutes by hand", () => {
    const plan: CookPlan = {
      version: COOK_PLAN_VERSION,
      tasks: ["a", "b", "c", "d", "e", "f"].map((id, i, all) =>
        task({ id, needs: i === 0 ? [] : [all[i - 1]], minutes: undefined }),
      ),
    };
    const items = flow(plan, "first", new Set());
    expect(idleAfter(items)).toEqual([0, 0, 0, 0, 0]);
    expect(sizes(stretchesOf(items))).toEqual([6]);
  });
});

describe("free time (N2-7)", () => {
  it("rounds down to 5, never up", () => {
    expect(freeMinutes(10)).toBe(10);
    expect(freeMinutes(14.999)).toBe(10);
    expect(freeMinutes(15)).toBe(15);
    expect(freeMinutes(49.5)).toBe(45);
    expect(freeMinutes(50)).toBe(50);
  });

  it("reads a schedule's thousandths as the minute they are", () => {
    // 15 by the grain, a hair under by floating point.
    expect(freeMinutes(14.9999999)).toBe(15);
  });

  it("runs from the hands' busy-until to the next stretch's first start", () => {
    // A 2-minute step at 0, a pot from 2 (hands free at 2) for 30, then a step at 32.
    const items = [screen(0, 2), screen(2, 32, { handsOff: true }), screen(32, 34)];
    const stretches = stretchesOf(items);
    expect(sizes(stretches)).toEqual([2, 1]);
    expect(freeAfter(items, stretches[0])).toEqual({ from: 2, to: 32, minutes: 30 });
    expect(freeAfter(items, stretches[1])).toBeNull();
  });

  it("takes the latest hands-end, not the stretch's last screen's", () => {
    // A long hands-on step overlaps a short one after it: hands free at 20.
    const items = [screen(0, 20), screen(5, 7), screen(33, 35)];
    const stretches = stretchesOf(items);
    expect(freeAfter(items, stretches[0])).toEqual({ from: 20, to: 33, minutes: 10 });
  });
});

describe("stretchesOf: the fixture corpus (slice C's table, its cap cuts merged)", () => {
  const table: Array<[string, string, string]> = [
    ["apple-sweet-potato-puree", "P·1‖15‖1", "P·1‖15‖1"],
    ["baking-chocolate-cake", "P·3‖11‖1", "P·5"],
    ["chewy-oat-cookies", "P·1‖15‖2‖12‖1", "P·1‖15‖2‖12‖1"],
    ["crispy-skin-salmon", "P·5", "P·7"],
    ["day-old-fried-rice", "P·6", "P·6"],
    ["indian-dal-tadka", "P·1‖14‖6", "P·9"],
    ["lime-shrimp-tacos", "P·3", "P·3"],
    ["multi-component-mole", "1‖22‖4‖12‖4", "1‖22‖4‖12‖4"],
    ["overnight-chickpea-stew", "P·1‖10‖2‖65‖1", "P·4‖65‖1"],
    ["simple-weeknight-salmon", "P·5", "P·6"],
    ["spicy-harissa-pasta", "P·3‖15‖3", "P·7"],
    ["sunday-roast-dinner", "P·1‖10‖3‖13‖4‖50‖9", "P·5‖13‖4‖42‖11"],
    ["weeknight-shakshuka", "P·1‖12‖2‖10‖3", "P·4‖10‖4"],
    ["weeknight-stir-fry", "P·6", "P·6"],
    ["yogurt-marinated-chicken", "P·1‖15‖1‖40‖1", "P·1‖15‖1‖27‖4"],
  ];

  it("covers every fixture with a derived plan", () => {
    const withPlans = loadCookPlanFixtures()
      .map((f) => f.name)
      .filter((name) => loadCookPlanSnapshots().get(name)?.raw);
    expect(withPlans.sort()).toEqual(table.map(([name]) => name).sort());
  });

  it.each(table)("%s: Prep first %s, As I go %s", (name, first, go) => {
    expect(corpusNotation(name, "first")).toBe(first);
    expect(corpusNotation(name, "go")).toBe(go);
  });
});

describe("chapters on the cook screen: Prep, then the stretches", () => {
  const chapters = (plan: CookPlan, mode: PrepMode) => {
    const start = initialCookState(mode);
    // Past Prep: the Prep screen, or in Prep first each of its prep pages.
    let state = start;
    for (let i = 0; i < prepScreenCount(plan, mode); i++) state = next(plan, state);
    return cookView(plan, { kind: "derived" }, state).chapters!;
  };

  it("keys each stretch by its first screen, after Prep", () => {
    const ids = chapters(corpusPlan("sunday-roast-dinner"), "first").map((c) => c.id);
    expect(ids[0]).toBe("prep");
    expect(ids.slice(1).every((id) => id.startsWith("stretch:"))).toBe(true);
    expect(ids).toHaveLength(5);
  });

  it("gives every stretch but the last its break, Prep none", () => {
    const free = chapters(corpusPlan("sunday-roast-dinner"), "first").map(
      (c) => c.free?.minutes ?? null,
    );
    expect(free).toEqual([null, 10, 10, 50, null]);
  });

  it("names each stretch by its opening move, for reports: mole", () => {
    expect(chapters(corpusPlan("multi-component-mole"), "first").map((c) => c.name)).toEqual([
      "Toast and soak chiles",
      "Poach chicken",
      "Blend mole",
    ]);
  });

  it("keeps one stretch after Prep, named 'Cook', with no break", () => {
    const tacos = chapters(corpusPlan("lime-shrimp-tacos"), "first");
    expect(tacos.map((c) => c.name)).toEqual(["Prep", "Cook"]);
    expect(tacos[1].free).toBeNull();
  });
});
