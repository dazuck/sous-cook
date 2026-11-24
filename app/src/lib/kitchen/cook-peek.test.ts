import { describe, expect, it } from "vitest";
import { peekOf, peekRows, peekWords, type PeekRow, type PeekScreen } from "./cook-peek";
import { initialCookState, next, prepPages, screensOf, type CookState } from "./cook-view";
import { identityPlan, parseCookPlan, type CookPlan } from "./cook-plan";
import { strip } from "./cook-strip";
import { layoutPeek } from "./peek-layout";
import { resolvePlan } from "./cook-session";
import { advanceMeasure } from "./__tests__/advance-measure";
import { packRecipeToQueueData } from "../pack-convert/to-queue";
import { fannie } from "../pack-convert/__tests__/fannie-native";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "./__tests__/load-cook-plan-fixtures";

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
  while (s.pos < pos) {
    const n = next(plan, s);
    if (n.pos === s.pos) throw new Error(`stuck at ${s.pos}`);
    s = n;
  }
  return s;
}

/** The rows as the cook reads them: one line each. */
const read = (rows: PeekRow[]) => rows.map((r) => peekWords(r).replace(/\u00a0/g, " "));

describe("the peek on the Sunday roast (Prep first), against the approved drawing", () => {
  const roast = corpusPlan("sunday-roast-dinner");
  const P = prepPages(roast, "first").length;
  const peek = (pos: number) => {
    const st = at(roast, "first", pos);
    return peekRows(peekOf(roast, st, strip(roast, st)));
  };

  it("has four prep pages before the oven goes on (the fixture this suite reads)", () => {
    expect(P).toBe(4);
  });

  it("on Coat potatoes: the step in hand, the roast, one ruled break row, then what comes after", () => {
    expect(read(peek(P + 6))).toEqual([
      "● Coat potatoes · Potatoes · 2 min",
      "○ Roast chicken and potatoes · Chicken",
      "then 50 min free while it roasts",
      "after that: Check chicken",
    ]);
  });

  it("counts a wait once: the roast that the 50-minute break covers shows no minutes of its own", () => {
    const roastRow = peek(P + 6).find((r) => r.kind === "step" && r.label === "Roast chicken and potatoes");
    expect(roastRow).toMatchObject({ kind: "step", minutes: null, pot: true });
  });

  it("marks the step in hand, and only it, as now", () => {
    const steps = peek(P + 6).filter((r): r is Extract<PeekRow, { kind: "step" }> => r.kind === "step");
    expect(steps.map((r) => r.now)).toEqual([true, false]);
  });

  it("with three steps to the break, shows them all and no 'after that'", () => {
    expect(read(peek(P + 4))).toEqual([
      "○ Heat duck fat · Potatoes · 5 min",
      "● Rough potatoes · Potatoes · 4 min",
      "● Coat potatoes · Potatoes · 2 min",
      "○ Roast chicken and potatoes · Chicken",
      "then 50 min free while it roasts",
    ]);
  });

  it("with more than three steps to the next break or the table, shows two and says how many more", () => {
    // Check chicken opens the last stretch: eight steps follow it to the table.
    const rows = peek(P + 8);
    expect(read(rows)).toEqual([
      "● Check chicken · Chicken · 2 min",
      "○ Rest chicken · Chicken · 15 min",
      "● Skim fat · Gravy · 3 min",
      "6 more steps, then on the table in about 30 min",
    ]);
  });

  it("on the last step: the step, then the table", () => {
    const last = roast.tasks.length ? peek(P + 16) : [];
    expect(read(last)).toEqual(["● Carve and serve · Chicken · 10 min", "then on the table in about 10 min"]);
  });

  it("on the first prep page runs through prep into cooking with no break between them", () => {
    const rows = peek(0);
    const brk = rows.find((r) => r.kind === "break");
    expect(brk).toMatchObject({ kind: "break", minutes: 10, more: 2 });
    expect(rows.filter((r) => r.kind === "step")).toHaveLength(3);
  });

  it("never lists a step twice and never lists a step already behind the cook", () => {
    for (let pos = 0; pos <= P + 16; pos++) {
      const st = at(roast, "first", pos);
      const input = peekOf(roast, st, strip(roast, st));
      const keys = peekRows(input).flatMap((r) => (r.kind === "step" || r.kind === "after" ? [r.key] : []));
      expect(new Set(keys).size, `at ${pos}: no step twice`).toBe(keys.length);
      // Behind the cook is every screen before the one in hand: none of them is listed, and the
      // list starts at the step in hand, then runs on in the screens' order.
      const index = keys.map((k) => input.screens.findIndex((s) => s.key === k));
      expect(index[0], `at ${pos}: the list starts at the step in hand`).toBe(input.at);
      for (const i of index) expect(i, `at ${pos}: ${input.screens[i]?.key} is not behind the cook`).toBeGreaterThanOrEqual(input.at);
      expect(index, `at ${pos}: in order`).toEqual([...index].sort((a, b) => a - b));
    }
  });
});

