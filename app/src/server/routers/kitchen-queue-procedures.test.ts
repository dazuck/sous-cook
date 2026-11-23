/**
 * The kitchen-queue procedures' cook-plan wiring: adds schedule a derivation
 * with `after()` instead of running it inline, and `ensureCookPlan` runs one
 * now. The derivation itself is tested in `kitchen-queue-cook-plan.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Every hook reads connected, as in a kitchen that has them: these cases
// send from the household book, which only a connected recipe library draws.
vi.mock("../../lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../../lib/hooks/types");
  return { connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, true])) };
});

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

vi.mock("../../lib/kitchen-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/kitchen-queue")>()),
  addToKitchenQueue: vi.fn(),
  getQueueItem: vi.fn(),
  cookPlanForCook: vi.fn(),
  ensureIntakeForCook: vi.fn(),
  prepareQueueItemInBackground: vi.fn(),
}));

// The model is the estimator's one external boundary (slice B4b). With no
// reply set, a call fails as it does with no key.
vi.mock("../../lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai")>()),
  chat: vi.fn(),
}));

vi.mock("../../lib/recipe-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/recipe-sync")>()),
  getDocRecipeBySlug: vi.fn(),
}));

import { after } from "next/server";
import {
  addToKitchenQueue,
  cookPlanForCook,
  ensureIntakeForCook,
  prepareQueueItemInBackground,
  getQueueItem,
  type KitchenQueueItem,
} from "../../lib/kitchen-queue";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { getDocRecipeBySlug, type DocRecipeRow } from "../../lib/recipe-sync";
import { chat } from "../../lib/ai";
import { sourceHash } from "../../lib/serves-estimate-plan";
import { appRouter } from "./_app";

const caller = appRouter.createCaller({ db: {} as never });
const QUEUE_ID = "3f1c2a9e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

/** Runs what the procedure handed to `after()`, as Next would post-response. */
function runScheduled(): void {
  for (const [task] of vi.mocked(after).mock.calls) {
    (task as () => unknown)();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chat).mockRejectedValue(new Error("GOOGLE_AI_API_KEY is not set"));
  vi.mocked(getQueueItem).mockResolvedValue(queueRow({}));
});

describe("addToKitchenQueue", () => {
  it("returns the new item and derives its plan after the response", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: QUEUE_ID });

    const result = await caller.addToKitchenQueue({
      recipeData: { name: "Dal", steps: ["Simmer the dal."], serves: 4 },
      targetUser: "cook",
    });

    expect(result).toEqual({ id: QUEUE_ID });
    expect(after).toHaveBeenCalledTimes(1);
    expect(prepareQueueItemInBackground).not.toHaveBeenCalled();
    runScheduled();
    expect(prepareQueueItemInBackground).toHaveBeenCalledWith(QUEUE_ID);
  });

  it("schedules nothing when the add fails", async () => {
    vi.mocked(addToKitchenQueue).mockRejectedValue(new Error("db down"));

    await expect(
      caller.addToKitchenQueue({ recipeNotionId: "n-1", targetUser: "cook" }),
    ).rejects.toThrow(/db down/);
    expect(after).not.toHaveBeenCalled();
  });
});

describe("queueFromPack: the household pack (the library row, as sendDocRecipeToQueue did)", () => {
  it("derives the queued recipe's plan after the response", async () => {
    vi.mocked(getDocRecipeBySlug).mockResolvedValue({
      slug: "dal",
      name: "Dal",
      ingredients: [],
      steps: ["Simmer the dal."],
      serves: 4,
      extractionError: null,
    } as unknown as DocRecipeRow);
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: QUEUE_ID });

    const result = await caller.queueFromPack({ packId: "household-book", recipeId: "dal", targetUser: "cook-2" });

    expect(result).toEqual({ id: QUEUE_ID });
    runScheduled();
    expect(prepareQueueItemInBackground).toHaveBeenCalledWith(QUEUE_ID);
  });
});

