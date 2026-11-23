/**
 * What a step cut looks like to the cook (standing agent call, DECISIONS
 * 2026-10-26, "a step is one stretch of work"): every step reads alone as
 * one or more whole sentences in the source's words. A piece cut out of a
 * sentence ("salt", "then 4 cups hot stock", "cook 5 min until soft.") is
 * a fragment, and a fragment is never shown.
 *
 * `fragmentReason` names why a step reads as a fragment; it is shared by
 * intake's check (`checkIntake`, which turns such a cut down and re-asks)
 * and the intake eval's hard checks. A step opening the way a source step
 * opens is the source's own wording, not something the cut made, and is
 * never called a fragment: a cut can't fix what the source wrote.
 *
 * `unpausedSplits` names where a cut split a source step without following
 * the rule's seams: a piece with no pause of its own ("In the Dutch oven,
 * warm the oil."), a piece that runs on past its pause into the next
 * stretch's work ("Add the farro and toast 2 min, then 4 cups hot stock."),
 * or a piece that carries on the cooking of the piece before it ("Toss and
 * repeat once, about 12 min total", "cook 1 min more").
 * `crowdedLines` names an ingredient line that still holds a second
 * ingredient ("1 sprig rosemary, 1 bay leaf", "olive oil, plus more; salt").
 * The pause is read from the words (a time, a doneness cue, a move), and a
 * second ingredient from an amount or a staple's name, so these are nudges: intake re-asks for it once and keeps a second cut that
 * still trips it (`checkIntake`, soft).
 */

import type { ChatRecipeIngredient } from "../../../drizzle/schema";
import { durationsIn } from "../kitchen/cook-plan";
import { ingredientToString } from "../kitchen/step-ingredients";
import { groundingWords } from "../recipe-grounding";

/** Words that join a clause to the one before it; a step never opens with one. */
const CONNECTIVES = new Set(["then", "and", "or", "but", "until", "plus", "so", "also"]);

/**
 * Words an ingredient line can hold that a whole step opens with as its
 * verb ("Salt the water", "Brown the chicken", "Warm the tortillas"), so
 * opening with one isn't opening with a bare noun.
 */
const STEP_VERBS = new Set([
  "brown",
  "butter",
  "chill",
  "cool",
  "core",
  "cream",
  "crumb",
  "cut",
  "dress",
  "dust",
  "finish",
  "flour",
  "glaze",
  "grease",
  "halve",
  "heat",
  "ice",
  "juice",
  "oil",
  "peel",
  "pepper",
  "salt",
  "season",
  "serve",
  "stem",
  "stock",
  "toast",
  "top",
  "warm",
  "zest",
]);

/**
 * Words of an ingredient line that never name the ingredient: amounts,
 * sizes, states and the words around them.
 */
const NOT_NAMES = new Set([
  "about",
  "and",
  "big",
  "cup",
  "cups",
  "extra",
  "for",
  "fresh",
  "good",
  "half",
  "large",
  "little",
  "medium",
  "more",
  "optional",
  "plus",
  "remaining",
  "small",
  "some",
  "the",
  "to",
  "whole",
  "with",
  "your",
]);

/** A step's words, lowercased, letters and digits only. */
function tokens(text: string): string[] {
  return (
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/\p{L}+|[0-9]+/gu) ?? []
  );
}

/** Words of a line's name that describe rather than name it (a colour, a temperature). */
const DESCRIBING = new Set(["white", "green", "red", "black", "yellow", "brown", "light", "dark", "hot", "cold", "warm"]);

/**
 * The words naming a line's ingredient: its item before any aside (a
 * parenthesis, a comma, a semicolon), less amounts, sizes, states and
 * describing words. "stock (or water + 1 tsp dashi), hot" names "stock".
 */
