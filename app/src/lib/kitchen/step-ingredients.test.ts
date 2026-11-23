import { describe, it, expect } from "vitest";
import {
  parseIngredient,
  findStepIngredients,
  ingredientToString,
  resolveStepIngredientIndices,
} from "./step-ingredients";

describe("parseIngredient", () => {
  it("splits a quantity + unit + name", () => {
    expect(parseIngredient("2 cups flour")).toEqual({
      amount: "2 cups",
      name: "flour",
    });
  });

  it("splits a fractional quantity + unit + name", () => {
    expect(parseIngredient("1/2 tsp salt")).toEqual({
      amount: "1/2 tsp",
      name: "salt",
    });
  });

  it("handles a bare number with no unit", () => {
    expect(parseIngredient("3 large eggs")).toEqual({
      amount: "3",
      name: "large eggs",
    });
  });

  it("keeps a multi-word descriptor in the name (non-standard unit)", () => {
    // "center-cut" is not a unit, so the count stays as the amount and the
    // full descriptor stays in the name.
    expect(parseIngredient("2 center-cut salmon fillets")).toEqual({
      amount: "2",
      name: "center-cut salmon fillets",
    });
  });

  it("returns a null amount for unquantified ingredients", () => {
    expect(parseIngredient("Salt to taste")).toEqual({
      amount: null,
      name: "Salt to taste",
    });
  });

  it("normalizes unit casing", () => {
    expect(parseIngredient("2 TBSP olive oil")).toEqual({
      amount: "2 tbsp",
      name: "olive oil",
    });
  });

  it("parses a unicode-fraction quantity", () => {
    expect(parseIngredient("¼ cup sugar")).toEqual({
      amount: "¼ cup",
      name: "sugar",
    });
  });
});

describe("findStepIngredients (fuzzy fallback)", () => {
  const ingredients = [
    "2 tbsp olive oil",
    "3 cloves garlic",
    "1 lb salmon",
    "2 cups flour",
    "1 tsp baking soda",
    "Salt to taste",
  ];

  it("matches ingredients named directly in the step", () => {
    expect(
      findStepIngredients(
        "Heat the olive oil and sauté the garlic",
        ingredients,
      ),
    ).toEqual(["2 tbsp olive oil", "3 cloves garlic"]);
  });

  it("misses abstractions like 'the dry ingredients' (known limitation)", () => {
    // This is precisely the failure mode the LLM mapping fixes. The fuzzy
    // matcher is purely syntactic, so an abstract phrase matches nothing.
    expect(
      findStepIngredients("Whisk the dry ingredients", ingredients),
    ).toEqual([]);
  });

  it("returns an empty list for an undefined step", () => {
    expect(findStepIngredients(undefined, ingredients)).toEqual([]);
  });

  it("ignores short words and stop words", () => {
    // "to" / "the" should never trigger a match on their own.
    expect(findStepIngredients("Bring to a boil", ingredients)).toEqual([]);
  });
});

describe("ingredientToString", () => {
  it("joins amount, unit, and item", () => {
    expect(
      ingredientToString({ item: "flour", amount: "2", unit: "cups" }),
    ).toBe("2 cups flour");
  });

  it("omits missing amount and unit", () => {
    expect(ingredientToString({ item: "salt" })).toBe("salt");
  });

  it("includes amount when unit is absent", () => {
    expect(ingredientToString({ item: "eggs", amount: "3" })).toBe("3 eggs");
  });
});

describe("resolveStepIngredientIndices", () => {
  const steps = [
    "Whisk the dry ingredients",
    "Heat the olive oil",
    "Plate and serve",
  ];
  const ingredientStrings = [
    "2 cups flour",
    "1 tsp baking soda",
    "2 tbsp olive oil",
    "Fresh parsley",
  ];

  it("uses the explicit mapping when present for the step", () => {
    const stepIngredients = [[0, 1], [2], []];
    expect(
      resolveStepIngredientIndices(
        0,
        steps,
        ingredientStrings,
        stepIngredients,
      ),
    ).toEqual([0, 1]);
  });

  it("de-duplicates and drops out-of-bounds / non-integer indices", () => {
    const stepIngredients = [[0, 0, 1, 9, -1, 1.5], [], []];
    expect(
      resolveStepIngredientIndices(
        0,
        steps,
        ingredientStrings,
        stepIngredients,
      ),
    ).toEqual([0, 1]);
  });

  it("honors an explicit empty array (no fallback)", () => {
    // Step 0 names "dry ingredients" which the fuzzy matcher would miss anyway,
    // but the contract is: an explicit [] means "nothing for this step".
    const stepIngredients = [[], [2], []];
    expect(
      resolveStepIngredientIndices(
        0,
        steps,
        ingredientStrings,
        stepIngredients,
      ),
    ).toEqual([]);
  });

  it("falls back to fuzzy matching when the mapping is absent entirely", () => {
    // Step 1 ("Heat the olive oil") fuzzy-matches the olive oil at index 2.
    expect(resolveStepIngredientIndices(1, steps, ingredientStrings)).toEqual([
      2,
    ]);
  });

  it("falls back to fuzzy matching when the mapping omits this step index", () => {
    // stepIngredients has only one entry; step index 1 is undefined → fuzzy.
    const stepIngredients = [[0, 1]];
    expect(
      resolveStepIngredientIndices(
        1,
        steps,
        ingredientStrings,
        stepIngredients,
      ),
    ).toEqual([2]);
  });

  it("returns indices, not strings, from the fuzzy fallback", () => {
    // Sanity: the fallback returns indices into ingredientStrings.
    const result = resolveStepIngredientIndices(1, steps, ingredientStrings);
    expect(result.every((i) => Number.isInteger(i))).toBe(true);
  });
});