describe("the dish column", () => {
  it("one-dish plans name no dish", () => {
    const plan = corpusPlan("weeknight-shakshuka");
    const st = at(plan, "first", prepPages(plan, "first").length + 1);
    const rows = peekRows(peekOf(plan, st, strip(plan, st)));
    for (const r of rows) if (r.kind === "step") expect(r.dish).toBeNull();
  });

  it("the plan's catch-all strand is never named as a dish", () => {
    const plan = corpusPlan("indian-dal-tadka");
    const st = at(plan, "first", prepPages(plan, "first").length);
    const rows = peekRows(peekOf(plan, st, strip(plan, st)));
    const dishes = rows.flatMap((r) => (r.kind === "step" ? [r.dish] : []));
    expect(dishes).not.toContain("Cook");
    expect(dishes).toContain(null);
  });
});

describe("as written (no minutes): rows with no minutes and no breaks", () => {
  it("lists the next steps and ends at the table with no time", () => {
    const plan = identityPlan({ steps: ["Chop the onion.", "Fry it.", "Add the rice.", "Serve."] });
    const st = at(plan, "go", 1);
    const rows = peekRows(peekOf(plan, st, strip(plan, st)));
    for (const r of rows) {
      if (r.kind === "step") expect(r.minutes).toBeNull();
      expect(r.kind).not.toBe("break");
    }
    expect(read(rows).at(-1)).toBe("then on the table");
  });
});

describe("as written, the peek's rows are the steps' own words (Gemini's read of v1.62: three-word fragments)", () => {
  /** Each step row's words against the step's text, and the drawn lines a cut of them at most. */
  function checkWhole(plan: CookPlan, mode: "first" | "go", pos: number) {
    const st = at(plan, mode, pos);
    const input = peekOf(plan, st, strip(plan, st));
    const want = plan.tasks.map((t) => t.text);
    const steps = peekRows(input).filter((r): r is Extract<PeekRow, { kind: "step" }> => r.kind === "step");
    expect(steps.length, "rows to read").toBeGreaterThan(1);
    for (const r of steps) {
      expect(want, `${r.key}: "${r.label}" is a step's whole text`).toContain(r.label);
    }
    // Drawn on the wide tablet, a long step wraps to two lines and is cut there, never reworded.
    const d = layoutPeek(input, { W: 1280, c: 1280 / 960, E: 44 * (1280 / 960), narrow: false, maxH: 2000 }, advanceMeasure);
    for (const row of d.rows) {
      if (row.kind !== "step") continue;
      const label = steps.find((r) => r.key === row.key)!.label;
      expect(row.lines.length).toBeLessThanOrEqual(2);
      const drawn = row.lines.join(" ");
      if (drawn !== label) {
        expect(drawn.endsWith("…"), `${row.key} cut with an ellipsis`).toBe(true);
        expect(label.startsWith(drawn.slice(0, -1).trimEnd()), `${row.key} cut, not reworded`).toBe(true);
      }
    }
    return steps;
  }

  it("a pack recipe (Fannie Farmer's Parker House rolls) cooked as written", () => {
    const recipe = fannie().recipes.find((r) => r.id === "parker-house-rolls")!;
    const projected = packRecipeToQueueData(recipe, fannie().id);
    if (!projected.ok) throw new Error("the rolls don't project");
    const plan = identityPlan(projected.projection.recipeData);
    const rows = checkWhole(plan, "go", 1);
    expect(rows[0].label).toBe(recipe.steps[1].text);
  });

  it("a recipe whose plan failed to derive (resolvePlan's as-written fallback)", () => {
    const fixture = loadCookPlanFixtures().find((f) => f.name === "sunday-roast-dinner")!;
    const { plan, source } = resolvePlan(fixture.recipe, { not: "a plan" }, "failed");
    expect(source).toEqual({ kind: "as-written", reason: "failed" });
    const rows = checkWhole(plan, "go", 2);
    expect(rows[0].label).toBe(fixture.recipe.steps![2]);
  });
});

