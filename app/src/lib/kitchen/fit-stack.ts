import { bindNumbers } from "./cook-view";
import { FIT_UP, STEP_FIT_SCALES } from "./fit-scales";

/**
 * How the flow stack fits its stage without splitting a step across pages
 * (DS §5, the flow stack).
 * Now stands alone on the stage. A fixed ladder:
 * - If full size (scale 1) fits, now steps up through FIT_UP (1.2, 1.1) to use the stage's room.
 * - Otherwise now steps down through STEP_FIT_SCALES (1, 0.9, 0.8, 0.7, 0.6, 0.5).
 * - A step that still exceeds the stage at FLOOR (0.5) stays whole on one screen (`pages: null`)
 *   and scrolls vertically on `[data-stage]` rather than chopping into "Continues ›" pages.
 * - The nudge never costs the step its size: if reserving its line would drop the step below
 *   the size it has without it, the nudge does not show.
 */

const FLOOR = STEP_FIT_SCALES[STEP_FIT_SCALES.length - 1];

/** A step's words as the stack sets them: a number stays bound to its unit. */
export function stepWords(text: string): string[] {
  return bindNumbers(text).split(" ");
}

/** A word that ends a sentence: . ! ? or …, then any closing quotes or brackets. */
function endsSentence(word: string): boolean {
  return /[.!?…]["'”’)\]]*$/.test(word);
}

/**
 * Sentence-boundary unit cutter retained for unit-level tests; `fitStack`
 * keeps every step whole (`pages: null`) and steps down `STEP_FIT_SCALES` instead.
 */
export function pageStarts(
  words: readonly string[],
  pairs: number,
  fits: (from: number, to: number, last: boolean) => boolean,
): number[] {
  const n = words.length + pairs;
  const ends = (k: number) => k >= words.length || endsSentence(words[k]);
  const starts = [0];
  let from = 0;
  while (n - from > 1 && !fits(from, n, true)) {
    let lo = from + 1;
    let hi = n - 1;
    let to = lo;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits(from, mid, false)) {
        to = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (let k = to; k > from; k--) {
      if (ends(k - 1)) {
        to = k;
        break;
      }
    }
    from = to;
    starts.push(from);
  }
  return starts;
}

/** What the browser measured, in px down the stage. */
export interface StackMeasure {
  /** Where the stack's lines must end by: the stage's height less the stack's foot. */
  room: number;
  /** Where now's top sits. */
  top: number;
  /** The current step's words (`stepWords`). */
  words: readonly string[];
  /** How many ingredient pairs its meta carries: units after the words. */
  pairs: number;
  /**
   * Now's height at `scale` showing units `[from, to)` with the step's meta.
   */
  now: (scale: number, from: number, to: number, last: boolean) => number;
  /**
   * Room to reserve for the nudge line if it fits without dropping the step's scale.
   */
  nudgeReserve?: number;
  /**
   * How much of the stack's foot (the padding under the step's last row) the nudge may stand in,
   * px: the nudge is drawn over the stage's bottom edge, so the foot is room it can share while it
   * keeps its gap from the row above (DECISIONS 2026-11-24). Used only where the reserve alone
   * drops the nudge, and only at 0.8 and up, below which the foot is already the tight one.
   */
  nudgeFoot?: number;
  /** Kept for caller compatibility; always 0 now that steps stay whole. */
  part?: number;
}

export interface StackFit {
  /** Now's scale, one of the fit scales. */
  scale: number;
  /** Whether the nudge line is shown without dropping the step's scale. */
  nudge: boolean;
  /** Always null: steps shrink down to 0.5× and scroll if still taller, never paging. */
  pages: null;
  /** Always 0. */
  part: 0;
  /** Set where the nudge stands in the stack's foot: how many px of it the step's rows took. */
  footUsed?: number;
}

export function fitStack(m: StackMeasure): StackFit {
  const n = m.words.length + m.pairs;
  const fits = (height: number, extra = 0) => m.top + height + extra <= m.room;
  const reserve = m.nudgeReserve ?? 0;

  // The nudge never costs the step its size (N7, N10): its line is reserved
  // when the step, with it, still takes the size the ladder gives it without
  // it, below the climb. The climb past 1 is spare room, and the nudge takes
  // it first, as the approved prototype fits with the nudge in place.
  if (reserve > 0) {
    const base = STEP_FIT_SCALES.find((s) => fits(m.now(s, 0, n, true))) ?? null;
    const withIt = [...FIT_UP, ...STEP_FIT_SCALES].find((s) => fits(m.now(s, 0, n, true), reserve));
    if (base !== null && withIt !== undefined && withIt >= base) {
      return { scale: withIt, nudge: true, pages: null, part: 0 };
    }
    // Where the reserve alone drops it, the nudge may stand in the stack's foot (`nudgeFoot`):
    // the step keeps the size it has without the nudge's climb, and a step that kept its nudge
    // above is never moved by this.
    const foot = m.nudgeFoot ?? 0;
    if (base !== null && base >= 0.8 && foot > 0) {
      const height = m.now(base, 0, n, true);
      if (fits(height, reserve - foot)) {
        return { scale: base, nudge: true, pages: null, part: 0, footUsed: Math.max(0, m.top + height + reserve - m.room) };
      }
    }
  }

  // 1. If full size fits, step up through FIT_UP (largest first).
  if (fits(m.now(1, 0, n, true))) {
    let scale = 1;
    for (const up of FIT_UP) {
      if (fits(m.now(up, 0, n, true))) {
        scale = up;
        break;
      }
    }
    // The nudge never costs the step its size: if reserving its line would drop
    // the step below the size it has without it, the nudge does not show.
    const nudge = reserve > 0 && fits(m.now(scale, 0, n, true), reserve);
    return { scale, nudge, pages: null, part: 0 };
  }

  // 2. Step down through STEP_FIT_SCALES (0.9, 0.8, 0.7, 0.6, 0.5).
  for (const scale of STEP_FIT_SCALES.slice(1)) {
    if (fits(m.now(scale, 0, n, true))) {
      const nudge = reserve > 0 && fits(m.now(scale, 0, n, true), reserve);
      return { scale, nudge, pages: null, part: 0 };
    }
  }

  // 3. Past FLOOR (0.5), keep the whole step together at FLOOR and let the stage scroll.
  return { scale: FLOOR, nudge: false, pages: null, part: 0 };
}

