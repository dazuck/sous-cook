import { describe, it, expect } from "vitest";
import {
  COOK_PLAN_VERSION,
  hasStepsToPlan,
  identityPlan,
  isCurrentCookPlan,
  leadMinutes,
  parseCookPlan,
  quantitiesIn,
  type CookPlanParseResult,
  type RecipeForPlan,
} from "./cook-plan";
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
  danDanRaw,
  danDanUncoveredRaw,
  tortaFixedRaw,
  tortaRaw,
  wingsFixedRaw,
  wingsRaw,
} from "./__tests__/three-reask-recipes";
import { verdictBattery } from "./__tests__/verdict-battery";

type RawTask = Record<string, unknown>;

/** Raw zucchini plan with one task edited in place. */
function withTask(id: string, edit: (t: RawTask) => void) {
  const raw = zucchiniRaw();
  const t = raw.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  edit(t);
  return raw;
}

function rejected(result: CookPlanParseResult): string {
  if (result.ok) throw new Error("expected rejection, got a valid plan");
  return result.rule;
}

describe("parseCookPlan", () => {
  it("accepts the zucchini plan and stamps the current version", () => {
    const result = parseCookPlan(zucchiniRaw(), ZUCCHINI_RECIPE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.version).toBe(COOK_PLAN_VERSION);
    expect(result.plan).toEqual(ZUCCHINI_PLAN);
  });

  it("normalizes null optional fields to absent", () => {
    const result = parseCookPlan(zucchiniRaw(), ZUCCHINI_RECIPE);
    if (!result.ok) throw new Error(result.detail);
    const onion = result.plan.tasks.find((t) => t.id === "onion")!;
    expect("cue" in onion).toBe(false);
    expect("lead" in onion).toBe(false);
  });

  it("drops out-of-range and duplicate ingredient indices, as stepIngredients does", () => {
    const raw = withTask("saute", (t) => {
      t.ingredientIdx = [0, 1, 1, 2, 3, 99, -1, 2.5];
    });
    const result = parseCookPlan(raw, ZUCCHINI_RECIPE);
    if (!result.ok) throw new Error(result.detail);
    const saute = result.plan.tasks.find((t) => t.id === "saute")!;
    expect(saute.ingredientIdx).toEqual([0, 1, 2, 3]);
  });

  it("rejects output that is not the plan shape", () => {
    expect(rejected(parseCookPlan("nope", ZUCCHINI_RECIPE))).toBe("shape");
    expect(rejected(parseCookPlan({ tasks: [] }, ZUCCHINI_RECIPE))).toBe(
      "shape",
    );
    const badKind = withTask("fry", (t) => {
      t.kind = "garnish";
    });
    expect(rejected(parseCookPlan(badKind, ZUCCHINI_RECIPE))).toBe("shape");
  });

  it("rejects a duplicate task id", () => {
    const raw = withTask("scape", (t) => {
      t.id = "onion";
    });
    expect(rejected(parseCookPlan(raw, ZUCCHINI_RECIPE))).toBe("duplicate-id");
  });

  it("rejects a need that names no task", () => {
    const raw = withTask("stuff", (t) => {
      t.needs = ["stir", "fry", "warm-plates"];
    });
    expect(rejected(parseCookPlan(raw, ZUCCHINI_RECIPE))).toBe("dangling-need");
  });

  it("rejects a cycle, including a task that needs itself", () => {
    const loop = withTask("saute", (t) => {
      t.needs = ["onion", "scape", "zuc", "stir"];
    });
    expect(rejected(parseCookPlan(loop, ZUCCHINI_RECIPE))).toBe("cycle");
    const self = withTask("fry", (t) => {
      t.needs = ["fry"];
    });
    expect(rejected(parseCookPlan(self, ZUCCHINI_RECIPE))).toBe("cycle");
  });

  it("rejects a source step that no task covers", () => {
    const raw = zucchiniRaw();
    raw.tasks = raw.tasks.filter((t) => t.id !== "chili");
    expect(parseCookPlan(raw, ZUCCHINI_RECIPE)).toEqual({
      ok: false,
      rule: "uncovered-step",
      detail: "no task covers step 4",
      uncoveredSteps: [4],
      violations: [{ rule: "uncovered-step", detail: "no task covers step 4", uncoveredSteps: [4] }],
    });
  });

  it("names every step no task covers, not only the first (peanut chutney, R31)", () => {
    // A re-ask told only the first uncited step fixes one per call, and two
    // calls can't fix eighteen.
    expect(parseCookPlan(chutneyMergedRaw(), CHUTNEY_RECIPE)).toEqual({
      ok: false,
      rule: "uncovered-step",
      detail: "no task covers steps 3, 4, 7, 11, 14",
      uncoveredSteps: CHUTNEY_UNCITED,
      violations: [
        { rule: "uncovered-step", detail: "no task covers steps 3, 4, 7, 11, 14", uncoveredSteps: CHUTNEY_UNCITED },
      ],
    });
    expect(parseCookPlan(chutneyRaw(), CHUTNEY_RECIPE).ok).toBe(true);
  });

  it("still names an earlier step's dropped number before a later uncovered step", () => {
    const raw = chutneyMergedRaw();
    raw.tasks[0]!.text = "Toast the peanuts on low heat.";
    expect(parseCookPlan(raw, CHUTNEY_RECIPE)).toMatchObject({
      ok: false,
      rule: "dropped-number",
      detail: expect.stringMatching(/^step 0 says 13 min/),
    });
  });

  it("rejects a source step index outside the recipe", () => {
    const raw = withTask("chili", (t) => {
      t.sourceStep = 5;
    });
    expect(rejected(parseCookPlan(raw, ZUCCHINI_RECIPE))).toBe(
      "bad-source-step",
    );
  });

  it("rejects a plan that drops a number from its source step", () => {
    const raw = withTask("saute", (t) => {
      t.text = "Sauté everything with the cumin until sweet and caramelized.";
    });
    const result = parseCookPlan(raw, ZUCCHINI_RECIPE);
    expect(rejected(result)).toBe("dropped-number");
    if (!result.ok) expect(result.detail).toContain("15");
  });

  it("does not count a number said only in the cue", () => {
    // The cook view shows a task's text; a number in the cue is never seen.
    const inCue = withTask("saute", (t) => {
      t.text = "Sauté everything with the cumin.";
      t.cue = "until sweet and caramelized, about 15 minutes";
    });
    expect(rejected(parseCookPlan(inCue, ZUCCHINI_RECIPE))).toBe(
      "dropped-number",
    );
  });

  it("does not accept the number from minutes.est alone", () => {
    const raw = withTask("saute", (t) => {
      t.text = "Sauté everything with the cumin until caramelized.";
      t.minutes = { est: 15, handsOff: true };
    });
    expect(rejected(parseCookPlan(raw, ZUCCHINI_RECIPE))).toBe(
      "dropped-number",
    );
  });

  it("rejects implied that disagrees with sourceStep", () => {
    const impliedWithStep = withTask("fry", (t) => {
      t.implied = true;
    });
    expect(rejected(parseCookPlan(impliedWithStep, ZUCCHINI_RECIPE))).toBe(
      "implied-mismatch",
    );
    const notImpliedNoStep = withTask("onion", (t) => {
      t.implied = false;
    });
    expect(rejected(parseCookPlan(notImpliedNoStep, ZUCCHINI_RECIPE))).toBe(
      "implied-mismatch",
    );
  });

  it("rejects a cook task the recipe never states, wherever it sits", () => {
    // Implied work is prep the recipe assumes. A cook step it never says is
    // invented, and would put an instruction in front of the cook.
    const midway = zucchiniRaw();
    const saute = midway.tasks.find((t) => t.id === "saute")!;
    midway.tasks.push({
      ...saute,
      id: "deglaze",
      text: "Deglaze the pan with a splash of wine.",
      label: "deglaze",
      ingredientIdx: [],
      sourceStep: null,
      implied: true,
      needs: ["saute"],
      minutes: null,
      cue: null,
    });
    midway.tasks.find((t) => t.id === "stir")!.needs = ["deglaze", "greens"];
    const result = parseCookPlan(midway, ZUCCHINI_RECIPE);
    expect(rejected(result)).toBe("invented-cook");
    if (!result.ok) expect(result.detail).toContain("deglaze");

    const atTheEnd = zucchiniRaw();
    atTheEnd.tasks.push({
      ...saute,
      id: "plates",
      text: "Warm the plates.",
      label: "warm plates",
      ingredientIdx: [],
      sourceStep: null,
      implied: true,
      needs: ["chili"],
      minutes: null,
      cue: null,
      branch: "Assemble",
    });
    expect(rejected(parseCookPlan(atTheEnd, ZUCCHINI_RECIPE))).toBe("invented-cook");
  });

  it("accepts an estimate of up to a week, so a two-day brine keeps its plan", () => {
    const withEst = (est: number) =>
      withTask("onion", (t) => {
        t.minutes = { est, handsOff: true };
      });
    expect(parseCookPlan(withEst(2880), ZUCCHINI_RECIPE).ok).toBe(true);
    expect(parseCookPlan(withEst(10080), ZUCCHINI_RECIPE).ok).toBe(true);
    expect(rejected(parseCookPlan(withEst(10081), ZUCCHINI_RECIPE))).toBe("shape");
  });

  it("rejects mise that waits on a cook task (it could not be prepped first)", () => {
    const raw = withTask("greens", (t) => {
      t.needs = ["saute"];
    });
    expect(rejected(parseCookPlan(raw, ZUCCHINI_RECIPE))).toBe(
      "mise-needs-cook",
    );
  });

  it("rejects an ahead task that waits on mise or cook work", () => {
    const raw = zucchiniRaw();
    raw.tasks.push({
      id: "marinate",
      kind: "ahead",
      text: "Marinate the sliced onion",
      label: "marinate",
      ingredientIdx: [1],
      sourceStep: null,
      implied: true,
      needs: ["onion"],
      minutes: null,
      cue: null,
      lead: "overnight",
      branch: "Filling",
    });
    expect(rejected(parseCookPlan(raw, ZUCCHINI_RECIPE))).toBe(
      "ahead-needs-later",
    );
  });

  it("rejects a plan with no cook task", () => {
    const recipe = { ingredients: [{ item: "onion" }], steps: ["Dice it."] };
    const raw = {
      tasks: [
        {
          id: "dice",
          kind: "mise",
          text: "Dice it.",
          label: "dice",
          ingredientIdx: [0],
          sourceStep: 0,
          implied: false,
          needs: [],
          branch: "Prep",
        },
      ],
    };
    expect(rejected(parseCookPlan(raw, recipe))).toBe("no-cook-task");
  });
});

/**
 * A one-step recipe and a plan citing it: one cook task per text, chained so
 * the plan ends once.
 */
function oneStep(step: string, ...texts: string[]): CookPlanParseResult {
  const recipe: RecipeForPlan = { ingredients: [], steps: [step] };
  const tasks = texts.map((text, i) => ({
    id: `t${i}`,
    kind: "cook",
    text,
    label: `t${i}`,
    ingredientIdx: [],
    sourceStep: 0,
    implied: false,
    needs: i === 0 ? [] : [`t${i - 1}`],
    minutes: null,
    cue: null,
    lead: null,
    branch: "Cook",
  }));
  return parseCookPlan({ tasks }, recipe);
}

