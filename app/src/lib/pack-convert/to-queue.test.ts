import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePack, type Recipe } from "@sous/pack";
import { ingredientLine } from "../kitchen/ingredient-display";
import { legacyToPackRecipe } from "./convert";
import { packRecipeToQueueData, packSource } from "./to-queue";

const FANNIE_FILE = fileURLToPath(new URL("../../../../packs/drafts/fannie-farmer-1896.pack.json", import.meta.url));

function fannie() {
  const parsed = parsePack(JSON.parse(readFileSync(FANNIE_FILE, "utf8")));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

function project(recipe: Recipe, packId = "fannie-farmer-1896") {
  const result = packRecipeToQueueData(recipe, packId);
  if (!result.ok) throw new Error(`refused: ${result.differences.join("; ")}`);
  return result.projection;
}

/** A recipe with one step that uses every line. */
function recipe(ingredients: Recipe["ingredients"], over: Partial<Recipe> = {}): Recipe {
  return {
    id: "r",
    title: "R",
    serves_base: 4,
    ingredients,
    steps: [{ id: "s", type: "action", text: "Mix it all.", ingredient_refs: ingredients.map((i) => i.id) }],
    ...over,
  };
}

describe("packRecipeToQueueData: the Fannie Farmer pack (the gate)", () => {
  const pack = fannie();

  it.each(pack.recipes.map((r) => [r.id, r] as const))("projects %s, and it reads back as the cook sees it", (_, r) => {
    const { recipeData, servesEstimate } = project(r);
    const back = legacyToPackRecipe(recipeData, { id: r.id, ...(servesEstimate && { servesEstimate }) });
    if (!back.ok) throw new Error("expected it to read back");
    // Each line's displayed amount, as the cook page shows it, is the pack's.
    r.ingredients.forEach((ingredient, i) => {
      const read = back.recipe.ingredients[i]!;
      if (ingredient.display_equivalents === undefined && ingredient.qty_canonical.count === undefined) return;
      expect(ingredientLine(read)).toMatchObject({
        kind: ingredientLine(ingredient).kind,
        amount: (ingredientLine(ingredient) as { amount: string }).amount,
      });
    });
    expect(back.recipe.steps.map((s) => s.text)).toEqual(r.steps.map((s) => s.text));
    expect(back.recipe.serves_base).toBe(r.serves_base);
    expect(back.recipe.serves_estimated).toBe(r.serves_estimated);
    expect(recipeData.source).toBe(`pack:fannie-farmer-1896/${r.id}`);
  });

  it("keeps Thin White Sauce's amounts as the pack states them", () => {
    const sauce = pack.recipes.find((r) => r.id === "thin-white-sauce")!;
    const { recipeData } = project(sauce);
    expect(recipeData.ingredients).toEqual([
      { item: "Butter", amount: "2", unit: "tbsp" },
      { item: "Flour", amount: "1.5", unit: "tbsp" },
      { item: "Milk", amount: "1", unit: "cup" },
      { item: "Salt", amount: "0.25", unit: "tsp" },
      // Only a canonical 0.1 g: the pack states no amount the app can show.
      { item: "Pepper" },
    ]);
  });

  it("stores Fannie's estimated counts beside the row, not in it", () => {
    const { recipeData, servesEstimate } = project(pack.recipes[0]!);
    expect(recipeData.serves).toBeUndefined();
    expect(servesEstimate).toEqual({
      count: 12,
      basis: "From the pack fannie-farmer-1896: it gives 12 as Sous's estimate.",
    });
  });

  it("logs what it drops: step types and titles, refs, a second hint, and a line with no amount to show", () => {
    const sauce = pack.recipes.find((r) => r.id === "thin-white-sauce")!;
    const { dropped } = project(sauce);
    expect(dropped).toContain("step 5 (beat-until-smooth): type checkpoint");
    expect(dropped).toContain('step 0 (scald-the-milk): title "Scald the milk"');
    expect(dropped).toContain("step 0 (scald-the-milk): commons:scalding-milk");
    expect(dropped).toContain("step 0 (scald-the-milk): state:milk-scalded");
    expect(dropped).toContain("butter (Butter): its metric hint (28 g)");
    expect(dropped).toContain(
      "pepper (Pepper): no stated amount the app can show (only a canonical amount); projected with none",
    );
  });
});

describe("packRecipeToQueueData: each kind of line", () => {
  it("projects a count, an as-written line, to taste and unstated, and each reads back", () => {
    const { recipeData } = project(
      recipe([
        { id: "eggs", name: "eggs", qty_canonical: { count: 3 } },
        { id: "chili", name: "chili flakes", qty_canonical: { as_written: "a pinch of" } },
        { id: "salt", name: "salt", qty_canonical: { to_taste: true } },
        { id: "oil", name: "oil for the pan", qty_canonical: { unstated: true } },
      ]),
    );
    expect(recipeData.ingredients).toEqual([
      { item: "eggs", amount: "3" },
      { item: "chili flakes", amount: "a pinch of" },
      { item: "salt", amount: "to taste" },
      { item: "oil for the pan" },
    ]);
  });

  it("maps step refs to the stored lines' indexes", () => {
    const { recipeData } = project(
      recipe(
        [
          { id: "a", name: "flour", qty_canonical: { mass_g: 120 }, display_equivalents: { imperial: { unit: "cup", amount: 1 } } },
          { id: "b", name: "eggs", qty_canonical: { count: 2 } },
        ],
        {
          steps: [
            { id: "s1", type: "action", text: "Beat the eggs.", ingredient_refs: ["b"] },
            { id: "s2", type: "action", text: "Fold in the flour.", ingredient_refs: ["a", "b"] },
          ],
        },
      ),
    );
    expect(recipeData.stepIngredients).toEqual([[1], [0, 1]]);
    expect(recipeData.source).toBe(packSource("fannie-farmer-1896", "r"));
  });

  it("carries the stated times, a stated count, the tags and the notes", () => {
    const { recipeData, servesEstimate } = project(
      recipe([{ id: "eggs", name: "eggs", qty_canonical: { count: 2 } }], {
        time_active_min: 10,
        time_total_min: 40,
        tags: ["breakfast"],
        creator_notes: ["Keeps a day.", "Doubles well."],
      }),
    );
    expect(recipeData).toMatchObject({
      estimatedTime: { active: 10, total: 40 },
      serves: 4,
      tags: ["breakfast"],
      notes: "Keeps a day.\n\nDoubles well.",
    });
    expect(servesEstimate).toBeNull();
  });

  it("logs a timer the text doesn't give, and queues anyway", () => {
    const { dropped } = project(
      recipe([{ id: "eggs", name: "eggs", qty_canonical: { count: 2 } }], {
        steps: [{ id: "s", type: "wait", text: "Let it rest.", timer_sec: 600, ingredient_refs: ["eggs"] }],
      }),
    );
    expect(dropped).toContain("step 0 (s): timer_sec 600, the text gives null");
    expect(dropped).toContain("step 0 (s): type wait");
  });
});

describe("packRecipeToQueueData: the guard refuses what wouldn't read back", () => {
  it("refuses a line whose stated hint reads back as something else", () => {
    // Words that read as a number: the pack shows "2" as written, and the
    // stored line "2" would read back as a count of 2.
    const result = packRecipeToQueueData(
      recipe([{ id: "herbs", name: "sprigs of thyme", qty_canonical: { as_written: "2" } }]),
      "p",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.differences.join("; ")).toMatch(/line 0 \(herbs\): shows .* reads back/);
  });

  it("refuses a title the converter would read differently", () => {
    const result = packRecipeToQueueData(
      recipe([{ id: "eggs", name: "eggs", qty_canonical: { count: 2 } }], { title: "Egg curry (holiday)" }),
      "p",
    );
    expect(result).toEqual({ ok: false, differences: ['title "Egg curry (holiday)" reads back "Egg curry"'] });
  });
});
