/**
 * How a listen from a tap on the voice dot ends (`voice-mode.ts` `tap`;
 * DECISIONS 2026-10-27 "Tap-to-talk listens through a pause").
 *
 * The listen runs continuously with interim results, so Chrome's own end of
 * an utterance (its first pause, under a second) no longer ends it: a cook
 * who says "The butter is still a little bit cold… should I melt it first"
 * is heard to the end. The hook ends it instead:
 *
 * - at once, on a whole command Chrome has settled (a final result), as a tap
 *   always did, so "next" is no slower than before;
 * - after `COMMAND_QUIET_MS` of quiet, on a whole command Chrome hasn't
 *   settled yet, so "next few" isn't cut to "next" and a recognizer that
 *   settles late (Android's dictation mode) doesn't make commands wait;
 * - after `QUIET_MS` of quiet, on anything else: the question is handed to
 *   Ask, or a short try echoed as before;
 * - after `FIRST_WORDS_MS` with no words at all, as heard nothing;
 * - at `MAX_LISTEN_MS`, taking what it heard as it stands;
 * - when Chrome ends the session itself, taking what it heard;
 * - on a second tap, dropping it (DECISIONS 2026-09-29).
 *
 * Quiet is measured from the last time the words changed, not the last
 * result: a final that only settles words already heard doesn't stretch it.
 *
 * Pure functions: the recognizer and the clocks live in
 * `hooks/useKitchenVoiceCommands.ts`.
 */

import { hearTapped, normalizeUtterance } from "./wake-word";

/** One recognition result of the session, as Chrome lists them. */
export interface HeardResult {
  transcript: string;
  isFinal: boolean;
}

/** What a listen has heard so far, and whether Chrome has settled all of it. */
export interface Heard {
  text: string;
  final: boolean;
}

export const NOTHING_HEARD: Heard = { text: "", final: true };

/**
 * After words that aren't a whole command, the listen ends once nothing new
 * has been heard for this long. Chrome's own pause threshold, which can cut a
 * speaker off mid-sentence, is under a second; a cook thinking aloud
 * across a counter, eyes on a pan, pauses longer than a talker at a desk.
 * Interim results trail speech by a few hundred ms, so the silence the cook
 * actually leaves is a little over this. Long enough for a breath and a look
 * at the pan, short enough that the wait after a question reads as a beat.
 */
export const QUIET_MS = 1800;

/** A whole command Chrome hasn't settled acts after this much quiet: about Chrome's own pause. */
export const COMMAND_QUIET_MS = 700;

/** A listen that has heard no words in this long ends, as heard nothing. */
export const FIRST_WORDS_MS = 8000;

/** No listen from a tap runs past this (about 50 words at a relaxed pace); what it heard stands. */
export const MAX_LISTEN_MS = 20_000;

/**
 * How a listen from a tap ended, for a flag's event log. A command Chrome
 * settled ends it at once and isn't logged here, as its echo says so; an
 * unsettled one ends on its quiet and is logged as `quiet`, beside its echo.
 * `browser` is Chrome ending the session on its own; `aborted` is Chrome
 * aborting a session the app didn't stop. On Android that is most likely a
 * generic recognizer error (Chromium maps `ERROR_CLIENT` to aborted) or the
 * page going hidden (Blink aborts on Android when it does); a busy
 * recognizer, the nearest thing to the mic being taken, is `not-allowed`.
 */
export type ListenEnding =
  | "quiet"
  | "longest"
  | "no words"
  | "browser"
  | "aborted"
  | "cancelled"
  | "held"
  | `error ${string}`;

/**
 * The session's results as one transcript. Where a result carries the one
 * before it whole (Chrome on Android repeats what it heard in each result in
 * continuous mode) or repeats it, only the later one is kept.
 */
export function heardSoFar(results: readonly HeardResult[]): Heard {
  const kept: { text: string; words: string; isFinal: boolean }[] = [];
  for (const result of results) {
    const text = result.transcript.trim();
    const words = normalizeUtterance(text);
    if (!words) continue;
    const last = kept.at(-1);
    if (last && (words === last.words || words.startsWith(`${last.words} `))) {
      kept[kept.length - 1] = { text, words, isFinal: result.isFinal };
    } else {
      kept.push({ text, words, isFinal: result.isFinal });
    }
  }
  return {
    text: kept.map((k) => k.text).join(" "),
    final: kept.every((k) => k.isFinal),
  };
}

/** How long a quiet ends the listen, given what it has heard: 0 is now. */
export function quietToEnd(heard: Heard): number {
  if (hearTapped(heard.text).kind === "command") return heard.final ? 0 : COMMAND_QUIET_MS;
  return QUIET_MS;
}
