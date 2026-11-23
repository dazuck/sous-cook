import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { legacyToPackRecipe } from "../convert";
import {
  compareRecipe,
  isAccepted,
  legacyOf,
  loadGoldenFiles,
  notationDifferences,
  type Disagreement,
  type GoldenFile,
  type GoldenRecipe,
} from "../golden";

// Slice B4 step 3/4, "zero wrong numbers": every golden file in `golden/`
// is converted and checked against values written from the source text by
// someone who never ran the converter. Any wrong number fails; a line kept as
// written where the writer saw a number fails unless it is listed in the
// file's `accepted` with its reason. The hand-built set proves the harness.

const GOLDEN_DIR = join(__dirname, "golden");

/** Written spelling → the reader's unit id the hint shows. */
const NOTATION = ["cups → cup"];

function convert(golden: GoldenRecipe) {
  const result = legacyToPackRecipe(legacyOf(golden), {
    id: golden.id,
    servesEstimate: golden.servesEstimate,
  });
  if (!result.ok) throw new Error(`${golden.id}: ${JSON.stringify(result.issues)}`);
  return result;
}

/** The disagreements a file fails on: wrong numbers, unaccepted reviewable ones, stale accepts. */
function failuresOf(file: GoldenFile): string[] {
  const failures: string[] = [];
  const found: Disagreement[] = [];
  for (const golden of file.recipes) {
    for (const d of compareRecipe(golden, convert(golden).recipe)) {
      found.push(d);
      if (isAccepted(file.accepted, d)) continue;
      failures.push(`${d.kind} ${d.recipe} ${d.where}: expected ${d.expected}, shows ${d.actual}`);
    }
  }
  for (const a of file.accepted) {
    if (!found.some((d) => isAccepted([a], d))) {
      failures.push(`accepted but no ${a.kind} disagreement there: ${a.recipe} ${a.where}`);
    }
  }
  return failures;
}

const files = loadGoldenFiles(GOLDEN_DIR);

describe("golden set: zero wrong numbers", () => {
  it("has the hand-built set", () => {
    expect(files.map((f) => f.name)).toEqual(["hand-built.json"]);
  });

  it.each(files.map((f) => [f.name, f.file] as const))("%s", (_name, file) => {
    expect(failuresOf(file)).toEqual([]);
  });

  it("the hand-built set covers every source line and step, and shows its as-written count", () => {
    const hand = files.find((f) => f.name === "hand-built.json")!.file;
    let lines = 0;
    let asWritten = 0;
    let steps = 0;
    let timers = 0;
    for (const golden of hand.recipes) {
      const { recipe, report } = convert(golden);
      lines += recipe.ingredients.length;
      asWritten += report.counts.as_written;
      steps += recipe.steps.length;
      timers += recipe.steps.filter((s) => s.timer_sec !== null).length;
    }
    expect(hand.recipes).toHaveLength(17);
    expect({ lines, steps, timers, asWritten }).toEqual({
      lines: 181,
      steps: 127,
      timers: 43,
      asWritten: 5,
    });
  });

  it("lists the hand-built set's notation differences once (not wrong numbers)", () => {
    const hand = files.find((f) => f.name === "hand-built.json")!.file;
    const pairs = hand.recipes.map((golden) => ({ golden, recipe: convert(golden).recipe }));
    expect(notationDifferences(pairs)).toEqual(NOTATION);
  });
});

