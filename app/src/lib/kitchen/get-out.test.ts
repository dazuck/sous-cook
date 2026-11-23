import { describe, expect, it } from "vitest";
import { buildGetOut, getOutName } from "./get-out";
import { loadCookPlanFixtures } from "./__tests__/load-cook-plan-fixtures";

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