function lineNameWords(line: ChatRecipeIngredient): string[] {
  const name = line.item.split(/[(,;]/)[0] ?? "";
  return tokens(name).filter(
    (word) =>
      word.length >= 3 && !/^[0-9]+$/.test(word) && !/(ed|ly)$/.test(word) && !NOT_NAMES.has(word) && !DESCRIBING.has(word),
  );
}

/** A word without its plural ending, so "peppers" and "pepper", "tomatoes" and "tomato" are one. */
function singular(word: string): string {
  return word.length > 3 ? word.replace(/(?:es|s)$/, "") : word;
}

/**
 * The ingredients a step names, one entry per word naming some (plural and
 * singular as one): the lines (by index) that word can name. "pepper" in a
 * recipe with a whole pepper and the remaining peppers names either line.
 */
export function namedLines(step: string, lines: readonly ChatRecipeIngredient[]): number[][] {
  const said = new Set(tokens(step).map(singular));
  const byWord = new Map<string, number[]>();
  lines.forEach((line, i) => {
    for (const word of lineNameWords(line).map(singular)) {
      if (!said.has(word)) continue;
      const named = byWord.get(word) ?? [];
      if (!named.includes(i)) named.push(i);
      byWord.set(word, named);
    }
  });
  return [...byWord.values()];
}

/** The words of the recipe's ingredient lines that can name an ingredient. */
export function ingredientNames(lines: readonly ChatRecipeIngredient[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    for (const word of tokens(ingredientToString(line))) {
      if (word.length < 3 || /^[0-9]+$/.test(word) || /(ed|ly)$/.test(word) || NOT_NAMES.has(word)) continue;
      names.add(word);
    }
  }
  return names;
}

/** How a step opens, for comparing it with the source's openings: its first three words. */
function opening(text: string): string {
  return tokens(text).slice(0, 3).join(" ");
}

export interface FragmentContext {
  /** `ingredientNames` of the recipe's lines. */
  names: ReadonlySet<string>;
  /** The source's steps: a step opening as one of them does is the source's own wording. */
  sourceSteps: readonly string[];
}

/** How a step ends, for comparing it with the source's endings: its last three words and its last mark. */
function ending(text: string): string {
  const trimmed = text.trim();
  return `${tokens(trimmed).slice(-3).join(" ")}${trimmed.slice(-1)}`;
}

/**
 * Why `step` reads as a fragment rather than a whole sentence, or null when
 * it reads whole: it ends mid-sentence (on a comma, a semicolon, a colon or
 * a dash), or it opens with a lowercase letter, a joining word ("then",
 * "and"), a number with no verb before it ("4 cups hot stock"), or a bare
 * ingredient ("Parmesan, lemon and pepper."). An ending or an opening a
 * source step has is the source's own.
 */
export function fragmentReason(step: string, { names, sourceSteps }: FragmentContext): string | null {
  const text = step.trim();
  const last = text.slice(-1);
  if (/[,;:\u2013\u2014-]/u.test(last) && !sourceSteps.some((source) => ending(source) === ending(text))) {
    return `ends mid-sentence ("${last}")`;
  }
  const opens = opening(text);
  if (opens !== "" && sourceSteps.some((source) => opening(source) === opens)) return null;
  const first = /^[^\p{L}\p{N}]*([\p{L}\p{N}]+)/u.exec(text)?.[1];
  if (first === undefined) return null;
  if (/^\p{Ll}/u.test(first)) return `opens in lowercase ("${first}")`;
  const word = first.toLowerCase();
  if (CONNECTIVES.has(word)) return `opens with "${first}", joined to the step before it`;
  if (/^[0-9]/.test(word)) return `opens with a number ("${first}"), no verb before it`;
  if (names.has(word) && !STEP_VERBS.has(word)) return `opens with a bare ingredient ("${first}")`;
  return null;
}

/** Each fragment step of `steps`, by index, with why. */
export function fragmentSteps(
  steps: readonly string[],
  context: FragmentContext,
): { index: number; step: string; reason: string }[] {
  return steps.flatMap((step, index) => {
    const reason = fragmentReason(step, context);
    return reason === null ? [] : [{ index, step, reason }];
  });
}

export function words(text: string): Set<string> {
  return new Set(groundingWords(text));
}

export function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/**
 * Each output step's original step, in order (never going back), choosing
 * the assignment that shares the most words overall.
 */
export function alignSteps(original: readonly string[], output: readonly string[]): number[] {
  const m = original.length;
  const n = output.length;
  if (m === 0 || n === 0) return output.map(() => 0);
  const ow = original.map(words);
  const score = output.map((text) => {
    const w = words(text);
    return ow.map((o) => overlap(w, o));
  });
  // best[i][k]: the most shared words for outputs 0..i with output i on step k.
  const best: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < n; i++) {
    best.push(new Array<number>(m).fill(-Infinity));
    from.push(new Array<number>(m).fill(-1));
    let runMax = -Infinity;
    let runArg = -1;
    for (let k = 0; k < m; k++) {
      if (i === 0) {
        best[i][k] = score[i][k];
        continue;
      }
      if (best[i - 1][k] > runMax) {
        runMax = best[i - 1][k];
        runArg = k;
      }
      best[i][k] = score[i][k] + runMax;
      from[i][k] = runArg;
    }
  }
  let k = 0;
  for (let j = 1; j < m; j++) if (best[n - 1][j] > best[n - 1][k]) k = j;
  const aligned = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    aligned[i] = k;
    k = from[i][k];
  }
  return aligned;
}

