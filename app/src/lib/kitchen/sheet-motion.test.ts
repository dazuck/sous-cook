import { describe, expect, it } from "vitest";
import { HOLD_MS, SheetMotion, type Level, type MotionHost } from "./sheet-motion";

/** A host with a hand-turned clock and frame queue. */
function rig(opts: { reduced?: boolean; onFade?: (ms: number | undefined) => void } = {}) {
  let t = 0;
  let q: { id: number; cb: (t: number) => void }[] = [];
  let next = 1;
  const D = [600, 300, 92];
  const levels: Level[] = [];
  const settled: Level[] = [];
  const painted: number[] = [];
  const passes: number[] = [];
  let fades = 0;
  const host: MotionHost = {
    raf: (cb) => {
      const id = next++;
      q.push({ id, cb });
      return id;
    },
    caf: (id) => {
      q = q.filter((f) => f.id !== id);
    },
    now: () => t,
    reduced: () => !!opts.reduced,
    detents: () => D,
    paint: (s) => {
      painted.push(s.Y);
      passes.push(s.pass);
    },
    onLevel: (k) => levels.push(k),
    onSettled: (k) => settled.push(k),
    crossfade: (apply, ms) => {
      fades++;
      opts.onFade?.(ms);
      apply();
    },
  };
  const m = new SheetMotion(host);
  m.reflow();
  const run = (ms: number) => {
    const end = t + ms;
    while (t < end) {
      t = Math.min(end, t + 16);
      const frames = q;
      q = [];
      for (const f of frames) f.cb(t);
    }
  };
  return { m, D, levels, settled, painted, passes, run, fades: () => fades, tick: (ms: number) => (t += ms), at: () => t };
}

describe("SheetMotion: the pull", () => {
  it("a slow pull springs back to Now", () => {
    const r = rig();
    r.m.down({ id: 1, x: 640, y: 650, t: r.at(), zone: "band" });
    for (let i = 1; i <= 15; i++) {
      r.tick(100);
      r.m.move({ id: 1, x: 640, y: 650 - i * 20, t: r.at() });
    }
    expect(r.m.Y).toBeLessThan(600);
    r.tick(60);
    const res = r.m.up({ id: 1, x: 640, y: 350, t: r.at() }, false);
    expect(res.swallow).toBe(true);
    r.run(1500);
    expect(r.m.pinned).toBe(0);
    expect(r.m.Y).toBe(r.D[0]);
    expect(r.levels).toEqual([]);
  });

  it("a quick pull held still before the finger lifts springs back: it lifts at no speed", () => {
    const r = rig();
    r.m.down({ id: 1, x: 640, y: 650, t: r.at(), zone: "band" });
    for (let i = 1; i <= 6; i++) {
      r.tick(16);
      r.m.move({ id: 1, x: 640, y: 650 - i * 40, t: r.at() });
    }
    r.tick(300);
    r.m.up({ id: 1, x: 640, y: 410, t: r.at() }, false);
    r.run(1500);
    expect(r.m.pinned).toBe(0);
  });

  it("a flick pins the stretch", () => {
    const r = rig();
    r.m.down({ id: 1, x: 640, y: 650, t: r.at() , zone: "band" });
    for (let i = 1; i <= 4; i++) {
      r.tick(16);
      r.m.move({ id: 1, x: 640, y: 650 - i * 40, t: r.at() });
    }
    r.m.up({ id: 1, x: 640, y: 490, t: r.at() }, false);
    r.run(1500);
    expect(r.m.pinned).toBe(1);
    expect(r.levels).toEqual([1]);
    expect(r.settled.at(-1)).toBe(1);
  });

  it("a cancelled pointer springs back to the level held before the pull, and pins nothing", () => {
    for (const from of [0, 1, 2] as Level[]) {
      const r = rig();
      if (from) {
        r.m.goTo(from);
        r.run(800);
      }
      r.m.down({ id: 1, x: 640, y: r.D[from] + 10, t: r.at(), zone: from ? "sheet" : "band" });
      for (let i = 1; i <= 6; i++) {
        r.tick(10);
        r.m.move({ id: 1, x: 640, y: r.D[from] + 10 - i * 60, t: r.at() });
      }
      r.m.up({ id: 1, x: 640, y: 0, t: r.at() }, true);
      r.run(1500);
      expect(r.m.pinned).toBe(from);
      expect(r.m.Y).toBe(r.D[from]);
      expect(r.levels).toEqual([]);
    }
  });

  it("from a pinned level, a push down goes to Now", () => {
    const r = rig();
    r.m.goTo(2);
    r.run(800);
    r.m.down({ id: 1, x: 640, y: 300, t: r.at(), zone: "sheet" });
    for (let i = 1; i <= 5; i++) {
      r.tick(40);
      r.m.move({ id: 1, x: 640, y: 300 + i * 6, t: r.at() });
    }
    r.m.up({ id: 1, x: 640, y: 330, t: r.at() }, false);
    r.run(1500);
    expect(r.m.pinned).toBe(0);
    expect(r.levels).toEqual([0]);
  });

  it("the deepest pull is the chart: a hard flick past it lands there, never on Whole recipe", () => {
    const r = rig();
    r.m.down({ id: 1, x: 640, y: 650, t: r.at(), zone: "band" });
    for (let i = 1; i <= 8; i++) {
      r.tick(10);
      r.m.move({ id: 1, x: 640, y: 650 - i * 80, t: r.at() });
    }
    // rubber-banded past the chart's detent, not followed 1:1
    expect(r.m.Y).toBeGreaterThan(r.D[2] - 60);
    expect(r.m.Y).toBeLessThan(r.D[2]);
    r.m.up({ id: 1, x: 640, y: 10, t: r.at() }, false);
    r.run(1500);
    expect(r.m.pinned).toBe(2);
    expect(r.m.Y).toBe(r.D[2]);
    expect(r.levels).toEqual([2]);
  });

  it("only the first finger counts", () => {
    const r = rig();
    r.m.down({ id: 1, x: 640, y: 650, t: r.at(), zone: "band" });
    r.m.down({ id: 2, x: 300, y: 650, t: r.at(), zone: "band" });
    r.tick(16);
    r.m.move({ id: 2, x: 300, y: 300, t: r.at() });
    expect(r.m.pulling).toBe(false);
  });
});

