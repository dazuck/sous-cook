/**
 * How Sue answers what the cook says (DESIGN_SYSTEM §4, "Sue acknowledges";
 * DECISIONS 2026-11-22). The rules, apart from the browser: which spoken
 * outcome gets which sound, and when a recorded confirmation may be said.
 *
 * - **Sounds** (`sounds` and `voice`): a soft rising sound for a command
 *   understood or a question handed to Ask, a lower falling one for anything
 *   not understood or refused. Never for touch: only the voice hook calls this.
 * - **A spoken confirmation** (`voice` only): after a command whose result
 *   can't be seen from across the kitchen (start or set a timer, flag), and
 *   only a command that was carried out. Never for a question, a mishearing, a
 *   refusal or a touch. At most `SPOKEN_PER_COOK` per cook; about one in
 *   three of them "Yes, chef.", the rest the plain words for the command
 *   ("Flagged.", "Timer's on.", "On it.") or a read-back of a whole common
 *   timer length ("Ten minutes."). A clip is never mixed with the browser's
 *   own voice, and never holds the microphone: it is a buffer started and
 *   left alone.
 * - Where a clip didn't load, the sound alone stands and the console says so.
 *
 * The sound for a command comes at the earliest honest moment: when an
 * interim result already says a whole command (`heardCommand`), ahead of the
 * action and of the quiet that ends the listen.
 */

import { readBackClip, YES_CHEF_TAKES, type ClipName } from "./ack-clips";
import type { AckAudio } from "./ack-audio";
import type { SueReplies } from "./cook-prefs";
import { timerRequestSeconds, type VoiceCommand } from "./wake-word";

/** Spoken confirmations in one cook, however many commands earn one. */
export const SPOKEN_PER_COOK = 3;

/** Of the spoken confirmations, the share that are "Yes, chef." */
export const YES_CHEF_SHARE = 1 / 3;

/** The commands whose result can't be seen across the kitchen. */
export const SPOKEN_COMMANDS: ReadonlySet<VoiceCommand> = new Set(["start-timer", "set-timer", "flag"]);

export interface Acknowledger {
  /** A listen began: nothing has been heard in it yet. */
  listenStarted(): void;
  /** An interim result already says a whole command: the understood sound, now. */
  heardCommand(): void;
  /** A command was carried out. */
  commandDone(command: VoiceCommand, heard: string): void;
  /** A question went to Ask. */
  asked(): void;
  /** Not understood, refused, nothing heard, or trouble listening. */
  notUnderstood(): void;
  /** Start loading the clips (the setting says voice). */
  warm(): void;
  /** A new cook: the count of spoken confirmations starts over. */
  newCook(): void;
}

export interface AcknowledgerDeps {
  audio: AckAudio;
  /** The device's setting, read at each use so a change applies at once. */
  mode: () => SueReplies;
  /** In [0, 1); injected so the one-in-three is deterministic under test. */
  random: () => number;
}

export function createAcknowledger({ audio, mode, random }: AcknowledgerDeps): Acknowledger {
  let spoken = 0;
  /** The understood sound played in this listen, and when it ends. */
  let heardAt: number | null = null;
  let lastTake: ClipName | null = null;
  let startTimers = 0;

  /** The understood sound, once per listen; the time it ends, or null. */
  const understood = (): number | null => {
    if (heardAt !== null) return heardAt;
    heardAt = audio.sound("understood");
    return heardAt;
  };

  const yesChef = (): ClipName => {
    const takes = YES_CHEF_TAKES.filter((take) => take !== lastTake);
    const pick = takes[Math.min(takes.length - 1, Math.floor(random() * takes.length))];
    lastTake = pick;
    return pick;
  };

  /** What this carried-out command says; the draw is made only once a clip can still be said. */
  const confirmation = (command: VoiceCommand, heard: string): ClipName => {
    if (random() < YES_CHEF_SHARE) return yesChef();
    if (command === "flag") return "flagged";
    if (command === "set-timer") {
      const seconds = timerRequestSeconds(heard);
      return (seconds !== null ? readBackClip(seconds) : null) ?? "timer-on";
    }
    // Starting the step's timer: the two plain acknowledgements, taking turns.
    return startTimers++ % 2 === 0 ? "timer-on" : "on-it";
  };

  return {
    listenStarted() {
      heardAt = null;
    },

    heardCommand() {
      if (mode() === "off") return;
      understood();
    },

    commandDone(command, heard) {
      const setting = mode();
      if (setting === "off") {
        heardAt = null;
        return;
      }
      const end = understood();
      heardAt = null;
      if (setting !== "voice" || !SPOKEN_COMMANDS.has(command) || spoken >= SPOKEN_PER_COOK) return;
      // After the sound, not over it.
      if (audio.clip(confirmation(command, heard), end !== null ? end + 0.05 : null)) spoken += 1;
    },

    asked() {
      if (mode() === "off") return;
      understood();
      heardAt = null;
    },

    notUnderstood() {
      heardAt = null;
      if (mode() === "off") return;
      audio.sound("not-understood");
    },

    warm() {
      if (mode() === "voice") void audio.warm();
    },

    newCook() {
      spoken = 0;
      lastTake = null;
      startTimers = 0;
    },
  };
}
