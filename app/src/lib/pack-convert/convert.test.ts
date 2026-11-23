import { describe, expect, it } from "vitest";
import type { AsWrittenReason } from "@sous/pack/quantity";
import type { ChatRecipeIngredient } from "../../../drizzle/schema";
import {
  NO_SERVES_ISSUE,
  ingredientAt,
  legacyToPackRecipe,
  readLegacyRecipe,
  stepAt,
  storedEstimate,
  type LegacyRecipe,
} from "./convert";

// Slice B4 step 3: a legacy recipe (doc_recipes row or kitchen_queue
// recipe_data) read into a Pack Format v0.5 recipe. One block per line class
// and per row of B4's failure table.

function legacy(over: Partial<LegacyRecipe> = {}): LegacyRecipe {
  return {
    name: "Dal",
    ingredients: [{ item: "red lentils", amount: "1", unit: "cup" }],
    steps: ["Rinse the lentils."],
    serves: 4,
    ...over,
  };
}

function convertOk(input: LegacyRecipe, id = "dal") {
  const result = legacyToPackRecipe(input, { id });
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result.issues)}`);
  return result;
}

function oneLine(line: ChatRecipeIngredient) {
  const { recipe, report } = convertOk(legacy({ ingredients: [line] }));
  return { ingredient: recipe.ingredients[0]!, line: report.lines[0]! };
}

describe("ingredient lines, one class each", () => {
  it("measured: canonical in the base unit, one hint in the source's unit and number", () => {
    const { ingredient, line } = oneLine({ item: "olive oil", amount: "2", unit: "tablespoons" });
    expect(ingredient).toEqual({
      id: "ing-0",
      name: "olive oil",
      qty_canonical: { volume_ml: 2 * 14.787 },
      display_equivalents: { imperial: { unit: "tbsp", amount: 2 } },
    });
    expect(line.kind).toBe("measured");
  });

  it.each([
    ["1 1/2", "cups", "volume_ml", 1.5 * 236.588, "imperial", "cup", 1.5],
    ["½", "tsp", "volume_ml", 0.5 * 4.929, "imperial", "tsp", 0.5],
    ["1½", "lb", "mass_g", 1.5 * 453.592, "imperial", "lb", 1.5],
    ["0.75", "cup", "volume_ml", 0.75 * 236.588, "imperial", "cup", 0.75],
    ["400", "g", "mass_g", 400, "metric", "g", 400],
    ["1.2", "kg", "mass_g", 1200, "metric", "kg", 1.2],
    ["250", "ml", "volume_ml", 250, "metric", "ml", 250],
  ])("measured %s %s", (amount, unit, key, canonical, system, hintUnit, hintAmount) => {
    const { ingredient } = oneLine({ item: "x", amount, unit });
    expect(Object.keys(ingredient.qty_canonical)).toEqual([key]);
    expect((ingredient.qty_canonical as Record<string, number>)[key]).toBeCloseTo(canonical, 9);
    expect(ingredient.display_equivalents).toEqual({
      [system]: { unit: hintUnit, amount: hintAmount },
    });
  });

  it("compound across dimensions: both canonicals from the stated values, both hints", () => {
    const { ingredient, line } = oneLine({ item: "sugar", amount: "1", unit: "cup (225 g)" });
    expect(ingredient.qty_canonical).toEqual({ volume_ml: 236.588, mass_g: 225 });
    expect(ingredient.display_equivalents).toEqual({
      imperial: { unit: "cup", amount: 1 },
      metric: { unit: "g", amount: 225 },
    });
    expect(line.kind).toBe("compound");
  });

  it("compound in one dimension: canonical from the head, the other system's stated number kept", () => {
    const { ingredient } = oneLine({ item: "beef chuck", amount: "1.2", unit: "kg (2 1/2 lb)" });
    expect(ingredient.qty_canonical).toEqual({ mass_g: 1200 });
    expect(ingredient.display_equivalents).toEqual({
      metric: { unit: "kg", amount: 1.2 },
      imperial: { unit: "lb", amount: 2.5 },
    });
  });

  it("count, bare: the item stays the name", () => {
    const { ingredient, line } = oneLine({ item: "eggs", amount: "2" });
    expect(ingredient).toEqual({ id: "ing-0", name: "eggs", qty_canonical: { count: 2 } });
    expect(line.kind).toBe("count");
  });

  it("count with a count noun: the noun unfolds to count_unit (P26, B5c-6)", () => {
    expect(oneLine({ item: "garlic", amount: "3", unit: "cloves" }).ingredient).toEqual({
      id: "ing-0",
      name: "garlic",
      qty_canonical: { count: 3, count_unit: { one: "clove", other: "cloves" } },
    });
    expect(
      oneLine({ item: "crushed tomatoes", amount: "1", unit: "can (14 oz)" }).ingredient,
    ).toEqual({
      id: "ing-0",
      name: "crushed tomatoes",
      qty_canonical: { count: 1, count_unit: { one: "can (14 oz)", other: "cans (14 oz)" } },
    });
  });
});

describe("the failure table, one row each", () => {
  it.each([
    ["a pinch of", undefined, "a pinch of", "amount-not-a-number"],
    ["3-2", "tbsp", "3-2 tbsp", "amount-not-a-number"],
    ["about 1", "cup", "about 1 cup", "amount-not-a-number"],
  ])("a phrase, invalid range or 'about' (%s) is as written, never a number", (amount, unit, text, reason) => {
    const { ingredient, line } = oneLine({ item: "cumin", amount, unit });
    expect(ingredient).toEqual({ id: "ing-0", name: "cumin", qty_canonical: { as_written: text } });
    expect(ingredient.display_equivalents).toBeUndefined();
    expect(line).toMatchObject({ kind: "as_written", reason });
  });

  it.each([["qt"], ["pt"], ["fl oz"], ["stick"]])(
    "a unit outside the table (%s) is as written, and the report lists the spelling",
    (unit) => {
      const { recipe, report } = convertOk(
        legacy({ ingredients: [{ item: "stock", amount: "1", unit }] }),
      );
      expect(recipe.ingredients[0]!.qty_canonical).toEqual({ as_written: `1 ${unit}` });
      expect(report.lines[0]).toMatchObject({ kind: "as_written", reason: "unit-not-in-table" });
      expect(report.unitsOutsideTable).toEqual([unit]);
    },
  );

  it("a stated number the formatter can't render back is as written", () => {
    const { ingredient, line } = oneLine({ item: "milk", amount: "0.33", unit: "cup" });
    expect(ingredient.qty_canonical).toEqual({ as_written: "0.33 cup" });
    expect(line).toMatchObject({ kind: "as_written", reason: "round-trip" });
  });

  it.each([
    ["cup (16 tbsp)", "1 cup (16 tbsp)", "compound-same-system"],
    ["qt (1 l)", "1 qt (1 l)", "unit-not-in-table"],
  ])("a compound %s keeps the whole line as written", (unit, text, reason) => {
    const { ingredient, line } = oneLine({ item: "cream", amount: "1", unit });
    expect(ingredient.qty_canonical).toEqual({ as_written: text });
    expect(line).toMatchObject({ kind: "as_written", reason });
  });

  it("no amount and 'to taste' is to_taste; the name stays whole", () => {
    const { ingredient, line } = oneLine({ item: "salt and pepper, to taste" });
    expect(ingredient).toEqual({
      id: "ing-0",
      name: "salt and pepper, to taste",
      qty_canonical: { to_taste: true },
    });
    expect(line.kind).toBe("to_taste");
  });

  it("no amount and no 'to taste' is unstated", () => {
    const { ingredient, line } = oneLine({ item: "frozen parathas" });
    expect(ingredient.qty_canonical).toEqual({ unstated: true });
    expect(line.kind).toBe("unstated");
  });

  it("a blank amount reads as no amount", () => {
    expect(oneLine({ item: "chili oil", amount: "  ", unit: "" }).ingredient.qty_canonical).toEqual({
      unstated: true,
    });
  });

  describe("stepIngredients: refs all or nothing", () => {
    const ingredients = [
      { item: "a", amount: "1" },
      { item: "b", amount: "2" },
    ];
    const steps = ["One.", "Two."];

    it("a mapping that fits gives every step its refs, in order, without repeats", () => {
      const { recipe, report } = convertOk(
        legacy({ ingredients, steps, stepIngredients: [[1, 0, 1], []] }),
      );
      expect(recipe.steps.map((s) => s.ingredient_refs)).toEqual([["ing-1", "ing-0"], []]);
      expect(report.mapping).toBe("used");
    });

    it("a mapping of ingredient objects resolves each item to its stored ingredient ref", () => {
      const { recipe, report } = convertOk(
        legacy({
          ingredients,
          steps,
          stepIngredients: [[{ item: "b", amount: "2" }, { item: "a", amount: "1" }], []],
        }),
      );
      expect(recipe.steps.map((s) => s.ingredient_refs)).toEqual([["ing-1", "ing-0"], []]);
      expect(report.mapping).toBe("used");
    });

    it.each<[string, LegacyRecipe["stepIngredients"], string]>([
      ["missing", undefined, "absent"],
      ["null", null, "absent"],
      ["shorter than the steps", [[0]], "length-mismatch"],
      ["longer than the steps", [[0], [1], [0]], "length-mismatch"],
      ["with an index past the ingredients", [[0], [2]], "index-out-of-range"],
      ["with a negative index", [[-1], [1]], "index-out-of-range"],
      ["with a fractional index", [[0.5], [1]], "index-out-of-range"],
    ])("a mapping %s gives no step any refs", (_name, stepIngredients, status) => {
      const { recipe, report } = convertOk(legacy({ ingredients, steps, stepIngredients }));
      expect(recipe.steps.every((s) => s.ingredient_refs === undefined)).toBe(true);
      expect(report.mapping).toBe(status);
    });

    it.each<[string, unknown]>([
      ["not a list", { 0: [0] }],
      ["with an entry that is not a list", [[0], 1]],
      ["with an index that is not a number", [[0], ["1"]]],
    ])("a mapping %s is malformed, and gives no step any refs", (_name, stepIngredients) => {
      const { recipe, report } = convertOk(
        legacy({ ingredients, steps, stepIngredients: stepIngredients as number[][] }),
      );
      expect(recipe.steps.every((s) => s.ingredient_refs === undefined)).toBe(true);
      expect(report.mapping).toBe("malformed");
    });
  });

  it("a step's timer is its first duration, and the report lists a step with several", () => {
    const { recipe, report } = convertOk(
      legacy({
        steps: [
          "Chill the dough at least 2 hours, or up to 3 days.",
          "Cook 2 minutes, then flip and cook 1 minute more.",
          "Season.",
        ],
      }),
    );
    expect(recipe.steps.map((s) => s.timer_sec)).toEqual([7200, 120, null]);
    expect(report.multiDurationSteps).toEqual([0, 1]);
  });

  it("a range is one duration at its lower bound", () => {
    const { recipe, report } = convertOk(legacy({ steps: ["Bake 35 to 40 minutes, until set."] }));
    expect(recipe.steps[0]!.timer_sec).toBe(2100);
    expect(report.multiDurationSteps).toEqual([]);
  });

  // B4 step 0, call 8: the lamb stew's step and the pasta's offset.
  it("an hour and minutes together are one timer", () => {
    const { recipe } = convertOk(
      legacy({ steps: ["Cook for 1 hour 45 minutes, until potatoes and lamb are very tender"] }),
    );
    expect(recipe.steps[0]!.timer_sec).toBe(6300);
  });

  it("a first duration relative to another time sets no timer, and the step is listed", () => {
    const { recipe, report } = convertOk(
      legacy({
        steps: [
          "Cook pasta 1-2 minutes less than package directions (e.g., if box says 9 minutes, cook for 7-8 minutes).",
          "Bake 5 minutes longer than the cake.",
        ],
      }),
    );
    expect(recipe.steps.map((s) => s.timer_sec)).toEqual([null, null]);
    expect(report.multiDurationSteps).toEqual([0]);
  });

  // B4 step 0, call 11: the scallops' flip point is no timer for the roast.
  it("a duration straight after 'at' is a point in the step; the timer is the next one", () => {
    const { recipe, report } = convertOk(
      legacy({
        steps: [
          "Roast in a single layer, flipping once at 12 min, until deep brown at the edges and fork-tender (about 25 min).",
          "Stir at the 10-minute mark; bake 30 minutes in all.",
          "Flip at 12 min.",
          "Bake at 350°F for 20 minutes.",
        ],
      }),
    );
    expect(recipe.steps.map((s) => s.timer_sec)).toEqual([1500, 1800, null, 1200]);
    expect(report.multiDurationSteps).toEqual([0, 1]);
  });

  it("seconds round to the nearest second", () => {
    expect(convertOk(legacy({ steps: ["Sear 30 seconds a side."] })).recipe.steps[0]!.timer_sec).toBe(30);
  });

  it("a first duration over 12 hours is kept, and listed", () => {
    const { recipe, report } = convertOk(legacy({ steps: ["Cure 3 days in the fridge."] }));
    expect(recipe.steps[0]!.timer_sec).toBe(3 * 24 * 3600);
    expect(report.longTimerSteps).toEqual([0]);
  });

  describe("the serving count (v0.5, slice B4b)", () => {
    const ESTIMATE = { count: 3, basis: "1 cup lentils: about 3 bowls." };

    it("a stated count is the count, unmarked", () => {
      const { recipe, report } = convertOk(legacy({ serves: 4 }));
      expect(recipe.serves_base).toBe(4);
      expect(recipe).not.toHaveProperty("serves_estimated");
      expect(report.serves).toBe("stated");
    });

    it("a stated count wins over an estimate beside it, which is ignored", () => {
      const result = legacyToPackRecipe(legacy({ serves: 4 }), { id: "r", servesEstimate: ESTIMATE });
      expect(result.ok && result.recipe.serves_base).toBe(4);
      expect(result.ok && result.recipe).not.toHaveProperty("serves_estimated");
      expect(result.report.serves).toBe("stated");
    });

    it("no stated count: Sous's estimate, marked", () => {
      for (const serves of [null, undefined]) {
        const result = legacyToPackRecipe(legacy({ serves }), { id: "r", servesEstimate: ESTIMATE });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.recipe.serves_base).toBe(3);
        expect(result.recipe.serves_estimated).toBe(true);
        expect(result.report.serves).toBe("estimated");
      }
    });

    it("no stated count and no estimate: refused with the one serves issue first, other issues after", () => {
      for (const serves of [null, undefined]) {
        const result = legacyToPackRecipe(legacy({ serves }), { id: "r" });
        expect(result.ok).toBe(false);
        expect(!result.ok && result.issues).toEqual([NO_SERVES_ISSUE]);
        expect(result.report.serves).toBe("no-estimate");
      }
      expect(NO_SERVES_ISSUE).toEqual({
        path: "serves_base",
        message: "no serving count: the recipe states none, and Sous hasn't estimated one yet",
      });
      const both = legacyToPackRecipe(legacy({ serves: null, ingredients: [], steps: [] }), { id: "r" });
      expect(!both.ok && both.issues.map((i) => i.path)).toEqual(["serves_base", "(root)"]);
    });

    it("hasAmounts: any line read as measured, compound, count or as written", () => {
      const reading = (ingredients: { item: string; amount?: string; unit?: string }[]) =>
        legacyToPackRecipe(legacy({ serves: 2, ingredients, stepIngredients: null }), { id: "r" }).report.hasAmounts;
      expect(reading([{ item: "tuna" }, { item: "mayo" }, { item: "salt, to taste" }])).toBe(false);
      expect(reading([])).toBe(false);
      expect(reading([{ item: "tuna" }, { item: "eggs", amount: "2" }])).toBe(true);
      expect(reading([{ item: "salt", amount: "a pinch of" }])).toBe(true);
      expect(reading([{ item: "flour", amount: "1", unit: "cup" }])).toBe(true);
    });

    it("storedEstimate reads the two columns, both or neither", () => {
      expect(storedEstimate({ servesEstimate: 3, servesEstimateBasis: "b" })).toEqual({ count: 3, basis: "b" });
      expect(storedEstimate({ servesEstimate: null, servesEstimateBasis: null })).toBeUndefined();
    });
  });

  it("estimated time: active and total copied when given, passive dropped and counted", () => {
    const full = convertOk(legacy({ estimatedTime: { active: 15, passive: 30, total: 45 } }));
    expect(full.recipe.time_active_min).toBe(15);
    expect(full.recipe.time_total_min).toBe(45);
    expect(full.report.passiveDropped).toBe(true);

    const partial = convertOk(legacy({ estimatedTime: { passive: 30 } }));
    expect(partial.recipe).not.toHaveProperty("time_active_min");
    expect(partial.recipe).not.toHaveProperty("time_total_min");
    expect(partial.report.passiveDropped).toBe(true);

    const none = convertOk(legacy({ estimatedTime: null }));
    expect(none.recipe).not.toHaveProperty("time_active_min");
    expect(none.report.passiveDropped).toBe(false);
  });

  it.each<[string, Partial<LegacyRecipe>, string]>([
    ["both lists empty", { ingredients: [], steps: [] }, "(root)"],
    ["both lists missing", { ingredients: undefined, steps: undefined }, "(root)"],
    ["an empty name", { name: "" }, "title"],
    // Fix round 2: blank lines are skipped, and a recipe left with neither
    // list is still refused (P27).
    ["only blank lines", { ingredients: [{ item: "" }, { item: "  ", amount: " " }], steps: ["", " \t"] }, "(root)"],
    ["only blank steps and no ingredients", { ingredients: null, steps: ["  "] }, "(root)"],
  ])("refuses a recipe with %s, with the issues", (_name, over, path) => {
    const result = legacyToPackRecipe(legacy(over), { id: "dal" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toContain(path);
  });

  it("allows empty steps beside ingredients (P27), and the reverse", () => {
    expect(convertOk(legacy({ steps: [] })).recipe.steps).toEqual([]);
    expect(convertOk(legacy({ ingredients: null })).recipe.ingredients).toEqual([]);
  });
});

// B4 fix round 2: a blank stored step or line (empty, or only whitespace)
// carries nothing, so it is skipped rather than failing the recipe, which main
// cooked. Every other line keeps the id of its stored index, so a stored
// plan's indices still name the same lines.
describe("blank stored lines are skipped, the rest keep their stored ids", () => {
  it("skips a blank step and keeps each step's stored index as its id", () => {
    const { recipe, report } = convertOk(legacy({ steps: ["Rinse.", "", "  \t", "Simmer 20 minutes."] }));
    expect(recipe.steps.map((s) => [s.id, s.text])).toEqual([
      ["step-0", "Rinse."],
      ["step-3", "Simmer 20 minutes."],
    ]);
    expect(report.blankSteps).toEqual([1, 2]);
    expect(stepAt(recipe, 3)?.text).toBe("Simmer 20 minutes.");
    expect(stepAt(recipe, 1)).toBeUndefined();
  });

  it("skips a line whose item, amount and unit are all blank", () => {
    const { recipe, report } = convertOk(
      legacy({
        ingredients: [
          { item: "eggs", amount: "2" },
          { item: "" },
          { item: "  ", amount: " ", unit: "" },
          { item: "salt", amount: "1", unit: "tsp" },
        ],
      }),
    );
    expect(recipe.ingredients.map((i) => [i.id, i.name])).toEqual([
      ["ing-0", "eggs"],
      ["ing-3", "salt"],
    ]);
    expect(report.blankIngredients).toEqual([1, 2]);
    expect(report.lines.map((l) => l.index)).toEqual([0, 3]);
    expect(report.counts).toMatchObject({ count: 1, measured: 1, unstated: 0 });
    expect(ingredientAt(recipe, 3)?.name).toBe("salt");
    expect(ingredientAt(recipe, 1)).toBeUndefined();
  });

  it("keeps a mapping that fits the stored lists, minus the refs to blank lines", () => {
    const { recipe, report } = convertOk(
      legacy({
        ingredients: [{ item: "a", amount: "1" }, { item: " " }, { item: "b", amount: "2" }],
        steps: ["One.", "", "Two."],
        stepIngredients: [[0, 1], [1], [2, 1, 0]],
      }),
    );
    expect(report.mapping).toBe("used");
    expect(recipe.steps.map((s) => [s.id, s.ingredient_refs])).toEqual([
      ["step-0", ["ing-0"]],
      ["step-2", ["ing-2", "ing-0"]],
    ]);
  });

  it("a recipe left with steps alone, or ingredients alone, converts (P27)", () => {
    expect(convertOk(legacy({ ingredients: [{ item: "" }] })).recipe.ingredients).toEqual([]);
    expect(convertOk(legacy({ steps: [""] })).recipe.steps).toEqual([]);
  });

  it("names nothing blank in the report when nothing is", () => {
    const { report } = convertOk(legacy());
    expect(report.blankSteps).toEqual([]);
    expect(report.blankIngredients).toEqual([]);
  });
});

describe("recipe fields", () => {
  it("maps the whole recipe positionally, text verbatim", () => {
    const { recipe } = convertOk(
      legacy({
        name: "Masoor Dal",
        ingredients: [
          { item: "red lentils", amount: "1", unit: "cup" },
          { item: "salt", amount: "1", unit: "tsp" },
        ],
        steps: ["  Rinse the lentils.", "Simmer 20 minutes."],
        serves: 4,
        tags: ["indian", "weeknight"],
        notes: "Better the next day.",
        stepIngredients: [[0], [0, 1]],
      }),
      "masoor-dal",
    );
    expect(recipe).toEqual({
      id: "masoor-dal",
      title: "Masoor Dal",
      serves_base: 4,
      tags: ["indian", "weeknight"],
      ingredients: [
        {
          id: "ing-0",
          name: "red lentils",
          qty_canonical: { volume_ml: 236.588 },
          display_equivalents: { imperial: { unit: "cup", amount: 1 } },
        },
        {
          id: "ing-1",
          name: "salt",
          qty_canonical: { volume_ml: 4.929 },
          display_equivalents: { imperial: { unit: "tsp", amount: 1 } },
        },
      ],
      steps: [
        { id: "step-0", type: "action", text: "  Rinse the lentils.", timer_sec: null, ingredient_refs: ["ing-0"] },
        { id: "step-1", type: "action", text: "Simmer 20 minutes.", timer_sec: 1200, ingredient_refs: ["ing-0", "ing-1"] },
      ],
      creator_notes: ["Better the next day."],
    });
  });

  it("a blank note is no creator_notes", () => {
    expect(convertOk(legacy({ notes: "  " })).recipe).not.toHaveProperty("creator_notes");
    expect(convertOk(legacy({ notes: null })).recipe).not.toHaveProperty("creator_notes");
  });

  it("does not change its input", () => {
    const input = legacy({ stepIngredients: [[0]], estimatedTime: { active: 5 } });
    const before = JSON.stringify(input);
    legacyToPackRecipe(input, { id: "dal" });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("counts every class in the report", () => {
    const { report } = convertOk(
      legacy({
        ingredients: [
          { item: "a", amount: "1", unit: "cup" },
          { item: "b", amount: "1", unit: "cup (225 g)" },
          { item: "c", amount: "2" },
          { item: "d, to taste" },
          { item: "e" },
          { item: "f", amount: "a handful of" },
          { item: "g", amount: "1", unit: "qt" },
        ],
      }),
    );
    expect(report.counts).toEqual({
      measured: 1,
      compound: 1,
      count: 1,
      to_taste: 1,
      unstated: 1,
      as_written: 2,
    });
  });
});

// B4 fix round 1, HIGH 1: the shapes the import paths actually store. Main
// showed every line by joining "amount unit item" and reading a leading
// quantity off the front; the converter reads the same joined text through
// the pack's reader whenever the stored fields hold no amount it can use, so
// no stored line shows less than main did.
describe("an amount written inside the item", () => {
  type Expect = [ChatRecipeIngredient, Record<string, unknown>, string, string | undefined];

  function expectLine(
    line: ChatRecipeIngredient,
    qty: Record<string, unknown>,
    name: string,
    readFrom?: string,
  ) {
    const { ingredient, line: report } = oneLine(line);
    expect({ name: ingredient.name, qty: ingredient.qty_canonical }).toEqual({ name, qty });
    expect(report.readFromText).toBe(readFrom);
    return { ingredient, report };
  }

  describe("JSON-LD import, split succeeded (today's stored shape)", () => {
    it.each<Expect>([
      [{ amount: "2", unit: "cups", item: "flour" }, { volume_ml: 2 * 236.588 }, "flour", undefined],
      [
        { amount: "3", unit: "cloves", item: "garlic" },
        { count: 3, count_unit: { one: "clove", other: "cloves" } },
        "garlic",
        undefined,
      ],
    ])("%j reads its fields", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });

    // A stated equivalent the split left in the item is read with the amount
    // (B4 step 0, call 7), so no unscaled number stands in the name.
    it("an equivalent left in the item reads as the compound the line states", () => {
      const { ingredient } = expectLine(
        { amount: "1", unit: "cup", item: "(225 g) butter" },
        { volume_ml: 236.588, mass_g: 225 },
        "butter",
        "1 cup (225 g) butter",
      );
      expect(ingredient.display_equivalents).toEqual({
        imperial: { unit: "cup", amount: 1 },
        metric: { unit: "g", amount: 225 },
      });
    });

    // The source's words, marked, where main showed the same words with a
    // bold "2"; the report lists the spelling (fix round 1 call 6).
    it("a word the split took as the unit stays as written (step-1 call 5)", () => {
      expectLine({ amount: "2", unit: "packets", item: "yeast" }, { as_written: "2 packets" }, "yeast");
    });

    // The prod export's words (B4 step 0, spelling calls 1–3; P26 in B5c-6):
    // a count noun unfolds to count_unit, a size word stays in the name, and
    // the extraction's "unit"/"item" is dropped, as the Doc has none.
    it.each<Expect>([
      [
        { amount: "1", unit: "bunch", item: "cilantro" },
        { count: 1, count_unit: { one: "bunch", other: "bunches" } },
        "cilantro",
        undefined,
      ],
      [
        { amount: "½", unit: "bunch", item: "cilantro" },
        { count: 0.5, count_unit: { one: "bunch", other: "bunches" } },
        "cilantro",
        undefined,
      ],
      [{ amount: "2", unit: "large", item: "eggs" }, { count: 2 }, "large eggs", undefined],
      [
        { amount: "3", unit: "ears", item: "sweet corn" },
        { count: 3, count_unit: { one: "ear", other: "ears" } },
        "sweet corn",
        undefined,
      ],
      [{ amount: "1/4", unit: "whole", item: "red onion" }, { count: 0.25 }, "whole red onion", undefined],
      [{ amount: "1", unit: "unit", item: "red onion, sliced" }, { count: 1 }, "red onion, sliced", undefined],
      [{ amount: "1", unit: "item", item: "lime" }, { count: 1 }, "lime", undefined],
      [{ amount: "1.5", unit: "tbs", item: "gram dhal" }, { volume_ml: 1.5 * 14.787 }, "gram dhal", undefined],
      [{ amount: "1", unit: "pinch", item: "red chili flakes" }, { as_written: "1 pinch" }, "red chili flakes", undefined],
      [{ amount: "Pinch", item: "salt" }, { as_written: "Pinch" }, "salt", undefined],
    ])("%j reads the export's spelling", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });

    it("a phrase in the amount with no number to lead stays as written", () => {
      expectLine({ amount: "a pinch of", item: "salt" }, { as_written: "a pinch of" }, "salt");
    });
  });

  describe("JSON-LD import, split failed: the whole line stored as the item", () => {
    it.each<Expect>([
      [{ item: "1 1/2 cups flour" }, { volume_ml: 1.5 * 236.588 }, "flour", "1 1/2 cups flour"],
      [
        { item: "1 cup (225 g) butter, softened" },
        { volume_ml: 236.588, mass_g: 225 },
        "butter, softened",
        "1 cup (225 g) butter, softened",
      ],
      [{ item: "2 eggs" }, { count: 2 }, "eggs", "2 eggs"],
      [
        { item: "1 (14 oz) can tomatoes" },
        { count: 1 },
        "(14 oz) can tomatoes",
        "1 (14 oz) can tomatoes",
      ],
      [{ item: "1/2 lemon, juiced" }, { count: 0.5 }, "lemon, juiced", "1/2 lemon, juiced"],
      [
        { item: "2-3 tbsp oil" },
        { volume_ml: 2 * 14.787, range_max: 3 * 14.787 },
        "oil",
        "2-3 tbsp oil",
      ],
      [{ item: "salt to taste" }, { to_taste: true }, "salt to taste", undefined],
      [{ item: "flaky sea salt" }, { unstated: true }, "flaky sea salt", undefined],
      [{ item: "00 flour" }, { unstated: true }, "00 flour", undefined],
    ])("%j", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });

    it("keeps the hint the text states", () => {
      const { ingredient } = expectLine(
        { item: "1 1/2 cups flour" },
        { volume_ml: 1.5 * 236.588 },
        "flour",
        "1 1/2 cups flour",
      );
      expect(ingredient.display_equivalents).toEqual({ imperial: { unit: "cup", amount: 1.5 } });
    });
  });

  describe("JSON-LD import, split inside the number (rows already stored)", () => {
    it.each<Expect>([
      [{ amount: "1", unit: "0", item: "eggs" }, { count: 10 }, "eggs", "10 eggs"],
      [
        { amount: "1", unit: "0", item: "eggs, beaten" },
        { count: 10 },
        "eggs, beaten",
        "10 eggs, beaten",
      ],
      [{ amount: "1/", unit: "2", item: "lemon" }, { count: 0.5 }, "lemon", "1/2 lemon"],
      [
        { amount: "1", unit: "2", item: "(14 oz) cans tomatoes" },
        { count: 12 },
        "(14 oz) cans tomatoes",
        "12 (14 oz) cans tomatoes",
      ],
    ])("%j is read as the one number the source wrote", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });

    it("a number in the unit slot before a word is a second number, not a split one", () => {
      expectLine(
        { amount: "1", unit: "15", item: "oz can beans" },
        { count: 1 },
        "15 oz can beans",
        "1 15 oz can beans",
      );
    });
  });

  describe("model import, a string entry (wrapped as the item)", () => {
    it.each<Expect>([
      [
        { item: "3 cloves garlic, minced" },
        { count: 3, count_unit: { one: "clove", other: "cloves" } },
        "garlic, minced",
        "3 cloves garlic, minced",
      ],
      [{ item: "2 Tbsp. olive oil" }, { volume_ml: 2 * 14.787 }, "olive oil", "2 Tbsp. olive oil"],
      [{ item: "100g dark chocolate" }, { mass_g: 100 }, "dark chocolate", "100g dark chocolate"],
      [
        { item: "2 tbsp butter, or to taste" },
        { volume_ml: 2 * 14.787 },
        "butter, or to taste",
        "2 tbsp butter, or to taste",
      ],
    ])("%j", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });
  });

  describe("model import, an object entry", () => {
    it.each<Expect>([
      [
        { item: "flour", amount: "1 1/2 cups" },
        { volume_ml: 1.5 * 236.588 },
        "flour",
        "1 1/2 cups flour",
      ],
      [{ item: "cups flour", amount: "2" }, { volume_ml: 2 * 236.588 }, "flour", "2 cups flour"],
      [{ item: "flour", amount: "2", unit: "cups" }, { volume_ml: 2 * 236.588 }, "flour", undefined],
      [{ item: "salt", amount: "to taste" }, { to_taste: true }, "salt", undefined],
      [{ item: "cumin", amount: "a pinch of" }, { as_written: "a pinch of" }, "cumin", undefined],
      [{ item: "eggs", amount: "2" }, { count: 2 }, "eggs", undefined],
    ])("%j", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });
  });

  describe("agent webhook (an agent sends {item, amount, unit})", () => {
    it.each<Expect>([
      [
        { item: "chickpeas", amount: "1", unit: "can" },
        { count: 1, count_unit: { one: "can", other: "cans" } },
        "chickpeas",
        undefined,
      ],
      [{ item: "olive oil", amount: "2", unit: "tbsp" }, { volume_ml: 2 * 14.787 }, "olive oil", undefined],
      [{ item: "1 lemon" }, { count: 1 }, "lemon", "1 lemon"],
      [{ item: "spinach", amount: "200", unit: "g" }, { mass_g: 200 }, "spinach", undefined],
    ])("%j", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });
  });

  // B4 fix round 2 (MED): an import stored the parenthetical with the unit
  // ("cup (about 1 lb)"), which reads as written alone. Re-read, the bare unit
  // is a measure and the parenthetical is part of the name, as the old split
  // stored it. A parenthetical that reads as an equivalent stays a compound.
  // One that holds a quantity would then stand unscaled beside the scaled
  // amount, so that line goes as written (B4 step 0, call 7).
  describe("a parenthetical after the unit the reader can't read", () => {
    it.each<Expect>([
      [
        { amount: "3", unit: "cups (about 1 lb)", item: "potatoes" },
        { as_written: "3 cups (about 1 lb)" },
        "potatoes",
        undefined,
      ],
      [
        { amount: "1", unit: "cup (a splash)", item: "cream" },
        { volume_ml: 236.588 },
        "(a splash) cream",
        "1 cup (a splash) cream",
      ],
      [
        { amount: "1", unit: "cup (about 2 lemons)", item: "juice" },
        { as_written: "1 cup (about 2 lemons)" },
        "juice",
        undefined,
      ],
      [
        { item: "1 cup (about 2 lemons) juice" },
        { as_written: "1 cup" },
        "(about 2 lemons) juice",
        "1 cup (about 2 lemons) juice",
      ],
      [
        { amount: "1", unit: "cup (8 oz)", item: "cream cheese" },
        { as_written: "1 cup (8 oz)" },
        "cream cheese",
        undefined,
      ],
      [
        { item: "1 cup (8 oz) cream cheese" },
        { as_written: "1 cup (8 oz)" },
        "cream cheese",
        "1 cup (8 oz) cream cheese",
      ],
      [
        { amount: "1", unit: "can (14 oz)", item: "tomatoes" },
        { count: 1, count_unit: { one: "can (14 oz)", other: "cans (14 oz)" } },
        "tomatoes",
        undefined,
      ],
    ])("%j", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });
  });

  // B4 step 0, call 7: a line is a scalable amount only if everything after
  // its amount scales with it. "2 tbsp + 1 tsp cumin" at 2× is a wrong
  // number, so a number left in the name sends the line to as written, unless
  // it is a stated equivalent the format's hints hold. The prod export's lines.
  describe("a number after the amount", () => {
    type Written = [ChatRecipeIngredient, string, AsWrittenReason, string, string | undefined];

    it.each<Written>([
      // A same-ingredient sum: the format has one hint per system, so a
      // same-system sum has no compound shape.
      [{ amount: "1 tbsp + 1 tsp", item: "cumin" }, "1 tbsp + 1 tsp", "amount-not-a-number", "cumin", undefined],
      [
        { amount: "⅓ cup + 2", unit: "tbsp", item: "marsala (or dry sherry)" },
        "⅓ cup + 2 tbsp",
        "amount-not-a-number",
        "marsala (or dry sherry)",
        undefined,
      ],
      [
        { amount: "1 Tablespoon + 1", unit: "teaspoon", item: "brown sugar" },
        "1 Tablespoon + 1 teaspoon",
        "amount-not-a-number",
        "brown sugar",
        undefined,
      ],
      [
        { amount: "1 tablespoon + 1 teaspoon", item: "avocado oil" },
        "1 tablespoon + 1 teaspoon",
        "amount-not-a-number",
        "avocado oil",
        undefined,
      ],
      [{ item: "1 tbsp + 1 tsp cumin" }, "1 tbsp", "number-after-amount", "+ 1 tsp cumin", "1 tbsp + 1 tsp cumin"],
      // Parts that name different things.
      [
        { amount: "2", unit: "teaspoons", item: "finely grated lemon zest plus 4 teaspoons juice (from 1 lemon)" },
        "2 teaspoons",
        "number-after-amount",
        "finely grated lemon zest plus 4 teaspoons juice (from 1 lemon)",
        undefined,
      ],
      // Two ingredients on one line.
      [{ item: "1 sprig rosemary, 1 bay leaf" }, "1 sprig", "number-after-amount", "rosemary, 1 bay leaf", "1 sprig rosemary, 1 bay leaf"],
      // An alternative amount.
      [
        { amount: "1", unit: "can (15 ounces)", item: "chickpeas, rinsed and drained, or 1 1/2 cups cooked chickpeas" },
        "1 can (15 ounces)",
        "number-after-amount",
        "chickpeas, rinsed and drained, or 1 1/2 cups cooked chickpeas",
        undefined,
      ],
      // A number that names the ingredient is still a number: the reader can't
      // tell it from an amount, and never guesses.
      [{ amount: "½", unit: "tsp", item: "Chinese five spice powder" }, "½ tsp", "number-after-amount", "Chinese five spice powder", undefined],
    ])("%j goes as written", (line, text, reason, name, readFrom) => {
      const { ingredient, line: report } = oneLine(line);
      expect(ingredient).toEqual({ id: "ing-0", name, qty_canonical: { as_written: text } });
      expect(report).toMatchObject({ kind: "as_written", text, reason });
      expect(report.readFromText).toBe(readFrom);
    });

    it.each<[ChatRecipeIngredient, string | undefined]>([
      [{ amount: "½", unit: "cup (113g)", item: "softened unsalted butter" }, undefined],
      [{ amount: "1⅔ cups (213g)", item: "softened unsalted butter" }, "1⅔ cups (213g) softened unsalted butter"],
    ])("an unspaced equivalent %j reads as the stated hints", (line, readFrom) => {
      const { ingredient, line: report } = oneLine(line);
      const cups = line.unit === undefined ? 1 + 2 / 3 : 0.5;
      const grams = line.unit === undefined ? 213 : 113;
      expect(ingredient).toEqual({
        id: "ing-0",
        name: "softened unsalted butter",
        qty_canonical: { volume_ml: cups * 236.588, mass_g: grams },
        display_equivalents: {
          imperial: { unit: "cup", amount: cups },
          metric: { unit: "g", amount: grams },
        },
      });
      expect(report.readFromText).toBe(readFrom);
    });

    it("trailing text with no number stays with the measured amount", () => {
      expectLine(
        { amount: "⅓", unit: "cup", item: "good olive oil, plus more to finish; salt" },
        { volume_ml: (1 / 3) * 236.588 },
        "good olive oil, plus more to finish; salt",
      );
    });

    // A size before a count noun is each unit's size, right at any count.
    it.each<Expect>([
      [{ item: "2 (14.5 ounce) cans diced tomatoes" }, { count: 2 }, "(14.5 ounce) cans diced tomatoes", "2 (14.5 ounce) cans diced tomatoes"],
      [{ amount: "2", item: "15-ounce cans chickpeas" }, { count: 2 }, "15-ounce cans chickpeas", undefined],
    ])("%j keeps its count", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });

    // Call 8 (the lead's refinement): only a second quantity blocks, a number
    // with a measuring unit or a count of a second item. A duration, a
    // dimension, a package size inside a count, a temperature or a percentage
    // measures something else and doesn't scale with the line.
    it.each<Expect>([
      [
        { amount: "1", unit: "lb", item: "Yellow Eye beans, soaked 8 to 18 hr, drained" },
        { mass_g: 453.592 },
        "Yellow Eye beans, soaked 8 to 18 hr, drained",
        undefined,
      ],
      [
        { item: "1 lb Yellow Eye beans, soaked 8 to 18 hr" },
        { mass_g: 453.592 },
        "Yellow Eye beans, soaked 8 to 18 hr",
        "1 lb Yellow Eye beans, soaked 8 to 18 hr",
      ],
      [{ item: "1 (14-ounce) can tomatoes" }, { count: 1 }, "(14-ounce) can tomatoes", "1 (14-ounce) can tomatoes"],
      [{ amount: "2", unit: "lb", item: "beef chuck, cut into 1-inch cubes" }, { mass_g: 2 * 453.592 }, "beef chuck, cut into 1-inch cubes", undefined],
      [{ amount: "1", unit: "lb", item: "tofu, cut 2x2 inches" }, { mass_g: 453.592 }, "tofu, cut 2x2 inches", undefined],
      [{ amount: "1", unit: "cup", item: "milk, warmed to 110°F" }, { volume_ml: 236.588 }, "milk, warmed to 110°F", undefined],
      [{ amount: "1", unit: "cup", item: "2% milk" }, { volume_ml: 236.588 }, "2% milk", undefined],
      // A ratio: a slash between two numbers, the larger first.
      [{ amount: "1", unit: "lb", item: "ground beef (80/20)" }, { mass_g: 453.592 }, "ground beef (80/20)", undefined],
      [{ item: "1 lb ground beef (80/20)" }, { mass_g: 453.592 }, "ground beef (80/20)", "1 lb ground beef (80/20)"],
    ])("%j is not a second quantity", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });

    it.each<Written>([
      [{ amount: "1", unit: "tbsp", item: "oil, plus 1 tsp more" }, "1 tbsp", "number-after-amount", "oil, plus 1 tsp more", undefined],
      [{ amount: "1", unit: "lb", item: "beans, or 1 (14-ounce) can" }, "1 lb", "number-after-amount", "beans, or 1 (14-ounce) can", undefined],
      // A fraction after a slash is still an amount.
      [{ amount: "1", unit: "cup", item: "lemon juice (1/2 lemon)" }, "1 cup", "number-after-amount", "lemon juice (1/2 lemon)", undefined],
    ])("%j holds a second quantity, so it goes as written", (line, text, reason, name, readFrom) => {
      const { ingredient, line: report } = oneLine(line);
      expect(ingredient).toEqual({ id: "ing-0", name, qty_canonical: { as_written: text } });
      expect(report).toMatchObject({ kind: "as_written", text, reason });
      expect(report.readFromText).toBe(readFrom);
    });
  });

  // Call 12: every probe the golden judge ran on 9ffb087 (judge §3), through
  // the converter. A second quantity in the name, in figures or words, sends
  // the line to as written; a number that measures something else, or a word
  // with no unit the table knows, leaves it as it reads.
  describe("the judge's probes", () => {
    type Probe = [string, string, string];
    const line = ([amount, unit, item]: Probe): ChatRecipeIngredient => ({ amount, unit, item });

    it.each<Probe>([
      // Its false exemptions, each of which scaled before call 12.
      ["1", "cup", "broth, plus a half-cup to finish"],
      ["1", "cup", "sugar, plus a tablespoon for sprinkling"],
      ["1", "cup", "rice, plus a cup of water"],
      ["1", "cup", "stock, plus a quarter cup"],
      ["1", "cup", "stock, plus a third of a cup"],
      ["1", "cup", "flour, plus a couple tablespoons"],
      ["1", "tbsp", "oil, plus 2-ish tbsp to finish"],
      ["1", "cup", "flour plus 2-heaping tbsp"],
      ["1", "lb", "shrimp (about twenty)"],
      ["2", "lb", "wings (fifteen to twenty pieces)"],
      ["1", "cup", "water, plus one-and-a-half cups to thin"],
      ["1", "tbsp", "oil plus 3/2 for frying"],
      // Lines it found already held.
      ["1", "cup", "flour, plus ½ cup for dusting"],
      ["1", "cup", "flour, plus 1½ cups for dusting"],
      ["1", "cup", "flour, plus .5 cup for dusting"],
      ["2", "cups", "flour (about 250 grams)"],
      ["1", "cup", "rice (about 200g)"],
      ["1", "lb", "shrimp, 16-20ct"],
      ["4", "", "eggs, 2 separated"],
      ["1", "cup", "water, plus about 2 more"],
      ["1", "cup", "oats (a 1/2 cup per person)"],
      ["1", "lb", "beef, for 4"],
      ["2", "cups", "water per 1 cup rice"],
      ["1", "cup", "flour (or 4/3 cup sifted)"],
      ["1", "lb", "shrimp (16-20 count)"],
      ["1", "lb", "shrimp, 16/20 count"],
      ["2", "lb", "chicken (4 6-ounce breasts)"],
      ["2", "lb", "chicken breasts (about 4 6-oz breasts)"],
      ["2", "lb", "potatoes (3 x 1 lb bags)"],
      ["2", "lb", "potatoes (2x 1-lb bags)"],
      ["1", "cup", "rice (makes a 3-cup yield)"],
      ["1", "cup", "rice (3-cup yield)"],
      ["1", "", "batch dough (2-cup yield)"],
      ["1", "tbsp", "butter, plus 1-2 more tbsp to finish"],
      ["1", "tbsp", "butter, plus 2-tbsp for the pan"],
      ["1", "tbsp", "butter, plus another two-tablespoons"],
      ["1", "tbsp", "oil plus 2 for frying"],
      ["2", "", "eggs plus 1 yolk"],
      ["2", "", "eggs, plus one yolk"],
      ["1", "cup", "stock, divided into 2 parts"],
      ["1", "lb", "ground beef (1/2 for meatballs)"],
      ["3", "", "eggs (1 for the wash)"],
      ["1", "cup", "cream, 35% fat, plus 2 tbsp"],
      ["1", "", "can (15 oz) chickpeas plus 1 more can"],
      ["4", "cups", "stock (1 quart)"],
      ["1", "cup", "sugar, minus 2 tbsp"],
      ["1", "lb", "pasta, about 4 servings"],
      ["2", "tbsp", "oil, used 2 times"],
      ["1", "cup", "basil, 2 handfuls"],
      ["2", "cups", "flour (8.5 ounces)"],
      ["2", "cups", "flour (8.5oz/240g)"],
      ["1", "cup", "nuts, 1-2 handfuls"],
      ["1", "lb", "pork, cut into 2-inch pieces, 2 pieces per person"],
      ["1", "cup", "sugar, 2 cups if you like it sweet"],
      ["1", "tsp", "salt, or two pinches"],
      ["1", "tsp", "salt, or 2 big pinches"],
      ["2", "", "dozen eggs"],
      ["1", "", "half a lemon"],
      ["1", "cup", "rice, 2 Tbsp reserved"],
      ["1", "cup", "flour, 1 T reserved"],
      ["1", "cup", "flour, 1 C sifted"],
      ["1", "cup", "flour (1 1/2 cups if humid)"],
      ["1", "cup", "flour, 1½ cups if humid"],
      ["1", "cup", "water at 100-110°F, 2 tsp yeast"],
      ["1", "cup", "broth, reduce by 1/2"],
      ["1", "cup", "broth, reduced to 1/2"],
      ["1", "", "onion, 1/2 sliced, 1/2 diced"],
    ])("%s %s %j holds a second quantity, so it goes as written", (...probe) => {
      const { ingredient, line: report } = oneLine(line(probe));
      expect(ingredient.name).toBe(probe[2]);
      expect(report).toMatchObject({ kind: "as_written", reason: "number-after-amount" });
    });

    it.each<[...Probe, string]>([
      // A number that measures something else.
      ["2", "cups", "milk, warmed to 110F", "measured"],
      ["1", "cup", "water, 2nd addition", "measured"],
      ["1", "cup", "stock, half reserved", "measured"],
      ["1", "cup", "stock (half for the sauce)", "measured"],
      ["1", "lb", "ground beef (80/20)", "measured"],
      ["2", "cups", "rice, 2/1 water ratio", "measured"],
      ["1", "cup", "milk, 2 percent", "measured"],
      ["1", "lb", "beef, 3 days aged", "measured"],
      ["1", "cup", "water, twice", "measured"],
      ["6", "", "tortillas, 6-inch", "count"],
      // Words with no unit the table knows, and a proportion.
      ["1", "cup", "milk, plus a splash", "measured"],
      ["2", "tbsp", "butter, plus a knob", "measured"],
      ["1", "tsp", "salt, plus extra", "measured"],
      ["2", "cups", "water for every cup of rice", "measured"],
    ])("%s %s %j holds no second quantity, so it reads as %s", (amount, unit, item, kind) => {
      const { ingredient, line: report } = oneLine(line([amount, unit, item]));
      expect(ingredient.name).toBe(item);
      expect(report.kind).toBe(kind);
    });
  });

  // Call 10: a length is no amount of an ingredient. The mole's "Cover with
  // 3 inches of water" is a depth, stored "3" "inches" "water": counted, it
  // read "6 inches water" at 2×. Every way a line can state one goes as
  // written, with the length the source wrote.
  describe("a length as the amount", () => {
    type Written = [ChatRecipeIngredient, string, AsWrittenReason, string, string | undefined];
    it.each<Written>([
      [{ amount: "3", unit: "inches", item: "water" }, "3 inches", "length-not-an-amount", "water", undefined],
      [
        { amount: "1", unit: "inch", item: "cinnamon stick, broken into 1 cm size pieces" },
        "1 inch",
        "length-not-an-amount",
        "cinnamon stick, broken into 1 cm size pieces",
        undefined,
      ],
      [{ amount: "1/2", unit: "inch", item: "grated ginger" }, "1/2 inch", "length-not-an-amount", "grated ginger", undefined],
      [{ amount: "2", unit: "cm", item: "ginger" }, "2 cm", "length-not-an-amount", "ginger", undefined],
      [{ item: "3 inches water" }, "3 inches", "length-not-an-amount", "water", "3 inches water"],
      [{ amount: "3", item: "inches water" }, "3 inches", "length-not-an-amount", "water", "3 inches water"],
      [{ amount: "1", item: "in. ginger, grated" }, "1 in", "length-not-an-amount", "ginger, grated", "1 in. ginger, grated"],
    ])("%j goes as written", (line, text, reason, name, readFrom) => {
      const { ingredient, line: report } = oneLine(line);
      expect(ingredient).toEqual({ id: "ing-0", name, qty_canonical: { as_written: text } });
      expect(report).toMatchObject({ kind: "as_written", text, reason });
      expect(report.readFromText).toBe(readFrom);
    });

    it("lists no length as a unit outside the table", () => {
      const { report } = convertOk(legacy({ ingredients: [{ amount: "3", unit: "inches", item: "water" }] }));
      expect(report.unitsOutsideTable).toEqual([]);
    });
  });

  // Call 8: a parenthetical right after the unit that holds only an
  // equivalent of the same amount becomes the hints and leaves the name. A
  // stick of butter is ½ cup; the unit table has no stick, so a stick
  // equivalent is checked against the amount and then dropped.
  describe("a stated equivalent after the unit", () => {
    type Hinted = [ChatRecipeIngredient, string, Record<string, unknown>, Record<string, unknown>, string | undefined];
    const cup = 236.588;
    const tbsp = 14.787;

    it.each<Hinted>([
      [
        { amount: "1⅔ cups (213g)", unit: "", item: "all-purpose flour" },
        "all-purpose flour",
        { volume_ml: (1 + 2 / 3) * cup, mass_g: 213 },
        { imperial: { unit: "cup", amount: 1 + 2 / 3 }, metric: { unit: "g", amount: 213 } },
        "1⅔ cups (213g) all-purpose flour",
      ],
      [
        { item: "1⅔ cups (213g) all-purpose flour" },
        "all-purpose flour",
        { volume_ml: (1 + 2 / 3) * cup, mass_g: 213 },
        { imperial: { unit: "cup", amount: 1 + 2 / 3 }, metric: { unit: "g", amount: 213 } },
        "1⅔ cups (213g) all-purpose flour",
      ],
      [
        { amount: "1", unit: "tbsp (15mL)", item: "vanilla extract" },
        "vanilla extract",
        { volume_ml: tbsp },
        { imperial: { unit: "tbsp", amount: 1 }, metric: { unit: "ml", amount: 15 } },
        undefined,
      ],
      [
        { item: "1 tbsp (15mL) vanilla" },
        "vanilla",
        { volume_ml: tbsp },
        { imperial: { unit: "tbsp", amount: 1 }, metric: { unit: "ml", amount: 15 } },
        "1 tbsp (15mL) vanilla",
      ],
      [
        { amount: "½", unit: "cup (1 stick / 113g)", item: "unsalted butter, softened" },
        "unsalted butter, softened",
        { volume_ml: cup / 2, mass_g: 113 },
        { imperial: { unit: "cup", amount: 0.5 }, metric: { unit: "g", amount: 113 } },
        undefined,
      ],
      [
        { item: "½ cup (1 stick / 113g) butter" },
        "butter",
        { volume_ml: cup / 2, mass_g: 113 },
        { imperial: { unit: "cup", amount: 0.5 }, metric: { unit: "g", amount: 113 } },
        "½ cup (1 stick / 113g) butter",
      ],
      [
        { amount: "1/2", unit: "cup (1 stick)", item: "butter" },
        "butter",
        { volume_ml: cup / 2 },
        { imperial: { unit: "cup", amount: 0.5 } },
        undefined,
      ],
      [
        { item: "1/2 cup (1 stick) butter" },
        "butter",
        { volume_ml: cup / 2 },
        { imperial: { unit: "cup", amount: 0.5 } },
        "1/2 cup (1 stick) butter",
      ],
      [
        { amount: "1/2", unit: "cup", item: "(1 stick) butter" },
        "butter",
        { volume_ml: cup / 2 },
        { imperial: { unit: "cup", amount: 0.5 } },
        "1/2 cup (1 stick) butter",
      ],
    ])("%j", (line, name, qty, hints, readFrom) => {
      const { ingredient, line: report } = oneLine(line);
      expect(ingredient).toEqual({ id: "ing-0", name, qty_canonical: qty, display_equivalents: hints });
      expect(report.readFromText).toBe(readFrom);
    });
  });

  // B4 fix round 2 (LOW): a line that is only an amount reads as that amount.
  // The name is what else the line says: the count noun, or the line itself.
  describe("a line that is only an amount", () => {
    it.each<Expect>([
      [
        { item: "3 cloves" },
        { count: 3, count_unit: { one: "clove", other: "cloves" } },
        "cloves",
        "3 cloves",
      ],
      [{ item: "2 g" }, { mass_g: 2 }, "2 g", "2 g"],
      [{ amount: "2", unit: "cups", item: "" }, { volume_ml: 2 * 236.588 }, "2 cups", undefined],
      [
        { amount: "3", unit: "cloves", item: "" },
        { count: 3, count_unit: { one: "clove", other: "cloves" } },
        "cloves",
        undefined,
      ],
      [{ amount: "2", item: "  " }, { count: 2 }, "2", undefined],
      [{ amount: "to taste", item: "" }, { to_taste: true }, "to taste", undefined],
      [{ amount: "a pinch", item: "" }, { as_written: "a pinch" }, "a pinch", undefined],
    ])("%j", (line, qty, name, readFrom) => {
      expectLine(line, qty, name, readFrom);
    });
  });

  it("counts a line by the reading it shows", () => {
    const { report } = convertOk(
      legacy({
        ingredients: [{ item: "1 1/2 cups flour" }, { amount: "1", unit: "0", item: "eggs" }],
      }),
    );
    expect(report.counts).toMatchObject({ measured: 1, count: 1, unstated: 0, as_written: 0 });
  });
});

// jsonb is typed by assertion, not checked: a stored row can hold a shape its
// type doesn't describe, and the converter must never be handed one (it
// throws on a numeric amount). Every caller reading stored data reads it here
// first, so a bad row is one recipe's issues, never a crashed load.
describe("readLegacyRecipe: a stored row checked before it is converted", () => {
  it("reads a doc_recipes row, dropping the columns the converter doesn't read", () => {
    const read = readLegacyRecipe({
      id: "0b6c…",
      docSlug: "dal",
      name: "Dal",
      category: "indian",
      ingredients: [{ item: "red lentils", amount: "1", unit: "cup" }],
      steps: ["Rinse."],
      estimatedTime: null,
      serves: null,
      tags: null,
      notes: null,
      stepIngredients: [[0]],
      rawDocText: "Dal…",
      extractionError: null,
      syncedAt: new Date("2026-10-01T12:00:00Z"),
    });
    expect(read).toEqual({
      ok: true,
      value: {
        name: "Dal",
        ingredients: [{ item: "red lentils", amount: "1", unit: "cup" }],
        steps: ["Rinse."],
        estimatedTime: null,
        serves: null,
        tags: null,
        notes: null,
        stepIngredients: [[0]],
      },
    });
  });

  it("reads a payload that leaves fields out, and keeps a malformed mapping for the converter", () => {
    const read = readLegacyRecipe({ name: "Toast", steps: ["Toast."], stepIngredients: "[[0]]" });
    expect(read).toEqual({
      ok: true,
      value: { name: "Toast", steps: ["Toast."], stepIngredients: "[[0]]" },
    });
  });

  it.each([
    [
      "a numeric amount",
      { name: "A", ingredients: [{ item: "flour", amount: 2, unit: "cup" }] },
      "ingredients.0.amount",
    ],
    ["ingredients not a list", { name: "A", ingredients: "flour" }, "ingredients"],
    ["a step not a string", { name: "A", steps: [3] }, "steps.0"],
    [
      "a line with a key the type doesn't have",
      { name: "A", ingredients: [{ item: "x", qty: "1" }] },
      "ingredients.0",
    ],
    ["no name", { steps: ["Mix."] }, "name"],
    ["not an object", "Dal", "(root)"],
  ])("refuses %s, naming where", (_case, data, path) => {
    const read = readLegacyRecipe(data);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.issues.map((i) => i.path)).toEqual([path]);
  });
});

describe("title suffixes become tags (slice S, S-D11)", () => {
  it("strips a vocabulary suffix from the title and adds it to the tags", () => {
    const { recipe } = convertOk(legacy({ name: "Dal and rice (holiday)", tags: ["quick"] }));
    expect(recipe.title).toBe("Dal and rice");
    expect(recipe.tags).toEqual(["quick", "holiday"]);
  });

  it("adds tags to a recipe that had none, in title order", () => {
    const { recipe } = convertOk(legacy({ name: "Spaghetti al limone (summer) (holiday)", tags: undefined }));
    expect(recipe.title).toBe("Spaghetti al limone");
    expect(recipe.tags).toEqual(["summer", "holiday"]);
  });

  it("doesn't add a tag the recipe already has, in any case", () => {
    const { recipe } = convertOk(legacy({ name: "Egg curry (holiday)", tags: ["Holiday", "quick"] }));
    expect(recipe.tags).toEqual(["Holiday", "quick"]);
  });

  it("keeps any other parenthetical in the title, and adds no tags key it didn't have", () => {
    const { recipe } = convertOk(legacy({ name: "Lentil stew (Indian-spiced)", tags: undefined }));
    expect(recipe.title).toBe("Lentil stew (Indian-spiced)");
    expect(recipe.tags).toBeUndefined();
  });

  it("leaves the stored name as it was", () => {
    const input = legacy({ name: "Black bean soup (holiday)" });
    convertOk(input);
    expect(input.name).toBe("Black bean soup (holiday)");
  });
});

describe("B5c-6: count_unit, ranges, containers, rate lines, and the 18 fixture count-noun lines", () => {
  it("converts the 18 fixture count-noun lines (cloves 10, head 2, sprig 2, can 2, inch 2 as written)", () => {
    const fixtureLines: ChatRecipeIngredient[] = [
      // cloves × 10
      { item: "garlic", amount: "2", unit: "cloves" },
      { item: "garlic, minced", amount: "4", unit: "cloves" },
      { item: "garlic", amount: "2", unit: "cloves" },
      { item: "garlic", amount: "4", unit: "cloves" },
      { item: "garlic", amount: "3", unit: "cloves" },
      { item: "garlic, minced", amount: "2", unit: "cloves" },
      { item: "garlic, thinly sliced", amount: "4", unit: "cloves" },
      { item: "garlic", amount: "3", unit: "cloves" },
      { item: "garlic, minced", amount: "3", unit: "cloves" },
      { item: "garlic, grated", amount: "4", unit: "cloves" },
      // head × 2
      { item: "little gem lettuce", amount: "1", unit: "head" },
      { item: "garlic", amount: "1", unit: "head" },
      // sprigs × 2
      { item: "thyme", amount: "4", unit: "sprigs" },
      { item: "rosemary", amount: "2", unit: "sprigs" },
      // can × 2
      { item: "crushed tomatoes", amount: "1", unit: "can (14 oz)" },
      { item: "whole tomatoes", amount: "1", unit: "can (28 oz)" },
      // inch × 2 (as written)
      { item: "ginger, grated", amount: "1", unit: "inch" },
      { item: "ginger, grated", amount: "1", unit: "inch" },
    ];
    expect(fixtureLines).toHaveLength(18);
    const { recipe, report } = convertOk(legacy({ ingredients: fixtureLines }));
    expect(report.counts.count).toBe(16);
    expect(report.counts.as_written).toBe(2);
    for (let i = 0; i < 10; i++) {
      expect(recipe.ingredients[i]!.qty_canonical.count_unit).toEqual({
        one: "clove",
        other: "cloves",
      });
    }
    expect(recipe.ingredients[10]!.qty_canonical).toEqual({
      count: 1,
      count_unit: { one: "head", other: "heads" },
    });
    expect(recipe.ingredients[12]!.qty_canonical).toEqual({
      count: 4,
      count_unit: { one: "sprig", other: "sprigs" },
    });
    expect(recipe.ingredients[14]!.qty_canonical).toEqual({
      count: 1,
      count_unit: { one: "can (14 oz)", other: "cans (14 oz)" },
    });
    expect(recipe.ingredients[15]!.qty_canonical).toEqual({
      count: 1,
      count_unit: { one: "can (28 oz)", other: "cans (28 oz)" },
    });
    expect(recipe.ingredients[16]!.qty_canonical).toEqual({ as_written: "1 inch" });
    expect(recipe.ingredients[17]!.qty_canonical).toEqual({ as_written: "1 inch" });
  });

  it("converts measured and count ranges (P29)", () => {
    expect(oneLine({ item: "oil", amount: "2-3", unit: "tbsp" }).ingredient).toEqual({
      id: "ing-0",
      name: "oil",
      qty_canonical: { volume_ml: 2 * 14.787, range_max: 3 * 14.787 },
      display_equivalents: { imperial: { unit: "tbsp", amount: 2, amount_max: 3 } },
    });
    expect(oneLine({ item: "beef", amount: "1.5 to 2", unit: "lb" }).ingredient).toEqual({
      id: "ing-0",
      name: "beef",
      qty_canonical: { mass_g: 1.5 * 453.592, range_max: 2 * 453.592 },
      display_equivalents: { imperial: { unit: "lb", amount: 1.5, amount_max: 2 } },
    });
    expect(oneLine({ item: "salt", amount: "2½–3", unit: "tsp" }).ingredient).toEqual({
      id: "ing-0",
      name: "salt",
      qty_canonical: { volume_ml: 2.5 * 4.929, range_max: 3 * 4.929 },
      display_equivalents: { imperial: { unit: "tsp", amount: 2.5, amount_max: 3 } },
    });
    expect(oneLine({ item: "chiles", amount: "8-10" }).ingredient).toEqual({
      id: "ing-0",
      name: "chiles",
      qty_canonical: { count: 8, range_max: 10 },
    });
    expect(oneLine({ item: "garlic", amount: "4-5", unit: "cloves" }).ingredient).toEqual({
      id: "ing-0",
      name: "garlic",
      qty_canonical: { count: 4, range_max: 5, count_unit: { one: "clove", other: "cloves" } },
    });
    // One end fails round-trip: stays as written.
    expect(oneLine({ item: "milk", amount: "0.33-1", unit: "cup" }).ingredient).toEqual({
      id: "ing-0",
      name: "milk",
      qty_canonical: { as_written: "0.33-1 cup" },
    });
  });

  it("converts containers and sized containers (C6 through P26)", () => {
    expect(oneLine({ item: "beer", amount: "12 oz", unit: "bottle" }).ingredient).toEqual({
      id: "ing-0",
      name: "beer",
      qty_canonical: { count: 1, count_unit: { one: "bottle (12 oz)", other: "bottles (12 oz)" } },
    });
    expect(oneLine({ item: "12 oz bottle beer" }).ingredient).toEqual({
      id: "ing-0",
      name: "beer",
      qty_canonical: { count: 1, count_unit: { one: "bottle (12 oz)", other: "bottles (12 oz)" } },
    });
    expect(
      oneLine({ item: "cannellini beans, rinsed", amount: "2 (14-ounce)", unit: "cans" }).ingredient,
    ).toEqual({
      id: "ing-0",
      name: "cannellini beans, rinsed",
      qty_canonical: { count: 2, count_unit: { one: "can (14-ounce)", other: "cans (14-ounce)" } },
    });
    expect(
      oneLine({ item: "spring greens", amount: "1", unit: "large bag" }).ingredient,
    ).toEqual({
      id: "ing-0",
      name: "spring greens",
      qty_canonical: { count: 1, count_unit: { one: "large bag", other: "large bags" } },
    });
    expect(
      oneLine({ item: "store-bought dumplings", amount: "1", unit: "package" }).ingredient,
    ).toEqual({
      id: "ing-0",
      name: "store-bought dumplings",
      qty_canonical: { count: 1, count_unit: { one: "package", other: "packages" } },
    });
  });

  it("marks true rate lines fixed ('per <unit or share word>'), while '(6 oz each)' and 'for frying' stay linear", () => {
    expect(oneLine({ item: "egg per person", amount: "1" }).ingredient).toEqual({
      id: "ing-0",
      name: "egg per person",
      qty_canonical: { count: 1 },
      scaling: "fixed",
    });
    expect(
      oneLine({ item: "salt per pound of meat", amount: "1", unit: "tsp" }).ingredient,
    ).toEqual({
      id: "ing-0",
      name: "salt per pound of meat",
      qty_canonical: { volume_ml: 4.929 },
      display_equivalents: { imperial: { unit: "tsp", amount: 1 } },
      scaling: "fixed",
    });
    // Negative row: "(6 oz each)" is the size of one, not a rate and not a second quantity.
    const breasts = oneLine({ item: "chicken breasts (6 oz each)", amount: "4" }).ingredient;
    expect(breasts).toEqual({
      id: "ing-0",
      name: "chicken breasts (6 oz each)",
      qty_canonical: { count: 4 },
    });
    expect(breasts).not.toHaveProperty("scaling");
    // Accepted outside the rate rule: "2 cups olive oil, for frying" scales linearly.
    const fryingOil = oneLine({ item: "olive oil, for frying", amount: "2", unit: "cups" }).ingredient;
    expect(fryingOil).toEqual({
      id: "ing-0",
      name: "olive oil, for frying",
      qty_canonical: { volume_ml: 2 * 236.588 },
      display_equivalents: { imperial: { unit: "cup", amount: 2 } },
    });
    expect(fryingOil).not.toHaveProperty("scaling");
  });
});
