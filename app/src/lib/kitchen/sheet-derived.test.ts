import { describe, expect, it } from "vitest";
import { strip, toTableCountdown } from "./cook-strip";
import { initialCookState, next, type CookState } from "./cook-view";
import type { CookPlan } from "./cook-plan";
import { SIDE } from "./overview-place";
import { buildTimetable } from "./timetable-model";
import { nowOn } from "./timetable-layout";
import { advanceMeasure } from "./__tests__/advance-measure";
import { timetableCorpus } from "./__tests__/timetable-corpus";
import { buildLayout, frameAt, type Frame, type LayoutInput, type Measure, type SheetGeo, type SheetLayout } from "./sheet-layout";
import { LINE_FROM_FOOT, SHEET1_ABOVE_LINE, lineFill } from "./strip-map";
import { BAND0, TT_PLATE } from "./sheet-derived";

/** The browser's metrics, from the faces' own advances (px in, px out). */
const measure: Measure = (text, px, weight, family) => advanceMeasure(text, px, weight, family);

const VIEWPORTS = [
  { name: "1280×800", W: 1280, H: 800 },
  { name: "1280×680", W: 1280, H: 680 },
  { name: "800×1280", W: 800, H: 1280 },
];

function geoFor(W: number, H: number): SheetGeo {
  const c = Math.min(Math.max(W, H) / 960, Math.min(W, H) / 600);
  const top = 92 * c;
  return { W, H, c, E: 48, top, stepTop: top + (H > W ? 58 : 12) * c, footTop: H - 100 * c, ledgeTop: H - 96 * c, portrait: H > W };
}

/** The sheet's input as CookSheet makes it: the strip, the timetable of both modes, the plan's tasks. */
function inputFor(plan: CookPlan, state: CookState, W: number, H: number, o: { step?: boolean; opening?: boolean; topLine?: boolean } = {}): LayoutInput {
  const g = geoFor(W, H);
  const s = strip(plan, state, null);
  const mode = state.mode ?? "first";
  const first = mode === "first" ? s : strip(plan, initialCookState("first"), null);
  const go = mode === "go" ? s : strip(plan, initialCookState("go"), null);
  const t = buildTimetable(plan, first, go, mode);
  const other = buildTimetable(plan, first, go, mode === "first" ? "go" : "first", { now: 0 });
  // A three-line step at 64 cpx with its meta under it, at its rest fit.
  const keepH = 3 * 64 * 1.15 * g.c;
  return {
    strip: s,
    geo: g,
    step: o.step === false ? null : { textH: keepH, keepH, fullH: keepH + 60 * g.c, inkW: g.W - 2 * g.E, restFit: 1, text: "Sear the beef" },
    nudge: null,
    read: null,
    opening: o.opening ? { getOut: [], scaleNote: null } : null,
    timetable: t && other ? { t, other } : null,
    title: "Sunday roast dinner",
    chrome: { more: { w: 56 * g.c, h: 56 * g.c }, controls: o.opening ? { w: 268 * g.c, h: 64 * g.c } : null, hint: false },
    measure,
    tasks: new Map(plan.tasks.map((x) => [x.id, x])),
    topLine: o.topLine,
  };
}

const corpus = timetableCorpus();
const plan = (name: string) => corpus.find((c) => c.name === name)!.plan;
const roast = plan("sunday-roast-dinner");
const at = (p: CookPlan, pos: number, mode: "first" | "go" = "first") => {
  let s = initialCookState(mode);
  for (let i = 0; i < pos; i++) s = next(p, s);
  return s;
};
/** The frame at depth d, on the way the sheet's edge runs (a pull, never a pass). */
const atDepth = (L: SheetLayout, d: number, extra: { now?: number; progress?: number; pass?: number } = {}): Frame => {
  const [Y0, Y1, Y2] = L.detents;
  const Y = d <= 1 ? Y0 + (Y1 - Y0) * d : Y1 + (Y2 - Y1) * (d - 1);
  return frameAt(L, { Y, ...extra });
};
const EPS = 0.5;
/** The roast's minutes to the table at a position, as the strip counts them. */
const roastLeft = (pos: number) => {
  const s = strip(roast, at(roast, pos), null);
  return s.totalMinutes - s.now;
};

