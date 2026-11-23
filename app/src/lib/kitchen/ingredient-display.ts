/**
 * How one pack ingredient reads on the cook page (slice B4 step 8): the
 * amount the cook sees, the name beside it, and, for a measured line, what the
 * conversions popover lists. Read by the step's pairs (`CookFlow`), the
 * Ingredients sheet and the Ask's context, by the plan's `ingredientIdx`
 * (a stored index: `storedIngredientLines` looks each up by its id, since the
 * converter skips a blank stored line).
 *
 * Every number shown as the amount is one the source states (B4 decision 3):
 * a measured line shows its display hint, imperial first (the household
 * default, 2026-08-11), in the source's own unit and number. The popover's
 * other rows are computed from the canonical amount, under "Conversions", in
 * the units the popover listed before B4. Nothing here guesses: a line with no
 * number shows the source's words, or the name alone.
 */

import type { Ingredient, Recipe } from "@sous/pack";
import {
  convertValue,
  countUnitFromNoun,
  formatCount,
  formatCountRange,
  formatQuantity,
  formatQuantityRange,
  formatScaledCount,
  formatScaledCountRange,
  formatScaledMeasure,
  formatScaledMeasureRange,
  formatUnitValue,
  getUnit,
  inflectCountName,
  isBelowConversionFloor,
  parseNumber,
  readLeadingAmount,
  readScaledCanonical,
  scaleMultiplier,
  scaledHints,
  type ResolvedHint,
  type ScaledCanonicalAmounts,
  type UnitId,
} from "@sous/pack/quantity";
import { ingredientAt } from "../pack-convert/ids";
import { COOK_COPY } from "./cook-view";

/** A row in the popover: the unit, then its value ("tsp", "6"). */
export interface MeasureRow {
  unit: UnitId;
  value: string;
}

export type IngredientLine =
  /** A measured line: the stated amount, every stated form, the computed others. */
  | {
      kind: "amount";
      amount: string;
      name: string;
      /** Each amount the source states, imperial first; `amount` reads the first. */
      stated: MeasureRow[];
      /** The popover's other units, computed from the canonical amount. */
      conversions: MeasureRow[];
      /** Set when scaled (multiplier ≠ 1), so the popover heads "Recipe says, for 4". */
      servesBase?: number;
    }
  /** A count: the number alone ("3"), any count noun in the name ("cloves garlic"). */
  | {
      kind: "count";
      amount: string;
      name: string;
      /** Set when a scaled count was rounded ("about 5" → "5⅓", "about ½" → "⅛"). */
      exact?: string;
    }
  /** The source's amount and unit verbatim ("a pinch of"), marked as written. */
  | {
      kind: "as_written";
      amount: string;
      name: string;
      /** Set when the recipe is scaled, for "(as written, for 4)". */
      servesBase?: number;
    }
  | { kind: "to_taste"; name: string }
  | { kind: "unstated"; name: string };

/** The popover's units before B4 (`MeasurementPopover`), in its order. */
const CONVERSION_UNITS: Record<"volume" | "mass", readonly UnitId[]> = {
  volume: ["ml", "tbsp", "tsp", "cup"],
  mass: ["g", "oz", "lb"],
};

/** A conversion too small or too large to be any use is left out, as before. */
const MIN_VALUE = 0.01;
const MAX_VALUE = 10000;

/** Two amounts equal to within float noise. */
const SAME_VALUE = 1e-9;

/** A value string with its unit label, pluralized on the upper bound when ranged ("1–2 cups", "½–1 cup"). */
export function withUnit(value: string, unit: UnitId): string {
  const num = parseNumber(value.split("–").at(-1) ?? value);
  const def = getUnit(unit);
  return `${value} ${num !== null && num > 1 + SAME_VALUE ? def.labelPlural : def.label}`;
}

interface StatedHint extends MeasureRow {
  /** The amount as the chip says it: "1½ cups". */
  text: string;
}

function statedHints(ingredient: Ingredient): StatedHint[] {
  return scaledHints(ingredient, 1).map((hint) => {
    const lowValue = formatUnitValue(hint.amount, hint.unit);
    const highValue =
      hint.amount_max !== undefined ? formatUnitValue(hint.amount_max, hint.unit) : undefined;
    return {
      unit: hint.unit,
      value: highValue === undefined || highValue === lowValue ? lowValue : `${lowValue}–${highValue}`,
      text:
        hint.amount_max !== undefined
          ? formatQuantityRange(hint.amount, hint.amount_max, hint.unit)
          : formatQuantity(hint.amount, hint.unit),
    };
  });
}

