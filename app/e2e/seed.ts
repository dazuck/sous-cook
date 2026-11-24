/**
 * Seeds the home kitchen with fixed test rows using the application's own
 * library functions (never the tRPC router, which schedules background work).
 */

import type { Recipe } from "@sous/pack";
import { and, eq, sql } from "drizzle-orm";
import { db, kitchenQueue } from "@/lib/db";
import { COOK_PLAN_BLOCKED } from "@/lib/kitchen/cook-plan-derive";
import { storedPlanToCopy } from "@/lib/kitchen/cook-plan-stamp";
import { addToKitchenQueue, updateQueueStatus } from "@/lib/kitchen-queue";
import { findHomeKitchen } from "@/lib/kitchens/deployment";
import { packPlanFor, readPackPlanFile, type PackPlanFile } from "@/lib/pack-cook-plans";
import { packRecipeToQueueData } from "@/lib/pack-convert/to-queue";
import { PACK_PLANS_DIR, loadAppShelf } from "@/lib/shelf/load";
import { PACK_FILE_SOURCES } from "@/lib/shelf/registry";
import {
  BUNDLED_PACK_ID,
  HERB_OMELETTE_RECIPE,
  PACK_RECIPE_IDS,
  PANTRY_TOMATO_SOUP_RECIPE,
  SEED_NOW,
  SESAME_GREEN_BEANS_RECIPE,
} from "./seed-data";
import { truncateDataTablesSql } from "./snapshot";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function ago(offsetMs: number): Date {
  return new Date(SEED_NOW.getTime() - offsetMs);
}

/** Fixed timestamps for every seeded row, relative to SEED_NOW. */
export const SEED_TIMES = {
  P1: { createdAt: ago(10 * MINUTE_MS) },
  P2: { createdAt: ago(1 * HOUR_MS) },
  P3: { createdAt: ago(2 * HOUR_MS) },
  P4: { createdAt: ago(3 * HOUR_MS) },
  F1: {
    createdAt: ago(1 * DAY_MS + 2 * HOUR_MS),
    startedAt: ago(1 * DAY_MS + 1 * HOUR_MS),
    completedAt: ago(1 * DAY_MS + 15 * MINUTE_MS),
  },
  F2: {
    createdAt: ago(3 * DAY_MS + 1 * HOUR_MS),
    startedAt: ago(3 * DAY_MS + 40 * MINUTE_MS),
    completedAt: ago(3 * DAY_MS),
  },
  X1: { createdAt: ago(2 * DAY_MS) },
} as const;

export interface SeedResult {
  kitchenId: string;
  ids: {
    P1: string;
    P2: string;
    P3: string;
    P4: string;
    F1: string;
    F2: string;
    X1: string;
  };
}

/**
 * Queues a single bundled pack recipe using the same projection and stored-plan
 * verification as queueFromPack. Throws an error naming the recipe unless
 * storedPlanToCopy succeeds, so a pack row is never seeded without its plan.
 */
export async function queuePackRecipe(
  kitchenId: string,
  packId: string,
  recipe: Recipe,
  planFile: PackPlanFile | null,
): Promise<{ id: string }> {
  const projected = packRecipeToQueueData(recipe, packId);
  if (!projected.ok) {
    throw new Error(
      `Pack recipe "${recipe.title}" (${packId}/${recipe.id}) failed queue projection: ${projected.differences.join("; ")}`,
    );
  }
  const stored = packPlanFor(planFile, recipe.id);
  if (stored === null) {
    throw new Error(
      `Pack recipe "${recipe.title}" (${packId}/${recipe.id}) has no stored cook plan in ${packId}.cook-plans.json`,
    );
  }
  const copied = storedPlanToCopy(stored, projected.projection.recipeData);
  if (!copied.ok) {
    throw new Error(
      `Pack recipe "${recipe.title}" (${packId}/${recipe.id}) stored cook plan cannot be copied: ${copied.reason}`,
    );
  }
  return addToKitchenQueue(kitchenId, {
    recipeData: projected.projection.recipeData,
    servesEstimate: projected.projection.servesEstimate ?? undefined,
    plan: copied.copy,
  });
}

async function setRowTimes(
  kitchenId: string,
  queueId: string,
  times: {
    createdAt: Date;
    startedAt?: Date | null;
    completedAt?: Date | null;
  },
): Promise<void> {
  await db
    .update(kitchenQueue)
    .set({
      createdAt: times.createdAt,
      ...(times.startedAt !== undefined && { startedAt: times.startedAt }),
      ...(times.completedAt !== undefined && { completedAt: times.completedAt }),
    })
    .where(and(eq(kitchenQueue.kitchenId, kitchenId), eq(kitchenQueue.id, queueId)));
}

