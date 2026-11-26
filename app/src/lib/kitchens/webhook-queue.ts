import { after } from "next/server";
import { z } from "zod";
import {
  addToKitchenQueue,
  prepareQueueItemInBackground,
} from "@/lib/kitchen-queue";
import {
  legacyToPackRecipe,
  resolveStepIngredients,
  type ConversionReport,
} from "@/lib/pack-convert/convert";
import {
  CANT_ESTIMATE_SERVES,
  CANT_READ_RECIPE,
  queueRefusal,
  servesForQueue,
} from "@/lib/pack-convert/queue-recipe";
import {
  adaptedPackSource,
  packRecipeToQueueData,
  packSource,
  parsePackSource,
} from "@/lib/pack-convert/to-queue";
import { PACK_PLANS_DIR, loadAppPackFiles } from "@/lib/shelf/load";
import { packPlanFor, readPackPlanFile } from "@/lib/pack-cook-plans";
import { storedPlanToCopy, type StoredPlan } from "@/lib/kitchen/cook-plan-stamp";
import { canonicalJson } from "@/lib/serves-estimate-plan";
import { findAllowanceUsed, kitchenMeter } from "@/lib/ai";

/**
 * The pack recipe's id for the queue-time check. The queue row's id, the one
 * the cook page converts with, doesn't exist until the row is stored, and the
 * check's outcome doesn't depend on the id.
 */
const WEBHOOK_RECIPE_ID = "webhook";

const RecipeIngredientSchema = z.object({
  item: z.string(),
  amount: z.string().optional(),
  unit: z.string().optional(),
});

const StepIngredientEntrySchema = z.union([
  z.number(),
  RecipeIngredientSchema,
]);

