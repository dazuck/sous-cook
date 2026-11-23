"use client";

/**
 * The kitchen's timers on every kitchen page (slice B5a, A11): one engine,
 * mounted once by `app/kitchen/layout.tsx`, so a timer counts, chimes and
 * holds its alarm on the kitchen, the shelf and the cook page alike.
 *
 * - One 500 ms tick, only while a timer exists. It announces a crossing by
 *   the chime (`chimeDue`: at the end and each minute after, five times, never
 *   late after a reload), from the one tab elected to chime (`electChimer`).
 * - The chime unlocks on any tap or key on the page; while a timer exists
 *   and sound is still locked, `soundLocked` says so for the screen.
 * - The screen is held awake while any timer exists (B1 reading 5).
 * - Saved data that couldn't be read is said once, in `notices` (the reset
 *   lines). Any quiet line a kitchen screen should say goes through here.
 *
 * Outside the provider (the fixture viewer, a component test) the timers are
 * an empty list and starting one does nothing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  consumeCorruptionNotices,
  safeLocalStorage,
  safeSessionStorage,
  subscribeCorruptionNotices,
  type CorruptionNotice,
  type StringStore,
} from "@/lib/persist/safe-storage";
import { chime as pageChime, type Chime } from "@/lib/kitchen/chime";
import { NO_TIMERS, TIMERS_KEY, timerStore, type TimerStart, type TimerStore } from "@/lib/kitchen/timer-store";
import { chimeDue, electChimer, type ChimerClaim, type KitchenTimer } from "@/lib/kitchen/timers";
import { SESSION_RESET_COPY } from "@/lib/kitchen/cook-session";
import { OPEN_COPY } from "@/lib/kitchen/cook-open";
import { COOK_COPY } from "@/lib/kitchen/cook-view";

export const TICK_MS = 500;
const CHIMER_KEY = "sous-chimer";
/** Reset lines not yet drawn, kept for the tab (sessionStorage). */
const RESET_LINES_KEY = "sous-reset-lines";
/** The gestures that may unlock audio: a mouse's press, a touch's lift, a key. */
const UNLOCK_EVENTS = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;

export interface KitchenTimers {
  timers: readonly KitchenTimer[];
  /** Ids of the timers that have finished and not been dismissed. */
  expired: ReadonlySet<string>;
  /** A timer exists and the chime can't sound until the page is tapped. */
  soundLocked: boolean;
  /**
   * Timers that rang and were stopped, wherever they were stopped (the cook,
   * a borrowed ledge, the kitchen), until they start again: their step says
   * "timer done" and offers it again, and on the last step it is spent, so
   * Finish is the next act. This tab's record, for as long as it is open.
   */
  stopped: ReadonlySet<string>;
  /** Quiet lines to say once: saved data reset, and any line a screen adds. */
  notices: readonly string[];
  start: (spec: TimerStart, options?: { restart?: boolean }) => "started" | "running";
  dismiss: (id: string) => void;
  allowSound: () => void;
  /** Add a quiet line (B5b's "This recipe changed…" goes here). */
  say: (line: string, options?: { persistent?: boolean }) => void;
  /** Unsay a quiet line (e.g. offline line when back online). */
  unsay: (line: string) => void;
  /** The lines have been read: the cook moved on, or tapped one. */
  clearNotices: () => void;
  /**
   * Forget the cook's own lines (a reset or changed-recipe line) that no cook
   * screen drew, in memory and in the tab: a cook that never opened (its page
   * failed) must not leave them for the next one. The kitchen's lines stay.
   */
  dropCookNotices: () => void;
  /**
   * A screen has drawn the lines. A reset line is kept for the tab until
   * then (sessionStorage), so a page load before it is seen doesn't lose it.
   * If specific lines are passed, only those are marked shown.
   */
  noticesShown: (shown?: readonly string[]) => void;
}

const NOTHING: ReadonlySet<string> = new Set();

/** A timer's finish, told apart from the same timer started again. */
function finishKey(timer: Pick<KitchenTimer, "id" | "endsAtEpochMs">): string {
  return `${timer.id}@${timer.endsAtEpochMs}`;
}

const INERT: KitchenTimers = {
  timers: NO_TIMERS,
  expired: NOTHING,
  soundLocked: false,
  stopped: NOTHING,
  notices: [],
  start: () => "started",
  dismiss: () => {},
  allowSound: () => {},
  say: () => {},
  unsay: () => {},
  clearNotices: () => {},
  dropCookNotices: () => {},
  noticesShown: () => {},
};

