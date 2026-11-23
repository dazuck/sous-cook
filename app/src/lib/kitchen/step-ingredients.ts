/**
 * Per-step ingredient resolution for kitchen mode.
 *
 * Recipes carry a flat ingredient list and a flat list of steps. The "You'll
 * need" panel shown on each cooking step needs to know WHICH ingredients belong
 * to the current step. There are two sources for that mapping, in priority
 * order:
 *
 *   1. Explicit `stepIngredients` — an array (parallel to `steps`) of ingredient
 *      indices, assigned by the import LLM, which understands phrases like "add
 *      the dry ingredients" or "stir in the sauce". This is authoritative.
 *   2. Fuzzy regex fallback (`findStepIngredients`) — used only for legacy
 *      recipes and JSON-LD imports that lack an explicit mapping. It is purely
 *      syntactic (word-boundary matching) and therefore approximate.
 *
 * These functions are pure (no React, no DB) so they can be unit-tested and
 * scored against a labeled corpus without pulling in browser dependencies.
 */

import type { ChatRecipeIngredient } from "../../../drizzle/schema";

/**
 * Parse an ingredient string into amount and name components.
 * e.g., "2 cups flour" → { amount: "2 cups", name: "flour" }
 *       "1/2 tsp salt" → { amount: "1/2 tsp", name: "salt" }
 *       "Salt to taste" → { amount: null, name: "Salt to taste" }
 *
 * Only for matching a step's words to an ingredient's name (the plan stays on
 * the legacy recipe, B4 decision 6). No amount on screen comes from here: the
 * cook page reads amounts from the pack recipe (`ingredient-display.ts`).
 */
export function parseIngredient(ingredient: string): {
  amount: string | null;
  name: string;
} {
  const trimmed = ingredient.trim();

  // Common unit patterns (with optional plural 's')
  const unitPattern =
    /^([\d\s¼-¾⅐-⅞/]+)\s*(tsp|tbsp|cup|cups|oz|lb|lbs|g|kg|ml|l|teaspoon|teaspoons|tablespoon|tablespoons|ounce|ounces|pound|pounds|gram|grams|kilogram|kilograms|milliliter|milliliters|liter|liters|cloves?|heads?|bunche?s?|slices?|pieces?|cans?|packages?|sticks?|sprigs?|pinch|pinches|dash|dashes)?\s+(.+)$/i;

  // First try pattern: number + optional unit + name
  const match = trimmed.match(unitPattern);
  if (match) {
    const [, quantity, unit, name] = match;
    const amount = unit
      ? `${quantity.trim()} ${unit.toLowerCase()}`
      : quantity.trim();
    return { amount, name: name.trim() };
  }

  // Try pattern: just a number at the start (e.g., "3 large eggs")
  const numberOnlyMatch = trimmed.match(/^([\d\s¼-¾⅐-⅞/]+)\s+(.+)$/);
  if (numberOnlyMatch) {
    const [, quantity, name] = numberOnlyMatch;
    return { amount: quantity.trim(), name: name.trim() };
  }

  // No amount found
  return { amount: null, name: trimmed };
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOP_WORDS = new Set(["and", "the", "for", "with"]);

/**
 * Whether an ingredient string is plausibly referenced by a step.
 * Fuzzy: matches if any significant word (3+ chars, not a stop word) of the
 * ingredient name appears as a whole word (allowing a trailing plural 's') in
 * the step text. This is the legacy/fallback heuristic — approximate by design.
 */
function ingredientMatchesStep(stepLower: string, ingredient: string): boolean {
  const { name } = parseIngredient(ingredient);
  const words = name.toLowerCase().split(/\s+/);

  for (const word of words) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    const wordPattern = new RegExp(`\\b${escapeRegex(word)}s?\\b`, "i");
    if (wordPattern.test(stepLower)) return true;
  }
  return false;
}

/**
 * Find ingredients mentioned in this step via fuzzy word matching.
 * Legacy fallback used when no explicit per-step mapping exists.
 */
export function findStepIngredients(
  step: string | undefined,
  ingredients: string[],
): string[] {
  if (!step) return [];
  const stepLower = step.toLowerCase();
  return ingredients.filter((ingredient) =>
    ingredientMatchesStep(stepLower, ingredient),
  );
}

/**
 * Converts a ChatRecipeIngredient to its display string.
 * Example: { item: "flour", amount: "2", unit: "cups" } => "2 cups flour"
 */
export function ingredientToString(ing: ChatRecipeIngredient): string {
  const parts: string[] = [];
  if (ing.amount) parts.push(ing.amount);
  if (ing.unit) parts.push(ing.unit);
  parts.push(ing.item);
  return parts.join(" ");
}

/**
 * Resolve the ingredient INDICES for a given step.
 *
 * Prefers the explicit per-step mapping when present for this step; otherwise
 * falls back to fuzzy regex matching. Returned indices are sanitized:
 * de-duplicated, integer, and within bounds of `ingredientStrings`.
 *
 * @param stepIndex - index of the step in `steps`
 * @param steps - the recipe's ordered step strings
 * @param ingredientStrings - the recipe's ingredients pre-formatted as strings,
 *   in the same order the explicit indices refer to
 * @param stepIngredients - optional explicit mapping (parallel to `steps`)
 */
export function resolveStepIngredientIndices(
  stepIndex: number,
  steps: string[],
  ingredientStrings: string[],
  stepIngredients?: number[][],
): number[] {
  const explicit = stepIngredients?.[stepIndex];
  if (explicit !== undefined) {
    const seen = new Set<number>();
    const result: number[] = [];
    for (const i of explicit) {
      if (
        Number.isInteger(i) &&
        i >= 0 &&
        i < ingredientStrings.length &&
        !seen.has(i)
      ) {
        seen.add(i);
        result.push(i);
      }
    }
    return result;
  }

  // Fallback: fuzzy match, returning indices to keep the contract index-based.
  const step = steps[stepIndex];
  if (!step) return [];
  const stepLower = step.toLowerCase();
  const result: number[] = [];
  ingredientStrings.forEach((ingredient, i) => {
    if (ingredientMatchesStep(stepLower, ingredient)) result.push(i);
  });
  return result;
}
