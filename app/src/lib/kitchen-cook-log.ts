/**
 * The Cook Log write behind Done, and the rating that fills the same row.
 *
 * The log itself is the cook-log hook (`lib/hooks/types.ts`, `CookLogGrid`);
 * the rules for a cook's row are `lib/hooks/cook-log.ts`. This module is the
 * queue item's side: the claim, the stored outcome, the retry. Its callers
 * (the router, the sweep) run it only while the hook is connected.
 *
 * Done moves the item into "completed" (`updateQueueStatus`), then the router
 * runs `logCookInBackground` from `after()`: Done never waits on the log. The
 * outcome stays on the queue item, as `cook_log` (the row) or
 * `cook_log_error` (why not), and `cookLogStatus` reads it, so a failed or
 * lost write shows as "failed" and is retried from the app, never dropped.
 *
 * Every write first claims the item (`cook_log_claimed_at`, a conditional
 * UPDATE), so of two writes started together (a double retry, a retry and a
 * rating, a refinish's write and the first finish's) only one reaches the
 * log; the other is a "writing" conflict. A claim older than
 * `LOST_WRITE_MS` belongs to a lost write and may be taken. Whether a write
 * appends a row or moves the one the cook has (a cook the app finished,
 * reopened and finished again) is read off the item under the claim, and a
 * write that stored its row looks again before it lets go, so a refinish
 * that raced it moves the row rather than leave it at the first finish.
 *
 * The log may have other writers (`lib/hooks/cook-log.ts`): a job that asks
 * for a rating on rows with none skips a row the app has rated.
 */

import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { CookLogRef } from "../../drizzle/schema";
import { db, kitchenQueue } from "./db";
import {
  appendCookLog,
  cookLogRating,
  cookLogTimestamp,
  CookLogRowMoved,
  rateCookLog,
  retimeCookLog,
} from "./hooks/cook-log";
import { hook } from "./hooks/registry";
import { getQueueItem, type KitchenQueueItem } from "./kitchen-queue";

/**
 * A write that has stored neither a row nor an error this long after Done,
 * or after its claim, was lost (the function was stopped): it reads "failed",
 * and may be retried. Each call to the log bounds its own time (the hook's
 * contract), but a hung runtime or database can keep a live write past it. A
 * retry then takes over, and both writes may append a row.
 */
export const LOST_WRITE_MS = 2 * 60 * 1000;

const ERROR_LIMIT = 500;

export type CookLogStatus = "none" | "writing" | "logged" | "failed";

/** What a write attempt left on the item. */
export type CookLogOutcome =
  | { status: "logged"; log: CookLogRef }
  | { status: "failed"; error: string };

/** Why a retry or a rating can't run now; the router answers CONFLICT. */
export type CookLogConflictReason = "not-completed" | "writing" | "row-moved";

export class CookLogConflict extends Error {
  constructor(
    readonly reason: CookLogConflictReason,
    message: string,
  ) {
    super(message);
    this.name = "CookLogConflict";
  }
}

/** No queue item has the id; the router answers NOT_FOUND. */
export class CookLogItemNotFound extends Error {
  constructor(readonly queueId: string) {
    super(`Kitchen queue item not found: ${queueId}`);
    this.name = "CookLogItemNotFound";
  }
}

/** Whether `at` is within `LOST_WRITE_MS` before `now`. */
function withinWritingWindow(at: Date | string, now: Date): boolean {
  return now.getTime() - new Date(at).getTime() <= LOST_WRITE_MS;
}

/**
 * Where the item's Cook Log write stands. Derived, never stored: "none" for
 * an item that isn't a completed cook, "logged" with a row, "writing" while a
 * write holds its claim, "failed" with an error or once `LOST_WRITE_MS` has
 * passed since Done with neither, else "writing".
 */