// B4 fix round 1, MED 3: the app's own adds read the recipe as a pack recipe
// before queueing it, as the webhook does, so a recipe the cook page couldn't
// read is refused where the sender sees it, not queued to fail at the counter.
describe("the pack-recipe check on adds", () => {
  // Fix round 2: a blank stored line is skipped on read, so only a recipe left
  // with neither steps nor ingredients after that is refused (P27).
  it("addToKitchenQueue refuses a recipe the format can't read, queueing nothing", async () => {
    const refused = caller.addToKitchenQueue({
      recipeData: { name: "Dal", steps: ["", "  "], ingredients: [{ item: " " }], serves: 4 },
      targetUser: "cook",
    });
    await expect(refused).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      message:
        "Recipe can't be read as a pack recipe: (root): a recipe needs at least one ingredient or one step",
    });
    expect(addToKitchenQueue).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("addToKitchenQueue queues a Notion id alone without a check (no recipe to read)", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: QUEUE_ID });
    await expect(
      caller.addToKitchenQueue({ recipeNotionId: "n-1", targetUser: "cook" }),
    ).resolves.toEqual({ id: QUEUE_ID });
  });

  it("queueFromPack refuses a library recipe the format can't read, queueing nothing", async () => {
    vi.mocked(getDocRecipeBySlug).mockResolvedValue({
      slug: "dal",
      name: "Dal",
      ingredients: [{ item: "" }],
      steps: [" "],
      serves: 4,
      extractionError: null,
    } as unknown as DocRecipeRow);

    await expect(
      caller.queueFromPack({ packId: "household-book", recipeId: "dal", targetUser: "cook-2" }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      message:
        "Recipe can't be read as a pack recipe: (root): a recipe needs at least one ingredient or one step",
    });
    expect(addToKitchenQueue).not.toHaveBeenCalled();
  });

  // Fix round 2: main cooks a library recipe with a blank step or item, so the
  // check must not refuse one; the blank line carries nothing and is skipped.
  const WITH_BLANKS = {
    slug: "dal",
    name: "Dal",
    ingredients: [
      { item: "red lentils", amount: "1", unit: "cup" },
      { item: "  ", amount: "", unit: "" },
      { item: "garlic", amount: "3", unit: "cloves" },
    ],
    steps: ["Rinse the lentils.", "", "Simmer for 20 minutes.", "   "],
    serves: 4,
    extractionError: null,
  };

  it("queueFromPack queues a library recipe with a blank step and a blank item", async () => {
    vi.mocked(getDocRecipeBySlug).mockResolvedValue(WITH_BLANKS as unknown as DocRecipeRow);
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: QUEUE_ID });

    await expect(
      caller.queueFromPack({ packId: "household-book", recipeId: "dal", targetUser: "cook-2" }),
    ).resolves.toEqual({ id: QUEUE_ID });
    // Queued as stored: the blank lines are skipped on read, never rewritten.
    expect(vi.mocked(addToKitchenQueue).mock.calls[0]?.[0]).toMatchObject({
      recipeData: { ingredients: WITH_BLANKS.ingredients, steps: WITH_BLANKS.steps },
    });
  });

  it("addToKitchenQueue queues a recipe with a blank step and a blank item", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: QUEUE_ID });
    await expect(
      caller.addToKitchenQueue({
        recipeData: {
          name: "Dal",
          ingredients: WITH_BLANKS.ingredients,
          steps: WITH_BLANKS.steps,
          serves: 4,
        },
        targetUser: "cook",
      }),
    ).resolves.toEqual({ id: QUEUE_ID });
  });

  it("the same row, already queued, opens with every line past the blanks under its stored id", async () => {
    vi.mocked(getQueueItem).mockResolvedValue(
      queueRow({
        recipeData: {
          name: "Dal",
          ingredients: WITH_BLANKS.ingredients,
          steps: WITH_BLANKS.steps,
          serves: 4,
          stepIngredients: [[0], [], [0, 1, 2], []],
          source: "library",
        },
      }),
    );

    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });

    expect(item?.conversionError).toBeNull();
    expect(item?.packRecipe?.ingredients.map((i) => [i.id, i.name])).toEqual([
      ["ing-0", "red lentils"],
      ["ing-2", "garlic"],
    ]);
    expect(
      item?.packRecipe?.steps.map((s) => [s.id, s.timer_sec, s.ingredient_refs ?? null]),
    ).toEqual([
      ["step-0", null, ["ing-0"]],
      ["step-2", 1200, ["ing-0", "ing-2"]],
    ]);
  });
});

