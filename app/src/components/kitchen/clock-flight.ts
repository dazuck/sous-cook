/**
 * The clock's walk down to the counter's edge (slice B5a, design rounds 2
 * and 3): as the cook moves on from a step whose timer runs, its digits
 * travel from the step's meta into the foot's well, and back up when the
 * cook returns. Each clock records where its digits last stood; the one that
 * mounts next for the same timer flies in from there (a FLIP, by transform
 * only), on a beat of its own: the steps change first (`--dur-step`), then
 * the digits drop, then the well's name fades in once they have landed.
 */

/** The step change the flight waits out, then its own glide. */
const WAIT_MS = 320;
const FLIGHT_MS = 700;
const NAME_MS = 320;
/** A rect older than this is from another screen, not the one just left. */
const FRESH_MS = 1200;
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

interface Spot {
  rect: DOMRect;
  at: number;
}

const spots = new Map<string, Spot>();

/** Where a clock's digits stand now; call from a layout effect. */
export function markClock(id: string, el: HTMLElement): void {
  spots.set(id, { rect: el.getBoundingClientRect(), at: performance.now() });
}

/**
 * Fly a clock's digits in from where the same timer last stood, if that was
 * a moment ago somewhere else on the screen, and fade `name` (the well's
 * label) in once they land. Under reduced motion it lands at once.
 */
export function flyClockIn(id: string, el: HTMLElement, name?: HTMLElement | null): void {
  const from = spots.get(id);
  if (!from || performance.now() - from.at > FRESH_MS) return;
  const to = el.getBoundingClientRect();
  if (to.height === 0 || (Math.abs(from.rect.top - to.top) < 2 && Math.abs(from.rect.left - to.left) < 2)) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const scale = from.rect.height / to.height;
  const dx = from.rect.left - to.left;
  const dy = from.rect.top - to.top;
  el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, transformOrigin: "0 0" },
      { transform: "none", transformOrigin: "0 0" },
    ],
    // Held where it stood while the steps change, then its own glide.
    { duration: FLIGHT_MS, delay: WAIT_MS, easing: EASE, fill: "backwards" },
  );
  name?.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: NAME_MS,
    delay: WAIT_MS + FLIGHT_MS,
    easing: EASE,
    fill: "backwards",
  });
}
