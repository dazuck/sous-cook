/**
 * A pack-file recipe entering the kitchen queue (slice S, S-D12): projected
 * into the legacy shape the queue already stores, behind a round-trip guard.
 *
 * Why a projection: B4 decision 2 keeps one stored shape, so a rollback to
 * R19 stays safe and the CookPlan derivation reads the input it always has; a
 * stored pack variant would make every reader branch, and a pointer into the
 * pack would let a pack edit change a cook already under way (a queued recipe
 * is a snapshot). B5 reads a `pack:` row's pack recipe natively (PLAN B5's
 * must-do), keyed by `source`.
 *
 * The guard: the projection, read back through the converter the cook page
 * uses (`legacyToPackRecipe`), must show the cook what the pack recipe
 * shows: the same title, each line's amount, name and kind
 * (`ingredientLine`: the stated hint for a measured line, a count's number,
 * the as-written words), the same step texts, the same refs, the same
 * serving count and its mark. Anything else is a refusal with the
 * differences named; nothing is queued.
 *
 * What it drops, logged and never refused: step types, titles, technique,
 * state and media refs, a `timer_sec` that differs from the one the text
 * gives, an ingredient's prep, a measured line's second stated hint, and a
 * measured line with no stated amount the app can show (the pack keeps only
 * a canonical amount), which projects as a line with no amount, as the app
 * would show it (B4 decision 3: only source-stated numbers).
 */

import type { Ingredient, Recipe } from "@sous/pack";
import { readScaledCanonical, scaledHints } from "@sous/pack/quantity";
import type { ChatRecipeIngredient, KitchenQueueRecipeData } from "../../../drizzle/schema";
import { ingredientLine, type IngredientLine } from "../kitchen/ingredient-display";
import { legacyToPackRecipe, type ServesEstimateInput } from "./convert";

export interface QueueProjection {
  recipeData: KitchenQueueRecipeData;
  /** Sous's estimate, stored beside the row as B4b's columns hold it; null for a stated count. */
  servesEstimate: ServesEstimateInput | null;
  /** What the projection left out, for the log. Never shown, never a refusal. */
  dropped: string[];
}

export type ProjectionResult =
  | { ok: true; projection: QueueProjection }
  | { ok: false; differences: string[] };

/** The queue row's `source` for a pack recipe: B5 finds the pack recipe again by it. */
export function packSource(packId: string, recipeId: string): string {
  return `pack:${packId}/${recipeId}`;
}

/** The queue row's `source` for an AI-adapted/converged recipe anchored to a pack recipe. */
export function adaptedPackSource(packId: string, recipeId: string): string {
  return `pack-adapted:${packId}/${recipeId}`;
}

/**
 * The pack and recipe a queue row's `source` names (`packSource`'s inverse),
 * or null for any other source: a household send, an import, the webhook,
 * or a malformed one.
 */
export function parsePackSource(
  source: unknown,
): { packId: string; recipeId: string; adapted?: boolean } | null {
  if (typeof source !== "string") return null;
  const match = /^(pack|pack-adapted):([^/\s]+)\/([^/\s]+)$/.exec(source);
  if (match === null) return null;
  return match[1] === "pack-adapted"
    ? { packId: match[2]!, recipeId: match[3]!, adapted: true }
    : { packId: match[2]!, recipeId: match[3]! };
}

/** A hint's number as the stored line writes it: plain decimals, no float noise. */
function amountText(amount: number): string {
  return String(Number(amount.toFixed(6)));
}

function spanText(low: number, high?: number): string {
  return high === undefined ? amountText(low) : `${amountText(low)}–${amountText(high)}`;
}

/** One pack line as the stored shape: its name, and the amount the cook sees, in words. */
function lineOf(ingredient: Ingredient, dropped: string[]): ChatRecipeIngredient {
  const canonical = readScaledCanonical(ingredient, 1);
  const label = `${ingredient.id} (${ingredient.name})`;
  if (ingredient.prep) dropped.push(`${label}: prep "${ingredient.prep}"`);
  if (canonical.mass_g !== undefined || canonical.volume_ml !== undefined) {
    const hints = scaledHints(ingredient, 1);
    const first = hints[0];
    if (first === undefined) {
      dropped.push(`${label}: no stated amount the app can show (only a canonical amount); projected with none`);
      return { item: ingredient.name };
    }
    const other = first.system === "imperial" ? ingredient.display_equivalents?.metric : undefined;
    if (other !== undefined) {
      dropped.push(`${label}: its metric hint (${spanText(other.amount, other.amount_max)} ${other.unit})`);
    }
    return { item: ingredient.name, amount: spanText(first.amount, first.amount_max), unit: first.unit };
  }
  if (canonical.count !== undefined) {
    const amount = spanText(canonical.count.min, canonical.count.max);
    if (canonical.count_unit !== undefined) {
      const unit =
        (canonical.count.max ?? canonical.count.min) <= 1
          ? canonical.count_unit.one
          : canonical.count_unit.other;
      return { item: ingredient.name, amount, unit };
    }
    return { item: ingredient.name, amount };
  }
  if (canonical.as_written !== undefined) return { item: ingredient.name, amount: canonical.as_written };
  if (canonical.to_taste === true) return { item: ingredient.name, amount: "to taste" };
  return { item: ingredient.name };
}

/**
 * What the cook sees for a line: `ingredientLine`, except that a measured
 * line with no stated amount the app can show reads as a line with no amount
 * (`ingredientLine` refuses to invent one), which is what its projection is.
 */
function shown(ingredient: Ingredient): IngredientLine {
  if (hasNoShownAmount(ingredient)) return { kind: "unstated", name: ingredient.name };
  return ingredientLine(ingredient);
}

