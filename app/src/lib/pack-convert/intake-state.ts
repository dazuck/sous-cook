/**
 * Which recipe a queue row's cook meets, given its intake columns
 * (cook-fidelity plan; `drizzle/schema.ts` documents the columns). One rule,
 * read by every reader that shows or plans the recipe: the cook page, the
 * plan derive, Ask, the pantry check on Finish.
 *
 * - `none`: intake was never asked for (a pack row, the app's own adds, a
 *   row queued before intake shipped). The recipe as stored.
 * - `pending`: asked for, no outcome yet or only an error for now (a
 *   timeout, a rate limit, a provider's 5xx, a missing key:
 *   `isSettledIntakeError`), and nothing planned from the original. The
 *   recipe as sent for now; the cook page asks for intake (again) and waits,
 *   unless a cook has already started on it. `error` is the last try's, if
 *   any. An error for now is written at most `INTAKE_MAX_TRIES` times: the
 *   last is settled (`intakeErrorAfter`).
 * - `normalized`: the cut recipe.
 * - `as-sent`: intake failed for good, or its outcome can't be used. The
 *   recipe as sent, with the reason, which the info sheet and the reports
 *   show. Covers a settled error, a stored cut that doesn't read or was made
 *   from another recipe, and a plan worked out from the original before
 *   intake landed (an intake landing then would swap the recipe under that
 *   plan, so it never lands; `ensureIntake`'s write refuses it), an error
 *   for now included.
 *
 * Every state but `pending` is final: a cut or a settled error is written
 * once, and an error for now only until a try lands one of them. Once a cook
 * has started on the recipe as sent (the page opened it and intake failed,
 * or a kept session cooks it), the row is settled as sent, so nothing swaps
 * the recipe under the cook (`ensureIntake`).
 */

import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { sourceHash } from "../serves-estimate-plan";
import { readLegacyRecipe } from "./convert";

/**
 * The start of a stored error that may pass on another try (a timeout, a
 * rate limit, a provider's 5xx, a dropped connection): the row tries again
 * the next time it is opened.
 */
export const INTAKE_FOR_NOW = "failed for now: ";

/**
 * Whether a stored intake error is final: anything but an error for now
 * (`INTAKE_FOR_NOW`). A refused cut, a reply with no recipe and an
 * extraction that never parsed would fail the same way again.
 */
export function isSettledIntakeError(error: string): boolean {
  return !error.startsWith(INTAKE_FOR_NOW);
}

/**
 * How many runs may end in an error for now before the last one is settled:
 * a timeout that recurs on a long recipe, or a key missing for good, would
 * otherwise cost a wait and a paid call on every open, without end.
 */
export const INTAKE_MAX_TRIES = 3;

/**
 * The error to store after `attempts` runs (this one counted), the last of
 * which ended in `error`: an error for now is settled on the last allowed
 * try; any other is stored as it is.
 */
export function intakeErrorAfter(error: string, attempts: number): string {
  if (isSettledIntakeError(error) || attempts < INTAKE_MAX_TRIES) return error;
  return `failed ${attempts} times, the last: ${error.slice(INTAKE_FOR_NOW.length)}`;
}

/**
 * The settled error for a run the cook page asked for as it opened the item
 * that failed for now: the cook starts on the recipe as sent, so the row is
 * settled as sent rather than tried again under the cook.
 */
export function openedBeforeCut(error: string): string {
  const why = isSettledIntakeError(error) ? error : error.slice(INTAKE_FOR_NOW.length);
  return `the cook opened it before intake could cut it (${why})`;
}

export type IntakeState = "none" | "pending" | "normalized" | "as-sent";

export interface QueueIntake {
  state: IntakeState;
  /** The recipe the cook meets; null for a row with no recipe (a Notion id alone). */
  recipe: KitchenQueueRecipeData | null;
  /** Why the recipe shows as sent; for `pending`, the last try's error for now, if any; else null. */
  error: string | null;
}

