"use client";

/**
 * The timer in the step's meta (slice B5a, A7; DS §5 "Timers"), where the
 * step's time line stood, so a wait says one number. Design round 2 (after
 * the critic's 5/10): the cook screen keeps its ghosts, the alarm is the
 * stage's own (`AlarmBand`), and the clock walks down to the foot's well.
 *
 * - **offer**: a ghost word with the timer's glyph, "Start 10 min timer":
 *   ink-soft, no fill at rest, sand while pressed. On the last part of the
 *   last step it is the next act and holds the ember (2026-10-03).
 * - **running**: the digits alone, in Caprasimo at the title size (DS §2,
 *   timer digits 44 cpx); the step above already names what they time. Ember
 *   when this clock holds the screen's ember, else ink. Not a button: a
 *   wet-handed brush must not stop nine minutes of pasta (2026-08-11).
 * - **final ten**: the digits grow from their left edge and, when ember,
 *   beat once a second in colour, ember to ember-700 (DS §3), never by
 *   fading ember (DS §1). Under reduced motion they grow at once and don't
 *   beat; an ink clock grows and stays ink.
 * - **done**: once dismissed, "10 min timer done" in ink-soft, with "Again"
 *   as a ghost to time it once more: the cook moves on, the step doesn't
 *   offer itself as new.
 *
 * "Tap so the timer can ring" follows a clock while the chime is locked.
 */

import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { formatDuration, timerView, type KitchenTimer } from "@/lib/kitchen/timers";
import type { TimerOffer } from "@/lib/kitchen/timer-attach";
import { flyClockIn, markClock } from "./clock-flight";
import { useTimerHere } from "./KitchenTimers";
import { ACTION, FOCUS } from "./control-style";

/** Placeholder copy, awaiting a rewrite. */
export const TIMER_COPY = {
  start: (durationSec: number) => `Start ${formatDuration(durationSec)} timer`,
  done: "Done",
  stepDone: (durationSec: number) => `${formatDuration(durationSec)} timer done`,
  again: "Again",
  againName: (durationSec: number) => `Start the ${formatDuration(durationSec)} timer again`,
  dismiss: (label: string, finished: string | null) =>
    finished ? `${label} timer: ${finished}. Tap to dismiss.` : `${label} timer done. Tap to dismiss.`,
  soundOff: "Tap so the timer can ring",
  more: (n: number) => `and ${String(n)} more`,
  stopHint: "Tap anywhere, or say “Sue, stop”",
} as const;

const LABEL = "text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft";
export const DIGITS = "font-[family-name:var(--font-display)] font-normal leading-none whitespace-nowrap tabular-nums";
/**
 * The digits' size by where they stand: the title's 44 cpx, the chip's 30,
 * or on a borrowed ledge the chip's, stepping down to the meta's 22 (the
 * DS floor) where the ledge leaves the clock under 200 px (portrait), so an
 * hour-plus clock or "Done" in its ring stays on the screen (B5a re-verify
 * of 4bbf470). The ledge's box is a size container (`LedgeClocks`).
 */
const DIGIT_SIZE = {
  title: "text-[length:var(--type-title)]",
  chip: "text-[length:var(--type-chip)]",
  ledge: "text-[length:var(--type-chip)] @max-[200px]:text-[length:var(--type-meta)]",
  /** The foot's well: the title's, the chip's where the foot is shortest (`data-ledge-small`). */
  well: "text-[length:var(--type-title)] group-data-[ledge-small]/foot:text-[length:var(--type-chip)]",
} as const;
export type ClockSize = keyof typeof DIGIT_SIZE;
const EMBER_RING = "font-semibold text-ember-700 before:border-ember before:border-2";
/**
 * A ghost word in the meta (the cook screen keeps its ghosts, DS §5): no
 * fill at rest, sand while pressed, on an 80 cpx target that reaches into the
 * gaps above and below so the row costs only its 52 cpx.
 */
const META_GHOST = `-my-[calc(14*var(--cpx))] -ml-[calc(16*var(--cpx))] inline-flex h-[var(--target)] shrink-0 cursor-pointer items-center gap-[var(--space-2)] rounded-full px-[calc(16*var(--cpx))] text-[length:var(--type-meta)] leading-tight whitespace-nowrap transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand ${FOCUS}`;
/**
 * The offer as the next act: filled in ember at the ring's 52 cpx, inside its
 * 80 cpx target, as the foot's Finish is a fill (DS §1, the one call to action).
 */
const EMBER_FILL =
  "relative isolate ml-0 font-semibold text-paper before:absolute before:inset-x-0 before:inset-y-[calc(14*var(--cpx))] before:-z-10 before:rounded-full before:bg-ember before:content-[''] active:before:bg-ember-700";