export function cookLogStatus(
  item: Pick<
    KitchenQueueItem,
    "status" | "completedAt" | "cookLog" | "cookLogError" | "cookLogClaimedAt"
  >,
  now: Date = new Date(),
): CookLogStatus {
  if (item.status !== "completed" || !item.completedAt) return "none";
  if (item.cookLog) return "logged";
  if (item.cookLogClaimedAt && withinWritingWindow(item.cookLogClaimedAt, now)) {
    return "writing";
  }
  if (item.cookLogError) return "failed";
  return withinWritingWindow(item.completedAt, now) ? "writing" : "failed";
}

async function itemOrThrow(
  kitchenId: string,
  queueId: string,
): Promise<KitchenQueueItem> {
  const item = await getQueueItem(kitchenId, queueId);
  if (!item) throw new CookLogItemNotFound(queueId);
  return item;
}

/** Rows a write may land on: a completed cook with no row stored yet. */
function awaitingRow(kitchenId: string, queueId: string) {
  return and(
    eq(kitchenQueue.kitchenId, kitchenId),
    eq(kitchenQueue.id, queueId),
    eq(kitchenQueue.status, "completed"),
    isNull(kitchenQueue.cookLog),
  );
}

/**
 * Takes the item for one write, stamped `claimedAt`: it holds no live claim,
 * is still the cook the write read, and (for "append") awaits a row; "move"
 * takes a cook whatever row it holds. A reopen and Done since stamps a new
 * `completed_at`, and the write must not claim that cook. Of two calls at
 * once, exactly one gets `true`.
 */
async function claim(
  kitchenId: string,
  queueId: string,
  completedAt: Date,
  claimedAt: Date,
  write: "append" | "move" = "append",
): Promise<boolean> {
  const expired = new Date(claimedAt.getTime() - LOST_WRITE_MS);
  const claimed = await db
    .update(kitchenQueue)
    .set({ cookLogClaimedAt: claimedAt })
    .where(
      and(
        write === "append"
          ? awaitingRow(kitchenId, queueId)
          : and(
              eq(kitchenQueue.kitchenId, kitchenId),
              eq(kitchenQueue.id, queueId),
              eq(kitchenQueue.status, "completed"),
            ),
        // The database clock stamps completed_at in microseconds; the item
        // was read in milliseconds.
        sql`date_trunc('milliseconds', ${kitchenQueue.completedAt}) = ${completedAt.toISOString()}::timestamptz`,
        or(
          isNull(kitchenQueue.cookLogClaimedAt),
          lt(kitchenQueue.cookLogClaimedAt, expired),
        ),
      ),
    )
    .returning({ id: kitchenQueue.id });
  return claimed.length > 0;
}

/**
 * Stores the write's failure and releases its claim, only while the claim is
 * still this write's: once a later write has taken over, its claim stands.
 */
async function storeError(
  kitchenId: string,
  queueId: string,
  claimedAt: Date,
  error: string,
): Promise<void> {
  await db
    .update(kitchenQueue)
    .set({ cookLogError: error.slice(0, ERROR_LIMIT), cookLogClaimedAt: null })
    .where(
      and(
        awaitingRow(kitchenId, queueId),
        eq(kitchenQueue.cookLogClaimedAt, claimedAt),
      ),
    );
}

function notCompleted(queueId: string): CookLogConflict {
  return new CookLogConflict(
    "not-completed",
    `Kitchen queue item ${queueId} is not a completed cook, so there's nothing to log`,
  );
}

