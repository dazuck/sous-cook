import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

const fakeProvider = await vi.hoisted(async () => {
  const { FakeProviderController } = await import("../__tests__/fake-provider");
  return new FakeProviderController();
});
const scheduled = vi.hoisted(() => [] as Array<() => Promise<void> | void>);
const mockReadTabs = vi.hoisted(() => vi.fn());
const mockPantryReadSections = vi.hoisted(() => vi.fn());

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => Promise<void> | void) => {
      scheduled.push(fn);
    },
  };
});
vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);
vi.mock("@/lib/ai/providers/google", () => ({
  createGoogleProvider: () => fakeProvider.provider("google"),
}));
vi.mock("@/lib/ai/providers/anthropic", () => ({
  createAnthropicProvider: () => fakeProvider.provider("anthropic"),
}));
vi.mock("@/lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../hooks/types");
  return {
    connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, false])),
  };
});
vi.mock("@/lib/hooks/registry", () => ({
  hook: (name: string) => {
    if (name === "recipe-library") {
      return { readTabs: mockReadTabs };
    }
    if (name === "pantry") {
      return {
        readSections: mockPantryReadSections,
        addItems: vi.fn(),
        applyUpdates: vi.fn(),
      };
    }
    throw new Error(`Unexpected hook "${name}" in cap-paths.test.ts`);
  },
}));

import * as dbModule from "@/lib/db";
import {
  aiUsage,
  conversationLogs,
  db,
  docRecipes,
  kitchenQueue,
  kitchens,
} from "@/lib/db";
import { connected } from "@/lib/hooks/connected";
import { HOOK_NAMES } from "@/lib/hooks/types";
import { POST as webhookQueuePost } from "@/app/api/kitchen-queue/route";
import { resetAuthForTests } from "@/lib/auth/auth";
import { CostLedger } from "@/lib/cook-plan-cost";
import {
  COOK_PLAN_TIMEOUT_MS,
  CookPlanDerivationError,
  deriveCookPlan,
} from "@/lib/kitchen/cook-plan-derive";
import {
  ZUCCHINI_RECIPE,
  zucchiniRaw,
} from "@/lib/kitchen/__tests__/zucchini-wraps";
import {
  deriveAndStoreCookPlan,
  ensureIntakeForCook,
  prepareQueueItemInBackground,
} from "@/lib/kitchen-queue";
import { resetDeploymentCheckForTests } from "@/lib/kitchens/deployment";
import { deriveLibraryPlan } from "@/lib/library-cook-plans";
import { INTAKE_TIMEOUT_MS, runIntake } from "@/lib/pack-convert/intake";
import { sourceHash } from "@/lib/serves-estimate-plan";
import {
  extractRecipeFromText,
  type ExtractionUsage,
} from "@/lib/recipe-import";
import {
  callerFor,
  mintToken,
  seedKitchen,
  seedQueueRow,
  snapshotRow,
  type KitchenRow,
  type MemberRow,
  type AuthUserRow,
} from "@/lib/__tests__/kitchens";
import { signedInHeaders, stubSignInEnv } from "@/lib/__tests__/test-auth";
import { httpCall } from "@/lib/__tests__/trpc-http";
import { kitchenMeter } from "./meter";
import { computeCostMicros, getModelPrice } from "./prices";
import {
  AllowanceUsedError,
  UnpricedModelError,
  isAllowanceUsed,
} from "./types";

const client = (dbModule as unknown as { client: PGlite }).client;

let kitchenA: KitchenRow;
let memberA: MemberRow;
let userA: AuthUserRow;
let kitchenB: KitchenRow;
let userB: AuthUserRow;

const TEST_RECIPE_NO_SERVES = {
  name: "Lemon Garlic Beans",
  ingredients: [
    { item: "white beans", amount: "2", unit: "cans" },
    { item: "garlic cloves", amount: "3" },
  ],
  steps: ["Warm the white beans with minced garlic cloves for 10 minutes."],
};

const INTAKE_RECIPE = {
  name: "Zucchini wraps",
  serves: 4,
  ...ZUCCHINI_RECIPE,
};

interface HttpTrpcErrorBody {
  error: {
    message: string;
    data: {
      code: string;
      allowance?: { scope: "kitchen" | "overall"; resetsAt: string };
    };
  };
}