describe("a derived plan's sheet: the line that never moves (SPEC §10, T3)", () => {
  for (const vp of VIEWPORTS) {
    it(`at ${vp.name} the line is level 2's last track, ${LINE_FROM_FOOT} cpx over the foot; the detents hang from it`, () => {
      for (const pos of [0, 2, 5, 9]) {
        const L = buildLayout(inputFor(roast, at(roast, pos), vp.W, vp.H));
        const g = L.geo;
        const D = L.derived!;
        expect(D, "derived").not.toBeNull();
        expect(D.lineY).toBeCloseTo(g.footTop - LINE_FROM_FOOT * g.c, 3);
        const above = g.portrait ? SHEET1_ABOVE_LINE.portrait : SHEET1_ABOVE_LINE.landscape;
        // Level 0 keeps as written's band (80 over the foot); the line's 52 target, centred on it,
        // reaches no more than 2 into the stage.
        expect(L.detents[0]).toBeCloseTo(g.footTop - BAND0 * g.c, 6);
        expect(L.band).toBeCloseTo(BAND0 * g.c, 6);
        expect(D.lineY - 26 * g.c).toBeGreaterThanOrEqual(L.detents[0] - 2 * g.c - 1e-6);
        expect(L.detents[1]).toBeCloseTo(D.lineY - above * g.c, 6);
        expect(L.detents[2]).toBe(0);
        expect(D.paper).toEqual([g.H + 10 * g.c, L.detents[1], 18 * g.c]);
        // The level-1 sheet stands under the top line.
        expect(L.detents[1]).toBeGreaterThan(g.top);
      }
    });
  }

  it("at level 0 the line runs margin to margin, filled to the end of the step in hand, which the clock's minutes don't move; nothing is laid out again for it", () => {
    for (const vp of VIEWPORTS) {
      const state = at(roast, 5);
      const L = buildLayout(inputFor(roast, state, vp.W, vp.H));
      const g = L.geo;
      const D = L.derived!;
      const F = atDepth(L, 0);
      expect(F.derived!.line.x).toBeCloseTo(SIDE * g.c, 6);
      expect(F.derived!.line.w).toBeCloseTo(g.W - 2 * SIDE * g.c, 6);
      expect(F.derived!.line.ink).toBe(0);
      // The end of the step in hand (asked 2026-11-22, v1.54), past the step's start.
      const s = strip(roast, state, null);
      expect(D.progress).toBe(s.progress);
      expect(s.progress).toBeGreaterThan(s.now);
      expect(F.derived!.line.fill).toBeCloseTo(lineFill(D.total, s.progress, D.line0.x0, D.line0.x1), 6);
      expect(F.derived!.fill, "as painted").toBe(F.derived!.line.fill);
      // The clock walks on (a timer's minutes): the fill at rest stands where it is, from the same layout.
      const later = atDepth(L, 0, { now: L.now + 7 });
      expect(later.derived!.line.fill).toBe(F.derived!.line.fill);
      expect(later.derived!.fill).toBe(F.derived!.fill);
      // The clock's strip moving its end (said at a paint, nothing laid out) moves the fill.
      const on = atDepth(L, 0, { progress: s.progress + 7 });
      expect(on.derived!.fill).toBeCloseTo(lineFill(D.total, s.progress + 7, D.line0.x0, D.line0.x1), 6);
      expect(on.derived!.fill).toBeGreaterThan(F.derived!.fill);
      // At level 1 the line is as laid, the map's rail; at level 2 the timetable's track, its fill
      // following the clock as level 0's does (T3 follow-up: the now line is the fill's end).
      expect(atDepth(L, 1, { now: L.now + 7 }).derived!.line).toEqual(atDepth(L, 1).derived!.line);
      const two = atDepth(L, 2, { now: L.now + 7 }).derived!.line;
      const fill = nowOn(L.overview!.drawing.clock!, L.now + 7).fills.get(D.line2.keys[1])! * g.c;
      expect(two).toEqual({ ...atDepth(L, 2).derived!.line, fill });
      // (portrait's last row starts later in the cook: its fill is still empty here)
      if (!g.portrait) expect(fill).toBeGreaterThan(D.line2.fill);
    }
  });

  it("the painted fill: the end of the step in hand at every level, the whole cook included, whatever the clock says (v1.63: the glide retires)", () => {
    for (const vp of VIEWPORTS) {
      for (const pass of [0, 1]) {
        const state = at(roast, 5);
        const L = buildLayout(inputFor(roast, state, vp.W, vp.H));
        const D = L.derived!;
        const s = strip(roast, state, null);
        // A timer's minutes on the clock: now walks on from the step's start, short of or past its end.
        for (const now of [s.now, s.now + 3, s.progress + 9]) {
          const end = lineFill(D.total, s.progress, D.line0.x0, D.line0.x1);
          const fillAt = (d: number) => atDepth(L, d, { now, pass }).derived!.fill;
          for (const d of [0, 0.01, 0.3, 0.7, 0.99, 1, 1.3, 1.45, 1.9, 1.999, 2]) expect(fillAt(d), `depth ${d}`).toBe(end);
        }
      }
    }
  });

  it("on the last step the painted line is full at rest and under the peek, on every plan", () => {
    const vp = VIEWPORTS[0];
    for (const p of [roast, plan("indian-dal-tadka")]) {
      let state = initialCookState("first");
      for (let i = 0; i < 80; i++) {
        const after = next(p, state);
        if (after.pos === state.pos) break;
        state = after;
      }
      const L = buildLayout(inputFor(p, state, vp.W, vp.H));
      const D = L.derived!;
      for (const d of [0, 0.5, 1]) expect(atDepth(L, d).derived!.fill).toBeCloseTo(D.line0.x1 - D.line0.x0, 6);
      expect(strip(p, state, null).now).toBeLessThan(D.total);
    }
  });

  it("at level 1 the fill folds into now and the line turns Ink, the rail from now's dot to the plate; at level 2 it is the last track again", () => {
    for (const vp of VIEWPORTS) {
      const L = buildLayout(inputFor(roast, at(roast, 5), vp.W, vp.H));
      const c = L.geo.c;
      const D = L.derived!;
      const F1 = atDepth(L, 1).derived!;
      expect(F1.line).toEqual({ x: D.map.rail.x0 * c, w: (D.map.rail.x1 - D.map.rail.x0) * c, fill: 0, ink: 1 });
      const F2 = atDepth(L, 2).derived!;
      expect(F2.line).toEqual({ x: D.line2.x0, w: D.line2.x1 - D.line2.x0, fill: D.line2.fill, ink: 0 });
      // The timetable's own drawing of that track is the line's: it hides those two marks.
      const keys = new Set(D.line2.keys);
      expect(L.overview!.drawing.marks.filter((m) => keys.has(m.k)).map((m) => m.role).sort()).toEqual(["track", "track-fill"]);
    }
  });
});

