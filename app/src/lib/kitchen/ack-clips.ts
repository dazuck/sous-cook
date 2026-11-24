/**
 * Sue's recorded confirmations: the fixed set of short clips a spoken
 * confirmation is chosen from (DESIGN_SYSTEM §4, "Sue acknowledges"). The
 * words, the file names and the timer lengths that have a read-back all live
 * here, so the generator (`scripts/generate-sue-clips.ts`), the player and
 * the tests read one list.
 *
 * The files are generated speech, one voice and one style for all of them
 * (the generator records which), served from `public/sounds/sue/`. This
 * repository ships without them (`docs/voice-replies.md`).
 */

export const SUE_CLIP_DIR = "/sounds/sue";

/**
 * Whether this build carries every clip, decided once at build time from the
 * files themselves (`ack-clips-build.ts`, called by `next.config.ts`). Without
 * them "Sounds and voice" isn't offered, a stored choice of it reads as
 * Sounds, and neither the page nor the service worker asks for a clip.
 */
export function sueClipsShipped(): boolean {
  // Written out whole: the build replaces exactly this expression.
  return process.env.SOUS_SUE_CLIPS === "1";
}

/** "Yes, chef." in takes that differ in pace, so a cook who hears it twice doesn't hear a loop. */
export const YES_CHEF_TAKES = ["yes-chef-1", "yes-chef-2", "yes-chef-3"] as const;

/** Whole timer lengths (seconds) that have their own read-back clip. */
export const READ_BACKS = {
  60: { name: "read-1-minute", text: "One minute." },
  120: { name: "read-2-minutes", text: "Two minutes." },
  180: { name: "read-3-minutes", text: "Three minutes." },
  300: { name: "read-5-minutes", text: "Five minutes." },
  600: { name: "read-10-minutes", text: "Ten minutes." },
  900: { name: "read-15-minutes", text: "Fifteen minutes." },
  1200: { name: "read-20-minutes", text: "Twenty minutes." },
  1500: { name: "read-25-minutes", text: "Twenty five minutes." },
  1800: { name: "read-30-minutes", text: "Thirty minutes." },
  2700: { name: "read-45-minutes", text: "Forty five minutes." },
  3600: { name: "read-1-hour", text: "One hour." },
} as const;

/**
 * Every clip: its file name (without extension) and what it says. The three
 * takes of "Yes, chef." are chosen from more by the generator, so the text
 * here is what each one says.
 */
export const CLIP_TEXT: Record<string, string> = {
  "yes-chef-1": "Yes, chef.",
  "yes-chef-2": "Yes, chef.",
  "yes-chef-3": "Yes, chef.",
  "timer-on": "Timer's on.",
  "on-it": "On it.",
  flagged: "Flagged.",
  ...Object.fromEntries(Object.values(READ_BACKS).map((r) => [r.name, r.text])),
};

export type ClipName = keyof typeof CLIP_TEXT & string;

export const CLIP_NAMES: readonly ClipName[] = Object.keys(CLIP_TEXT);

export function clipUrl(name: string): string {
  return `${SUE_CLIP_DIR}/${name}.mp3`;
}

/** The read-back clip for a timer of exactly `seconds`, or null when its length has none. */
export function readBackClip(seconds: number): ClipName | null {
  const found = (READ_BACKS as Record<number, { name: string }>)[seconds];
  return found ? found.name : null;
}