// The harness has to fail on a wrong number, or its green means nothing. Each
// case takes a real hand-built recipe and changes one expected value.
describe("the harness catches a wrong number", () => {
  const hand = files.find((f) => f.name === "hand-built.json")!.file;
  const byId = (id: string) => structuredClone(hand.recipes.find((r) => r.id === id)!);

  /** Its disagreements, less the class ones the hand-built file accepts. */
  function disagreementsFor(golden: GoldenRecipe): Disagreement[] {
    return compareRecipe(golden, convert(golden).recipe).filter(
      (d) => d.kind !== "class" || !isAccepted(hand.accepted, d),
    );
  }

  it("starts from recipes that agree", () => {
    for (const id of ["baking-chocolate-cake", "sunday-roast-dinner", "zucchini-wraps"]) {
      expect(disagreementsFor(byId(id))).toEqual([]);
    }
  });

  it("an amount off", () => {
    const golden = byId("baking-chocolate-cake");
    golden.expected.ingredients[2] = { amount: 0.5, unit: "cup" };
    expect(disagreementsFor(golden)).toEqual([
      {
        recipe: "baking-chocolate-cake",
        where: "ingredients.2",
        kind: "wrong-number",
        expected: "0.5 cup",
        actual: "0.75 cup",
      },
    ]);
  });

  it("the right amount in the wrong unit", () => {
    const golden = byId("baking-chocolate-cake");
    golden.expected.ingredients[3] = { amount: 2, unit: "tbsp" };
    expect(disagreementsFor(golden).map((d) => [d.where, d.kind])).toEqual([
      ["ingredients.3", "wrong-number"],
    ]);
  });

  it("a unit spelled another way is not a wrong number", () => {
    const golden = byId("baking-chocolate-cake");
    golden.expected.ingredients[3] = { amount: 2, unit: "teaspoons" };
    expect(disagreementsFor(golden)).toEqual([]);
  });

  it("a compound showing its other stated value", () => {
    const golden = byId("sunday-roast-dinner");
    golden.expected.ingredients[9] = { amount: 300, unit: "g" };
    expect(disagreementsFor(golden).map((d) => [d.where, d.kind, d.actual])).toEqual([
      ["ingredients.9", "wrong-number", "10 oz"],
    ]);
  });

  it("a count off", () => {
    const golden = byId("baking-chocolate-cake");
    golden.expected.ingredients[5] = { count: 3 };
    expect(disagreementsFor(golden).map((d) => [d.where, d.kind])).toEqual([
      ["ingredients.5", "wrong-number"],
    ]);
  });

  it("a number shown where the source states none", () => {
    const golden = byId("baking-chocolate-cake");
    golden.expected.ingredients[0] = "unstated";
    expect(disagreementsFor(golden).map((d) => [d.where, d.kind])).toEqual([
      ["ingredients.0", "wrong-number"],
    ]);
  });

  it("a timer off, and a timer where none is stated", () => {
    const cake = byId("baking-chocolate-cake");
    cake.expected.steps[5] = { timer_sec: 1500 };
    expect(disagreementsFor(cake).map((d) => [d.where, d.kind, d.actual])).toEqual([
      ["steps.5", "wrong-number", "timer 1800"],
    ]);
    const roast = byId("sunday-roast-dinner");
    roast.expected.steps[1] = { timer_sec: null };
    expect(disagreementsFor(roast).map((d) => [d.where, d.kind, d.actual])).toEqual([
      ["steps.1", "wrong-number", "timer 3600"],
    ]);
  });

  // A stored step's text sometimes loses the duration its source states (a
  // phase heading's "(30 sec)"): no timer is shown, so no wrong number, but
  // each one is reviewed.
  it("a missing timer is a class disagreement, failing until it is accepted", () => {
    const file = structuredClone(hand);
    const cake = file.recipes.find((r) => r.id === "baking-chocolate-cake")!;
    cake.expected.steps[0] = { timer_sec: 60 };
    expect(failuresOf(file)).toEqual([
      "class baking-chocolate-cake steps.0: expected timer 60, shows timer null",
    ]);
    file.accepted.push({ recipe: "baking-chocolate-cake", where: "steps.0", kind: "class", reason: "test" });
    expect(failuresOf(file)).toEqual([]);
  });

  it("a serving count off", () => {
    const golden = byId("zucchini-wraps");
    golden.expected.serves += 1;
    expect(disagreementsFor(golden).map((d) => [d.where, d.kind])).toEqual([
      ["serves", "wrong-number"],
    ]);
  });

  it("Sous's estimate shown as the source's count, and the reverse", () => {
    const estimated = byId("zucchini-wraps");
    estimated.expected.servesEstimated = false;
    expect(disagreementsFor(estimated).map((d) => [d.where, d.kind, d.expected, d.actual])).toEqual([
      ["serves", "wrong-number", "stated", "Sous's estimate"],
    ]);
  });

  /**
   * The recipe with a blank stored line and a blank step at index 1 (fix
   * round 2: the converter skips them), the expected values and the plan's
   * indices moved to match.
   */
  function withBlanksAt1(id: string): GoldenRecipe {
    const golden = byId(id);
    const r = golden.recipe;
    r.ingredients!.splice(1, 0, { item: "  ", amount: "", unit: "" });
    r.steps!.splice(1, 0, " ");
    if (r.stepIngredients) {
      r.stepIngredients = r.stepIngredients.map((refs) => refs.map((i) => (i >= 1 ? i + 1 : i)));
      r.stepIngredients.splice(1, 0, []);
    }
    golden.expected.ingredients.splice(1, 0, "blank");
    golden.expected.steps.splice(1, 0, { timer_sec: null });
    return golden;
  }

  it("a blank stored line and step compare by stored index, every line after them included", () => {
    for (const id of ["baking-chocolate-cake", "sunday-roast-dinner"]) {
      expect(disagreementsFor(withBlanksAt1(id))).toEqual([]);
    }
  });

  it("a line expected blank that shows a row, and a line expected that shows none", () => {
    const golden = withBlanksAt1("baking-chocolate-cake");
    golden.expected.ingredients[1] = { amount: 1, unit: "cup" };
    golden.expected.ingredients[2] = "blank";
    expect(disagreementsFor(golden)).toEqual([
      {
        recipe: "baking-chocolate-cake",
        where: "ingredients.1",
        kind: "wrong-number",
        expected: "1 cup",
        actual: "missing",
      },
      {
        recipe: "baking-chocolate-cake",
        where: "ingredients.2",
        kind: "wrong-number",
        expected: "blank",
        actual: "2 cup",
      },
    ]);
  });

  it("a number kept as written fails until it is accepted, and a stale accept fails", () => {
    const file = structuredClone(hand);
    const wraps = file.recipes.find((r) => r.id === "zucchini-wraps")!;
    wraps.expected.ingredients[3] = { amount: 1, unit: "pinch" };
    expect(failuresOf(file)).toEqual([
      "class zucchini-wraps ingredients.3: expected 1 pinch, shows as written",
    ]);

    file.accepted.push({ recipe: "zucchini-wraps", where: "ingredients.3", kind: "class", reason: "test" });
    expect(failuresOf(file)).toEqual([]);

    file.accepted.push({ recipe: "zucchini-wraps", where: "ingredients.4", kind: "class", reason: "test" });
    expect(failuresOf(file)).toEqual([
      "accepted but no class disagreement there: zucchini-wraps ingredients.4",
    ]);
  });
});

