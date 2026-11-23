/**
 * Loader for the cook-plan eval corpus (`fixtures/cook-plan/`, labelling
 * rules in its README).
 *
 * Shared by the offline eval test and `scripts/eval-cook-plan.ts`. The labels
 * define the eval gate, so a malformed one throws here rather than silently
 * moving a score: indices out of range, two ahead items sharing an anchor or a
 * step, or an item no derived task could ever find.
 *
 * Derived snapshots (`fixtures/cook-plan/derived/`) are what the script got
 * from the model. Each carries hashes of the prompt and recipe it came from, so
 * the offline test can tell a stale snapshot from a current one.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ChatRecipeIngredient } from "../../../../drizzle/schema";
import type { CookPlanGold } from "../cook-plan-scorer";
import { loadStepIngredientFixtures } from "./load-step-ingredient-fixtures";

export const PREP_STYLES = ["front-loaded", "inline", "implied"] as const;
export type PrepStyle = (typeof PREP_STYLES)[number];

const index = z.number().int();

const fixtureSchema = z.strictObject({
  description: z.string().min(1),
  prepStyles: z.array(z.enum(PREP_STYLES)).min(1),
  recipe: z
    .strictObject({
      ingredients: z.array(
        z.strictObject({
          item: z.string().min(1),
          amount: z.string().optional(),
          unit: z.string().optional(),
        }),
      ),
      steps: z.array(z.string().min(1)).min(1),
    })
    .optional(),
  recipeFrom: z.string().min(1).optional(),
  gold: z.strictObject({
    ahead: z.array(
      z.strictObject({
        what: z.string().min(1),
        ingredients: z.array(index),
        steps: z.array(index),
      }),
    ),
    mise: z.array(index),
    handsOffSteps: z.array(index),
  }),
});

export interface CookPlanFixture {
  /** File basename without extension. */
  name: string;
  description: string;
  prepStyles: PrepStyle[];
  /**
   * The recipe as the plans in `derived/` were made from it: ingredients and
   * steps. The layout tests read those plans against this.
   */
  recipe: { ingredients: ChatRecipeIngredient[]; steps: string[] };
  /**
   * For a recipe borrowed from the step-ingredient corpus (`recipeFrom`), that
   * corpus's labelled mapping, as an intake recipe carries one. The eval
   * derives and scores with it (`gateRecipe`); an inline recipe has none.
   */
  stepIngredients?: number[][];
  gold: CookPlanGold;
}

export type RecipeLookup = (
  name: string,
) => (CookPlanFixture["recipe"] & { stepIngredients?: number[][] }) | undefined;

/**
 * The recipe the eval derives and scores: the fixture's, with its mapping
 * when it has one (cook-fidelity plan, decision 3).
 */
export function gateRecipe(
  fixture: CookPlanFixture,
): CookPlanFixture["recipe"] & { stepIngredients?: number[][] } {
  return fixture.stepIngredients === undefined
    ? fixture.recipe
    : { ...fixture.recipe, stepIngredients: fixture.stepIngredients };
}

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "cook-plan",
);

/**
 * The plans the layout tests cook: the eval's snapshots as of 2026-10-04,
 * kept fixed so a prompt change moves the eval, not every layout table
 * (README).
 */
export const DERIVED_DIR = join(FIXTURES_DIR, "derived");

/** The eval's snapshots under the shipped prompt, re-scored offline by `cook-plan-eval.test.ts`. */
export const GATE_DIR = join(FIXTURES_DIR, "gate");

function checkIndices(
  name: string,
  what: string,
  indices: number[],
  count: number,
): void {
  const seen = new Set<number>();
  for (const i of indices) {
    if (i < 0 || i >= count) {
      throw new Error(`Fixture ${name}: ${what} index ${i} is out of range (${count})`);
    }
    if (seen.has(i)) throw new Error(`Fixture ${name}: ${what} lists ${i} twice`);
    seen.add(i);
  }
}