/** The item is no longer the cook a write or rating started for. */
function reopened(queueId: string, what: string): CookLogConflict {
  return new CookLogConflict(
    "not-completed",
    `Kitchen queue item ${queueId} was reopened ${what}`,
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Writes the item's cook to the Cook Log, or adopts the row already there,
 * and stores the row. The cook's time is `completed_at`, so a retry the next
 * morning still logs, and dedupes against, the day it was cooked.
 *
 * It claims the item before calling the log; while another write holds the
 * claim, it calls nothing. A failure of the log is an outcome, stored as
 * `cook_log_error` and returned. A failure to read or store the item throws.
 * The row is stored only while the claim is still this write's (finishing
 * the cook again clears it), and only over no row: a write that outlived its
 * claim, or its cook, stores nothing.
 *
 * `now` pins the clock for every step; left out, each step reads it when it
 * runs, so the claim is stamped when it is taken, not before the reads.
 *
 * @throws CookLogItemNotFound if no item has the id
 * @throws CookLogConflict "not-completed" if it isn't a completed cook, or
 *   was reopened before or while its row was written; "writing" while
 *   another write holds the claim
 * @throws Error if the database refuses the write
 */
export async function logCook(
  kitchenId: string,
  queueId: string,
  now?: Date,
): Promise<CookLogOutcome> {
  const item = await itemOrThrow(kitchenId, queueId);
  // A cook reopened after an auto-finish and finished again keeps its row
  // (`updateQueueStatus`): the row moves to the new finish, never a second.
  if (item.cookLog && item.status === "completed" && !rowOnFinish(item)) {
    const moved = await followFinish(kitchenId, queueId, now);
    if (moved === "held") {
      throw new CookLogConflict(
        "writing",
        "Another write holds this cook's Cook Log row; it moves the row to this finish",
      );
    }
    if (moved === "gone") throw reopened(queueId, "and finished as a new cook before its row was moved");
    return { status: "logged", log: moved };
  }
  return writeCook(kitchenId, item, now);
}

/**
 * Whether the item's row needs no move: it carries the finish time, or it
 * isn't the app's to move. A row the app adopted (another writer logged the
 * cook that day) keeps the time its writer gave it, which is half that
 * writer's key for the row; the app moves only a row it appended.
 */
function rowOnFinish(item: Pick<KitchenQueueItem, "cookLog" | "completedAt">): boolean {
  if (!item.cookLog || !item.completedAt || item.cookLog.adopted) return true;
  return item.cookLog.timestamp === cookLogTimestamp(new Date(item.completedAt));
}

/** A cook can't be finished again faster than this; past it, something is wrong. */
const FOLLOW_ROUNDS = 5;

/**
 * Moves the cook's row to its finish until the two agree: a cook finished
 * again while its row was moved is followed once more. "held" when another
 * write holds the claim; that write follows the finish before it lets go.
 * "gone" when the item holds no row any more: finished again past the reopen
 * window, it is a new cook, and that finish's write logs it.
 *
 * @throws CookLogRowMoved if no single row holds the cook (nothing written)
 * @throws Error if the log refuses the write (the row keeps its old time), or
 *   the cook was finished again in every one of `FOLLOW_ROUNDS` rounds
 */
async function followFinish(
  kitchenId: string,
  queueId: string,
  now?: Date,
): Promise<CookLogRef | "held" | "gone"> {
  for (let round = 0; round < FOLLOW_ROUNDS; round++) {
    const item = await itemOrThrow(kitchenId, queueId);
    if (!item.cookLog) return "gone";
    if (item.status !== "completed" || rowOnFinish(item)) return item.cookLog;
    const moved = await moveRow(kitchenId, item, now);
    if (moved === "held") return "held";
  }
  throw new Error(
    `queue item ${queueId} was finished again in each of ${FOLLOW_ROUNDS} moves of its Cook Log row`,
  );
}

/**
 * Under a claim, moves the cook's row to its finish time and stores where it
 * now is. The row and the time are read once the claim is held, so a write
 * that stored the row meanwhile is the row moved; the store lands only while
 * the claim is still this move's and over the row it read. A cook finished
 * again during the move keeps the claim (`updateQueueStatus`), so it stores,
 * and `followFinish` moves the row once more.
 */
async function moveRow(
  kitchenId: string,
  item: KitchenQueueItem,
  now?: Date,
): Promise<"moved" | "held"> {
  if (!item.completedAt) throw notCompleted(item.id);
  const claimedAt = now ?? new Date();
  if (!(await claim(kitchenId, item.id, new Date(item.completedAt), claimedAt, "move"))) return "held";
  try {
    const held = await itemOrThrow(kitchenId, item.id);
    if (!held.cookLog || !held.completedAt || rowOnFinish(held)) return "moved";
    const moved = await retimeCookLog(hook("cook-log"), held.cookLog, new Date(held.completedAt));
    await db
      .update(kitchenQueue)
      .set({ cookLog: moved })
      .where(
        and(
          eq(kitchenQueue.kitchenId, kitchenId),
          eq(kitchenQueue.id, item.id),
          eq(kitchenQueue.cookLogClaimedAt, claimedAt),
          sql`${kitchenQueue.cookLog} = ${JSON.stringify(held.cookLog)}::jsonb`,
          or(
            eq(kitchenQueue.status, "completed"),
            and(eq(kitchenQueue.status, "cooking"), eq(kitchenQueue.finishedBy, "auto")),
          ),
        ),
      );
    return "moved";
  } finally {
    await db
      .update(kitchenQueue)
      .set({ cookLogClaimedAt: null })
      .where(
        and(
          eq(kitchenQueue.kitchenId, kitchenId),
          eq(kitchenQueue.id, item.id),
          eq(kitchenQueue.cookLogClaimedAt, claimedAt),
        ),
      );
  }
}

/** `logCook` for an item already read: the cook it writes is that one. */
async function writeCook(
  kitchenId: string,
  item: KitchenQueueItem,
  now?: Date,
): Promise<CookLogOutcome> {
  const queueId = item.id;
  if (item.cookLog) return { status: "logged", log: item.cookLog };
  if (item.status !== "completed" || !item.completedAt) {
    throw notCompleted(queueId);
  }

  const claimedAt = now ?? new Date();
  if (!(await claim(kitchenId, queueId, new Date(item.completedAt), claimedAt))) {
    const current = await itemOrThrow(kitchenId, queueId);
    if (!sameCook(item, current)) {
      throw reopened(
        queueId,
        "before its Cook Log write started; nothing was written",
      );
    }
    if (current.cookLog) return { status: "logged", log: current.cookLog };
    throw new CookLogConflict(
      "writing",
      "Still writing this cook to the Cook Log; try again in a moment",
    );
  }

  const name = item.recipeData?.name?.trim();
  if (!name) {
    const error = "no recipe name";
    await storeError(kitchenId, queueId, claimedAt, error);
    return { status: "failed", error };
  }

  let log: CookLogRef;
  try {
    log = await appendCookLog(hook("cook-log"), { name, at: new Date(item.completedAt) });
  } catch (err) {
    const error = messageOf(err).slice(0, ERROR_LIMIT);
    await storeError(kitchenId, queueId, claimedAt, error);
    return { status: "failed", error };
  }

  const stored = await db
    .update(kitchenQueue)
    .set({ cookLog: log, cookLogError: null, cookLogClaimedAt: null })
    .where(
      and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.id, queueId),
        isNull(kitchenQueue.cookLog),
        eq(kitchenQueue.cookLogClaimedAt, claimedAt),
        // Or a cook the app finished and the cook reopened while its row was
        // written (cook-fidelity decision 7): its row goes with it, so the
        // next finish moves the row rather than log the cook twice.
        or(
          eq(kitchenQueue.status, "completed"),
          and(eq(kitchenQueue.status, "cooking"), eq(kitchenQueue.finishedBy, "auto")),
        ),
      ),
    )
    .returning({ id: kitchenQueue.id });
  if (stored.length > 0) {
    // A refinish while the row was appended kept the claim and waited on
    // this write (its own write found the claim held): move the row to it.
    const followed = await followFinish(kitchenId, queueId, now);
    return { status: "logged", log: typeof followed === "string" ? log : followed };
  }

  // The claim was lost mid-write, so nothing was stored.
  const current = await itemOrThrow(kitchenId, queueId);
  if (!sameCook(item, current)) {
    // Reopened (and maybe Done again): the item is no longer this cook, and
    // the new cook writes its own row.
    throw reopened(
      queueId,
      `while its Cook Log row was written; row ${log.row} stays in the log for the earlier cook`,
    );
  }
  // A write that took over the lapsed claim stored its row: the cook's answer.
  if (current.cookLog) return { status: "logged", log: current.cookLog };
  // That write is still running; it dedupes against the row appended here.
  throw new CookLogConflict(
    "writing",
    `Another write took over this cook's Cook Log write (row ${log.row} was appended); try again in a moment`,
  );
}

