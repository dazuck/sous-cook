import { describe, it, expect } from "vitest";
import type { Ingredient } from "@sous/pack";
import {
  howMuch,
  ingredientLine,
  ingredientText,
  servingsText,
  storedIngredientLines,
} from "./ingredient-display";
import { representationsFor } from "@sous/pack/quantity";
import { legacyToPackRecipe } from "../pack-convert/convert";

/** The pack ingredients the converter makes from these legacy lines. */
function converted(
  ...lines: { item: string; amount?: string; unit?: string }[]
): Ingredient[] {
  const result = legacyToPackRecipe(
    { name: "Test", ingredients: lines, steps: ["Cook."], serves: 4 },
    { id: "test" },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.recipe.ingredients;
}

function lineOf(line: { item: string; amount?: string; unit?: string }) {
  return ingredientLine(converted(line)[0]);
}

describe("ingredientLine: a measured line shows the number the source states", () => {
  it("an imperial volume: its stated amount, then today's other units computed", () => {
    expect(lineOf({ item: "olive oil", amount: "2", unit: "tbsp" })).toEqual({
      kind: "amount",
      amount: "2 tbsp",
      name: "olive oil",
      stated: [{ unit: "tbsp", value: "2" }],
      conversions: [
        { unit: "ml", value: "29.6" },
        { unit: "tsp", value: "6" },
        { unit: "cup", value: "⅛" },
      ],
    });
  });

  it("a metric mass: grams stated, ounces and pounds computed in kitchen fractions", () => {
    expect(lineOf({ item: "flour", amount: "500", unit: "g" })).toEqual({
      kind: "amount",
      amount: "500 g",
      name: "flour",
      stated: [{ unit: "g", value: "500" }],
      conversions: [
        { unit: "oz", value: "17⅝" },
        { unit: "lb", value: "1⅛" },
      ],
    });
  });

  // B4 step 0, call 8: a stated equivalent after the unit is a hint, and it
  // must never show unscaled. The app draws at 1× until B5, where the chip
  // says the stated amount and the popover both stated rows. 1⅔ is stored as
  // 1 + 2/3 (1.6666666666666665) and still reads 1⅔.
  it.each<[{ item: string; amount?: string; unit?: string }, string]>([
    [{ item: "softened unsalted butter", amount: "1⅔", unit: "cups (213g)" }, "softened unsalted butter"],
    [{ item: "1⅔ cups (213g) all-purpose flour" }, "all-purpose flour"],
  ])("1⅔ cups (213g) %j reads 1⅔ cups and 213 g at 1×", (line, name) => {
    expect(converted(line)[0].display_equivalents?.imperial?.amount).toBe(1 + 2 / 3);
    expect(lineOf(line)).toMatchObject({
      kind: "amount",
      amount: "1⅔ cups",
      name,
      stated: [
        { unit: "cup", value: "1⅔" },
        { unit: "g", value: "213" },
      ],
    });
  });

  // B5's scaled path (the pack's representationsFor) shows each stated hint × scale,
  // so the grams double with the cups: 426 g, not 213.
  it.each<[number, string[]]>([
    [1, ["1⅔ cups", "213 g"]],
    [2, ["3⅓ cups", "426 g"]],
  ])("1⅔ cups (213g) at %d× reads %j", (scale, texts) => {
    const [butter] = converted({ item: "softened unsalted butter", amount: "1⅔", unit: "cups (213g)" });
    if (butter.qty_canonical === undefined) throw new Error("butter has no quantity");
    expect(
      representationsFor({ ...butter, qty_canonical: butter.qty_canonical }, scale, "imperial").map(
        (form) => form.text,
      ),
    ).toEqual(texts);
  });

  it("the source's spelling of a unit reads in the table's label, cups plural", () => {
    expect(lineOf({ item: "stock", amount: "1 1/2", unit: "cups" })).toMatchObject({
      kind: "amount",
      amount: "1½ cups",
    });
    expect(lineOf({ item: "sugar", amount: "1", unit: "tablespoon" })).toMatchObject({
      kind: "amount",
      amount: "1 tbsp",
    });
  });

  it("a cross-system compound: imperial in the chip, both stated, each dimension's others computed", () => {
    expect(lineOf({ item: "butter", amount: "1", unit: "cup (225 g)" })).toEqual({
      kind: "amount",
      amount: "1 cup",
      name: "butter",
      stated: [
        { unit: "cup", value: "1" },
        { unit: "g", value: "225" },
      ],
      conversions: [
        { unit: "ml", value: "237" },
        { unit: "tbsp", value: "16" },
        { unit: "tsp", value: "48" },
        { unit: "oz", value: "7⅞" },
        { unit: "lb", value: "½" },
      ],
    });
  });

  it("a same-dimension compound: both stated as the source says them, never one from the other", () => {
    const line = lineOf({ item: "potatoes", amount: "1.2", unit: "kg (2 1/2 lb)" });
    expect(line).toMatchObject({
      kind: "amount",
      amount: "2½ lb",
      stated: [
        { unit: "lb", value: "2½" },
        { unit: "kg", value: "1.2" },
      ],
    });
    // 1200 g is 2⅝ lb: the chip keeps the source's 2½, and lb is no conversion row.
    expect(line.kind === "amount" && line.conversions.map((c) => c.unit)).toEqual([
      "g",
      "oz",
    ]);
  });

  it("a metric-only line: its one hint is the chip", () => {
    expect(lineOf({ item: "milk", amount: "250", unit: "ml" })).toMatchObject({
      amount: "250 ml",
      stated: [{ unit: "ml", value: "250" }],
    });
  });
});

describe("ingredientLine: lines with no measure", () => {
  it("a count: with count_unit in the amount, or bare with the item as the name", () => {
    expect(lineOf({ item: "garlic", amount: "3", unit: "cloves" })).toEqual({
      kind: "count",
      amount: "3 cloves",
      name: "garlic",
    });
    expect(lineOf({ item: "lemon, zested", amount: "1/2" })).toEqual({
      kind: "count",
      amount: "½",
      name: "lemon, zested",
    });
  });

  it("as written: the source's words verbatim, never a number", () => {
    expect(lineOf({ item: "chili flakes", amount: "a pinch of" })).toEqual({
      kind: "as_written",
      amount: "a pinch of",
      name: "chili flakes",
    });
  });

  it("to taste and unstated: the name alone", () => {
    expect(lineOf({ item: "black pepper, to taste" })).toEqual({
      kind: "to_taste",
      name: "black pepper, to taste",
    });
    expect(lineOf({ item: "crusty bread, to serve" })).toEqual({
      kind: "unstated",
      name: "crusty bread, to serve",
    });
  });
});

describe("ingredientLine: a name that is only the line's own amount shows the amount once (B4 fix round 3)", () => {
  it("a blank item with an amount: a count, the source's words, a measure", () => {
    expect(lineOf({ item: "", amount: "3" })).toEqual({ kind: "count", amount: "3", name: "" });
    expect(lineOf({ item: "", amount: "a pinch" })).toEqual({
      kind: "as_written",
      amount: "a pinch",
      name: "",
    });
    expect(lineOf({ item: " ", amount: "2", unit: "g" })).toMatchObject({
      kind: "amount",
      amount: "2 g",
      name: "",
    });
  });

  it("an imported line that is only a measure keeps its kind and conversions", () => {
    expect(lineOf({ item: "2 g" })).toEqual({
      kind: "amount",
      amount: "2 g",
      name: "",
      stated: [{ unit: "g", value: "2" }],
      conversions: [{ unit: "oz", value: "0.07" }],
    });
    expect(lineOf({ item: "1 l" })).toMatchObject({
      kind: "amount",
      name: "",
      stated: [{ unit: "l", value: "1" }],
    });
    expect(lineOf({ item: "1 cup (225 g)" })).toMatchObject({
      kind: "amount",
      amount: "1 cup",
      name: "",
      stated: [
        { unit: "cup", value: "1" },
        { unit: "g", value: "225" },
      ],
    });
  });

  it("a name that reads as a different amount than the line's is a name, kept", () => {
    expect(
      ingredientLine({
        id: "ing-0",
        name: "2 g",
        qty_canonical: { mass_g: 5 },
        display_equivalents: { metric: { unit: "g", amount: 5 } },
      }),
    ).toMatchObject({ amount: "5 g", name: "2 g" });
    expect(
      ingredientLine({ id: "ing-1", name: "3", qty_canonical: { count: 2 } }),
    ).toEqual({ kind: "count", amount: "2", name: "3" });
    expect(
      ingredientLine({ id: "ing-2", name: "a pinch", qty_canonical: { as_written: "a dash" } }),
    ).toEqual({ kind: "as_written", amount: "a dash", name: "a pinch" });
  });

  it("the Ask's context says the amount once, with no trailing space", () => {
    const lines = converted(
      { item: "", amount: "3" },
      { item: "2 g" },
      { item: "", amount: "a pinch" },
    ).map((ing) => ingredientLine(ing));
    expect(lines.map(ingredientText)).toEqual(["3", "2 g", "a pinch"]);
  });
});

describe("ingredientLine: a measured line it can't show truthfully throws", () => {
  it("no display hint: the converter always writes one, so this is a contract break", () => {
    expect(() =>
      ingredientLine({ id: "ing-0", name: "flour", qty_canonical: { mass_g: 500 } }),
    ).toThrow("ing-0 (flour): a measured line with no stated amount to show");
  });

  it("a hint in a unit the reader doesn't know", () => {
    expect(() =>
      ingredientLine({
        id: "ing-2",
        name: "milk",
        qty_canonical: { volume_ml: 946 },
        display_equivalents: { imperial: { unit: "quart", amount: 1 } },
      }),
    ).toThrow("ing-2 (milk): a measured line with no stated amount to show");
  });
});

describe("ingredientText: one line for the Ask's context", () => {
  it("the amount the cook sees, then the name; the name alone when there is none", () => {
    const lines = converted(
      { item: "olive oil", amount: "2", unit: "tbsp" },
      { item: "garlic", amount: "3", unit: "cloves" },
      { item: "chili flakes", amount: "a pinch of" },
      { item: "salt, to taste" },
      { item: "crusty bread, to serve" },
    ).map((ing) => ingredientLine(ing));
    expect(lines.map(ingredientText)).toEqual([
      "2 tbsp olive oil",
      "3 cloves garlic",
      "a pinch of chili flakes",
      "salt, to taste",
      "crusty bread, to serve",
    ]);
  });
});

describe("howMuch: the Ingredients sheet's line for a line with no number", () => {
  it.each([
    ["a phrase", { item: "chili flakes", amount: "a pinch of" }, "as written"],
    ["to taste in the amount", { item: "salt", amount: "to taste" }, "to taste — start small"],
    ["no amount", { item: "bread, to serve" }, "the recipe doesn't say"],
  ])("%s says how much", (_case, line, said) => {
    expect(howMuch(lineOf(line))).toBe(said);
  });

  // B4 fix round 1: a name that already says "to taste" isn't told so again.
  it.each(["salt and pepper to taste", "black pepper, to taste", "Salt, To Taste"])(
    "%s: no second line",
    (item) => {
      const line = lineOf({ item });
      expect(line.kind).toBe("to_taste");
      expect(howMuch(line)).toBeNull();
    },
  );

  it("a line with a number has none", () => {
    expect(howMuch(lineOf({ item: "olive oil", amount: "2", unit: "tbsp" }))).toBeNull();
    expect(howMuch(lineOf({ item: "eggs", amount: "2" }))).toBeNull();
  });

  // B4 fix round 2 (LOW): a line that is only an amount shows that amount,
  // never "the recipe doesn't say"; once, not beside itself (fix round 3).
  it.each<[string, { item: string; amount?: string; unit?: string }, string, string]>([
    ["a count with its noun", { item: "3 cloves" }, "3 cloves", ""],
    ["an amount-only range", { item: "2-3 tbsp" }, "2–3 tbsp", ""],
    ["a measure", { item: "2 g" }, "2 g", ""],
    ["a measure with a blank item", { item: "", amount: "2", unit: "cups" }, "2 cups", ""],
  ])("only an amount, %s: shown as that amount", (_case, stored, amount, name) => {
    const line = lineOf(stored);
    expect(line).toMatchObject({ amount, name });
    expect(howMuch(line)).toBeNull();
  });
});

describe("storedIngredientLines: the lines by the index a stored plan holds", () => {
  function recipeOf(lines: { item: string; amount?: string; unit?: string }[]) {
    const result = legacyToPackRecipe(
      { name: "Test", ingredients: lines, steps: ["Cook."], serves: 4 },
      { id: "test" },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.recipe;
  }

  it("one line per stored line, in order", () => {
    const stored = [{ item: "eggs", amount: "2" }, { item: "salt" }];
    expect(storedIngredientLines(recipeOf(stored), stored.length).map((l) => l?.name)).toEqual([
      "eggs",
      "salt",
    ]);
  });

  // B4 fix round 2: the converter skips a blank stored line, so the stored
  // index i is the line whose id is ing-<i>, not the i-th converted line.
  it("a blank stored line is a gap, and every later line keeps its stored index", () => {
    const stored = [
      { item: "eggs", amount: "2" },
      { item: "  " },
      { item: "salt" },
      { item: "" },
    ];
    expect(storedIngredientLines(recipeOf(stored), stored.length).map((l) => l?.name ?? null)).toEqual([
      "eggs",
      null,
      "salt",
      null,
    ]);
  });
});

describe("servingsText: a serving count, and whose it is (slice B4b)", () => {
  it("a stated count reads as the source's", () => {
    expect(servingsText({ serves_base: 4 })).toBe("serves 4");
  });

  it("Sous's estimate carries the mark", () => {
    expect(servingsText({ serves_base: 4, serves_estimated: true })).toBe("serves 4 (Sous's estimate)");
  });

  it("scaling an estimated count keeps the mark at every scale", () => {
    const estimated = { serves_base: 4, serves_estimated: true as const };
    expect(servingsText(estimated, 2)).toBe("serves 2 (Sous's estimate)");
    expect(servingsText(estimated, 8)).toBe("serves 8 (Sous's estimate)");
    expect(servingsText(estimated, 12)).toBe("serves 12 (Sous's estimate)");
  });

  it("a scaled stated count never gains the mark", () => {
    expect(servingsText({ serves_base: 4 }, 8)).toBe("serves 8");
  });
});

describe("ingredientLine: v0.7 range_max and count_unit through readScaledCanonical", () => {
  it("shows both bounds of a measured range and never the low end alone", () => {
    const line = ingredientLine({
      id: "ing-0",
      name: "olive oil",
      qty_canonical: { volume_ml: 29.574, range_max: 44.361 },
      display_equivalents: {
        imperial: { unit: "tbsp", amount: 2, amount_max: 3 },
      },
    });
    expect(line).toMatchObject({
      kind: "amount",
      amount: "2–3 tbsp",
      name: "olive oil",
      stated: [{ unit: "tbsp", value: "2–3" }],
    });
    if (line.kind === "amount") {
      expect(line.conversions).toContainEqual({ unit: "ml", value: "29.6–44.4" });
      expect(line.conversions).toContainEqual({ unit: "tsp", value: "6–9" });
    }
  });

  it("shows both bounds of a count range and includes count_unit", () => {
    expect(
      ingredientLine({
        id: "ing-0",
        name: "garlic, minced",
        qty_canonical: {
          count: 2,
          range_max: 4,
          count_unit: { one: "clove", other: "cloves" },
        },
      }),
    ).toEqual({
      kind: "count",
      amount: "2–4 cloves",
      name: "garlic, minced",
    });
    expect(
      ingredientLine({
        id: "ing-1",
        name: "garlic, minced",
        qty_canonical: {
          count: 1,
          count_unit: { one: "clove", other: "cloves" },
        },
      }),
    ).toEqual({
      kind: "count",
      amount: "1 clove",
      name: "garlic, minced",
    });
  });
});

describe("ingredientLine: B5c scaling, popover rows per dimension, and as-written note", () => {
  it("scales a cross-system compound per dimension from each first stated hint while keeping Recipe says unscaled", () => {
    const [butter] = converted({ item: "butter", amount: "1", unit: "cup (200 g)" });
    const scaled = ingredientLine(butter, 2, 4);
    expect(scaled).toEqual({
      kind: "amount",
      amount: "2 cups",
      name: "butter",
      servesBase: 4,
      stated: [
        { unit: "cup", value: "1" },
        { unit: "g", value: "200" },
      ],
      conversions: [
        { unit: "ml", value: "473" },
        { unit: "tbsp", value: "32" },
        { unit: "tsp", value: "96" },
        { unit: "oz", value: "14⅛" },
        { unit: "lb", value: "⅞" },
      ],
    });
  });

  it("uses B5c-7 kitchen fallbacks on missed cup and lb fractions", () => {
    const [flour] = converted({ item: "flour", amount: "1¼", unit: "cups" });
    expect(ingredientLine(flour, 2 / 3, 6)).toMatchObject({
      kind: "amount",
      amount: "¾ cup + 4 tsp",
      name: "flour",
      servesBase: 6,
      stated: [{ unit: "cup", value: "1¼" }],
    });

    const [beef] = converted({ item: "chuck roast", amount: "2", unit: "lb" });
    expect(ingredientLine(beef, 2 / 3, 6)).toMatchObject({
      kind: "amount",
      amount: "1 lb + 5¼ oz",
      name: "chuck roast",
      servesBase: 6,
      stated: [{ unit: "lb", value: "2" }],
    });
  });

  it("drops imperial conversion rows below their kitchen floor while keeping metric in the popover", () => {
    const [spice] = converted({ item: "cayenne", amount: "⅛", unit: "tsp" });
    const quartered = ingredientLine(spice, 0.25, 4);
    expect(quartered).toEqual({
      kind: "amount",
      amount: "a pinch",
      name: "cayenne",
      servesBase: 4,
      stated: [{ unit: "tsp", value: "⅛" }],
      conversions: [{ unit: "ml", value: "0.2" }],
    });
  });

  it("gives a rounded count line an exact popover and keeps exact whole/half counts without one", () => {
    const [tortillas] = converted({ item: "corn tortillas", amount: "8" });
    expect(ingredientLine(tortillas, 2 / 3, 6)).toEqual({
      kind: "count",
      amount: "about 5",
      name: "corn tortillas",
      exact: "5⅓",
    });
    expect(ingredientLine(tortillas, 0.5, 6)).toEqual({
      kind: "count",
      amount: "4",
      name: "corn tortillas",
    });

    const [garlic] = converted({ item: "garlic", amount: "8", unit: "cloves" });
    expect(ingredientLine(garlic, 2 / 3, 6)).toEqual({
      kind: "count",
      amount: "about 5 cloves",
      name: "garlic",
      exact: "5⅓",
    });
  });

  it("keeps scaling: fixed lines at 1× regardless of multiplier", () => {
    const fixedOil: Ingredient = {
      id: "ing-0",
      name: "peanut oil, for frying",
      qty_canonical: { volume_ml: 1900 },
      display_equivalents: { metric: { unit: "l", amount: 1.9 } },
      scaling: "fixed",
    };
    expect(ingredientLine(fixedOil, 2, 4)).toEqual(ingredientLine(fixedOil, 1));
  });

  it("marks as_written lines with servesBase when scaled so howMuch says 'as written, for N'", () => {
    const [chili] = converted({ item: "chili flakes", amount: "a pinch of" });
    const unscaled = ingredientLine(chili, 1, 4);
    const scaled = ingredientLine(chili, 2, 4);
    expect(howMuch(unscaled)).toBe("as written");
    expect(howMuch(scaled)).toBe("as written, for 4");
  });

  it("storedIngredientLines scales linear lines and leaves fixed lines untouched", () => {
    const result = legacyToPackRecipe(
      {
        name: "Test",
        serves: 4,
        ingredients: [
          { item: "garlic", amount: "3", unit: "cloves" },
          { item: "salt", amount: "1", unit: "tsp per lb" },
        ],
        steps: ["Cook."],
      },
      { id: "test" },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const linesAt8 = storedIngredientLines(result.recipe, 2, 8);
    expect(linesAt8[0]).toMatchObject({ kind: "count", amount: "6 cloves", name: "garlic" });
    expect(linesAt8[1]).toMatchObject({ kind: "amount", amount: "1 tsp", name: "per lb salt" });
  });
});