describe("peekRows on hand-made screens: the edges", () => {
  const s = (key: string, start: number, end: number, stretch: number | null, pot = false, dish: string | null = null): PeekScreen => ({
    key,
    label: key,
    dish,
    start,
    end,
    pot,
    stretch,
  });

  it("a lower limit folds sooner: the peek laid again when it is too tall for its screen", () => {
    const run = Array.from({ length: 5 }, (_, i) => s(`s${i}`, i, i + 1, 0));
    const input = { screens: run, at: 0, frees: [], toTable: 5, asWritten: false };
    expect(read(peekRows(input, 1))).toEqual(["● s0 · 1 min", "4 more steps, then on the table in about 5 min"]);
    expect(read(peekRows(input, 0))).toEqual(["● s0 · 1 min", "4 more steps, then on the table in about 5 min"]);
  });

  it("folded all the way (limit 0), the peek is the step in hand and its ruled row: no 'after that'", () => {
    const screens = [s("Sear", 0, 2, 0), s("Into the oven", 2, 40, 0, true), s("Check it", 40, 42, 1)];
    const input = { screens, at: 0, frees: [{ stretch: 0, from: 4, to: 40, minutes: 35 }], toTable: 42, asWritten: false };
    expect(read(peekRows(input, 1))).toEqual(["● Sear · 2 min", "○ Into the oven", "then 35 min free while it cooks", "after that: Check it"]);
    expect(read(peekRows(input, 0))).toEqual(["● Sear · 2 min", "1 more step, then 35 min free while it cooks"]);
  });

  it("an empty plan has no rows", () => {
    expect(peekRows({ screens: [], at: 0, frees: [], toTable: null, asWritten: false })).toEqual([]);
  });

  it("names the break by the pot going in as hands come free, and says 'cooks' when its verb is unknown", () => {
    const screens = [s("Stir sauce", 0, 2, 0), s("Leave the stock", 2, 40, 0, true), s("Taste", 40, 42, 1)];
    const rows = peekRows({ screens, at: 0, frees: [{ stretch: 0, from: 2, to: 40, minutes: 35 }], toTable: 42, asWritten: false });
    expect(read(rows)).toContain("then 35 min free while it cooks");
  });

  it("a break with nothing cooking through it says no 'while'", () => {
    const screens = [s("Shape dough", 0, 5, 0), s("Bake", 30, 50, 1)];
    const rows = peekRows({ screens, at: 0, frees: [{ stretch: 0, from: 5, to: 30, minutes: 25 }], toTable: 50, asWritten: false });
    expect(read(rows)).toContain("then 25 min free");
  });

  it("folds only past three steps, and counts exactly what it folds", () => {
    const run = (n: number) => Array.from({ length: n }, (_, i) => s(`s${i}`, i, i + 1, 0));
    // The step in hand and three more: all shown.
    expect(read(peekRows({ screens: run(4), at: 0, frees: [], toTable: 4, asWritten: false }))).toHaveLength(5);
    // Four more: two shown, two folded.
    const four = read(peekRows({ screens: run(5), at: 0, frees: [], toTable: 5, asWritten: false }));
    expect(four).toHaveLength(4);
    expect(four.at(-1)).toBe("2 more steps, then on the table in about 5 min");
    // Six more: two shown, four folded.
    expect(read(peekRows({ screens: run(7), at: 0, frees: [], toTable: 7, asWritten: false })).at(-1)).toBe(
      "4 more steps, then on the table in about 10 min",
    );
  });

  it("an 'after that' row appears only when at most one step stands before the break", () => {
    const screens = [s("a", 0, 1, 0), s("b", 1, 2, 0), s("c", 30, 31, 1)];
    const free = [{ stretch: 0, from: 2, to: 30, minutes: 25 }];
    expect(read(peekRows({ screens, at: 1, frees: free, toTable: 31, asWritten: false })).at(-1)).toBe("after that: c");
    expect(read(peekRows({ screens, at: 0, frees: free, toTable: 31, asWritten: false })).at(-1)).toBe("after that: c");
    const more = [s("a", 0, 1, 0), s("b", 1, 2, 0), s("b2", 2, 3, 0), s("c", 30, 31, 1)];
    expect(read(peekRows({ screens: more, at: 0, frees: free, toTable: 31, asWritten: false })).some((w) => w.startsWith("after that"))).toBe(false);
  });

  it("the table in under a minute still says a minute, never 0", () => {
    const rows = peekRows({ screens: [s("Serve", 0, 1, 0)], at: 0, frees: [], toTable: 0.2, asWritten: false });
    expect(read(rows).at(-1)).toBe("then on the table in about 5 min");
    // At the cook's end, or past it, the same: never "Ready" in the middle of a sentence.
    for (const toTable of [0, -1]) {
      expect(read(peekRows({ screens: [s("Serve", 0, 1, 0)], at: 0, frees: [], toTable, asWritten: false })).at(-1)).toBe(
        "then on the table in about 5 min",
      );
    }
  });

  it("a Prep screen with nothing on it shows no minutes, never a made-up minute", () => {
    // As I go with all the mise in the steps: the Prep screen says there is nothing to do before
    // you start, and the peek must not say "Prep · 1 min" over it.
    const cookies = corpusPlan("chewy-oat-cookies");
    const st = initialCookState("go");
    const first = peekRows(peekOf(cookies, st, strip(cookies, st)))[0];
    expect(first).toMatchObject({ kind: "step", key: "prep", now: true, minutes: null });
    expect(read([first])).toEqual(["● Prep"]);
    // A step of real minutes keeps them, however short.
    expect(peekRows({ screens: [s("Stir", 0, 0.4, 0)], at: 0, frees: [], toTable: 1, asWritten: false })[0]).toMatchObject({ minutes: 1 });
  });
});

