/**
 * The library's stored cook plans (slice P) against a real Postgres (PGlite,
 * in memory): reuse or derive per row, the guarded write under the sync's
 * advisory lock, and the check-only status. Only the model call is mocked;
 * derivation, validation and hashing are real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { chat } from "./ai";
import type { RecipeForPlan } from "./kitchen/cook-plan";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE, zucchiniRaw } from "./kitchen/__tests__/zucchini-wraps";

vi.mock("./ai", () => ({ chat: vi.fn() }));

vi.mock("@/lib/db", async () =>
  (await import("./__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "./db";
import { conversationLogs, db, docRecipes } from "./db";
import { homeKitchen } from "./__tests__/kitchens";
import { cookPlanStamp, planSourceHash } from "./kitchen/cook-plan-stamp";
import { CostLedger, callCostUsd } from "./cook-plan-cost";
import { docRecipeToQueueData } from "./recipe-sync";
import {
  NO_PLAN,
  REFRESH_MAX_USD,
  REFRESH_PLAN_BUDGET_MS,
  auditLibraryPlans,
  describeValidRate,
  libraryPlanReport,
  libraryPlanStatus,
  libraryRecipeForPlan,
  libraryRecipeLockKey,
  planBudget,
  planForChunk,
  readLibraryPlanRows,
  readLibraryPlansForAudit,
  readSavedPlan,
  storeLibraryPlan,
  type LibraryPlanRow,
  type PlanBudget,
  type SavedPlan,
} from "./library-cook-plans";

const client = (dbModule as unknown as { client: PGlite }).client;
const mockChat = chat as Mock;
let homeId: string;

beforeEach(async () => {
  mockChat.mockReset();
  await client.exec("delete from doc_recipes; delete from conversation_logs");
  homeId = (await homeKitchen(db)).id;
});

const OPEN: PlanBudget = { start: () => new CostLedger(Infinity).meter() };
const SPENT: PlanBudget = { start: () => null };
const HASH = planSourceHash(ZUCCHINI_RECIPE);

function replyPlan() {
  mockChat.mockResolvedValueOnce({ content: JSON.stringify(zucchiniRaw()), finishReason: "stop" });
}

/** A plan that leaves step 4 uncited: the validator refuses it. */
function replyUncovered() {
  const broken = zucchiniRaw();
  broken.tasks = broken.tasks.filter((t) => t.sourceStep !== 4).map((t) => ({ ...t, needs: [] }));
  mockChat.mockResolvedValueOnce({ content: JSON.stringify(broken), finishReason: "stop" });
}

function saved(over: Partial<SavedPlan> = {}): SavedPlan {
  return {
    cookPlan: ZUCCHINI_PLAN,
    cookPlanError: null,
    cookPlanSourceHash: HASH,
    cookPlanStamp: cookPlanStamp(),
    ...over,
  };
}

/** The recipe with one step reworded: the same text could extract this way too. */
const REWORDED: RecipeForPlan = {
  ...ZUCCHINI_RECIPE,
  steps: ZUCCHINI_RECIPE.steps!.map((s, i) => (i === 1 ? `${s} Taste for salt.` : s)),
};

async function insertRow(docSlug: string, over: Partial<typeof docRecipes.$inferInsert> = {}) {
  await db.insert(docRecipes).values({
    kitchenId: homeId,
    docSlug,
    name: docSlug,
    rawDocText: docSlug,
    ingredients: ZUCCHINI_RECIPE.ingredients,
    steps: ZUCCHINI_RECIPE.steps,
    stepIngredients: ZUCCHINI_RECIPE.stepIngredients,
    ...over,
  });
}

async function planColumns(docSlug: string) {
  const [row] = await db
    .select({
      cookPlan: docRecipes.cookPlan,
      cookPlanError: docRecipes.cookPlanError,
      cookPlanSourceHash: docRecipes.cookPlanSourceHash,
      cookPlanStamp: docRecipes.cookPlanStamp,
    })
    .from(docRecipes)
    .where(eq(docRecipes.docSlug, docSlug));
  return row;
}

describe("the derive input of a library row", () => {
  it("hashes the same after a round trip through the table as the extraction did", async () => {
    await insertRow("zucchini-wraps");
    const [row] = await db.select().from(docRecipes);
    expect(planSourceHash(libraryRecipeForPlan(row!))).toBe(HASH);
    // And as the queue snapshot it would be copied into.
    expect(planSourceHash(docRecipeToQueueData(row!))).toBe(HASH);
  });
});

