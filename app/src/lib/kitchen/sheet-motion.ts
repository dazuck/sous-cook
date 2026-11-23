/**
 * The cook sheet's motion: where its edge stands, the finger that pulls it,
 * the spring that settles it and the glide that a tap, a word or a key
 * starts (P58 (c), (d); N3, N3a, N4; N2-1). Framework-free so the units drive
 * it with a fake clock; `useCookSheet` binds it to the page.
 *
 * - Three detents: Now, the stretch, the chart. A pull follows the finger,
 *   rubber-banded at 0.3 past either end; on release it settles on the
 *   critically damped spring from the finger's own velocity (`releaseLevel`),
 *   never past the detent and never deeper than the chart.
 * - A glide runs 400 ms for one level and 520 ms for more on the DS easing.
 * - The opening's Start is no glide (slice N3, N3-3): no card has a place in
 *   both drawings, so it is the base step-advance cross-fade, 320 ms (200
 *   under reduced motion), the edge at Now at once (`jump`).
 * - Between the stretch and the whole cook the edge still follows the finger;
 *   what it shows cross-fades by depth (`frameAt`), so nothing here is timed.
 * - Whole recipe (level 3) is a borrowed screen over the sheet, not a detent:
 *   going there leaves the edge where it stands (the caller cross-fades the
 *   screen in), and leaving it puts the edge at the level asked for at once,
 *   under the screen's fade out.
 * - A cancelled pointer springs back to the level held before the pull.
 * - Under reduced motion nothing follows the finger: a pull past the slop goes
 *   one level deeper (two on a far flick), a push down goes to Now, and every
 *   change is the caller's 200 ms cross-fade.
 * - The touch's claim (N3a): a touch the sheet classed as a pull or a drift is
 *   claimed until the next touch starts, so the swipe hook, reading it at
 *   touchend (after pointerup), never takes it as a swipe.
 */

import {
  classify,
  DEEPEST,
  releaseLevel,
  reducedRelease,
  SHEET_CONSTANTS,
  velocity,
  type GestureMode,
  type PointerZone,
} from "./sheet-release";
import { ease, glideMs, SPRING_W } from "./spring";

/** Now, the stretch, the chart, Whole recipe. */
export type Level = 0 | 1 | 2 | 3;
/** A level the sheet's edge stands at: Whole recipe has no detent. */
export type Detent = 0 | 1 | 2;

/** A finger still this long before it lifts lifts at no speed. */
export const STILL_MS = 100;
/** A press held this long without moving is no tap: a wet hand resting on the band. */
export const HOLD_MS = 500;
/** The opening's Start (N3-3): DS §3's step-advance cross-fade, and its reduced-motion length. */
export const JUMP_MS = 320;
export const JUMP_REDUCED_MS = 200;
/** A cut-short pass under a settling spring eases out over an entry fade (SPEC §11: 280 ms), in s. */
const PASS_EASE_S = 0.28;

export interface MotionHost {
  raf: (cb: (t: number) => void) => number;
  caf: (id: number) => void;
  now: () => number;
  reduced: () => boolean;
  /** The three detents [Now, stretch, chart], px from the screen's top, or null before the first layout. */
  detents: () => readonly number[] | null;
  /** Draw at this edge. */
  /**
   * `pass`: how far the frame is a glide straight between Now and the chart, past the stretch
   * without stopping (its parts stay away): 1 such a glide, 0 the levels' own frames, between
   * them while a cut-short pass eases out (T3 fix round).
   */
  paint: (s: { Y: number; smooth: boolean; pass: number }) => void;
  /** The pinned level changed by the sheet's own hand (a release). */
  onLevel: (k: Level) => void;
  /** The sheet came to rest on a level. */
  onSettled: (k: Level) => void;
  /** Cross-fade into what `apply` draws: reduced motion (200 ms), and the opening's Start (`jump`, its own length). */
  crossfade: (apply: () => void, ms?: number) => void;
}

