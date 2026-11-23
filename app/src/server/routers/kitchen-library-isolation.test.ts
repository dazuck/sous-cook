/**
 * Library-level kitchen isolation tests against a real migrated PGlite
 * database. Exercises direct library calls with another kitchen's id and
 * deterministic mid-operation kitchen transfers to verify every kitchen filter
 * in kitchen-queue, kitchen-auto-finish, and kitchen-cook-log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { FakeProviderController } from "../../lib/__tests__/fake-provider";
import { ZUCCHINI_RECIPE, zucchiniRaw } from "../../lib/kitchen/__tests__/zucchini-wraps";

const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/providers/google", () => ({
  createGoogleProvider: () => provider.provider("google"),
}));
vi.mock("@/lib/ai/providers/anthropic", () => ({
  createAnthropicProvider: () => provider.provider("anthropic"),
}));
vi.mock("@/lib/kitchen/zone", () => ({
  KITCHEN_TIME_ZONE: "America/New_York",
}));
vi.mock("@/lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../../lib/hooks/types");
  return {
    connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, true])),
  };
});
vi.mock("@/lib/hooks/registry", async () => {
  const { scriptedCookLog } = await import(
    "../../lib/__tests__/scripted-cook-log"
  );
  return { hook: () => scriptedCookLog((url, init) => mockFetch(url, init)) };
});
vi.mock("@/lib/db", async () =>
  (await import("../../lib/__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db, kitchenQueue } from "@/lib/db";
import { connected } from "@/lib/hooks/connected";
import {
  seedKitchen,
  seedQueueRow,
  snapshotRow,
  type KitchenRow,
} from "@/lib/__tests__/kitchens";
import {
  deriveAndStoreCookPlan,
  ensureIntakeForCook,
  selectCookPlanBackfill,
  updateQueueStatus,
} from "@/lib/kitchen-queue";
import {
  reopenAutoFinished,
  reportLastScreen,
  sweepAndLogIdleCooks,
} from "@/lib/kitchen-auto-finish";
import {
  CookLogItemNotFound,
  dismissCookAsk,
  logCook,
  openCookAsk,
  rateCook,
} from "@/lib/kitchen-cook-log";
import { cookLogTimestamp } from "@/lib/hooks/cook-log";
import { AUTO_FINISH_IDLE_MS } from "@/lib/kitchen/auto-finish";
import { sourceHash } from "@/lib/serves-estimate-plan";

const client = (dbModule as unknown as { client: PGlite }).client;
const provider = new FakeProviderController();

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;

const INTAKE_SENT: KitchenQueueRecipeData = {
  name: "Zucchini wraps",
  serves: 4,
  ...ZUCCHINI_RECIPE,
};

const INTAKE_CUT: KitchenQueueRecipeData = {
  ...INTAKE_SENT,
  ingredients: (ZUCCHINI_RECIPE.ingredients ?? []).map((line, i) =>
    i === 0 ? { ...line, item: "green zucchini" } : line,
  ),
  stepIngredients: [[0, 1, 2, 3], [4], [5], [], [6]],
};

async function moveRowToKitchen(queueId: string, newKitchenId: string): Promise<void> {
  await db
    .update(kitchenQueue)
    .set({ kitchenId: newKitchenId })
    .where(eq(kitchenQueue.id, queueId));
}

beforeEach(async () => {
  provider.reset();
  mockFetch.mockReset();
  connected["cook-log"] = true;
  vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
  vi.stubEnv("AI_TEXT_PROVIDER", "google");
  vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");

  await client.exec("delete from conversation_logs; truncate table kitchen_queue;");
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchenA = (await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" })).kitchen;
  kitchenB = (await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" })).kitchen;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("kitchen-queue library isolation", () => {
  it("updateQueueStatus into cooking with another kitchen's id leaves the row unchanged", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, { status: "pending" });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    const res = await updateQueueStatus(kitchenB.id, rowA.id, "cooking");
    expect(res).toEqual({ completed: false, started: false });
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });

  it("updateQueueStatus into completed (pressed) with another kitchen's id leaves the row unchanged", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      startedAt: new Date(Date.now() - 30 * 60_000),
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    const res = await updateQueueStatus(kitchenB.id, rowA.id, "completed", {
      by: "pressed",
    });
    expect(res).toEqual({ completed: false, started: false });
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });

  it("updateQueueStatus into completed (auto) with another kitchen's id leaves the row unchanged", async () => {
    const now = new Date();
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      startedAt: new Date(now.getTime() - 120 * 60_000),
      lastScreenActiveAt: new Date(now.getTime() - AUTO_FINISH_IDLE_MS - 60_000),
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    const res = await updateQueueStatus(kitchenB.id, rowA.id, "completed", {
      by: "auto",
      idleBefore: now,
    });
    expect(res).toEqual({ completed: false, started: false });
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });

  it("updateQueueStatus into cancelled with another kitchen's id leaves the row unchanged", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, { status: "pending" });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    const res = await updateQueueStatus(kitchenB.id, rowA.id, "cancelled");
    expect(res).toEqual({ completed: false, started: false });
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });

  it("deriveAndStoreCookPlan does not write a plan if the row moved to another kitchen mid-derivation", async () => {
    const row = await seedQueueRow(db, kitchenB.id, {
      recipeData: { name: "Sweet Zucchini Wraps", ...ZUCCHINI_RECIPE },
    });
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    provider.onNextChat(async () => {
      await moveRowToKitchen(row.id, kitchenA.id);
      afterMove = await snapshotRow(db, kitchenQueue, row.id);
      return {
        content: JSON.stringify(zucchiniRaw()),
        finishReason: "stop",
      };
    });

    await expect(deriveAndStoreCookPlan(kitchenB.id, row.id)).rejects.toThrow(
      /Kitchen queue item not found/,
    );
    expect(afterMove).not.toBeNull();
    expect(await snapshotRow(db, kitchenQueue, row.id)).toEqual(afterMove);
  });

  it("deriveAndStoreCookPlan does not write a plan error if the row moved to another kitchen mid-derivation", async () => {
    const row = await seedQueueRow(db, kitchenB.id, {
      recipeData: { name: "Sweet Zucchini Wraps", ...ZUCCHINI_RECIPE },
    });
    let moved = false;
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    provider.setDefaultChat(async () => {
      if (!moved) {
        moved = true;
        await moveRowToKitchen(row.id, kitchenA.id);
        afterMove = await snapshotRow(db, kitchenQueue, row.id);
      }
      throw new Error("provider 503");
    });

    await expect(deriveAndStoreCookPlan(kitchenB.id, row.id)).rejects.toThrow(
      /Kitchen queue item not found/,
    );
    expect(afterMove).not.toBeNull();
    expect(await snapshotRow(db, kitchenQueue, row.id)).toEqual(afterMove);
  });

  it("selectCookPlanBackfill returns only the requested kitchen's open rows", async () => {
    const t1 = new Date("2026-10-04T12:00:00.000Z");
    const t2 = new Date("2026-10-04T12:01:00.000Z");
    const todoA = await seedQueueRow(db, kitchenA.id, {
      status: "pending",
      createdAt: t1,
      recipeData: { name: "A Todo", steps: ["Cook."], serves: 2 },
    });
    const settledA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      createdAt: t2,
      cookPlanError: "rejected (uncovered-step): step 1 is in no task",
      recipeData: { name: "A Settled", steps: ["Cook."], serves: 2 },
    });
    await seedQueueRow(db, kitchenB.id, {
      status: "pending",
      createdAt: t1,
      recipeData: { name: "B Todo", steps: ["Cook."], serves: 2 },
    });
    await seedQueueRow(db, kitchenB.id, {
      status: "cooking",
      createdAt: t2,
      cookPlanError: "rejected (uncovered-step): step 1 is in no task",
      recipeData: { name: "B Settled", steps: ["Cook."], serves: 2 },
    });

    const selected = await selectCookPlanBackfill(kitchenA.id);
    expect(selected.open.map((r) => r.id)).toEqual([todoA.id, settledA.id]);
    expect(selected.todo.map((r) => r.id)).toEqual([todoA.id]);
    expect(selected.settled.map((r) => r.id)).toEqual([settledA.id]);
  });

  it("ensureIntakeForCook does not write an intake error if the row moved to another kitchen mid-run", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const row = await seedQueueRow(db, kitchenB.id, {
      recipeData: INTAKE_SENT,
      intakeSourceHash: sourceHash("kitchen_queue", INTAKE_SENT),
    });
    let moved = false;
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    provider.setDefaultChat(async () => {
      if (!moved) {
        moved = true;
        await moveRowToKitchen(row.id, kitchenA.id);
        afterMove = await snapshotRow(db, kitchenQueue, row.id);
      }
      throw Object.assign(new Error("503 overloaded"), { status: 503 });
    });

    await expect(
      ensureIntakeForCook(kitchenB.id, row.id, "opening"),
    ).rejects.toThrow(/Kitchen queue item not found/);
    expect(afterMove).not.toBeNull();
    expect(await snapshotRow(db, kitchenQueue, row.id)).toEqual(afterMove);
    info.mockRestore();
  });

  it("ensureIntakeForCook does not write an intake cut if the row moved to another kitchen mid-run", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const row = await seedQueueRow(db, kitchenB.id, {
      recipeData: INTAKE_SENT,
      intakeSourceHash: sourceHash("kitchen_queue", INTAKE_SENT),
    });
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    provider.onNextChat(async () => {
      await moveRowToKitchen(row.id, kitchenA.id);
      afterMove = await snapshotRow(db, kitchenQueue, row.id);
      return {
        content: JSON.stringify({
          name: INTAKE_CUT.name,
          ingredients: INTAKE_CUT.ingredients,
          steps: INTAKE_CUT.steps,
          stepIngredients: INTAKE_CUT.stepIngredients,
        }),
        finishReason: "stop",
      };
    });

    await expect(
      ensureIntakeForCook(kitchenB.id, row.id, "opening"),
    ).rejects.toThrow(/Kitchen queue item not found/);
    expect(afterMove).not.toBeNull();
    expect(await snapshotRow(db, kitchenQueue, row.id)).toEqual(afterMove);
    info.mockRestore();
  });
});

describe("kitchen-auto-finish library isolation", () => {
  it("reportLastScreen with another kitchen's id leaves the row unchanged", async () => {
    const now = new Date();
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      startedAt: new Date(now.getTime() - 30 * 60_000),
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    const res = await reportLastScreen(kitchenB.id, rowA.id, now, now);
    expect(res).toEqual({ cooking: false, autoFinished: false });
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });

  it("sweepAndLogIdleCooks does not select another kitchen's sitting cook even if it moves mid-sweep", async () => {
    const now = new Date();
    const idleAt = new Date(now.getTime() - AUTO_FINISH_IDLE_MS - 60_000);
    const startedAt = new Date(now.getTime() - 120 * 60_000);

    // Seed B first, then A, on a freshly truncated table so an unfiltered scan
    // visits B before A.
    const rowB = await seedQueueRow(db, kitchenB.id, {
      status: "cooking",
      startedAt,
      lastScreenActiveAt: idleAt,
      recipeData: { name: "B Soup", steps: ["Simmer."], serves: 2 },
    });
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      startedAt,
      lastScreenActiveAt: idleAt,
      recipeData: { name: "A Stew", steps: ["Simmer."], serves: 2 },
    });

    const rows: string[][] = [
      ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
    ];
    let afterMoveA: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const [values] = JSON.parse(String(init.body)).values as string[][];
        rows.push(values);
        if (!afterMoveA) {
          await moveRowToKitchen(rowA.id, kitchenB.id);
          afterMoveA = await snapshotRow(db, kitchenQueue, rowA.id);
        }
        return {
          ok: true,
          json: async () => ({
            updates: {
              updatedRange: `'Cook Log'!A${rows.length}:E${rows.length}`,
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ values: rows.map((r) => [...r]) }),
      };
    });

    const result = await sweepAndLogIdleCooks(kitchenB.id, now);
    expect(result.finished.map((f) => f.queueId)).toEqual([rowB.id]);
    expect(afterMoveA).not.toBeNull();
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(afterMoveA);
  });

  it("sweepAndLogIdleCooks relog pass ignores another kitchen's unlogged auto-finished cook", async () => {
    const now = new Date();
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "completed",
      finishedBy: "auto",
      completedAt: new Date(now.getTime() - 10 * 60_000),
      cookLog: null,
      cookLogError: "Cook Log API 503",
      recipeData: { name: "A Stew", steps: ["Simmer."], serves: 2 },
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    const result = await sweepAndLogIdleCooks(kitchenB.id, now);
    expect(result).toEqual({ finished: [], relogged: [] });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });

  it("reopenAutoFinished with another kitchen's id leaves the row unchanged", async () => {
    const now = new Date();
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "completed",
      finishedBy: "auto",
      completedAt: new Date(now.getTime() - 10 * 60_000),
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    const res = await reopenAutoFinished(kitchenB.id, rowA.id, now);
    expect(res).toEqual({ reopened: false });
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });
});

describe("kitchen-cook-log library isolation", () => {
  it("logCook does not store a cook-log error if the row moved to another kitchen during append", async () => {
    const now = new Date("2026-10-04T23:02:00.000Z");
    const row = await seedQueueRow(db, kitchenB.id, {
      status: "completed",
      completedAt: now,
      cookLog: null,
      recipeData: { name: "B Soup", steps: ["Simmer."], serves: 2 },
    });
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    mockFetch.mockImplementation(async () => {
      if (!afterMove) {
        await moveRowToKitchen(row.id, kitchenA.id);
        afterMove = await snapshotRow(db, kitchenQueue, row.id);
      }
      throw new Error("Cook Log API 503");
    });

    const outcome = await logCook(kitchenB.id, row.id, now);
    expect(outcome.status).toBe("failed");
    expect(afterMove).not.toBeNull();
    expect(await snapshotRow(db, kitchenQueue, row.id)).toEqual(afterMove);
  });

  it("logCook does not update cookLog during moveRow if the row moved to another kitchen mid-retime", async () => {
    const firstFinish = new Date("2026-10-04T23:02:00.000Z");
    const secondFinish = new Date("2026-10-04T23:30:00.000Z");
    const firstStamp = cookLogTimestamp(firstFinish);
    const row = await seedQueueRow(db, kitchenB.id, {
      status: "completed",
      finishedBy: "auto",
      completedAt: secondFinish,
      cookLog: {
        row: 2,
        timestamp: firstStamp,
        recipeName: "B Soup",
        adopted: false,
      },
      recipeData: { name: "B Soup", steps: ["Simmer."], serves: 2 },
    });
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    const sheetRows: string[][] = [
      ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
      [firstStamp, "B Soup", "", "", ""],
    ];
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        await moveRowToKitchen(row.id, kitchenA.id);
        afterMove = await snapshotRow(db, kitchenQueue, row.id);
        return { ok: true, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({ values: sheetRows.map((r) => [...r]) }),
      };
    });

    await expect(logCook(kitchenB.id, row.id, secondFinish)).rejects.toThrow(
      CookLogItemNotFound,
    );
    expect(afterMove).not.toBeNull();
    const after = await snapshotRow(db, kitchenQueue, row.id);
    expect(after?.cookLog).toEqual({
      row: 2,
      timestamp: firstStamp,
      recipeName: "B Soup",
      adopted: false,
    });
    expect(after).toEqual(afterMove);
  });

  it("logCook does not clear cookLogClaimedAt in moveRow finally if the row moved to another kitchen mid-retime", async () => {
    const firstFinish = new Date("2026-10-04T23:02:00.000Z");
    const secondFinish = new Date("2026-10-04T23:30:00.000Z");
    const firstStamp = cookLogTimestamp(firstFinish);
    const row = await seedQueueRow(db, kitchenB.id, {
      status: "completed",
      finishedBy: "auto",
      completedAt: secondFinish,
      cookLog: {
        row: 2,
        timestamp: firstStamp,
        recipeName: "B Soup",
        adopted: false,
      },
      recipeData: { name: "B Soup", steps: ["Simmer."], serves: 2 },
    });
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    const sheetRows: string[][] = [
      ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
      [firstStamp, "B Soup", "", "", ""],
    ];
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        await moveRowToKitchen(row.id, kitchenA.id);
        afterMove = await snapshotRow(db, kitchenQueue, row.id);
        throw new Error("Cook Log API 503");
      }
      return {
        ok: true,
        json: async () => ({ values: sheetRows.map((r) => [...r]) }),
      };
    });

    await expect(logCook(kitchenB.id, row.id, secondFinish)).rejects.toThrow(
      /Cook Log API 503/,
    );
    expect(afterMove).not.toBeNull();
    const after = await snapshotRow(db, kitchenQueue, row.id);
    expect(after?.cookLogClaimedAt).toEqual(secondFinish);
    expect(after).toEqual(afterMove);
  });

  it("logCook does not store the appended cookLog if the row moved to another kitchen during append", async () => {
    const now = new Date("2026-10-04T23:02:00.000Z");
    const row = await seedQueueRow(db, kitchenB.id, {
      status: "completed",
      completedAt: now,
      cookLog: null,
      recipeData: { name: "B Soup", steps: ["Simmer."], serves: 2 },
    });
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    const sheetRows: string[][] = [
      ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
    ];
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const [values] = JSON.parse(String(init.body)).values as string[][];
        sheetRows.push(values);
        await moveRowToKitchen(row.id, kitchenA.id);
        afterMove = await snapshotRow(db, kitchenQueue, row.id);
        return {
          ok: true,
          json: async () => ({
            updates: {
              updatedRange: `'Cook Log'!A${sheetRows.length}:E${sheetRows.length}`,
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ values: sheetRows.map((r) => [...r]) }),
      };
    });

    await expect(logCook(kitchenB.id, row.id, now)).rejects.toThrow(
      CookLogItemNotFound,
    );
    expect(afterMove).not.toBeNull();
    expect(await snapshotRow(db, kitchenQueue, row.id)).toEqual(afterMove);
  });

  it("rateCook does not close the ask or update cookLog if the row moved to another kitchen during rating", async () => {
    const now = new Date("2026-10-04T23:02:00.000Z");
    const stamp = cookLogTimestamp(now);
    const row = await seedQueueRow(db, kitchenB.id, {
      status: "completed",
      completedAt: now,
      ratingClosedAt: null,
      cookLog: {
        row: 2,
        timestamp: stamp,
        recipeName: "B Soup",
        adopted: false,
      },
      recipeData: { name: "B Soup", steps: ["Simmer."], serves: 2 },
    });
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    const sheetRows: string[][] = [
      ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
      [stamp, "B Soup", "", "", ""],
    ];
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        await moveRowToKitchen(row.id, kitchenA.id);
        afterMove = await snapshotRow(db, kitchenQueue, row.id);
        return { ok: true, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({ values: sheetRows.map((r) => [...r]) }),
      };
    });

    const outcome = await rateCook(
      kitchenB.id,
      { queueId: row.id, rating: 5, notes: "great" },
      now,
    );
    expect(outcome.rated).toBe(true);
    expect(afterMove).not.toBeNull();
    expect(await snapshotRow(db, kitchenQueue, row.id)).toEqual(afterMove);
  });

  it("openCookAsk does not close a rated ask if the row moved to another kitchen while reading the cook log", async () => {
    const now = new Date("2026-10-04T23:02:00.000Z");
    const stamp = cookLogTimestamp(now);
    const row = await seedQueueRow(db, kitchenB.id, {
      status: "completed",
      completedAt: now,
      ratingClosedAt: null,
      cookLog: {
        row: 2,
        timestamp: stamp,
        recipeName: "B Soup",
        adopted: false,
      },
      recipeData: { name: "B Soup", steps: ["Simmer."], serves: 2 },
    });
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    mockFetch.mockImplementation(async () => {
      if (!afterMove) {
        await moveRowToKitchen(row.id, kitchenA.id);
        afterMove = await snapshotRow(db, kitchenQueue, row.id);
      }
      return {
        ok: true,
        json: async () => ({
          values: [
            ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
            [stamp, "B Soup", "", "5", "already rated"],
          ],
        }),
      };
    });

    const ask = await openCookAsk(kitchenB.id, now);
    expect(ask).toBeNull();
    expect(afterMove).not.toBeNull();
    expect(await snapshotRow(db, kitchenQueue, row.id)).toEqual(afterMove);
  });

  it("openCookAsk does not rewrite cookLog row position if the row moved to another kitchen while reading the cook log", async () => {
    const now = new Date("2026-10-04T23:02:00.000Z");
    const stamp = cookLogTimestamp(now);
    const row = await seedQueueRow(db, kitchenB.id, {
      status: "completed",
      completedAt: now,
      ratingClosedAt: null,
      cookLog: {
        row: 2,
        timestamp: stamp,
        recipeName: "B Soup",
        adopted: false,
      },
      recipeData: { name: "B Soup", steps: ["Simmer."], serves: 2 },
    });
    let afterMove: Awaited<ReturnType<typeof snapshotRow<typeof kitchenQueue>>> = null;

    mockFetch.mockImplementation(async () => {
      if (!afterMove) {
        await moveRowToKitchen(row.id, kitchenA.id);
        afterMove = await snapshotRow(db, kitchenQueue, row.id);
      }
      return {
        ok: true,
        json: async () => ({
          values: [
            ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
            ["2026-10-01 18:00", "Other Dish", "", "", ""],
            [stamp, "B Soup", "", "", ""],
          ],
        }),
      };
    });

    const ask = await openCookAsk(kitchenB.id, now);
    expect(ask).toEqual({
      queueId: row.id,
      name: "B Soup",
      state: "logged",
    });
    expect(afterMove).not.toBeNull();
    expect(await snapshotRow(db, kitchenQueue, row.id)).toEqual(afterMove);
  });

  it("dismissCookAsk with another kitchen's id throws not found and leaves the row unchanged", async () => {
    const now = new Date("2026-10-04T23:02:00.000Z");
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "completed",
      completedAt: now,
      ratingClosedAt: null,
      recipeData: { name: "A Stew", steps: ["Simmer."], serves: 2 },
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    await expect(dismissCookAsk(kitchenB.id, rowA.id)).rejects.toThrow(
      CookLogItemNotFound,
    );
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });
});