function conversionsOf(
  canonical: ScaledCanonicalAmounts,
  statedUnits: ReadonlySet<UnitId>,
): MeasureRow[] {
  const rows: MeasureRow[] = [];
  const add = (
    span: { min: number; max?: number } | undefined,
    from: UnitId,
    units: readonly UnitId[],
  ) => {
    if (span === undefined) return;
    for (const unit of units) {
      if (statedUnits.has(unit)) continue;
      const low = convertValue(span.min, from, unit);
      if (low < MIN_VALUE || low > MAX_VALUE) continue;
      const lowStr = formatUnitValue(low, unit);
      let value = lowStr;
      if (span.max !== undefined) {
        const high = convertValue(span.max, from, unit);
        const highStr = formatUnitValue(high, unit);
        if (highStr !== lowStr) value = `${lowStr}–${highStr}`;
      }
      rows.push({ unit, value });
    }
  };
  add(canonical.volume_ml, "ml", CONVERSION_UNITS.volume);
  add(canonical.mass_g, "g", CONVERSION_UNITS.mass);
  return rows;
}

/**
 * Conversions at a scale ≠ 1 (B5c-2, B5c-7): each dimension's rows come from
 * the first stated hint in that dimension (`hint.amount × m`), dropping rows
 * below the unit's smallest kitchen fraction (`⅛ cup`, `½ tbsp`, `⅛ tsp`).
 */
function scaledConversionsOf(
  hints: readonly ResolvedHint[],
  statedUnits: ReadonlySet<UnitId>,
): MeasureRow[] {
  const rows: MeasureRow[] = [];
  for (const dimension of ["volume", "mass"] as const) {
    const hint = hints.find((h) => getUnit(h.unit).dimension === dimension);
    if (hint === undefined) continue;
    for (const unit of CONVERSION_UNITS[dimension]) {
      if (statedUnits.has(unit)) continue;
      const low = convertValue(hint.amount, hint.unit, unit);
      if (low < MIN_VALUE || low > MAX_VALUE || isBelowConversionFloor(low, unit)) continue;
      const lowStr = formatUnitValue(low, unit);
      let value = lowStr;
      if (hint.amount_max !== undefined) {
        const high = convertValue(hint.amount_max, hint.unit, unit);
        const highStr = formatUnitValue(high, unit);
        if (highStr !== lowStr) value = `${lowStr}–${highStr}`;
      }
      rows.push({ unit, value });
    }
  }
  return rows;
}

/**
 * The name says nothing but the line's own amount (B4 fix round 3): "3" for a
 * count of 3, "a pinch" for as written "a pinch", "2 g" or "1 cup (225 g)" for
 * the measure its hints state. The converter writes such a name for a line
 * that is only an amount (a blank item, or a line imported whole), since the
 * format needs one. Compared by reading, not by spelling, so "1/2 cup" is the
 * amount ½ cup; a name that reads as some other amount is a name.
 */
function nameIsItsAmount(ingredient: Ingredient, canonical: ScaledCanonicalAmounts): boolean {
  const name = ingredient.name.trim();
  if (canonical.mass_g !== undefined || canonical.volume_ml !== undefined) {
    const lead = readLeadingAmount(name);
    if (lead === null || lead.rest !== "") return false;
    const reading = lead.reading;
    const measures =
      reading.kind === "measured"
        ? [reading.amount]
        : reading.kind === "compound"
          ? [reading.head, reading.also]
          : [];
    const hints = scaledHints(ingredient, 1);
    return (
      measures.length > 0 &&
      measures.every((measure) => {
        const system = getUnit(measure.unit).system;
        const hint = hints.find((h) => h.system === system);
        return (
          hint !== undefined &&
          hint.unit === measure.unit &&
          Math.abs(hint.amount - measure.value) < SAME_VALUE &&
          (measure.max === undefined
            ? hint.amount_max === undefined
            : hint.amount_max !== undefined && Math.abs(hint.amount_max - measure.max) < SAME_VALUE)
        );
      })
    );
  }
  if (canonical.count !== undefined) {
    if (canonical.count_unit !== undefined) {
      const lower = name.toLowerCase();
      if (
        lower === canonical.count_unit.one.toLowerCase() ||
        lower === canonical.count_unit.other.toLowerCase()
      ) {
        return true;
      }
      const lead = readLeadingAmount(name);
      if (lead !== null && lead.rest === "" && lead.reading.kind === "count") {
        const cu = countUnitFromNoun(lead.reading.noun);
        return (
          cu !== null &&
          cu.one === canonical.count_unit.one &&
          cu.other === canonical.count_unit.other &&
          Math.abs(lead.reading.value - canonical.count.min) < SAME_VALUE &&
          (lead.reading.max === undefined
            ? canonical.count.max === undefined
            : canonical.count.max !== undefined &&
              Math.abs(lead.reading.max - canonical.count.max) < SAME_VALUE)
        );
      }
      return false;
    }
    if (canonical.count.max !== undefined) {
      const lead = readLeadingAmount(`${name} unit`);
      return (
        lead !== null &&
        lead.rest === "" &&
        lead.reading.kind === "count" &&
        lead.reading.noun === null &&
        Math.abs(lead.reading.value - canonical.count.min) < SAME_VALUE &&
        lead.reading.max !== undefined &&
        Math.abs(lead.reading.max - canonical.count.max) < SAME_VALUE
      );
    }
    const value = parseNumber(name);
    return value !== null && Math.abs(value - canonical.count.min) < SAME_VALUE;
  }
  if (canonical.as_written !== undefined) return name === canonical.as_written.trim();
  return false;
}

