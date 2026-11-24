import { describe, expect, it } from "vitest";
import { breakRows, mealLines, potWords, type MealLines } from "./meal-lines";
import { initialCookState, next, prepPages, type CookState } from "./cook-view";
import { parseCookPlan, type CookPlan } from "./cook-plan";
import { strip } from "./cook-strip";
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
function kitchenPlan(name: string): CookPlan {
  const k = loadKitchenPlans().find((p) => p.name === name);
  if (!k) throw new Error(`no kitchen plan ${name}`);
  return k.plan;
}
function at(plan: CookPlan, mode: "first" | "go", pos: number): CookState {
  let s = initialCookState(mode);
  while (s.pos < pos) {
    const n = next(plan, s);
    if (n.pos === s.pos) throw new Error(`stuck at ${s.pos}`);
    s = n;
  }
  return s;
}
const opening = (plan: CookPlan, mode: "first" | "go") => mealLines(plan, strip(plan, initialCookState(mode)), { opening: true });
const midCook = (plan: CookPlan, mode: "first" | "go", pos: number) => {
  const st = at(plan, mode, pos);
  return mealLines(plan, strip(plan, st));
};
const stop = (L: MealLines, label: string) => {
  const q = L.stops.find((s) => s.label === label);
  if (!q) throw new Error(`no stop ${label}`);
  return q;
};
const dishOf = (L: MealLines, label: string) => L.columns[stop(L, label).col].dish;

const roast = corpusPlan("sunday-roast-dinner");
const pita = kitchenPlan("chicken-pita-wraps");

describe("the compressed scale ('Yes, keep these steps')", () => {
  it("is 1 row to 5 minutes, 1.25 to 15, 1.6 to 30 and 1.9 past that, however long", () => {
    expect([1, 5, 6, 15, 16, 30, 31, 50, 240].map(breakRows)).toEqual([1, 1, 1.25, 1.25, 1.6, 1.6, 1.9, 1.9, 1.9]);
  });
});

describe("what a pot says on its line", () => {
  it("says only its verb when the dish heads the column", () => {
    expect(potWords("roast chicken and potatoes", "Chicken")).toBe("roasts");
    expect(potWords("roast chicken thighs", "Chicken")).toBe("roasts");
    expect(potWords("simmer potatoes", "Potatoes")).toBe("simmers");
    expect(potWords("air fry squash", "Squash")).toBe("air fries");
  });
  it("keeps the prototype's short form when something else cooks ('heats', 'boils'), but names the oven: a bare 'heats' would not say what heats", () => {
    expect(potWords("heat oven", "Chicken")).toBe("oven heats");
    expect(potWords("preheat oven", "Chicken")).toBe("oven heats");
    expect(potWords("heat duck fat", "Potatoes")).toBe("heats");
    expect(potWords("boil chickpeas", "Hummus")).toBe("boils");
  });
  it("says the oven heats for a pot that preps the oven, and 'cooks' with no cooking verb at all", () => {
    expect(potWords("prep oven and pans", null)).toBe("oven heats");
    expect(potWords("finish dish", null)).toBe("cooks");
  });
});

