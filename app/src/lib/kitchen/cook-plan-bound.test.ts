/**
 * The plan keeps intake's placement (cook-fidelity plan, decision 3): when a
 * recipe says which ingredients each step uses, the derive shows them on each
 * step, the validator holds every cook task to its own step's, and a reply
 * that strays is sent back once with the rule and its hint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../ai";
import { parseCookPlan, stepIngredientBounds, type RecipeForPlan } from "./cook-plan";
import { COOK_PLAN_SYSTEM_PROMPT, REASK_HINTS, deriveCookPlan } from "./cook-plan-derive";
import { ZUCCHINI_RECIPE, zucchiniRaw } from "./__tests__/zucchini-wraps";

vi.mock("../ai", () => ({ chat: vi.fn() }));
const mockChat = chat as ReturnType<typeof vi.fn>;

beforeEach(() => mockChat.mockReset());
afterEach(() => mockChat.mockReset());

// The zucchini wraps with the mapping its cook tasks already keep to.
const MAPPED: RecipeForPlan = { ...ZUCCHINI_RECIPE, stepIngredients: [[0, 1, 2, 3], [4], [5], [], [6]] };

/** The zucchini plan with one task's ingredients changed. */
function listing(id: string, ingredientIdx: number[]) {
  const raw = zucchiniRaw();
  const task = raw.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  task.ingredientIdx = ingredientIdx;
  return raw;
}

describe("ingredient-outside-step", () => {
  it("accepts a plan whose cook tasks list only their steps' ingredients", () => {
    expect(parseCookPlan(zucchiniRaw(), MAPPED).ok).toBe(true);
  });

  it("rejects a cook task listing an ingredient another step adds, naming the task, the step and what it uses", () => {
    expect(parseCookPlan(listing("stir", [4, 6]), MAPPED)).toMatchObject({
      ok: false,
      rule: "ingredient-outside-step",
      detail: `cook "stir" lists ingredient 6, which step 1 doesn't use (it uses 4)`,
    });
  });

  it("says 'none' for a step that uses no ingredient, and names every stray index", () => {
    expect(parseCookPlan(listing("stuff", [5, 0]), MAPPED)).toMatchObject({
      rule: "ingredient-outside-step",
      detail: `cook "stuff" lists ingredient 5, 0, which step 3 doesn't use (it uses none)`,
    });
  });

  it("names every cook task that strays, so one re-ask can fix them all", () => {
    const raw = listing("stir", [4, 6]);
    raw.tasks.find((t) => t.id === "chili")!.ingredientIdx = [6, 5];
    const result = parseCookPlan(raw, MAPPED);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.violations.map((v) => v.detail)).toEqual([
      `cook "stir" lists ingredient 6, which step 1 doesn't use (it uses 4)`,
      `cook "chili" lists ingredient 5, which step 4 doesn't use (it uses 6)`,
    ]);
  });

  it("leaves mise tasks free: one readies an ingredient for whichever step uses it", () => {
    expect(parseCookPlan(listing("onion", [1, 6]), MAPPED).ok).toBe(true);
  });

  it("binds nothing without a mapping that fits the recipe", () => {
    const stray = () => listing("stir", [4, 6]);
    expect(parseCookPlan(stray(), ZUCCHINI_RECIPE).ok).toBe(true);
    // One list short (a row stored against other steps), and an index past the list.
    expect(parseCookPlan(stray(), { ...ZUCCHINI_RECIPE, stepIngredients: [[0, 1, 2, 3], [4], [5], []] }).ok).toBe(true);
    expect(parseCookPlan(stray(), { ...ZUCCHINI_RECIPE, stepIngredients: [[0, 1, 2, 3], [4], [5], [], [7]] }).ok).toBe(
      true,
    );
  });
});

describe("stepIngredientBounds", () => {
  const withMap = (stepIngredients: unknown) => ({ ...ZUCCHINI_RECIPE, stepIngredients }) as RecipeForPlan;

  it("returns the mapping when it has one list per step of indices into the ingredients", () => {
    expect(stepIngredientBounds(MAPPED)).toEqual([[0, 1, 2, 3], [4], [5], [], [6]]);
  });

  it.each([
    ["absent", undefined],
    ["one list short", [[0], [4], [5], []]],
    ["one list over", [[0], [4], [5], [], [6], []]],
    ["an index past the ingredients", [[0], [4], [5], [], [7]]],
    ["a negative index", [[-1], [4], [5], [], [6]]],
    ["a fractional index", [[0.5], [4], [5], [], [6]]],
    ["an entry that isn't a list", [[0], 4, [5], [], [6]]],
  ])("is null for a mapping %s", (_name, map) => {
    expect(stepIngredientBounds(withMap(map))).toBeNull();
  });

  it("is null for a recipe with no steps", () => {
    expect(stepIngredientBounds({ ingredients: ZUCCHINI_RECIPE.ingredients, steps: [], stepIngredients: [] })).toBeNull();
  });
});

describe("the derive with a mapping", () => {
  function reply(raw: unknown) {
    mockChat.mockResolvedValueOnce({ content: JSON.stringify(raw), finishReason: "stop" });
  }

  it("ends each step with its ingredients, 'none' for a step with none", async () => {
    reply(zucchiniRaw());
    await deriveCookPlan(MAPPED);
    const prompt = mockChat.mock.calls[0]![0].messages[0].content as string;
    expect(prompt).toContain(`[0] ${MAPPED.steps![0]} (ingredients: 0, 1, 2, 3)\n`);
    expect(prompt).toContain(`[3] ${MAPPED.steps![3]} (ingredients: none)\n`);
    expect(prompt).toContain(`[4] ${MAPPED.steps![4]} (ingredients: 6)`);
  });

  it("leaves the steps as written without one", async () => {
    reply(zucchiniRaw());
    await deriveCookPlan(ZUCCHINI_RECIPE);
    const prompt = mockChat.mock.calls[0]![0].messages[0].content as string;
    expect(prompt).not.toContain("(ingredients:");
    expect(prompt).toContain(`[3] ${ZUCCHINI_RECIPE.steps![3]}\n`);
  });

  it("re-asks a stray cook task once with the rule and its hint, and keeps the corrected plan", async () => {
    reply(listing("stir", [4, 6]));
    reply(zucchiniRaw());
    const { result, rejections } = await deriveCookPlan(MAPPED);
    expect(result.ok).toBe(true);
    expect(rejections.map((r) => r.rule)).toEqual(["ingredient-outside-step"]);
    const correction = mockChat.mock.calls[1]![0].messages[2].content as string;
    expect(correction).toContain(`(ingredient-outside-step): cook "stir" lists ingredient 6, which step 1 doesn't use`);
    expect(correction).toContain(REASK_HINTS["ingredient-outside-step"]);
  });

  it("tells the model the rule in the system prompt, with an example that keeps it", () => {
    expect(COOK_PLAN_SYSTEM_PROMPT).toContain("(ingredients: ");
    expect(COOK_PLAN_SYSTEM_PROMPT).toContain("a cook task's come only from the step it cites");
  });
});
