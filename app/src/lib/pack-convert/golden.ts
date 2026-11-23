/**
 * The golden-set check (slice B4, "zero wrong numbers"): a converted recipe
 * against values written from the source text by someone who never ran the
 * converter. Used by `__tests__/golden.test.ts`.
 *
 * What the cook sees for a line is what B4 shows: a line's imperial hint if it
 * has one, else its only hint; a count; or no number (to taste, unstated, as
 * written). A wrong number is a shown amount, unit, count, timer or serving
 * count that differs from the source, or a number shown where the source
 * states none. Notation is not a wrong number: units compare by the reader's
 * table ("tablespoons" is "tbsp"), amounts as numbers (1.5 is 1½).
 *
 * A line the converter keeps as written where the source writer saw a number
 * is a class disagreement, not a wrong number: no number is shown. Each one
 * must be adjudicated and listed in the file's `accepted` list with its reason,
 * so the as-written count stays a reviewed list rather than a silent one. So
 * must a step whose timer the source states and the converter doesn't set.
 *
 * A golden file can read each line in full (`ReadingLine`): its class,
 * whether it scales, and every number it states, per system. Every number the
 * converter shows, each hint and a count, must be one the line states, or it
 * is a wrong number. Fewer numbers, another class label, or not scaling is a
 * class disagreement; scaling a line the source keeps fixed is a scales
 * disagreement. Both are reviewed: only an accepted one passes.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Ingredient, Recipe } from "@sous/pack";
import { readScaledCanonical, scaledHints, unitFromAlias } from "@sous/pack/quantity";
import type { LegacyRecipe } from "./convert";
import { ingredientAt, stepAt } from "./ids";
import { ingredientLine } from "../kitchen/ingredient-display";

const NO_NUMBER = ["to taste", "unstated", "as written"] as const;
type NoNumber = (typeof NO_NUMBER)[number];

const note = z.string().min(1).optional();

/**
 * A stored line with no text at all: the converter skips it and the cook sees
 * no row for it (fix round 2). Lines after it keep their stored index.
 */
const BLANK = "blank";

const LINE_CLASSES = ["measured", "compound", "count", "to_taste", "unstated", "as_written"] as const;

const statedSchema = z.strictObject({
  amount: z.number().positive(),
  amount_max: z.number().positive().optional(),
  unit: z.string().min(1),
});

const scaledExpectationSchema = z.strictObject({
  x2: z.string().min(1),
  x2_3: z.string().min(1),
});

/**
 * A line read in full. `hints` holds each number the line states as an amount,
 * one per system; a line that states none, or none a single hint can hold (a
 * sum, a range, two in one system), has none, so any number shown is wrong.
 * `count` is a count's number. `scaled` holds the independent B5c-7 chip
 * strings at ×2 and ×⅔ for every scaling line.
 */
const readingLineSchema = z.strictObject({
  class: z.enum(LINE_CLASSES),
  scales: z.boolean(),
  hints: z
    .strictObject({ imperial: statedSchema.optional(), metric: statedSchema.optional() })
    .optional(),
  count: z.number().positive().optional(),
  count_max: z.number().positive().optional(),
  count_unit: z.strictObject({ one: z.string().min(1), other: z.string().min(1) }).optional(),
  scaled: scaledExpectationSchema.optional(),
});

export type ReadingLine = z.infer<typeof readingLineSchema>;

const expectedLineSchema = z.union([
  readingLineSchema,
  z.enum(NO_NUMBER),
  z.literal(BLANK),
  z.strictObject({ shows: z.enum(NO_NUMBER), note }),
  z.strictObject({
    amount: z.number().positive(),
    amount_max: z.number().positive().optional(),
    unit: z.string().min(1),
    note,
  }),
  z.strictObject({
    count: z.number().positive(),
    count_max: z.number().positive().optional(),
    note,
  }),
]);

export type ExpectedLine = z.infer<typeof expectedLineSchema>;

const ingredientLineSchema = z.strictObject({
  item: z.string(),
  amount: z.string().optional(),
  unit: z.string().optional(),
});