/** Whether `b` is still the cook `a` read: completed, at the same time. */
function sameCook(
  a: Pick<KitchenQueueItem, "completedAt">,
  b: Pick<KitchenQueueItem, "status" | "completedAt">,
): boolean {
  return (
    b.status === "completed" &&
    a.completedAt !== null &&
    b.completedAt !== null &&
    new Date(a.completedAt).getTime() === new Date(b.completedAt).getTime()
  );
}

/**
 * `logCook` for Done, run from `after()` once the status update has answered.
 * Never rejects: a failure of the log is already stored for the app to show and
 * retry, and a throw (the item gone or reopened, the database down) has no
 * caller left to tell; a cook left without an outcome reads "failed" after
 * `LOST_WRITE_MS`. Both are logged here as errors. A write that found
 * another one holding the claim (nothing to do) is logged as info.
 */
export async function logCookInBackground(
  kitchenId: string,
  queueId: string,
): Promise<void> {
  try {
    const outcome = await logCook(kitchenId, queueId);
    if (outcome.status === "failed") {
      console.error(
        `Cook Log write failed for queue item ${queueId}: ${outcome.error}`,
      );
    }
  } catch (err) {
    if (err instanceof CookLogConflict && err.reason === "writing") {
      console.info(
        `Cook Log write skipped for queue item ${queueId}: another write holds it`,
      );
      return;
    }
    console.error(`Cook Log write threw for queue item ${queueId}:`, err);
  }
}