interface Pointer {
  id: number;
  x0: number;
  y0: number;
  t0: number;
  zone: PointerZone;
  mode: GestureMode | null;
  samples: [number, number][];
  pinned: Detent;
  grab: number;
  Ystart: number;
  lastY: number;
}

export interface UpResult {
  /** A tap: under the slop, not held, not cancelled. */
  tap: boolean;
  /** Swallow the click this touch would make (it pulled, or it was held). */
  swallow: boolean;
}

export class SheetMotion {
  Y = 0;
  pinned: Level = 0;
  settled: Level = 0;
  /** The detent the edge stands at: the pinned level, or the one under Whole recipe. */
  base: Detent = 0;
  private anim = 0;
  private P: Pointer | null = null;
  private claim = false;
  private moving = false;
  /**
   * How far the frames are a straight pass between levels 0 and 2 (1), or the levels' own (0). A
   * pass cut short (a key, a finger) carries this on from where it was drawn; at the ends the two
   * draw the same, so landing there sets it back to 0 with no change on screen.
   */
  private passW = 0;

  constructor(private host: MotionHost) {}

  /** The edge's depth, 0 (Now) to 2 (the chart), continuous between detents. */
  get d(): number {
    const D = this.host.detents();
    if (!D) return 0;
    if (this.Y >= D[0]) return 0;
    for (let k = 0; k < DEEPEST; k++) {
      if (this.Y >= D[k + 1]) return k + (D[k] - this.Y) / Math.max(1e-6, D[k] - D[k + 1]);
    }
    return DEEPEST;
  }

  /** A pull is under way. */
  get pulling(): boolean {
    return this.P?.mode === "pull";
  }

  /** A finger (or the mouse) is down on the sheet, pulling or not yet. */
  get touching(): boolean {
    return this.P !== null;
  }

  /**
   * At rest: settled where it is pinned, nothing moving (no glide, spring or pull, a glide turned
   * back to the level it left included) and no finger down (T3 follow-up).
   */
  get resting(): boolean {
    return this.settled === this.pinned && !this.moving && this.anim === 0 && this.P === null;
  }

  /** A new touch began somewhere the sheet doesn't take: the last one's claim is spent. */
  clearClaim() {
    this.claim = false;
  }

  /** Whether the last touch was the sheet's (a pull or a drift), for the swipe hook (N3a). */
  claimed(): boolean {
    return this.claim;
  }

  private draw(smooth = this.moving) {
    this.host.paint({ Y: this.Y, smooth, pass: this.passW });
  }

  /** Stop what runs: the pass's weight stays where it was drawn, for what follows to carry on. */
  private stop() {
    if (this.anim) this.host.caf(this.anim);
    this.anim = 0;
  }

  /** Where a motion toward k takes the pass's weight: out at the stretch, held toward an end. */
  private passTo(k: Level): number {
    return k === 1 ? 0 : this.passW;
  }

  /** A new layout (a step change, a rotation, fonts): stand at the base detent. A pull in hand is cancelled. */
  reflow() {
    const D = this.host.detents();
    if (!D) return;
    if (this.P) this.P = null;
    this.stop();
    this.moving = false;
    this.passW = 0;
    this.Y = D[this.base];
    this.draw(false);
    // A glide the new layout cut short has landed: say so.
    if (this.settled !== this.pinned) {
      this.settled = this.pinned;
      this.host.onSettled(this.pinned);
    }
  }

  private arrived() {
    this.anim = 0;
    this.moving = false;
    this.passW = 0;
    this.settled = this.pinned;
    this.host.onSettled(this.pinned);
    this.draw(false);
  }

