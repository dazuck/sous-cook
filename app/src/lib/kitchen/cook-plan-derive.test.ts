import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { chat } from "../ai";
import { RawCookPlanSchema, parseCookPlan, type RecipeForPlan } from "./cook-plan";
import {
  COOK_PLAN_EXAMPLE,
  COOK_PLAN_RESPONSE_SCHEMA,
  COOK_PLAN_SYSTEM_PROMPT,
  COOK_PLAN_THINKING_BUDGET,
  COOK_PLAN_TIMEOUT_MS,
  CALL_OVERHEAD_TOKENS,
  CookPlanCapReached,
  CookPlanDerivationError,
  OUTPUT_TOKENS,
  OUTPUT_TOKENS_RETRY,
  REASK_HINTS,
  correctionPrompt,
  deriveCookPlan as rawDeriveCookPlan,
  deriveCookPlanOutcome as rawDeriveCookPlanOutcome,
  type DeriveOptions,
} from "./cook-plan-derive";
import { scriptMeter } from "../ai/meter";
import { CostLedger, callCostUsd } from "../cook-plan-cost";
import { isSettledPlanError } from "./cook-plan-stamp";
import {
  ZUCCHINI_PLAN,
  ZUCCHINI_RECIPE,
  zucchiniRaw,
} from "./__tests__/zucchini-wraps";
import {
  CHUTNEY_RECIPE,
  CHUTNEY_UNCITED,
  chutneyMergedRaw,
  chutneyRaw,
} from "./__tests__/fragmented-chutney";
import {
  DAN_DAN_RECIPE,
  TORTA_RECIPE,
  WINGS_RECIPE,
  danDanAheadFixedRaw,
  danDanFixedRaw,
  danDanMiseSauceRaw,
  danDanRaw,
  danDanUncoveredRaw,
  tortaFixedRaw,
  tortaRaw,
  wingsFixedRaw,
  wingsRaw,
} from "./__tests__/three-reask-recipes";
import {
  loadCookPlanFixtures,
  loadCookPlanSnapshots,
} from "./__tests__/load-cook-plan-fixtures";

vi.mock("../ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai")>()),
  chat: vi.fn(),
}));

const TEST_METER = scriptMeter("cook-plan-derive-test");
const deriveCookPlan = (
  recipe: Parameters<typeof rawDeriveCookPlan>[0],
  options: Omit<DeriveOptions, "meter"> = {},
) => rawDeriveCookPlan(recipe, { ...options, meter: TEST_METER });
const deriveCookPlanOutcome = (
  recipe: Parameters<typeof rawDeriveCookPlanOutcome>[0],
  options: Omit<DeriveOptions, "meter"> = {},
) => rawDeriveCookPlanOutcome(recipe, { ...options, meter: TEST_METER });

const mockChat = chat as ReturnType<typeof vi.fn>;

function reply(content: string, finishReason = "stop") {
  mockChat.mockResolvedValueOnce({ content, finishReason });
}

/** The failure seen in prod: every task missing its needs. */
function withoutNeeds() {
  const raw = zucchiniRaw();
  return {
    tasks: raw.tasks.map((task) => {
      const { needs: _needs, ...rest } = task;
      return rest;
    }),
  };
}

/** A plan that leaves a step uncited. */
function uncovered() {
  const broken = zucchiniRaw();
  broken.tasks = broken.tasks
    .filter((t) => t.sourceStep !== 4)
    .map((t) => ({ ...t, needs: [] }));
  return broken;
}

beforeEach(() => {
  mockChat.mockReset();
});

describe("the prompt's worked example", () => {
  it("is a plan that passes validation, so the model never learns a rejected shape", () => {
    const result = parseCookPlan(COOK_PLAN_EXAMPLE.raw, COOK_PLAN_EXAMPLE.recipe);
    expect(result.ok).toBe(true);
  });

  it("appears in the system prompt exactly as the model's input and output would", () => {
    expect(COOK_PLAN_SYSTEM_PROMPT).toContain("[0] 1 onion, finely chopped");
    expect(COOK_PLAN_SYSTEM_PROMPT).toContain(
      JSON.stringify(COOK_PLAN_EXAMPLE.raw.tasks[2]),
    );
  });
});

