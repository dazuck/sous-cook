/**
 * The ids the converter (`convert.ts`) gives a legacy recipe's lines: stored
 * ingredient i is `ing-<i>`, stored step i is `step-<i>`. A stored CookPlan
 * names lines by stored index, and the converter skips a blank stored line
 * (B4 fix round 2), so a stored index is looked up by id here, never by
 * position in the converted lists. Kept apart from the converter so the cook
 * page can read them without loading it.
 */

import type { Ingredient, Recipe, Step } from "@sous/pack";

/** The id of the stored ingredient line at `index`. */
export function ingredientId(index: number): string {
  return `ing-${index}`;
}

/** The id of the stored step at `index`. */
export function stepId(index: number): string {
  return `step-${index}`;
}

/**
 * The converted ingredient for the stored line at `index`. Undefined for a
 * blank line the converter skipped, or an index past the list.
 */
export function ingredientAt(recipe: Recipe, index: number): Ingredient | undefined {
  const id = ingredientId(index);
  return recipe.ingredients.find((ingredient) => ingredient.id === id);
}

/** The converted step for the stored step at `index`; undefined as for `ingredientAt`. */
export function stepAt(recipe: Recipe, index: number): Step | undefined {
  const id = stepId(index);
  return recipe.steps.find((step) => step.id === id);
}
