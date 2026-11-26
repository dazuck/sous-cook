import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { POST } from "./route";

// Mock webhook token auth
vi.mock("@/lib/kitchens/webhook-tokens", () => ({
  authenticateWebhookRequest: vi.fn(),
}));

vi.mock("@/lib/kitchens/packs", () => ({
  readVisibleKitchenPacks: vi.fn().mockResolvedValue([]),
}));

// Mock kitchen-queue module
vi.mock("@/lib/kitchen-queue", () => ({
  addToKitchenQueue: vi.fn(),
  prepareQueueItemInBackground: vi.fn(),
}));

// The model is the estimator's one external boundary (slice B4b). With no
// reply set, a call fails as it does with no key.
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  chat: vi.fn(),
}));

// after() needs a Next request scope, which a direct POST() call lacks.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

import { after } from "next/server";
import { chat } from "@/lib/ai";
import { authenticateWebhookRequest } from "@/lib/kitchens/webhook-tokens";
import {
  addToKitchenQueue,
  prepareQueueItemInBackground,
} from "@/lib/kitchen-queue";

const HOME_KITCHEN = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "home",
};
const HOME_AUTH = {
  ok: true as const,
  kitchen: HOME_KITCHEN,
  tokenId: "00000000-0000-4000-8000-000000000099",
};

/** What the route queued, per call: [kitchenId, input]. */
const queued = () => vi.mocked(addToKitchenQueue).mock.calls;

/** The smallest recipe the pack format reads: a name and one step. */
const TEST = { name: "Test", steps: ["Cook it."], serves: 2 };
const FAMILY_DINNER = { name: "Family Dinner", steps: ["Cook it."], serves: 4 };
const NO_LINES = {
  measured: 0,
  compound: 0,
  count: 0,
  to_taste: 0,
  unstated: 0,
  as_written: 0,
};

/**
 * A sending agent's payload: the recipe wrapped as `{"recipeData": …}`,
 * every key of the recipe filled.
 */
const AGENT_RECIPE = {
  name: "Weeknight harissa chicken",
  ingredients: [
    { item: "chicken thighs", amount: "2", unit: "lb" },
    { item: "harissa", amount: "3", unit: "tbsp" },
    { item: "lemons", amount: "2", unit: "" },
    { item: "salt, to taste", amount: "", unit: "" },
    { item: "olive oil", amount: "a glug", unit: "" },
    { item: "parsley", amount: "", unit: "" },
  ],
  steps: [
    "Heat the oven to 425F.",
    "Toss the chicken with the harissa and roast for 35 minutes.",
  ],
  estimatedTime: { active: 15, passive: 35, total: 50 },
  serves: 4,
  tags: ["weeknight"],
  notes: "Good with rice.",
  source: "https://example.com/harissa-chicken",
};
const AGENT_PAYLOAD = { recipeData: AGENT_RECIPE };

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost:3000/api/kitchen-queue", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-kitchen-token",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/kitchen-queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateWebhookRequest).mockResolvedValue(HOME_AUTH);
  });

  it("returns the token check's refusal response unchanged without queueing", async () => {
    const refusal = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    vi.mocked(authenticateWebhookRequest).mockResolvedValueOnce({
      ok: false,
      response: refusal,
    });

    const res = await POST(makeRequest({ recipeData: TEST }, {}));

    expect(res).toBe(refusal);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
    expect(addToKitchenQueue).not.toHaveBeenCalled();
  });

  it("accepts valid auth token", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "queue-123" });

    const res = await POST(
      makeRequest(
        { recipeData: TEST },
        { Authorization: "Bearer valid-token" },
      ),
    );

    expect(res.status).toBe(200);
  });

  it("queues for the token's kitchen", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "q-cook" });

    const res = await POST(makeRequest({ recipeData: FAMILY_DINNER }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      success: true,
      queueIds: ["q-cook"],
      conversion: NO_LINES,
    });
    expect(queued().map(([kitchenId]) => kitchenId)).toEqual([HOME_KITCHEN.id]);
  });

  it("refuses targetUser in the body with 400", async () => {
    const res = await POST(
      makeRequest({ targetUser: "cook", recipeData: FAMILY_DINNER }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "targetUser is no longer accepted: the token names the kitchen",
    });
    expect(queued()).toHaveLength(0);
  });

  it("derives a cook plan for the queued item after responding", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "q-cook" });

    await POST(makeRequest({ recipeData: FAMILY_DINNER }));

    expect(prepareQueueItemInBackground).not.toHaveBeenCalled();
    const scheduled = vi.mocked(after).mock.calls.map(([task]) => task);
    expect(scheduled).toHaveLength(1);
    for (const task of scheduled) {
      (task as () => unknown)();
    }
    expect(vi.mocked(prepareQueueItemInBackground).mock.calls).toEqual([
      [HOME_KITCHEN.id, "q-cook"],
    ]);
  });

  it("schedules nothing when queueing fails", async () => {
    vi.mocked(addToKitchenQueue).mockRejectedValue(new Error("db down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(makeRequest({ recipeData: TEST }));

    expect(res.status).toBe(500);
    expect(after).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("rejects bad input (no recipe data or notion id)", async () => {
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
  });

  it("accepts valid input with recipeData and queues it", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "queue-456" });

    const res = await POST(
      makeRequest({
        recipeData: {
          name: "Harissa Chicken",
          serves: 4,
          steps: ["Season chicken", "Roast at 425F"],
          ingredients: [{ item: "chicken", amount: "2", unit: "lbs" }],
          tags: ["spicy"],
          source: "https://example.com/recipe",
        },
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      success: true,
      queueIds: ["queue-456"],
      conversion: { ...NO_LINES, measured: 1 },
    });

    // An agent recipe asks for intake.
    expect(addToKitchenQueue).toHaveBeenCalledWith(HOME_KITCHEN.id, {
      recipeData: expect.objectContaining({ name: "Harissa Chicken" }),
      recipeNotionId: undefined,
      servesEstimate: undefined,
      intake: true,
    });
  });

  it("accepts valid input with recipeNotionId", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "queue-789" });

    const res = await POST(
      makeRequest({
        recipeNotionId: "abc123",
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, queueIds: ["queue-789"] });

    // No recipe to cut.
    expect(addToKitchenQueue).toHaveBeenCalledWith(HOME_KITCHEN.id, {
      recipeData: undefined,
      recipeNotionId: "abc123",
      servesEstimate: undefined,
      intake: false,
    });
  });
});

