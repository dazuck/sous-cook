/**
 * The flags this tablet didn't keep, since the page loaded (panel round 4):
 * the pill says "Not kept" for its 1.6 s and lets the cook get back to
 * dinner, and the miss waits here for the hub's label and the panel to say,
 * with why. A miss is held in memory only: what failed was the storage it
 * would go to, and a reload, which forgets it, is a new start.
 */

/** Why a flag wasn't kept: it couldn't be captured or stored (F2), or the outbox was full (F11). */
export type Miss = "failed" | "full";

export type FlagMisses = Readonly<Record<Miss, number>>;

const NONE: FlagMisses = { failed: 0, full: 0 };

export interface MissLog {
  add: (why: Miss) => void;
  read: () => FlagMisses;
  /** The cook has read them: the panel lets them go as it goes, by any way out. */
  clear: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function createMissLog(): MissLog {
  let misses = NONE;
  const listeners = new Set<() => void>();
  const set = (next: FlagMisses) => {
    misses = next;
    for (const listener of listeners) listener();
  };
  return {
    add: (why) => set({ ...misses, [why]: misses[why] + 1 }),
    read: () => misses,
    clear: () => {
      if (misses !== NONE) set(NONE);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** How many misses in all. */
export const missCount = (misses: FlagMisses): number => misses.failed + misses.full;

/** The tablet's one log of misses. */
export const flagMisses: MissLog = createMissLog();
