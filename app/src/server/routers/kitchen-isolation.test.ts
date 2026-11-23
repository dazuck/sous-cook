/**
 * Two-kitchen isolation tests for rows 2 to 17 of the server API and the
 * queue/intake diagnostic logs, running against a real migrated PGlite
 * database with two kitchens (A and B) and a scripted AI provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { FakeProviderController } from "../../lib/__tests__/fake-provider";
import { ZUCCHINI_RECIPE, zucchiniRaw } from "../../lib/kitchen/__tests__/zucchini-wraps";

const scheduled = vi.hoisted(() => [] as Array<() => unknown>);
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/providers/google", () => ({
  createGoogleProvider: () => provider.provider("google"),
}));
vi.mock("@/lib/ai/providers/anthropic", () => ({
  createAnthropicProvider: () => provider.provider("anthropic"),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((task: () => unknown) => scheduled.push(task)),
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
import { conversationLogs, db, kitchenQueue } from "@/lib/db";
import { connected } from "@/lib/hooks/connected";
import {
  callerFor,
  seedKitchen,
  seedQueueRow,
  snapshotRow,
  type KitchenRow,
} from "@/lib/__tests__/kitchens";
import {
  logCookPlanRejections,
  removeFromQueue,
} from "@/lib/kitchen-queue";
import { AUTO_FINISH_IDLE_MS } from "@/lib/kitchen/auto-finish";
import { sourceHash } from "@/lib/serves-estimate-plan";

const client = (dbModule as unknown as { client: PGlite }).client;
const provider = new FakeProviderController();

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;
let callerA: ReturnType<typeof callerFor>;
let callerB: ReturnType<typeof callerFor>;

const SECRET_RECIPE_A: KitchenQueueRecipeData = {
  name: "Saffron Cardamom Heirloom Tart",
  ingredients: [
    { item: "rare kashmiri saffron threads", amount: "2", unit: "tsp" },
    { item: "green cardamom pods", amount: "8" },
  ],
  steps: [
    "Bloom the rare kashmiri saffron threads in warm cream for 10 minutes.",
    "Crush the green cardamom pods and fold them into the custard.",
  ],
  serves: 4,
};

function setupCookLogSheet() {
  const rows: string[][] = [
    ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
  ];
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const [values] = JSON.parse(String(init.body)).values as string[][];
      rows.push(values);
      return {
        ok: true,
        json: async () => ({
          updates: {
            updatedRange: `'Cook Log'!A${rows.length}:E${rows.length}`,
          },
        }),
      };
    }
    if (init?.method === "PUT") {
      return { ok: true, json: async () => ({}) };
    }
    return {
      ok: true,
      json: async () => ({ values: rows.map((r) => [...r]) }),
    };
  });
  return rows;
}

beforeEach(async () => {
  provider.reset();
  scheduled.length = 0;
  mockFetch.mockReset();
  connected["cook-log"] = true;
  connected.pantry = false;
  connected["household-context"] = false;
  vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
  vi.stubEnv("AI_TEXT_PROVIDER", "google");
  vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");
  vi.stubEnv("AI_COOK_CHAT_MODEL", "gemini-3.5-flash");

  await client.exec("delete from conversation_logs; delete from kitchen_queue;");
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchenA = (await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" }))
    .kitchen;
  kitchenB = (await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" }))
    .kitchen;
  callerA = callerFor(kitchenA);
  callerB = callerFor(kitchenB);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * True when the error or anything it wraps mentions the text. A failed query
 * reaches a caller wrapped once or twice, and the database's own message (the
 * one that names the constraint) is the innermost.
 */