function checkDisjoint(name: string, what: string, sets: number[][]): void {
  const owner = new Map<number, number>();
  sets.forEach((set, item) => {
    for (const i of set) {
      const other = owner.get(i);
      if (other !== undefined) {
        throw new Error(
          `Fixture ${name}: ahead items ${other} and ${item} share ${what} ${i}`,
        );
      }
      owner.set(i, item);
    }
  });
}

/** Parse and check one fixture; throws with the fixture's name on any fault. */
export function parseCookPlanFixture(
  name: string,
  raw: unknown,
  lookup: RecipeLookup,
): CookPlanFixture {
  const parsed = fixtureSchema.parse(raw);

  if ((parsed.recipe === undefined) === (parsed.recipeFrom === undefined)) {
    throw new Error(`Fixture ${name}: needs exactly one of recipe or recipeFrom`);
  }
  const recipe: ReturnType<RecipeLookup> = parsed.recipe ?? lookup(parsed.recipeFrom!);
  if (!recipe) {
    throw new Error(`Fixture ${name}: recipeFrom "${parsed.recipeFrom}" not found`);
  }

  const ingredientCount = recipe.ingredients.length;
  const stepCount = recipe.steps.length;
  const { gold } = parsed;

  checkIndices(name, "mise", gold.mise, ingredientCount);
  checkIndices(name, "handsOffSteps", gold.handsOffSteps, stepCount);
  gold.ahead.forEach((item, i) => {
    checkIndices(name, `ahead[${i}].ingredients`, item.ingredients, ingredientCount);
    checkIndices(name, `ahead[${i}].steps`, item.steps, stepCount);
    if (item.steps.length === 0 && item.ingredients.length === 0) {
      throw new Error(
        `Fixture ${name}: ahead item "${item.what}" has no steps or anchors, so nothing can find it`,
      );
    }
  });
  checkDisjoint(name, "ingredient", gold.ahead.map((item) => item.ingredients));
  checkDisjoint(name, "step", gold.ahead.map((item) => item.steps));

  return {
    name,
    description: parsed.description,
    prepStyles: parsed.prepStyles,
    recipe: { ingredients: recipe.ingredients, steps: recipe.steps },
    ...(recipe.stepIngredients !== undefined && { stepIngredients: recipe.stepIngredients }),
    gold,
  };
}

/** Read and check every fixture, sorted by name. */
export function loadCookPlanFixtures(): CookPlanFixture[] {
  const stepFixtures = new Map(
    loadStepIngredientFixtures().map((f) => [
      f.name,
      { ingredients: f.ingredients, steps: f.steps, stepIngredients: f.golden },
    ]),
  );
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) =>
      parseCookPlanFixture(
        file.replace(/\.json$/, ""),
        JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")),
        (name) => stepFixtures.get(name),
      ),
    );
}

const snapshotSchema = z.strictObject({
  /** "provider/model" that produced it. */
  model: z.string().min(1),
  thinkingBudget: z.number().int().nonnegative(),
  promptHash: z.string().min(1),
  recipeHash: z.string().min(1),
  /** Wall time of the derivation, retries included. */
  ms: z.number().nonnegative(),
  /** Set when the derivation threw (truncated twice, model error). */
  error: z.string().nullable(),
  /** The model's output as `deriveCookPlan` returned it; null on error. */
  raw: z.unknown(),
  /**
   * Tokens over every call of the derivation, as the provider reported them
   * (slice P; snapshots from before it have none).
   */
  usage: z
    .strictObject({
      calls: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
});

export type CookPlanSnapshot = z.infer<typeof snapshotSchema>;

/** Short, stable content hash for staleness checks. */
export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function recipeHash(recipe: ReturnType<typeof gateRecipe>): string {
  return contentHash(JSON.stringify(recipe));
}

/** Read every snapshot in `dir`, keyed by fixture name. */
export function loadCookPlanSnapshots(
  dir: string = DERIVED_DIR,
): Map<string, CookPlanSnapshot> {
  if (!existsSync(dir)) return new Map();
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((file) => [
        file.replace(/\.json$/, ""),
        snapshotSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8"))),
      ]),
  );
}