describe("POST /api/kitchen-queue: the recipe read as a pack recipe at queue time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateWebhookRequest).mockResolvedValue(HOME_AUTH);
  });

  it("an agent's queue-post payload: 200, stored as received, the response counts its lines", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "queue-oc" });

    const res = await POST(makeRequest(AGENT_PAYLOAD));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      queueIds: ["queue-oc"],
      conversion: {
        measured: 2,
        compound: 0,
        count: 1,
        to_taste: 1,
        unstated: 1,
        as_written: 1,
      },
    });
    // The legacy shape is what's stored; the pack recipe is read from it.
    expect(queued()).toEqual([
      [
        HOME_KITCHEN.id,
        {
          recipeData: AGENT_RECIPE,
          recipeNotionId: undefined,
          servesEstimate: undefined,
          intake: true,
        },
      ],
    ]);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "no steps and no ingredients",
      { name: "Nothing", steps: [], ingredients: [], serves: 2 },
      [
        {
          path: "(root)",
          message: "a recipe needs at least one ingredient or one step",
        },
      ],
    ],
    [
      "neither list at all",
      { name: "Nothing", serves: 2 },
      [
        {
          path: "(root)",
          message: "a recipe needs at least one ingredient or one step",
        },
      ],
    ],
    [
      "an empty name",
      { name: "", steps: ["Cook it."], serves: 2 },
      [
        {
          path: "title",
          message: "Too small: expected string to have >=1 characters",
        },
      ],
    ],
  ])(
    "a recipe the pack format refuses (%s): 422 with the issues, nothing queued",
    async (_case, recipeData, issues) => {
      const res = await POST(makeRequest({ recipeData }));

      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "Recipe can't be read as a pack recipe",
        issues,
      });
      expect(addToKitchenQueue).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
    },
  );

  it("refuses unreadable recipes before queueing", async () => {
    const res = await POST(
      makeRequest({ recipeData: { name: "Nothing", steps: [], serves: 2 } }),
    );

    expect(res.status).toBe(422);
    expect(addToKitchenQueue).not.toHaveBeenCalled();
  });

  it("preserves stepIngredients (indices or ingredient objects) while stripping unknown keys", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "queue-sx" });

    const res = await POST(
      makeRequest({
        ...AGENT_PAYLOAD,
        recipeData: {
          ...AGENT_RECIPE,
          stepIngredients: [[0, 1], [0]],
          cuisine: "North African",
        },
        sentBy: "agent",
      }),
    );

    expect(res.status).toBe(200);
    expect(queued()[0]![1].recipeData).toEqual({
      ...AGENT_RECIPE,
      stepIngredients: [[0, 1], [0]],
    });
  });

  it("resolves object stepIngredients against recipeData.ingredients when queued via webhook", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "queue-obj" });

    const res = await POST(
      makeRequest({
        ...AGENT_PAYLOAD,
        recipeData: {
          ...AGENT_RECIPE,
          stepIngredients: [
            [
              AGENT_RECIPE.ingredients[0]!,
              AGENT_RECIPE.ingredients[1]!,
            ],
            [AGENT_RECIPE.ingredients[0]!],
          ],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(queued()[0]![1].recipeData).toEqual({
      ...AGENT_RECIPE,
      stepIngredients: [[0, 1], [0]],
    });
  });

  it("a Notion id alone is not read: no conversion in the response", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "queue-n" });

    const res = await POST(makeRequest({ recipeNotionId: "abc123" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, queueIds: ["queue-n"] });
  });
});

