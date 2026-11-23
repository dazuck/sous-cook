/**
 * Library-level kitchen isolation tests against a real migrated PGlite
 * database. Exercises direct library calls with another kitchen's id and
 * deterministic mid-operation kitchen transfers to verify every kitchen filter
 * in kitchen-queue, kitchen-auto-finish, kitchen-cook-log, recipe-sync,
 * library-cook-plans, recipe-ideas, cook-reports, and shelf/load.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, type SQL } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { FakeProviderController } from "../../lib/__tests__/fake-provider";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE, zucchiniRaw } from "../../lib/kitchen/__tests__/zucchini-wraps";
import type { LibraryTab } from "../../lib/hooks/types";

const mockFetch = vi.hoisted(() => vi.fn());
const mockReadTabs = vi.hoisted(() => vi.fn<() => Promise<LibraryTab[]>>());
const mockReadIdeasText = vi.hoisted(() => vi.fn<() => Promise<string>>());

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
  return {
    hook: (name: string) => {
      if (name === "recipe-library") return { readTabs: mockReadTabs };
      if (name === "ideas") return { readText: mockReadIdeasText, append: vi.fn() };
      return scriptedCookLog((url, init) => mockFetch(url, init));
    },
  };
});
vi.mock("@/lib/db", async () =>
  (await import("../../lib/__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import {
  conversationLogs,
  cookReports,
  db,
  docRecipes,
  kitchenQueue,
  recipeIdeasCache,
} from "@/lib/db";
import { askExchange, intakeLines } from "@/lib/report-listing-queries";
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
import {
  findStaleRecipes,
  getDocRecipeBySlug,
  readFamilyLibrary,
  syncRecipesFromDoc,
  writeDocOrder,
  type RecipeChunk,
} from "@/lib/recipe-sync";
import {
  readLibraryPlanRows,
  readLibraryPlansForAudit,
  readSavedPlan,
  storeLibraryPlan,
} from "@/lib/library-cook-plans";
import { cachedIdeasCount, getRecipeIdeas } from "@/lib/recipe-ideas";
import {
  REPORTS_PER_DAY,
  annotateCookReport,
  countCookReportsSince,
  storeCookReport,
  type CookReportInput,
} from "@/lib/cook-reports";
import { loadAppShelf } from "@/lib/shelf/load";
import { cookPlanStamp, planSourceHash } from "@/lib/kitchen/cook-plan-stamp";
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
  mockReadTabs.mockReset();
  mockReadIdeasText.mockReset();
  connected["cook-log"] = true;
  connected["recipe-library"] = true;
  connected.ideas = true;
  vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
  vi.stubEnv("AI_TEXT_PROVIDER", "google");
  vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");

  await client.exec(
    "delete from conversation_logs; delete from cook_reports; delete from doc_recipes; delete from recipe_ideas_cache; truncate table kitchen_queue; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
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

async function seedDocRecipe(
  kitchenId: string,
  docSlug: string,
  overrides: Partial<typeof docRecipes.$inferInsert> = {},
) {
  const [row] = await db
    .insert(docRecipes)
    .values({
      kitchenId,
      docSlug,
      name: docSlug,
      category: "indian",
      categoryTitle: "Indian",
      docPosition: 0,
      ingredients: ZUCCHINI_RECIPE.ingredients,
      steps: ZUCCHINI_RECIPE.steps,
      stepIngredients: ZUCCHINI_RECIPE.stepIngredients,
      serves: 4,
      rawDocText: `${docSlug}\n1 cup lentils\nSimmer until tender.`,
      ...overrides,
    })
    .returning();
  return row!;
}

function makeReport(id: string, overrides: Partial<CookReportInput> = {}): CookReportInput {
  return {
    id,
    capturedAt: "2026-10-04T18:00:00.000Z",
    build: "test-build",
    path: "/kitchen/queue/4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
    screen: "step",
    queueId: null,
    recipeName: "Dal",
    stepKey: "s1",
    chapterId: null,
    planVersion: 4,
    plan: null,
    state: { mode: "go", pos: 0, ticked: [], passed: [], kept: [] },
    context: {
      viewport: { w: 1280, h: 800, dpr: 2 },
      ua: "test-agent",
      online: true,
      voice: { mode: null, status: "off" },
      ask: { sessionId: "", open: false },
      layers: { pane: false, card: null, more: false },
      part: null,
    },
    events: [],
    dom: "<div>step</div>",
    domTruncated: false,
    note: "",
    ...overrides,
  };
}

describe("recipe-sync library isolation", () => {
  it("readFamilyLibrary returns only the requested kitchen's rows", async () => {
    await seedDocRecipe(kitchenA.id, "only-a");
    await seedDocRecipe(kitchenB.id, "only-b");

    const rowsA = await readFamilyLibrary(kitchenA.id);
    const rowsB = await readFamilyLibrary(kitchenB.id);
    expect(rowsA.map((r) => r.docSlug)).toEqual(["only-a"]);
    expect(rowsB.map((r) => r.docSlug)).toEqual(["only-b"]);
  });

  it("getDocRecipeBySlug returns null for another kitchen's slug", async () => {
    await seedDocRecipe(kitchenA.id, "only-a");
    expect(await getDocRecipeBySlug(kitchenB.id, "only-a")).toBeNull();
    expect((await getDocRecipeBySlug(kitchenA.id, "only-a"))?.docSlug).toBe("only-a");
  });

  it("findStaleRecipes returns only the requested kitchen's stale rows", async () => {
    await seedDocRecipe(kitchenA.id, "stale-a", { name: "Stale A" });
    await seedDocRecipe(kitchenB.id, "kept-b", { name: "Kept B" });

    expect(await findStaleRecipes(kitchenB.id, ["kept-b"])).toEqual([]);
    expect(await findStaleRecipes(kitchenA.id, ["other"])).toEqual(["Stale A"]);
  });

  it("writeDocOrder updates only the requested kitchen's positions and category titles", async () => {
    const aShared = await seedDocRecipe(kitchenA.id, "shared", {
      docPosition: 0,
      categoryTitle: "A Indian",
    });
    const aOnly = await seedDocRecipe(kitchenA.id, "only-a", {
      docPosition: 1,
      categoryTitle: "A Sides",
    });
    const bShared = await seedDocRecipe(kitchenB.id, "shared", {
      docPosition: 4,
      categoryTitle: "Old B",
    });
    const beforeAShared = await snapshotRow(db, docRecipes, aShared.id);
    const beforeAOnly = await snapshotRow(db, docRecipes, aOnly.id);

    const chunk: RecipeChunk = {
      docSlug: "shared",
      name: "shared",
      category: "mains",
      categoryTitle: "New B",
      position: 0,
      rawText: "shared",
      nonText: false,
    };
    await writeDocOrder(kitchenB.id, [chunk]);

    expect(await snapshotRow(db, docRecipes, aShared.id)).toEqual(beforeAShared);
    expect(await snapshotRow(db, docRecipes, aOnly.id)).toEqual(beforeAOnly);
    const afterB = await snapshotRow(db, docRecipes, bShared.id);
    expect(afterB?.docPosition).toBe(0);
    expect(afterB?.categoryTitle).toBe("New B");
  });

  it("syncRecipesFromDoc does not reuse another kitchen's saved serving estimate", async () => {
    const lines = [
      "1 cup garlic",
      "1 tsp salt",
      "Roast garlic until golden and blend smooth.",
    ];
    const rawText = ["Garlic chutney", ...lines].join("\n");
    const rowA = await seedDocRecipe(kitchenA.id, "garlic-chutney", {
      name: "Garlic chutney",
      serves: null,
      rawDocText: rawText,
      servesEstimate: 99,
      servesEstimateBasis: "kitchen A estimate",
      servesEstimateSourceHash: sourceHash("doc_recipes", rawText),
    });
    const beforeA = await snapshotRow(db, docRecipes, rowA.id);

    mockReadTabs.mockResolvedValueOnce([
      {
        title: "Entrees",
        lines: [],
        nonText: false,
        children: [{ title: "Garlic chutney", lines, nonText: false, children: [] }],
      },
    ]);

    // 1) Extraction (no stated serves), 2) Serves estimate for B, 3) Cook plan for B.
    provider.onNextChat(() => ({
      content: JSON.stringify({
        name: "Garlic chutney",
        ingredients: [
          { item: "garlic", amount: "1", unit: "cup" },
          { item: "salt", amount: "1", unit: "tsp" },
        ],
        steps: ["Roast garlic until golden and blend smooth."],
        stepIngredients: [[0, 1]],
      }),
      finishReason: "stop",
    }));
    provider.onNextChat(() => ({
      content: JSON.stringify({
        serves: 6,
        basis: "kitchen B estimate",
      }),
      finishReason: "stop",
    }));
    provider.onNextChat(() => ({
      content: JSON.stringify({
        tasks: [
          {
            id: "s1",
            sourceStep: 1,
            text: "Roast garlic until golden and blend smooth.",
            kind: "active",
            needs: [],
          },
        ],
      }),
      finishReason: "stop",
    }));

    await syncRecipesFromDoc(kitchenB.id);

    expect(await snapshotRow(db, docRecipes, rowA.id)).toEqual(beforeA);
    const rowB = await getDocRecipeBySlug(kitchenB.id, "garlic-chutney");
    expect(rowB?.servesEstimate).toBe(6);
    expect(rowB?.servesEstimateBasis).toBe("kitchen B estimate");
  });

  it("syncRecipesFromDoc isolates failed upserts, parts-lost reads, parts-lost updates, and successful upserts", async () => {
    const chutneySteps = [
      "Roast the whole cloves in a dry cast iron skillet until deeply fragrant and lightly charred.",
      "Grind the roasted cloves with coarse salt in a mortar until completely smooth and glossy.",
    ];
    const lines = [
      "Serves 4",
      "1 cup garlic",
      "1 tsp salt",
      ...chutneySteps,
      "Keeps a week in the fridge.",
    ];
    const rawText = ["Garlic chutney", ...lines].join("\n");

    // Case 1: A has a failed row; B's failed extraction inserts its own row without touching A.
    const failedA = await seedDocRecipe(kitchenA.id, "failed-dish", {
      name: "Failed dish",
      extractionError: "kitchen A prior failure",
      steps: null,
      ingredients: null,
    });
    const beforeFailedA = await snapshotRow(db, docRecipes, failedA.id);

    // Case 2: A has a saved row matching rawText; B has none. B's extraction drops steps.
    // Because B has no saved row, B saves the extraction instead of tripping partsLost against A.
    const onlyA = await seedDocRecipe(kitchenA.id, "garlic-chutney", {
      name: "Garlic chutney",
      rawDocText: rawText,
      ingredients: [
        { item: "garlic", amount: "1", unit: "cup" },
        { item: "salt", amount: "1", unit: "tsp" },
      ],
      steps: chutneySteps,
      notes: "Keeps a week in the fridge.",
    });
    const beforeOnlyA = await snapshotRow(db, docRecipes, onlyA.id);

    // Case 3: Both A and B have "kept-dish" matching rawText; B's extraction drops steps and
    // moves to category "Entrees". Only B's row updates category/position; A stays unchanged.
    const keptSteps = [
      "Rinse the lentils thoroughly, then simmer them in a heavy pot with turmeric for twenty minutes until tender.",
      "Ladle the warm dal into deep bowls and finish with toasted spices before serving.",
    ];
    const keptLines = [
      "Serves 4",
      "2 cups lentils",
      "1 tsp turmeric",
      ...keptSteps,
    ];
    const keptRaw = ["Kept dish", ...keptLines].join("\n");
    const keptA = await seedDocRecipe(kitchenA.id, "kept-dish", {
      name: "Kept dish",
      category: "indian",
      categoryTitle: "Indian",
      docPosition: 5,
      rawDocText: keptRaw,
      ingredients: [
        { item: "lentils", amount: "2", unit: "cups" },
        { item: "turmeric", amount: "1", unit: "tsp" },
      ],
      steps: keptSteps,
    });
    const beforeKeptA = await snapshotRow(db, docRecipes, keptA.id);
    const keptB = await seedDocRecipe(kitchenB.id, "kept-dish", {
      name: "Kept dish",
      category: "indian",
      categoryTitle: "Indian",
      docPosition: 5,
      rawDocText: keptRaw,
      ingredients: [
        { item: "lentils", amount: "2", unit: "cups" },
        { item: "turmeric", amount: "1", unit: "tsp" },
      ],
      steps: keptSteps,
    });

    mockReadTabs.mockResolvedValueOnce([
      {
        title: "Entrees",
        lines: [],
        nonText: false,
        children: [
          { title: "Failed dish", lines: ["Not a recipe", "Just a note"], nonText: false, children: [] },
          { title: "Garlic chutney", lines, nonText: false, children: [] },
          { title: "Kept dish", lines: keptLines, nonText: false, children: [] },
        ],
      },
    ]);

    provider.setDefaultChat((options) => {
      const prompt = JSON.stringify(options.messages);
      if (prompt.includes("Failed dish")) {
        return { content: JSON.stringify({ isRecipe: false }), finishReason: "stop" };
      }
      if (prompt.includes("Garlic chutney")) {
        return {
          content: JSON.stringify({
            isRecipe: true,
            name: "Garlic chutney",
            serves: 4,
            ingredients: [{ item: "garlic", amount: "1", unit: "cup" }],
            steps: [],
          }),
          finishReason: "stop",
        };
      }
      if (prompt.includes("Kept dish")) {
        return {
          content: JSON.stringify({
            isRecipe: true,
            name: "Kept dish",
            serves: 4,
            ingredients: [{ item: "lentils", amount: "2", unit: "cups" }],
            steps: [],
          }),
          finishReason: "stop",
        };
      }
      return { content: JSON.stringify(zucchiniRaw()), finishReason: "stop" };
    });

    const result = await syncRecipesFromDoc(kitchenB.id);

    // Every kitchen A row is untouched.
    expect(await snapshotRow(db, docRecipes, failedA.id)).toEqual(beforeFailedA);
    expect(await snapshotRow(db, docRecipes, onlyA.id)).toEqual(beforeOnlyA);
    expect(await snapshotRow(db, docRecipes, keptA.id)).toEqual(beforeKeptA);

    // Kitchen B got its own failed row, saved garlic-chutney (no partsLost against A),
    // and kept kept-dish while moving it into Entrees.
    const failedB = await getDocRecipeBySlug(kitchenB.id, "failed-dish");
    expect(failedB?.extractionError).not.toBeNull();
    const chutneyB = await getDocRecipeBySlug(kitchenB.id, "garlic-chutney");
    expect(chutneyB).not.toBeNull();
    expect(chutneyB?.extractionError).toBeNull();
    expect(chutneyB?.steps).toEqual([]);
    const afterKeptB = await snapshotRow(db, docRecipes, keptB.id);
    expect(afterKeptB?.category).toBe("entrees");
    expect(afterKeptB?.categoryTitle).toBe("Entrees");
    expect(afterKeptB?.steps).toEqual(keptSteps);
    expect(result.failures.map((f) => f.name)).toContain("Kept dish");
  });
});

describe("library-cook-plans library isolation", () => {
  const HASH = planSourceHash(ZUCCHINI_RECIPE);
  const PLAN_COLS = {
    cookPlan: ZUCCHINI_PLAN,
    cookPlanError: null,
    cookPlanSourceHash: HASH,
    cookPlanStamp: cookPlanStamp(),
  };

  it("readSavedPlan returns undefined for another kitchen's slug", async () => {
    await seedDocRecipe(kitchenA.id, "zucchini-wraps", PLAN_COLS);
    expect(await readSavedPlan(kitchenB.id, "zucchini-wraps")).toBeUndefined();
    expect(await readSavedPlan(kitchenA.id, "zucchini-wraps")).toEqual(PLAN_COLS);
  });

  it("storeLibraryPlan does not read or overwrite another kitchen's row when B has no row", async () => {
    const rowA = await seedDocRecipe(kitchenA.id, "zucchini-wraps");
    const beforeA = await snapshotRow(db, docRecipes, rowA.id);

    expect(await storeLibraryPlan(kitchenB.id, "zucchini-wraps", HASH, PLAN_COLS)).toBe(
      "changed under it",
    );
    expect(await snapshotRow(db, docRecipes, rowA.id)).toEqual(beforeA);
  });

  it("storeLibraryPlan updates only kitchen B's row when both kitchens hold the same slug", async () => {
    const rowA = await seedDocRecipe(kitchenA.id, "zucchini-wraps");
    const rowB = await seedDocRecipe(kitchenB.id, "zucchini-wraps");
    const beforeA = await snapshotRow(db, docRecipes, rowA.id);

    expect(await storeLibraryPlan(kitchenB.id, "zucchini-wraps", HASH, PLAN_COLS)).toBe(
      "stored",
    );
    expect(await snapshotRow(db, docRecipes, rowA.id)).toEqual(beforeA);
    expect((await snapshotRow(db, docRecipes, rowB.id))?.cookPlan).toEqual(ZUCCHINI_PLAN);
  });

  it("readLibraryPlanRows and readLibraryPlansForAudit return only the requested kitchen's rows", async () => {
    await seedDocRecipe(kitchenA.id, "only-a", PLAN_COLS);
    await seedDocRecipe(kitchenB.id, "only-b");

    expect((await readLibraryPlanRows(kitchenB.id)).map((r) => r.docSlug)).toEqual(["only-b"]);
    expect((await readLibraryPlansForAudit(kitchenB.id)).map((r) => r.docSlug)).toEqual([
      "only-b",
    ]);
  });
});

describe("recipe-ideas library isolation", () => {
  it("cachedIdeasCount and stale fallback ignore another kitchen's cached row", async () => {
    await db
      .insert(recipeIdeasCache)
      .values({ kitchenId: kitchenA.id, text: "Miso cod\nLentil soup" });

    expect(await cachedIdeasCount(kitchenA.id)).toBe(2);
    expect(await cachedIdeasCount(kitchenB.id)).toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockReadIdeasText.mockRejectedValueOnce(new Error("ideas store down"));
    await expect(getRecipeIdeas(kitchenB.id)).rejects.toThrow(/ideas store down/);
    warn.mockRestore();
  });

  it("getRecipeIdeas upserts only the requested kitchen's cache row", async () => {
    const [rowA] = await db
      .insert(recipeIdeasCache)
      .values({ kitchenId: kitchenA.id, text: "Miso cod" })
      .returning();
    const beforeA = await snapshotRow(db, recipeIdeasCache, rowA!.id);

    mockReadIdeasText.mockResolvedValueOnce("Crispy tacos\nSoup");
    const res = await getRecipeIdeas(kitchenB.id);
    expect(res.ideas).toEqual(["Crispy tacos", "Soup"]);
    expect(await snapshotRow(db, recipeIdeasCache, rowA!.id)).toEqual(beforeA);
    expect(await cachedIdeasCount(kitchenB.id)).toBe(2);
  });
});

describe("cook-reports library isolation", () => {
  const REPORT_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const REPORT_B = "1f8fad5b-d9cb-469f-a165-70867728950e";

  it("storeCookReport returns conflict for another kitchen's id without touching its row", async () => {
    expect(await storeCookReport(kitchenA.id, makeReport(REPORT_A, { note: "A note" }))).toBe(
      "inserted",
    );
    const beforeA = await snapshotRow(db, cookReports, REPORT_A);

    expect(await storeCookReport(kitchenB.id, makeReport(REPORT_A, { note: "B note" }))).toBe(
      "conflict",
    );
    expect(await snapshotRow(db, cookReports, REPORT_A)).toEqual(beforeA);
  });

  it("storeCookReport counts the daily cap per kitchen", async () => {
    const baseValues = Array.from({ length: REPORTS_PER_DAY }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      kitchenId: kitchenA.id,
      capturedAt: new Date(),
      build: "test-build",
      path: "/kitchen",
      screen: "step",
      queueId: null,
      recipeName: "Dal",
      state: { mode: "go", pos: 0, ticked: [], passed: [], kept: [] },
      context: makeReport(REPORT_A).context,
      events: [],
      dom: "<div></div>",
      domTruncated: false,
      note: "",
    }));
    await db.insert(cookReports).values(baseValues);

    expect(await storeCookReport(kitchenA.id, makeReport(REPORT_A))).toBe("capped");
    expect(await storeCookReport(kitchenB.id, makeReport(REPORT_B))).toBe("inserted");
  });

  it("annotateCookReport returns false for another kitchen's report and leaves it unchanged", async () => {
    await storeCookReport(kitchenA.id, makeReport(REPORT_A, { note: "original" }));
    const beforeA = await snapshotRow(db, cookReports, REPORT_A);

    expect(await annotateCookReport(kitchenB.id, REPORT_A, "tampered")).toBe(false);
    expect(await snapshotRow(db, cookReports, REPORT_A)).toEqual(beforeA);
  });

  it("countCookReportsSince counts only the requested kitchen's reports", async () => {
    await storeCookReport(kitchenA.id, makeReport(REPORT_A));
    await storeCookReport(kitchenB.id, makeReport(REPORT_B));
    const since = new Date(Date.now() - 60 * 60_000);

    expect(await countCookReportsSince(kitchenA.id, since)).toBe(1);
    expect(await countCookReportsSince(kitchenB.id, since)).toBe(1);
  });

  it("a row moved to another kitchen between the read and the update keeps its note", async () => {
    const id = randomUUID();
    expect(await storeCookReport(kitchenA.id, makeReport(id, { note: "old" }))).toBe("inserted");
    const realTransaction = db.transaction.bind(db);
    // Drizzle's generic transaction and update signatures cannot be wrapped without casting the spy override.
    vi.spyOn(db, "transaction").mockImplementationOnce(((work, config) =>
      realTransaction(async (tx) => {
        const realUpdate = tx.update.bind(tx);
        let moved = false;
        tx.update = ((table: Parameters<typeof realUpdate>[0]) => {
          if (moved || table !== cookReports) return realUpdate(table);
          moved = true;
          return {
            set: (values: Parameters<ReturnType<typeof realUpdate<typeof cookReports>>["set"]>[0]) => ({
              where: async (where: SQL | undefined) => {
                await realUpdate(cookReports)
                  .set({ kitchenId: kitchenB.id })
                  .where(eq(cookReports.id, id));
                return realUpdate(cookReports).set(values).where(where);
              },
            }),
          };
        }) as typeof tx.update;
        return work(tx);
      }, config)) as typeof db.transaction);
    expect(await storeCookReport(kitchenA.id, makeReport(id, { note: "new" }))).toBe("duplicate");
    const row = await snapshotRow(db, cookReports, id);
    expect(row?.kitchenId).toBe(kitchenB.id);
    expect(row?.note).toBe("old");
  });
});

describe("shelf/load library isolation", () => {
  it("loadAppShelf loads only the requested kitchen's household book", async () => {
    await seedDocRecipe(kitchenA.id, "secret-a", { name: "Secret A Stew" });

    const shelfB = await loadAppShelf(kitchenB.id);
    const householdB = shelfB.packs.find((p) => p.pack.kind === "household")?.pack;
    expect(householdB?.recipes ?? []).toEqual([]);

    const shelfA = await loadAppShelf(kitchenA.id);
    const householdA = shelfA.packs.find((p) => p.pack.kind === "household")?.pack;
    expect(householdA?.recipes.map((r) => r.id)).toEqual(["secret-a"]);
  });
});

describe("list-reports script isolation", () => {
  it("askExchange reads conversation_logs only within the report's kitchen even when sessionId repeats", async () => {
    const sharedSessionId = "cook-session-shared";

    await db.insert(conversationLogs).values([
      {
        kitchenId: kitchenA.id,
        sessionId: sharedSessionId,
        role: "user",
        content: "Kitchen A secret question",
      },
      {
        kitchenId: kitchenA.id,
        sessionId: sharedSessionId,
        role: "assistant",
        content: "Kitchen A secret answer",
      },
      {
        kitchenId: kitchenB.id,
        sessionId: sharedSessionId,
        role: "user",
        content: "Kitchen B question",
      },
    ]);

    const capturedAt = new Date(Date.now() + 60_000);
    const exchangeB = await askExchange({
      kitchenId: kitchenB.id,
      capturedAt,
      context: {
        ...makeReport("0f8fad5b-d9cb-469f-a165-70867728950e").context,
        ask: { sessionId: sharedSessionId, open: true },
      },
    });

    expect(exchangeB).toEqual({
      question: "Kitchen B question",
      answer: null,
    });
  });

  it("intakeLines joins queue rows within each report's kitchen and keys results by report id", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: INTAKE_SENT,
      intakeSourceHash: sourceHash("kitchen_queue", INTAKE_SENT),
      intakeRecipe: INTAKE_CUT,
      intakeStamp: "test-stamp",
      intakeAttempts: 1,
      intakeNudges: [],
    });

    // Only B's report referencing A's queueId: query must return no line.
    const onlyB = await intakeLines([
      { id: "rep-b-only", kitchenId: kitchenB.id, queueId: rowA.id },
    ]);
    expect(onlyB.size).toBe(0);

    // Listing holding both A's report and B's report referencing A's queueId:
    // only A's report receives the intake line.
    const both = await intakeLines([
      { id: "rep-a", kitchenId: kitchenA.id, queueId: rowA.id },
      { id: "rep-b", kitchenId: kitchenB.id, queueId: rowA.id },
    ]);
    expect(both.get("rep-a")).toBeDefined();
    expect(both.has("rep-b")).toBe(false);
  });
});
