/**
 * The family library's cook plans, worked out ahead of time (slice P).
 *
 * A library row (`doc_recipes`) carries the plan made from its derive input,
 * or the error that says why there is none, with the input's hash and the
 * stamp of what made it (`cook-plan-stamp.ts`). This module decides, per
 * row:
 * - `planForChunk`: what Refresh stores beside a new extraction. The saved
 *   plan or settled error when the extraction's derive input and the running
 *   stamp both match it (no call), else one derivation, unless the run's
 *   time budget is spent or its dollar cap (`REFRESH_MAX_USD`) has no room
 *   for one of the derivation's calls (`pending`, no plan). The result goes
 *   into the row's own upsert, so a plan never sits beside steps it wasn't
 *   made for.
 * - `storeLibraryPlan`: the guarded write the backfill uses. Under the same
 *   advisory lock as the sync's save, it re-reads the row and writes only if
 *   the row still has the derive input the plan was made for.
 * - `libraryPlanStatus` and `libraryPlanReport`: the check-only
 *   classification and the free report the pack view reads.
 * - `auditLibraryPlans`: `plan-report`'s re-check of every stored plan with
 *   the validator, and the valid rate beside its gate.
 *
 * Failures are settled or transient (`isSettledPlanError`): a settled one is
 * kept until the recipe's text or the stamp changes; a transient one is
 * retried by the next Refresh (P decision 8).
 */

import { randomUUID } from "node:crypto";
import { eq, isNull, and, sql } from "drizzle-orm";
import { db, docRecipes, kitchens } from "./db";
import { hasStepsToPlan, parseCookPlan, type CookPlan, type RecipeForPlan } from "./kitchen/cook-plan";
import { COOK_PLAN_GATES } from "./kitchen/cook-plan-scorer";
import { CookPlanCapReached, deriveCookPlanOutcome, type DeriveMeter, type DerivedCookPlan } from "./kitchen/cook-plan-derive";
import { CostLedger } from "./cook-plan-cost";
import {
  cookPlanStamp,
  isSettledPlanError,
  planSourceHash,
  verifyStoredPlan,
} from "./kitchen/cook-plan-stamp";
import { logCookPlanRejections } from "./kitchen-queue";

/**
 * Refresh stops starting derivations once it has run this long. The tRPC
 * function's limit is 300 s (`maxDuration` on the route; Vercel Hobby with
 * fluid compute), and a derivation can take 45 s, so 200 s leaves room for
 * the last ones and the saves.
 */
export const REFRESH_PLAN_BUDGET_MS = 200_000;

/**
 * The dollar cap of one Refresh's derivations, held by a `CostLedger`: a model
 * call starts only if what the run has spent, plus the bound of every call
 * still in flight, plus its own bound is at most this. A Refresh therefore
 * spends at most $0.50 as long as no call is billed past its bound (the
 * ledger counts any that is, `overBound`). A refused call leaves its recipe
 * `pending`; the run's later recipes still ask, and start if theirs fits.
 *
 * A first call's bound is about 9 cents (its 8,192 output tokens, and its
 * input bytes) against about 2 cents billed, and up to four recipes plan at
 * once (`EXTRACTION_CONCURRENCY` in `recipe-sync.ts`), so refusals can start
 * once about 14 cents is spent, well short of $0.50. A steady-state Refresh
 * derives only what changed, so the cap binds only one that finds most of
 * the library without a current plan (the first after release, if it comes
 * before the backfill); the rest stay `pending` for the backfill or the next
 * Refresh.
 */
export const REFRESH_MAX_USD = 0.5;

/**
 * Whether a run may start another derivation: a meter for it (its calls
 * still each checked against the run's cap), or null when its time is spent.
 */
export interface PlanBudget {
  start(): DeriveMeter | null;
}

/** A budget of `ms` from now, on an injectable clock, its calls metered by one ledger (`REFRESH_MAX_USD` by default). */
export function planBudget(
  ms: number = REFRESH_PLAN_BUDGET_MS,
  now: () => number = Date.now,
  ledger: CostLedger = new CostLedger(REFRESH_MAX_USD),
): PlanBudget {
  const start = now();
  return { start: () => (now() - start < ms ? ledger.meter() : null) };
}

/** The four plan columns of a library row, as written together. */
export interface LibraryPlanColumns {
  cookPlan: CookPlan | null;
  cookPlanError: string | null;
  cookPlanSourceHash: string | null;
  cookPlanStamp: string | null;
}

export const NO_PLAN: LibraryPlanColumns = {
  cookPlan: null,
  cookPlanError: null,
  cookPlanSourceHash: null,
  cookPlanStamp: null,
};

/** A saved row's plan columns, the plan as stored (not yet trusted). */
export type SavedPlan = Omit<LibraryPlanColumns, "cookPlan"> & { cookPlan: unknown };

