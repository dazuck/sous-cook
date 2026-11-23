/**
 * Cook stretches: the steps after Prep cut into runs of work that end where
 * the cook can step away (slice C's break rule; slice N2 drops its cap).
 *
 * Idle hands come from the schedule the screens are built from (`flow()`), not
 * from a flag: a screen's hands are busy until its end, or only until its
 * start when it is a single hands-off task (it starts the simmer, then the
 * cook is free). Busy-until is the running maximum of that, so a wait As I go
 * fills with chopping is no wait. Idle before the next screen is its start
 * minus busy-until, never below 0 (two screens can overlap in the schedule).
 *
 * A break is idle of at least `BREAK_MINUTES`. Breaks always cut, even when
 * that leaves a one-screen stretch ("heat the oven, then wait 15" is an honest
 * stretch). Nothing else cuts: a stretch is however long the work runs
 * (N2-12 retired the 5-screen cap).
 *
 * A step with no estimate counts as `NOMINAL_MINUTES` hands-on in the
 * schedule, so a break needs real estimates.
 *
 * Not the timetable's chapters (`TimetableChapter`, `timetable-model.ts`):
 * those are drawn bands on the whole-cook picture's minute axis, cut where
 * the stove is free 8+ min and capped at 4. These stretches cut screens and
 * drive the cook view's chapter menu and eyebrow. Both stand.
 */

import { isPot, type FlowItem } from "./cook-schedule";

/** Idle minutes between two screens that end a stretch. */
export const BREAK_MINUTES = 10;

/** Minutes are compared in thousandths, the schedule's own grain. */
const GRAIN = 1000;

function onGrain(minutes: number): number {
  return Math.round(minutes * GRAIN) / GRAIN;
}

/** When the cook's hands come free from a screen. */
export function handsEnd(item: FlowItem): number {
  return isPot(item) ? item.start : item.end;
}

/**
 * Idle hands after each screen but the last: entry `i` is the wait between
 * screen `i` and screen `i + 1`, in minutes, never below 0.
 */
export function idleAfter(items: readonly FlowItem[]): number[] {
  const idle: number[] = [];
  let busyUntil = -Infinity;
  items.forEach((item, i) => {
    busyUntil = Math.max(busyUntil, handsEnd(item));
    const following = items[i + 1];
    if (following) idle.push(Math.max(0, onGrain(following.start - busyUntil)));
  });
  return idle;
}

/**
 * Free minutes as the cook hears them (N2-7): rounded down to 5, so the plan
 * never promises more than it holds. A break is at least 10, so the figure is.
 */
export function freeMinutes(idle: number): number {
  return Math.floor(onGrain(idle) / 5) * 5;
}

/** A run of screens, `start` to `end` (exclusive), as indices into the items. */
export interface Stretch {
  start: number;
  end: number;
  /** The break that opens this stretch, in idle minutes; null for the first. */
  breakBefore: number | null;
  /** The break that closes this stretch, in idle minutes; null for the last. */
  breakAfter: number | null;
}

/** The screens cut into stretches at every break of `BREAK_MINUTES` or more. */
export function stretchesOf(items: readonly FlowItem[]): Stretch[] {
  if (items.length === 0) return [];
  const idle = idleAfter(items);

  const runs: Stretch[] = [];
  let start = 0;
  const closeRun = (end: number) => {
    runs.push({
      start,
      end,
      breakBefore: start === 0 ? null : idle[start - 1],
      breakAfter: end === items.length ? null : idle[end - 1],
    });
    start = end;
  };
  idle.forEach((wait, i) => {
    if (wait >= BREAK_MINUTES) closeRun(i + 1);
  });
  closeRun(items.length);
  return runs;
}

/** The break after a stretch, in plan minutes and as said; null on the last. */
export interface FreeTime {
  /** When the cook's hands come free: the busy-until of the stretch. */
  from: number;
  /** The next stretch's first start. */
  to: number;
  /** The idle minutes rounded down to 5 (`freeMinutes`). */
  minutes: number;
}

/**
 * The break after `run`, on the items' own minutes. The strip and the cook
 * view both call this on the items they draw, so the chart's field, the
 * eyebrow and Whole recipe's dividers say one figure.
 */
export function freeAfter(items: readonly FlowItem[], run: Stretch): FreeTime | null {
  const following = items[run.end];
  if (run.breakAfter === null || following === undefined) return null;
  return {
    from: onGrain(following.start - run.breakAfter),
    to: following.start,
    minutes: freeMinutes(run.breakAfter),
  };
}