const Context = createContext<KitchenTimers>(INERT);

export function useKitchenTimers(): KitchenTimers {
  return useContext(Context);
}

const Here = createContext<string | null>(null);

/**
 * The cook a page's timers are shown on, so a timer away from its own cook
 * names its recipe (`timerView`'s `here`). The cook page sets it; the
 * kitchen and the shelf are no cook's.
 */
export function TimerHere({ queueId, children }: { queueId: string | null; children: ReactNode }) {
  return <Here.Provider value={queueId}>{children}</Here.Provider>;
}

export function useTimerHere(): string | null {
  return useContext(Here);
}

/**
 * The quiet lines on the kitchen, the one page besides the cook page that
 * says them (a borrowed ledge has no room beside its label): a reset read on
 * the shelf waits in the tab until one of the two draws it (B5a verify, M2
 * and round 2). Ink-soft at the meta's size; the cook page draws its own,
 * counted by its fit.
 */
export function TimerNotices({ className = "" }: { className?: string }) {
  const { notices, noticesShown } = useKitchenTimers();
  const kitchenNotices = useMemo(() => notices.filter((l) => !isCookNotice(l)), [notices]);
  const drawn = kitchenNotices.length > 0;
  // Keyed by the lines, so a line added while others stand is marked too.
  const lines = kitchenNotices.join("\n");
  useEffect(() => {
    if (lines) noticesShown(kitchenNotices);
  }, [lines, noticesShown, kitchenNotices]);
  if (!drawn) return null;
  return (
    <div data-notices role="status" className={className}>
      {kitchenNotices.map((line) => (
        <p key={line} className="text-[length:var(--type-meta)] leading-[1.3] font-medium text-ink-soft">
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * The time now, ticking every 500 ms while `active`: the one clock the
 * timers' digits read, so every clock on a screen turns together.
 */
const clock = (() => {
  let now = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (interval === null) {
        now = Date.now();
        interval = setInterval(() => {
          now = Date.now();
          for (const l of listeners) l();
        }, TICK_MS);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && interval !== null) {
          clearInterval(interval);
          interval = null;
        }
      };
    },
    // Stable between ticks, as useSyncExternalStore needs: the subscribe
    // that starts the tick sets it, and React reads it again once subscribed.
    // Not ticking (before the first timer, or idle since the last), it is the
    // time now to the tick, so the render that starts a timer reads the real
    // time, never 0 or the time the clock last stopped (a pot laid out 29M
    // minutes long, T3 fix round).
    now: () => {
      if (interval === null) now = Math.floor(Date.now() / TICK_MS) * TICK_MS;
      return now;
    },
  };
})();

const noSubscribe = () => () => {};

export function useNow(active = true): number {
  return useSyncExternalStore(
    active ? clock.subscribe : noSubscribe,
    clock.now,
    () => 0,
  );
}

/** What a reset says, by the store it cleared. Placeholder copy. */
const RESET_LINES: Record<string, string> = {
  [TIMERS_KEY]: "Saved timers couldn't be read and were reset.",
  "sous-cook": "Saved cook progress couldn't be read and was reset.",
};

export function isCookNotice(line: string): boolean {
  return (
    line === SESSION_RESET_COPY ||
    line === RESET_LINES["sous-cook"] ||
    line === OPEN_COPY.changed ||
    line === OPEN_COPY.offline ||
    line === COOK_COPY.finishedNotPressed
  );
}

export function resetLine(notice: CorruptionNotice): string {
  if (notice.text) return notice.text;
  const known = Object.entries(RESET_LINES).find(([key]) => notice.store.startsWith(key));
  return known?.[1] ?? "Saved kitchen data couldn't be read and was reset.";
}

/** Where the chimer claim is kept: the page's localStorage, shared by its tabs. */
function pageStore(): Pick<Storage, "getItem" | "setItem"> | null {
  return safeLocalStorage();
}

function readClaim(claims: Pick<Storage, "getItem" | "setItem"> | null): ChimerClaim | null {
  try {
    if (claims === null) return null;
    const raw = claims.getItem(CHIMER_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<ChimerClaim>;
    return typeof v.tab === "string" && typeof v.at === "number" ? { tab: v.tab, at: v.at } : null;
  } catch {
    return null;
  }
}

function writeClaim(claims: Pick<Storage, "getItem" | "setItem"> | null, claim: ChimerClaim): void {
  try {
    claims?.setItem(CHIMER_KEY, JSON.stringify(claim));
  } catch {
    // A tab that can't write the claim chimes as if it held it: never nobody.
  }
}

/** The tab's sessionStorage, where reset lines wait to be drawn. */
function tabStore(): StringStore | null {
  return safeSessionStorage();
}

function readResetLines(session: StringStore | null): string[] {
  try {
    const raw = session?.getItem(RESET_LINES_KEY) ?? null;
    if (raw === null) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeResetLines(session: StringStore | null, lines: readonly string[]): void {
  try {
    if (lines.length === 0) session?.removeItem(RESET_LINES_KEY);
    else session?.setItem(RESET_LINES_KEY, JSON.stringify(lines));
  } catch {
    // A tab that can't keep the line still says it now.
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

export function KitchenTimersProvider({
  children,
  store = timerStore,
  chime = pageChime,
  claims,
  session,
}: {
  children: ReactNode;
  store?: TimerStore;
  chime?: Chime;
  /** Where tabs agree which one chimes; the page's localStorage by default. */
  claims?: Pick<Storage, "getItem" | "setItem">;
  /** Where reset lines wait to be drawn; the tab's sessionStorage by default. */
  session?: StringStore;
}) {
  const timers = useSyncExternalStore(store.subscribe, store.getSnapshot, () => NO_TIMERS);
  // Which timers the tick has seen finish, by id and end time (`finishKey`).
  const [finished, setFinished] = useState<ReadonlySet<string>>(NOTHING);
  const [unlocked, setUnlocked] = useState(false);
  // Reset lines (kept for the tab until drawn) and lines said for now.
  const [resets, setResets] = useState<readonly string[]>([]);
  const [said, setSaid] = useState<readonly string[]>([]);
  const [persistent, setPersistent] = useState<ReadonlySet<string>>(NOTHING);
  const [stopped, setStopped] = useState<ReadonlySet<string>>(NOTHING);
  const tab = useRef<string>("");
  const timersRef = useRef(timers);
  useLayoutEffect(() => {
    timersRef.current = timers;
  });

  // Another tab's start or dismiss.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === TIMERS_KEY) store.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [store]);

  // Reset lines: any a page load before this one read and no screen drew,
  // what was cleared before this mounted, and anything after.
  useEffect(() => {
    const tabLines = session ?? tabStore();
    const add = (lines: readonly string[]) => {
      if (lines.length === 0) return;
      setResets((n) => {
        const fresh = lines.filter((l) => !n.includes(l));
        if (fresh.length === 0) return n;
        // Only lines not yet drawn wait in the tab: those already on
        // screen were marked shown and stay out (verify round 3).
        const waiting = readResetLines(tabLines);
        writeResetLines(tabLines, [...waiting, ...fresh.filter((l) => !waiting.includes(l))]);
        return [...n, ...fresh];
      });
    };
    add(readResetLines(tabLines));
    const take = () => add(consumeCorruptionNotices().map(resetLine));
    take();
    return subscribeCorruptionNotices(take);
  }, [session]);

  // The chime unlocks from any gesture on the page.
  useEffect(() => {
    const unlock = () => {
      chime.unlock();
      // `resume()` settles a moment later.
      setTimeout(() => setUnlocked(chime.unlocked()), 50);
    };
    // A touch's pointerdown is no user activation in Chrome (HTML: a touch
    // activates on pointerup, touchend and click), so the way up counts too.
    for (const type of UNLOCK_EVENTS) document.addEventListener(type, unlock, { capture: true });
    return () => {
      for (const type of UNLOCK_EVENTS) document.removeEventListener(type, unlock, { capture: true });
    };
  }, [chime]);

  const any = timers.length > 0;
  // Finished means a timer that exists now and was seen to end. A dismissed timer is gone from
  // the list, and one started again has a new end time, so neither carries an old finish: there
  // is nothing to reset when the last timer goes.
  const expired = useMemo<ReadonlySet<string>>(() => {
    const ids = timers.filter((t) => finished.has(finishKey(t))).map((t) => t.id);
    return ids.length === 0 ? NOTHING : new Set(ids);
  }, [timers, finished]);

  // The tick: crossings, the chime and which timers have finished.
  useEffect(() => {
    if (!any) {
      return;
    }
    tab.current ||= Math.random().toString(36).slice(2);
    // From mount: anything due before it never chimes late.
    let prev = Date.now();
    const tick = () => {
      const now = Date.now();
      const list = timersRef.current;
      const done = new Set(list.filter((t) => t.endsAtEpochMs <= now).map(finishKey));
      setFinished((e) => (sameSet(e, done) ? e : done));
      const claimStore = claims ?? pageStore();
      const { claim, chimer } = electChimer(
        readClaim(claimStore),
        tab.current,
        document.visibilityState === "visible",
        now,
      );
      if (claim) writeClaim(claimStore, claim);
      if (chimer && chimeDue(list, prev, now)) chime.play();
      setUnlocked(chime.unlocked());
      prev = now;
    };
    tick();
    const interval = setInterval(tick, TICK_MS);
    return () => clearInterval(interval);
  }, [any, chime, claims]);

  // The screen stays awake while a timer exists.
  useEffect(() => {
    if (!any || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;
    const request = async () => {
      try {
        const got = await navigator.wakeLock.request("screen");
        if (disposed) void got.release();
        else sentinel = got;
      } catch (err) {
        console.warn("The screen may sleep while a timer runs:", err);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void request();
    };
    void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
    };
  }, [any]);

  const start = useCallback(
    (spec: TimerStart, options?: { restart?: boolean }) => {
      chime.unlock();
      setStopped((s) => {
        if (!s.has(spec.id)) return s;
        const next = new Set(s);
        next.delete(spec.id);
        return next;
      });
      return store.start(spec, Date.now(), options);
    },
    [store, chime],
  );
  const dismiss = useCallback(
    (id: string) => {
      const rang = timersRef.current.some((t) => t.id === id && t.endsAtEpochMs <= Date.now());
      store.dismiss(id);
      if (rang) setStopped((s) => (s.has(id) ? s : new Set([...s, id])));
    },
    [store],
  );
  const allowSound = useCallback(() => {
    chime.unlock();
    setTimeout(() => setUnlocked(chime.unlocked()), 50);
  }, [chime]);
  const say = useCallback((line: string, options?: { persistent?: boolean }) => {
    setSaid((n) => (n.includes(line) ? n : [...n, line]));
    if (options?.persistent) {
      setPersistent((p) => (p.has(line) ? p : new Set([...p, line])));
    }
  }, []);
  const unsay = useCallback((line: string) => {
    setSaid((n) => (n.includes(line) ? n.filter((l) => l !== line) : n));
    setPersistent((p) => {
      if (!p.has(line)) return p;
      const next = new Set(p);
      next.delete(line);
      return next;
    });
  }, []);
  const noticesShown = useCallback(
    (shown?: readonly string[]) => {
      const tab = session ?? tabStore();
      if (!shown) {
        writeResetLines(tab, []);
        return;
      }
      const waiting = readResetLines(tab);
      const remaining = waiting.filter((l) => !shown.includes(l));
      writeResetLines(tab, remaining);
    },
    [session],
  );
  const clearNotices = useCallback(() => {
    setResets((n) => (n.length === 0 ? n : []));
    setSaid((n) => n.filter((l) => persistent.has(l)));
    writeResetLines(session ?? tabStore(), []);
  }, [session, persistent]);
  const dropCookNotices = useCallback(() => {
    setResets((n) => (n.some(isCookNotice) ? n.filter((l) => !isCookNotice(l)) : n));
    const tab = session ?? tabStore();
    const waiting = readResetLines(tab);
    if (waiting.some(isCookNotice)) writeResetLines(tab, waiting.filter((l) => !isCookNotice(l)));
  }, [session]);
  const notices = useMemo(() => [...resets, ...said.filter((l) => !resets.includes(l))], [resets, said]);

  const value = useMemo<KitchenTimers>(
    () => ({
      timers,
      expired,
      soundLocked: any && !unlocked,
      stopped,
      notices,
      start,
      dismiss,
      allowSound,
      say,
      unsay,
      clearNotices,
      dropCookNotices,
      noticesShown,
    }),
    [timers, expired, any, unlocked, stopped, notices, start, dismiss, allowSound, say, unsay, clearNotices, dropCookNotices, noticesShown],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
