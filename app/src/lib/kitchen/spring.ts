/**
 * Spring and glide motion curves for the cook look-ahead (P58, N3, N4).
 *
 * Settle uses a critically damped spring from the finger's velocity on release.
 * Glides (tap, voice, key) use the design system's cubic-bezier(0.32, 0.72, 0, 1).
 */

/**
 * Critically damped spring angular frequency (rad/s).
 * Default value from the prototype (ahead.html) and sheet constants.
 */
export const SPRING_W = 16;

/**
 * Standard cubic-bezier easing control points from DS §3:
 * cubic-bezier(0.32, 0.72, 0, 1).
 */
export const EASE_POINTS = [0.32, 0.72, 0, 1] as const;

/**
 * Evaluates a cubic bezier curve at progression x (0..1).
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (x: number) => number {
  const B = (t: number, a: number, b: number) =>
    3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (B(m, x1, x2) < x) lo = m;
      else hi = m;
    }
    return B((lo + hi) / 2, y1, y2);
  };
}

/** The default DS easing function. */
export const ease = cubicBezier(
  EASE_POINTS[0],
  EASE_POINTS[1],
  EASE_POINTS[2],
  EASE_POINTS[3],
);

/**
 * Spring displacement at time t (seconds) from displacement x0 and initial velocity v0 (px/s).
 * x(t) = (x0 + (v0 + w * x0) * t) * e^(-w * t)
 * Clamped so it never passes the detent (target), i.e. if x crosses 0 / changes sign, it clamps to 0.
 */
export function springDisplacement(
  x0: number,
  v0_px_s: number,
  tSeconds: number,
  w: number = SPRING_W,
): number {
  const sign = Math.sign(x0);
  if (sign === 0) return 0;
  let x = (x0 + (v0_px_s + w * x0) * tSeconds) * Math.exp(-w * tSeconds);
  if (sign !== 0 && Math.sign(x) !== sign) x = 0;
  return x;
}

/**
 * Spring position at time t (seconds) for a target detent and initial displacement x0.
 * Never passes target from any (x0, v0).
 */
export function springAt(
  target: number,
  x0: number,
  v0_px_s: number,
  tSeconds: number,
  w: number = SPRING_W,
): number {
  return target + springDisplacement(x0, v0_px_s, tSeconds, w);
}

/**
 * Whether the spring has settled.
 * Settled when displacement is under 0.4 px after 80 ms, or timed out past 1.2 s.
 */
export function settled(x: number, tSeconds: number): boolean {
  return (Math.abs(x) < 0.4 && tSeconds > 0.08) || tSeconds > 1.2;
}

export const UNFURL_MS = 400;
export const UNFURL_FAR_MS = 520;

/**
 * Duration in ms for a glide between levels:
 * 400 ms for one level, 520 ms for more than one level (N4).
 */
export function glideMs(from: number, to: number): number {
  return Math.abs(to - from) > 1 ? UNFURL_FAR_MS : UNFURL_MS;
}
