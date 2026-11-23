import { describe, it, expect } from "vitest";
import type { CookPlan, CookTask } from "./cook-plan";
import {
  COOK_PLAN_GATES,
  scoreCookPlan,
  scoreCorpus,
  scoreDerivation,
  type CookPlanGold,
  type DerivationScore,
} from "./cook-plan-scorer";

function t(
  id: string,
  kind: CookTask["kind"],
  opts: Partial<CookTask> = {},
): CookTask {
  const sourceStep = opts.sourceStep ?? null;
  return {
    id,
    kind,
    text: id,
    label: id,
    ingredientIdx: [],
    sourceStep,
    implied: sourceStep === null,
    needs: [],
    branch: "Cook",
    ...opts,
  };
}

const plan = (...tasks: CookTask[]): CookPlan => ({ version: 1, tasks });
const off = (est: number) => ({ est, handsOff: true });
const on = (est: number) => ({ est, handsOff: false });

const NO_GOLD: CookPlanGold = { ahead: [], mise: [], handsOffSteps: [] };

describe("scoreCookPlan: ahead", () => {
  const gold: CookPlanGold = {
    ...NO_GOLD,
    ahead: [
      { what: "soften the butter", ingredients: [0], steps: [] },
      { what: "make and chill the dough", ingredients: [1, 2], steps: [0, 1] },
    ],
  };

  it("finds a stated item by a task citing one of its steps", () => {
    const score = scoreCookPlan(
      plan(t("chill", "ahead", { sourceStep: 1 }), t("bake", "cook")),
      gold,
      null,
    ).ahead;
    expect(score).toMatchObject({ items: 2, found: 1, tasks: 1, matchedTasks: 1 });
    expect(score.missed).toEqual(["soften the butter"]);
  });

  it("finds an implied item only by an implied task touching its anchor", () => {
    const implied = scoreCookPlan(
      plan(t("soften", "ahead", { ingredientIdx: [0] }), t("bake", "cook")),
      gold,
      null,
    ).ahead;
    expect(implied.found).toBe(1);
    expect(implied.missed).toEqual(["make and chill the dough"]);

    // Citing the creaming step for work the recipe never states finds the
    // dough, not the butter.
    const cited = scoreCookPlan(
      plan(
        t("soften", "ahead", { sourceStep: 0, ingredientIdx: [0] }),
        t("bake", "cook"),
      ),
      gold,
      null,
    ).ahead;
    expect(cited.missed).toEqual(["soften the butter"]);
  });

  it("finds a stated item by an implied task touching its anchors", () => {
    const score = scoreCookPlan(
      plan(t("zest", "ahead", { ingredientIdx: [2] }), t("bake", "cook")),
      gold,
      null,
    ).ahead;
    expect(score.missed).toEqual(["soften the butter"]);
  });

  it("counts an ahead task that finds no item as a false alarm", () => {
    const score = scoreCookPlan(
      plan(
        t("chill", "ahead", { sourceStep: 1 }),
        t("preheat", "ahead", { sourceStep: 2 }),
        t("thaw", "ahead", { ingredientIdx: [5] }),
        t("bake", "cook"),
      ),
      gold,
      null,
    ).ahead;
    expect(score).toMatchObject({ tasks: 3, matchedTasks: 1 });
    expect(score.falseAlarms).toEqual(["preheat", "thaw"]);
  });

  it("ignores mise and cook tasks, whatever they cite", () => {
    const score = scoreCookPlan(
      plan(
        t("mix", "mise", { sourceStep: 0, ingredientIdx: [1] }),
        t("soften", "cook", { ingredientIdx: [0] }),
      ),
      gold,
      null,
    ).ahead;
    expect(score).toMatchObject({ found: 0, tasks: 0, matchedTasks: 0 });
  });
});

describe("scoreCookPlan: mise and hands-off", () => {
  it("scores the ingredients any mise task touches against the gold set", () => {
    const score = scoreCookPlan(
      plan(
        t("dice", "mise", { ingredientIdx: [0, 1] }),
        t("zest", "mise", { ingredientIdx: [1, 4] }),
        t("soak", "ahead", { ingredientIdx: [2] }),
        t("fry", "cook", { ingredientIdx: [3] }),
      ),
      { ...NO_GOLD, mise: [0, 1, 2] },
      null,
    ).mise;
    expect(score).toMatchObject({
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 1,
    });
  });

  it("scores the source steps of hands-off tasks; implied ones are not scored", () => {
    const score = scoreCookPlan(
      plan(
        t("stir", "cook", { sourceStep: 2, minutes: on(3) }),
        t("simmer", "cook", { sourceStep: 1, minutes: off(20) }),
        t("rest", "cook", { sourceStep: 3, minutes: off(5) }),
        t("soak", "ahead", { sourceStep: 0, minutes: off(600) }),
        t("steep", "mise", { minutes: off(10) }),
        t("sear", "cook", { sourceStep: 2 }),
      ),
      { ...NO_GOLD, handsOffSteps: [0, 1, 2] },
      null,
    ).handsOff;
    expect(score).toMatchObject({
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 1,
    });
  });
});

