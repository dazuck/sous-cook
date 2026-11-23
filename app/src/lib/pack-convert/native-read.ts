/**
 * A `pack:` queue row read as its pack recipe (slice B5d, B5.md §B5d D1–D5).
 *
 * The row stores S-D12's projection, the legacy shape every reader knows.
 * This reads the creator's own recipe instead, so its step types, timers,
 * refs and second stated hints come back, but only behind the reverse guard:
 * the registry's recipe must still project to exactly what the row stored
 * (key-sorted JSON) and to its serving estimate. Anything else (the pack
 * changed since the row was queued, the pack or recipe is gone, the pack won't
 * load, a re-keyed recipe the format refuses) reads the projection, today's
 * reading, with the reason for the log. A queued recipe stays the snapshot it
 * was queued as (S-D12) wherever the projection could show a difference.
 *
 * The native recipe is re-keyed to the stored indices (D3): step i is
 * `step-<i>` and ingredient i `ing-<i>`, refs mapped, as the converter keys
 * the projection. The stored plan's indices, B5a's timer ids
 * (`queueId:stepId`) and B5b's kept places then mean the same thing under
 * either reading. `variations` are dropped (a non-goal; their patches name the
 * pack's own ids). A measured line with no stated amount the app can show is
 * read as one with no amount (D5), as its projection is.
 */

import {
  parseRecipe,
  verifyRecipeRefs,
  type Ingredient,
  type Libraries,
  type Recipe,
  type Step,
} from "@sous/pack";
import { readScaledCanonical } from "@sous/pack/quantity";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { canonicalJson } from "../serves-estimate-plan";
import type { PackFiles } from "../shelf/registry";
import { legacyToPackRecipe, readLegacyRecipe, storedEstimate, textTimerSec } from "./convert";
import { ingredientId, stepId } from "./ids";
import type { RecipeLibrary, SourcePackInfo } from "./recipe-library";
import { hasNoShownAmount, packRecipeToQueueData, parsePackSource } from "./to-queue";

export type PackRowRead =
  | {
      reading: "native";
      /** The pack recipe, re-keyed to the stored indices (D3). */
      packRecipe: Recipe;
      library: RecipeLibrary;
      /** What the read changed or noticed, for the server log. Never shown. */
      notes: string[];
      sourcePack: SourcePackInfo;
    }
  | {
      reading: "adapted";
      /** The adapted recipe with matched source step metadata and creator notes grafted on. */
      packRecipe: Recipe;
      library: RecipeLibrary;
      /** True only when every `fixed` base ingredient uniquely matched a distinct adapted line. */
      scales: boolean;
      why: string;
      notes: string[];
      sourcePack: SourcePackInfo;
    }
  /** The row reads its projection; `why` is for the server log. */
  | { reading: "projection"; why: string; sourcePack?: SourcePackInfo };

/** The row as stored, as much of it as the guard reads. */
export interface QueueRowForRead {
  id: string;
  recipeData: KitchenQueueRecipeData | null;
  servesEstimate?: number | null;
  servesEstimateBasis?: string | null;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "into",
  "onto",
  "until",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "them",
  "their",
  "this",
  "that",
  "then",
]);

function normalizeStepText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contentTokens(text: string): Set<string> {
  const words = normalizeStepText(text).split(" ");
  return new Set(words.filter((w) => w.length > 0 && !STOPWORDS.has(w)));
}

function sharesHalfContentTokens(a: string, b: string): boolean {
  const tokensA = contentTokens(a);
  const tokensB = contentTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared += 1;
  }
  if ((tokensA.size >= 3 || tokensB.size >= 3) && shared < 2) return false;
  return shared / tokensB.size >= 0.5 || shared / tokensA.size >= 0.5;
}

