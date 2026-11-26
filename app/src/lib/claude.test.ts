import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pack, Commons, States } from "@sous/pack";
import { COOK_PLAN_VERSION, type CookPlan } from "./kitchen/cook-plan";

const mockInsertValues = vi.fn().mockResolvedValue(undefined);
vi.mock("./db", () => ({
  db: {
    insert: () => ({
      values: mockInsertValues,
    }),
  },
  conversationLogs: {},
}));

const mockAiChat = vi.fn();
const mockGetConfig = vi.fn(() => ({
  textProvider: "google" as const,
  textModel: "gemini-3.5-flash",
  cookChatModel: "gemini-3.5-flash",
  visionProvider: "google" as const,
  visionModel: "gemini-2.5-flash",
}));
vi.mock("./ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai")>()),
  chat: (...args: unknown[]) => mockAiChat(...args),
  getConfig: () => mockGetConfig(),
}));

const mockGetQueueItem = vi.fn();
vi.mock("./kitchen-queue", () => ({
  getQueueItemForKitchen: (...args: unknown[]) => mockGetQueueItem(...args),
}));

const KITCHEN_ID = "00000000-0000-4000-8000-000000000001";

const mockLoadAppPackFiles = vi.fn();
vi.mock("./shelf/load", () => ({
  loadAppPackFiles: (...args: unknown[]) => mockLoadAppPackFiles(...args),
}));

const mockReadHouseholdContext = vi.fn<() => Promise<string>>().mockResolvedValue("");
const mockReadCookLog = vi.fn<() => Promise<string[][]>>().mockResolvedValue([
  ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
]);
vi.mock("./hooks/connected", async () => {
  const { HOOK_NAMES } = await import("./hooks/types");
  return {
    connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, false])),
  };
});
vi.mock("./hooks/registry", () => ({
  hook: (name: string) => {
    if (name === "household-context") return { read: mockReadHouseholdContext };
    if (name === "cook-log") return { read: mockReadCookLog };
    throw new Error(`Unexpected hook in claude.test: ${name}`);
  },
}));

import { connected } from "./hooks/connected";
import { HOOK_NAMES } from "./hooks/types";
import {
  COOKING_MAX_TOKENS,
  answerContent,
  chatCookingAssistant,
  parseActions,
} from "./claude";
import { AnswerCutOff } from "./kitchen/ask-failure";
import { packRecipeToQueueData } from "./pack-convert/to-queue";

