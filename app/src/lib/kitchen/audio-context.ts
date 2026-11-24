/**
 * The page's one WebAudio context. The timer's chime (`chime.ts`) and Sue's
 * acknowledgements (`ack-audio.ts`) share it, so the tap that unlocks the
 * chime (`KitchenTimers`: any tap or key on the page) unlocks both, and the
 * page never holds two contexts open on a tablet's one speaker.
 *
 * Browsers only start audio from a user gesture; until then the context is
 * `suspended`, and whoever wants to sound checks `state` first.
 */

let shared: AudioContext | null = null;

/** The page's context, made on first ask; null where there is no WebAudio. */
export function sharedAudioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  shared ??= new AudioContext();
  return shared;
}
