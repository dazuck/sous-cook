import { NextResponse, after } from "next/server";
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
import { authenticateWebhookRequest } from "@/lib/kitchens/webhook-tokens";
import { findAllowanceUsed, kitchenMeter } from "@/lib/ai";

/**
 * The pack recipe's id for the queue-time check. The queue row's id, the one
 * the cook page converts with, doesn't exist until the row is stored, and the
 * check's outcome doesn't depend on the id.
 */
const WEBHOOK_RECIPE_ID = "webhook";

/**
 * After the response, the add runs intake (up to 90 s) and then the cook plan,
 * inside this function's time.
 */
export const maxDuration = 300;

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

const KitchenQueueWebhookSchema = z
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

function parsePackShorthand(
  pack: string | undefined,
  packId: string | undefined,
  recipeId: string | undefined,
): { packId: string; recipeId: string } | null {
  if (packId && recipeId) return { packId, recipeId };
  if (!pack) return null;
  const trimmed = pack.startsWith("pack:") ? pack.slice("pack:".length) : pack;
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  return match ? { packId: match[1]!, recipeId: match[2]! } : { packId: "", recipeId: "" };
}

/**
 * POST /api/kitchen-queue
 *
 * Webhook endpoint for pushing recipes into a kitchen's queue.
 * Used by external apps (an assistant, a script) to send recipes to the tablet.
 *
 * Auth: Per-kitchen Bearer token (required in every environment).
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateWebhookRequest(request);
  if (!auth.ok) return auth.response;
  const { kitchen } = auth;

  // Parse and validate body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Refuse the retired targetUser field loudly before Zod strips unknown keys.
  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "targetUser" in body
  ) {
    return NextResponse.json(
      { error: "targetUser is no longer accepted: the token names the kitchen" },
      { status: 400 },
    );
  }

  const parsed = KitchenQueueWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation error", details: parsed.error.flatten() },
      { status: 400 },
    );
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
      return NextResponse.json(
        { error: "Pack or recipe not found" },
        { status: 404 },
      );
    }
    const files = await loadAppPackFiles();
    const pack = files.packs.find((p) => p.id === directPack.packId);
    const recipe = pack?.recipes.find((r) => r.id === directPack.recipeId);
    if (!pack || !recipe) {
      return NextResponse.json(
        { error: "Pack or recipe not found" },
        { status: 404 },
      );
    }

    const projected = packRecipeToQueueData(recipe, pack.id);
    if (!projected.ok) {
      return NextResponse.json(
        {
          error: CANT_READ_RECIPE,
          differences: projected.differences,
        },
        { status: 422 },
      );
    }

    const packRecipeData = projected.projection.recipeData;
    const packServesEstimate = projected.projection.servesEstimate ?? undefined;
    const refusal = queueRefusal(packRecipeData, packServesEstimate);
    if (refusal !== null) {
      return NextResponse.json({ error: refusal }, { status: 422 });
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

    try {
      const inserted = await addToKitchenQueue(kitchen.id, {
        recipeData: packRecipeData,
        ...(packServesEstimate !== undefined && {
          servesEstimate: packServesEstimate,
        }),
        ...(plan !== undefined && { plan }),
      });
      if (plan === undefined) {
        after(() => prepareQueueItemInBackground(kitchen.id, inserted.id));
      }
      return NextResponse.json(
        {
          success: true,
          id: inserted.id,
          queueIds: [inserted.id],
          name: recipe.title,
          source: packSource(pack.id, recipe.id),
          mode: "native",
        },
        { status: 201 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Kitchen queue error:", message);
      return NextResponse.json(
        { error: "Failed to queue recipe", details: message },
        { status: 500 },
      );
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
  if (
    recipeData?.source?.startsWith("pack:") ||
    recipeData?.source?.startsWith("pack-adapted:")
  ) {
    const parsedSource = parsePackSource(recipeData.source);
    const files = await loadAppPackFiles();
    const pack = parsedSource
      ? files.packs.find((p) => p.id === parsedSource.packId)
      : undefined;
    const recipe = pack?.recipes.find((r) => r.id === parsedSource?.recipeId);
    if (!parsedSource || !pack || !recipe) {
      const { source: _dropped, ...withoutSource } = recipeData;
      recipeData = withoutSource;
    } else {
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
      meter: kitchenMeter(kitchen.id, null, "serves-estimate"),
    });
  } catch (error) {
    const allowance = findAllowanceUsed(error);
    if (allowance) {
      return NextResponse.json(
        {
          error: "ai_allowance_used",
          message: allowance.message,
          resetsAt: allowance.resetsAt.toISOString(),
        },
        { status: 429 },
      );
    }
    throw error;
  }
  if (!serves.ok) {
    console.error(`[webhook] ${CANT_ESTIMATE_SERVES}: ${serves.reason}`);
    return NextResponse.json(
      { error: CANT_ESTIMATE_SERVES, reason: serves.reason },
      { status: 503 },
    );
  }
  const { servesEstimate } = serves;
  if (recipeData) {
    const converted = legacyToPackRecipe(recipeData, {
      id: WEBHOOK_RECIPE_ID,
      servesEstimate,
    });
    if (!converted.ok) {
      return NextResponse.json(
        {
          error: CANT_READ_RECIPE,
          issues: converted.issues,
        },
        { status: 422 },
      );
    }
    conversion = converted.report.counts;
  }

  // An agent recipe is cut to the import rules before the cook meets it
  // (cook-fidelity plan): a step per stretch of work, one ingredient per line, each
  // step's own ingredients. A pack recipe, native or adapted, is read through
  // its pack instead, so it gets none. The recipe is stored as sent either way.
  const intake = recipeData !== undefined && parsePackSource(recipeData.source) === null;

  try {
    const inserted = await addToKitchenQueue(kitchen.id, {
      recipeData,
      recipeNotionId,
      servesEstimate,
      intake,
    });
    after(() => prepareQueueItemInBackground(kitchen.id, inserted.id));

    return NextResponse.json({
      success: true,
      queueIds: [inserted.id],
      ...(conversion && { conversion }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Kitchen queue error:", message);
    return NextResponse.json(
      { error: "Failed to queue recipe", details: message },
      { status: 500 },
    );
  }
}