  /** A release: critically damped from the finger's velocity (px/ms), clamped at the detent. */
  private settle(k: Detent, v0: number) {
    const D = this.host.detents();
    if (!D) return;
    const target = D[k];
    if (this.host.reduced()) {
      this.stop();
      this.host.crossfade(() => {
        this.Y = target;
        this.draw(false);
      });
      this.arrived();
      return;
    }
    this.stop();
    this.moving = true;
    const w = SPRING_W;
    const x0 = this.Y - target;
    const sign = Math.sign(x0);
    const v = v0 * 1000;
    const t0 = this.host.now();
    const w0 = this.passW;
    const w1 = this.passTo(k);
    const tick = () => {
      const t = (this.host.now() - t0) / 1000;
      let x = (x0 + (v + w * x0) * t) * Math.exp(-w * t);
      if (sign !== 0 && Math.sign(x) !== sign) x = 0;
      this.Y = target + x;
      // The pass's weight eases over an entry's 280 ms (SPEC §11): the stretch's parts come in as they would.
      this.passW = w0 + (w1 - w0) * ease(Math.min(1, t / PASS_EASE_S));
      if ((Math.abs(x) < 0.4 && t > 0.08) || t > 1.2) {
        this.Y = target;
        this.arrived();
        return;
      }
      this.draw(true);
      this.anim = this.host.raf(tick);
    };
    this.anim = this.host.raf(tick);
  }

  private glide(k: Detent, ms: number, pass = false) {
    const D = this.host.detents();
    if (!D) return;
    const target = D[k];
    if (this.host.reduced()) {
      this.stop();
      this.host.crossfade(() => {
        this.Y = target;
        this.draw(false);
      });
      this.arrived();
      return;
    }
    this.stop();
    this.moving = true;
    // A straight pass from rest is one from its first frame; any other glide carries on the
    // weight it was drawn with (a pass cut short), easing it out toward the stretch.
    const w0 = pass ? 1 : this.passW;
    const w1 = pass ? 1 : this.passTo(k);
    this.passW = w0;
    const y0 = this.Y;
    const t0 = this.host.now();
    const tick = () => {
      const p = Math.min(1, (this.host.now() - t0) / ms);
      this.Y = y0 + (target - y0) * ease(p);
      this.passW = w0 + (w1 - w0) * ease(p);
      if (p >= 1) {
        this.arrived();
        return;
      }
      this.draw(true);
      this.anim = this.host.raf(tick);
    };
    this.anim = this.host.raf(tick);
  }

  /**
   * A tap, a word or a key: glide to level k (400 ms for one level, 520 for
   * more). Level 3 opens Whole recipe over the sheet where it stands; leaving
   * it puts the edge at k at once (the screen's fade out is the transition).
   */
  goTo(k: Level) {
    const D = this.host.detents();
    const from = this.pinned;
    if (k === 3) {
      // The edge stops where it was going: Whole recipe borrows the screen over it.
      this.stop();
      this.moving = false;
      if (from !== 3) this.base = from;
      this.pinned = 3;
      if (D) {
        this.Y = D[this.base];
        this.draw(false);
      }
      if (this.settled !== 3) {
        this.settled = 3;
        this.host.onSettled(3);
      }
      return;
    }
    this.pinned = k;
    this.base = k;
    if (!D) {
      this.settled = k;
      return;
    }
    if (from === 3) {
      this.stop();
      this.moving = false;
      this.Y = D[k];
      this.draw(false);
      this.settled = k;
      this.host.onSettled(k);
      return;
    }
    // Straight from Now to the chart or back, at rest on either: past the stretch without its parts (T3).
    const pass = Math.abs(k - from) === 2 && this.settled === from && this.Y === D[from];
    this.glide(k, glideMs(from, k), pass);
  }

  /**
   * A cut to level k under a cross-fade (N3-3: the opening's Start to Now):
   * the edge stands at k at once and the caller fades the old look out over
   * 320 ms, 200 under reduced motion.
   */
  jump(k: Detent) {
    const D = this.host.detents();
    this.stop();
    this.P = null;
    this.moving = false;
    this.pinned = k;
    this.base = k;
    if (!D) {
      this.settled = k;
      return;
    }
    this.host.crossfade(() => {
      this.Y = D[k];
      this.draw(false);
    }, this.host.reduced() ? JUMP_REDUCED_MS : JUMP_MS);
    this.arrived();
  }

  // ---- pointers ----

