/**
 * Cook-plan storage against a real Postgres (PGlite, in memory).
 *
 * The first-writer-wins guarantee lives in SQL (a conditional UPDATE on a
 * jsonb version), so these tests run the real queries rather than a mocked
 * query builder. Only the model call is mocked; derivation and validation
 * are real.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Mock } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { chat } from "./ai";
import { COOK_PLAN_VERSION, type CookPlan } from "./kitchen/cook-plan";
import {
  ZUCCHINI_PLAN,
  ZUCCHINI_RECIPE,
  zucchiniRaw,
} from "./kitchen/__tests__/zucchini-wraps";

vi.mock("./ai", () => ({ chat: vi.fn() }));

vi.mock("@/lib/db", async () =>
  (await import("./__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "./db";
import { conversationLogs, db, kitchenQueue } from "./db";
import {
  addToKitchenQueue,
  deriveAndStoreCookPlan,
  prepareQueueItemInBackground,
  getQueueItem,
  selectCookPlanBackfill,
} from "./kitchen-queue";

const client = (dbModule as unknown as { client: PGlite }).client;
const mockChat = chat as Mock;

beforeEach(async () => {
  mockChat.mockReset();
  await client.exec("delete from kitchen_queue; delete from conversation_logs");
});

/** The rejected replies logged for the item, in call order. */
async function logged(id: string) {
  const rows = await db
    .select()
    .from(conversationLogs)
    .where(eq(conversationLogs.sessionId, `cook-plan:${id}`))
    .orderBy(sql`(${conversationLogs.context}->>'call')::int`);
  return rows.map(({ role, content, context }) => ({ role, content, context }));
}

/** The zucchini plan with every `needs` left out, as prod saw Gemini do. */
function withoutNeeds(): Record<string, unknown> {
  const raw = zucchiniRaw();
  return {
    tasks: raw.tasks.map((task) => {
      const { needs: _, ...rest } = task;
      return rest;
    }),
  };
}

function reply(raw: unknown) {
  mockChat.mockResolvedValueOnce({
    content: JSON.stringify(raw),
    finishReason: "stop",
  });
}

async function queueZucchini(): Promise<string> {
  const { id } = await addToKitchenQueue({
    recipeData: { name: "Sweet Zucchini Wraps", ...ZUCCHINI_RECIPE },
    targetUser: "cook",
  });
  return id;
}

async function stored(id: string) {
  const item = await getQueueItem(id);
  return { cookPlan: item?.cookPlan, cookPlanError: item?.cookPlanError };
}

/** The zucchini plan with a different last-task label, to tell plans apart. */
function variant(label: string): Record<string, unknown> {
  const raw = zucchiniRaw();
  raw.tasks[raw.tasks.length - 1].label = label;
  return raw;
}

/** A model call the test finishes when it chooses. */
function deferredReply() {
  let finish: (raw: unknown) => void = () => {};
  mockChat.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = (raw) =>
          resolve({ content: JSON.stringify(raw), finishReason: "stop" });
      }),
  );
  return (raw: unknown) => finish(raw);
}

