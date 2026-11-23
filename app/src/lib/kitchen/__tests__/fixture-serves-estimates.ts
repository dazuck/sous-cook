/**
 * Sous's serving estimates for the test recipes that state no count (slice
 * B4b): the 15 cook-plan fixtures, the zucchini wraps and a synthetic herb
 * salt. Made once by the real estimator (`estimateServes`,
 * `src/lib/serves-estimate.ts`) and committed, so tests read real estimator
 * output and never call a model. Kept beside the recipes, as the
 * app keeps an estimate beside the stored source: inside a fixture's recipe it
 * would move the recipe hash every derived plan snapshot is checked against.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const fileSchema = z.strictObject({
  version: z.literal(1),
  proposedAt: z.string(),
  model: z.string(),
  estimates: z.record(
    z.string(),
    z.strictObject({
      count: z.number().int().min(1).max(48),
      basis: z.string().min(1),
      hasAmounts: z.boolean(),
    }),
  ),
});

let cache: z.infer<typeof fileSchema>["estimates"] | null = null;

function estimates() {
  cache ??= fileSchema.parse(
    JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "serves-estimates.json"), "utf8")),
  ).estimates;
  return cache;
}

/** A fixture's estimate as the converter takes it. Throws for a key it doesn't hold. */
export function fixtureServesEstimate(key: string): { count: number; basis: string } {
  const found = estimates()[key];
  if (found === undefined) throw new Error(`No serving estimate for fixture "${key}" (fixtures/serves-estimates.json)`);
  return { count: found.count, basis: found.basis };
}