  down(e: { id: number; x: number; y: number; t: number; zone: PointerZone }) {
    if (this.P) return; // only the first finger counts
    this.claim = false;
    // No pull starts at Whole recipe (`pointerZone` says "none" there); the
    // touch is still tracked so a tap on the screen's own chrome stays a tap.
    this.P = {
      id: e.id,
      x0: e.x,
      y0: e.y,
      t0: e.t,
      zone: this.pinned === 3 ? "none" : e.zone,
      mode: null,
      samples: [[e.t, e.y]],
      pinned: this.base,
      grab: 0,
      Ystart: this.Y,
      lastY: e.y,
    };
  }

  /** Returns true when the sheet now owns the pointer (a pull just began). */
  move(e: { id: number; x: number; y: number; t: number }): boolean {
    const P = this.P;
    if (!P || e.id !== P.id) return false;
    const dx = e.x - P.x0;
    const dy = e.y - P.y0;
    let began = false;
    if (!P.mode || P.mode === "tap") {
      const m = classify(dx, dy, P.zone, this.pinned);
      if (m === "pull") {
        P.mode = "pull";
        this.claim = true;
        P.grab = P.y0 - this.Y;
        P.Ystart = this.Y;
        this.stop();
        this.moving = true;
        began = true;
      } else if (m === "swipe") {
        P.mode = "swipe";
      } else if (m === "drift") {
        P.mode = "drift";
        this.claim = true;
      } else if (m === "none") {
        P.mode = "none";
      } else {
        P.mode = "tap";
      }
    }
    P.lastY = e.y;
    if (P.mode === "pull") {
      P.samples.push([e.t, e.y]);
      if (P.samples.length > 8) P.samples.shift();
      if (!this.host.reduced()) {
        const D = this.host.detents();
        if (D) {
          const lo = D[DEEPEST];
          const hi = D[0];
          let Y = e.y - P.grab;
          if (Y < lo) Y = lo - (lo - Y) * 0.3;
          if (Y > hi) Y = hi + (Y - hi) * 0.3;
          this.Y = Y;
          this.draw(true);
        }
      }
    }
    return began;
  }

  up(e: { id: number; x: number; y: number; t: number }, cancelled: boolean): UpResult {
    const P = this.P;
    if (!P || e.id !== P.id) return { tap: false, swallow: false };
    this.P = null;
    if (P.mode === "pull") {
      // A finger held still before it lifts sends no moves: its velocity is
      // what it did last, which was nothing. Over 100 ms still, it is 0.
      const lastT = P.samples[P.samples.length - 1][0];
      const v = e.t - lastT > STILL_MS ? 0 : velocity(P.samples);
      if (cancelled) {
        this.pinned = P.pinned;
        this.base = P.pinned;
        this.settle(P.pinned, 0);
        return { tap: false, swallow: true };
      }
      let k: number;
      if (this.host.reduced()) {
        k = reducedRelease(P.pinned, e.y - P.y0, v);
      } else {
        const D = this.host.detents();
        k = releaseLevel({
          pinnedLevel: P.pinned,
          currentDepth: this.d,
          currentY: this.Y,
          velocity: v,
          netYDown: this.Y - P.Ystart,
          detents: D ?? undefined,
        });
      }
      // A pull never lands past the chart: Whole recipe is its button's alone.
      const to = Math.max(0, Math.min(DEEPEST, k)) as Detent;
      this.pinned = to;
      this.base = to;
      if (to !== P.pinned) this.host.onLevel(to);
      this.settle(to, this.host.reduced() ? 0 : v);
      return { tap: false, swallow: true };
    }
    if (cancelled) return { tap: false, swallow: false };
    const held = e.t - P.t0 >= HOLD_MS;
    const still = P.mode === null || P.mode === "tap";
    return { tap: still && !held, swallow: still && held };
  }

  /** Forget a pointer the browser took (no release logic): used when the sheet unmounts. */
  drop() {
    this.P = null;
  }

  dispose() {
    this.stop();
  }
}

export { SHEET_CONSTANTS };