function matchSourceStep(
  convStep: Step,
  index: number,
  convCount: number,
  sourceSteps: readonly Step[],
  usedIndices: Set<number>,
): Step | undefined {
  const normConv = normalizeStepText(convStep.text);
  if (index < sourceSteps.length && !usedIndices.has(index)) {
    const atIndex = sourceSteps[index]!;
    if (normalizeStepText(atIndex.text) === normConv) {
      usedIndices.add(index);
      return atIndex;
    }
  }
  const exactIdx = sourceSteps.findIndex(
    (s, i) => !usedIndices.has(i) && normalizeStepText(s.text) === normConv,
  );
  if (exactIdx !== -1) {
    usedIndices.add(exactIdx);
    return sourceSteps[exactIdx];
  }
  if (convCount === sourceSteps.length && index < sourceSteps.length && !usedIndices.has(index)) {
    const atIndex = sourceSteps[index]!;
    if (sharesHalfContentTokens(convStep.text, atIndex.text)) {
      usedIndices.add(index);
      return atIndex;
    }
  }
  return undefined;
}

function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function canonicalKey(qty: Ingredient["qty_canonical"]): string {
  const { salt_type: _saltType, ...rest } = qty;
  return canonicalJson(rest);
}

function enrichAdaptedRecipe(
  converted: Recipe,
  sourceRecipe: Recipe,
  projectedSource: Recipe,
): { recipe: unknown; scales: boolean; unmatchedFixed: string[] } {
  const baseKeys = sourceRecipe.ingredients.map((srcIng, i) => {
    const projQty = projectedSource.ingredients[i]?.qty_canonical ?? srcIng.qty_canonical;
    return `${normName(srcIng.name)}\0${canonicalKey(projQty)}`;
  });
  const baseKeyCounts = new Map<string, number>();
  for (const key of baseKeys) {
    baseKeyCounts.set(key, (baseKeyCounts.get(key) ?? 0) + 1);
  }

  const convIndicesByKey = new Map<string, number[]>();
  converted.ingredients.forEach((convIng, j) => {
    const key = `${normName(convIng.name)}\0${canonicalKey(convIng.qty_canonical)}`;
    const list = convIndicesByKey.get(key) ?? [];
    list.push(j);
    convIndicesByKey.set(key, list);
  });

  const fixedConvIndices = new Set<number>();
  const unmatchedFixed: string[] = [];
  sourceRecipe.ingredients.forEach((srcIng, i) => {
    if (srcIng.scaling !== "fixed") return;
    const key = baseKeys[i]!;
    const convMatches = convIndicesByKey.get(key) ?? [];
    if (baseKeyCounts.get(key) === 1 && convMatches.length === 1) {
      fixedConvIndices.add(convMatches[0]!);
    } else {
      unmatchedFixed.push(`${srcIng.id} (${srcIng.name})`);
    }
  });

  const ingredients: Ingredient[] = converted.ingredients.map((convIng, j) =>
    fixedConvIndices.has(j) ? { ...convIng, scaling: "fixed" as const } : convIng,
  );

  const usedIndices = new Set<number>();
  const steps: Step[] = converted.steps.map((convStep, i) => {
    const srcStep = matchSourceStep(
      convStep,
      i,
      converted.steps.length,
      sourceRecipe.steps,
      usedIndices,
    );
    if (srcStep === undefined) return convStep;
    const convTextTimer = textTimerSec(convStep.text);
    const srcTextTimer = textTimerSec(srcStep.text);
    const timerSec =
      (convStep.timer_sec ?? null) === null && srcStep.timer_sec != null && convTextTimer === null
        ? srcStep.timer_sec
        : convTextTimer === srcTextTimer && srcStep.timer_sec !== undefined
          ? srcStep.timer_sec
          : convStep.timer_sec;
    return {
      ...convStep,
      type: srcStep.type,
      ...(srcStep.title !== undefined && { title: srcStep.title }),
      ...(srcStep.coach_hints !== undefined && { coach_hints: srcStep.coach_hints }),
      ...(srcStep.technique_refs !== undefined && { technique_refs: srcStep.technique_refs }),
      ...(srcStep.recommended_technique_ref !== undefined && {
        recommended_technique_ref: srcStep.recommended_technique_ref,
      }),
      ...(srcStep.state_refs !== undefined && { state_refs: srcStep.state_refs }),
      ...(srcStep.media_ref !== undefined && { media_ref: srcStep.media_ref }),
      timer_sec: timerSec,
    };
  });

  const srcNotes = sourceRecipe.creator_notes ?? [];
  const convNotes = converted.creator_notes ?? [];
  let creatorNotes: string[] | undefined = converted.creator_notes;
  if (srcNotes.length > 0) {
    if (
      convNotes.length === 0 ||
      (convNotes.length === 1 && convNotes[0] === srcNotes.join("\n\n"))
    ) {
      creatorNotes = [...srcNotes];
    } else {
      const missing = srcNotes.filter((n) => !convNotes.some((existing) => existing.includes(n)));
      creatorNotes = [...convNotes, ...missing];
    }
  }

  return {
    recipe: {
      ...converted,
      ingredients,
      steps,
      ...(creatorNotes !== undefined && creatorNotes.length > 0 && { creator_notes: creatorNotes }),
    },
    scales: unmatchedFixed.length === 0,
    unmatchedFixed,
  };
}

