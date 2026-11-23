/**
 * Derive a cook plan from a recipe with one `chat()` call.
 *
 * The model only extracts tasks: what each is, which kind, what it needs, and
 * roughly how long it takes. Ordering them is the scheduler's job
 * (`cook-schedule.ts`), so the prompt forbids timing words in task text.
 * `parseCookPlan` then validates the result strictly. Gemini writes to a
 * response schema, so no field can go missing. A rejected plan is sent back
 * once with the rule it broke, for the model to correct, before it comes back
 * with that rule; the cook view then falls back to the recipe as written.
 *
 * The kind rules mirror the labelling rules of the eval corpus
 * (`__tests__/fixtures/cook-plan/README.md`). Change one, change both, then
 * re-run `scripts/eval-cook-plan.ts`.
 */

import {
  chat,
  isAllowanceUsed,
  isUnpricedModel,
  type AIMessage,
  type AiMeter,
  type ResponseSchema,
} from "../ai";
import {
  hasStepsToPlan,
  parseCookPlan,
  stepIngredientBounds,
  type CookPlan,
  type CookPlanParseResult,
  type CookPlanRule,
  type CookPlanViolation,
  type RecipeForPlan,
} from "./cook-plan";
import { ingredientToString } from "./step-ingredients";

/** Gemini thinking tokens per derivation; chosen by the corpus eval. */
export const COOK_PLAN_THINKING_BUDGET = 0;

/**
 * How long a derivation may take, every attempt together. Derivations take
 * 3–12 s; the deadline keeps a hung call from holding the request (or the
 * `after()` behind it) until the platform kills it, and fits under a 60 s
 * function limit with room to store the result.
 */
export const COOK_PLAN_TIMEOUT_MS = 45_000;

/** Output budget before thinking; the retry doubles it. */
export const OUTPUT_TOKENS = 8192;
export const OUTPUT_TOKENS_RETRY = 16_384;

/**
 * The derive's own failure texts that another attempt at the same recipe
 * won't change. `isSettledPlanError` matches them exactly, so a provider's
 * message that happens to share a word (Google's 403 "… are blocked." for a
 * key restriction) stays transient.
 */
export const COOK_PLAN_BLOCKED = "The model declined to plan this recipe (blocked)";
export const COOK_PLAN_TOKEN_LIMIT = "Cook plan derivation exceeded the token limit even after retrying";

/** The stored text of a plan the validator refused. */
export function rejectedPlanError(rule: CookPlanRule, detail: string): string {
  return `rejected (${rule}): ${detail}`;
}

/**
 * The worked example in the prompt, kept as data so a test holds it to the
 * same validation as a derived plan. Not from the eval corpus.
 */
export const COOK_PLAN_EXAMPLE = {
  recipe: {
    ingredients: [
      { amount: "1", item: "onion, finely chopped" },
      { amount: "2", unit: "tbsp", item: "butter" },
      { amount: "1", unit: "cup", item: "basmati rice" },
      { amount: "2", unit: "cups", item: "stock" },
      { amount: "1", item: "lemon" },
    ],
    steps: [
      "Rinse the rice until the water runs clear.",
      "Melt the butter in a saucepan and cook the onion for 8 minutes, stirring now and then, until soft.",
      "Add the rice and stock, bring to a boil, then cover and simmer on low for 15 minutes.",
      "Zest the lemon over the rice, fluff with a fork and serve.",
    ],
    stepIngredients: [[2], [0, 1], [2, 3], [4]],
  },
  raw: {
    tasks: [
      { id: "chop-onion", kind: "mise", text: "Finely chop the onion.", label: "chop onion", ingredientIdx: [0], sourceStep: null, implied: true, needs: [], minutes: { est: 3, handsOff: false }, cue: null, lead: null, branch: "Cook" },
      { id: "rinse-rice", kind: "mise", text: "Rinse the rice until the water runs clear.", label: "rinse rice", ingredientIdx: [2], sourceStep: 0, implied: false, needs: [], minutes: { est: 2, handsOff: false }, cue: "until the water runs clear", lead: null, branch: "Cook" },
      { id: "soften-onion", kind: "cook", text: "Melt the butter in a saucepan and cook the onion for 8 minutes, stirring now and then, until soft.", label: "soften onion", ingredientIdx: [0, 1], sourceStep: 1, implied: false, needs: ["chop-onion"], minutes: { est: 9, handsOff: true }, cue: "until soft", lead: null, branch: "Cook" },
      { id: "simmer-rice", kind: "cook", text: "Add the rice and stock, bring to a boil, then cover and simmer on low for 15 minutes.", label: "simmer rice", ingredientIdx: [2, 3], sourceStep: 2, implied: false, needs: ["soften-onion", "rinse-rice"], minutes: { est: 20, handsOff: true }, cue: null, lead: null, branch: "Cook" },
      { id: "finish", kind: "cook", text: "Zest the lemon over the rice, fluff with a fork and serve.", label: "zest and serve", ingredientIdx: [4], sourceStep: 3, implied: false, needs: ["simmer-rice"], minutes: { est: 2, handsOff: false }, cue: null, lead: null, branch: "Cook" },
    ],
  },
} satisfies { recipe: RecipeForPlan; raw: { tasks: unknown[] } };

