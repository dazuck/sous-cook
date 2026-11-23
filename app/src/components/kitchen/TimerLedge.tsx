"use client";

/**
 * The ledge (slice B5a, A8; PLAN M's "the clock moves into the ledge"): a
 * running timer whose step isn't on screen sits at the counter's edge. On
 * the cook screen it is a well of its own in the foot, after the back
 * chevron, drawn only while a timer runs (design rounds 2 and 3); on a
 * borrowed screen or page it stands over the ledge's end. The clock you
 * walked away from keeps its size: name over digits at the timer's 44 cpx.
 * The soonest leads, an alarm before it (the one finished longest); the next
 * shows its own digits beside it, smaller, so no running timer ever leaves
 * the screen without a trace; any beyond two are said in words ("and 1
 * more"), never a count badge. Ink, or ember when the screen's ember is the
 * clock's. It never blinks.
 */

import { useNow } from "./KitchenTimers";
import { Clock, SoundOff } from "./TimerLine";
import type { KitchenTimer } from "@/lib/kitchen/timers";

/** The clock the ledge shows first: an alarm (longest finished), else the soonest to end. */
export function ledgeLead(timers: readonly KitchenTimer[], now: number): KitchenTimer | null {
  const sorted = [...timers].sort((a, b) => a.endsAtEpochMs - b.endsAtEpochMs);
  return sorted.find((t) => t.endsAtEpochMs <= now) ?? sorted[0] ?? null;
}

export function TimerLedge({
  timers,
  emberId,
  soundLocked = false,
  onDismiss,
  onAllowSound,
}: {
  timers: readonly KitchenTimer[];
  /** The running clock that holds the screen's ember, if any. */
  emberId: string | null;
  soundLocked?: boolean;
  onDismiss: (id: string) => void;
  onAllowSound?: () => void;
}) {
  const now = useNow(timers.length > 0);
  const lead = ledgeLead(timers, now);
  if (lead === null) return null;
  const rest = [...timers].filter((t) => t.id !== lead.id).sort((a, b) => a.endsAtEpochMs - b.endsAtEpochMs);
  const second = rest[0];
  return (
    <span data-ledge className="inline-flex shrink-0 items-end gap-x-[var(--space-4)] whitespace-nowrap">
      <Clock timer={lead} now={now} ember={lead.id === emberId} size="well" stacked onDismiss={onDismiss} />
      {second && (
        // Where the foot is shortest the second clock goes, still said.
        <span data-ledge-second className="inline-flex group-data-[ledge-one]/foot:sr-only">
          <Clock
            timer={second}
            now={now}
            ember={second.id === emberId}
            size="chip"
            stacked
            more={rest.length - 1}
            quietName
            onDismiss={onDismiss}
          />
        </span>
      )}
      {soundLocked && onAllowSound && <SoundOff onAllow={onAllowSound} />}
    </span>
  );
}