describe("the response schema", () => {
  const task = () => {
    const tasks = COOK_PLAN_RESPONSE_SCHEMA;
    if (tasks.type !== "object") throw new Error("not an object");
    const list = tasks.properties.tasks;
    if (list.type !== "array" || list.items.type !== "object") {
      throw new Error("tasks is not an array of objects");
    }
    return list.items;
  };

  it("names every field the validator reads, and requires each one", () => {
    const fields = Object.keys(RawCookPlanSchema.shape.tasks.element.shape);
    expect(Object.keys(task().properties).sort()).toEqual([...fields].sort());
    expect([...(task().required ?? [])].sort()).toEqual([...fields].sort());
    expect(COOK_PLAN_RESPONSE_SCHEMA).toMatchObject({ required: ["tasks"] });
  });

  it("asks for the keys in the worked example's order, so text comes before its tags", () => {
    expect(task().propertyOrdering).toEqual(
      Object.keys(COOK_PLAN_EXAMPLE.raw.tasks[0]),
    );
  });

  it("lets a field be null exactly when the validator does, except minutes", () => {
    // The validator tolerates a plan with no minutes; the schema asks for them.
    const fields = RawCookPlanSchema.shape.tasks.element.shape;
    const validatorNullable = Object.entries(fields)
      .filter(([, field]) => field.safeParse(null).success)
      .map(([name]) => name)
      .sort();
    const schemaNullable = Object.entries(task().properties)
      .filter(([, field]) => field.nullable)
      .map(([name]) => name)
      .sort();
    expect(validatorNullable).toEqual(["cue", "lead", "minutes", "sourceStep"]);
    expect(schemaNullable).toEqual(["cue", "lead", "sourceStep"]);
  });

  it("offers exactly the validator's kinds", () => {
    const kinds = RawCookPlanSchema.shape.tasks.element.shape.kind.options;
    expect(task().properties.kind).toEqual({ type: "string", enum: kinds });
  });
});