export function ingredientLine(
  ingredient: Ingredient,
  multiplier: number = 1,
  servesBase?: number,
): IngredientLine {
  const canonical = readScaledCanonical(ingredient, 1);
  // A name that is only the amount shows nothing beside it: the amount once,
  // its kind and conversions kept (B4 fix round 3).
  const name = nameIsItsAmount(ingredient, canonical) ? "" : ingredient.name;
  const isRecipeScaled = Math.abs(multiplier - 1) > SAME_VALUE;
  const effMultiplier = scaleMultiplier(ingredient, multiplier);
  const isLineScaled = Math.abs(effMultiplier - 1) > SAME_VALUE;

  if (canonical.mass_g !== undefined || canonical.volume_ml !== undefined) {
    const stated = statedHints(ingredient);
    // The converter writes a hint in a known unit for every measured line, so
    // a line without one wasn't converted by it; showing a computed number in
    // its place would break "only source-stated numbers" (B4 decision 3).
    if (stated.length === 0) {
      throw new Error(
        `${ingredient.id} (${ingredient.name}): a measured line with no stated amount to show`,
      );
    }
    const statedUnits = new Set(stated.map((hint) => hint.unit));
    if (!isLineScaled) {
      return {
        kind: "amount",
        amount: stated[0].text,
        name,
        stated: stated.map(({ unit, value }) => ({ unit, value })),
        conversions: conversionsOf(canonical, statedUnits),
      };
    }
    const scaled = scaledHints(ingredient, multiplier);
    const primaryHint = scaled[0]!;
    const primaryFormatted =
      primaryHint.amount_max !== undefined
        ? formatScaledMeasureRange(
            primaryHint.amount,
            primaryHint.amount_max,
            primaryHint.unit,
            effMultiplier,
          )
        : formatScaledMeasure(primaryHint.amount, primaryHint.unit, effMultiplier);
    return {
      kind: "amount",
      amount: primaryFormatted.text,
      name,
      stated: stated.map(({ unit, value }) => ({ unit, value })),
      conversions: scaledConversionsOf(scaled, statedUnits),
      ...(servesBase !== undefined ? { servesBase } : {}),
    };
  }
  if (canonical.count !== undefined) {
    if (!isLineScaled) {
      const numStr =
        canonical.count.max !== undefined
          ? formatCountRange(canonical.count.min, canonical.count.max)
          : formatCount(canonical.count.min);
      const amount =
        canonical.count_unit !== undefined
          ? `${numStr} ${
              (canonical.count.max ?? canonical.count.min) <= 1 + SAME_VALUE
                ? canonical.count_unit.one
                : canonical.count_unit.other
            }`
          : numStr;
      return { kind: "count", amount, name };
    }
    const scaledCanonical = readScaledCanonical(ingredient, multiplier);
    const scaledSpan = scaledCanonical.count!;
    const scaledCount =
      scaledSpan.max !== undefined
        ? formatScaledCountRange(scaledSpan.min, scaledSpan.max, effMultiplier)
        : formatScaledCount(scaledSpan.min, effMultiplier);
    if (canonical.count_unit !== undefined) {
      const noun =
        scaledCount.magnitude <= 1 + SAME_VALUE
          ? canonical.count_unit.one
          : canonical.count_unit.other;
      return {
        kind: "count",
        amount: `${scaledCount.text} ${noun}`,
        name,
        ...(scaledCount.exact !== undefined ? { exact: scaledCount.exact } : {}),
      };
    }
    const baseRef = canonical.count.max ?? canonical.count.min;
    const inflectedName =
      name === "" ? "" : inflectCountName(name, baseRef, scaledCount.magnitude, effMultiplier);
    return {
      kind: "count",
      amount: scaledCount.text,
      name: inflectedName,
      ...(scaledCount.exact !== undefined ? { exact: scaledCount.exact } : {}),
    };
  }
  if (canonical.as_written !== undefined) {
    return {
      kind: "as_written",
      amount: canonical.as_written,
      name,
      ...(isRecipeScaled && servesBase !== undefined ? { servesBase } : {}),
    };
  }
  if (canonical.to_taste === true) return { kind: "to_taste", name };
  if (canonical.unstated === true) return { kind: "unstated", name };
  // The format's refine makes this unreachable for a parsed recipe.
  throw new Error(`${ingredient.id} (${ingredient.name}): a quantity with nothing to show`);
}

