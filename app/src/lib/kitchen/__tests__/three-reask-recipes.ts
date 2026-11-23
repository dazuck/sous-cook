/**
 * Three multi-rule recipe fixtures built by hand in the malformed shapes a
 * model can return, used to test validator recovery when a re-ask fixes only
 * the first named rule and subsequent checks catch the rest:
 *
 * - Dan dan noodles: grinding toasted peppercorns tagged mise
 *   (`mise-needs-cook`), with a sauce made ahead that needs the grind
 *   (`ahead-needs-later`). `danDanUncoveredRaw()` also leaves the noodle boil
 *   uncited (`uncovered-step`).
 * - Chicken wings: a 1-4 hour marinade needing two prep tasks still tagged
 *   mise (`ahead-needs-later` twice).
 * - Onion torta: an overnight cool needing a cook bake (`ahead-needs-later`),
 *   and task durations written as leads ("chill 1 h", "freeze 30 min"), so
 *   the overnight cool needs work with shorter leads (`lead-order` twice:
 *   the line-tin directly, the mix-dough behind it).
 *
 * Each `...FixedRaw()` is a plan the rules ask for, and passes. Dan dan has
 * two, one per legal fix of its chain.
 */

import type { RecipeForPlan } from "../cook-plan";

type Kind = "ahead" | "mise" | "cook";

interface Task {
  id: string;
  kind: Kind;
  text: string;
  label: string;
  ingredientIdx: number[];
  sourceStep: number | null;
  implied: boolean;
  needs: string[];
  minutes: { est: number; handsOff: boolean } | null;
  cue: string | null;
  lead: string | null;
  branch: string;
}

function task(
  id: string,
  kind: Kind,
  sourceStep: number,
  text: string,
  needs: string[],
  branch: string,
  lead: string | null = null,
): Task {
  return {
    id,
    kind,
    text,
    label: id.replace(/-/g, " "),
    ingredientIdx: [],
    sourceStep,
    implied: false,
    needs,
    minutes: null,
    cue: null,
    lead,
    branch,
  };
}

export const DAN_DAN_RECIPE: RecipeForPlan = {
  ingredients: [
    { item: "Szechuan peppercorns" },
    { item: "chili oil" },
    { item: "soy sauce" },
    { item: "sesame paste" },
    { item: "noodles" },
    { item: "ground pork" },
  ],
  steps: [
    "Toast the Szechuan peppercorns in a dry pan until fragrant.",
    "Grind the toasted peppercorns to a fine powder.",
    "Stir the ground peppercorns into the chili oil, soy sauce and sesame paste.",
    "Boil the noodles until just tender.",
    "Toss the noodles with the sauce and top with the pork.",
  ],
};

function danDan(grind: Kind, sauce: Kind, boil = true): { tasks: Task[] } {
  const tasks = [
    task("toast-szechuan-peppercorns", "cook", 0, "Toast the Szechuan peppercorns in a dry pan until fragrant.", [], "Sauce"),
    task("grind-szechuan-peppercorns", grind, 1, "Grind the toasted peppercorns to a fine powder.", ["toast-szechuan-peppercorns"], "Sauce"),
    task(
      "mix-sauce",
      sauce,
      2,
      "Stir the ground peppercorns into the chili oil, soy sauce and sesame paste.",
      ["grind-szechuan-peppercorns"],
      "Sauce",
      sauce === "ahead" ? "the day before" : null,
    ),
    task("boil-noodles", "cook", 3, "Boil the noodles until just tender.", [], "Noodles"),
    task("toss", "cook", 4, "Toss the noodles with the sauce and top with the pork.", boil ? ["boil-noodles", "mix-sauce"] : ["mix-sauce"], "Noodles"),
  ];
  return { tasks: boil ? tasks : tasks.filter((t) => t.id !== "boil-noodles") };
}

/** Grind tagged mise after a cook toast, and an ahead sauce needing the grind. */
export const danDanRaw = () => danDan("mise", "ahead");
/**
 * The sauce tagged mise as well: the validator can name only the grind, so a
 * fix that retags just the grind fails next on the sauce that needs it.
 */
export const danDanMiseSauceRaw = () => danDan("mise", "mise");
/** Call 1's shape: the noodle boil uncited, and the grind still mise. */
export const danDanUncoveredRaw = () => danDan("mise", "mise", false);
/**
 * The sauce really happens during the cook, so it is cook, and so is the
 * grind, which is work done to the peppercorns after they were heated.
 */
