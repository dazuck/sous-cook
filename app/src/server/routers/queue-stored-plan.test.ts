/**
 * Queueing with a plan worked out ahead (slice P decision 5), through the
 * router (`createCaller`) against a real Postgres (PGlite, in memory): the
 * library row's read, the three checks, the insert and the open. Only the
 * model call and `after()` are stubbed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE, zucchiniRaw } from "../../lib/kitchen/__tests__/zucchini-wraps";

const scheduled: Array<() => unknown> = [];
// Every hook reads connected, as in a kitchen that has them: these cases
// send from the household book, which only a connected recipe library draws.
vi.mock("../../lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../../lib/hooks/types");
  return { connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, true])) };
});

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((task: () => unknown) => scheduled.push(task)),
}));
vi.mock("../../lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai")>()),
  chat: vi.fn(),
}));
// The pack branch reads plan files from a temp `pack-plans/` stand-in; the
// shelf still loads the repo's packs.
// (Hoisted above the imports, so only a path here; `beforeAll` makes it.)
const plansDir = vi.hoisted(
  () => `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/queue-pack-plans-${process.pid}-${Date.now()}`,
);
vi.mock("../../lib/shelf/load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/shelf/load")>()),
  PACK_PLANS_DIR: plansDir,
}));
vi.mock("../../lib/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../../../drizzle/schema");
  const client = new PGlite();
  return { ...schema, db: drizzle(client, { schema }), client };
});

import * as dbModule from "../../lib/db";
import { conversationLogs, db, docRecipes, kitchenQueue } from "../../lib/db";
import { chat } from "../../lib/ai";
import { cookPlanStamp, planSourceHash } from "../../lib/kitchen/cook-plan-stamp";
import { chainPlan } from "../../lib/kitchen/__tests__/chain-plan";
import { fannie } from "../../lib/pack-convert/__tests__/fannie-native";
import { checkPackPlans, packPlanPath, serializePackPlanFile, type PackPlanFile } from "../../lib/pack-cook-plans";
import { appRouter } from "./_app";

const client = (dbModule as unknown as { client: PGlite }).client;
const mockChat = chat as Mock;
const caller = appRouter.createCaller({ db: {} as never });
const HASH = planSourceHash(ZUCCHINI_RECIPE);
const SETTLED = "rejected (uncovered-step): step 4 is in no task";

beforeAll(async () => {
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ docRecipes, kitchenQueue, conversationLogs }),
  );
  for (const statement of statements) await client.exec(statement);
});

let info: MockInstance<typeof console.info>;
let error: MockInstance<typeof console.error>;
beforeEach(async () => {
  mockChat.mockReset();
  scheduled.length = 0;
  await client.exec("delete from doc_recipes; delete from kitchen_queue; delete from conversation_logs");
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  info.mockRestore();
  error.mockRestore();
});

/** The zucchini wraps as a library row, with whatever plan columns the case sets. */
async function libraryRow(plan: Partial<typeof docRecipes.$inferInsert> = {}) {
  await db.insert(docRecipes).values({
    docSlug: "zucchini-wraps",
    name: "Sweet Zucchini Wraps",
    category: "indian",
    categoryTitle: "Indian",
    docPosition: 0,
    ingredients: ZUCCHINI_RECIPE.ingredients,
    steps: ZUCCHINI_RECIPE.steps,
    serves: 2,
    rawDocText: "Sweet Zucchini Wraps",
    ...plan,
  });
}

const queue = () => caller.queueFromPack({ packId: "household-book", recipeId: "zucchini-wraps", targetUser: "cook" });

async function queued(id: string) {
  const [row] = await db.select().from(kitchenQueue).where(eq(kitchenQueue.id, id));
  return row;
}

