import { describe, expect, it } from "vitest";
import { buildGetOut, getOutName, parseSimpleAmount } from "./get-out";
import { storedIngredientLines, type StoredIngredientLines } from "./ingredient-display";
import { loadCookPlanFixtures } from "./__tests__/load-cook-plan-fixtures";
import { legacyToPackRecipe } from "../pack-convert/convert";

describe("getOutName", () => {
  it("strips parentheticals, prep clauses, and leading count units and capitalizes cleanly", () => {
    expect(getOutName("potatoes (about 1.5 lb), peeled and halved")).toBe("Potatoes");
    expect(getOutName("bunch spinach")).toBe("Spinach");
    expect(getOutName("red onion, thinly sliced")).toBe("Red onion");
    expect(getOutName("cloves garlic")).toBe("Garlic");
    expect(getOutName("can (28 oz) whole tomatoes")).toBe("Whole tomatoes");
    expect(getOutName("crusty bread, to serve")).toBe("Crusty bread");
    expect(getOutName("unsalted butter, softened")).toBe("Unsalted butter");
  });
});

describe("buildGetOut", () => {
  const fixtures = loadCookPlanFixtures();

  it("classifies Sunday Roast Dinner fixture into fridge, pantry, and equipment with parentheticals stripped", () => {
    const roast = fixtures.find((f) => f.name === "sunday-roast-dinner");
    expect(roast).toBeDefined();

    const model = buildGetOut({
      ingredients: roast!.recipe.ingredients,
      steps: roast!.recipe.steps,
    });

    expect(model.equipment).toEqual([
      "Pot",
      "Roasting pan",
      "Second roasting tin",
      "Thermometer",
    ]);

    expect(model.fridge).toEqual([
      {
        index: 0,
        key: "whole chicken",
        bare: "Whole chicken",
        amount: "1",
        withAmount: "1 whole chicken",
      },
      {
        index: 2,
        key: "lemon",
        bare: "Lemon",
        amount: "1",
        withAmount: "1 lemon",
      },
      {
        index: 3,
        key: "garlic",
        bare: "Garlic",
        amount: "1 head",
        withAmount: "1 head garlic",
      },
      {
        index: 4,
        key: "thyme",
        bare: "Thyme",
        amount: "4 sprigs",
        withAmount: "4 sprigs thyme",
      },
      {
        index: 6,
        key: "floury potatoes",
        bare: "Floury potatoes",
        amount: "1.2 kg",
        withAmount: "1.2 kg floury potatoes",
      },
      {
        index: 7,
        key: "duck fat",
        bare: "Duck fat",
        amount: "4 tbsp",
        withAmount: "4 tbsp duck fat",
      },
      {
        index: 8,
        key: "rosemary",
        bare: "Rosemary",
        amount: "2 sprigs",
        withAmount: "2 sprigs rosemary",
      },
      {
        index: 9,
        key: "green beans",
        bare: "Green beans",
        amount: "300 g",
        withAmount: "300 g green beans",
      },
      {
        index: 10,
        key: "butter",
        bare: "Butter",
        amount: "1 tbsp",
        withAmount: "1 tbsp butter",
      },
      {
        index: 11,
        key: "shallot",
        bare: "Shallot",
        amount: "1",
        withAmount: "1 shallot",
      },
      {
        index: 13,
        key: "dry white wine",
        bare: "Dry white wine",
        amount: "1/2 cup",
        withAmount: "1/2 cup dry white wine",
      },
    ]);

    expect(model.pantry.map((i) => ({ index: i.index, bare: i.bare, amount: i.amount }))).toEqual([
      { index: 1, bare: "Flaky salt", amount: "1 tbsp" },
      { index: 5, bare: "Olive oil", amount: "3 tbsp" },
      { index: 12, bare: "Plain flour", amount: "1 tbsp" },
      { index: 14, bare: "Chicken stock", amount: "1 1/2 cups" },
      { index: 15, bare: "Salt and pepper", amount: null },
    ]);
  });

  it("classifies Weeknight Shakshuka ingredients and extracts 12-inch skillet", () => {
    const shakshuka = fixtures.find((f) => f.name === "weeknight-shakshuka");
    expect(shakshuka).toBeDefined();

    const model = buildGetOut({
      ingredients: shakshuka!.recipe.ingredients,
      steps: shakshuka!.recipe.steps,
    });

    expect(model.equipment).toEqual(["12-inch skillet"]);

    expect(model.fridge.map((i) => ({ index: i.index, bare: i.bare, amount: i.amount }))).toEqual([
      { index: 1, bare: "Onion", amount: "1" },
      { index: 2, bare: "Red bell peppers", amount: "2" },
      { index: 3, bare: "Garlic", amount: "3 cloves" },
      { index: 7, bare: "Whole tomatoes", amount: "1 can" },
      { index: 9, bare: "Eggs", amount: "6" },
      { index: 10, bare: "Feta", amount: "1/3 cup" },
      { index: 11, bare: "Parsley", amount: "2 tbsp" },
      { index: 12, bare: "Crusty bread", amount: null },
    ]);

    expect(model.pantry.map((i) => ({ index: i.index, bare: i.bare, amount: i.amount }))).toEqual([
      { index: 0, bare: "Olive oil", amount: "2 tbsp" },
      { index: 4, bare: "Ground cumin", amount: "1 tsp" },
      { index: 5, bare: "Sweet paprika", amount: "1 tsp" },
      { index: 6, bare: "Cayenne", amount: "1/4 tsp" },
      { index: 8, bare: "Salt", amount: "1/2 tsp" },
    ]);
  });

  it("classifies Lime Shrimp Tacos and Chewy Oat Cookies fixtures accurately", () => {
    const tacos = fixtures.find((f) => f.name === "lime-shrimp-tacos")!;
    const tacoOut = buildGetOut({
      ingredients: tacos.recipe.ingredients,
      steps: tacos.recipe.steps,
    });

    expect(tacoOut.equipment).toEqual(["Large skillet"]);
    expect(tacoOut.pantry.map((i) => i.bare)).toEqual([
      "Olive oil",
      "Chili powder",
      "Cider vinegar",
      "Sugar",
      "Salt",
    ]);
    expect(tacoOut.fridge.map((i) => i.bare)).toEqual([
      "Shrimp",
      "Limes",
      "Garlic",
      "Red onion",
      "Cabbage",
      "Avocado",
      "Corn tortillas",
      "Cilantro leaves",
    ]);

    const cookies = fixtures.find((f) => f.name === "chewy-oat-cookies")!;
    const cookieOut = buildGetOut({
      ingredients: cookies.recipe.ingredients,
      steps: cookies.recipe.steps,
    });

    expect(cookieOut.equipment).toEqual(["2 sheet pans", "Parchment paper"]);
    expect(cookieOut.pantry.map((i) => i.bare)).toEqual([
      "Brown sugar",
      "White sugar",
      "Vanilla extract",
      "All-purpose flour",
      "Baking soda",
      "Salt",
    ]);
    expect(cookieOut.fridge.map((i) => i.bare)).toEqual([
      "Unsalted butter",
      "Eggs",
      "Rolled oats",
      "Raisins",
    ]);
  });

  it("deduplicates ingredients across sub-recipes, preserving first index and combining matching amounts", () => {
    const model = buildGetOut({
      ingredients: [
        { amount: "2", unit: "tbsp", item: "olive oil" },
        { amount: "2", unit: "cloves", item: "garlic, minced" },
        { amount: "1", unit: "bunch", item: "spinach" },
        { amount: "1", unit: "tbsp", item: "Olive oil (for drizzling)" },
        { amount: "3", unit: "cloves", item: "garlic, sliced" },
        { kind: "to_taste", name: "kosher salt and black pepper" },
        { kind: "unstated", name: "flaky salt, for finishing" },
      ],
    });

    expect(model.fridge).toEqual([
      {
        index: 1,
        key: "garlic",
        bare: "Garlic",
        amount: "5 cloves",
        withAmount: "5 cloves garlic",
      },
      {
        index: 2,
        key: "spinach",
        bare: "Spinach",
        amount: "1 bunch",
        withAmount: "1 bunch spinach",
      },
    ]);

    expect(model.pantry).toEqual([
      {
        index: 0,
        key: "olive oil",
        bare: "Olive oil",
        amount: "3 tbsp",
        withAmount: "3 tbsp olive oil",
      },
      {
        index: 5,
        key: "kosher salt and black pepper",
        bare: "Kosher salt and black pepper",
        amount: null,
        withAmount: "Kosher salt and black pepper",
      },
      {
        index: 6,
        key: "flaky salt",
        bare: "Flaky salt",
        amount: null,
        withAmount: "Flaky salt",
      },
    ]);
  });

  it("suppresses generic vessel names when a qualified vessel is matched and ignores basic utensils", () => {
    const model = buildGetOut({
      ingredients: [],
      steps: [
        "Use a sharp knife on a cutting board to dice the potatoes, then toss in a large bowl with tongs.",
        "Place chickpeas in a medium saucepan and cover with water. Simmer in the saucepan or pot until tender.",
        "Arrange chicken on two sheet pans (or a single sheet pan if small) and roast in the oven.",
        "Blend the tahini in a food processor, then pass through a fine-mesh strainer using a spoon and spatula.",
      ],
      notes: [
        "A carbon steel pan or cast-iron skillet works best on the stove; check with a meat thermometer before serving on a plate.",
      ],
      taskTexts: [
        "Whisk dressing with a whisk in a medium bowl, then transfer to zip-top bags.",
      ],
    });

    expect(model.equipment).toEqual([
      "Large bowl",
      "Medium saucepan",
      "2 sheet pans",
      "Food processor",
      "Fine-mesh strainer",
      "Carbon steel pan",
      "Cast-iron skillet",
      "Meat thermometer",
      "Medium bowl",
      "Zip-top bags",
    ]);
  });
});

