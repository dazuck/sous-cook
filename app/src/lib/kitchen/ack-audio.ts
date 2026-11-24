/**
 * What Sue sounds like, through WebAudio on the page's shared context
 * (`audio-context.ts`): two short synthesized sounds, and the recorded
 * confirmation clips (`ack-clips.ts`), decoded once into buffers.
 *
 * - **Understood**: two soft rising notes, C5 then G5, a little over a third of
 *   a second. Lower, quieter and shorter than the timer's chime (A5, D6, 0.4
 *   gain, 0.6 s), so the two are never mistaken for each other.
 * - **Not understood**: two lower, falling notes, G4 then D4, a triangle wave
 *   (its overtones carry on a small speaker where a sine's low note doesn't).
 *
 * Nothing here speaks through the browser's own voice, and nothing holds the
 * microphone: a sound is a few oscillators and a clip a buffer source, both
 * started and forgotten.
 *
 * A sound that can't sound says so once on the console (a locked context, no
 * WebAudio, a clip that didn't load or decode) and reports false, so the
 * caller knows; it never throws into a cook's command.
 */

import { CLIP_NAMES, clipUrl, type ClipName } from "./ack-clips";
import { sharedAudioContext } from "./audio-context";

export type AckSound = "understood" | "not-understood";

export type AckAudioContext = Pick<
  AudioContext,
  | "state"
  | "resume"
  | "currentTime"
  | "createOscillator"
  | "createGain"
  | "createBufferSource"
  | "decodeAudioData"
  | "destination"
>;

export interface AckAudio {
  /** Sound it; the context time it ends, or null when it didn't sound. */
  sound(kind: AckSound): number | null;
  /** Play a clip, not before context time `notBefore`; false when it didn't sound. */
  clip(name: ClipName, notBefore?: number | null): boolean;
  /** Fetch and decode every clip not yet loaded. Safe to call again. */
  warm(): Promise<void>;
}

export interface AckAudioOptions {
  context?: () => AckAudioContext | null;
  /** Where a clip's bytes come from; the page's fetch by default (the service worker keeps them). */
  fetchClip?: (url: string) => Promise<ArrayBuffer>;
  /**
   * Where a problem is said. The console by default: a warning for the state
   * a page is in before its first tap (nothing is wrong), an error for a
   * clip that is missing or won't decode (something is).
   */
  report?: (level: "warn" | "error", message: string, detail?: unknown) => void;
}

/** [seconds after the start, frequency, length] of each note. */
const NOTES: Record<AckSound, { type: OscillatorType; peak: number; notes: readonly (readonly [number, number, number])[] }> = {
  understood: { type: "sine", peak: 0.14, notes: [[0, 523.25, 0.22], [0.11, 783.99, 0.26]] },
  "not-understood": { type: "triangle", peak: 0.18, notes: [[0, 392, 0.2], [0.13, 293.66, 0.3]] },
};

/** Just after "now", so the scheduler has the start in hand and it never lands in the past. */
const LEAD_S = 0.01;

async function defaultFetchClip(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.arrayBuffer();
}

export function createAckAudio({
  context = sharedAudioContext,
  fetchClip = defaultFetchClip,
  report = (level, message, detail) => console[level](message, detail ?? ""),
}: AckAudioOptions = {}): AckAudio {
  const buffers = new Map<string, AudioBuffer>();
  const said = new Set<string>();
  let loading: Promise<void> | null = null;

  /** Said once per cause, so a missing file doesn't flood the console on every command. */
  const sayOnce = (level: "warn" | "error", key: string, message: string, detail?: unknown) => {
    if (said.has(key)) return;
    said.add(key);
    report(level, message, detail);
  };

  /** The context when it can sound now; else say why, once, and nudge it awake for the next time. */
  const running = (): AckAudioContext | null => {
    const ctx = context();
    if (!ctx) {
      sayOnce("warn", "no-audio", "Sue's sounds are off: this browser has no WebAudio.");
      return null;
    }
    if (ctx.state !== "running") {
      // `resume()` only succeeds once the page has had a tap; trying is free.
      void ctx.resume().catch(() => undefined);
      sayOnce("warn", "locked", "Sue's sounds wait for a tap on the page: the audio context is locked.");
      return null;
    }
    return ctx;
  };

  const load = async () => {
    const ctx = context();
    if (!ctx) {
      sayOnce("warn", "no-audio", "Sue's clips can't load: this browser has no WebAudio.");
      return;
    }
    await Promise.all(
      CLIP_NAMES.filter((name) => !buffers.has(name)).map(async (name) => {
        try {
          const bytes = await fetchClip(clipUrl(name));
          buffers.set(name, await ctx.decodeAudioData(bytes));
        } catch (err) {
          sayOnce("error", `load:${name}`, `Sue's clip "${name}" didn't load; her sound stands alone for it.`, err);
        }
      }),
    );
  };

  return {
    sound(kind) {
      const ctx = running();
      if (!ctx) return null;
      const { type, peak, notes } = NOTES[kind];
      const now = ctx.currentTime + LEAD_S;
      let end = now;
      for (const [offset, frequency, length] of notes) {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = type;
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(peak, now + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + length);
        oscillator.connect(gain).connect(ctx.destination);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + length + 0.05);
        end = Math.max(end, now + offset + length);
      }
      return end;
    },

    clip(name, notBefore = null) {
      const buffer = buffers.get(name);
      if (!buffer) {
        sayOnce("error", `missing:${name}`, `Sue's clip "${name}" isn't loaded; her sound stands alone.`);
        return false;
      }
      const ctx = running();
      if (!ctx) return false;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(Math.max(ctx.currentTime + LEAD_S, notBefore ?? 0));
      return true;
    },

    warm() {
      loading ??= load().finally(() => {
        loading = null;
      });
      return loading;
    },
  };
}