describe("the Sunday roast at the opening (Prep first), against the approved drawing", () => {
  const L = opening(roast, "first");

  it("draws one column per dish, in the order each first goes on the heat", () => {
    expect(L.columns.map((c) => c.name)).toEqual(["Chicken", "Potatoes", "Gravy", "Beans"]);
    expect(L.oneDish).toBe(false);
  });

  it("puts each prep job on its own dish's line, at the head", () => {
    expect(["Prep potatoes", "Prep aromatics", "Trim beans", "Chop shallot"].map((l) => dishOf(L, l))).toEqual(["Potatoes", "Chicken", "Beans", "Gravy"]);
    expect(L.stops.slice(0, 4).every((q) => q.prep)).toBe(true);
  });

  it("draws the roast both dishes share on both lines; the crisping after it is the potatoes' alone", () => {
    const shared = stop(L, "Roast chicken and potatoes");
    expect(shared.col).toBe(0);
    expect(shared.also).toEqual([1]);
    expect(stop(L, "Crisp potatoes").also).toEqual([]);
  });

  it("meets every line at the last step, which says itself in full", () => {
    const last = L.stops[L.stops.length - 1];
    expect(last.label).toBe("Carve and serve");
    expect(last.joins).toEqual([1, 2, 3]);
    expect(last.words).toBe("Carve and serve");
  });

  it("says pots by their verb, the oven by name, and counts a wait a break covers only once", () => {
    expect(stop(L, "Heat oven").words).toBe("oven heats");
    expect(stop(L, "Roast chicken and potatoes")).toMatchObject({ words: "roasts", minutes: null });
    expect(stop(L, "Rest chicken")).toMatchObject({ words: "rests", minutes: 15 });
  });

  it("says when the cook can walk away, and for how long: three breaks, the 50-minute roast on the top step of the scale", () => {
    expect(L.breaks.map((b) => [b.minutes, b.rows])).toEqual([
      [10, 1.25],
      [10, 1.25],
      [50, 1.9],
    ]);
    expect(L.finish).toEqual({ minutes: 27, going: 4, afterLong: true });
  });

  it("has nothing done and nothing in hand before Start", () => {
    expect(L.stops.every((q) => q.state === "ahead")).toBe(true);
  });

  it("offers the gravy's three jobs as a run that may fold, never the shared roast or the last step", () => {
    const gravy = L.runs.find((r) => L.columns[r.col].dish === "Gravy");
    expect(gravy?.keys.map((k) => L.stops.find((q) => q.key === k)?.label)).toEqual(["Skim fat", "Cook shallot and flour", "Deglaze gravy"]);
    const folded = new Set(L.runs.flatMap((r) => r.keys));
    expect(folded.has(stop(L, "Roast chicken and potatoes").key)).toBe(false);
    expect(folded.has(stop(L, "Carve and serve").key)).toBe(false);
  });
});

describe("the roast As I go", () => {
  const first = opening(roast, "first");
  const go = opening(roast, "go");
  it("keeps its columns where they stood in Prep first", () => {
    expect(go.columns).toEqual(first.columns);
  });
  it("moves the gravy's and the beans' prep into the 40-minute roast, after the break starts", () => {
    const brk = go.breaks.find((b) => b.minutes === 40)!;
    expect(stop(go, "Chop shallot").start).toBeGreaterThanOrEqual(brk.from);
    expect(stop(go, "Trim beans").prep).toBe(false);
  });
});

describe("the roast mid-cook (Prep first): where the cook stands", () => {
  const P = prepPages(roast, "first").length;
  const L = midCook(roast, "first", P + 6); // Coat potatoes

  it("marks the step in hand, and only it, as now", () => {
    expect(L.stops.filter((q) => q.state === "now").map((q) => q.label)).toEqual(["Coat potatoes"]);
  });

  it("folds the work done, and keeps a pot still cooking from before as running", () => {
    expect(stop(L, "Prep potatoes").state).toBe("done");
    expect(stop(L, "Roast chicken initial").state).toBe("running");
    const order = L.stops.map((q) => q.state);
    expect(order.indexOf("now")).toBeGreaterThan(order.lastIndexOf("done"));
  });

  it("draws only the breaks still to come", () => {
    expect(L.breaks.map((b) => b.minutes)).toEqual([50]);
  });

  it("on the last step: everything else done, nothing left to wait for", () => {
    const end = midCook(roast, "first", P + 16);
    expect(end.stops.filter((q) => q.state === "now").map((q) => q.label)).toEqual(["Carve and serve"]);
    expect(end.breaks).toEqual([]);
  });
});

