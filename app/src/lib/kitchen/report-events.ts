/**
 * The last 50 things that happened in a cook, so a flag carries its own
 * lead-up (B2 decision 9; ported from Player's `eventLog`). A module ring
 * buffer: events are ambient facts, not React state, and a flag reads them
 * from a tap handler. Fed from outside the session reducer, which StrictMode
 * runs twice.
 *
 * What it never holds: Ask's words, voice talk past three words, URL query
 * strings or fragments. The DOM a report carries is another matter (decision
 * 9): it holds the screen as drawn, Ask's panel included.
 */

import type { VoiceEcho } from "@/hooks/useKitchenVoiceCommands";
import type { CookAction } from "./cook-session";
import type { ListenEnding } from "./tap-listen";
import { cutToJsonBytes, jsonBytes } from "./report-capture";
import { MAX_COMMAND_WORDS, wordsToSous } from "./wake-word";

export const REPORT_EVENT_KINDS = [
  "cook",
  "step",
  "layer",
  "voice",
  "ask",
  "error",
  "flag",
] as const;

export type ReportEventKind = (typeof REPORT_EVENT_KINDS)[number];

export interface ReportEvent {
  /** ISO time to the millisecond, so a reader can tell a move just before a flag. */
  at: string;
  kind: ReportEventKind;
  detail: string;
}

export const EVENT_CAPACITY = 50;

/** An event's detail never runs past this; errors are where it bites. */
export const ERROR_DETAIL_MAX = 300;

/** One event's cap as JSON (decision 8), as the server measures it. */
export const EVENT_MAX_BYTES = 1024;

let events: ReportEvent[] = [];

/**
 * The detail is cut to `ERROR_DETAIL_MAX` characters, then to what fits the
 * event in `EVENT_MAX_BYTES` as JSON (fix round 1, LOW-8): 300 control
 * characters escape to 1.8 KB.
 */
export function recordEvent(kind: ReportEventKind, detail: string): void {
  const at = new Date().toISOString();
  const room = EVENT_MAX_BYTES - jsonBytes({ at, kind, detail: "" });
  const cut = cutToJsonBytes(detail.slice(0, ERROR_DETAIL_MAX), room).text;
  events.push({ at, kind, detail: cut });
  if (events.length > EVENT_CAPACITY) events = events.slice(events.length - EVENT_CAPACITY);
}

/** Oldest first, a copy: a report reads the run-up in the order it happened. */
export function recentEvents(): ReportEvent[] {
  return events.slice();
}

export function resetEventLog(): void {
  events = [];
}

/**
 * Drops each URL's query string and fragment, where tokens and ids ride,
 * then cuts to `ERROR_DETAIL_MAX`. A path is anything from a scheme's `//` or
 * a `/` up to the `?` or `#`; the strip runs to the next space, quote or
 * closing bracket.
 */
export function redactError(text: string): string {
  return text
    .replace(/((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s?#]*)[?#][^\s)\]'"]*/gi, "$1")
    .slice(0, ERROR_DETAIL_MAX);
}

/**
 * Window errors and unhandled rejections land in the log too: the flag most
 * worth pressing is the one right after something broke. The error listener
 * rides the capture phase, since resource-load failures (a stale chunk, a
 * missing image) fire at the element and never bubble.
 */
export function installErrorCapture(target: Window = window): () => void {
  const onError = (event: Event) => {
    if (event instanceof ErrorEvent) {
      const location =
        event.filename === "" || event.filename === undefined
          ? ""
          : ` (${redactError(event.filename)}:${String(event.lineno)})`;
      recordEvent("error", redactError(`${redactError(event.message)}${location}`));
      return;
    }
    const el = event.target;
    let source = "resource";
    if (el instanceof Element) {
      const ref = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
      source = ref === "" ? el.tagName.toLowerCase() : ref;
    }
    recordEvent("error", redactError(`failed to load ${source}`));
  };
  const onRejection = (event: Event) => {
    const reason: unknown = (event as PromiseRejectionEvent).reason;
    recordEvent("error", redactError(`unhandled rejection: ${String(reason)}`));
  };
  target.addEventListener("error", onError, true);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError, true);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/** One move of the cook session, with the place it left the cook. */
export function recordStep(action: CookAction, pos: number): void {
  const to = ` → ${String(pos)}`;
  switch (action.type) {
    case "next":
    case "back":
      recordEvent("step", `${action.type}${to}`);
      return;
    case "jump":
      recordEvent("step", `jump${to}`);
      return;
    case "goMark":
      recordEvent("step", `go from the chart${to}`);
      return;
    case "mode":
      recordEvent("step", `mode ${action.mode}${to}`);
      return;
    case "tick":
      recordEvent("step", `tick ${action.id}${to}`);
      return;
    case "offer": {
      const { source } = action;
      const from = source.kind === "derived" ? "derived" : `as-written (${source.reason})`;
      recordEvent("step", `offer ${from}${to}`);
      return;
    }
  }
}

/**
 * What voice heard, as the dot echoes it. An unknown phrase is kept only
 * while it could be a try at a command, at most `MAX_COMMAND_WORDS` past its
 * address; longer is talk, and talk is never logged.
 */
export function recordVoice(echo: VoiceEcho): void {
  switch (echo.kind) {
    case "command":
      recordEvent("voice", `${echo.command} ("${echo.heard}")`);
      return;
    case "unknown":
      if (wordsToSous(echo.heard).length > MAX_COMMAND_WORDS) return;
      recordEvent("voice", `unknown ("${echo.heard}")`);
      return;
    case "near-miss":
      recordEvent("voice", `near-miss ("${echo.heard}")`);
      return;
    case "reply":
      recordEvent("voice", `reply (${echo.text})`);
      return;
    case "armed":
    case "asked":
    case "silence":
    case "trouble":
      recordEvent("voice", echo.kind);
      return;
  }
}

/**
 * How a listen from a tap ended, whether it had heard words, and how long it
 * ran (DECISIONS 2026-10-27): never the words. A flag then shows a question
 * cut short ("browser, words heard, 1.2 s"), and a listen that heard nothing,
 * was cancelled, was held or failed, which leave no echo or one that doesn't
 * say why. Not called for a command Chrome settled (its echo says how its
 * listen ended).
 */
export function recordListen(ending: ListenEnding, heardWords: boolean, ms: number): void {
  const heard = heardWords ? "words heard" : "nothing heard";
  recordEvent("voice", `listen ended: ${ending}, ${heard}, ${(ms / 1000).toFixed(1)} s`);
}

/**
 * That Ask was used and how it went; never the question or the answer. A
 * reply cut at the token cap is its own error, so a flag shows which it was.
 */
export function recordAsk(
  what: "sent" | "answered" | "error" | "error: cut at the token cap",
): void {
  recordEvent("ask", what);
}