const text: ResponseSchema = { type: "string" };
const nullableText: ResponseSchema = { type: "string", nullable: true };
const ids: ResponseSchema = { type: "array", items: text };

/**
 * The raw plan's shape, for the model to write to. It mirrors
 * `RawCookPlanSchema` field for field, every one required, in the worked
 * example's key order so each task's text is written before its tags. The
 * validator still checks everything, because a schema can't say what a plan
 * means (ids that exist, steps all cited, no cycles).
 */
export const COOK_PLAN_RESPONSE_SCHEMA: ResponseSchema = (() => {
  const fields: Record<string, ResponseSchema> = {
    id: text,
    kind: { type: "string", enum: ["ahead", "mise", "cook"] },
    text,
    label: text,
    ingredientIdx: { type: "array", items: { type: "integer" } },
    sourceStep: { type: "integer", nullable: true },
    implied: { type: "boolean" },
    needs: ids,
    minutes: {
      type: "object",
      properties: { est: { type: "integer" }, handsOff: { type: "boolean" } },
      required: ["est", "handsOff"],
      propertyOrdering: ["est", "handsOff"],
    },
    cue: nullableText,
    lead: nullableText,
    branch: text,
  };
  const order = Object.keys(fields);
  return {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: fields,
          required: order,
          propertyOrdering: order,
        },
      },
    },
    required: ["tasks"],
  };
})();

/**
 * The recipe as the model reads it. When the recipe says which ingredients
 * each step uses (`stepIngredientBounds`: intake's mapping, or an import's),
 * each step ends with them, and the validator holds cook tasks to them.
 */
function recipePrompt(recipe: RecipeForPlan): string {
  const ingredients = (recipe.ingredients ?? [])
    .map((ing, i) => `[${i}] ${ingredientToString(ing)}`)
    .join("\n");
  const bounds = stepIngredientBounds(recipe);
  const uses = (i: number) => {
    if (bounds === null) return "";
    const list = bounds[i]!;
    return ` (ingredients: ${list.length > 0 ? list.join(", ") : "none"})`;
  };
  const steps = (recipe.steps ?? []).map((s, i) => `[${i}] ${s}${uses(i)}`).join("\n");
  return `Ingredients:\n${ingredients || "(none listed)"}\n\nSteps:\n${steps}`;
}

const EXAMPLE = `${recipePrompt(COOK_PLAN_EXAMPLE.recipe)}

${JSON.stringify(COOK_PLAN_EXAMPLE.raw)}`;

