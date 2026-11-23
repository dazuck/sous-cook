/**
 * The kitchen's running timers, kept on this tablet (slice B5a, A5): the one
 * list every kitchen page reads, persisted under `sous-timers` so a reload, a
 * deploy or a dropped connection keeps them. Not in the database: timers
 * belong to the kitchen as a device, they must run with no connection, and
 * the app has no auth. Read through `useSyncExternalStore` (no zustand, A6).
 */

import { z } from "zod";
import { readStored, writeStored, type StringStore } from "../persist/safe-storage";
import type { KitchenTimer } from "./timers";

export const TIMERS_KEY = "sous-timers";

const timerSchema = z.object({
  id: z.string().min(1),
  queueId: z.string().nullable(),
  recipeName: z.string().nullable(),
  stepId: z.string().nullable(),
  label: z.string(),
  durationMs: z.number().positive(),
  endsAtEpochMs: z.number(),
});
const timersSchema = z.array(timerSchema);

/** A timer to start: everything but its end, which the start sets. */
export type TimerStart = Omit<KitchenTimer, "endsAtEpochMs">;

export interface TimerStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => readonly KitchenTimer[];
  /**
   * Start a timer, replacing one with the same id ("started"). With
   * `restart: false`, a timer of that id still running is left alone
   * ("running"): voice's start is idempotent, so a misheard phrase never
   * resets nine minutes of pasta.
   */
  start: (spec: TimerStart, nowEpochMs: number, options?: { restart?: boolean }) => "started" | "running";
  /** Remove a timer: an alarm acknowledged. */
  dismiss: (id: string) => void;
  /** Read the list again, as another tab changed it. */
  reload: () => void;
}

const NONE: readonly KitchenTimer[] = Object.freeze([]);

export function createTimerStore(backing: StringStore | null | undefined = undefined): TimerStore {
  // `undefined` is the page's localStorage, resolved by safe-storage; null is none.
  const store = backing === undefined ? undefined : backing;
  let timers: readonly KitchenTimer[] | null = null;
  const listeners = new Set<() => void>();

  const read = () => readStored(TIMERS_KEY, timersSchema, store) ?? NONE;
  const current = () => (timers ??= read());
  const set = (next: readonly KitchenTimer[]) => {
    timers = next;
    writeStored(TIMERS_KEY, next, store);
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: current,
    start: (spec, nowEpochMs, { restart = true } = {}) => {
      const existing = current().find((t) => t.id === spec.id);
      if (!restart && existing !== undefined && existing.endsAtEpochMs > nowEpochMs) return "running";
      set([
        ...current().filter((t) => t.id !== spec.id),
        { ...spec, endsAtEpochMs: nowEpochMs + spec.durationMs },
      ]);
      return "started";
    },
    dismiss: (id) => {
      if (!current().some((t) => t.id === id)) return;
      set(current().filter((t) => t.id !== id));
    },
    reload: () => {
      timers = read();
      for (const listener of listeners) listener();
    },
  };
}

/** The page's timers. On the server it holds nothing and is never written. */
export const timerStore = createTimerStore();

/** What the server renders, and the first paint before storage is read. */
export const NO_TIMERS = NONE;