/** An action word in a row: the target reaches into the gaps above and below. */
const IN_ROW = "-my-[calc(14*var(--cpx))]";

/** The timer's glyph: a stopwatch, drawn at the words' size. */
export function TimerGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      className="size-[var(--type-meta)] shrink-0"
    >
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 13.5V9.5M10 2.5h4M18.5 5.5l1.5 1.5" />
    </svg>
  );
}

export function TimerLine({
  offer,
  timer,
  done = false,
  ringing = false,
  now,
  ember,
  soundLocked,
  onStart,
  onAllowSound,
}: {
  offer: TimerOffer;
  /** The step's timer while it runs; null before it starts and once it has ended. */
  timer: KitchenTimer | null;
  /** The step's timer ended and was dismissed in this cook. */
  done?: boolean;
  /** The step's timer is ringing: the stage's band carries it, so this line only says so. */
  ringing?: boolean;
  now: number;
  /** This line holds the screen's ember (`emberHolder`). */
  ember: boolean;
  soundLocked: boolean;
  onStart: () => void;
  onAllowSound: () => void;
}) {
  // Every state holds the row's 52 cpx, so the line under it never moves.
  const row =
    "inline-flex min-h-[calc(52*var(--cpx))] flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)]";
  if (timer !== null) {
    return (
      <span className={row}>
        <RunningDigits timer={timer} now={now} ember={ember} size="title" />
        {soundLocked && <SoundOff onAllow={onAllowSound} />}
      </span>
    );
  }
  if (ringing) {
    return (
      <span className={row}>
        <span data-timer="done" className={LABEL}>
          {TIMER_COPY.stepDone(offer.durationSec)}
        </span>
      </span>
    );
  }
  if (done) {
    return (
      <span className={row}>
        <span data-timer="done" className={LABEL}>
          {TIMER_COPY.stepDone(offer.durationSec)}
        </span>
        <button
          type="button"
          aria-label={TIMER_COPY.againName(offer.durationSec)}
          onClick={onStart}
          className={`${META_GHOST} font-medium text-ink-soft`}
        >
          <TimerGlyph />
          {TIMER_COPY.again}
        </button>
      </span>
    );
  }
  return (
    <span className={row}>
      <button
        type="button"
        data-timer="offer"
        onClick={onStart}
        // The next act on the last step is the screen's one call to action,
        // so it is filled in ember (DS §1); elsewhere a ghost.
        className={`${META_GHOST} ${ember ? EMBER_FILL : "font-medium text-ink-soft"}`}
      >
        <TimerGlyph />
        {TIMER_COPY.start(offer.durationSec)}
      </button>
    </span>
  );
}

/**
 * A running clock's digits, which mark where they stand and fly in from
 * where the same timer last stood (`clock-flight`).
 */
export function RunningDigits({
  timer,
  now,
  ember,
  size,
  finalScale = 1.45,
  name,
}: {
  timer: KitchenTimer;
  now: number;
  ember: boolean;
  size: ClockSize;
  /** How far the last ten seconds grow: to the step's size in the meta, a little in the well. */
  finalScale?: number;
  /** The well's name, which fades in once the digits land. */
  name?: RefObject<HTMLElement | null>;
}) {
  // Its name is said, not drawn: named as the clock around it is, so two
  // cooks' clocks are told apart by ear as well (B5a verify round 2).
  const view = timerView(timer, now, useTimerHere());
  const ref = useRef<HTMLSpanElement>(null);
  const flown = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!flown.current) {
      flown.current = true;
      flyClockIn(timer.id, el, name?.current);
    }
    markClock(timer.id, el);
  });
  const digitSize = DIGIT_SIZE[size];
  return (
    <span data-timer="running" role="timer" aria-label={`${view.label}, ${view.digits} left`}>
      <span
        ref={ref}
        aria-hidden="true"
        data-final-ten={view.finalTen || undefined}
        style={view.finalTen ? ({ "--final-scale": String(finalScale) } as CSSProperties) : undefined}
        // The colour beat is the ember's; an ink clock grows but stays ink.
        className={`inline-block ${DIGITS} ${digitSize} ${ember ? "text-ember" : "text-ink"} ${view.finalTen ? `timer-pulse ${ember ? "timer-beat" : ""}` : ""}`}
      >
        {view.digits}
      </span>
    </span>
  );
}

/**
 * One clock off its step (the kitchen home, a borrowed screen's ledge, the
 * foot's well): its label then its digits, or the alarm, whose whole line
 * dismisses it.
 */