export const COOK_PLAN_SYSTEM_PROMPT = `You turn a recipe into a cook plan: the list of tasks a home cook does, each tagged with its kind and what it needs. An app schedules the tasks, so you never decide the order or timing, only what must finish before what.

# Kinds

**ahead**: work that needs an unattended stretch of 30 minutes or more that must be finished before cooking starts, or that the recipe says to do the day before. Soaking, marinating, dry-brining, chilling or resting a dough, cooking and chilling rice, softening butter, bringing eggs or meat to room temperature, and thawing all count.
- The test: could the cook get it done before they start cooking, and must it be finished before the rest of the recipe can go on? "Chill the dough for at least 2 hours" before shaping and baking passes, so the chill is ahead, and so is every step that makes that dough.
- Everything upstream of ahead work is ahead too: the marinade mixed for an overnight marinade, and every step making a dough that is then chilled, the dry mix and the wet mix included. If a task feeds ahead work, it is ahead, never mise.
- Ingredient lines imply ahead work: "butter, softened", "eggs, at room temperature", "rice, cooked and chilled overnight", "shrimp, thawed" each need an implied ahead task.
- Long waits that are the cooking itself are not ahead (simmer 1 hour, roast 50 minutes, soaking chiles right after toasting them). They are cook tasks.
- Waits under 30 minutes are not ahead: a 15-minute marinade or a 20-minute quick pickle is mise.

**mise**: work on an ingredient on the day, before it is combined or heated:
- cuts: slice, dice, chop, mince, julienne, score, trim, halve, shred, quarter, tear;
- other single-ingredient work: peel, core, seed, grate, zest, juice into a measure, crush, beat eggs, rinse, drain, pat dry, break up cold rice, brew coffee;
- a separate mix whisked or stirred in its own bowl, then added to the main pan or bowl or served alongside as a unit: a sauce, dressing, raita, slurry, pickle brine, dry mix, wet mix, or a marinade of under 30 minutes. List every ingredient in the mix. When two mixes are combined (wet into dry), both are mise and the combining is cook.
- An ingredient line that names the work ("garlic, minced", "chopped parsley", "grated Parmesan", "shredded cabbage", "crumbled feta", "1 onion, quartered", "1 lemon, juiced") needs a mise task even when no step mentions it, and even when the ingredient is used at the moment of use.

**cook**: everything else.
- Anything with heat: toasting, charring, blanching, anything in a pan or oven. Work done to something after it has been heated is cook too.
- The main build: the step that brings mixes together, and each step in the main pan, bowl or tray, even with no heat.
- Seasoning a protein just before it cooks. (Salt that rests 30+ minutes is a dry brine: ahead.)
- Work at the moment of use: squeezing a lemon over the plate. (An ingredient line that names the work still wins: "grated Parmesan" is mise.)
- Measuring and seasoning to taste are not mise; do not make tasks for them.

# Tasks

- Keep each step's cook work as one cook task, using the step's own words as its text. Split a step only to pull its prep out as separate mise or ahead tasks: "Dice the onion and add it to the pan" becomes a mise task (dice the onion) and a cook task (add it to the pan), and "Rinse the lentils and simmer them" becomes a mise task (rinse the lentils) and a cook task (simmer them).
- A step that is all prep is one mise or ahead task (or several, one per ingredient or mix).
- Implied tasks (sourceStep null, implied true) are only for prep the recipe assumes: an ingredient line that names work, or a step that uses a prepared ingredient no step prepares ("add the chopped onion"). Go through the ingredient lines one by one and give each line that names work its own task, unless a step states that work. Never invent cook tasks.
- Drop timing words from task text: no "meanwhile", "while the chicken roasts", "in the meantime". The app decides timing.

# Fields

- id: short, unique, lowercase with hyphens ("chop-onion").
- kind: "ahead" | "mise" | "cook".
- text: one imperative instruction in the recipe's words. Every number in a step (quantities, temperatures, times, sizes) must appear, with its unit, in the text of a task that cites that step; a step that says a number twice needs it said twice. An ahead task may carry its time in the lead instead. A number only in the cue does not count, because the cook reads the text: "about 15 minutes" belongs in the text even when the cue repeats it.
- label: 1 to 3 lowercase words, imperative, verb first ("soak chickpeas", "chop onion", "roast chicken"). It is read as "before you {label}".
- ingredientIdx: indices of the ingredients the task works on or adds, not ones already in a mixture an earlier task made ("fry the doughnuts" lists the fat, not the dough's flour and eggs). When the steps end with their ingredients ("(ingredients: 0, 3)"), a cook task's come only from the step it cites. A mise or ahead task lists the ingredients it readies, whichever step uses them.
- sourceStep: index of the step the task comes from, or null when implied. Every step must be cited by at least one task.
- implied: true exactly when sourceStep is null.
- needs: ids of tasks that must finish before this one starts: the prep that readies its ingredients, and the previous task in the same pot, pan, bowl or tray. Only real dependencies. The app keeps recipe order within a branch, but orders tasks in different branches only by their needs: when a task must wait for work in another branch (the tempering poured over the cooked dal), it needs that task. A mise task never needs a cook task. An ahead task only needs ahead tasks: when it needs a task you tagged mise, retag that task ahead.
- minutes: { "est": whole-task minutes (your estimate when the recipe gives none, 1 to 1440), "handsOff": true when the task contains a stretch of 5+ minutes where the cook's hands are free }. Simmering, roasting, baking, steaming, resting, chilling, soaking, marinating, preheating an oven, bringing water to a boil, and sautéing 5+ minutes with only occasional stirring or a single turn ("4 minutes per side") are hands-off. Stir-frying and constant stirring are not, and neither is heating oil, ghee or a pan (a minute or two). handsOff is never true when est is under 5. A "meanwhile" in the next step means this one is hands-off.
- cue: the doneness cue in the recipe's words ("until golden at the edges"), else null.
- lead: ahead tasks only, how far ahead ("overnight", "at least 4 hours", "1 hour before"), else null.
- branch: the component the task builds, as a short title ("Sauce", "Chicken", "Salad"). Use "Cook" for every task when the recipe builds one thing. Ahead and mise tasks take the branch of the task that uses them.

Every plan has at least one cook task, and the needs never form a cycle.

Every task is needed by another task, except where a branch finishes. A branch finishes at most once, on a cook task from a recipe step (never implied) that needs at least one task. Mise and ahead tasks are always needed by the task that uses them. A step that stands apart, like preheating the oven or boiling the water, is needed by the task that uses the oven or the water.

# Example

${EXAMPLE}

Return only the JSON object {"tasks": [...]}.`;