/**
 * What a Get out amount opens when tapped (asked 2026-11-22): the conversions its line opens
 * on a step screen, from the same lines the step's pairs read (`storedIngredientLines`).
 */
describe("buildGetOut: what an amount opens", () => {
  function linesOf(
    lines: { item: string; amount?: string; unit?: string }[],
    servings?: number,
    serves = 4,
  ): StoredIngredientLines {
    const result = legacyToPackRecipe({ name: "Test", ingredients: lines, steps: ["Cook."], serves }, { id: "test" });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return storedIngredientLines(result.recipe, lines.length, servings);
  }
  const itemsOf = (lines: StoredIngredientLines) => {
    const model = buildGetOut({ ingredients: lines });
    return new Map([...model.fridge, ...model.pantry].map((it) => [it.key, it]));
  };

  it("a measured line opens what its pair opens on a step: its stated amount and the same conversions", () => {
    const lines = linesOf([
      { item: "toor dal", amount: "1", unit: "cup" },
      { item: "flour", amount: "500", unit: "g" },
    ]);
    const items = itemsOf(lines);
    for (const [key, line] of [["toor dal", lines[0]], ["flour", lines[1]]] as const) {
      if (line?.kind !== "amount") throw new Error(`${key} is not a measured line`);
      expect(line.conversions.length, key).toBeGreaterThan(0);
      expect(items.get(key)!.amount).toBe(line.amount);
      expect(items.get(key)!.opens).toEqual({ stated: line.stated, conversions: line.conversions });
    }
  });

  it("scaled, it opens the scaled line: the scaled conversions under what the recipe says for its own count", () => {
    const lines = linesOf([{ item: "toor dal", amount: "1", unit: "cup" }], 8);
    const line = lines[0];
    if (line?.kind !== "amount") throw new Error("not a measured line");
    const item = itemsOf(lines).get("toor dal")!;
    expect(item.amount).toBe("2 cups");
    expect(item.opens).toEqual({ stated: [{ unit: "cup", value: "1" }], conversions: line.conversions, servesBase: 4 });
    expect(item.opens!.conversions).toContainEqual({ unit: "tbsp", value: "32" });
  });

  it("a scaled count that rounding moved opens its exact count, as its pair does; any other count is plain", () => {
    // 4 eggs for 3, cooked for 4: 5⅓, shown as "about 5".
    const scaled = linesOf([{ item: "eggs", amount: "4" }], 4, 3);
    const eggs = scaled[0];
    if (eggs?.kind !== "count" || eggs.exact === undefined) throw new Error(`eggs did not round: ${JSON.stringify(eggs)}`);
    expect(eggs.exact).toBe("5⅓");
    expect(itemsOf(scaled).get("eggs")!.opens).toEqual({ stated: [], conversions: [], exact: "5⅓" });
    const plain = itemsOf(linesOf([{ item: "eggs", amount: "2" }])).get("eggs")!;
    expect(plain.amount).toBe("2");
    expect(plain.opens).toBeUndefined();
  });

  it("the source's own words, a line with no amount and a line of another shape are plain", () => {
    const items = itemsOf(linesOf([{ item: "ginger", amount: "1", unit: "inch" }, { item: "flaky salt" }]));
    expect(items.get("ginger")!.amount).not.toBeNull();
    expect(items.get("ginger")!.opens).toBeUndefined();
    expect(items.get("flaky salt")!.amount).toBeNull();
    expect(items.get("flaky salt")!.opens).toBeUndefined();
    const legacy = buildGetOut({ ingredients: [{ amount: "2", unit: "tbsp", item: "olive oil" }] });
    expect(legacy.pantry[0].amount).toBe("2 tbsp");
    expect(legacy.pantry[0].opens).toBeUndefined();
  });

  it("a line named twice in one unit opens the conversions of the sum it shows", () => {
    const lines = linesOf([
      { item: "butter", amount: "2", unit: "tbsp" },
      { item: "onion", amount: "1" },
      { item: "butter, for the pan", amount: "1", unit: "tbsp" },
    ]);
    const item = itemsOf(lines).get("butter")!;
    expect(item.amount).toBe("3 tbsp");
    // 3 tbsp: 44.4 ml, 9 tsp, and 3/16 cup at the nearest kitchen fraction; no "Recipe says", since the recipe says two amounts.
    expect(item.opens).toEqual({
      stated: [],
      conversions: [
        { unit: "ml", value: "44.4" },
        { unit: "tsp", value: "9" },
        { unit: "cup", value: expect.any(String) },
      ],
    });
    // The same rows a single 3 tbsp line shows.
    const single = linesOf([{ item: "butter", amount: "3", unit: "tbsp" }])[0];
    if (single?.kind !== "amount") throw new Error("not a measured line");
    expect(item.opens!.conversions).toEqual(single.conversions);
  });

  it("one of the merged lines states the only amount: it opens what that line opens", () => {
    const lines = linesOf([{ item: "olive oil, for drizzling" }, { item: "olive oil", amount: "2", unit: "tbsp" }]);
    const line = lines[1];
    if (line?.kind !== "amount") throw new Error("not a measured line");
    const item = itemsOf(lines).get("olive oil")!;
    expect(item.amount).toBe("2 tbsp");
    expect(item.opens).toEqual({ stated: line.stated, conversions: line.conversions });
  });

  it("merged amounts that don't add up to one measure stay plain: two units, counts, the source's words", () => {
    // Two units: both amounts are said, side by side (review round 1: the first alone understated it).
    const mixed = itemsOf(
      linesOf([
        { item: "butter", amount: "1", unit: "cup" },
        { item: "butter", amount: "2", unit: "tbsp" },
      ]),
    ).get("butter")!;
    expect(mixed.amount).toBe("1 cup + 2 tbsp");
    expect(mixed.withAmount).toBe("1 cup + 2 tbsp butter");
    expect(mixed.opens).toBeUndefined();
    // Counts add up to a count, which has nothing to convert.
    const counts = itemsOf(linesOf([{ item: "eggs", amount: "2" }, { item: "eggs", amount: "1" }])).get("eggs")!;
    expect(counts.amount).toBe("3");
    expect(counts.opens).toBeUndefined();
    // A measure and the source's own words.
    const words = itemsOf(
      linesOf([
        { item: "ginger", amount: "1", unit: "tbsp" },
        { item: "ginger", amount: "1", unit: "inch" },
      ]),
    ).get("ginger")!;
    expect(words.opens).toBeUndefined();
  });

  it("two lines of 1½ tbsp add up to 3 tbsp and open the sum's conversions (review round 1: it read 1 with the unit \"½ tbsp\" and showed \"2 ½ tbsp\")", () => {
    const lines = linesOf([
      { item: "butter", amount: "1½", unit: "tbsp" },
      { item: "butter, for the pan", amount: "1½", unit: "tbsp" },
    ]);
    expect(lines[0]).toMatchObject({ kind: "amount", amount: "1½ tbsp" });
    const item = itemsOf(lines).get("butter")!;
    expect(item.amount).toBe("3 tbsp");
    const single = linesOf([{ item: "butter", amount: "3", unit: "tbsp" }])[0];
    if (single?.kind !== "amount") throw new Error("not a measured line");
    expect(item.opens).toEqual({ stated: [], conversions: single.conversions });
  });
});

