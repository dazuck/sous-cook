"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ARM_WINDOW_MS,
  IDLE,
  hear,
  hearTapped,
  type VoiceCommand,
  type WakeState,
} from "@/lib/kitchen/wake-word";
import { recordListen, recordVoice } from "@/lib/kitchen/report-events";
import {
  FIRST_WORDS_MS,
  MAX_LISTEN_MS,
  NOTHING_HEARD,
  heardSoFar,
  quietToEnd,
  type Heard,
  type ListenEnding,
} from "@/lib/kitchen/tap-listen";
import { voiceModeFor, type VoiceMode } from "@/lib/kitchen/voice-mode";
import { normalizeUtterance } from "@/lib/kitchen/wake-word";
import { useSpeechRecognition } from "./useSpeechRecognition";

/**
 * Where voice stands, as the indicator dot shows it.
 *
 * - `listening`: on and meant to be hearing. It stays so across the brief
 *   gaps while the recognizer restarts, so the dot never flickers.
 * - `paused`: on, but held while Ask has the mic or the page is hidden.
 * - `blocked`: the mic is denied or missing. Nothing retries until a tap.
 * - `stalled`: the recognizer failed too many times in a row. Same.
 *
 * From `blocked` or `stalled` the dot turns voice off, so a kitchen with no
 * mic or no network can silence it; turning it on again starts afresh.
 *
 * Where voice listens only on a tap (`lib/kitchen/voice-mode.ts`):
 *
 * - `ready`: nothing listens until the dot is tapped.
 * - `hearing`: one listen, from a tap, is under way.
 * - `paused` and `blocked` as above; a tap after `blocked` tries again.
 */
export type VoiceStatus =
  | "unsupported"
  | "off"
  | "listening"
  | "paused"
  | "blocked"
  | "stalled"
  | "ready"
  | "hearing";

/** What was last heard, shown beside the dot for a moment. */
export type VoiceEcho =
  | { kind: "armed" }
  | { kind: "command"; command: VoiceCommand; heard: string }
  | { kind: "unknown"; heard: string }
  | { kind: "near-miss"; heard: string }
  /** What a command answered (B5a): "Couldn't set that timer", say. */
  | { kind: "reply"; heard: string; text: string }
  /** From a tap, a question handed to Ask: the words as asked. */
  | { kind: "asked"; text: string }
  /** A listen from a tap ended having heard nothing. */
  | { kind: "silence" }
  /** A listen from a tap failed: no network, or Chrome wouldn't start it. */
  | { kind: "trouble" };

/** How long a heard phrase stays beside the dot. "Sue" alone stays for its window. */
export const ECHO_MS = 1500;

/** The first restart after a session ends, doubled per failure in a row. */
export const RESTART_MS = 250;
export const MAX_RESTART_MS = 5000;
/** Failures in a row before voice stops and waits for a tap. */
export const MAX_FAILURES = 5;
/**
 * A session Chrome ends this soon, having heard nothing and reported no
 * error, counts as a failure: a recognizer that ends at once would otherwise
 * restart every RESTART_MS for as long as the cook view is open.
 */
export const QUICK_END_MS = 1000;

/** Errors no restart can fix: the mic is denied, missing or not allowed. */
const FATAL = new Set(["not-allowed", "audio-capture", "service-not-allowed"]);
/** Endings that are not failures: silence, and our own stop. */
const BENIGN = new Set(["no-speech", "aborted"]);

interface Session {
  failed: boolean;
  heard: boolean;
  /** It has run QUICK_END_MS. */
  settled: boolean;
}

/**
 * The time a tap's listen reads to say how long it ran. Only the
 * recognizer's callbacks, the listen's timers, the hold's effect and a tap
 * call it, never a render; the compiler's purity rule can't see that through
 * the listen's helpers.
 */
const clock = () => Date.now();

/** A session's ending: failed (counted when it failed), quick, or clean. */
function howItEnded(session: Session): "failed" | "quick" | "clean" {
  if (session.failed) return "failed";
  if (!session.heard && !session.settled) return "quick";
  return "clean";
}

