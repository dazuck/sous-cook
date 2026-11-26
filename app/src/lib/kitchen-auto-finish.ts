/**
 * Finishing a cook the cook didn't (cook-fidelity plan, decision 7): a cook
 * left on its last screen counts as finished, through the same path as Done
 * (`updateQueueStatus` into "completed", then the Cook Log write), skipping
 * the pantry sheet, dated to its last activity and marked `finished_by`
 * "auto", "finished (not pressed)". Then, with a Cook Log connected, its row
 * exists, and the kitchen's "How was it?" (and any nightly job that asks for
 * ratings) finds it.
 *
 * Where it runs:
 *   - the open cook page, on the tablet (`useCookAutoFinish`): it knows the
 *     screen, the timers and every touch, and finishes the cook 45 minutes
 *     after its last activity on the last screen (`autoFinishCook` here);
 *   - the server, for a page that isn't open (the tablet asleep, the tab
 *     gone): the page reports its last-screen activity as it goes
 *     (`reportLastScreen`); a nightly job asks the server to sweep
 *     cooks past the wait before it prompts for ratings
 *     (`sweepAndLogIdleCooks`, behind `POST /api/kitchen-queue/sweep`), and a
 *     cook's next start finishes any cook left on its last screen with no
 *     timer running (`finishLeftCooks`). No read finishes anything: a GET
 *     (the kitchen's "How was it?", a deploy's smoke) writes nothing.
 *
 * A press on the open cook after an auto-finish reopens it
 * (`reopenAutoFinished`), and its next finish within the reopen window
 * updates the Cook Log row it has rather than logging a second
 * (`updateQueueStatus`, `logCook`).
 */

import { and, eq, gt, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { db, kitchenQueue } from "./db";
import { AUTO_FINISH_IDLE_MS, REOPEN_WINDOW_MS } from "./kitchen/auto-finish";
import { getQueueItem, updateQueueStatus } from "./kitchen-queue";
import { cookLogStatus, logCookInBackground, type CookLogStatus } from "./kitchen-cook-log";
import { connected } from "./hooks/connected";

/** Whether the item is a cook the app finished (and not reopened since). */
async function isAutoFinished(kitchenId: string, queueId: string): Promise<boolean> {
  const item = await getQueueItem(kitchenId, queueId);
  return item?.status === "completed" && item.finishedBy === "auto";
}

/**
 * Keeps where a cooking cook sits, from one page's report: its last-screen
 * activity, or null off the last screen, as of the cook's last touch on that
 * page, `interactedAt` by the page's own clock.
 *
 * Every merge moves toward "still cooking" (cook-fidelity decision 7, review
 * round 3), so no order the reports arrive in can finish a cook that is
 * going:
 *   - a report lands only if its touch is at least as new as the newest held:
 *     a report delayed in transit, or from a page touched less lately, never
 *     undoes a step back or a touch reported since. One touch reported twice
 *     (the press, then the step it made) carries one time, and both land;
 *   - off the last screen, it clears the activity (nothing finishes it);
 *   - on it, the activity only ever rises (`greatest`): a page that doesn't
 *     know another's running timer never lowers that timer's end. A timer
 *     stopped early only puts the finish off.
 * The touch is dated by the page's clock, as the pages' clocks are kept to
 * the network's time; the activity by the server's (the router), so a slow
 * report reads later, never earlier. A cook that isn't cooking is left
 * alone, and the answer says whether the app finished it, so an open page
 * learns of a sweep.
 */
export async function reportLastScreen(
  kitchenId: string,
  queueId: string,
  activeAt: Date | null,
  interactedAt: Date,
): Promise<{ cooking: boolean; autoFinished: boolean }> {
  const touched = interactedAt.toISOString();
  const kept = await db
    .update(kitchenQueue)
    .set({
      // Postgres's greatest skips a null.
      lastScreenActiveAt:
        activeAt === null
          ? null
          : sql`greatest(${kitchenQueue.lastScreenActiveAt}, ${activeAt.toISOString()}::timestamptz)`,
      lastInteractionAt: sql`greatest(${kitchenQueue.lastInteractionAt}, ${touched}::timestamptz)`,
    })
    .where(
      and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.id, queueId),
        eq(kitchenQueue.status, "cooking"),
        sql`(${kitchenQueue.lastInteractionAt} is null or ${kitchenQueue.lastInteractionAt} <= ${touched}::timestamptz)`,
      ),
    )
    .returning({ id: kitchenQueue.id });
  if (kept.length > 0) return { cooking: true, autoFinished: false };
  const item = await getQueueItem(kitchenId, queueId);
  if (item?.status === "cooking") return { cooking: true, autoFinished: false };
  return { cooking: false, autoFinished: item?.status === "completed" && item.finishedBy === "auto" };
}