describe("addToKitchenQueue with a plan worked out ahead (slice P)", () => {
  it("writes a copied plan in the insert, so an open needs no call", async () => {
    const { id } = await addToKitchenQueue({
      recipeData: { name: "Sweet Zucchini Wraps", ...ZUCCHINI_RECIPE },
      targetUser: "cook",
      plan: { cookPlan: ZUCCHINI_PLAN, cookPlanError: null },
    });

    expect(await stored(id)).toEqual({ cookPlan: ZUCCHINI_PLAN, cookPlanError: null });
    expect(await deriveAndStoreCookPlan(id)).toEqual({ plan: ZUCCHINI_PLAN, error: null });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("writes a copied settled error in the insert, with no plan", async () => {
    const settled = "The model declined to plan this recipe (blocked)";
    const { id } = await addToKitchenQueue({
      recipeData: { name: "Sweet Zucchini Wraps", ...ZUCCHINI_RECIPE },
      targetUser: "cook",
      plan: { cookPlan: null, cookPlanError: settled },
    });

    expect(await stored(id)).toEqual({ cookPlan: null, cookPlanError: settled });
  });

  it("writes neither without one", async () => {
    expect(await stored(await queueZucchini())).toEqual({ cookPlan: null, cookPlanError: null });
  });
});

describe("deriveAndStoreCookPlan", () => {
  it("derives, validates and stores the plan with the current version", async () => {
    const id = await queueZucchini();
    reply(zucchiniRaw());

    const outcome = await deriveAndStoreCookPlan(id);

    expect(outcome).toEqual({ plan: ZUCCHINI_PLAN, error: null });
    expect(await stored(id)).toEqual({
      cookPlan: ZUCCHINI_PLAN,
      cookPlanError: null,
    });
    expect(ZUCCHINI_PLAN.version).toBe(COOK_PLAN_VERSION);
  });

  it("returns a current stored plan without calling the model", async () => {
    const id = await queueZucchini();
    reply(zucchiniRaw());
    await deriveAndStoreCookPlan(id);

    const outcome = await deriveAndStoreCookPlan(id);

    expect(outcome).toEqual({ plan: ZUCCHINI_PLAN, error: null });
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("re-derives over a plan from an older version", async () => {
    const id = await queueZucchini();
    const old: CookPlan = { ...ZUCCHINI_PLAN, version: COOK_PLAN_VERSION - 1 };
    await db.update(kitchenQueue).set({ cookPlan: old });
    reply(zucchiniRaw());

    const outcome = await deriveAndStoreCookPlan(id);

    expect(outcome.plan).toEqual(ZUCCHINI_PLAN);
    expect((await stored(id)).cookPlan).toEqual(ZUCCHINI_PLAN);
  });

  it("stores the rule when validation rejects the plan, and keeps no plan", async () => {
    const id = await queueZucchini();
    const broken = zucchiniRaw();
    broken.tasks = broken.tasks
      .filter((t) => t.sourceStep !== 4)
      .map((t) => ({ ...t, needs: [] }));
    reply(broken);
    reply(broken);

    const outcome = await deriveAndStoreCookPlan(id);

    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(outcome.plan).toBeNull();
    expect(outcome.error).toMatch(/^rejected \(uncovered-step\): /);
    expect(await stored(id)).toEqual({
      cookPlan: null,
      cookPlanError: outcome.error,
    });
  });

  it("logs each rejected reply, so a bad plan can be read back later", async () => {
    const id = await queueZucchini();
    reply(withoutNeeds());
    reply({ tasks: "not a list" });

    await deriveAndStoreCookPlan(id);

    const rows = await logged(id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      role: "assistant",
      content: JSON.stringify(withoutNeeds()),
      context: {
        derivation: expect.any(String),
        call: 1,
        rule: "shape",
        detail: expect.stringMatching(/needs/),
      },
    });
    expect(rows[1]).toMatchObject({
      content: JSON.stringify({ tasks: "not a list" }),
      context: { call: 2, rule: "shape" },
    });
    // One derivation: both rows carry its id.
    expect(rows[1].context).toMatchObject({
      derivation: (rows[0].context as { derivation: string }).derivation,
    });
  });

  it("logs a rejected first reply and stores the plan from the re-ask", async () => {
    const id = await queueZucchini();
    reply(withoutNeeds());
    reply(zucchiniRaw());

    const outcome = await deriveAndStoreCookPlan(id);

    expect(outcome).toEqual({ plan: ZUCCHINI_PLAN, error: null });
    expect((await stored(id)).cookPlan).toEqual(ZUCCHINI_PLAN);
    expect(await logged(id)).toHaveLength(1);
  });

  it("logs a reply that isn't JSON as its text", async () => {
    const id = await queueZucchini();
    mockChat.mockResolvedValueOnce({ content: "Sure! Here", finishReason: "stop" });
    reply(zucchiniRaw());

    await deriveAndStoreCookPlan(id);

    expect(await logged(id)).toEqual([
      {
        role: "assistant",
        content: "Sure! Here",
        context: {
          derivation: expect.any(String),
          call: 1,
          rule: "shape",
          detail: "the response was not JSON",
        },
      },
    ]);
  });

  it("logs a rejected reply even when the re-ask fails, and stores that failure", async () => {
    const id = await queueZucchini();
    reply(withoutNeeds());
    mockChat.mockRejectedValueOnce(new Error("quota exceeded"));

    const outcome = await deriveAndStoreCookPlan(id);

    expect(outcome).toEqual({ plan: null, error: "quota exceeded" });
    expect((await stored(id)).cookPlanError).toBe("quota exceeded");
    expect(await logged(id)).toEqual([
      expect.objectContaining({
        content: JSON.stringify(withoutNeeds()),
        context: expect.objectContaining({ call: 1, rule: "shape" }),
      }),
    ]);
  });

  it("still stores the plan when logging a rejection fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await queueZucchini();
    reply(withoutNeeds());
    reply(zucchiniRaw());
    await client.exec("alter table conversation_logs rename to logs_gone");
    try {
      const outcome = await deriveAndStoreCookPlan(id);

      expect(outcome).toEqual({ plan: ZUCCHINI_PLAN, error: null });
      expect((await stored(id)).cookPlan).toEqual(ZUCCHINI_PLAN);
      expect(error).toHaveBeenCalledWith(
        `Could not log a rejected cook plan for cook-plan:${id}:`,
        expect.anything(),
      );
    } finally {
      await client.exec("alter table logs_gone rename to conversation_logs");
      error.mockRestore();
    }
  });

  it("stores a model error", async () => {
    const id = await queueZucchini();
    mockChat.mockRejectedValueOnce(new Error("quota exceeded"));

    const outcome = await deriveAndStoreCookPlan(id);

    expect(outcome).toEqual({ plan: null, error: "quota exceeded" });
    expect((await stored(id)).cookPlanError).toBe("quota exceeded");
  });

  it("retries after a failure and clears the error on success", async () => {
    const id = await queueZucchini();
    mockChat.mockRejectedValueOnce(new Error("quota exceeded"));
    await deriveAndStoreCookPlan(id);
    reply(zucchiniRaw());

    const outcome = await deriveAndStoreCookPlan(id);

    expect(outcome).toEqual({ plan: ZUCCHINI_PLAN, error: null });
    expect(await stored(id)).toEqual({
      cookPlan: ZUCCHINI_PLAN,
      cookPlanError: null,
    });
  });

  it("throws when storing the plan fails, rather than recording it as the plan's error", async () => {
    const id = await queueZucchini();
    reply(zucchiniRaw());
    // Refuses any write of a plan; a write of an error alone still goes through.
    await client.exec(`
      create function refuse_cook_plan() returns trigger language plpgsql as $$
      begin
        if new.cook_plan is not null then
          raise exception 'storage refused';
        end if;
        return new;
      end $$;
      create trigger refuse_cook_plan before update on kitchen_queue
        for each row execute function refuse_cook_plan();
    `);
    try {
      // drizzle wraps the database error as the cause of its "Failed query".
      await expect(deriveAndStoreCookPlan(id)).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringMatching(/storage refused/),
        }),
      });
    } finally {
      await client.exec(`
        drop trigger refuse_cook_plan on kitchen_queue;
        drop function refuse_cook_plan();
      `);
    }
    expect(await stored(id)).toEqual({ cookPlan: null, cookPlanError: null });
  });

  it("records a recipe with no steps without calling the model", async () => {
    const { id } = await addToKitchenQueue({
      recipeNotionId: "notion-123",
      targetUser: "cook",
    });

    const outcome = await deriveAndStoreCookPlan(id);

    expect(outcome.plan).toBeNull();
    expect(outcome.error).toMatch(/no steps/);
    expect(mockChat).not.toHaveBeenCalled();
    expect((await stored(id)).cookPlanError).toMatch(/no steps/);
  });

  // P decision 8: another attempt at the same text won't fix a settled
  // failure, so an open returns it rather than paying for the same refusal.
  it("returns a settled error without calling the model", async () => {
    const id = await queueZucchini();
    const settled = "rejected (uncovered-step): step 4 is in no task";
    await db.update(kitchenQueue).set({ cookPlanError: settled }).where(eq(kitchenQueue.id, id));

    expect(await deriveAndStoreCookPlan(id)).toEqual({ plan: null, error: settled });
    expect(await deriveAndStoreCookPlan(id)).toEqual({ plan: null, error: settled });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("retries a transient error once per call", async () => {
    const id = await queueZucchini();
    await db
      .update(kitchenQueue)
      .set({ cookPlanError: "Cook plan derivation timed out after 45 s" })
      .where(eq(kitchenQueue.id, id));
    reply(zucchiniRaw());

    expect(await deriveAndStoreCookPlan(id)).toEqual({ plan: ZUCCHINI_PLAN, error: null });
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("throws for a queue item that does not exist", async () => {
    await expect(
      deriveAndStoreCookPlan("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/not found/);
    expect(mockChat).not.toHaveBeenCalled();
  });

  describe("two derivations of one item at once", () => {
    it("keeps the first plan written, and both callers get it", async () => {
      const id = await queueZucchini();
      const finishSlow = deferredReply();
      const finishFast = deferredReply();
      const slow = deriveAndStoreCookPlan(id);
      const fast = deriveAndStoreCookPlan(id);
      await vi.waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));

      finishFast(variant("fast wins"));
      const fastOutcome = await fast;
      finishSlow(variant("slow loses"));
      const slowOutcome = await slow;

      const labels = (plan: CookPlan | null) => plan?.tasks.at(-1)?.label;
      expect(labels(fastOutcome.plan)).toBe("fast wins");
      expect(labels(slowOutcome.plan)).toBe("fast wins");
      expect(labels((await stored(id)).cookPlan ?? null)).toBe("fast wins");
    });

    it("never records a late failure over a stored plan", async () => {
      const id = await queueZucchini();
      const finishFailing = deferredReply();
      const finishOk = deferredReply();
      const failing = deriveAndStoreCookPlan(id);
      const ok = deriveAndStoreCookPlan(id);
      await vi.waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));

      finishOk(zucchiniRaw());
      await ok;
      reply({ tasks: "still not a list" });
      finishFailing({ tasks: "not a list" });
      const outcome = await failing;

      expect(outcome).toEqual({ plan: ZUCCHINI_PLAN, error: null });
      expect(await stored(id)).toEqual({
        cookPlan: ZUCCHINI_PLAN,
        cookPlanError: null,
      });
    });

    it("stores nothing for an item removed mid-derivation", async () => {
      const id = await queueZucchini();
      const finish = deferredReply();
      const pending = deriveAndStoreCookPlan(id);
      await vi.waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));

      await client.exec("delete from kitchen_queue");
      finish(zucchiniRaw());

      await expect(pending).rejects.toThrow(/not found/);
    });
  });

  it("never overwrites a plan from a newer version, but still returns a usable plan", async () => {
    const id = await queueZucchini();
    const newer = { ...ZUCCHINI_PLAN, version: COOK_PLAN_VERSION + 1 };
    await db.update(kitchenQueue).set({ cookPlan: newer });
    reply(zucchiniRaw());

    const outcome = await deriveAndStoreCookPlan(id);

    expect(outcome).toEqual({ plan: ZUCCHINI_PLAN, error: null });
    expect((await stored(id)).cookPlan).toEqual(newer);
  });
});

