/**
 * What the whole cook says beside its timetable (`timetable-model.ts`,
 * `timetable-layout.ts`, which place and draw it):
 *
 * - `PotTimer`: a started timer on one of a pot's tasks, as the cook screen
 *   hands it to the sheet (a timer started lays the whole cook out again).
 * - `timedStrip`: the strip with each pot's timer deciding its end (N3: "the
 *   timer decides a carried pot"): a running timer ends the pot when it
 *   does; one that rang or was stopped ends it now, done.
 * - `prepWords`: Prep's words when read at the whole cook, and for a screen
 *   reader on its block: what is to do, then its minutes.
 */

import type { Strip, StripMark } from "./cook-strip";
import { COOK_COPY } from "./cook-view";
import { hm } from "./sheet-layout";

/** A started timer on one of a pot's tasks. `done`: it rang (`expired`) or was stopped. */
export interface PotTimer {
  endsAtEpochMs: number;
  done: boolean;
}

/** The pot's timer: the first of its tasks with one started. */
function timerOf(m: StripMark, timers: ReadonlyMap<string, PotTimer>): PotTimer | null {
  for (const id of m.tasks) {
    const t = timers.get(id);
    if (t) return t;
  }
  return null;
}

/**
 * The strip as the pots' timers have it. A pot mark with a started timer
 * ends when the timer does (in the strip's minutes, from its now, at least a
 * minute on) and runs until then, past the plan's end too; once the timer
 * rang or was stopped it ends now, done: the plan's minutes no longer decide
 * it. The step in hand keeps its state. Marks
 * without a timer are as they were, and with no timers the strip is returned
 * as it came.
 */
/**
 * What of the pots' timers `timedStrip` reads at `nowEpochMs`: each timer's
 * whole minutes left, or that it is over. The same key, the same timed strip,
 * so a memo on it lays the whole cook out again at a minute or a timer's end,
 * never on the clock's half-second tick (N3-1).
 */
export function timedKey(timers: ReadonlyMap<string, PotTimer> | undefined, nowEpochMs: number): string {
  if (!timers || timers.size === 0) return "";
  return [...timers.entries()]
    .map(([id, t]) => {
      const ms = t.endsAtEpochMs - nowEpochMs;
      return `${id}:${t.done || ms <= 0 ? "over" : Math.ceil(ms / 60_000)}`;
    })
    .sort()
    .join(",");
}

export function timedStrip(strip: Strip, timers: ReadonlyMap<string, PotTimer> | undefined, nowEpochMs: number): Strip {
  if (!timers || timers.size === 0) return strip;
  let changed = false;
  const marks = strip.marks.map((m) => {
    const t = m.pot ? timerOf(m, timers) : null;
    if (!t) return m;
    const ms = t.endsAtEpochMs - nowEpochMs;
    const over = t.done || ms <= 0;
    const end = Math.max(m.start, over ? Math.min(m.end, strip.now) : strip.now + Math.max(1, Math.ceil(ms / 60_000)));
    // Running while its timer runs, past the plan's end too; done once it is over.
    const state = over ? (m.state === "running" ? "done" : m.state) : m.state === "done" ? "running" : m.state;
    if (end === m.end && state === m.state) return m;
    changed = true;
    return { ...m, end, state };
  });
  return changed ? { ...strip, marks } : strip;
}

/**
 * Prep's words. On the opening, and while Prep is ahead or in hand, what is
 * to do and its minutes ("Prep, 6 to do · 21 min"); once the cook has moved
 * past it, done or what is left. A Prep with no mise of its own (As I go put
 * it all in the cook) is "all as you cook".
 */
export function prepWords(prepMark: StripMark, opening: boolean): { rest: string; done: boolean; aria: string; read: string } {
  const todo = prepMark.todo ?? 0;
  const moved = !opening && prepMark.state !== "in-hand" && prepMark.state !== "ahead";
  const total = prepMark.tasks.length;
  if (total === 0) {
    const rest = !moved ? `  ${COOK_COPY.prepAllAsYouCook}` : ` · ${COOK_COPY.prepDone}`;
    return {
      rest,
      done: moved,
      aria: `${COOK_COPY.prepChapter}${rest.replace(/^ {2}/, ", ")}`,
      read: `${COOK_COPY.prepChapter}${rest.replace(/^ {2}/, " · ")}`,
    };
  }
  const fresh = opening || !moved || todo === total;
  const done = !fresh && todo === 0;
  const rest = fresh
    ? `  ${COOK_COPY.prepToDo(todo)} · ${hm(prepMark.end - prepMark.start)}`
    : ` · ${done ? COOK_COPY.prepDone : COOK_COPY.prepToDo(todo)}`;
  return {
    rest,
    done,
    aria: `${COOK_COPY.prepChapter}${rest.replace(/^ {2}/, ", ")}`,
    read: `${COOK_COPY.prepChapter}${rest.replace(/^ {2}/, " · ")}`,
  };
}