describe("POST /api/kitchen-queue: the serving estimate (slice B4b)", () => {
  const UDON = {
    name: "Garlic udon",
    ingredients: [
      { item: "udon", amount: "2", unit: "packs" },
      { item: "soy sauce", amount: "3", unit: "tbsp" },
    ],
    steps: ["Boil the udon.", "Toss with the sauce."],
    source: "https://example.com/udon",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateWebhookRequest).mockResolvedValue(HOME_AUTH);
    vi.mocked(chat).mockRejectedValue(new Error("GOOGLE_AI_API_KEY is not set"));
  });

  it("a recipe that states its count: no call", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "q" });
    const res = await POST(makeRequest(AGENT_PAYLOAD));
    expect(res.status).toBe(200);
    expect(chat).not.toHaveBeenCalled();
    expect(queued()[0]![1].servesEstimate).toBeUndefined();
  });

  it("no count: one call, the estimate stored on the row, the recipe stored as received", async () => {
    vi.mocked(chat).mockResolvedValue({
      content: JSON.stringify({ basis: "2 packs udon: about 2 bowls.", serves: 2 }),
      finishReason: "stop",
    });
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "q-cook" });

    const res = await POST(makeRequest({ recipeData: UDON }));

    expect(res.status).toBe(200);
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(chat).mock.calls[0]![0].messages[0]!.content;
    expect(prompt).toContain("Amounts in the ingredient lines: yes.");
    expect(prompt).not.toContain("<<<"); // a URL source is not source text
    expect(queued().map(([kitchenId, input]) => [kitchenId, input.servesEstimate])).toEqual([
      [HOME_KITCHEN.id, { count: 2, basis: "2 packs udon: about 2 bowls." }],
    ]);
    expect(queued()[0]![1].recipeData).toEqual(UDON);
  });

  it("no count and no amounts: estimated from the dish, its basis saying so", async () => {
    vi.mocked(chat).mockResolvedValue({
      content: JSON.stringify({ basis: "From the dish alone: a tuna salad for two sandwiches.", serves: 2 }),
      finishReason: "stop",
    });
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "q" });
    const tuna = { name: "Tuna salad", ingredients: [{ item: "tuna" }, { item: "mayo" }], steps: ["Mix."] };

    const res = await POST(makeRequest({ recipeData: tuna }));

    expect(res.status).toBe(200);
    expect(vi.mocked(chat).mock.calls[0]![0].messages[0]!.content).toContain("Amounts in the ingredient lines: none.");
    expect(queued()[0]![1].servesEstimate).toEqual({
      count: 2,
      basis: "From the dish alone: a tuna salad for two sandwiches.",
    });
  });

  it("an estimate that can't be made: 503 with its reason, nothing queued, no stand-in count", async () => {
    const res = await POST(makeRequest({ recipeData: UDON }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Couldn't work out how many this serves, so nothing was queued",
      reason: "the estimate call failed: GOOGLE_AI_API_KEY is not set",
    });
    expect(addToKitchenQueue).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("a reply out of range is a failed estimate too", async () => {
    vi.mocked(chat).mockResolvedValue({
      content: JSON.stringify({ basis: "lots", serves: 60 }),
      finishReason: "stop",
    });
    const res = await POST(makeRequest({ recipeData: UDON }));
    expect(res.status).toBe(503);
    expect(addToKitchenQueue).not.toHaveBeenCalled();
  });

  it("a recipe refused for another reason: no call, 422 with both issues", async () => {
    const res = await POST(makeRequest({ recipeData: { name: "Nothing" } }));

    expect(res.status).toBe(422);
    expect(chat).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      error: "Recipe can't be read as a pack recipe",
      issues: [
        {
          path: "serves_base",
          message: "no serving count: the recipe states none, and Sous hasn't estimated one yet",
        },
        { path: "(root)", message: "a recipe needs at least one ingredient or one step" },
      ],
    });
  });
});

