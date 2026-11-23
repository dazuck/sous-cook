/**
 * Loader + shared helpers for the step-ingredient eval corpus.
 *
 * Used by both the Vitest regression guard (`step-ingredient-eval.test.ts`)
 * and the standalone baseline script (`scripts/eval-step-ingredients.ts`) so
 * fixture parsing and the regex-approach prediction live in exactly one place.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  ingredientToString,
  resolveStepIngredientIndices,
} from "../step-ingredients";

const ingredientSchema = z.object({
  item: z.string(),
  amount: z.string().optional(),
  unit: z.string().optional(),
});

const fixtureSchema = z.object({
  description: z.string(),
  ingredients: z.array(ingredientSchema),
  steps: z.array(z.string()),
  golden: z.array(z.array(z.number().int())),
});

export type StepIngredientFixture = z.infer<typeof fixtureSchema> & {
  /** File basename without extension, used as a stable label. */
  name: string;
};

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "step-ingredients",
);

/**
 * Read, parse, and validate every fixture in the corpus directory.
 * Throws (loudly) if a fixture is malformed, has a golden array whose length
 * differs from its step count, or references an out-of-bounds ingredient index.
 */
export function loadStepIngredientFixtures(): StepIngredientFixture[] {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  return files.map((file) => {
    const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
    const parsed = fixtureSchema.parse(JSON.parse(raw));
    const name = file.replace(/\.json$/, "");

    if (parsed.golden.length !== parsed.steps.length) {
      throw new Error(
        `Fixture ${name}: golden length ${parsed.golden.length} != steps length ${parsed.steps.length}`,
      );
    }
    parsed.golden.forEach((indices, stepIdx) => {
      for (const i of indices) {
        if (i < 0 || i >= parsed.ingredients.length) {
          throw new Error(
            `Fixture ${name}: golden step ${stepIdx} references out-of-bounds ingredient index ${i}`,
          );
        }
      }
    });

    return { ...parsed, name };
  });
}

/** Pre-format a fixture's structured ingredients into display strings. */
export function fixtureIngredientStrings(
  fixture: StepIngredientFixture,
): string[] {
  return fixture.ingredients.map(ingredientToString);
}

/**
 * Predict per-step ingredient indices using the legacy fuzzy regex matcher
 * (no explicit mapping). This is the baseline approach under test.
 */
export function regexPredictions(fixture: StepIngredientFixture): number[][] {
  const ingredientStrings = fixtureIngredientStrings(fixture);
  return fixture.steps.map((_, i) =>
    resolveStepIngredientIndices(i, fixture.steps, ingredientStrings),
  );
}
