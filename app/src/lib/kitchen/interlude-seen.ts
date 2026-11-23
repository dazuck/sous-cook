/**
 * How many times this tablet has moved past each interlude (slice B5d, B5.md
 * §B5d D9; the Player's `household.interludesSeen`, 2026-08-11). An interlude
 * is keyed by its technique refs, the least familiar governing, else by its
 * recipe and step. Moving forward past one is the honest proxy for "seen".
 * Kept in `sous-interludes` through `safe-storage`: a corrupt store is cleared
 * with its reset line, once.
 */

import { z } from "zod";
import { readStored, safeLocalStorage, writeStored, type StringStore } from "@/lib/persist/safe-storage";

export const INTERLUDES_KEY = "sous-interludes";

/** Collapsed once moved past this many times (the Player's threshold, 2026-08-11). */
export const COLLAPSE_AFTER = 1;

/** Placeholder copy, awaiting a rewrite. */
export const INTERLUDES_RESET_COPY = "Which asides you've read couldn't be read, so they all show in full again.";

const schema = z.record(z.string(), z.number().int().nonnegative());

function browserStore(): StringStore | null {
  return safeLocalStorage();
}

function read(backing: StringStore | null): Record<string, number> {
  return readStored(INTERLUDES_KEY, schema, backing, 1, INTERLUDES_RESET_COPY) ?? {};
}

/**
 * Reads the count once, so a corrupt store is cleared and its line said as
 * the cook opens, not on a later move that would put the line away at once.
 */
export function checkInterludes(backing: StringStore | null = browserStore()): void {
  read(backing);
}

/** Times the least familiar of `keys` has been moved past. */
export function timesSeen(keys: readonly string[], backing: StringStore | null = browserStore()): number {
  if (keys.length === 0) return 0;
  const counts = read(backing);
  return Math.min(...keys.map((key) => counts[key] ?? 0));
}

/** Whether an interlude shows collapsed, to its title alone. */
export function isCollapsed(keys: readonly string[], backing: StringStore | null = browserStore()): boolean {
  return timesSeen(keys, backing) >= COLLAPSE_AFTER;
}

/** Count one move past an interlude. False when storage refused it (logged). */
export function markSeen(keys: readonly string[], backing: StringStore | null = browserStore()): boolean {
  const counts = read(backing);
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return writeStored(INTERLUDES_KEY, counts, backing, 1);
}
