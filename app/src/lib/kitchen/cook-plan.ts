/**
 * Cook plan: the derived task graph the cook view schedules and renders.
 *
 * A plan sits beside a queued recipe and never rewrites it. Each task is one
 * thing the cook does, tagged by kind:
 *
 *   - ahead: needs doing hours or a day before the cook (soak, marinate, chill)
 *   - mise:  transforms an ingredient before it is combined or heated
 *   - cook:  everything at the stove or bench once cooking starts
 *
 * Tasks cite the source step they came from (`sourceStep`), or are `implied`
 * when the recipe assumed them ("the diced onion" with no dicing step). The
 * LLM extracts tasks; ordering them is the scheduler's job (`cook-schedule.ts`),
 * so a mid-cook mode switch reschedules offline and instantly.
 *
 * Validation is strict and rejects whole plans: a dropped step or temperature
 * is a silent cooking failure, so a plan that loses one is worse than no plan.
 * The cook view falls back to `identityPlan` (the recipe as written). Two
 * things are normalized rather than rejected: out-of-range ingredient indices
 * are dropped, and a hands-off estimate under `MIN_HANDS_OFF_MINUTES` becomes
 * hands-on, since no prep fits in it.
 *
 * Design: the repo's `design/cook-lookahead-brief.md`.
 */

import { z } from "zod";
import type { ChatRecipeIngredient } from "../../../drizzle/schema";
import {
  ingredientToString,
  resolveStepIngredientIndices,
} from "./step-ingredients";

/**
 * Bump when the task shape, the derivation prompt or validation changes; stale
 * plans re-derive, so a plan passed by weaker checks is checked again. Not
 * bumped for `lead-order` (2026-10-04), nor for reading a lead said in parts
 * as one wait (2026-10-06): re-deriving every stored plan is paid and can
 * change a plan under a cook, and the cook view reads a plan with mixed lead
 * anchors in its needs order, so those plans stay right as stored.
 */
export const COOK_PLAN_VERSION = 4;

/** A hands-off stretch shorter than this leaves no room to do anything else. */
export const MIN_HANDS_OFF_MINUTES = 5;

export type CookTaskKind = "ahead" | "mise" | "cook";
export type PrepMode = "first" | "go";

export interface CookTask {
  id: string;
  kind: CookTaskKind;
  /** What the cook does, in the recipe's words where it has them. */
  text: string;
  /**
   * 1–3 lowercase words in the imperative ("fry parathas", "add chili oil"),
   * for lane segments and "before you {label}".
   */
  label: string;
  ingredientIdx: number[];
  /** Index into the recipe's steps, or null when the task is implied. */
  sourceStep: number | null;
  implied: boolean;
  /** Ids of tasks that must finish before this one starts. */
  needs: string[];
  minutes?: { est: number; handsOff: boolean };
  /** The doneness cue, e.g. "until crisp and flaky". */
  cue?: string;
  /**
   * How far ahead, e.g. "overnight" or "at least 4 hours", always counted
   * back from the start of the cook, never from the task that uses it: what
   * an ahead task needs has a lead at least as long (`lead-order`). Plans
   * stored before that rule may still mix anchors; the cook view orders them
   * by their needs (DECISIONS 2026-10-04, make-ahead lead order).
   */
  lead?: string;
  /** The component this task builds, e.g. "Filling" or "Wrappers". */
  branch: string;
}

export interface CookPlan {
  version: number;
  tasks: CookTask[];
}

export type RecipeForPlan = {
  ingredients?: ChatRecipeIngredient[];
  steps?: string[];
  stepIngredients?: number[][];
};

export type CookPlanRule =
  | "shape"
  | "bad-character"
  | "duplicate-id"
  | "dangling-need"
  | "cycle"
  | "bad-source-step"
  | "implied-mismatch"
  | "invented-cook"
  | "uncovered-step"
  | "dropped-number"
  | "ingredient-outside-step"
  | "mise-needs-cook"
  | "ahead-needs-later"
  | "lead-order"
  | "no-cook-task"
  | "unused-task"
  | "disconnected-task"
  | "branch-ends-twice";

/**
 * One broken rule and why. An `uncovered-step` violation also lists every
 * step no task cites, so the re-ask can quote them all: a model told only the
 * first fixes one per call (peanut chutney, R31: 18 uncited).
 */
export interface CookPlanViolation {
  rule: CookPlanRule;
  detail: string;
  uncoveredSteps?: number[];
}

/**
 * A rejection names the first rule broken and says why (`rule`, `detail`,
 * and `uncoveredSteps` when that rule is `uncovered-step`): that is what is
 * stored and logged. `violations` lists every rule broken, the first one
 * first, so the re-ask can name them all: told only the first, the model
 * fixed it and failed the next call on a second it was never told about (R31:
 * 3 of 39 library plans). A structural failure is its own only violation.
 */
export type CookPlanParseResult =
  | { ok: true; plan: CookPlan }
  | ({ ok: false; violations: CookPlanViolation[] } & CookPlanViolation);

const nonEmpty = z.string().trim().min(1);

const RawTaskSchema = z.object({
  id: nonEmpty,
  kind: z.enum(["ahead", "mise", "cook"]),
  text: nonEmpty,
  label: nonEmpty,
  ingredientIdx: z.array(z.number()),
  sourceStep: z.number().int().nullable(),
  implied: z.boolean(),
  needs: z.array(nonEmpty),
  // The prompt asks for at most a day; a longer ahead task (a two-day brine)
  // is taken rather than losing the whole plan to it.
  minutes: z
    .object({ est: z.number().positive().max(10080), handsOff: z.boolean() })
    .nullish(),
  cue: z.string().nullish(),
  lead: z.string().nullish(),
  branch: nonEmpty,
});

/** The shape the derivation LLM returns (no version; nulls for absent fields). */
export const RawCookPlanSchema = z.object({
  tasks: z.array(RawTaskSchema).min(1),
});

type RawTask = z.infer<typeof RawTaskSchema>;

function reject(rule: CookPlanRule, detail: string): CookPlanParseResult {
  return rejectAll([{ rule, detail }]);
}

/**
 * A rejection naming the first of `violations` (never empty). Identical lines
 * (a task that lists the same need twice) are kept once, first one first.
 */
