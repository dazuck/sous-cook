import { describe, expect, it } from "vitest";
import { COOK_PLAN_VERSION } from "./cook-plan";
import {
  COOK_PLAN_RESPONSE_SCHEMA,
  COOK_PLAN_SYSTEM_PROMPT,
  COOK_PLAN_THINKING_BUDGET,
} from "./cook-plan-derive";
import {
  cookPlanPromptHash,
  cookPlanStamp,
  isSettledPlanError,
  planSourceHash,
  stampOf,
  storedPlanToCopy,
  verifyStoredPlan,
} from "./cook-plan-stamp";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE } from "./__tests__/zucchini-wraps";

const CURRENT = {
  version: COOK_PLAN_VERSION,
  systemPrompt: COOK_PLAN_SYSTEM_PROMPT,
  responseSchema: COOK_PLAN_RESPONSE_SCHEMA,
  thinkingBudget: COOK_PLAN_THINKING_BUDGET,
};

describe("planSourceHash", () => {
  it("is a sha256 hex digest", () => {
    expect(planSourceHash(ZUCCHINI_RECIPE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not move with key order, at any depth", () => {
    const reordered = {
      stepIngredients: ZUCCHINI_RECIPE.stepIngredients,
      steps: ZUCCHINI_RECIPE.steps,
      ingredients: ZUCCHINI_RECIPE.ingredients?.map((ing) =>
        Object.fromEntries(Object.entries(ing).reverse()),
      ),
    } as typeof ZUCCHINI_RECIPE;
    expect(planSourceHash(reordered)).toBe(planSourceHash(ZUCCHINI_RECIPE));
  });

  it("reads only what the model sees: other recipe fields don't move it", () => {
    const withExtras = { ...ZUCCHINI_RECIPE, name: "Other", notes: "x", serves: "4" };
    expect(planSourceHash(withExtras)).toBe(planSourceHash(ZUCCHINI_RECIPE));
  });

  it("hashes a null field as an absent one (a library row's nulls)", () => {
    const ingredients = ZUCCHINI_RECIPE.ingredients?.map((ing) => ({
      ...ing,
      unit: ing.unit ?? null,
    }));
    const withNulls = {
      ...ZUCCHINI_RECIPE,
      ingredients,
      stepIngredients: null,
    } as unknown as typeof ZUCCHINI_RECIPE;
    expect(planSourceHash(withNulls)).toBe(
      planSourceHash({ ...ZUCCHINI_RECIPE, stepIngredients: undefined }),
    );
  });

  it("moves when a step, an ingredient or a step's ingredients change", () => {
    const base = planSourceHash(ZUCCHINI_RECIPE);
    const steps = [...(ZUCCHINI_RECIPE.steps ?? [])];
    steps[0] = `${steps[0]} Gently.`;
    expect(planSourceHash({ ...ZUCCHINI_RECIPE, steps })).not.toBe(base);

    const ingredients = [...(ZUCCHINI_RECIPE.ingredients ?? [])];
    ingredients[0] = { ...ingredients[0], amount: "9" };
    expect(planSourceHash({ ...ZUCCHINI_RECIPE, ingredients })).not.toBe(base);

    expect(
      planSourceHash({ ...ZUCCHINI_RECIPE, stepIngredients: [[0]] }),
    ).not.toBe(base);
  });

  it("moves when two steps swap (the plan points at step indexes)", () => {
    const [a, b, ...rest] = ZUCCHINI_RECIPE.steps ?? [];
    expect(planSourceHash({ ...ZUCCHINI_RECIPE, steps: [b, a, ...rest] })).not.toBe(
      planSourceHash(ZUCCHINI_RECIPE),
    );
  });
});

describe("cookPlanStamp", () => {
  it("is the plan version, a colon and a hash", () => {
    expect(cookPlanStamp()).toMatch(new RegExp(`^${COOK_PLAN_VERSION}:[0-9a-f]{16}$`));
    expect(cookPlanStamp()).toBe(stampOf(CURRENT));
  });

  it("is the stamp every stored plan carries, so a change outside the prompt re-derives nothing", () => {
    // The re-ask (`correctionPrompt`) and the validator are not in the stamp:
    // changing them keeps every stored plan. A prompt, schema, budget or
    // version change moves this, and with it re-derives the library.
    expect(cookPlanStamp()).toBe("4:9e4c4743a075ef61");
  });

  it("changes on a prompt edit with no version bump", () => {
    expect(stampOf({ ...CURRENT, systemPrompt: `${COOK_PLAN_SYSTEM_PROMPT} ` })).not.toBe(
      cookPlanStamp(),
    );
  });

  it("changes on a schema, thinking-budget or version change", () => {
    const stamps = new Set([
      cookPlanStamp(),
      stampOf({ ...CURRENT, responseSchema: { type: "object", properties: {} } }),
      stampOf({ ...CURRENT, thinkingBudget: 512 }),
      stampOf({ ...CURRENT, version: COOK_PLAN_VERSION + 1 }),
    ]);
    expect(stamps.size).toBe(4);
  });

  it("keeps the eval snapshots' prompt hash (the prompt alone, 16 hex)", () => {
    expect(cookPlanPromptHash()).toMatch(/^[0-9a-f]{16}$/);
    expect(cookPlanPromptHash()).toBe(cookPlanPromptHash(COOK_PLAN_SYSTEM_PROMPT));
  });
});

describe("isSettledPlanError", () => {
  it.each([
    ["rejected (uncovered-step): step 3 is not carried by any task", true],
    ["rejected (shape): the response was not JSON", true],
    ["The model declined to plan this recipe (blocked)", true],
    ["Cook plan derivation exceeded the token limit even after retrying", true],
    ["Cook plan derivation timed out after 45 s", false],
    ["Google API error 429: Resource exhausted", false],
    // Google's 403 for an API key or service restriction: a config outage, never settled.
    [
      "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent: [403 Forbidden] Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent are blocked.",
      false,
    ],
    ["Requests to this API are blocked. (blocked)", false],
    ["The request exceeded the token limit", false],
    ["rejected (not-a-rule): made up", false],
    ["Upstream rejected (403): forbidden", false],
    ["fetch failed", false],
    ["Cannot derive a cook plan: the recipe has no steps", false],
    ["", false],
  ])("%j is settled: %s", (error, settled) => {
    expect(isSettledPlanError(error)).toBe(settled);
  });

  it("reads null as no error", () => {
    expect(isSettledPlanError(null)).toBe(false);
  });
});

describe("verifyStoredPlan", () => {
  const hash = planSourceHash(ZUCCHINI_RECIPE);
  const stamp = cookPlanStamp();

  it("returns the plan when hash, stamp and validation all hold", () => {
    const checked = verifyStoredPlan(ZUCCHINI_PLAN, hash, stamp, ZUCCHINI_RECIPE);
    expect(checked).toEqual({ ok: true, plan: ZUCCHINI_PLAN });
  });

  it("refuses a missing plan", () => {
    expect(verifyStoredPlan(null, hash, stamp, ZUCCHINI_RECIPE)).toEqual({
      ok: false,
      reason: "no plan",
    });
  });

  it("refuses a plan made for other steps (hash)", () => {
    const steps = [...(ZUCCHINI_RECIPE.steps ?? []), "Serve."];
    const checked = verifyStoredPlan(ZUCCHINI_PLAN, hash, stamp, {
      ...ZUCCHINI_RECIPE,
      steps,
    });
    expect(checked).toEqual({ ok: false, reason: "hash" });
  });

  it("refuses a plan from another prompt or version (stamp)", () => {
    expect(verifyStoredPlan(ZUCCHINI_PLAN, hash, "3:abc", ZUCCHINI_RECIPE)).toEqual({
      ok: false,
      reason: "stamp",
    });
    expect(verifyStoredPlan(ZUCCHINI_PLAN, hash, null, ZUCCHINI_RECIPE)).toEqual({
      ok: false,
      reason: "stamp",
    });
  });

  it("refuses a plan that no longer validates, naming the rule", () => {
    const corrupted = {
      ...ZUCCHINI_PLAN,
      tasks: ZUCCHINI_PLAN.tasks.map((t, i) =>
        i === 0 ? { ...t, needs: ["no-such-task"] } : t,
      ),
    };
    const checked = verifyStoredPlan(corrupted, hash, stamp, ZUCCHINI_RECIPE);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(/^invalid \(dangling-need\)/);
  });

  it("refuses a value that is not a plan at all", () => {
    const checked = verifyStoredPlan({ tasks: "x" }, hash, stamp, ZUCCHINI_RECIPE);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(/^invalid \(shape\)/);
  });
});

describe("storedPlanToCopy", () => {
  const hash = planSourceHash(ZUCCHINI_RECIPE);
  const stamp = cookPlanStamp();
  const none = { plan: null, error: null, sourceHash: null, stamp: null };
  const settled = "rejected (uncovered-step): step 4 is in no task";

  it("copies a plan that passes the three checks", () => {
    expect(storedPlanToCopy({ ...none, plan: ZUCCHINI_PLAN, sourceHash: hash, stamp }, ZUCCHINI_RECIPE)).toEqual({
      ok: true,
      copy: { cookPlan: ZUCCHINI_PLAN, cookPlanError: null },
    });
  });

  it("copies nothing for a plan that fails one, giving the reason", () => {
    const steps = [...(ZUCCHINI_RECIPE.steps ?? []), "Serve."];
    expect(
      storedPlanToCopy({ ...none, plan: ZUCCHINI_PLAN, sourceHash: hash, stamp }, { ...ZUCCHINI_RECIPE, steps }),
    ).toEqual({ ok: false, reason: "hash" });
    expect(
      storedPlanToCopy({ ...none, plan: ZUCCHINI_PLAN, sourceHash: hash, stamp: "3:abc" }, ZUCCHINI_RECIPE),
    ).toEqual({ ok: false, reason: "stamp" });
    const corrupted = storedPlanToCopy({ ...none, plan: { tasks: "x" }, sourceHash: hash, stamp }, ZUCCHINI_RECIPE);
    expect(corrupted.ok).toBe(false);
    if (!corrupted.ok) expect(corrupted.reason).toMatch(/^invalid \(shape\)/);
  });

  it("copies a settled error made for this recipe at this stamp, with no plan", () => {
    expect(storedPlanToCopy({ ...none, error: settled, sourceHash: hash, stamp }, ZUCCHINI_RECIPE)).toEqual({
      ok: true,
      copy: { cookPlan: null, cookPlanError: settled },
    });
  });

  it("copies no settled error made for other steps or another stamp", () => {
    const steps = [...(ZUCCHINI_RECIPE.steps ?? []), "Serve."];
    expect(
      storedPlanToCopy({ ...none, error: settled, sourceHash: hash, stamp }, { ...ZUCCHINI_RECIPE, steps }),
    ).toEqual({ ok: false, reason: "hash" });
    expect(storedPlanToCopy({ ...none, error: settled, sourceHash: hash, stamp: "3:abc" }, ZUCCHINI_RECIPE)).toEqual({
      ok: false,
      reason: "stamp",
    });
  });

  it("copies no transient error (the queue's own attempt may succeed)", () => {
    expect(
      storedPlanToCopy({ ...none, error: "Cook plan derivation timed out after 45 s", sourceHash: hash, stamp }, ZUCCHINI_RECIPE),
    ).toEqual({ ok: false, reason: "transient error" });
  });

  it("copies nothing when nothing is stored", () => {
    expect(storedPlanToCopy(none, ZUCCHINI_RECIPE)).toEqual({ ok: false, reason: "no plan" });
  });
});
