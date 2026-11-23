/**
 * When the app finishes a cook the cook didn't (cook-fidelity plan, decision
 * 7): a cook left on its last screen with nothing moving counts as finished,
 * dated to its last activity, and marked "finished (not pressed)". Pure, and
 * shared: the cook page decides it while it is open (`useCookAutoFinish`),
 * and the server's sweep (`kitchen-auto-finish.ts`) for when it isn't, from
 * what the page last reported.
 */

/** How long a cook sits on its last screen, nothing moving, before it counts as finished. */
export const AUTO_FINISH_IDLE_MS = 45 * 60 * 1000;

/**
 * How far apart two readings of the same activity may fall: the page sends
 * how long ago it was, and the server dates it by its clock on arrival, so
 * a report and a finish of the one activity differ by their latencies. A
 * finish is refused only for activity reported later than its own by more
 * than this (another screen on the same cook, say). Also how far ahead of
 * the server's clock a page's own may run before its touches are refused.
 */
export const ACTIVITY_SLACK_MS = 2 * 60_000;

/**
 * How long after an auto-finish (its `completed_at`, the cook's last
 * activity) a press on the open cook reopens it. Past this, the cook is
 * over: a press is read as looking back, not cooking on, and a new cook
 * starts from the queue.
 */
export const REOPEN_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * The cook's last sign of life while it sits on its last screen: its latest
 * touch or voice command, or the end of a timer it is running, whichever is
 * later. While a timer runs that end is in the future, so the cook can't
 * count as idle until the timer is done. Null anywhere but the last screen.
 */
export function lastScreenActivity({
  onLastScreen,
  lastInteraction,
  timerEnds,
}: {
  onLastScreen: boolean;
  /** Epoch ms of the latest touch, key or voice command on the cook. */
  lastInteraction: number;
  /** Epoch ms each of this cook's timers ends (or ended) at. */
  timerEnds: readonly number[];
}): number | null {
  if (!onLastScreen) return null;
  return Math.max(lastInteraction, ...timerEnds);
}

/** When the cook counts as finished, given its last-screen activity; null off the last screen. */
export function autoFinishDue(activeAt: number | null, idleMs: number = AUTO_FINISH_IDLE_MS): number | null {
  return activeAt === null ? null : activeAt + idleMs;
}