// Expected values can read each line in full: its class, whether it scales,
// and every number it states, per system. Each number the
// converter shows must be one the line states; fewer numbers, another class
// label, or not scaling are reviewed (class); scaling a line the reader keeps
// fixed is reviewed too (scales), since at 2× it would show a number the
// source never wrote.
describe("a line read in full: class, scales and every hint", () => {
  const hand = files.find((f) => f.name === "hand-built.json")!.file;
  const byId = (id: string) => structuredClone(hand.recipes.find((r) => r.id === id)!);
  const cup = (amount: number) => ({ amount, unit: "cups" });

  function kindsFor(golden: GoldenRecipe): [string, string][] {
    return compareRecipe(golden, convert(golden).recipe)
      .filter((d) => !isAccepted(hand.accepted, d))
      .map((d) => [d.where, d.kind]);
  }

  it("agrees when the class, the scaling and every stated number match", () => {
    const cake = byId("baking-chocolate-cake");
    cake.expected.ingredients[2] = { class: "measured", scales: true, hints: { imperial: cup(0.75) } };
    cake.expected.ingredients[5] = { class: "count", scales: true, count: 2 };
    expect(kindsFor(cake)).toEqual([]);

    const roast = byId("sunday-roast-dinner");
    roast.expected.ingredients[9] = {
      class: "compound",
      scales: true,
      hints: { imperial: { amount: 10, unit: "ounces" }, metric: { amount: 300, unit: "grams" } },
    };
    roast.expected.ingredients[15] = { class: "unstated", scales: false };
    // A line kept as written shows its own text, so every number it states.
    roast.expected.ingredients[0] = { class: "as_written", scales: false, count: 1 };
    expect(compareRecipe(roast, convert(roast).recipe)).toEqual([]);

    const wraps = byId("zucchini-wraps");
    wraps.expected.ingredients[3] = { class: "as_written", scales: false };
    expect(kindsFor(wraps)).toEqual([]);
  });

  it("a stated number off, or a count off, is a wrong number", () => {
    const roast = byId("sunday-roast-dinner");
    roast.expected.ingredients[9] = {
      class: "compound",
      scales: true,
      hints: { imperial: { amount: 10, unit: "oz" }, metric: { amount: 280, unit: "g" } },
    };
    roast.expected.ingredients[2] = { class: "count", scales: true, count: 2 };
    expect(compareRecipe(roast, convert(roast).recipe).filter((d) => d.where !== "ingredients.0")).toEqual([
      {
        recipe: "sunday-roast-dinner",
        where: "ingredients.2",
        kind: "wrong-number",
        expected: "count 2, scales",
        actual: "count 1, scales",
      },
      {
        recipe: "sunday-roast-dinner",
        where: "ingredients.9",
        kind: "wrong-number",
        expected: "compound 10 oz + 280 g, scales",
        actual: "compound 10 oz + 300 g, scales",
      },
    ]);
  });

  it("a number shown in a system the line doesn't state is a wrong number", () => {
    const roast = byId("sunday-roast-dinner");
    roast.expected.ingredients[9] = {
      class: "measured",
      scales: true,
      hints: { imperial: { amount: 10, unit: "oz" } },
    };
    expect(kindsFor(roast)).toEqual([["ingredients.9", "wrong-number"]]);
  });

  it("any number shown where the line states no single amount is a wrong number", () => {
    // "1 tbsp + 1 tsp": a sum, which no hint holds.
    const cake = byId("baking-chocolate-cake");
    cake.expected.ingredients[2] = { class: "measured", scales: true };
    cake.expected.ingredients[5] = { class: "as_written", scales: false };
    expect(kindsFor(cake)).toEqual([
      ["ingredients.2", "wrong-number"],
      ["ingredients.5", "wrong-number"],
    ]);
  });

  it("fewer numbers, another class label, or not scaling is a class disagreement", () => {
    const cake = byId("baking-chocolate-cake");
    cake.expected.ingredients[2] = {
      class: "compound",
      scales: true,
      hints: { imperial: cup(0.75), metric: { amount: 75, unit: "g" } },
    };
    const roast = byId("sunday-roast-dinner");
    roast.expected.ingredients[0] = { class: "count", scales: true, count: 1 };
    roast.expected.ingredients[9] = {
      class: "measured",
      scales: true,
      hints: { imperial: { amount: 10, unit: "oz" }, metric: { amount: 300, unit: "g" } },
    };
    expect(kindsFor(cake)).toEqual([["ingredients.2", "class"]]);
    expect(compareRecipe(roast, convert(roast).recipe).map((d) => [d.where, d.kind])).toEqual([
      ["ingredients.0", "class"],
      ["ingredients.9", "class"],
    ]);
  });

  it("scaling a line the source keeps fixed fails until it is accepted", () => {
    const file = structuredClone(hand);
    const cake = file.recipes.find((r) => r.id === "baking-chocolate-cake")!;
    cake.expected.ingredients[2] = { class: "as_written", scales: false, hints: { imperial: cup(0.75) } };
    expect(failuresOf(file)).toEqual([
      "scales baking-chocolate-cake ingredients.2: expected as_written 0.75 cup, fixed, shows measured 0.75 cup, scales",
    ]);
    file.accepted.push({ recipe: "baking-chocolate-cake", where: "ingredients.2", kind: "scales", reason: "test" });
    expect(failuresOf(file)).toEqual([]);
  });

  // B4 verify LOW 1: an accept matched the line alone, so a line accepted as
  // a class disagreement passed when it began to scale, unreviewed.
  it("an accept passes only the kind it reviewed", () => {
    const file = structuredClone(hand);
    const cake = file.recipes.find((r) => r.id === "baking-chocolate-cake")!;
    cake.expected.ingredients[2] = { class: "as_written", scales: false, hints: { imperial: cup(0.75) } };
    file.accepted.push({ recipe: "baking-chocolate-cake", where: "ingredients.2", kind: "class", reason: "test" });
    expect(failuresOf(file)).toEqual([
      "scales baking-chocolate-cake ingredients.2: expected as_written 0.75 cup, fixed, shows measured 0.75 cup, scales",
      "accepted but no class disagreement there: baking-chocolate-cake ingredients.2",
    ]);
  });
});