function errorChainMentions(err: unknown, text: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    if (current.message.includes(text)) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

describe("ISO-2: chatCooking", () => {
  beforeEach(() => {
    connected["cook-log"] = false;
  });

  it("does not leak kitchen A's queue item into kitchen B's prompt and logs under B's kitchen_id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    provider.onNextChat(() => ({
      content: "Keep the heat gentle.",
      finishReason: "stop",
    }));

    await callerB.chatCooking({
      sessionId: "ask-session-b",
      queueId: rowA.id,
      messages: [{ role: "user", content: "What ingredient goes in first?" }],
    });

    expect(provider.chatCalls).toHaveLength(1);
    const systemPrompt = provider.chatCalls[0]!.options.systemPrompt ?? "";
    expect(systemPrompt).not.toContain(SECRET_RECIPE_A.name);
    expect(systemPrompt).not.toContain("kashmiri saffron");
    expect(systemPrompt).not.toContain("green cardamom pods");
    expect(systemPrompt).not.toContain("fold them into the custard");

    const logs = await db
      .select()
      .from(conversationLogs)
      .where(eq(conversationLogs.sessionId, "ask-session-b"));
    expect(logs).toHaveLength(2);
    expect(logs.every((row) => row.kitchenId === kitchenB.id)).toBe(true);
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
    warn.mockRestore();
  });

  it("includes kitchen A's own queue item when kitchen A asks", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: SECRET_RECIPE_A,
    });

    provider.onNextChat(() => ({
      content: "Bloom the saffron first.",
      finishReason: "stop",
    }));

    await callerA.chatCooking({
      sessionId: "ask-session-a",
      queueId: rowA.id,
      messages: [{ role: "user", content: "What goes first?" }],
    });

    expect(provider.chatCalls).toHaveLength(1);
    const systemPrompt = provider.chatCalls[0]!.options.systemPrompt ?? "";
    expect(systemPrompt).toContain(SECRET_RECIPE_A.name);
    expect(systemPrompt).toContain("kashmiri saffron");

    const logs = await db
      .select()
      .from(conversationLogs)
      .where(eq(conversationLogs.sessionId, "ask-session-a"));
    expect(logs).toHaveLength(2);
    expect(logs.every((row) => row.kitchenId === kitchenA.id)).toBe(true);
  });
});

describe("ISO-3: addToKitchenQueue", () => {
  it("ignores extra kitchenId and targetUser fields and assigns the row to caller A's kitchen", async () => {
    const inputWithExtras = {
      recipeData: SECRET_RECIPE_A,
      targetUser: "someone-else",
      kitchenId: kitchenB.id,
    } as Parameters<typeof callerA.addToKitchenQueue>[0];

    const created = await callerA.addToKitchenQueue(inputWithExtras);
    const stored = await snapshotRow(db, kitchenQueue, created.id);

    expect(stored?.kitchenId).toBe(kitchenA.id);
    expect(stored?.targetUser).toBeNull();
    expect(await callerB.getKitchenQueue({ status: "pending" })).toEqual([]);
    expect((await callerA.getKitchenQueue({ status: "pending" })).map((r) => r.id)).toEqual([
      created.id,
    ]);
  });
});

describe("ISO-4: getKitchenQueue", () => {
  it("lists only the caller's own rows across every status and ignores userId", async () => {
    const statuses = ["pending", "cooking", "completed", "cancelled"] as const;
    const idsA: Record<string, string> = {};
    const idsB: Record<string, string> = {};

    for (const status of statuses) {
      idsA[status] = (
        await seedQueueRow(db, kitchenA.id, {
          status,
          recipeData: { name: `A ${status}`, steps: ["Cook."], serves: 2 },
        })
      ).id;
      idsB[status] = (
        await seedQueueRow(db, kitchenB.id, {
          status,
          recipeData: { name: `B ${status}`, steps: ["Cook."], serves: 2 },
        })
      ).id;
    }

    for (const status of statuses) {
      const listA = await callerA.getKitchenQueue({
        userId: "someone-else",
        status,
      });
      const listB = await callerB.getKitchenQueue({ status });

      expect(listA.map((r) => r.id)).toEqual([idsA[status]]);
      expect(listB.map((r) => r.id)).toEqual([idsB[status]]);
      expect("kitchenId" in listA[0]!).toBe(false);
      expect("kitchenId" in listB[0]!).toBe(false);
    }
  });
});

