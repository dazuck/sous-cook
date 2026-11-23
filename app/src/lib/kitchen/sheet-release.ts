/**
 * Pointer gesture classification, velocity and level release calculation
 * for the cook look-ahead sheet (P58, N3, N3a, N4).
 */

export const SHEET_CONSTANTS = {
  FLICK: 0.5, // px/ms upward at release: at or past this pins; slower springs back
  FLICK_FAR: 1.2, // px/ms: a flick this fast, already half a level past next, projects further
  PROJECT_MS: 180, // how far ahead a far flick projects (ms)
  PUSH: 0.3, // px/ms downward at release, or 8 px net down: back to Now
  SLOP_PULL: 10, // px, with |dy| > 1.2 * |dx|: becomes a pull
  SLOP_SWIPE: 14, // px, with |dx| > 1.5 * |dy|: becomes a swipe (stage only)
  DEAD_SIDE: 48, // px: no pull starts this close to side edge (Android back gesture)
  DEAD_FOOT: 24, // px: no pull starts this close to bottom edge (system home gesture)
  SPRING_W: 16, // rad/s: critically damped spring
  GATE_MS: 140, // ms: name fades in or out over this
} as const;

/**
 * The deepest level a pull reaches: the chart (N2-1). Whole recipe (level 3)
 * is a borrowed screen opened by its button, never by a pull.
 */
export const DEEPEST = 2;

export type PointerZone = "band" | "foot" | "sheet" | "stage" | "none";
export type GestureMode = "tap" | "pull" | "swipe" | "drift" | "none";

export interface SheetGeometry {
  width: number;
  height: number;
  bandTop: number;
  bandBottom: number;
  footTop: number;
  stageTop: number;
}

/**
 * Identifies which zone a pointer touch starts in.
 * Respects system dead zones and level limits (at level 3, none).
 */
export function pointerZone(
  x: number,
  y: number,
  geometry: SheetGeometry,
  pinnedLevel: number,
): PointerZone {
  if (
    x < SHEET_CONSTANTS.DEAD_SIDE ||
    x > geometry.width - SHEET_CONSTANTS.DEAD_SIDE ||
    y > geometry.height - SHEET_CONSTANTS.DEAD_FOOT
  ) {
    return "none";
  }

  // At Whole recipe (level 3), the column scrolls and ledge is a button; no pull starts there.
  if (pinnedLevel >= 3) return "none";

  if (y >= geometry.bandTop && y <= geometry.bandBottom) return "band";
  if (y >= geometry.footTop) return "foot";
  if (pinnedLevel > 0 && y > geometry.bandBottom) return "sheet";
  if (y >= geometry.stageTop) return "stage";

  return "none";
}

/**
 * Classifies a gesture once pointer moves:
 * - Within slop: "tap"
 * - Past slop:
 *   - Pull: |dy| > 10 and |dy| > 1.2 * |dx| (on pullable zones)
 *   - Swipe: |dx| > 14 and |dx| > 1.5 * |dy| (stage only)
 *   - Drift: neither ratio
 */
export function classify(
  dx: number,
  dy: number,
  zone: PointerZone,
  pinnedLevel: number,
): GestureMode {
  if (zone === "none") return "none";

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // Under slop, it remains a potential tap
  const slopX = zone === "stage" ? SHEET_CONSTANTS.SLOP_SWIPE : SHEET_CONSTANTS.SLOP_PULL;
  if (absDx <= slopX && absDy <= SHEET_CONSTANTS.SLOP_PULL) {
    return "tap";
  }

  // Check if zone is pullable at this level:
  // At Now (0): band or foot
  // Pinned (1..2): band, foot, sheet, or stage
  const pullable =
    zone === "band" ||
    zone === "foot" ||
    zone === "sheet" ||
    (zone === "stage" && pinnedLevel > 0);

  if (pullable && absDy > SHEET_CONSTANTS.SLOP_PULL && absDy > 1.2 * absDx) {
    return "pull";
  }

  if (zone === "stage" && absDx > SHEET_CONSTANTS.SLOP_SWIPE && absDx > 1.5 * absDy) {
    return "swipe";
  }

  return "drift";
}

