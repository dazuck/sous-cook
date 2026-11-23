/**
 * What the app does with the Cook Log, over any `CookLogGrid` (`types.ts`):
 * how a cook's row is written, found again, rated and moved, and how the
 * recent rows read for Ask. The grid only reads, appends and writes cells;
 * every rule about which row is a cook's lives here.
 *
 * Columns: timestamp, recipe_name, recipe_anchor, rating, notes (1 to 5).
 * The log may have other writers (a person editing it, a nightly job that
 * asks for ratings), so the app follows conventions they can share: the
 * timestamp is "YYYY-MM-DD HH:MM" in the kitchen's zone, every cell is text,
 * a cook already logged that day is adopted rather than logged twice, and a
 * later rating or note overwrites.
 */

import type { CookLogRef } from "../../../drizzle/schema";
import { KITCHEN_TIME_ZONE } from "../kitchen/zone";
import type { CookLogGrid } from "./types";

/** Column numbers, as the grid counts them (from 1). */
const TIMESTAMP_COL = 1;
const RATING_COL = 4;

/** The zone the timestamp column is written in: the kitchen's. */
export const COOK_LOG_TIME_ZONE = KITCHEN_TIME_ZONE;

const TIMESTAMP_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: COOK_LOG_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `at` as the timestamp column holds it: "YYYY-MM-DD HH:MM" in the kitchen's zone. */
export function cookLogTimestamp(at: Date): string {
  const parts = TIMESTAMP_PARTS.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

/** Names match exactly after lowercasing, trimming and collapsing whitespace. */
export function normalizeRecipeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// =============================================================================
// Reading
// =============================================================================

export interface CookLogEntry {
  name: string;
  date: Date | null;
  rating: number | null;
  /** The cook's note ("too many leeks…"), trimmed; null when blank. */
  notes: string | null;
}

/**
 * The last `limit` cooks of a log read whole (`CookLogGrid.read`), newest
 * first. The header row is skipped, and so is a row with no recipe name.
 */
export function recentCooks(rows: readonly string[][], limit: number = 10): CookLogEntry[] {
  return rows
    .slice(1)
    .filter((row) => row[1]?.trim())
    .slice(-limit)
    .reverse()
    .map((row) => {
      const parsedDate = new Date(row[0] ?? "");
      const parsedRating = Number.parseFloat(row[3] ?? "");
      const note = (row[4] ?? "").trim();
      return {
        name: row[1].trim(),
        date: Number.isNaN(parsedDate.getTime()) ? null : parsedDate,
        rating: Number.isNaN(parsedRating) ? null : parsedRating,
        notes: note === "" ? null : note,
      };
    });
}

/** The log's last `limit` cooks, newest first. */
export async function fetchRecentCookLog(
  grid: CookLogGrid,
  limit: number = 10,
): Promise<CookLogEntry[]> {
  return recentCooks(await grid.read(), limit);
}

// =============================================================================
// Writing
// =============================================================================

/**
 * The stored row no longer holds the cook, and no single row elsewhere does:
 * the log was edited. Nothing was written.
 */
export class CookLogRowMoved extends Error {
  constructor(
    readonly log: CookLogRef,
    readonly matches: number,
  ) {
    super(
      `Cook Log row ${log.row} no longer holds "${log.recipeName}" at ${log.timestamp}, ` +
        `and ${matches === 0 ? "no other row does" : `${matches} rows do`}`,
    );
    this.name = "CookLogRowMoved";
  }
}

/**
 * The row of a cook already in the log: one on the same day (the kitchen's)
 * with the same name, normalized; the latest, if several. Null when the day
 * has no such row.
 */
export function adoptableRow(
  rows: readonly string[][],
  recipeName: string,
  timestamp: string,
): CookLogRef | null {
  const day = timestamp.slice(0, 10);
  const key = normalizeRecipeName(recipeName);
  for (let i = rows.length - 1; i >= 0; i--) {
    const [a = "", b = ""] = rows[i];
    if (a.slice(0, 10) === day && normalizeRecipeName(b) === key) {
      return { row: i + 1, timestamp: a, recipeName: b, adopted: true };
    }
  }
  return null;
}

/**
 * Logs a cook finished at `at`, unless the Cook Log already has it: a row on
 * the same day with the same name is adopted (`adoptableRow`) and nothing is
 * appended. Another writer may have logged the cook first, and a retry after
 * a lost answer adopts the row the first attempt wrote.
 *
 * @throws Error if the name is empty, the grid fails, or the append doesn't
 *   name its row (the row then exists unlinked; a retry adopts it)
 */
export async function appendCookLog(
  grid: CookLogGrid,
  { name, at }: { name: string; at: Date },
): Promise<CookLogRef> {
  const recipeName = name.trim();
  if (!recipeName) throw new Error("no recipe name");
  const timestamp = cookLogTimestamp(at);

  const adopted = adoptableRow(await grid.read(), recipeName, timestamp);
  if (adopted) return adopted;

  const row = await grid.append([timestamp, recipeName, recipeName, "", ""]);
  if (!Number.isInteger(row) || row < 1) {
    throw new Error(`Cook Log append returned no row number (${JSON.stringify(row)})`);
  }
  return { row, timestamp, recipeName, adopted: false };
}

function holds(row: readonly string[] | undefined, log: CookLogRef): boolean {
  const [a = "", b = ""] = row ?? [];
  return (
    a === log.timestamp &&
    normalizeRecipeName(b) === normalizeRecipeName(log.recipeName)
  );
}

/**
 * The row number that holds the cook: the stored one if it still does, else
 * the one row that does (the log was sorted, or a row inserted above).
 *
 * @throws CookLogRowMoved if zero or several rows hold the cook
 */
export function cookRow(rows: readonly string[][], log: CookLogRef): number {
  if (holds(rows[log.row - 1], log)) return log.row;
  const found = rows.flatMap((r, i) => (holds(r, log) ? [i + 1] : []));
  if (found.length !== 1) throw new CookLogRowMoved(log, found.length);
  return found[0];
}

/**
 * The rating in the cook's row (as written; null when blank), read while the
 * app's ask is open, so a cook rated by another writer closes it. The row is
 * found as `rateCookLog` finds it.
 *
 * @returns the log, with `row` where the cook was found, and its rating
 * @throws CookLogRowMoved if zero or several rows hold the cook
 */
export async function cookLogRating(
  grid: CookLogGrid,
  log: CookLogRef,
): Promise<{ log: CookLogRef; rating: string | null }> {
  const rows = await grid.read();
  const row = cookRow(rows, log);
  const rating = rows[row - 1][3]?.trim();
  return { log: { ...log, row }, rating: rating ? rating : null };
}

/**
 * Writes a rating, and a note when one is given, into the cook's row. The
 * row is checked first: if it no longer holds the cook, the one row that
 * does is written instead. A note left empty keeps any note already there.
 * The rating goes in as text.
 *
 * Known gap: an edit between the check and the write can't be caught; the
 * grid has no compare-and-set.
 *
 * @returns the log, with `row` where the cook was found
 * @throws CookLogRowMoved if zero or several rows hold the cook
 */
export async function rateCookLog(
  grid: CookLogGrid,
  log: CookLogRef,
  rating: number,
  notes?: string,
): Promise<CookLogRef> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error(`Invalid rating: ${rating}`);
  }

  // The whole log, not the one row: a stored row past the log's last row
  // (rows deleted above it) is then no row, not a failed read.
  const row = cookRow(await grid.read(), log);

  const note = notes?.trim();
  await grid.write(row, RATING_COL, note ? [String(rating), note] : [String(rating)]);
  return { ...log, row };
}

/**
 * Moves the cook's row to a new finish time: the timestamp only, so the
 * rating and note stay. For a cook reopened after an auto-finish and
 * finished again (cook-fidelity decision 7), which keeps its row rather than
 * logging the cook twice. The row is found as `rateCookLog` finds it, with
 * the same known gap.
 *
 * @returns the log, with `row` where the cook was found and its new timestamp
 * @throws CookLogRowMoved if zero or several rows hold the cook
 */
export async function retimeCookLog(
  grid: CookLogGrid,
  log: CookLogRef,
  at: Date,
): Promise<CookLogRef> {
  const row = cookRow(await grid.read(), log);
  const timestamp = cookLogTimestamp(at);
  await grid.write(row, TIMESTAMP_COL, [timestamp]);
  return { ...log, row, timestamp };
}