describe("ensureCookPlan", () => {
  it("asks for the cook's plan now (none while intake is waiting) and returns the outcome", async () => {
    const outcome = { plan: null, error: "rejected (cycle): a -> b -> a" };
    vi.mocked(cookPlanForCook).mockResolvedValue(outcome);

    await expect(caller.ensureCookPlan({ queueId: QUEUE_ID })).resolves.toEqual(
      outcome,
    );
    expect(cookPlanForCook).toHaveBeenCalledWith(QUEUE_ID);
    expect(after).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a uuid without deriving", async () => {
    await expect(caller.ensureCookPlan({ queueId: "abc" })).rejects.toThrow();
    expect(cookPlanForCook).not.toHaveBeenCalled();
  });
});

/** A stored queue row, as `getQueueItem` returns it. */
function queueRow(
  over: Partial<
    Pick<
      KitchenQueueItem,
      | "recipeData"
      | "recipeNotionId"
      | "servesEstimate"
      | "servesEstimateBasis"
      | "intakeRecipe"
      | "intakeError"
      | "intakeSourceHash"
    >
  >,
): KitchenQueueItem {
  return {
    id: QUEUE_ID,
    recipeNotionId: null,
    recipeData: null,
    targetUser: "cook",
    status: "pending",
    createdAt: "2026-10-05T09:00:00.000Z",
    cookPlan: null,
    cookPlanError: null,
    startedAt: null,
    completedAt: null,
    cookLog: null,
    cookLogError: null,
    cookLogClaimedAt: null,
    ratingClosedAt: null,
    servesEstimate: null,
    servesEstimateBasis: null,
    servesEstimateSourceHash: null,
    intakeRecipe: null,
    intakeError: null,
    intakeSourceHash: null,
    intakeStamp: null,
    intakeAttempts: null,
    intakeNudges: null,
    finishedBy: null,
    lastScreenActiveAt: null,
    lastInteractionAt: null,
    ...over,
  };
}

/** A library recipe queued by `queueFromPack` from the household pack: it has a mapping. */
const LIBRARY_DATA: KitchenQueueRecipeData = {
  name: "Dal",
  ingredients: [
    { item: "red lentils", amount: "1", unit: "cup" },
    { item: "garlic", amount: "3", unit: "cloves" },
    { item: "salt, to taste" },
  ],
  steps: [
    "Rinse the lentils.",
    "Simmer the lentils with the garlic for 20 minutes, then salt.",
  ],
  estimatedTime: { active: 10, passive: 20, total: 30 },
  serves: 4,
  tags: ["weeknight"],
  notes: "Better the next day.",
  stepIngredients: [[0], [0, 1, 2]],
  source: "library",
};