describe("parseCookPlan: numbers", () => {
  it("keeps each number the step says, not just one of each value", () => {
    const result = oneStep(
      "Whisk 2 eggs and bake for 2 hours at 350°F.",
      "Whisk 2 eggs and bake at 350°F until set.",
    );
    expect(rejected(result)).toBe("dropped-number");
    if (!result.ok) expect(result.detail).toContain("120 min");
  });

  it("pools the tasks that split a step, and still misses a dropped number", () => {
    expect(
      oneStep("Dice 1 onion and cook for 1 minute.", "Dice 1 onion.", "Cook for 1 minute.").ok,
    ).toBe(true);
    expect(
      rejected(oneStep("Dice 1 onion and cook for 1 minute.", "Dice 1 onion.", "Cook until soft.")),
    ).toBe("dropped-number");
    expect(
      rejected(
        oneStep(
          "Slice the 12 mushrooms and fry for 12 minutes.",
          "Slice the 12 mushrooms.",
          "Fry until golden.",
        ),
      ),
    ).toBe("dropped-number");
  });

  it("carries a number written as a word when it has a unit", () => {
    expect(rejected(oneStep("Simmer for twenty minutes.", "Simmer until thick."))).toBe(
      "dropped-number",
    );
    expect(oneStep("Simmer for twenty minutes.", "Simmer for 20 minutes.").ok).toBe(true);
    expect(oneStep("Simmer for twenty-five minutes.", "Simmer 25 minutes.").ok).toBe(true);
    // A bare "one" is too often not a quantity ("one at a time").
    expect(oneStep("Add one onion.", "Add the onion.").ok).toBe(true);
  });

  it("carries a bare word number above one", () => {
    expect(rejected(oneStep("Add two onions.", "Add the onions."))).toBe("dropped-number");
    expect(rejected(oneStep("Cut into eight wedges.", "Cut into wedges."))).toBe(
      "dropped-number",
    );
    expect(oneStep("Add two onions.", "Add the 2 onions.").ok).toBe(true);
  });

  it("carries a time said in words with no number", () => {
    expect(
      rejected(oneStep("Let the dough rest for half an hour.", "Let the dough rest.")),
    ).toBe("dropped-number");
    expect(rejected(oneStep("Braise for an hour.", "Braise until tender."))).toBe(
      "dropped-number",
    );
    expect(oneStep("Braise for an hour.", "Braise for an hour.").ok).toBe(true);
    expect(oneStep("Let it rest half an hour.", "Let it rest 30 minutes.").ok).toBe(true);
    expect(oneStep("Braise an hour and a half.", "Braise for 90 minutes.").ok).toBe(true);
  });

  it.each([
    ["Bake at 350°F.", "Bake at 350°C."],
    ["Rest for 10 minutes.", "Rest for 10 seconds."],
    ["Add 1 tbsp butter.", "Add 1 tsp butter."],
    ["Add 1 T butter.", "Add 1 t butter."],
    ["Add 3 cloves garlic.", "Add the garlic, 3 minutes."],
    // A word the reader doesn't know as a unit is still a different unit.
    ["Melt 2 tablespoons of butter.", "Melt 2 sticks of butter."],
    ["Add 2 cups chopped onion.", "Add 2 chopped onions."],
    ["Add 2 teaspoons minced garlic.", "Add 2 cloves minced garlic."],
  ])("rejects a number whose unit changed: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    ["Stir in two and a half cups of flour.", "Stir in the flour."],
    ["Stir in one and a half cups of flour.", "Stir in 1 cup of flour."],
    ["Add three-quarters cup milk.", "Add the milk."],
    ["Preheat the oven to 350.", "Preheat the oven."],
  ])("still rejects a quantity said in words and dropped: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    ["Bake at 200°C for 20 minutes.", "Bake at 200 for 20 minutes."],
    ["Roast at 425°F.", "Roast at 425 degrees."],
    ["Roast at 425°F.", "Roast at 425°."],
    ["Bake at 350°.", "Bake at 350."],
    ["Heat the oil to 180 degrees.", "Heat the oil to 180."],
    ["Bake at 350oF.", "Bake at 350."],
    ["Bake at 350ᵒF.", "Bake at 350."],
    ["Bake at 350\u200b°F.", "Bake at 350."],
    ["Bake at ３５０°F.", "Bake."],
  ])("rejects a temperature that lost its scale: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    ["Add 1½ cups stock.", "Add 1.5 cups stock."],
    ["Add 1,000 g flour.", "Add 1000 g flour."],
    ["1. Preheat the oven to 400°F.", "Preheat the oven to 400°F."],
    ["Roast for 1 hour.", "Roast for 60 minutes."],
    ["Simmer 3-4 minutes.", "Simmer 3 to 4 minutes."],
    ["Bake at 350 degrees.", "Bake at 350°F."],
    ["Bake at 180℃ for 20 minutes.", "Bake at 180°C for 20 minutes."],
    ["Bake at 350℉.", "Bake at 350°F."],
    ["Bake at 350˚F.", "Bake at 350°F."],
    ["Bake at 350&deg;F.", "Bake at 350°F."],
    ["Bake at 350&amp;deg;F.", "Bake at 350°F."],
    ["Add 250 gm flour.", "Add 250 g flour."],
    ["Add 500 mls stock.", "Add 500 ml stock."],
    ["Cut into 2 in. pieces.", "Cut into 2-inch pieces."],
    ["Add 1 tblsp oil.", "Add 1 tbsp oil."],
    ["Bake at 350°.", "Bake at 350°F."],
    ["Bake at 350&#XB0;F.", "Bake at 350°F."],
    ["Bake at 350&#0176;F.", "Bake at 350°F."],
    ["Bake at 350&degF.", "Bake at 350°F."],
    ["Bake at 350⁰F.", "Bake at 350°F."],
    ["Bake at 350oF.", "Bake at 350°F."],
    ["Bake at 350 oC.", "Bake at 350°C."],
    ["Bake at 350ᵒF.", "Bake at 350°F."],
    ["Bake at 350\u200b°F.", "Bake at 350°F."],
    ["Bake at ３５０°F.", "Bake at 350°F."],
    ["Stir in two and a half cups of flour.", "Stir in 2½ cups of flour."],
    ["Stir in one and a half cups of flour.", "Stir in 1 1/2 cups of flour."],
    ["Add two and three-quarters cups milk.", "Add 2¾ cups milk."],
    ["Add three-quarters cup milk.", "Add ¾ cup milk."],
    ["Add two-thirds of a cup of sugar.", "Add ⅔ cup sugar."],
    ["Pour into a nine-by-thirteen-inch pan.", "Pour into a 9x13-inch pan."],
    ["Rest three-quarters of an hour.", "Rest 45 minutes."],
    ["Rest a quarter of an hour.", "Rest 15 minutes."],
    ["Braise an hour and a quarter.", "Braise 75 minutes."],
    ["Braise an hour and one-half.", "Braise 90 minutes."],
    ["Add one and a quarter cups stock.", "Add 1¼ cups stock."],
    ["Add a cup and a half of stock.", "Add 1½ cups stock."],
    ["Cook 1 minute and a half.", "Cook 1.5 minutes."],
    ["Add two-and-a-half cups flour.", "Add 2½ cups flour."],
    ["Add two  thirds cup sugar.", "Add ⅔ cup sugar."],
    ["Simmer twenty-one and a half minutes.", "Simmer 21.5 minutes."],
    ["Add half a cup of milk.", "Add ½ cup milk."],
    ["Add a third of a cup of sugar.", "Add ⅓ cup sugar."],
    ["Fill the cups two-thirds full.", "Fill the cups ⅔ full."],
    ["Cut into 2 quarter-inch-thick planks.", "Cut into 2 planks, ¼ inch thick."],
    ["Shape into two quarter-pound patties.", "Shape into 2 patties of ¼ lb."],
    ["Set aside one half of the dough.", "Set aside half the dough."],
    ["Keep one third back.", "Keep a third back."],
  ])("accepts the same quantity written another way: %s → %s", (step, text) => {
    const result = oneStep(step, text);
    expect(result.ok ? "ok" : `${result.rule}: ${result.detail}`).toBe("ok");
  });

  it.each([
    ["Preheat the oven to 350.", "Preheat the oven to 350°F."],
    ["Heat the oil to 350.", "Heat the oil to 350°C."],
    ["Heat the oil to 180.", "Heat the oil to 180 degrees."],
    ["Divide the dough into 12.", "Divide the dough into 12°."],
    ["Cook 10, stirring.", "Cook 10 minutes, stirring."],
  ])("rejects a unit added to a bare number: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    ["Simmer for about 15 minutes.", "Simmer, about 15, until thick."],
    ["Add 2 cups stock.", "Add 2 of the stock."],
    // A stray word number elsewhere in the task is not the dropped measure.
    ["Add eggs one at a time, beating 1 minute after each.", "Add eggs one at a time, beating after each."],
    ["Sear 1 minute per side.", "Sear on one side, then the other."],
    ["Season with 1 teaspoon salt.", "Season with salt, one side at a time."],
  ])("rejects a unit dropped from a number: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    // A count of things that size, not a fraction of the size.
    ["Cut into 2 quarter-inch-thick planks.", "Cut into ½-inch planks."],
    ["Cut into 3 quarter-inch slices.", "Cut into ¾-inch slices."],
    ["Shape into two quarter-pound patties.", "Shape into ½-pound patties."],
    ["Rest three-quarters of an hour.", "Rest."],
    ["Rest three-quarters of an hour.", "Rest an hour."],
    ["Add 1 cup and a half teaspoon salt.", "Add 1½ cups salt."],
    ["Add a cup and a half of stock.", "Add the stock."],
    ["Add half a cup of milk.", "Add the milk."],
  ])("rejects a quantity misread or dropped: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    ["Flip and cook 1 more minute per side.", "Flip and cook on one side."],
    ["Cook 5 more minutes.", "Cook another 5."],
    ["Cook 5 more minutes, stirring.", "Cook 5 more hours, stirring."],
    ["Stir in 2 more tablespoons of water.", "Stir in 2 more teaspoons of water."],
    ["Simmer for 10 to 15 more minutes.", "Simmer for 10 to 15 more seconds."],
    ["Add 2 heaping tablespoons of cocoa.", "Add 2 heaping teaspoons of cocoa."],
    ["Add 1 level teaspoon of salt.", "Add 1 level tablespoon of salt."],
    ["Add 2 lightly packed cups of basil.", "Add 2 lightly packed handfuls of basil."],
    ["Simmer 20-odd minutes.", "Simmer 20-odd seconds."],
    ["Rest 5 or so minutes.", "Rest 5 or so."],
  ])("reads the unit past a word before it: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    ["Heat a tablespoon of oil in a pan.", "Heat oil in a pan."],
    ["Heat a tablespoon of oil in a pan.", "Heat 3 tablespoons of oil in a pan."],
    ["Add a cup of stock.", "Add the stock."],
    ["Add a teaspoon of salt.", "Add a tablespoon of salt."],
    ["Add a pound of beef.", "Add an ounce of beef."],
    ["Add a heaping tablespoon of cocoa.", "Add the cocoa."],
    ["Add a dozen eggs, one at a time.", "Add 6 eggs, one at a time."],
    ["Add half a dozen eggs.", "Add the eggs."],
    ["Cook for another minute.", "Cook briefly."],
    ["Cook for another minute or two.", "Cook for two."],
    ["Add a tsp and a half of salt.", "Add 1 tsp salt."],
    ["Stir in a tablespoon of oil.", "Stir in a tbsp and a half of oil."],
    ["Add a kilo and a half of flour.", "Add 1 kilo flour."],
    ["Add an oz and a half of gin.", "Add 1 oz gin."],
    ["Add a kg and a half of potatoes.", "Add 1 kg potatoes."],
    ["Cut into slices a centimetre and a half thick.", "Cut into 1 cm slices."],
    ["Beat a half-dozen eggs.", "Beat 12 eggs."],
    ["Beat a half-dozen eggs.", "Beat the eggs."],
    ["Crack one and a half dozen eggs.", "Crack 6 eggs."],
    ["Crack 1½ dozen eggs.", "Crack 12 eggs."],
    ["Cook for a further hour and a half.", "Cook for a further hour."],
    ["Cook for another hour and a half.", "Cook for another hour."],
    ["Braise a good hour and a half.", "Braise a good hour."],
    ["Add another cup and a half of stock.", "Add another cup of stock."],
    ["Add a heaping tablespoon and a half of cocoa.", "Add a heaping tablespoon of cocoa."],
    ["Add a scant cup and a half of milk.", "Add a scant cup of milk."],
    ["Add a tbsp. and a half of oil.", "Add 1 tbsp. oil."],
    ["Roast for an hr. and a half.", "Roast for 1 hr."],
    ["Rest for ½ an hour.", "Rest for an hour."],
    ["Fry the sliced eggplant in half an inch of oil.", "Fry the sliced eggplant in an inch of oil."],
    ["Simmer the sliced carrots in half a cup of water.", "Simmer the sliced carrots in a cup of water."],
    ["Cut the potatoes in half inch cubes.", "Cut the potatoes in 1 inch cubes."],
    ["Whisk the yolks of a dozen eggs.", "Whisk the yolks of 6 eggs."],
    ["Add a qt. and a half of stock.", "Add 1 qt. stock."],
  ])("reads a unit said with a or an: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    ["Whisk in .5 cup milk.", "Whisk in 5 cups milk."],
    ["Add 2 dl cream.", "Add 2 cl cream."],
  ])("rejects a quantity read the wrong size: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    ["Pour in half the sauce; reserve the rest.", "Pour in the sauce."],
    ["Add half of the butter.", "Add the butter."],
    ["Fold in a third of the egg whites.", "Fold in the egg whites."],
    ["Whisk in a quarter of the milk.", "Whisk in the milk."],
    ["Fold in one third of the whites.", "Fold in the whites."],
    ["Stir in two thirds of the stock.", "Stir in the stock."],
    ["Chop half an onion.", "Chop the onion."],
    ["Rest for half-an-hour.", "Rest."],
    ["Dissolve the sugar in half the milk.", "Dissolve the sugar in the milk."],
    ["Slice the onion and stir in half the stock.", "Slice the onion and stir in the stock."],
    ["Sauté the sliced mushrooms in half the butter.", "Sauté the sliced mushrooms in the butter."],
    ["Simmer the split peas in half the stock.", "Simmer the split peas in the stock."],
    ["Marinate the chicken (cut into strips) in half the sauce overnight.", "Marinate the chicken strips in the sauce overnight."],
    ["Fry the tofu — cut into cubes — in half the oil.", "Fry the tofu cubes in the oil."],
    ["Sear the squash (cut side down) in half the butter.", "Sear the squash cut side down in the butter."],
    ["Sear the squash, then cut side down in half the butter.", "Sear the squash cut side down in the butter."],
    ["Sauté the carrots, then snap peas in half the butter.", "Sauté the carrots, then the snap peas in the butter."],
    ["Slice onions thin to fry in half the oil.", "Slice the onions thin and fry them in the oil."],
    ["Fold gently in half the whites.", "Gently fold in the whites."],
    ["Toss 1 lb. cut green beans in half the butter.", "Toss 1 lb. cut green beans in the butter."],
    ["Fold whipped cream in half the batter.", "Fold the whipped cream into the batter."],
    ["Cut cold butter in half the flour.", "Cut the cold butter into the flour."],
    ["Fold the whites in half of the batter.", "Fold the whites into the batter."],
    ["Poach the pears (cut them in half) in half a bottle of red wine.", "Halve the pears and poach them in red wine."],
    ["Poach the pears — cut them in half — in half a bottle of red wine.", "Halve the pears and poach them in red wine."],
    ["Fold the whites in a third of the batter.", "Fold the whites into the batter."],
    ["Fold very gently in a third of the whites.", "Very gently fold in the whites."],
    ["Sauté the carrots, then snap beans in half a stick of butter.", "Sauté the carrots, then the snapped beans in butter."],
    ["Fold the berries in half of it.", "Fold in the berries."],
    ["Toss 1lb. cut green beans in half a jar of pesto.", "Toss 1lb. cut green beans in the pesto."],
    ["Fold the whites in half the batter this way.", "Fold the whites into the batter."],
    ["Cut the butter in half the flour the way you would for pastry.", "Cut the butter into the flour as for pastry."],
  ])("reads a part of an ingredient: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    ["Add the wine and simmer until reduced by half.", "Add the wine and simmer until reduced."],
    ["Simmer the sauce until reduced by a third.", "Simmer the sauce until reduced."],
    ["Boil the stock until reduced to a third.", "Boil the stock until reduced."],
    ["Boil until reduced by about half.", "Boil until reduced."],
    ["Melt a half stick of butter.", "Melt a stick of butter."],
    ["Stir in a half can of coconut milk.", "Stir in a can of coconut milk."],
    ["Add a half onion, finely diced.", "Add an onion, finely diced."],
    ["Add a quarter onion.", "Add an onion."],
    ["Add one half onion.", "Add an onion."],
    ["Fill a large pot halfway with water.", "Fill a large pot with water."],
    ["Fill the pot half-way with water.", "Fill the pot with water."],
    ["Flip the fish halfway through.", "Flip the fish once."],
    ["Fill the muffin cups half full.", "Fill the muffin cups."],
    ["Fill the cups a third full.", "Fill the cups."],
    ["Fill the jars three quarters full.", "Fill the jars."],
    ["Pour half into the pan.", "Pour it into the pan."],
    ["Stir in half, then the rest.", "Stir it in."],
    ["Serve half now and half later.", "Serve some now and the rest later."],
    ["Add the other half.", "Add the rest."],
    ["Keep one third back.", "Keep some back."],
    ["Reserve a third for serving.", "Reserve some for serving."],
    ["Stir in half the same way.", "Stir it in the same way."],
    ["Whisk in half this way.", "Whisk it in this way."],
    ["Fold very gently in half the same way.", "Fold very gently the same way."],
    ["Cook until reduced in half.", "Cook until reduced."],
    ["Reduce the vinegar in half.", "Reduce the vinegar."],
    ["Boil until the liquid reduces in half.", "Boil until the liquid reduces."],
    ["Boil the stock down in half.", "Boil the stock down."],
    ["Simmer until cooked down into half.", "Simmer until cooked down."],
    ["Tip in half, stir, then tip in the rest.", "Tip it in, stir, then tip in the rest."],
    ["Throw in half and toss.", "Throw it in and toss."],
    ["Crumble in half now, the rest at the end.", "Crumble it in now and at the end."],
    ["Grate in half, then taste.", "Grate it in, then taste."],
    ["Drop in half, then the rest.", "Drop it in, then the rest."],
    ["Reduce by a fifth.", "Reduce."],
    ["Reserve a sixth for garnish.", "Reserve some for garnish."],
    ["Add a fourth of the flour.", "Add the flour."],
    ["Stir in an eighth of the stock.", "Stir in the stock."],
  ])("reads a share said with no unit: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it.each([
    ["Cook 5 more minutes.", "Cook 5 minutes more."],
    ["Add 2 heaping tablespoons of cocoa.", "Add 2 heaped tbsp cocoa."],
    ["Heat a tablespoon of oil.", "Heat 1 tbsp oil."],
    ["Add a cup of stock.", "Add a cup of stock."],
    ["Cook for an additional minute.", "Cook 1 more minute."],
    ["Cook for another minute or two.", "Cook 1 to 2 minutes more."],
    ["Add a dozen eggs.", "Add 12 eggs."],
    ["Add half a dozen eggs.", "Add 6 eggs."],
    ["Bake two dozen cookies.", "Bake 24 cookies."],
    ["Whisk in .5 cup milk.", "Whisk in ½ cup milk."],
    ["Add 1-1/2 cups flour.", "Add 1 1/2 cups flour."],
    ["Add 2 dl cream.", "Add 200 ml cream."],
    ["Add a tsp and a half of salt.", "Add 1½ tsp salt."],
    ["Beat a half-dozen eggs.", "Beat 6 eggs."],
    ["Crack one and a half dozen eggs.", "Crack 18 eggs."],
    ["Pour in half the sauce.", "Pour in ½ the sauce."],
    ["Fold in one third of the whites.", "Fold in a third of the whites."],
    ["Stir in two thirds of the stock.", "Stir in two-thirds of the stock."],
    ["Chop half an onion.", "Chop ½ onion."],
    ["Rest for half-an-hour.", "Rest for 30 minutes."],
    ["Quarter the onions.", "Cut the onions into quarters."],
    ["Cut the lemon in half.", "Halve the lemon."],
    ["Cut the zucchini in half the long way.", "Halve the zucchini lengthwise."],
    ["Slice each breast crosswise in half the short way.", "Halve each breast crosswise."],
    ["Fold the dough in half a second time.", "Fold the dough over again."],
    ["Cook for another hour and a half, until tender.", "Cook for another 90 minutes, until tender."],
    ["Add a lb. and a half of beef.", "Add 1½ lb beef."],
    ["Rest for ½ an hour.", "Rest for 30 minutes."],
    ["Rest for 1/2 an hour.", "Rest for 30 minutes."],
    ["Add ½ a teaspoon of salt.", "Add ½ tsp salt."],
    ["Beat a half-dozen eggs.", "Beat ½ dozen eggs."],
    ["Crack 1½ dozen eggs.", "Crack 18 eggs."],
    ["Crack two and one-half dozen eggs.", "Crack 30 eggs."],
    ["Bake a dozen-and-a-half rolls.", "Bake 18 rolls."],
    ["Fry the sliced onion in half a tablespoon of butter.", "Fry the sliced onion in 1/2 tablespoon of butter."],
    ["Sauté the mushrooms in half the butter.", "Sauté the sliced mushrooms in half the butter."],
    ["Whisk the yolks of a dozen eggs.", "Whisk the yolks of 12 eggs."],
    ["Rest for 1⁄2 an hour.", "Rest for 30 minutes."],
    ["Then carefully cut the cake in half the short way.", "Halve the cake crosswise."],
    ["Cut avocados in half the long way and remove the pits.", "Halve the avocados lengthwise and remove the pits."],
    ["Stir in two and ½ cups of flour.", "Stir in 2½ cups of flour."],
    ["Add a kg and a half of potatoes.", "Add 1.5 kg potatoes."],
    ["Cut into slices a centimetre and a half thick.", "Cut into 1.5 cm slices."],
    ["Roast the peppers (cut them in half first).", "Halve the peppers and roast them."],
    ["Prep the fruit: cut avocados in half the long way.", "Halve the avocados lengthwise."],
    ["Split the rolls in half the way you would a bagel.", "Halve the rolls like a bagel."],
    ["Fold the dough in half the other way.", "Fold the dough over the other way."],
    ["Cut the dough in half the other direction.", "Halve the dough the other way."],
    ["Fold it in half this way.", "Fold it over like this."],
    ["Fold the dough in half a third time.", "Fold the dough over once more."],
    ["Cut the zucchini (or squash) in half the long way.", "Halve the zucchini lengthwise."],
    ["Chill 30min. Cut the loaf in half the long way.", "Chill 30 min, then halve the loaf lengthwise."],
    ["Cut the eggplant (1 lb) in half the long way.", "Halve the 1 lb eggplant lengthwise."],
    ["Simmer until reduced by half.", "Simmer until reduced by ½."],
    ["Fill the jars three quarters full.", "Fill the jars ¾ full."],
    ["Fill a pot halfway with water.", "Fill a pot half full of water."],
    ["Fill the tortillas and fold in half.", "Fill the tortillas and fold them over."],
    ["Divide the mixture in half.", "Halve the mixture."],
    ["Slice the onion into half-moons.", "Slice the onion into thin crescents."],
    ["Scoop the seeds from each half.", "Scoop out the seeds."],
    ["Stir in the half-and-half.", "Stir in the cream."],
    ["Add a third egg.", "Add another egg."],
    ["Reduce the heat and cut the lemon in half.", "Lower the heat and halve the lemon."],
    ["Cut the reduced-fat cheese in half.", "Halve the cheese."],
    ["Add a fifth egg.", "Add another egg."],
    ["Fold the dough a fourth time.", "Fold the dough once more."],
    ["Stir in the double cream.", "Stir in the cream."],
    ["Melt the chocolate in a double boiler.", "Melt the chocolate over simmering water."],
    ["Let rise until doubled.", "Let rise until doubled in size."],
    ["Let rise until double in size.", "Let rise until doubled."],
    ["Let rise until it doubles.", "Let rise until twice the size."],
    ["Add an eighth teaspoon of cayenne.", "Add ⅛ tsp cayenne."],
    ["Add an eighth of a teaspoon of cayenne.", "Add 1/8 tsp cayenne."],
  ])("accepts a quantity said around a word: %s → %s", (step, text) => {
    const result = oneStep(step, text);
    expect(result.ok ? "ok" : `${result.rule}: ${result.detail}`).toBe("ok");
  });

  it.each([
    ["Add an eighth of a teaspoon of cayenne.", "Add cayenne."],
    ["Stir in a sixth cup of oil.", "Stir in the oil."],
    ["Let rise until doubled in size, about 1 hour.", "Let rise, about 1 hour."],
    ["Let rise until doubled.", "Let rise."],
    ["Let the dough double in size.", "Let the dough rise."],
    ["Leave until tripled.", "Leave to rise."],
    ["Knead twice as long.", "Knead longer."],
  ])("reads a part or a multiple said in words: %s → %s", (step, text) => {
    expect(rejected(oneStep(step, text))).toBe("dropped-number");
  });

  it("counts an ahead task's lead, but not a cook task's", () => {
    const recipe: RecipeForPlan = {
      ingredients: [{ item: "dried beans" }],
      steps: ["Soak the beans for 8 hours.", "Simmer the beans until tender."],
    };
    const plan = (kind: string) => ({
      tasks: [
        {
          id: "soak",
          kind,
          text: "Soak the beans",
          label: "soak beans",
          ingredientIdx: [0],
          sourceStep: 0,
          implied: false,
          needs: [],
          minutes: null,
          cue: null,
          lead: "8 hours",
          branch: "Beans",
        },
        {
          id: "simmer",
          kind: "cook",
          text: "Simmer the beans until tender.",
          label: "simmer beans",
          ingredientIdx: [0],
          sourceStep: 1,
          implied: false,
          needs: ["soak"],
          minutes: null,
          cue: null,
          lead: null,
          branch: "Beans",
        },
      ],
    });
    expect(parseCookPlan(plan("ahead"), recipe).ok).toBe(true);
    expect(rejected(parseCookPlan(plan("cook"), recipe))).toBe("dropped-number");
  });
});