/** The item's status, refusing the states where no write may start. */
async function writableItem(kitchenId: string, queueId: string, now: Date) {
  const item = await itemOrThrow(kitchenId, queueId);
  const status = cookLogStatus(item, now);
  if (status === "none") throw notCompleted(queueId);
  return { item, status };
}

export type RetryOutcome = CookLogOutcome | { status: "writing" };

/**
 * Runs the write again, only from "failed". A logged item answers with its
 * row; one still writing answers "writing" and starts nothing. Of two
 * retries at once, the one that loses the claim answers "writing" too.
 *
 * @throws CookLogItemNotFound if no item has the id
 * @throws CookLogConflict "not-completed" for an item that isn't a finished
 *   cook, or was reopened before or while the write ran
 */
export async function retryCookLog(
  kitchenId: string,
  queueId: string,
  now?: Date,
): Promise<RetryOutcome> {
  const { item, status } = await writableItem(kitchenId, queueId, now ?? new Date());
  if (status === "logged" && item.cookLog) {
    return { status: "logged", log: item.cookLog };
  }
  if (status === "writing") return { status: "writing" };
  try {
    return await writeCook(kitchenId, item, now);
  } catch (err) {
    if (err instanceof CookLogConflict && err.reason === "writing") {
      return { status: "writing" };
    }
    throw err;
  }
}

export type RateOutcome =
  | { rated: true; log: CookLogRef }
  | { rated: false; error: string };

/**
 * Writes the cook's rating (and a note, if given) into its Cook Log row, then
 * closes the ask. With no row yet, a failed write runs first, so the rating
 * isn't held up by a retry; a write still in flight is a conflict. The
 * rating lives only in the log, where another writer may later replace
 * it; the item keeps only that the ask closed.
 *
 * A failure of the log is returned (`rated: false`) and leaves the ask open. The
 * ask closes only on the cook that was rated: if the item was reopened and
 * finished again meanwhile, the new cook's row and ask are left alone.
 *
 * @throws CookLogItemNotFound if no item has the id
 * @throws CookLogConflict "not-completed" (also when the cook was reopened
 *   before or while its row was written), "writing" (also when another write
 *   took the claim first), or "row-moved" when no single row holds the cook
 *   any more (nothing was written)
 */
