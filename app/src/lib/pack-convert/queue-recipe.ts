/**
 * A queue row's stored recipe read as a Pack Format v0.5 recipe, for the cook
 * page (slice B4 step 7). The row is read, never changed: `recipe_data` keeps
 * the legacy shape it was stored in (B4 decision 2), and the pack recipe is
 * converted from it on every read, under the row's id.
 */

import type { Recipe, SchemaIssue } from "@sous/pack";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import {
  legacyToPackRecipe,
  readLegacyRecipe,
  storedEstimate,
  type ServesEstimateInput,
} from "./convert";
import type { PackFiles } from "../shelf/registry";
import { readPackRow } from "./native-read";
import { EMPTY_LIBRARY, type RecipeLibrary, type RecipeReading, type SourcePackInfo } from "./recipe-library";
import type { AiMeter } from "../ai";
import {
  estimateServes as defaultEstimateServes,
  queueSourceText,
  type ServesEstimateResult,
} from "../serves-estimate";

export interface QueueRecipeReading {
  /** The pack recipe; null when the row has none to read, or it can't be read. */
  packRecipe: Recipe | null;
  /** Why the stored recipe can't be read; null when it was, or there was none. */
  conversionError: string | null;
}

function described(issues: SchemaIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

export function readQueueRecipe(row: {
  id: string;
  recipeData: KitchenQueueRecipeData | null;
  /** Sous's estimate beside the stored recipe (slice B4b); null when none. */
  servesEstimate?: number | null;
  servesEstimateBasis?: string | null;
}): QueueRecipeReading {
  // A row queued by Notion id alone stores no recipe.
  if (row.recipeData === null) return { packRecipe: null, conversionError: null };
  const read = readLegacyRecipe(row.recipeData);
  if (!read.ok) {
    return {
      packRecipe: null,
      conversionError: `recipe row unreadable: ${described(read.issues)}`,
    };
  }
  const converted = legacyToPackRecipe(read.value, {
    id: row.id,
    servesEstimate: storedEstimate({
      servesEstimate: row.servesEstimate ?? null,
      servesEstimateBasis: row.servesEstimateBasis ?? null,
    }),
  });
  if (!converted.ok) {
    return { packRecipe: null, conversionError: described(converted.issues) };
  }
  return { packRecipe: converted.recipe, conversionError: null };
}

/** A queue row as the cook page reads it (slice B5d): natively for a `pack:` row that passes the guard. */
export interface QueueItemReading extends QueueRecipeReading {
  reading: RecipeReading;
  library: RecipeLibrary;
  /** Whether the cook page may scale the recipe's serving count (slice B5c, B5c-13). */
  scales: boolean;
  sourcePack?: SourcePackInfo;
  /** For the server log: why a pack row reads its projection, or what its native read noticed. */
  log: string[];
}

/**
 * `readQueueRecipe`, then, for a `pack:` row, its pack recipe natively when
 * the reverse guard passes (`readPackRow`, B5.md §B5d D1–D5), or enriched as
 * an adapted pack recipe when edited. `files` is read only for a pack row;
 * pass null when the row isn't one.
 */
export function readQueueItem(
  row: Parameters<typeof readQueueRecipe>[0],
  files: PackFiles | null,
): QueueItemReading {
  const converted = readQueueRecipe(row);
  const pack = files === null ? null : readPackRow(row, files);
  if (pack === null) {
    return { ...converted, reading: "projection", library: EMPTY_LIBRARY, scales: true, log: [] };
  }
  if (pack.reading === "projection") {
    return {
      ...converted,
      reading: "projection",
      library: EMPTY_LIBRARY,
      scales: false,
      ...(pack.sourcePack !== undefined && { sourcePack: pack.sourcePack }),
      log: [`reads its projection: ${pack.why}; the serving count stays at the recipe's`],
    };
  }
  if (pack.reading === "adapted") {
    const detail = pack.notes.length > 0 ? `; ${pack.notes.join("; ")}` : "";
    return {
      packRecipe: pack.packRecipe,
      conversionError: null,
      reading: "adapted",
      library: pack.library,
      scales: pack.scales,
      sourcePack: pack.sourcePack,
      log: [`read as adapted pack recipe: ${pack.why}${detail}`],
    };
  }
  return {
    packRecipe: pack.packRecipe,
    conversionError: null,
    reading: "native",
    library: pack.library,
    scales: true,
    sourcePack: pack.sourcePack,
    log: pack.notes.map((note) => `read natively: ${note}`),
  };
}

/** The refusal every add path gives a recipe the cook page couldn't read. */
export const CANT_READ_RECIPE = "Recipe can't be read as a pack recipe";

/**
 * The queue-time check for the app's own adds (B4 fix round 1, MED 3): the
 * recipe about to be queued, read as the cook page will read it. Null when it
 * reads, or there is no recipe (a Notion id alone); otherwise the refusal,
 * with the reason. The id is fixed, as the webhook's is: the row doesn't exist
 * yet, and the outcome doesn't depend on it.
 */
export function queueRefusal(
  recipeData: KitchenQueueRecipeData | null | undefined,
  servesEstimate?: ServesEstimateInput,
): string | null {
  if (recipeData == null) return null;
  const { conversionError } = readQueueRecipe({
    id: "queue-add",
    recipeData,
    servesEstimate: servesEstimate?.count ?? null,
    servesEstimateBasis: servesEstimate?.basis ?? null,
  });
  return conversionError === null ? null : `${CANT_READ_RECIPE}: ${conversionError}`;
}

/** What a queue add stores beside a recipe for its serving count (slice B4b). */
export type QueueServes =
  | { ok: true; servesEstimate: ServesEstimateInput | undefined }
  /** The estimate was needed and couldn't be made: nothing is queued. */
  | { ok: false; reason: string };

/**
 * The serving estimate a queue add stores, made before its queue-time check.
 *
 * - No recipe, or a recipe that states its count: none.
 * - An estimate carried from the library row (`carried`): that one, no call.
 * - Otherwise, when `mayEstimate` (an import, the webhook): one estimator
 *   call, told whether the lines give amounts and given the row's own source
 *   text. A recipe the cook page couldn't read for another reason gets no
 *   call: the queue-time check refuses it with that reason.
 * - A library send never estimates (the sync owns library estimates): with no
 *   carried estimate, the check refuses it ("Sous hasn't estimated one yet").
 */
export type ServesForQueueOptions =
  | {
      carried?: ServesEstimateInput;
      mayEstimate: false;
    }
  | {
      carried?: ServesEstimateInput;
      mayEstimate: true;
      meter: AiMeter;
      estimateServes?: undefined;
    }
  | {
      carried?: ServesEstimateInput;
      mayEstimate: true;
      estimateServes: (input: Parameters<typeof defaultEstimateServes>[0]) => Promise<ServesEstimateResult>;
    };

export async function servesForQueue(
  recipeData: KitchenQueueRecipeData | null | undefined,
  options: ServesForQueueOptions,
): Promise<QueueServes> {
  if (recipeData == null || typeof recipeData.serves === "number") {
    return { ok: true, servesEstimate: undefined };
  }
  if (options.carried !== undefined) return { ok: true, servesEstimate: options.carried };
  if (!options.mayEstimate) return { ok: true, servesEstimate: undefined };
  const read = readLegacyRecipe(recipeData);
  if (!read.ok) return { ok: true, servesEstimate: undefined };
  // Read with a placeholder count first: a recipe refused for another reason
  // is the queue-time check's to refuse, without a call.
  const probe = legacyToPackRecipe(read.value, {
    id: "queue-add",
    servesEstimate: { count: 1, basis: "probe" },
  });
  if (!probe.ok) return { ok: true, servesEstimate: undefined };
  const estimateInput = {
    name: read.value.name,
    ingredients: read.value.ingredients ?? [],
    steps: read.value.steps ?? [],
    sourceText: queueSourceText(recipeData),
    hasAmounts: probe.report.hasAmounts,
  };
  const result = options.estimateServes
    ? await options.estimateServes(estimateInput)
    : await defaultEstimateServes(estimateInput, { meter: options.meter });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, servesEstimate: result.estimate };
}

/** The refusal an add gives when the serving estimate couldn't be made. */
export const CANT_ESTIMATE_SERVES = "Couldn't work out how many this serves, so nothing was queued";
