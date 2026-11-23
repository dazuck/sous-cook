/**
 * The timer's chime: two rising tones made with WebAudio, so it works offline
 * with nothing to cache (slice B5a, ported from the Player's `lib/chime.ts`).
 *
 * Browsers only start audio from a user gesture. Until `unlock()` has run
 * inside one, `play()` reports false and the alarm stays on screen alone; the
 * kitchen says "Sound off. Tap to allow" while a timer runs and sound is
 * still locked (B1 reading 4), so a locked context is never silent without
 * saying so.
 */

export interface Chime {
  /** Call from a user gesture. Safe to call repeatedly. */
  unlock: () => void;
  /** True when a chime would sound now. */
  unlocked: () => boolean;
  /** True if the chime sounded; false means the alarm is visual only. */
  play: () => boolean;
}

type AudioContextLike = Pick<
  AudioContext,
  "state" | "resume" | "currentTime" | "createOscillator" | "createGain" | "destination"
>;

export function createChime(
  makeContext: () => AudioContextLike | null = () =>
    typeof AudioContext === "undefined" ? null : new AudioContext(),
): Chime {
  let context: AudioContextLike | null = null;
  return {
    unlock: () => {
      context ??= makeContext();
      if (context?.state === "suspended") void context.resume();
    },
    unlocked: () => context?.state === "running",
    play: () => {
      if (context?.state !== "running") return false;
      const now = context.currentTime;
      // A5 then D6: bright enough for a kitchen, short enough not to be an
      // alarm clock.
      for (const [offset, frequency] of [
        [0, 880],
        [0.18, 1174.66],
      ] as const) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.4, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.6);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + 0.65);
      }
      return true;
    },
  };
}

/** The page's one chime. */
export const chime = createChime();