describe("deriveCookPlan", () => {
  it("sends the numbered recipe in JSON mode with the rules as the system prompt", async () => {
    reply(JSON.stringify(zucchiniRaw()));
    await deriveCookPlan(ZUCCHINI_RECIPE);

    expect(mockChat).toHaveBeenCalledTimes(1);
    const options = mockChat.mock.calls[0][0];
    expect(options.responseFormat).toBe("json");
    expect(options.responseSchema).toBe(COOK_PLAN_RESPONSE_SCHEMA);
    expect(options.thinkingBudget).toBe(COOK_PLAN_THINKING_BUDGET);
    expect(options.systemPrompt).toMatch(/ahead/);
    expect(options.systemPrompt).toMatch(/mise/);
    const [message] = options.messages;
    expect(message.role).toBe("user");
    expect(message.content).toContain("[1] 1 onion bulb");
    expect(message.content).toContain("[6] chili oil or Calabrian chile");
    expect(message.content).toContain(
      "[2] Fry the parathas in a dry skillet until crisp and flaky.",
    );
  });

  it("returns the validated plan and the raw output, with no rejections", async () => {
    reply(JSON.stringify(zucchiniRaw()));
    const { raw, result, rejections } = await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(raw).toEqual(zucchiniRaw());
    expect(result).toEqual({ ok: true, plan: ZUCCHINI_PLAN });
    expect(rejections).toEqual([]);
  });

  it("reads JSON wrapped in a code fence", async () => {
    reply("```json\n" + JSON.stringify(zucchiniRaw()) + "\n```");
    const { result } = await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(result.ok).toBe(true);
  });

  it("rejects output that is not JSON as a shape failure, keeping the text", async () => {
    reply("Sorry, I can't plan this recipe.");
    reply("Sorry, I still can't.");
    const { raw, result } = await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(raw).toBe("Sorry, I still can't.");
    expect(result).toMatchObject({ ok: false, rule: "shape" });
  });

  it("rejects a plan that breaks a validation rule, naming the rule", async () => {
    reply(JSON.stringify(uncovered()));
    reply(JSON.stringify(uncovered()));
    const { result } = await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(result).toMatchObject({ ok: false, rule: "uncovered-step" });
  });

  it("asks once more when the plan is rejected, and returns the second plan", async () => {
    reply(JSON.stringify(withoutNeeds()));
    reply(JSON.stringify(zucchiniRaw()));
    const { raw, result, rejections } = await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true, plan: ZUCCHINI_PLAN });
    expect(raw).toEqual(zucchiniRaw());
    expect(rejections).toEqual([
      {
        call: 1,
        raw: withoutNeeds(),
        rule: "shape",
        detail: expect.stringMatching(/needs/),
      },
    ]);
  });

  it("re-asks with its reply and the rule it broke, so the model can correct it", async () => {
    // The same prompt again gets the same plan: four identical rejections in prod.
    const first = JSON.stringify(uncovered());
    reply(first);
    reply(JSON.stringify(zucchiniRaw()));
    const { result } = await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(result.ok).toBe(true);

    const [ask, reask] = mockChat.mock.calls.map(([o]) => o.messages);
    expect(ask).toHaveLength(1);
    expect(reask.slice(0, 1)).toEqual(ask);
    expect(reask.slice(1)).toEqual([
      { role: "assistant", content: first },
      {
        role: "user",
        content: correctionPrompt(
          { rule: "uncovered-step", detail: "no task covers step 4", uncoveredSteps: [4] },
          ZUCCHINI_RECIPE,
        ),
      },
    ]);
    expect(reask[2].content).toContain("(uncovered-step): no task covers step 4");
    expect(reask[2].content).toContain(`[4] ${ZUCCHINI_RECIPE.steps![4]}`);
  });

  it("re-asks a recipe in many short steps with every uncited step quoted, and accepts a reply citing them all", async () => {
    // Peanut chutney (R31): the model merged short neighbours, each merged
    // task citing one step. The re-ask named only the first uncited step, so
    // call 1 fixed step 4 and call 2 came back on step 6.
    reply(JSON.stringify(chutneyMergedRaw()));
    reply(JSON.stringify(chutneyRaw()));
    const { result, rejections } = await deriveCookPlan(CHUTNEY_RECIPE);

    expect(rejections).toEqual([
      {
        call: 1,
        raw: chutneyMergedRaw(),
        rule: "uncovered-step",
        detail: "no task covers steps 3, 4, 7, 11, 14",
      },
    ]);
    const correction = mockChat.mock.calls[1][0].messages[2];
    expect(correction.role).toBe("user");
    expect(correction.content).toContain("(uncovered-step): no task covers steps 3, 4, 7, 11, 14");
    const steps = CHUTNEY_RECIPE.steps!;
    for (const i of CHUTNEY_UNCITED) {
      expect(correction.content).toContain(`[${i}] ${steps[i]}`);
    }
    // Only the uncited steps are quoted: a cited one would read as a fault.
    const quoted = [...correction.content.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
    expect(quoted).toEqual(CHUTNEY_UNCITED);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tasks.map((t) => t.sourceStep)).toEqual(steps.map((_, i) => i));
  });

  it("turns down the cookies derived with mixed lead anchors and re-asks with the one anchor", async () => {
    // The shipped prompt still says a lead is "how far ahead", so it can
    // still count soften-butter back from the creaming (DECISIONS
    // 2026-10-04): the parser catches it and the re-ask states the anchor.
    const cookies = loadCookPlanFixtures().find((f) => f.name === "chewy-oat-cookies")!;
    const fixed = loadCookPlanSnapshots().get(cookies.name)!.raw as {
      tasks: { id: string; lead: string | null }[];
    };
    const oldWay = structuredClone(fixed);
    oldWay.tasks.find((t) => t.id === "soften-butter")!.lead = "1 hour before";
    oldWay.tasks.find((t) => t.id === "room-temp-eggs")!.lead = "30 minutes before";
    const rule = "a lead counts back from the start of the cook, so what a task needs can't have a shorter lead";
    const detail = `"beat-butter-sugar" (at least 2 hours before) needs "soften-butter" (1 hour before); ${rule}`;
    // The eggs break the same rule; the re-ask names both, not only the first.
    const eggs = `"add-eggs-vanilla" (at least 2 hours before) needs "room-temp-eggs" (30 minutes before); ${rule}`;

    reply(JSON.stringify(oldWay));
    reply(JSON.stringify(fixed));
    const { result, rejections } = await deriveCookPlan(cookies.recipe);
    expect(rejections.map((r) => [r.rule, r.detail])).toEqual([["lead-order", detail]]);
    expect(mockChat.mock.calls[1][0].messages[2]).toEqual({
      role: "user",
      content: correctionPrompt(
        {
          rule: "lead-order",
          detail,
          violations: [
            { rule: "lead-order", detail },
            { rule: "lead-order", detail: eggs },
          ],
        },
        cookies.recipe,
      ),
    });
    expect(result.ok).toBe(true);

    // Twice the old way, no plan is kept: the cook gets the recipe as written.
    mockChat.mockReset();
    reply(JSON.stringify(oldWay));
    reply(JSON.stringify(oldWay));
    const again = await deriveCookPlan(cookies.recipe);
    expect(again.result).toMatchObject({ ok: false, rule: "lead-order" });
  });

  it("sends back text that wasn't JSON as it came", async () => {
    reply("Sorry, I can't plan this recipe.");
    reply(JSON.stringify(zucchiniRaw()));
    await deriveCookPlan(ZUCCHINI_RECIPE);
    const reask = mockChat.mock.calls[1][0].messages;
    expect(reask[1]).toEqual({ role: "assistant", content: "Sorry, I can't plan this recipe." });
    expect(reask[2].content).toContain("(shape): the response was not JSON");
  });

  it("asks only once more: two rejections return the second, with both kept", async () => {
    reply("not json");
    reply(JSON.stringify(uncovered()));
    const { raw, result, rejections } = await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(raw).toEqual(uncovered());
    expect(result).toMatchObject({ ok: false, rule: "uncovered-step" });
    expect(rejections.map((r) => [r.raw, r.rule])).toEqual([
      ["not json", "shape"],
      [uncovered(), "uncovered-step"],
    ]);
  });

  it("keeps a truncated retry and a rejected retry apart: three calls at most", async () => {
    reply('{"tasks": [{"id": "on', "max_tokens");
    reply(JSON.stringify(withoutNeeds()));
    reply(JSON.stringify(withoutNeeds()));
    const { result, rejections } = await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(mockChat).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, rule: "shape" });
    expect(rejections.map((r) => r.call)).toEqual([2, 3]);
  });

  it("keeps a rejected reply on the error when the re-ask fails", async () => {
    reply(JSON.stringify(withoutNeeds()));
    mockChat.mockRejectedValueOnce(new Error("quota exceeded"));
    const failure = await deriveCookPlan(ZUCCHINI_RECIPE).catch((e) => e);
    expect(failure).toBeInstanceOf(CookPlanDerivationError);
    expect(failure.message).toBe("quota exceeded");
    expect(failure.rejections).toEqual([
      expect.objectContaining({ call: 1, raw: withoutNeeds(), rule: "shape" }),
    ]);
  });

  it("throws a plain error when nothing was rejected", async () => {
    mockChat.mockRejectedValueOnce(new Error("quota exceeded"));
    const failure = await deriveCookPlan(ZUCCHINI_RECIPE).catch((e) => e);
    expect(failure).not.toBeInstanceOf(CookPlanDerivationError);
    expect(failure.message).toBe("quota exceeded");
  });

  it("retries a rejected plan's re-ask at the larger budget only if it was truncated", async () => {
    reply(JSON.stringify(withoutNeeds()));
    reply('{"tasks": [{"id": "on', "max_tokens");
    reply(JSON.stringify(zucchiniRaw()));
    const { result } = await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(result.ok).toBe(true);
    const budgets = mockChat.mock.calls.map(([o]) => o.maxTokens);
    expect(budgets[0]).toBe(budgets[1]);
    expect(budgets[2]).toBeGreaterThan(budgets[1]);
    // The truncated reply isn't kept: the retry asks the re-ask again.
    expect(mockChat.mock.calls[2][0].messages).toEqual(mockChat.mock.calls[1][0].messages);
    expect(mockChat.mock.calls[2][0].messages).toHaveLength(3);
  });

  it("retries once with a larger budget when the output is truncated", async () => {
    reply('{"tasks": [{"id": "on', "max_tokens");
    reply(JSON.stringify(zucchiniRaw()));
    const { result } = await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(result.ok).toBe(true);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockChat.mock.calls[1][0].maxTokens).toBeGreaterThan(
      mockChat.mock.calls[0][0].maxTokens,
    );
  });

  it("throws when the output is truncated twice", async () => {
    reply("{", "max_tokens");
    reply("{", "max_tokens");
    await expect(deriveCookPlan(ZUCCHINI_RECIPE)).rejects.toThrow(/token limit/);
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it("adds the thinking budget to the token limit so thinking can't truncate the plan", async () => {
    reply(JSON.stringify(zucchiniRaw()));
    reply(JSON.stringify(zucchiniRaw()));
    await deriveCookPlan(ZUCCHINI_RECIPE, { thinkingBudget: 0 });
    await deriveCookPlan(ZUCCHINI_RECIPE, { thinkingBudget: 4096 });
    const [plain, thinking] = mockChat.mock.calls.map(([o]) => o);
    expect(plain.thinkingBudget).toBe(0);
    expect(thinking.thinkingBudget).toBe(4096);
    expect(thinking.maxTokens - plain.maxTokens).toBe(4096);
  });

  it("throws on a recipe with no steps without calling the model", async () => {
    await expect(
      deriveCookPlan({ ingredients: [{ item: "salt" }], steps: [] }),
    ).rejects.toThrow(/no steps/);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("passes model errors through", async () => {
    mockChat.mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(deriveCookPlan(ZUCCHINI_RECIPE)).rejects.toThrow(/quota/);
  });

  it("reports every call's tokens, truncated and rejected calls included", async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"tasks": [{"id": "on',
      finishReason: "max_tokens",
      usage: { inputTokens: 3000, outputTokens: 8192 },
    });
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify(withoutNeeds()),
      finishReason: "stop",
      usage: { inputTokens: 3100, outputTokens: 900 },
    });
    // A provider that reports no usage counts as zero tokens, not as no call.
    reply(JSON.stringify(zucchiniRaw()));
    const seen: unknown[] = [];
    const { result } = await deriveCookPlan(ZUCCHINI_RECIPE, {
      onUsage: (usage) => seen.push(usage),
    });
    expect(result.ok).toBe(true);
    const bound = (outputTokens: number) => ({ inputTokens: expect.any(Number), outputTokens });
    expect(seen).toEqual([
      { call: 1, inputTokens: 3000, outputTokens: 8192, bound: bound(8192) },
      { call: 2, inputTokens: 3100, outputTokens: 900, bound: bound(16_384) },
      { call: 3, inputTokens: 0, outputTokens: 0, bound: bound(16_384) },
    ]);
  });

  it("reports a declined call's tokens before throwing", async () => {
    mockChat.mockResolvedValueOnce({
      content: "",
      finishReason: "blocked",
      usage: { inputTokens: 3000, outputTokens: 0 },
    });
    const seen: unknown[] = [];
    await expect(
      deriveCookPlan(ZUCCHINI_RECIPE, { onUsage: (usage) => seen.push(usage) }),
    ).rejects.toThrow(/declined/);
    expect(seen).toEqual([{ call: 1, inputTokens: 3000, outputTokens: 0, bound: expect.any(Object) }]);
  });

  it("reports a call that threw with no tokens and its bound, so a ledger charges the bound", async () => {
    mockChat.mockRejectedValueOnce(new Error("socket hang up"));
    const seen: Array<{ inputTokens: number; outputTokens: number }> = [];
    await expect(
      deriveCookPlan(ZUCCHINI_RECIPE, { onUsage: (usage) => seen.push(usage) }),
    ).rejects.toThrow(/socket/);
    expect(seen).toEqual([
      { call: 1, inputTokens: 0, outputTokens: 0, bound: { inputTokens: expect.any(Number), outputTokens: 8192 } },
    ]);
  });
});

