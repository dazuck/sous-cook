/**
 * The judgment behind Sue's generated clips (`generate-sue-clips.ts` runs it):
 * which takes of "Yes, chef." are kept, what a call costs, and the checks a
 * finished file must pass. Pure, so it is tested without a model or ffmpeg.
 */

/** The one voice and the one style line every clip is generated with. */
export const SUE_VOICE = {
  model: "gemini-3.8-flash-lite-tts",
  voice: "Schedar",
  /** Schedar is listed by Google as "Even". The style keeps every clip in one register. */
  style: "calm, low and brief, unbothered, a sous-chef acknowledging the chef; no exclamation, no smile",
} as const;

/** What Google lists for the model today: dollars per million tokens (2026-11-22; doubles on 2027-01-01). */
export const PRICE = { textInputPerM: 0.5, audioOutputPerM: 6 } as const;

/** What a call cost, from the token counts the response reports. */
export function callCostUsd(inputTokens: number, outputAudioTokens: number): number {
  return (inputTokens * PRICE.textInputPerM + outputAudioTokens * PRICE.audioOutputPerM) / 1_000_000;
}

export interface Take {
  /** Which take of the phrase, from 1. */
  take: number;
  seconds: number;
}

/**
 * `count` takes that differ in pace: the quickest, the slowest, and the ones
 * between spaced evenly by rank. Takes within `minGapS` of one already kept
 * are skipped, as they'd sound like the same clip twice; fewer than `count`
 * come back when there aren't that many apart.
 */
export function pickTakesByPace(takes: readonly Take[], count: number, minGapS = 0.02): Take[] {
  const sorted = [...takes].sort((a, b) => a.seconds - b.seconds);
  if (sorted.length === 0 || count <= 0) return [];
  const wanted = Array.from({ length: Math.min(count, sorted.length) }, (_, i) =>
    count === 1 ? sorted[0] : sorted[Math.round((i * (sorted.length - 1)) / (Math.min(count, sorted.length) - 1 || 1))],
  );
  const kept: Take[] = [];
  for (const take of [...new Set(wanted)]) {
    if (kept.every((k) => Math.abs(k.seconds - take.seconds) >= minGapS)) kept.push(take);
  }
  // Fill from what's left, widest apart first, if the even spacing repeated a take.
  for (const take of sorted) {
    if (kept.length >= count) break;
    if (kept.includes(take)) continue;
    if (kept.every((k) => Math.abs(k.seconds - take.seconds) >= minGapS)) kept.push(take);
  }
  return kept.sort((a, b) => a.seconds - b.seconds);
}

/** What a finished clip is held to, in one place. */
export const LIMITS = {
  minSeconds: 0.3,
  maxSeconds: 3,
  /** Peak, dBFS: loud enough to be a clip, never clipped. */
  peakMinDb: -12,
  peakMaxDb: -0.5,
  /** Every clip's level (RMS, dBFS) lands within this of the target. */
  targetRmsDb: -21,
  rmsToleranceDb: 1.5,
} as const;

export interface Measured {
  seconds: number;
  peakDb: number;
  rmsDb: number;
}

/** What is wrong with a finished clip, in words; empty when it passes. */
export function problemsWith(name: string, m: Measured): string[] {
  const out: string[] = [];
  if (!(m.seconds >= LIMITS.minSeconds)) out.push(`${name}: ${m.seconds.toFixed(2)} s is too short (under ${LIMITS.minSeconds} s)`);
  if (!(m.seconds <= LIMITS.maxSeconds)) out.push(`${name}: ${m.seconds.toFixed(2)} s is too long (over ${LIMITS.maxSeconds} s)`);
  if (!(m.peakDb <= LIMITS.peakMaxDb)) out.push(`${name}: peak ${m.peakDb.toFixed(1)} dBFS may clip (over ${LIMITS.peakMaxDb})`);
  if (!(m.peakDb >= LIMITS.peakMinDb)) out.push(`${name}: peak ${m.peakDb.toFixed(1)} dBFS is too quiet (under ${LIMITS.peakMinDb})`);
  if (!(Math.abs(m.rmsDb - LIMITS.targetRmsDb) <= LIMITS.rmsToleranceDb)) {
    out.push(`${name}: level ${m.rmsDb.toFixed(1)} dB RMS is off the ${LIMITS.targetRmsDb} dB target by more than ${LIMITS.rmsToleranceDb}`);
  }
  return out;
}

/** The gain, in dB, that brings a clip to the target level without its peak passing the ceiling. */
export function gainToTarget(m: Pick<Measured, "peakDb" | "rmsDb">): number {
  const toTarget = LIMITS.targetRmsDb - m.rmsDb;
  const headroom = -1 - m.peakDb;
  return Math.min(toTarget, headroom);
}