describe("scoreCookPlan: step ingredients", () => {
  it("scores, per step of the mapping, what the tasks citing it list against what the step uses", () => {
    const score = scoreCookPlan(
      plan(
        // Step 0 uses 0 and 1: its two cook tasks list both between them.
        t("sweat", "cook", { sourceStep: 0, ingredientIdx: [0] }),
        t("season", "cook", { sourceStep: 0, ingredientIdx: [1] }),
        // Step 1 uses 2 and 3: its cook task drops 3; an implied mise listing 3 cites no step.
        t("chop", "mise", { ingredientIdx: [3] }),
        t("simmer", "cook", { sourceStep: 1, ingredientIdx: [2] }),
        // Step 2 uses none, and its task lists 4 (a plan the validator would refuse).
        t("serve", "cook", { sourceStep: 2, ingredientIdx: [4] }),
        // Step 3's work moved to Prep: its mise task shows 5, and lists 6, which step 3 doesn't use.
        t("whisk-dry", "mise", { sourceStep: 3, ingredientIdx: [5, 6] }),
      ),
      NO_GOLD,
      [[0, 1], [2, 3], [], [5]],
    ).stepIngredients;
    expect(score.map(({ truePositives, falsePositives, falseNegatives }) => [truePositives, falsePositives, falseNegatives])).toEqual([
      [2, 0, 0],
      [1, 0, 1],
      [0, 1, 0],
      [1, 1, 0],
    ]);
  });

  it("scores nothing for a recipe without a mapping", () => {
    const score = scoreCookPlan(plan(t("fry", "cook", { sourceStep: 0, ingredientIdx: [0] })), NO_GOLD, null);
    expect(score.stepIngredients).toEqual([]);
  });
});

describe("scoreDerivation", () => {
  const recipe = {
    ingredients: [{ item: "chickpeas" }, { item: "onion" }],
    steps: ["Soak the chickpeas overnight.", "Dice the onion.", "Simmer 1 hour."],
  };
  const gold: CookPlanGold = {
    ahead: [{ what: "soak", ingredients: [0], steps: [0] }],
    mise: [1],
    handsOffSteps: [0, 2],
  };

  it("scores a valid plan as derived", () => {
    const derived = plan(
      t("soak", "ahead", { sourceStep: 0, ingredientIdx: [0], minutes: off(480) }),
      t("dice", "mise", { sourceStep: 1, ingredientIdx: [1] }),
      t("simmer", "cook", { sourceStep: 2, minutes: off(60) }),
    );
    const result = scoreDerivation({ ok: true, plan: derived }, recipe, gold);
    expect(result.valid).toBe(true);
    expect(result.rule).toBeNull();
    expect(result.score.ahead.found).toBe(1);
    expect(result.score.mise.f1).toBe(1);
    expect(result.score.handsOff.f1).toBe(1);
  });

  it("scores an invalid plan as the as-written fallback: every gold label missed", () => {
    const result = scoreDerivation(
      { ok: false, rule: "cycle", detail: "a → b → a", violations: [{ rule: "cycle", detail: "a → b → a" }] },
      recipe,
      gold,
    );
    expect(result.valid).toBe(false);
    expect(result.rule).toBe("cycle");
    expect(result.score.ahead).toMatchObject({ items: 1, found: 0, tasks: 0 });
    expect(result.score.mise).toMatchObject({ truePositives: 0, falseNegatives: 1 });
    expect(result.score.handsOff).toMatchObject({ truePositives: 0, falseNegatives: 2 });
  });
});

