/**
 * The foot's well holds its room on a step with a timer (DECISIONS 2026-11-24, the pick on the
 * progress line's jump). The strip's line takes what the foot's ends leave it (DS v1.62), so when the
 * step's own clock walked into the well (landing at the whole cook) the line was laid again about
 * 245 px shorter in one frame, and back on leaving. On a step with a timer the well now keeps the room
 * its clock would take from the start: the clocks it holds, the step's own among them, are drawn there
 * unseen (`TimerLedge` in `CookFlow`'s foot), so the line stands at the shorter length the whole time.
 * A step with no timer keeps the whole line.
 */

import type { KitchenTimer } from "./timers";
import type { TimerOffer } from "./timer-attach";

export interface WellTimers {
  /** The step in hand's timer to start; null on a step with none. */
  offer: TimerOffer | null;
  /** That timer while it runs on the step. */
  stepTimer: KitchenTimer | null;
  /** The clocks in the well: every running timer but the step's own while it stands on the step. */
  ledge: readonly KitchenTimer[];
}

/**
 * The clocks whose room the well keeps, or null where it keeps none (a step with no timer): the well's
 * clocks with the step's own among them. Running, it is its own clock; not started, done or ringing, a
 * clock of its whole length, so the room it holds is the room it takes once it runs.
 */
export function wellRoom(t: WellTimers, now: number): readonly KitchenTimer[] | null {
  const offer = t.offer;
  if (offer === null) return null;
  if (t.ledge.some((x) => x.id === offer.id)) return t.ledge;
  const own: KitchenTimer = t.stepTimer ?? {
    id: offer.id,
    queueId: offer.queueId,
    recipeName: offer.recipeName,
    stepId: offer.stepId,
    label: offer.label,
    durationMs: offer.durationMs,
    endsAtEpochMs: now + offer.durationMs,
  };
  return [...t.ledge, own];
}

/** One way the well can stand: these clocks, this one leading, that one beside it (null: none beside). */
export interface WellShape {
  timers: readonly KitchenTimer[];
  lead: string;
  second: string | null;
}

/**
 * Every way the well can stand on this step, for the room it holds (review round 2): the well without
 * the step's clock (as it is while the clock stands on the step) and with it (at the whole cook), each
 * clock leading and each other beside it. Which clock leads moves with the minutes (the soonest leads,
 * an alarm first), so the room is held for every lead, and stays the same while the clocks count down,
 * start, and walk into the well and out. Null on a step with no timer.
 */
export function wellShapes(t: WellTimers, now: number): WellShape[] | null {
  const room = wellRoom(t, now);
  if (room === null || t.offer === null) return null;
  const ownId = t.offer.id;
  const without = room.filter((x) => x.id !== ownId);
  const shapes: WellShape[] = [];
  for (const timers of without.length > 0 ? [without, room] : [room]) {
    if (timers.length === 1) {
      shapes.push({ timers, lead: timers[0].id, second: null });
      continue;
    }
    for (const a of timers) for (const b of timers) if (a.id !== b.id) shapes.push({ timers, lead: a.id, second: b.id });
  }
  return shapes;
}

/**
 * What the held shapes are drawn from, and nothing else: each clock's name and whole length, never
 * where it stands in its countdown. The foot draws its held room again only when this changes, not on
 * the clock's tick (review round 3).
 */
export function wellShapesKey(t: WellTimers): string {
  const clock = (x: { id: string; queueId: string | null; recipeName: string | null; label: string; durationMs: number }) =>
    `${x.id}~${x.queueId}~${x.recipeName}~${x.label}~${x.durationMs}`;
  return [t.offer ? clock(t.offer) : "", t.stepTimer ? clock(t.stepTimer) : "", ...t.ledge.map(clock)].join("|");
}
