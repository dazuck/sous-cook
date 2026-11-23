/**
 * "Sue, how much flour" (slice B5d, B5.md §B5d D11–D12): the question read
 * from what was heard, and its answer, shown and said.
 *
 * The answer reads the lines the step's pairs read (`storedIngredientLines`
 * → `ingredientLine`), never a reading of its own, so it always says what the
 * pair shows. B5c adds the serving multiplier there, and the answer follows
 * with no change here (DECISIONS 2026-10-10, B5d before B5c). Every number it
 * gives is one the recipe states, except an amount asked in a unit the recipe
 * only converts to, which is said as a conversion, with the stated amount
 * after it (the popover's own split, B4 decision 3).
 */

import { parseNumber, UNITS, type UnitId } from "@sous/pack/quantity";
import { matchIngredient, tokens } from "./ingredient-match";
import type { IngredientLine, MeasureRow, StoredIngredientLines } from "./ingredient-display";

/** An amount question: the words for the ingredient, and the unit asked in, if any. */
export interface HowMuchRequest {
  asked: string;
  unit: UnitId | null;
}

const HOW_MUCH_RE = /^how (?:much|many) (.+)$/;

/**
 * Words after the ingredient that ask nothing more ("how much flour do I
 * need", "how much milk in total"). A body that is only these asks nothing.
 */
const TRAILING_FILLER_RE =
  /(?:^|\s+)(?:do (?:i|we|you) need|does (?:it|this|the recipe) (?:need|take|call for|want)|goes in|go in|is (?:it|that|there)|again|please|total|in total|in all|altogether)$/;

/**
 * Where the ingredient's words end and the rest of the question begins
 * (b5d-followup): "flour | should I use", "oil | do I put in", "sugar |
 * goes in the dough", "butter | to use". The ingredient is the words before
 * the first of these; leading "is"/"are" ("how much is the flour") come off
 * the front.
 */
const CLAUSE_START = new Set([
  "should", "do", "does", "did", "goes", "go", "to", "will", "would", "can", "could", "need", "needs",
  "is", "are", "was", "for",
]);
const LEADING_VERBS = new Set(["is", "are", "was"]);

/**
 * Words that make it a question about the recipe, not an amount of one of
 * its lines (B5d verify round 1): "how many people does this serve", "how
 * much does this make", "how many calories", "how many tablespoons in a
 * cup". These fall through as before B5d (after a tap, to Ask), whether in
 * the ingredient's words or in the clause after them.
 */
const NOT_AN_INGREDIENT = new Set([
  "serve", "serves", "serving", "servings", "people", "person", "portion", "portions",
  "make", "makes", "yield", "yields", "calorie", "calories", "degree", "degrees", "temperature", "heat",
]);

const UNIT_WORDS: Record<string, UnitId> = {
  g: "g", gram: "g", grams: "g",
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  ml: "ml", milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  cup: "cup", cups: "cup",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
};

const UNIT_SUFFIX_RE = new RegExp(`\\s+in (${Object.keys(UNIT_WORDS).join("|")})$`);

/** A question about time, never an amount: "how much longer", "how much time is left", "how much more". */
const TIME_WORDS = new Set(["more", "longer", "long", "time", "left", "until", "minute", "hour", "second"]);

/** The most words an ingredient is asked by; past this it is a question for Ask (D11). */
export const MAX_ASKED_WORDS = 3;

/**
 * The amount question a normalized phrase asks, or null. Null for anything
 * that isn't one, so it falls through as it did before B5d: after a tap a
 * question for Ask, after "Sue" talk (D11).
 */
export function howMuchRequest(phrase: string): HowMuchRequest | null {
  const match = HOW_MUCH_RE.exec(phrase.trim());
  if (match === null) return null;
  let body = match[1]!;
  let unit: UnitId | null = null;
  // Fillers and the unit come off the end in either order ("flour do I need
  // in grams", "flour in grams again").
  for (let previous = ""; previous !== body; ) {
    previous = body;
    body = body.replace(TRAILING_FILLER_RE, "");
    const unitMatch: RegExpExecArray | null = unit === null ? UNIT_SUFFIX_RE.exec(body) : null;
    if (unitMatch !== null) {
      unit = UNIT_WORDS[unitMatch[1]!]!;
      body = body.slice(0, unitMatch.index);
    }
  }
  const all = body.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  // Questions about the recipe or time, wherever their word stands.
  if (all.some((word) => NOT_AN_INGREDIENT.has(word) || TIME_WORDS.has(word))) return null;
  let start = 0;
  while (start < all.length && LEADING_VERBS.has(all[start]!)) start += 1;
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) {
    if (CLAUSE_START.has(all[i]!)) {
      end = i;
      break;
    }
  }
  const ingredient = all.slice(start, end);
  // A unit named outside the "in grams" suffix is a conversion question
  // ("how many tablespoons in a cup"), not an amount.
  if (ingredient.length === 0 || CLAUSE_START.has(ingredient[0]!) || all.some((word) => word in UNIT_WORDS)) return null;
  const words = tokens(ingredient.join(" "));
  if (words.length === 0 || words.length > MAX_ASKED_WORDS) return null;
  return { asked: ingredient.join(" "), unit };
}