/**
 * Where two stored recipes differ, for the log: each top-level field, and for
 * a list its first differing entry ("steps[2]").
 */
function differingFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((key) => {
    const x = a[key] ?? null;
    const y = b[key] ?? null;
    if (canonicalJson(x) === canonicalJson(y)) return [];
    if (Array.isArray(x) && Array.isArray(y)) {
      const at = Array.from({ length: Math.max(x.length, y.length) }, (_, i) => i).find(
        (i) => canonicalJson(x[i] ?? null) !== canonicalJson(y[i] ?? null),
      );
      return [`${key}[${String(at)}]`];
    }
    return [key];
  });
}

function rekeyIngredient(
  ingredient: Ingredient,
  index: number,
  notes: string[],
  projected: Ingredient | undefined,
): Ingredient {
  const id = ingredientId(index);
  if (!hasNoShownAmount(ingredient)) {
    const canonical = readScaledCanonical(ingredient, 1);
    const pCanonical = projected !== undefined ? readScaledCanonical(projected, 1) : undefined;
    if ((canonical.mass_g !== undefined || canonical.volume_ml !== undefined) && pCanonical !== undefined) {
      // A measured line's computed numbers (the popover's conversions) come
      // from the amount the cook sees, its first stated hint, exactly as its
      // projection's do (B5d verify round 1): never from a canonical amount
      // the pack holds beside it, which can disagree with the stated amount
      // (Fannie's milk: "1 cup" beside 240 ml) or bridge to the other
      // dimension by a density the app has never shown. The creator's
      // canonical amount is read by no number on screen.
      const mass = pCanonical.mass_g?.min;
      const volume = pCanonical.volume_ml?.min;
      const rangeMax = pCanonical.mass_g?.max ?? pCanonical.volume_ml?.max;
      const saltType = ingredient.qty_canonical.salt_type;
      return {
        ...ingredient,
        id,
        qty_canonical: {
          ...(mass !== undefined && { mass_g: mass }),
          ...(volume !== undefined && { volume_ml: volume }),
          ...(rangeMax !== undefined && { range_max: rangeMax }),
          ...(saltType !== undefined && { salt_type: saltType }),
        },
      };
    }
    return { ...ingredient, id };
  }
  notes.push(
    `${ingredient.id} (${ingredient.name}): no stated amount the app can show (only a canonical amount); read with none`,
  );
  const { salt_type: saltType } = ingredient.qty_canonical;
  return {
    ...ingredient,
    id,
    qty_canonical: { unstated: true, ...(saltType !== undefined && { salt_type: saltType }) },
  };
}

/**
 * The pack recipe under the stored indices' ids (D3), its no-amount lines
 * read as none (D5), and each measured line's canonical amount its
 * projection's (`projection`, the stored row converted).
 */
