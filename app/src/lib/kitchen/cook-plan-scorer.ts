/**
 * Scores a derived cook plan against the labelled corpus in
 * `__tests__/fixtures/cook-plan/`, whose README defines every label. Four
 * measures, each the thing the cook view would get wrong:
 *
 *   - ahead: per gold item. A missed item is make-ahead work the cook learns
 *     about too late, so recall is gated at 1.0. A derived ahead task finds an
 *     item when it cites one of the item's steps, or, when implied, touches
 *     one of the item's anchor ingredients.
 *   - mise: the ingredients any mise task touches, against the gold set.
 *   - hands-off: the source steps of hands-off tasks, against the gold set.
 *     These windows are where "As I go" puts the prep.
 *   - step ingredients (cook-fidelity plan, decision 3): for a recipe whose
 *     steps say which ingredients they use, per step, the ingredients the
 *     tasks citing it list against that step's. A false positive is an
 *     ingredient shown beside a step that doesn't use it (the validator stops
 *     a cook task listing one; a mise or ahead task may); a false negative, one
 *     the step adds that no task citing it shows. Every kind counts: a step
 *     whose work moved to Prep ("whisk the dry ingredients") is cited by its
 *     mise task, which shows them there. Counting cook tasks alone scored that
 *     as dropped, 19 times in the first run, every one shown by the mise or
 *     ahead task citing the same step.
 *
 * A plan that fails validation is scored as the recipe as written, which is
 * what the cook would see, so its gold counts as missed.
 *
 * Pure module, shared by the offline eval test and `scripts/eval-cook-plan.ts`.
 */

import {
  identityPlan,
  stepIngredientBounds,
  type CookPlan,
  type CookPlanParseResult,
  type CookPlanRule,
  type CookTask,
  type RecipeForPlan,
} from "./cook-plan";
import {
  microAverage,
  scoreIndexSet,
  type MicroScore,
  type StepScore,
} from "./step-ingredient-scorer";

export interface AheadGold {
  /** What the work is, for reports: "soak the chickpeas". */
  what: string;
  /** Ingredients the work is on; implied work is found through these. */
  ingredients: number[];
  /** Source steps that state the work; empty when it is implied. */
  steps: number[];
}

export interface CookPlanGold {
  ahead: AheadGold[];
  mise: number[];
  handsOffSteps: number[];
}

export interface AheadScore {
  items: number;
  found: number;
  /** Derived ahead tasks. */
  tasks: number;
  /** Derived ahead tasks that find at least one item. */
  matchedTasks: number;
  /** The `what` of each item no task found. */
  missed: string[];
  /** The text of each ahead task that found no item. */
  falseAlarms: string[];
}

export interface CookPlanScore {
  ahead: AheadScore;
  mise: StepScore;
  handsOff: StepScore;
  /** One score per step, when the recipe says which ingredients each step uses; none otherwise. */
  stepIngredients: StepScore[];
}

export interface DerivationScore {
  valid: boolean;
  /** The rule an invalid plan broke; null for a valid plan. */
  rule: CookPlanRule | null;
  score: CookPlanScore;
}

/** Fixed before the first eval run; never lowered (brief, "Eval gate"). */
export const COOK_PLAN_GATES = {
  validPlans: 14 / 15,
  aheadRecall: 1,
  aheadPrecision: 0.75,
  miseF1: 0.8,
  handsOffF1: 0.75,
  // Added with the cook-fidelity plan, the line fixed before its first eval
  // run. The measure was redefined after that run (cook tasks only → every
  // task citing the step; header): it missed the line at 0.885 on 19 "drops",
  // each one shown by the mise or ahead task citing the same step.
  stepIngredientsF1: 0.9,
} as const;

export type CookPlanGate = keyof typeof COOK_PLAN_GATES;

export interface CorpusScore {
  plans: number;
  valid: number;
  ahead: { recall: number; precision: number };
  mise: MicroScore;
  handsOff: MicroScore;
  stepIngredients: MicroScore;
  gates: Record<CookPlanGate, boolean>;
  passed: boolean;
}

function finds(task: CookTask, item: AheadGold): boolean {
  if (task.sourceStep !== null) return item.steps.includes(task.sourceStep);
  return task.ingredientIdx.some((i) => item.ingredients.includes(i));
}

