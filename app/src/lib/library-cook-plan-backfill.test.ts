/**
 * The library backfill (slice P decision 9) against a real Postgres (PGlite,
 * in memory): which rows it derives, the cap with two in flight, resuming
 * after a stop, the valid-rate stop, a row edited while it derives, and a
 * row that throws. The model call is a stubbed chat; derivation, validation,
 * hashing, the cap's metering and the guarded write are real. Two cases wrap
 * the real derive, one to watch concurrency and one to make it throw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { chat } from "./ai";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE, zucchiniRaw } from "./kitchen/__tests__/zucchini-wraps";

vi.mock("./ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai")>()),
  chat: vi.fn(),
}));

vi.mock("@/lib/db", async () =>
  (await import("./__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "./db";
import { conversationLogs, db, docRecipes } from "./db";
import { homeKitchen } from "./__tests__/kitchens";
import { CostLedger } from "./cook-plan-cost";
import { OUTPUT_TOKENS } from "./kitchen/cook-plan-derive";
import { cookPlanStamp, planSourceHash } from "./kitchen/cook-plan-stamp";
import { deriveLibraryPlan, libraryPlanStatus, readLibraryPlanRows } from "./library-cook-plans";
import {
  describeValidRateStop,
  runLibraryBackfill,
  selectBackfillRows,
  validRateStops,
  type DeriveLibraryRow,
} from "./library-cook-plan-backfill";

const client = (dbModule as unknown as { client: PGlite }).client;
const mockChat = chat as Mock;
const HASH = planSourceHash(ZUCCHINI_RECIPE);
const OPEN = () => new CostLedger(100);
let homeId: string;

beforeEach(async () => {
  mockChat.mockReset();
  await client.exec("delete from doc_recipes; delete from conversation_logs");
  homeId = (await homeKitchen(db)).id;
});

/** A step marker the stubbed chat answers by: a refused plan, a failure for now, or a reply too long for the first call. */
const REFUSED = "Taste for salt.";
const FOR_NOW = "Rest a minute.";
const LONG = "Simmer an hour.";

function withStep(marker: string) {
  return ZUCCHINI_RECIPE.steps!.map((s, i) => (i === 1 ? `${s} ${marker}` : s));
}

/**
 * Answers each call by the recipe in its prompt: a plan, a plan missing step
 * 4, a 429, or (for LONG) a reply cut off at the first call's output limit.
 * `reported` usage, or none: a call with none is charged its whole bound,
 * the most it could have cost.
 */
function stubChat(reported: { inputTokens: number; outputTokens: number } | null = { inputTokens: 3_000, outputTokens: 1_000 }) {
  mockChat.mockImplementation(async (args: { maxTokens: number; messages: Array<{ content: unknown }> }) => {
    const prompt = JSON.stringify(args.messages[0]?.content);
    if (prompt.includes(FOR_NOW)) throw new Error("429 Too Many Requests");
    const usage = reported ?? undefined;
    if (prompt.includes(LONG) && args.maxTokens === OUTPUT_TOKENS) {
      return { content: '{"tasks": [', finishReason: "max_tokens", usage };
    }
    const raw = zucchiniRaw();
    if (prompt.includes(REFUSED)) {
      raw.tasks = raw.tasks.filter((t) => t.sourceStep !== 4).map((t) => ({ ...t, needs: [] }));
    }
    return { content: JSON.stringify(raw), finishReason: "stop", usage };
  });
}

let position = 0;
async function insertRow(docSlug: string, over: Partial<typeof docRecipes.$inferInsert> = {}) {
  await db.insert(docRecipes).values({
    kitchenId: homeId,
    docSlug,
    name: docSlug,
    rawDocText: docSlug,
    ingredients: ZUCCHINI_RECIPE.ingredients,
    steps: ZUCCHINI_RECIPE.steps,
    stepIngredients: ZUCCHINI_RECIPE.stepIngredients,
    docPosition: position++,
    ...over,
  });
}

async function statuses() {
  return Object.fromEntries((await readLibraryPlanRows(homeId)).map((r) => [r.docSlug, libraryPlanStatus(r)]));
}

async function targets(options?: Parameters<typeof selectBackfillRows>[1]) {
  return selectBackfillRows(await readLibraryPlanRows(homeId), options).targets;
}

/** What one plain recipe costs when its one call is charged its whole bound. */
async function oneRecipeAtBound(): Promise<number> {
  stubChat(null);
  await insertRow("probe");
  const ledger = OPEN();
  await runLibraryBackfill(homeId, await targets(), ledger);
  await client.exec("delete from doc_recipes; delete from conversation_logs");
  mockChat.mockReset();
  position = 0;
  expect(ledger.calls).toBe(1);
  return ledger.spentUsd;
}