export interface IntakeRow {
  recipeData: KitchenQueueRecipeData | null;
  intakeRecipe: KitchenQueueRecipeData | null;
  intakeError: string | null;
  intakeSourceHash: string | null;
  cookPlan: unknown;
  cookPlanError: string | null;
  /** Runs that wrote an outcome (`drizzle/schema.ts`); absent or null for none. */
  intakeAttempts?: number | null;
  /** A kept cut's nudges, `rule: detail`; absent or null without a cut. */
  intakeNudges?: string[] | null;
}

/** The reasons this module gives, beside the stored errors intake writes. */
export const INTAKE_STATE_ERRORS = {
  otherRecipe: "the intake was asked for another recipe than the one stored",
  plannedFirst: "the prep plan was worked out from the recipe as sent before intake ran",
  unreadable: "the stored cut can't be read",
  /** A kept session cooks the recipe as sent: the page settles the row so. */
  cookStarted: "the cook started on the recipe as sent before intake landed",
  /** Asked for a plan before intake has an outcome: none is planned (an old tablet's ask). */
  waiting: "the recipe is still waiting for intake, so no plan is worked out yet",
} as const;

export function queueIntake(row: IntakeRow): QueueIntake {
  const sent = row.recipeData;
  if (row.intakeSourceHash === null || sent === null) return { state: "none", recipe: sent, error: null };
  const asSent = (error: string): QueueIntake => ({ state: "as-sent", recipe: sent, error });
  if (row.intakeSourceHash !== sourceHash("kitchen_queue", sent)) return asSent(INTAKE_STATE_ERRORS.otherRecipe);
  if (row.intakeRecipe !== null) {
    const read = readLegacyRecipe(row.intakeRecipe);
    if (!read.ok) {
      const why = read.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      return asSent(`${INTAKE_STATE_ERRORS.unreadable}: ${why}`);
    }
    return { state: "normalized", recipe: row.intakeRecipe, error: null };
  }
  if (row.intakeError !== null && isSettledIntakeError(row.intakeError)) return asSent(row.intakeError);
  if (row.cookPlan !== null || row.cookPlanError !== null) {
    return asSent(row.intakeError ?? INTAKE_STATE_ERRORS.plannedFirst);
  }
  return { state: "pending", recipe: sent, error: row.intakeError };
}

/** What a reader passes on about a row's intake. */
export interface IntakeSummary {
  state: IntakeState;
  error: string | null;
}

/**
 * One line on a row's intake for the read-only reports (`plan-report`,
 * `list-reports`); null for a row intake was never asked for. With the row's
 * counts: a kept cut's nudges (the soft rules it still trips), and the tries
 * a waiting row has spent.
 */
export function describeIntake(
  { state, error }: IntakeSummary,
  { nudges, attempts }: { nudges?: readonly string[] | null; attempts?: number | null } = {},
): string | null {
  switch (state) {
    case "none":
      return null;
    case "pending": {
      if (error === null) return "intake: waiting";
      const spent = attempts ? `, ${attempts} of ${INTAKE_MAX_TRIES} tries spent` : "";
      return `intake: waiting to try again${spent} (${error})`;
    }
    case "normalized":
      return nudges && nudges.length > 0
        ? `intake: cut, kept with ${nudges.length} nudge${nudges.length === 1 ? "" : "s"} (${nudges.join("; ")})`
        : "intake: cut";
    case "as-sent":
      return `intake: shown as sent (${error})`;
  }
}

/**
 * The row with the recipe its cook meets in `recipeData` (the recipe as sent
 * stays in the database, never in what a reader passes on), and its intake
 * state beside it.
 */
export function withCookRecipe<T extends IntakeRow>(row: T): T & { intake: IntakeSummary } {
  const { state, recipe, error } = queueIntake(row);
  return { ...row, recipeData: recipe, intake: { state, error } };
}
