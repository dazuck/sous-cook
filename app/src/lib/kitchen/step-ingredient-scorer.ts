/**
 * Precision / recall / F1 scorer for per-step ingredient assignment.
 *
 * Each prediction and each golden label is an array (parallel to a recipe's
 * steps) of arrays of 0-based ingredient indices. For a single step we compare
 * the predicted index set against the golden index set:
 *
 *   TP = indices in both      FP = predicted but not golden
 *   FN = golden but not predicted
 *
 * Aggregates:
 *   - macro F1: the mean of per-step F1, SKIPPING steps where both the
 *     prediction and the golden label are empty (those are trivially correct
 *     and would otherwise inflate the score on technique/timing steps).
 *   - micro P/R/F1: accumulate TP/FP/FN across every step, then compute once.
 *
 * Pure module — no AI, DB, or React imports — so it runs in unit tests and the
 * standalone eval script identically.
 */

export interface StepScore {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** True when both predicted and golden index sets were empty for this step. */
  triviallyEmpty: boolean;
}

export interface ScoreResult {
  perStep: StepScore[];
  /** Mean per-step F1, excluding trivially-empty steps. */
  macroF1: number;
  microPrecision: number;
  microRecall: number;
  microF1: number;
  /** Number of steps included in the macro average (non-trivially-empty). */
  scoredSteps: number;
}

function uniqueIntegers(indices: number[]): Set<number> {
  const set = new Set<number>();
  for (const i of indices) {
    if (Number.isInteger(i)) set.add(i);
  }
  return set;
}

/**
 * Compare one predicted index set against its golden set. Shared with the
 * cook-plan scorer, which compares whole-recipe sets the same way.
 */
export function scoreIndexSet(predicted: number[], golden: number[]): StepScore {
  const predictedSet = uniqueIntegers(predicted);
  const goldenSet = uniqueIntegers(golden);

  let truePositives = 0;
  for (const i of predictedSet) {
    if (goldenSet.has(i)) truePositives++;
  }
  const falsePositives = predictedSet.size - truePositives;
  const falseNegatives = goldenSet.size - truePositives;

  const triviallyEmpty = predictedSet.size === 0 && goldenSet.size === 0;

  const precision =
    predictedSet.size === 0 ? 1 : truePositives / predictedSet.size;
  const recall = goldenSet.size === 0 ? 1 : truePositives / goldenSet.size;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);

  return {
    precision,
    recall,
    f1,
    truePositives,
    falsePositives,
    falseNegatives,
    triviallyEmpty,
  };
}

/**
 * Score predicted per-step ingredient indices against golden labels.
 *
 * @throws if `predictions` and `golden` differ in length (they must be parallel
 *   to the same step list — a mismatch is a harness bug, not a soft failure).
 */
export function scoreStepIngredients(
  predictions: number[][],
  golden: number[][],
): ScoreResult {
  if (predictions.length !== golden.length) {
    throw new Error(
      `Prediction/golden length mismatch: ${predictions.length} vs ${golden.length}`,
    );
  }

  const perStep = predictions.map((predicted, i) =>
    scoreIndexSet(predicted, golden[i]),
  );

  const scored = perStep.filter((s) => !s.triviallyEmpty);
  const macroF1 =
    scored.length === 0
      ? 1
      : scored.reduce((sum, s) => sum + s.f1, 0) / scored.length;

  const micro = microAverage(perStep);

  return {
    perStep,
    macroF1,
    microPrecision: micro.precision,
    microRecall: micro.recall,
    microF1: micro.f1,
    scoredSteps: scored.length,
  };
}

export interface MicroScore {
  precision: number;
  recall: number;
  f1: number;
}

/** Accumulate TP/FP/FN across set scores, then compute P/R/F1 once. */
export function microAverage(
  scores: ReadonlyArray<
    Pick<StepScore, "truePositives" | "falsePositives" | "falseNegatives">
  >,
): MicroScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const s of scores) {
    tp += s.truePositives;
    fp += s.falsePositives;
    fn += s.falseNegatives;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  // F1 from the counts, not from P and R: the same value, but exact at a gate
  // line (8/10 and 8/10 give 0.8000000000000002 the other way).
  const f1 = tp + fp + fn === 0 ? 1 : (2 * tp) / (2 * tp + fp + fn);
  return { precision, recall, f1 };
}