describe("loading a golden file", () => {
  const dir = mkdtempSync(join(tmpdir(), "b4-golden-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const one = {
    source: "test",
    seed: null,
    expectedBy: "test",
    recipes: [
      {
        id: "r",
        recipe: {
          name: "R",
          ingredients: [{ item: "flour", amount: "1", unit: "cup" }],
          steps: ["Mix."],
        },
        servesEstimate: { count: 2, basis: "1 cup flour: 2." },
        expected: {
          serves: 2,
          servesEstimated: true,
          ingredients: [{ amount: 1, unit: "cup" }],
          steps: [{ timer_sec: null }],
        },
      },
    ],
    accepted: [],
  };

  it("refuses expected values that do not line up with the recipe", () => {
    const bad = structuredClone(one);
    bad.recipes[0]!.expected.steps = [];
    writeFileSync(join(dir, "bad.json"), JSON.stringify(bad));
    expect(() => loadGoldenFiles(dir)).toThrow(
      /expected has 1 lines and 0 steps, the recipe 1 and 1/,
    );
    rmSync(join(dir, "bad.json"));
  });

  it("refuses an expected line it cannot read", () => {
    const bad = structuredClone(one) as { recipes: { expected: { ingredients: unknown[] } }[] };
    bad.recipes[0]!.expected.ingredients = [{ amount: "1", unit: "cup" }];
    writeFileSync(join(dir, "bad.json"), JSON.stringify(bad));
    expect(() => loadGoldenFiles(dir)).toThrow();
    rmSync(join(dir, "bad.json"));
  });

  it("reads a good one", () => {
    writeFileSync(join(dir, "good.json"), JSON.stringify(one));
    expect(loadGoldenFiles(dir).map((f) => f.name)).toEqual(["good.json"]);
  });

  it("never accepts the low end alone when a ranged pack ingredient meets a single-number expectation", () => {
    const golden = structuredClone(one.recipes[0]!);
    const rangedPackRecipe = {
      id: "r",
      title: "R",
      serves_base: 2,
      serves_estimated: true as const,
      ingredients: [
        {
          id: "ing-0",
          name: "flour",
          qty_canonical: { volume_ml: 236.588, range_max: 473.176 },
          display_equivalents: { imperial: { unit: "cup", amount: 1, amount_max: 2 } },
        },
      ],
      steps: [{ id: "step-0", type: "action" as const, text: "Mix.", timer_sec: null }],
    };
    expect(compareRecipe(golden, rangedPackRecipe)).toEqual([
      {
        recipe: "r",
        where: "ingredients.0",
        kind: "wrong-number",
        expected: "1 cup",
        actual: "1–2 cup",
      },
    ]);
  });
});