describe("getKitchenQueueItem: the stored recipe read as a pack recipe", () => {
  it("a library row: its pack recipe, under the row's id, with the mapping's refs", async () => {
    const row = queueRow({ recipeData: LIBRARY_DATA });
    vi.mocked(getQueueItem).mockResolvedValue(row);

    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });

    expect(item).toEqual({
      ...row,
      packRecipe: {
        id: QUEUE_ID,
        title: "Dal",
        serves_base: 4,
        time_active_min: 10,
        time_total_min: 30,
        tags: ["weeknight"],
        ingredients: [
          {
            id: "ing-0",
            name: "red lentils",
            qty_canonical: { volume_ml: expect.closeTo(236.59, 2) },
            display_equivalents: { imperial: { unit: "cup", amount: 1 } },
          },
          {
            id: "ing-1",
            name: "garlic",
            qty_canonical: {
              count: 3,
              count_unit: { one: "clove", other: "cloves" },
            },
          },
          {
            id: "ing-2",
            name: "salt, to taste",
            qty_canonical: { to_taste: true },
          },
        ],
        steps: [
          {
            id: "step-0",
            type: "action",
            text: "Rinse the lentils.",
            timer_sec: null,
            ingredient_refs: ["ing-0"],
          },
          {
            id: "step-1",
            type: "action",
            text: "Simmer the lentils with the garlic for 20 minutes, then salt.",
            timer_sec: 1200,
            ingredient_refs: ["ing-0", "ing-1", "ing-2"],
          },
        ],
        creator_notes: ["Better the next day."],
      },
      conversionError: null,
      // Not a `pack:` row, so read as stored (slice B5d).
      reading: "projection",
      scales: true,
      library: { states: [], commons: [] },
      intake: { state: "none", error: null },
    });
    // The stored row is read, never changed.
    expect(row.recipeData).toEqual(LIBRARY_DATA);
  });

  it("a webhook row: no mapping, so no step has refs", async () => {
    vi.mocked(getQueueItem).mockResolvedValue(
      queueRow({
        recipeData: {
          name: "Webhook stew",
          ingredients: [{ item: "carrots", amount: "2" }],
          steps: ["Chop the carrots.", "Simmer."],
          source: "https://example.com/stew",
        },
        servesEstimate: 2,
        servesEstimateBasis: "2 carrots: a small stew for 2.",
      }),
    );

    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });

    expect(item?.conversionError).toBeNull();
    expect(item?.packRecipe?.ingredients).toEqual([
      { id: "ing-0", name: "carrots", qty_canonical: { count: 2 } },
    ]);
    expect(item?.packRecipe?.steps).toEqual([
      {
        id: "step-0",
        type: "action",
        text: "Chop the carrots.",
        timer_sec: null,
      },
      { id: "step-1", type: "action", text: "Simmer.", timer_sec: null },
    ]);
    // No stated count: Sous's estimate from beside the row, marked.
    expect(item?.packRecipe?.serves_base).toBe(2);
    expect(item?.packRecipe?.serves_estimated).toBe(true);
  });

  it("an import row (pasted): read the same way, its mapping kept", async () => {
    vi.mocked(getQueueItem).mockResolvedValue(
      queueRow({ recipeData: { ...LIBRARY_DATA, source: "pasted" } }),
    );

    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });

    expect(item?.conversionError).toBeNull();
    expect(item?.packRecipe?.steps.map((s) => s.ingredient_refs)).toEqual([
      ["ing-0"],
      ["ing-0", "ing-1", "ing-2"],
    ]);
  });

  it.each([
    [
      "the format refuses it (no steps, no ingredients)",
      { name: "Nothing", steps: [], ingredients: [], serves: 2 },
      "(root): a recipe needs at least one ingredient or one step",
    ],
    [
      "the format refuses it (an empty name)",
      { name: "", steps: ["Cook it."], serves: 2 },
      "title: Too small: expected string to have >=1 characters",
    ],
    [
      "no stated count and no estimate beside it",
      { name: "Stew", steps: ["Cook it."] },
      "serves_base: no serving count: the recipe states none, and Sous hasn't estimated one yet",
    ],
    [
      "the stored row isn't the recipe shape (a numeric amount)",
      {
        name: "Odd",
        ingredients: [{ item: "eggs", amount: 2 }],
        steps: ["Cook."],
      },
      "recipe row unreadable: ingredients.0.amount: Invalid input: expected string, received number",
    ],
  ])(
    "a row whose recipe can't be read (%s): no pack recipe, the reason given and logged",
    async (_case, recipeData, reason) => {
      const row = queueRow({
        recipeData: recipeData as unknown as KitchenQueueRecipeData,
      });
      vi.mocked(getQueueItem).mockResolvedValue(row);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });

      expect(item).toEqual({
        ...row,
        packRecipe: null,
        conversionError: reason,
        reading: "projection",
        scales: true,
        library: { states: [], commons: [] },
        intake: { state: "none", error: null },
      });
      expect(error.mock.calls).toEqual([
        [
          `[queue] item ${QUEUE_ID}: can't read its recipe as a pack recipe: ${reason}`,
        ],
      ]);
      error.mockRestore();
    },
  );

  it("a row queued by Notion id alone: nothing to read, no reason", async () => {
    const row = queueRow({ recipeNotionId: "notion-abc" });
    vi.mocked(getQueueItem).mockResolvedValue(row);
    const error = vi.spyOn(console, "error");

    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });

    expect(item).toEqual({
      ...row,
      packRecipe: null,
      conversionError: null,
      reading: "projection",
      scales: true,
      library: { states: [], commons: [] },
      intake: { state: "none", error: null },
    });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("an id with no row: null, as before", async () => {
    vi.mocked(getQueueItem).mockResolvedValue(null);

    await expect(
      caller.getKitchenQueueItem({ queueId: QUEUE_ID }),
    ).resolves.toBeNull();
  });
});

