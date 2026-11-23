/**
 * The library backfill (slice P decision 9): plans for the library rows that
 * have none current, worked out by the operator, never on a schedule.
 * `scripts/backfill-library-cook-plans.ts` drives it.
 *
 * - `selectBackfillRows`: the rows to derive. Pending ones (missing, stale,
 *   a transient failure), settled failures too with `retryFailed`, narrowed
 *   by `only`. A current row is never derived, so a re-run resumes.
 * - `runLibraryBackfill`: derives them two at a time, each call checked
 *   against the ledger's cap before it is made (`CostLedger`), each row
 *   written through the guarded write (`storeLibraryPlan`), so a row edited
 *   by a Refresh meanwhile is skipped as `changed under it`. It stops starting
 *   recipes when the cap refuses a call (that recipe is left unstored, for
 *   the next run), or when, after the first 10 settled
 *   outcomes, the run has two or more settled failures and its valid rate is
 *   below its gate (`validRateStops`; a prompt problem: it escalates, never
 *   retries). A row whose derivation or write throws is
 *   recorded and the run goes on.
 */

import type { CostLedger } from "./cook-plan-cost";
import type { RecipeForPlan } from "./kitchen/cook-plan";
import { CookPlanCapReached, type DeriveMeter } from "./kitchen/cook-plan-derive";
import { COOK_PLAN_GATES } from "./kitchen/cook-plan-scorer";
import { isSettledPlanError, planSourceHash } from "./kitchen/cook-plan-stamp";
import {
  deriveLibraryPlan,
  libraryPlanNeedsDerive,
  libraryPlanStatus,
  libraryRecipeForPlan,
  storeLibraryPlan,
  type LibraryPlanColumns,
  type LibraryPlanListing,
  type LibraryPlanStatus,
  type StoreLibraryPlanResult,
} from "./library-cook-plans";

/** Two derivations at a time (P decision 9). */
export const BACKFILL_CONCURRENCY = 2;

/** The valid-rate stop judges only after this many settled outcomes. */
export const VALID_RATE_STOP_AFTER = 10;

/** A lone settled failure never stops a run; the stop needs this many. */
export const VALID_RATE_STOP_MISSES = 2;

/**
 * The valid-rate stop (DECISIONS 2026-10-11, "a lone miss never stops a
 * run"): from `stopAfter` settled outcomes on, the run stops once it has at
 * least `VALID_RATE_STOP_MISSES` settled failures and its valid rate is under
 * the gate (14/15). Two misses by 15 stop it; two in 30 sit at the gate and
 * don't; one never does.
 */
export function validRateStops(valid: number, settled: number, stopAfter = VALID_RATE_STOP_AFTER): boolean {
  return (
    settled >= stopAfter && settled - valid >= VALID_RATE_STOP_MISSES && valid / settled < COOK_PLAN_GATES.validPlans
  );
}

/** Why the valid rate stopped a run, for the script's "Stopped short" line. */
export function describeValidRateStop(valid: number, settled: number): string {
  const rate = ((valid / settled) * 100).toFixed(1);
  return (
    `the valid rate stopped the run, ${settled - valid} of ${settled} settled plans failed (${rate}% valid): ` +
    "two or more misses under the 14/15 gate point at the prompt, so escalate rather than re-run"
  );
}

/** A row the backfill will derive, with the derive input and its hash. */
export interface BackfillTarget {
  slug: string;
  name: string;
  status: LibraryPlanStatus;
  recipe: RecipeForPlan;
  madeFor: string;
}

export interface BackfillSelection {
  targets: BackfillTarget[];
  /** Rows `only` named that won't be derived, with why (their status). */
  skipped: Array<{ slug: string; status: LibraryPlanStatus }>;
  /** Slugs `only` named that the library doesn't have. */
  unknown: string[];
}

