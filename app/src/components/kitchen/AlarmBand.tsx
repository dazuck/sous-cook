"use client";

/**
 * A finished timer, as the cook screen's one subject while it rings (slice
 * B5a, design round 2, the critic's gap 1): "Done" in Caprasimo at the step's
 * size in ember, pulsing (DS §1: danger is ember at full strength plus
 * motion), over the step, which steps back to ink-soft until it is stopped.
 * Named by what finished; the others finished too are said in words. One tap
 * anywhere on the stage stops it (CookFlow), as does "Sue, stop"; the band
 * itself is that target too, for a keyboard or a screen reader.
 */

import { timerView, type KitchenTimer } from "@/lib/kitchen/timers";
import { useTimerHere } from "./KitchenTimers";
import { DIGITS, TIMER_COPY } from "./TimerLine";

export function AlarmBand({
  expired,
  now,
  onDismiss,
}: {
  /** The finished timers, the one finished longest first. */
  expired: readonly KitchenTimer[];
  now: number;
  onDismiss: (id: string) => void;
}) {
  const here = useTimerHere();
  const first = expired[0];
  if (first === undefined) return null;
  const view = timerView(first, now, here);
  const more = expired.length - 1;
  const name = more > 0 ? `${view.label}, ${TIMER_COPY.more(more)}` : view.label;
  const ago = view.overdueMs >= 60_000 ? view.finishedText : null;
  return (
    <button
      type="button"
      data-alarm-band
      aria-label={TIMER_COPY.dismiss(view.label, ago)}
      onClick={() => onDismiss(first.id)}
      className="block w-full cursor-pointer text-left outline-none focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ink"
    >
      {/* One line, so the alarm costs the stage as little as it can: the
          step under it keeps its words (design round 3). */}
      <span className="flex flex-wrap items-baseline gap-x-[var(--space-4)] gap-y-[var(--space-1)]">
        <span className={`${DIGITS} timer-alarm text-[length:var(--type-step)] text-ember`}>{TIMER_COPY.done}</span>
        <span className="text-[length:var(--type-chip)] leading-tight font-semibold text-ink">
          <span aria-hidden className="mr-[var(--space-3)] text-ink-soft">
            ·
          </span>
          {name}
        </span>
        <span className="text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft">
          {ago ? `${ago}. ` : ""}
          {TIMER_COPY.stopHint}
        </span>
      </span>
    </button>
  );
}