describe("five dishes: the chicken pita wraps", () => {
  it("draws five columns in the order the drawing does, in both modes", () => {
    const names = ["Chicken", "Hummus", "Assembly", "Cabbage Slaw", "Cucumber Pickles"];
    expect(opening(pita, "first").columns.map((c) => c.name)).toEqual(names);
    expect(opening(pita, "go").columns.map((c) => c.name)).toEqual(names);
  });

  it("finds the hummus's ten blender jobs as one run, named by its first ('Blend tahini')", () => {
    const L = opening(pita, "first");
    const long = L.runs.find((r) => r.keys.length === 10)!;
    expect(L.stops.find((q) => q.key === long.keys[0])?.label).toBe("Blend tahini");
  });

  it("brings the slaw and the pickles into the last step", () => {
    const L = opening(pita, "first");
    const last = L.stops[L.stops.length - 1];
    expect(last.label).toBe("Assemble and serve");
    expect(last.joins.map((c) => L.columns[c].dish).sort()).toEqual(["Cabbage Slaw", "Chicken", "Cucumber Pickles"]);
  });
});

describe("a one-pan meal", () => {
  it("is one dish (the list form), the catch-all strand unnamed", () => {
    const L = opening(kitchenPlan("skillet-eggs-potatoes-greens"), "first");
    expect(L.oneDish).toBe(true);
    expect(L.columns).toEqual([{ dish: "Cook", name: null }]);
    expect(L.stops.every((q) => q.joins.length === 0 && q.also.length === 0)).toBe(true);
  });
  it("with no break at all draws no gap (the stir-fry)", () => {
    expect(opening(corpusPlan("weeknight-stir-fry"), "first").breaks).toEqual([]);
  });
});

describe("prep cards that span dishes split onto each dish's line", () => {
  it("every prep stop sits on the dish of every job it carries", () => {
    for (const name of ["sunday-roast-dinner", "crispy-skin-salmon", "lime-shrimp-tacos", "indian-dal-tadka"]) {
      const plan = corpusPlan(name);
      const byId = new Map(plan.tasks.map((t) => [t.label, t.branch]));
      for (const mode of ["first", "go"] as const) {
        const L = opening(plan, mode);
        for (const q of L.stops.filter((s) => s.prep)) {
          for (const part of q.label.toLowerCase().split(", ")) {
            const branch = byId.get(part);
            if (branch) expect(L.columns[q.col].dish).toBe(branch);
          }
        }
      }
    }
  });
});

describe("every stored plan fixture", () => {
  const all: [string, CookPlan][] = [
    ...loadCookPlanFixtures().flatMap((f): [string, CookPlan][] => {
      const raw = loadCookPlanSnapshots().get(f.name)?.raw;
      const p = raw ? parseCookPlan(raw, f.recipe) : null;
      return p && p.ok ? [[f.name, p.plan]] : [];
    }),
    ...loadKitchenPlans().map((k): [string, CookPlan] => [k.name, k.plan]),
  ];
  it("draws every step once, in cook order, with the last step taking every open line", () => {
    expect(all.length).toBeGreaterThan(15);
    for (const [, plan] of all) {
      for (const mode of ["first", "go"] as const) {
        const s = strip(plan, initialCookState(mode));
        const L = mealLines(plan, s, { opening: true });
        const marks = s.marks.filter((m) => m.key !== "prep").map((m) => m.key).sort();
        expect(L.stops.filter((q) => !q.prep).map((q) => q.key).sort()).toEqual(marks);
        for (let i = 1; i < L.stops.length; i++) expect(L.stops[i].start).toBeGreaterThanOrEqual(L.stops[i - 1].start);
        // Every column's line ends somewhere: in a join, a share, or as the last step's own.
        const last = L.stops[L.stops.length - 1];
        const ended = new Set([last.col, ...last.also, ...L.stops.flatMap((q) => q.joins)]);
        if (L.columns.length > 1) for (let c = 0; c < L.columns.length; c++) expect(ended.has(c) || L.stops.some((q) => q.also.includes(c))).toBe(true);
      }
    }
  });
});
