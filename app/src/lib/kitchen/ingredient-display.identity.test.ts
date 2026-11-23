import { describe, expect, it } from "vitest";
import type { Ingredient, Recipe } from "@sous/pack";
import {
  convertValue,
  countUnitFromNoun,
  formatCount,
  formatCountRange,
  formatQuantity,
  formatQuantityRange,
  formatUnitValue,
  getUnit,
  parseNumber,
  readLeadingAmount,
  readScaledCanonical,
  scaledHints,
  type ScaledCanonicalAmounts,
  type UnitId,
} from "@sous/pack/quantity";
import { FANNIE_RECIPES, fannieNative } from "../pack-convert/__tests__/fannie-native";
import { legacyToPackRecipe } from "../pack-convert/convert";
import { legacyOf, loadGoldenFiles } from "../pack-convert/golden";
import { loadCookPlanFixtures } from "./__tests__/load-cook-plan-fixtures";
import {
  ingredientLine,
  storedIngredientLines,
  type IngredientLine,
  type MeasureRow,
} from "./ingredient-display";

const CONVERSION_UNITS: Record<"volume" | "mass", readonly UnitId[]> = {
  volume: ["ml", "tbsp", "tsp", "cup"],
  mass: ["g", "oz", "lb"],
};
const MIN_VALUE = 0.01;
const MAX_VALUE = 10000;
const SAME_VALUE = 1e-9;

function referenceNameIsItsAmount(
  ingredient: Ingredient,
  canonical: ScaledCanonicalAmounts,
): boolean {
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
            : hint.amount_max !== undefined &&
              Math.abs(hint.amount_max - measure.max) < SAME_VALUE)
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

/** Reference ×1 line shape prior to B5c scaling additions. */
function referenceAt1x(ingredient: Ingredient): IngredientLine {
  const canonical = readScaledCanonical(ingredient, 1);
  const name = referenceNameIsItsAmount(ingredient, canonical) ? "" : ingredient.name;
  if (canonical.mass_g !== undefined || canonical.volume_ml !== undefined) {
    const stated = scaledHints(ingredient, 1).map((hint) => {
      const lowValue = formatUnitValue(hint.amount, hint.unit);
      const highValue =
        hint.amount_max !== undefined ? formatUnitValue(hint.amount_max, hint.unit) : undefined;
      return {
        unit: hint.unit,
        value:
          highValue === undefined || highValue === lowValue
            ? lowValue
            : `${lowValue}–${highValue}`,
        text:
          hint.amount_max !== undefined
            ? formatQuantityRange(hint.amount, hint.amount_max, hint.unit)
            : formatQuantity(hint.amount, hint.unit),
      };
    });
    const statedUnits = new Set(stated.map((h) => h.unit));
    const conversions: MeasureRow[] = [];
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
        conversions.push({ unit, value });
      }
    };
    add(canonical.volume_ml, "ml", CONVERSION_UNITS.volume);
    add(canonical.mass_g, "g", CONVERSION_UNITS.mass);
    return {
      kind: "amount",
      amount: stated[0]!.text,
      name,
      stated: stated.map(({ unit, value }) => ({ unit, value })),
      conversions,
    };
  }
  if (canonical.count !== undefined) {
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
  if (canonical.as_written !== undefined) {
    return { kind: "as_written", amount: canonical.as_written, name };
  }
  if (canonical.to_taste === true) return { kind: "to_taste", name };
  return { kind: "unstated", name };
}

describe("ingredientLine ×1 byte-identity sweep (B5c-1, B5c-2, B5c-7)", () => {
  const recipes: { label: string; recipe: Recipe; storedCount: number }[] = [];

  const fixturesByName = new Map(loadCookPlanFixtures().map((f) => [f.name, f]));

  for (const f of fixturesByName.values()) {
    const res = legacyToPackRecipe(
      { ...f.recipe, name: f.name },
      { id: f.name, servesEstimate: { count: 4, basis: "fixture" } },
    );
    if (!res.ok) throw new Error(`fixture ${f.name}: ${JSON.stringify(res.issues)}`);
    recipes.push({
      label: `fixture:${f.name}`,
      recipe: res.recipe,
      storedCount: f.recipe.ingredients?.length ?? 0,
    });
  }

  for (const file of loadGoldenFiles("src/lib/pack-convert/__tests__/golden")) {
    for (const r of file.file.recipes) {
      const res = legacyToPackRecipe(legacyOf(r), {
        id: r.id,
        servesEstimate: r.servesEstimate,
      });
      if (!res.ok) throw new Error(`golden:${r.id}: ${JSON.stringify(res.issues)}`);
      recipes.push({
        label: `golden:${file.name}:${r.id}`,
        recipe: res.recipe,
        storedCount: r.recipe.ingredients?.length ?? 0,
      });
    }
  }

  for (const id of FANNIE_RECIPES) {
    const native = fannieNative(id);
    const converted = legacyToPackRecipe(native.recipeData, {
      id,
      ...(native.servesEstimate !== null && native.servesEstimateBasis !== null
        ? { servesEstimate: { count: native.servesEstimate, basis: native.servesEstimateBasis } }
        : {}),
    });
    if (!converted.ok) throw new Error(`fannie-converted:${id}: ${JSON.stringify(converted.issues)}`);
    recipes.push({
      label: `registry-converted:${id}`,
      recipe: converted.recipe,
      storedCount: native.recipeData.ingredients?.length ?? 0,
    });
    recipes.push({
      label: `registry-native:${id}`,
      recipe: native.packRecipe,
      storedCount: native.recipeData.ingredients?.length ?? 0,
    });
  }

  it("sweeps every fixture, golden recipe, and registry pack at ×1 with byte-identical output", () => {
    expect(recipes.length).toBeGreaterThan(40);
    let totalLines = 0;
    for (const { label, recipe, storedCount } of recipes) {
      for (const ing of recipe.ingredients) {
        totalLines += 1;
        const expected = referenceAt1x(ing);
        const actualDefault = ingredientLine(ing);
        const actualExplicit = ingredientLine(ing, 1);
        const actualWithBase = ingredientLine(ing, 1, recipe.serves_base);
        expect(actualDefault, `${label}:${ing.id}`).toEqual(expected);
        expect(actualExplicit, `${label}:${ing.id}`).toEqual(expected);
        expect(actualWithBase, `${label}:${ing.id}`).toEqual(expected);
        expect(JSON.stringify(actualDefault), `${label}:${ing.id}`).toBe(
          JSON.stringify(expected),
        );
      }
      expect(storedIngredientLines(recipe, storedCount), label).toEqual(
        storedIngredientLines(recipe, storedCount, recipe.serves_base),
      );
    }
    expect(totalLines).toBeGreaterThan(400);
  });
});
