/**
 * The intake pass (cook-fidelity plan, decisions 1-4): a recipe the webhook
 * queues is cut to the app's own import rules before anyone cooks it. Each
 * step one stretch of work ending at a natural pause, a source step split
 * only where it holds two, never inside a sentence into fragments (standing
 * agent call, DECISIONS 2026-10-26); one ingredient per line; and each step's
 * ingredients (`stepIngredients`) placed where the import prompt places
 * them: seasonings at first use, garnish at the finish, a single ingredient
 * readied earlier again where it goes into the dish.
 *
 * The agent's recipe is serialized to text (`intakeText`) and run through the
 * import's own text extraction (`extractRecipeFromText`, which grounds it
 * against that text and validates its shape). What comes back is checked
 * against the original by `checkIntake` before it is trusted: every number
 * kept both ways (nothing dropped, nothing added), and kept in the steps cut
 * from the source step that stated it (`moved-number`); the words of every
 * step and ingredient line kept; no step merged away, left empty or cut into
 * a fragment; and a step mapping for every step, read as the model gave it
 * (`keepStepIngredients`, since the cook plan trusts it as a bound): no index
 * naming no line, no line a step names left on no step (one no step names
 * is only noted, `unmentioned-ingredient`), no step listing nothing while it
 * names an ingredient no step before it lists. A reply that fails is sent
 * back once with what was wrong; a second failure is the row's
 * `intake_error`, and the cook view shows the recipe as sent (explicit and
 * logged, never silent). Two rules are nudges rather than refusals (`soft`):
 * a split off the rule's seams (`unpausedSplits`) and a line still naming
 * two ingredients (`crowdedLines`), both read from wording, are sent back
 * once, and a second cut that still has one is kept, the nudge logged,
 * since a cut a step too fine or a line short of split still reads better
 * than the recipe as sent.
 *
 * An error is settled (the same text would fail the same way: a refused
 * cut, no recipe found, a reply that never parsed, another refused request)
 * or for now (a timeout, a rate limit, a provider's 5xx, a dropped
 * connection, a missing or refused key, which config fixes:
 * `isTransientModelError`), told apart by `isSettledIntakeError`. A settled
 * one is final. One for now is tried again, at most `INTAKE_MAX_TRIES` times
 * in all, the last settling it; and never once a cook has started on the
 * recipe as sent, which settles the row as sent (`ensureIntake`'s asks;
 * DECISIONS 2026-10-26, intake round 3).
 *
 * Intake only changes the ingredients, the steps and their mapping. The name,
 * serving count, notes, tags, times and source are the original's, copied,
 * never re-extracted: the notes aren't even sent, so the model can't turn a
 * note into a step.
 *
 * Non-goals (plan): no judging of taste or proportion, no rewording of steps.
 */

import { createHash } from "node:crypto";
import type { ChatRecipeIngredient, KitchenQueueRecipeData } from "../../../drizzle/schema";
import { isAllowanceUsed, type AiMeter } from "../ai";
import { quantitiesIn } from "../kitchen/cook-plan";
import { ingredientToString } from "../kitchen/step-ingredients";
import { groundingWords } from "../recipe-grounding";
import {
  TransientModelError,
  RECIPE_IMPORT_PROMPT,
  extractRecipeFromText,
  type ExtractionUsage,
  type ImportedRecipe,
} from "../recipe-import";
import { isBlankLine, isBlankStep, legacyToPackRecipe, type ServesEstimateInput } from "./convert";
import { alignSteps, crowdedLines, fragmentSteps, ingredientNames, namedLines, unpausedSplits } from "./intake-cut";
import { INTAKE_FOR_NOW } from "./intake-state";

/**
 * Bump when what intake sends, keeps or checks changes; recorded on each
 * row's outcome. 3: numbers checked per source step, the step mapping
 * checked unscrubbed (round-3 review, S3 and C1).
 */
export const INTAKE_VERSION = 3;