// Leaving Prep in As I go ticks the mise done before cooking, and the steps recut (the prep folds
// into them). The strip reads Prep as the cook will stand on leaving (`rowState`), so the peek must
// count its screens the same way, or on Prep its rows stand one step out from the marks they read.
describe("on As I go's Prep screen, the peek counts the screens the strip counts", () => {
  const plans = loadCookPlanFixtures()
    .map((f) => ({ name: f.name, plan: corpusPlan(f.name) }))
    .filter(({ plan }) => screensOf(plan, "go", initialCookState("go").ticked)[0]?.kind === "prep");

  it("has stored plans with a Prep screen in As I go (the fixtures this reads)", () => {
    expect(plans.length).toBeGreaterThan(2);
  });

  for (const { name, plan } of plans) {
    it(`${name}: every step mark stands on the peek's screen of the same key, and Next lands on the peek's next row`, () => {
      const st = initialCookState("go");
      const s = strip(plan, st);
      const input = peekOf(plan, st, s);
      expect(input.screens[input.at]?.key).toBe("prep");
      for (const m of s.marks) if (m.key !== "prep") expect(input.screens[m.screen]?.key, `${m.key} at screen ${m.screen}`).toBe(m.key);
      // The peek's first row after Prep is the step the cook lands on.
      const rows = peekRows(input).filter((r) => r.kind === "step");
      const landed = next(plan, st);
      const there = peekOf(plan, landed, strip(plan, landed));
      expect(there.screens[there.at]?.key).toBe(rows[1]?.kind === "step" ? rows[1].key : undefined);
    });
  }
});
