/**
 * Two-kitchen isolation tests for rows 2 to 37 of the server API, the
 * queue/intake/library diagnostic logs, and structural router checks, running
 * against a real migrated PGlite database with two kitchens (A and B) and a
 * scripted AI provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { FakeProviderController } from "../../lib/__tests__/fake-provider";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE, zucchiniRaw } from "../../lib/kitchen/__tests__/zucchini-wraps";
import type { LibraryTab } from "../../lib/hooks/types";

const scheduled = vi.hoisted(() => [] as Array<() => unknown>);
const mockFetch = vi.hoisted(() => vi.fn());
const mockReadTabs = vi.hoisted(() => vi.fn<() => Promise<LibraryTab[]>>());
const mockReadIdeasText = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockAppendIdea = vi.hoisted(() => vi.fn<(text: string) => Promise<void>>());
const mockPantryReadSections = vi.hoisted(() => vi.fn());
const mockPantryAddItems = vi.hoisted(() => vi.fn());
const mockPantryApplyUpdates = vi.hoisted(() => vi.fn());
const mockShoppingList = vi.hoisted(() => vi.fn());
const mockShoppingAdd = vi.hoisted(() => vi.fn());
const mockShoppingRemove = vi.hoisted(() => vi.fn());
const mockShoppingClear = vi.hoisted(() => vi.fn());

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
vi.mock("@/lib/hooks/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/registry")>();
  const { scriptedCookLog } = await import(
    "../../lib/__tests__/scripted-cook-log"
  );
  return {
    ...actual,
    hook: (name: string) => {
      if (name === "recipe-library") return { readTabs: mockReadTabs };
      if (name === "ideas") {
        return { readText: mockReadIdeasText, append: mockAppendIdea };
      }
      if (name === "pantry") {
        return {
          readSections: mockPantryReadSections,
          addItems: mockPantryAddItems,
          applyUpdates: mockPantryApplyUpdates,
        };
      }
      if (name === "shopping-list") {
        return {
          list: mockShoppingList,
          add: mockShoppingAdd,
          remove: mockShoppingRemove,
          clear: mockShoppingClear,
        };
      }
      return scriptedCookLog((url, init) => mockFetch(url, init));
    },
  };
});
vi.mock("@/lib/db", async () =>
  (await import("../../lib/__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import {
  aiUsage,
  authUser,
  conversationLogs,
  cookReports,
  db,
  docRecipes,
  invites,
  kitchenCookLog,
  kitchenQueue,
  kitchens,
  kitchenWebhookTokens,
  members,
  recipeIdeasCache,
} from "@/lib/db";
import { connected } from "@/lib/hooks/connected";
import { HOOK_NAMES } from "@/lib/hooks/types";
import {
  callerFor,
  seedKitchen,
  seedQueueRow,
  snapshotRow,
  type KitchenRow,
  type MemberRow,
} from "@/lib/__tests__/kitchens";
import {
  createTestAuth,
  signedInHeaders,
  stubSignInEnv,
} from "@/lib/__tests__/test-auth";
import { httpCall } from "@/lib/__tests__/trpc-http";
import { resetAuthForTests } from "@/lib/auth/auth";
import { resetDeploymentCheckForTests } from "@/lib/kitchens/deployment";
import { NotInvitedError } from "@/lib/kitchens/invites";
import {
  addKitchenToCircle,
  createCircle,
  removeKitchenFromCircle,
} from "@/lib/kitchens/circles";
import { addKitchenPack } from "@/lib/kitchens/packs";
import { PACKS_DIR } from "@/lib/shelf/load";
import {
  logCookPlanRejections,
  removeFromQueue,
} from "@/lib/kitchen-queue";
import { AUTO_FINISH_IDLE_MS } from "@/lib/kitchen/auto-finish";
import { cookPlanStamp, planSourceHash } from "@/lib/kitchen/cook-plan-stamp";
import { storeLibraryPlan } from "@/lib/library-cook-plans";
import { getDocRecipeBySlug } from "@/lib/recipe-sync";
import { REPORTS_PER_DAY, type CookReportInput } from "@/lib/cook-reports";
import { sourceHash } from "@/lib/serves-estimate-plan";
import { intakeLines } from "@/lib/report-listing-queries";
import { appRouter } from "./_app";
import { createTRPCContext } from "../trpc";

const client = (dbModule as unknown as { client: PGlite }).client;
const provider = new FakeProviderController();

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;
let memberA: MemberRow;
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
  mockReadTabs.mockReset();
  mockReadIdeasText.mockReset();
  mockAppendIdea.mockReset();
  mockPantryReadSections.mockReset();
  mockPantryAddItems.mockReset();
  mockPantryApplyUpdates.mockReset();
  mockShoppingList.mockReset();
  mockShoppingAdd.mockReset();
  mockShoppingRemove.mockReset();
  mockShoppingClear.mockReset();
  connected["cook-log"] = true;
  connected["recipe-library"] = true;
  connected.ideas = true;
  connected.pantry = false;
  connected["shopping-list"] = true;
  connected["household-context"] = false;
  vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
  vi.stubEnv("AI_TEXT_PROVIDER", "google");
  vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");
  vi.stubEnv("AI_COOK_CHAT_MODEL", "gemini-3.5-flash");
  vi.stubEnv("AI_VISION_PROVIDER", "google");
  vi.stubEnv("AI_VISION_MODEL", "gemini-2.5-flash");

  resetAuthForTests();
  resetDeploymentCheckForTests(db);

  await client.exec(
    "delete from circle_members; delete from circles; delete from kitchen_pack_shares; delete from kitchen_packs; delete from ai_usage; delete from conversation_logs; delete from cook_reports; delete from kitchen_cook_log; delete from doc_recipes; delete from recipe_ideas_cache; delete from kitchen_queue; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  const seededA = await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" });
  kitchenA = seededA.kitchen;
  memberA = seededA.member;
  kitchenB = (await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" }))
    .kitchen;
  callerA = callerFor(kitchenA, { id: memberA.id, role: memberA.role });
  callerB = callerFor(kitchenB);
});

afterEach(() => {
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function unauthenticatedSignInCaller() {
  stubSignInEnv();
  for (const name of HOOK_NAMES) {
    connected[name] = false;
  }
  resetDeploymentCheckForTests(db);
  return appRouter.createCaller(await createTRPCContext());
}

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
    expect(logs.every((row) => row.memberId === memberA.id)).toBe(true);
  });
});

describe("ISO-3: addToKitchenQueue", () => {
  it("ignores an extra kitchenId field and assigns the row to caller A's kitchen", async () => {
    const inputWithExtras = {
      recipeData: SECRET_RECIPE_A,
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
  it("lists only the caller's own rows across every status", async () => {
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
      const listA = await callerA.getKitchenQueue({ status });
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
  it("returns kitchen A's open ask only to A and returns null to B", async () => {
    setupCookLogSheet();
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "completed",
      completedAt: new Date(),
      cookLogError: "Cook Log API 503",
      recipeData: SECRET_RECIPE_A,
    });

    expect(await callerB.getCookAsk({})).toBeNull();

    const askA = await callerA.getCookAsk({});
    expect(askA).toEqual({
      queueId: rowA.id,
      name: SECRET_RECIPE_A.name,
      state: "failed",
    });
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
  it("lists only the caller's own cooking rows", async () => {
    const cookingA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      recipeData: { name: "A Cooking", steps: ["Cook."], serves: 2 },
    });
    const cookingB = await seedQueueRow(db, kitchenB.id, {
      status: "cooking",
      recipeData: { name: "B Cooking", steps: ["Cook."], serves: 2 },
    });

    const recentA = await callerA.getRecentCookingItems({});
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

  it("writes library cook-plan rejection rows with kitchen A's kitchen_id", async () => {
    const lines = [
      "Serves 4",
      "2 zucchini",
      "1 onion bulb",
      "1 garlic scape",
      "a pinch of cumin or curry powder",
      "a handful of onion greens",
      "frozen parathas",
      "chili oil or Calabrian chile",
      "Sauté the onion, garlic scape and zucchini with a pinch of cumin until sweet and caramelized, about 15 minutes.",
      "Stir in the onion greens at the very end.",
      "Fry the parathas in a dry skillet until crisp and flaky.",
      "Stuff the hot wrappers with the spiced zucchini.",
      "Add a drizzle of chili oil or Calabrian chile for anyone who wants heat.",
    ];
    mockReadTabs.mockResolvedValueOnce([
      {
        title: "Entrees",
        lines: [],
        nonText: false,
        children: [{ title: "Zucchini wraps", lines, nonText: false, children: [] }],
      },
    ]);

    // 1) Extraction returns ZUCCHINI_RECIPE (with stated serves: 4 so no serves estimate call).
    provider.onNextChat(() => ({
      content: JSON.stringify({
        isRecipe: true,
        name: "Zucchini wraps",
        serves: 4,
        ingredients: ZUCCHINI_RECIPE.ingredients,
        steps: ZUCCHINI_RECIPE.steps,
        stepIngredients: ZUCCHINI_RECIPE.stepIngredients,
      }),
      finishReason: "stop",
    }));
    // 2) First plan attempt is invalid (missing `needs`), triggering rejection logging.
    const broken = {
      tasks: zucchiniRaw().tasks.map((task) => {
        const { needs: _dropped, ...rest } = task;
        return rest;
      }),
    };
    provider.onNextChat(() => ({
      content: JSON.stringify(broken),
      finishReason: "stop",
    }));
    // 3) Second plan attempt succeeds.
    provider.onNextChat(() => ({
      content: JSON.stringify(zucchiniRaw()),
      finishReason: "stop",
    }));

    const result = await callerA.syncRecipes();
    expect(result.plans.derived).toBe(1);

    const rows = await db
      .select()
      .from(conversationLogs)
      .where(eq(conversationLogs.sessionId, "cook-plan:doc:zucchini-wraps"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kitchenId).toBe(kitchenA.id);
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
      rawDocText: `${docSlug}\n2 zucchini\nCook until tender.`,
      ...overrides,
    })
    .returning();
  return row!;
}

function makeReport(
  id: string,
  overrides: Partial<CookReportInput> = {},
): CookReportInput {
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

describe("ISO-18: importRecipeFromUrl", () => {
  it("imports a recipe without storing anything another kitchen can read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        `<html><body><h1>Lemon Pasta</h1><p>1 lb pasta, 2 lemons. Boil pasta and toss with lemon juice.</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    );
    provider.onNextChat(() => ({
      content: JSON.stringify({
        isRecipe: true,
        name: "Lemon Pasta",
        serves: 4,
        ingredients: [
          { item: "pasta", amount: "1", unit: "lb" },
          { item: "lemons", amount: "2" },
        ],
        steps: ["Boil pasta and toss with lemon juice."],
      }),
      finishReason: "stop",
    }));

    const result = await callerB.importRecipeFromUrl({
      url: "https://recipes.example.com/lemon-pasta",
    });
    expect(result.success).toBe(true);
    expect(result.recipe?.name).toBe("Lemon Pasta");
    expect("kitchenId" in result).toBe(false);
    expect(await callerA.getKitchenQueue({ status: "pending" })).toEqual([]);
    expect(await db.select().from(docRecipes)).toEqual([]);
    const usage = await db.select().from(aiUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      kitchenId: kitchenB.id,
      feature: "import-url",
      status: "settled",
    });
  });
});

describe("ISO-19: importRecipeFromText", () => {
  it("imports a recipe from text without storing anything another kitchen can read", async () => {
    provider.onNextChat(() => ({
      content: JSON.stringify({
        isRecipe: true,
        name: "Garlic Beans",
        serves: 2,
        ingredients: [{ item: "white beans", amount: "1", unit: "can" }],
        steps: ["Warm the beans with olive oil and garlic."],
      }),
      finishReason: "stop",
    }));

    const result = await callerB.importRecipeFromText({
      text: "Garlic Beans\n1 can white beans\nWarm the beans with olive oil and garlic.",
    });
    expect(result.success).toBe(true);
    expect(result.recipe?.name).toBe("Garlic Beans");
    expect("kitchenId" in result).toBe(false);
    expect(await callerA.getKitchenQueue({ status: "pending" })).toEqual([]);
    expect(await db.select().from(docRecipes)).toEqual([]);
    const usage = await db.select().from(aiUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      kitchenId: kitchenB.id,
      feature: "import-text",
      status: "settled",
    });
  });
});

describe("ISO-20: importRecipeFromImage", () => {
  it("imports a recipe from an image without storing anything another kitchen can read", async () => {
    provider.onNextVision(() =>
      JSON.stringify({
        isRecipe: true,
        name: "Herb Omelette",
        serves: 1,
        ingredients: [{ item: "eggs", amount: "3" }],
        steps: ["Whisk eggs and cook in butter until set."],
      }),
    );

    const result = await callerB.importRecipeFromImage({
      imageBase64: "data:image/jpeg;base64,AAAA",
    });
    expect(result.success).toBe(true);
    expect(result.recipe?.name).toBe("Herb Omelette");
    expect("kitchenId" in result).toBe(false);
    expect(provider.visionCalls).toHaveLength(1);
    expect(await callerA.getKitchenQueue({ status: "pending" })).toEqual([]);
    expect(await db.select().from(docRecipes)).toEqual([]);
    const usage = await db.select().from(aiUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      kitchenId: kitchenB.id,
      feature: "import-photo",
      status: "settled",
    });
  });
});

describe("ISO-21: getShelf", () => {
  it("isolates the household book and ideas count per kitchen and allows identical slugs in both kitchens", async () => {
    await seedDocRecipe(kitchenA.id, "shared-dish", { name: "Kitchen A Dal" });
    await db
      .insert(recipeIdeasCache)
      .values({ kitchenId: kitchenA.id, text: "Idea 1\nIdea 2\nIdea 3" });

    const shelfBEmpty = await callerB.getShelf();
    expect(shelfBEmpty.household?.state).toBe("empty");
    expect(shelfBEmpty.household?.cookable).toBe(0);
    expect(shelfBEmpty.household?.contents).toEqual([]);
    expect(shelfBEmpty.ideas).toBeNull();
    expect("kitchenId" in shelfBEmpty).toBe(false);

    const shelfA = await callerA.getShelf();
    expect(shelfA.household?.state).toBe("ok");
    expect(shelfA.household?.cookable).toBe(1);
    expect(shelfA.ideas).toBe(3);

    // Both kitchens can hold the same slug at once.
    await seedDocRecipe(kitchenB.id, "shared-dish", {
      name: "Kitchen B Soup",
      category: "soups",
      categoryTitle: "Soups",
    });
    const shelfB = await callerB.getShelf();
    expect(shelfB.household?.state).toBe("ok");
    expect(shelfB.household?.cookable).toBe(1);
    expect(shelfB.household?.contents.map((c) => c.title)).toEqual(["Soups"]);
  });
});

describe("ISO-22: getPack", () => {
  it("scopes the household pack per kitchen while keeping creator packs shared", async () => {
    await seedDocRecipe(kitchenA.id, "shared-dish", { name: "Kitchen A Secret Stew" });

    const householdBEmpty = await callerB.getPack({ packId: "household-book" });
    expect(householdBEmpty?.state).toBe("empty");
    expect(householdBEmpty?.cookable).toBe(0);
    expect(householdBEmpty?.chapters).toEqual([]);

    const householdA = await callerA.getPack({ packId: "household-book" });
    expect(householdA?.cookable).toBe(1);
    expect(householdA?.chapters.flatMap((c) => c.rows.map((r) => r.title))).toEqual([
      "Kitchen A Secret Stew",
    ]);

    // Both kitchens can hold the same slug and see only their own recipe.
    await seedDocRecipe(kitchenB.id, "shared-dish", { name: "Kitchen B Stew" });
    const householdB = await callerB.getPack({ packId: "household-book" });
    expect(householdB?.chapters.flatMap((c) => c.rows.map((r) => r.title))).toEqual([
      "Kitchen B Stew",
    ]);

    // Shared pack files are readable by both kitchens.
    const sharedB = await callerB.getPack({ packId: "fannie-farmer-1896" });
    expect(sharedB?.kind).toBe("creator");
    expect((sharedB?.cookable ?? 0) > 0).toBe(true);
  });
});

describe("ISO-23: libraryPlanReport", () => {
  it("reports only the calling kitchen's library rows", async () => {
    const hash = planSourceHash(ZUCCHINI_RECIPE);
    await seedDocRecipe(kitchenA.id, "broken-a", {
      name: "Broken A",
      cookPlan: null,
      cookPlanError: "rejected (uncovered-step): step 1 is in no task",
      cookPlanSourceHash: hash,
      cookPlanStamp: cookPlanStamp(),
    });
    await seedDocRecipe(kitchenA.id, "pending-a", { name: "Pending A" });

    expect(await callerB.libraryPlanReport()).toEqual({
      needFixes: [],
      pending: 0,
      total: 0,
    });

    const reportA = await callerA.libraryPlanReport();
    expect(reportA.total).toBe(2);
    expect(reportA.pending).toBe(1);
    expect(reportA.needFixes.map((f) => f.slug)).toEqual(["broken-a"]);
  });
});

describe("ISO-24: syncRecipes", () => {
  it("scopes doc order, all three saveRecipe writes, and storeLibraryPlan to the calling kitchen", async () => {
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

    const aShared = await seedDocRecipe(kitchenA.id, "shared-dish", {
      name: "Shared dish",
      category: "indian",
      categoryTitle: "A Indian",
      docPosition: 0,
      rawDocText: "Shared dish\n1 cup rice\nBoil rice.",
    });
    const aOnly = await seedDocRecipe(kitchenA.id, "only-a", {
      name: "Only A",
      category: "sides",
      categoryTitle: "A Sides",
      docPosition: 1,
    });
    const aFailed = await seedDocRecipe(kitchenA.id, "failed-dish", {
      name: "Failed dish",
      extractionError: "kitchen A prior failure",
      steps: null,
      ingredients: null,
      docPosition: 2,
    });
    const aKept = await seedDocRecipe(kitchenA.id, "kept-dish", {
      name: "Kept dish",
      category: "indian",
      categoryTitle: "A Indian",
      docPosition: 3,
      rawDocText: keptRaw,
      ingredients: [
        { item: "lentils", amount: "2", unit: "cups" },
        { item: "turmeric", amount: "1", unit: "tsp" },
      ],
      steps: keptSteps,
    });
    const bKept = await seedDocRecipe(kitchenB.id, "kept-dish", {
      name: "Kept dish",
      category: "indian",
      categoryTitle: "Old B",
      docPosition: 9,
      rawDocText: keptRaw,
      ingredients: [
        { item: "lentils", amount: "2", unit: "cups" },
        { item: "turmeric", amount: "1", unit: "tsp" },
      ],
      steps: keptSteps,
    });

    const beforeAShared = await snapshotRow(db, docRecipes, aShared.id);
    const beforeAOnly = await snapshotRow(db, docRecipes, aOnly.id);
    const beforeAFailed = await snapshotRow(db, docRecipes, aFailed.id);
    const beforeAKept = await snapshotRow(db, docRecipes, aKept.id);

    mockReadTabs.mockResolvedValueOnce([
      {
        title: "B Mains",
        lines: [],
        nonText: false,
        children: [
          { title: "Failed dish", lines: ["Not a recipe", "Just notes"], nonText: false, children: [] },
          { title: "Kept dish", lines: keptLines, nonText: false, children: [] },
          {
            title: "Shared dish",
            lines: [
              "Serves 4",
              "2 zucchini",
              "1 onion bulb",
              "1 garlic scape",
              "a pinch of cumin or curry powder",
              "a handful of onion greens",
              "frozen parathas",
              "chili oil or Calabrian chile",
              "Sauté the onion, garlic scape and zucchini with a pinch of cumin until sweet and caramelized, about 15 minutes.",
              "Stir in the onion greens at the very end.",
              "Fry the parathas in a dry skillet until crisp and flaky.",
              "Stuff the hot wrappers with the spiced zucchini.",
              "Add a drizzle of chili oil or Calabrian chile for anyone who wants heat.",
            ],
            nonText: false,
            children: [],
          },
        ],
      },
    ]);

    provider.setDefaultChat((options) => {
      const prompt = JSON.stringify(options.messages);
      if (prompt.includes("Failed dish")) {
        return { content: JSON.stringify({ isRecipe: false }), finishReason: "stop" };
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
      if (prompt.includes("Shared dish") && !prompt.includes("tasks")) {
        return {
          content: JSON.stringify({
            isRecipe: true,
            name: "Shared dish",
            serves: 4,
            ingredients: ZUCCHINI_RECIPE.ingredients,
            steps: ZUCCHINI_RECIPE.steps,
            stepIngredients: ZUCCHINI_RECIPE.stepIngredients,
          }),
          finishReason: "stop",
        };
      }
      return { content: JSON.stringify(zucchiniRaw()), finishReason: "stop" };
    });

    const syncResult = await callerB.syncRecipes();
    expect(syncResult.total).toBe(3);

    // Every kitchen A row is byte-for-byte unchanged, including docPosition and categoryTitle.
    expect(await snapshotRow(db, docRecipes, aShared.id)).toEqual(beforeAShared);
    expect(await snapshotRow(db, docRecipes, aOnly.id)).toEqual(beforeAOnly);
    expect(await snapshotRow(db, docRecipes, aFailed.id)).toEqual(beforeAFailed);
    expect(await snapshotRow(db, docRecipes, aKept.id)).toEqual(beforeAKept);

    // Kitchen B's rows updated independently.
    const bShared = await getDocRecipeBySlug(kitchenB.id, "shared-dish");
    expect(bShared?.extractionError).toBeNull();
    expect(bShared?.categoryTitle).toBe("B Mains");
    expect(bShared?.docPosition).toBe(2);
    expect((await getDocRecipeBySlug(kitchenB.id, "failed-dish"))?.extractionError).not.toBeNull();
    const afterBKept = await snapshotRow(db, docRecipes, bKept.id);
    expect(afterBKept?.categoryTitle).toBe("B Mains");
    expect(afterBKept?.docPosition).toBe(1);
    expect(afterBKept?.steps).toEqual(keptSteps);
    expect(syncResult.failures.find((f) => f.name === "Kept dish")?.error).toContain(
      "saved recipe was kept",
    );

    // B storing a plan with storeLibraryPlan for shared-dish leaves A's shared-dish unchanged.
    const bNoPlan = await seedDocRecipe(kitchenB.id, "plan-target");
    const aPlanTarget = await seedDocRecipe(kitchenA.id, "plan-target");
    const beforeAPlanTarget = await snapshotRow(db, docRecipes, aPlanTarget.id);
    const stored = await storeLibraryPlan(
      kitchenB.id,
      "plan-target",
      planSourceHash(ZUCCHINI_RECIPE),
      {
        cookPlan: ZUCCHINI_PLAN,
        cookPlanError: null,
        cookPlanSourceHash: planSourceHash(ZUCCHINI_RECIPE),
        cookPlanStamp: cookPlanStamp(),
      },
    );
    expect(stored).toBe("stored");
    expect(await snapshotRow(db, docRecipes, aPlanTarget.id)).toEqual(beforeAPlanTarget);
    expect((await snapshotRow(db, docRecipes, bNoPlan.id))?.cookPlan).toEqual(ZUCCHINI_PLAN);
  });
});

describe("ISO-25: queueFromPack", () => {
  it("refuses another kitchen's household recipe with NOT_FOUND and queues shared pack recipes into the caller's kitchen", async () => {
    const rowA = await seedDocRecipe(kitchenA.id, "secret-a", {
      name: "Secret A Dal",
    });
    const beforeA = await snapshotRow(db, docRecipes, rowA.id);

    await expect(
      callerB.queueFromPack({
        packId: "household-book",
        recipeId: "secret-a",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await snapshotRow(db, docRecipes, rowA.id)).toEqual(beforeA);
    expect(await callerB.getKitchenQueue({ status: "pending" })).toEqual([]);

    // Shared pack-file recipe queued by B lands in B's queue only.
    const sharedPack = await callerB.getPack({ packId: "fannie-farmer-1896" });
    const firstRecipeId = sharedPack?.chapters[0]?.rows[0]?.id;
    expect(firstRecipeId).toBeDefined();

    const queued = await callerB.queueFromPack({
      packId: "fannie-farmer-1896",
      recipeId: firstRecipeId!,
    });
    expect("kitchenId" in queued).toBe(false);
    const stored = await snapshotRow(db, kitchenQueue, queued.id);
    expect(stored?.kitchenId).toBe(kitchenB.id);
    expect(stored?.targetUser).toBeNull();
    expect(await callerA.getKitchenQueue({ status: "pending" })).toEqual([]);
  });
});

describe("ISO-26: getRecipeIdeas", () => {
  it("refreshes kitchen B's cache row while leaving kitchen A's cache row unchanged", async () => {
    const [rowA] = await db
      .insert(recipeIdeasCache)
      .values({ kitchenId: kitchenA.id, text: "Kitchen A Secret Idea" })
      .returning();
    const beforeA = await snapshotRow(db, recipeIdeasCache, rowA!.id);

    mockReadIdeasText.mockResolvedValueOnce("Kitchen B Idea 1\nKitchen B Idea 2");
    const resB = await callerB.getRecipeIdeas();
    expect(resB.ideas).toEqual(["Kitchen B Idea 1", "Kitchen B Idea 2"]);
    expect("kitchenId" in resB).toBe(false);

    expect(await snapshotRow(db, recipeIdeasCache, rowA!.id)).toEqual(beforeA);
  });
});

describe("ISO-27: saveRecipeIdea", () => {
  it("answers UNAUTHORIZED without a session", async () => {
    const anon = await unauthenticatedSignInCaller();
    await expect(
      anon.saveRecipeIdea({ text: "Roasted carrots" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mockAppendIdea).not.toHaveBeenCalled();
  });

  it("delegates to the ideas hook when called with a kitchen session", async () => {
    mockAppendIdea.mockResolvedValueOnce(undefined);
    expect(await callerB.saveRecipeIdea({ text: "Roasted carrots" })).toEqual({
      success: true,
    });
    expect(mockAppendIdea).toHaveBeenCalledWith("Roasted carrots");
  });
});

describe("ISO-28: submitCookReport", () => {
  const REPORT_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const REPORT_B = "1f8fad5b-d9cb-469f-a165-70867728950e";
  const REPORT_C = "2f8fad5b-d9cb-469f-a165-70867728950e";

  it("answers CONFLICT when kitchen B resends kitchen A's report id and leaves A's row unchanged", async () => {
    const resA = await callerA.submitCookReport(makeReport(REPORT_A, { note: "A note" }));
    expect(resA).toEqual({ id: REPORT_A, duplicate: false });
    const beforeA = await snapshotRow(db, cookReports, REPORT_A);
    expect(beforeA?.memberId).toBe(memberA.id);

    await expect(
      callerB.submitCookReport(makeReport(REPORT_A, { note: "B tampered note" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshotRow(db, cookReports, REPORT_A)).toEqual(beforeA);
  });

  it("counts the daily cap per kitchen and answers capped before conflict when B is at its cap", async () => {
    await callerA.submitCookReport(makeReport(REPORT_A, { note: "A first" }));
    const beforeA = await snapshotRow(db, cookReports, REPORT_A);

    // Fill kitchen A to its daily cap (99 more rows).
    const fillA = Array.from({ length: REPORTS_PER_DAY - 1 }, (_, i) => ({
      id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
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
    await db.insert(cookReports).values(fillA);

    // Kitchen A is capped; kitchen B still stores.
    await expect(
      callerA.submitCookReport(makeReport(REPORT_B)),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(await callerB.submitCookReport(makeReport(REPORT_B))).toEqual({
      id: REPORT_B,
      duplicate: false,
    });

    // Fill kitchen B to its daily cap (99 more rows).
    const fillB = Array.from({ length: REPORTS_PER_DAY - 1 }, (_, i) => ({
      id: `20000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      kitchenId: kitchenB.id,
      capturedAt: new Date(),
      build: "test-build",
      path: "/kitchen",
      screen: "step",
      queueId: null,
      recipeName: "Soup",
      state: { mode: "go", pos: 0, ticked: [], passed: [], kept: [] },
      context: makeReport(REPORT_B).context,
      events: [],
      dom: "<div></div>",
      domTruncated: false,
      note: "",
    }));
    await db.insert(cookReports).values(fillB);

    // B at its cap resending A's report id gets TOO_MANY_REQUESTS (capped first), leaving A untouched.
    await expect(
      callerB.submitCookReport(makeReport(REPORT_A, { note: "capped B" })),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(await snapshotRow(db, cookReports, REPORT_A)).toEqual(beforeA);

    // Once B is under its cap again, the same resend answers CONFLICT (never a raw DB error).
    await db.delete(cookReports).where(eq(cookReports.id, REPORT_B));
    await expect(
      callerB.submitCookReport(makeReport(REPORT_A, { note: "uncapped B" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshotRow(db, cookReports, REPORT_A)).toEqual(beforeA);
  });

  it("stores a report naming another kitchen's queueId, and list-reports intakeLines returns no line for it", async () => {
    const cut: KitchenQueueRecipeData = {
      ...SECRET_RECIPE_A,
      ingredients: [{ item: "saffron", amount: "2", unit: "tsp" }],
      stepIngredients: [[0], []],
    };
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: SECRET_RECIPE_A,
      intakeSourceHash: sourceHash("kitchen_queue", SECRET_RECIPE_A),
      intakeRecipe: cut,
      intakeStamp: "test-stamp",
      intakeAttempts: 1,
      intakeNudges: [],
    });

    await callerA.submitCookReport(makeReport(REPORT_A, { queueId: rowA.id }));
    await callerB.submitCookReport(makeReport(REPORT_C, { queueId: rowA.id }));

    const lines = await intakeLines([
      { id: REPORT_A, kitchenId: kitchenA.id, queueId: rowA.id },
      { id: REPORT_C, kitchenId: kitchenB.id, queueId: rowA.id },
    ]);
    expect(lines.get(REPORT_A)).toBeDefined();
    expect(lines.has(REPORT_C)).toBe(false);
  });
});

describe("ISO-29: annotateCookReport", () => {
  it("answers NOT_FOUND when kitchen B annotates kitchen A's report and leaves A's note unchanged", async () => {
    const reportId = "3f8fad5b-d9cb-469f-a165-70867728950e";
    await callerA.submitCookReport(makeReport(reportId, { note: "original note" }));
    const beforeA = await snapshotRow(db, cookReports, reportId);

    await expect(
      callerB.annotateCookReport({ id: reportId, note: "tampered note" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await snapshotRow(db, cookReports, reportId)).toEqual(beforeA);
  });
});

describe("ISO-30: parseGroceryInput", () => {
  it("parses groceries via the provider without storing anything another kitchen can read", async () => {
    connected.pantry = true;
    provider.onNextChat(() => ({
      content: JSON.stringify({
        items: [{ text: "2 avocados", suggestedSection: "Fridge" }],
      }),
      finishReason: "stop",
    }));

    const result = await callerB.parseGroceryInput({
      type: "text",
      content: "2 avocados",
    });
    expect(result.items).toEqual([{ text: "2 avocados", suggestedSection: "Fridge" }]);
    expect("kitchenId" in result).toBe(false);
    expect(provider.chatCalls).toHaveLength(1);
    expect(await callerA.getKitchenQueue({ status: "pending" })).toEqual([]);
    const usage = await db.select().from(aiUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      kitchenId: kitchenB.id,
      feature: "grocery-parse",
      status: "settled",
    });
  });
});

describe("ISO-31: addIngredientsToPantry", () => {
  it("answers UNAUTHORIZED without a session", async () => {
    const anon = await unauthenticatedSignInCaller();
    await expect(
      anon.addIngredientsToPantry({ items: [{ text: "2 avocados" }] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mockPantryAddItems).not.toHaveBeenCalled();
  });

  it("delegates to the pantry hook when called with a kitchen session", async () => {
    connected.pantry = true;
    mockPantryAddItems.mockResolvedValueOnce({ added: 1 });
    expect(
      await callerB.addIngredientsToPantry({ items: [{ text: "2 avocados" }] }),
    ).toEqual({ success: true, count: 1 });
    expect(mockPantryAddItems).toHaveBeenCalledWith([{ text: "2 avocados" }]);
  });
});

describe("ISO-32: getRecipePantryReconciliation", () => {
  it("answers NOT_FOUND for kitchen A's queueId whether pantry is connected or not, with no model or hook call", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    for (const isConnected of [true, false]) {
      connected.pantry = isConnected;
      await expect(
        callerB.getRecipePantryReconciliation({ queueId: rowA.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
    }
    expect(mockPantryReadSections).not.toHaveBeenCalled();
    expect(provider.chatCalls).toHaveLength(0);
  });
});

describe("ISO-33: applyPantryReconciliation", () => {
  it("answers NOT_FOUND for kitchen A's queueId whether pantry is connected or not, with no hook write", async () => {
    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: SECRET_RECIPE_A,
    });
    const beforeA = await snapshotRow(db, kitchenQueue, rowA.id);

    for (const isConnected of [true, false]) {
      connected.pantry = isConnected;
      await expect(
        callerB.applyPantryReconciliation({
          queueId: rowA.id,
          actions: [{ action: "delete", oldText: "2 avocados" }],
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await snapshotRow(db, kitchenQueue, rowA.id)).toEqual(beforeA);
    }
    expect(mockPantryApplyUpdates).not.toHaveBeenCalled();
  });
});

describe("ISO-34: getShoppingList", () => {
  it("answers UNAUTHORIZED without a session", async () => {
    const anon = await unauthenticatedSignInCaller();
    await expect(anon.getShoppingList()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(mockShoppingList).not.toHaveBeenCalled();
  });

  it("returns the shopping-list hook answer when called with a kitchen session", async () => {
    const syncedAt = new Date("2026-10-04T18:00:00.000Z");
    mockShoppingList.mockResolvedValueOnce({ items: [], syncedAt });
    expect(await callerB.getShoppingList()).toEqual({ items: [], syncedAt });
    expect(mockShoppingList).toHaveBeenCalledTimes(1);
  });
});

describe("ISO-35: addShoppingListItems", () => {
  it("answers UNAUTHORIZED without a session", async () => {
    const anon = await unauthenticatedSignInCaller();
    await expect(
      anon.addShoppingListItems({ items: [{ item: "Milk" }] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mockShoppingAdd).not.toHaveBeenCalled();
  });

  it("returns the shopping-list hook answer when called with a kitchen session", async () => {
    mockShoppingAdd.mockResolvedValueOnce({ added: ["Milk"] });
    expect(
      await callerB.addShoppingListItems({ items: [{ item: "Milk" }] }),
    ).toEqual({ added: ["Milk"] });
    expect(mockShoppingAdd).toHaveBeenCalledTimes(1);
  });
});

describe("ISO-36: removeShoppingListItem", () => {
  it("answers UNAUTHORIZED without a session", async () => {
    const anon = await unauthenticatedSignInCaller();
    await expect(
      anon.removeShoppingListItem({ rawOrKey: "Milk" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mockShoppingRemove).not.toHaveBeenCalled();
  });

  it("returns the shopping-list hook answer when called with a kitchen session", async () => {
    mockShoppingRemove.mockResolvedValueOnce({ removed: true });
    expect(
      await callerB.removeShoppingListItem({ rawOrKey: "Milk" }),
    ).toEqual({ removed: true });
    expect(mockShoppingRemove).toHaveBeenCalledWith("Milk");
  });
});

describe("ISO-37: clearShoppingList", () => {
  it("answers UNAUTHORIZED without a session", async () => {
    const anon = await unauthenticatedSignInCaller();
    await expect(anon.clearShoppingList()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(mockShoppingClear).not.toHaveBeenCalled();
  });

  it("returns the shopping-list hook answer when called with a kitchen session", async () => {
    mockShoppingClear.mockResolvedValueOnce({ cleared: 2 });
    expect(await callerB.clearShoppingList()).toEqual({ cleared: 2 });
    expect(mockShoppingClear).toHaveBeenCalledTimes(1);
  });
});

describe("STRUCT-1: router procedure inventory", () => {
  it("exposes exactly the 55 documented procedures", () => {
    const expected = [
      "health",
      "chatCooking",
      "addToKitchenQueue",
      "getKitchenQueue",
      "getKitchenQueueItem",
      "ensureIntake",
      "ensureCookPlan",
      "updateKitchenQueueStatus",
      "markCookActivity",
      "autoFinishCook",
      "reopenCook",
      "retryCookLog",
      "rateCook",
      "getCookAsk",
      "setCookLogHeldBack",
      "dismissCookAsk",
      "getCookLog",
      "updateCookLogEntry",
      "getKitchenSettings",
      "updateKitchenAbout",
      "listKitchenWebhookTokens",
      "createKitchenWebhookToken",
      "revokeKitchenWebhookToken",
      "setDocRecipePrivate",
      "setQueueRecipePrivate",
      "removeFromKitchenQueue",
      "getRecentCookingItems",
      "importRecipeFromUrl",
      "importRecipeFromText",
      "importRecipeFromImage",
      "getShelf",
      "getPack",
      "libraryPlanReport",
      "syncRecipes",
      "queueFromPack",
      "getRecipeIdeas",
      "saveRecipeIdea",
      "submitCookReport",
      "annotateCookReport",
      "getPantry",
      "parseGroceryInput",
      "addIngredientsToPantry",
      "getRecipePantryReconciliation",
      "applyPantryReconciliation",
      "getShoppingList",
      "addShoppingListItems",
      "removeShoppingListItem",
      "clearShoppingList",
      "getCircleDishes",
      "getCircleDish",
      "queueCircleDish",
      "getSharedRecipe",
      "queueSharedRecipe",
      "getPackCircleShares",
      "setPackCircleShare",
    ];
    expect(expected).toHaveLength(55);
    expect(Object.keys(appRouter._def.procedures).sort()).toEqual(
      [...expected].sort(),
    );
  });
});

describe("STRUCT-2 (SLUG-1): router input schemas never accept kitchen, member, or cook slug ownership", () => {
  // SLUG-1: retired userId and targetUser slug fields are forbidden on every procedure input.
  const FORBIDDEN_KEYS = new Set(["kitchenId", "kitchen", "memberId", "userId", "targetUser"]);

  interface ZodLikeSchema {
    shape?: Record<string, ZodLikeSchema>;
    unwrap?: () => ZodLikeSchema;
    isOptional?: () => boolean;
    def?: { type?: string; innerType?: ZodLikeSchema; schema?: ZodLikeSchema };
    _def?: { typeName?: string; innerType?: ZodLikeSchema; schema?: ZodLikeSchema };
  }

  function objectShape(schema: unknown): Record<string, ZodLikeSchema> | null {
    let current = schema as ZodLikeSchema | undefined;
    const seen = new Set<unknown>();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (current.shape && typeof current.shape === "object") {
        return current.shape;
      }
      const next =
        current.def?.innerType ??
        current.def?.schema ??
        current._def?.innerType ??
        current._def?.schema ??
        (typeof current.unwrap === "function" ? current.unwrap() : undefined);
      current = next;
    }
    return null;
  }

  it("forbids kitchenId, kitchen, memberId, userId, and targetUser on all procedure inputs (SLUG-1)", () => {
    const procedures = appRouter._def.procedures as Record<
      string,
      { _def?: { inputs?: unknown[] } }
    >;

    for (const [name, procedure] of Object.entries(procedures)) {
      const inputs = procedure._def?.inputs ?? [];
      for (const inputSchema of inputs) {
        const shape = objectShape(inputSchema);
        expect(shape, `Procedure ${name} should have an inspectable object input schema`).not.toBeNull();
        if (!shape) continue;

        for (const key of Object.keys(shape)) {
          expect(
            FORBIDDEN_KEYS.has(key),
            `Procedure ${name} must not accept "${key}" in its input`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("AUTH-1: every procedure except health requires a session and kitchen membership", () => {
  const SAMPLE_UUID = "00000000-0000-4000-8000-000000000001";

  it("answers UNAUTHORIZED for all 54 non-health procedures when called without a session", async () => {
    const anon = await unauthenticatedSignInCaller();

    const calls: Record<string, () => Promise<unknown>> = {
      chatCooking: () =>
        anon.chatCooking({
          sessionId: "s1",
          messages: [{ role: "user", content: "hi" }],
        }),
      addToKitchenQueue: () =>
        anon.addToKitchenQueue({
          recipeData: { name: "Soup", steps: ["Simmer."], serves: 2 },
        }),
      getKitchenQueue: () => anon.getKitchenQueue({ status: "pending" }),
      getKitchenQueueItem: () =>
        anon.getKitchenQueueItem({ queueId: SAMPLE_UUID }),
      ensureIntake: () =>
        anon.ensureIntake({ queueId: SAMPLE_UUID, ask: "opening" }),
      ensureCookPlan: () => anon.ensureCookPlan({ queueId: SAMPLE_UUID }),
      updateKitchenQueueStatus: () =>
        anon.updateKitchenQueueStatus({
          queueId: SAMPLE_UUID,
          status: "cooking",
        }),
      markCookActivity: () =>
        anon.markCookActivity({
          queueId: SAMPLE_UUID,
          idleForMs: null,
          interactedAt: Date.now(),
        }),
      autoFinishCook: () =>
        anon.autoFinishCook({
          queueId: SAMPLE_UUID,
          idleForMs: 0,
          interactedAt: Date.now(),
        }),
      reopenCook: () => anon.reopenCook({ queueId: SAMPLE_UUID }),
      retryCookLog: () => anon.retryCookLog({ queueId: SAMPLE_UUID }),
      rateCook: () => anon.rateCook({ queueId: SAMPLE_UUID, rating: 5 }),
      getCookAsk: () => anon.getCookAsk({}),
      setCookLogHeldBack: () =>
        anon.setCookLogHeldBack({ queueId: SAMPLE_UUID, heldBack: true }),
      dismissCookAsk: () => anon.dismissCookAsk({ queueId: SAMPLE_UUID }),
      getCookLog: () => anon.getCookLog(),
      updateCookLogEntry: () =>
        anon.updateCookLogEntry({ id: SAMPLE_UUID, rating: 4 }),
      getKitchenSettings: () => anon.getKitchenSettings(),
      updateKitchenAbout: () =>
        anon.updateKitchenAbout({ about: "No peanuts." }),
      listKitchenWebhookTokens: () => anon.listKitchenWebhookTokens(),
      createKitchenWebhookToken: () =>
        anon.createKitchenWebhookToken({ label: "assistant" }),
      revokeKitchenWebhookToken: () =>
        anon.revokeKitchenWebhookToken({ id: SAMPLE_UUID }),
      setDocRecipePrivate: () =>
        anon.setDocRecipePrivate({ docSlug: "dal", isPrivate: true }),
      setQueueRecipePrivate: () =>
        anon.setQueueRecipePrivate({ queueId: SAMPLE_UUID, isPrivate: true }),
      removeFromKitchenQueue: () =>
        anon.removeFromKitchenQueue({ queueId: SAMPLE_UUID }),
      getRecentCookingItems: () => anon.getRecentCookingItems({}),
      importRecipeFromUrl: () =>
        anon.importRecipeFromUrl({ url: "https://example.com/recipe" }),
      importRecipeFromText: () =>
        anon.importRecipeFromText({ text: "Boil water." }),
      importRecipeFromImage: () =>
        anon.importRecipeFromImage({
          imageBase64: "AAAA",
        }),
      getShelf: () => anon.getShelf(),
      getPack: () => anon.getPack({ packId: "fannie-farmer-1896" }),
      libraryPlanReport: () => anon.libraryPlanReport(),
      syncRecipes: () => anon.syncRecipes(),
      queueFromPack: () =>
        anon.queueFromPack({
          packId: "fannie-farmer-1896",
          recipeId: "thin-white-sauce",
        }),
      getRecipeIdeas: () => anon.getRecipeIdeas(),
      saveRecipeIdea: () => anon.saveRecipeIdea({ text: "Tacos" }),
      submitCookReport: () => anon.submitCookReport(makeReport(SAMPLE_UUID)),
      annotateCookReport: () =>
        anon.annotateCookReport({ id: SAMPLE_UUID, note: "note" }),
      getPantry: () => anon.getPantry(),
      parseGroceryInput: () =>
        anon.parseGroceryInput({ type: "text", content: "apples" }),
      addIngredientsToPantry: () =>
        anon.addIngredientsToPantry({ items: [{ text: "apples" }] }),
      getRecipePantryReconciliation: () =>
        anon.getRecipePantryReconciliation({ queueId: SAMPLE_UUID }),
      applyPantryReconciliation: () =>
        anon.applyPantryReconciliation({
          actions: [{ action: "delete", oldText: "apples" }],
        }),
      getShoppingList: () => anon.getShoppingList(),
      addShoppingListItems: () =>
        anon.addShoppingListItems({ items: [{ item: "Milk" }] }),
      removeShoppingListItem: () =>
        anon.removeShoppingListItem({ rawOrKey: "Milk" }),
      clearShoppingList: () => anon.clearShoppingList(),
      getCircleDishes: () => anon.getCircleDishes(),
      getCircleDish: () => anon.getCircleDish({ logId: SAMPLE_UUID }),
      queueCircleDish: () => anon.queueCircleDish({ logId: SAMPLE_UUID }),
      getSharedRecipe: () => anon.getSharedRecipe({ recipeId: SAMPLE_UUID }),
      queueSharedRecipe: () => anon.queueSharedRecipe({ recipeId: SAMPLE_UUID }),
      getPackCircleShares: () =>
        anon.getPackCircleShares({ packId: "my-pack" }),
      setPackCircleShare: () =>
        anon.setPackCircleShare({
          packId: "my-pack",
          targetKitchenId: SAMPLE_UUID,
          shared: true,
        }),
    };

    const nonHealthProcedures = Object.keys(appRouter._def.procedures)
      .filter((name) => name !== "health")
      .sort();
    expect(Object.keys(calls).sort()).toEqual(nonHealthProcedures);

    for (const [name, invoke] of Object.entries(calls)) {
      await expect(
        invoke(),
        `Procedure ${name} must answer UNAUTHORIZED without a session`,
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("answers FORBIDDEN with NotInvitedError cause on caller and data.reason='not-invited' through HTTP for a signed-in user with no kitchen", async () => {
    stubSignInEnv();
    for (const name of HOOK_NAMES) {
      connected[name] = false;
    }
    resetDeploymentCheckForTests(db);

    // Create a user + session via a pending invite, then revoke the invite so
    // they hold a valid session cookie with no membership and no pending invite.
    await db.insert(invites).values({
      email: "uninvited-session@example.com",
      newKitchenName: "Temp Kitchen",
      newKitchenSlug: "temp-kitchen",
      role: "owner",
    });
    const testAuth = createTestAuth(db);
    const authCtx = await testAuth.$context;
    const savedUser = await authCtx.test.saveUser(
      authCtx.test.createUser({
        email: "uninvited-session@example.com",
        name: "No Kitchen",
        emailVerified: true,
      }),
    );
    const headers = await signedInHeaders(savedUser.id, db);
    await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.email, "uninvited-session@example.com"));

    // Through caller: FORBIDDEN with NotInvitedError cause.
    const ctx = await createTRPCContext({
      req: new Request("https://app.example.com/api/trpc/getKitchenQueue", {
        headers,
      }),
    });
    const caller = appRouter.createCaller(ctx);
    const callerErr = await caller
      .getKitchenQueue({ status: "pending" })
      .catch((e: unknown) => e);
    expect(callerErr).toMatchObject({ code: "FORBIDDEN" });
    expect((callerErr as { cause?: unknown }).cause).toBeInstanceOf(
      NotInvitedError,
    );

    // Through HTTP (query): 403 with data.reason === "not-invited".
    const queryRes = await httpCall<{
      error: { data: { code: string; reason?: string } };
    }>("getKitchenQueue", { status: "pending" }, { method: "GET", headers });
    expect(queryRes.status).toBe(403);
    expect(queryRes.body.error.data.code).toBe("FORBIDDEN");
    expect(queryRes.body.error.data.reason).toBe("not-invited");

    // Through HTTP (mutation): 403 with data.reason === "not-invited".
    const mutationRes = await httpCall<{
      error: { data: { code: string; reason?: string } };
    }>(
      "removeFromKitchenQueue",
      { queueId: SAMPLE_UUID },
      { method: "POST", headers },
    );
    expect(mutationRes.status).toBe(403);
    expect(mutationRes.body.error.data.code).toBe("FORBIDDEN");
    expect(mutationRes.body.error.data.reason).toBe("not-invited");

    // Confirm user row still exists and no kitchen was created for them.
    const [u] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.id, savedUser.id));
    expect(u?.id).toBe(savedUser.id);
  });
});

describe("AUTH-2: public health procedure", () => {
  it("answers without a session and returns only status and timestamp", async () => {
    const unauthenticatedCaller = await unauthenticatedSignInCaller();
    const result = await unauthenticatedCaller.health();
    expect(Object.keys(result).sort()).toEqual(["status", "timestamp"]);
    expect(result.status).toBe("ok");
    expect(typeof result.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });
});

describe("ISO-38: getCookLog and updateCookLogEntry", () => {
  it("lists and updates only the caller kitchen's cook log rows", async () => {
    const [entryA] = await db
      .insert(kitchenCookLog)
      .values({
        kitchenId: kitchenA.id,
        recipeTitle: SECRET_RECIPE_A.name,
        timestampText: "2026-03-10 18:30",
        cookedDay: "2026-03-10",
        rating: 4,
        notes: "Kitchen A private note",
        notePrivate: true,
        heldBack: false,
      })
      .returning();

    expect(await callerB.getCookLog()).toEqual([]);
    const listA = await callerA.getCookLog();
    expect(listA).toHaveLength(1);
    expect(listA[0]!.id).toBe(entryA!.id);
    expect(listA[0]!.recipeTitle).toBe(SECRET_RECIPE_A.name);

    await expect(
      callerB.updateCookLogEntry({
        id: entryA!.id,
        rating: 1,
        notes: "tampered",
        heldBack: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [unchanged] = await db
      .select()
      .from(kitchenCookLog)
      .where(eq(kitchenCookLog.id, entryA!.id));
    expect(unchanged?.rating).toBe(4);
    expect(unchanged?.notes).toBe("Kitchen A private note");
    expect(unchanged?.heldBack).toBe(false);
  });
});

describe("ISO-39: getKitchenSettings and updateKitchenAbout", () => {
  it("reads and updates only the caller kitchen's settings and about text", async () => {
    await callerA.updateKitchenAbout({ about: "We avoid tree nuts." });

    const settingsA = await callerA.getKitchenSettings();
    const settingsB = await callerB.getKitchenSettings();

    expect(settingsA.slug).toBe("kitchen-a");
    expect(settingsA.about).toBe("We avoid tree nuts.");
    expect(settingsA.memberRole).toBe("owner");

    expect(settingsB.slug).toBe("kitchen-b");
    expect(settingsB.about).toBe("");

    await callerB.updateKitchenAbout({ about: "Kitchen B only" });
    const [rowA] = await db
      .select({ about: kitchens.about })
      .from(kitchens)
      .where(eq(kitchens.id, kitchenA.id));
    expect(rowA?.about).toBe("We avoid tree nuts.");
  });

  it("accepts a 2,000-character about string and rejects 2,001 characters with BAD_REQUEST", async () => {
    const exact = "a".repeat(2000);
    const updated = await callerA.updateKitchenAbout({ about: exact });
    expect(updated.about).toBe(exact);

    await expect(
      callerA.updateKitchenAbout({ about: "a".repeat(2001) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const settingsA = await callerA.getKitchenSettings();
    expect(settingsA.about).toBe(exact);
  });
});

describe("ISO-40: setDocRecipePrivate and setQueueRecipePrivate", () => {
  it("refuses cross-kitchen privacy toggles on doc recipes and queue items", async () => {
    const [docA] = await db
      .insert(docRecipes)
      .values({
        kitchenId: kitchenA.id,
        docSlug: "saffron-tart",
        name: SECRET_RECIPE_A.name,
        rawDocText: "Saffron tart\n1 cup cream\nBake 30 min.",
        isPrivate: false,
      })
      .returning();

    const rowA = await seedQueueRow(db, kitchenA.id, {
      recipeData: SECRET_RECIPE_A,
    });

    await expect(
      callerB.setDocRecipePrivate({ id: docA!.id, isPrivate: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerB.setDocRecipePrivate({ docSlug: "saffron-tart", isPrivate: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerB.setQueueRecipePrivate({ queueId: rowA.id, isPrivate: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [docAfterB] = await db
      .select({ isPrivate: docRecipes.isPrivate })
      .from(docRecipes)
      .where(eq(docRecipes.id, docA!.id));
    expect(docAfterB?.isPrivate).toBe(false);

    const [queueAfterB] = await db
      .select({ isPrivate: kitchenQueue.isPrivate })
      .from(kitchenQueue)
      .where(eq(kitchenQueue.id, rowA.id));
    expect(queueAfterB?.isPrivate).toBe(false);

    expect(
      await callerA.setDocRecipePrivate({ docSlug: "saffron-tart", isPrivate: true }),
    ).toMatchObject({ docSlug: "saffron-tart", isPrivate: true });
    expect(
      await callerA.setQueueRecipePrivate({ queueId: rowA.id, isPrivate: true }),
    ).toMatchObject({ id: rowA.id, isPrivate: true });
  });
});

describe("ISO-41: owner webhook tokens", () => {
  it("isolates tokens between kitchens, restricts management to owners in sign-in mode, and enforces the 10-live-token cap", async () => {
    // Owner of kitchen B
    const [userB] = await db
      .insert(authUser)
      .values({
        id: "user-owner-b",
        name: "Owner B",
        email: "owner-b@example.com",
        emailVerified: true,
      })
      .returning();
    const [memberB] = await db
      .insert(members)
      .values({
        kitchenId: kitchenB.id,
        userId: userB!.id,
        role: "owner",
      })
      .returning();
    const ownerCallerB = callerFor(kitchenB, {
      id: memberB!.id,
      role: "owner",
    });

    // Cook in kitchen A
    const [cookUserA] = await db
      .insert(authUser)
      .values({
        id: "user-cook-a",
        name: "Cook A",
        email: "cook-a@example.com",
        emailVerified: true,
      })
      .returning();
    const [cookMemberA] = await db
      .insert(members)
      .values({
        kitchenId: kitchenA.id,
        userId: cookUserA!.id,
        role: "cook",
      })
      .returning();
    const cookCallerA = callerFor(kitchenA, {
      id: cookMemberA!.id,
      role: "cook",
    });

    // Owner A creates a token
    const createdA = await callerA.createKitchenWebhookToken({
      label: "Kitchen assistant",
    });
    expect(createdA.label).toBe("Kitchen assistant");
    expect(createdA.token).toMatch(/^sous_[A-Za-z0-9_-]+$/);

    // Owner B cannot see or revoke Kitchen A's token
    expect(await ownerCallerB.listKitchenWebhookTokens()).toEqual([]);
    await expect(
      ownerCallerB.revokeKitchenWebhookToken({ id: createdA.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Cook in Kitchen A is refused with FORBIDDEN
    await expect(cookCallerA.listKitchenWebhookTokens()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      cookCallerA.createKitchenWebhookToken({ label: "cook-attempt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      cookCallerA.revokeKitchenWebhookToken({ id: createdA.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Listing for Owner A never returns plaintext token or SHA-256 hash
    const listedA = await callerA.listKitchenWebhookTokens();
    expect(listedA).toHaveLength(1);
    expect(listedA[0]).toMatchObject({
      id: createdA.id,
      label: "Kitchen assistant",
      lastUsedAt: null,
    });
    expect(JSON.stringify(listedA)).not.toContain(createdA.token);

    // Mint 9 more tokens (total 10 live); 11th is refused with CONFLICT
    const extraIds: string[] = [];
    for (let i = 2; i <= 10; i++) {
      const extra = await callerA.createKitchenWebhookToken({
        label: `Token ${i}`,
      });
      extraIds.push(extra.id);
    }
    await expect(
      callerA.createKitchenWebhookToken({ label: "Token 11" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Revoking one frees a slot and prevents re-revocation
    const revoked = await callerA.revokeKitchenWebhookToken({ id: extraIds[0]! });
    expect(revoked.id).toBe(extraIds[0]);
    await expect(
      callerA.revokeKitchenWebhookToken({ id: extraIds[0]! }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Kitchen B is unaffected by Kitchen A's 10-token cap
    const createdB = await ownerCallerB.createKitchenWebhookToken({
      label: "B token",
    });
    expect(createdB.token).toMatch(/^sous_/);

    // Kitchen A can mint one replacement after revoking
    const replacement = await callerA.createKitchenWebhookToken({
      label: "Replacement",
    });
    expect(replacement.label).toBe("Replacement");
    const liveCountA = (await callerA.listKitchenWebhookTokens()).length;
    expect(liveCountA).toBe(10);

    // Revoking createdA removes it from the live list and marks it revoked in DB
    await callerA.revokeKitchenWebhookToken({ id: createdA.id });
    expect(
      (await callerA.listKitchenWebhookTokens()).some(
        (t) => t.id === createdA.id,
      ),
    ).toBe(false);
    const [dbRow] = await db
      .select({ revokedAt: kitchenWebhookTokens.revokedAt })
      .from(kitchenWebhookTokens)
      .where(eq(kitchenWebhookTokens.id, createdA.id));
    expect(dbRow?.revokedAt).toBeInstanceOf(Date);
  });

  it("refuses token management endpoints in single-kitchen mode (SOUS_SIGN_IN=off)", async () => {
    await client.exec(
      "delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user; delete from kitchens where slug <> 'home';",
    );
    vi.stubEnv("SOUS_SIGN_IN", "off");
    for (const name of HOOK_NAMES) {
      connected[name] = false;
    }
    resetDeploymentCheckForTests(db);

    const singleCaller = appRouter.createCaller(await createTRPCContext());
    await expect(singleCaller.listKitchenWebhookTokens()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      singleCaller.createKitchenWebhookToken({ label: "single" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      singleCaller.revokeKitchenWebhookToken({
        id: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("ISO-42: getPantry", () => {
  it("answers UNAUTHORIZED without a session and delegates to the pantry hook when connected", async () => {
    const anon = await unauthenticatedSignInCaller();
    await expect(anon.getPantry()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(mockPantryReadSections).not.toHaveBeenCalled();

    connected.pantry = false;
    expect(await callerA.getPantry()).toEqual({ sections: [] });
    expect(mockPantryReadSections).not.toHaveBeenCalled();

    connected.pantry = true;
    mockPantryReadSections.mockResolvedValueOnce([
      { heading: "fridge", rawHeading: "Fridge", items: ["2 avocados"] },
    ]);
    expect(await callerB.getPantry()).toEqual({
      sections: [{ heading: "fridge", rawHeading: "Fridge", items: ["2 avocados"] }],
    });
    expect(mockPantryReadSections).toHaveBeenCalledTimes(1);
  });
});

describe("ISO-43: setCookLogHeldBack", () => {
  it("isolates between kitchens and refuses single-kitchen mode", async () => {
    const qRowA = await seedQueueRow(db, kitchenA.id, {
      status: "completed",
      completedAt: new Date(),
      recipeData: SECRET_RECIPE_A,
    });
    await db.insert(kitchenCookLog).values({
      kitchenId: kitchenA.id,
      queueId: qRowA.id,
      recipeTitle: SECRET_RECIPE_A.name,
      recipeSnapshot: SECRET_RECIPE_A,
      timestampText: "2026-11-24 19:00",
      cookedDay: "2026-11-24",
      heldBack: false,
    });

    await expect(
      callerB.setCookLogHeldBack({ queueId: qRowA.id, heldBack: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const toggled = await callerA.setCookLogHeldBack({
      queueId: qRowA.id,
      heldBack: true,
    });
    expect(toggled).toEqual({ queueId: qRowA.id, heldBack: true });

    await client.exec(
      "delete from kitchen_cook_log; delete from kitchen_queue; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user; delete from kitchens where slug <> 'home';",
    );
    vi.stubEnv("SOUS_SIGN_IN", "off");
    for (const name of HOOK_NAMES) {
      connected[name] = false;
    }
    resetDeploymentCheckForTests(db);
    const singleCaller = appRouter.createCaller(await createTRPCContext());
    await expect(
      singleCaller.setCookLogHeldBack({
        queueId: "00000000-0000-4000-8000-000000000001",
        heldBack: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("ISO-44: getCircleDishes, getCircleDish, and queueCircleDish", () => {
  it("isolates dishes to circle members and queues an independent copy for the viewer", async () => {
    const circle = await createCircle({ name: "Test Circle" }, db);
    await addKitchenToCircle({ circleId: circle.id, kitchenSlug: "kitchen-a" }, db);

    const [logA] = await db
      .insert(kitchenCookLog)
      .values({
        kitchenId: kitchenA.id,
        recipeTitle: SECRET_RECIPE_A.name,
        recipeSnapshot: SECRET_RECIPE_A,
        timestampText: "2026-11-25 19:00",
        cookedDay: "2026-11-25",
        cookedAt: new Date(Date.now() + 2_000),
        rating: 5,
        notes: "Flaky crust",
        heldBack: false,
      })
      .returning();

    // Kitchen B is NOT in the circle -> sees nothing and gets NOT_FOUND
    expect(await callerB.getCircleDishes()).toEqual([]);
    await expect(
      callerB.getCircleDish({ logId: logA!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Not available" });
    await expect(
      callerB.queueCircleDish({ logId: logA!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Not available" });

    // Add Kitchen B to the circle -> sees A's dish and can open & queue a copy
    await addKitchenToCircle({ circleId: circle.id, kitchenSlug: "kitchen-b" }, db);
    const dishesB = await callerB.getCircleDishes();
    expect(dishesB).toHaveLength(1);
    expect(dishesB[0]).toMatchObject({
      logId: logA!.id,
      recipeTitle: SECRET_RECIPE_A.name,
      kitchenName: "Kitchen A",
      canOpenRecipe: true,
    });

    const readDish = await callerB.getCircleDish({ logId: logA!.id });
    expect(readDish.title).toBe(SECRET_RECIPE_A.name);
    expect(readDish.recipe.steps).toEqual(SECRET_RECIPE_A.steps);

    const queuedCopy = await callerB.queueCircleDish({ logId: logA!.id });
    const storedCopy = await snapshotRow(db, kitchenQueue, queuedCopy.id);
    expect(storedCopy?.kitchenId).toBe(kitchenB.id);
    expect(storedCopy?.recipeData?.name).toBe(SECRET_RECIPE_A.name);
    expect(storedCopy?.isPrivate).toBe(false);

    // Removing Kitchen A hides it immediately
    await removeKitchenFromCircle({ kitchenSlug: "kitchen-a" }, db);
    expect(await callerB.getCircleDishes()).toEqual([]);
    await expect(
      callerB.getCircleDish({ logId: logA!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Not available" });
  });
});

describe("ISO-45: getSharedRecipe and queueSharedRecipe", () => {
  it("opens share links only for same-circle kitchens and gives identical Not available otherwise", async () => {
    const circle = await createCircle({ name: "Share Circle" }, db);
    await addKitchenToCircle({ circleId: circle.id, kitchenSlug: "kitchen-a" }, db);

    const [docA] = await db
      .insert(docRecipes)
      .values({
        kitchenId: kitchenA.id,
        docSlug: "saffron-tart",
        name: SECRET_RECIPE_A.name,
        ingredients: SECRET_RECIPE_A.ingredients,
        steps: SECRET_RECIPE_A.steps,
        serves: 4,
        rawDocText: "Saffron tart",
        isPrivate: false,
      })
      .returning();

    // Outside circle B gets NOT_FOUND
    await expect(
      callerB.getSharedRecipe({ recipeId: docA!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Not available" });
    await expect(
      callerB.queueSharedRecipe({ recipeId: docA!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Not available" });

    // Join circle -> opens and queues into B
    await addKitchenToCircle({ circleId: circle.id, kitchenSlug: "kitchen-b" }, db);
    const shared = await callerB.getSharedRecipe({ recipeId: docA!.id });
    expect(shared.title).toBe(SECRET_RECIPE_A.name);
    const queued = await callerB.queueSharedRecipe({ recipeId: docA!.id });
    const storedCopy = await snapshotRow(db, kitchenQueue, queued.id);
    expect(storedCopy?.kitchenId).toBe(kitchenB.id);

    // Marking private blocks immediately with identical NOT_FOUND
    await callerA.setDocRecipePrivate({ id: docA!.id, isPrivate: true });
    await expect(
      callerB.getSharedRecipe({ recipeId: docA!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Not available" });
  });
});

describe("ISO-46: getPackCircleShares and setPackCircleShare", () => {
  it("restricts pack circle sharing toggles to the owning kitchen's owner within the circle", async () => {
    const circle = await createCircle({ name: "Pack Circle" }, db);
    await addKitchenToCircle({ circleId: circle.id, kitchenSlug: "kitchen-a" }, db);
    await addKitchenToCircle({ circleId: circle.id, kitchenSlug: "kitchen-b" }, db);

    const samplePack = {
      id: "owner-circle-pack",
      title: "Owner Circle Pack",
      version: "1.0.0",
      creator: { name: "Chef A" },
      recipes: [
        {
          id: "r1",
          title: "Simple Broth",
          serves_base: 4,
          ingredients: [
            {
              id: "i1",
              name: "Water",
              qty_canonical: { volume_ml: 500 },
              display_equivalents: { imperial: { unit: "cup", amount: 2 } },
            },
          ],
          steps: [
            {
              id: "s1",
              type: "action",
              text: "Boil the water for 5 minutes.",
              ingredient_refs: ["i1"],
              timer_sec: 300,
            },
          ],
        },
      ],
    };
    await addKitchenPack(
      {
        kitchenSlug: "kitchen-a",
        rawBytes: JSON.stringify(samplePack),
        packsDir: PACKS_DIR,
      },
      db,
    );

    const [cookUserA] = await db
      .insert(authUser)
      .values({
        id: "user-cook-circle-a",
        name: "Cook A",
        email: "cook-circle-a@example.com",
        emailVerified: true,
      })
      .returning();
    const [cookMemberA] = await db
      .insert(members)
      .values({
        kitchenId: kitchenA.id,
        userId: cookUserA!.id,
        role: "cook",
      })
      .returning();
    const cookCallerA = callerFor(kitchenA, {
      id: cookMemberA!.id,
      role: "cook",
    });

    const [ownerUserB] = await db
      .insert(authUser)
      .values({
        id: "user-owner-circle-b",
        name: "Owner B",
        email: "owner-circle-b@example.com",
        emailVerified: true,
      })
      .returning();
    const [ownerMemberB] = await db
      .insert(members)
      .values({
        kitchenId: kitchenB.id,
        userId: ownerUserB!.id,
        role: "owner",
      })
      .returning();
    const ownerCallerB = callerFor(kitchenB, {
      id: ownerMemberB!.id,
      role: "owner",
    });

    // Cook in A is forbidden
    await expect(
      cookCallerA.getPackCircleShares({ packId: "owner-circle-pack" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      cookCallerA.setPackCircleShare({
        packId: "owner-circle-pack",
        targetKitchenId: kitchenB.id,
        shared: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Owner of B cannot inspect or toggle A's pack
    await expect(
      ownerCallerB.getPackCircleShares({ packId: "owner-circle-pack" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      ownerCallerB.setPackCircleShare({
        packId: "owner-circle-pack",
        targetKitchenId: kitchenA.id,
        shared: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Owner of A lists and toggles sharing with B on and off
    const shares = await callerA.getPackCircleShares({
      packId: "owner-circle-pack",
    });
    expect(shares.kitchens).toEqual([
      { kitchenId: kitchenB.id, slug: "kitchen-b", name: "Kitchen B", shared: false },
    ]);

    await callerA.setPackCircleShare({
      packId: "owner-circle-pack",
      targetKitchenId: kitchenB.id,
      shared: true,
    });
    expect(
      (await callerB.getPack({ packId: "owner-circle-pack" }))?.title,
    ).toBe("Owner Circle Pack");

    await callerA.setPackCircleShare({
      packId: "owner-circle-pack",
      targetKitchenId: kitchenB.id,
      shared: false,
    });
    expect(
      await callerB.getPack({ packId: "owner-circle-pack" }),
    ).toBeNull();
  });
});