export async function rateCook(
  kitchenId: string,
  {
    queueId,
    rating,
    notes,
  }: { queueId: string; rating: number; notes?: string },
  now?: Date,
): Promise<RateOutcome> {
  const { item, status } = await writableItem(kitchenId, queueId, now ?? new Date());
  if (status === "writing") {
    throw new CookLogConflict(
      "writing",
      "Still writing this cook to the Cook Log; try again in a moment",
    );
  }

  let log: CookLogRef;
  if (status === "logged" && item.cookLog) {
    log = item.cookLog;
  } else {
    // The write is for the cook read here: one reopened and Done since is
    // refused at the claim, not written and rated in its place.
    const written = await writeCook(kitchenId, item, now);
    if (written.status === "failed") return { rated: false, error: written.error };
    log = written.log;
  }

  let rated: CookLogRef;
  try {
    rated = await rateCookLog(hook("cook-log"), log, rating, notes);
  } catch (err) {
    if (err instanceof CookLogRowMoved) {
      throw new CookLogConflict("row-moved", err.message);
    }
    const error = messageOf(err).slice(0, ERROR_LIMIT);
    console.error(`Cook Log rating failed for queue item ${queueId}: ${error}`);
    return { rated: false, error };
  }

  // Only over the row that was rated: a re-Done meanwhile cleared it.
  await db
    .update(kitchenQueue)
    .set({ cookLog: rated, ratingClosedAt: sql`now()` })
    .where(
      and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.id, queueId),
        eq(kitchenQueue.status, "completed"),
        sql`${kitchenQueue.cookLog} = ${JSON.stringify(log)}::jsonb`,
      ),
    );
  return { rated: true, log: rated };
}

// =============================================================================
// The kitchen's ask: "How was it?"
// =============================================================================

/**
 * Where the asked cook's row stands, for the kitchen's line: still being
 * written, not written (a retry offered), written and waiting for a rating,
 * written but no single row holds it any more (the log was edited), or
 * written but the log couldn't be read just now, so a rating given
 * elsewhere may not show yet (`unread`, T follow-up item 2).
 */
export type CookAskState = "writing" | "failed" | "logged" | "row-moved" | "unread";

export interface CookAsk {
  queueId: string;
  /** The recipe's name, or null for a legacy item with none. */
  name: string | null;
  state: CookAskState;
}

/** A day is at most 25 hours (where clocks change in autumn); a margin over. */
const ASK_LOOKBACK_MS = 26 * 60 * 60 * 1000;

/** The kitchen's day `at` falls on, "YYYY-MM-DD", as the Cook Log dates it. */
function askDay(at: Date | string): string {
  return cookLogTimestamp(new Date(at)).slice(0, 10);
}

/**
 * Closes the ask of a cook rated in the log by another writer, over the row it
 * was read from, and keeps where the row was found. Only on that cook: one
 * reopened or rated since is left as it is.
 */
async function closeRatedAsk(
  kitchenId: string,
  item: KitchenQueueItem,
  read: CookLogRef,
): Promise<void> {
  await db
    .update(kitchenQueue)
    .set({ cookLog: read, ratingClosedAt: sql`now()` })
    .where(
      and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.id, item.id),
        eq(kitchenQueue.status, "completed"),
        isNull(kitchenQueue.ratingClosedAt),
        sql`${kitchenQueue.cookLog} = ${JSON.stringify(item.cookLog)}::jsonb`,
      ),
    );
}

/**
 * Keeps where an unrated row was found when it isn't where it was stored, so
 * the next read finds it first, as a rating does (T follow-up, item 6). Only
 * over the row it read and only on that cook, as `closeRatedAsk`: a row
 * stored meanwhile (a rating, a retry), a cook reopened or an ask closed
 * meanwhile is left as it is.
 */
