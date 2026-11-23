import { describe, expect, it } from "vitest";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { sourceHash } from "../serves-estimate-plan";
import {
  INTAKE_FOR_NOW,
  INTAKE_MAX_TRIES,
  describeIntake,
  intakeErrorAfter,
  isSettledIntakeError,
  queueIntake,
  withCookRecipe,
  type IntakeRow,
} from "./intake-state";

const SENT: KitchenQueueRecipeData = {
  name: "Toast",
  ingredients: [{ item: "bread, butter", amount: "2" }],
  steps: ["Toast the bread and butter it."],
};
const CUT: KitchenQueueRecipeData = {
  name: "Toast",
  ingredients: [{ item: "bread", amount: "2" }, { item: "butter" }],
  steps: ["Toast the bread.", "Butter it."],
  stepIngredients: [[0], [1]],
};

function row(over: Partial<IntakeRow>): IntakeRow {
  return {
    recipeData: SENT,
    intakeRecipe: null,
    intakeError: null,
    intakeSourceHash: sourceHash("kitchen_queue", SENT),
    cookPlan: null,
    cookPlanError: null,
    ...over,
  };
}

describe("queueIntake", () => {
  it("none: a row intake was never asked for cooks what was stored, even with a plan", () => {
    expect(queueIntake(row({ intakeSourceHash: null, cookPlan: { version: 4 } }))).toEqual({
      state: "none",
      recipe: SENT,
      error: null,
    });
  });

  it("none: a row with no recipe (a Notion id alone)", () => {
    expect(queueIntake(row({ recipeData: null }))).toEqual({ state: "none", recipe: null, error: null });
  });

  it("pending: asked for, no outcome, nothing planned: the recipe as sent for now", () => {
    expect(queueIntake(row({}))).toEqual({ state: "pending", recipe: SENT, error: null });
  });

  it("normalized: the cut, with the hash read from stored jsonb in any key order", () => {
    const reordered = { steps: SENT.steps, name: SENT.name, ingredients: SENT.ingredients };
    expect(queueIntake(row({ recipeData: reordered, intakeRecipe: CUT }))).toEqual({
      state: "normalized",
      recipe: CUT,
      error: null,
    });
  });

  it("normalized wins over a plan: the plan was worked out from the cut", () => {
    expect(queueIntake(row({ intakeRecipe: CUT, cookPlan: { version: 4 } })).state).toBe("normalized");
  });

  it("as-sent: the stored error", () => {
    expect(queueIntake(row({ intakeError: "Intake timed out after 90 s" }))).toEqual({
      state: "as-sent",
      recipe: SENT,
      error: "Intake timed out after 90 s",
    });
  });

  it("as-sent: a plan or a plan error stored before intake landed", () => {
    for (const over of [{ cookPlan: { version: 4 } }, { cookPlanError: "rejected (cycle): …" }]) {
      expect(queueIntake(row(over))).toEqual({
        state: "as-sent",
        recipe: SENT,
        error: "the prep plan was worked out from the recipe as sent before intake ran",
      });
    }
  });

  it("as-sent: a cut that doesn't read", () => {
    const broken = { name: 7 } as unknown as KitchenQueueRecipeData;
    const intake = queueIntake(row({ intakeRecipe: broken }));
    expect(intake.state).toBe("as-sent");
    expect(intake.recipe).toBe(SENT);
    expect(intake.error).toMatch(/^the stored cut can't be read: name: /);
  });

  it("withCookRecipe: the cut in recipeData, the rest of the row as it was, the state beside it", () => {
    const stored = { ...row({ intakeRecipe: CUT }), id: "q1" };
    expect(withCookRecipe(stored)).toEqual({ ...stored, recipeData: CUT, intake: { state: "normalized", error: null } });
  });

  it("describeIntake: one line per state for the reports, none for a row never asked", () => {
    expect(describeIntake({ state: "none", error: null })).toBeNull();
    expect(describeIntake({ state: "pending", error: null })).toBe("intake: waiting");
    expect(describeIntake({ state: "normalized", error: null })).toBe("intake: cut");
    expect(describeIntake({ state: "as-sent", error: "quota exceeded" })).toBe("intake: shown as sent (quota exceeded)");
  });

  it("describeIntake: a kept cut's nudges and a waiting row's tries, from the row", () => {
    expect(describeIntake({ state: "normalized", error: null }, { nudges: [] })).toBe("intake: cut");
    expect(
      describeIntake(
        { state: "normalized", error: null },
        { nudges: ["crowded-line: line 3 names two", "unpaused-split: step 2"] },
      ),
    ).toBe("intake: cut, kept with 2 nudges (crowded-line: line 3 names two; unpaused-split: step 2)");
    expect(describeIntake({ state: "pending", error: "failed for now: 503" }, { attempts: 1 })).toBe(
      `intake: waiting to try again, 1 of ${INTAKE_MAX_TRIES} tries spent (failed for now: 503)`,
    );
  });

  it("intakeErrorAfter: an error for now is stored for now until the last try, then settled", () => {
    const forNow = `${INTAKE_FOR_NOW}503 overloaded`;
    expect(intakeErrorAfter(forNow, 1)).toBe(forNow);
    expect(intakeErrorAfter(forNow, INTAKE_MAX_TRIES - 1)).toBe(forNow);
    const capped = intakeErrorAfter(forNow, INTAKE_MAX_TRIES);
    expect(capped).toBe(`failed ${INTAKE_MAX_TRIES} times, the last: 503 overloaded`);
    expect(isSettledIntakeError(capped)).toBe(true);
    // A settled error stays as it is, whatever the count.
    expect(intakeErrorAfter("rejected (dropped-number): x", 1)).toBe("rejected (dropped-number): x");
  });

  it("as-sent: a hash that names another recipe, cut or not", () => {
    const other = sourceHash("kitchen_queue", { ...SENT, name: "Jam toast" });
    for (const over of [{}, { intakeRecipe: CUT }]) {
      expect(queueIntake(row({ ...over, intakeSourceHash: other }))).toEqual({
        state: "as-sent",
        recipe: SENT,
        error: "the intake was asked for another recipe than the one stored",
      });
    }
  });
});