/**
 * A doneness cue or a move to another vessel, as words: "until soft", "when
 * it boils", "once tender", "to a boil", "transfer", "into a bowl".
 */
const PAUSE_CUE =
  /\b(?:until|till|when|once|overnight|transfer|onto)\b|\bto (?:a|the) (?:boil|simmer)\b|\binto (?:a|the|another)\b/i;

/** Whether `text` carries a pause: a stated time, a doneness cue or a move. */
export function hasPause(text: string): boolean {
  return durationsIn(text).length > 0 || PAUSE_CUE.test(text);
}

/**
 * Words saying a piece carries on the cooking of the one before it: a
 * repeat, a length given as more or in total ("1 min more", "12 min total").
 */
const SAME_STRETCH =
  /\b(?:repeat|again)\b|\bmore\s+(?:sec|secs|seconds|min|mins|minutes|hr|hrs|hours?)\b|\b(?:sec|secs|seconds|min|mins|minutes|hr|hrs|hours?)\s+more\b|\btotal\b/i;

/** Staples a source line tacks on after the ingredient it is about ("…, plus more to finish; salt"). */
const STAPLES = new Set(["salt", "pepper", "black pepper", "kosher salt", "flaky salt", "olive oil", "oil", "butter", "sugar"]);

/**
 * The ingredient lines that still hold a second ingredient after a comma or
 * a semicolon (outside brackets): a part opening with its own amount ("1
 * sprig rosemary, 1 bay leaf") or one that is a staple's name ("…; salt").
 * A part describing the ingredient ("chopped; stems sliced", "a big
 * handful", "plus more to finish") is not one.
 */
export function crowdedLines(lines: readonly ChatRecipeIngredient[]): { index: number; line: string }[] {
  return lines.flatMap((ingredient, index) => {
    const line = ingredientToString(ingredient);
    const parts = line
      .replace(/\([^)]*\)/g, "")
      .split(/[,;]/)
      .slice(1)
      .map((part) => part.trim().toLowerCase().replace(/^(?:and|or)\s+/, ""));
    const second = parts.some((part) => /^[0-9\u00bc-\u00be\u2150-\u215e]/u.test(part) || STAPLES.has(part.replace(/\.$/, "")));
    return second ? [{ index, line }] : [];
  });
}

/** The clause after a step's last "then" joining it to what came before, if any. */
function trailingThen(text: string): string | null {
  const parts = text.split(/[,;]\s*(?:and\s+)?then\s+/i);
  return parts.length > 1 ? parts[parts.length - 1]!.trim() : null;
}

/**
 * Where the cut split a source step off the rule's seams (see the module
 * note): each piece of a split source step needs a pause of its own, and a
 * piece followed by another piece of the same source step must end at its
 * pause, not run on into a "then" clause with none.
 */
export function unpausedSplits(sourceSteps: readonly string[], steps: readonly string[]): { index: number; step: string; reason: string }[] {
  const aligned = alignSteps(sourceSteps, steps);
  return steps.flatMap((step, index) => {
    const pieces = aligned.filter((k) => k === aligned[index]).length;
    if (pieces < 2) return [];
    if (!hasPause(step)) {
      return [{ index, step, reason: "has no pause of its own (a time, a doneness cue or a move): it belongs in the step its work leads into" }];
    }
    const carriesOn = aligned[index - 1] === aligned[index] ? SAME_STRETCH.exec(step) : null;
    if (carriesOn !== null) {
      return [{ index, step, reason: `carries on the step before it ("${carriesOn[0]}"): the same cooking, so one step` }];
    }
    const last = aligned[index + 1] !== aligned[index];
    const tail = last ? null : trailingThen(step);
    if (tail !== null && !hasPause(tail)) {
      return [{ index, step, reason: `runs on past its pause into "${tail}", which starts the next step` }];
    }
    return [];
  });
}