describe("ISO-5: getKitchenQueueItem", () => {
  it("returns null when kitchen B requests kitchen A's queue item and omits kitchenId from returned items", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: SECRET_RECIPE_A,
    });

    expect(await callerB.getKitchenQueueItem({ queueId: rowA.id })).toBeNull();
    const itemA = await callerA.getKitchenQueueItem({ queueId: rowA.id });
    expect(itemA?.id).toBe(rowA.id);
    expect(itemA).not.toBeNull();
    expect("kitchenId" in itemA!).toBe(false);
  });
});

describe("ISO-6: ensureIntake", () => {
  it("answers NOT_FOUND for kitchen A's item, leaves it unchanged, and makes no model call", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: SECRET_RECIPE_A,
      intakeSourceHash: sourceHash("kitchen_queue", SECRET_RECIPE_A),
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    await expect(
      callerB.ensureIntake({ queueId: rowA.id, ask: "opening" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
    expect(provider.chatCalls).toHaveLength(0);
  });
});

describe("ISO-7: ensureCookPlan", () => {
  it("answers NOT_FOUND for kitchen A's item, leaves it unchanged, and makes no model call", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: { name: "Sweet Zucchini Wraps", ...ZUCCHINI_RECIPE },
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    await expect(
      callerB.ensureCookPlan({ queueId: rowA.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
    expect(provider.chatCalls).toHaveLength(0);
  });
});

describe("ISO-8: updateKitchenQueueStatus", () => {
  it("answers NOT_FOUND when B updates A's row, and B starting its own cook leaves A's last-screen cook unfinished", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      startedAt: new Date(Date.now() - 60 * 60_000),
      lastScreenActiveAt: new Date(Date.now() - 10 * 60_000),
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    await expect(
      callerB.updateKitchenQueueStatus({ queueId: rowA.id, status: "completed" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);

    // Kitchen B starts its own cook; kitchen A's cook sitting on its last screen stays cooking.
    const rowB = await seedQueueRow(db, kitchenB.id, {
      status: "pending",
      recipeData: { name: "B Soup", steps: ["Simmer."], serves: 2 },
    });
    await callerB.updateKitchenQueueStatus({ queueId: rowB.id, status: "cooking" });

    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
    expect((await snapshotRow(db, kitchenQueue, rowB.id))?.status).toBe("cooking");
  });
});

describe("ISO-9: markCookActivity", () => {
  it("answers NOT_FOUND for kitchen A's item and leaves it unchanged", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      startedAt: new Date(Date.now() - 30 * 60_000),
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    await expect(
      callerB.markCookActivity({
        queueId: rowA.id,
        idleForMs: 0,
        interactedAt: Date.now() - 1_000,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });
});

describe("ISO-10: autoFinishCook", () => {
  it("answers NOT_FOUND for kitchen A's item, leaves it unchanged, and schedules nothing", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      startedAt: new Date(Date.now() - 120 * 60_000),
      lastScreenActiveAt: new Date(Date.now() - AUTO_FINISH_IDLE_MS - 60_000),
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    await expect(
      callerB.autoFinishCook({
        queueId: rowA.id,
        idleForMs: AUTO_FINISH_IDLE_MS + 60_000,
        interactedAt: Date.now() - AUTO_FINISH_IDLE_MS - 60_000,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
    expect(scheduled).toHaveLength(0);
  });
});

describe("ISO-11: reopenCook", () => {
  it("answers NOT_FOUND for kitchen A's auto-finished cook and leaves it unchanged", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "completed",
      completedAt: new Date(Date.now() - 10 * 60_000),
      finishedBy: "auto",
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    await expect(
      callerB.reopenCook({ queueId: rowA.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });
});

describe("ISO-12: retryCookLog", () => {
  it("answers NOT_FOUND for kitchen A's item whether cook-log is connected or not", async () => {
    setupCookLogSheet();
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "completed",
      completedAt: new Date(Date.now() - 10 * 60_000),
      cookLogError: "Cook Log API 503",
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    for (const isConnected of [true, false]) {
      connected["cook-log"] = isConnected;
      await expect(
        callerB.retryCookLog({ queueId: rowA.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("ISO-13: rateCook", () => {
  it("answers NOT_FOUND for kitchen A's item whether cook-log is connected or not", async () => {
    setupCookLogSheet();
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "completed",
      completedAt: new Date(Date.now() - 10 * 60_000),
      cookLog: {
        row: 2,
        timestamp: "2026-10-04 19:02",
        recipeName: SECRET_RECIPE_A.name,
        adopted: false,
      },
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    for (const isConnected of [true, false]) {
      connected["cook-log"] = isConnected;
      await expect(
        callerB.rateCook({ queueId: rowA.id, rating: 5, notes: "great" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("ISO-14: getCookAsk", () => {
  it("returns kitchen A's open ask only to A (with or without userId) and returns null to B", async () => {
    setupCookLogSheet();
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "completed",
      completedAt: new Date(),
      cookLogError: "Cook Log API 503",
      recipeData: SECRET_RECIPE_A,
    });

    expect(await callerB.getCookAsk({})).toBeNull();
    expect(await callerB.getCookAsk({ userId: "someone-else" })).toBeNull();

    const askA = await callerA.getCookAsk({ userId: "someone-else" });
    expect(askA).toEqual({
      queueId: rowA.id,
      name: SECRET_RECIPE_A.name,
      state: "failed",
    });
    expect(await callerA.getCookAsk({})).toEqual(askA);
  });
});

describe("ISO-15: dismissCookAsk", () => {
  it("answers NOT_FOUND for kitchen A's item whether cook-log is connected or not", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "completed",
      completedAt: new Date(),
      cookLogError: "Cook Log API 503",
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    for (const isConnected of [true, false]) {
      connected["cook-log"] = isConnected;
      await expect(
        callerB.dismissCookAsk({ queueId: rowA.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
    }
  });
});

describe("ISO-16: removeFromKitchenQueue", () => {
  it("answers NOT_FOUND for kitchen A's item and leaves the row intact", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    await expect(
      callerB.removeFromKitchenQueue({ queueId: rowA.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);

    // Direct library call with B's kitchenId must also delete nothing in A.
    await removeFromQueue(kitchenB.id, rowA.id);
    expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
  });
});

describe("ISO-17: getRecentCookingItems", () => {
  it("lists only the caller's own cooking rows and ignores userId", async () => {
    const cookingA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      recipeData: { name: "A Cooking", steps: ["Cook."], serves: 2 },
    });
    const cookingB = await seedQueueRow(db, kitchenB.id, {
      status: "cooking",
      recipeData: { name: "B Cooking", steps: ["Cook."], serves: 2 },
    });

    const recentA = await callerA.getRecentCookingItems({
      userId: "someone-else",
    });
    const recentB = await callerB.getRecentCookingItems({});

    expect(recentA.map((r) => r.id)).toEqual([cookingA.id]);
    expect(recentB.map((r) => r.id)).toEqual([cookingB.id]);
    expect("kitchenId" in recentA[0]!).toBe(false);
    expect("kitchenId" in recentB[0]!).toBe(false);
  });
});

describe("ISO-LOG: diagnostic rejection logs", () => {
  it("writes cook-plan rejection rows with kitchen A's kitchen_id", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: { name: "Sweet Zucchini Wraps", ...ZUCCHINI_RECIPE },
    });

    // First reply is invalid (missing needs), second reply succeeds.
    const invalidRaw = zucchiniRaw();
    const broken = {
      tasks: invalidRaw.tasks.map((task) => {
        const { needs: _dropped, ...rest } = task;
        return rest;
      }),
    };
    provider.onNextChat(() => ({
      content: JSON.stringify(broken),
      finishReason: "stop",
    }));
    provider.onNextChat(() => ({
      content: JSON.stringify(zucchiniRaw()),
      finishReason: "stop",
    }));

    const outcome = await callerA.ensureCookPlan({ queueId: rowA.id });
    expect(outcome.plan).not.toBeNull();

    const rows = await db
      .select()
      .from(conversationLogs)
      .where(eq(conversationLogs.sessionId, `cook-plan:${rowA.id}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kitchenId).toBe(kitchenA.id);
  });

  it("writes intake rejection rows with kitchen A's kitchen_id", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const sent: KitchenQueueRecipeData = {
      name: "Simple Toast",
      ingredients: [{ item: "bread, butter", amount: "2" }],
      steps: ["Toast the bread and butter it."],
      serves: 2,
    };
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: sent,
      intakeSourceHash: sourceHash("kitchen_queue", sent),
    });

    // Return a cut that violates intake checks (empty steps array) on both attempts
    // so intake logs its rejection rows into conversation_logs.
    provider.setDefaultChat(() => ({
      content: JSON.stringify({
        name: "Simple Toast",
        ingredients: [{ item: "bread", amount: "2" }],
        steps: ["Toast the bread and butter it."],
        stepIngredients: [[0, 99]],
      }),
      finishReason: "stop",
    }));

    const intakeAnswer = await callerA.ensureIntake({ queueId: rowA.id, ask: "opening" });
    expect("kitchenId" in intakeAnswer).toBe(false);

    const rows = await db
      .select()
      .from(conversationLogs)
      .where(eq(conversationLogs.sessionId, `intake:${rowA.id}`));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.kitchenId === kitchenA.id)).toBe(true);
    info.mockRestore();
  });

  it("rethrows integrity constraint violations (SQLSTATE class 23) from logIntakeRejections instead of swallowing them", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const sent: KitchenQueueRecipeData = {
      name: "Simple Toast",
      ingredients: [{ item: "bread, butter", amount: "2" }],
      steps: ["Toast the bread and butter it."],
      serves: 2,
    };
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: sent,
      intakeSourceHash: sourceHash("kitchen_queue", sent),
    });

    provider.setDefaultChat(() => ({
      content: JSON.stringify({
        name: "Simple Toast",
        ingredients: [{ item: "bread", amount: "2" }],
        steps: ["Toast the bread and butter it."],
        stepIngredients: [[0, 99]],
      }),
      finishReason: "stop",
    }));

    await client.exec(`
      ALTER TABLE conversation_logs
      ADD CONSTRAINT test_refuse_intake_log
      CHECK (session_id <> 'intake:${rowA.id}')
    `);
    try {
      await expect(
        callerA.ensureIntake({ queueId: rowA.id, ask: "opening" }),
      ).rejects.toSatisfy((err: unknown) => errorChainMentions(err, "test_refuse_intake_log"));
    } finally {
      await client.exec(`
        ALTER TABLE conversation_logs
        DROP CONSTRAINT IF EXISTS test_refuse_intake_log
      `);
      info.mockRestore();
    }
  });

  it("rethrows integrity constraint violations (SQLSTATE class 23) from logCookPlanRejections instead of swallowing them", async () => {
    await client.exec(`
      ALTER TABLE conversation_logs
      ADD CONSTRAINT test_refuse_plan_log
      CHECK (session_id <> 'cook-plan:integrity-probe')
    `);
    try {
      await expect(
        logCookPlanRejections(kitchenA.id, "cook-plan:integrity-probe", "d-1", [
          {
            call: 1,
            raw: "{}",
            rule: "shape",
            detail: "bad shape",
          },
        ]),
      ).rejects.toSatisfy((err: unknown) => errorChainMentions(err, "test_refuse_plan_log"));
    } finally {
      await client.exec(`
        ALTER TABLE conversation_logs
        DROP CONSTRAINT IF EXISTS test_refuse_plan_log
      `);
    }
  });
});