describe("prepareQueueItemInBackground", () => {
  it("stores the plan", async () => {
    const id = await queueZucchini();
    reply(zucchiniRaw());

    await prepareQueueItemInBackground(id);

    expect((await stored(id)).cookPlan).toEqual(ZUCCHINI_PLAN);
  });

  it("logs a failed derivation and resolves, leaving the error stored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await queueZucchini();
    mockChat.mockRejectedValueOnce(new Error("quota exceeded"));

    await expect(prepareQueueItemInBackground(id)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      `No cook plan for queue item ${id}: quota exceeded`,
    );
    expect((await stored(id)).cookPlanError).toBe("quota exceeded");
    warn.mockRestore();
  });

  it("logs a throw instead of rejecting", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = "00000000-0000-0000-0000-000000000000";

    await expect(prepareQueueItemInBackground(missing)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      `Preparing queue item ${missing} failed:`,
      expect.objectContaining({ message: expect.stringMatching(/not found/) }),
    );
    error.mockRestore();
  });
});

// scripts/backfill-cook-plans.ts reads this selection for its check-only
// listing (empty means it prints the deploy signal) and for --apply.
describe("selectCookPlanBackfill", () => {
  const SETTLED = "rejected (branch-ends-twice): the plan ends two branches";
  const TRANSIENT = "Cook plan derivation timed out after 45 s";

  async function withColumns(columns: Partial<typeof kitchenQueue.$inferInsert>): Promise<string> {
    const id = await queueZucchini();
    await db.update(kitchenQueue).set(columns).where(eq(kitchenQueue.id, id));
    return id;
  }

  // Rows queued in one millisecond tie on created_at, so compare as sets.
  const ids = (items: Array<{ id: string }>) => items.map((item) => item.id).sort();
  const sorted = (list: string[]) => [...list].sort();

  it("is empty with no open items, and ignores finished ones without a plan", async () => {
    expect(await selectCookPlanBackfill()).toEqual({ open: [], todo: [], settled: [] });

    await withColumns({ status: "completed" });
    await withColumns({ status: "cancelled", cookPlanError: TRANSIENT });
    expect(await selectCookPlanBackfill()).toEqual({ open: [], todo: [], settled: [] });
  });

  it("is empty when every open item has a current plan", async () => {
    await withColumns({ cookPlan: ZUCCHINI_PLAN });
    await withColumns({ status: "cooking", cookPlan: ZUCCHINI_PLAN });
    const selection = await selectCookPlanBackfill();
    expect(selection.open).toHaveLength(2);
    expect(selection.todo).toEqual([]);
    expect(selection.settled).toEqual([]);
  });

  it("lists an item with no plan, pending or cooking", async () => {
    const pending = await queueZucchini();
    const cooking = await withColumns({ status: "cooking" });
    expect(ids((await selectCookPlanBackfill()).todo)).toEqual(sorted([pending, cooking]));
  });

  it("lists an item whose plan is from an older version", async () => {
    const id = await withColumns({ cookPlan: { ...ZUCCHINI_PLAN, version: COOK_PLAN_VERSION - 1 } });
    expect(ids((await selectCookPlanBackfill()).todo)).toEqual([id]);
  });

  it("leaves out an item with a settled error, shown as settled", async () => {
    const id = await withColumns({ cookPlanError: SETTLED });
    const selection = await selectCookPlanBackfill();
    expect(selection.todo).toEqual([]);
    expect(ids(selection.settled)).toEqual([id]);
  });

  it("leaves out a settled error stored beside an older-version plan", async () => {
    const id = await withColumns({
      cookPlan: { ...ZUCCHINI_PLAN, version: COOK_PLAN_VERSION - 1 },
      cookPlanError: SETTLED,
    });
    const selection = await selectCookPlanBackfill();
    expect(selection.todo).toEqual([]);
    expect(ids(selection.settled)).toEqual([id]);
  });

  it("lists an item with a transient error: it needs work", async () => {
    const id = await withColumns({ cookPlanError: TRANSIENT });
    const selection = await selectCookPlanBackfill();
    expect(ids(selection.todo)).toEqual([id]);
    expect(selection.settled).toEqual([]);
  });

  it("lists exactly the items deriveAndStoreCookPlan calls the model for", async () => {
    const missing = await queueZucchini();
    const transient = await withColumns({ cookPlanError: TRANSIENT });
    const settled = await withColumns({ cookPlanError: SETTLED });
    const current = await withColumns({ cookPlan: ZUCCHINI_PLAN });
    const { open, todo } = await selectCookPlanBackfill();
    expect(ids(todo)).toEqual(sorted([missing, transient]));

    const called: string[] = [];
    for (const id of ids(open)) {
      const before = mockChat.mock.calls.length;
      reply(zucchiniRaw());
      await deriveAndStoreCookPlan(id);
      if (mockChat.mock.calls.length > before) called.push(id);
      mockChat.mockReset();
    }
    expect(sorted(called)).toEqual(sorted([missing, transient]));
    expect(ids(open)).toEqual(sorted([missing, transient, settled, current]));
    expect(await selectCookPlanBackfill()).toMatchObject({ todo: [] });
  });
});
