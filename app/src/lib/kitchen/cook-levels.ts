/**
 * Look-ahead levels rules, fit ladder and hit resolution (P58, N7, N8).
 *
 * Pure derivations for the cook view's look-ahead levels:
 * - Level 0: the progress line (derived) / the strip (as written)
 * - Level 1: the strip map (derived, slice T3) / the next steps (as written)
 * - Level 2: the timetable (derived) / the outline (as written)
 * - Level 3: Whole recipe
 */

import { isAsWritten, type Strip, type StripMark } from "./cook-strip";
import {
  COOK_COPY,
  prepSummary,
  chartState,
  screensOf,
  stepBody,
  type CookState,
} from "./cook-view";
import type { CookPlan } from "./cook-plan";

// ---------------------------------------------------------------------------
// 1b. As written, the next steps (N2-2)
// ---------------------------------------------------------------------------

/** Most next steps a plan cooked as written lists at level 1. */
export const STRETCH_HORIZON_CAP = 4;

/**
 * As written, level 1's rows: the steps after the one in hand, up to
 * `STRETCH_HORIZON_CAP`; the step in hand alone on the last step. A derived
 * plan's level 1 is the strip map (`strip-map.ts`, slice T3), not rows.
 */
export function writtenRows(strip: Strip): StripMark[] {
  const inHand = strip.marks.find((m) => m.state === "in-hand");
  if (inHand === undefined) return [];
  const ahead = strip.marks.filter((m) => m.screen > inHand.screen);
  if (ahead.length === 0) return [inHand];
  return ahead.slice(0, STRETCH_HORIZON_CAP);
}

// ---------------------------------------------------------------------------
// 5. Nudge (N7)
// ---------------------------------------------------------------------------

export interface Nudge {
  /** "start": N7's start nudge; "step-away": N2-8's last step before a break. */
  kind: "start" | "step-away";
  text: string;
  strand: string;
  minutes: number;
  /** The mark it is about: the step to start, or the step in hand before the break. */
  target: StripMark;
  /** The plan minute it stands over: the step to start's start, or the break's. */
  at: number;
  toString(): string;
}

/**
 * Returns a nudge if:
 * 1. Step in hand is pot and lasts 8 minutes or more.
 * 2. Recipe is not cooked as written.
 * 3. A step in another strand starts after now and before step in hand ends.
 */
export function nudge(strip: Strip, now: number): Nudge | null {
  if (strip.asWritten) return null;

  const inHand = strip.marks.find((m) => m.state === "in-hand");
  if (!inHand || !inHand.pot) return null;

  const duration = inHand.end - inHand.start;
  if (duration < 8) return null;

  if (now >= inHand.end) return null;

  // Find steps in another strand starting before inHand.end
  const candidates = strip.marks
    .filter(
      (m) =>
        m.strand !== inHand.strand &&
        m.start < inHand.end &&
        m.start >= inHand.start &&
        m.state !== "done",
    )
    .sort((a, b) => a.start - b.start || a.screen - b.screen);

  if (candidates.length === 0) return null;

  const target = candidates[0];
  const remaining = target.start - now;
  const minutes = Math.ceil(remaining);

  const strandName = target.strand.toLowerCase();
  let text = "";
  if (minutes <= 0) {
    text = `Start the ${strandName} now`;
  } else if (minutes === 1) {
    text = `Start the ${strandName} in about 1 minute`;
  } else {
    text = `Start the ${strandName} in about ${minutes} minutes`;
  }

  return {
    kind: "start",
    text,
    strand: target.strand,
    minutes,
    target,
    at: target.start,
    toString() {
      return this.text;
    },
  };
}

/**
 * The walk-away line (N2-8): on the last step of a stretch with a break after
 * it, "After this step: about 50 min free. Step away." The minutes are the
 * break's as said (rounded down to 5, N2-7). Null anywhere else, on Prep and
 * as written.
 */
