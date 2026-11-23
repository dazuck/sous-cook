/**
 * A peanut chutney fixture written as many short one-clause steps (36 steps,
 * 20 of four words or fewer) to test step-merging validation. The model can
 * merge short neighbours into one task, and a task cites one step, so the
 * neighbour it folded in is left uncited.
 *
 * `chutneyRaw()` is a plan that cites every step, one cook task per step in a
 * chain. `chutneyMergedRaw()` simulates merged neighbours where each merged
 * task cites only one of its steps, so steps 3, 4, 7, 11 and 14 are carried
 * by no task.
 */

import type { RecipeForPlan } from "../cook-plan";

export const CHUTNEY_RECIPE: RecipeForPlan = {
  ingredients: [
    { amount: "1.5", unit: "cups", item: "peanuts" },
    { amount: "3", item: "garlic cloves" },
    { amount: "1", unit: "teaspoon", item: "coriander seeds" },
    { amount: "1", unit: "teaspoon", item: "cumin seeds" },
    { item: "curry leaves" },
    { item: "oil" },
    { amount: "1", unit: "cup", item: "water" },
    { amount: "1/4", unit: "teaspoon", item: "salt" },
  ],
  steps: [
    "Toast the peanuts on low heat for about 13 minutes",
    "Let cool to room temperature",
    "Peel",
    "Set aside",
    "Turn stove to low heat",
    "Add oil, wait 30 seconds",
    "Add garlic",
    "Wait 30 seconds",
    "Add coriander seeds",
    "Add cumin seeds",
    "Add curry leaves",
    "Remove from heat",
    "Add the spice mixture, peanuts and 1 cup water to the blender",
    "Add 1/4 teaspoon salt",
    "Blend",
  ],
};

/**
 * Each merged task: the step it cites and the neighbour it folds in. Step 5's
 * task cites 5 but reads "Turn stove to low heat. Add oil, wait 30 seconds.",
 * as `heat-pan-oil` did in prod.
 */
const MERGES = [
  { cites: 2, folds: 3 },
  { cites: 5, folds: 4 },
  { cites: 6, folds: 7 },
  { cites: 10, folds: 11 },
  { cites: 13, folds: 14 },
];

/** The steps `chutneyMergedRaw` leaves uncited. */
export const CHUTNEY_UNCITED = [3, 4, 7, 11, 14];

interface ChainTask {
  id: string;
  kind: "cook";
  text: string;
  label: string;
  ingredientIdx: number[];
  sourceStep: number;
  implied: false;
  needs: string[];
  minutes: { est: number; handsOff: boolean };
  cue: null;
  lead: null;
  branch: string;
}

function chain(groups: { cites: number; steps: number[] }[]): { tasks: ChainTask[] } {
  const steps = CHUTNEY_RECIPE.steps!;
  const tasks = groups.map(({ cites, steps: carried }, i): ChainTask => ({
    id: `step-${cites}`,
    kind: "cook",
    text: carried.map((s) => `${steps[s]}.`).join(" "),
    label: steps[cites]!.toLowerCase().split(" ").slice(0, 2).join(" "),
    ingredientIdx: [],
    sourceStep: cites,
    implied: false,
    needs: i === 0 ? [] : [`step-${groups[i - 1]!.cites}`],
    minutes: cites === 0 ? { est: 13, handsOff: true } : { est: 1, handsOff: false },
    cue: null,
    lead: null,
    branch: "Cook",
  }));
  return { tasks };
}

/** Every step its own task, in a chain: a plan the validator accepts. */
export function chutneyRaw(): { tasks: ChainTask[] } {
  return chain(CHUTNEY_RECIPE.steps!.map((_, i) => ({ cites: i, steps: [i] })));
}

/** Short neighbours merged, each merged task citing one step (the prod reply). */
export function chutneyMergedRaw(): { tasks: ChainTask[] } {
  const folded = new Set(MERGES.map((m) => m.folds));
  const groups = CHUTNEY_RECIPE.steps!.flatMap((_, i) => {
    if (folded.has(i)) return [];
    const merge = MERGES.find((m) => m.cites === i);
    return [{ cites: i, steps: merge ? [i, merge.folds].sort((a, b) => a - b) : [i] }];
  });
  return chain(groups);
}