// Cook-fidelity plan: the cook meets intake's cut when there is one.
describe("getKitchenQueueItem: the recipe the cook meets", () => {
  const SENT: KitchenQueueRecipeData = {
    name: "Toast",
    ingredients: [{ item: "bread, butter", amount: "2" }],
    steps: ["Toast the bread and butter it."],
    serves: 2,
  };
  const CUT: KitchenQueueRecipeData = {
    ...SENT,
    ingredients: [{ item: "bread", amount: "2" }, { item: "butter" }],
    steps: ["Toast the bread.", "Butter it."],
    stepIngredients: [[0], [1]],
  };
  const asked = { recipeData: SENT, intakeSourceHash: sourceHash("kitchen_queue", SENT) };

  it("a cut: the recipe and pack recipe are the cut's", async () => {
    vi.mocked(getQueueItem).mockResolvedValue(queueRow({ ...asked, intakeRecipe: CUT }));

    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });

    expect(item?.recipeData).toEqual(CUT);
    expect(item?.packRecipe?.steps.map((s) => [s.text, s.ingredient_refs])).toEqual([
      ["Toast the bread.", ["ing-0"]],
      ["Butter it.", ["ing-1"]],
    ]);
    expect(item?.intake).toEqual({ state: "normalized", error: null });
  });

  it("an intake that failed: the recipe as sent, the reason beside it, and no log line on every read", async () => {
    vi.mocked(getQueueItem).mockResolvedValue(queueRow({ ...asked, intakeError: "quota exceeded" }));
    const warn = vi.spyOn(console, "warn");

    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });

    expect(item?.recipeData).toEqual(SENT);
    expect(item?.packRecipe?.steps.map((s) => s.text)).toEqual(["Toast the bread and butter it."]);
    expect(item?.intake).toEqual({ state: "as-sent", error: "quota exceeded" });
    // Intake logs its outcome once, when it stores it ([intake]); a read doesn't.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still waiting: the recipe as sent, marked pending, no warning", async () => {
    vi.mocked(getQueueItem).mockResolvedValue(queueRow(asked));
    const warn = vi.spyOn(console, "warn");

    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });

    expect(item?.recipeData).toEqual(SENT);
    expect(item?.intake).toEqual({ state: "pending", error: null });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("ensureIntake", () => {
  const SENT: KitchenQueueRecipeData = {
    name: "Toast",
    ingredients: [{ item: "bread, butter", amount: "2" }],
    steps: ["Toast the bread and butter it."],
    serves: 2,
  };
  const CUT: KitchenQueueRecipeData = {
    ...SENT,
    ingredients: [{ item: "bread", amount: "2" }, { item: "butter" }],
    steps: ["Toast the bread.", "Butter it."],
    stepIngredients: [[0], [1]],
  };
  const asked = { recipeData: SENT, intakeSourceHash: sourceHash("kitchen_queue", SENT) };

  it("runs it now, as the page asks, and answers with the row its write stored: the cut, read for the cook", async () => {
    vi.mocked(getQueueItem).mockResolvedValueOnce(queueRow(asked));
    vi.mocked(ensureIntakeForCook).mockResolvedValue({
      intake: { state: "normalized", recipe: CUT, error: null },
      item: queueRow({ ...asked, intakeRecipe: CUT }),
    });

    const item = await caller.ensureIntake({ queueId: QUEUE_ID, ask: "opening" });

    expect(ensureIntakeForCook).toHaveBeenCalledWith(QUEUE_ID, "opening");
    expect(item.recipeData).toEqual(CUT);
    expect(item.packRecipe?.steps.map((s) => s.text)).toEqual(["Toast the bread.", "Butter it."]);
    expect(item.intake).toEqual({ state: "normalized", error: null });
  });

  // Round-4 review, H1: a read after the write could fail and turn a stored
  // cut into the page's "shown as written". The answer is the write's row.
  it("reads nothing after the write: a read that would fail then doesn't fail the answer", async () => {
    vi.mocked(getQueueItem)
      .mockResolvedValueOnce(queueRow(asked))
      .mockRejectedValue(new Error("connection reset"));
    vi.mocked(ensureIntakeForCook).mockResolvedValue({
      intake: { state: "normalized", recipe: CUT, error: null },
      item: queueRow({ ...asked, intakeRecipe: CUT }),
    });

    const item = await caller.ensureIntake({ queueId: QUEUE_ID, ask: "opening" });

    expect(getQueueItem).toHaveBeenCalledTimes(1);
    expect(item.recipeData).toEqual(CUT);
    expect(item.intake.state).toBe("normalized");
  });

  it("a cook already under way: passed on as such, and the item answers as sent", async () => {
    vi.mocked(getQueueItem).mockResolvedValueOnce(queueRow(asked));
    vi.mocked(ensureIntakeForCook).mockResolvedValue({
      intake: { state: "as-sent", recipe: SENT, error: "x" },
      item: queueRow({ ...asked, intakeError: "the cook started on the recipe as sent before intake landed" }),
    });

    const item = await caller.ensureIntake({ queueId: QUEUE_ID, ask: "started" });

    expect(ensureIntakeForCook).toHaveBeenCalledWith(QUEUE_ID, "started");
    expect(item.intake.state).toBe("as-sent");
    expect(item.recipeData).toEqual(SENT);
  });

  it("an id with no row: NOT_FOUND, nothing run", async () => {
    vi.mocked(getQueueItem).mockResolvedValue(null);
    await expect(caller.ensureIntake({ queueId: QUEUE_ID, ask: "opening" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(ensureIntakeForCook).not.toHaveBeenCalled();
  });
});

// Slice B4b: a recipe that states no serving count gets Sous's estimate before
// the queue-time check, stored beside it; a library send carries the library
// row's and never calls the model.
describe("the serving estimate on adds (slice B4b)", () => {
  const STEW = {
    name: "Stew",
    ingredients: [{ item: "carrots", amount: "4" }, { item: "beef", amount: "1", unit: "lb" }],
    steps: ["Brown the beef.", "Simmer with the carrots for 2 hours."],
  };

  it("addToKitchenQueue: no count, one call, the estimate stored beside the recipe", async () => {
    vi.mocked(chat).mockResolvedValue({
      content: JSON.stringify({ basis: "1 lb beef and 4 carrots: about 3 bowls.", serves: 3 }),
      finishReason: "stop",
    });
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: QUEUE_ID });

    await caller.addToKitchenQueue({ recipeData: STEW, targetUser: "cook" });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addToKitchenQueue).mock.calls[0]![0]).toEqual({
      recipeNotionId: undefined,
      recipeData: STEW,
      targetUser: "cook",
      servesEstimate: { count: 3, basis: "1 lb beef and 4 carrots: about 3 bowls." },
    });
  });

  it("addToKitchenQueue: an estimate that can't be made refuses the add, queueing nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      caller.addToKitchenQueue({ recipeData: STEW, targetUser: "cook" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Couldn't work out how many this serves, so nothing was queued: the estimate call failed: GOOGLE_AI_API_KEY is not set",
    });
    expect(addToKitchenQueue).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("addToKitchenQueue: a stated count, no call", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: QUEUE_ID });
    await caller.addToKitchenQueue({ recipeData: { ...STEW, serves: 6 }, targetUser: "cook" });
    expect(chat).not.toHaveBeenCalled();
    expect(vi.mocked(addToKitchenQueue).mock.calls[0]![0].servesEstimate).toBeUndefined();
  });

  it("queueFromPack: the library row's estimate travels byte for byte, no call", async () => {
    vi.mocked(getDocRecipeBySlug).mockResolvedValue({
      ...STEW,
      docSlug: "stew",
      serves: null,
      servesEstimate: 3,
      servesEstimateBasis: "1 lb beef and 4 carrots: about 3 bowls.",
      extractionError: null,
    } as unknown as DocRecipeRow);
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: QUEUE_ID });

    await caller.queueFromPack({ packId: "household-book", recipeId: "stew", targetUser: "cook-2" });

    expect(chat).not.toHaveBeenCalled();
    expect(vi.mocked(addToKitchenQueue).mock.calls[0]![0].servesEstimate).toEqual({
      count: 3,
      basis: "1 lb beef and 4 carrots: about 3 bowls.",
    });
  });

  it("queueFromPack: no count and no estimate is refused, never estimated", async () => {
    vi.mocked(getDocRecipeBySlug).mockResolvedValue({
      ...STEW,
      docSlug: "stew",
      serves: null,
      servesEstimate: null,
      servesEstimateBasis: null,
      extractionError: null,
    } as unknown as DocRecipeRow);

    await expect(
      caller.queueFromPack({ packId: "household-book", recipeId: "stew", targetUser: "cook-2" }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      message:
        "Recipe can't be read as a pack recipe: serves_base: no serving count: the recipe states none, and Sous hasn't estimated one yet",
    });
    expect(chat).not.toHaveBeenCalled();
    expect(addToKitchenQueue).not.toHaveBeenCalled();
  });
});