describe("parseCookPlan: every task leads somewhere", () => {
  function withExtra(extra: RawTask) {
    const raw = zucchiniRaw();
    raw.tasks.push({
      text: "Do it.",
      label: "do it",
      ingredientIdx: [],
      sourceStep: null,
      implied: true,
      needs: [],
      minutes: null,
      cue: null,
      lead: null,
      branch: "Filling",
      ...extra,
    });
    return raw;
  }

  it("rejects mise or ahead work that nothing uses", () => {
    const mise = withExtra({ id: "garnish", kind: "mise" });
    expect(rejected(parseCookPlan(mise, ZUCCHINI_RECIPE))).toBe("unused-task");
    const ahead = withExtra({ id: "chill", kind: "ahead", lead: "overnight" });
    expect(rejected(parseCookPlan(ahead, ZUCCHINI_RECIPE))).toBe("unused-task");
  });

  it("rejects a recipe step that neither needs nor feeds anything", () => {
    const raw = withExtra({
      id: "garnish",
      kind: "cook",
      sourceStep: 4,
      implied: false,
      branch: "Garnish",
    });
    expect(rejected(parseCookPlan(raw, ZUCCHINI_RECIPE))).toBe(
      "disconnected-task",
    );
  });

  it("rejects a branch that ends twice", () => {
    const raw = withTask("chili", (t) => {
      t.needs = ["fry"];
    });
    expect(rejected(parseCookPlan(raw, ZUCCHINI_RECIPE))).toBe(
      "branch-ends-twice",
    );
  });

  it("lets separate branches finish separately", () => {
    const raw = withTask("chili", (t) => {
      t.needs = ["fry"];
      t.branch = "Garnish";
    });
    const result = parseCookPlan(raw, ZUCCHINI_RECIPE);
    expect(result.ok ? "ok" : `${result.rule}: ${result.detail}`).toBe("ok");
  });
});