/**
 * The open page's finish: the cook sat on its last screen past the wait, its
 * last activity at `at`, its last touch there at `interactedAt` (the page's
 * clock). A newer touch on any page keeps the cook going. `finished` is true
 * only when this call finished it (the caller's cue to log the cook);
 * `autoFinished` says where it stands.
 */
export async function autoFinishCook(
  kitchenId: string,
  queueId: string,
  at: Date,
  interactedAt: Date,
  memberId: string | null = null,
): Promise<{ finished: boolean; autoFinished: boolean }> {
  const { completed } = await updateQueueStatus(kitchenId, queueId, "completed", {
    by: "auto",
    at,
    interactedAt,
    memberId,
  });
  return { finished: completed, autoFinished: completed || (await isAutoFinished(kitchenId, queueId)) };
}

/**
 * Finishes each cooking cook of `kitchenId` whose last-screen activity is at or
 * before `cutoff`, except `except`, running `then` on each before the next.
 * The select only finds them: each finish reads the row again as it writes
 * (`idleBefore`), so a step back or a timer reported since keeps that cook
 * cooking.
 */
async function finishSittingCooks(
  kitchenId: string,
  cutoff: Date,
  except?: string,
  then: (id: string) => Promise<void> = async () => {},
): Promise<string[]> {
  const sitting = await db
    .select({ id: kitchenQueue.id })
    .from(kitchenQueue)
    .where(
      and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.status, "cooking"),
        isNotNull(kitchenQueue.lastScreenActiveAt),
        lte(kitchenQueue.lastScreenActiveAt, cutoff),
        ...(except === undefined ? [] : [ne(kitchenQueue.id, except)]),
      ),
    );
  const finished: string[] = [];
  for (const { id } of sitting) {
    const { completed } = await updateQueueStatus(kitchenId, id, "completed", {
      by: "auto",
      idleBefore: cutoff,
    });
    if (!completed) continue;
    finished.push(id);
    await then(id);
  }
  return finished;
}

/**
 * The server's sweep: finishes `kitchenId`'s cooks that sat on their last screen
 * `idleMs` past their last activity (a running timer's end counts as
 * activity, so a timer still running never qualifies). Returns those it
 * finished, for the caller to log.
 */
export function sweepIdleCooks(
  kitchenId: string,
  now: Date = new Date(),
  idleMs: number = AUTO_FINISH_IDLE_MS,
): Promise<string[]> {
  return finishSittingCooks(kitchenId, new Date(now.getTime() - idleMs));
}

/**
 * A cook the sweep finished or logged again, and where its Cook Log row
 * stands once written ("none" with no Cook Log connected: nothing is written).
 */
export interface SweptCook {
  queueId: string;
  name: string | null;
  cookLog: CookLogStatus;
}

/**
 * How far back the sweep looks for an auto-finish left without its row, by
 * its `completed_at`. That is the cook's last activity, not when the finish
 * ran, and no column holds the latter, so the window allows for the
 * backdating: a cook the 21:00 sweep finished was last active up to about
 * 24h45m before it (any earlier, the night before's sweep had taken it), so
 * a failed write from one night is up to about 48h45m old at the next
 * night's sweep. Three days lets the next night retry it in the worst case,
 * and the night after if one sweep is missed, at most a few extra Cook Log
 * calls for a write that keeps failing. A write cut off with its claim held
 * reads "writing" for the claim's 2 minutes (`LOST_WRITE_MS`) and is skipped
 * only until then.
 */
export const RELOG_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Writes the cook's row (never rejects) and says where it stands. With no
 * Cook Log connected there is no row to write, and it stands at "none".
 */