/**
 * A measured pack line with no stated amount the app can show: only a
 * canonical amount, as Studio wrote Fannie's Thin White Sauce pepper (0.1 g
 * from "few grains"). The app never shows a computed number in a stated
 * amount's place (B4 decision 3), so such a line reads as one with no amount:
 * its projection is that, and B5d's native read rewrites it to that
 * (`native-read.ts`, B5.md §B5d D5).
 */
export function hasNoShownAmount(ingredient: Ingredient): boolean {
  const canonical = readScaledCanonical(ingredient, 1);
  return (
    (canonical.mass_g !== undefined || canonical.volume_ml !== undefined) &&
    scaledHints(ingredient, 1).length === 0
  );
}

/** A line as the guard compares it: its kind, the amount shown and the name beside it. */
function seen(line: IngredientLine): string {
  return JSON.stringify(["amount" in line ? [line.kind, line.amount] : [line.kind], line.name]);
}

/**
 * Projects a pack-file recipe into the queue's stored shape and checks the
 * projection reads back as what the cook would see; refuses with the
 * differences when it doesn't.
 */
export function packRecipeToQueueData(recipe: Recipe, packId: string): ProjectionResult {
  const dropped: string[] = [];
  const ingredients = recipe.ingredients.map((ingredient) => lineOf(ingredient, dropped));
  const indexOf = new Map(recipe.ingredients.map((ingredient, i) => [ingredient.id, i]));

  const steps = recipe.steps.map((step) => step.text);
  const stepIngredients = recipe.steps.map((step) =>
    (step.ingredient_refs ?? []).map((ref) => indexOf.get(ref)!),
  );
  recipe.steps.forEach((step, i) => {
    const label = `step ${String(i)} (${step.id})`;
    if (step.type !== "action") dropped.push(`${label}: type ${step.type}`);
    if (step.title) dropped.push(`${label}: title "${step.title}"`);
    for (const ref of step.technique_refs ?? []) dropped.push(`${label}: ${ref}`);
    for (const ref of step.state_refs ?? []) dropped.push(`${label}: ${ref}`);
    if (step.media_ref != null) dropped.push(`${label}: media ${step.media_ref}`);
  });

  const estimatedTime = {
    ...(recipe.time_active_min !== undefined && { active: recipe.time_active_min }),
    ...(recipe.time_total_min !== undefined && { total: recipe.time_total_min }),
  };
  const estimated = recipe.serves_estimated === true;
  const servesEstimate: ServesEstimateInput | null = estimated
    ? {
        count: recipe.serves_base,
        basis: `From the pack ${packId}: it gives ${String(recipe.serves_base)} as Sous's estimate.`,
      }
    : null;
  const notes = (recipe.creator_notes ?? []).join("\n\n");

  const recipeData: KitchenQueueRecipeData = {
    name: recipe.title,
    ingredients,
    steps,
    ...(Object.keys(estimatedTime).length > 0 && { estimatedTime }),
    ...(!estimated && { serves: recipe.serves_base }),
    ...(recipe.tags !== undefined && { tags: recipe.tags }),
    ...(notes.trim() !== "" && { notes }),
    stepIngredients,
    source: packSource(packId, recipe.id),
  };

  const back = legacyToPackRecipe(recipeData, {
    id: recipe.id,
    ...(servesEstimate !== null && { servesEstimate }),
  });
  if (!back.ok) {
    return {
      ok: false,
      differences: back.issues.map((issue) => `doesn't read back: ${issue.path}: ${issue.message}`),
    };
  }
  const read = back.recipe;
  const differences: string[] = [];
  if (read.title !== recipe.title) differences.push(`title "${recipe.title}" reads back "${read.title}"`);
  if (read.serves_base !== recipe.serves_base || read.serves_estimated !== recipe.serves_estimated) {
    differences.push(
      `serves ${String(recipe.serves_base)}${estimated ? " (estimated)" : ""} reads back ${String(read.serves_base)}${read.serves_estimated ? " (estimated)" : ""}`,
    );
  }
  if (read.ingredients.length !== recipe.ingredients.length) {
    differences.push(`${String(recipe.ingredients.length)} lines read back as ${String(read.ingredients.length)}`);
  } else {
    recipe.ingredients.forEach((ingredient, i) => {
      const before = seen(shown(ingredient));
      const after = seen(shown(read.ingredients[i]!));
      if (before !== after) differences.push(`line ${String(i)} (${ingredient.id}): shows ${before}, reads back ${after}`);
    });
  }
  if (read.steps.length !== recipe.steps.length) {
    differences.push(`${String(recipe.steps.length)} steps read back as ${String(read.steps.length)}`);
  } else {
    const readIndex = new Map(read.ingredients.map((ingredient, i) => [ingredient.id, i]));
    recipe.steps.forEach((step, i) => {
      const readStep = read.steps[i]!;
      if (readStep.text !== step.text) differences.push(`step ${String(i)} (${step.id}): text differs`);
      const refs = (step.ingredient_refs ?? []).map((ref) => indexOf.get(ref)).join(",");
      const readRefs = (readStep.ingredient_refs ?? []).map((ref) => readIndex.get(ref)).join(",");
      if (refs !== readRefs) differences.push(`step ${String(i)} (${step.id}): refs [${refs}] read back [${readRefs}]`);
      const timer = step.timer_sec ?? null;
      if (timer !== (readStep.timer_sec ?? null)) {
        dropped.push(`step ${String(i)} (${step.id}): timer_sec ${String(timer)}, the text gives ${String(readStep.timer_sec ?? null)}`);
      }
    });
  }
  if (differences.length > 0) return { ok: false, differences };
  return { ok: true, projection: { recipeData, servesEstimate, dropped } };
}
