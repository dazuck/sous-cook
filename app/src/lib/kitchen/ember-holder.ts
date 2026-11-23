/**
 * The cook screen's one ember (DS §1; slice V's V2 as amended 2026-10-05;
 * slice B5a, A10). Everything that might draw ember reads this one answer;
 * the step holds it by default and yields, fading to ink over `--dur-step`,
 * to whichever claim wins. In order:
 *
 * 1. `alarm`: a timer that has finished and not been dismissed, anywhere in
 *    the kitchen. Danger is ember at full strength plus motion (DS §1).
 * 2. `discussed`: a pair "how much" just answered (slice B5d, D13), for its
 *    8 s linger: DS §5's "ember = the one being discussed". The cook asked;
 *    the answer is the thing to read, so it outranks the next act.
 * 3. On the last part of the last step, the next act (2026-10-03):
 *    `offer`, the step's timer not yet started, then `finish`, the Finish
 *    check. Once the timer runs, Finish holds the ember and the clock is ink.
 *    This reverses slice V's call 4 ("a timer beats Finish"), which didn't
 *    cite that answer.
 * 4. `timer`: a running timer on the screen, in the meta or the ledge; the
 *    soonest-ending one is the one drawn in ember (P42 as accepted).
 * 5. `step`.
 *
 * An unstarted offer on any other step claims nothing: it is ink, and the
 * step keeps the ember (B5a question 1, built as recommended). B2's lost-flag
 * alarm is not a holder (its ember went in B2's panel round 4). A borrowed
 * screen has no step, so its one ember is its own.
 */
export type EmberHolder = "alarm" | "discussed" | "offer" | "finish" | "timer" | "step";

export interface EmberClaims {
  /** An expired timer, not yet dismissed. */
  alarm?: boolean;
  /** A pair lingering as the answer to "how much". */
  discussed?: boolean;
  /** The Finish check is drawn: the last part of the last step. */
  finish: boolean;
  /** The step in hand offers a timer not yet started. */
  offer?: boolean;
  /** A timer is running. */
  timer: boolean;
}

export function emberHolder({ alarm = false, discussed = false, finish, offer = false, timer }: EmberClaims): EmberHolder {
  if (alarm) return "alarm";
  if (discussed) return "discussed";
  if (finish) return offer ? "offer" : "finish";
  if (timer) return "timer";
  return "step";
}
