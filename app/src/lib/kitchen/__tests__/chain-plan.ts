import { COOK_PLAN_VERSION, type CookPlan, type RecipeForPlan } from "../cook-plan";

/**
 * One cook task per step, in order: the simplest plan the validator accepts
 * for a recipe, so tests can hold a current plan without a model call.
 */
export function chainPlan(recipe: RecipeForPlan): CookPlan {
  const steps = recipe.steps ?? [];
  return {
    version: COOK_PLAN_VERSION,
    tasks: steps.map((text, i) => ({
      id: `s${i}`,
      kind: "cook" as const,
      text,
      label: `step ${i + 1}`,
      ingredientIdx: recipe.stepIngredients?.[i] ?? [],
      sourceStep: i,
      implied: false,
      needs: i === 0 ? [] : [`s${i - 1}`],
      branch: "Main",
    })),
  };
}