describe("a derived plan's sheet: the transitions (SPEC §11)", () => {
  const L = buildLayout(inputFor(roast, at(roast, 5), 1280, 800));
  const g = L.geo;

  it("0 → 1: the Paper rises from under the screen, the stations fade in over the second half", () => {
    expect(atDepth(L, 0).derived!.paperTop).toBeGreaterThanOrEqual(g.H);
    expect(atDepth(L, 1).derived!.paperTop).toBeCloseTo(L.detents[1], 6);
    expect(atDepth(L, 0).derived!.stations).toBe(0);
    expect(atDepth(L, 0.5).derived!.stations).toBe(0);
    expect(atDepth(L, 0.75).derived!.stations).toBeGreaterThan(0);
    expect(atDepth(L, 1).derived!.stations).toBe(1);
    for (const d of [0, 0.5, 1]) {
      expect(atDepth(L, d).derived!.grow, `grow at ${d}`).toBe(0);
      expect(atDepth(L, d).derived!.lanes, `timetable at ${d}`).toBe(0);
    }
  });

  it("1 → 2: the stations go fast, the marks grow out of the line, the words after them; the Paper reaches 18", () => {
    expect(atDepth(L, 1.15).derived!.stations).toBe(0);
    expect(atDepth(L, 1.1).derived!.stations).toBeGreaterThan(0);
    expect(atDepth(L, 1.05).derived!.lanes).toBe(1);
    expect(atDepth(L, 1.5).derived!.grow).toBeCloseTo(0.5, 6);
    expect(atDepth(L, 1.5).derived!.words).toBe(0);
    expect(atDepth(L, 1.8).derived!.words).toBeGreaterThan(0);
    expect(atDepth(L, 2).derived!.grow).toBe(1);
    expect(atDepth(L, 2).derived!.words).toBe(1);
    expect(atDepth(L, 2).derived!.paperTop).toBeCloseTo(18 * g.c, 6);
    // The step fades out on the way; the top line gives way to the timetable's words.
    expect(atDepth(L, 2).step!.op).toBe(0);
    expect(atDepth(L, 2).header).toBe(0);
    expect(atDepth(L, 1).header).toBe(1);
  });

  it("a glide straight between 0 and 2 passes level 1: no station shows, the line goes from track to track", () => {
    for (const d of [0.25, 0.5, 1, 1.2, 1.6]) expect(atDepth(L, d, { pass: 1 }).derived!.stations, `at ${d}`).toBe(0);
    // Through level 1's depth the line never turns Ink, nor shrinks to the rail.
    const mid = atDepth(L, 1, { pass: 1 }).derived!.line;
    expect(mid.ink).toBe(0);
    const P0 = atDepth(L, 0).derived!.line;
    const P2 = atDepth(L, 2).derived!.line;
    expect(mid.w).toBeCloseTo((P0.w + P2.w) / 2, 6);
    expect(mid.x).toBeCloseTo((P0.x + P2.x) / 2, 6);
    // Time to the table waits at the header and fades in there.
    const tt1 = atDepth(L, 1, { pass: 1 }).tt;
    expect(tt1.op).toBe(0);
    const tt2 = atDepth(L, 2, { pass: 1 }).tt;
    expect(tt2.op).toBe(1);
    expect(tt2.y + L.detents[2]).toBeCloseTo(L.P[2].tt.top + L.detents[2], 6);
  });

  it("a pass cut short is drawn between the pass and the levels' own by its weight, and the two agree at Now and the chart (fix round)", () => {
    const close = (a: Frame, b: Frame) =>
      Math.abs(a.derived!.line.x - b.derived!.line.x) +
      Math.abs(a.derived!.line.w - b.derived!.line.w) +
      Math.abs(a.derived!.line.ink - b.derived!.line.ink) * 100 +
      Math.abs(a.derived!.stations - b.derived!.stations) * 100 +
      Math.abs(a.tt.op - b.tt.op) * 100 +
      (a.tt.op > 0.01 || b.tt.op > 0.01 ? Math.abs(a.tt.x - b.tt.x) + Math.abs(a.tt.y - b.tt.y) : 0);
    for (const d of [0.3, 0.7, 1, 1.4]) {
      const own = atDepth(L, d, { pass: 0 });
      const pass = atDepth(L, d, { pass: 1 });
      const half = atDepth(L, d, { pass: 0.5 });
      // Halfway in weight is halfway in what it draws.
      expect(half.derived!.stations, `at ${d}`).toBeCloseTo((own.derived!.stations + pass.derived!.stations) / 2, 6);
      expect(half.derived!.line.ink, `at ${d}`).toBeCloseTo((own.derived!.line.ink + pass.derived!.line.ink) / 2, 6);
      expect(half.derived!.line.x, `at ${d}`).toBeCloseTo((own.derived!.line.x + pass.derived!.line.x) / 2, 6);
      expect(half.tt.op, `at ${d}`).toBeCloseTo((own.tt.op + pass.tt.op) / 2, 6);
      // A little weight is a little change: 2% of the weight moves the picture 2% of the way, no pop.
      expect(close(atDepth(L, d, { pass: 0.98 }), pass), `at ${d}`).toBeLessThanOrEqual(0.0201 * close(own, pass) + 1e-6);
    }
    // At the ends the pass and the levels' own frames are one picture: landing there drops the weight unseen.
    for (const d of [0, 2]) expect(close(atDepth(L, d, { pass: 0 }), atDepth(L, d, { pass: 1 })), `at ${d}`).toBeLessThan(0.01);
  });

  it("the step stays clear of the rising Paper all the way up, and stands at its level-1 scale", () => {
    for (const vp of VIEWPORTS) {
      const M = buildLayout(inputFor(roast, at(roast, 5), vp.W, vp.H));
      const st = M.step!;
      const floor = Math.min(1, 22 / (64 * st.fit1 / st.sc1));
      for (let d = 0; d <= 1.0001; d += 0.05) {
        const F = atDepth(M, d);
        const bottom = M.geo.stepTop + st.keepH * F.step!.scale;
        if (F.step!.scale > floor + 1e-6) expect(bottom + 22 * M.geo.c, `${vp.name} at ${d.toFixed(2)}`).toBeLessThanOrEqual(Math.min(F.derived!.paperTop, M.detents[0]) + EPS);
      }
      expect(atDepth(M, 1).step!.scale).toBeCloseTo(st.sc1, 6);
    }
  });

  it("time to the table: none at level 0; on the plate at 1 in landscape, the header's place in portrait; the header at 2; continuous between", () => {
    for (const vp of VIEWPORTS) {
      const M = buildLayout(inputFor(roast, at(roast, 5), vp.W, vp.H));
      const c = M.geo.c;
      const D = M.derived!;
      expect(atDepth(M, 0).tt.op).toBe(0);
      const F1 = atDepth(M, 1);
      expect(F1.tt.op).toBe(1);
      const num = D.map.words.find((w) => w.role === "tt-num")!;
      const words = D.map.words.find((w) => w.role === "tt-words")!;
      // Where the map set it, on screen: the sheet's edge is level 1's detent.
      expect(F1.tt.x).toBeCloseTo(num.x * c, 4);
      expect(F1.tt.y + M.detents[1]).toBeCloseTo(D.lineY + num.y * c, 4);
      expect(F1.tt.wx).toBeCloseTo((words.x - num.x) * c, 4);
      if (D.map.ttAt === "plate") {
        expect(M.geo.portrait).toBe(false);
        expect(F1.tt.n).toBeCloseTo(M.tt.sizes[TT_PLATE].n, 6);
        // "to the table" stands under the rail.
        expect(D.lineY + (num.y * c + F1.tt.n + F1.tt.wy)).toBeGreaterThan(D.lineY);
      } else {
        expect(M.geo.portrait).toBe(true);
        expect(F1.tt.wx).toBeCloseTo(0, 4);
        expect(F1.tt.wy).toBeCloseTo(0, 4);
      }
      const F2 = atDepth(M, 2);
      expect(F2.tt.x).toBeCloseTo(M.overview!.tt.x, 6);
      expect(F2.tt.y).toBeCloseTo(M.overview!.tt.top, 6);
      expect(F2.tt.wx).toBe(0);
      expect(F2.tt.wy).toBe(0);
      for (let d = 0.02; d < 2; d += 0.02) {
        const a = atDepth(M, d - 0.005).tt;
        const b = atDepth(M, d + 0.005).tt;
        expect(Math.abs(a.x - b.x) + Math.abs(a.y + 0 - b.y), `${vp.name} at ${d.toFixed(2)}`).toBeLessThan(20 * c);
      }
    }
  });

  it("time to the table: its box holds every count the clock says before the next layout (call 13)", () => {
    for (const vp of VIEWPORTS) {
      // Far enough from the table that the count crosses the hour: "1 h" gives way to the wider "55 min".
      const pos = [...Array(12).keys()].find((p) => {
        const s = strip(roast, at(roast, p), null);
        return s.totalMinutes - s.now > 62;
      })!;
      const M = buildLayout(inputFor(roast, at(roast, pos), vp.W, vp.H));
      const c = M.geo.c;
      const says = toTableCountdown(M.tt.num === "Ready" ? 0 : roastLeft(pos));
      const n = M.tt.sizes[1].n;
      const w = (s: string, size = n) => measure(s, size, 400, "display");
      // The precondition: something it will say is wider than what it says now.
      expect(says.some((s) => w(s) > w(M.tt.num) + 1)).toBe(true);
      for (const s of says) {
        expect(M.tt.numEm * n, `${vp.name}: "${s}"`).toBeGreaterThanOrEqual(w(s) - 1e-6);
        // Every place is measured with it: the header's block and the plate's number.
        expect(M.tt.dims[2].w).toBeGreaterThanOrEqual(w(s, M.tt.sizes[2].n) - 1e-6);
      }
      expect(w(M.tt.widest)).toBeCloseTo(Math.max(...says.map((s) => w(s))), 6);
      const D = M.derived!;
      const num = D.map.words.find((x) => x.role === "tt-num")!;
      expect(num.w * c).toBeCloseTo(w(M.tt.widest, num.size * c), 4);
      if (D.map.ttAt === "plate") {
        // Right-set over the ring: the box's right edge is the plate's, whatever the count says.
        const plate = D.map.stations.find((s) => s.key === "plate")!;
        expect(num.x + num.w).toBeCloseTo(plate.x + 17, 6);
      }
    }
  });

  it("the opening is the timetable whole: no line of its own to grow from, no stations, the words in", () => {
    const O = buildLayout(inputFor(roast, initialCookState("first"), 1280, 800, { opening: true, step: false }));
    for (const k of [0, 1, 2]) {
      const F = frameAt(O, { Y: O.detents[k] });
      expect(F.derived!.stations).toBe(0);
      expect(F.derived!.grow).toBe(1);
      expect(F.derived!.words).toBe(1);
      expect(F.header).toBe(0);
    }
  });
});