/** The rows a run derives, in Doc order. */
export function selectBackfillRows(
  rows: readonly LibraryPlanListing[],
  { only = [], retryFailed = false }: { only?: readonly string[]; retryFailed?: boolean } = {},
): BackfillSelection {
  const named = new Set(only);
  const targets: BackfillTarget[] = [];
  const skipped: BackfillSelection["skipped"] = [];
  for (const row of rows) {
    if (named.size > 0 && !named.has(row.docSlug)) continue;
    const status = libraryPlanStatus(row);
    if (!libraryPlanNeedsDerive(status, { retryFailed })) {
      if (named.size > 0) skipped.push({ slug: row.docSlug, status });
      continue;
    }
    const recipe = libraryRecipeForPlan(row);
    targets.push({ slug: row.docSlug, name: row.name, status, recipe, madeFor: planSourceHash(recipe) });
  }
  const known = new Set(rows.map((r) => r.docSlug));
  return { targets, skipped, unknown: only.filter((slug) => !known.has(slug)) };
}

export type BackfillOutcome = "plan" | "failed settled" | "failed transient" | "threw";

export interface BackfilledRow {
  slug: string;
  name: string;
  outcome: BackfillOutcome;
  /** What the guarded write did; null when the derivation threw before it. */
  stored: StoreLibraryPlanResult | null;
  /** The plan's error, or the thrown message. */
  detail: string | null;
}

export interface BackfillResult {
  rows: BackfilledRow[];
  /** Slugs not derived because the run stopped: never started, or stopped by the cap mid-way (nothing stored). */
  left: string[];
  stop: "cap" | "valid rate" | null;
  /** Plans among the settled outcomes of this run. */
  valid: number;
  /** Plans plus settled failures of this run (the valid rate's denominator). */
  settled: number;
}

/** `deriveLibraryPlan`, in the script and the tests (over a stubbed chat). */
export type DeriveLibraryRow = (
  slug: string,
  recipe: RecipeForPlan,
  meter: DeriveMeter,
) => Promise<LibraryPlanColumns>;

function outcomeOf(columns: LibraryPlanColumns): BackfillOutcome {
  if (columns.cookPlan !== null) return "plan";
  return isSettledPlanError(columns.cookPlanError) ? "failed settled" : "failed transient";
}

export async function runLibraryBackfill(
  targets: readonly BackfillTarget[],
  ledger: CostLedger,
  {
    derive = deriveLibraryPlan,
    store = storeLibraryPlan,
    concurrency = BACKFILL_CONCURRENCY,
    stopAfter = VALID_RATE_STOP_AFTER,
    onRow,
  }: {
    derive?: DeriveLibraryRow;
    store?: typeof storeLibraryPlan;
    concurrency?: number;
    stopAfter?: number;
    onRow?: (row: BackfilledRow) => void;
  } = {},
): Promise<BackfillResult> {
  const rows: BackfilledRow[] = [];
  let next = 0;
  const capped = new Set<string>();
  let stop: BackfillResult["stop"] = null;
  let valid = 0;
  let settled = 0;

  /** The row derived (and its write tried), or null when the cap refused one of its calls. */
  async function one(target: BackfillTarget): Promise<BackfilledRow | null> {
    const base = { slug: target.slug, name: target.name };
    let columns: LibraryPlanColumns;
    try {
      columns = await derive(target.slug, target.recipe, ledger.meter());
    } catch (err) {
      if (err instanceof CookPlanCapReached) return null;
      ledger.finishRecipe();
      return { ...base, outcome: "threw", stored: null, detail: err instanceof Error ? err.message : String(err) };
    }
    ledger.finishRecipe();
    const outcome = outcomeOf(columns);
    if (outcome === "plan") valid++;
    if (outcome !== "failed transient") settled++;
    try {
      const stored = await store(target.slug, target.madeFor, columns);
      return { ...base, outcome, stored, detail: columns.cookPlanError };
    } catch (err) {
      return { ...base, outcome: "threw", stored: null, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async function worker(): Promise<void> {
    while (stop === null && next < targets.length) {
      const target = targets[next++]!;
      const row = await one(target);
      if (row === null) {
        // The cap had no room for one of its calls: nothing stored, and no
        // more recipes start (one still in flight finishes, or is refused too).
        capped.add(target.slug);
        stop = "cap";
        return;
      }
      rows.push(row);
      onRow?.(row);
      if (stop === null && validRateStops(valid, settled, stopAfter)) stop = "valid rate";
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const left = targets.filter((t, i) => i >= next || capped.has(t.slug)).map((t) => t.slug);
  return { rows, left, stop, valid, settled };
}