/**
 * Ahead tasks, each [id, lead, needs], feeding one cook task (the recipe's
 * one step) that needs whichever of them nothing else does.
 */
function aheadPlan(...ahead: [string, string | null, string[]][]): CookPlanParseResult {
  const recipe: RecipeForPlan = { ingredients: [], steps: ["Bake."] };
  const used = new Set(ahead.flatMap(([, , needs]) => needs));
  const tasks = [
    ...ahead.map(([id, lead, needs]) => ({
      id,
      kind: "ahead",
      text: `Do ${id}.`,
      label: id,
      ingredientIdx: [],
      sourceStep: null,
      implied: true,
      needs,
      minutes: null,
      cue: null,
      lead,
      branch: "Cookies",
    })),
    {
      id: "bake",
      kind: "cook",
      text: "Bake.",
      label: "bake",
      ingredientIdx: [],
      sourceStep: 0,
      implied: false,
      needs: ahead.map(([id]) => id).filter((id) => !used.has(id)),
      minutes: null,
      cue: null,
      lead: null,
      branch: "Cookies",
    },
  ];
  return parseCookPlan({ tasks }, recipe);
}

describe("parseCookPlan: one anchor for every lead", () => {
  it("rejects the cookies as derived with mixed anchors, naming both leads and the rule", () => {
    // Soften the butter "1 hour before" the creaming, which is "at least 2
    // hours before" the cook: on Prep the creaming would come first.
    const result = aheadPlan(
      ["soften-butter", "1 hour before", []],
      ["beat-butter-sugar", "at least 2 hours before", ["soften-butter"]],
    );
    const detail =
      '"beat-butter-sugar" (at least 2 hours before) needs "soften-butter" (1 hour before); a lead counts back from the start of the cook, so what a task needs can\'t have a shorter lead';
    expect(result).toEqual({
      ok: false,
      rule: "lead-order",
      detail,
      violations: [{ rule: "lead-order", detail }],
    });
  });

  it("accepts the cookies counted back from the start of the cook", () => {
    const result = aheadPlan(
      ["soften-butter", "at least 3 hours before", []],
      ["room-temp-eggs", "2½ hours before", []],
      ["beat-butter-sugar", "at least 2 hours before", ["soften-butter"]],
      ["add-eggs", "at least 2 hours before", ["beat-butter-sugar", "room-temp-eggs"]],
    );
    expect(result.ok ? "ok" : `${result.rule}: ${result.detail}`).toBe("ok");
  });

  it("accepts the cookies as the B4 live eval re-derived them, a lead said in parts", () => {
    // Rejected live: "at least 2 hours 30 minutes before" read as 30 minutes.
    const result = aheadPlan(
      ["soften-butter", "at least 3 hours before", []],
      ["room-temp-eggs", "at least 2 hours 30 minutes before", []],
      ["whisk-dry-mix", "at least 2 hours before", []],
      ["beat-butter-sugars", "at least 2 hours before", ["soften-butter"]],
      ["beat-eggs-vanilla", "at least 2 hours before", ["beat-butter-sugars", "room-temp-eggs"]],
      ["mix-dough", "at least 2 hours before", ["beat-eggs-vanilla", "whisk-dry-mix"]],
      ["chill-dough", "at least 2 hours before", ["mix-dough"]],
    );
    expect(result.ok ? "ok" : `${result.rule}: ${result.detail}`).toBe("ok");
  });

  it("compares a lead said in parts as its whole length, both as the need and as the task", () => {
    // As the task: 1 hour 15 minutes ahead can't need work 30 minutes ahead,
    // which passed when the lead read as 15.
    expect(
      rejected(aheadPlan(["soak", "30 minutes before", []], ["drain", "1 hour 15 minutes before", ["soak"]])),
    ).toBe("lead-order");
    expect(
      aheadPlan(["soak", "1 hour 30 minutes before", []], ["drain", "1 hour 15 minutes before", ["soak"]]).ok,
    ).toBe(true);
    // As the need: 1 hour 15 minutes ahead is long enough for work an hour
    // ahead, which was rejected when it read as 15, and too short for two hours.
    expect(
      aheadPlan(["soak", "1 hour 15 minutes before", []], ["drain", "1 hour before", ["soak"]]).ok,
    ).toBe(true);
    expect(
      rejected(aheadPlan(["soak", "1 hour 15 minutes before", []], ["drain", "at least 2 hours before", ["soak"]])),
    ).toBe("lead-order");
  });

  it("checks every link of a chain of three", () => {
    expect(
      aheadPlan(
        ["brine", "the day before", []],
        ["dry", "overnight", ["brine"]],
        ["temper", "1 hour before", ["dry"]],
      ).ok,
    ).toBe(true);
    // The middle link is the short one.
    expect(
      rejected(
        aheadPlan(
          ["brine", "the day before", []],
          ["dry", "30 minutes before", ["brine"]],
          ["temper", "1 hour before", ["dry"]],
        ),
      ),
    ).toBe("lead-order");
  });

  it("lets a need share its dependent's lead, however it is said", () => {
    expect(
      aheadPlan(
        ["grate", "at least 4 hours before", []],
        ["marinate", "at least 4 hours", ["grate"]],
        ["rest", "an hour before", []],
        ["fold", "60 minutes before", ["rest"]],
      ).ok,
    ).toBe(true);
  });

  it("has nothing to compare when either lead is missing or says no time", () => {
    expect(
      aheadPlan(
        ["tin", null, []],
        ["chill", "at least 2 hours before", ["tin"]],
      ).ok,
    ).toBe(true);
    expect(
      aheadPlan(
        ["soak", "1 hour before", []],
        ["simmer", "the morning of", ["soak"]],
      ).ok,
    ).toBe(true);
    expect(
      aheadPlan(
        ["soak", "a few hours ahead", []],
        ["chill", "at least 2 hours before", ["soak"]],
      ).ok,
    ).toBe(true);
  });

  // Fix round 1 (M1): same-day words and "up to" read as days had valid
  // plans rejected. A valid plan is never rejected.
  it("accepts work done on the day that needs work done overnight", () => {
    for (const day of ["on the day", "the day of", "earlier in the day"]) {
      const result = aheadPlan(["soak", "overnight", []], ["cook-beans", day, ["soak"]]);
      expect(result.ok ? "ok" : `${result.rule}: ${result.detail}`, day).toBe("ok");
    }
  });

  it("accepts work that may be done up to days ahead needing work done overnight", () => {
    const result = aheadPlan(
      ["soak", "overnight", []],
      ["make-sauce", "up to 2 days ahead", ["soak"]],
    );
    expect(result.ok ? "ok" : `${result.rule}: ${result.detail}`).toBe("ok");
  });

  it("accepts work that may be done on the day needing work done overnight (fix round 2)", () => {
    // LOW 3: the alternative read as a day, so the overnight soak was too short.
    for (const lead of ["a day ahead or the same day", "the day before or the morning of"]) {
      const result = aheadPlan(["soak", "overnight", []], ["cook-beans", lead, ["soak"]]);
      expect(result.ok ? "ok" : `${result.rule}: ${result.detail}`, lead).toBe("ok");
    }
    // LOW 6: "up to overnight" read as overnight, so the hour's thaw was too short.
    const bound = aheadPlan(["thaw", "1 hour before", []], ["brine", "up to overnight", ["thaw"]]);
    expect(bound.ok ? "ok" : `${bound.rule}: ${bound.detail}`).toBe("ok");
  });

  it("compares a lead after \"bring up to\" (fix round 2)", () => {
    expect(
      rejected(
        aheadPlan(
          ["soften", "30 minutes before", []],
          ["temper", "bring up to room temperature 1 hour before", ["soften"]],
        ),
      ),
    ).toBe("lead-order");
  });

  it("checks a need through work whose lead it can't read", () => {
    // The thaw comes before the morning's brine, which comes before work
    // three hours ahead, so the thaw can't be an hour ahead.
    const result = aheadPlan(
      ["thaw", "1 hour before", []],
      ["brine", "the morning of", ["thaw"]],
      ["cure", "at least 3 hours before", ["brine"]],
    );
    const detail =
      '"cure" (at least 3 hours before) needs "thaw" (1 hour before), through "brine"; a lead counts back from the start of the cook, so what a task needs can\'t have a shorter lead';
    expect(result).toEqual({
      ok: false,
      rule: "lead-order",
      detail,
      violations: [{ rule: "lead-order", detail }],
    });
    // Through untimed work too.
    expect(
      rejected(
        aheadPlan(
          ["thaw", "1 hour before", []],
          ["pat-dry", null, ["thaw"]],
          ["cure", "at least 3 hours before", ["pat-dry"]],
        ),
      ),
    ).toBe("lead-order");
    // And it stays quiet when the far need is long enough.
    expect(
      aheadPlan(
        ["thaw", "the day before", []],
        ["brine", "the morning of", ["thaw"]],
        ["cure", "at least 3 hours before", ["brine"]],
      ).ok,
    ).toBe(true);
  });
});