describe("a derivation's call bounds and meter", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const FIXED =
    bytes(COOK_PLAN_SYSTEM_PROMPT) + bytes(JSON.stringify(COOK_PLAN_RESPONSE_SCHEMA)) + CALL_OVERHEAD_TOKENS;

  it("bounds each call by its maxTokens and the bytes it sends, the carried reply and correction included", async () => {
    const rejected = JSON.stringify(uncovered());
    mockChat.mockResolvedValueOnce({ content: '{"tasks": [', finishReason: "max_tokens" });
    reply(rejected);
    reply(JSON.stringify(zucchiniRaw()));
    const bounds: Array<{ inputTokens: number; outputTokens: number }> = [];
    const { result } = await deriveCookPlan(ZUCCHINI_RECIPE, {
      beforeCall: (bound) => {
        bounds.push(bound);
        return true;
      },
    });
    expect(result.ok).toBe(true);
    const sent = mockChat.mock.calls.map(
      ([args]) => FIXED + (args as { messages: Array<{ content: string }> }).messages.reduce((n, m) => n + bytes(m.content), 0),
    );
    expect(bounds).toEqual([
      { inputTokens: sent[0], outputTokens: OUTPUT_TOKENS },
      { inputTokens: sent[1], outputTokens: OUTPUT_TOKENS_RETRY },
      { inputTokens: sent[2], outputTokens: OUTPUT_TOKENS_RETRY },
    ]);
    // The third call carries the rejected reply and its correction.
    expect(sent[2]! - sent[1]!).toBeGreaterThanOrEqual(bytes(rejected));
    // Comfortably above the ~3,300 input tokens a call is estimated to take.
    expect(bounds[0]!.inputTokens).toBeGreaterThan(10_000);
  });

  it("makes no call the meter refuses, and lets the refusal through unstored", async () => {
    await expect(
      deriveCookPlanOutcome(ZUCCHINI_RECIPE, { beforeCall: () => false }),
    ).rejects.toBeInstanceOf(CookPlanCapReached);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("stops before a retry the meter refuses, after a rejected reply, without wrapping it", async () => {
    reply(JSON.stringify(uncovered()));
    const err = await deriveCookPlan(ZUCCHINI_RECIPE, { beforeCall: (_bound, call) => call === 1 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CookPlanCapReached);
    expect(err).toMatchObject({ call: 2, bound: { outputTokens: OUTPUT_TOKENS } });
    expect(mockChat).toHaveBeenCalledTimes(1);
  });
});

describe("a paid run's cap, held by the real derivation", () => {
  it("stops a recipe whose truncated reply leaves no room for the retry: one call, spend under the cap", async () => {
    // A provider that bills every call its whole bound, the worst it can do.
    mockChat.mockImplementation(async (args: { maxTokens: number; messages: Array<{ content: string }> }) => ({
      content: '{"tasks": [',
      finishReason: "max_tokens",
      usage: { inputTokens: 1, outputTokens: args.maxTokens },
    }));
    // Room for the first call's bound and a little: not for the 16,384-token retry.
    const ledger = new CostLedger(callCostUsd(15_000, OUTPUT_TOKENS + 2_000));
    await expect(deriveCookPlanOutcome(ZUCCHINI_RECIPE, ledger.meter())).rejects.toBeInstanceOf(CookPlanCapReached);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(ledger.calls).toBe(1);
    expect(ledger.refused).toBe(1);
    expect(ledger.spentUsd).toBeLessThanOrEqual(ledger.maxUsd);
  });

  it("lets a recipe take all three calls when the cap has room for their bounds", async () => {
    mockChat.mockResolvedValueOnce({ content: '{"tasks": [', finishReason: "max_tokens" });
    reply(JSON.stringify(uncovered()));
    reply(JSON.stringify(uncovered()));
    const ledger = new CostLedger(2);
    const outcome = await deriveCookPlanOutcome(ZUCCHINI_RECIPE, ledger.meter());
    expect(outcome.error).toMatch(/^rejected \(uncovered-step\)/);
    expect(ledger.calls).toBe(3);
    // No usage reported: each call charged at its bound, the worst one recipe can cost.
    expect(ledger.unreported).toBe(3);
    expect(ledger.spentUsd).toBeGreaterThan(callCostUsd(0, OUTPUT_TOKENS + 2 * OUTPUT_TOKENS_RETRY));
    expect(ledger.spentUsd).toBeLessThan(0.5);
  });

  it("throws when the model declines to answer, rather than calling it not JSON", async () => {
    reply("", "blocked");
    await expect(deriveCookPlan(ZUCCHINI_RECIPE)).rejects.toThrow(/declined/);
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("re-asks with every rule the reply broke, so call 2 isn't the first time the model hears of one (onion torta, R31)", async () => {
    reply(JSON.stringify(tortaRaw()));
    reply(JSON.stringify(tortaFixedRaw()));
    const { result, rejections } = await deriveCookPlan(TORTA_RECIPE);
    expect(result.ok).toBe(true);
    // The log keeps the rule the validator names first, as before.
    expect(rejections.map((r) => r.rule)).toEqual(["ahead-needs-later"]);
    const correction = mockChat.mock.calls[1][0].messages[2].content as string;
    expect(correction).toContain('(ahead-needs-later): ahead "cool-crust" needs cook "finish-bake-crust"');
    expect(correction).toContain('(lead-order): "cool-crust" (overnight) needs "line-tin" (freeze 30 min)');
    expect(correction).toContain(REASK_HINTS["ahead-needs-later"]);
    expect(correction).toContain(REASK_HINTS["lead-order"]);
  });
});

describe("correctionPrompt", () => {
  const HINTED = Object.keys(REASK_HINTS) as (keyof typeof REASK_HINTS)[];

  /** The re-ask for a plan the validator turns down. */
  function reask(raw: unknown, recipe: RecipeForPlan): string {
    const result = parseCookPlan(raw, recipe);
    if (result.ok) throw new Error("expected a rejected plan");
    return correctionPrompt(result, recipe);
  }

  /** Each hint is in the re-ask exactly when its rule is broken, and once. */
  function expectHints(text: string, rules: string[]) {
    for (const rule of HINTED) {
      const count = text.split(REASK_HINTS[rule]).length - 1;
      expect(count, rule).toBe(rules.includes(rule) ? 1 : 0);
    }
  }

  it("lists both phase rules with a fix for each (dan dan noodles)", () => {
    const text = reask(danDanRaw(), DAN_DAN_RECIPE);
    expect(text).toContain(
      '(mise-needs-cook): mise "grind-szechuan-peppercorns" needs cook "toast-szechuan-peppercorns"',
    );
    expect(text).toContain('(ahead-needs-later): ahead "mix-sauce" needs mise "grind-szechuan-peppercorns"');
    expectHints(text, ["mise-needs-cook", "ahead-needs-later"]);
  });

  it("quotes the uncited steps alongside a phase rule, and only those (dan dan noodles, call 1)", () => {
    const text = reask(danDanUncoveredRaw(), DAN_DAN_RECIPE);
    expect(text).toContain("(uncovered-step): no task covers step 3");
    expect(text).toContain('(mise-needs-cook): mise "grind-szechuan-peppercorns"');
    expect(text).toContain(`[3] ${DAN_DAN_RECIPE.steps![3]}`);
    const quoted = [...text.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
    expect(quoted).toEqual([3]);
    expectHints(text, ["mise-needs-cook"]);
  });

  it("lists each need an ahead task can't have, with one fix for the rule (chicken wings)", () => {
    const text = reask(wingsRaw(), WINGS_RECIPE);
    expect(text).toContain('(ahead-needs-later): ahead "marinate" needs mise "pat-wings-dry"');
    expect(text).toContain('(ahead-needs-later): ahead "marinate" needs mise "mince-ginger"');
    expectHints(text, ["ahead-needs-later"]);
  });

  it("lists a phase rule and a lead order with a fix for each (onion torta)", () => {
    const text = reask(tortaRaw(), TORTA_RECIPE);
    expect(text).toContain('(ahead-needs-later): ahead "cool-crust" needs cook "finish-bake-crust"');
    expect(text).toContain('(lead-order): "cool-crust" (overnight) needs "line-tin" (freeze 30 min)');
    expect(text).toContain('(lead-order): "cool-crust" (overnight) needs "mix-dough" (chill 1 h)');
    expectHints(text, ["ahead-needs-later", "lead-order"]);
    expect(text).toMatch(/return the whole plan again as the JSON object \{"tasks": \[\.\.\.\]\}\.$/);
  });

  it("prints hints a fixed plan can follow all at once, forbidding nothing the prompt allows", () => {
    // Each case: a broken plan, a fixed one that passes, the retags the fix
    // makes, and for each hint the re-ask prints, the words in that hint
    // that allow the fix's move. A hint that ruled a move out ("never retag
    // the ahead task") would leave one of these fixes unfollowable.
    type Raw = { tasks: { id: string; kind: string; lead: string | null }[] };
    const cases: {
      name: string;
      broken: Raw;
      fixed: Raw;
      recipe: RecipeForPlan;
      retags: Record<string, string>;
      allows: Partial<Record<keyof typeof REASK_HINTS, string>>;
    }[] = [
      {
        name: "dan dan, the sauce made during the cook",
        broken: danDanRaw(),
        fixed: danDanFixedRaw(),
        recipe: DAN_DAN_RECIPE,
        retags: { "grind-szechuan-peppercorns": "mise→cook", "mix-sauce": "ahead→cook" },
        allows: {
          "mise-needs-cook": "work done to something after it has been heated, which is cook",
          "ahead-needs-later": "If it really happens during the cook",
        },
      },
      {
        // The validator names only the grind; the sauce that needs it must
        // move too, or the next call fails on it.
        name: "dan dan, the sauce tagged mise",
        broken: danDanMiseSauceRaw(),
        fixed: danDanFixedRaw(),
        recipe: DAN_DAN_RECIPE,
        retags: { "grind-szechuan-peppercorns": "mise→cook", "mix-sauce": "mise→cook" },
        allows: { "mise-needs-cook": "retag the mise task cook, and any mise task that needs it cook as well" },
      },
      {
        name: "dan dan, the sauce made the day before",
        broken: danDanRaw(),
        fixed: danDanAheadFixedRaw(),
        recipe: DAN_DAN_RECIPE,
        retags: { "toast-szechuan-peppercorns": "cook→ahead", "grind-szechuan-peppercorns": "mise→ahead" },
        allows: {
          "mise-needs-cook": "it is ahead, and so is everything upstream of it, the cook task it needs included",
          "ahead-needs-later": "retag what it needs ahead, and everything upstream of that",
        },
      },
      {
        name: "chicken wings, a 1-4 hour marinade",
        broken: wingsRaw(),
        fixed: wingsFixedRaw(),
        recipe: WINGS_RECIPE,
        retags: { "trim-wings": "mise→ahead", "pat-wings-dry": "mise→ahead", "mince-ginger": "mise→ahead" },
        allows: { "ahead-needs-later": "a marinade of 30 minutes or more), retag what it needs ahead" },
      },
      {
        name: "onion torta, an overnight cool",
        broken: tortaRaw(),
        fixed: tortaFixedRaw(),
        recipe: TORTA_RECIPE,
        retags: { "blind-bake-crust": "cook→ahead", "finish-bake-crust": "cook→ahead" },
        allows: {
          "ahead-needs-later": "an overnight chill or cool",
          "lead-order": "Give tasks done together the same lead in the same words",
        },
      },
    ];
    for (const c of cases) {
      const text = reask(c.broken, c.recipe);
      const printed = HINTED.filter((rule) => text.includes(REASK_HINTS[rule]));
      expect(printed, c.name).toEqual(Object.keys(c.allows));
      for (const rule of printed) expect(REASK_HINTS[rule], `${c.name}: ${rule}`).toContain(c.allows[rule]);
      const before = new Map(c.broken.tasks.map((t) => [t.id, t.kind]));
      const retags = Object.fromEntries(
        c.fixed.tasks.filter((t) => before.get(t.id) !== t.kind).map((t) => [t.id, `${before.get(t.id)}→${t.kind}`]),
      );
      expect(retags, c.name).toEqual(c.retags);
      const result = parseCookPlan(c.fixed, c.recipe);
      expect(result.ok ? "ok" : `${result.rule}: ${result.detail}`, c.name).toBe("ok");
    }
    // The torta's crust is done together, so it shares one lead.
    expect(new Set(tortaFixedRaw().tasks.filter((t) => t.branch === "Crust").map((t) => t.lead))).toEqual(
      new Set(["the day before"]),
    );
    for (const hint of Object.values(REASK_HINTS)) expect(hint).not.toMatch(/\b(never|do not|don't)\b/i);
  });

  it("keeps one violation's opening line, adding the fix when its rule has one", () => {
    const uncited = correctionPrompt(
      { rule: "uncovered-step", detail: "no task covers step 4", uncoveredSteps: [4] },
      ZUCCHINI_RECIPE,
    );
    expect(uncited).toMatch(/^The app rejected that plan \(uncovered-step\): no task covers step 4\. /);
    expectHints(uncited, []);
    const detail = '"beat" (overnight) needs "soften" (1 hour before)';
    const lead = correctionPrompt({ rule: "lead-order", detail }, ZUCCHINI_RECIPE);
    expect(lead).toMatch(/^The app rejected that plan \(lead-order\): "beat" \(overnight\) needs "soften" \(1 hour before\)\. /);
    expectHints(lead, ["lead-order"]);
    expect(correctionPrompt({ rule: "shape", detail: "the response was not JSON" }, ZUCCHINI_RECIPE)).toBe(
      'The app rejected that plan (shape): the response was not JSON. Correct it, following every rule above, and return the whole plan again as the JSON object {"tasks": [...]}.',
    );
  });
});

describe("deriveCookPlan's deadline", () => {
  /** A model call that never answers, and rejects when its signal aborts. */
  function hang() {
    mockChat.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a model call that hangs, saying it timed out", async () => {
    hang();
    const derivation = deriveCookPlan(ZUCCHINI_RECIPE);
    const outcome = expect(derivation).rejects.toThrow(/timed out after 45 s/);
    await vi.advanceTimersByTimeAsync(COOK_PLAN_TIMEOUT_MS);
    await outcome;
  });

  it("holds both attempts to one deadline, so a retry can't double it", async () => {
    mockChat.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, COOK_PLAN_TIMEOUT_MS - 1000));
      return { content: "{", finishReason: "max_tokens" };
    });
    hang();
    const derivation = deriveCookPlan(ZUCCHINI_RECIPE);
    const outcome = expect(derivation).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(COOK_PLAN_TIMEOUT_MS);
    await outcome;
    expect(mockChat).toHaveBeenCalledTimes(2);
    const [first, second] = mockChat.mock.calls.map(([o]) => o.signal);
    expect(first).toBe(second);
  });

  it("keeps a rejected reply when the re-ask times out", async () => {
    reply(JSON.stringify(withoutNeeds()));
    hang();
    const derivation = deriveCookPlan(ZUCCHINI_RECIPE).catch((e) => e);
    await vi.advanceTimersByTimeAsync(COOK_PLAN_TIMEOUT_MS);
    const failure = await derivation;
    expect(failure).toBeInstanceOf(CookPlanDerivationError);
    expect(failure.message).toMatch(/timed out after 45 s/);
    expect(failure.rejections).toHaveLength(1);
  });

  it("starts no retry once the deadline has passed", async () => {
    // A provider that ignores the signal and answers late.
    mockChat.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, COOK_PLAN_TIMEOUT_MS + 1000));
      return { content: "{", finishReason: "max_tokens" };
    });
    const derivation = deriveCookPlan(ZUCCHINI_RECIPE);
    const outcome = expect(derivation).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(COOK_PLAN_TIMEOUT_MS + 1000);
    await outcome;
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("clears its timer once the plan is back", async () => {
    reply(JSON.stringify(zucchiniRaw()));
    await deriveCookPlan(ZUCCHINI_RECIPE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a model error that isn't the deadline as it is", async () => {
    mockChat.mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(deriveCookPlan(ZUCCHINI_RECIPE)).rejects.toThrow(/quota/);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("deriveCookPlanOutcome", () => {
  it("returns the plan with no error", async () => {
    reply(JSON.stringify(zucchiniRaw()));
    expect(await deriveCookPlanOutcome(ZUCCHINI_RECIPE)).toEqual({
      plan: ZUCCHINI_PLAN,
      error: null,
      rejections: [],
    });
  });

  it("names a refused plan by its rule, a settled error", async () => {
    reply(JSON.stringify(uncovered()));
    reply(JSON.stringify(uncovered()));
    const outcome = await deriveCookPlanOutcome(ZUCCHINI_RECIPE);
    expect(outcome.plan).toBeNull();
    expect(outcome.error).toMatch(/^rejected \(uncovered-step\): /);
    expect(isSettledPlanError(outcome.error)).toBe(true);
    expect(outcome.rejections).toHaveLength(2);
  });

  it("keeps a thrown error's text, and the rejections it carried", async () => {
    reply(JSON.stringify(withoutNeeds()));
    mockChat.mockRejectedValueOnce(new Error("quota exceeded"));
    const outcome = await deriveCookPlanOutcome(ZUCCHINI_RECIPE);
    expect(outcome).toMatchObject({ plan: null, error: "quota exceeded" });
    expect(outcome.rejections.map((r) => r.rule)).toEqual(["shape"]);
    expect(isSettledPlanError(outcome.error)).toBe(false);
  });

  it("classifies a declined reply and a twice-truncated one as settled", async () => {
    reply("", "blocked");
    expect(isSettledPlanError((await deriveCookPlanOutcome(ZUCCHINI_RECIPE)).error)).toBe(true);
    reply("{", "max_tokens");
    reply("{", "max_tokens");
    expect(isSettledPlanError((await deriveCookPlanOutcome(ZUCCHINI_RECIPE)).error)).toBe(true);
  });

  it("keeps a provider's key-restriction 403 transient, though its text says blocked", async () => {
    mockChat.mockRejectedValueOnce(
      new Error(
        "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent: [403 Forbidden] Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent are blocked.",
      ),
    );
    const outcome = await deriveCookPlanOutcome(ZUCCHINI_RECIPE);
    expect(outcome.error).toMatch(/are blocked\.$/);
    expect(isSettledPlanError(outcome.error)).toBe(false);
  });
});
