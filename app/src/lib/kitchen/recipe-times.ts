/**
 * Recipe times: how long a recipe really takes, from its cook plan.
 *
 * The plan holds per-task minutes, hands-off flags, the mise a recipe leaves
 * unsaid and each ahead task's lead; `timeline` schedules them. From that
 * schedule, in "Prep first" (the default mode, and the longer one: all the
 * mise is packed before the cook), one summary that every surface shows:
 *
 *   - total: the timeline's span, prep included; hands-off time that runs
 *     alongside other work counts once, as the schedule overlaps it;
 *   - hands-on: the minutes the cook's hands are busy, the same durations the
 *     schedule used (a task with no estimate counts `NOMINAL_MINUTES`);
 *   - ahead: each ahead task's lead in the plan's own words, never parsed.
 *
 * Both totals round up to the next 5 minutes and nothing is added: a fudge
 * factor would be a guessed number. Whether the times are realistic is
 * measured against real cooks (`cook-time-check.ts`), not padded here.
 *
 * `shownTimes` decides what a surface shows: the plan's times, or the
 * recipe's stated time marked as the recipe's when there is no current plan
 * or the plan's minutes are mostly the nominal guess, or nothing.
 *
 * A derived layer: computed on read, never stored (`design/pack-format-v0.md`,
 * "Derived layers").
 */

import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { isCurrentCookPlan, type CookPlan } from "./cook-plan";
import { taskMinutes, timeline } from "./cook-schedule";

/**
 * Past this share of hands-on minutes resting on the nominal guess, a plan's
 * times are mostly made up, and the recipe's stated time is shown instead.
 */
export const NOMINAL_SHARE_LIMIT = 0.25;

export interface AheadWork {
  /** Distinct leads of the ahead tasks, in plan order, as the plan words them. */
  leads: string[];
  /** Ahead tasks the plan gave no lead. */
  unled: number;
}

export interface RecipeTimes {
  /** The first-mode timeline's span, in minutes. */
  totalMinutes: number;
  /** Minutes of non-ahead tasks that aren't hands-off. */
  handsOnMinutes: number;
  /** Of `handsOnMinutes`, the ones counted at `NOMINAL_MINUTES` for no estimate. */
  nominalMinutes: number;
  /** `nominalMinutes / handsOnMinutes`; 0 when there are no hands-on minutes. */
  nominalShare: number;
  rounded: { total: number; handsOn: number };
  ahead: AheadWork;
}

export type StatedTime = KitchenQueueRecipeData["estimatedTime"];

export type ShownTimes =
  | { source: "plan"; total: number; handsOn: number; ahead: AheadWork }
  | {
      source: "recipe";
      reason: "no-plan" | "nominal";
      /** As the recipe states it, unrounded; null when it states none. */
      total: number | null;
      handsOn: number | null;
      ahead: AheadWork;
    }
  | { source: "none"; reason: "no-plan" | "nominal"; ahead: AheadWork };

/** Sums of minutes kept to the schedule's thousandths, so 5 stays 5. */
function exact(minutes: number): number {
  return Math.round(minutes * 1000) / 1000;
}

export function roundUpToFive(minutes: number): number {
  return Math.ceil(exact(minutes) / 5) * 5;
}

function aheadWork(plan: CookPlan): AheadWork {
  const ahead = plan.tasks.filter((t) => t.kind === "ahead");
  const leads: string[] = [];
  let unled = 0;
  for (const t of ahead) {
    if (!t.lead) unled++;
    else if (!leads.includes(t.lead)) leads.push(t.lead);
  }
  return { leads, unled };
}

export function recipeTimes(plan: CookPlan): RecipeTimes {
  const totalMinutes = exact(timeline(plan, "first", new Set()).total);
  const handsOn = plan.tasks.filter(
    (t) => t.kind !== "ahead" && !(t.minutes?.handsOff ?? false),
  );
  const handsOnMinutes = exact(
    handsOn.reduce((sum, t) => sum + taskMinutes(t), 0),
  );
  const nominalMinutes = exact(
    handsOn
      .filter((t) => t.minutes === undefined)
      .reduce((sum, t) => sum + taskMinutes(t), 0),
  );
  return {
    totalMinutes,
    handsOnMinutes,
    nominalMinutes,
    nominalShare: handsOnMinutes === 0 ? 0 : nominalMinutes / handsOnMinutes,
    rounded: {
      total: roundUpToFive(totalMinutes),
      handsOn: roundUpToFive(handsOnMinutes),
    },
    ahead: aheadWork(plan),
  };
}

/** A stated number counts only when it is a positive, finite count of minutes. */
function minutesOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** A stated part of the time: any finite count of minutes, 0 included. */
function partOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * The recipe's total: as stated, else active plus passive when it states
 * both (0 counts as stated). One part alone is not a total (T follow-up,
 * item 4): active alone would read "all hands-on", passive alone as the
 * whole cook, neither of which the recipe said.
 */
function statedTotal(stated: StatedTime): number | null {
  const total = minutesOrNull(stated?.total);
  if (total !== null) return total;
  const active = partOrNull(stated?.active);
  const passive = partOrNull(stated?.passive);
  if (active === null || passive === null) return null;
  return minutesOrNull(active + passive);
}

/**
 * What a surface shows for a recipe. `plan` is the stored plan as found on
 * the queue item; anything but a current one counts as no plan (the recipe
 * as written, `identityPlan`, is all nominal and is never passed here). A
 * plan that adds up to no minutes (only ahead work, or no tasks) counts as no
 * plan too, though its ahead leads still show.
 */
export function shownTimes(plan: unknown, stated: StatedTime): ShownTimes {
  const current = isCurrentCookPlan(plan) ? plan : null;
  const times = current ? recipeTimes(current) : null;
  const ahead = times?.ahead ?? { leads: [], unled: 0 };
  const timed = times && times.rounded.total > 0 ? times : null;

  if (timed && timed.nominalShare <= NOMINAL_SHARE_LIMIT) {
    return {
      source: "plan",
      total: timed.rounded.total,
      handsOn: timed.rounded.handsOn,
      ahead,
    };
  }

  const reason = timed ? "nominal" : "no-plan";
  const total = statedTotal(stated);
  const handsOn = minutesOrNull(stated?.active);
  if (total === null && handsOn === null) return { source: "none", reason, ahead };
  return { source: "recipe", reason, total, handsOn, ahead };
}