describe("planBudget", () => {
  it("allows derivations until the budget has run, on the clock it is given", () => {
    let now = 1_000;
    const budget = planBudget(REFRESH_PLAN_BUDGET_MS, () => now);
    expect(budget.start()).not.toBeNull();
    now += REFRESH_PLAN_BUDGET_MS - 1;
    expect(budget.start()).not.toBeNull();
    now += 1;
    expect(budget.start()).toBeNull();
  });

  it("is 200 s, under the route's 300 s limit, and $0.50", () => {
    expect(REFRESH_PLAN_BUDGET_MS).toBe(200_000);
    expect(REFRESH_MAX_USD).toBe(0.5);
  });

  it("a budget of 0 starts nothing", () => {
    expect(planBudget(0).start()).toBeNull();
  });

  it("meters every derivation it starts on one ledger, capped at its dollars", async () => {
    // A provider that bills each call its whole bound: the cap's worst case.
    mockChat.mockImplementation(async (args: { maxTokens: number }) => ({
      content: JSON.stringify(zucchiniRaw()),
      finishReason: "stop",
      usage: { inputTokens: 12_000, outputTokens: args.maxTokens },
    }));
    const ledger = new CostLedger(REFRESH_MAX_USD);
    const budget = planBudget(REFRESH_PLAN_BUDGET_MS, Date.now, ledger);
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push((await planForChunk(homeId, `r${i}`, ZUCCHINI_RECIPE, undefined, budget)).outcome);
    }
    // About $0.09 a call billed at its bound: five fit under $0.50, the rest wait.
    expect(outcomes.filter((o) => o === "derived").length).toBe(5);
    expect(outcomes.slice(5)).toEqual(Array(5).fill("pending"));
    expect(ledger.spentUsd).toBeLessThanOrEqual(REFRESH_MAX_USD);
  });
});

