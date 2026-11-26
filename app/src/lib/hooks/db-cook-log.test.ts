import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db, docRecipes, kitchenCookLog, kitchenQueue } from "@/lib/db";
import {
  callerFor,
  homeKitchen,
  seedKitchen,
  seedQueueRow,
} from "../__tests__/kitchens";
import { resetDeploymentCheckForTests } from "../kitchens/deployment";
import { connected } from "./connected";
import { HOOK_NAMES } from "./types";
import { appRouter } from "../../server/routers/_app";
import { createTRPCContext } from "../../server/trpc";
import { addKitchenToCircle, createCircle } from "../kitchens/circles";
import { getCircleDishesForKitchen } from "../circle-dishes";
import {
  CookLogConflict,
  getCookAskHeldBack,
  listCookLogEntries,
  logCook,
  rateCook,
  retryCookLog,
  setCookLogHeldBack,
  updateCookLogEntry,
} from "../kitchen-cook-log";
import { updateQueueStatus } from "../kitchen-queue";
import { dbCookLog } from "./db-cook-log";

const client = (dbModule as unknown as { client: PGlite }).client;

let homeId: string;
let kitchenAId: string;
let kitchenBId: string;
let memberAId: string;
let callerA: ReturnType<typeof callerFor>;
let callerB: ReturnType<typeof callerFor>;