export interface UseKitchenVoiceCommandsOptions {
  /** The cook wants voice on. Listening only on a tap, nothing listens untapped, so this is moot. */
  enabled: boolean;
  /** Hold listening, as while Ask has the mic. It also holds while the page is hidden. */
  paused?: boolean;
  /**
   * A command said to Sous, with what was heard. Read through a ref, so it
   * may change every render. A string returned is said back in the echo, in
   * place of the phrase (B5a: "That timer's running"). `false` says the
   * phrase is no command here (B5d: "not yet" off a checkpoint), and it is
   * heard as it would have been without that command: echoed as not caught,
   * or after a tap a question for Ask.
   */
  onCommand: (command: VoiceCommand, heard: string) => string | void | false;
  /**
   * Where voice listens on a tap, anything said that isn't a command and is
   * long enough to ask (`hearTapped`), for Ask. Read through a ref too.
   */
  onQuestion?: (text: string) => void;
}

export interface UseKitchenVoiceCommandsReturn {
  /** How this device listens; null until the page has read it. */
  mode: VoiceMode | null;
  status: VoiceStatus;
  /** The last thing heard, while it is still shown. */
  echo: VoiceEcho | null;
  /** Forget a stop after `blocked` or `stalled`, so voice starts afresh when on. */
  reset: () => void;
  /** Where voice listens on a tap: listen once, or end the listen under way. */
  talk: () => void;
}

/**
 * The cook view's voice. Where it listens all the time: continuous
 * recognition, gated by the wake word (`lib/kitchen/wake-word.ts`), restarted
 * with backoff whenever Chrome ends a session, and stopped for good on a
 * denied mic or a run of failures. Where it listens on a tap (Android, whose
 * every start chimes): one session per `talk()`, for one command or one
 * question for Ask, never restarted. That session is continuous with interim
 * results, so a pause mid-question doesn't end it; the rules in
 * `lib/kitchen/tap-listen.ts` do (DECISIONS 2026-10-27). Each ending is
 * logged for a flag (`recordListen`) but a command Chrome settled, whose echo
 * says it.
 */