async function keepFoundRow(
  kitchenId: string,
  item: KitchenQueueItem,
  read: CookLogRef,
): Promise<void> {
  await db
    .update(kitchenQueue)
    .set({ cookLog: read })
    .where(
      and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.id, item.id),
        eq(kitchenQueue.status, "completed"),
        isNull(kitchenQueue.ratingClosedAt),
        sql`${kitchenQueue.cookLog} = ${JSON.stringify(item.cookLog)}::jsonb`,
      ),
    );
}

/**
 * The cook the kitchen asks "How was it?" of: the latest one `kitchenId`
 * finished today (the kitchen's day, the Cook Log's) whose ask is still open
 * (`rating_closed_at` null). At midnight the day's asks lapse unanswered.
 *
 * For a cook whose row is written, the row is read: a rating there (given by
 * another writer) closes the ask, and the cook before it is asked of instead. An
 * unrated row found away from where it was stored is kept where it was found.
 * A log that can't be read keeps the ask open as `unread`, and is logged:
 * the line says so, and a rating still tries, answering what went wrong. The
 * log is read only while an ask is open on a written row, so a kitchen with
 * nothing to ask reads none.
 */
export async function openCookAsk(
  kitchenId: string,
  now: Date = new Date(),
): Promise<CookAsk | null> {
  const today = askDay(now);
  const finished = await db.query.kitchenQueue.findMany({
    where: and(
      eq(kitchenQueue.kitchenId, kitchenId),
      eq(kitchenQueue.status, "completed"),
      isNull(kitchenQueue.ratingClosedAt),
      gte(kitchenQueue.completedAt, new Date(now.getTime() - ASK_LOOKBACK_MS)),
    ),
    orderBy: [desc(kitchenQueue.completedAt)],
  });

  for (const item of finished) {
    if (!item.completedAt || askDay(item.completedAt) !== today) continue;
    const ask = (state: CookAskState): CookAsk => ({
      queueId: item.id,
      name: item.recipeData?.name?.trim() || null,
      state,
    });

    const status = cookLogStatus(item, now);
    if (status === "none") {
      // Unreachable: the query holds only finished cooks.
      throw new Error(`openCookAsk: queue item ${item.id} is not a finished cook`);
    }
    if (status !== "logged" || !item.cookLog) return ask(status);
    // Only the log's read is caught: a store that fails is the database's
    // error, and the query answers it as one.
    let found: Awaited<ReturnType<typeof cookLogRating>>;
    try {
      found = await cookLogRating(hook("cook-log"), item.cookLog);
    } catch (err) {
      if (err instanceof CookLogRowMoved) return ask("row-moved");
      console.error(
        `Cook Log read for the ask on queue item ${item.id} failed: ${messageOf(err)}`,
      );
      return ask("unread");
    }
    if (found.rating === null) {
      if (found.log.row !== item.cookLog.row) await keepFoundRow(kitchenId, item, found.log);
      return ask("logged");
    }
    await closeRatedAsk(kitchenId, item, found.log);
  }
  return null;
}

/**
 * "Not now": closes the cook's ask unanswered. Closing a closed ask keeps
 * the first close.
 *
 * @throws CookLogItemNotFound if no item has the id
 * @throws CookLogConflict "not-completed" if it isn't a finished cook
 */
export async function dismissCookAsk(
  kitchenId: string,
  queueId: string,
): Promise<void> {
  const closed = await db
    .update(kitchenQueue)
    .set({ ratingClosedAt: sql`now()` })
    .where(
      and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.id, queueId),
        eq(kitchenQueue.status, "completed"),
        isNull(kitchenQueue.ratingClosedAt),
      ),
    )
    .returning({ id: kitchenQueue.id });
  if (closed.length > 0) return;
  const item = await itemOrThrow(kitchenId, queueId);
  if (item.status !== "completed") throw notCompleted(queueId);
}