async function logAndRead(kitchenId: string, id: string): Promise<SweptCook> {
  // Never rejects: an outcome it can't store is logged, and reads "failed".
  if (connected["cook-log"]) await logCookInBackground(kitchenId, id);
  const item = await getQueueItem(kitchenId, id);
  if (!item) throw new Error(`queue item ${id} vanished as the sweep logged it`);
  return {
    queueId: id,
    name: item.recipeData?.name?.trim() || null,
    cookLog: connected["cook-log"] ? cookLogStatus(item) : "none",
  };
}

/**
 * The sweep (`POST /api/kitchen-queue/sweep`, for a nightly job to call
 * before it asks for ratings), for one kitchen:
 *   - `finished`: finishes each cook idle on its last screen past the wait
 *     and writes its Cook Log row before it finishes the next, so a sweep cut
 *     off part way leaves no cook it finished unlogged but the one in hand;
 *   - `relogged`: writes the row of each cook the app finished lately
 *     (`RELOG_LOOKBACK_MS`) whose write failed or was lost (a sweep cut off, the log down), so
 *     a retry of the sweep recovers it. Not one the cook finished (the app's
 *     retry is theirs), and not one whose write is still under way. Always
 *     empty with no Cook Log connected.
 * A tablet asleep on the last screen runs no page timer; this is what
 * finishes its cook. Idempotent: a cook it finished is no longer cooking,
 * and one logged has its row, so a second call writes nothing new.
 */
export async function sweepAndLogIdleCooks(
  kitchenId: string,
  now: Date = new Date(),
): Promise<{ finished: SweptCook[]; relogged: SweptCook[] }> {
  const finished: SweptCook[] = [];
  const relogged: SweptCook[] = [];
  await finishSittingCooks(
    kitchenId,
    new Date(now.getTime() - AUTO_FINISH_IDLE_MS),
    undefined,
    async (id) => {
      finished.push(await logAndRead(kitchenId, id));
    },
  );
  if (connected["cook-log"]) {
    const unlogged = await db.query.kitchenQueue.findMany({
      where: and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.status, "completed"),
        eq(kitchenQueue.finishedBy, "auto"),
        isNull(kitchenQueue.cookLog),
        gt(kitchenQueue.completedAt, new Date(now.getTime() - RELOG_LOOKBACK_MS)),
      ),
    });
    for (const item of unlogged) {
      if (finished.some((f) => f.queueId === item.id)) continue;
      if (cookLogStatus(item, now) !== "failed") continue;
      relogged.push(await logAndRead(kitchenId, item.id));
    }
  }
  return { finished, relogged };
}

/**
 * A cook's next start: finishes `kitchenId`'s other cooks left on their last
 * screen with no timer running, at once. A cook mid-recipe stays cooking: two
 * dishes can be under way together. Returns those it finished, for the
 * caller to log.
 */
export function finishLeftCooks(
  kitchenId: string,
  starting: string,
  now: Date = new Date(),
): Promise<string[]> {
  return finishSittingCooks(kitchenId, now, starting, async () => {});
}

/**
 * A press on the open cook after the app finished it: the cook goes on. Its
 * start, Cook Log row and closed ask stay, and `finished_by` stays "auto"
 * and `completed_at` the finish's while it cooks, so a next finish within
 * `REOPEN_WINDOW_MS` of it moves that row instead of logging a second. Only
 * within `REOPEN_WINDOW_MS` of `completed_at`, the cook's last activity the
 * finish was dated to (so a cook the next start finished hours after its
 * last activity doesn't reopen), and never a cook the cook finished.
 */
export async function reopenAutoFinished(
  kitchenId: string,
  queueId: string,
  now: Date = new Date(),
): Promise<{ reopened: boolean }> {
  const reopened = await db
    .update(kitchenQueue)
    // Where the cook sits now is the page's to say, and it reports at once:
    // until then no sweep or next start takes the cook (a step back may have
    // left the last screen).
    .set({ status: "cooking", lastScreenActiveAt: null })
    .where(
      and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.id, queueId),
        eq(kitchenQueue.status, "completed"),
        eq(kitchenQueue.finishedBy, "auto"),
        gt(kitchenQueue.completedAt, new Date(now.getTime() - REOPEN_WINDOW_MS)),
      ),
    )
    .returning({ id: kitchenQueue.id });
  return { reopened: reopened.length > 0 };
}
