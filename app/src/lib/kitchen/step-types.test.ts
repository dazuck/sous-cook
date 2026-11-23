import { describe, expect, it } from "vitest";
import { fannieNative } from "../pack-convert/__tests__/fannie-native";
import { readQueueRecipe } from "../pack-convert/queue-recipe";
import { EMPTY_LIBRARY } from "../pack-convert/recipe-library";
import { identityPlan, type CookPlan, type CookTask } from "./cook-plan";
import { hasHowToCheck, screenStep } from "./step-types";

// Which kind of step a cook screen is (slice B5d, B5.md §B5d D7–D10).

const KEY = "pack:fannie-farmer-1896/x";

function asWritten(recipeId: string) {
  const r = fannieNative(recipeId);
  return { ...r, plan: identityPlan(r.recipeData) };
}

function at(plan: CookPlan, step: number): CookTask[] {
  return [plan.tasks.find((t) => t.sourceStep === step)!];
}

describe("screenStep", () => {
  it("a checkpoint carries its states' names and looks, in order, and its hints", () => {
    const { plan, packRecipe, library } = asWritten("boiled-custard");
    expect(screenStep(plan, packRecipe, library, at(plan, 5), KEY)).toEqual({
      kind: "checkpoint",
      evidence: [
        {
          name: "Custard coats the spoon",
          look: expect.stringMatching(/^An even opaque film clings/) as string,
        },
        { name: expect.any(String) as string, look: expect.any(String) as string },
      ],
      hints: [],
    });
  });

  it("a checkpoint with coach hints carries them", () => {
    const { plan, packRecipe, library } = asWritten("parker-house-rolls");
    const step = screenStep(plan, packRecipe, library, at(plan, 3), KEY);
    expect(step.kind === "checkpoint" && step.hints).toHaveLength(2);
    expect(hasHowToCheck(step)).toBe(true);
  });

  it("a state missing from the library is left out; with nothing to show there is no how-to-check", () => {
    const { plan, packRecipe } = asWritten("boiled-custard");
    const step = screenStep(plan, packRecipe, EMPTY_LIBRARY, at(plan, 5), KEY);
    expect(step).toEqual({ kind: "checkpoint", evidence: [], hints: [] });
    expect(hasHowToCheck(step)).toBe(false);
  });

  it("an interlude: its title, keyed by its techniques", () => {
    const { plan, packRecipe, library } = asWritten("doughnuts-i");
    expect(screenStep(plan, packRecipe, library, at(plan, 10), KEY)).toEqual({
      kind: "interlude",
      title: "About the fat",
      keys: ["commons:deep-frying", "commons:testing-fat-temperature"],
    });
  });

  it("an interlude with no technique is keyed by its recipe and step", () => {
    const { plan, packRecipe, library } = asWritten("waffles");
    const bare = structuredClone(packRecipe);
    bare.steps[0]!.technique_refs = [];
    expect(screenStep(plan, bare, library, at(plan, 0), KEY)).toMatchObject({ kind: "interlude", keys: [`${KEY}#step-0`] });
  });

  it("a wait", () => {
    const { plan, packRecipe, library } = asWritten("parker-house-rolls");
    expect(screenStep(plan, packRecipe, library, at(plan, 6), KEY)).toEqual({ kind: "wait" });
  });

  it("an action, an implied task and merged mise are actions", () => {
    const { plan, packRecipe, library } = asWritten("boiled-custard");
    expect(screenStep(plan, packRecipe, library, at(plan, 0), KEY)).toEqual({ kind: "action" });
    const implied = { ...plan.tasks[5]!, sourceStep: null };
    expect(screenStep(plan, packRecipe, library, [implied], KEY)).toEqual({ kind: "action" });
    const mise = plan.tasks.slice(5, 7).map((t) => ({ ...t, kind: "mise" as const }));
    expect(screenStep(plan, packRecipe, library, mise, KEY)).toEqual({ kind: "action" });
  });

  it("a step cited by two tasks gives its type to the later; the other is an action", () => {
    const { plan, packRecipe, library } = asWritten("boiled-custard");
    const gate = plan.tasks.find((t) => t.sourceStep === 5)!;
    const before: CookTask = { ...gate, id: "gate-a" };
    const split: CookPlan = { ...plan, tasks: plan.tasks.flatMap((t) => (t.id === gate.id ? [before, t] : [t])) };
    expect(screenStep(split, packRecipe, library, [before], KEY)).toEqual({ kind: "action" });
    expect(screenStep(split, packRecipe, library, [gate], KEY).kind).toBe("checkpoint");
  });

  it("a recipe read from its projection is all actions", () => {
    const { plan, recipeData, servesEstimate, servesEstimateBasis } = asWritten("boiled-custard");
    const projected = readQueueRecipe({ id: "q", recipeData, servesEstimate, servesEstimateBasis }).packRecipe!;
    for (let i = 0; i < 9; i++) expect(screenStep(plan, projected, EMPTY_LIBRARY, at(plan, i), KEY)).toEqual({ kind: "action" });
  });
});