const KitchenQueueRecipeDataSchema = z.object({
  name: z.string(),
  ingredients: z.array(RecipeIngredientSchema).optional(),
  steps: z.array(z.string()).optional(),
  estimatedTime: z
    .object({
      active: z.number().optional(),
      passive: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
  serves: z.number().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  // Per-step ingredient indices or ingredient objects (parallel to steps).
  // Must be declared here or z.object() strips it from recipeData before it
  // reaches the database.
  stepIngredients: z.array(z.array(StepIngredientEntrySchema)).optional(),
  source: z.string().optional(),
});

export const KitchenQueueWebhookSchema = z
  .object({
    recipeData: KitchenQueueRecipeDataSchema.optional(),
    recipeNotionId: z.string().optional(),
    packId: z.string().min(1).optional(),
    recipeId: z.string().min(1).optional(),
    pack: z.string().min(1).optional(),
  })
  .refine(
    (data) =>
      Boolean(
        data.recipeData ||
          data.recipeNotionId ||
          (data.packId && data.recipeId) ||
          data.pack,
      ),
    {
      message: "Either recipeData or recipeNotionId must be provided",
    },
  );

export type KitchenQueueWebhookInput = z.infer<
  typeof KitchenQueueWebhookSchema
>;

export interface QueueWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

function parsePackShorthand(
  pack: string | undefined,
  packId: string | undefined,
  recipeId: string | undefined,
): { packId: string; recipeId: string } | null {
  if (packId && recipeId) return { packId, recipeId };
  if (!pack) return null;
  const trimmed = pack.startsWith("pack:") ? pack.slice("pack:".length) : pack;
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  return match
    ? { packId: match[1]!, recipeId: match[2]! }
    : { packId: "", recipeId: "" };
}

/**
 * Shared validation and queueing pipeline for `POST /api/kitchen-queue` and
 * the MCP `queue_recipe` tool. Always scopes queueing, shelf visibility, and
 * AI metering strictly to `kitchenId`.
 */
export async function queueRecipeForKitchen(
  kitchenId: string,
  body: unknown,
): Promise<QueueWebhookResult> {
  // Refuse the retired targetUser field loudly before Zod strips unknown keys.
  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "targetUser" in body
  ) {
    return {
      status: 400,
      body: {
        error: "targetUser is no longer accepted: the token names the kitchen",
      },
    };
  }

  const parsed = KitchenQueueWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: "Validation error", details: parsed.error.flatten() },
    };
  }

  const {
    recipeData: rawRecipeData,
    recipeNotionId,
    packId: rawPackId,
    recipeId: rawRecipeId,
    pack: rawPack,
  } = parsed.data;

  // Shape 1 — Direct pack recipe queue ({ packId, recipeId } or { pack: "<packId>/<recipeId>" })
  const directPack = parsePackShorthand(rawPack, rawPackId, rawRecipeId);
  if (directPack !== null) {
    if (!directPack.packId || !directPack.recipeId) {
      return { status: 404, body: { error: "Pack or recipe not found" } };
    }
    const files = await loadAppPackFiles({ kitchenId });
    const pack = files.packs.find((p) => p.id === directPack.packId);
    const recipe = pack?.recipes.find((r) => r.id === directPack.recipeId);
    if (!pack || !recipe) {
      return { status: 404, body: { error: "Pack or recipe not found" } };
    }

    const projected = packRecipeToQueueData(recipe, pack.id);
    if (!projected.ok) {
      return {
        status: 422,
        body: {
          error: CANT_READ_RECIPE,
          differences: projected.differences,
        },
      };
    }

    const packRecipeData = projected.projection.recipeData;
    const packServesEstimate = projected.projection.servesEstimate ?? undefined;
    const refusal = queueRefusal(packRecipeData, packServesEstimate);
    if (refusal !== null) {
      return { status: 422, body: { error: refusal } };
    }

    let stored: StoredPlan | null = null;
    const planFile = await readPackPlanFile(PACK_PLANS_DIR, pack.id);
    if (planFile.ok) {
      stored = packPlanFor(planFile.file, recipe.id);
    } else {
      console.error(
        `[webhook] ${pack.id}/${recipe.id}: pack plan file unreadable, deriving instead: ${planFile.reason}`,
      );
    }
    const checked =
      stored === null ? null : storedPlanToCopy(stored, packRecipeData);
    const plan = checked?.ok ? checked.copy : undefined;

    const sourceKitchenPackId = files.packMeta?.get(pack.id)?.kitchenPackId ?? null;

    try {
      const inserted = await addToKitchenQueue(kitchenId, {
        recipeData: packRecipeData,
        ...(packServesEstimate !== undefined && {
          servesEstimate: packServesEstimate,
        }),
        ...(plan !== undefined && { plan }),
        sourceKitchenPackId,
      });
      if (plan === undefined) {
        after(() => prepareQueueItemInBackground(kitchenId, inserted.id));
      }
      return {
        status: 201,
        body: {
          success: true,
          id: inserted.id,
          queueIds: [inserted.id],
          name: recipe.title,
          source: packSource(pack.id, recipe.id),
          mode: "native",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Kitchen queue error:", message);
      return {
        status: 500,
        body: { error: "Failed to queue recipe", details: message },
      };
    }
  }

  let recipeData = rawRecipeData
    ? (() => {
        const { stepIngredients: rawStepIngredients, ...rest } = rawRecipeData;
        return rawStepIngredients !== undefined
          ? {
              ...rest,
              stepIngredients: resolveStepIngredients(
                rawStepIngredients,
                rest.ingredients ?? [],
              ) as number[][],
            }
          : rest;
      })()
    : undefined;

  // Deterministic pack attribution gate (create-flow.md D2) & creator notes carry-over
  let sourceKitchenPackId: string | null = null;
  if (
    recipeData?.source?.startsWith("pack:") ||
    recipeData?.source?.startsWith("pack-adapted:")
  ) {
    const parsedSource = parsePackSource(recipeData.source);
    const files = await loadAppPackFiles({ kitchenId });
    const pack = parsedSource
      ? files.packs.find((p) => p.id === parsedSource.packId)
      : undefined;
    const recipe = pack?.recipes.find((r) => r.id === parsedSource?.recipeId);
    if (!parsedSource || !pack || !recipe) {
      const { source: _dropped, ...withoutSource } = recipeData;
      recipeData = withoutSource;
    } else {
      sourceKitchenPackId = files.packMeta?.get(pack.id)?.kitchenPackId ?? null;
      const projected = packRecipeToQueueData(recipe, pack.id);
      const canonicalCandidate = {
        ...recipeData,
        source: packSource(pack.id, recipe.id),
      };
      const isByteIdentical =
        !parsedSource.adapted &&
        projected.ok &&
        canonicalJson(canonicalCandidate) ===
          canonicalJson(projected.projection.recipeData);
      if (isByteIdentical) {
        recipeData = canonicalCandidate;
      } else {
        let nextNotes = recipeData.notes;
        if (recipe.creator_notes && recipe.creator_notes.length > 0) {
          const existingNotes = recipeData.notes ?? "";
          const missingNotes = recipe.creator_notes.filter(
            (note) => !existingNotes.includes(note),
          );
          if (missingNotes.length > 0) {
            const joined = missingNotes.join("\n\n");
            const block = `Creator notes (${pack.creator.name}):\n${joined}`;
            nextNotes = existingNotes.trim()
              ? `${existingNotes.trim()}\n\n${block}`
              : block;
          }
        }
        recipeData = {
          ...recipeData,
          ...(nextNotes !== undefined && { notes: nextNotes }),
          source: adaptedPackSource(pack.id, recipe.id),
        };
      }
    }
  }

  // Read as a pack recipe before anything is queued: a recipe the cook page
  // couldn't read is refused here, where the sender sees why. The payload is
  // stored as received; the cook page converts the stored row again.
  let conversion: ConversionReport["counts"] | undefined;
  let serves: Awaited<ReturnType<typeof servesForQueue>>;
  try {
    serves = await servesForQueue(recipeData, {
      mayEstimate: true,
      meter: kitchenMeter(kitchenId, null, "serves-estimate"),
    });
  } catch (error) {
    const allowance = findAllowanceUsed(error);
    if (allowance) {
      return {
        status: 429,
        body: {
          error: "ai_allowance_used",
          message: allowance.message,
          resetsAt: allowance.resetsAt.toISOString(),
        },
      };
    }
    throw error;
  }
  if (!serves.ok) {
    console.error(`[webhook] ${CANT_ESTIMATE_SERVES}: ${serves.reason}`);
    return {
      status: 503,
      body: { error: CANT_ESTIMATE_SERVES, reason: serves.reason },
    };
  }
  const { servesEstimate } = serves;
  if (recipeData) {
    const converted = legacyToPackRecipe(recipeData, {
      id: WEBHOOK_RECIPE_ID,
      servesEstimate,
    });
    if (!converted.ok) {
      return {
        status: 422,
        body: {
          error: CANT_READ_RECIPE,
          issues: converted.issues,
        },
      };
    }
    conversion = converted.report.counts;
  }

  // An agent recipe is cut to the import rules before the cook meets it
  // (cook-fidelity plan): a step per stretch of work, one ingredient per line, each
  // step's own ingredients. A pack recipe, native or adapted, is read through
  // its pack instead, so it gets none. The recipe is stored as sent either way.
  const intake =
    recipeData !== undefined && parsePackSource(recipeData.source) === null;

  try {
    const inserted = await addToKitchenQueue(kitchenId, {
      recipeData,
      recipeNotionId,
      servesEstimate,
      intake,
      ...(sourceKitchenPackId !== null ? { sourceKitchenPackId } : {}),
    });
    after(() => prepareQueueItemInBackground(kitchenId, inserted.id));

    return {
      status: 200,
      body: {
        success: true,
        queueIds: [inserted.id],
        ...(conversion && { conversion }),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Kitchen queue error:", message);
    return {
      status: 500,
      body: { error: "Failed to queue recipe", details: message },
    };
  }
}