/**
 * What a chunk's plan step decided:
 * - `none`: the recipe has no steps, so there is nothing to plan;
 * - `reused`: the saved plan or settled error, no call;
 * - `derived`: one derivation, its plan or its error;
 * - `pending`: the budget was spent, so no plan for now (the next Refresh).
 */
export interface ChunkPlan {
  outcome: "none" | "reused" | "derived" | "pending";
  columns: LibraryPlanColumns;
}

/** The derive input of a library row: the fields `docRecipeToQueueData` carries to the plan. */
export function libraryRecipeForPlan(row: {
  ingredients: RecipeForPlan["ingredients"] | null;
  steps: string[] | null;
  stepIngredients: number[][] | null;
}): RecipeForPlan {
  return {
    ingredients: row.ingredients ?? undefined,
    steps: row.steps ?? undefined,
    stepIngredients: row.stepIngredients ?? undefined,
  };
}

/** The saved plan columns of a library row that extracted, if any. */
export async function readSavedPlan(docSlug: string): Promise<SavedPlan | undefined> {
  const [row] = await db
    .select({
      cookPlan: docRecipes.cookPlan,
      cookPlanError: docRecipes.cookPlanError,
      cookPlanSourceHash: docRecipes.cookPlanSourceHash,
      cookPlanStamp: docRecipes.cookPlanStamp,
    })
    .from(docRecipes)
    .where(and(eq(docRecipes.docSlug, docSlug), isNull(docRecipes.extractionError)));
  return row;
}

async function resolveHomeKitchenIdForLog(): Promise<string> {
  // FIXME(WP3b): pass kitchenId into deriveLibraryPlan directly once library tables are scoped.
  const [home] = await db
    .select({ id: kitchens.id })
    .from(kitchens)
    .where(eq(kitchens.slug, "home"))
    .limit(1);
  if (!home) {
    throw new Error('Default "home" kitchen not found; run `pnpm --dir app db:migrate`.');
  }
  return home.id;
}

/**
 * One derivation of a library recipe's plan, as the columns to store. Each
 * rejected reply is logged under `cook-plan:doc:<slug>`, so a recipe that
 * needs a fix can be read back. Throws `CookPlanCapReached` when the meter
 * refuses a call (nothing to store), after logging any reply the validator
 * had already turned down: the call it paid for is read back like any other.
 */
export async function deriveLibraryPlan(
  docSlug: string,
  recipe: RecipeForPlan,
  meter: DeriveMeter,
): Promise<LibraryPlanColumns> {
  const sessionId = `cook-plan:doc:${docSlug}`;
  const derivation = randomUUID();
  let derived: DerivedCookPlan;
  try {
    derived = await deriveCookPlanOutcome(recipe, { beforeCall: meter.beforeCall, onUsage: meter.onUsage });
  } catch (err) {
    if (err instanceof CookPlanCapReached && err.rejections.length > 0) {
      const kitchenId = await resolveHomeKitchenIdForLog();
      await logCookPlanRejections(kitchenId, sessionId, derivation, err.rejections);
    }
    throw err;
  }
  const { plan, error, rejections } = derived;
  if (rejections.length > 0) {
    const kitchenId = await resolveHomeKitchenIdForLog();
    await logCookPlanRejections(kitchenId, sessionId, derivation, rejections);
  }
  return {
    cookPlan: plan,
    cookPlanError: error,
    cookPlanSourceHash: planSourceHash(recipe),
    cookPlanStamp: cookPlanStamp(),
  };
}

/**
 * The plan to store with a new extraction of `docSlug`. Reuse needs the
 * saved row's hash to equal this extraction's derive input and its stamp the
 * running one; then a plan that still validates, or a settled error, is kept
 * with no call. A transient error, a stored plan that no longer validates,
 * or anything else stale derives once, if the budget allows: its time, and
 * its cap before each call. A derivation the cap stops is `pending` too.
 */
export async function planForChunk(
  docSlug: string,
  recipe: RecipeForPlan,
  saved: SavedPlan | undefined,
  budget: PlanBudget,
): Promise<ChunkPlan> {
  if (!hasStepsToPlan(recipe)) return { outcome: "none", columns: NO_PLAN };

  const hash = planSourceHash(recipe);
  const stamp = cookPlanStamp();
  if (saved && saved.cookPlanSourceHash === hash && saved.cookPlanStamp === stamp) {
    if (saved.cookPlan != null) {
      const check = verifyStoredPlan(saved.cookPlan, hash, stamp, recipe);
      if (check.ok) {
        return {
          outcome: "reused",
          columns: { cookPlan: check.plan, cookPlanError: null, cookPlanSourceHash: hash, cookPlanStamp: stamp },
        };
      }
    } else if (isSettledPlanError(saved.cookPlanError)) {
      return {
        outcome: "reused",
        columns: { cookPlan: null, cookPlanError: saved.cookPlanError, cookPlanSourceHash: hash, cookPlanStamp: stamp },
      };
    }
  }

  const meter = budget.start();
  if (meter === null) return { outcome: "pending", columns: NO_PLAN };
  try {
    return { outcome: "derived", columns: await deriveLibraryPlan(docSlug, recipe, meter) };
  } catch (err) {
    if (err instanceof CookPlanCapReached) return { outcome: "pending", columns: NO_PLAN };
    throw err;
  }
}