export interface AnswerChoice {
  index: number;
  name: string;
}

export type HowMuchAnswer =
  /** One line, or several sharing one name, listed in recipe order (D12). */
  | { kind: "amount"; indices: number[]; shown: string; speech: string }
  /** Lines with different names: the cook picks one (`answerFor`). */
  | { kind: "which"; asked: string; unit: UnitId | null; choices: AnswerChoice[]; shown: string; speech: string }
  | { kind: "none"; asked: string; shown: string; speech: string };

/** Copy for the answers. Placeholder, awaiting a rewrite. */
export const HOW_MUCH_COPY = {
  toTaste: "To taste.",
  unstated: "The recipe doesn't say.",
  asWritten: "as written",
  none: (asked: string) => `Nothing called ${asked} in this recipe.`,
  which: (asked: string) => `Which ${asked}?`,
} as const;

const FRACTION_WORDS: Record<string, string> = {
  "½": "a half", "⅓": "a third", "⅔": "two thirds", "¼": "a quarter", "¾": "three quarters",
  "⅕": "a fifth", "⅖": "two fifths", "⅗": "three fifths", "⅘": "four fifths", "⅙": "a sixth",
  "⅚": "five sixths", "⅐": "a seventh", "⅛": "an eighth", "⅜": "three eighths", "⅝": "five eighths",
  "⅞": "seven eighths", "⅑": "a ninth", "⅒": "a tenth",
};
const FRACTION_GLYPHS = /[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒]/g;

const SPOKEN_UNITS: Record<string, { one: string; many: string }> = {
  g: { one: "gram", many: "grams" },
  kg: { one: "kilogram", many: "kilograms" },
  oz: { one: "ounce", many: "ounces" },
  lb: { one: "pound", many: "pounds" },
  lbs: { one: "pound", many: "pounds" },
  ml: { one: "milliliter", many: "milliliters" },
  l: { one: "liter", many: "liters" },
  tsp: { one: "teaspoon", many: "teaspoons" },
  tbsp: { one: "tablespoon", many: "tablespoons" },
};

function speakAmountPart(amount: string): string {
  return amount
    .replace("⁄", "/")
    .replace(/(\d)(?=[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒])/g, "$1 and ")
    .replace(FRACTION_GLYPHS, (glyph) => FRACTION_WORDS[glyph] ?? glyph);
}

/** A shown quantity ("1½ cups", "28 g") as the synthesizer should say it (the Player's). */
export function speakableQuantity(text: string): string {
  if (text.includes(" + ")) {
    return text
      .split(" + ")
      .map((part) => {
        const bareCup = /^([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒]) cup$/.exec(part);
        if (bareCup !== null) {
          return `${speakAmountPart(bareCup[1]!)} of a cup`;
        }
        return speakableQuantity(part);
      })
      .join(" and ");
  }
  let amount = text;
  let unitWord = "";
  const unitMatch = /^(.+) ([a-z]+)$/.exec(text);
  if (unitMatch !== null) {
    const [, qty, label] = unitMatch;
    const words = SPOKEN_UNITS[label!];
    amount = qty!;
    const upper = qty!.split("–").at(-1) ?? qty!;
    // Singular only for a bare "1": "1½" is already plural.
    unitWord = words === undefined ? ` ${label!}` : ` ${upper === "1" ? words.one : words.many}`;
  }
  const spoken = amount.includes("–")
    ? amount.split("–").map(speakAmountPart).join(" to ")
    : speakAmountPart(amount);
  return spoken + unitWord;
}