/** A reply the validator turned down, kept so the failure can be read later. */
export interface CookPlanRejection {
  /** Which model call of the derivation gave it, from 1. */
  call: number;
  /** Parsed JSON, or the text when it was not JSON. */
  raw: unknown;
  rule: CookPlanRule;
  detail: string;
}

export interface CookPlanDerivation {
  /** The model's last output: parsed JSON, or the text when it was not JSON. */
  raw: unknown;
  result: CookPlanParseResult;
  /** Every rejected reply in order, the last one included when `result` is. */
  rejections: CookPlanRejection[];
}

/**
 * A derivation that threw after the validator had already turned down a
 * reply (the re-ask timed out, failed or was blocked). It carries those
 * rejections so the caller can keep them.
 */
export class CookPlanDerivationError extends Error {
  constructor(
    message: string,
    readonly rejections: CookPlanRejection[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CookPlanDerivationError";
  }
}

/**
 * The most tokens one model call can be billed, known before it is made.
 * Output is the call's `maxTokens` (thinking included), which the provider
 * enforces. Input is the UTF-8 bytes of everything sent (system prompt,
 * response schema, every message) plus `CALL_OVERHEAD_TOKENS`: Gemini's
 * tokenizer, like any SentencePiece one with byte fallback, never spends more
 * than one token per byte, and the overhead covers role markers and the
 * schema's framing. That is about 12,500 for a first call against about
 * 3,300 estimated (P "Cost"), and a ledger counts any call whose reported
 * usage passes its bound, so the first paid run checks the assumption.
 */
export interface CallBound {
  inputTokens: number;
  outputTokens: number;
}

export const CALL_OVERHEAD_TOKENS = 1_024;

const encoder = new TextEncoder();
function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

const FIXED_INPUT_BYTES =
  utf8Bytes(COOK_PLAN_SYSTEM_PROMPT) +
  utf8Bytes(JSON.stringify(COOK_PLAN_RESPONSE_SCHEMA));

function callBound(messages: readonly AIMessage[], maxTokens: number): CallBound {
  const messageBytes = messages.reduce((sum, m) => sum + utf8Bytes(m.content), 0);
  return { inputTokens: FIXED_INPUT_BYTES + messageBytes + CALL_OVERHEAD_TOKENS, outputTokens: maxTokens };
}

/** One model call's tokens, as the provider reported them, with the bound it was made under. */
export interface DerivationUsage {
  call: number;
  inputTokens: number;
  outputTokens: number;
  bound: CallBound;
  /** False when the call was refused before reaching the provider (allowance or unpriced model). */
  sent?: false;
}

/**
 * A paid run's say over each call (slice P, "Cost"): `beforeCall` is asked
 * before every model call with that call's bound and may refuse it;
 * `onUsage` hears every call it allowed, answered or thrown.
 */
export interface DeriveMeter {
  beforeCall(bound: CallBound, call: number): boolean;
  onUsage(usage: DerivationUsage): void;
}

export interface DeriveOptions extends Partial<DeriveMeter> {
  /** Defaults to COOK_PLAN_THINKING_BUDGET; the eval script varies it. */
  thinkingBudget?: number;
  /** Metering context for each model call made by this derivation. */
  meter: AiMeter;
}

/**
 * A `beforeCall` refused a call: the run's cap has no room for it. Not a
 * failure of the recipe, so it is never stored as one: `deriveCookPlan` and
 * `deriveCookPlanOutcome` both let it through as is, and the paid run that
 * refused stops (the recipe is left for its next run). A refused re-ask
 * comes after a reply the validator turned down, so it carries the
 * rejections received before it, for the caller to log.
 */
export class CookPlanCapReached extends Error {
  constructor(
    readonly call: number,
    readonly bound: CallBound,
    readonly rejections: readonly CookPlanRejection[] = [],
  ) {
    super(`The run's cap has no room for call ${call} of this derivation`);
    this.name = "CookPlanCapReached";
  }
}

function parseJson(content: string): unknown {
  const fenced = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  try {
    return JSON.parse(fenced ? fenced[1] : content);
  } catch {
    return undefined;
  }
}

/**
 * How to fix each rule a model fixed the wrong way, or never heard of, in
 * R31's library backfill. One per rule broken goes in the re-ask. Each states
 * what the rule enforces, then the moves the system prompt itself allows,
 * pointing at the prompt's own deciding rule. A hint never forbids a move the
 * prompt allows, and hints printed together must be satisfiable together:
 * dan dan prints the first two, and both its fixes (the sauce made on the day,
 * or the whole sauce chain made the day before) follow both.
 */
export const REASK_HINTS = {
  // Dan dan noodles: grinding toasted peppercorns was tagged mise.
  "mise-needs-cook":
    'A mise task can\'t need a cook task, because mise is finished before cooking starts. If the mise task feeds ahead work that really is done before the cook, it is ahead, and so is everything upstream of it, the cook task it needs included ("Everything upstream of ahead work is ahead too"). Otherwise it is work done to something after it has been heated, which is cook ("Work done to something after it has been heated is cook too"): retag the mise task cook, and any mise task that needs it cook as well. If the mise task doesn\'t really need that cook task (a wrong need on preheating the oven or boiling the water), drop the need ("Only real dependencies"). Retag consistently along the whole chain.',
  // Onion torta: an overnight cool needed a cook bake, and the model made
  // the cool cook instead of making the bakes ahead. Wings: a marinade's prep
  // left mise.
  "ahead-needs-later":
    'An ahead task can need only ahead tasks, because ahead work is finished before cooking starts. Decide by when the ahead task actually happens. If it is done before the cook (an overnight chill or cool, a marinade of 30 minutes or more), retag what it needs ahead, and everything upstream of that ("Everything upstream of ahead work is ahead too"). If it really happens during the cook, like soaking chiles right after toasting them, it is cook ("Long waits that are the cooking itself are not ahead"): retag the ahead task cook.',
  // Onion torta: "chill 1 h" and "freeze 30 min" written as leads, so the
  // overnight cool needed work with shorter leads.
  // New with intake's mapping (cook-fidelity plan): the bound a step's
  // ingredient list sets on its cook tasks.
  "ingredient-outside-step":
    'A cook task lists only ingredients of the step it cites, the ones that step ends with ("(ingredients: …)"). Take the ingredient off that task. If the task readies it before the cook (a cut, a separate mix), that work is a mise or ahead task, which may list it ("Split a step only to pull its prep out as separate mise or ahead tasks"); if a different step adds it, it belongs on that step\'s cook task.',
  "lead-order":
    'A lead counts back from the start of the cook, not from the task that uses it, so anything an ahead task needs must lead at least as far back as that task does. Give tasks done together the same lead in the same words: "overnight" and "the day before" are different leads. Keep the recipe\'s times in the task\'s text or its lead ("chill it for 1 hour", "at least 4 hours"), because that is where the numbers are checked, not in minutes.',
} as const satisfies Partial<Record<CookPlanRule, string>>;

function hintFor(rule: CookPlanRule): string | undefined {
  return (REASK_HINTS as Partial<Record<CookPlanRule, string>>)[rule];
}

/**
 * The re-ask after a rejected reply. Asking again with the same prompt gets
 * the same plan back (four identical rejections in prod, 2026-10-04), so the
 * model sees its reply and every rule it broke, numbered as the prompt
 * numbers steps, with a fix for each rule that has one (`REASK_HINTS`). Told
 * only the first rule, the model fixed that one and failed the last call on
 * a second it was never told about (R31: 3 of 39 library plans). An
 * uncovered-step rejection quotes every uncited step: a recipe extracted as
 * many one-clause steps gets its short neighbours merged into one task, which
 * cites only one of them (peanut chutney, R31: 18 uncited), and naming only
 * the first fixed one step per call. A failure without `violations` (built by
 * hand) is its own only violation.
 */
export function correctionPrompt(
  failure: CookPlanViolation & { violations?: readonly CookPlanViolation[] },
  recipe: RecipeForPlan,
): string {
  const steps = recipe.steps ?? [];
  const list = failure.violations && failure.violations.length > 0 ? failure.violations : [failure];
  const uncoveredSteps = list.find((v) => v.rule === "uncovered-step")?.uncoveredSteps ?? [];
  const uncited = uncoveredSteps.map((i) => `[${i}] ${steps[i]}`);
  const hints = [...new Set(list.map((v) => v.rule))].flatMap((rule) => hintFor(rule) ?? []);
  const correct = `Correct it, following every rule above, and return the whole plan again as the JSON object {"tasks": [...]}.`;
  const cites = `A task cites one step (its sourceStep), so a task that merged a step with its neighbour covers only the step it cites. Give each of these steps a task whose sourceStep is its index:`;

  if (list.length === 1) {
    const rejected = `The app rejected that plan (${list[0].rule}): ${list[0].detail}.`;
    if (uncited.length === 0) return [rejected, ...hints, correct].join(" ");
    return `${rejected} ${cites}
${uncited.join("\n")}
${[...hints, correct].join(" ")}`;
  }
  return [
    "The app rejected that plan. It breaks these rules:",
    ...list.map((v) => `- (${v.rule}): ${v.detail}`),
    ...(uncited.length > 0 ? [cites, ...uncited] : []),
    ...hints,
    correct,
  ].join("\n");
}

/**
 * Derive and validate a plan. A rejected plan goes back to the model once,
 * with every rule it broke (`correctionPrompt`), and a truncated reply is
 * retried once with a larger budget, so a derivation makes
 * at most three calls. Throws when the recipe has no steps, when the model
 * call fails, is blocked or passes the deadline, or when the output is
 * truncated twice; everything else comes back as a result, so the caller can
 * store why a plan was rejected. A throw after a rejected reply is a
 * `CookPlanDerivationError` carrying the rejections.
 */
export async function deriveCookPlan(
  recipe: RecipeForPlan,
  options: DeriveOptions,
): Promise<CookPlanDerivation> {
  if (!hasStepsToPlan(recipe)) {
    throw new Error("Cannot derive a cook plan: the recipe has no steps");
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), COOK_PLAN_TIMEOUT_MS);
  const rejections: CookPlanRejection[] = [];
  try {
    return await derive(recipe, options, deadline.signal, rejections);
  } catch (err) {
    if (err instanceof CookPlanCapReached) throw err;
    const error =
      deadline.signal.aborted && !isAllowanceUsed(err)
        ? new Error(
            `Cook plan derivation timed out after ${COOK_PLAN_TIMEOUT_MS / 1000} s`,
          )
        : err;
    if (rejections.length === 0) throw error;
    throw new CookPlanDerivationError(
      error instanceof Error ? error.message : String(error),
      rejections,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A derivation as something to store: the plan, or the error text that
 * names why there is none (`rejected (<rule>): <detail>` when the validator
 * refused, else the thrown message), with every rejected reply for the log.
 * The error text is what `isSettledPlanError` classifies. Never throws,
 * except `CookPlanCapReached` when a `beforeCall` refuses a call or
 * `AllowanceUsedError` when a monthly AI cap is reached.
 */
export type DerivedCookPlan =
  | { plan: CookPlan; error: null; rejections: CookPlanRejection[] }
  | { plan: null; error: string; rejections: CookPlanRejection[] };

export async function deriveCookPlanOutcome(
  recipe: RecipeForPlan,
  options: DeriveOptions,
): Promise<DerivedCookPlan> {
  try {
    const { result, rejections } = await deriveCookPlan(recipe, options);
    return result.ok
      ? { plan: result.plan, error: null, rejections }
      : { plan: null, error: rejectedPlanError(result.rule, result.detail), rejections };
  } catch (err) {
    if (err instanceof CookPlanCapReached || isAllowanceUsed(err)) throw err;
    return {
      plan: null,
      error: err instanceof Error ? err.message : String(err),
      rejections: err instanceof CookPlanDerivationError ? err.rejections : [],
    };
  }
}

async function derive(
  recipe: RecipeForPlan,
  options: DeriveOptions,
  signal: AbortSignal,
  rejections: CookPlanRejection[],
): Promise<CookPlanDerivation> {
  const thinkingBudget = options.thinkingBudget ?? COOK_PLAN_THINKING_BUDGET;
  const messages: AIMessage[] = [{ role: "user", content: recipePrompt(recipe) }];
  let output = OUTPUT_TOKENS;

  for (let call = 1; ; call++) {
    // A provider may not honour a signal that aborted before its call.
    signal.throwIfAborted();
    const maxTokens = output + thinkingBudget;
    const bound = callBound(messages, maxTokens);
    if (options.beforeCall && !options.beforeCall(bound, call)) {
      throw new CookPlanCapReached(call, bound, [...rejections]);
    }
    let response: Awaited<ReturnType<typeof chat>>;
    try {
      response = await chat(
        {
          systemPrompt: COOK_PLAN_SYSTEM_PROMPT,
          messages: [...messages],
          responseFormat: "json",
          responseSchema: COOK_PLAN_RESPONSE_SCHEMA,
          thinkingBudget,
          maxTokens,
          signal,
        },
        options.meter,
      );
    } catch (err) {
      // A call that failed (a timeout may still be billed) reports no
      // tokens, so a paid run's ledger charges it at its bound. A call
      // refused before reaching the provider releases its bound with sent: false.
      const notSent = isAllowanceUsed(err) || isUnpricedModel(err);
      options.onUsage?.({
        call,
        inputTokens: 0,
        outputTokens: 0,
        bound,
        ...(notSent ? { sent: false as const } : {}),
      });
      throw err;
    }
    options.onUsage?.({
      call,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      bound,
    });
    if (response.finishReason === "max_tokens") {
      if (output === OUTPUT_TOKENS_RETRY) {
        throw new Error(COOK_PLAN_TOKEN_LIMIT);
      }
      output = OUTPUT_TOKENS_RETRY;
      continue;
    }
    if (response.finishReason === "blocked") {
      throw new Error(COOK_PLAN_BLOCKED);
    }

    const parsed = parseJson(response.content);
    const raw = parsed === undefined ? response.content : parsed;
    const result: CookPlanParseResult =
      parsed === undefined
        ? {
            ok: false,
            rule: "shape",
            detail: "the response was not JSON",
            violations: [{ rule: "shape", detail: "the response was not JSON" }],
          }
        : parseCookPlan(parsed, recipe);
    if (!result.ok) {
      rejections.push({ call, raw, rule: result.rule, detail: result.detail });
    }
    if (result.ok || rejections.length === 2) {
      return { raw, result, rejections };
    }
    messages.push(
      { role: "assistant", content: response.content },
      { role: "user", content: correctionPrompt(result, recipe) },
    );
  }
}