/**
 * Computes velocity in px/ms from pointer move samples [timestamp, y].
 * Calculated over the first and last of the last 8 samples.
 * Negative velocity = moving upward (y decreasing).
 * Positive velocity = moving downward (y increasing).
 */
export function velocity(samples: ReadonlyArray<readonly [number, number]>): number {
  if (samples.length <= 1) return 0;

  const windowSamples = samples.slice(-8);
  const first = windowSamples[0];
  const last = windowSamples[windowSamples.length - 1];

  const dt = last[0] - first[0];
  if (dt <= 0) return 0;

  const dy = last[1] - first[1];
  return dy / dt;
}

export interface ReleaseOptions {
  pinnedLevel: number;
  currentDepth: number;
  currentY?: number;
  velocity: number; // px/ms, negative = upward, positive = downward
  netYDown?: number; // px moved down from start
  cancelled?: boolean;
  detents?: readonly number[]; // [Y0, Y1, Y2] in px: Now, the stretch, the chart
}

/**
 * Determines which level to settle to when pointer is released.
 */
export function releaseLevel({
  pinnedLevel,
  currentDepth,
  currentY,
  velocity: v,
  netYDown = 0,
  cancelled = false,
  detents,
}: ReleaseOptions): number {
  // A cancelled pointer mid-pull returns to the prior level at velocity 0, never pins a new one.
  if (cancelled) {
    return pinnedLevel;
  }

  // Upward flick (v <= -FLICK)
  if (v <= -SHEET_CONSTANTS.FLICK) {
    const one = Math.min(DEEPEST, pinnedLevel + 1);

    // Fast flick already half a level past the next projects further
    if (v <= -SHEET_CONSTANTS.FLICK_FAR && currentDepth >= one + 0.5) {
      if (detents && currentY !== undefined) {
        const proj = currentY + v * SHEET_CONSTANTS.PROJECT_MS;
        let near = 1;
        for (let q = 2; q <= DEEPEST; q++) {
          if (Math.abs(detents[q] - proj) < Math.abs(detents[near] - proj)) {
            near = q;
          }
        }
        return Math.min(DEEPEST, Math.max(near, Math.round(currentDepth)));
      }
      // Projected depth fallback if detents not provided
      const depthProj = currentDepth + Math.abs(v) * (SHEET_CONSTANTS.PROJECT_MS / 180);
      return Math.min(DEEPEST, Math.max(one, Math.round(depthProj)));
    }

    // A flick pins the next level, or the level the finger already took the sheet nearest.
    return Math.min(DEEPEST, Math.max(one, Math.round(currentDepth)));
  }

  // Push down from pinned level (+0.3 px/ms or 8 px net down goes to Now)
  if (pinnedLevel > 0 && (netYDown > 8 || v >= SHEET_CONSTANTS.PUSH)) {
    return 0;
  }

  // Otherwise springs back to where it was
  return pinnedLevel;
}

/**
 * Release logic under prefers-reduced-motion: reduce.
 * A pull up past slop goes 1 level deeper (2 with FLICK_FAR).
 * A push down goes to Now.
 */
export function reducedRelease(
  pinnedLevel: number,
  dy: number,
  v: number,
): number {
  // Push down
  if (dy > 8 || v >= SHEET_CONSTANTS.PUSH) {
    return 0;
  }

  // Pull up past slop
  if (dy < -SHEET_CONSTANTS.SLOP_PULL) {
    if (v <= -SHEET_CONSTANTS.FLICK_FAR) {
      return Math.min(DEEPEST, pinnedLevel + 2);
    }
    return Math.min(DEEPEST, pinnedLevel + 1);
  }

  return pinnedLevel;
}
