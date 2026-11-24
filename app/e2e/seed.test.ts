/**
 * Tests for the E2E database seed and snapshot/restore SQL against PGlite
 * with every application migration applied.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../src/lib/__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import {
  authAccount,
  authSession,
  authUser,
  authVerification,
  conversationLogs,
  cookReports,
  db,
  invites,
  kitchenQueue,
  kitchenWebhookTokens,
  kitchens,
  members,
} from "@/lib/db";
import {
  cookPlanWithoutDerive,
  getQueueItemForKitchen,
} from "@/lib/kitchen-queue";
import { COOK_PLAN_BLOCKED } from "@/lib/kitchen/cook-plan-derive";
import { identityPlan } from "@/lib/kitchen/cook-plan";
import { timerOffers } from "@/lib/kitchen/timer-attach";
import { readPackPlanFile } from "@/lib/pack-cook-plans";
import { readQueueItem } from "@/lib/pack-convert/queue-recipe";
import {
  PACK_PLANS_DIR,
  loadAppPackFiles,
  loadAppShelf,
} from "@/lib/shelf/load";
import { PACK_FILE_SOURCES } from "@/lib/shelf/registry";
import {
  BUNDLED_PACK_ID,
  PACK_RECIPE_IDS,
  RECIPE_NAMES,
} from "./seed-data";
import { SEED_TIMES, queuePackRecipe, seedDatabase } from "./seed";
import { E2E_DATA_TABLES, restoreSql, snapshotSql } from "./snapshot";

const client = (dbModule as unknown as { client: PGlite }).client;

let homeKitchenId: string;

beforeAll(async () => {
  const [home] = await db
    .select({ id: kitchens.id })
    .from(kitchens)
    .where(eq(kitchens.slug, "home"));
  if (!home) throw new Error("Expected migration to create the home kitchen");
  homeKitchenId = home.id;
});

async function dumpDataTables(): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of E2E_DATA_TABLES) {
    const query = await client.query(`SELECT * FROM public.${table} ORDER BY id ASC`);
    result[table] = query.rows;
  }
  return result;
}

describe("E2E seed and snapshot", () => {
  it("SEED-1: seeds the home kitchen with the seven expected rows and fixed times", async () => {
    const seeded = await seedDatabase();
    expect(seeded.kitchenId).toBe(homeKitchenId);

    const rows = await db
      .select()
      .from(kitchenQueue)
      .orderBy(asc(kitchenQueue.createdAt));
    expect(rows).toHaveLength(7);

    const byId = new Map(rows.map((row) => [row.id, row]));

    const p1 = byId.get(seeded.ids.P1)!;
    expect(p1.kitchenId).toBe(homeKitchenId);
    expect(p1.recipeData?.name).toBe(RECIPE_NAMES.thinWhiteSauce);
    expect(p1.status).toBe("pending");
    expect(p1.cookPlan).not.toBeNull();
    expect(p1.cookPlanError).toBeNull();
    expect(p1.finishedBy).toBeNull();
    expect(p1.createdAt).toEqual(SEED_TIMES.P1.createdAt);
    expect(p1.startedAt).toBeNull();
    expect(p1.completedAt).toBeNull();

    const p2 = byId.get(seeded.ids.P2)!;
    expect(p2.kitchenId).toBe(homeKitchenId);
    expect(p2.recipeData?.name).toBe(RECIPE_NAMES.boiledCustard);
    expect(p2.status).toBe("pending");
    expect(p2.cookPlan).not.toBeNull();
    expect(p2.cookPlanError).toBeNull();
    expect(p2.finishedBy).toBeNull();
    expect(p2.createdAt).toEqual(SEED_TIMES.P2.createdAt);
    expect(p2.startedAt).toBeNull();
    expect(p2.completedAt).toBeNull();

    const p3 = byId.get(seeded.ids.P3)!;
    expect(p3.kitchenId).toBe(homeKitchenId);
    expect(p3.recipeData?.name).toBe(RECIPE_NAMES.pantryTomatoSoup);
    expect(p3.status).toBe("pending");
    expect(p3.cookPlan).toBeNull();
    expect(p3.cookPlanError).toBeNull();
    expect(p3.finishedBy).toBeNull();
    expect(p3.createdAt).toEqual(SEED_TIMES.P3.createdAt);
    expect(p3.startedAt).toBeNull();
    expect(p3.completedAt).toBeNull();

    const p4 = byId.get(seeded.ids.P4)!;
    expect(p4.kitchenId).toBe(homeKitchenId);
    expect(p4.recipeData?.name).toBe(RECIPE_NAMES.sesameGreenBeans);
    expect(p4.status).toBe("pending");
    expect(p4.cookPlan).toBeNull();
    expect(p4.cookPlanError).toBe(COOK_PLAN_BLOCKED);
    expect(p4.finishedBy).toBeNull();
    expect(p4.createdAt).toEqual(SEED_TIMES.P4.createdAt);
    expect(p4.startedAt).toBeNull();
    expect(p4.completedAt).toBeNull();

    const f1 = byId.get(seeded.ids.F1)!;
    expect(f1.kitchenId).toBe(homeKitchenId);
    expect(f1.recipeData?.name).toBe(RECIPE_NAMES.waffles);
    expect(f1.status).toBe("completed");
    expect(f1.cookPlan).not.toBeNull();
    expect(f1.cookPlanError).toBeNull();
    expect(f1.finishedBy).toBe("pressed");
    expect(f1.createdAt).toEqual(SEED_TIMES.F1.createdAt);
    expect(f1.startedAt).toEqual(SEED_TIMES.F1.startedAt);
    expect(f1.completedAt).toEqual(SEED_TIMES.F1.completedAt);

    const f2 = byId.get(seeded.ids.F2)!;
    expect(f2.kitchenId).toBe(homeKitchenId);
    expect(f2.recipeData?.name).toBe(RECIPE_NAMES.herbOmelette);
    expect(f2.status).toBe("completed");
    expect(f2.cookPlan).toBeNull();
    expect(f2.cookPlanError).toBeNull();
    expect(f2.finishedBy).toBe("pressed");
    expect(f2.createdAt).toEqual(SEED_TIMES.F2.createdAt);
    expect(f2.startedAt).toEqual(SEED_TIMES.F2.startedAt);
    expect(f2.completedAt).toEqual(SEED_TIMES.F2.completedAt);

    const x1 = byId.get(seeded.ids.X1)!;
    expect(x1.kitchenId).toBe(homeKitchenId);
    expect(x1.recipeData?.name).toBe(RECIPE_NAMES.parkerHouseRolls);
    expect(x1.status).toBe("cancelled");
    expect(x1.cookPlan).not.toBeNull();
    expect(x1.cookPlanError).toBeNull();
    expect(x1.finishedBy).toBeNull();
    expect(x1.createdAt).toEqual(SEED_TIMES.X1.createdAt);
    expect(x1.startedAt).toBeNull();
    expect(x1.completedAt).toBeNull();
  });

  it("SEED-2: every pending row reads back cleanly and every pack row has a current stored plan", async () => {
    const seeded = await seedDatabase();
    const packFiles = await loadAppPackFiles({ sources: PACK_FILE_SOURCES });
    expect(packFiles.libraries).not.toBeNull();

    const pendingIds = [seeded.ids.P1, seeded.ids.P2, seeded.ids.P3, seeded.ids.P4];
    for (const id of pendingIds) {
      const item = await getQueueItemForKitchen(homeKitchenId, id);
      expect(item).not.toBeNull();
      const reading = readQueueItem(item!, packFiles);
      expect(reading.conversionError).toBeNull();
      expect(reading.packRecipe).not.toBeNull();
      expect(reading.packRecipe!.steps.length).toBeGreaterThan(0);
    }

    const packRowIds = [seeded.ids.P1, seeded.ids.P2, seeded.ids.F1, seeded.ids.X1];
    for (const id of packRowIds) {
      const item = await getQueueItemForKitchen(homeKitchenId, id);
      expect(item).not.toBeNull();
      const reading = readQueueItem(item!, packFiles);
      expect(reading.conversionError).toBeNull();
      expect(reading.reading).toBe("native");
      expect(reading.scales).toBe(true);
      expect(item!.servesEstimate).not.toBeNull();
      expect(item!.servesEstimateBasis).not.toBeNull();

      const planOutcome = cookPlanWithoutDerive(item!);
      expect(planOutcome).not.toBeNull();
      expect(planOutcome!.plan).not.toBeNull();
      expect(planOutcome!.error).toBeNull();
    }

    // Confirm P3 carries a 12-minute timer offer for the cook timer spec while P1 and P2 carry none.
    const p3Item = (await getQueueItemForKitchen(homeKitchenId, seeded.ids.P3))!;
    const p3Reading = readQueueItem(p3Item, packFiles);
    const p3Offers = timerOffers(identityPlan(p3Item.recipeData!), p3Reading.packRecipe!, {
      queueId: p3Item.id,
      recipeName: p3Item.recipeData!.name,
    });
    expect(p3Offers.size).toBe(1);
    const [p3Offer] = p3Offers.values();
    expect(p3Offer!.durationSec).toBe(720);
  });

  it("SEED-3: queueing a pack recipe with edited step text throws naming the recipe and adds no row", async () => {
    await seedDatabase();
    const beforeCount = (await db.select().from(kitchenQueue)).length;

    const shelf = await loadAppShelf(homeKitchenId, { sources: PACK_FILE_SOURCES });
    const pack = shelf.packs.find((entry) => entry.pack.id === BUNDLED_PACK_ID)!.pack;
    const original = pack.recipes.find(
      (entry) => entry.id === PACK_RECIPE_IDS.thinWhiteSauce,
    )!;
    const edited = {
      ...original,
      steps: original.steps.map((step, index) =>
        index === 0 ? { ...step, text: `${step.text} Stir once more.` } : step,
      ),
    };

    const planFileRead = await readPackPlanFile(PACK_PLANS_DIR, BUNDLED_PACK_ID);
    if (!planFileRead.ok) throw new Error(planFileRead.reason);

    await expect(
      queuePackRecipe(homeKitchenId, pack.id, edited, planFileRead.file),
    ).rejects.toThrow(/Thin White Sauce/);

    const afterCount = (await db.select().from(kitchenQueue)).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("SEED-4: running seedDatabase twice leaves the same seven rows", async () => {
    await seedDatabase();
    const first = (
      await db.select().from(kitchenQueue).orderBy(asc(kitchenQueue.createdAt))
    ).map((row) => ({
      name: row.recipeData?.name,
      status: row.status,
      finishedBy: row.finishedBy,
      cookPlanError: row.cookPlanError,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    }));

    await seedDatabase();
    const second = (
      await db.select().from(kitchenQueue).orderBy(asc(kitchenQueue.createdAt))
    ).map((row) => ({
      name: row.recipeData?.name,
      status: row.status,
      finishedBy: row.finishedBy,
      cookPlanError: row.cookPlanError,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    }));

    expect(second).toHaveLength(7);
    expect(second).toEqual(first);
  });

  it("SEED-5: leaves only the home kitchen and no auth, member, invite, token, report, or chat rows", async () => {
    await seedDatabase();

    const allKitchens = await db.select().from(kitchens);
    expect(allKitchens).toHaveLength(1);
    expect(allKitchens[0]!.slug).toBe("home");

    expect(await db.select().from(members)).toHaveLength(0);
    expect(await db.select().from(invites)).toHaveLength(0);
    expect(await db.select().from(authUser)).toHaveLength(0);
    expect(await db.select().from(authSession)).toHaveLength(0);
    expect(await db.select().from(authAccount)).toHaveLength(0);
    expect(await db.select().from(authVerification)).toHaveLength(0);
    expect(await db.select().from(kitchenWebhookTokens)).toHaveLength(0);
    expect(await db.select().from(cookReports)).toHaveLength(0);
    expect(await db.select().from(conversationLogs)).toHaveLength(0);
  });

  it("SNAP-1: restores every data table row for row after mutations across tables", async () => {
    const seeded = await seedDatabase();
    const baseline = await dumpDataTables();

    await client.exec(snapshotSql());

    // Delete P2
    await db
      .delete(kitchenQueue)
      .where(
        and(eq(kitchenQueue.kitchenId, homeKitchenId), eq(kitchenQueue.id, seeded.ids.P2)),
      );
    // Change P1's status
    await db
      .update(kitchenQueue)
      .set({ status: "cooking" })
      .where(
        and(eq(kitchenQueue.kitchenId, homeKitchenId), eq(kitchenQueue.id, seeded.ids.P1)),
      );
    // Insert a new queue row
    await db.insert(kitchenQueue).values({
      kitchenId: homeKitchenId,
      recipeData: { name: "Temporary Soup", serves: 2, ingredients: [], steps: ["Boil."] },
      status: "pending",
    });
    // Insert a cook report row
    await db.insert(cookReports).values({
      id: randomUUID(),
      kitchenId: homeKitchenId,
      capturedAt: new Date("2026-03-10T11:05:00Z"),
      build: "test-build",
      path: `/kitchen/queue/${seeded.ids.P1}`,
      screen: "step",
      queueId: seeded.ids.P1,
      recipeName: RECIPE_NAMES.thinWhiteSauce,
      state: { mode: "ahead", pos: 0, ticked: [], passed: [], kept: [] },
      context: {
        viewport: { w: 1280, h: 800, dpr: 1 },
        ua: "test",
        online: true,
        voice: { mode: null, status: "off" },
        ask: { sessionId: "test", open: false },
        layers: { pane: false, card: null, more: false },
        part: null,
      },
      events: [],
      dom: "<main></main>",
      domTruncated: false,
      note: "Test report note",
    });
    // Insert a conversation row
    await db.insert(conversationLogs).values({
      kitchenId: homeKitchenId,
      sessionId: "test-session",
      role: "user",
      content: "Is the pan hot enough?",
    });

    await client.exec(restoreSql());

    const restored = await dumpDataTables();
    expect(restored).toEqual(baseline);
  });
});