describe("planForChunk", () => {
  it("plans nothing for a recipe with no steps, with no call", async () => {
    const plan = await planForChunk(homeId, "x", { ingredients: [], steps: [] }, undefined, OPEN);
    expect(plan).toEqual({ outcome: "none", columns: NO_PLAN });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("derives a new recipe's plan, stamped with its derive input", async () => {
    replyPlan();
    const plan = await planForChunk(homeId, "zucchini-wraps", ZUCCHINI_RECIPE, undefined, OPEN);
    expect(plan).toEqual({
      outcome: "derived",
      columns: { cookPlan: ZUCCHINI_PLAN, cookPlanError: null, cookPlanSourceHash: HASH, cookPlanStamp: cookPlanStamp() },
    });
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("reuses a saved plan when the derive input and stamp are unchanged: zero calls", async () => {
    const plan = await planForChunk(homeId, "zucchini-wraps", ZUCCHINI_RECIPE, saved(), SPENT);
    expect(plan.outcome).toBe("reused");
    expect(plan.columns.cookPlan).toEqual(ZUCCHINI_PLAN);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("re-derives when the same text extracts as different steps (hash)", async () => {
    replyPlan();
    const plan = await planForChunk(homeId, "zucchini-wraps", REWORDED, saved(), OPEN);
    expect(plan.outcome).toBe("derived");
    expect(plan.columns.cookPlanSourceHash).toBe(planSourceHash(REWORDED));
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("re-derives a plan from an older prompt or version (stamp)", async () => {
    replyPlan();
    const plan = await planForChunk(homeId, "zucchini-wraps", ZUCCHINI_RECIPE, saved({ cookPlanStamp: "3:0000" }), OPEN);
    expect(plan.outcome).toBe("derived");
    expect(plan.columns.cookPlanStamp).toBe(cookPlanStamp());
  });

  it("re-derives a stored plan that no longer validates, though hash and stamp match", async () => {
    replyPlan();
    const corrupt = { ...ZUCCHINI_PLAN, tasks: ZUCCHINI_PLAN.tasks.slice(1) };
    const plan = await planForChunk(homeId, "zucchini-wraps", ZUCCHINI_RECIPE, saved({ cookPlan: corrupt }), OPEN);
    expect(plan.outcome).toBe("derived");
    expect(plan.columns.cookPlan).toEqual(ZUCCHINI_PLAN);
  });

  it("keeps a settled error on a same-hash Refresh, with no call", async () => {
    const error = "rejected (uncovered-step): step 4 is carried by no task";
    const plan = await planForChunk(
      homeId,
      "zucchini-wraps",
      ZUCCHINI_RECIPE,
      saved({ cookPlan: null, cookPlanError: error }),
      OPEN,
    );
    expect(plan).toEqual({
      outcome: "reused",
      columns: { cookPlan: null, cookPlanError: error, cookPlanSourceHash: HASH, cookPlanStamp: cookPlanStamp() },
    });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("retries a settled error once the recipe's text changes", async () => {
    replyPlan();
    const plan = await planForChunk(
      homeId,
      "zucchini-wraps",
      REWORDED,
      saved({ cookPlan: null, cookPlanError: "rejected (cycle): a needs b needs a" }),
      OPEN,
    );
    expect(plan.outcome).toBe("derived");
  });

  it("retries a transient error once on the next Refresh", async () => {
    replyPlan();
    const plan = await planForChunk(
      homeId,
      "zucchini-wraps",
      ZUCCHINI_RECIPE,
      saved({ cookPlan: null, cookPlanError: "Cook plan derivation timed out after 45 s" }),
      OPEN,
    );
    expect(plan.outcome).toBe("derived");
    expect(plan.columns.cookPlan).toEqual(ZUCCHINI_PLAN);
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("starts no derivation once the budget is spent: pending, no plan, the old one cleared", async () => {
    const plan = await planForChunk(homeId, "zucchini-wraps", REWORDED, saved(), SPENT);
    expect(plan).toEqual({ outcome: "pending", columns: NO_PLAN });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("stores a refusal as a settled error with its hash and stamp, logging each reply", async () => {
    replyUncovered();
    replyUncovered();
    const plan = await planForChunk(homeId, "zucchini-wraps", ZUCCHINI_RECIPE, undefined, OPEN);
    expect(plan.outcome).toBe("derived");
    expect(plan.columns.cookPlan).toBeNull();
    expect(plan.columns.cookPlanError).toMatch(/^rejected \(uncovered-step\)/);
    expect(plan.columns.cookPlanSourceHash).toBe(HASH);
    const logs = await db.select().from(conversationLogs);
    expect(logs.map((l) => l.sessionId)).toEqual(["cook-plan:doc:zucchini-wraps", "cook-plan:doc:zucchini-wraps"]);
  });

  it("stores a provider error as a transient error, never throwing", async () => {
    mockChat.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const plan = await planForChunk(homeId, "zucchini-wraps", ZUCCHINI_RECIPE, undefined, OPEN);
    expect(plan.columns).toEqual({
      cookPlan: null,
      cookPlanError: "429 Too Many Requests",
      cookPlanSourceHash: HASH,
      cookPlanStamp: cookPlanStamp(),
    });
  });

  it("charges each call's tokens to the run's ledger", async () => {
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify(zucchiniRaw()),
      finishReason: "stop",
      usage: { inputTokens: 3300, outputTokens: 1000 },
    });
    const ledger = new CostLedger(1);
    await planForChunk(homeId, "zucchini-wraps", ZUCCHINI_RECIPE, undefined, { start: () => ledger.meter() });
    expect(ledger.calls).toBe(1);
    expect(ledger.spentUsd).toBeCloseTo(callCostUsd(3300, 1000));
  });

  it("leaves a recipe the cap stops pending, clearing the old plan, with nothing stored as an error", async () => {
    mockChat.mockResolvedValueOnce({ content: '{"tasks": [', finishReason: "max_tokens" });
    // Room for the first call's bound, not for the truncation retry's.
    const ledger = new CostLedger(callCostUsd(15_000, 10_000));
    const plan = await planForChunk(homeId, "zucchini-wraps", REWORDED, saved(), { start: () => ledger.meter() });
    expect(plan).toEqual({ outcome: "pending", columns: NO_PLAN });
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(ledger.refused).toBe(1);
  });
});

describe("readSavedPlan", () => {
  it("reads a row that extracted, and nothing for one that failed", async () => {
    await insertRow("ok", { cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: "s" });
    await insertRow("failed", { extractionError: "no recipe here", steps: null });
    expect(await readSavedPlan(homeId, "ok")).toEqual({
      cookPlan: ZUCCHINI_PLAN,
      cookPlanError: null,
      cookPlanSourceHash: HASH,
      cookPlanStamp: "s",
    });
    expect(await readSavedPlan(homeId, "failed")).toBeUndefined();
    expect(await readSavedPlan(homeId, "absent")).toBeUndefined();
  });
});

describe("libraryRecipeLockKey", () => {
  it("gives different keys for two kitchens with the same slug and the same key for the same kitchen and slug", () => {
    const kitchenA = "00000000-0000-4000-8000-000000000001";
    const kitchenB = "00000000-0000-4000-8000-000000000002";
    expect(libraryRecipeLockKey(kitchenA, "zucchini-wraps")).toBe(
      libraryRecipeLockKey(kitchenA, "zucchini-wraps"),
    );
    expect(libraryRecipeLockKey(kitchenA, "zucchini-wraps")).not.toBe(
      libraryRecipeLockKey(kitchenB, "zucchini-wraps"),
    );
  });
});

describe("storeLibraryPlan", () => {
  const columns = {
    cookPlan: ZUCCHINI_PLAN,
    cookPlanError: null,
    cookPlanSourceHash: HASH,
    cookPlanStamp: cookPlanStamp(),
  };

  it("writes a plan to the row it was made for", async () => {
    await insertRow("zucchini-wraps");
    expect(await storeLibraryPlan(homeId, "zucchini-wraps", HASH, columns)).toBe("stored");
    expect(await planColumns("zucchini-wraps")).toEqual(columns);
  });

  it("skips a row edited while the plan was derived: changed under it", async () => {
    await insertRow("zucchini-wraps");
    // A Refresh rewrites the steps between the derivation and the write.
    await db.update(docRecipes).set({ steps: REWORDED.steps }).where(eq(docRecipes.docSlug, "zucchini-wraps"));
    expect(await storeLibraryPlan(homeId, "zucchini-wraps", HASH, columns)).toBe("changed under it");
    expect(await planColumns("zucchini-wraps")).toEqual(NO_PLAN);
  });

  it("leaves a current plan alone", async () => {
    await insertRow("zucchini-wraps", columns);
    const other = { ...columns, cookPlan: null, cookPlanError: "rejected (cycle): x" };
    expect(await storeLibraryPlan(homeId, "zucchini-wraps", HASH, other)).toBe("already current");
    expect(await planColumns("zucchini-wraps")).toEqual(columns);
  });

  it("replaces a settled error (--retry-failed) and a stale plan", async () => {
    await insertRow("failed", { ...columns, cookPlan: null, cookPlanError: "rejected (cycle): x" });
    await insertRow("stale", { ...columns, cookPlanStamp: "3:0000" });
    expect(await storeLibraryPlan(homeId, "failed", HASH, columns)).toBe("stored");
    expect(await storeLibraryPlan(homeId, "stale", HASH, columns)).toBe("stored");
  });

  it("skips a row that is gone or whose extraction failed", async () => {
    await insertRow("failed", { extractionError: "no recipe here" });
    expect(await storeLibraryPlan(homeId, "failed", HASH, columns)).toBe("changed under it");
    expect(await storeLibraryPlan(homeId, "absent", HASH, columns)).toBe("changed under it");
  });
});

describe("libraryPlanStatus", () => {
  const base: LibraryPlanRow = {
    extractionError: null,
    ingredients: ZUCCHINI_RECIPE.ingredients ?? null,
    steps: ZUCCHINI_RECIPE.steps ?? null,
    stepIngredients: ZUCCHINI_RECIPE.stepIngredients ?? null,
    hasPlan: true,
    cookPlanError: null,
    cookPlanSourceHash: HASH,
    cookPlanStamp: cookPlanStamp(),
  };

  it.each([
    ["current", {}],
    ["missing", { hasPlan: false, cookPlanSourceHash: null, cookPlanStamp: null }],
    ["stale (hash)", { steps: REWORDED.steps! }],
    ["stale (stamp)", { cookPlanStamp: "3:0000" }],
    ["failed settled", { hasPlan: false, cookPlanError: "rejected (cycle): x" }],
    ["failed settled", { hasPlan: false, cookPlanError: "The model declined to plan this recipe (blocked)" }],
    ["failed transient", { hasPlan: false, cookPlanError: "429 Too Many Requests" }],
    ["stale (hash)", { hasPlan: false, cookPlanError: "rejected (cycle): x", steps: REWORDED.steps! }],
    ["no steps", { steps: null, hasPlan: false, cookPlanSourceHash: null, cookPlanStamp: null }],
    ["extraction failed", { extractionError: "no recipe here" }],
  ] as const)("%s: %o", (status, over) => {
    expect(libraryPlanStatus({ ...base, ...over })).toBe(status);
  });
});

describe("libraryPlanReport", () => {
  it("names settled failures, counts the rest that wait on a derivation", async () => {
    const stamp = cookPlanStamp();
    await insertRow("current", { cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: stamp, docPosition: 0 });
    await insertRow("salad", {
      name: "Tomato and herb salad",
      cookPlanError: "rejected (uncovered-step): step 2 is carried by no task",
      cookPlanSourceHash: HASH,
      cookPlanStamp: stamp,
      docPosition: 1,
    });
    await insertRow("transient", { cookPlanError: "429", cookPlanSourceHash: HASH, cookPlanStamp: stamp });
    await insertRow("missing");
    await insertRow("old", { cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: "3:0000" });
    await insertRow("crackers", { extractionError: "no recipe here", steps: null });

    expect(await libraryPlanReport(homeId)).toEqual({
      needFixes: [
        { slug: "salad", name: "Tomato and herb salad", error: "rejected (uncovered-step): step 2 is carried by no task" },
      ],
      pending: 3,
      total: 6,
    });
  });

  it("reads whether a plan is stored, not the plan", async () => {
    await insertRow("current", { cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: cookPlanStamp() });
    const [row] = await readLibraryPlanRows(homeId);
    expect(row).not.toHaveProperty("cookPlan");
    expect(row!.hasPlan).toBe(true);
    expect(libraryPlanStatus(row!)).toBe("current");
  });
});

describe("auditLibraryPlans", () => {
  it("re-checks each current plan with the validator; the rate counts settled rows only", async () => {
    const stamp = cookPlanStamp();
    const broken = zucchiniRaw();
    broken.tasks = broken.tasks.filter((t) => t.sourceStep !== 4).map((t) => ({ ...t, needs: [] }));
    await insertRow("good", { cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: stamp, docPosition: 0 });
    // Stored current but refused today (as if the validator had tightened).
    await insertRow("bad", { cookPlan: broken as never, cookPlanSourceHash: HASH, cookPlanStamp: stamp, docPosition: 1 });
    await insertRow("salad", {
      cookPlanError: "rejected (uncovered-step): step 2 is carried by no task",
      cookPlanSourceHash: HASH,
      cookPlanStamp: stamp,
      docPosition: 2,
    });
    await insertRow("missing", { docPosition: 3 });
    await insertRow("transient", { cookPlanError: "429", cookPlanSourceHash: HASH, cookPlanStamp: stamp, docPosition: 4 });

    const audit = auditLibraryPlans(await readLibraryPlansForAudit(homeId));
    expect(audit.rows.map((r) => [r.slug, r.status, r.invalid])).toEqual([
      ["good", "current", false],
      ["bad", "current", true],
      ["salad", "failed settled", false],
      ["missing", "missing", false],
      ["transient", "failed transient", false],
    ]);
    expect(audit.rows[1]!.error).toMatch(/^invalid \(uncovered-step\): /);
    expect(audit.rows[2]!.error).toBe("rejected (uncovered-step): step 2 is carried by no task");
    expect(audit).toMatchObject({ valid: 1, settled: 3, gate: 14 / 15 });
    expect(audit.validRate).toBeCloseTo(1 / 3);
  });

  it("has no rate with nothing settled", () => {
    expect(auditLibraryPlans([])).toMatchObject({ rows: [], valid: 0, settled: 0, validRate: null });
  });
});

describe("describeValidRate", () => {
  it("prints the rate beside the eval's 14/15 gate", () => {
    expect(describeValidRate(40, 42)).toBe("Valid plans: 40 of 42 (95.2%); gate 93.3% (14/15 on the eval): meets it.");
    expect(describeValidRate(14, 15)).toMatch(/: meets it\.$/);
    expect(describeValidRate(13, 15)).toBe("Valid plans: 13 of 15 (86.7%); gate 93.3% (14/15 on the eval): below it.");
    expect(describeValidRate(0, 0)).toBe("Valid plans: none settled yet; gate 93.3% (14/15 on the eval).");
  });
});