const goldenRecipeSchema = z.strictObject({
  id: z.string().min(1),
  recipe: z.strictObject({
    name: z.string(),
    ingredients: z.array(ingredientLineSchema).nullable().optional(),
    steps: z.array(z.string()).nullable().optional(),
    estimatedTime: z
      .strictObject({
        active: z.number().nullable().optional(),
        passive: z.number().nullable().optional(),
        total: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
    serves: z.number().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    notes: z.string().nullable().optional(),
    stepIngredients: z.array(z.array(z.number())).nullable().optional(),
  }),
  /**
   * Sous's estimate stored beside a recipe that states no count (slice B4b),
   * as the DB keeps it beside the source: the reviewed estimate for a prod
   * recipe, the fixture estimate for a hand-built one.
   */
  servesEstimate: z.strictObject({ count: z.number().int().positive(), basis: z.string().min(1) }).optional(),
  expected: z.strictObject({
    /** The count the cook sees: the stated one, else Sous's estimate. */
    serves: z.number().positive(),
    /** True when that count is Sous's estimate: the recipe must carry the mark. */
    servesEstimated: z.boolean(),
    ingredients: z.array(expectedLineSchema),
    steps: z.array(z.strictObject({ timer_sec: z.number().int().positive().nullable() })),
  }),
});

const acceptedSchema = z.strictObject({
  recipe: z.string().min(1),
  /** "ingredients.<i>" or "steps.<i>"; never a wrong number. */
  where: z.string().regex(/^(?:ingredients|steps)\.\d+$/),
  /** The kind reviewed: it passes only that one, so a line that begins to scale is reviewed again. */
  kind: z.enum(["class", "scales"]),
  reason: z.string().min(1),
});

const goldenFileSchema = z.strictObject({
  /** Where the recipes came from (an export, a fixture set). */
  source: z.string().min(1),
  /** The random draw's seed; null for a hand-built set. */
  seed: z.number().int().nullable(),
  /** Who wrote `expected`, and from what text. */
  expectedBy: z.string().min(1),
  recipes: z.array(goldenRecipeSchema).min(1),
  accepted: z.array(acceptedSchema),
});

export type GoldenFile = z.infer<typeof goldenFileSchema>;
export type GoldenRecipe = GoldenFile["recipes"][number];

/** Read and check every golden file in `dir`, sorted by name. */
export function loadGoldenFiles(dir: string): { name: string; file: GoldenFile }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = goldenFileSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      for (const r of file.recipes) {
        const lines = r.recipe.ingredients?.length ?? 0;
        const steps = r.recipe.steps?.length ?? 0;
        if (r.expected.ingredients.length !== lines || r.expected.steps.length !== steps) {
          throw new Error(
            `${name} ${r.id}: expected has ${r.expected.ingredients.length} lines and ${r.expected.steps.length} steps, the recipe ${lines} and ${steps}`,
          );
        }
      }
      return { name, file };
    });
}

export function legacyOf(recipe: GoldenRecipe): LegacyRecipe {
  return recipe.recipe;
}

/** What the cook sees for a line, in the expected values' terms. */
export type Shown =
  | { kind: "amount"; amount: number; amount_max?: number; unit: string }
  | { kind: "count"; count: number; count_max?: number }
  | { kind: "none"; shows: NoNumber };

export function shownFor(ingredient: Ingredient): Shown {
  const canonical = readScaledCanonical(ingredient, 1);
  if (canonical.as_written !== undefined) return { kind: "none", shows: "as written" };
  if (canonical.to_taste !== undefined) return { kind: "none", shows: "to taste" };
  if (canonical.unstated !== undefined) return { kind: "none", shows: "unstated" };
  if (canonical.count !== undefined) {
    return {
      kind: "count",
      count: canonical.count.min,
      ...(canonical.count.max !== undefined ? { count_max: canonical.count.max } : {}),
    };
  }
  const hints = scaledHints(ingredient, 1);
  const hint = hints[0] ?? ingredient.display_equivalents?.imperial ?? ingredient.display_equivalents?.metric;
  if (hint === undefined) {
    throw new Error(`${ingredient.id}: a measured line with no hint shows no stated number`);
  }
  return {
    kind: "amount",
    amount: hint.amount,
    ...(hint.amount_max !== undefined ? { amount_max: hint.amount_max } : {}),
    unit: hint.unit,
  };
}

/** What the source says the cook should see: a shown line, or no row at all. */
export type Expected = Shown | { kind: "blank" };

function isReading(line: ExpectedLine): line is ReadingLine {
  return typeof line === "object" && "class" in line;
}

export function expectedShown(line: Exclude<ExpectedLine, ReadingLine>): Expected {
  if (line === BLANK) return { kind: "blank" };
  if (typeof line === "string") return { kind: "none", shows: line };
  if ("shows" in line) return { kind: "none", shows: line.shows };
  if ("count" in line) {
    return {
      kind: "count",
      count: line.count,
      ...(line.count_max !== undefined ? { count_max: line.count_max } : {}),
    };
  }
  return {
    kind: "amount",
    amount: line.amount,
    ...(line.amount_max !== undefined ? { amount_max: line.amount_max } : {}),
    unit: line.unit,
  };
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
}