describe("a derived plan's sheet across the corpus × 3 screens: the map fits where the sheet puts it", () => {
  it("every step of every cook: the map fits (portrait's chain included), its words over the Paper, under the grabber, over the foot", () => {
    const breaches: string[] = [];
    const rungs = new Map<number, number>();
    let n = 0;
    for (const { name, plan: p } of corpus) {
      for (const mode of ["first", "go"] as const) {
        let s = initialCookState(mode);
        for (let i = 0; i < 60; i++) {
          const st = strip(p, s, null);
          if (st.asWritten) break;
          for (const vp of VIEWPORTS) {
            const L = buildLayout(inputFor(p, s, vp.W, vp.H));
            const D = L.derived!;
            const c = L.geo.c;
            const where = `${name} ${mode} pos ${s.pos} ${vp.name}`;
            n++;
            if (vp.H > vp.W) rungs.set(D.map.rung, (rungs.get(D.map.rung) ?? 0) + 1);
            if (!D.map.fits) breaches.push(`${where}: rung ${D.map.rung}, no fit`);
            for (const w of D.map.words) {
              const top = D.lineY + w.y * c;
              const header = D.map.ttAt === "header" && (w.role === "tt-num" || w.role === "tt-words");
              if (!header && top < L.detents[1] + 24 * c - EPS) breaches.push(`${where}: ${w.k} under the grabber`);
              if (top < L.detents[1] - EPS) breaches.push(`${where}: ${w.k} over the Paper's top`);
              if (top + w.h * c > L.geo.footTop + EPS) breaches.push(`${where}: ${w.k} under the foot`);
              if (w.x * c < -EPS || (w.x + w.w) * c > L.geo.W + EPS) breaches.push(`${where}: ${w.k} off the screen`);
            }
          }
          if (!st.marks.some((m) => m.state === "in-hand")) break;
          const nx = next(p, s);
          if (nx.pos === s.pos) break;
          s = nx;
        }
      }
    }
    console.info(`sheet, portrait rungs: ${[...rungs].sort((a, b) => a[0] - b[0]).map(([r, k]) => `${r}: ${k}`).join(", ")}`);
    expect(n).toBeGreaterThan(500);
    expect(breaches.slice(0, 30)).toEqual([]);
  }, 30_000);
});
