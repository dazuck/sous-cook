/**
 * Refresh's cook plans (slice P) against a real Postgres (PGlite, in memory):
 * the plan step between the serving count and the save, the save that writes
 * a plan with the steps it was made for, and the time budget. The recipe
 * library (the hook's read), the extractor and the model call are stubbed;
 * the sync, the derivation, the validator and every query are real.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { RecipeForPlan } from "./kitchen/cook-plan";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE, zucchiniRaw } from "./kitchen/__tests__/zucchini-wraps";

const readTabs = vi.hoisted(() => vi.fn());
vi.mock("./hooks/registry", () => ({ hook: () => ({ readTabs }) }));
vi.mock("./recipe-import", () => ({ extractRecipeFromText: vi.fn() }));
vi.mock("./ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai")>()),
  chat: vi.fn(),
}));
vi.mock("./db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../../drizzle/schema");
  const client = new PGlite();
  return { ...schema, db: drizzle(client, { schema }), client };
});

import * as dbModule from "./db";
import { conversationLogs, db, docRecipes } from "./db";
import { chat } from "./ai";
import { extractRecipeFromText, type ImportedRecipe } from "./recipe-import";
import type { LibraryTab } from "./hooks/types";
import { cookPlanStamp, planSourceHash } from "./kitchen/cook-plan-stamp";
import { readFamilyLibrary, syncRecipesFromDoc } from "./recipe-sync";
import { REFRESH_PLAN_BUDGET_MS, planBudget, type PlanBudget } from "./library-cook-plans";
import { CostLedger, callCostUsd } from "./cook-plan-cost";

const client = (dbModule as unknown as { client: PGlite }).client;
const mockChat = chat as Mock;
const mockExtract = extractRecipeFromText as Mock;

beforeAll(async () => {
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ docRecipes, conversationLogs }),
  );
  for (const statement of statements) await client.exec(statement);
});

beforeEach(async () => {
  mockChat.mockReset();
  mockExtract.mockReset();
  readTabs.mockReset();
  await client.exec("delete from doc_recipes; delete from conversation_logs");
});

const OPEN: PlanBudget = { start: () => new CostLedger(Infinity).meter() };
const HASH = planSourceHash(ZUCCHINI_RECIPE);

/** The recipe's tab body: its ingredients and steps, as the family wrote them. */
const BODY = [
  ...ZUCCHINI_RECIPE.ingredients!.map((i) => [i.amount, i.item].filter(Boolean).join(" ")),
  ...ZUCCHINI_RECIPE.steps!,
];

function tab(title: string, lines: string[] = [], children: LibraryTab[] = []): LibraryTab {
  return { title, lines, nonText: false, children };
}

/** A Doc of one category holding a tab per name, each the zucchini recipe. */
function docOf(...names: string[]) {
  const tabs = [tab("mains", [], names.map((n) => tab(n, BODY)))];
  readTabs.mockResolvedValue(tabs);
}

/** Every tab extracts as `recipe` (a stated count, so no serving estimate is asked for). */
function extractAs(recipe: RecipeForPlan) {
  mockExtract.mockImplementation(async (text: string) => ({
    recipe: { name: text.split("\n")[0], serves: 4, ...recipe } satisfies ImportedRecipe,
    notices: [],
  }));
}

function replyPlan() {
  return { content: JSON.stringify(zucchiniRaw()), finishReason: "stop" };
}

function replyUncovered() {
  const broken = zucchiniRaw();
  broken.tasks = broken.tasks.filter((t) => t.sourceStep !== 4).map((t) => ({ ...t, needs: [] }));
  return { content: JSON.stringify(broken), finishReason: "stop" };
}

/** The same Doc text, extracted with step 2 worded differently. */
const REWORDED: RecipeForPlan = {
  ...ZUCCHINI_RECIPE,
  steps: ZUCCHINI_RECIPE.steps!.map((s, i) => (i === 1 ? "Stir in the onion greens right at the end." : s)),
};

async function row(docSlug: string) {
  const [found] = await db.select().from(docRecipes).where(eq(docRecipes.docSlug, docSlug));
  return found;
}

