import { describe, expect, it } from "vitest";
import { identityPlan, parseCookPlan, type CookPlan } from "../../kitchen/cook-plan";
import {
  loadCookPlanFixtures,
  loadCookPlanSnapshots,
  recipeHash,
} from "../../kitchen/__tests__/load-cook-plan-fixtures";
import { loadStepIngredientFixtures } from "../../kitchen/__tests__/load-step-ingredient-fixtures";
import { legacyToPackRecipe } from "../convert";
import { fixtureServesEstimate } from "../../kitchen/__tests__/fixture-serves-estimates";

// Slice B4 decision 6, the index proof: conversion is positional, so every
// index a stored CookPlan holds still names the same line in the pack recipe.
// Run over the 15 committed eval fixtures and the plans derived from them.
// The CookPlan keeps reading the legacy recipe; the pack recipe only has to
// line up with it.

const fixtures = loadCookPlanFixtures();
const snapshots = loadCookPlanSnapshots();
const mappings = new Map(loadStepIngredientFixtures().map((f) => [f.name, f]));

describe("the 15-snapshot index proof", () => {
  it("covers every committed fixture, each with its snapshot", () => {
    expect(fixtures).toHaveLength(15);
    for (const fixture of fixtures) expect(snapshots.has(fixture.name), fixture.name).toBe(true);
  });

  let parsedPlans = 0;
  let mapped = 0;

  it.each(fixtures.map((f) => [f.name, f] as const))("%s", (_name, fixture) => {
    const hashBefore = recipeHash(fixture.recipe);
    const stepFixture = mappings.get(fixture.name);
    const stepIngredients =
      stepFixture !== undefined &&
      JSON.stringify(stepFixture.steps) === JSON.stringify(fixture.recipe.steps) &&
      JSON.stringify(stepFixture.ingredients) === JSON.stringify(fixture.recipe.ingredients)
        ? stepFixture.golden
        : undefined;

    const result = legacyToPackRecipe(
      { name: fixture.name, ...fixture.recipe, stepIngredients },
      { id: fixture.name, servesEstimate: fixtureServesEstimate(fixture.name) },
    );
    if (!result.ok) throw new Error(`${fixture.name}: ${JSON.stringify(result.issues)}`);
    const { recipe, report } = result;
    const legacy = fixture.recipe;

    expect(recipe.steps).toHaveLength(legacy.steps.length);
    expect(recipe.ingredients).toHaveLength(legacy.ingredients.length);
    recipe.steps.forEach((step, i) => {
      expect(step.id).toBe(`step-${i}`);
      expect(step.text).toBe(legacy.steps[i]);
    });
    recipe.ingredients.forEach((ingredient, i) => {
      expect(ingredient.id).toBe(`ing-${i}`);
      // The item verbatim, after a folded count noun when there is one.
      expect(ingredient.name.endsWith(legacy.ingredients[i]!.item)).toBe(true);
    });

    if (stepIngredients !== undefined) {
      mapped += 1;
      expect(report.mapping).toBe("used");
      recipe.steps.forEach((step, i) => {
        expect(step.ingredient_refs).toEqual(
          [...new Set(stepIngredients[i])].map((index) => `ing-${index}`),
        );
      });
    } else {
      expect(report.mapping).toBe("absent");
    }

    const snapshot = snapshots.get(fixture.name)!;
    const parsed = parseCookPlan(snapshot.raw, legacy);
    if (parsed.ok) parsedPlans += 1;
    const plan: CookPlan = parsed.ok ? parsed.plan : identityPlan(legacy);
    for (const task of plan.tasks) {
      if (task.sourceStep !== null) {
        const step = recipe.steps[task.sourceStep];
        expect(step, `${task.id} sourceStep`).toBeDefined();
        expect(step!.text).toBe(legacy.steps[task.sourceStep]);
      }
      for (const index of task.ingredientIdx) {
        const ingredient = recipe.ingredients[index];
        expect(ingredient, `${task.id} ingredientIdx`).toBeDefined();
        expect(ingredient!.id).toBe(`ing-${index}`);
        expect(ingredient!.name.endsWith(legacy.ingredients[index]!.item)).toBe(true);
      }
    }

    // The derive input is unchanged: conversion never touches the legacy recipe.
    expect(recipeHash(fixture.recipe)).toBe(hashBefore);
    expect(recipeHash(fixture.recipe)).toBe(snapshot.recipeHash);
  });

  it("checked real derived plans, and every fixture that has a mapping", () => {
    expect(parsedPlans).toBeGreaterThanOrEqual(14);
    expect(mapped).toBe(8);
  });
});