/**
 * Empties all data tables and seeds the home kitchen with the seven fixed rows
 * (P1-P4, F1-F2, X1). Creates no kitchens, members, invites, auth rows, webhook
 * tokens, cook reports, or conversation rows.
 */
export async function seedDatabase(): Promise<SeedResult> {
  const home = await findHomeKitchen();
  if (!home) {
    throw new Error(
      'Home kitchen (slug "home") not found. Run database migrations before seeding.',
    );
  }

  await db.execute(sql.raw(truncateDataTablesSql()));

  const shelf = await loadAppShelf(home.id, { sources: PACK_FILE_SOURCES });
  const pack = shelf.packs.find((entry) => entry.pack.id === BUNDLED_PACK_ID)?.pack;
  if (!pack) {
    throw new Error(`Bundled pack "${BUNDLED_PACK_ID}" did not load from packs/`);
  }

  const planFileRead = await readPackPlanFile(PACK_PLANS_DIR, BUNDLED_PACK_ID);
  if (!planFileRead.ok) {
    throw new Error(
      `Bundled pack plan file for "${BUNDLED_PACK_ID}" could not be read: ${planFileRead.reason}`,
    );
  }
  const planFile = planFileRead.file;

  const findPackRecipe = (recipeId: string): Recipe => {
    const recipe = pack.recipes.find((entry) => entry.id === recipeId);
    if (!recipe) {
      throw new Error(`Recipe "${recipeId}" not found in pack "${BUNDLED_PACK_ID}"`);
    }
    return recipe;
  };

  // P1: Thin White Sauce (pending, stored plan)
  const p1 = await queuePackRecipe(
    home.id,
    pack.id,
    findPackRecipe(PACK_RECIPE_IDS.thinWhiteSauce),
    planFile,
  );
  await setRowTimes(home.id, p1.id, SEED_TIMES.P1);

  // P2: Boiled Custard (pending, stored plan)
  const p2 = await queuePackRecipe(
    home.id,
    pack.id,
    findPackRecipe(PACK_RECIPE_IDS.boiledCustard),
    planFile,
  );
  await setRowTimes(home.id, p2.id, SEED_TIMES.P2);

  // P3: Pantry Tomato Soup (pending, no plan, no error)
  const p3 = await addToKitchenQueue(home.id, {
    recipeData: PANTRY_TOMATO_SOUP_RECIPE,
  });
  await setRowTimes(home.id, p3.id, SEED_TIMES.P3);

  // P4: Sesame Green Beans (pending, no plan, settled COOK_PLAN_BLOCKED error)
  const p4 = await addToKitchenQueue(home.id, {
    recipeData: SESAME_GREEN_BEANS_RECIPE,
    plan: { cookPlan: null, cookPlanError: COOK_PLAN_BLOCKED },
  });
  await setRowTimes(home.id, p4.id, SEED_TIMES.P4);

  // F1: Waffles (completed via cooking -> completed with finished_by "pressed", stored plan)
  const f1 = await queuePackRecipe(
    home.id,
    pack.id,
    findPackRecipe(PACK_RECIPE_IDS.waffles),
    planFile,
  );
  await updateQueueStatus(home.id, f1.id, "cooking");
  await updateQueueStatus(home.id, f1.id, "completed", { by: "pressed" });
  await setRowTimes(home.id, f1.id, SEED_TIMES.F1);

  // F2: Herb Omelette (completed via cooking -> completed with finished_by "pressed", no plan)
  const f2 = await addToKitchenQueue(home.id, {
    recipeData: HERB_OMELETTE_RECIPE,
  });
  await updateQueueStatus(home.id, f2.id, "cooking");
  await updateQueueStatus(home.id, f2.id, "completed", { by: "pressed" });
  await setRowTimes(home.id, f2.id, SEED_TIMES.F2);

  // X1: Parker House Rolls (cancelled, stored plan)
  const x1 = await queuePackRecipe(
    home.id,
    pack.id,
    findPackRecipe(PACK_RECIPE_IDS.parkerHouseRolls),
    planFile,
  );
  await updateQueueStatus(home.id, x1.id, "cancelled");
  await setRowTimes(home.id, x1.id, SEED_TIMES.X1);

  return {
    kitchenId: home.id,
    ids: {
      P1: p1.id,
      P2: p2.id,
      P3: p3.id,
      P4: p4.id,
      F1: f1.id,
      F2: f2.id,
      X1: x1.id,
    },
  };
}
