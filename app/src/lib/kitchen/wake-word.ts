/**
 * The cook view's voice grammar, behind the wake word "Sous" (said "Sue").
 *
 * The cook view listens all the time, so it acts only on speech addressed to
 * it (DECISIONS 2026-09-28): "Sue, next" in one breath, or "Sue" alone, which
 * opens a short window for one bare command. Anything else in the kitchen —
 * including "next" or "done" said to someone else — is ignored.
 *
 * The wake word must open the utterance ("hey" or "okay" may come first), and
 * a command must be the whole of what follows it: "Sue, next time use less
 * salt" does nothing, and neither does "we should call Sue next", as Sue is
 * also a name. What Chrome heard comes back with each outcome, so the screen
 * can echo it and a transcription the wake list misses shows up rather than
 * failing silently.
 *
 * Where the cook view listens only on a tap (`voice-mode.ts`), the tap is the
 * address, so `hearTapped` takes a bare command.
 *
 * Pure functions: the recognizer and the clock live in the hook.
 */

import { durationsIn } from "./cook-plan";
import { howMuchRequest, type HowMuchRequest } from "./how-much";

export type VoiceCommand =
  | "next"
  | "back"
  | "next-few"
  | "how-much-more"
  | "whole-recipe"
  | "done"
  | "close"
  /** Report the screen as it is (B2): captures, closes nothing. */
  | "flag"
  /** Start the step in hand's timer (B5a, A12); a no-op while it runs. */
  | "start-timer"
  /** Start a kitchen timer for the time said (`timerRequestSeconds`). */
  | "set-timer"
  /** Silence and dismiss the timer that finished first. */
  | "dismiss-timer"
  /** On a checkpoint, show what to look for (slice B5d, D8). */
  | "not-yet"
  /** An amount question, "how much flour", read by `howMuchRequest` (slice B5d, D11). */
  | "how-much";

/**
 * How Chrome writes "Sous", said "Sue". Add a spelling only after seeing it
 * echoed on the tablet, and never a common word ("so", "zoo").
 */
export const WAKE_WORDS: readonly string[] = ["sous", "sue", "soo", "su", "sioux", "sou"];

/** Words said before the wake word that still leave it opening the utterance. */
const LEAD_INS: readonly string[] = ["hey", "hi", "ok", "okay"];

/**
 * Words Chrome might write for "Sue" that the wake list leaves out, as they
 * are words in their own right. A command after one is echoed, never acted on,
 * so the cook learns to start with "Sue" and a missed spelling shows. Only
 * words unlikely to open kitchen talk: never "so", "sure" or "see".
 */
const NEAR_WAKE: readonly string[] = ["shoe", "shoo", "zoo", "zu", "sew"];

/** How long "Sue" alone waits for its command. */
export const ARM_WINDOW_MS = 6000;

/** Past this many words, an unmatched phrase is conversation, not a try at a command. */
export const MAX_COMMAND_WORDS = 3;

const COMMANDS: Record<VoiceCommand, RegExp[]> = {
  next: [
    /^next$/,
    /^next step$/,
    /^go next$/,
    /^continue$/,
    /^forward$/,
    /^move forward$/,
    /^advance$/,
    /^done with this$/,
  ],
  "next-few": [
    /^what'?s next$/,
    /^next few$/,
  ],
  // The chart (slice N2, N2-9): the id stays N's, the phrases follow the depth.
  "how-much-more": [
    /^how much more$/,
    /^(show )?(the )?whole cook$/,
    /^(show )?the plan$/,
    /^(show )?the map$/,
    /^overview$/,
    /^show overview$/,
    /^show all$/,
  ],
  // The column of ingredients and steps as written (N2-9).
  "whole-recipe": [
    /^(show )?(the )?whole recipe$/,
    /^ingredients$/,
    /^what ingredients$/,
    /^show (?:me )?ingredients$/,
    /^what do i need$/,
    /^what'?s in this$/,
    /^shopping list$/,
    /^all steps$/,
    /^show all steps$/,
    /^step list$/,
  ],
  back: [
    /^back$/,
    /^go back$/,
    /^previous$/,
    /^previous step$/,
    /^backward$/,
    /^move back$/,
    /^last step$/,
    /^undo$/,
  ],
  done: [
    /^done$/,
    /^finish$/,
    /^finished$/,
    /^complete$/,
    /^completed$/,
    /^all done$/,
    /^i'?m done$/,
    /^that'?s it$/,
    /^end$/,
  ],
  close: [
    /^close$/,
    /^close (it|that|this)$/,
    /^back to cooking$/,
    /^never ?mind$/,
    /^hide( it| that| this)?$/,
  ],
  flag: [/^flag( it| that| this)?$/],
  // Before set-timer, so "start the timer" is the step's and not a time.
  "start-timer": [/^timer$/, /^start (?:a |the )?timer$/],
  "set-timer": [
    /^(?:(?:set|start) )?(?:a |an |the )?timer for .+$/,
    /^(?:(?:set|start) )?(?:a |an )?.+ (?:second|minute|hour)s? timer$/,
  ],
  "dismiss-timer": [
    /^stop$/,
    /^stop (?:it|that|the timer|the alarm|timer|alarm)$/,
    /^dismiss(?: it| that| the timer| the alarm)?$/,
    /^(?:timer|alarm) off$/,
  ],
  "not-yet": [/^not yet$/, /^not quite$/],
  // Read by `howMuchRequest` in `parseCommand`, after every pattern here, so
  // N's anchored "how much more" is the level's and never an amount (N11).
  "how-much": [],
};