export function useKitchenVoiceCommands({
  enabled,
  paused = false,
  onCommand,
  onQuestion,
}: UseKitchenVoiceCommandsOptions): UseKitchenVoiceCommandsReturn {
  const [halted, setHalted] = useState<"blocked" | "stalled" | null>(null);
  const [echo, setEcho] = useState<VoiceEcho | null>(null);
  // Each echo joins the flag's event log (B2) as it shows, before any command
  // it carries acts, so a report reads the voice ahead of the move.
  const show = (shown: VoiceEcho) => {
    recordVoice(shown);
    setEcho(shown);
  };
  const [mode, setMode] = useState<VoiceMode | null>(null);
  const [hearing, setHearing] = useState(false);
  const tap = mode === "tap";

  const wake = useRef<WakeState>(IDLE);
  const failures = useRef(0);
  // The session under way: whether it failed, heard anything, or has run a while.
  const session = useRef<Session>({ failed: false, heard: false, settled: true });
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the recognizer's callbacks read; they fire between renders. `start`
  // is the recognizer's own, set once rendered, before any callback can fire.
  const live = useRef({
    want: false,
    halted: false,
    onCommand,
    onQuestion,
    tap,
    held: false,
    start: () => {},
  });
  // A listen from a tap. `open`: a session is running, from its start to its
  // ending. `taking`: the cook is waiting on it, so a result counts. `queued`:
  // a tap came while the last session was still closing; Chrome can't start
  // another until it ends, so this one starts then, and what the closing
  // session hands over meanwhile is dropped.
  const tapped = useRef({ open: false, taking: false, queued: false });
  // The listen the cook is waiting on: when it began, what it has heard, and
  // the clocks that end it (`lib/kitchen/tap-listen.ts`).
  const listen = useRef<{
    startedAt: number;
    heard: Heard;
    quiet: ReturnType<typeof setTimeout> | null;
    firstWords: ReturnType<typeof setTimeout> | null;
    longest: ReturnType<typeof setTimeout> | null;
  }>({ startedAt: 0, heard: NOTHING_HEARD, quiet: null, firstWords: null, longest: null });

  // The listen's own moves, for `talk` and the hold's effect, which keep one
  // identity across renders; set each render, like `live`.
  const tapActs = useRef({
    openListen: () => {},
    armListen: () => {},
    closeListen: (_ending: ListenEnding | "command") => {},
    stopTaking: () => {},
  });

  const clearRestart = () => {
    if (restartTimer.current !== null) clearTimeout(restartTimer.current);
    restartTimer.current = null;
  };
  const clearSettle = () => {
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = null;
  };

  const { isSupported, startListening, stopListening } = useSpeechRecognition({
    // A tap's listen is continuous too, so Chrome's first pause doesn't end
    // it; its results, interim ones included, come through `onResults`.
    continuous: true,
    interimResults: tap,
    onResults: (results) => {
      const t = tapped.current;
      if (!live.current.tap || !t.taking || t.queued || live.current.held) return;
      const l = listen.current;
      const now = heardSoFar(results);
      if (!now.text) return;
      const changed = normalizeUtterance(now.text) !== normalizeUtterance(l.heard.text);
      const settled = now.final && !l.heard.final;
      l.heard = now;
      if (!changed && !settled) return;
      clearClock("firstWords");
      const quiet = quietToEnd(now);
      if (quiet === 0) {
        finishListen("command");
        return;
      }
      // A final that only settles words already heard leaves the quiet running.
      if (!changed) return;
      clearClock("quiet");
      l.quiet = setTimeout(() => finishListen("quiet"), quiet);
    },
    onFinalTranscript: (transcript) => {
      if (live.current.tap) return;
      failures.current = 0;
      session.current.heard = true;
      if (!live.current.want) return;
      const { state, outcome } = hear(wake.current, transcript, Date.now());
      wake.current = state;
      if (outcome.kind === "ignore") return;
      show(outcome);
      if (outcome.kind === "command") {
        const reply = live.current.onCommand(outcome.command, outcome.heard);
        // No command here: echoed as a try that wasn't caught, as before.
        if (reply === false) show({ kind: "unknown", heard: outcome.heard });
        else if (typeof reply === "string") show({ kind: "reply", heard: outcome.heard, text: reply });
      }
    },
    // Chrome aborted a session we didn't stop (on Android, most likely a
    // recognizer error or the page going hidden). Its ending comes next; this
    // says it wasn't Chrome ending on its own.
    onAborted: () => {
      const t = tapped.current;
      if (!live.current.tap || !t.taking || t.queued) return;
      const words = listen.current.heard.text;
      closeListen("aborted");
      // The words came before the abort: they are what the cook said. With
      // none, nothing is shown, as for any abort before.
      if (words) handOver(words);
    },
    onError: (_message, code) => {
      const t = tapped.current;
      const waitedOn = live.current.tap && t.taking && !t.queued;
      if (FATAL.has(code)) {
        if (waitedOn) closeListen(`error ${code}`);
        live.current.halted = true;
        setHalted("blocked");
        return;
      }
      if (live.current.tap) {
        // No session began, so no ending will come to say the listen is over.
        if (code === "start-failed") {
          t.open = false;
          if (t.taking) closeListen(`error ${code}`);
          stopTaking();
          show({ kind: "trouble" });
          return;
        }
        // A closing session's trouble isn't the cook's: they've moved on.
        if (!waitedOn) return;
        const words = listen.current.heard.text;
        closeListen(`error ${code}`);
        // The words came before the error: they are what the cook said.
        if (words) handOver(words);
        else if (code === "no-speech") show({ kind: "silence" });
        else show({ kind: "trouble" });
        return;
      }
      // An error from a session already stopped for a hold says nothing about the mic.
      if (BENIGN.has(code) || !live.current.want) return;
      session.current.failed = true;
      failures.current += 1;
      if (failures.current >= MAX_FAILURES) {
        live.current.halted = true;
        setHalted("stalled");
      } else if (code === "start-failed") {
        // No session began, so no ending will come to restart it.
        restartLater();
      }
    },
    onEnd: () => {
      if (live.current.tap) {
        const t = tapped.current;
        t.open = false;
        if (t.queued && !live.current.held && !live.current.halted) {
          t.queued = false;
          t.open = true;
          armListen();
          live.current.start();
          return;
        }
        if (t.taking && !t.queued) {
          // Chrome ended the listen itself (its own cap, or an Android
          // session that won't stay open): what it heard is the cook's.
          const words = listen.current.heard.text;
          closeListen("browser");
          if (words) handOver(words);
          else show({ kind: "silence" });
          return;
        }
        stopTaking();
        return;
      }
      if (!live.current.want || live.current.halted) return;
      // A session that ended cleanly clears the count, so failures spread
      // over a long cook never add up; one that ended at once adds to it.
      const ending = howItEnded(session.current);
      if (ending === "clean") failures.current = 0;
      else if (ending === "quick") {
        if (++failures.current >= MAX_FAILURES) {
          live.current.halted = true;
          setHalted("stalled");
          return;
        }
      }
      restartLater();
    },
  });

  function clearClock(which: "quiet" | "firstWords" | "longest") {
    const l = listen.current;
    const timer = l[which];
    if (timer !== null) clearTimeout(timer);
    l[which] = null;
  }

  function stopTaking() {
    clearClock("quiet");
    clearClock("firstWords");
    clearClock("longest");
    tapped.current.taking = false;
    tapped.current.queued = false;
    setHearing(false);
  }

  /**
   * A tap asks for a listen: nothing heard yet. Its time counts from the tap
   * until its session starts (`armListen`), so a listen cancelled while
   * queued says how long the cook waited.
   */
  function openListen() {
    stopTaking();
    const l = listen.current;
    l.startedAt = clock();
    l.heard = NOTHING_HEARD;
  }

  /**
   * The listen's session is starting: from now, one that hears no words, or
   * runs too long, ends on its own. Not at the tap, as a tap queued behind a
   * closing session would spend its clocks waiting.
   */
  function armListen() {
    const l = listen.current;
    clearClock("firstWords");
    clearClock("longest");
    l.startedAt = clock();
    l.firstWords = setTimeout(() => finishListen("no words"), FIRST_WORDS_MS);
    l.longest = setTimeout(() => finishListen("longest"), MAX_LISTEN_MS);
  }

  /** The cook's listen is over; logged unless a command Chrome settled ended it, as its echo says so. */
  function closeListen(ending: ListenEnding | "command") {
    const l = listen.current;
    stopTaking();
    if (ending !== "command") recordListen(ending, l.heard.text !== "", clock() - l.startedAt);
  }

  /** The listen has heard enough (or all it may): Chrome is told to stop, and what it heard counts. */
  function finishListen(ending: "command" | "quiet" | "longest" | "no words") {
    const t = tapped.current;
    if (!t.taking || t.queued) return;
    const words = listen.current.heard.text;
    closeListen(ending);
    stopListening();
    if (words) handOver(words);
    else show({ kind: "silence" });
  }

  /** What a tap's listen heard, as one command or one question for Ask; the next tap listens afresh. */
  function handOver(transcript: string) {
    const outcome = hearTapped(transcript);
    if (outcome.kind === "ignore") {
      show({ kind: "silence" });
      return;
    }
    if (outcome.kind === "question") {
      show({ kind: "asked", text: outcome.text });
      live.current.onQuestion?.(outcome.text);
      return;
    }
    // The echo shows (and joins the flag's log) before the command acts.
    show(outcome);
    if (outcome.kind !== "command") return;
    // A command's own answer takes the echo's place.
    const reply = live.current.onCommand(outcome.command, outcome.heard);
    if (reply === false) {
      const asWords = hearTapped(transcript, false);
      if (asWords.kind === "question") {
        show({ kind: "asked", text: asWords.text });
        live.current.onQuestion?.(asWords.text);
      } else if (asWords.kind !== "ignore") show(asWords);
      return;
    }
    if (typeof reply === "string") show({ kind: "reply", heard: outcome.heard, text: reply });
  }

  function restartLater() {
    clearRestart();
    const delay = Math.min(RESTART_MS * 2 ** failures.current, MAX_RESTART_MS);
    restartTimer.current = setTimeout(() => {
      restartTimer.current = null;
      if (live.current.want && !live.current.halted) begin();
    }, delay);
  }

  const begin = useCallback(() => {
    const current: Session = { failed: false, heard: false, settled: false };
    session.current = current;
    clearSettle();
    settleTimer.current = setTimeout(() => {
      current.settled = true;
    }, QUICK_END_MS);
    startListening();
  }, [startListening]);

  // Chrome may refuse the mic to a page in the background, which would read
  // as a denied mic; so voice holds while the page is hidden.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Read once the page is up: the server can't know the device.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(voiceModeFor(navigator.userAgent, navigator.maxTouchPoints));
  }, []);

  const held = paused || hidden;
  const want = mode === "always" && enabled && !held && isSupported && halted === null;

  useLayoutEffect(() => {
    live.current = {
      want,
      halted: halted !== null,
      onCommand,
      onQuestion,
      tap,
      held,
      start: startListening,
    };
    tapActs.current = { openListen, armListen, closeListen, stopTaking };
  });

  // A hold ends a listen from a tap, and one waiting to start: nothing it
  // hands over counts, even if the hold lifts before it ends.
  useEffect(() => {
    if (!tap || !held) return;
    const acts = tapActs.current;
    if (tapped.current.taking) acts.closeListen("held");
    else acts.stopTaking();
    stopListening();
  }, [tap, held, stopListening]);

  const talk = useCallback(() => {
    const now = live.current;
    const t = tapped.current;
    const { openListen, armListen, closeListen } = tapActs.current;
    if (!now.tap || now.held || !isSupported) return;
    // A second tap cancels: Chrome may still hand over what it heard as it
    // stops, and that is dropped.
    if (t.taking) {
      closeListen("cancelled");
      stopListening();
      return;
    }
    now.halted = false;
    openListen();
    t.taking = true;
    setHalted(null);
    setEcho(null);
    setHearing(true);
    if (t.open) {
      // The last session is still closing: listen once it has ended.
      t.queued = true;
      stopListening();
      return;
    }
    t.open = true;
    armListen();
    startListening();
  }, [isSupported, startListening, stopListening]);

  useEffect(() => {
    if (want) {
      begin();
      return;
    }
    clearRestart();
    wake.current = IDLE;
    stopListening();
  }, [want, begin, stopListening]);

  useEffect(
    () => () => {
      clearRestart();
      clearSettle();
      const l = listen.current;
      for (const timer of [l.quiet, l.firstWords, l.longest]) {
        if (timer !== null) clearTimeout(timer);
      }
    },
    [],
  );

  // The echo fades on its own; "Sue" alone stays for as long as it waits.
  useEffect(() => {
    if (!echo) return;
    const timer = setTimeout(() => setEcho(null), echo.kind === "armed" ? ARM_WINDOW_MS : ECHO_MS);
    return () => clearTimeout(timer);
  }, [echo]);

  const reset = useCallback(() => {
    failures.current = 0;
    setHalted(null);
  }, []);

  let status: VoiceStatus;
  if (!isSupported || mode === null) status = "unsupported";
  else if (tap) {
    // Held first: no tap is taken while held, whatever else is wrong.
    if (held) status = "paused";
    else if (halted) status = halted;
    else status = hearing ? "hearing" : "ready";
  } else if (!enabled) status = "off";
  else if (halted) status = halted;
  else if (held) status = "paused";
  else status = "listening";

  const shown = tap ? !held : want;
  return { mode, status, echo: shown ? echo : null, reset, talk };
}
