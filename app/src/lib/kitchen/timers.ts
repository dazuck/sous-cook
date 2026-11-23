/**
 * The kitchen's timers, as pure arithmetic on absolute end times (slice B5a;
 * ported from the Player's `lib/timers.ts`, DECISIONS 2026-08-11). Every
 * function takes an explicit `now`: the 500 ms tick, a reload mid-cook and a
 * night's sleep are the same computation, with no interval state to recover.
 *
 * Timers belong to the kitchen, not a step or a recipe (2026-08-11): one runs
 * on every kitchen page and outlives the cook that started it. One never
 * starts by itself and never from an estimate; it starts from a step's stated
 * `timer_sec` or from a time the cook says ("Sue, set a timer for 5 minutes").
 */

export interface KitchenTimer {
  /** `queueId:stepId` for a step's timer, so a second start replaces it; `adhoc:<n>` for one said. */
  id: string;
  queueId: string | null;
  /** The recipe it was started from, for a timer shown away from its cook. */
  recipeName: string | null;
  stepId: string | null;
  /** What it times, the task's label ("Simmer dal"), or "Timer" for one said. */
  label: string;
  durationMs: number;
  endsAtEpochMs: number;
}

export interface TimerView {
  id: string;
  label: string;
  recipeName: string | null;
  phase: "running" | "expired";
  remainingMs: number;
  overdueMs: number;
  /** "9:00", "0:10", "1:02:05"; "0:00" once expired. */
  digits: string;
  /** "Finished 4 min ago" once expired; null while running. */
  finishedText: string | null;
  /** The last ten seconds, which pulse (DS §3). */
  finalTen: boolean;
}

const FINAL_TEN_MS = 10_000;

/** Countdown digits: "1:30", "10:00", "1:02:05". Partial seconds round up. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${String(hours)}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${String(minutes)}:${ss}`;
}

/** A duration as the offer says it: "30 sec", "9 min", "1 h 30 min". */
export function formatDuration(durationSec: number): string {
  if (durationSec < 60) return `${String(Math.round(durationSec))} sec`;
  const totalMinutes = Math.round(durationSec / 60);
  if (totalMinutes < 60) return `${String(totalMinutes)} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
}

/** "Finished just now", "Finished 45 min ago", "Finished 2 h 15 min ago". Placeholder copy. */
export function formatFinishedAgo(overdueMs: number): string {
  const totalMinutes = Math.floor(overdueMs / 60_000);
  if (totalMinutes < 1) return "Finished just now";
  if (totalMinutes < 60) return `Finished ${String(totalMinutes)} min ago`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0
    ? `Finished ${String(hours)} h ago`
    : `Finished ${String(hours)} h ${String(minutes)} min ago`;
}

/**
 * `here` is the cook the timer is shown on (its queue id), null on a page
 * that is no cook's (the kitchen, the shelf). Away from its own cook a
 * timer's label leads with its recipe ("Dal · Simmer dal"), so two cooks'
 * "Simmer" clocks are told apart (B5a verify, M3); a timer said by voice
 * belongs to no recipe and keeps its own label.
 */
export function timerView(timer: KitchenTimer, nowEpochMs: number, here: string | null = null): TimerView {
  const remainingMs = Math.max(0, timer.endsAtEpochMs - nowEpochMs);
  const overdueMs = Math.max(0, nowEpochMs - timer.endsAtEpochMs);
  const expired = remainingMs === 0;
  const away = timer.recipeName !== null && (timer.queueId === null || timer.queueId !== here);
  return {
    id: timer.id,
    label: away ? `${timer.recipeName} · ${timer.label}` : timer.label,
    recipeName: timer.recipeName,
    phase: expired ? "expired" : "running",
    remainingMs,
    overdueMs,
    digits: formatCountdown(remainingMs),
    finishedText: expired ? formatFinishedAgo(overdueMs) : null,
    finalTen: !expired && remainingMs <= FINAL_TEN_MS,
  };
}

/**
 * Timers whose end falls inside (prev, now]: exclusive at the previous tick,
 * so nothing is announced twice; the window can be 500 ms or a slept-through
 * night.
 */
export function expiredBetween<T extends Pick<KitchenTimer, "endsAtEpochMs">>(
  timers: readonly T[],
  prevEpochMs: number,
  nowEpochMs: number,
): T[] {
  return timers.filter((t) => t.endsAtEpochMs > prevEpochMs && t.endsAtEpochMs <= nowEpochMs);
}

/** An unacknowledged alarm chimes at its end and each minute after, this many times in all. */
export const CHIME_REPEATS = 5;
const CHIME_EVERY_MS = 60_000;
/**
 * The latest a chime may sound after it fell due: a hidden tab's tick is
 * throttled to about once a minute and must still chime (B5.md's failure
 * table), while a tick waking from a sleep must not chime what fell due in
 * it ("no late chime").
 */
export const CHIME_LATE_MS = 90_000;

/**
 * Whether a chime is due in (prev, now]: an expired timer chimes at its end,
 * then every 60 s, five times in all, until it is dismissed (B1 reading 3).
 * One chime for a window holding several. A chime due before the window
 * opened never sounds late, so a reload after the end is quiet until the next
 * repeat, and a night's sleep is quiet.
 */
export function chimeDue(
  timers: readonly Pick<KitchenTimer, "endsAtEpochMs">[],
  prevEpochMs: number,
  nowEpochMs: number,
): boolean {
  // A window is never wider than the latest a chime may sound: a tick that
  // wakes from a sleep sees the whole sleep, and what fell due in it stays
  // silent (independent verify of 11790c5, item 3).
  const from = Math.max(prevEpochMs, nowEpochMs - CHIME_LATE_MS);
  return timers.some((t) => {
    for (let k = 0; k < CHIME_REPEATS; k++) {
      const at = t.endsAtEpochMs + k * CHIME_EVERY_MS;
      if (at > from && at <= nowEpochMs) return true;
    }
    return false;
  });
}

/** Which tab chimes, and since when it last said so. */
export interface ChimerClaim {
  tab: string;
  at: number;
}

/**
 * How long a claim stands without its tab renewing it. A hidden tab's timers
 * are throttled by Chrome to about one tick a minute, so a holder ticking
 * that slowly still holds it; a closed one gives it up.
 */
export const CHIMER_STALE_MS = 90_000;

/**
 * One tab chimes, and never nobody (A11): the visible tab takes the claim; a
 * hidden tab keeps one it holds, so a lone tab behind another app still
 * chimes; a hidden tab takes a claim gone stale. `claim` is what to write
 * back, null to leave it.
 */
export function electChimer(
  current: ChimerClaim | null,
  tab: string,
  visible: boolean,
  nowEpochMs: number,
): { claim: ChimerClaim | null; chimer: boolean } {
  const take = { claim: { tab, at: nowEpochMs }, chimer: true };
  if (visible || current === null || current.tab === tab) return take;
  if (nowEpochMs - current.at > CHIMER_STALE_MS) return take;
  return { claim: null, chimer: false };
}

/** A timer a cook may set: 10 s to 12 h (B1 reading 7, A12). */
export const MIN_TIMER_SEC = 10;
export const MAX_TIMER_SEC = 12 * 3600;

export function inTimerRange(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds >= MIN_TIMER_SEC && seconds <= MAX_TIMER_SEC;
}