/** The violations a rejected plan reports, as [rule, detail]. */
function violations(result: CookPlanParseResult): [string, string][] {
  if (result.ok) throw new Error("expected rejection, got a valid plan");
  return result.violations.map((v) => [v.rule, v.detail]);
}

describe("parseCookPlan: every violation, so one re-ask can fix them all (R31)", () => {
  // The re-ask fixed the one rule it was told about, and the next call failed
  // on a second rule already in the first reply: 3 of R31's 39 library plans.
  const LEAD_RULE =
    "a lead counts back from the start of the cook, so what a task needs can't have a shorter lead";

  it("names both phase rules a plan breaks (dan dan noodles)", () => {
    const result = parseCookPlan(danDanRaw(), DAN_DAN_RECIPE);
    expect(result).toMatchObject({
      ok: false,
      rule: "mise-needs-cook",
      detail: 'mise "grind-szechuan-peppercorns" needs cook "toast-szechuan-peppercorns"',
    });
    expect(violations(result)).toEqual([
      ["mise-needs-cook", 'mise "grind-szechuan-peppercorns" needs cook "toast-szechuan-peppercorns"'],
      ["ahead-needs-later", 'ahead "mix-sauce" needs mise "grind-szechuan-peppercorns"'],
    ]);
  });

  it("names an uncovered step and a phase rule together, keeping the uncited steps (dan dan noodles, call 1)", () => {
    const result = parseCookPlan(danDanUncoveredRaw(), DAN_DAN_RECIPE);
    expect(result).toEqual({
      ok: false,
      rule: "uncovered-step",
      detail: "no task covers step 3",
      uncoveredSteps: [3],
      violations: [
        { rule: "uncovered-step", detail: "no task covers step 3", uncoveredSteps: [3] },
        {
          rule: "mise-needs-cook",
          detail: 'mise "grind-szechuan-peppercorns" needs cook "toast-szechuan-peppercorns"',
        },
      ],
    });
  });

  it("names every need an ahead task can't have, not only the first (chicken wings)", () => {
    expect(violations(parseCookPlan(wingsRaw(), WINGS_RECIPE))).toEqual([
      ["ahead-needs-later", 'ahead "marinate" needs mise "pat-wings-dry"'],
      ["ahead-needs-later", 'ahead "marinate" needs mise "mince-ginger"'],
    ]);
  });

  it("names every lead order broken behind a phase rule, past the first short need (onion torta)", () => {
    const result = parseCookPlan(tortaRaw(), TORTA_RECIPE);
    expect(rejected(result)).toBe("ahead-needs-later");
    expect(violations(result)).toEqual([
      ["ahead-needs-later", 'ahead "cool-crust" needs cook "finish-bake-crust"'],
      [
        "lead-order",
        `"cool-crust" (overnight) needs "line-tin" (freeze 30 min), through "finish-bake-crust", "blind-bake-crust"; ${LEAD_RULE}`,
      ],
      [
        "lead-order",
        `"cool-crust" (overnight) needs "mix-dough" (chill 1 h), through "finish-bake-crust", "blind-bake-crust", "line-tin"; ${LEAD_RULE}`,
      ],
    ]);
  });

  it("stops the lead search at a need whose lead is long enough: its own check covers what is behind it", () => {
    expect(
      violations(
        aheadPlan(
          ["thaw", "10 minutes before", []],
          ["brine", "the day before", ["thaw"]],
          ["rest", "overnight", ["brine"]],
        ),
      ),
    ).toEqual([["lead-order", `"brine" (the day before) needs "thaw" (10 minutes before); ${LEAD_RULE}`]]);
  });

  it("names a need listed twice once", () => {
    const raw = wingsRaw();
    raw.tasks.find((t) => t.id === "marinate")!.needs.push("mince-ginger");
    expect(violations(parseCookPlan(raw, WINGS_RECIPE))).toEqual([
      ["ahead-needs-later", 'ahead "marinate" needs mise "pat-wings-dry"'],
      ["ahead-needs-later", 'ahead "marinate" needs mise "mince-ginger"'],
    ]);
  });

  it("accepts each plan once it is fixed the way the rules ask", () => {
    for (const [raw, recipe] of [
      [danDanFixedRaw(), DAN_DAN_RECIPE],
      [danDanAheadFixedRaw(), DAN_DAN_RECIPE],
      [wingsFixedRaw(), WINGS_RECIPE],
      [tortaFixedRaw(), TORTA_RECIPE],
    ] as const) {
      const result = parseCookPlan(raw, recipe);
      expect(result.ok ? "ok" : `${result.rule}: ${result.detail}`).toBe("ok");
    }
  });

  it("names every lead-order break: each ahead task, and each short need of one", () => {
    expect(
      violations(
        aheadPlan(
          ["butter", "1 hour before", []],
          ["eggs", "30 minutes before", []],
          ["cream", "overnight", ["butter", "eggs"]],
          ["thaw", "10 minutes before", []],
          ["brine", "the day before", ["thaw"]],
        ),
      ),
    ).toEqual([
      ["lead-order", `"cream" (overnight) needs "butter" (1 hour before); ${LEAD_RULE}`],
      ["lead-order", `"cream" (overnight) needs "eggs" (30 minutes before); ${LEAD_RULE}`],
      ["lead-order", `"brine" (the day before) needs "thaw" (10 minutes before); ${LEAD_RULE}`],
    ]);
  });

  it("names a dropped number and a later uncovered step together, the earlier step first", () => {
    const raw = chutneyMergedRaw();
    raw.tasks[0]!.text = "Toast the peanuts on low heat.";
    const result = parseCookPlan(raw, CHUTNEY_RECIPE);
    expect(rejected(result)).toBe("dropped-number");
    expect(result).not.toHaveProperty("uncoveredSteps");
    if (result.ok) return;
    expect(result.violations.map((v) => v.rule)).toEqual(["dropped-number", "uncovered-step"]);
    expect(result.violations[1]).toEqual({
      rule: "uncovered-step",
      detail: "no task covers steps 3, 4, 7, 11, 14",
      uncoveredSteps: CHUTNEY_UNCITED,
    });
  });

  it("still stops at a structural failure, which is its only violation", () => {
    const cycle = withTask("fry", (t) => {
      t.needs = ["fry"];
    });
    expect(violations(parseCookPlan(cycle, ZUCCHINI_RECIPE))).toEqual([
      ["cycle", "fry → fry"],
    ]);
    expect(violations(parseCookPlan("nope", ZUCCHINI_RECIPE))).toHaveLength(1);
  });

  it("checks that every task leads somewhere only once the rest pass, as before", () => {
    const raw = zucchiniRaw();
    raw.tasks.push({ ...raw.tasks.find((t) => t.kind === "mise")!, id: "spare", needs: [] });
    expect(violations(parseCookPlan(raw, ZUCCHINI_RECIPE))).toEqual([
      ["unused-task", 'mise "spare" is needed by nothing'],
    ]);
  });

  it("keeps the verdict on every snapshot and every one-change break of it", () => {
    // Counts taken from the validator before it collected every violation:
    // the same plans pass, and each failure is named for the same rule.
    const counts: Record<string, number> = {};
    for (const c of verdictBattery()) {
      const result = parseCookPlan(c.raw, c.recipe);
      const key = result.ok ? "ok" : result.rule;
      counts[key] = (counts[key] ?? 0) + 1;
      if (result.ok) continue;
      // The first violation is the one the result names.
      expect(result.violations[0], c.name).toEqual({
        rule: result.rule,
        detail: result.detail,
        ...(result.uncoveredSteps ? { uncoveredSteps: result.uncoveredSteps } : {}),
      });
    }
    expect(counts).toEqual({
      ok: 173,
      "ahead-needs-later": 89,
      "invented-cook": 24,
      "lead-order": 10,
      "mise-needs-cook": 63,
      "uncovered-step": 120,
      "unused-task": 1,
    });
  });
});

