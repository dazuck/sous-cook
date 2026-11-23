"use client";

import { createTRPCClient, httpLink } from "@trpc/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { fetchWithin } from "@/lib/fetch-within";
import { AUTO_FINISH_IDLE_MS, autoFinishDue, lastScreenActivity } from "@/lib/kitchen/auto-finish";
import { recordEvent } from "@/lib/kitchen/report-events";
import type { AppRouter } from "@/server/routers/_app";

/** The three calls the open cook makes, injected so the hook runs without a server. */
export interface CookAutoFinishDeps {
  /**
   * Where the cook sits: how long since its last-screen activity (negative
   * while a timer runs on), or null off the last screen, relative so the
   * server dates it by its own clock; and the cook's last touch on this page,
   * by this page's clock, which orders the reports of every page on the cook.
   */
  report: (
    queueId: string,
    idleForMs: number | null,
    interactedAt: number,
  ) => Promise<{ cooking: boolean; autoFinished: boolean }>;
  /** Finishes the cook, dated `idleForMs` before the server's now: its last activity. */
  finish: (queueId: string, idleForMs: number, interactedAt: number) => Promise<{ autoFinished: boolean }>;
  /** The cook goes on after the app finished it. */
  reopen: (queueId: string) => Promise<{ reopened: boolean }>;
  now: () => number;
}

/**
 * How long one of the page's calls may take before it is given up (and, for
 * a report or reopen, sent again a minute on). Done waits behind them
 * (`inOrder`), so a call that never answers must end.
 */
const CALL_TIMEOUT_MS = 10_000;

let client: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;
function server() {
  client ??= createTRPCClient<AppRouter>({
    links: [httpLink({ url: "/api/trpc", fetch: fetchWithin(CALL_TIMEOUT_MS) })],
  });
  return client;
}

const browserDeps: CookAutoFinishDeps = {
  report: (queueId, idleForMs, interactedAt) =>
    server().markCookActivity.mutate({ queueId, idleForMs, interactedAt }),
  finish: (queueId, idleForMs, interactedAt) => server().autoFinishCook.mutate({ queueId, idleForMs, interactedAt }),
  reopen: (queueId) => server().reopenCook.mutate({ queueId }),
  now: () => Date.now(),
};