describe("SheetMotion: taps and the claim (N3a)", () => {
  it("a 6 px wobble is a tap", () => {
    const r = rig();
    r.m.down({ id: 1, x: 640, y: 650, t: r.at(), zone: "band" });
    r.tick(30);
    r.m.move({ id: 1, x: 646, y: 654, t: r.at() });
    r.tick(30);
    expect(r.m.up({ id: 1, x: 646, y: 654, t: r.at() }, false)).toEqual({ tap: true, swallow: false });
  });

  it("a press held still does nothing (a wet hand resting on the band)", () => {
    const r = rig();
    r.m.down({ id: 1, x: 640, y: 650, t: r.at(), zone: "band" });
    r.tick(HOLD_MS + 50);
    expect(r.m.up({ id: 1, x: 640, y: 650, t: r.at() }, false)).toEqual({ tap: false, swallow: true });
  });

  it("a diagonal drift on a pinned stage stays claimed after the pointer lifts, until the next touch", () => {
    const r = rig();
    r.m.goTo(1);
    r.run(800);
    // 80 px across, 60 down in 120 ms: the swipe hook's own test (|dx| > |dy|, ≥ 50 px, quick) would take it.
    r.m.down({ id: 1, x: 400, y: 200, t: r.at(), zone: "stage" });
    for (let i = 1; i <= 5; i++) {
      r.tick(24);
      r.m.move({ id: 1, x: 400 + i * 16, y: 200 + i * 12, t: r.at() });
    }
    r.m.up({ id: 1, x: 480, y: 260, t: r.at() }, false);
    // the swipe hook reads the claim at touchend, which comes after pointerup
    expect(r.m.claimed()).toBe(true);
    r.m.down({ id: 2, x: 400, y: 200, t: r.at(), zone: "stage" });
    expect(r.m.claimed()).toBe(false);
  });

  it("a sideways drag on the band is claimed, and a touch the sheet doesn't take after it clears that", () => {
    const r = rig();
    r.m.down({ id: 1, x: 640, y: 650, t: r.at(), zone: "band" });
    for (let i = 1; i <= 5; i++) {
      r.tick(16);
      r.m.move({ id: 1, x: 640 - i * 50, y: 650, t: r.at() });
    }
    r.m.up({ id: 1, x: 390, y: 650, t: r.at() }, false);
    expect(r.m.claimed()).toBe(true);
    // the next touch lands on the stage at Now, which the sheet doesn't take
    r.m.clearClaim();
    expect(r.m.claimed()).toBe(false);
  });

  it("a swipe on a pinned stage is not claimed", () => {
    const r = rig();
    r.m.goTo(1);
    r.run(800);
    r.m.down({ id: 1, x: 400, y: 200, t: r.at(), zone: "stage" });
    for (let i = 1; i <= 5; i++) {
      r.tick(16);
      r.m.move({ id: 1, x: 400 - i * 30, y: 200 + i * 2, t: r.at() });
    }
    r.m.up({ id: 1, x: 250, y: 210, t: r.at() }, false);
    expect(r.m.claimed()).toBe(false);
    expect(r.m.pinned).toBe(1);
  });

  it("a pull on a pinned stage is claimed, so it moves no step", () => {
    const r = rig();
    r.m.goTo(1);
    r.run(800);
    r.m.down({ id: 1, x: 400, y: 200, t: r.at(), zone: "stage" });
    for (let i = 1; i <= 5; i++) {
      r.tick(40);
      r.m.move({ id: 1, x: 400 + i * 3, y: 200 - i * 20, t: r.at() });
    }
    r.m.up({ id: 1, x: 415, y: 100, t: r.at() }, false);
    expect(r.m.claimed()).toBe(true);
  });
});