describe("leadMinutes", () => {
  it("reads a lead as the shortest wait it allows, before the cook starts", () => {
    const read = (lead: string | null) => leadMinutes(lead);
    expect(read("1 hour before")).toBe(60);
    expect(read("at least 2 hours before")).toBe(120);
    expect(read("2½ hours before")).toBe(150);
    expect(read("half an hour before")).toBe(30);
    expect(read("2-3 hours")).toBe(120);
    expect(read("at least 2 hours, or up to 3 days")).toBe(120);
    expect(read("8 hours or overnight")).toBe(480);
    expect(read("overnight")).toBe(720);
    expect(read("the night before")).toBe(720);
    expect(read("a day ahead")).toBe(1440);
    expect(read("the day before")).toBe(1440);
    expect(read("1 to 2 days ahead")).toBe(1440);
    expect(read("a week ahead")).toBe(10080);
  });

  it("is null for a lead that says no time it can read", () => {
    expect(leadMinutes(null)).toBeNull();
    expect(leadMinutes(undefined)).toBeNull();
    expect(leadMinutes("")).toBeNull();
    expect(leadMinutes("the morning of")).toBeNull();
    expect(leadMinutes("a few hours ahead")).toBeNull();
    // A temperature in a lead is not a wait.
    expect(leadMinutes("while the oven heats to 350°F")).toBeNull();
  });

  it("reads no day before in work done on the day", () => {
    for (const lead of ["the day of", "on the day", "earlier in the day", "that day", "the morning of"]) {
      expect(leadMinutes(lead), lead).toBeNull();
    }
    // A time said alongside still reads.
    expect(leadMinutes("on the day, at least 2 hours before")).toBe(120);
    // The day before still reads as a day, however it is said.
    expect(leadMinutes("the previous day")).toBe(1440);
    expect(leadMinutes("a day or two ahead")).toBe(1440);
    expect(leadMinutes("one day ahead")).toBe(1440);
  });

  it("reads no wait in an upper bound alone, which allows any shorter one", () => {
    for (const lead of [
      "up to 3 days ahead",
      "up to 2 days ahead",
      "up to a week ahead",
      "up to a day before",
      "at most 4 hours before",
      "no more than 2 days ahead",
    ]) {
      expect(leadMinutes(lead), lead).toBeNull();
    }
    // Beside a lower bound, the lower bound is the reading.
    expect(leadMinutes("at least 2 hours, or up to 3 days")).toBe(120);
    expect(leadMinutes("overnight, or up to 2 days ahead")).toBe(720);
    expect(leadMinutes("2 to 3 days ahead")).toBe(2880);
    // Fix round 2 (LOW 6): a bound needs a wait right after it.
    for (const lead of ["up to overnight", "up to the day before", "up to 2-3 days ahead", "up to 1½ hours before"]) {
      expect(leadMinutes(lead), lead).toBeNull();
    }
  });

  it("reads a wait after \"bring up to\", which bounds nothing", () => {
    // Fix round 2 (LOW 6): this read as no time, so it was never compared.
    expect(leadMinutes("bring up to room temperature 1 hour before")).toBe(60);
    expect(leadMinutes("bring the stock up to a simmer 30 minutes before")).toBe(30);
  });

  it("reads the shortest of its alternatives, and no time when one is on the day", () => {
    // Fix round 2 (LOW 3): "a day ahead or the same day" allows the same day,
    // so it names no shortest wait; it read as a day.
    for (const lead of [
      "a day ahead or the same day",
      "the day before or the morning of",
      "overnight or that morning",
      "the night before or a few hours ahead",
    ]) {
      expect(leadMinutes(lead), lead).toBeNull();
    }
    expect(leadMinutes("8 hours or overnight")).toBe(480);
    expect(leadMinutes("the day before or overnight")).toBe(720);
    // Not alternatives: "or so", and "or two" after a wait.
    expect(leadMinutes("2 hours or so before")).toBe(120);
    expect(leadMinutes("a day or two ahead")).toBe(1440);
  });

  // B4 live eval: "2 hours 30 minutes" read as its smallest part, 30, so a
  // valid cookie plan was rejected and a short need could pass a longer lead.
  it.each([
    ["at least 2 hours 30 minutes before", 150],
    ["1 hour 15 minutes before", 75],
    ["1 hour and 15 minutes before", 75],
    ["1 hr 45 min before", 105],
    ["1 day and 8 hours ahead", 1920],
    ["an hour and a half before", 90],
    ["1½ hours before", 90],
    ["at least 1 1/2 hours before", 90],
  ])("joins a duration said in parts: %j is %i minutes", (lead, minutes) => {
    expect(leadMinutes(lead)).toBe(minutes);
  });

  it.each([
    ["1–2 hours before", 60],
    ["1 to 2 hours before", 60],
    ["1 or 2 hours before", 60],
    ["30 minutes to 1 hour before", 30],
    ["1 hour 30 minutes to 2 hours before", 90],
    ["2 hours 30 minutes or overnight", 150],
    ["overnight", 720],
  ])("keeps the shortest of a range or its alternatives: %j is %i minutes", (lead, minutes) => {
    expect(leadMinutes(lead)).toBe(minutes);
  });

  it.each(["up to 1 hour 30 minutes before", "up to 1 hour and 30 minutes before", "up to a day and 8 hours ahead"])(
    "reads no wait in an upper bound said in parts: %j",
    (lead) => {
      expect(leadMinutes(lead)).toBeNull();
    },
  );

  // B4 verify: shapes `durationsIn` misreads as a step's length must not
  // reach a lead as a wait, and a mark must not drop a wait said before.
  it.each([
    ["at least 2 hours 30 minutes before", 150],
    ["2 hours before serving", 120],
    ["at least 2 hours 30 minutes before serving", 150],
    ["30 minutes before the end of the braise", 30],
    ["start 2 hours before; baste every 20 minutes", 120],
    ["baste every 20 minutes for 2 hours", 120],
    ["at least 2 hours, within 3 hours of serving", 120],
    ["at least 1 day ahead; keeps up to 3 days", 1440],
    ["a day ahead; keeps 3 days", 1440],
    ["ready in 3 hours total", 180],
  ])("reads only the wait a lead names: %j is %i minutes", (lead, minutes) => {
    expect(leadMinutes(lead)).toBe(minutes);
  });

  it.each([
    "check every 20 minutes",
    "every 2 hours",
    "within 30 minutes of serving",
    "within 2 days",
    "keeps up to 3 days",
    "keeps 3 days",
    "will keep for 2 weeks",
    // An upper bound on a repeat names no wait either (verify of 11790c5).
    "up to 2 x 4 hours before",
    "within 1 hour, 30 minutes of serving",
  ])("reads no wait in a cadence or a bound: %j", (lead) => {
    expect(leadMinutes(lead)).toBeNull();
  });

  // Slice B5a, decisions A2 and A3 (PLAN B5's lead must-dos from the B4
  // delta verify). A repeat is the whole wait, count times each: it read no
  // wait before B5a ("2 x 5 minutes" was in the list above).
  it.each([
    ["2 x 4 hours before", 480],
    ["2 x 5 minutes", 10],
    ["3 × 2 hours ahead", 360],
    ["1 hour, 15 minutes before", 75],
    ["at least 2h 30m before", 150],
    ["a day and 8 hours ahead", 1920],
    ["a day and a half ahead", 2160],
    ["keeps overnight; at least 1 hour before", 60],
    ["at least 1 hour before; keeps overnight", 60],
    ["2 hours before; keeps, covered, 3 days", 120],
    // Independent verify of 11790c5: a compound joins whatever follows it,
    // and a ranged repeat waits its fewest rounds.
    ["at least 1 hour, 30 minutes at room temperature before", 90],
    ["1 hour, 15 minutes in the fridge before", 75],
    ["2-3 x 5 minutes before", 10],
  ])("B5a: %j is %i minutes", (lead, minutes) => {
    expect(leadMinutes(lead)).toBe(minutes);
  });

  // B5a verify round 1: a lead keeps the waits it read before, beside a
  // holding time or across a comma between two waits.
  it.each([
    ["keeps well, at least 4 hours ahead", 240],
    ["keeps, at least 6 hours before", 360],
    ["will keep, at least 2 hours before", 120],
    ["a day and a night ahead", 1440],
    ["a day and two nights ahead", 1440],
    ["keeps well, make 1 day ahead", 1440],
    ["2 hours, 30 minutes or overnight", 150],
    ["up to 4 hours, 2 hours ahead", 120],
  ])("B5a verify: %j is %i minutes", (lead, minutes) => {
    expect(leadMinutes(lead)).toBe(minutes);
  });

  // A holding time says how long it keeps, not how far ahead to make it,
  // whatever word follows its wait (B5a verify round 2, M1). "Keeps covered,
  // a day ahead" reads as a holding time too: covered is a holding word.
  it.each([
    "keeps 3 days ahead",
    "keeps 2 days before",
    "keeps 1 hour before",
    "keeps for 3 days in advance",
    "keeps, covered, 3 days ahead",
    "keeps 2 hours ahead of serving",
    "keeps, covered, 3 days before",
    "keeps covered, a day ahead",
  ])("B5a round 2: reads no wait in a holding time: %j", (lead) => {
    expect(leadMinutes(lead)).toBeNull();
  });

  it.each([
    "keeps overnight",
    "it keeps 2 hours before serving",
    "keeps, covered, 3 days",
    "keeps (covered) 3 days",
    "will keep, chilled, for a week",
    "within 1 hour, 30 minutes before",
    "up to 1 hour, 30 minutes before",
  ])("B5a: reads no wait in a holding time or a bound: %j", (lead) => {
    expect(leadMinutes(lead)).toBeNull();
  });
});

describe("parseCookPlan: storable text", () => {
  it("rejects a NUL or a lone surrogate and names where, without echoing it", () => {
    const nul = withTask("fry", (t) => {
      t.text = "Fry the\u0000 parathas.";
    });
    const result = parseCookPlan(nul, ZUCCHINI_RECIPE);
    expect(rejected(result)).toBe("bad-character");
    if (!result.ok) {
      expect(result.detail).toContain("tasks[6].text");
      expect(result.detail).not.toContain("\u0000");
    }

    const surrogate = withTask("saute", (t) => {
      t.cue = "until sweet \ud83d and caramelized";
    });
    const second = parseCookPlan(surrogate, ZUCCHINI_RECIPE);
    expect(rejected(second)).toBe("bad-character");
    if (!second.ok) expect(second.detail).toContain("tasks[4].cue");

    const need = withTask("stuff", (t) => {
      t.needs = ["stir\u0000", "fry"];
    });
    const third = parseCookPlan(need, ZUCCHINI_RECIPE);
    expect(rejected(third)).toBe("bad-character");
    if (!third.ok) expect(third.detail).toContain("tasks[7].needs[0]");
  });

  it("accepts a character outside the basic plane", () => {
    const raw = withTask("chili", (t) => {
      t.text = `${t.text as string} 🌶️`;
    });
    expect(parseCookPlan(raw, ZUCCHINI_RECIPE).ok).toBe(true);
  });
});

describe("parseCookPlan: normalizing", () => {
  it("trims the ids a task needs, as it trims ids", () => {
    const raw = withTask("saute", (t) => {
      t.needs = [" onion", "scape ", "zuc"];
    });
    const result = parseCookPlan(raw, ZUCCHINI_RECIPE);
    if (!result.ok) throw new Error(result.detail);
    expect(result.plan.tasks.find((t) => t.id === "saute")!.needs).toEqual([
      "onion",
      "scape",
      "zuc",
    ]);
    const blank = withTask("saute", (t) => {
      t.needs = ["onion", " "];
    });
    expect(rejected(parseCookPlan(blank, ZUCCHINI_RECIPE))).toBe("shape");
  });

  it("treats a hands-off estimate under 5 minutes as hands-on", () => {
    // "Heat the oil until shimmering" leaves no room to do anything else.
    const short = withTask("fry", (t) => {
      t.minutes = { est: 4, handsOff: true };
    });
    const result = parseCookPlan(short, ZUCCHINI_RECIPE);
    if (!result.ok) throw new Error(result.detail);
    expect(result.plan.tasks.find((t) => t.id === "fry")!.minutes).toEqual({
      est: 4,
      handsOff: false,
    });

    const five = withTask("fry", (t) => {
      t.minutes = { est: 5, handsOff: true };
    });
    const kept = parseCookPlan(five, ZUCCHINI_RECIPE);
    if (!kept.ok) throw new Error(kept.detail);
    expect(kept.plan.tasks.find((t) => t.id === "fry")!.minutes).toEqual({
      est: 5,
      handsOff: true,
    });
  });
});