/** Lowercase words and apostrophes only, single-spaced. */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    // A number broken by a doubled point or an ellipsis ("1..5", "1…5") is
    // neither 1.5 nor 5: it is dropped, so a said timer sets nothing rather
    // than the wrong length (B5a, re-verify of 4bbf470).
    .replace(/\d+(?:\.{2,}|…)\d+/g, " ")
    // A decimal point before a digit (not after a letter, nor ending an
    // ellipsis) and a fraction's slash between digits are part of the number
    // ("1.5 hours", ".5 hours", "1/2"), so a said timer is read whole (B5a).
    .replace(/[^\p{L}\p{N}'./]+|(?<!\d)\/|\/(?!\d)|\.(?!\d)|(?<=[\p{L}.])\./gu, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The command a whole normalized phrase names, or null. */
export function parseCommand(phrase: string): VoiceCommand | null {
  for (const [command, patterns] of Object.entries(COMMANDS)) {
    if (patterns.some((pattern) => pattern.test(phrase))) return command as VoiceCommand;
  }
  if (howMuchRequest(phrase) !== null) return "how-much";
  return null;
}

export interface WakeState {
  /** When the window "Sue" alone opened closes; null when none is open. */
  armedUntil: number | null;
}

export const IDLE: WakeState = { armedUntil: null };

export type Hearing =
  /** Not addressed to Sous, or nothing to act on. */
  | { kind: "ignore" }
  /** "Sue" alone: the window is open. */
  | { kind: "armed" }
  | { kind: "command"; command: VoiceCommand; heard: string }
  /** Addressed to Sous, but not a command. */
  | { kind: "unknown"; heard: string }
  /** A command after a word Chrome may have written for "Sue": shown, never acted on. */
  | { kind: "near-miss"; heard: string };

/**
 * Where the words addressed to Sous start, when the utterance opens with the
 * wake word, or null. "Sous chef" counts as the wake word.
 */
function afterWake(words: string[]): number | null {
  const at = LEAD_INS.includes(words[0]) ? 1 : 0;
  if (!WAKE_WORDS.includes(words[at])) return null;
  return words[at + 1] === "chef" ? at + 2 : at + 1;
}

/** What one final transcript means, given the window state at `now`. */
export function hear(
  state: WakeState,
  transcript: string,
  now: number,
): { state: WakeState; outcome: Hearing } {
  const heard = normalizeUtterance(transcript);
  const words = heard ? heard.split(" ") : [];
  const armed = state.armedUntil !== null && now <= state.armedUntil;
  const keep = { state: armed ? state : IDLE };
  if (words.length === 0) return { ...keep, outcome: { kind: "ignore" } };

  const start = afterWake(words);
  if (start !== null) {
    const rest = words.slice(start);
    if (rest.length === 0) {
      return { state: { armedUntil: now + ARM_WINDOW_MS }, outcome: { kind: "armed" } };
    }
    const command = parseCommand(rest.join(" "));
    if (command) return { state: IDLE, outcome: { kind: "command", command, heard } };
    // "Sue, flip it" is a try at a command; "Sue said the dal needs salt" is talk.
    if (rest.length <= MAX_COMMAND_WORDS) {
      return { state: IDLE, outcome: { kind: "unknown", heard } };
    }
    return { ...keep, outcome: { kind: "ignore" } };
  }

  if (armed) {
    const command = parseCommand(heard);
    if (command) return { state: IDLE, outcome: { kind: "command", command, heard } };
    if (words.length <= MAX_COMMAND_WORDS) {
      return { state: IDLE, outcome: { kind: "unknown", heard } };
    }
    return { state, outcome: { kind: "ignore" } };
  }

  if (NEAR_WAKE.includes(words[0]) && parseCommand(words.slice(1).join(" "))) {
    return { state: IDLE, outcome: { kind: "near-miss", heard } };
  }
  return { state: IDLE, outcome: { kind: "ignore" } };
}

/**
 * Fewer words than this, not a command, are too little to ask about: "salt"
 * alone is echoed, "how much salt" is asked. A guess (DECISIONS 2026-10-02),
 * to retune against what the tablet actually hears.
 */
export const MIN_QUESTION_WORDS = 2;

/** What a tap on the dot hears: a command, or, from the same tap, a question for Ask. */
export type TappedHearing =
  | Hearing
  /** Words for Ask, as Chrome wrote them, with "Sue" and the like taken off the front. */
  | { kind: "question"; text: string; heard: string };

/**
 * What one final transcript means after a tap on the dot: the tap said it was
 * for Sous, so a bare command counts, and "Sue" (or a word Chrome may have
 * written for it) before one is let be. Anything else of MIN_QUESTION_WORDS
 * or more is a question for Ask (DECISIONS 2026-10-02): one place to talk to
 * Sous, whatever is said. Shorter is echoed, never ignored, as the cook asked
 * to be heard.
 */
export function hearTapped(transcript: string, commands = true): TappedHearing {
  const heard = normalizeUtterance(transcript);
  if (!heard) return { kind: "ignore" };
  const toSous = wordsToSous(heard);
  const command = commands ? (parseCommand(heard) ?? parseCommand(toSous.join(" "))) : null;
  if (command) return { kind: "command", command, heard };
  if (toSous.length >= MIN_QUESTION_WORDS) {
    const droppedCount = heard.split(" ").length - toSous.length;
    return { kind: "question", text: dropWords(transcript, droppedCount), heard };
  }
  return { kind: "unknown", heard };
}

/**
 * The words of a normalized phrase past its address: a lead-in, the wake word
 * (or a word Chrome may have written for it) and "chef". A phrase with no
 * address is all words to Sous, as after a tap.
 */
export function wordsToSous(heard: string): string[] {
  const words = heard ? heard.split(" ") : [];
  const lead = LEAD_INS.includes(words[0]) ? 1 : 0;
  const wake = WAKE_WORDS.includes(words[lead]) || NEAR_WAKE.includes(words[lead]);
  const start = wake ? (words[lead + 1] === "chef" ? lead + 2 : lead + 1) : 0;
  return words.slice(start);
}

/**
 * The seconds a "set a timer" phrase asks for ("Sue, set a timer for 5
 * minutes" is 300, "twenty minute timer" 1200, "an hour and a half" 5400),
 * read as a step's durations are (`durationsIn`); null when it names no time.
 * The range (10 s to 12 h) is the caller's to check.
 */
export function timerRequestSeconds(heard: string): number | null {
  const words = wordsToSous(normalizeUtterance(heard)).join(" ");
  const first = durationsIn(words)[0];
  return first === undefined ? null : Math.round(first.minutes * 60);
}

/**
 * The amount question a heard "how much" command asks (slice B5d, D11), read
 * from what was heard, as `timerRequestSeconds` reads a timer's length.
 */
export function howMuchHeard(heard: string): HowMuchRequest | null {
  return howMuchRequest(wordsToSous(normalizeUtterance(heard)).join(" "));
}

/**
 * The transcript as Chrome wrote it, less its first `count` words (as
 * `normalizeUtterance` counts them) and the punctuation after them, with its
 * first letter raised: "Sue, how much salt?" asks "How much salt?".
 */
function dropWords(transcript: string, count: number): string {
  const tokens = transcript.trim().split(/\s+/);
  let dropped = 0;
  let at = 0;
  while (at < tokens.length && dropped < count) {
    const said = normalizeUtterance(tokens[at]);
    dropped += said ? said.split(" ").length : 0;
    at += 1;
  }
  const rest = tokens.slice(at).join(" ").replace(/^[^\p{L}\p{N}]+/u, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