beforeEach(async () => {
  await client.exec(
    "delete from circle_members; delete from circles; delete from kitchen_cook_log; delete from doc_recipes; delete from kitchen_queue; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  homeId = (await homeKitchen(db)).id;
  const seededA = await seedKitchen(db, { slug: "cooklog-a", name: "Cooklog A" });
  const seededB = await seedKitchen(db, { slug: "cooklog-b", name: "Cooklog B" });
  kitchenAId = seededA.kitchen.id;
  memberAId = seededA.member.id;
  kitchenBId = seededB.kitchen.id;
  callerA = callerFor(seededA.kitchen, { id: memberAId, role: "owner" });
  callerB = callerFor(seededB.kitchen, { id: seededB.member.id, role: "owner" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dbCookLog (per-kitchen CookLogGrid)", () => {
  it("isolates rows and row numbers per kitchen", async () => {
    const gridA = dbCookLog(kitchenAId);
    const gridB = dbCookLog(kitchenBId);

    const rowA = await gridA.append([
      "2026-03-10 18:00",
      "Lemon Soup",
      "Lemon Soup",
      "",
      "",
    ]);
    const rowB = await gridB.append([
      "2026-03-10 19:00",
      "Spicy Dal",
      "Spicy Dal",
      "",
      "",
    ]);

    expect(rowA).toBe(2);
    expect(rowB).toBe(2);

    await gridB.write(2, 4, ["5", "Great"]);

    expect(await gridA.read()).toEqual([
      ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
      ["2026-03-10 18:00", "Lemon Soup", "Lemon Soup", "", ""],
    ]);
    expect(await gridB.read()).toEqual([
      ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
      ["2026-03-10 19:00", "Spicy Dal", "Spicy Dal", "5", "Great"],
    ]);
  });

  it("sets cookedByMemberId to null in single-kitchen mode and member.id in sign-in mode", async () => {
    const homeRow = await seedQueueRow(db, homeId, {
      status: "cooking",
      recipeData: { name: "Single Kitchen Oatmeal" },
    });
    await updateQueueStatus(homeId, homeRow.id, "completed");
    await logCook(homeId, homeRow.id);

    const [homeEntry] = await listCookLogEntries(homeId);
    expect(homeEntry?.cookedByMemberId).toBeNull();
    expect(homeEntry?.cookedByName).toBeNull();

    const rowA = await seedQueueRow(db, kitchenAId, {
      status: "cooking",
      recipeData: { name: "Signed In Risotto" },
    });
    await callerA.updateKitchenQueueStatus({
      queueId: rowA.id,
      status: "completed",
    });
    await logCook(kitchenAId, rowA.id);

    const [entryA] = await listCookLogEntries(kitchenAId);
    expect(entryA?.cookedByMemberId).toBe(memberAId);
    expect(entryA?.cookedByName).toBe("Cooklog A Owner");
  });

  it("links docRecipeId and packSource and enforces notePrivate default false and heldBack rules", async () => {
    const [doc] = await db
      .insert(docRecipes)
      .values({
        kitchenId: kitchenAId,
        docSlug: "weeknight-dal",
        name: "Weeknight Dal",
        rawDocText: "Weeknight Dal\n1 cup lentils\nSimmer 20 min.",
      })
      .returning();

    const docQueue = await seedQueueRow(db, kitchenAId, {
      status: "completed",
      completedAt: new Date("2026-03-10T18:00:00Z"),
      completedByMemberId: memberAId,
      recipeData: { name: "Weeknight Dal", source: "library" },
    });
    await logCook(kitchenAId, docQueue.id);
    await rateCook(kitchenAId, {
      queueId: docQueue.id,
      rating: 3,
      notes: "Too thick",
    });

    const [docEntry] = await listCookLogEntries(kitchenAId);
    expect(docEntry?.docRecipeId).toBe(doc!.id);
    expect(docEntry?.packSource).toBeNull();
    expect(docEntry?.notePrivate).toBe(false);
    expect(docEntry?.heldBack).toBe(true);
    expect(docEntry?.visibilityChosen).toBe(false);

    // Answering twice for one cook updates the single row; never makes two.
    await rateCook(kitchenAId, {
      queueId: docQueue.id,
      rating: 5,
      notes: "Actually great once rested",
      notePrivate: true,
    });
    const entriesAfterSecond = await listCookLogEntries(kitchenAId);
    expect(entriesAfterSecond).toHaveLength(1);
    expect(entriesAfterSecond[0]?.rating).toBe(5);
    expect(entriesAfterSecond[0]?.notes).toBe("Actually great once rested");
    expect(entriesAfterSecond[0]?.notePrivate).toBe(true);
    expect(entriesAfterSecond[0]?.heldBack).toBe(false);

    // Explicit heldBack sets visibilityChosen=true and sticks across later rating changes.
    await updateCookLogEntry(kitchenAId, {
      id: entriesAfterSecond[0]!.id,
      heldBack: true,
    });
    await updateCookLogEntry(kitchenAId, {
      id: entriesAfterSecond[0]!.id,
      rating: 5,
    });
    const [sticky] = await listCookLogEntries(kitchenAId);
    expect(sticky?.heldBack).toBe(true);
    expect(sticky?.visibilityChosen).toBe(true);

    // Pack source is recorded for pack: recipes.
    const packQueue = await seedQueueRow(db, kitchenBId, {
      status: "completed",
      completedAt: new Date("2026-03-10T19:00:00Z"),
      recipeData: {
        name: "Thin White Sauce",
        source: "pack:fannie-farmer-1896/thin-white-sauce",
      },
    });
    await logCook(kitchenBId, packQueue.id);
    const [packEntry] = await listCookLogEntries(kitchenBId);
    expect(packEntry?.packSource).toBe(
      "pack:fannie-farmer-1896/thin-white-sauce",
    );
    expect(packEntry?.docRecipeId).toBeNull();
    expect(await callerB.getCookLog()).toHaveLength(1);
  });

  it("does not block finishing on a failed save and allows retry into kitchen_cook_log", async () => {
    const q = await seedQueueRow(db, homeId, {
      status: "cooking",
      recipeData: { name: "Retryable Stew" },
    });
    const finished = await updateQueueStatus(homeId, q.id, "completed");
    expect(finished.completed).toBe(true);

    const txSpy = vi
      .spyOn(db, "transaction")
      .mockImplementationOnce((() => {
        throw new Error("Simulated transient insert error");
      }) as never);

    const firstAttempt = await logCook(homeId, q.id);
    expect(firstAttempt.status).toBe("failed");
    txSpy.mockRestore();

    const [failedRow] = await db
      .select()
      .from(kitchenQueue)
      .where(eq(kitchenQueue.id, q.id));
    expect(failedRow?.status).toBe("completed");
    expect(failedRow?.cookLogError).toContain("Simulated transient insert error");

    const retried = await retryCookLog(homeId, q.id);
    expect(retried.status).toBe("logged");

    const entries = await db
      .select()
      .from(kitchenCookLog)
      .where(eq(kitchenCookLog.kitchenId, homeId));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recipeTitle).toBe("Retryable Stew");
  });

  it("keeps recook notePrivate and heldBack on the new cook log row rather than the old row", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "on");
    const circle = await createCircle({ name: "Privacy Circle" }, db);
    await addKitchenToCircle({ circleId: circle.id, kitchenSlug: "cooklog-a" }, db);
    await addKitchenToCircle({ circleId: circle.id, kitchenSlug: "cooklog-b" }, db);

    const day1 = new Date(Date.now() + 1_000);
    const day2 = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000);

    const q = await seedQueueRow(db, kitchenAId, {
      status: "completed",
      completedAt: day1,
      completedByMemberId: memberAId,
      recipeData: { name: "Recook Pasta" },
    });
    const firstLog = await logCook(kitchenAId, q.id, day1);
    expect(firstLog.status).toBe("logged");
    await rateCook(kitchenAId, {
      queueId: q.id,
      rating: 5,
      notes: "Day 1 public note",
      notePrivate: false,
      heldBack: false,
    });

    // Reopen and finish the exact same queue row on a later day
    await db
      .update(kitchenQueue)
      .set({
        status: "completed",
        completedAt: day2,
        cookLog: null,
        cookLogError: null,
        cookLogClaimedAt: null,
        ratingClosedAt: null,
      })
      .where(eq(kitchenQueue.id, q.id));

    const secondLog = await logCook(kitchenAId, q.id, day2);
    expect(secondLog.status).toBe("logged");
    if (secondLog.status === "logged") {
      expect(secondLog.log.row).toBe(3);
    }

    // Hold back and rate with a private note on the second cook
    await setCookLogHeldBack(kitchenAId, q.id, true);
    expect(await getCookAskHeldBack(kitchenAId, q.id)).toBe(true);

    await rateCook(kitchenAId, {
      queueId: q.id,
      rating: 5,
      notes: "Day 2 secret note",
      notePrivate: true,
      heldBack: false,
    });

    const entries = await listCookLogEntries(kitchenAId);
    expect(entries).toHaveLength(2);
    const newest = entries[0]!;
    const oldest = entries[1]!;
    expect(oldest.notes).toBe("Day 1 public note");
    expect(oldest.notePrivate).toBe(false);
    expect(oldest.heldBack).toBe(false);
    expect(newest.notes).toBe("Day 2 secret note");
    expect(newest.notePrivate).toBe(true);
    expect(newest.heldBack).toBe(false);

    // Circle peer sees Day 2 dish (heldBack=false) but NEVER sees the private note!
    const dishesForB = await getCircleDishesForKitchen(kitchenBId, db);
    expect(dishesForB).toHaveLength(1);
    expect(dishesForB[0]?.note).toBeNull();
  });

  it("writes note and notePrivate atomically and never leaves a public note if the log row moved", async () => {
    const q = await seedQueueRow(db, kitchenAId, {
      status: "completed",
      completedAt: new Date("2026-03-15T18:00:00Z"),
      recipeData: { name: "Atomic Soup" },
    });
    const logged = await logCook(kitchenAId, q.id);
    expect(logged.status).toBe("logged");

    // Simulate external edit shifting timestamp so stored cookLogRef no longer matches
    await db
      .update(kitchenCookLog)
      .set({ timestampText: "2026-03-15 19:00" })
      .where(eq(kitchenCookLog.kitchenId, kitchenAId));

    await expect(
      rateCook(kitchenAId, {
        queueId: q.id,
        rating: 5,
        notes: "Should never leak publicly",
        notePrivate: true,
      }),
    ).rejects.toMatchObject({ reason: "row-moved" } satisfies Partial<CookLogConflict>);

    const [row] = await db
      .select()
      .from(kitchenCookLog)
      .where(eq(kitchenCookLog.kitchenId, kitchenAId));
    expect(row?.notes).toBe("");
    expect(row?.rating).toBeNull();
  });

  it("refuses heldBack edits in single-kitchen mode", async () => {
    const homeRow = await seedQueueRow(db, homeId, {
      status: "completed",
      completedAt: new Date("2026-03-16T18:00:00Z"),
      recipeData: { name: "Single Kitchen Bread" },
    });
    await logCook(homeId, homeRow.id);
    const [entry] = await listCookLogEntries(homeId);

    await client.exec("delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from kitchens where slug <> 'home';");
    vi.stubEnv("SOUS_SIGN_IN", "off");
    const savedFlags = { ...connected };
    for (const name of HOOK_NAMES) {
      connected[name] = false;
    }
    try {
      resetDeploymentCheckForTests(db);
      const singleCaller = appRouter.createCaller(await createTRPCContext());
      await expect(
        singleCaller.updateCookLogEntry({ id: entry!.id, heldBack: true }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      Object.assign(connected, savedFlags);
      resetDeploymentCheckForTests(db);
      vi.unstubAllEnvs();
    }
  });
});