function sameOptionalNumber(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return sameNumber(a, b);
}

/** The reader's unit for a spelling, or the spelling itself when the table has none. */
function unitKey(unit: string): string {
  return unitFromAlias(unit)?.id ?? unit.trim().toLowerCase();
}

export interface Disagreement {
  recipe: string;
  where: string;
  kind: "wrong-number" | "class" | "scales";
  expected: string;
  actual: string;
}

/** Whether `accepted` lists this disagreement: its line and its kind. A wrong number never is. */
export function isAccepted(accepted: GoldenFile["accepted"], d: Disagreement): boolean {
  return accepted.some((a) => a.recipe === d.recipe && a.where === d.where && a.kind === d.kind);
}

function describe(shown: Expected): string {
  switch (shown.kind) {
    case "blank":
      return BLANK;
    case "amount":
      return `${shown.amount}${shown.amount_max !== undefined ? `–${shown.amount_max}` : ""} ${shown.unit}`;
    case "count":
      return `count ${shown.count}${shown.count_max !== undefined ? `–${shown.count_max}` : ""}`;
    case "none":
      return shown.shows;
  }
}

function compareLine(expected: Shown, actual: Shown): Disagreement["kind"] | null {
  if (actual.kind === "none") {
    return expected.kind === "none" && expected.shows === actual.shows ? null : "class";
  }
  if (expected.kind === "amount" && actual.kind === "amount") {
    return sameNumber(expected.amount, actual.amount) &&
      sameOptionalNumber(expected.amount_max, actual.amount_max) &&
      unitKey(expected.unit) === unitKey(actual.unit)
      ? null
      : "wrong-number";
  }
  if (expected.kind === "count" && actual.kind === "count") {
    return sameNumber(expected.count, actual.count) &&
      sameOptionalNumber(expected.count_max, actual.count_max)
      ? null
      : "wrong-number";
  }
  // A number shown where the source states none, or of another kind.
  return "wrong-number";
}

/** An ingredient read the way `ReadingLine` reads a source line. */
function readingOf(ingredient: Ingredient): ReadingLine {
  const canonical = readScaledCanonical(ingredient, 1);
  if (canonical.as_written !== undefined) return { class: "as_written", scales: false };
  if (canonical.to_taste !== undefined) return { class: "to_taste", scales: false };
  if (canonical.unstated !== undefined) return { class: "unstated", scales: false };
  const scales = ingredient.scaling !== "fixed";
  if (canonical.count !== undefined) {
    return {
      class: "count",
      scales,
      count: canonical.count.min,
      ...(canonical.count.max !== undefined ? { count_max: canonical.count.max } : {}),
      ...(canonical.count_unit !== undefined ? { count_unit: canonical.count_unit } : {}),
    };
  }
  const hints = ingredient.display_equivalents ?? {};
  const both = hints.imperial !== undefined && hints.metric !== undefined;
  return { class: both ? "compound" : "measured", scales, hints };
}

const SYSTEMS = ["imperial", "metric"] as const;

function sameStated(
  a: { amount: number; amount_max?: number; unit: string },
  b: { amount: number; amount_max?: number; unit: string },
) {
  return (
    sameNumber(a.amount, b.amount) &&
    sameOptionalNumber(a.amount_max, b.amount_max) &&
    unitKey(a.unit) === unitKey(b.unit)
  );
}

function describeReading(line: ReadingLine): string {
  const numbers = [
    ...(line.count === undefined
      ? []
      : [`${line.count}${line.count_max !== undefined ? `–${line.count_max}` : ""}`]),
    ...SYSTEMS.flatMap((s) => {
      const hint = line.hints?.[s];
      return hint === undefined
        ? []
        : [`${hint.amount}${hint.amount_max !== undefined ? `–${hint.amount_max}` : ""} ${unitKey(hint.unit)}`];
    }),
  ].join(" + ");
  return `${line.class}${numbers === "" ? "" : ` ${numbers}`}, ${line.scales ? "scales" : "fixed"}`;
}

function compareReading(expected: ReadingLine, actual: ReadingLine): Disagreement["kind"] | null {
  const countStated =
    actual.count === undefined ||
    (expected.count !== undefined && sameNumber(expected.count, actual.count));
  const hintsStated = SYSTEMS.every((s) => {
    const shown = actual.hints?.[s];
    const stated = expected.hints?.[s];
    return shown === undefined || (stated !== undefined && sameStated(stated, shown));
  });
  if (!countStated || !hintsStated) return "wrong-number";
  if (actual.scales && !expected.scales) return "scales";
  // A line kept as written shows its own text, so every number it states.
  const fewer =
    actual.class !== "as_written" &&
    ((expected.count !== undefined && actual.count === undefined) ||
      SYSTEMS.some((s) => expected.hints?.[s] !== undefined && actual.hints?.[s] === undefined));
  return fewer || expected.class !== actual.class || expected.scales !== actual.scales
    ? "class"
    : null;
}

