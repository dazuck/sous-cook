import { describe, it, expect } from "vitest";
import { scoreStepIngredients } from "./step-ingredient-scorer";

describe("scoreStepIngredients", () => {
  it("scores a perfect match as F1 = 1", () => {
    const result = scoreStepIngredients([[0, 1], [2], []], [[0, 1], [2], []]);
    expect(result.macroF1).toBe(1);
    expect(result.microF1).toBe(1);
    expect(result.microPrecision).toBe(1);
    expect(result.microRecall).toBe(1);
  });

  it("excludes trivially-empty steps from the macro average", () => {
    // Step 1 is empty in both → trivially correct, must not be counted. Step 0
    // is a perfect single match. So macroF1 should be 1 over a single scored
    // step, not diluted.
    const result = scoreStepIngredients([[0], []], [[0], []]);
    expect(result.scoredSteps).toBe(1);
    expect(result.macroF1).toBe(1);
  });

  it("penalizes a false positive in precision", () => {
    // Predicted {0,1}, golden {0}: TP=1, FP=1, FN=0.
    const result = scoreStepIngredients([[0, 1]], [[0]]);
    expect(result.microPrecision).toBe(0.5);
    expect(result.microRecall).toBe(1);
    expect(result.microF1).toBeCloseTo((2 * 0.5 * 1) / (0.5 + 1), 5);
  });

  it("penalizes a false negative in recall", () => {
    // Predicted {0}, golden {0,1}: TP=1, FP=0, FN=1.
    const result = scoreStepIngredients([[0]], [[0, 1]]);
    expect(result.microPrecision).toBe(1);
    expect(result.microRecall).toBe(0.5);
  });

  it("scores a complete miss as F1 = 0", () => {
    const result = scoreStepIngredients([[2]], [[0, 1]]);
    expect(result.microF1).toBe(0);
    expect(result.macroF1).toBe(0);
  });

  it("treats an empty prediction against a non-empty golden as full miss on recall", () => {
    // Predicted {}, golden {0}: precision is vacuously 1 (no wrong guesses),
    // recall is 0, so F1 is 0.
    const result = scoreStepIngredients([[]], [[0]]);
    expect(result.microRecall).toBe(0);
    expect(result.perStep[0].f1).toBe(0);
    expect(result.perStep[0].triviallyEmpty).toBe(false);
  });

  it("deduplicates repeated indices within a step", () => {
    const result = scoreStepIngredients([[0, 0, 0]], [[0]]);
    expect(result.microPrecision).toBe(1);
    expect(result.microRecall).toBe(1);
  });

  it("throws when prediction and golden lengths differ", () => {
    expect(() => scoreStepIngredients([[0]], [[0], [1]])).toThrow(
      /length mismatch/,
    );
  });
});