describe("parseSimpleAmount: one number and one unit, or nothing", () => {
  const read = (text: string) => parseSimpleAmount(text);

  it("reads whole numbers, decimals and typed fractions, as before", () => {
    expect(read("2 tbsp")).toEqual({ value: 2, unit: "tbsp" });
    expect(read("3")).toEqual({ value: 3, unit: "" });
    expect(read("1.5 lb")).toEqual({ value: 1.5, unit: "lb" });
    expect(read("1/2 cup")).toEqual({ value: 0.5, unit: "cup" });
    expect(read("1 1/2 cups")).toEqual({ value: 1.5, unit: "cups" });
    expect(read("  2   Cloves ")).toEqual({ value: 2, unit: "cloves" });
    // A unit that carries its own size is still one unit.
    expect(read("1 14-oz can")).toEqual({ value: 1, unit: "14-oz can" });
  });

  it("reads a fraction glyph alone, every one of them", () => {
    const glyphs: [string, number][] = [
      ["¼", 1 / 4], ["½", 1 / 2], ["¾", 3 / 4],
      ["⅐", 1 / 7], ["⅑", 1 / 9], ["⅒", 1 / 10],
      ["⅓", 1 / 3], ["⅔", 2 / 3],
      ["⅕", 1 / 5], ["⅖", 2 / 5], ["⅗", 3 / 5], ["⅘", 4 / 5],
      ["⅙", 1 / 6], ["⅚", 5 / 6],
      ["⅛", 1 / 8], ["⅜", 3 / 8], ["⅝", 5 / 8], ["⅞", 7 / 8],
    ];
    for (const [glyph, value] of glyphs) {
      const got = read(`${glyph} cup`);
      expect(got?.unit, glyph).toBe("cup");
      expect(got?.value, glyph).toBeCloseTo(value, 10);
    }
  });

  it("reads a whole number with a fraction glyph as one number, set tight or with a space", () => {
    expect(read("1½ tbsp")).toEqual({ value: 1.5, unit: "tbsp" });
    expect(read("1 ½ tbsp")).toEqual({ value: 1.5, unit: "tbsp" });
    expect(read("2⅞ cups")).toEqual({ value: 2.875, unit: "cups" });
    expect(read("10¼")).toEqual({ value: 10.25, unit: "" });
    expect(read("3⅜ lb")).toEqual({ value: 3.375, unit: "lb" });
  });

  it("reads nothing where the words are more than one number and one unit", () => {
    for (const text of [
      "",
      "a pinch",
      "about ¼ cup",
      "¾ cup + 4 tsp",
      "1 cup + 2 tbsp",
      "1-2 cups",
      "1–2 cups",
      "1 to 2 cups",
      "1½-2 cups",
      "1 or 2",
      "0 cups",
      "½½ cup",
      "1/0 cup",
    ]) {
      expect(read(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe("buildGetOut: an ingredient named on several lines", () => {
  const amountOf = (rows: { item: string; amount?: string; unit?: string }[]) => {
    const model = buildGetOut({ ingredients: rows });
    const [item] = [...model.fridge, ...model.pantry];
    return item;
  };

  it("adds up amounts in one unit, fraction glyphs and mixed numbers included", () => {
    expect(amountOf([{ item: "butter", amount: "1½", unit: "tbsp" }, { item: "butter", amount: "1½", unit: "tbsp" }]).amount).toBe("3 tbsp");
    expect(amountOf([{ item: "milk", amount: "⅜", unit: "cup" }, { item: "milk", amount: "⅝", unit: "cup" }]).amount).toBe("1 cup");
    expect(amountOf([{ item: "cream", amount: "⅞", unit: "cup" }, { item: "cream", amount: "1⅛", unit: "cups" }]).amount).toBe("2 cup");
    expect(amountOf([{ item: "eggs", amount: "2" }, { item: "eggs", amount: "1" }]).amount).toBe("3");
    expect(amountOf([{ item: "garlic", amount: "2", unit: "cloves" }, { item: "garlic", amount: "3", unit: "clove" }]).amount).toBe("5 cloves");
  });

  it("says amounts that don't add up side by side, each whole, never one for all of them", () => {
    // Compound amounts (a scaled line's "¾ cup + 4 tsp"): each as written, not "1.5 cup + 4 tsp".
    const compound = amountOf([
      { item: "milk", amount: "¾ cup + 4 tsp" },
      { item: "milk", amount: "¾ cup + 4 tsp" },
    ]);
    expect(compound.amount).toBe("¾ cup + 4 tsp + ¾ cup + 4 tsp");
    expect(compound.withAmount).toBe("¾ cup + 4 tsp + ¾ cup + 4 tsp milk");
    expect(compound.opens).toBeUndefined();
    // Two units.
    expect(amountOf([{ item: "butter", amount: "1", unit: "cup" }, { item: "butter", amount: "2", unit: "tbsp" }]).amount).toBe("1 cup + 2 tbsp");
    // A range is not a number to add.
    expect(amountOf([{ item: "stock", amount: "1-2", unit: "cups" }, { item: "stock", amount: "1-2", unit: "cups" }]).amount).toBe("1-2 cups + 1-2 cups");
    // Words.
    expect(amountOf([{ item: "ginger", amount: "1", unit: "tbsp" }, { item: "ginger", amount: "a thumb" }]).amount).toBe("1 tbsp + a thumb");
  });

  it("adds a later line into the amount in its unit, wherever that stands", () => {
    expect(
      amountOf([
        { item: "butter", amount: "1", unit: "cup" },
        { item: "butter", amount: "2", unit: "tbsp" },
        { item: "butter", amount: "1", unit: "tbsp" },
        { item: "butter", amount: "½", unit: "cup" },
      ]).amount,
    ).toBe("1.5 cup + 3 tbsp");
    expect(
      amountOf([
        { item: "milk", amount: "about ¼ cup" },
        { item: "milk", amount: "1", unit: "cup" },
        { item: "milk", amount: "1", unit: "cup" },
      ]).amount,
    ).toBe("about ¼ cup + 2 cup");
  });

  it("one amount among lines with none is that amount, as written", () => {
    expect(amountOf([{ item: "olive oil" }, { item: "olive oil", amount: "1½", unit: "tbsp" }, { item: "olive oil" }]).amount).toBe("1½ tbsp");
  });
});