/**
 * Unit spellings that differ only in notation ("cups" written, "cup" shown),
 * each pair once, sorted. Not a wrong number; B4 lists it once in the report.
 */
export function notationDifferences(pairs: { golden: GoldenRecipe; recipe: Recipe }[]): string[] {
  const seen = new Set<string>();
  for (const { golden, recipe } of pairs) {
    golden.expected.ingredients.forEach((line, i) => {
      if (isReading(line)) return;
      const expected = expectedShown(line);
      const ingredient = ingredientAt(recipe, i);
      if (expected.kind !== "amount" || ingredient === undefined) return;
      const actual = shownFor(ingredient);
      if (actual.kind !== "amount" || compareLine(expected, actual) !== null) return;
      if (expected.unit !== actual.unit) seen.add(`${expected.unit} → ${actual.unit}`);
    });
  }
  return [...seen].sort();
}

/** Every disagreement between a converted recipe and its expected values. */
export function compareRecipe(golden: GoldenRecipe, recipe: Recipe): Disagreement[] {
  const out: Disagreement[] = [];
  const push = (where: string, kind: Disagreement["kind"], expected: string, actual: string) =>
    out.push({ recipe: golden.id, where, kind, expected, actual });

  if (golden.expected.serves !== recipe.serves_base) {
    push("serves", "wrong-number", String(golden.expected.serves), String(recipe.serves_base));
  }
  // A count shown as the source's when it is Sous's, or the reverse, is a
  // wrong number too: the cook reads where it came from.
  if (golden.expected.servesEstimated !== (recipe.serves_estimated === true)) {
    const said = (estimated: boolean) => (estimated ? "Sous's estimate" : "stated");
    push("serves", "wrong-number", said(golden.expected.servesEstimated), said(recipe.serves_estimated === true));
  }
  // By stored index, not position: a skipped blank line leaves a gap in the
  // converted list, and every line after it keeps its stored id.
  golden.expected.ingredients.forEach((line, i) => {
    if (isReading(line)) {
      const ingredient = ingredientAt(recipe, i);
      if (ingredient === undefined) {
        push(`ingredients.${i}`, "wrong-number", describeReading(line), "missing");
        return;
      }
      const actual = readingOf(ingredient);
      const kind = compareReading(line, actual);
      if (kind !== null) push(`ingredients.${i}`, kind, describeReading(line), describeReading(actual));
      if (line.scaled !== undefined && actual.scales) {
        const at2 = ingredientLine(ingredient, 2);
        const at23 = ingredientLine(ingredient, 2 / 3);
        const shown2 = "amount" in at2 ? at2.amount : at2.kind;
        const shown23 = "amount" in at23 ? at23.amount : at23.kind;
        if (shown2 !== line.scaled.x2) {
          push(`ingredients.${i}`, "wrong-number", `×2 ${line.scaled.x2}`, `×2 ${shown2}`);
        }
        if (shown23 !== line.scaled.x2_3) {
          push(`ingredients.${i}`, "wrong-number", `×⅔ ${line.scaled.x2_3}`, `×⅔ ${shown23}`);
        }
      }
      return;
    }
    const expected = expectedShown(line);
    const ingredient = ingredientAt(recipe, i);
    if (ingredient === undefined) {
      if (expected.kind !== "blank") {
        push(`ingredients.${i}`, "wrong-number", describe(expected), "missing");
      }
      return;
    }
    const actual = shownFor(ingredient);
    if (expected.kind === "blank") {
      // A row where the source has no line: a number there is a wrong number.
      const kind = actual.kind === "none" ? "class" : "wrong-number";
      push(`ingredients.${i}`, kind, describe(expected), describe(actual));
      return;
    }
    const kind = compareLine(expected, actual);
    if (kind !== null) push(`ingredients.${i}`, kind, describe(expected), describe(actual));
  });
  golden.expected.steps.forEach((step, i) => {
    const actual = stepAt(recipe, i)?.timer_sec ?? null;
    if (step.timer_sec !== actual) {
      // No timer where the source states one shows no number: reviewed, not wrong.
      const kind = actual === null ? "class" : "wrong-number";
      push(`steps.${i}`, kind, `timer ${step.timer_sec}`, `timer ${actual}`);
    }
  });
  return out;
}