function capitalize(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** A popover row as words: "28 g", "3½ cups". */
function rowText(row: MeasureRow): string {
  const value = parseNumber(row.value.split("–").at(-1) ?? row.value);
  const def = UNITS[row.unit];
  return `${row.value} ${value !== null && value > 1 ? def.labelPlural : def.label}`;
}

/** The name, lowercased for the middle of a sentence. */
function spokenName(line: IngredientLine): string {
  return line.name.toLowerCase();
}

function amountWithName(amount: string, line: IngredientLine): string {
  return line.name === "" ? amount : `${amount} ${line.name.toLowerCase()}`;
}

/** One line's amount, as shown and said; `unit` is the unit it was asked in. */
function lineAnswer(line: IngredientLine, unit: UnitId | null): { shown: string; speech: string; short: string; spokenShort: string } {
  switch (line.kind) {
    case "amount": {
      if (unit !== null) {
        const stated = line.stated.find((row) => row.unit === unit);
        if (stated !== undefined) {
          const text = rowText(stated);
          return { shown: amountWithName(text, line), speech: capitalize(`${speakableQuantity(text)} of ${spokenName(line)}`), short: text, spokenShort: speakableQuantity(text) };
        }
        const converted = line.conversions.find((row) => row.unit === unit);
        if (converted !== undefined) {
          const text = rowText(converted);
          return {
            shown: `about ${text} · recipe says ${line.amount}`,
            speech: `About ${speakableQuantity(text)}. The recipe says ${speakableQuantity(line.amount)}.`,
            short: `about ${text}`,
            spokenShort: `about ${speakableQuantity(text)}`,
          };
        }
        const statedUnit = UNITS[line.stated[0]!.unit].labelPlural;
        const unitName = SPOKEN_UNITS[statedUnit]?.many ?? statedUnit;
        return {
          shown: amountWithName(line.amount, line),
          speech: `The recipe gives ${spokenName(line) || "it"} in ${unitName}: ${speakableQuantity(line.amount)}.`,
          short: line.amount,
          spokenShort: speakableQuantity(line.amount),
        };
      }
      return {
        shown: amountWithName(line.amount, line),
        speech: capitalize(line.name === "" ? speakableQuantity(line.amount) : `${speakableQuantity(line.amount)} of ${spokenName(line)}`),
        short: line.amount,
        spokenShort: speakableQuantity(line.amount),
      };
    }
    case "count":
      return {
        shown: amountWithName(line.amount, line),
        speech: capitalize(`${speakableQuantity(line.amount)} ${spokenName(line)}`.trim()),
        short: line.amount,
        spokenShort: speakableQuantity(line.amount),
      };
    case "as_written":
      return {
        shown: `${amountWithName(line.amount, line)} (${HOW_MUCH_COPY.asWritten})`,
        speech: capitalize(`${line.amount} ${spokenName(line)}`.trim()),
        short: line.amount,
        spokenShort: line.amount,
      };
    case "to_taste":
      return { shown: `${line.name}: to taste`, speech: HOW_MUCH_COPY.toTaste, short: "to taste", spokenShort: "to taste" };
    case "unstated":
      return { shown: `${line.name}: the recipe doesn't say`, speech: HOW_MUCH_COPY.unstated, short: "not said", spokenShort: "not said" };
  }
}

/** Words joined as said, in the recipe's order: "a, then b, then c". */
function listed(parts: string[]): string {
  return parts.join(", then ");
}

/** The answer for chosen lines: one, or several sharing a name, in recipe order. */
export function answerFor(lines: StoredIngredientLines, indices: readonly number[], unit: UnitId | null): HowMuchAnswer {
  const chosen = indices.map((i) => lines[i]!);
  if (chosen.length === 1) {
    const one = lineAnswer(chosen[0]!, unit);
    return { kind: "amount", indices: [...indices], shown: one.shown, speech: one.speech };
  }
  const parts = chosen.map((line) => lineAnswer(line, unit));
  const name = chosen[0]!.name;
  return {
    kind: "amount",
    indices: [...indices],
    shown: `${name}: ${parts.map((p) => p.short).join(" · ")}`,
    speech: `${name}: ${listed(parts.map((p) => p.spokenShort))}.`,
  };
}

/**
 * The answer to an amount question, the screen in hand's lines tried first
 * (`onScreen`, stored indices). `lines` are the ones the pairs read.
 */
export function answerHowMuch(
  lines: StoredIngredientLines,
  onScreen: readonly number[],
  request: HowMuchRequest,
): HowMuchAnswer {
  const match = matchIngredient(lines, onScreen, request.asked);
  switch (match.kind) {
    case "match":
      return answerFor(lines, match.indices, request.unit);
    case "which": {
      const choices = match.indices.map((index) => ({ index, name: lines[index]!.name }));
      const names = choices.map((c) => c.name.toLowerCase());
      const spokenNames = names.length > 1 ? `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]!}` : names[0]!;
      return {
        kind: "which",
        asked: request.asked,
        unit: request.unit,
        choices,
        shown: HOW_MUCH_COPY.which(request.asked),
        speech: `Which ${request.asked}: ${spokenNames}?`,
      };
    }
    case "none":
      return { kind: "none", asked: request.asked, shown: HOW_MUCH_COPY.none(request.asked), speech: HOW_MUCH_COPY.none(request.asked) };
  }
}