describe("SheetMotion: glides", () => {
  it("one level glides in 400 ms, more in 520 ms, Esc's way to Now included", () => {
    const r = rig();
    r.m.goTo(1);
    r.run(390);
    expect(r.settled).toEqual([]);
    r.run(40);
    expect(r.settled).toEqual([1]);
    r.m.goTo(2);
    r.run(390);
    expect(r.settled).toEqual([1]);
    r.run(40);
    expect(r.settled).toEqual([1, 2]);
    // chart to Now (Esc): the 520 ms glide, nothing unfits first
    r.m.goTo(0);
    r.run(500);
    expect(r.settled).toEqual([1, 2]);
    expect(r.m.Y).toBeGreaterThan(r.D[2]);
    expect(r.m.Y).toBeLessThan(r.D[0]);
    r.run(40);
    expect(r.settled.at(-1)).toBe(0);
    expect(r.m.Y).toBe(r.D[0]);
  });

  it("the opening's Start is a cut under a 320 ms cross-fade (200 reduced), never a glide through the stretch (N3-3)", () => {
    for (const reduced of [false, true]) {
      const fadeMs: (number | undefined)[] = [];
      const r = rig({ reduced, onFade: (ms) => fadeMs.push(ms) });
      r.m.goTo(2);
      r.run(600);
      const painted = r.painted.length;
      // Reduced motion reaches the chart by its own cross-fade: only the jump's counts.
      fadeMs.length = 0;
      r.m.jump(0);
      expect(fadeMs).toEqual([reduced ? 200 : 320]);
      expect(r.m.pinned).toBe(0);
      expect(r.m.base).toBe(0);
      expect(r.settled.at(-1)).toBe(0);
      expect(r.m.Y).toBe(r.D[0]);
      r.run(600);
      // nothing was drawn between the chart and Now
      expect(r.painted.slice(painted).every((y) => y === r.D[0])).toBe(true);
    }
  });

  it("Whole recipe is no detent: the edge stays where it stands under it, and leaving puts it at the level asked at once", () => {
    const r = rig();
    r.m.goTo(2);
    r.run(600);
    const painted = r.painted.length;
    r.m.goTo(3);
    expect(r.m.pinned).toBe(3);
    expect(r.settled.at(-1)).toBe(3);
    expect(r.m.base).toBe(2);
    expect(r.m.Y).toBe(r.D[2]);
    expect(r.m.d).toBe(2);
    r.run(600);
    expect(r.painted.slice(painted).every((y) => y === r.D[2])).toBe(true);
    // a reflow under it keeps the edge on the chart
    r.m.reflow();
    expect(r.m.Y).toBe(r.D[2]);
    // "Back to cooking": straight to Now, no glide behind the screen's fade
    r.m.goTo(0);
    expect(r.m.pinned).toBe(0);
    expect(r.settled.at(-1)).toBe(0);
    expect(r.m.Y).toBe(r.D[0]);
  });

  it("Whole recipe opened mid-glide stands the edge at the glide's level", () => {
    const r = rig();
    r.m.goTo(1);
    r.run(160);
    r.m.goTo(3);
    expect(r.m.base).toBe(1);
    expect(r.m.Y).toBe(r.D[1]);
    r.run(600);
    expect(r.m.Y).toBe(r.D[1]);
    // back to the level under it settles with no motion
    r.m.goTo(1);
    expect(r.settled.at(-1)).toBe(1);
    expect(r.m.Y).toBe(r.D[1]);
  });

  it("no pull starts at Whole recipe", () => {
    const r = rig();
    r.m.goTo(3);
    r.m.down({ id: 1, x: 640, y: 650, t: r.at(), zone: "band" });
    for (let i = 1; i <= 5; i++) {
      r.tick(16);
      expect(r.m.move({ id: 1, x: 640, y: 650 - i * 40, t: r.at() })).toBe(false);
    }
    expect(r.m.pulling).toBe(false);
    r.m.up({ id: 1, x: 640, y: 450, t: r.at() }, false);
    expect(r.m.pinned).toBe(3);
  });

  it("a glide straight between Now and the chart passes the stretch (T3); one level, a pull and the landing don't", () => {
    const r = rig();
    const from = (n: number) => r.passes.slice(n);
    let n = r.passes.length;
    r.m.goTo(2);
    r.run(600);
    const down = from(n);
    // every frame on the way passes; the frame it lands on is the level's own (the two agree there)
    expect(down.slice(0, -1).length).toBeGreaterThan(5);
    expect(down.slice(0, -1).every((w) => w === 1)).toBe(true);
    expect(down[down.length - 1]).toBe(0);
    n = r.passes.length;
    r.m.goTo(0);
    r.run(600);
    expect(from(n).slice(0, -1).every((w) => w === 1)).toBe(true);
    n = r.passes.length;
    r.m.goTo(1);
    r.run(600);
    expect(from(n).every((w) => w === 0)).toBe(true);
  });

  /**
   * No frame jumps from the one before it: the pass's weight moves by at most `step` a 16 ms frame
   * (the DS curve's steepest frame over an entry's 280 ms is about 0.23; the pop was 1 in one).
   */
  const smooth = (ws: number[], step = 0.3) => ws.every((w, i) => i === 0 || Math.abs(w - ws[i - 1]) <= step);

  it("a pass cut short by a key carries on from where it is drawn: its weight eases out on the way to the stretch (fix round)", () => {
    const r = rig();
    r.m.goTo(2);
    r.run(600);
    // Escape at the chart, then ↑ 120 ms into the pass to Now.
    r.m.goTo(0);
    r.run(120);
    const n = r.passes.length;
    const before = r.passes[n - 1];
    expect(before).toBe(1);
    r.m.goTo(1);
    r.run(600);
    const after = [before, ...r.passes.slice(n)];
    expect(smooth(after), after.map((w) => w.toFixed(2)).join(" ")).toBe(true);
    expect(after[after.length - 1]).toBe(0);
    expect(r.settled.at(-1)).toBe(1);
    // Re-aimed at an end, a cut pass keeps its weight: the ends are drawn the same either way.
    r.m.goTo(0);
    r.run(600);
    r.m.goTo(2);
    r.run(120);
    const k = r.passes.length;
    r.m.goTo(0);
    r.run(600);
    const back = [r.passes[k - 1], ...r.passes.slice(k)];
    // Every frame on the way keeps the pass; the landing frame is Now's own, drawn the same as the pass's there.
    expect(back.slice(0, -1).every((w) => w === 1), back.join(" ")).toBe(true);
    expect(back[back.length - 1]).toBe(0);
    expect(r.m.Y).toBe(r.D[0]);
  });

  it("a finger that grabs a pass carries it on: the frames under it keep the drawn weight, the landing eases it out (fix round)", () => {
    const r = rig();
    r.m.goTo(2);
    r.run(600);
    // On the way back to Now, between Now and the stretch, a finger takes the sheet.
    r.m.goTo(0);
    while (r.m.Y < r.D[1] + 60) r.run(16);
    const n = r.passes.length;
    expect(r.passes[n - 1]).toBe(1);
    const y = r.m.Y;
    r.m.down({ id: 1, x: 640, y, t: r.at(), zone: "sheet" });
    // It flicks the sheet up toward the stretch.
    for (let i = 1; i <= 6; i++) {
      r.tick(16);
      r.m.move({ id: 1, x: 640, y: y - i * 10, t: r.at() });
    }
    const held = r.passes.slice(n);
    expect(held.length).toBeGreaterThan(3);
    expect(held.every((w) => w === 1), held.join(" ")).toBe(true);
    // Let go mid-flick: it settles on the stretch, the weight easing to the stretch's own.
    r.tick(16);
    r.m.up({ id: 1, x: 640, y: y - 70, t: r.at() }, false);
    r.run(1400);
    expect(r.settled.at(-1)).toBe(1);
    const all = [held[held.length - 1], ...r.passes.slice(n + held.length)];
    expect(smooth(all), all.map((w) => w.toFixed(2)).join(" ")).toBe(true);
    expect(all[all.length - 1]).toBe(0);
  });

  it("rest is no motion: a glide turned back to the level it left is moving until it lands there (T3 follow-up)", () => {
    const r = rig();
    r.m.goTo(2);
    r.run(600);
    expect(r.m.resting).toBe(true);
    r.m.goTo(1);
    r.run(100);
    r.m.goTo(2);
    // Pinned where it started and settled there still, but on its way back: not at rest.
    expect([r.m.pinned, r.m.settled]).toEqual([2, 2]);
    expect(r.m.resting).toBe(false);
    r.run(600);
    expect(r.m.Y).toBe(r.D[2]);
    expect(r.m.resting).toBe(true);
    // A finger down is no rest either, until it lifts.
    r.m.down({ id: 1, x: 640, y: 200, t: r.at(), zone: "sheet" });
    expect(r.m.touching).toBe(true);
    expect(r.m.resting).toBe(false);
    r.m.up({ id: 1, x: 640, y: 200, t: r.at() + 50 }, false);
    expect(r.m.touching).toBe(false);
    expect(r.m.resting).toBe(true);
  });

  it("a glide interpolates: the edge passes through the levels between", () => {
    const r = rig();
    r.m.goTo(2);
    r.run(520);
    const between = r.painted.filter((y) => y < r.D[0] - 5 && y > r.D[2] + 5);
    expect(between.length).toBeGreaterThan(10);
  });

  it("under reduced motion nothing follows the finger, and a pull up goes one level deeper", () => {
    const r = rig({ reduced: true });
    r.m.down({ id: 1, x: 640, y: 650, t: r.at(), zone: "band" });
    for (let i = 1; i <= 10; i++) {
      r.tick(100);
      r.m.move({ id: 1, x: 640, y: 650 - i * 10, t: r.at() });
    }
    expect(r.m.Y).toBe(r.D[0]);
    r.m.up({ id: 1, x: 640, y: 550, t: r.at() }, false);
    expect(r.m.pinned).toBe(1);
    expect(r.fades()).toBe(1);
  });

  it("a new layout mid-pull (a rotation) cancels the pull and redraws the prior level", () => {
    const r = rig();
    r.m.down({ id: 1, x: 640, y: 650, t: r.at(), zone: "band" });
    for (let i = 1; i <= 4; i++) {
      r.tick(30);
      r.m.move({ id: 1, x: 640, y: 650 - i * 40, t: r.at() });
    }
    r.m.reflow();
    expect(r.m.Y).toBe(r.D[0]);
    expect(r.m.up({ id: 1, x: 640, y: 400, t: r.at() }, false)).toEqual({ tap: false, swallow: false });
    expect(r.m.pinned).toBe(0);
  });
});