describe("parseActions", () => {
  it("parses CREATE_TASK action from response", () => {
    const content = `Got it - I've added "Soak chickpeas overnight" to your list.

[ACTION:CREATE_TASK]{"task": "Soak chickpeas overnight", "owner": "Either", "dueDate": "2025-01-15", "category": "Prep", "recurrence": "One-time"}[/ACTION]`;

    const result = parseActions(content);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("create_task");
    expect(result.actions[0].data).toEqual({
      task: "Soak chickpeas overnight",
      owner: "Either",
      dueDate: "2025-01-15",
      category: "Prep",
      recurrence: "One-time",
    });
    expect(result.cleanContent).toBe(
      'Got it - I\'ve added "Soak chickpeas overnight" to your list.',
    );
  });

  it("parses COMPLETE_TASK action from response", () => {
    const content = `Nice! Crossing that off.

[ACTION:COMPLETE_TASK]{"taskId": "abc123"}[/ACTION]`;

    const result = parseActions(content);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("complete_task");
    expect(result.actions[0].data).toEqual({ taskId: "abc123" });
    expect(result.cleanContent).toBe("Nice! Crossing that off.");
  });

  it("parses UPDATE_TASK action from response", () => {
    const content = `I've updated the due date to January 20th.

[ACTION:UPDATE_TASK]{"taskId": "task123", "updates": {"dueDate": "2025-01-20"}}[/ACTION]`;

    const result = parseActions(content);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("update_task");
    expect(result.actions[0].data).toEqual({
      taskId: "task123",
      updates: { dueDate: "2025-01-20" },
    });
  });

  it("handles response with no actions", () => {
    const content = "Tomatoes, onions, and garlic would make a great base.";

    const result = parseActions(content);

    expect(result.actions).toHaveLength(0);
    expect(result.cleanContent).toBe(content);
  });

  it("handles multiple actions in one response", () => {
    const content = `I've created both tasks for you!

[ACTION:CREATE_TASK]{"task": "Task One", "owner": "Alex", "category": "Home", "recurrence": "One-time"}[/ACTION]

[ACTION:CREATE_TASK]{"task": "Task Two", "owner": "Sam", "category": "Pantry", "recurrence": "One-time"}[/ACTION]`;

    const result = parseActions(content);

    expect(result.actions).toHaveLength(2);
    const [first, second] = result.actions;
    expect(first.type).toBe("create_task");
    expect(second.type).toBe("create_task");
    if (first.type === "create_task" && second.type === "create_task") {
      expect(first.data.task).toBe("Task One");
      expect(second.data.task).toBe("Task Two");
    }
    expect(result.cleanContent).toBe("I've created both tasks for you!");
  });

  it("ignores malformed JSON but still strips the marker", () => {
    const content = `Something went wrong:

[ACTION:CREATE_TASK]{invalid json}[/ACTION]

But here's the plan anyway.`;

    const result = parseActions(content);

    expect(result.actions).toHaveLength(0);
    expect(result.cleanContent).toContain("Something went wrong:");
    expect(result.cleanContent).toContain("But here's the plan anyway.");
    expect(result.cleanContent).not.toContain("[ACTION:");
  });

  it("handles CREATE_TASK with minimal data", () => {
    const content = `Added!

[ACTION:CREATE_TASK]{"task": "Buy diapers"}[/ACTION]`;

    const result = parseActions(content);

    expect(result.actions).toHaveLength(1);
    const action = result.actions[0];
    expect(action.type).toBe("create_task");
    if (action.type === "create_task") {
      expect(action.data.task).toBe("Buy diapers");
      expect(action.data.owner).toBeUndefined();
      expect(action.data.dueDate).toBeUndefined();
    }
  });

  it("does not parse retired recipe action markers", () => {
    // SAVE_RECIPE / LOG_COOK are retired: unknown markers pass through untouched.
    const content = `Here you go!

[ACTION:SAVE_RECIPE]{"name": "Quick Pasta", "tags": ["Weeknight"]}[/ACTION]`;

    const result = parseActions(content);

    expect(result.actions).toHaveLength(0);
    expect(result.cleanContent).toBe(content);
  });

  it("resets regex state between calls", () => {
    const content = `Done.

[ACTION:COMPLETE_TASK]{"taskId": "xyz"}[/ACTION]`;

    expect(parseActions(content).actions).toHaveLength(1);
    expect(parseActions(content).actions).toHaveLength(1);
  });
});