describe("quantitiesIn", () => {
  const all = { wordsNeedUnit: false };

  it("reads values and units, with times in minutes", () => {
    expect(
      quantitiesIn("Bake at 350°F for 2.5 hours with 1/2 cup stock", all),
    ).toEqual([
      { value: 350, unit: "F" },
      { value: 150, unit: "min" },
      { value: 0.5, unit: "cup" },
    ]);
  });

  it("gives the first number of a range the range's unit", () => {
    expect(quantitiesIn("Simmer 3-4 minutes, or 1 to 2 hours", all)).toEqual([
      { value: 3, unit: "min" },
      { value: 4, unit: "min" },
      { value: 60, unit: "min" },
      { value: 120, unit: "min" },
    ]);
  });

  it("reads unicode fractions, mixed numbers and grouped thousands", () => {
    expect(quantitiesIn("Add 1½ cups", all)).toEqual([{ value: 1.5, unit: "cup" }]);
    expect(quantitiesIn("Add 1 1/2 cups", all)).toEqual(
      quantitiesIn("Add 1½ cups", all),
    );
    expect(quantitiesIn("Add 1,000 g", all)).toEqual([{ value: 1000, unit: "g" }]);
  });

  it("splits a clock time into its parts", () => {
    expect(quantitiesIn("Rest 1:30", all)).toEqual([
      { value: 1, unit: null },
      { value: 30, unit: null },
    ]);
  });

  it("reads word numbers, keeping only those with a unit when asked", () => {
    const text = "Simmer twenty-five minutes, adding one onion";
    expect(quantitiesIn(text, { wordsNeedUnit: true })).toEqual([
      { value: 25, unit: "min" },
    ]);
    expect(quantitiesIn(text, all)).toEqual([
      { value: 25, unit: "min" },
      { value: 1, unit: null },
    ]);
    expect(quantitiesIn("Line two sheets", { wordsNeedUnit: true })).toEqual([
      { value: 2, unit: null },
    ]);
  });

  it("reads hours and minutes said in words with no number", () => {
    const minutes = (text: string) => quantitiesIn(text, all).map((q) => q.value);
    expect(minutes("Braise for an hour, then rest half an hour")).toEqual([60, 30]);
    expect(minutes("Cook a minute more; a half-hour chill; a half hour rest")).toEqual([
      1, 30, 30,
    ]);
    expect(
      minutes("Roast an hour and a half, 2 and a half hours or two and a half hours"),
    ).toEqual([90, 150, 150]);
    expect(quantitiesIn("Braise for an hour", { wordsNeedUnit: true })).toEqual([
      { value: 60, unit: "min" },
    ]);
  });

  it("leaves other halves and articles alone", () => {
    expect(
      quantitiesIn(
        "Cut in half, wait a second, chill a day ahead, quarter the onions, half-and-half, an hourglass",
        all,
      ),
    ).toEqual([]);
    // A turn's or a pan's size is a share too, one a task shouldn't drop
    // any more than a 9x13 pan.
    expect(quantitiesIn("a quarter turn, a half-sheet pan", all)).toEqual([
      { value: 0.25, unit: null },
      { value: 0.5, unit: null },
    ]);
    expect(
      quantitiesIn(
        "Crack an egg, use a T-bone, dozens of cookies, the rest of a cup, a large pan",
        all,
      ),
    ).toEqual([]);
  });

  it("reads a unit past the words that can sit before it", () => {
    expect(
      quantitiesIn(
        "5 more minutes, 2 heaping tbsp, 1 level tsp, 2 well-packed cups, 20-odd minutes, 5 or so minutes",
        all,
      ),
    ).toEqual([
      { value: 5, unit: "min" },
      { value: 2, unit: "tbsp" },
      { value: 1, unit: "tsp" },
      { value: 2, unit: "cup" },
      { value: 20, unit: "min" },
      { value: 5, unit: "min" },
    ]);
    // One word the reader doesn't know stops it: eggs are not a unit. So do
    // three modifiers: the unit is too far from the number to be its own.
    expect(
      quantitiesIn(
        "2 large eggs, 2 more onions, 2 more of the minutes, 2 more well packed cups",
        all,
      ),
    ).toEqual([
      { value: 2, unit: null },
      { value: 2, unit: null },
      { value: 2, unit: null },
      { value: 2, unit: null },
    ]);
  });

  it("reads a measure said with a, an or another as one", () => {
    expect(
      quantitiesIn(
        "a tablespoon, an ounce, another minute, a heaping teaspoon, an additional cup, a minute or two",
        all,
      ),
    ).toEqual([
      { value: 1, unit: "tbsp" },
      { value: 1, unit: "oz" },
      { value: 1, unit: "min" },
      { value: 1, unit: "tsp" },
      { value: 1, unit: "cup" },
      { value: 1, unit: "min" },
      { value: 2, unit: "min" },
    ]);
    expect(
      quantitiesIn("a dozen, half a dozen, two dozen, 3 dozen, a dozen and a half", all),
    ).toEqual([
      { value: 12, unit: null },
      { value: 6, unit: null },
      { value: 24, unit: null },
      { value: 36, unit: null },
      { value: 18, unit: null },
    ]);
    expect(
      quantitiesIn(
        "a half-dozen, half-dozen, one and a half dozen, two-and-a-half dozen, 1 and a half dozen",
        all,
      ).map((q) => q.value),
    ).toEqual([6, 6, 18, 30, 18]);
    // A dozen is twelve after digits too, and after "and a half" said either way.
    expect(
      quantitiesIn(
        "1½ dozen, 1 1/2 dozen, ½ dozen, 2-3 dozen, two and one-half dozen, a dozen-and-a-half",
        all,
      ).map((q) => q.value),
    ).toEqual([18, 18, 6, 24, 36, 30, 18]);
  });

  it("reads a measure and a half past the words that can sit before it", () => {
    expect(
      read(
        "another hour and a half, a further hour and a half, a good hour and a half, a scant cup and a half, a heaping tablespoon and a half, two more minutes and a half",
      ),
    ).toEqual([
      [90, "min"],
      [90, "min"],
      [90, "min"],
      [1.5, "cup"],
      [1.5, "tbsp"],
      [2.5, "min"],
    ]);
    expect(read("an hr. and a half, a tbsp. and a half, a lb. and a half")).toEqual([
      [90, "min"],
      [1.5, "tbsp"],
      [1.5, "lb"],
    ]);
  });

  it("reads a fraction character as a fraction wherever a digit one would be", () => {
    expect(read("two and ½ cups, 2 and ¾ cups, 1½ cups, 1-½ cups, ½ an hour")).toEqual([
      [2.5, "cup"],
      [2.75, "cup"],
      [1.5, "cup"],
      [1.5, "cup"],
      [30, "min"],
    ]);
  });

  it("reads a metric measure said with a or an", () => {
    expect(read("a kg and a half, a kilo of flour, a centimetre and a half thick, a cm")).toEqual([
      [1.5, "kg"],
      [1, "kg"],
      [1.5, "cm"],
      [1, "cm"],
    ]);
  });

  it("reads a fraction said with an article after it", () => {
    expect(read("½ an hour, 1/2 an hour, ½ a teaspoon")).toEqual([
      [30, "min"],
      [30, "min"],
      [0.5, "tsp"],
    ]);
  });

  it("leaves a thing cut or folded in half alone, but not a half stirred in", () => {
    expect(
      read(
        "Cut the zucchini in half the long way; fold the dough in half a second time; break each bar of chocolate in half the short way",
      ),
    ).toEqual([]);
    // Nothing between the verb and "in": "fold in half the whites" folds in
    // half of them. "And" ends what was cut, and a hyphen makes a size.
    expect(
      read(
        "Fold in half the whites; slice the onion and stir in half the stock; dissolve it in half the milk; cut the pepper in half-inch strips",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.5, "inch"],
    ]);
  });

  it("cuts in half only after a cook told to cut something", () => {
    // Said as an instruction: the verb opens its clause, past "then", "and",
    // "by" or an adverb, and names what it cuts.
    expect(
      read(
        "Then carefully cut the cake in half the short way. Start by cutting the loaf in half the long way, and fold it in half a second time",
      ),
    ).toEqual([]);
    // Where a clause surely starts (a sentence, a colon or semicolon, a new
    // line, "then", "to", "by"), what is cut can be bare.
    expect(
      read(
        "Cut avocados in half the long way and remove the pits. Very carefully slice peppers in half the short way: split vanilla beans in half the long way\nbreak chocolate bars in half the short way; use a knife to cut limes in half the long way",
      ),
    ).toEqual([]);
    // Bare, it is not what is cut when it is an adverb, "side", "peas", or a
    // word past "to": the verb then has no object here.
    expect(
      read(
        "Fold gently in half the whites. Sear it; cut side down in half the butter. Then snap peas in half the stock. Slice onions thin to fry in half the oil. Tear bread into the bowl in half the milk",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.5, null],
    ]);
    // A bracket or dash usually opens an aside ("cut into strips") rather
    // than an instruction, and a period can end an abbreviation, so there
    // what is cut needs its "the" or "them" as after a comma.
    expect(
      read(
        "Marinate the chicken (cut into strips) in half the sauce. Fry the tofu \u2014 cut into cubes \u2014 in half the oil. Toss 1 lb. cut beans in half the butter",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [1, "lb"],
      [0.5, null],
    ]);
    expect(
      read("Roast the peppers (cut them in half first) \u2014 slice the onions in half too"),
    ).toEqual([]);
    // Whatever cut it, a "half the" that says no way of cutting is a part.
    expect(
      read(
        "Fold the whites in half the batter. Then cut cold butter in half the flour; fold the dough in half the same way. Cut each in half the long way round",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
    ]);
    // A sliced or split thing is cooked in a part of something.
    expect(
      read(
        "Sauté the sliced mushrooms in half the butter. Simmer the sliced carrots in half a cup of water. Fry the sliced eggplant in half an inch of oil. Toss the sliced apples in a quarter cup of sugar. Coat the sliced chicken in a third of a cup of flour",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, "cup"],
      [0.5, "inch"],
      [0.25, "cup"],
      [0.333, "cup"],
    ]);
    expect(
      read(
        "Simmer the split peas in half the stock; add the onion and split peas in half the stock; sauté cut mushrooms in half the butter; toss the peppers and cut onions in half the oil",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.5, null],
    ]);
    // After a comma, "and" or "or" the verb can be a noun's ("split peas"), so
    // what is cut needs its "the" or "each".
    expect(read("Warm the oil, split peas in half the stock, or cut onions in half the butter")).toEqual([
      [0.5, null],
      [0.5, null],
    ]);
    // A measure after the half makes it a size, hyphen or not.
    expect(read("Cut the potatoes in half inch cubes; slice it in half an inch from the top")).toEqual([
      [0.5, "inch"],
      [0.5, "inch"],
    ]);
  });

  it("reads a part after a cut unless a way of cutting follows it", () => {
    // Whatever cut something, "half a", "half of", "a third of" or "a
    // quarter of" after it is a part of something.
    expect(
      read(
        "Then snap beans in half a stick of butter. Fold the berries in half of it. Fold the whites in a third of the batter. Fold very gently in a third of the whites. Toss 1lb. cut green beans in half a jar of pesto",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [0.333, null],
      [0.333, null],
      [1, "lb"],
      [0.5, null],
    ]);
    // Nothing in an aside says how the part after it is cut.
    expect(
      read(
        "Poach the pears (cut them in half) in half a bottle of red wine. Poach the pears — cut them in half — in half a bottle of wine. Fry the leeks (cut them in thirds) in a quarter of the oil. Boil the eggs (break it in half) in half a pot of water",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [0.25, null],
      [0.5, null],
    ]);
    // A way of cutting is said right after the half: "the batter this way"
    // and "the flour the way you would" are parts, done some way.
    expect(
      read(
        "Fold the whites in half the batter this way. Cut the butter in half the flour the way you would for pastry. Fold the whites in half the batter any way you like",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [0.5, null],
    ]);
    expect(
      read(
        "Cut the dough in half the other direction; fold it in half this way. Fold the dough in half a third time, then cut it in half the opposite way",
      ),
    ).toEqual([]);
  });

  it("reads a share wherever it is not how a thing is cut", () => {
    // Half is a share unless it is a cut ("in half"), a piece ("each half")
    // or the cream ("half-and-half"): the safe side, since a share dropped
    // is a silent change to the dish.
    expect(
      read(
        "Simmer until reduced by half. Melt a half stick of butter. Pour half into the pan; stir in half, then the rest. Serve half now and half later. Fill the cups half full. Add the other half",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.5, null],
    ]);
    expect(
      read(
        "Cut the lemon in half. Fold the tortillas in half and press. Divide the mixture in half. Slice into half-moons. Scoop the seeds from each half. Stir in half-and-half, or half & half",
      ),
    ).toEqual([]);
    // Halfway is half, and so is the part a pot or a cup is filled.
    expect(read("Fill a pot halfway; flip half-way through; fill it half way")).toEqual([
      [0.5, null],
      [0.5, null],
      [0.5, null],
    ]);
    expect(
      read("Fill the cups a third full; the jars three quarters full, the glasses two thirds full"),
    ).toEqual([
      [0.333, null],
      [0.75, null],
      [0.667, null],
    ]);
    // "A quarter" is always a share; "a third" is one unless a thing follows,
    // when it counts ("a third egg", "a third time").
    expect(
      read(
        "Reduce by a third. Reduce to a third, about 10 minutes. Add a quarter onion; reserve a third for serving; keep a third back",
      ),
    ).toEqual([
      [0.333, null],
      [0.333, null],
      [10, "min"],
      [0.25, null],
      [0.333, null],
      [0.333, null],
    ]);
    expect(read("Add a third egg; fold it a third time; the third of them")).toEqual([]);
    // So are the other parts said as ordinals: with "a" or "an" a share,
    // bare an ordinal.
    expect(
      read("Reduce by a fifth. Add a fourth of the flour; an eighth teaspoon; reserve a sixth"),
    ).toEqual([
      [0.2, null],
      [0.25, null],
      [0.125, "tsp"],
      [0.167, null],
    ]);
    expect(
      read("Add a fifth egg; fold it a fourth time; the sixth hour; the eighth of them; fifth cup"),
    ).toEqual([]);
    // Reduced in half is a share, as reduced by half is: a liquid is not cut.
    expect(
      read(
        "Cook until reduced in half. Reduce the vinegar in half; it reduces in half. Boil the stock down in half",
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.5, null],
    ]);
    expect(
      read("Reduce the heat and cut the lemon in half. Cut the reduced-fat cheese in half"),
    ).toEqual([]);
  });

  it("reads a share after a cut or a bracket unless a way of cutting follows it", () => {
    // What a cut in brackets names, or one before a full stop, can still be
    // cut some way.
    expect(
      read(
        "Cut the zucchini (or squash) in half the long way. Chill 30min. Cut the loaf in half the long way. Cut the eggplant (1 lb) in half the long way",
      ),
    ).toEqual([
      [30, "min"],
      [1, "lb"],
    ]);
    // With no cut before it, a way said after "half the" is how a share is
    // added; "very" is how, not what is cut.
    expect(
      read("Stir in half the same way. Whisk in half this way. Fold very gently in half the same way"),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [0.5, null],
    ]);
  });

  it("reads a dozen of something, but not a measure that is part of another", () => {
    expect(
      read("the yolks of a dozen eggs, the juice of a dozen limes, half of a dozen eggs, ½ of a dozen eggs"),
    ).toEqual([
      [12, null],
      [12, null],
      [6, null],
      [6, null],
    ]);
    expect(read("the rest of a cup, most of an hour, three quarters of an hour")).toEqual([
      [45, "min"],
    ]);
  });

  it("reads a fraction in words or decimals, or with a fraction slash, before an article", () => {
    expect(
      read("one-half an hour, three-quarters an hour, 0.5 an hour, 1⁄2 an hour, two and 1⁄2 cups"),
    ).toEqual([
      [30, "min"],
      [45, "min"],
      [30, "min"],
      [30, "min"],
      [2.5, "cup"],
    ]);
  });

  it("reads the rarer abbreviations a measure and a half comes in", () => {
    expect(read("a qt. and a half, a pt and a half, a gal. and a half, a tbs. and a half")).toEqual([
      [1.5, "qt"],
      [1.5, "pt"],
      [1.5, "gal"],
      [1.5, "tbsp"],
    ]);
  });

  it("reads a leading decimal point and a hyphenated mixed number", () => {
    expect(quantitiesIn("Add .5 cup, then 1-1/2 cups, then 3-4 cups", all)).toEqual([
      { value: 0.5, unit: "cup" },
      { value: 1.5, unit: "cup" },
      { value: 3, unit: "cup" },
      { value: 4, unit: "cup" },
    ]);
    expect(quantitiesIn("Serve.5 minutes, v1.5", all).map((q) => q.value)).toEqual([5, 1.5]);
  });

  it("tells temperatures and spoons apart", () => {
    expect(
      quantitiesIn("350 degrees F, 180 C, 350°, 1 T, 1 t, 2 tbsp", all),
    ).toEqual([
      { value: 350, unit: "F" },
      { value: 180, unit: "C" },
      { value: 350, unit: "deg" },
      { value: 1, unit: "tbsp" },
      { value: 1, unit: "tsp" },
      { value: 2, unit: "tbsp" },
    ]);
  });

  it("does not read a unit out of the next word", () => {
    expect(
      quantitiesIn("2 large eggs, 2 garlic cloves, 2 minced shallots, 2 in the pan", all),
    ).toEqual([
      { value: 2, unit: null },
      { value: 2, unit: null },
      { value: 2, unit: null },
      { value: 2, unit: null },
    ]);
  });

  it("reads temperature symbols and entities as degrees", () => {
    expect(
      quantitiesIn("180℃, 350℉, 350˚F, 350&deg;F, 350&amp;deg;F, 350&#176;", all),
    ).toEqual([
      { value: 180, unit: "C" },
      { value: 350, unit: "F" },
      { value: 350, unit: "F" },
      { value: 350, unit: "F" },
      { value: 350, unit: "F" },
      { value: 350, unit: "deg" },
    ]);
    expect(
      quantitiesIn("350&#XB0;F, 180&#xb0;C, 350&#0176;, 350&degF, 350⁰F", all),
    ).toEqual([
      { value: 350, unit: "F" },
      { value: 180, unit: "C" },
      { value: 350, unit: "deg" },
      { value: 350, unit: "F" },
      { value: 350, unit: "F" },
    ]);
  });

  it("reads the less common unit spellings", () => {
    expect(quantitiesIn("250 gm, 500 mls, 2 in. pieces, 1 tblsp", all)).toEqual([
      { value: 250, unit: "g" },
      { value: 500, unit: "ml" },
      { value: 2, unit: "inch" },
      { value: 1, unit: "tbsp" },
    ]);
  });

  it("reads fractions said in words", () => {
    const read = (text: string) =>
      quantitiesIn(text, all).map((q) => [Number(q.value.toFixed(3)), q.unit]);
    expect(
      read(
        "two and a half cups, three-quarters cup, two thirds of a cup, one-third cup, 2 and 1/2 cups",
      ),
    ).toEqual([
      [2.5, "cup"],
      [0.75, "cup"],
      [0.667, "cup"],
      [0.333, "cup"],
      [2.5, "cup"],
    ]);
    // Not a proper fraction, so not one: two halves are two pieces.
    expect(read("Cut into two halves")).toEqual([[2, null]]);
  });

  const read = (text: string, options = all) =>
    quantitiesIn(text, options).map((q) => [Number(q.value.toFixed(3)), q.unit]);

  it("reads how many times a thing grows", () => {
    // A rise to double is a cue the cook needs, as much as a time is.
    expect(
      read(
        "until doubled; it doubles; until double in size; tripled; it triples; triple in volume; twice as long; thrice",
      ),
    ).toEqual([
      [2, null],
      [2, null],
      [2, null],
      [3, null],
      [3, null],
      [3, null],
      [2, null],
      [3, null],
    ]);
    expect(read("double cream, a double boiler, double-check, triple sec, double the recipe")).toEqual([]);
  });

  it("keeps a count apart from the size of the things counted", () => {
    expect(
      read("2 quarter-inch-thick planks, 3 quarter-inch slices, two quarter-pound patties"),
    ).toEqual([
      [2, null],
      [0.25, "inch"],
      [3, null],
      [0.25, "inch"],
      [2, null],
      [0.25, "lb"],
    ]);
    expect(read("a three-quarter-inch dice, a quarter-pound burger")).toEqual([
      [0.75, "inch"],
      [0.25, "lb"],
    ]);
  });

  it("does not join a fraction to the number before it", () => {
    expect(read("between 1/4 and 1/2 inch")).toEqual([
      [0.25, null],
      [0.5, "inch"],
    ]);
    expect(read("1.5 and 1/2 cups")).toEqual([
      [1.5, null],
      [0.5, "cup"],
    ]);
    expect(read("fill 12 two-thirds full")).toEqual([
      [12, null],
      [0.667, null],
    ]);
    expect(read("flour,2 and a half cups")).toEqual([[2.5, "cup"]]);
  });

  it("reads parts of an hour and a measure and a part", () => {
    expect(
      read(
        "three-quarters of an hour, a quarter of an hour, half of an hour, an hour and a quarter, an hour and one-half",
      ),
    ).toEqual([
      [45, "min"],
      [15, "min"],
      [30, "min"],
      [75, "min"],
      [90, "min"],
    ]);
    expect(read("a cup and a half of stock, 1 minute and a half, two hours and a half")).toEqual([
      [1.5, "cup"],
      [1.5, "min"],
      [150, "min"],
    ]);
    expect(
      read("a tsp and a half, a tbsp and a half, an oz and a half, a gallon and a half, a kilo and a half"),
    ).toEqual([
      [1.5, "tsp"],
      [1.5, "tbsp"],
      [1.5, "oz"],
      [1.5, "gal"],
      [1.5, "kg"],
    ]);
    // The half belongs to the teaspoon, not the cup.
    expect(read("1 cup and a half teaspoon salt")).toEqual([
      [1, "cup"],
      [0.5, "tsp"],
    ]);
  });

  it("reads the other ways a fraction is said", () => {
    expect(
      read(
        "two  thirds cup, two-and-a-half cups, twenty-one and a half minutes, one and one-half cups, half a cup, a third of a cup, a half teaspoon, one half cup",
      ),
    ).toEqual([
      [0.667, "cup"],
      [2.5, "cup"],
      [21.5, "min"],
      [1.5, "cup"],
      [0.5, "cup"],
      [0.333, "cup"],
      [0.5, "tsp"],
      [0.5, "cup"],
    ]);
  });

  it("reads a fraction with no unit when it is hyphenated or a part of something", () => {
    const needUnit = { wordsNeedUnit: true };
    expect(read("one-third of the sugar; two-thirds full", needUnit)).toEqual([
      [0.333, null],
      [0.667, null],
    ]);
    expect(
      read(
        "half the sauce, half of the butter, half an onion, a third of the whites, a quarter of the milk, one half of the dough, three quarters of the stock",
        needUnit,
      ),
    ).toEqual([
      [0.5, null],
      [0.5, null],
      [0.5, null],
      [0.333, null],
      [0.25, null],
      [0.5, null],
      [0.75, null],
    ]);
    // "One" before a part makes it a share, whatever follows: "keep one
    // third back" holds back a third.
    expect(read("keep one third back; one quarter; one half onion; cut in half", needUnit)).toEqual([
      [0.333, null],
      [0.25, null],
      [0.5, null],
    ]);
    // "a third" and "the third" can be ordinals, and "quarter" a verb, so
    // those need "a" or "one" to be a part.
    expect(read("a third egg, the third hour, the third of them, quarter the lemons", needUnit)).toEqual(
      [],
    );
  });

  it("skips a zero denominator and a fraction of one or more", () => {
    expect(read("2 and 1/0 cups")).toEqual([[2, null]]);
    expect(read("sixteen quarters, two halves, four quarters cup")).toEqual([
      [16, null],
      [2, null],
      [4, null],
    ]);
  });

  it("reads a long gap between numbers in linear time", () => {
    // Quadratic backtracking took ~20 s here; linear takes milliseconds.
    const text = `1${" ".repeat(200_000)}and 2 cups`;
    const started = performance.now();
    expect(read(text)).toEqual([
      [1, null],
      [2, "cup"],
    ]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads a size said in words as a range", () => {
    expect(quantitiesIn("a nine-by-thirteen-inch pan", all)).toEqual([
      { value: 9, unit: "inch" },
      { value: 13, unit: "inch" },
    ]);
  });

  it("returns nothing for text without numbers", () => {
    expect(quantitiesIn("Season to taste.", all)).toEqual([]);
  });
});