describe("scoreCorpus", () => {
  function entry(overrides: {
    valid?: boolean;
    ahead?: [found: number, items: number, matched: number, tasks: number];
    mise?: [tp: number, fp: number, fn: number];
    handsOff?: [tp: number, fp: number, fn: number];
    stepIngredients?: [tp: number, fp: number, fn: number];
  }): DerivationScore {
    const [found, items, matchedTasks, tasks] = overrides.ahead ?? [0, 0, 0, 0];
    const set = ([tp, fp, fn]: [number, number, number]) => ({
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision: 0,
      recall: 0,
      f1: 0,
      triviallyEmpty: false,
    });
    return {
      valid: overrides.valid ?? true,
      rule: overrides.valid === false ? "cycle" : null,
      score: {
        ahead: { items, found, tasks, matchedTasks, missed: [], falseAlarms: [] },
        mise: set(overrides.mise ?? [0, 0, 0]),
        handsOff: set(overrides.handsOff ?? [0, 0, 0]),
        stepIngredients: overrides.stepIngredients ? [set(overrides.stepIngredients)] : [],
      },
    };
  }

  /** 15 plans that sit exactly on every gate. */
  function onTheLine(): DerivationScore[] {
    const results = Array.from({ length: 15 }, () => entry({}));
    results[0] = entry({ valid: false });
    // Ahead: all 4 items found; 3 of 4 tasks match, so precision is 0.75.
    results[1] = entry({ ahead: [4, 4, 3, 4] });
    // Mise F1 = 0.8: tp 8, fp 2, fn 2.
    results[2] = entry({ mise: [8, 2, 2] });
    // Hands-off F1 = 0.75: tp 3, fp 1, fn 1.
    results[3] = entry({ handsOff: [3, 1, 1] });
    // Step ingredients F1 = 0.9: tp 9, fp 0, fn 2.
    results[4] = entry({ stepIngredients: [9, 0, 2] });
    return results;
  }

  it("sums items, tasks and set counts across the corpus", () => {
    const corpus = scoreCorpus([
      entry({ ahead: [1, 2, 1, 2], mise: [3, 1, 0], handsOff: [1, 0, 1] }),
      entry({ ahead: [1, 1, 1, 1], mise: [1, 0, 1], handsOff: [2, 1, 0] }),
    ]);
    expect(corpus.plans).toBe(2);
    expect(corpus.valid).toBe(2);
    expect(corpus.ahead.recall).toBeCloseTo(2 / 3);
    expect(corpus.ahead.precision).toBeCloseTo(2 / 3);
    expect(corpus.mise.precision).toBeCloseTo(4 / 5);
    expect(corpus.mise.recall).toBeCloseTo(4 / 5);
    expect(corpus.handsOff.precision).toBeCloseTo(3 / 4);
    expect(corpus.handsOff.recall).toBeCloseTo(3 / 4);
  });

  it("passes a corpus sitting exactly on every gate", () => {
    const corpus = scoreCorpus(onTheLine());
    expect(corpus.valid).toBe(14);
    expect(corpus.ahead).toEqual({ recall: 1, precision: 0.75 });
    expect(corpus.mise.f1).toBeCloseTo(0.8, 10);
    expect(corpus.handsOff.f1).toBeCloseTo(0.75, 10);
    expect(corpus.stepIngredients.f1).toBeCloseTo(0.9, 10);
    expect(corpus.gates).toEqual({
      validPlans: true,
      aheadRecall: true,
      aheadPrecision: true,
      miseF1: true,
      handsOffF1: true,
      stepIngredientsF1: true,
    });
    expect(corpus.passed).toBe(true);
  });

  it("fails each gate just below its line", () => {
    const cases: Array<[keyof typeof COOK_PLAN_GATES, DerivationScore]> = [
      ["validPlans", entry({ valid: false })],
      ["aheadRecall", entry({ ahead: [0, 1, 0, 0] })],
      ["aheadPrecision", entry({ ahead: [0, 0, 0, 1] })],
      ["miseF1", entry({ mise: [0, 1, 1] })],
      ["handsOffF1", entry({ handsOff: [0, 1, 1] })],
      ["stepIngredientsF1", entry({ stepIngredients: [0, 0, 1] })],
    ];
    for (const [gate, extra] of cases) {
      const results = onTheLine();
      results[14] = extra;
      const corpus = scoreCorpus(results);
      expect(corpus.gates[gate], gate).toBe(false);
      expect(corpus.passed, gate).toBe(false);
    }
  });

  it("treats a corpus with no mapping anywhere as perfect on step ingredients", () => {
    expect(scoreCorpus([entry({})]).stepIngredients).toEqual({ precision: 1, recall: 1, f1: 1 });
  });

  it("treats a corpus with no ahead work and no ahead tasks as perfect on ahead", () => {
    const corpus = scoreCorpus([entry({})]);
    expect(corpus.ahead).toEqual({ recall: 1, precision: 1 });
  });

  it("throws on an empty corpus", () => {
    expect(() => scoreCorpus([])).toThrow(/empty/);
  });
});