export function walkAway(strip: Strip): Nudge | null {
  if (strip.asWritten) return null;
  const inHand = strip.marks.find((m) => m.state === "in-hand");
  if (inHand === undefined || inHand.stretch === null) return null;
  const stretch = strip.stretches[inHand.stretch];
  if (stretch === undefined || stretch.free === null) return null;
  if (stretch.screens[stretch.screens.length - 1] !== inHand.screen) return null;
  const { minutes, from } = stretch.free;
  return {
    kind: "step-away",
    text: COOK_COPY.stepAway(minutes),
    strand: inHand.strand,
    minutes,
    target: inHand,
    at: from,
    toString() {
      return this.text;
    },
  };
}

/**
 * The one line on the nudge's slot at rest: the start nudge when it applies,
 * since it counts down and the free time is then shorter (N2-8), else the
 * walk-away line.
 */
export function restNudge(strip: Strip, now: number): Nudge | null {
  return nudge(strip, now) ?? walkAway(strip);
}

// ---------------------------------------------------------------------------
// 9. As written, the outline's hits (N8)
// ---------------------------------------------------------------------------

export interface HitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An outline name's tap band and the step it reads. */
export interface OutlineName {
  rect: HitRect;
  mark: StripMark;
}

const inside = (r: HitRect, x: number, y: number) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

/**
 * As written, the step a tap at level 2 reads: the outline name whose band
 * is under the finger, else none. A derived plan's level 2 is the timetable,
 * whose hits are `hitTimetable`'s (timetable-layout).
 */
export function hitOutline(x: number, y: number, names: readonly OutlineName[]): StripMark | null {
  return names.find((n) => inside(n.rect, x, y))?.mark ?? null;
}

// ---------------------------------------------------------------------------
// 8. Touch-to-read step details (N8)
// ---------------------------------------------------------------------------

export interface StepReadDetails {
  text: string;
  minutes: string | null;
  isCurrent: boolean;
}

/**
 * Derives words and minutes for a step read in place at How much more (N8).
 */
export function readStepDetails(
  mark: StripMark,
  plan?: CookPlan | null,
  state?: CookState,
  steps?: string[],
): StepReadDetails {
  const isCurrent =
    mark.state === "in-hand" || (state !== undefined && mark.screen === state.pos);
  const durMin = mark.end > mark.start ? Math.max(1, mark.end - mark.start) : null;
  const minutes = durMin ? `${durMin} min` : null;

  if (mark.key === "prep") {
    if (plan && state) {
      const summary = prepSummary(plan, state);
      return { text: summary.text, minutes: summary.minutes, isCurrent };
    }
    return { text: COOK_COPY.prepChapter, minutes, isCurrent };
  }

  // A prep card (`Strip.prepMarks`): its own tasks' words, whichever screen
  // it goes to (the Prep screen, or in "Prep first" its first prep page,
  // which may hold only part of a card cut over pages).
  if (plan && mark.cook === false && mark.tasks.length > 0 && !isAsWritten(plan)) {
    const tasks = mark.tasks
      .map((id) => plan.tasks.find((t) => t.id === id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t));
    if (tasks.length > 0 && tasks.every((t) => t.kind === "mise")) {
      return {
        text: stepBody({ tasks, start: mark.start, end: mark.end, during: null, lead: null }),
        minutes,
        isCurrent,
      };
    }
  }

  if (plan && state && !isAsWritten(plan)) {
    // The mark's screen counts the screens the strip drew it on: on Prep, as
    // the cook stands on leaving (`chartState`, the strip's own read).
    const read = chartState(plan, state);
    const screen = screensOf(plan, read.mode, read.ticked)[mark.screen];
    if (screen?.kind === "step") {
      return { text: stepBody(screen.item), minutes, isCurrent };
    }
  }

  if (steps && steps[mark.screen]) {
    return { text: steps[mark.screen], minutes, isCurrent };
  }

  const task = plan?.tasks.find((t) => t.id === mark.key);
  const text = task?.text || task?.label || mark.label;
  return { text, minutes, isCurrent };
}