export const danDanFixedRaw = () => danDan("cook", "cook");
/**
 * The other legal fix: the sauce really is made the day before, so the grind
 * that feeds it and the toast upstream of that are made the day before too.
 */
export function danDanAheadFixedRaw(): { tasks: Task[] } {
  const raw = danDan("ahead", "ahead");
  for (const t of raw.tasks) {
    if (t.branch !== "Sauce") continue;
    t.kind = "ahead";
    t.lead = "the day before";
  }
  return raw;
}

export const WINGS_RECIPE: RecipeForPlan = {
  ingredients: [
    { item: "chicken wings" },
    { item: "ginger" },
    { item: "garlic" },
    { item: "dried methi" },
    { item: "yogurt" },
  ],
  steps: [
    "Trim the wing tips and pat the wings dry.",
    "Mince the ginger and garlic.",
    "Toss the wings with the ginger, garlic, methi and yogurt and marinate for 1 to 4 hours.",
    "Roast the wings at 220°C until charred.",
  ],
};

const MARINADE_LEAD = "1 to 4 hours before";

function wings(prep: Kind): { tasks: Task[] } {
  const lead = prep === "ahead" ? MARINADE_LEAD : null;
  return {
    tasks: [
      task("trim-wings", prep, 0, "Trim the wing tips.", [], "Wings", lead),
      task("pat-wings-dry", prep, 0, "Pat the wings dry.", ["trim-wings"], "Wings", lead),
      task("mince-ginger", prep, 1, "Mince the ginger and garlic.", [], "Wings", lead),
      task(
        "marinate",
        "ahead",
        2,
        "Toss the wings with the ginger, garlic, methi and yogurt and marinate for 1 to 4 hours.",
        ["pat-wings-dry", "mince-ginger"],
        "Wings",
        MARINADE_LEAD,
      ),
      task("roast", "cook", 3, "Roast the wings at 220°C until charred.", ["marinate"], "Wings"),
    ],
  };
}

/** A 1-4 hour marinade needing two prep tasks still tagged mise. */
export const wingsRaw = () => wings("mise");
/** The marinade's prep, and everything upstream of it, made ahead too, with the marinade's own lead. */
export const wingsFixedRaw = () => wings("ahead");

export const TORTA_RECIPE: RecipeForPlan = {
  ingredients: [
    { item: "flour" },
    { item: "butter" },
    { item: "onions" },
    { item: "eggs" },
  ],
  steps: [
    "Mix the dough and chill it for 1 hour.",
    "Roll out the dough, line the tin and freeze it for 30 minutes.",
    "Blind bake the crust, then remove the weights and bake until golden.",
    "Let the crust cool completely, overnight if you can.",
    "Cook the onions slowly until jammy.",
    "Fill the crust with the onions and eggs and bake until set.",
  ],
};

/** Call 1's shape: durations as leads, and the crust bakes left on the day. */
export function tortaRaw(): { tasks: Task[] } {
  return {
    tasks: [
      task("mix-dough", "ahead", 0, "Mix the dough and chill it for 1 hour.", [], "Crust", "chill 1 h"),
      task("line-tin", "ahead", 1, "Roll out the dough, line the tin and freeze it for 30 minutes.", ["mix-dough"], "Crust", "freeze 30 min"),
      task("blind-bake-crust", "cook", 2, "Blind bake the crust.", ["line-tin"], "Crust"),
      task("finish-bake-crust", "cook", 2, "Remove the weights and bake until golden.", ["blind-bake-crust"], "Crust"),
      task("cool-crust", "ahead", 3, "Let the crust cool completely.", ["finish-bake-crust"], "Crust", "overnight"),
      task("cook-onions", "cook", 4, "Cook the onions slowly until jammy.", [], "Filling"),
      task("fill-and-bake", "cook", 5, "Fill the crust with the onions and eggs and bake until set.", ["cool-crust", "cook-onions"], "Torta"),
    ],
  };
}

/** The crust made the day before, every lead counted back from the cook. */
export function tortaFixedRaw(): { tasks: Task[] } {
  const raw = tortaRaw();
  for (const t of raw.tasks) {
    if (t.branch !== "Crust") continue;
    t.kind = "ahead";
    t.lead = "the day before";
  }
  return raw;
}