describe("Refresh's plans", () => {
  it("derives each new recipe's plan and saves it with its row", async () => {
    docOf("Zucchini wraps", "Paratha rolls");
    extractAs(ZUCCHINI_RECIPE);
    mockChat.mockResolvedValue(replyPlan());

    const result = await syncRecipesFromDoc({ planBudget: OPEN });

    expect(result.plans).toEqual({ derived: 2, reused: 0, pending: 0, failed: [] });
    expect(mockChat).toHaveBeenCalledTimes(2);
    const saved = await row("zucchini-wraps");
    expect(saved?.cookPlan).toEqual(ZUCCHINI_PLAN);
    expect(saved?.cookPlanSourceHash).toBe(HASH);
    expect(saved?.cookPlanStamp).toBe(cookPlanStamp());
    expect(saved?.cookPlanError).toBeNull();
  });

  it("reuses every plan on a Refresh whose extractions come back the same: zero calls", async () => {
    docOf("Zucchini wraps", "Paratha rolls");
    extractAs(ZUCCHINI_RECIPE);
    mockChat.mockResolvedValue(replyPlan());
    await syncRecipesFromDoc({ planBudget: OPEN });
    mockChat.mockClear();

    const again = await syncRecipesFromDoc({ planBudget: OPEN });

    expect(again.plans).toEqual({ derived: 0, reused: 2, pending: 0, failed: [] });
    expect(mockChat).not.toHaveBeenCalled();
    expect((await row("paratha-rolls"))?.cookPlan).toEqual(ZUCCHINI_PLAN);
  });

  it("re-derives a recipe whose same text extracts as different steps, in the same write", async () => {
    docOf("Zucchini wraps");
    extractAs(ZUCCHINI_RECIPE);
    mockChat.mockResolvedValue(replyPlan());
    await syncRecipesFromDoc({ planBudget: OPEN });

    extractAs(REWORDED);
    mockChat.mockClear();
    const result = await syncRecipesFromDoc({ planBudget: OPEN });

    expect(result.plans.derived).toBe(1);
    expect(mockChat).toHaveBeenCalledTimes(1);
    const saved = await row("zucchini-wraps");
    expect(saved?.steps).toEqual(REWORDED.steps);
    expect(saved?.cookPlanSourceHash).toBe(planSourceHash(REWORDED));
  });

  it("past the budget saves rows with no plan, clearing a stale one, and counts them pending", async () => {
    docOf("Zucchini wraps", "Paratha rolls", "Wrap night");
    extractAs(ZUCCHINI_RECIPE);
    mockChat.mockResolvedValue(replyPlan());
    await syncRecipesFromDoc({ planBudget: OPEN });

    // The Doc's steps change, and the budget is already spent.
    extractAs(REWORDED);
    mockChat.mockClear();
    const result = await syncRecipesFromDoc({ planBudget: planBudget(0) });

    expect(result.plans).toEqual({ derived: 0, reused: 0, pending: 3, failed: [] });
    expect(result.succeeded).toBe(3);
    expect(mockChat).not.toHaveBeenCalled();
    for (const slug of ["zucchini-wraps", "paratha-rolls", "wrap-night"]) {
      const saved = await row(slug);
      expect(saved?.steps).toEqual(REWORDED.steps);
      expect(saved?.cookPlan).toBeNull();
      expect(saved?.cookPlanSourceHash).toBeNull();
    }
  });

  it("a budget that runs out mid-run leaves the rest pending, and the next Refresh finishes them", async () => {
    docOf("Zucchini wraps", "Paratha rolls", "Wrap night");
    extractAs(ZUCCHINI_RECIPE);
    mockChat.mockResolvedValue(replyPlan());
    // A clock that moves 150 s each time it is read: one derivation fits.
    let now = 0;
    const clock = () => {
      const t = now;
      now += 150_000;
      return t;
    };

    const first = await syncRecipesFromDoc({ planBudget: planBudget(REFRESH_PLAN_BUDGET_MS, clock) });
    expect(first.plans).toEqual({ derived: 1, reused: 0, pending: 2, failed: [] });

    const second = await syncRecipesFromDoc({ planBudget: OPEN });
    expect(second.plans).toEqual({ derived: 2, reused: 1, pending: 0, failed: [] });
    expect(mockChat).toHaveBeenCalledTimes(3);
  });

  it("a Refresh that finds the library unplanned spends at most its dollar cap, the rest pending for the next", async () => {
    docOf("Zucchini wraps", "Paratha rolls", "Wrap night", "Dal", "Roti");
    extractAs(ZUCCHINI_RECIPE);
    // Billed at its whole bound, the worst a call can cost.
    mockChat.mockImplementation(async (args: { maxTokens: number }) => ({
      ...replyPlan(),
      usage: { inputTokens: 12_000, outputTokens: args.maxTokens },
    }));
    // Room for two calls' bounds, with four derivations in flight at once.
    const ledger = new CostLedger(callCostUsd(2 * 13_000, 2 * 8_192));
    const first = await syncRecipesFromDoc({ planBudget: planBudget(REFRESH_PLAN_BUDGET_MS, Date.now, ledger) });
    expect(first.plans).toEqual({ derived: 2, reused: 0, pending: 3, failed: [] });
    expect(first.succeeded).toBe(5);
    expect(ledger.spentUsd).toBeLessThanOrEqual(ledger.maxUsd);
    expect(mockChat).toHaveBeenCalledTimes(2);

    const second = await syncRecipesFromDoc({ planBudget: planBudget() });
    expect(second.plans).toEqual({ derived: 3, reused: 2, pending: 0, failed: [] });
  });

  it("a run killed mid-derivation leaves each row at its old state or its new one, never half", async () => {
    docOf("Zucchini wraps", "Paratha rolls", "Wrap night");
    extractAs(ZUCCHINI_RECIPE);
    mockChat.mockResolvedValue(replyPlan());
    await syncRecipesFromDoc({ planBudget: OPEN });

    // The next Refresh rewords a step; one recipe's derivation never returns.
    extractAs(REWORDED);
    let release: (v: unknown) => void = () => {};
    mockChat.mockReset();
    mockChat
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValue(replyPlan());
    const run = syncRecipesFromDoc({ planBudget: OPEN });

    await vi.waitFor(async () => {
      const rows = await db.select().from(docRecipes);
      expect(rows.filter((r) => r.cookPlanSourceHash === planSourceHash(REWORDED))).toHaveLength(2);
    });
    const rows = await db.select().from(docRecipes);
    for (const r of rows) {
      const fresh = r.cookPlanSourceHash === planSourceHash(REWORDED);
      // Old steps with the old plan, or new steps with the new one.
      expect(r.steps).toEqual(fresh ? REWORDED.steps : ZUCCHINI_RECIPE.steps);
      expect(r.cookPlanSourceHash).toBe(planSourceHash(fresh ? REWORDED : ZUCCHINI_RECIPE));
      expect(r.cookPlan).toEqual(ZUCCHINI_PLAN);
    }

    release(replyPlan());
    expect((await run).plans.derived).toBe(3);
  });

  it("names a refused plan as a settled failure, and keeps it on a same-text Refresh with no call", async () => {
    docOf("Tomato and herb salad");
    extractAs(ZUCCHINI_RECIPE);
    mockChat.mockResolvedValue(replyUncovered());

    const first = await syncRecipesFromDoc({ planBudget: OPEN });
    expect(first.plans.failed).toEqual([
      { name: "Tomato and herb salad", error: expect.stringMatching(/^rejected \(uncovered-step\)/), settled: true },
    ]);
    expect((await row("tomato-and-herb-salad"))?.cookPlanError).toMatch(/^rejected/);

    mockChat.mockClear();
    const again = await syncRecipesFromDoc({ planBudget: OPEN });
    expect(mockChat).not.toHaveBeenCalled();
    expect(again.plans.reused).toBe(1);
    expect(again.plans.failed).toEqual([expect.objectContaining({ name: "Tomato and herb salad", settled: true })]);
  });

  it("retries a transient failure on the next Refresh, once", async () => {
    docOf("Zucchini wraps");
    extractAs(ZUCCHINI_RECIPE);
    mockChat.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    const first = await syncRecipesFromDoc({ planBudget: OPEN });
    expect(first.plans.failed).toEqual([{ name: "Zucchini wraps", error: "429 Too Many Requests", settled: false }]);

    mockChat.mockResolvedValue(replyPlan());
    const second = await syncRecipesFromDoc({ planBudget: OPEN });
    expect(second.plans).toEqual({ derived: 1, reused: 0, pending: 0, failed: [] });
    expect((await row("zucchini-wraps"))?.cookPlan).toEqual(ZUCCHINI_PLAN);
  });

  it("a kept recipe keeps its saved plan with its saved steps", async () => {
    docOf("Zucchini wraps");
    extractAs(ZUCCHINI_RECIPE);
    mockChat.mockResolvedValue(replyPlan());
    await syncRecipesFromDoc({ planBudget: OPEN });

    // The unchanged tab comes back without its steps: the saved recipe is kept.
    extractAs({ ingredients: ZUCCHINI_RECIPE.ingredients });
    mockChat.mockClear();
    const result = await syncRecipesFromDoc({ planBudget: OPEN });

    expect(result.failures).toEqual([{ name: "Zucchini wraps", error: expect.stringMatching(/saved recipe was kept/) }]);
    expect(result.plans).toEqual({ derived: 0, reused: 0, pending: 0, failed: [] });
    const saved = await row("zucchini-wraps");
    expect(saved?.steps).toEqual(ZUCCHINI_RECIPE.steps);
    expect(saved?.cookPlan).toEqual(ZUCCHINI_PLAN);
    expect(saved?.cookPlanSourceHash).toBe(HASH);
  });

  it("a failed extraction plans nothing, and leaves a saved recipe's plan alone", async () => {
    docOf("Zucchini wraps", "Crackers");
    mockExtract.mockImplementation(async (text: string) =>
      text.startsWith("Crackers") ? null : { recipe: { name: "Zucchini wraps", serves: 4, ...ZUCCHINI_RECIPE }, notices: [] },
    );
    mockChat.mockResolvedValue(replyPlan());
    await syncRecipesFromDoc({ planBudget: OPEN });
    const crackers = await row("crackers");
    expect(crackers?.extractionError).not.toBeNull();
    expect(crackers?.cookPlan).toBeNull();
    expect(crackers?.cookPlanSourceHash).toBeNull();

    mockExtract.mockResolvedValue(null);
    mockChat.mockClear();
    const result = await syncRecipesFromDoc({ planBudget: OPEN });
    expect(mockChat).not.toHaveBeenCalled();
    expect(result.plans).toEqual({ derived: 0, reused: 0, pending: 0, failed: [] });
    expect((await row("zucchini-wraps"))?.cookPlan).toEqual(ZUCCHINI_PLAN);
  });

  it("a recipe with no steps is saved with no plan and no call", async () => {
    docOf("Zucchini wraps");
    extractAs({ ingredients: ZUCCHINI_RECIPE.ingredients, steps: [] });
    const result = await syncRecipesFromDoc({ planBudget: OPEN });
    expect(mockChat).not.toHaveBeenCalled();
    expect(result.plans).toEqual({ derived: 0, reused: 0, pending: 0, failed: [] });
    expect((await row("zucchini-wraps"))?.cookPlan).toBeNull();
  });
});

describe("readFamilyLibrary", () => {
  it("reads every column but the plan itself", async () => {
    docOf("Zucchini wraps");
    extractAs(ZUCCHINI_RECIPE);
    mockChat.mockResolvedValue(replyPlan());
    await syncRecipesFromDoc({ planBudget: OPEN });

    const [shelfRow] = await readFamilyLibrary();
    expect(shelfRow).not.toHaveProperty("cookPlan");
    expect(shelfRow).toMatchObject({ docSlug: "zucchini-wraps", cookPlanSourceHash: HASH, cookPlanError: null });
  });
});
