import { describe, expect, it } from "vitest";
import { loadKitchenPlans, parseKitchenPlan } from "./load-kitchen-plans";

const good = () => ({
  description: "a test plan",
  plan: {
    version: 4,
    tasks: [
      {
        id: "slice",
        kind: "mise",
        branch: "Salad",
        label: "slice cucumber",
        text: "slice cucumber",
        sourceStep: null,
        implied: true,
        needs: [],
        minutes: { est: 5, handsOff: false },
      },
    ],
  },
});

describe("kitchen plan fixtures", () => {
  it("load, every task's text its label and no ingredient indices", () => {
    const plans = loadKitchenPlans();
    expect(plans.map((p) => p.name)).toEqual([
      "butternut-chickpea-salad",
      "chicken-pita-wraps",
      "skillet-eggs-potatoes-greens",
      "tomato-beans-greens",
    ]);
    for (const p of plans) {
      for (const t of p.plan.tasks) {
        expect(t.text).toBe(t.label);
        expect(t.ingredientIdx).toEqual([]);
      }
    }
  });

  it("accept a plan-only file", () => {
    expect(parseKitchenPlan("ok", good()).plan.tasks[0]).toMatchObject({ id: "slice", ingredientIdx: [] });
  });

  it("refuse task text other than the label, so no recipe prose rides in", () => {
    const raw = good();
    raw.plan.tasks[0].text = "Slice the cucumber into thin half-moons.";
    expect(() => parseKitchenPlan("prose", raw)).toThrow("Kitchen plan prose: slice's text is not its label");
  });

  it("refuse a cue or ingredient indices", () => {
    const withCue = good();
    Object.assign(withCue.plan.tasks[0], { cue: "until crisp" });
    expect(() => parseKitchenPlan("cue", withCue)).toThrow(/Kitchen plan cue/);
    const withIngredients = good();
    Object.assign(withIngredients.plan.tasks[0], { ingredientIdx: [0] });
    expect(() => parseKitchenPlan("ingredients", withIngredients)).toThrow(/Kitchen plan ingredients/);
  });
});