describe("answerContent", () => {
  it("passes an answer that stopped normally through", () => {
    expect(answerContent({ content: "Use shallots.", finishReason: "stop" })).toBe(
      "Use shallots.",
    );
    // No finish reason at all: both providers always give one, so this is
    // ambiguous rather than a known failure, and it passes.
    expect(answerContent({ content: "Use shallots." })).toBe("Use shallots.");
  });

  it("throws AnswerCutOff on a reply cut at the token cap, rather than passing it off as whole", () => {
    let failure: unknown = null;
    try {
      answerContent({
        content: "Use shal",
        finishReason: "max_tokens",
        usage: { inputTokens: 900, outputTokens: 12 },
      });
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(AnswerCutOff);
    expect((failure as AnswerCutOff).outputTokens).toBe(12);
    expect((failure as Error).message).toMatch(/cut off at the token limit after 12 output tokens/);
    expect(() => answerContent({ content: "Use shal", finishReason: "max_tokens" })).toThrow(
      /cut off at the token limit$/,
    );
  });

  it("throws on any other finish that isn't a normal stop", () => {
    expect(() => answerContent({ content: "Use shal", finishReason: "other" })).toThrow(
      /ended without finishing \(other\)/,
    );
  });

  it("throws when the model withheld its answer, rather than showing it empty", () => {
    expect(() => answerContent({ content: "", finishReason: "blocked" })).toThrow(
      /declined/,
    );
    expect(() => answerContent({ content: "Partial", finishReason: "blocked" })).toThrow(
      /declined/,
    );
  });
});

describe("chatCookingAssistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const name of HOOK_NAMES) {
      connected[name] = false;
    }
    mockReadHouseholdContext.mockResolvedValue("");
    mockReadCookLog.mockResolvedValue([
      ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
    ]);
    mockGetConfig.mockReturnValue({
      textProvider: "google",
      textModel: "gemini-3.5-flash",
      cookChatModel: "gemini-2.5-flash-cook",
      visionProvider: "google",
      visionModel: "gemini-2.5-flash",
    });
    mockAiChat.mockResolvedValue({
      content: "Keep the heat medium-low until the butter foams.",
      finishReason: "stop",
      usage: { inputTokens: 120, outputTokens: 18 },
      sources: [{ title: "Serious Eats", url: "https://seriouseats.com/butter" }],
    });
  });

  it("uses Sous counter persona, safety rules, cookChatModel, COOKING_MAX_TOKENS, no thinking, and googleSearch", async () => {
    expect(COOKING_MAX_TOKENS).toBe(350);

    const res = await chatCookingAssistant(
      KITCHEN_ID,
      "cook-session-1",
      [{ role: "user", content: "Is 150°F okay for chicken?" }],
      "Roast Chicken",
    );

    expect(res.content).toBe("Keep the heat medium-low until the butter foams.");
    expect(res.sources).toEqual([
      { title: "Serious Eats", url: "https://seriouseats.com/butter" },
    ]);

    expect(mockAiChat).toHaveBeenCalledTimes(1);
    const call = mockAiChat.mock.calls[0][0];
    expect(call.model).toBe("gemini-2.5-flash-cook");
    expect(call.maxTokens).toBe(350);
    expect(call.thinkingBudget).toBe(0);
    expect(call.temperature).toBe(0.5);
    expect(call.googleSearch).toBe(true);

    // Sous persona & safety rules
    expect(call.systemPrompt).toContain("You are Sous");
    expect(call.systemPrompt).toContain("at most two sentences");
    expect(call.systemPrompt).toContain("74°C / 165°F");
    expect(call.systemPrompt).toContain("allergen");
    expect(call.systemPrompt).toContain("already scaled to the current serving size");
    expect(call.systemPrompt).toContain("No exclamation marks, no emoji");
  });

  it("with no hook connected (as shipped), answers with no household reference block", async () => {
    await chatCookingAssistant(
      KITCHEN_ID,
      "cook-session-unconnected",
      [{ role: "user", content: "Is 150°F okay for chicken?" }],
      "Roast Chicken",
    );

    const call = mockAiChat.mock.calls[0][0];
    expect(call.systemPrompt).toContain("<current_recipe>\nRoast Chicken\n</current_recipe>");
    expect(call.systemPrompt).not.toContain("<reference_info>");
  });

  it("includes household-context when non-empty and omits reference_info when empty", async () => {
    connected["household-context"] = true;
    mockReadHouseholdContext.mockResolvedValueOnce("   \n  ");

    await chatCookingAssistant(
      KITCHEN_ID,
      "cook-session-empty-ctx",
      [{ role: "user", content: "What can I add?" }],
      "Roast Chicken",
    );
    expect(mockAiChat.mock.calls[0][0].systemPrompt).not.toContain("<reference_info>");

    mockReadHouseholdContext.mockResolvedValueOnce("We avoid peanuts. Four of us.");
    await chatCookingAssistant(
      KITCHEN_ID,
      "cook-session-with-ctx",
      [{ role: "user", content: "What oil should I use?" }],
      "Stir Fry",
    );
    const call = mockAiChat.mock.calls[1][0];
    expect(call.systemPrompt).toContain("<reference_info>");
    expect(call.systemPrompt).toContain("Family context:\nWe avoid peanuts. Four of us.");
    const userLogCall = mockInsertValues.mock.calls.filter((c) => c[0]?.role === "user")[1];
    expect(String(userLogCall?.[0]?.context)).toContain("We avoid peanuts. Four of us.");
  });

  it("loads server recipe, creator, states/commons notes, cookPlan, and scaled [context] when queueId is provided", async () => {
    const testPack: Pack = {
      id: "pack-test",
      title: "Test Pack",
      version: "0.7.0",
      creator: {
        name: "Casey Hearthstone",
        bio: "Writes weeknight recipes",
        voice_notes: "Plain, practical, a little dry.",
      },
      recipes: [
        {
          id: "pan-salmon",
          title: "Crispy Pan Salmon",
          story: "Dry skin is the secret to crispiness.",
          serves_base: 2,
          ingredients: [
            {
              id: "ing-0",
              name: "salmon fillets",
              qty_canonical: { count: 2 },
              scaling: "linear",
            },
            {
              id: "ing-1",
              name: "kosher salt",
              qty_canonical: {
                mass_g: 6,
                salt_profile: "diamond_crystal",
              },
              display_equivalents: {
                imperial: { amount: 1, unit: "tsp" },
              },
              scaling: "linear",
            },
          ],
          steps: [
            {
              id: "step-0",
              type: "action",
              text: "Pat the salmon fillets dry and season with salt.",
              ingredient_refs: ["ing-0", "ing-1"],
              technique_refs: ["commons:dry-brine"],
              state_refs: [],
            },
            {
              id: "step-1",
              type: "checkpoint",
              text: "Sear skin-side down until 70% opaque up the sides.",
              timer_sec: 300,
              coach_hints: ["Skin releases cleanly and is shatteringly crisp."],
              ingredient_refs: [],
              technique_refs: [],
              state_refs: ["state:crispy-skin"],
            },
          ],
          creator_notes: ["Press the fillet flat for the first 15 seconds."],
        },
      ],
    };

    const commons: Commons = [
      {
        id: "commons:dry-brine",
        name: "Dry Brining",
        description: "Draws out surface moisture so skin browns quickly.",
      },
    ];
    const states: States = [
      {
        id: "state:crispy-skin",
        name: "Crispy Salmon Skin",
        sensory_notes: {
          look: "Golden-brown across the whole surface, opaque two-thirds up.",
          sound: "Steady gentle sizzle, not spitting.",
          smell: "Nutty, toasted fish skin.",
        },
      },
    ];

    const projected = packRecipeToQueueData(testPack.recipes[0], testPack.id);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const cookPlan: CookPlan = {
      version: COOK_PLAN_VERSION,
      tasks: [
        {
          id: "t0",
          kind: "mise",
          text: "Pat the salmon fillets dry and season with salt.",
          label: "season salmon",
          ingredientIdx: [0, 1],
          sourceStep: 0,
          implied: false,
          needs: [],
          branch: "Salmon",
        },
        {
          id: "t1",
          kind: "cook",
          text: "Sear skin-side down until 70% opaque up the sides.",
          label: "sear salmon",
          ingredientIdx: [],
          sourceStep: 1,
          implied: false,
          needs: ["t0"],
          minutes: { est: 5, handsOff: false },
          cue: "until 70% opaque up the sides",
          branch: "Salmon",
        },
      ],
    };

    mockGetQueueItem.mockResolvedValue({
      id: "q-salmon-1",
      targetUser: "cook",
      recipeData: projected.projection.recipeData,
      servesEstimate: projected.projection.servesEstimate?.count ?? null,
      servesEstimateBasis: projected.projection.servesEstimate?.basis ?? null,
      cookPlan,
    });
    mockLoadAppPackFiles.mockResolvedValue({
      packs: [testPack],
      libraries: { commons, states },
      errors: [],
    });

    await chatCookingAssistant(
      KITCHEN_ID,
      "cook-session-2",
      [{ role: "user", content: "How much salt and how do I know the skin is ready?" }],
      "Crispy Pan Salmon",
      {
        queueId: "q-salmon-1",
        servings: 4,
        servesBase: 2,
        currentStepIndex: 1,
        timers: [
          { id: "t-sear", label: "Sear skin", remainingSec: 95, status: "running" },
          { id: "t-rest", label: "Warm pan", remainingSec: -30, status: "expired" },
        ],
      },
    );

    const call = mockAiChat.mock.calls[0][0];
    // System prompt carries creator, headnote, steps, states sensory notes, commons, and cookPlan
    expect(call.systemPrompt).toContain("Crispy Pan Salmon");
    expect(call.systemPrompt).toContain("Dry skin is the secret to crispiness.");
    expect(call.systemPrompt).toContain("Casey Hearthstone");
    expect(call.systemPrompt).toContain("Plain, practical, a little dry.");
    expect(call.systemPrompt).toContain("Press the fillet flat for the first 15 seconds.");
    expect(call.systemPrompt).toContain("Golden-brown across the whole surface");
    expect(call.systemPrompt).toContain("Steady gentle sizzle");
    expect(call.systemPrompt).toContain("Nutty, toasted fish skin.");
    expect(call.systemPrompt).toContain("Draws out surface moisture");
    expect(call.systemPrompt).toContain("sear salmon");

    // Turn [context] is appended to the user message sent to aiChat
    const lastSentMsg = call.messages[call.messages.length - 1];
    expect(lastSentMsg.content).toContain("[context]");
    expect(lastSentMsg.content).toContain("serving scale: 2× (serves 4, base 2)");
    expect(lastSentMsg.content).toContain(
      "current step: step 2 (checkpoint) — Sear skin-side down until 70% opaque up the sides.",
    );
    expect(lastSentMsg.content).toContain("recent steps, oldest first: step 1");
    expect(lastSentMsg.content).toContain("timer t-sear (Sear skin): 1m 35s remaining");
    expect(lastSentMsg.content).toContain("timer t-rest (Warm pan): expired 30s ago");
    // Scaled quantities: 2x of 2 salmon fillets -> 4 salmon fillets; 2x of 1 tsp kosher salt -> 2 tsp kosher salt
    expect(lastSentMsg.content).toContain("4 salmon fillets");
    expect(lastSentMsg.content).toContain("2 tsp kosher salt");

    // conversation_logs records the raw user question without [context]
    const userLogCall = mockInsertValues.mock.calls.find(
      (c) => c[0]?.role === "user",
    );
    expect(userLogCall?.[0]?.content).toBe(
      "How much salt and how do I know the skin is ready?",
    );
  });

  describe("from a prep page (review round 3)", () => {
    // A dal whose first prep job (mince the garlic) gets ready for step 3.
    // The screen used to send that step as the one in hand, so Sous was told
    // steps 1 and 2 were done before the cook had lit the stove.
    const dalPack: Pack = {
      id: "pack-prep",
      title: "Prep Pack",
      version: "0.7.0",
      creator: {
        name: "A. Cook",
        bio: "Weeknight cook",
        voice_notes: "Plain.",
      },
      recipes: [
        {
          id: "weeknight-dal",
          title: "Weeknight dal",
          story: "Lentils, then a quick fry on top.",
          serves_base: 4,
          ingredients: [
            { id: "ing-0", name: "cloves garlic", qty_canonical: { count: 3 }, scaling: "linear" },
            { id: "ing-1", name: "onion", qty_canonical: { count: 1 }, scaling: "linear" },
          ],
          steps: [
            {
              id: "step-0",
              type: "action",
              text: "Simmer the lentils until soft.",
              ingredient_refs: [],
              technique_refs: [],
              state_refs: [],
            },
            {
              id: "step-1",
              type: "action",
              text: "Fry the onion until golden.",
              ingredient_refs: ["ing-1"],
              technique_refs: [],
              state_refs: [],
            },
            {
              id: "step-2",
              type: "action",
              text: "Add the garlic and cook one minute.",
              ingredient_refs: ["ing-0"],
              technique_refs: [],
              state_refs: [],
            },
          ],
          creator_notes: [],
        },
      ],
    };
    const prep = {
      jobs: [
        { text: "Mince the garlic", amounts: ["6 cloves garlic"], done: true },
        { text: "Chop the onion", amounts: ["2 onion"], done: false },
        { text: "Rinse the lentils", amounts: [], done: false },
      ],
    };
    const QUESTION = "How fine should the garlic be?";

    function queueTheDal() {
      const projected = packRecipeToQueueData(dalPack.recipes[0], dalPack.id);
      expect(projected.ok).toBe(true);
      if (!projected.ok) throw new Error("the dal did not project");
      mockGetQueueItem.mockResolvedValue({
        id: "q-dal",
        targetUser: "cook",
        recipeData: projected.projection.recipeData,
        servesEstimate: projected.projection.servesEstimate?.count ?? null,
        servesEstimateBasis: projected.projection.servesEstimate?.basis ?? null,
      });
      mockLoadAppPackFiles.mockResolvedValue({
        packs: [dalPack],
        libraries: { commons: [], states: [] },
        errors: [],
      });
    }

    function lastSent(): string {
      const call = mockAiChat.mock.calls.at(-1)![0];
      return call.messages[call.messages.length - 1].content;
    }

    it("says the cook is in prep, on the page's jobs with their amounts, and names no step as in hand or done", async () => {
      queueTheDal();
      await chatCookingAssistant(KITCHEN_ID, "cook-session-prep", [{ role: "user", content: QUESTION }], "Weeknight dal", {
        queueId: "q-dal",
        servings: 8,
        servesBase: 4,
        prep,
      });

      const sent = lastSent();
      expect(sent).toContain("[context]");
      expect(sent).toContain("cook's place: prep, before the cooking steps; no cooking step is in hand");
      expect(sent).toContain(
        "prep jobs in hand: Mince the garlic (6 cloves garlic) [done]; Chop the onion (2 onion); Rinse the lentils",
      );
      expect(sent).not.toContain("current step:");
      expect(sent).not.toContain("recent steps");
      // The rest of the turn's context stands as on any step.
      expect(sent).toContain("serving scale: 2× (serves 8, base 4)");
      expect(sent).toContain("scaled ingredients: 6 cloves garlic; 2 onion");
      // And Sous is told how to read it.
      const call = mockAiChat.mock.calls.at(-1)![0];
      expect(call.systemPrompt).toContain("says the cook is in prep");
    });

    it("prep is the place even when a step is sent with it: no step is claimed", async () => {
      queueTheDal();
      await chatCookingAssistant(KITCHEN_ID, "cook-session-prep", [{ role: "user", content: QUESTION }], "Weeknight dal", {
        queueId: "q-dal",
        currentStepIndex: 2,
        prep,
      });
      const sent = lastSent();
      expect(sent).toContain("cook's place: prep, before the cooking steps; no cooking step is in hand");
      expect(sent).not.toContain("current step:");
      expect(sent).not.toContain("recent steps");
      expect(sent).not.toContain("Simmer the lentils");
    });

    it("with every job done there is no jobs line, and prep is still the place", async () => {
      queueTheDal();
      await chatCookingAssistant(KITCHEN_ID, "cook-session-prep", [{ role: "user", content: QUESTION }], "Weeknight dal", {
        queueId: "q-dal",
        prep: { jobs: [] },
      });
      const sent = lastSent();
      expect(sent).toContain("cook's place: prep, before the cooking steps; no cooking step is in hand");
      expect(sent).not.toContain("prep jobs in hand");
      expect(sent).not.toContain("current step:");
    });

    it("says prep with the recipe as the screen's own text too (no stored recipe to read)", async () => {
      await chatCookingAssistant(KITCHEN_ID, "cook-session-prep", [{ role: "user", content: QUESTION }], "Weeknight dal", {
        prep,
      });
      const sent = lastSent();
      expect(sent.startsWith(QUESTION)).toBe(true);
      expect(sent).toContain("cook's place: prep, before the cooking steps; no cooking step is in hand");
      expect(sent).toContain("prep jobs in hand: Mince the garlic (6 cloves garlic) [done]; Chop the onion (2 onion)");
    });

    it("on a cooking step nothing says prep", async () => {
      queueTheDal();
      await chatCookingAssistant(KITCHEN_ID, "cook-session-prep", [{ role: "user", content: QUESTION }], "Weeknight dal", {
        queueId: "q-dal",
        currentStepIndex: 2,
      });
      const sent = lastSent();
      expect(sent).toContain("current step: step 3 (action) — Add the garlic and cook one minute.");
      expect(sent).toContain("recent steps, oldest first: step 1 (Simmer the lentils until soft.); step 2");
      expect(sent).not.toContain("cook's place: prep");
      expect(sent).not.toContain("prep jobs in hand");
    });
  });

  it("logs console.warn and falls back to currentRecipe when queueId is missing or inaccessible", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetQueueItem.mockResolvedValue(null);

    try {
      await chatCookingAssistant(
        KITCHEN_ID,
        "cook-session-missing",
        [{ role: "user", content: "What next?" }],
        "Fallback Recipe Text: Boil water.",
        {
          queueId: "non-existent-id",
        },
      );

      expect(warnSpy).toHaveBeenCalledWith(
        "[AskSous] queueId not found, falling back to currentRecipe:",
        "non-existent-id",
      );
      const call = mockAiChat.mock.calls[0][0];
      expect(call.systemPrompt).toContain("<current_recipe>");
      expect(call.systemPrompt).toContain("Fallback Recipe Text: Boil water.");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("omits recipe context cleanly when includeRecipeContext is false", async () => {
    await chatCookingAssistant(
      KITCHEN_ID,
      "cook-session-photo-no-context",
      [{ role: "user", content: "How does this look?" }],
      "Should Not Appear Recipe",
      {
        queueId: "q-salmon-1",
        includeRecipeContext: false,
      },
    );

    expect(mockGetQueueItem).not.toHaveBeenCalled();
    const call = mockAiChat.mock.calls[0][0];
    expect(call.systemPrompt).not.toContain("<current_recipe>");
    expect(call.systemPrompt).not.toContain("Should Not Appear Recipe");
    expect(call.messages[0].content).toBe("How does this look?");
  });
});