function rejectAll(violations: CookPlanViolation[]): CookPlanParseResult {
  const seen = new Set<string>();
  const unique = violations.filter((v) => {
    const key = `${v.rule}\n${v.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ok: false, ...unique[0], violations: unique };
}

function sanitizeIngredientIdx(indices: number[], count: number): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const i of indices) {
    if (Number.isInteger(i) && i >= 0 && i < count && !seen.has(i)) {
      seen.add(i);
      result.push(i);
    }
  }
  return result;
}

function normalizeTask(raw: RawTask, ingredientCount: number): CookTask {
  const task: CookTask = {
    id: raw.id,
    kind: raw.kind,
    text: raw.text,
    label: raw.label,
    ingredientIdx: sanitizeIngredientIdx(raw.ingredientIdx, ingredientCount),
    sourceStep: raw.sourceStep,
    implied: raw.implied,
    needs: raw.needs,
    branch: raw.branch,
  };
  if (raw.minutes) {
    const { est, handsOff } = raw.minutes;
    task.minutes = { est, handsOff: handsOff && est >= MIN_HANDS_OFF_MINUTES };
  }
  const cue = raw.cue?.trim();
  if (cue) task.cue = cue;
  const lead = raw.lead?.trim();
  if (lead) task.lead = lead;
  return task;
}

/** Returns the ids of one cycle if the needs graph has any. */
function findCycle(tasks: CookTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  function visit(id: string): string[] | null {
    const s = state.get(id);
    if (s === "done") return null;
    if (s === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const need of byId.get(id)!.needs) {
      const cycle = visit(need);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return null;
  }

  for (const t of tasks) {
    const cycle = visit(t.id);
    if (cycle) return cycle;
  }
  return null;
}

const UNICODE_FRACTIONS: Record<string, string> = {
  "½": "1/2",
  "⅓": "1/3",
  "⅔": "2/3",
  "¼": "1/4",
  "¾": "3/4",
  "⅕": "1/5",
  "⅖": "2/5",
  "⅗": "3/5",
  "⅘": "4/5",
  "⅙": "1/6",
  "⅚": "5/6",
  "⅐": "1/7",
  "⅛": "1/8",
  "⅜": "3/8",
  "⅝": "5/8",
  "⅞": "7/8",
  "⅑": "1/9",
  "⅒": "1/10",
};

const UNICODE_FRACTION_RE = new RegExp(
  `[${Object.keys(UNICODE_FRACTIONS).join("")}]`,
  "g",
);

/**
 * Integers, decimals, fractions and mixed numbers ("1 1/2"), and a decimal
 * with no leading zero (".5") unless it follows a word ("Serve.5 minutes").
 */
const NUMBER_RE =
  /(\d+)\s+(\d+)\/(\d+)|(\d+)\/(\d+)|\d+(?:\.\d+)?|(?<![\w.])\.\d+/g;

const SMALL_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = [
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

/** "five", "twenty", "twenty-five", "twenty five". Not "half". */
const WORD_NUMBER_RE = new RegExp(
  `\\b(?:(${TENS.join("|")})(?:[-\\s](${SMALL_NUMBERS.slice(1, 10).join("|")}))?` +
    `|(${SMALL_NUMBERS.join("|")}))\\b`,
  "gi",
);

const ONES = SMALL_NUMBERS.slice(1, 10).join("|");

/** "5", "five", "twenty-five", "twenty five". */
const COUNT_WORDS = `\\d+|(?:${TENS.join("|")})(?:[-\\s](?:${ONES}))?|${SMALL_NUMBERS.join("|")}`;
const COUNT = `(${COUNT_WORDS})`;

/** A count as `COUNT` or `WORD_NUMBER_RE` matched it: "7", "seven", "twenty-one". */
function countValue(count: string): number {
  if (/^\d+$/.test(count)) return Number(count);
  const [first, second] = count.toLowerCase().split(/[-\s]/);
  const tens = TENS.indexOf(first);
  if (tens === -1) return SMALL_NUMBERS.indexOf(first);
  return (tens + 2) * 10 + (second ? SMALL_NUMBERS.indexOf(second) : 0);
}

const DENOMINATORS: Record<string, number> = {
  half: 2, halves: 2, third: 3, thirds: 3, quarter: 4, quarters: 4,
  fourth: 4, fourths: 4, fifth: 5, fifths: 5, sixth: 6, sixths: 6,
  eighth: 8, eighths: 8,
};
const DENOMINATOR = `(${Object.keys(DENOMINATORS).join("|")})`;
/** "a half", "one-quarter", "a third": the part after "and". */
const AND_A_PART = `(?:a|one)[-\\s]+(half|quarter|third)`;

/** A number and "of" ending the text: "0.5 of ", "1/2 of ". */
const NUMBER_BEFORE_OF_RE = /\d\s*of\s+$/i;

/** Not inside a number: "1/4 and 1/2" is two numbers, not "4 and 1/2". */
const NOT_IN_NUMBER = "(?<!\\d|\\d[/.,])";

/**
 * Measures said with "a", "an" or "another" and no number (see
 * `WORD_NUMBERS`). One list, so every measure an article can take can also
 * take "and a half": "a tsp and a half" is 1.5 teaspoons, never 1.
 */
const ARTICLE_MEASURES =
  "hours?|hrs?|minutes?|mins?|cups?|tablespoons?|tbsps?|teaspoons?|tsps?|" +
  "pounds?|lbs?|ounces?|oz|inch(?:es)?|quarts?|qts?|pints?|pts?|" +
  "lit(?:er|re)s?|gallons?|gal|kg|kilos?|kilograms?|grams?|tbs|dozen|" +
  "cm|centimet(?:er|re)s?|mm|millimet(?:er|re)s?|ml|millilit(?:er|re)s?";
const ARTICLE_MEASURE_WORD = `(${ARTICLE_MEASURES})`;

/** Words for the measures a whole number and a half can come in. */
const MEASURE_WORD = `(${ARTICLE_MEASURES}|days?|weeks?)`;

/** Measures written short, which can end in a period. */
const ABBREVIATIONS = "hrs?|mins?|tbsps?|tbs|tsps?|lbs?|oz|qts?|pts?|gal|kg|cm|mm|ml";

/** The period an abbreviated measure can carry: "a tbsp. and a half". */
const ABBREVIATION_PERIOD = `(?:(?<=\\b(?:${ABBREVIATIONS}))\\.)?`;

const DIVIDE_VERB =
  "(?:(?:then|first|now|next|also|just|very|[a-z]+ly)\\s+){0,2}" +
  "(?:cut(?:ting)?|slic(?:e|ing)|split(?:ting)?|fold(?:ing)?|tear(?:ing)?|" +
  "break(?:ing)?|divid(?:e|ing)|snap(?:ping)?)\\s+";
/**
 * A word of what is cut; "and", "then" or "or" ends it, and so does "to" or
 * "into" (what the cut is for, or makes). A bracket or a dash doesn't: "the
 * zucchini (or squash)" is cut the long way. An aside closed before the half
 * ("the pears (cut them in half) in half the wine") can run on into what is
 * cut, harmlessly: only a way of cutting after the half (`DIVIDED_HOW_RE`)
 * makes it a cut.
 */
const DIVIDED_WORD = "(?!(?:and|then|or|to|into)\\b)[^\\s.;:!?,]+";
/**
 * The first word of what is cut, said bare: not an adverb, "very" or a word
 * ending in "-ly" ("fold very gently in half the same way", though "cut
 * belly" is lost with them), nor "side" ("cut side down") or "peas" ("snap
 * peas").
 */
const BARE_DIVIDED_WORD = `(?!(?:very|[a-z]+ly|sides?|peas)\\b)${DIVIDED_WORD}`;

/**
 * The cook told to cut, fold or tear something in half, just before the
 * "half": "cut the zucchini in half the long way", "then carefully fold it in
 * half a second time", "start by cutting the loaf in half". Only after one
 * can the words after the half say how it is cut (`DIVIDED_HOW_RE`);
 * anywhere else "in half the same way" is a part, done the same way. The verb
 * is an instruction, opening its clause past any adverbs, and names what it
 * cuts. Where the clause surely starts (a sentence, a colon or semicolon, a
 * new line, "then", "to", "by"), what is cut can be bare: "cut avocados in
 * half the long way". Any period ends a sentence here, even one ending a
 * measure ("toss 1 lb. cut beans in half the butter"), since what follows
 * still needs a way of cutting to be one. After a comma, "and", "or", a bracket or a dash the
 * verb can be a noun's ("the onion and split peas") or open an aside ("the
 * chicken (cut into strips)"), so what is cut must start with a word like
 * "the", "each" or "it". Nothing is cut in "fold in half" or "fold gently in
 * half" (no object), nor in "slice the onion and stir in half" ("and" ends
 * what was cut).
 */
const DIVIDED_IN_RE = new RegExp(
  "(?:" +
    `(?:^|[.!?;:\\n]\\s*|\\b(?:then|to|by)\\s+)${DIVIDE_VERB}` +
    `${BARE_DIVIDED_WORD}(?:\\s+${DIVIDED_WORD}){0,3}` +
    "|" +
    `(?:[,(\u2014\u2013]\\s*|\\b(?:and|or)\\s+)${DIVIDE_VERB}` +
    `(?:the|an?|each|every|both|all|them|it|this|that|these|those|your|its|their|any|some|${COUNT_WORDS})\\b` +
    `(?:\\s+${DIVIDED_WORD}){0,3}` +
    ")\\s+in\\s+$",
  "i",
);

/**
 * What says how a thing is cut, right after the part: "in half the long way",
 * "in half this way", "in half the way you would a bagel", "in half the other
 * direction", "in half a second time". Only these words, and only here:
 * "in half the batter this way" is a part of the batter, and "in half the
 * day before" a part of something too (a false reading, but a safe one).
 */
const DIVIDED_HOW_RE =
  /^\s+(?:(?:the|this|that)\s+(?:(?:long|short|same|other|opposite|usual)\s+)?(?:way|direction)|(?:second|third|fourth|last|final)\s+time)\b/i;

/**
 * What follows a fraction that is a part of something rather than a size:
 * "half the sauce", "a third of the whites", "one half of it".
 */
const PART_OF_RE =
  /^\s+(?:of\s+)?(?:the|an?|your|this|that|these|those|its|their|each|it|them)\b/i;

/**
 * What can follow a share but not a count of things: the clause's end,
 * "full", or a word that names no thing ("reserve a third for serving", "keep
 * one third back", "reduce by two thirds, then"). Any other word is taken for
 * the thing counted: "a third egg", "a third time", "three quarters lemon".
 */
const NO_THING_AFTER_RE = new RegExp(
  "^(?:\\s*(?:$|[.,;:!?)\\]\u2014\u2013])|[-\\s]+full\\b|\\s+(?:" +
    "and|or|then|but|so|as|if|while|until|before|after|" +
    "of|in|into|on|onto|over|at|to|for|from|with|by|under|through|" +
    "back|aside|away|off|out|up|down|more|less|now|later|again|each|too" +
    ")\\b)",
  "i",
);

/** The cream, not a share: "half-and-half", "half & half". */
const HALF_AND_HALF_RE = /^[-\s]*(?:and|&)[-\s]*half\b/i;
const AFTER_HALF_AND_RE = /\bhalf[-\s]*(?:and|&)[-\s]*$/i;

/** "In half" or "into half": how a thing is cut ("cut the lemon in half", "fold in half", "slice into half-moons"). */
const IN_HALF_RE = /\bin(?:to)?\s+$/i;

/**
 * A verb that adds something, opening "in half": "stir in half", "pour in
 * half, then the rest" add a share. "Fold" is left out: "fold in half" is
 * more often a tortilla folded than half the whites folded in.
 */
const ADDED_IN_RE = new RegExp(
  "\\b(?:stir(?:s|red|ring)?|whisk(?:s|ed|ing)?|mix(?:es|ed|ing)?|beat(?:s|ing)?|" +
    "add(?:s|ed|ing)?|pour(?:s|ed|ing)?|drizzl(?:e|es|ed|ing)|swirl(?:s|ed|ing)?|" +
    "work(?:s|ed|ing)?|blend(?:s|ed|ing)?|toss(?:es|ed|ing)?|knead(?:s|ed|ing)?|" +
    "sprinkl(?:e|es|ed|ing)|spoon(?:s|ed|ing)?|ladl(?:e|es|ed|ing)|" +
    "scatter(?:s|ed|ing)?|incorporat(?:e|es|ed|ing)|squeez(?:e|es|ed|ing)|" +
    "tip(?:s|ped|ping)?|throw(?:s|n|ing)?|threw|crumbl(?:e|es|ed|ing)|" +
    "grat(?:e|es|ed|ing)|drop(?:s|ped|ping)?)" +
    "\\s+(?:[a-z]+ly\\s+)?in\\s+$",
  "i",
);

/**
 * A liquid cooked down, just before "in half": "simmer until reduced in
 * half", "reduce the vinegar in half", "boil the stock down in half". Half of
 * it is left, a share, as in "reduced by half"; a liquid is not cut. What is
 * reduced runs as what is cut does (`DIVIDED_WORD`), so "reduce the heat and
 * cut the lemon in half" is still a cut.
 */
const REDUCED_IN_RE = new RegExp(
  "\\b(?:reduc(?:e|es|ed|ing)(?:\\s+" + DIVIDED_WORD + "){0,4}|" +
    "(?:boil|cook|simmer)(?:s|ed|ing)?(?:\\s+" + DIVIDED_WORD + "){0,4}\\s+down)" +
    "\\s+in(?:to)?\\s+$",
  "i",
);

/** Parts said as ordinals: with "a" or "an" a share, bare an ordinal ("the third hour"). */
const ORDINAL_PARTS = new Set(["third", "fourth", "fifth", "sixth", "eighth"]);

/** A piece, not a share: "scoop the seeds from each half". */
const PIECE_BEFORE_RE = /\b(?:each|either)\s+$/i;

/**
 * Words that can sit between a number and its unit: "5 more minutes", "2
 * heaping tablespoons", "2 lightly packed cups", "20-odd minutes", "5 or so
 * minutes". Up to two, and only these: any other word ends the search, so "2
 * large eggs" stays a bare 2.
 */
const UNIT_MODIFIER =
  "(?:more|additional|extra|further|heap(?:ing|ed)|level(?:l?ed)?|rounded|" +
  "scant|generous|good|full|whole|packed|lightly|loosely|firmly|tightly|well|" +
  "odd|or\\s+so|US|metric|imperial)";
const UNIT_MODIFIERS = `(?:${UNIT_MODIFIER}(?:\\s+|\\s*-\\s*)){0,2}`;
const UNIT_MODIFIERS_RE = new RegExp(`^${UNIT_MODIFIERS}`, "i");

/**
 * Rewrites one kind of number phrase. Gets the capture groups, the text after
 * the match (to see whether a unit follows), the match itself, which it
 * returns unchanged to leave the phrase alone, and the text before it.
 */
type WordRule = [
  RegExp,
  (
    groups: (string | undefined)[],
    rest: string,
    match: string,
    before: string,
  ) => string,
];

/**
 * Numbers said in words that the digit and word readers would split or miss,
 * rewritten as digits (a fraction as a decimal, so a count before it stays
 * its own number), in this order so the longer phrase wins:
 * 1. a measure and a part: "an hour and a half", "another cup and a half", "a
 *    good hour and a half", "a tbsp. and a half", "a dozen-and-a-half", "2
 *    minutes and one-half" ("1.5 hour"), unless a unit follows, as in "1 cup
 *    and a half teaspoon";
 * 2. a fraction with a count, "three-quarters cup", "two thirds of a cup"
 *    ("0.75"), when it is less than one and a unit follows or it is
 *    hyphenated ("two-thirds full"). Not "two halves" (two pieces), not "3
 *    quarter-inch slices" or "two quarter-pound patties" (a count of things
 *    that size). Spaced words with no unit are a share when "one" leads
 *    ("keep one third back", "one half onion"), when a part of something
 *    follows ("three quarters of the stock"), or when nothing a count could
 *    count does ("three quarters full", "reduce by two thirds, then"), else
 *    not ("two thirds eggs");
 * 3. a whole number and a part, "two and a half", "twenty-one and 1/2",
 *    "two and three-quarters" ("2.75");
 * 4. "halfway" and "half-way" ("0.5"): how far to fill or cook, a share;
 * 5. a part on its own ("0.5", with the unit when one follows: "half a cup",
 *    "a quarter-inch", "half-an-hour", "a third of a cup", "an eighth
 *    teaspoon", "half a dozen").
 *    "Half" is a share by default, since a dropped share is a silent cooking
 *    failure and a rejected plan only costs the as-written view: "reduced by
 *    half", "a half stick", "pour half into the pan", "half full", "serve
 *    half now". It is not one as the dairy ("half-and-half"), as a piece
 *    ("each half"), or as a cut: "in half" or "into half" ("cut the lemon in
 *    half", "fold in half", "slice into half-moons"), unless a verb that adds
 *    opens it ("stir in half, then the rest"), a liquid is cooked down to it
 *    ("reduce the vinegar in half") or a part of something follows ("cut
 *    cold butter in half the flour"). A part stays a part after a cut:
 *    only a way of cutting said right after it (`DIVIDED_HOW_RE`), once the
 *    cook was told to cut something (`DIVIDED_IN_RE`), makes it how the
 *    thing is cut, as in "cut the zucchini in half the long way". "A
 *    quarter" is always a share ("a quarter onion", "a quarter turn"), but
 *    bare "quarter" is a verb ("quarter the onions") unless a unit follows.
 *    "A third" is a share when nothing a count could count follows
 *    ("reduce by a third", "reserve a third for serving"), not in "a third
 *    egg" or "a third time", and bare "third" is always an ordinal; so are
 *    "a fourth", "a fifth", "a sixth" and "an eighth";
 * 6. the article between a fraction and its measure: "½ an hour", "1/2 a
 *    teaspoon" and "one-half an hour" (by now "0.5 an hour") are "½ hour",
 *    "1/2 teaspoon" and "0.5 hour", not a half and then an hour;
 * 7. a measure with no number, "an hour", "a tablespoon", "another minute",
 *    "a heaping teaspoon", "a dozen" ("1 hour"), and "a minute or two" ("1 to
 *    2 minute"), but not "of an hour", which belongs to the number before it
 *    or is a part of something ("the rest of a cup"). A dozen counts the
 *    things themselves, so "the yolks of a dozen eggs" is twelve, while "half
 *    of a dozen" is still six;
 * 8. how many times a thing grows: "doubled", "doubles", "twice", "double in
 *    size" ("2"), "tripled", "thrice" ("3"), since "let rise until doubled"
 *    is the cue the rise waits on. Not "double" or "triple" alone: "double
 *    cream", "a double boiler" and "triple sec" are things.
 * Seconds, days and weeks are left alone in 7: "wait a second" and "a day
 * ahead" are rarely quantities. A dozen is a unit (`UNITS`), so "½ dozen",
 * "two dozen" and "a dozen and a half" all count eggs by twelves.
 */
const WORD_NUMBERS: WordRule[] = [
  [
    new RegExp(
      `${NOT_IN_NUMBER}\\b(an?|another|${COUNT_WORDS})\\s+${UNIT_MODIFIERS}${MEASURE_WORD}` +
        `${ABBREVIATION_PERIOD}[-\\s]+and[-\\s]+${AND_A_PART}\\b`,
      "gi",
    ),
    ([whole, unit, part], rest, match) =>
      unitAfter(rest)
        ? match
        : `${(/^(?:an?|another)$/i.test(whole!) ? 1 : countValue(whole!)) + 1 / DENOMINATORS[part!.toLowerCase()]} ${unit}`,
  ],
  [
    new RegExp(`${NOT_IN_NUMBER}\\b${COUNT}(-|\\s+)${DENOMINATOR}\\b`, "gi"),
    ([count, gap, fraction], rest, match) => {
      const n = countValue(count!);
      const d = DENOMINATORS[fraction!.toLowerCase()];
      const spaced = gap !== "-";
      const inWords = !/^\d+$/.test(count!);
      if (!(n > 0 && n < d)) return match;
      if (spaced && (!inWords || /^-/.test(rest))) return match;
      const share =
        unitAfter(rest) !== null ||
        PART_OF_RE.test(rest) ||
        (inWords && (!spaced || n === 1 || NO_THING_AFTER_RE.test(rest)));
      return share ? `${n / d}` : match;
    },
  ],
  [
    new RegExp(
      `${NOT_IN_NUMBER}\\b${COUNT}[-\\s]+and[-\\s]+(?:${AND_A_PART}|(\\d+)/(\\d+)|(0?\\.\\d+))\\b`,
      "gi",
    ),
    ([count, part, num, den, decimal], _rest, match) => {
      if (den !== undefined && Number(den) === 0) return match;
      const fraction = part
        ? 1 / DENOMINATORS[part.toLowerCase()]
        : decimal !== undefined
          ? Number(decimal)
          : Number(num) / Number(den);
      return `${countValue(count!) + fraction}`;
    },
  ],
  [/\bhalf[-\s]?way\b/gi, () => "0.5"],
  [
    /\b(?:(an?)[-\s]+)?(half|quarter|third|fourth|fifth|sixth|eighth)([-\s]+an?)?\b/gi,
    ([article, part, trailingArticle], rest, match, before) => {
      const p = part!.toLowerCase();
      // Without "a", "the third hour" is an ordinal.
      if (ORDINAL_PARTS.has(p) && !article) return match;
      const value = `${1 / DENOMINATORS[p]}`;
      if (unitAfter(rest) !== null) return value;
      if (p !== "half") {
        // Without "a" or a unit, "quarter the onions" is a verb.
        if (!article) return match;
        const share =
          p === "quarter" || PART_OF_RE.test(rest) || NO_THING_AFTER_RE.test(rest);
        return share ? value : match;
      }
      if (HALF_AND_HALF_RE.test(rest) || AFTER_HALF_AND_RE.test(before)) return match;
      if (
        !article &&
        IN_HALF_RE.test(before) &&
        !ADDED_IN_RE.test(before) &&
        !REDUCED_IN_RE.test(before)
      ) {
        // Cut in half, unless a share follows that is not a way of cutting.
        const partOf = trailingArticle !== undefined || PART_OF_RE.test(rest);
        const cutHow = DIVIDED_IN_RE.test(before) && DIVIDED_HOW_RE.test(rest);
        return partOf && !cutHow ? value : match;
      }
      if (!article && PIECE_BEFORE_RE.test(before)) return match;
      return value;
    },
  ],
  [
    new RegExp(
      `((?:\\d+/\\d+|\\d*\\.\\d+)\\s*)\\ban?\\s+(?=${UNIT_MODIFIERS}${ARTICLE_MEASURE_WORD}\\b)`,
      "gi",
    ),
    ([fraction]) => fraction!,
  ],
  [
    new RegExp(
      `\\b(?:an?|another)\\s+${UNIT_MODIFIERS}${ARTICLE_MEASURE_WORD}\\b(\\s+or\\s+two\\b)?`,
      "gi",
    ),
    ([unit, orTwo], _rest, match, before) => {
      if (/\bof\s+$/i.test(before)) {
        const dozenOfThings = /^dozen$/i.test(unit!) && !NUMBER_BEFORE_OF_RE.test(before);
        if (!dozenOfThings) return match;
      }
      return orTwo ? `1 to 2 ${unit}` : `1 ${unit}`;
    },
  ],
  [/\b(?:doubled|doubles|twice)\b/gi, () => "2"],
  [/\b(?:tripled|triples|thrice)\b/gi, () => "3"],
  [/\bdouble(?=\s+in\s+(?:size|volume|bulk)\b)/gi, () => "2"],
  [/\btriple(?=\s+in\s+(?:size|volume|bulk)\b)/gi, () => "3"],
];

function numberWords(text: string): string {
  return WORD_NUMBERS.reduce(
    (out, [pattern, digits]) =>
      // No rule has named groups, so the last two arguments are always the
      // offset and the whole string.
      out.replace(pattern, (match: string, ...args: unknown[]) => {
        const whole = args.at(-1) as string;
        const offset = args.at(-2) as number;
        const groups = args.slice(0, -2) as (string | undefined)[];
        return digits(
          groups,
          whole.slice(offset + match.length),
          match,
          whole.slice(0, offset),
        );
      }),
    text,
  );
}

/**
 * Characters imported pages carry that would hide a number from the readers
 * below: zero-width spaces and joiners, soft hyphens, fullwidth digits, the
 * fraction slash ("1⁄2"), and fraction characters, spelled out before the
 * word readers so "two and ½" is one number like "two and 1/2" ("1½" becomes
 * "1 1/2").
 */
function normalizeHidden(text: string): string {
  return text
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/⁄/g, "/")
    .replace(UNICODE_FRACTION_RE, (f) => ` ${UNICODE_FRACTIONS[f]}`)
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
}

/**
 * Degree signs as imported pages write them: the ℃ and ℉ ligatures, the ring
 * accent ˚, a superscript zero, HTML entities left encoded (once or twice,
 * named or numbered, with or without the semicolon on "&deg"), and a letter
 * o standing in for the ring before a scale ("350oF", "350ᵒF").
 */
function normalizeDegrees(text: string): string {
  return text
    .replace(/&(?:amp;)?(?:deg;?|#0*176;|#[xX]0*[bB]0;)/g, "°")
    .replace(/[˚⁰]/g, "°")
    .replace(/℃/g, "°C")
    .replace(/℉/g, "°F")
    .replace(/(\d)\s?[oᵒ](?=\s?[FC]\b)/g, "$1°");
}

export type Unit =
  | "F" | "C" | "deg" | "min"
  | "cup" | "floz" | "tbsp" | "tsp" | "ml" | "l" | "qt" | "pt" | "gal"
  | "kg" | "g" | "oz" | "lb"
  | "inch" | "cm" | "mm" | "%";

/** A number in recipe text, with times in minutes. */
export interface Quantity {
  value: number;
  unit: Unit | null;
}

/**
 * Units that can follow a number, tried in order, each anchored at the text
 * just after it. Every word unit ends on a word boundary, so "minced" is not
 * minutes and "garlic" is not grams. Case matters only where it disambiguates:
 * "C" is Celsius and "c" a cup; "T" a tablespoon and "t" a teaspoon.
 */
const UNITS: [RegExp, Unit | null, number][] = [
  [/^[°º]\s*(?:f|fahrenheit)(?![a-z])/i, "F", 1],
  [/^[°º]\s*(?:c|celsius)(?![a-z])/i, "C", 1],
  [/^[°º]/, "deg", 1],
  [/^deg(?:ree)?s?\.?\s*(?:f|fahrenheit)(?![a-z])/i, "F", 1],
  [/^deg(?:ree)?s?\.?\s*(?:c|celsius)(?![a-z])/i, "C", 1],
  [/^deg(?:ree)?s?\b/i, "deg", 1],
  [/^fahrenheit\b/i, "F", 1],
  [/^celsius\b/i, "C", 1],
  [/^F\b/, "F", 1],
  [/^C\b/, "C", 1],
  // Not "a second time", an ordinal.
  [/^sec(?:ond)?s?\b(?!\s+times?\b)/i, "min", 1 / 60],
  [/^min(?:ute)?s?\b/i, "min", 1],
  [/^(?:h(?:ou)?rs?|h)\b/i, "min", 60],
  [/^days?\b/i, "min", 1440],
  [/^weeks?\b/i, "min", 10080],
  [/^cups?\b/i, "cup", 1],
  [/^c\b/, "cup", 1],
  [/^(?:fl\.?\s*oz|fluid\s+ounces?)\b/i, "floz", 1],
  [/^(?:tablespoons?|tbsps?|tblsps?|tbls?|tbs)\b/i, "tbsp", 1],
  [/^T\b/, "tbsp", 1],
  [/^(?:teaspoons?|tsps?)\b/i, "tsp", 1],
  [/^t\b/, "tsp", 1],
  [/^(?:mls?|millilit(?:er|re)s?)\b/i, "ml", 1],
  // Not cl: in ingredient lists it is as often cloves as centilitres.
  [/^(?:dl|decilit(?:er|re)s?)\b/i, "ml", 100],
  [/^(?:l|lit(?:er|re)s?)\b/i, "l", 1],
  [/^(?:qts?|quarts?)\b/i, "qt", 1],
  [/^(?:pts?|pints?)\b/i, "pt", 1],
  [/^(?:gal|gallons?)\b/i, "gal", 1],
  [/^(?:kg|kilos?|kilograms?)\b/i, "kg", 1],
  [/^(?:g|gr|gms?|grams?)\b/i, "g", 1],
  [/^(?:oz|ounces?)\b/i, "oz", 1],
  [/^(?:lbs?|pounds?)\b/i, "lb", 1],
  [/^inch(?:es)?\b/i, "inch", 1],
  // Only with its period: "2 in the pan" is not inches.
  [/^in\./i, "inch", 1],
  [/^(?:cm|centimet(?:er|re)s?)\b/i, "cm", 1],
  [/^(?:mm|millimet(?:er|re)s?)\b/i, "mm", 1],
  [/^(?:%|per\s?cent\b)/i, "%", 1],
  // A count of twelve, not a measure: "2 dozen eggs" is 24 eggs.
  [/^dozen\b/i, null, 12],
];

/**
 * What may sit between the numbers of a range: "3-4", "1 to 2", "2 x 3",
 * "nine-by-thirteen". Tried only on a short gap: the pattern backtracks over
 * long runs of spaces.
 */
const RANGE_GAP_RE = /^\s*(?:[-–—]|[-–—]?\s*(?:to|or|x|×|by)\s*[-–—]?)\s*$/i;
const RANGE_GAP_MAX = 40;

function unitAfter(rest: string): { unit: Unit | null; factor: number } | null {
  // An inch mark counts only against the number: 2" but not 2 ".
  if (/^["”″]/.test(rest)) return { unit: "inch", factor: 1 };
  // "2-inch", "two-thirds of a cup", "5 more minutes".
  const after = rest
    .replace(/^\s*-?\s*/, "")
    .replace(/^of\s+an?\s+/i, "")
    .replace(UNIT_MODIFIERS_RE, "");
  for (const [pattern, unit, factor] of UNITS) {
    if (pattern.test(after)) return { unit, factor };
  }
  return null;
}

/**
 * The quantities in a piece of text, in order: digits, fractions and word
 * numbers, each with the unit that follows it. "1½", "1 1/2" and "1.5" read
 * the same, as do "1,000" and "1000", and "1 hour" and "60 minutes". The
 * first number of a range takes the range's unit ("3-4 minutes"); a clock
 * time splits into its parts. "Two and a half", "three-quarters", "an hour"
 * and "half an hour" read as numbers (see `WORD_NUMBERS`), and ℃, ˚ and
 * "&deg;" as degrees. With `wordsNeedUnit`, a bare "one" (no unit after it) is
 * left out, since "one at a time" is not a quantity; "two onions" still is.
 */
export function quantitiesIn(
  text: string,
  { wordsNeedUnit }: { wordsNeedUnit: boolean },
): Quantity[] {
  return readQuantities(text).flatMap((r) =>
    r.word && wordsNeedUnit && r.unit === null && r.value === 1
      ? []
      : [{ value: r.value, unit: r.unit }],
  );
}

/**
 * A number as `readQuantities` read it: whether it was said in words, whether
 * it opens a range with the next one ("35" in "35 to 40 minutes"), having
 * taken that number's unit, its unit's factor (60 for an hour in minutes),
 * the text before it back to the last number, and the text after it up to
 * the next number.
 */
interface QuantityReading extends Quantity {
  word: boolean;
  rangeWithNext: boolean;
  factor: number;
  before: string;
  after: string;
}

function readQuantities(text: string): QuantityReading[] {
  const normalized = numberWords(normalizeDegrees(normalizeHidden(text)))
    .replace(/\b\d{1,3}(?:,\d{3})+(?!\d)/g, (n) => n.replace(/,/g, ""))
    // "1-1/2" and "1-½" are one and a half, not a range from 1 to 1/2.
    .replace(
      /(?<![\d/.])(\d+)-\s?(\d+)\/(\d+)(?![\d/])/g,
      (match, whole: string, num: string, den: string) =>
        Number(num) < Number(den) ? `${whole} ${num}/${den}` : match,
    );

  const tokens: { start: number; end: number; value: number; word: boolean }[] =
    [];
  for (const m of normalized.matchAll(NUMBER_RE)) {
    let value = Number(m[0]);
    if (m[1] !== undefined) {
      if (Number(m[3]) === 0) continue;
      value = Number(m[1]) + Number(m[2]) / Number(m[3]);
    } else if (m[4] !== undefined) {
      if (Number(m[5]) === 0) continue;
      value = Number(m[4]) / Number(m[5]);
    }
    tokens.push({ start: m.index, end: m.index + m[0].length, value, word: false });
  }
  for (const m of normalized.matchAll(WORD_NUMBER_RE)) {
    const value = countValue(m[0]);
    tokens.push({ start: m.index, end: m.index + m[0].length, value, word: true });
  }
  tokens.sort((a, b) => a.start - b.start);

  const units = tokens.map((t) => unitAfter(normalized.slice(t.end)));
  const rangeWithNext = tokens.map(() => false);
  for (let i = tokens.length - 2; i >= 0; i--) {
    const gap = normalized.slice(tokens[i].end, tokens[i + 1].start);
    if (!units[i] && gap.length <= RANGE_GAP_MAX && RANGE_GAP_RE.test(gap)) {
      units[i] = units[i + 1];
      rangeWithNext[i] = units[i] !== null;
    }
  }

  return tokens.map((t, i) => {
    const u = units[i];
    return {
      value: u ? t.value * u.factor : t.value,
      unit: u?.unit ?? null,
      word: t.word,
      rangeWithNext: rangeWithNext[i],
      factor: u?.factor ?? 1,
      before: normalized.slice(tokens[i - 1]?.end ?? 0, t.start),
      after: normalized.slice(t.end, tokens[i + 1]?.start ?? normalized.length),
    };
  });
}

/**
 * What a duration in a step says (slice B5a, decision A1). Only a `length`
 * is how long the step takes, so only a length can time it:
 *
 * - `length`: "simmer 20 minutes", "let rest 10 minutes before serving";
 * - `mark`: a point within the step, "flipping once at 12 min", "add the
 *   peas 5 minutes before the end" (or "before serving", unless the step
 *   rests, stands, cools or soaks for it);
 * - `relative`: an offset from another time, "1-2 minutes less than package
 *   directions", "5 minutes shy of done";
 * - `cadence`: how often, "baste every 20 minutes";
 * - `bound`: a limit, not a length, "within 10 minutes of slicing", "keeps
 *   up to 3 days", "keeps, covered, 3 days". "Up to", "at most" and "no
 *   more than" in a step are its longest, which a timer runs to: "chill up
 *   to 2 hours" is a 2-hour length (DECISIONS B5a readings, call 3);
 * - `summary`: the whole recipe's time, "ready in 45 minutes total", "takes
 *   about an hour". Only the words before it say so: "bake 30 minutes in
 *   all" and "30 minutes total" are the step's own length;
 * - `rate`: a time per weight or size, "20 minutes per pound", "15 minutes
 *   each pound": the length depends on the cut, which no number states, so no
 *   timer (re-verify of 4bbf470). "4 minutes per side" is a length.
 */
export type DurationRole = "length" | "mark" | "relative" | "cadence" | "bound" | "summary" | "rate";

/**
 * A duration a step states, in minutes, with its role. A repeat ("2 x 5
 * minutes") is one round, with its count: a timer times one round, a lead
 * waits for all of them.
 */
export interface Duration {
  minutes: number;
  role: DurationRole;
  repeat?: { count: number };
}

/**
 * Only the unit between two durations: "1 hour 45 minutes", "1 hour and 15
 * minutes", "1 hour, 15 minutes" (B5a, A2: a bare comma joins too, unless
 * `BARE_COMMA_APART_RE` holds the parts apart).
 */
const COMPOUND_GAP_RE = /^\s*\p{L}+\.?\s*(?:,\s*(?:and\s+)?|and\s+)?$/u;
/** A bare comma between the units, with no "and". */
const BARE_COMMA_RE = /,(?!\s*and\b)/;
/**
 * After a bare comma, a smaller unit joins the larger whatever follows it, so
 * the compound reads as its comma-free text does, its role from what follows
 * the whole ("bake for 1 hour, 15 minutes until golden" is 75; "at least 1
 * hour, 30 minutes at room temperature before" a 90-minute lead; "cook 1
 * hour, 15 minutes shy of done" an offset and "add the glaze 1 hour, 15
 * minutes before the end" a point, neither timed; the independent verify of
 * 11790c5 and its re-verify, reversing round 1's Q3 and round 2's H1). The
 * one exception is a smaller part that is a part of the larger: "braise 3
 * hours, 20 minutes of it uncovered" is 3 hours.
 */
const BARE_COMMA_APART_RE = /^\s*\p{L}+\.?\s+of\s+(?:it|them|that|this|which|those|the\s+time)\b/iu;
/**
 * The unit, then a comparison: "1-2 minutes less than package directions",
 * "5 minutes shy of done", "10 minutes short of the time given".
 */
const RELATIVE_AFTER_RE =
  /^\s*-?\s*\p{L}+\.?\s+(?:(?:less|more|longer|shorter)\s+than|shy\s+of|short\s+of)\b/iu;
/**
 * The unit, then a weight or a size it is per: "20 minutes per pound",
 * "each pound". Not "15 minutes a pound": the reader takes "a pound" as a
 * quantity of its own, so that one still times (logged, B5a).
 */
const RATE_AFTER_RE =
  /^\s*-?\s*\p{L}+\.?\s+(?:per|each|for\s+each)\s+(?:pounds?|lbs?|kilos?|kilograms?|kg|inch(?:es)?|cm|centimet(?:er|re)s?|(?:\d+\s*)?(?:g|grams?|oz|ounces?))\b/iu;
/** "at" straight before: "flipping once at 12 min", "at the 10-minute mark". */
const MARK_BEFORE_RE = /\bat\s+(?:the\s+)?$/i;
/** The unit, then "before the end" or "from the end": a point, not a length. */
const END_MARK_AFTER_RE = /^\s*-?\s*\p{L}+\.?\s+(?:before|from)\s+the\s+(?:end|finish)\b/iu;
/** The unit, then "before serving": a point after a verb that adds (below), else a wait's length. */
const SERVING_MARK_AFTER_RE = /^\s*-?\s*\p{L}+\.?\s+before\s+(?:serving|you\s+serve)\b/iu;
/**
 * A verb that puts something in or on at a point, opening the duration's own
 * clause ("add the peas 5 minutes before serving"). Any other clause before
 * serving waits it out: "let rest", "refrigerate", "steam … for" (B5a verify
 * round 1, Q2), and so does "remove from the oven and let rest 10 minutes
 * before serving", whose last clause rests (round 2, M2).
 */
const ADDS_BEFORE_RE =
  /(?:^|[.;:!?,]|\band\b|\bthen\b)\s*(?:add|stir\s+in|toss\s+in|fold\s+in|mix\s+in|sprinkle|drizzle|scatter|top|garnish|baste|brush|glaze|season)\b(?:(?![.;:!?,]|\band\b|\bthen\b)[^])*$/i;
/** "for" straight before: "bake for 1 hour" is a length, whatever follows. */
const FOR_BEFORE_RE = /\bfor\s+$/i;
/** Straight before: "every 20", "every other", "every 5 to 10". */
const CADENCE_BEFORE_RE = /\bevery\s+(?:other\s+)?$/i;
/**
 * A holding time's opening: "keeps" or "will keep", then up to three holding
 * words or a parenthetical ("keeps, covered,", "will keep, chilled, for",
 * "keeps (covered)"), then the wait. Only holding words: "stirring keeps it
 * smooth for 5 minutes" holds nothing (B5a verify round 1, Q1). Shared by the
 * step reader and the lead reader, so the two never part.
 */
const HOLDING = String.raw`(?:keeps|will\s+keep)(?:[\s,]+(?:\([^)]*\)|well|covered|chilled|refrigerated|frozen|wrapped|tightly|sealed|airtight|in\s+the\s+(?:fridge|freezer|refrigerator))){0,3}[\s,]+(?:for\s+)?`;
/**
 * Straight before: a bound, which no timer runs to. "Within" (a deadline from
 * another event) and a holding time. "Up to", "at most" and "no more than" in
 * a step say its longest, which a timer runs to ("steep no more than 4
 * minutes", Q4); in a lead they still name no wait (`LEAD_UPPER_BOUND_RE`).
 */
const BOUND_BEFORE_RE = new RegExp(String.raw`(?:\bwithin\s+|\b${HOLDING}(?:up\s+to\s+)?)$`, "i");
/**
 * Straight before: the whole recipe's time. "Ready in", "the whole recipe
 * takes". A step's own "takes about 4 minutes" or "a total of 1 hour" is its
 * length (Q4).
 */
const SUMMARY_BEFORE_RE =
  /\b(?:ready\s+in|(?:recipe|dish|whole\s+thing)\s+takes)\s+(?:about\s+|around\s+|roughly\s+)?$/i;
/** Between a count and a length: "2 x 5 minutes", "3 × 2 minutes". */
const REPEAT_GAP_RE = /^\s*[x×]\s*$/i;

/**
 * The role of a duration, from the text before its first number and after
 * its last. A cadence, a bound or a summary is what precedes it; an offset is
 * what follows; a mark is either ("at 12 min", "5 minutes before the end").
 */
function durationRole(before: string, after: string): DurationRole {
  if (MARK_BEFORE_RE.test(before)) return "mark";
  if (CADENCE_BEFORE_RE.test(before)) return "cadence";
  if (BOUND_BEFORE_RE.test(before)) return "bound";
  if (SUMMARY_BEFORE_RE.test(before)) return "summary";
  if (RELATIVE_AFTER_RE.test(after)) return "relative";
  if (RATE_AFTER_RE.test(after)) return "rate";
  if (FOR_BEFORE_RE.test(before)) return "length";
  if (END_MARK_AFTER_RE.test(after)) return "mark";
  if (SERVING_MARK_AFTER_RE.test(after) && ADDS_BEFORE_RE.test(before)) return "mark";
  return "length";
}

/**
 * Hour-and-minute shorthand written as one word or with bare letters, "2h30m",
 * "2h 30m", "1 h 15 m", spelled out so the readers join it. A bare "m" is
 * minutes only straight after an hour; anywhere else it may be metres.
 */
function spellShorthand(text: string): string {
  return text.replace(
    /\b(\d+(?:\.\d+)?)\s*h(?:rs?)?\s*(\d+)\s*m(?:ins?)?\b/gi,
    "$1 hours $2 minutes",
  );
}

/**
 * "a day and 8 hours" is one wait: "a day" reads as a number here, which it
 * otherwise doesn't ("a day ahead" is a lead's words, not a quantity).
 */
function spellDayCompound(text: string): string {
  return text.replace(
    /\ban?\s+day(?=[-\s]+and[-\s]+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an?)\s+(?:h(?:ou)?rs?|min(?:ute)?s?)\b)/gi,
    "1 day",
  );
}

/** The next duration continues this one: a smaller unit straight after it. */
function continuesDuration(last: QuantityReading, next: QuantityReading | undefined): boolean {
  return (
    next !== undefined &&
    next.unit === "min" &&
    !last.rangeWithNext &&
    next.factor < last.factor &&
    COMPOUND_GAP_RE.test(last.after) &&
    (!BARE_COMMA_RE.test(last.after) || !BARE_COMMA_APART_RE.test(next.after))
  );
}

/**
 * The durations a step states, in minutes and in order, each with its role
 * (`DurationRole`). A range is one duration at its lower bound ("35 to 40
 * minutes" is 35, "a minute or two" is 1), where `quantitiesIn` reads it as
 * two numbers. A larger unit followed straight by a smaller one is one
 * duration ("1 hour 45 minutes", "1 hour, 15 minutes", "2h 30m", "a day and 8
 * hours"). A count times a length ("2 x 5 minutes") is a repeat: one round,
 * with its count. A list number opening the step is not read. The converter
 * times a pack step by `timedLength`.
 */
export function durationsIn(text: string): Duration[] {
  const readings = readQuantities(
    spellDayCompound(spellShorthand(text.replace(STEP_ENUMERATOR_RE, ""))),
  );
  const durations: Duration[] = [];
  let range: number[] = [];
  let start: QuantityReading | undefined;
  let repeat: number | undefined;
  for (let i = 0; i < readings.length; i++) {
    let last = readings[i];
    if (last.unit !== "min") continue;
    start ??= last;
    // "2 x 5 minutes": the 2 took the minutes as a range's first number did.
    // A ranged count ("2-3 x 5 minutes") is counts, not minutes: the range
    // read so far is its fewest, and the round is what follows.
    if (last.rangeWithNext && REPEAT_GAP_RE.test(last.after)) {
      const factor = last.factor;
      repeat = Math.min(last.value / factor, ...range.map((v) => v / factor));
      range = [];
      continue;
    }
    let minutes = last.value;
    while (continuesDuration(last, readings[i + 1])) {
      i += 1;
      last = readings[i];
      minutes += last.value;
    }
    range.push(minutes);
    if (last.rangeWithNext) continue;
    const duration: Duration = {
      minutes: Math.min(...range),
      role: durationRole(start.before, last.after),
    };
    if (repeat !== undefined && Number.isInteger(repeat) && repeat > 1) {
      duration.repeat = { count: repeat };
    }
    durations.push(duration);
    range = [];
    start = undefined;
    repeat = undefined;
  }
  return durations;
}

/** Roles that say nothing about how long the step itself runs. */
const ASIDE_ROLES: ReadonlySet<DurationRole> = new Set(["mark", "cadence", "bound", "summary", "rate"]);

/**
 * How long a step's timer runs, in minutes: its first length, one round of a
 * repeat; null when the step states none (slice B5a, A1). Marks, cadences,
 * bounds and summaries are passed over. An offset is not: when the first
 * duration that isn't one of those is relative ("1-2 minutes less than the
 * package says, e.g. 9 minutes"), the step's length is that offset's, which
 * no number states, so there is no timer (B4 step 0, call 8).
 */
export function timedLength(durations: readonly Duration[]): number | null {
  const first = durations.find((d) => !ASIDE_ROLES.has(d.role));
  return first === undefined || first.role === "relative" ? null : first.minutes;
}

/**
 * Leads said in words, in minutes before the cook starts. Only a day before
 * counts as a day: "the day of", "on the day" and "earlier in the day" are
 * the cook's own day and name no wait.
 */
const LEAD_WORDS: [RegExp, number][] = [
  [/\b(?:a|one)\s+week\b/i, 10080],
  // Not the day of "a day and 8 hours" or "a day and a half": `durationsIn`
  // reads those whole (B5a, A2).
  [
    /\b(?:a|one|(?:the\s+)?previous)\s+day\b(?![-\s]+and[-\s]+(?:an?[-\s]+half\b|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an?)\s+(?:h(?:ou)?rs?|min(?:ute)?s?)\b))|\bday\s+(?:before|ahead)\b/i,
    1440,
  ],
  [/\bovernight\b|\b(?:night|evening)\s+before\b|\bprevious\s+(?:night|evening)\b/i, 720],
];

/** A count of something, in figures or words, as a lead says it. */
const LEAD_COUNT =
  String.raw`(?:\d+(?:[.,]\d+)?\s*[¼-¾⅐-⅞]?|[¼-¾⅐-⅞]|half\s+an?|a\s+couple\s+of|a\s+few|several|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;

/** A unit a lead's wait is said in. */
const LEAD_UNIT = String.raw`(?:min(?:ute)?s?|h(?:ou)?rs?|days?|nights?|weeks?)\b`;

/**
 * An upper bound and the wait it bounds ("up to 3 days", "at most 4 hours",
 * "no more than a week", "up to overnight", "within 30 minutes of serving",
 * "keeps 3 days"): it allows any shorter lead, down to none, so it sets no
 * shortest wait and is read out before anything else. The wait must follow
 * the bound directly, so "bring up to room temperature 1 hour before" bounds
 * nothing and reads as an hour; only "keeps" or "will keep", a holding time,
 * may have up to three words or a parenthetical before it ("keeps, covered,
 * 3 days", B5a A3). A wait said in parts is bounded whole ("up to 1 hour 30
 * minutes", "within 1 hour, 30 minutes"), as `durationsIn` joins it.
 */
/**
 * A lead's wait as a bound takes it: a count and unit, said in parts (a
 * comma joins only minutes, so "up to 4 hours, 2 hours ahead" is a bound
 * and then a lead), a repeat of one ("up to 2 x 4 hours"), or "overnight",
 * "the day before".
 */
const LEAD_BOUNDED_WAIT = String.raw`(?:(?:${LEAD_COUNT}(?:\s*(?:-|–|to|or)\s*${LEAD_COUNT})?\s*[x×]\s*)?${LEAD_COUNT}(?:\s*(?:-|–|to|or)\s*${LEAD_COUNT})?\s*${LEAD_UNIT}(?:\s*(?:and\s+)?${LEAD_COUNT}\s*(?:min(?:ute)?s?|h(?:ou)?rs?)\b|\s*,\s*(?:and\s+)?${LEAD_COUNT}\s*min(?:ute)?s?\b)*|overnight\b|(?:the\s+)?(?:night|evening|day)\s+before\b)`;
const LEAD_UPPER_BOUND_RE = new RegExp(
  String.raw`\b(?:(?:up\s+to|at\s+most|no\s+more\s+than|within)\s+${LEAD_BOUNDED_WAIT}|${HOLDING}(?:up\s+to\s+)?${LEAD_BOUNDED_WAIT})`,
  "gi",
);

/**
 * A wait that recurs rather than one to wait before the cook: a cadence
 * ("baste every 20 minutes"). Read out with the upper bounds, so "baste every
 * 20 minutes for 2 hours" is 2 hours, not 20 minutes. A repeat ("2 x 4 hours
 * before") is not read out: it is the whole wait, count times each (B5a, A3).
 */
const LEAD_RECURRING_RE = new RegExp(
  String.raw`\bevery\s+(?:other\s+)?(?:${LEAD_COUNT}(?:\s*(?:-|–|to|or)\s*${LEAD_COUNT})?\s*)?${LEAD_UNIT}`,
  "gi",
);

/**
 * Where a lead offers alternatives ("the day before or the morning of"). Not
 * "or so", nor "or two" after a wait ("a day or two"), which only widen it.
 */
const LEAD_OR_RE = /\bor\b(?!\s+(?:so|two|three|more)\b)/i;

/** Words that make an alternative a time, even one this can't read. */
const LEAD_TIME_WORD_RE =
  /\b(?:day|morning|afternoon|evening|night|hours?|minutes?|weeks?|few|several|couple)\b/i;

/**
 * The shortest wait a lead's words name, in minutes; null if none. A wait
 * said in parts is one wait ("2 hours 30 minutes" is 150, not 30). Every
 * duration counts, whatever role `durationsIn` gives it: a lead times no
 * point within a step, so a wait before a mark ("2 hours before serving") or
 * a summary ("ready in 3 hours total") is still its wait; cadences and bounds
 * are read out first, by the lead's own patterns.
 */
function leadReading(text: string): number | null {
  // A repeat waits out every round: "2 x 4 hours" is 8 hours. Every other
  // duration counts as read, whatever its role: the strips above took the
  // cadences and bounds out by their own words.
  const said = durationsIn(text).map((d) => d.minutes * (d.repeat?.count ?? 1));
  for (const [pattern, minutes] of LEAD_WORDS) {
    if (pattern.test(text)) said.push(minutes);
  }
  return said.length > 0 ? Math.min(...said) : null;
}

/**
 * How far ahead a lead puts its task, in minutes before the cook starts: the
 * shortest it allows, so "at least 2 hours, or up to 3 days" is 120 and
 * "8 hours or overnight" is 480. Words count too ("overnight" 720, "the day
 * before" 1440). Null when the lead allows no shortest time this can read:
 * no time at all ("the morning of", "on the day", "a few hours"); only an
 * upper bound ("up to 2 days ahead", which allows doing it just before); or
 * an alternative that is such a time ("a day ahead or the same day", whose
 * shortest is the same day). Such a lead can't be compared with another.
 */
export function leadMinutes(lead: string | null | undefined): number | null {
  if (!lead) return null;
  const bounded = lead.replace(LEAD_UPPER_BOUND_RE, " ").replace(LEAD_RECURRING_RE, " ");
  const unread = bounded
    .split(LEAD_OR_RE)
    .some((alt) => LEAD_TIME_WORD_RE.test(alt) && leadReading(alt) === null);
  return unread ? null : leadReading(bounded);
}

/** "1." or "Step 2)" opening a step: a list number, not a quantity. */
const STEP_ENUMERATOR_RE = /^\s*(?:step\s*)?\d+\s*[.):]\s+/i;

function sameValue(a: Quantity, b: Quantity): boolean {
  return Math.abs(a.value - b.value) < 1e-6;
}

/**
 * The one way a task's quantity may differ from the step's: a bare degree
 * given its scale ("350 degrees" as "350°F"). Whether it is the right scale
 * can't be checked here (known-issues). Every other quantity keeps its unit
 * exactly. A task may not add one ("divide into 12" is not "12°", "heat the
 * oil to 350" is not "350°C"), and may not leave one off: "simmer, about 15"
 * for "15 minutes" would let any number in the task stand for a dropped
 * measure ("sear on one side" for "1 minute per side"). A word the reader
 * doesn't know as a unit counts as none, so "2 sticks" can't stand for "2
 * tablespoons" either.
 */
function scalesDegree(said: Unit | null, needed: Unit | null): boolean {
  return needed === "deg" && (said === "F" || said === "C");
}

/**
 * The quantities a step says that the tasks citing it do not, counting each
 * occurrence: a step saying 2 twice needs 2 said twice. A task's text counts,
 * and an ahead task's lead ("8 hours"); a cue never does, because the cook
 * view doesn't show it as the instruction.
 */
function droppedQuantities(step: string, citing: CookTask[]): Quantity[] {
  const said = citing.flatMap((t) =>
    [t.text, t.kind === "ahead" ? t.lead : undefined].flatMap((part) =>
      part ? quantitiesIn(part, { wordsNeedUnit: false }) : [],
    ),
  );
  const needed = quantitiesIn(step.replace(STEP_ENUMERATOR_RE, ""), {
    wordsNeedUnit: true,
  });
  const used = said.map(() => false);
  const matched = needed.map(() => false);
  const take = (i: number, fits: (a: Unit | null, b: Unit | null) => boolean) => {
    const j = said.findIndex(
      (q, k) => !used[k] && sameValue(q, needed[i]) && fits(q.unit, needed[i].unit),
    );
    if (j === -1) return;
    used[j] = true;
    matched[i] = true;
  };

  needed.forEach((_, i) => take(i, (a, b) => a === b));
  needed.forEach((_, i) => {
    if (!matched[i]) take(i, scalesDegree);
  });
  return needed.filter((_, i) => !matched[i]);
}

function formatQuantity(q: Quantity): string {
  const value = Number(q.value.toFixed(2));
  return q.unit ? `${value} ${q.unit}` : `${value}`;
}

/** Text Postgres can't store in jsonb: a NUL, or half of a surrogate pair. */
function unstorable(text: string): boolean {
  return text.includes("\u0000") || !text.isWellFormed();
}

/** Where a task field holds unstorable text, e.g. "tasks[7].needs[0]". */
function unstorableField(tasks: RawTask[]): string | null {
  for (const [i, t] of tasks.entries()) {
    const fields: [string, string | null | undefined][] = [
      ["id", t.id],
      ["text", t.text],
      ["label", t.label],
      ...t.needs.map((n, j): [string, string] => [`needs[${j}]`, n]),
      ["cue", t.cue],
      ["lead", t.lead],
      ["branch", t.branch],
    ];
    for (const [name, value] of fields) {
      if (value && unstorable(value)) return `tasks[${i}].${name}`;
    }
  }
  return null;
}

/**
 * Validate an LLM-derived plan against the recipe it came from.
 *
 * Rejects the whole plan when any rule is broken, checked in this order:
 * the shape; text Postgres can't store; ids (duplicate, dangling, cycle);
 * each task's source step, which every cook task has; every step covered (naming every uncovered
 * one), with every quantity it says said again by the tasks citing it; each cook task listing only
 * ingredients its step uses, when the recipe says which (`stepIngredientBounds`); kinds needing only
 * what can come before them; no ahead task needing one with a shorter lead; at least one cook task; and every task leading somewhere, so each
 * branch ends in one recipe step. The result names the first rule broken, so
 * the stored error says why. The checks up to the source steps stop at the
 * first failure, as do those after the lead order; from coverage through the
 * lead order every violation is listed (`violations`), so one re-ask can name
 * them all. Out-of-range ingredient indices are dropped rather than
 * rejected, as `stepIngredients` handles them.
 */
export function parseCookPlan(
  raw: unknown,
  recipe: RecipeForPlan,
): CookPlanParseResult {
  const parsed = RawCookPlanSchema.safeParse(raw);
  if (!parsed.success) return reject("shape", parsed.error.message);

  const badField = unstorableField(parsed.data.tasks);
  if (badField) {
    return reject("bad-character", `${badField} has a character that can't be stored`);
  }

  const steps = recipe.steps ?? [];
  const ingredientCount = recipe.ingredients?.length ?? 0;
  const tasks = parsed.data.tasks.map((t) => normalizeTask(t, ingredientCount));

  const byId = new Map<string, CookTask>();
  for (const t of tasks) {
    if (byId.has(t.id)) return reject("duplicate-id", `"${t.id}" appears twice`);
    byId.set(t.id, t);
  }

  for (const t of tasks) {
    for (const need of t.needs) {
      if (!byId.has(need)) {
        return reject("dangling-need", `"${t.id}" needs unknown "${need}"`);
      }
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) return reject("cycle", cycle.join(" → "));

  for (const t of tasks) {
    if (t.sourceStep !== null && (t.sourceStep < 0 || t.sourceStep >= steps.length)) {
      return reject(
        "bad-source-step",
        `"${t.id}" cites step ${t.sourceStep}; the recipe has ${steps.length}`,
      );
    }
    if (t.implied !== (t.sourceStep === null)) {
      return reject(
        "implied-mismatch",
        `"${t.id}" has implied=${t.implied} with sourceStep=${t.sourceStep}`,
      );
    }
    if (t.kind === "cook" && t.sourceStep === null) {
      return reject("invented-cook", `cook "${t.id}" cites no recipe step`);
    }
  }

  // From here to the lead order, every violation is collected rather than
  // the first, in the order the checks run, so the first is the one named
  // and the re-ask can list them all. A plan passes only with none.
  const violations: CookPlanViolation[] = [];

  const cited = new Set(tasks.map((t) => t.sourceStep));
  const uncovered = steps.map((_, i) => i).filter((i) => !cited.has(i));
  for (let step = 0; step < steps.length; step++) {
    const citing = tasks.filter((t) => t.sourceStep === step);
    if (citing.length === 0) {
      // One violation, at the first uncovered step, naming every one.
      if (step === uncovered[0]) {
        const which = uncovered.length === 1 ? `step ${step}` : `steps ${uncovered.join(", ")}`;
        violations.push({ rule: "uncovered-step", detail: `no task covers ${which}`, uncoveredSteps: uncovered });
      }
      continue;
    }
    const dropped = droppedQuantities(steps[step], citing);
    if (dropped.length > 0) {
      violations.push({
        rule: "dropped-number",
        detail: `step ${step} says ${dropped.map(formatQuantity).join(", ")}; its tasks (${citing
          .map((t) => t.id)
          .join(", ")}) do not`,
      });
    }
  }

  // Intake decides which ingredients go on which step, and the plan keeps
  // that (cook-fidelity plan, decision 3): a cook task lists only what its
  // step uses. Mise and ahead tasks are left free: one readies an ingredient
  // for whichever step uses it, often with no step of its own (implied), so
  // the mapping says nothing about it.
  const bounds = stepIngredientBounds(recipe);
  if (bounds !== null) {
    for (const t of tasks) {
      if (t.kind !== "cook" || t.sourceStep === null) continue;
      const uses = bounds[t.sourceStep]!;
      const outside = t.ingredientIdx.filter((i) => !uses.includes(i));
      if (outside.length > 0) {
        violations.push({
          rule: "ingredient-outside-step",
          detail: `cook "${t.id}" lists ingredient ${outside.join(", ")}, which step ${t.sourceStep} doesn't use (it uses ${
            uses.length > 0 ? uses.join(", ") : "none"
          })`,
        });
      }
    }
  }

  for (const t of tasks) {
    for (const need of t.needs) {
      const kind = byId.get(need)!.kind;
      if (t.kind === "mise" && kind === "cook") {
        violations.push({ rule: "mise-needs-cook", detail: `mise "${t.id}" needs cook "${need}"` });
      }
      if (t.kind === "ahead" && kind !== "ahead") {
        violations.push({
          rule: "ahead-needs-later",
          detail: `ahead "${t.id}" needs ${kind} "${need}"`,
        });
      }
    }
  }

  // Every lead counts back from the start of the cook, so what an ahead task
  // needs is done at least as far ahead. A shorter lead on the need is a
  // second anchor (counting back from the task that uses it) and would put it
  // after its dependent on Prep. A lead this can't read is no error: it has
  // nothing to compare, so the check looks through it (and through work with
  // no lead) to the needs beyond, which come earlier still. Breadth first, so
  // a direct need is named before one further off. Every short need is named,
  // and the search goes on past it, since what that need needs is only
  // checked against its own shorter lead and could still fall short of this
  // task's. A need whose lead is long enough ends the search on that branch:
  // its own check covers what is behind it. Cycles were rejected above.
  for (const t of tasks) {
    if (t.kind !== "ahead") continue;
    const own = leadMinutes(t.lead);
    if (own === null) continue;
    const seen = new Set<string>();
    const queue: { id: string; via: string[] }[] = t.needs.map((id) => ({ id, via: [] }));
    while (queue.length > 0) {
      const { id, via } = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id)!;
      const needs = leadMinutes(n.lead);
      if (needs === null) {
        for (const next of n.needs) queue.push({ id: next, via: [...via, n.id] });
        continue;
      }
      if (needs < own) {
        const through = via.length > 0 ? `, through ${via.map((v) => `"${v}"`).join(", ")}` : "";
        violations.push({
          rule: "lead-order",
          detail: `"${t.id}" (${t.lead}) needs "${n.id}" (${n.lead})${through}; a lead counts back from the start of the cook, so what a task needs can't have a shorter lead`,
        });
        for (const next of n.needs) queue.push({ id: next, via: [...via, n.id] });
      }
    }
  }

  if (violations.length > 0) return rejectAll(violations);

  if (!tasks.some((t) => t.kind === "cook")) {
    return reject("no-cook-task", "the plan has no cook tasks");
  }

  // Every task leads somewhere: the scheduler places work by what consumes
  // it, so a task nothing needs has no place, and a branch with two ends has
  // lost the edge joining them.
  const consumed = new Set(tasks.flatMap((t) => t.needs));
  const sinks = tasks.filter((t) => !consumed.has(t.id));
  for (const t of sinks) {
    if (t.kind !== "cook") {
      return reject("unused-task", `${t.kind} "${t.id}" is needed by nothing`);
    }
  }
  if (tasks.length > 1) {
    for (const t of sinks) {
      if (t.needs.length === 0) {
        return reject(
          "disconnected-task",
          `"${t.id}" (step ${t.sourceStep}) neither needs nor feeds another task`,
        );
      }
    }
  }
  const endOf = new Map<string, string>();
  for (const t of sinks) {
    const other = endOf.get(t.branch);
    if (other) {
      return reject(
        "branch-ends-twice",
        `branch "${t.branch}" ends at both "${other}" and "${t.id}"`,
      );
    }
    endOf.set(t.branch, t.id);
  }

  return { ok: true, plan: { version: COOK_PLAN_VERSION, tasks } };
}

/**
 * The recipe's step-ingredient mapping when it can bound a plan's cook tasks:
 * one list per step, of whole-number indices into the ingredient lines. Null
 * when there is none, or it doesn't fit the recipe (a row stored with a
 * mapping of another length); a plan's cook tasks then choose their own, as
 * before the bound existed.
 */
export function stepIngredientBounds(recipe: RecipeForPlan): number[][] | null {
  const map: unknown = recipe.stepIngredients;
  const steps = recipe.steps ?? [];
  const count = recipe.ingredients?.length ?? 0;
  if (!Array.isArray(map) || steps.length === 0 || map.length !== steps.length) return null;
  const fits = map.every(
    (entry: unknown) =>
      Array.isArray(entry) && entry.every((i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < count),
  );
  return fits ? (map as number[][]) : null;
}

function labelFor(stepText: string, stepIndex: number): string {
  const words = stepText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  return words.length > 0 ? words.join(" ") : `step ${stepIndex + 1}`;
}

/**
 * The recipe as written: one cook task per source step, chained in order.
 * Used when no derived plan exists, so every recipe gets the lookahead stack.
 */
export function identityPlan(recipe: RecipeForPlan): CookPlan {
  const steps = recipe.steps ?? [];
  const ingredientStrings = (recipe.ingredients ?? []).map(ingredientToString);
  const tasks: CookTask[] = steps.map((text, i) => ({
    id: `s${i}`,
    kind: "cook",
    text,
    label: labelFor(text, i),
    ingredientIdx: resolveStepIngredientIndices(
      i,
      steps,
      ingredientStrings,
      recipe.stepIngredients,
    ),
    sourceStep: i,
    implied: false,
    needs: i === 0 ? [] : [`s${i - 1}`],
    branch: "Cook",
  }));
  return { version: COOK_PLAN_VERSION, tasks };
}

/**
 * Whether there is anything to plan. A recipe with no steps opens on its
 * ingredients alone, so it is never sent for a plan.
 */
export function hasStepsToPlan(recipe: RecipeForPlan): boolean {
  return (recipe.steps?.length ?? 0) > 0;
}

/** A stored plan is usable only at the current version; older ones re-derive. */
export function isCurrentCookPlan(value: unknown): value is CookPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === COOK_PLAN_VERSION &&
    Array.isArray((value as { tasks?: unknown }).tasks)
  );
}