describe("identityPlan", () => {
  it("makes one cook task per source step, chained in order", () => {
    const plan = identityPlan(ZUCCHINI_RECIPE);
    expect(plan.tasks.map((t) => t.sourceStep)).toEqual([0, 1, 2, 3, 4]);
    expect(plan.tasks.every((t) => t.kind === "cook" && !t.implied)).toBe(true);
    expect(plan.tasks[0].needs).toEqual([]);
    expect(plan.tasks[3].needs).toEqual([plan.tasks[2].id]);
    expect(plan.tasks[1].text).toBe(ZUCCHINI_RECIPE.steps![1]);
  });

  it("uses the explicit step-ingredient mapping when present", () => {
    const plan = identityPlan({
      ...ZUCCHINI_RECIPE,
      stepIngredients: [[0, 1, 2, 3], [4], [5], [], [6]],
    });
    expect(plan.tasks.map((t) => t.ingredientIdx)).toEqual([
      [0, 1, 2, 3],
      [4],
      [5],
      [],
      [6],
    ]);
  });

  it("falls back to fuzzy matching without a mapping", () => {
    const plan = identityPlan(ZUCCHINI_RECIPE);
    expect(plan.tasks[2].ingredientIdx).toContain(5);
  });

  it("passes its own validation", () => {
    const plan = identityPlan(ZUCCHINI_RECIPE);
    expect(parseCookPlan(plan, ZUCCHINI_RECIPE).ok).toBe(true);
  });

  it("is empty for a recipe without steps", () => {
    expect(identityPlan({ steps: [] }).tasks).toEqual([]);
    expect(identityPlan({}).tasks).toEqual([]);
  });
});

describe("isCurrentCookPlan", () => {
  it("accepts a stored plan at the current version", () => {
    expect(isCurrentCookPlan(ZUCCHINI_PLAN)).toBe(true);
  });

  it("treats an old version, null or junk as absent", () => {
    expect(isCurrentCookPlan({ ...ZUCCHINI_PLAN, version: 0 })).toBe(false);
    expect(isCurrentCookPlan(null)).toBe(false);
    expect(isCurrentCookPlan({ tasks: [] })).toBe(false);
  });
});

describe("hasStepsToPlan", () => {
  it("is true when the recipe has a step", () => {
    expect(hasStepsToPlan(ZUCCHINI_RECIPE)).toBe(true);
    expect(hasStepsToPlan({ steps: ["Sear it"] })).toBe(true);
  });

  it("is false with no steps, an empty list or no recipe data", () => {
    expect(hasStepsToPlan({ ingredients: [{ item: "salmon" }] })).toBe(false);
    expect(hasStepsToPlan({ steps: [] })).toBe(false);
    expect(hasStepsToPlan({})).toBe(false);
  });
});
