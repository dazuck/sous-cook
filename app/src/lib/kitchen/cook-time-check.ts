/**
 * Cook-time check: how long finished cooks really took, against the total
 * the app shows for them (`recipe-times.ts`).
 *
 * Decision 10 makes the numbers, read by a person, the place a fix is chosen:
 * this measures and reports, it never adjusts a displayed time. The ratio is
 * actual over the shown (rounded) total; under 1 the shown time was
 * generous, over 1 the cook ran long.
 *
 * The total is the recipe's cook plan as stored now, not as shown during the
 * cook: nothing records what the cook was told. A plan re-derived after the
 * cook (a new plan version, a re-sync) moves that cook's ratio with it.
 *
 * A cook is excluded, and counted by reason, when it can't be measured:
 *   - before-T: no `completed_at` (finished before the stamps existed);
 *   - no-start: no `started_at` (started straight from an import, or before T);
 *   - no-plan: no current cook plan to compare with, or one with no minutes;
 *   - invalid: finished at or before it started;
 *   - abandoned: over `ABANDONED_RATIO` times the shown total (left open and
 *     finished later).
 * A cook the app finished (`finishedBy` "auto", cook-fidelity decision 7) is
 * measured like any other: its `completed_at` is its last activity, not when
 * the app noticed, so the minutes it sat idle on its last screen are never
 * counted. The summary counts how each cook finished.
 * A plan whose hands-on minutes rest mostly on the nominal guess is kept, and
 * flagged `nominalHeavy`: those are the cooks where the display fell back to
 * the recipe's stated time.
 *
 * Pure; `scripts/cook-times.ts` reads the rows and prints the result.
 */

import type { CookLogRef, FinishedBy } from "../../../drizzle/schema";
import { isCurrentCookPlan } from "./cook-plan";
import { NOMINAL_SHARE_LIMIT, recipeTimes } from "./recipe-times";

/** Past this many times the shown total, a cook was left open, not cooked. */
export const ABANDONED_RATIO = 3;

export type CookExclusion =
  | "before-T"
  | "no-start"
  | "no-plan"
  | "invalid"
  | "abandoned";

export const COOK_EXCLUSIONS: readonly CookExclusion[] = [
  "before-T",
  "no-start",
  "no-plan",
  "invalid",
  "abandoned",
];

/** The fields of a completed queue item the check reads. */
export interface FinishedCook {
  id: string;
  name: string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  cookPlan: unknown;
  cookLog: CookLogRef | null;
  /** How it finished; null for a cook from before the column. */
  finishedBy: FinishedBy | null;
}

export interface CookTime {
  id: string;
  name: string;
  completedAt: Date | null;
  /** Minutes from start to finish; null without both stamps. */
  actualMinutes: number | null;
  /** The plan's total, unrounded; null without a current plan. */
  derivedMinutes: number | null;
  /** The plan's total as shown, rounded up to 5. */
  shownMinutes: number | null;
  /** `actualMinutes / shownMinutes`, when both exist. */
  ratio: number | null;
  nominalHeavy: boolean;
  excluded: CookExclusion | null;
  /** How the Cook Log row came about, or null without one. */
  logged: "appended" | "adopted" | null;
  /** How the cook finished: pressed, by the app, or null before it was kept. */
  finishedBy: FinishedBy | null;
}

export interface CookTimeSummary {
  cooks: CookTime[];
  /** Cooks not excluded. */
  measured: number;
  /** Median of the measured cooks' ratios; null when none were measured. */
  medianRatio: number | null;
  /** Measured cooks flagged `nominalHeavy`. */
  nominalHeavy: number;
  excluded: Record<CookExclusion, number>;
  logged: { appended: number; adopted: number; none: number };
  /** How the cooks finished; `unknown` for those from before it was kept. */
  finished: { pressed: number; auto: number; unknown: number };
}

function dateOrNull(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function exclusionOf(cook: Omit<CookTime, "excluded">, started: Date | null) {
  if (!cook.completedAt) return "before-T";
  if (!started) return "no-start";
  // A plan that schedules no minutes at all gives nothing to compare with.
  if (!cook.shownMinutes) return "no-plan";
  if (cook.actualMinutes === null || cook.actualMinutes <= 0) return "invalid";
  if (cook.ratio !== null && cook.ratio > ABANDONED_RATIO) return "abandoned";
  return null;
}

export function checkCook(cook: FinishedCook): CookTime {
  const started = dateOrNull(cook.startedAt);
  const completed = dateOrNull(cook.completedAt);
  const actualMinutes =
    started && completed
      ? (completed.getTime() - started.getTime()) / 60_000
      : null;
  const times = isCurrentCookPlan(cook.cookPlan)
    ? recipeTimes(cook.cookPlan)
    : null;
  const shownMinutes = times?.rounded.total ?? null;
  const measured: Omit<CookTime, "excluded"> = {
    id: cook.id,
    name: cook.name,
    completedAt: completed,
    actualMinutes,
    derivedMinutes: times?.totalMinutes ?? null,
    shownMinutes,
    ratio:
      actualMinutes !== null && shownMinutes ? actualMinutes / shownMinutes : null,
    nominalHeavy: times ? times.nominalShare > NOMINAL_SHARE_LIMIT : false,
    logged: cook.cookLog ? (cook.cookLog.adopted ? "adopted" : "appended") : null,
    finishedBy: cook.finishedBy,
  };
  return { ...measured, excluded: exclusionOf(measured, started) };
}

export function checkCookTimes(cooks: FinishedCook[]): CookTimeSummary {
  const checked = cooks.map(checkCook);
  const kept = checked.filter((c) => c.excluded === null);
  const excluded = Object.fromEntries(
    COOK_EXCLUSIONS.map((reason) => [
      reason,
      checked.filter((c) => c.excluded === reason).length,
    ]),
  ) as Record<CookExclusion, number>;
  return {
    cooks: checked,
    measured: kept.length,
    medianRatio: median(kept.map((c) => c.ratio as number)),
    nominalHeavy: kept.filter((c) => c.nominalHeavy).length,
    excluded,
    logged: {
      appended: checked.filter((c) => c.logged === "appended").length,
      adopted: checked.filter((c) => c.logged === "adopted").length,
      none: checked.filter((c) => c.logged === null).length,
    },
    finished: {
      pressed: checked.filter((c) => c.finishedBy === "pressed").length,
      auto: checked.filter((c) => c.finishedBy === "auto").length,
      unknown: checked.filter((c) => c.finishedBy === null).length,
    },
  };
}