describe("queueFromPack: the household pack's stored plan", () => {
  it("copies a current plan into the queue row and schedules nothing; the open makes no call", async () => {
    await libraryRow({ cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: cookPlanStamp() });

    const { id } = await queue();

    expect(await queued(id)).toMatchObject({ cookPlan: ZUCCHINI_PLAN, cookPlanError: null });
    expect(scheduled).toHaveLength(0);
    expect(await caller.ensureCookPlan({ queueId: id })).toEqual({ plan: ZUCCHINI_PLAN, error: null });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("copies a settled error with no plan and schedules nothing; the open makes no call", async () => {
    await libraryRow({ cookPlanError: SETTLED, cookPlanSourceHash: HASH, cookPlanStamp: cookPlanStamp() });

    const { id } = await queue();

    expect(await queued(id)).toMatchObject({ cookPlan: null, cookPlanError: SETTLED });
    expect(scheduled).toHaveLength(0);
    expect(await caller.ensureCookPlan({ queueId: id })).toEqual({ plan: null, error: SETTLED });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("copies nothing beside steps the plan wasn't made for (the release before P's sync), and derives", async () => {
    const steps = [...(ZUCCHINI_RECIPE.steps ?? []), "Serve warm."];
    await libraryRow({ steps, cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: cookPlanStamp() });

    const { id } = await queue();

    expect(await queued(id)).toMatchObject({ cookPlan: null, cookPlanError: null });
    expect(scheduled).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/stored cook plan not copied \(hash\)/));
  });

  it("copies nothing from an older prompt or version, and derives", async () => {
    await libraryRow({ cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: "3:0123456789abcdef" });

    const { id } = await queue();

    expect((await queued(id)).cookPlan).toBeNull();
    expect(scheduled).toHaveLength(1);
  });

  it("copies no plan that fails validation, logs it, and derives", async () => {
    const corrupted = {
      ...ZUCCHINI_PLAN,
      tasks: ZUCCHINI_PLAN.tasks.map((t, i) => (i === 0 ? { ...t, needs: ["no-such-task"] } : t)),
    };
    await libraryRow({ cookPlan: corrupted, cookPlanSourceHash: HASH, cookPlanStamp: cookPlanStamp() });

    const { id } = await queue();

    expect((await queued(id)).cookPlan).toBeNull();
    expect(scheduled).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/not copied \(invalid \(dangling-need\)/));
  });

  it("copies no transient error, and derives as before", async () => {
    await libraryRow({
      cookPlanError: "Cook plan derivation timed out after 45 s",
      cookPlanSourceHash: HASH,
      cookPlanStamp: cookPlanStamp(),
    });
    mockChat.mockResolvedValueOnce({ content: JSON.stringify(zucchiniRaw()), finishReason: "stop" });

    const { id } = await queue();
    expect((await queued(id)).cookPlanError).toBeNull();
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();

    expect((await queued(id)).cookPlan).toEqual(ZUCCHINI_PLAN);
  });

  it("derives for a row with nothing stored, as before P", async () => {
    await libraryRow();

    const { id } = await queue();

    expect((await queued(id)).cookPlan).toBeNull();
    expect(scheduled).toHaveLength(1);
    expect(info).not.toHaveBeenCalledWith(expect.stringMatching(/not copied/));
  });

  it("keeps the queue row a snapshot: a later change to the library row never reaches it", async () => {
    await libraryRow({ cookPlan: ZUCCHINI_PLAN, cookPlanSourceHash: HASH, cookPlanStamp: cookPlanStamp() });
    const { id } = await queue();
    const before = await queued(id);

    await db
      .update(docRecipes)
      .set({
        steps: [...(ZUCCHINI_RECIPE.steps ?? []), "Serve warm."],
        cookPlan: null,
        cookPlanError: SETTLED,
        cookPlanSourceHash: "0".repeat(64),
      })
      .where(eq(docRecipes.docSlug, "zucchini-wraps"));

    expect(await queued(id)).toEqual(before);
    expect(before.cookPlan).toEqual(ZUCCHINI_PLAN);
  });
});

describe("queueFromPack: a pack file's committed plan", () => {
  const pack = fannie();
  const recipe = checkPackPlans(pack, null).recipes[0]!;
  const plan = chainPlan(recipe.recipeData!);
  const planFile = packPlanPath(plansDir, pack.id);

  function writePlanFile(entry: PackPlanFile["recipes"][string]) {
    const file: PackPlanFile = {
      version: 1,
      packId: pack.id,
      packVersion: pack.version,
      model: "google/gemini-3.5-flash",
      stamp: cookPlanStamp(),
      proposedAt: "2026-10-11T00:00:00.000Z",
      recipes: { [recipe.recipeId]: entry },
    };
    writeFileSync(planFile, serializePackPlanFile(file));
  }
  const queuePack = () => caller.queueFromPack({ packId: pack.id, recipeId: recipe.recipeId, targetUser: "cook" });

  beforeAll(() => mkdirSync(plansDir, { recursive: true }));
  afterEach(() => rmSync(planFile, { force: true }));
  afterAll(() => rmSync(plansDir, { recursive: true, force: true }));

  it("copies the entry made for the recipe and schedules nothing", async () => {
    writePlanFile({ sourceHash: recipe.sourceHash!, plan, error: null });

    const { id } = await queuePack();

    expect(await queued(id)).toMatchObject({ cookPlan: plan, cookPlanError: null });
    expect(scheduled).toHaveLength(0);
  });

  it("copies a reviewed settled failure and schedules nothing", async () => {
    writePlanFile({ sourceHash: recipe.sourceHash!, plan: null, error: SETTLED });

    const { id } = await queuePack();

    expect(await queued(id)).toMatchObject({ cookPlan: null, cookPlanError: SETTLED });
    expect(scheduled).toHaveLength(0);
  });

  it("copies nothing for a recipe edited since its plan (a pack shipped without --propose), and derives", async () => {
    writePlanFile({ sourceHash: "0".repeat(64), plan, error: null });

    const { id } = await queuePack();

    expect((await queued(id)).cookPlan).toBeNull();
    expect(scheduled).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/stored cook plan not copied \(hash\)/));
  });

  it("derives for a pack with no plan file, as before P", async () => {
    const { id } = await queuePack();

    expect((await queued(id)).cookPlan).toBeNull();
    expect(scheduled).toHaveLength(1);
    expect(error).not.toHaveBeenCalledWith(expect.stringMatching(/plan file/));
    expect(info).not.toHaveBeenCalledWith(expect.stringMatching(/not copied/));
  });

  it("logs an unreadable plan file and derives", async () => {
    writeFileSync(planFile, "{");

    const { id } = await queuePack();

    expect((await queued(id)).cookPlan).toBeNull();
    expect(scheduled).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/pack plan file unreadable, deriving instead: .*not JSON/));
  });
});