export type StoreLibraryPlanResult = "stored" | "changed under it" | "already current";

/**
 * Writes a plan (or its error) derived outside any transaction to a library
 * row, only if the row still has the derive input it was made for
 * (`madeFor`, a `planSourceHash`) and holds no current plan. Holds the
 * sync's advisory lock on the slug (`saveRecipe`), so a Refresh can't
 * rewrite the steps between the check and the write.
 */
export async function storeLibraryPlan(
  docSlug: string,
  madeFor: string,
  columns: LibraryPlanColumns,
): Promise<StoreLibraryPlanResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${docSlug}))`);
    const [row] = await tx
      .select({
        ingredients: docRecipes.ingredients,
        steps: docRecipes.steps,
        stepIngredients: docRecipes.stepIngredients,
        extractionError: docRecipes.extractionError,
        cookPlan: docRecipes.cookPlan,
        cookPlanSourceHash: docRecipes.cookPlanSourceHash,
        cookPlanStamp: docRecipes.cookPlanStamp,
      })
      .from(docRecipes)
      .where(eq(docRecipes.docSlug, docSlug));
    if (!row || row.extractionError !== null) return "changed under it";
    const recipe = libraryRecipeForPlan(row);
    if (planSourceHash(recipe) !== madeFor) return "changed under it";
    if (verifyStoredPlan(row.cookPlan, row.cookPlanSourceHash, row.cookPlanStamp, recipe).ok) {
      return "already current";
    }
    await tx.update(docRecipes).set(columns).where(eq(docRecipes.docSlug, docSlug));
    return "stored";
  });
}

export type LibraryPlanStatus =
  | "current"
  | "missing"
  | "stale (hash)"
  | "stale (stamp)"
  | "failed settled"
  | "failed transient"
  | "no steps"
  | "extraction failed";

/** A library row as the status reads it: the plan's presence, not the plan. */
export interface LibraryPlanRow {
  extractionError: string | null;
  ingredients: RecipeForPlan["ingredients"] | null;
  steps: string[] | null;
  stepIngredients: number[][] | null;
  hasPlan: boolean;
  cookPlanError: string | null;
  cookPlanSourceHash: string | null;
  cookPlanStamp: string | null;
}

/**
 * Where a library row's plan stands, from its columns alone (no parse: a
 * `current` plan that no longer validates is `plan-report`'s to find).
 */
export function libraryPlanStatus(row: LibraryPlanRow): LibraryPlanStatus {
  if (row.extractionError !== null) return "extraction failed";
  const recipe = libraryRecipeForPlan(row);
  if (!hasStepsToPlan(recipe)) return "no steps";
  if (!row.hasPlan && row.cookPlanError === null) return "missing";
  if (row.cookPlanSourceHash !== planSourceHash(recipe)) return "stale (hash)";
  if (row.cookPlanStamp !== cookPlanStamp()) return "stale (stamp)";
  if (row.hasPlan) return "current";
  return isSettledPlanError(row.cookPlanError) ? "failed settled" : "failed transient";
}

/** Statuses still waiting on a derivation: not current, not a settled failure. */
const PENDING: ReadonlySet<LibraryPlanStatus> = new Set([
  "missing",
  "stale (hash)",
  "stale (stamp)",
  "failed transient",
]);

/** Whether the backfill derives a row of this status; settled failures only when asked to retry them. */
export function libraryPlanNeedsDerive(status: LibraryPlanStatus, { retryFailed = false } = {}): boolean {
  return PENDING.has(status) || (retryFailed && status === "failed settled");
}

/** A library row with its slug and name, for the scripts and the report. */
export type LibraryPlanListing = LibraryPlanRow & { docSlug: string; name: string };

/** The columns of a listing: the plan's presence, not the plan. */
const LISTING_COLUMNS = {
  docSlug: docRecipes.docSlug,
  name: docRecipes.name,
  extractionError: docRecipes.extractionError,
  ingredients: docRecipes.ingredients,
  steps: docRecipes.steps,
  stepIngredients: docRecipes.stepIngredients,
  hasPlan: sql<boolean>`${docRecipes.cookPlan} is not null`,
  cookPlanError: docRecipes.cookPlanError,
  cookPlanSourceHash: docRecipes.cookPlanSourceHash,
  cookPlanStamp: docRecipes.cookPlanStamp,
};

const DOC_ORDER = [sql`${docRecipes.docPosition} asc nulls last`, docRecipes.name] as const;

/** Every library row as the status reads it, in Doc order. */
export async function readLibraryPlanRows(): Promise<LibraryPlanListing[]> {
  return db.select(LISTING_COLUMNS).from(docRecipes).orderBy(...DOC_ORDER);
}

export interface LibraryPlanReport {
  /** Settled failures: the fix is an edit to the Doc tab. */
  needFixes: Array<{ slug: string; name: string; error: string }>;
  /** Rows with steps and no current plan or settled failure yet. */
  pending: number;
  /** Every library row. */
  total: number;
}

/** The library's plans at a glance, from the columns (free; no plan is read). */
export async function libraryPlanReport(): Promise<LibraryPlanReport> {
  const rows = await readLibraryPlanRows();
  const needFixes: LibraryPlanReport["needFixes"] = [];
  let pending = 0;
  for (const row of rows) {
    const status = libraryPlanStatus(row);
    if (status === "failed settled") {
      needFixes.push({ slug: row.docSlug, name: row.name, error: row.cookPlanError ?? "" });
    } else if (PENDING.has(status)) {
      pending += 1;
    }
  }
  return { needFixes, pending, total: rows.length };
}

/** One library row as `plan-report` reads it: its status, and why a current plan fails the validator. */
export interface AuditedPlanRow {
  slug: string;
  name: string;
  status: LibraryPlanStatus;
  /** The stored error (a failure) or the validator's refusal (a current plan that no longer parses). */
  error: string | null;
  /** A current plan that the validator refuses today (`parseCookPlan`). */
  invalid: boolean;
}

export interface LibraryPlanAudit {
  rows: AuditedPlanRow[];
  /** Current plans that parse. */
  valid: number;
  /** Rows whose plan is settled at this stamp: current plans plus settled failures. */
  settled: number;
  /** `valid / settled`, or null with nothing settled yet. */
  validRate: number | null;
  /** The eval's gate on the same rate (`COOK_PLAN_GATES.validPlans`, 14/15). */
  gate: number;
}

/**
 * Every stored plan re-checked (P decision 7, the library's golden check):
 * each `current` plan parsed with `parseCookPlan` against its row's derive
 * input, and the valid rate over the rows whose plan is settled (a current
 * plan or a settled failure; pending rows aren't counted), beside its gate.
 */
export function auditLibraryPlans(rows: ReadonlyArray<LibraryPlanListing & { cookPlan: unknown }>): LibraryPlanAudit {
  const audited: AuditedPlanRow[] = [];
  let valid = 0;
  let settled = 0;
  for (const row of rows) {
    const status = libraryPlanStatus(row);
    let error = row.cookPlanError;
    let invalid = false;
    if (status === "current") {
      settled += 1;
      const parsed = parseCookPlan(row.cookPlan, libraryRecipeForPlan(row));
      if (parsed.ok) valid += 1;
      else {
        invalid = true;
        error = `invalid (${parsed.rule}): ${parsed.detail}`;
      }
    } else if (status === "failed settled") {
      settled += 1;
    }
    audited.push({ slug: row.docSlug, name: row.name, status, error, invalid });
  }
  return {
    rows: audited,
    valid,
    settled,
    validRate: settled === 0 ? null : valid / settled,
    gate: COOK_PLAN_GATES.validPlans,
  };
}

/** Whether a valid rate meets the gate; null (nothing settled) can't be judged. */
export function meetsValidGate(validRate: number | null): boolean | null {
  return validRate === null ? null : validRate >= COOK_PLAN_GATES.validPlans;
}

/**
 * "Valid plans: 40 of 42 (95.2%); gate 93.3% (14/15 on the eval): meets it."
 * The line `plan-report` and the backfill print.
 */
export function describeValidRate(valid: number, settled: number): string {
  const gate = `gate ${(COOK_PLAN_GATES.validPlans * 100).toFixed(1)}% (14/15 on the eval)`;
  if (settled === 0) return `Valid plans: none settled yet; ${gate}.`;
  const rate = valid / settled;
  const verdict = meetsValidGate(rate) ? "meets it" : "below it";
  return `Valid plans: ${valid} of ${settled} (${(rate * 100).toFixed(1)}%); ${gate}: ${verdict}.`;
}

/** Every library row with its stored plan, for `auditLibraryPlans` (reads every plan). */
export async function readLibraryPlansForAudit(): Promise<Array<LibraryPlanListing & { cookPlan: unknown }>> {
  return db
    .select({ ...LISTING_COLUMNS, cookPlan: docRecipes.cookPlan })
    .from(docRecipes)
    .orderBy(...DOC_ORDER);
}
