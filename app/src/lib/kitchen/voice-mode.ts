/**
 * How the cook view listens on this device (DECISIONS 2026-09-29).
 *
 * - `always`: continuous recognition behind the wake word, restarted each
 *   time Chrome ends a session (`lib/kitchen/wake-word.ts` `hear`).
 * - `tap`: one listen per tap on the voice dot, for one command or one
 *   question, no wake word needed (`hearTapped`). Chrome on Android ends a
 *   session after a few seconds of silence and plays the system mic chime on
 *   every start, with no way for a page to mute it; listening all the time
 *   there chimed every few seconds. The one listen runs continuously and
 *   ends by `tap-listen.ts`'s rules, not at Chrome's first pause (DECISIONS
 *   2026-10-27).
 *
 * Chrome on a large Android tablet (the Pixel Tablet among them) asks for
 * desktop sites by default, and then says it is Linux, not Android. So a
 * touch screen on Linux counts as Android too; ChromeOS says CrOS, and a
 * touch-screen Linux laptop, rare, gets tap to talk, which works anywhere.
 */
export type VoiceMode = "always" | "tap";

export function voiceModeFor(userAgent: string, maxTouchPoints: number): VoiceMode {
  if (/Android/i.test(userAgent)) return "tap";
  if (/Linux/.test(userAgent) && !/CrOS/.test(userAgent) && maxTouchPoints > 0) return "tap";
  return "always";
}