/** A name that already says "to taste" ("salt and pepper to taste"). */
const SAYS_TO_TASTE_RE = /\bto taste\b/i;

/**
 * The Ingredients sheet's how-much line, under the name of a line with no
 * number to show (B4 step 8 call 4): the app's answer to "how much?", since
 * it has no voice for it. Null for a line with a number, and for a to-taste
 * line whose name already says so (B4 fix round 1): the sheet never repeats
 * what the line says.
 */
export function howMuch(line: IngredientLine): string | null {
  switch (line.kind) {
    case "amount":
    case "count":
      return null;
    case "as_written":
      return line.servesBase !== undefined
        ? COOK_COPY.asWrittenFor(line.servesBase)
        : COOK_COPY.asWritten;
    case "to_taste":
      return SAYS_TO_TASTE_RE.test(line.name) ? null : COOK_COPY.toTaste;
    case "unstated":
      return COOK_COPY.unstated;
  }
}

/**
 * One line for the Ask's context: the amount the cook sees, then the name;
 * the amount alone when the name was only that amount.
 */
export function ingredientText(line: IngredientLine): string {
  if (!("amount" in line)) return line.name;
  return line.name === "" ? line.amount : `${line.amount} ${line.name}`;
}

/**
 * The lines indexed as the stored recipe's: entry i is stored line i, null
 * where the converter skipped a blank stored line (B4 fix round 2). Every
 * consumer of a plan's `ingredientIdx` reads through this, so an index after
 * a blank line still names its own line.
 */
export type StoredIngredientLines = readonly (IngredientLine | null)[];

/** `recipe`'s lines by stored index, for a stored list of `storedCount` lines. */
export function storedIngredientLines(
  recipe: Recipe,
  storedCount: number,
  servings: number = recipe.serves_base,
): StoredIngredientLines {
  const multiplier =
    recipe.serves_base > 0 && Math.abs(servings - recipe.serves_base) > SAME_VALUE
      ? servings / recipe.serves_base
      : 1;
  const servesBase = multiplier !== 1 ? recipe.serves_base : undefined;
  return Array.from({ length: storedCount }, (_, index) => {
    const ingredient = ingredientAt(recipe, index);
    return ingredient === undefined ? null : ingredientLine(ingredient, multiplier, servesBase);
  });
}

/**
 * The mark beside a serving count that is Sous's estimate, not the source's
 * (slice B4b, format v0.5 `serves_estimated`; DS v1.18). Placeholder copy,
 * awaiting a rewrite.
 */
export const SOUS_ESTIMATE_MARK = "(Sous's estimate)";

/**
 * A serving count as the cook reads it, in the line's own words and style:
 * "serves 4", or "serves 4 (Sous's estimate)" when the source states no
 * count. `servings` is a scaled count (B5's stepper); a count scaled from an
 * estimate is still an estimate, so it keeps the mark at every scale, and a
 * stated count never gains it. Every surface that shows a serving count says
 * it through here (DS §6; S's rows and B5's stepper included).
 */
export function servingsText(
  recipe: { serves_base: number; serves_estimated?: true },
  servings: number = recipe.serves_base,
): string {
  const words = `serves ${String(servings)}`;
  return recipe.serves_estimated === true ? `${words} ${SOUS_ESTIMATE_MARK}` : words;
}