describe("selectBackfillRows", () => {
  beforeEach(async () => {
    position = 0;
    const stamp = cookPlanStamp();
    await insertRow("current", { cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: stamp });
    await insertRow("missing");
    await insertRow("old", { cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: "3:0000" });
    await insertRow("salad", { cookPlanError: "rejected (cycle): x", cookPlanSourceHash: HASH, cookPlanStamp: stamp });
    await insertRow("transient", { cookPlanError: "429", cookPlanSourceHash: HASH, cookPlanStamp: stamp });
    await insertRow("notes", { steps: null, stepIngredients: null });
    await insertRow("crackers", { extractionError: "no recipe here", steps: null });
  });

  it("takes the pending rows in Doc order, with each one's hash", async () => {
    const { targets, skipped, unknown } = selectBackfillRows(await readLibraryPlanRows(homeId));
    expect(targets.map((t) => [t.slug, t.status])).toEqual([
      ["missing", "missing"],
      ["old", "stale (stamp)"],
      ["transient", "failed transient"],
    ]);
    expect(targets[0]!.madeFor).toBe(HASH);
    expect(skipped).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("takes settled failures too with retryFailed", async () => {
    const { targets } = selectBackfillRows(await readLibraryPlanRows(homeId), { retryFailed: true });
    expect(targets.map((t) => t.slug)).toEqual(["missing", "old", "salad", "transient"]);
  });

  it("narrows to the named slugs, saying which it skips and which don't exist", async () => {
    const selection = selectBackfillRows(await readLibraryPlanRows(homeId), { only: ["missing", "current", "salad", "nope"] });
    expect(selection.targets.map((t) => t.slug)).toEqual(["missing"]);
    expect(selection.skipped).toEqual([
      { slug: "current", status: "current" },
      { slug: "salad", status: "failed settled" },
    ]);
    expect(selection.unknown).toEqual(["nope"]);
  });
});

describe("validRateStops", () => {
  it.each([
    [9, 10],
    [10, 11],
    [11, 12],
    [12, 13],
    [13, 14],
  ])("goes on with a lone miss: %i valid of %i settled", (valid, settled) => {
    expect(validRateStops(valid, settled)).toBe(false);
  });

  it.each([
    [8, 10],
    [13, 15],
    [27, 30],
  ])("stops with two or more misses under the gate: %i valid of %i settled", (valid, settled) => {
    expect(validRateStops(valid, settled)).toBe(true);
  });

  it("goes on at the gate: 28 valid of 30 settled is 14/15", () => {
    expect(validRateStops(28, 30)).toBe(false);
  });

  it("doesn't judge before 10 settled, however many missed", () => {
    expect(validRateStops(0, 9)).toBe(false);
    expect(validRateStops(0, 4, 5)).toBe(false);
    expect(validRateStops(0, 5, 5)).toBe(true);
  });

  it("says why it stopped", () => {
    expect(describeValidRateStop(13, 15)).toBe(
      "the valid rate stopped the run, 2 of 15 settled plans failed (86.7% valid): " +
        "two or more misses under the 14/15 gate point at the prompt, so escalate rather than re-run",
    );
  });
});

describe("runLibraryBackfill", () => {
  beforeEach(() => {
    position = 0;
  });

  it("stores a plan, a settled failure and a transient one through the guarded write, and a re-run skips what's done", async () => {
    stubChat();
    await insertRow("wraps");
    await insertRow("salty", { steps: withStep(REFUSED) });
    await insertRow("busy", { steps: withStep(FOR_NOW) });
    const ledger = OPEN();

    const result = await runLibraryBackfill(homeId, await targets(), ledger);
    expect(Object.fromEntries(result.rows.map((r) => [r.slug, [r.outcome, r.stored]]))).toEqual({
      wraps: ["plan", "stored"],
      salty: ["failed settled", "stored"],
      busy: ["failed transient", "stored"],
    });
    expect(result).toMatchObject({ left: [], stop: null, valid: 1, settled: 2 });
    expect(await statuses()).toEqual({ wraps: "current", salty: "failed settled", busy: "failed transient" });
    // wraps 1 call, salty 2 (refused twice), busy 1 that threw: charged at its bound.
    expect(ledger.calls).toBe(4);
    expect(ledger.unreported).toBe(1);
    expect(ledger.spentUsd).toBeGreaterThan(0);

    // A re-run derives only the transient one; --retry-failed adds the settled one.
    expect((await targets()).map((t) => t.slug)).toEqual(["busy"]);
    expect((await targets({ retryFailed: true })).map((t) => t.slug)).toEqual(["salty", "busy"]);
  });

  it("keeps two derivations in flight, never more", async () => {
    // Timing only: the real derive, held a moment so the runner's concurrency shows.
    stubChat();
    for (const slug of ["a", "b", "c", "d", "e"]) await insertRow(slug);
    let inFlight = 0;
    let most = 0;
    const slow: DeriveLibraryRow = async (kitchenId, slug, recipe, meter, aiMeter) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return deriveLibraryPlan(kitchenId, slug, recipe, meter, aiMeter);
    };
    const result = await runLibraryBackfill(homeId, await targets(), OPEN(), { derive: slow });
    expect(result.rows).toHaveLength(5);
    expect(most).toBe(2);
  });

  it("never passes the cap with two in flight, every call charged its bound; a re-run derives only the rest", async () => {
    const perRecipe = await oneRecipeAtBound();
    stubChat(null);
    for (const slug of ["a", "b", "c", "d", "e", "f", "g", "h"]) await insertRow(slug);
    // Room for two and a half recipes: two run at once, the third call is refused.
    const ledger = new CostLedger(2.5 * perRecipe);
    const first = await runLibraryBackfill(homeId, await targets(), ledger);
    expect(first.stop).toBe("cap");
    expect(first.rows.map((r) => r.slug)).toEqual(["a", "b"]);
    expect(first.left).toEqual(["c", "d", "e", "f", "g", "h"]);
    expect(ledger.spentUsd).toBeLessThanOrEqual(ledger.maxUsd);
    expect(ledger.refused).toBeGreaterThan(0);
    // The cut recipes stored nothing.
    const after = await statuses();
    for (const slug of first.left) expect(after[slug]).toBe("missing");

    const rest = await targets();
    expect(rest.map((t) => t.slug)).toEqual(first.left);
    const second = await runLibraryBackfill(homeId, rest, OPEN());
    expect(second).toMatchObject({ stop: null, left: [] });
    expect(Object.values(await statuses()).every((s) => s === "current")).toBe(true);
  });

  it("stops a recipe mid-way when its retry won't fit: one call made, nothing stored, the recipe left", async () => {
    const perRecipe = await oneRecipeAtBound();
    stubChat(null);
    await insertRow("long", { steps: withStep(LONG) });
    // The first call fits; its 16,384-token retry does not.
    const ledger = new CostLedger(1.5 * perRecipe);
    const result = await runLibraryBackfill(homeId, await targets(), ledger);
    expect(result).toMatchObject({ rows: [], left: ["long"], stop: "cap" });
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(ledger.spentUsd).toBeLessThanOrEqual(ledger.maxUsd);
    expect(await statuses()).toEqual({ long: "missing" });
  });

  it("keeps a rejected reply whose re-ask the cap refuses: logged, nothing stored, the recipe left", async () => {
    const perRecipe = await oneRecipeAtBound();
    stubChat(null);
    await insertRow("salty", { steps: withStep(REFUSED) });
    // The first call fits; the re-ask, carrying the reply and the correction, does not.
    const ledger = new CostLedger(1.5 * perRecipe);
    const result = await runLibraryBackfill(homeId, await targets(), ledger);
    expect(result).toMatchObject({ rows: [], left: ["salty"], stop: "cap" });
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(ledger.refused).toBe(1);
    expect(await statuses()).toEqual({ salty: "missing" });
    const logged = await db.select().from(conversationLogs);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      sessionId: "cook-plan:doc:salty",
      role: "assistant",
      context: { call: 1, rule: expect.any(String), detail: expect.any(String) },
    });
    expect(JSON.parse(logged[0]!.content).tasks.some((t: { sourceStep: number }) => t.sourceStep === 4)).toBe(false);
  });

  it("starts nothing under a cap smaller than one call's bound", async () => {
    const perRecipe = await oneRecipeAtBound();
    stubChat(null);
    await insertRow("a");
    const result = await runLibraryBackfill(homeId, await targets(), new CostLedger(perRecipe / 2));
    expect(result).toMatchObject({ rows: [], left: ["a"], stop: "cap" });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("stops on a valid rate below the gate once 10 outcomes have settled", async () => {
    stubChat();
    for (let i = 0; i < 14; i++) await insertRow(`r${String(i).padStart(2, "0")}`, { steps: withStep(REFUSED) });
    const result = await runLibraryBackfill(homeId, await targets(), OPEN());
    expect(result.stop).toBe("valid rate");
    expect(result.settled).toBeGreaterThanOrEqual(10);
    expect(result.valid).toBe(0);
    expect(result.left.length).toBe(14 - result.rows.length);
    expect(result.left.length).toBeGreaterThan(0);
  });

  /** `n` plain rows, with a refused plan at each 1-based position in `misses`. */
  async function insertRun(n: number, misses: readonly number[]) {
    for (let i = 1; i <= n; i++) {
      await insertRow(`r${String(i).padStart(2, "0")}`, misses.includes(i) ? { steps: withStep(REFUSED) } : {});
    }
  }

  it.each([1, 10, 14])("never stops on a lone miss, here at row %i of 15", async (miss) => {
    stubChat();
    await insertRun(15, [miss]);
    const result = await runLibraryBackfill(homeId, await targets(), OPEN(), { concurrency: 1 });
    expect(result).toMatchObject({ stop: null, left: [], valid: 14, settled: 15 });
  });

  it("stops on a second miss by row 15, at that row", async () => {
    stubChat();
    await insertRun(20, [14, 15]);
    const result = await runLibraryBackfill(homeId, await targets(), OPEN(), { concurrency: 1 });
    expect(result).toMatchObject({ stop: "valid rate", valid: 13, settled: 15 });
    expect(result.left).toEqual(["r16", "r17", "r18", "r19", "r20"]);
  });

  it("goes on with two misses in 30 (28/30, at the gate), and stops on the third", async () => {
    stubChat();
    await insertRun(31, [1, 30, 31]);
    const result = await runLibraryBackfill(homeId, await targets(), OPEN(), { concurrency: 1 });
    // Row 30 left the run going at 28/30; row 31's miss made 28/31.
    expect(result.rows).toHaveLength(31);
    expect(result).toMatchObject({ stop: "valid rate", left: [], valid: 28, settled: 31 });
  });

  it("doesn't judge the rate before 10 settled outcomes", async () => {
    stubChat();
    for (let i = 0; i < 9; i++) await insertRow(`r${i}`, { steps: withStep(REFUSED) });
    const result = await runLibraryBackfill(homeId, await targets(), OPEN());
    expect(result).toMatchObject({ stop: null, left: [], settled: 9 });
  });

  it("skips a row a Refresh rewrote while it derived, as changed under it", async () => {
    await insertRow("wraps");
    // The Refresh lands while the model is answering.
    mockChat.mockImplementation(async () => {
      await db.update(docRecipes).set({ steps: withStep(REFUSED) }).where(eq(docRecipes.docSlug, "wraps"));
      return { content: JSON.stringify(zucchiniRaw()), finishReason: "stop" };
    });
    const result = await runLibraryBackfill(homeId, await targets(), OPEN());
    expect(result.rows).toEqual([
      { slug: "wraps", name: "wraps", outcome: "plan", stored: "changed under it", detail: null },
    ]);
    const [row] = await db.select({ cookPlan: docRecipes.cookPlan }).from(docRecipes);
    expect(row!.cookPlan).toBeNull();
  });

  it("records a row that throws and goes on to the next", async () => {
    // The real derive answers every model failure with a row; this wraps it to
    // throw, as a conversation-log write could, to test the runner's own catch.
    stubChat();
    await insertRow("a");
    await insertRow("b");
    const flaky: DeriveLibraryRow = async (kitchenId, slug, recipe, meter, aiMeter) => {
      if (slug === "a") throw new Error("connection reset");
      return deriveLibraryPlan(kitchenId, slug, recipe, meter, aiMeter);
    };
    const result = await runLibraryBackfill(homeId, await targets(), OPEN(), { derive: flaky, concurrency: 1 });
    expect(result.rows.map((r) => [r.slug, r.outcome, r.stored, r.detail])).toEqual([
      ["a", "threw", null, "connection reset"],
      ["b", "plan", "stored", null],
    ]);
    expect(await statuses()).toEqual({ a: "missing", b: "current" });
  });

  it("records a write that throws", async () => {
    stubChat();
    await insertRow("a");
    const store = async (): Promise<never> => {
      throw new Error("deadlock detected");
    };
    const result = await runLibraryBackfill(homeId, await targets(), OPEN(), { store });
    expect(result.rows).toEqual([{ slug: "a", name: "a", outcome: "threw", stored: null, detail: "deadlock detected" }]);
  });
});