export function Clock({
  timer,
  now,
  ember,
  size,
  stacked = false,
  more = 0,
  quietName = false,
  ledge = false,
  onDismiss,
}: {
  timer: KitchenTimer;
  now: number;
  ember: boolean;
  size: ClockSize;
  /** The foot's well: the name over the digits, so the name always stands. */
  stacked?: boolean;
  /** How many more timers are behind this one, said in words. */
  more?: number;
  /** In the well, a second clock's name gives way first where the foot is short; its digits stay. */
  quietName?: boolean;
  /**
   * Over a borrowed screen's ledge: one row beside the ledge's label, its
   * name kept to the well's width and an alarm's time since said, not drawn.
   * Where the ledge leaves the clock under 170 px (portrait), the name goes
   * and the clock stands alone: two letters and an ellipsis name nothing.
   * The name is still said (the clock's label).
   */
  ledge?: boolean;
  onDismiss: (id: string) => void;
}) {
  const view = timerView(timer, now, useTimerHere());
  const name = more > 0 ? `${view.label}, ${TIMER_COPY.more(more)}` : view.label;
  // A long name ("Recipe · Step", away from its cook) ends in an ellipsis
  // rather than pushing the page wide; the digits and "Done" never give.
  const label = <span className={`${LABEL} min-w-0 truncate`}>{name}</span>;
  // The well's name keeps to a width of its own, so the foot's middle never
  // moves for it; where the foot is short, the others go first, then the
  // name ends in an ellipsis (`data-ledge-short`).
  const nameRef = useRef<HTMLSpanElement>(null);
  const wellName = (
    <span
      ref={nameRef}
      className={`${LABEL} block max-w-[calc(180*var(--cpx))] truncate whitespace-nowrap group-data-[ledge-short]/foot:max-w-[calc(120*var(--cpx))] ${quietName ? "group-data-[ledge-short]/foot:sr-only" : ""}`}
    >
      {view.label}
    </span>
  );
  // In the well the last ten grow a little: the band is the foot's.
  const finalScale = stacked ? 1.12 : 1.45;
  if (view.phase === "expired") {
    const digitSize = DIGIT_SIZE[size];
    const ago = view.overdueMs >= 60_000 ? view.finishedText : null;
    return (
      <button
        type="button"
        data-timer="alarm"
        aria-label={TIMER_COPY.dismiss(view.label, ago)}
        onClick={() => onDismiss(timer.id)}
        className={`${ACTION} ${IN_ROW} ${EMBER_RING} max-w-full min-w-0 items-baseline gap-x-[var(--space-3)] ${ledge ? "@max-[200px]:px-[calc(12*var(--cpx))]" : ""}`}
      >
        {stacked || ledge ? (
          // On a ledge or in the well the name keeps the well's width and
          // the time since is said, not drawn: the ledge's label stands
          // beside it, and nothing there can give (B5a verify round 3).
          <span className={`${LABEL} block max-w-[calc(180*var(--cpx))] min-w-0 truncate ${ledge ? "@max-[170px]:sr-only" : ""}`}>{name}</span>
        ) : (
          label
        )}
        <span className={`${DIGITS} ${digitSize} shrink-0 text-ember timer-alarm`}>{TIMER_COPY.done}</span>
        {ago && !stacked && !ledge && <span className={`${LABEL} shrink-0 whitespace-nowrap`}>{ago}</span>}
      </button>
    );
  }
  return (
    <span
      className={
        stacked
          ? "inline-flex flex-col items-start gap-y-[calc(2*var(--cpx))]"
          : "inline-flex max-w-full min-w-0 items-baseline gap-x-[var(--space-3)]"
      }
    >
      {stacked ? wellName : ledge ? <span className={`${LABEL} max-w-[calc(180*var(--cpx))] min-w-0 truncate @max-[170px]:sr-only`}>{name}</span> : label}
      {stacked && more > 0 ? (
        // The others, in words beside the digits; where the foot is short they
        // go first, the name and the digits staying.
        <span className="inline-flex items-baseline gap-x-[var(--space-2)]">
          <RunningDigits timer={timer} now={now} ember={ember} size={size} finalScale={finalScale} name={nameRef} />
          <span className={`${LABEL} whitespace-nowrap group-data-[ledge-short]/foot:sr-only`}>{TIMER_COPY.more(more)}</span>
        </span>
      ) : (
        // On a ledge the last ten don't grow: the clock stands at the
        // screen's edge, with no room to grow into.
        <RunningDigits timer={timer} now={now} ember={ember} size={size} finalScale={ledge ? 1 : finalScale} name={nameRef} />
      )}
    </span>
  );
}

export function SoundOff({ onAllow }: { onAllow: () => void }) {
  return (
    <button type="button" data-sound-off onClick={onAllow} className={`${META_GHOST} font-medium text-ink-soft`}>
      {TIMER_COPY.soundOff}
    </button>
  );
}