function onConnection(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/**
 * Whether the tablet has a connection. Offline the page sends nothing (each
 * call could only fail); it reports and reopens when the connection comes back.
 */
function useOnline(): boolean {
  return useSyncExternalStore(
    onConnection,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * How often the open page checks whether the cook is due, and how long it
 * waits to send again a report or reopen that failed; a sleeping tablet
 * checks again as it wakes.
 */
const CHECK_MS = 60_000;

/** The cook's acts as a call went out: a later look says whether the cook acted meanwhile. */
interface Acts {
  cookKey: string;
  timerIds: readonly string[];
}

const actsOf = ({ cookKey, timerIds }: Acts): Acts => ({ cookKey, timerIds });

/** Whether the cook acted on the cook since `sent`: a step, a tick, the servings, or a timer started. */
function actedSince(sent: Acts, now: Acts): boolean {
  return now.cookKey !== sent.cookKey || now.timerIds.some((id) => !sent.timerIds.includes(id));
}

export interface CookAutoFinishInput {
  /** The queue item cooking; without one (the fixture viewer) nothing runs. */
  queueId: string | undefined;
  /** Whether the cook is on its last screen. */
  onLastScreen: boolean;
  /** When each of this cook's timers ends (or ended), epoch ms. */
  timerEnds: readonly number[];
  /**
   * This cook's timers, by id: one that wasn't there before is a timer
   * started, which reopens a cook the app finished. One leaving (dismissed,
   * or ended) is not the cook acting on the cook.
   */
  timerIds: readonly string[];
  /**
   * Changes whenever the cook acts on the cook itself: a step moved, a line
   * ticked, the servings. That, or a timer started, is what reopens a cook
   * the app finished; opening a menu, reading the info or leaving is not.
   */
  cookKey: string;
  deps?: CookAutoFinishDeps;
}

export interface CookAutoFinish {
  autoFinished: boolean;
  /** A touch, key or voice command: activity, reported at once. */
  touch: () => void;
  /**
   * Runs `call` after every call this page has sent or decided on (a
   * report, the page's finish, a reopen): Done goes this way, so a reopen
   * on its way lands first and Done completes the cook it reopened.
   */
  inOrder: <T>(call: () => Promise<T>) => Promise<T>;
}

/**
 * Auto-finish on the open cook page (cook-fidelity decision 7; the rule is
 * `lib/kitchen/auto-finish.ts`, the server side `lib/kitchen-auto-finish.ts`).
 * Any touch, key or voice command (`touch`) is activity. While open the page
 * finishes the cook itself `AUTO_FINISH_IDLE_MS` after its activity on the
 * last screen, dated to it; a running timer's end counts as activity, so
 * nothing finishes while one runs, and off the last screen nothing does.
 *
 * It tells the server where the cook sits on every act (a touch, a step, a
 * tick, a timer), so the server can finish the cook when the page is gone,
 * and nothing done here goes unsaid there: the server's merge of every
 * page's reports only moves toward "still cooking" (`reportLastScreen`).
 * Nothing is said until the cook acts on this page, by a touch, key or voice
 * command or by arriving on the last screen: opening a cook writes nothing here (the plan derive on open, `ensureCookPlan`, is apart).
 *
 * Every call the page makes goes one at a time, in the order decided
 * (`inOrder`): a report, its finish, a reopen, and Done after them. Once
 * finished, the cook acting again (`cookKey`, a timer started) reopens it;
 * so does an answer saying the cook was finished elsewhere, if the cook has
 * acted since the server last answered "cooking". Done after a finish, with
 * no act, changes nothing: the cook is already finished.
 */
export function useCookAutoFinish({
  queueId,
  onLastScreen,
  timerEnds,
  timerIds,
  cookKey,
  deps = browserDeps,
}: CookAutoFinishInput): CookAutoFinish {
  const [autoFinished, setAutoFinishedState] = useState(false);
  // Whether the server holds the cook as cooking, from the last report: only
  // then does the page try to finish it (a cook opened but never started
  // stays pending, and Done is its only finish).
  const [serverCooking, setServerCooking] = useState(false);
  const online = useOnline();

  const latest = useRef({ deps, queueId, online, onLastScreen, timerEnds, timerIds, cookKey });
  useLayoutEffect(() => {
    latest.current = { deps, queueId, online, onLastScreen, timerEnds, timerIds, cookKey };
  });

  // Read inside calls already queued, so kept beside the state.
  const finished = useRef(false);
  const setAutoFinished = useCallback((value: boolean) => {
    finished.current = value;
    setAutoFinishedState(value);
  }, []);

  // The exact last interaction; opening the cook counts as the first.
  const [openedAt] = useState(() => deps.now());
  const lastInteraction = useRef(openedAt);
  // Whether the page may speak for the cook (see above).
  const armed = useRef(false);
  // The cook's acts as of the last report the server answered "cooking" (or
  // a reopen it answered): acts since then may have come after a finish.
  const answered = useRef<Acts>({ cookKey, timerIds });

  // The cook's last-screen activity as the server holds it from this page:
  // the latest this page has seen since it came to the last screen, never
  // lowered (a timer dismissed early keeps its end), as the server merges a
  // page's reports (`reportLastScreen`); off the last screen, none. So the
  // page's finish is due when the server's would be, and dated where the
  // server accepts it.
  const held = useRef<number | null>(null);
  const activeAt = useCallback((): number | null => {
    const { onLastScreen: last, timerEnds: ends } = latest.current;
    const now = lastScreenActivity({ onLastScreen: last, lastInteraction: lastInteraction.current, timerEnds: ends });
    held.current = now === null ? null : Math.max(now, held.current ?? now);
    return held.current;
  }, []);

  // The page's calls, one at a time in the order decided.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inOrder = useCallback(<T,>(call: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(call);
    queue.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  // A retry a minute on, of a report or a reopen that failed; one of each at a time.
  const retries = useRef<{ report: ReturnType<typeof setTimeout> | null; reopen: ReturnType<typeof setTimeout> | null }>(
    { report: null, reopen: null },
  );
  useEffect(
    () => () => {
      if (retries.current.report !== null) clearTimeout(retries.current.report);
      if (retries.current.reopen !== null) clearTimeout(retries.current.reopen);
    },
    [],
  );

  // A reopen decided but not landed (offline, or failed): sent when it can be.
  const reopenOwed = useRef(false);
  // A report owed for the same reasons.
  const reportOwed = useRef(false);
  // A report queued and not yet sent: it reads where the cook sits as it
  // goes, so a second request meanwhile adds nothing.
  const reportQueued = useRef(false);

  // The calls refer to each other; each reads the latest through refs.
  const calls = useRef({
    requestReport: () => {},
    reopen: async (): Promise<void> => {},
  });

  const reopen = async (): Promise<void> => {
    const { deps: d, queueId: id, online: isOnline } = latest.current;
    if (id === undefined || !finished.current) {
      reopenOwed.current = false;
      return;
    }
    if (!isOnline) {
      reopenOwed.current = true;
      return;
    }
    recordEvent("cook", "reopen after finish (not pressed)");
    try {
      const { reopened } = await d.reopen(id);
      reopenOwed.current = false;
      // The acts are answered for either way: reopened, or past the window.
      answered.current = actsOf(latest.current);
      if (!reopened) return;
      setAutoFinished(false);
      // Where the reopened cook sits, at once: the reopen left it unsaid.
      calls.current.requestReport();
    } catch (error) {
      console.error("Couldn't reopen the cook; it is tried again in a minute:", error);
      reopenOwed.current = true;
      if (retries.current.reopen === null) {
        retries.current.reopen = setTimeout(() => {
          retries.current.reopen = null;
          void inOrder(calls.current.reopen);
        }, CHECK_MS);
      }
    }
  };

  const sendReport = async (): Promise<void> => {
    reportQueued.current = false;
    const { deps: d, queueId: id, online: isOnline } = latest.current;
    if (id === undefined) return;
    if (!isOnline) {
      reportOwed.current = true;
      return;
    }
    const at = activeAt();
    const now = d.now();
    const sent = actsOf(latest.current);
    try {
      const { cooking, autoFinished: done } = await d.report(id, at === null ? null : now - at, lastInteraction.current);
      reportOwed.current = false;
      setServerCooking(cooking);
      if (cooking) {
        answered.current = sent;
        // Reopened on another page.
        if (finished.current) setAutoFinished(false);
        return;
      }
      if (!done) return;
      setAutoFinished(true);
      // Finished elsewhere, and the cook has acted since the server last held
      // it cooking (this report may be that act's own): it goes on. A reopen
      // already owed (queued behind this report, or waiting on its retry)
      // is that reopen: it isn't sent twice.
      if (!reopenOwed.current && actedSince(answered.current, latest.current)) await reopen();
    } catch (error) {
      console.warn("Couldn't report where the cook sits; it is sent again in a minute:", error);
      reportOwed.current = true;
      if (retries.current.report === null) {
        retries.current.report = setTimeout(() => {
          retries.current.report = null;
          calls.current.requestReport();
        }, CHECK_MS);
      }
    }
  };

  const requestReport = () => {
    if (!armed.current || latest.current.queueId === undefined || reportQueued.current) return;
    reportQueued.current = true;
    void inOrder(sendReport);
  };

  useLayoutEffect(() => {
    calls.current = { requestReport, reopen };
  });

  const touch = useCallback(() => {
    lastInteraction.current = latest.current.deps.now();
    armed.current = true;
    calls.current.requestReport();
  }, []);

  useEffect(() => {
    if (queueId === undefined) return;
    const onInput = () => touch();
    document.addEventListener("pointerdown", onInput, true);
    document.addEventListener("keydown", onInput, true);
    return () => {
      document.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("keydown", onInput, true);
    };
  }, [queueId, touch]);

  // The cook acting on a cook the app finished: it goes on. Queued now, so
  // it lands before anything decided after it (Done above all).
  const timersKey = timerIds.join(",");
  const actsWere = useRef<Acts>({ cookKey, timerIds });
  useEffect(() => {
    const now: Acts = { cookKey, timerIds: timersKey === "" ? [] : timersKey.split(",") };
    const acted = actedSince(actsWere.current, now);
    actsWere.current = now;
    if (acted && finished.current && queueId !== undefined) {
      reopenOwed.current = true;
      void inOrder(calls.current.reopen);
    }
  }, [cookKey, timersKey, queueId, inOrder]);

  // Arriving on the last screen arms the page, as a touch does.
  const lastScreenWas = useRef(onLastScreen);
  useEffect(() => {
    if (onLastScreen && !lastScreenWas.current) armed.current = true;
    if (!onLastScreen) held.current = null;
    lastScreenWas.current = onLastScreen;
  }, [onLastScreen]);

  // Reports where the cook sits on every change of it: the screen, a timer,
  // a step or tick (a touch reports by itself). Once armed.
  const timerKey = timerEnds.join(",");
  useEffect(() => {
    calls.current.requestReport();
  }, [queueId, onLastScreen, timerKey, cookKey]);

  // The connection back: what is owed goes, in order.
  useEffect(() => {
    if (!online) return;
    if (reopenOwed.current) void inOrder(calls.current.reopen);
    if (reportOwed.current) calls.current.requestReport();
  }, [online, inOrder]);

  // Finishes the cook once it is due: checked each minute and as the tablet
  // wakes, never by one long timer a sleeping tablet would hold back.
  const finishing = useRef(false);
  useEffect(() => {
    if (queueId === undefined || !online || !onLastScreen || autoFinished || !serverCooking) return;
    const due = (): boolean => {
      const due = autoFinishDue(activeAt());
      return due !== null && latest.current.deps.now() >= due && !finished.current;
    };
    const check = () => {
      if (!due() || finishing.current) return;
      finishing.current = true;
      void inOrder(async () => {
        try {
          // Read again as it goes: an act queued before it may have moved it.
          const at = activeAt();
          if (at === null || !due()) return;
          const d = latest.current.deps;
          const sent = actsOf(latest.current);
          const { autoFinished: done } = await d.finish(queueId, d.now() - at, lastInteraction.current);
          if (!done) return;
          recordEvent("cook", "finish (not pressed)");
          setAutoFinished(true);
          // The cook acted while the finish was on its way: it goes on.
          if (actedSince(sent, latest.current)) await calls.current.reopen();
        } catch (error) {
          console.error("Couldn't finish the idle cook; it is tried again on the next check:", error);
        } finally {
          finishing.current = false;
        }
      });
    };
    check();
    const timer = setInterval(check, Math.min(CHECK_MS, AUTO_FINISH_IDLE_MS));
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [queueId, online, onLastScreen, autoFinished, serverCooking, activeAt, inOrder, setAutoFinished]);

  return { autoFinished, touch, inOrder };
}