beforeEach(async () => {
  fakeProvider.reset();
  scheduled.length = 0;
  mockReadTabs.mockReset();
  mockPantryReadSections.mockReset();
  for (const name of HOOK_NAMES) {
    connected[name] = false;
  }

  stubSignInEnv({
    SOUS_AI_KITCHEN_CAP_USD: "2",
    SOUS_AI_TOTAL_CAP_USD: "10",
  });
  vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
  vi.stubEnv("AI_TEXT_PROVIDER", "google");
  vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");
  vi.stubEnv("AI_COOK_CHAT_MODEL", "gemini-3.5-flash");
  vi.stubEnv("AI_VISION_PROVIDER", "google");
  vi.stubEnv("AI_VISION_MODEL", "gemini-2.5-flash");

  resetAuthForTests();
  resetDeploymentCheckForTests(db);

  await client.exec(
    "delete from ai_usage; delete from conversation_logs; delete from cook_reports; delete from doc_recipes; delete from recipe_ideas_cache; delete from kitchen_queue; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec(
    "delete from kitchens where slug <> 'home'; update kitchens set ai_monthly_cap_micros = null where slug = 'home';",
  );

  const a = await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" });
  kitchenA = a.kitchen;
  memberA = a.member;
  userA = a.user;
  const b = await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" });
  kitchenB = b.kitchen;
  userB = b.user;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AI caps across tRPC, webhook, cook plans, refresh, intake, and pantry", () => {
  it("CAP-1: enforces per-kitchen cap through HTTP with data.allowance while leaving other kitchens unaffected", async () => {
    const headersA = await signedInHeaders(userA.id, db);
    const headersB = await signedInHeaders(userB.id, db);
    headersA.set("origin", "https://app.example.com");
    headersB.set("origin", "https://app.example.com");

    // First import call succeeds and settles with known cost; inspect its reservation
    // and set A's cap so this settled cost + a second reservation will exceed it.
    fakeProvider.setDefaultChat(() => ({
      content: JSON.stringify({
        isRecipe: true,
        name: "Quick Dal",
        serves: 4,
        ingredients: [{ item: "red lentils", amount: "1", unit: "cup" }],
        steps: ["Simmer red lentils for 20 minutes."],
      }),
      finishReason: "stop",
      usage: { inputTokens: 1_000, outputTokens: 1_000 },
    }));

    const first = await httpCall<{ result: { data: { success: boolean } } }>(
      "importRecipeFromText",
      { text: "Quick Dal\n1 cup red lentils\nSimmer red lentils for 20 minutes." },
      { method: "POST", headers: headersA },
    );
    expect(first.status).toBe(200);
    expect(first.body.result.data.success).toBe(true);
    expect(fakeProvider.chatCalls).toHaveLength(1);

    const [firstUsage] = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.kitchenId, kitchenA.id));
    expect(firstUsage?.status).toBe("settled");
    const expectedFirstCost = computeCostMicros(
      getModelPrice("gemini-3.5-flash")!,
      { inputTokens: 1_000, outputTokens: 1_000, searchQueries: 0 },
    );
    expect(firstUsage?.costMicros).toBe(expectedFirstCost);

    // Cap A at its exact settled cost so a second call's reservation cannot fit.
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: expectedFirstCost })
      .where(eq(kitchens.id, kitchenA.id));

    // Cap B tightly enough that B's own single reservation fits, but A's spend +
    // B's reservation would NOT fit (catches any missing kitchen_id filter in the sum).
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: firstUsage!.reservedMicros })
      .where(eq(kitchens.id, kitchenB.id));

    const second = await httpCall<HttpTrpcErrorBody>(
      "importRecipeFromText",
      { text: "Quick Dal\n1 cup red lentils\nSimmer red lentils for 20 minutes." },
      { method: "POST", headers: headersA },
    );
    expect(second.status).toBe(429);
    expect(second.body.error.data.code).toBe("TOO_MANY_REQUESTS");
    expect(second.body.error.message).toMatch(
      /^This kitchen's AI allowance for this month is used up\. It resets on \d+ [A-Z][a-z]+\. Cooking from saved plans still works\.$/,
    );
    expect(second.body.error.data.allowance).toEqual({
      scope: "kitchen",
      resetsAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/),
    });
    // Provider was not called for the refused request.
    expect(fakeProvider.chatCalls).toHaveLength(1);

    // Kitchen B's call still succeeds.
    const callB = await httpCall<{ result: { data: { success: boolean } } }>(
      "importRecipeFromText",
      { text: "Quick Dal\n1 cup red lentils\nSimmer red lentils for 20 minutes." },
      { method: "POST", headers: headersB },
    );
    expect(callB.status).toBe(200);
    expect(callB.body.result.data.success).toBe(true);
    expect(fakeProvider.chatCalls).toHaveLength(2);
  });

  it("CAP-2: overall cap refuses both kitchens, logs [ai-cap] overall monthly cap reached, and meters importRecipeFromImage", async () => {
    const headersA = await signedInHeaders(userA.id, db);
    const headersB = await signedInHeaders(userB.id, db);
    headersA.set("origin", "https://app.example.com");
    headersB.set("origin", "https://app.example.com");

    // 1. Vision import is metered with reported usage.
    fakeProvider.onNextVision(() => ({
      content: JSON.stringify({
        isRecipe: true,
        name: "Photo Soup",
        serves: 2,
        ingredients: [{ item: "carrots", amount: "3" }],
        steps: ["Simmer the carrots until tender."],
      }),
      usage: { inputTokens: 1_200, outputTokens: 300 },
    }));

    const visionRes = await httpCall<{ result: { data: { success: boolean } } }>(
      "importRecipeFromImage",
      { imageBase64: "data:image/jpeg;base64,aGVsbG8=" },
      { method: "POST", headers: headersA },
    );
    expect(visionRes.status).toBe(200);
    expect(visionRes.body.result.data.success).toBe(true);

    const [visionRow] = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.feature, "import-photo"));
    expect(visionRow).toMatchObject({
      kitchenId: kitchenA.id,
      memberId: memberA.id,
      status: "settled",
      inputTokens: 1_200,
      outputTokens: 300,
      costMicros: computeCostMicros(getModelPrice("gemini-2.5-flash")!, {
        inputTokens: 1_200,
        outputTokens: 300,
        searchQueries: 0,
      }),
    });

    // 2. A and B together spend $0.99 against a $1.00 overall cap (with $2 kitchen caps),
    // leaving too little room for either kitchen's next call.
    await db.insert(aiUsage).values([
      {
        kitchenId: kitchenA.id,
        feature: "ask",
        provider: "google",
        model: "gemini-3.5-flash",
        status: "settled",
        reservedMicros: 500_000,
        costMicros: 500_000,
        settledAt: new Date(),
      },
      {
        kitchenId: kitchenB.id,
        feature: "ask",
        provider: "google",
        model: "gemini-3.5-flash",
        status: "settled",
        reservedMicros: 495_000,
        costMicros: 495_000,
        settledAt: new Date(),
      },
    ]);

    vi.stubEnv("SOUS_AI_TOTAL_CAP_USD", "1");
    resetDeploymentCheckForTests(db);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const headers of [headersA, headersB]) {
      const res = await httpCall<HttpTrpcErrorBody>(
        "importRecipeFromText",
        { text: "Soup\n1 carrot\nBoil the carrot until soft." },
        { method: "POST", headers },
      );
      expect(res.status).toBe(429);
      expect(res.body.error.data.code).toBe("TOO_MANY_REQUESTS");
      expect(res.body.error.message).toMatch(
        /^Sous's AI allowance for this month is used up for everyone\. It resets on \d+ [A-Z][a-z]+\. Cooking from saved plans still works\.$/,
      );
      expect(res.body.error.data.allowance?.scope).toBe("overall");
    }

    expect(errSpy).toHaveBeenCalledWith(
      "[ai-cap] overall monthly cap reached",
      expect.objectContaining({ month: expect.stringMatching(/^\d{4}-\d{2}$/) }),
    );
    expect(fakeProvider.chatCalls).toHaveLength(0);
  });

  it("CAP-4: cook plan cap refusal preserves deadline/rejection causes, logs rejections, leaves rows unchanged, and succeeds after raising cap", async () => {
    const meterA = kitchenMeter(kitchenA.id, memberA.id, "cook-plan");
    const resetsAt = new Date("2026-12-01T00:00:00.000Z");

    // 1. AllowanceUsedError arriving right as the derivation deadline fires is NOT rewritten as a timeout.
    vi.useFakeTimers();
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 5_000_000 })
      .where(eq(kitchens.id, kitchenA.id));
    fakeProvider.onNextChat(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new AllowanceUsedError("kitchen", resetsAt));
          }, COOK_PLAN_TIMEOUT_MS + 10);
        }),
    );
    const deadlinePromise = deriveCookPlan(ZUCCHINI_RECIPE, {
      meter: meterA,
    }).catch((err) => err);
    await vi.advanceTimersByTimeAsync(COOK_PLAN_TIMEOUT_MS + 20);
    const deadlineErr = await deadlinePromise;
    expect(isAllowanceUsed(deadlineErr)).toBe(true);
    expect((deadlineErr as Error).message).not.toMatch(/timed out/i);
    vi.useRealTimers();

    // 2. Cap hit on the second call after a rejected first reply:
    // both deriveAndStoreCookPlan and deriveLibraryPlan log the first rejection and rethrow with AllowanceUsedError in cause.
    await client.exec("delete from ai_usage; delete from conversation_logs;");
    const badPlan = {
      tasks: zucchiniRaw().tasks.slice(0, -1), // uncovered step -> triggers re-ask
    };

    // 2a. deriveAndStoreCookPlan
    const queueRowForReask = await seedQueueRow(db, kitchenA.id, {
      recipeData: { name: "Zucchini Wraps", serves: 4, ...ZUCCHINI_RECIPE },
    });
    const beforeReaskRow = await snapshotRow(db, kitchenQueue, queueRowForReask.id);
    fakeProvider.onNextChat(async () => {
      // Lower A's cap to 0 before the re-ask so call 2 hits the real monthly cap.
      await db
        .update(kitchens)
        .set({ aiMonthlyCapMicros: 0 })
        .where(eq(kitchens.id, kitchenA.id));
      return {
        content: JSON.stringify(badPlan),
        finishReason: "stop",
        usage: { inputTokens: 1_000, outputTokens: 200 },
      };
    });
    const storeErr = await deriveAndStoreCookPlan(
      kitchenA.id,
      queueRowForReask.id,
      memberA.id,
    ).catch((e) => e);
    expect(storeErr).toBeInstanceOf(CookPlanDerivationError);
    expect(isAllowanceUsed(storeErr)).toBe(true);
    expect(await snapshotRow(db, kitchenQueue, queueRowForReask.id)).toEqual(
      beforeReaskRow,
    );
    const queueRejectionLogs = await db
      .select()
      .from(conversationLogs)
      .where(
        and(
          eq(conversationLogs.kitchenId, kitchenA.id),
          eq(conversationLogs.sessionId, `cook-plan:${queueRowForReask.id}`),
        ),
      );
    expect(queueRejectionLogs).toHaveLength(1);

    // 2b. deriveLibraryPlan
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 5_000_000 })
      .where(eq(kitchens.id, kitchenA.id));
    fakeProvider.onNextChat(async () => {
      await db
        .update(kitchens)
        .set({ aiMonthlyCapMicros: 0 })
        .where(eq(kitchens.id, kitchenA.id));
      return {
        content: JSON.stringify(badPlan),
        finishReason: "stop",
        usage: { inputTokens: 1_000, outputTokens: 200 },
      };
    });
    const ledger = new CostLedger(2);
    const libErr = await deriveLibraryPlan(
      kitchenA.id,
      "zucchini-wraps",
      ZUCCHINI_RECIPE,
      ledger.meter(),
      kitchenMeter(kitchenA.id, memberA.id, "library-refresh"),
    ).catch((e) => e);
    expect(libErr).toBeInstanceOf(CookPlanDerivationError);
    expect(isAllowanceUsed(libErr)).toBe(true);
    const libRejectionLogs = await db
      .select()
      .from(conversationLogs)
      .where(
        and(
          eq(conversationLogs.kitchenId, kitchenA.id),
          eq(conversationLogs.sessionId, "cook-plan:doc:zucchini-wraps"),
        ),
      );
    expect(libRejectionLogs).toHaveLength(1);

    // 3. Background preparation at cap logs [ai-cap] and stores no plan and no error.
    const bgRow = await seedQueueRow(db, kitchenA.id, {
      recipeData: { name: "Zucchini Wraps", serves: 4, ...ZUCCHINI_RECIPE },
    });
    const beforeBg = await snapshotRow(db, kitchenQueue, bgRow.id);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await prepareQueueItemInBackground(kitchenA.id, bgRow.id);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[ai-cap] cook plan not derived for ${bgRow.id}`),
    );
    warnSpy.mockRestore();

    const afterBg = await snapshotRow(db, kitchenQueue, bgRow.id);
    expect(afterBg?.cookPlan).toBeNull();
    expect(afterBg?.cookPlanError).toBeNull();
    expect(afterBg).toEqual(beforeBg);

    // 4. ensureCookPlan over HTTP answers TOO_MANY_REQUESTS with data.allowance and leaves row byte-for-byte unchanged.
    const headersA = await signedInHeaders(userA.id, db);
    headersA.set("origin", "https://app.example.com");
    const cappedRes = await httpCall<HttpTrpcErrorBody>(
      "ensureCookPlan",
      { queueId: bgRow.id },
      { method: "POST", headers: headersA },
    );
    expect(cappedRes.status).toBe(429);
    expect(cappedRes.body.error.data.code).toBe("TOO_MANY_REQUESTS");
    expect(cappedRes.body.error.data.allowance?.scope).toBe("kitchen");
    expect(await snapshotRow(db, kitchenQueue, bgRow.id)).toEqual(beforeBg);

    // 5. After raising the cap, ensureCookPlan derives and stores the plan.
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 5_000_000 })
      .where(eq(kitchens.id, kitchenA.id));
    fakeProvider.onNextChat(() => ({
      content: JSON.stringify(zucchiniRaw()),
      finishReason: "stop",
      usage: { inputTokens: 1_000, outputTokens: 300 },
    }));
    const okRes = await httpCall<{
      result: { data: { plan: unknown; error: string | null } };
    }>("ensureCookPlan", { queueId: bgRow.id }, { method: "POST", headers: headersA });
    expect(okRes.status).toBe(200);
    expect(okRes.body.result.data.error).toBeNull();
    expect(okRes.body.result.data.plan).not.toBeNull();
    const afterOk = await snapshotRow(db, kitchenQueue, bgRow.id);
    expect(afterOk?.cookPlan).not.toBeNull();
    expect(afterOk?.cookPlanError).toBeNull();
  });

  it("CAP-5: with cap at zero, queueFromPack for a bundled pack recipe succeeds with no model call and copies the stored plan", async () => {
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 0 })
      .where(eq(kitchens.id, kitchenA.id));

    const callerA = callerFor(kitchenA, { id: memberA.id, role: memberA.role });
    const queued = await callerA.queueFromPack({
      packId: "fannie-farmer-1896",
      recipeId: "doughnuts-i",
    });

    expect(fakeProvider.chatCalls).toHaveLength(0);
    expect(fakeProvider.visionCalls).toHaveLength(0);
    expect(scheduled).toHaveLength(0);

    const stored = await snapshotRow(db, kitchenQueue, queued.id);
    expect(stored?.kitchenId).toBe(kitchenA.id);
    expect(stored?.cookPlan).not.toBeNull();
  });

  it("CAP-6: with cap reached, addToKitchenQueue answers TOO_MANY_REQUESTS and webhook answers 429 ai_allowance_used", async () => {
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 0 })
      .where(eq(kitchens.id, kitchenA.id));

    // 1. tRPC addToKitchenQueue
    const headersA = await signedInHeaders(userA.id, db);
    headersA.set("origin", "https://app.example.com");
    const trpcRes = await httpCall<HttpTrpcErrorBody>(
      "addToKitchenQueue",
      { recipeData: TEST_RECIPE_NO_SERVES },
      { method: "POST", headers: headersA },
    );
    expect(trpcRes.status).toBe(429);
    expect(trpcRes.body.error.data.code).toBe("TOO_MANY_REQUESTS");
    expect(trpcRes.body.error.data.allowance?.scope).toBe("kitchen");
    expect(await db.select().from(kitchenQueue)).toHaveLength(0);

    // 2. Webhook POST /api/kitchen-queue
    const tokenA = await mintToken(db, kitchenA.id, "cap6-agent");
    const whRes = await webhookQueuePost(
      new Request("http://localhost:3000/api/kitchen-queue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ recipeData: TEST_RECIPE_NO_SERVES }),
      }),
    );
    expect(whRes.status).toBe(429);
    const whBody = (await whRes.json()) as {
      error: string;
      message: string;
      resetsAt: string;
    };
    expect(whBody).toEqual({
      error: "ai_allowance_used",
      message: expect.stringMatching(
        /^This kitchen's AI allowance for this month is used up\. It resets on \d+ [A-Z][a-z]+\. Cooking from saved plans still works\.$/,
      ),
      resetsAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/),
    });
    expect(await db.select().from(kitchenQueue)).toHaveLength(0);
    expect(fakeProvider.chatCalls).toHaveLength(0);
  });

  it("CAP-11: recipe-library refresh stops at cap without storing the allowance sentence on any doc_recipes row and keeps already-saved rows", async () => {
    connected["recipe-library"] = true;
    const tabs = [
      {
        title: "Mains",
        lines: [],
        nonText: [],
        children: [
          {
            title: "Dish One",
            lines: ["1 cup rice", "Cook the rice in 2 cups water for 15 minutes. Serves 2."],
            nonText: [],
            children: [],
          },
          {
            title: "Dish Two",
            lines: ["1 cup oats", "Simmer the oats in 2 cups milk for 10 minutes. Serves 2."],
            nonText: [],
            children: [],
          },
          {
            title: "Dish Three",
            lines: ["2 eggs", "Scramble the eggs in butter for 3 minutes. Serves 1."],
            nonText: [],
            children: [],
          },
          {
            title: "Dish Four",
            lines: ["1 lb pasta", "Boil the pasta in salted water for 9 minutes. Serves 4."],
            nonText: [],
            children: [],
          },
          {
            title: "Dish Five",
            lines: ["2 potatoes", "Roast the potatoes at 400F for 30 minutes. Serves 2."],
            nonText: [],
            children: [],
          },
          {
            title: "Dish Six",
            lines: ["1 cup beans", "Warm the beans in olive oil for 5 minutes. Serves 2."],
            nonText: [],
            children: [],
          },
        ],
      },
    ];
    mockReadTabs.mockResolvedValue(tabs);

    // Hold the first two extraction calls in flight until worker 3 hits the
    // overall cap inside `extractChunk`. The $0.20 cap fits 2 extraction
    // reservations (~$0.08 each), not 3, so worker 3 immediately hits
    // AllowanceUsedError while 1 & 2 are in flight; after 1 & 2 settle for a
    // tiny actual cost and save their rows, `mapWithConcurrency` must NOT hand
    // out chunks 5 & 6 even though room has freed up again.
    vi.stubEnv("SOUS_AI_TOTAL_CAP_USD", "0.20");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let extractionStarted = 0;
    const releaseFirstTwo: Array<() => void> = [];
    fakeProvider.setDefaultChat(async (opts) => {
      const userPrompt = opts.messages[0]?.content ?? "";
      // Cook plan request vs recipe extraction request
      if (opts.responseSchema) {
        const stepText = userPrompt.includes("rice")
          ? "Cook the rice in 2 cups water for 15 minutes."
          : "Simmer the oats in 2 cups milk for 10 minutes.";
        return {
          content: JSON.stringify({
            tasks: [
              {
                id: "t1",
                text: stepText,
                label: "cook it",
                kind: "cook",
                sourceStep: 0,
                implied: false,
                ingredientIdx: [0],
                needs: [],
                branch: "Main",
              },
            ],
          }),
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      extractionStarted += 1;
      if (extractionStarted <= 2) {
        await new Promise<void>((resolve) => {
          releaseFirstTwo.push(resolve);
        });
      }
      if (userPrompt.includes("Dish One")) {
        return {
          content: JSON.stringify({
            isRecipe: true,
            name: "Dish One",
            serves: 2,
            ingredients: [{ item: "rice", amount: "1", unit: "cup" }],
            steps: ["Cook the rice in 2 cups water for 15 minutes."],
          }),
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      if (userPrompt.includes("Dish Two")) {
        return {
          content: JSON.stringify({
            isRecipe: true,
            name: "Dish Two",
            serves: 2,
            ingredients: [{ item: "oats", amount: "1", unit: "cup" }],
            steps: ["Simmer the oats in 2 cups milk for 10 minutes."],
          }),
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      return {
        content: JSON.stringify({
          isRecipe: true,
          name: "Other Dish",
          serves: 2,
          ingredients: [{ item: "eggs", amount: "2" }],
          steps: ["Cook for 3 minutes."],
        }),
        finishReason: "stop",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    });

    const callerA = callerFor(kitchenA, { id: memberA.id, role: memberA.role });
    const syncOutcome = callerA.syncRecipes().then(
      () => null,
      (err: unknown) => err,
    );

    // Wait deterministically until worker 3 has hit the cap while 1 & 2 are parked.
    await vi.waitFor(() => {
      expect(releaseFirstTwo).toHaveLength(2);
      expect(errSpy).toHaveBeenCalledWith(
        "[ai-cap] overall monthly cap reached",
        expect.anything(),
      );
    });
    for (const go of releaseFirstTwo) go();

    const syncErr = await syncOutcome;
    errSpy.mockRestore();

    expect(syncErr).toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringContaining("AI allowance for this month is used up"),
    });

    const rows = await db
      .select()
      .from(docRecipes)
      .where(eq(docRecipes.kitchenId, kitchenA.id));
    // First two chunks finished and saved; chunks 3..6 were never saved with an error or processed.
    expect(rows.map((r) => r.docSlug).sort()).toEqual(["dish-one", "dish-two"]);
    for (const row of rows) {
      expect(row.extractionError).toBeNull();
      expect(row.cookPlanError).toBeNull();
    }
    // Exactly 4 provider calls (extract + plan for Dish One and Dish Two); no calls for chunks 3..6.
    expect(fakeProvider.chatCalls).toHaveLength(4);
  });

  it("CAP-12: intake at cap leaves row unchanged across repeated background tries, answers TOO_MANY_REQUESTS on opening, preserves cap over timeout, and cuts after cap is raised", async () => {
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 0 })
      .where(eq(kitchens.id, kitchenA.id));

    const row = await seedQueueRow(db, kitchenA.id, {
      recipeData: INTAKE_RECIPE,
      intakeSourceHash: sourceHash("kitchen_queue", INTAKE_RECIPE),
    });
    const before = await snapshotRow(db, kitchenQueue, row.id);

    // 1. Three background runs in a row: each logs [ai-cap] and leaves intake_error,
    // intake_stamp, and intake_attempts untouched (INTAKE_MAX_TRIES is never reached).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      const res = await ensureIntakeForCook(kitchenA.id, row.id, "background");
      expect(res.intake.state).toBe("pending");
    }
    expect(
      warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes(`[ai-cap] intake not run for ${row.id}`),
      ),
    ).toHaveLength(3);

    // Running prepareQueueItemInBackground at cap logs only [ai-cap], not "not cut yet, tries again on open".
    warnSpy.mockClear();
    await prepareQueueItemInBackground(kitchenA.id, row.id);
    const bgWarns = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(
      bgWarns.some((line) =>
        line.includes(`[ai-cap] intake not run for ${row.id}`),
      ),
    ).toBe(true);
    expect(
      bgWarns.some((line) => line.includes("not cut yet, tries again on open")),
    ).toBe(false);
    warnSpy.mockRestore();

    const afterBg = await snapshotRow(db, kitchenQueue, row.id);
    expect(afterBg?.intakeError).toBeNull();
    expect(afterBg?.intakeStamp).toBeNull();
    expect(afterBg?.intakeAttempts).toBeNull();
    expect(afterBg).toEqual(before);

    // 2. "opening" ask over HTTP answers TOO_MANY_REQUESTS and leaves row pending (not settled as openedBeforeCut).
    const headersA = await signedInHeaders(userA.id, db);
    headersA.set("origin", "https://app.example.com");
    const openRes = await httpCall<HttpTrpcErrorBody>(
      "ensureIntake",
      { queueId: row.id, ask: "opening" },
      { method: "POST", headers: headersA },
    );
    expect(openRes.status).toBe(429);
    expect(openRes.body.error.data.code).toBe("TOO_MANY_REQUESTS");
    expect(openRes.body.error.data.allowance?.scope).toBe("kitchen");
    expect(await snapshotRow(db, kitchenQueue, row.id)).toEqual(before);

    // 3. Cap refusal arriving as intake's deadline fires is still treated as the cap, not stored as a timeout.
    vi.useFakeTimers();
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 5_000_000 })
      .where(eq(kitchens.id, kitchenA.id));
    fakeProvider.onNextChat(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(
              new AllowanceUsedError(
                "kitchen",
                new Date("2026-12-01T00:00:00.000Z"),
              ),
            );
          }, INTAKE_TIMEOUT_MS + 10);
        }),
    );
    const intakeDeadlinePromise = runIntake(INTAKE_RECIPE, {
      meter: kitchenMeter(kitchenA.id, null, "intake"),
    }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(INTAKE_TIMEOUT_MS + 20);
    const intakeDeadlineErr = await intakeDeadlinePromise;
    expect(isAllowanceUsed(intakeDeadlineErr)).toBe(true);
    vi.useRealTimers();

    // 4. After raising the cap, a background run cuts the recipe.
    fakeProvider.onNextChat(() => ({
      content: JSON.stringify({
        isRecipe: true,
        ...INTAKE_RECIPE,
        stepIngredients: [[0, 1, 2, 3], [4], [5], [], [6]],
      }),
      finishReason: "stop",
      usage: { inputTokens: 800, outputTokens: 200 },
    }));
    const cutRes = await ensureIntakeForCook(kitchenA.id, row.id, "background");
    expect(cutRes.intake.state).toBe("normalized");
    expect(cutRes.item.intakeRecipe).not.toBeNull();
    expect(cutRes.item.intakeError).toBeNull();
  });

  it("CAP-15: AllowanceUsedError and UnpricedModelError pass sent: false to usage hooks and release CostLedger reservations with zero phantom cost", async () => {
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 0 })
      .where(eq(kitchens.id, kitchenA.id));

    // 1. Cook-plan derivation with AllowanceUsedError: CostLedger releases pending bounds and keeps calls/tokens at 0.
    const ledger = new CostLedger(0.2);
    const initialCommitted = ledger.committedUsd;
    const seenDeriveUsage: Array<{ sent?: false }> = [];
    const deriveMeter = {
      beforeCall: (bound: Parameters<CostLedger["beforeCall"]>[0]) =>
        ledger.beforeCall(bound),
      onUsage: (usage: Parameters<CostLedger["record"]>[0]) => {
        seenDeriveUsage.push({ sent: usage.sent });
        ledger.record(usage);
      },
    };
    await expect(
      deriveCookPlan(ZUCCHINI_RECIPE, {
        ...deriveMeter,
        meter: kitchenMeter(kitchenA.id, null, "cook-plan"),
      }),
    ).rejects.toBeInstanceOf(AllowanceUsedError);
    expect(seenDeriveUsage).toEqual([{ sent: false }]);
    expect(ledger.calls).toBe(0);
    expect(ledger.inputTokens).toBe(0);
    expect(ledger.outputTokens).toBe(0);
    expect(ledger.committedUsd).toBe(initialCommitted);

    // 2. Cook-plan derivation with UnpricedModelError: same release with sent: false.
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 5_000_000 })
      .where(eq(kitchens.id, kitchenA.id));
    vi.stubEnv("AI_TEXT_MODEL", "unpriced-test-model");
    const seenUnpriced: Array<{ sent?: false }> = [];
    await expect(
      deriveCookPlan(ZUCCHINI_RECIPE, {
        beforeCall: (b) => ledger.beforeCall(b),
        onUsage: (u) => {
          seenUnpriced.push({ sent: u.sent });
          ledger.record(u);
        },
        meter: kitchenMeter(kitchenA.id, null, "cook-plan"),
      }),
    ).rejects.toBeInstanceOf(UnpricedModelError);
    expect(seenUnpriced).toEqual([{ sent: false }]);
    expect(ledger.calls).toBe(0);
    expect(ledger.committedUsd).toBe(0);
    // Room is unchanged for the next beforeCall.
    expect(ledger.beforeCall({ inputTokens: 10_000, outputTokens: 10_000 })).toBe(
      true,
    );

    // 3. askChat (via extractRecipeFromText) with AllowanceUsedError and UnpricedModelError passes sent: false.
    const extractionUsages: ExtractionUsage[] = [];
    await expect(
      extractRecipeFromText("Toast\n1 slice bread\nToast it.", {
        meter: kitchenMeter(kitchenA.id, null, "import-text"),
        onUsage: (u) => extractionUsages.push(u),
      }),
    ).rejects.toBeInstanceOf(UnpricedModelError);

    // 4. ensureIntakeForCook with an unpriced model skips unsent calls in its logged tally (0 calls).
    const unpricedIntakeRow = await seedQueueRow(db, kitchenA.id, {
      recipeData: INTAKE_RECIPE,
      intakeSourceHash: sourceHash("kitchen_queue", INTAKE_RECIPE),
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await ensureIntakeForCook(kitchenA.id, unpricedIntakeRow.id, "background");
    const intakeLogs = infoSpy.mock.calls.map((call) => String(call[0]));
    expect(
      intakeLogs.some(
        (line) =>
          line.includes(`[intake] ${unpricedIntakeRow.id}:`) &&
          line.includes("0 call(s), 0 input + 0 output tokens"),
      ),
    ).toBe(true);
    infoSpy.mockRestore();

    vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 0 })
      .where(eq(kitchens.id, kitchenA.id));
    await expect(
      extractRecipeFromText("Toast\n1 slice bread\nToast it.", {
        meter: kitchenMeter(kitchenA.id, null, "import-text"),
        onUsage: (u) => extractionUsages.push(u),
      }),
    ).rejects.toBeInstanceOf(AllowanceUsedError);

    expect(extractionUsages.map((u) => u.sent)).toEqual([false, false]);
  });

  it("records the calling member and procedure feature on ai_usage rows across every metered tRPC procedure", async () => {
    connected["recipe-library"] = true;
    mockReadTabs.mockResolvedValue([
      {
        title: "Mains",
        lines: [],
        nonText: [],
        children: [
          {
            title: "Simple Rice",
            lines: [
              "1 cup rice",
              "Cook the rice in 2 cups water for 15 minutes. Serves 2.",
            ],
            nonText: [],
            children: [],
          },
        ],
      },
    ]);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        "<html><body><h1>Simple Toast</h1><p>Ingredients: 1 slice bread. Steps: Toast the bread in a toaster for 2 minutes until golden brown. Serves 1.</p></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    );
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const planRow = await seedQueueRow(db, kitchenA.id, {
      recipeData: INTAKE_RECIPE,
    });
    const intakeRow = await seedQueueRow(db, kitchenA.id, {
      recipeData: INTAKE_RECIPE,
      intakeSourceHash: sourceHash("kitchen_queue", INTAKE_RECIPE),
    });

    const caller = callerFor(kitchenA, { id: memberA.id, role: memberA.role });

    // 1. Ask (chatCooking)
    fakeProvider.onNextChat(() => ({
      content: "Simmer gently for 10 minutes.",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 20 },
    }));
    const askRes = await caller.chatCooking({
      sessionId: "member-feature-ask",
      messages: [{ role: "user", content: "How long should it simmer?" }],
    });
    expect(askRes.content).toContain("Simmer gently");

    // 2. addToKitchenQueue (no serves -> serves-estimate)
    fakeProvider.onNextChat(() => ({
      content: JSON.stringify({
        basis: "2 cans white beans with garlic: about 4 portions.",
        serves: 4,
      }),
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 20 },
    }));
    const queued = await caller.addToKitchenQueue({
      recipeData: TEST_RECIPE_NO_SERVES,
    });
    expect(queued.id).toBeTruthy();

    // 3. importRecipeFromText
    fakeProvider.onNextChat(() => ({
      content: JSON.stringify({
        name: "Simple Toast",
        serves: 1,
        ingredients: [{ item: "bread", amount: "1", unit: "slice" }],
        steps: ["Toast the bread for 2 minutes."],
      }),
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 40 },
    }));
    const textImport = await caller.importRecipeFromText({
      text: "Simple Toast\n1 slice bread\nToast the bread for 2 minutes. Serves 1.",
    });
    expect(textImport.success).toBe(true);

    // 4. importRecipeFromUrl
    fakeProvider.onNextChat(() => ({
      content: JSON.stringify({
        name: "Simple Toast",
        serves: 1,
        ingredients: [{ item: "bread", amount: "1", unit: "slice" }],
        steps: ["Toast the bread in a toaster for 2 minutes until golden brown."],
      }),
      finishReason: "stop",
      usage: { inputTokens: 120, outputTokens: 40 },
    }));
    const urlImport = await caller.importRecipeFromUrl({
      url: "https://example.com/simple-toast",
    });
    expect(urlImport.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();

    // 5. ensureCookPlan
    fakeProvider.onNextChat(() => ({
      content: JSON.stringify(zucchiniRaw()),
      finishReason: "stop",
      usage: { inputTokens: 200, outputTokens: 150 },
    }));
    const planRes = await caller.ensureCookPlan({ queueId: planRow.id });
    expect(planRes.plan).not.toBeNull();

    // 6. ensureIntake
    fakeProvider.onNextChat(() => ({
      content: JSON.stringify({
        isRecipe: true,
        ...INTAKE_RECIPE,
        stepIngredients: [[0, 1, 2, 3], [4], [5], [], [6]],
      }),
      finishReason: "stop",
      usage: { inputTokens: 200, outputTokens: 120 },
    }));
    const intakeRes = await caller.ensureIntake({
      queueId: intakeRow.id,
      ask: "opening",
    });
    expect(intakeRes.intake.state).toBe("normalized");

    // 7. syncRecipes (extraction + cook plan, both metered as library-refresh)
    fakeProvider.onNextChat(() => ({
      content: JSON.stringify({
        isRecipe: true,
        name: "Simple Rice",
        serves: 2,
        ingredients: [{ item: "rice", amount: "1", unit: "cup" }],
        steps: ["Cook the rice in 2 cups water for 15 minutes."],
      }),
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50 },
    }));
    fakeProvider.onNextChat(() => ({
      content: JSON.stringify({
        tasks: [
          {
            id: "t1",
            text: "Cook the rice in 2 cups water for 15 minutes.",
            label: "cook rice",
            kind: "cook",
            sourceStep: 0,
            implied: false,
            ingredientIdx: [0],
            needs: [],
            branch: "Main",
          },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50 },
    }));
    const syncRes = await caller.syncRecipes();
    expect(syncRes.succeeded).toBe(1);
    infoSpy.mockRestore();

    const rows = await db
      .select({
        kitchenId: aiUsage.kitchenId,
        memberId: aiUsage.memberId,
        feature: aiUsage.feature,
      })
      .from(aiUsage);

    expect(rows.map((r) => r.feature).sort()).toEqual([
      "ask",
      "cook-plan",
      "import-text",
      "import-url",
      "intake",
      "library-refresh",
      "library-refresh",
      "serves-estimate",
    ]);
    expect(rows.every((r) => r.kitchenId === kitchenA.id)).toBe(true);
    expect(rows.every((r) => r.memberId === memberA.id)).toBe(true);
  });

  it("pantry reconciliation and grocery parsing rethrow AllowanceUsedError as TOO_MANY_REQUESTS", async () => {
    connected.pantry = true;
    mockPantryReadSections.mockResolvedValue([
      { heading: "fridge", rawHeading: "Fridge", items: ["2 avocados"] },
    ]);
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 0 })
      .where(eq(kitchens.id, kitchenA.id));

    const row = await seedQueueRow(db, kitchenA.id, {
      recipeData: {
        name: "Guacamole",
        serves: 2,
        ingredients: [{ item: "avocados", amount: "2" }],
        steps: ["Mash the avocados."],
      },
    });

    const callerA = callerFor(kitchenA, { id: memberA.id, role: memberA.role });
    await expect(
      callerA.getRecipePantryReconciliation({ queueId: row.id }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringContaining("AI allowance for this month is used up"),
    });

    await expect(
      callerA.parseGroceryInput({ type: "text", content: "2 avocados" }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringContaining("AI allowance for this month is used up"),
    });

    await expect(
      callerA.parseGroceryInput({ type: "image", content: "data:image/jpeg;base64,aGVsbG8=" }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringContaining("AI allowance for this month is used up"),
    });
  });

  describe("ASKCAP-1: Ask at the AI cap writes nothing to conversation_logs", () => {
    it("refuses with 429 TOO_MANY_REQUESTS for a kitchen at cap without calling the provider or logging the question", async () => {
      await db
        .update(kitchens)
        .set({ aiMonthlyCapMicros: 0 })
        .where(eq(kitchens.id, kitchenA.id));

      const headersA = await signedInHeaders(userA.id, db);
      headersA.set("origin", "https://app.example.com");

      const res = await httpCall<HttpTrpcErrorBody>(
        "chatCooking",
        {
          sessionId: "askcap-1-capped",
          messages: [
            { role: "user", content: "Can I swap shallots for yellow onion?" },
          ],
        },
        { method: "POST", headers: headersA },
      );

      expect(res.status).toBe(429);
      expect(res.body.error.data.code).toBe("TOO_MANY_REQUESTS");
      expect(res.body.error.data.allowance?.scope).toBe("kitchen");
      expect(fakeProvider.chatCalls).toHaveLength(0);

      const rows = await db
        .select()
        .from(conversationLogs)
        .where(eq(conversationLogs.kitchenId, kitchenA.id));
      expect(rows).toEqual([]);
    });

    it("stores the user question and then the assistant answer when the cap allows the call", async () => {
      await client.exec("SET TIME ZONE 'America/Los_Angeles'");
      try {
        await db
          .update(kitchens)
          .set({ aiMonthlyCapMicros: null })
          .where(eq(kitchens.id, kitchenA.id));

        const headersA = await signedInHeaders(userA.id, db);
        headersA.set("origin", "https://app.example.com");

        const sessionId = "askcap-1-allowed";
        const question = "How long should the lentils simmer?";
        const answer = "Simmer the lentils gently for twenty minutes.";

        let replyAt: Date | undefined;
        fakeProvider.onNextChat(() => {
          const startedAt = Date.now();
          while (Date.now() <= startedAt) {
            // Wait until the clock moves on by at least one millisecond.
          }
          replyAt = new Date();
          return {
            content: answer,
            finishReason: "stop",
            usage: { inputTokens: 120, outputTokens: 24 },
          };
        });

        const res = await httpCall<{ result: { data: { content: string } } }>(
          "chatCooking",
          {
            sessionId,
            messages: [{ role: "user", content: question }],
          },
          { method: "POST", headers: headersA },
        );

        expect(res.status).toBe(200);
        expect(res.body.result.data.content).toBe(answer);
        expect(replyAt).toBeInstanceOf(Date);

        // conversation_logs.created_at is a timestamp without time zone written
        // in the database session's time zone; cast to timestamptz in SQL so
        // epoch milliseconds match UTC instants such as replyAt in any time zone.
        const rows = await db
          .select({
            role: conversationLogs.role,
            content: conversationLogs.content,
            createdAtMs: sql<number>`(extract(epoch from ${conversationLogs.createdAt}::timestamptz) * 1000)::double precision`,
          })
          .from(conversationLogs)
          .where(
            and(
              eq(conversationLogs.kitchenId, kitchenA.id),
              eq(conversationLogs.sessionId, sessionId),
            ),
          );
        expect(rows).toHaveLength(2);

        const userRow = rows.find((r) => r.role === "user");
        const assistantRow = rows.find((r) => r.role === "assistant");
        expect(userRow?.content).toBe(question);
        expect(assistantRow?.content).toBe(answer);
        expect(userRow!.createdAtMs).toBeLessThan(replyAt!.getTime());
        expect(assistantRow!.createdAtMs).toBeGreaterThanOrEqual(
          userRow!.createdAtMs,
        );
      } finally {
        await client.exec("RESET TIME ZONE");
      }
    });

    it("stores the user question and no assistant answer when the provider throws another error", async () => {
      const headersA = await signedInHeaders(userA.id, db);
      headersA.set("origin", "https://app.example.com");

      const sessionId = "askcap-1-provider-error";
      const question = "Should I cover the pot while braising?";

      fakeProvider.onNextChat(() => {
        throw new Error("provider unavailable");
      });

      const res = await httpCall<HttpTrpcErrorBody>(
        "chatCooking",
        {
          sessionId,
          messages: [{ role: "user", content: question }],
        },
        { method: "POST", headers: headersA },
      );

      expect(res.status).not.toBe(429);
      expect(res.status).toBe(500);
      expect(res.body.error.data.code).toBe("INTERNAL_SERVER_ERROR");

      const rows = await db
        .select()
        .from(conversationLogs)
        .where(
          and(
            eq(conversationLogs.kitchenId, kitchenA.id),
            eq(conversationLogs.sessionId, sessionId),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe("user");
      expect(rows[0]?.content).toBe(question);
    });

    it("returns the provider error and logs when storing the question fails after a provider error", async () => {
      const headersA = await signedInHeaders(userA.id, db);
      headersA.set("origin", "https://app.example.com");

      const sessionId = "askcap-1-log-write-fails";
      const question = "Can I substitute lime juice for vinegar?";
      const providerErrorMessage = "upstream provider failed: distinctive-askcap1";
      const constraintName = "askcap1_refuse_question_insert";

      fakeProvider.onNextChat(() => {
        throw new Error(providerErrorMessage);
      });

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await client.exec(
        `ALTER TABLE conversation_logs ADD CONSTRAINT ${constraintName} CHECK (content <> '${question}')`,
      );

      try {
        const res = await httpCall<HttpTrpcErrorBody>(
          "chatCooking",
          {
            sessionId,
            messages: [{ role: "user", content: question }],
          },
          { method: "POST", headers: headersA },
        );

        expect(res.status).toBe(500);
        expect(res.body.error.data.code).toBe("INTERNAL_SERVER_ERROR");
        expect(res.body.error.message).toBe(providerErrorMessage);
        expect(JSON.stringify(res.body)).not.toContain(constraintName);

        expect(errSpy).toHaveBeenCalledWith(
          expect.stringContaining("could not store the question"),
          expect.anything(),
        );

        const rows = await db
          .select()
          .from(conversationLogs)
          .where(
            and(
              eq(conversationLogs.kitchenId, kitchenA.id),
              eq(conversationLogs.sessionId, sessionId),
            ),
          );
        expect(rows).toEqual([]);
      } finally {
        errSpy.mockRestore();
        await client.exec(
          `ALTER TABLE conversation_logs DROP CONSTRAINT IF EXISTS ${constraintName}`,
        );
      }
    });
  });
});