function rekeyed(recipe: Recipe, rowId: string, notes: string[], projection: Recipe): unknown {
  const newId = new Map(recipe.ingredients.map((ingredient, i) => [ingredient.id, ingredientId(i)]));
  const ingredients = recipe.ingredients.map((ingredient, i) =>
    rekeyIngredient(ingredient, i, notes, projection.ingredients.find((p) => p.id === ingredientId(i))),
  );
  const steps: Step[] = recipe.steps.map((step, i) => {
    const text = textTimerSec(step.text);
    if (text !== null && (step.timer_sec ?? null) === null) {
      notes.push(`${step.id}: its text states a length (${String(text)} s) but timer_sec is null; no timer`);
    }
    return {
      ...step,
      id: stepId(i),
      ...(step.ingredient_refs !== undefined && {
        ingredient_refs: step.ingredient_refs.map((ref) => newId.get(ref) ?? ref),
      }),
    };
  });
  const { variations, ...rest } = recipe;
  if (variations !== undefined && variations.length > 0) {
    notes.push(`${String(variations.length)} variation(s) not read`);
  }
  return { ...rest, id: rowId, ingredients, steps };
}

/** Only the library entries `recipe`'s refs name. */
export function librarySubset(recipe: Recipe, libraries: Libraries): RecipeLibrary {
  const states = new Set(recipe.steps.flatMap((step) => step.state_refs ?? []));
  const commons = new Set(
    recipe.steps.flatMap((step) => [
      ...(step.technique_refs ?? []),
      ...(step.recommended_technique_ref == null ? [] : [step.recommended_technique_ref]),
    ]),
  );
  return {
    states: libraries.states.filter((entry) => states.has(entry.id)),
    commons: libraries.commons.filter((entry) => commons.has(entry.id)),
  };
}

/**
 * How a queue row reads: natively when it is a `pack:` row whose pack recipe
 * passes the reverse guard, adapted when `row.recipeData` was altered from the
 * pack recipe (preserving the altered ingredients and steps while grafting
 * matched step metadata and creator notes), else its projection with the
 * reason. Null for a row that isn't a pack row at all (household, import,
 * webhook): those never take this path.
 */
