import { describe, it, expect, beforeAll } from "vitest";
import {
  loadStepIngredientFixtures,
  regexPredictions,
  type StepIngredientFixture,
} from "./load-step-ingredient-fixtures";
import {
  scoreStepIngredients,
  type ScoreResult,
} from "../step-ingredient-scorer";

/**
 * Regression guard for the legacy fuzzy matcher (`findStepIngredients`), which
 * still backs legacy and JSON-LD recipes that carry no explicit LLM mapping.
 *
 * The measured regex baseline on this corpus (see
 * `scripts/eval-step-ingredients.ts`) is macro F1 ≈ 77.3%, micro ≈ 78.1%,
 * precision ≈ 75%. MINIMUM_F1 sits just below it: a refactor that degrades the
 * fallback fails here, while harmless formatting churn does not. The scoring is
 * deterministic (no model call), so the baseline does not drift run-to-run.
 *
 * The LLM-assigned approach scores materially higher on the same corpus — macro
 * ≈ 87.9%, micro ≈ 94.3%, precision ≈ 98.8% — but needs an API key, so it is
 * evaluated via the standalone script, not here. The precision jump (75% → 99%)
 * is the point: it kills the "oil/garlic matches every step" false positives.
 */
const MINIMUM_F1 = 0.76;

describe("step-ingredient eval corpus (regex fallback)", () => {
  let fixtures: StepIngredientFixture[];
  let perFixture: Array<{ fixture: StepIngredientFixture; score: ScoreResult }>;
  let corpus: ScoreResult;

  beforeAll(() => {
    fixtures = loadStepIngredientFixtures();
    const allPredictions: number[][] = [];
    const allGolden: number[][] = [];

    perFixture = fixtures.map((fixture) => {
      const predictions = regexPredictions(fixture);
      allPredictions.push(...predictions);
      allGolden.push(...fixture.golden);
      return {
        fixture,
        score: scoreStepIngredients(predictions, fixture.golden),
      };
    });

    corpus = scoreStepIngredients(allPredictions, allGolden);

    // Surface the table when running with reporter output.
    const rows = perFixture
      .map(
        ({ fixture, score }) =>
          `  ${fixture.name.padEnd(28)} macroF1=${(score.macroF1 * 100).toFixed(1)}%  microF1=${(score.microF1 * 100).toFixed(1)}%`,
      )
      .join("\n");
    console.log(
      `\nRegex baseline per fixture:\n${rows}\n  CORPUS macroF1=${(corpus.macroF1 * 100).toFixed(1)}%  microF1=${(corpus.microF1 * 100).toFixed(1)}%\n`,
    );
  });

  it("loads the full 8-fixture corpus", () => {
    expect(fixtures.length).toBe(8);
  });

  it("produces one prediction array per step in every fixture", () => {
    for (const { fixture } of perFixture) {
      const predictions = regexPredictions(fixture);
      expect(predictions.length).toBe(fixture.steps.length);
    }
  });

  it("keeps regex corpus macro F1 above the regression floor", () => {
    expect(corpus.macroF1).toBeGreaterThanOrEqual(MINIMUM_F1);
  });

  it("keeps regex corpus micro F1 above the regression floor", () => {
    expect(corpus.microF1).toBeGreaterThanOrEqual(MINIMUM_F1);
  });
});