/**
 * How long one intake may take, every call together: at most two attempts,
 * each with the extraction's own retry on truncation. An extraction takes
 * 5-20 s; the deadline keeps a hung call from holding the request or the
 * `after()` behind it.
 */
export const INTAKE_TIMEOUT_MS = 90_000;

/**
 * Gemini thinking tokens per intake call, on top of the output budget. With
 * none (the import's default) the model cut the same recipe a different way
 * run to run: split F1 0.36 to 1.0 over six eval runs on the final prompt and
 * checks. With 1024 it cut all three runs at the gold's seams (split F1 1.0),
 * for about a cent more a call and a few seconds (standing agent call,
 * DECISIONS 2026-10-26). Part of the stamp.
 */
export const INTAKE_THINKING_BUDGET = 1024;

/** `"<version>:<16 hex of the import prompt and the thinking budget>"`: what made a row's intake. */
export function intakeStamp(): string {
  const hash = createHash("sha256")
    .update(`${RECIPE_IMPORT_PROMPT}\nthinking ${INTAKE_THINKING_BUDGET}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${INTAKE_VERSION}:${hash}`;
}

// ---------------------------------------------------------------------------
// The text sent
// ---------------------------------------------------------------------------

/**
 * The recipe as text for the extraction: its name, its ingredient lines and
 * its numbered steps, each as stored. Blank lines and steps carry nothing and
 * are left out. Notes, serving count, tags and times are not sent: intake
 * keeps the original's.
 */
export function intakeText(recipe: KitchenQueueRecipeData): string {
  const lines = (recipe.ingredients ?? []).filter((line) => !isBlankLine(line));
  const steps = (recipe.steps ?? []).filter((step) => !isBlankStep(step));
  const parts = [recipe.name.trim()];
  if (lines.length > 0) {
    parts.push(["Ingredients:", ...lines.map((line) => `- ${ingredientToString(line).trim()}`)].join("\n"));
  }
  if (steps.length > 0) {
    parts.push(["Steps:", ...steps.map((step, i) => `${i + 1}. ${step.trim()}`)].join("\n"));
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// The recipe kept
// ---------------------------------------------------------------------------

function cleanLine(line: ChatRecipeIngredient): ChatRecipeIngredient {
  return {
    item: line.item,
    ...(line.amount ? { amount: line.amount } : {}),
    ...(line.unit ? { unit: line.unit } : {}),
  };
}

/**
 * The normalized recipe: the extraction's ingredients, steps and step
 * mapping (an index listed twice on a step kept once); everything else the
 * original's, as stored. The mapping is the model's own, unscrubbed: the
 * check refuses an index that names no line.
 */
export function mergeIntake(
  original: KitchenQueueRecipeData,
  extracted: Pick<ImportedRecipe, "ingredients" | "steps" | "stepIngredients">,
): KitchenQueueRecipeData {
  const { ingredients: _i, steps: _s, stepIngredients: _m, ...kept } = original;
  return {
    ...kept,
    ingredients: (extracted.ingredients ?? []).map(cleanLine),
    steps: extracted.steps ?? [],
    ...(extracted.stepIngredients !== undefined && {
      stepIngredients: extracted.stepIngredients.map((ids) => [...new Set(ids)]),
    }),
  };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export type IntakeRule =
  | "dropped-number"
  | "added-number"
  | "moved-number"
  | "merged-steps"
  | "empty-step"
  | "fragment-step"
  | "unpaused-split"
  | "crowded-line"
  | "lost-words"
  | "added-words"
  | "lost-ingredient-words"
  | "no-step-ingredients"
  | "bad-step-ingredients"
  | "unplaced-ingredient"
  | "unmentioned-ingredient"
  | "unlisted-ingredient"
  | "unreadable";

export interface IntakeViolation {
  rule: IntakeRule;
  detail: string;
  /** A nudge: re-asked once, but a second cut that still has it is kept. */
  soft?: true;
  /**
   * Logged only (always `soft` too): never sent back, so a cut whose only
   * faults are notes is kept on its first reply, with them as its nudges.
   * For what a re-ask could only answer by inventing (round-4 review, SF2).
   */
  note?: true;
}

/**
 * How many word occurrences of the original steps the cut may lose (each
 * occurrence counted: a clause dropped whole loses its words even when they
 * appear in other steps): at most 2, or 3% of them in a long recipe. A split
 * keeps the source's words ("Salt the mushrooms" from "...; salt, then set
 * half aside"), so the allowance is only for a word tidied away. And the
 * share of the cut's distinct step words the recipe must give.
 */
export const STEP_WORDS_LOST_MIN = 2;
export const STEP_WORDS_LOST_SHARE = 0.03;
export const STEP_WORDS_GROUNDED = 0.9;

function numbersOf(texts: readonly string[]): string[] {
  return texts.flatMap((text) =>
    quantitiesIn(text, { wordsNeedUnit: true }).map((q) => String(Number(q.value.toFixed(4)))),
  );
}

/** What `a` has that `b` hasn't, counting each occurrence. */
function multisetMinus(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

function lineTexts(recipe: KitchenQueueRecipeData): string[] {
  return (recipe.ingredients ?? []).filter((line) => !isBlankLine(line)).map(ingredientToString);
}

function stepTexts(recipe: KitchenQueueRecipeData): string[] {
  return (recipe.steps ?? []).filter((step) => !isBlankStep(step));
}

function wordsOf(texts: readonly string[]): string[] {
  return texts.flatMap(groundingWords);
}

/** Distinct words of `texts` (`groundingWords`: stemmed, common words dropped). */
function wordSet(texts: readonly string[]): Set<string> {
  return new Set(wordsOf(texts));
}

function coverage(wanted: Set<string>, have: Set<string>): { share: number; missing: string[] } {
  if (wanted.size === 0) return { share: 1, missing: [] };
  const missing = [...wanted].filter((w) => !have.has(w));
  return { share: (wanted.size - missing.length) / wanted.size, missing };
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * What is wrong with the steps' mapping (`stepIngredients`), the bound the
 * cook plan trusts (`stepIngredientBounds`; round-3 review, C1): an index
 * that names no line, a line on no step, and a step that lists nothing but
 * names an ingredient no step before it lists. A step naming one an earlier
 * step listed may list nothing: the import prompt lists an ingredient where
 * it is first used (a pot of beans simmering names the beans). A line on no
 * step that no step names ("chili crisp, optional") is only noted
 * (`unmentioned-ingredient`): no step uses it, so any placement would be
 * invented (round-4 review, SF2). Checked only on a mapping of the right
 * length (`no-step-ingredients` covers the rest).
 */
function mappingViolations(steps: readonly string[], lines: readonly ChatRecipeIngredient[], map: readonly number[][]): IntakeViolation[] {
  const violations: IntakeViolation[] = [];
  const bad = map.flatMap((ids, s) => {
    const off = ids.filter((id) => !Number.isInteger(id) || id < 0 || id >= lines.length);
    return off.length > 0 ? [`step ${s + 1} lists ${off.join(", ")}`] : [];
  });
  if (bad.length > 0) {
    violations.push({
      rule: "bad-step-ingredients",
      detail: `${bad.join("; ")}, which names no ingredient line (there are ${lines.length})`,
    });
    return violations;
  }
  const line = (i: number) => `line ${i + 1} ("${ingredientToString(lines[i]!).trim()}")`;
  const placed = new Set(map.flat());
  const named = new Set(steps.flatMap((step) => namedLines(step, lines).flat()));
  const off = lines.flatMap((l, i) => (isBlankLine(l) || placed.has(i) ? [] : [i]));
  const unplaced = off.filter((i) => named.has(i)).map(line);
  const unmentioned = off.filter((i) => !named.has(i)).map(line);
  if (unplaced.length > 0) {
    violations.push({
      rule: "unplaced-ingredient",
      detail: `${unplaced.join(", ")} ${unplaced.length === 1 ? "is" : "are"} on no step; list each ingredient where it is used, a garnish on the step that adds it`,
    });
  }
  if (unmentioned.length > 0) {
    violations.push({
      rule: "unmentioned-ingredient",
      detail: `${unmentioned.join(", ")} ${unmentioned.length === 1 ? "is" : "are"} on no step, and no step names ${unmentioned.length === 1 ? "it" : "them"}`,
      soft: true,
      note: true,
    });
  }
  const listed = new Set<number>();
  const unlisted: string[] = [];
  steps.forEach((step, s) => {
    const ids = map[s] ?? [];
    if (ids.length === 0) {
      // A word naming several lines is one an earlier step listed, if any is.
      const named = [
        ...new Set(
          namedLines(step, lines)
            .filter((group) => !group.some((i) => listed.has(i)))
            .flat()
            .filter((i) => !isBlankLine(lines[i]!)),
        ),
      ];
      if (named.length > 0) {
        unlisted.push(`step ${s + 1} ("${step}") lists nothing but names ${named.map(line).join(", ")}, which no step before it lists`);
      }
    }
    for (const id of ids) listed.add(id);
  });
  if (unlisted.length > 0) violations.push({ rule: "unlisted-ingredient", detail: unlisted.join("; ") });
  return violations;
}

/**
 * The numbers each source step lost or gained across the steps cut from it
 * (`alignSteps`), when the steps as a whole kept every one: a number moved
 * between steps ("Simmer 25 min" and "Rest 5 min" swapped). A source step
 * whose pieces keep its numbers but not their order, read piece by piece in
 * the cut's order, had two swapped between its pieces ("toast 2 min …
 * simmer 25 min" cut to "toast 25 min" and "simmer 2 min"; round-4 review,
 * SF1): a split keeps the source's sentences in order, so it keeps its
 * numbers in order.
 */
function movedNumbers(originalSteps: readonly string[], steps: readonly string[]): string[] {
  const aligned = alignSteps(originalSteps, steps);
  return originalSteps.flatMap((source, k) => {
    const cut = steps.filter((_, i) => aligned[i] === k);
    const was = numbersOf([source]);
    const now = numbersOf(cut);
    const lost = multisetMinus(was, now);
    const gained = multisetMinus(now, was);
    if (lost.length === 0 && gained.length === 0) {
      if (was.join() === now.join()) return [];
      return [`the steps cut from source step ${k + 1} reorder its numbers: ${was.join(", ")} became ${now.join(", ")}`];
    }
    const what = [lost.length > 0 && `lost ${lost.join(", ")}`, gained.length > 0 && `gained ${gained.join(", ")}`].filter(Boolean);
    return [`the steps cut from source step ${k + 1} ${what.join(" and ")}`];
  });
}

/**
 * What is wrong with `normalized` as a faithful cut of `original`; empty when
 * nothing is. Numbers are compared per part (ingredient lines, steps) as
 * values, each occurrence counted, both ways: the cut may move words between
 * steps but never change, drop or add a number, and never move one between a
 * line and a step, nor between source steps (each source step's numbers
 * against the steps cut from it). The mapping is checked as the plan will
 * trust it (`mappingViolations`). With `servesEstimate`, the normalized
 * recipe must also read as a pack recipe, as the cook page will read it.
 */
export function checkIntake(
  original: KitchenQueueRecipeData,
  normalized: KitchenQueueRecipeData,
  { servesEstimate }: { servesEstimate?: ServesEstimateInput } = {},
): IntakeViolation[] {
  const violations: IntakeViolation[] = [];
  const parts: [string, string[], string[]][] = [
    ["the ingredient lines", lineTexts(original), lineTexts(normalized)],
    ["the steps", stepTexts(original), stepTexts(normalized)],
  ];
  for (const [part, before, after] of parts) {
    const dropped = multisetMinus(numbersOf(before), numbersOf(after));
    const added = multisetMinus(numbersOf(after), numbersOf(before));
    if (dropped.length > 0) {
      violations.push({ rule: "dropped-number", detail: `${part} lost ${dropped.join(", ")}` });
    }
    if (added.length > 0) {
      violations.push({ rule: "added-number", detail: `${part} gained ${added.join(", ")}` });
    }
  }

  const steps = normalized.steps ?? [];
  const originalSteps = stepTexts(original);
  const before = numbersOf(originalSteps);
  const after = numbersOf(stepTexts(normalized));
  const stepsKept = multisetMinus(before, after).length === 0 && multisetMinus(after, before).length === 0;
  if (stepsKept && stepTexts(normalized).length >= originalSteps.length) {
    const moved = movedNumbers(originalSteps, stepTexts(normalized));
    if (moved.length > 0) violations.push({ rule: "moved-number", detail: moved.join("; ") });
  }
  if (stepTexts(normalized).length < originalSteps.length) {
    violations.push({
      rule: "merged-steps",
      detail: `${originalSteps.length} steps came back as ${stepTexts(normalized).length}; split steps, never merge them`,
    });
  }
  const empty = steps.flatMap((step, i) => (/\p{L}/u.test(step) ? [] : [i]));
  if (empty.length > 0) {
    violations.push({ rule: "empty-step", detail: `step(s) ${empty.join(", ")} say nothing` });
  }
  const fragments = fragmentSteps(steps, {
    names: ingredientNames(normalized.ingredients ?? []),
    sourceSteps: originalSteps,
  });
  if (fragments.length > 0) {
    violations.push({
      rule: "fragment-step",
      detail: fragments.map((f) => `step ${f.index + 1} ${f.reason}: "${f.step}"`).join("; "),
    });
  }
  const unpaused = unpausedSplits(originalSteps, stepTexts(normalized));
  if (unpaused.length > 0) {
    violations.push({
      rule: "unpaused-split",
      detail: unpaused.map((u) => `step ${u.index + 1} ("${u.step}") ${u.reason}`).join("; "),
      soft: true,
    });
  }

  const originalWords = wordsOf(originalSteps);
  const lost = multisetMinus(originalWords, wordsOf(steps));
  if (lost.length > Math.max(STEP_WORDS_LOST_MIN, Math.floor(originalWords.length * STEP_WORDS_LOST_SHARE))) {
    violations.push({
      rule: "lost-words",
      detail: `the steps lost ${lost.length} of the original steps' ${originalWords.length} words: ${lost.join(", ")}`,
    });
  }
  const given = wordSet([...originalSteps, ...lineTexts(original), original.name]);
  const grounded = coverage(wordSet(steps), given);
  if (grounded.share < STEP_WORDS_GROUNDED) {
    violations.push({
      rule: "added-words",
      detail: `${pct(1 - grounded.share)} of the steps' words aren't in the recipe: ${grounded.missing.join(", ")}`,
    });
  }
  const crowded = crowdedLines(normalized.ingredients ?? []);
  if (crowded.length > 0) {
    violations.push({
      rule: "crowded-line",
      detail: `${crowded.map((c) => `line ${c.index + 1} ("${c.line}")`).join(", ")} still names two ingredients: one line each, each keeping its own words`,
      soft: true,
    });
  }
  // Every word of every line, each occurrence: a split line keeps all its
  // words, and a dropped ingredient is often one word ("chives").
  const lostLines = multisetMinus(wordsOf(lineTexts(original)), wordsOf(lineTexts(normalized)));
  if (lostLines.length > 0) {
    violations.push({
      rule: "lost-ingredient-words",
      detail: `the ingredient lines lost ${lostLines.join(", ")}`,
    });
  }

  if (steps.length > 0 && normalized.stepIngredients?.length !== steps.length) {
    violations.push({
      rule: "no-step-ingredients",
      detail: "stepIngredients must have one entry per step",
    });
  } else if (steps.length > 0) {
    violations.push(...mappingViolations(steps, normalized.ingredients ?? [], normalized.stepIngredients ?? []));
  }

  if (servesEstimate !== undefined || typeof normalized.serves === "number") {
    const converted = legacyToPackRecipe(normalized, { id: "intake", servesEstimate });
    if (!converted.ok) {
      violations.push({
        rule: "unreadable",
        detail: converted.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      });
    }
  }
  return violations;
}

/** The stored error of a cut the check refused twice. */
export function rejectedIntakeError(violation: IntakeViolation): string {
  return `rejected (${violation.rule}): ${violation.detail}`;
}

function correctionFor(violations: readonly IntakeViolation[]): string {
  return [
    "the app checked it against the recipe and found:",
    ...violations.filter((v) => !v.note).map((v) => `- (${v.rule}) ${v.detail}`),
    "Keep every number and every word of the source. Never merge source steps; split one only where it holds two stretches of work, and never into fragments: each step whole sentences, opening with a capital letter.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/** One model call of an intake, numbered from 1, for a paid run's ledger. */
export interface IntakeUsage extends ExtractionUsage {
  call: number;
}

/** A cut the check turned down, kept for the log. */
export interface IntakeRejection {
  attempt: number;
  recipe: KitchenQueueRecipeData;
  violations: IntakeViolation[];
}

export type IntakeOutcome =
  | {
      recipe: KitchenQueueRecipeData;
      error: null;
      rejections: IntakeRejection[];
      /** Soft rules the kept cut still trips (logged, not refused). */
      nudges: IntakeViolation[];
    }
  | { recipe: null; error: string; rejections: IntakeRejection[] };

export interface IntakeOptions {
  /** Metering context for each model call made by this intake pass. */
  meter: AiMeter;
  /** The row's serving estimate, so the cut is read as the cook page reads it. */
  servesEstimate?: ServesEstimateInput;
  onUsage?: (usage: IntakeUsage) => void;
}

/**
 * Cuts the recipe to the import rules: at most two extractions (the second
 * told what the first got wrong), each checked by `checkIntake`. A cut that
 * trips only notes is kept at once, and a second cut that trips only soft
 * rules is kept, with them as its nudges; a note is never sent back. Throws
 * only `AllowanceUsedError`; a failed call, a deadline passed, a reply with
 * no recipe or a cut refused twice comes back as the error to store, a failed
 * call and a deadline as errors for now (`INTAKE_FOR_NOW`).
 */
export async function runIntake(
  original: KitchenQueueRecipeData,
  { meter, servesEstimate, onUsage }: IntakeOptions,
): Promise<IntakeOutcome> {
  const text = intakeText(original);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), INTAKE_TIMEOUT_MS);
  const rejections: IntakeRejection[] = [];
  let call = 0;
  const count = (usage: ExtractionUsage) => onUsage?.({ ...usage, call: ++call });
  try {
    let correction: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const extraction = await extractRecipeFromText(text, {
        meter,
        correction,
        onUsage: count,
        signal: deadline.signal,
        thinkingBudget: INTAKE_THINKING_BUDGET,
        keepStepIngredients: true,
      });
      if (extraction === null) {
        return { recipe: null, error: "The model found no recipe in it", rejections };
      }
      const recipe = mergeIntake(original, extraction.recipe);
      const violations = checkIntake(original, recipe, { servesEstimate });
      if (violations.every((v) => v.note)) return { recipe, error: null, rejections, nudges: violations };
      if (attempt === 2 && violations.every((v) => v.soft)) {
        return { recipe, error: null, rejections, nudges: violations };
      }
      rejections.push({ attempt, recipe, violations });
      correction = correctionFor(violations);
    }
    const refused = rejections[1]!.violations.find((v) => !v.soft)!;
    return { recipe: null, error: rejectedIntakeError(refused), rejections };
  } catch (err) {
    if (isAllowanceUsed(err)) throw err;
    if (deadline.signal.aborted) {
      return { recipe: null, error: `${INTAKE_FOR_NOW}Intake timed out after ${INTAKE_TIMEOUT_MS / 1000} s`, rejections };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { recipe: null, error: err instanceof TransientModelError ? `${INTAKE_FOR_NOW}${message}` : message, rejections };
  } finally {
    clearTimeout(timer);
  }
}