export function readPackRow(row: QueueRowForRead, files: PackFiles): PackRowRead | null {
  const source = parsePackSource(row.recipeData?.source);
  if (source === null || row.recipeData === null) return null;
  const projection = (why: string, sourcePack?: SourcePackInfo): PackRowRead => ({
    reading: "projection",
    why,
    ...(sourcePack !== undefined && { sourcePack }),
  });
  const { packId, recipeId } = source;

  if (files.libraries === null) {
    return projection(files.loadError ?? "the platform libraries couldn't be read");
  }
  const pack = files.packs.find((candidate) => candidate.id === packId);
  if (pack === undefined) {
    const failed = files.errors.find((error) => error.packId === packId);
    return projection(
      failed === undefined
        ? `pack ${packId} isn't in the registry`
        : `pack ${packId} didn't load: ${failed.reason}`,
    );
  }
  const recipe = pack.recipes.find((candidate) => candidate.id === recipeId);
  if (recipe === undefined) return projection(`pack ${packId} has no recipe ${recipeId}`);

  const baseSourcePack = {
    packId: pack.id,
    packTitle: pack.title,
    creatorName: pack.creator.name,
    recipeId: recipe.id,
    recipeTitle: recipe.title,
  };

  const projected = packRecipeToQueueData(recipe, packId);
  if (!projected.ok) {
    return projection(
      `${packId}/${recipeId} no longer projects: ${projected.differences.slice(0, 3).join("; ")}`,
    );
  }
  const fields = differingFields(
    projected.projection.recipeData as unknown as Record<string, unknown>,
    {
      ...(row.recipeData as unknown as Record<string, unknown>),
      source: projected.projection.recipeData.source,
    },
  );
  const estimate = storedEstimate({
    servesEstimate: row.servesEstimate ?? null,
    servesEstimateBasis: row.servesEstimateBasis ?? null,
  });

  if (source.adapted === true) {
    const why =
      fields.length > 0
        ? `${packId}/${recipeId} adapted (${fields.join(", ")})`
        : `${packId}/${recipeId} adapted`;
    const adaptedSourcePack: SourcePackInfo = { ...baseSourcePack, isAdapted: true };
    const legacy = readLegacyRecipe(row.recipeData);
    const converted = legacy.ok
      ? legacyToPackRecipe(legacy.value, {
          id: row.id,
          ...(estimate !== undefined && { servesEstimate: estimate }),
        })
      : null;
    const baseLegacy = readLegacyRecipe(projected.projection.recipeData);
    const projectedBase = baseLegacy.ok
      ? legacyToPackRecipe(baseLegacy.value, {
          id: recipe.id,
          ...(projected.projection.servesEstimate !== null && {
            servesEstimate: projected.projection.servesEstimate,
          }),
        })
      : null;
    if (converted === null || !converted.ok || projectedBase === null || !projectedBase.ok) {
      return projection(`${packId}/${recipeId}: the stored row can't be read to compare`, adaptedSourcePack);
    }
    const adaptedEnriched = enrichAdaptedRecipe(converted.recipe, recipe, projectedBase.recipe);
    const enriched = parseRecipe(adaptedEnriched.recipe);
    if (!enriched.ok) {
      return projection(
        `${packId}/${recipeId} adapted isn't a valid recipe: ${enriched.issues[0]?.message ?? ""}`,
        adaptedSourcePack,
      );
    }
    const refIssues = verifyRecipeRefs(enriched.value, files.libraries);
    if (refIssues.length > 0) {
      return projection(
        `${packId}/${recipeId} adapted refs don't resolve: ${refIssues[0]!.message}`,
        adaptedSourcePack,
      );
    }
    const notes =
      adaptedEnriched.unmatchedFixed.length > 0
        ? [
            `fixed base line not matched (${adaptedEnriched.unmatchedFixed.join(", ")}); the serving count stays at the recipe's`,
          ]
        : [];
    return {
      reading: "adapted",
      packRecipe: enriched.value,
      library: librarySubset(enriched.value, files.libraries),
      scales: adaptedEnriched.scales,
      why,
      notes,
      sourcePack: adaptedSourcePack,
    };
  }

  if (fields.length > 0) {
    return projection(`${packId}/${recipeId} changed since it was queued (${fields.join(", ")})`);
  }

  if (canonicalJson(projected.projection.servesEstimate ?? null) !== canonicalJson(estimate ?? null)) {
    return projection(`${packId}/${recipeId}: the row's serving estimate isn't the pack's`);
  }

  const legacy = readLegacyRecipe(row.recipeData);
  const converted = legacy.ok
    ? legacyToPackRecipe(legacy.value, { id: row.id, ...(estimate !== undefined && { servesEstimate: estimate }) })
    : null;
  if (converted === null || !converted.ok) {
    return projection(`${packId}/${recipeId}: the stored row can't be read to compare`);
  }

  const notes: string[] = [];
  const parsed = parseRecipe(rekeyed(recipe, row.id, notes, converted.recipe));
  if (!parsed.ok) {
    return projection(
      `${packId}/${recipeId} re-keyed isn't a valid recipe: ${parsed.issues[0]?.message ?? ""}`,
    );
  }
  const refIssues = verifyRecipeRefs(parsed.value, files.libraries);
  if (refIssues.length > 0) {
    return projection(
      `${packId}/${recipeId} re-keyed refs don't resolve: ${refIssues[0]!.message}`,
    );
  }
  return {
    reading: "native",
    packRecipe: parsed.value,
    library: librarySubset(parsed.value, files.libraries),
    notes,
    sourcePack: { ...baseSourcePack, isAdapted: false },
  };
}
