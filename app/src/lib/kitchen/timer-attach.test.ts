import { describe, expect, it } from "vitest";
import type { Recipe } from "@sous/pack";
import type { CookPlan, CookTask } from "./cook-plan";
import { offerForScreen, timerOffers } from "./timer-attach";

const COOK = { queueId: "q1", recipeName: "Dal" };

function recipe(steps: [string, number | null][]): Recipe {
  return {
    id: "r",
    title: "Dal",
    serves_base: 4,
    ingredients: [],
    steps: steps.map(([id, timer_sec]) => ({ id, type: "action", text: id, timer_sec })),
  } as unknown as Recipe;
}

function task(id: string, sourceStep: number | null, text: string, label = id): CookTask {
  return {
    id,
    kind: "cook",
    text,
    label,
    ingredientIdx: [],
    sourceStep,
    implied: sourceStep === null,
    needs: [],
    branch: "Dal",
  };
}

function plan(...tasks: CookTask[]): CookPlan {
  return { version: 4, tasks };
}

describe("timerOffers (B5a, A9)", () => {
  it("offers a step's timer on the task whose words state its length", () => {
    const offers = timerOffers(
      plan(
        task("rinse", 0, "Rinse the dal."),
        task("boil", 0, "Boil the dal 20 minutes, skimming.", "boil dal"),
        task("salt", 0, "Salt it."),
      ),
      recipe([["step-0", 1200]]),
      COOK,
    );
    expect([...offers.keys()]).toEqual(["boil"]);
    expect(offers.get("boil")).toEqual({
      id: "q1:step-0",
      queueId: "q1",
      recipeName: "Dal",
      stepId: "step-0",
      label: "Boil dal",
      durationMs: 1_200_000,
      durationSec: 1200,
    });
  });

  it("offers it on the step's last task when no task's words state it", () => {
    const offers = timerOffers(
      plan(task("a", 0, "Fry onions."), task("b", 0, "Keep stirring."), task("c", 1, "Plate.")),
      recipe([
        ["step-0", 600],
        ["step-1", null],
      ]),
      COOK,
    );
    expect([...offers.keys()]).toEqual(["b"]);
  });

  it("finds a step by id, past a blank stored step the converter skipped", () => {
    const offers = timerOffers(
      plan(task("t", 2, "Bake 30 minutes.")),
      recipe([
        ["step-0", null],
        ["step-2", 1800],
      ]),
      COOK,
    );
    expect(offers.get("t")?.stepId).toBe("step-2");
  });

  it("offers nothing for a step with no timer, an implied task or a step past the list", () => {
    const offers = timerOffers(
      plan(task("a", 0, "Chop."), task("b", null, "Heat oil 5 minutes."), task("c", 9, "Rest 5 minutes.")),
      recipe([["step-0", null]]),
      COOK,
    );
    expect(offers.size).toBe(0);
  });

  it("offers nothing over 12 hours: a day-ahead wait is a lead", () => {
    const offers = timerOffers(
      plan(task("cure", 0, "Cure 3 days.")),
      recipe([["step-0", 3 * 24 * 3600]]),
      COOK,
    );
    expect(offers.size).toBe(0);
    const twelve = timerOffers(plan(task("p", 0, "Proof 12 hours.")), recipe([["step-0", 12 * 3600]]), COOK);
    expect(twelve.size).toBe(1);
  });

  it("gives a timer named 'Timer' when the task has no label", () => {
    const offers = timerOffers(plan(task("x", 0, "Simmer.", "  ")), recipe([["step-0", 60]]), COOK);
    expect(offers.get("x")?.label).toBe("Timer");
  });
});

describe("offerForScreen", () => {
  it("finds the offer of any task merged onto a screen", () => {
    const offers = timerOffers(
      plan(task("a", 0, "Chop."), task("b", 1, "Simmer 5 minutes.")),
      recipe([
        ["step-0", null],
        ["step-1", 300],
      ]),
      COOK,
    );
    expect(offerForScreen(offers, "a+b")?.id).toBe("q1:step-1");
    expect(offerForScreen(offers, "a")).toBeNull();
    expect(offerForScreen(offers, "prep")).toBeNull();
  });
});