describe("POST /api/kitchen-queue: verbatim pack queueing & adapted pack attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateWebhookRequest).mockResolvedValue(HOME_AUTH);
  });

  it("queues a verbatim pack recipe via { packId, recipeId } with its pre-computed CookPlan", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "q-pack-1" });

    const res = await POST(
      makeRequest({
        packId: "fannie-farmer-1896",
        recipeId: "thin-white-sauce",
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      id: "q-pack-1",
      queueIds: ["q-pack-1"],
      name: "Thin White Sauce",
      source: "pack:fannie-farmer-1896/thin-white-sauce",
      mode: "native",
    });

    expect(addToKitchenQueue).toHaveBeenCalledTimes(1);
    const [kitchenIdArg, callArg] = vi.mocked(addToKitchenQueue).mock.calls[0]!;
    expect(kitchenIdArg).toBe(HOME_KITCHEN.id);
    expect(callArg.recipeData?.source).toBe(
      "pack:fannie-farmer-1896/thin-white-sauce",
    );
    expect(callArg.recipeData?.name).toBe("Thin White Sauce");
    expect(callArg.plan).toBeDefined();
    // Read through its pack, never cut.
    expect(callArg.intake).toBeUndefined();
    expect(after).not.toHaveBeenCalled();
  });

  it("queues a verbatim pack recipe via { pack: '<packId>/<recipeId>' } shorthand", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "q-pack-2" });

    const res = await POST(
      makeRequest({
        pack: "fannie-farmer-1896/waffles",
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.source).toBe("pack:fannie-farmer-1896/waffles");
    expect(body).not.toHaveProperty("targetUser");
    expect(body.mode).toBe("native");
  });

  it("returns 404 when queueing a pack recipe that is not on the shelf", async () => {
    const res = await POST(
      makeRequest({
        packId: "fannie-farmer-1896",
        recipeId: "no-such-recipe",
      }),
    );

    expect(res.status).toBe(404);
    expect(addToKitchenQueue).not.toHaveBeenCalled();
  });

  it("preserves valid source: 'pack:<packId>/<recipeId>' on adapted recipeData and appends creator_notes", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "q-adapted-1" });

    const res = await POST(
      makeRequest({
        recipeData: {
          name: "Thin White Sauce (with Gruyere)",
          serves: 2,
          ingredients: [
            { item: "Butter", amount: "2", unit: "tbsp" },
            { item: "Flour", amount: "1.5", unit: "tbsp" },
            { item: "Milk", amount: "1", unit: "cup" },
            { item: "Gruyere, grated", amount: "0.5", unit: "cup" },
          ],
          steps: [
            "Melt the butter in a saucepan over low heat.",
            "Whisk in the flour and milk until smooth, then stir in the Gruyere.",
          ],
          notes: "Adapted for pasta night.",
          source: "pack:fannie-farmer-1896/thin-white-sauce",
        },
      }),
    );

    expect(res.status).toBe(200);
    const stored = queued()[0]![1].recipeData!;
    expect(stored.source).toBe("pack-adapted:fannie-farmer-1896/thin-white-sauce");
    // An adapted pack recipe is read through its pack too: no intake.
    expect(queued()[0]![1].intake).toBe(false);
    expect(stored.notes).toContain("Adapted for pasta night.");
    expect(stored.notes).toContain(
      "The ingredient list calls for the milk already scalded",
    );
  });

  it("strips unresolvable source: 'pack:fake/dish' deterministically before storing", async () => {
    vi.mocked(addToKitchenQueue).mockResolvedValue({ id: "q-stripped" });

    const res = await POST(
      makeRequest({
        recipeData: {
          ...AGENT_RECIPE,
          source: "pack:fake-pack/fake-dish",
        },
      }),
    );

    expect(res.status).toBe(200);
    const stored = queued()[0]![1].recipeData!;
    expect(stored.source).toBeUndefined();
    // With its pack source gone it is an agent recipe like any other.
    expect(queued()[0]![1].intake).toBe(true);
  });
});

