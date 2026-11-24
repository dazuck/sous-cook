/**
 * The webhook end to end against a real Postgres (PGlite, in memory): the
 * POST, the insert, the queue-time intake and plan that `after()` runs, and
 * the cook page's read of the row (round-3 review, C5). Only the model call
 * is stubbed, and `after()` keeps its tasks for the test to run, as Next
 * would once the response is sent. `route.test.ts` covers the route's own
 * branches with the queue mocked.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { KitchenQueueRecipeData } from "../../../../drizzle/schema";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE, zucchiniRaw } from "@/lib/kitchen/__tests__/zucchini-wraps";

const scheduled: Array<() => unknown> = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((task: () => unknown) => scheduled.push(task)),
}));
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  chat: vi.fn(),
}));
vi.mock("@/lib/db", async () =>
  (await import("../../../lib/__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";
import {
  callerFor,
  homeKitchen,
  mintToken,
} from "@/lib/__tests__/kitchens";
import { POST } from "./route";

const client = (dbModule as unknown as { client: PGlite }).client;
const mockChat = chat as Mock;
let caller: ReturnType<typeof callerFor>;
let token: string;

/** A sending agent's recipe: a line naming two ingredients. */
const SENT: KitchenQueueRecipeData = { name: "Zucchini wraps", serves: 4, ...ZUCCHINI_RECIPE };
/** Intake's cut of it: the line split in its own words, each step's ingredients placed. */
const CUT: KitchenQueueRecipeData = {
  ...SENT,
  ingredients: (ZUCCHINI_RECIPE.ingredients ?? []).map((line, i) => (i === 0 ? { ...line, item: "green zucchini" } : line)),
  stepIngredients: [[0, 1, 2, 3], [4], [5], [], [6]],
};

interface ChatCall {
  systemPrompt?: string;
}

beforeAll(async () => {
  const home = await homeKitchen(db);
  caller = callerFor(home);
  token = await mintToken(db, home.id, "route-db-test");
});

beforeEach(async () => {
  vi.stubEnv("SOUS_SIGN_IN", "off");
  mockChat.mockReset();
  scheduled.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
  await client.exec("delete from kitchen_queue; delete from conversation_logs");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost:3000/api/kitchen-queue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Runs what the route handed to `after()`, as Next does once the response is sent. */
async function runScheduled(): Promise<void> {
  await Promise.all(scheduled.map((task) => task()));
}

describe("POST /api/kitchen-queue, through the database", () => {
  it("queues for the default cook; the row is cut and planned after the response, and the cook reads the cut", async () => {
    // The intake extraction has no system prompt; the plan call has one.
    mockChat.mockImplementation(async (options: ChatCall) =>
      options.systemPrompt === undefined
        ? {
            content: JSON.stringify({
              name: CUT.name,
              ingredients: CUT.ingredients,
              steps: CUT.steps,
              stepIngredients: CUT.stepIngredients,
            }),
            finishReason: "stop",
          }
        : { content: JSON.stringify(zucchiniRaw()), finishReason: "stop" },
    );

    const res = await post({ recipeData: SENT });

    expect(res.status).toBe(200);
    const { queueIds } = (await res.json()) as { queueIds: string[] };
    expect(queueIds).toHaveLength(1);
    expect((await caller.getKitchenQueue({})).map((row) => row.id)).toEqual(queueIds);
    // Nothing runs before the response: the row waits for intake.
    expect(mockChat).not.toHaveBeenCalled();
    for (const id of queueIds) {
      expect((await caller.getKitchenQueueItem({ queueId: id }))?.intake).toEqual({ state: "pending", error: null });
    }

    await runScheduled();

    for (const id of queueIds) {
      const item = await caller.getKitchenQueueItem({ queueId: id });
      expect(item?.intake).toEqual({ state: "normalized", error: null });
      expect(item?.recipeData).toEqual(CUT);
      expect(item?.packRecipe?.ingredients[0]?.name).toMatch(/green zucchini/);
      expect(item?.cookPlan).toEqual(ZUCCHINI_PLAN);
      expect([item?.intakeAttempts, item?.intakeNudges]).toEqual([1, []]);
    }
    // One intake call and one plan call for the row.
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it("a model down at queue time: the rows wait for intake with no plan, and the cook page's ask cuts it", async () => {
    mockChat.mockRejectedValue(Object.assign(new Error("503 overloaded"), { status: 503 }));

    const res = await post({ recipeData: SENT });
    const [id] = ((await res.json()) as { queueIds: string[] }).queueIds;
    await runScheduled();

    const waiting = await caller.getKitchenQueueItem({ queueId: id! });
    expect(waiting?.intake).toEqual({ state: "pending", error: "failed for now: 503 overloaded" });
    expect([waiting?.cookPlan, waiting?.cookPlanError]).toEqual([null, null]);

    mockChat.mockReset();
    mockChat.mockResolvedValue({
      content: JSON.stringify({ name: CUT.name, ingredients: CUT.ingredients, steps: CUT.steps, stepIngredients: CUT.stepIngredients }),
      finishReason: "stop",
    });
    const answer = await caller.ensureIntake({ queueId: id!, ask: "opening" });
    expect(answer.intake).toEqual({ state: "normalized", error: null });
    expect(answer.recipeData).toEqual(CUT);
  });
});
