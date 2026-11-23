/**
 * Sweet Zucchini Wraps — fixture recipe and cook plan shared by the
 * cook-plan, cook-schedule and cook-view tests so the expected sequences and
 * lane times trace back to one plan.
 *
 * Mise minutes sum to 6 (first-mode prep block 0–6) and the three sauté mise
 * tasks to 5 (the as-I-go card at 0–5), matching the mockup's lanes.
 */

import {
  COOK_PLAN_VERSION,
  type CookPlan,
  type CookTask,
  type RecipeForPlan,
} from "../cook-plan";

export const ZUCCHINI_RECIPE: RecipeForPlan = {
  ingredients: [
    { amount: "2", item: "zucchini" },
    { amount: "1", item: "onion bulb" },
    { amount: "1", item: "garlic scape" },
    { amount: "a pinch of", item: "cumin or curry powder" },
    { amount: "a handful of", item: "onion greens" },
    { item: "frozen parathas" },
    { item: "chili oil or Calabrian chile" },
  ],
  steps: [
    "Sauté the onion, garlic scape and zucchini with a pinch of cumin until sweet and caramelized, about 15 minutes.",
    "Stir in the onion greens at the very end.",
    "Fry the parathas in a dry skillet until crisp and flaky.",
    "Stuff the hot wrappers with the spiced zucchini.",
    "Add a drizzle of chili oil or Calabrian chile for anyone who wants heat.",
  ],
};

function task(t: Partial<CookTask> & Pick<CookTask, "id" | "kind">): CookTask {
  return {
    text: t.id,
    label: t.id,
    ingredientIdx: [],
    sourceStep: null,
    implied: t.sourceStep == null,
    needs: [],
    branch: "Filling",
    ...t,
  };
}

export const ZUCCHINI_TASKS: CookTask[] = [
  task({
    id: "onion",
    kind: "mise",
    text: "Slice the onion bulb",
    label: "slice onion",
    ingredientIdx: [1],
    minutes: { est: 2, handsOff: false },
  }),
  task({
    id: "scape",
    kind: "mise",
    text: "Mince the garlic scape",
    label: "mince scape",
    ingredientIdx: [2],
    minutes: { est: 1, handsOff: false },
  }),
  task({
    id: "zuc",
    kind: "mise",
    text: "Cut the zucchini into thin matchsticks",
    label: "cut zucchini",
    ingredientIdx: [0],
    minutes: { est: 2, handsOff: false },
  }),
  task({
    id: "greens",
    kind: "mise",
    text: "Chop the onion greens",
    label: "chop greens",
    ingredientIdx: [4],
    minutes: { est: 1, handsOff: false },
  }),
  task({
    id: "saute",
    kind: "cook",
    text: "Sauté the onion, garlic scape and zucchini with a pinch of cumin until sweet and caramelized, about 15 minutes.",
    label: "sauté",
    ingredientIdx: [0, 1, 2, 3],
    sourceStep: 0,
    implied: false,
    needs: ["onion", "scape", "zuc"],
    minutes: { est: 15, handsOff: true },
    cue: "until sweet and caramelized",
  }),
  task({
    id: "stir",
    kind: "cook",
    text: "Stir in the onion greens at the very end.",
    label: "stir in greens",
    ingredientIdx: [4],
    sourceStep: 1,
    implied: false,
    needs: ["saute", "greens"],
    minutes: { est: 1, handsOff: false },
  }),
  task({
    id: "fry",
    kind: "cook",
    text: "Fry the parathas in a dry skillet until crisp and flaky.",
    label: "fry parathas",
    ingredientIdx: [5],
    sourceStep: 2,
    implied: false,
    minutes: { est: 8, handsOff: false },
    cue: "until crisp and flaky",
    branch: "Wrappers",
  }),
  task({
    id: "stuff",
    kind: "cook",
    text: "Stuff the hot wrappers with the spiced zucchini.",
    label: "stuff wraps",
    sourceStep: 3,
    implied: false,
    needs: ["stir", "fry"],
    minutes: { est: 3, handsOff: false },
    branch: "Assemble",
  }),
  task({
    id: "chili",
    kind: "cook",
    text: "Add a drizzle of chili oil or Calabrian chile for anyone who wants heat.",
    label: "add chili oil",
    ingredientIdx: [6],
    sourceStep: 4,
    implied: false,
    needs: ["stuff"],
    minutes: { est: 1, handsOff: false },
    branch: "Assemble",
  }),
];

export const ZUCCHINI_PLAN: CookPlan = {
  version: COOK_PLAN_VERSION,
  tasks: ZUCCHINI_TASKS,
};

/** The plan as the LLM returns it: no version, nulls for absent fields. */
export function zucchiniRaw(): { tasks: Record<string, unknown>[] } {
  return {
    tasks: ZUCCHINI_TASKS.map((t) => ({
      ...t,
      minutes: t.minutes ?? null,
      cue: t.cue ?? null,
      lead: t.lead ?? null,
    })),
  };
}