function scoreAhead(plan: CookPlan, gold: AheadGold[]): AheadScore {
  const tasks = plan.tasks.filter((t) => t.kind === "ahead");
  const matched = tasks.filter((t) => gold.some((item) => finds(t, item)));
  const missed = gold.filter((item) => !tasks.some((t) => finds(t, item)));
  return {
    items: gold.length,
    found: gold.length - missed.length,
    tasks: tasks.length,
    matchedTasks: matched.length,
    missed: missed.map((item) => item.what),
    falseAlarms: tasks.filter((t) => !matched.includes(t)).map((t) => t.text),
  };
}

/**
 * Per step of the mapping, the ingredients the tasks citing it list, of any
 * kind, against the step's own.
 */
function scoreStepIngredients(plan: CookPlan, bounds: number[][] | null): StepScore[] {
  if (bounds === null) return [];
  return bounds.map((uses, step) =>
    scoreIndexSet(
      plan.tasks.filter((t) => t.sourceStep === step).flatMap((t) => t.ingredientIdx),
      uses,
    ),
  );
}

/**
 * `bounds` is the recipe's step-ingredient mapping (`stepIngredientBounds`),
 * or null for a recipe without one, which scores no cook ingredients.
 */
export function scoreCookPlan(plan: CookPlan, gold: CookPlanGold, bounds: number[][] | null): CookPlanScore {
  const mise = plan.tasks
    .filter((t) => t.kind === "mise")
    .flatMap((t) => t.ingredientIdx);
  const handsOff = plan.tasks.flatMap((t) =>
    t.minutes?.handsOff && t.sourceStep !== null ? [t.sourceStep] : [],
  );
  return {
    ahead: scoreAhead(plan, gold.ahead),
    mise: scoreIndexSet(mise, gold.mise),
    handsOff: scoreIndexSet(handsOff, gold.handsOffSteps),
    stepIngredients: scoreStepIngredients(plan, bounds),
  };
}

/** Score a derivation as the cook would meet it: invalid plans fall back. */
export function scoreDerivation(
  result: CookPlanParseResult,
  recipe: RecipeForPlan,
  gold: CookPlanGold,
): DerivationScore {
  const bounds = stepIngredientBounds(recipe);
  if (result.ok) {
    return { valid: true, rule: null, score: scoreCookPlan(result.plan, gold, bounds) };
  }
  return {
    valid: false,
    rule: result.rule,
    score: scoreCookPlan(identityPlan(recipe), gold, bounds),
  };
}

/** Micro-average the corpus and check each gate. */
export function scoreCorpus(results: DerivationScore[]): CorpusScore {
  if (results.length === 0) throw new Error("scoreCorpus: empty corpus");

  let items = 0;
  let found = 0;
  let tasks = 0;
  let matchedTasks = 0;
  for (const { score } of results) {
    items += score.ahead.items;
    found += score.ahead.found;
    tasks += score.ahead.tasks;
    matchedTasks += score.ahead.matchedTasks;
  }

  const plans = results.length;
  const valid = results.filter((r) => r.valid).length;
  const ahead = {
    recall: items === 0 ? 1 : found / items,
    precision: tasks === 0 ? 1 : matchedTasks / tasks,
  };
  const mise = microAverage(results.map((r) => r.score.mise));
  const handsOff = microAverage(results.map((r) => r.score.handsOff));
  const stepIngredients = microAverage(results.flatMap((r) => r.score.stepIngredients));

  const gates: Record<CookPlanGate, boolean> = {
    validPlans: valid / plans >= COOK_PLAN_GATES.validPlans,
    aheadRecall: ahead.recall >= COOK_PLAN_GATES.aheadRecall,
    aheadPrecision: ahead.precision >= COOK_PLAN_GATES.aheadPrecision,
    miseF1: mise.f1 >= COOK_PLAN_GATES.miseF1,
    handsOffF1: handsOff.f1 >= COOK_PLAN_GATES.handsOffF1,
    stepIngredientsF1: stepIngredients.f1 >= COOK_PLAN_GATES.stepIngredientsF1,
  };

  return {
    plans,
    valid,
    ahead,
    mise,
    handsOff,
    stepIngredients,
    gates,
    passed: Object.values(gates).every(Boolean),
  };
}
