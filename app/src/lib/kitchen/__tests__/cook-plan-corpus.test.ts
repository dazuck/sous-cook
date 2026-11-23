import { describe, it, expect } from "vitest";
import {
  PREP_STYLES,
  gateRecipe,
  loadCookPlanFixtures,
  parseCookPlanFixture,
  type CookPlanFixture,
  type RecipeLookup,
} from "./load-cook-plan-fixtures";
import { scoreCorpus, scoreDerivation } from "../cook-plan-scorer";
import { stepIngredientBounds } from "../cook-plan";

describe("cook-plan eval corpus", () => {
  const fixtures = loadCookPlanFixtures();

  it("has the 15 recipes the gate is defined over", () => {
    expect(fixtures).toHaveLength(15);
  });

  it("covers what the brief requires: make-ahead, a long recipe, every prep style", () => {
    const withAhead = fixtures.filter((f) => f.gold.ahead.length > 0);
    expect(withAhead.length).toBeGreaterThanOrEqual(3);
    expect(fixtures.some((f) => f.recipe.steps.length >= 20)).toBe(true);
    const styles = new Set(fixtures.flatMap((f) => f.prepStyles));
    expect([...styles].sort()).toEqual([...PREP_STYLES].sort());
  });

  it("gives each recipe borrowed from the step-ingredient corpus its labelled mapping, one that bounds the plan", () => {
    // The 8 `recipeFrom` fixtures: the cook-ingredients gate measures only these.
    const mapped = fixtures.filter((f) => f.stepIngredients !== undefined);
    expect(mapped).toHaveLength(8);
    for (const f of mapped) expect(stepIngredientBounds(gateRecipe(f)), f.name).not.toBeNull();
  });

  it("fails every gate but validity as written, so the gate measures derivation", () => {
    const corpus = scoreCorpus(
      fixtures.map((f) =>
        scoreDerivation(
          { ok: false, rule: "shape", detail: "", violations: [{ rule: "shape", detail: "" }] },
          f.recipe,
          f.gold,
        ),
      ),
    );
    expect(corpus.ahead.recall).toBe(0);
    expect(corpus.mise.recall).toBe(0);
    expect(corpus.handsOff.recall).toBe(0);
    expect(corpus.passed).toBe(false);
  });
});

describe("parseCookPlanFixture", () => {
  const recipe: CookPlanFixture["recipe"] = {
    ingredients: [{ item: "chickpeas" }, { item: "onion" }, { item: "salt" }],
    steps: ["Soak the chickpeas.", "Dice the onion.", "Simmer."],
  };
  const lookup: RecipeLookup = (name) => (name === "stew" ? recipe : undefined);
  const base = {
    description: "d",
    prepStyles: ["front-loaded"],
    recipe,
    gold: {
      ahead: [{ what: "soak", ingredients: [0], steps: [0] }],
      mise: [1],
      handsOffSteps: [0, 2],
    },
  };
  const parse = (raw: unknown) => parseCookPlanFixture("f", raw, lookup);
  const withGold = (gold: Partial<typeof base.gold>) => ({
    ...base,
    gold: { ...base.gold, ...gold },
  });

  it("accepts a well-formed fixture", () => {
    expect(parse(base)).toMatchObject({ name: "f", recipe, gold: base.gold });
  });

  it("resolves recipeFrom through the lookup", () => {
    const { recipe: _, ...rest } = base;
    expect(parse({ ...rest, recipeFrom: "stew" }).recipe).toEqual(recipe);
    expect(() => parse({ ...rest, recipeFrom: "soup" })).toThrow(/not found/);
  });

  it("needs exactly one of recipe or recipeFrom", () => {
    const { recipe: _, ...rest } = base;
    expect(() => parse(rest)).toThrow(/exactly one/);
    expect(() => parse({ ...base, recipeFrom: "stew" })).toThrow(/exactly one/);
  });

  it("rejects unknown keys and prep styles", () => {
    expect(() => parse({ ...base, notes: "x" })).toThrow();
    expect(() => parse({ ...base, prepStyles: ["batch"] })).toThrow();
  });

  it("rejects out-of-range and repeated indices", () => {
    expect(() => parse(withGold({ mise: [3] }))).toThrow(/mise index 3/);
    expect(() => parse(withGold({ handsOffSteps: [3] }))).toThrow(/handsOffSteps/);
    expect(() => parse(withGold({ mise: [1, 1] }))).toThrow(/twice/);
    expect(() =>
      parse(withGold({ ahead: [{ what: "soak", ingredients: [0], steps: [5] }] })),
    ).toThrow(/ahead\[0\]\.steps/);
  });

  it("rejects ahead items that share an anchor or a step", () => {
    const soak = { what: "soak", ingredients: [0], steps: [0] };
    expect(() =>
      parse(withGold({ ahead: [soak, { what: "brine", ingredients: [0, 2], steps: [] }] })),
    ).toThrow(/share ingredient 0/);
    expect(() =>
      parse(withGold({ ahead: [soak, { what: "brine", ingredients: [2], steps: [0] }] })),
    ).toThrow(/share step 0/);
  });

  it("rejects an ahead item nothing could find", () => {
    expect(() =>
      parse(withGold({ ahead: [{ what: "plan", ingredients: [], steps: [] }] })),
    ).toThrow(/nothing can find it/);
  });
});
