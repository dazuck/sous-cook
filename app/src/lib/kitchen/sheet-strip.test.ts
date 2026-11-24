import { describe, expect, it } from "vitest";
import { strip } from "./cook-strip";
import { initialCookState, next, type CookState } from "./cook-view";
import { identityPlan, type CookPlan } from "./cook-plan";
import { buildTimetable } from "./timetable-model";
import { advanceMeasure } from "./__tests__/advance-measure";
import { timetableCorpus } from "./__tests__/timetable-corpus";
import { buildLayout, frameAt, type LayoutInput, type Measure, type SheetGeo, type SheetLayout } from "./sheet-layout";
import { peekOf } from "./cook-peek";
import { PEEK_IN, PEEK_LEAVE, inHandKey, keyLevel, sheetArrowTargets, sheetArrows, stripTap } from "./sheet-strip";
import { SheetMotion, type Level, type MotionHost } from "./sheet-motion";

const measure: Measure = (text, px, weight, family) => advanceMeasure(text, px, weight, family);

/** The three shapes: the tablet both ways, and a phone. */
const SCREENS = [
  { name: "tablet 1280×800", W: 1280, H: 800 },
  { name: "tablet upright 800×1280", W: 800, H: 1280 },
  { name: "phone 390×844", W: 390, H: 844 },
];

function geoFor(W: number, H: number): SheetGeo {
  const c = Math.min(Math.max(W, H) / 960, Math.min(W, H) / 600);
  const top = 92 * c;
  return { W, H, c, E: 44 * c, top, stepTop: top + (H > W ? 58 : 12) * c, footTop: H - 100 * c, ledgeTop: H - 96 * c, portrait: H > W };
}

/** The sheet's input as CookSheet makes it, with the foot's middle cell as the strip's line and the peek's rows. */
function inputFor(plan: CookPlan, state: CookState, W: number, H: number, o: { strip?: boolean; keepH?: number; restFit?: number } = {}): LayoutInput {
  const g = geoFor(W, H);
  const s = strip(plan, state, null);
  const mode = state.mode ?? "first";
  const first = mode === "first" ? s : strip(plan, initialCookState("first"), null);
  const go = mode === "go" ? s : strip(plan, initialCookState("go"), null);
  const t = s.asWritten ? null : buildTimetable(plan, first, go, mode);
  const other = s.asWritten ? null : buildTimetable(plan, first, go, mode === "first" ? "go" : "first", { now: 0 });
  const restFit = o.restFit ?? 1;
  const keepH = o.keepH ?? 3 * 64 * 1.15 * g.c;
  const withStrip = o.strip !== false;
  return {
    strip: s,
    geo: g,
    step: { textH: keepH, keepH, fullH: keepH + 60 * g.c, inkW: g.W - 2 * g.E, restFit, text: "Sear the beef" },
    nudge: null,
    read: null,
    opening: null,
    timetable: t && other ? { t, other } : null,
    title: "Sunday roast dinner",
    chrome: { more: { w: 56 * g.c, h: 56 * g.c }, controls: null, hint: false },
    measure,
    tasks: new Map(plan.tasks.map((x) => [x.id, x])),
    peek: withStrip ? peekOf(plan, state, s) : null,
    // Back and Forward each 80 cpx at the edges, 8 between: the line between them, at the foot's centre.
    lineBox: withStrip ? { x0: g.E + 88 * g.c, x1: g.W - g.E - 88 * g.c, y: g.footTop + 50 * g.c } : null,
  };
}

const corpus = timetableCorpus();
const roast = corpus.find((c) => c.name === "sunday-roast-dinner")!.plan;
const written = identityPlan({ steps: ["Chop the onion.", "Fry it gently until soft.", "Add the rice and stir.", "Pour in the stock.", "Serve."] });
const at = (p: CookPlan, pos: number, mode: "first" | "go" = "first") => {
  let s = initialCookState(mode);
  for (let i = 0; i < pos; i++) s = next(p, s);
  return s;
};
const atDepth = (L: SheetLayout, d: number, extra: { now?: number; progress?: number; pass?: number } = {}) => {
  const [Y0, Y1, Y2] = L.detents;
  const Y = d <= 1 ? Y0 + (Y1 - Y0) * d : Y1 + (Y2 - Y1) * (d - 1);
  return frameAt(L, { Y, ...extra });
};

describe("the strip's levels: rest on the strip, the peek its own height over it, the whole cook as before", () => {
  for (const sc of SCREENS) {
    for (const [name, p, pos] of [
      ["the roast (derived)", roast, 10],
      ["as written", written, 1],
    ] as const) {
      it(`${name} at ${sc.name}`, () => {
        const state = at(p, pos, p === written ? "go" : "first");
        const base = buildLayout(inputFor(p, state, sc.W, sc.H, { strip: false }));
        const L = buildLayout(inputFor(p, state, sc.W, sc.H));
        const g = L.geo;
        expect(L.peek, "laid").toBeDefined();
        // Rest stands on the strip: no band kept over it, so the step has that room back.
        expect(L.detents[0]).toBe(g.footTop);
        expect(L.band).toBe(0);
        expect(base.detents[0]).toBeLessThan(g.footTop);
        // The peek: its own height over the strip; the step keeps its room over it.
        expect(L.detents[1]).toBeCloseTo(g.footTop - L.peek!.height, 6);
        expect(L.detents[1]).toBeGreaterThan(g.stepTop + 100 * g.c);
        // The whole cook stays where it was.
        expect(L.detents[2]).toBe(base.detents[2]);
        // The strip's line fills its cell exactly, gaps and all.
        const sl = L.stripLine!;
        expect(sl.parts[0].x0).toBe(0);
        expect(sl.parts.at(-1)!.x1).toBeCloseTo(sl.x1 - sl.x0, 6);
      });
    }
  }
});

describe("the step at the peek: clear of the drawer, never under 22 cpx a line", () => {
  for (const sc of SCREENS) {
    it(`at ${sc.name}`, () => {
      const L = buildLayout(inputFor(roast, at(roast, 10), sc.W, sc.H));
      const g = L.geo;
      const F = atDepth(L, 1);
      const st = L.step!;
      const bottom = g.stepTop + st.keepH * F.step!.scale;
      // Clear of the drawer by 22 cpx, unless the 22 cpx floor stops it first.
      const floor = 22 / 64;
      if (F.step!.scale > floor + 1e-6) expect(bottom).toBeLessThanOrEqual(L.detents[1] - 22 * g.c + 0.5);
      expect(F.step!.scale).toBeGreaterThanOrEqual(floor - 1e-6);
    });
  }
});

describe("a long step at the peek: the peek folds sooner rather than stand over its words (the mole upright)", () => {
  for (const sc of SCREENS) {
    it(`at ${sc.name}`, () => {
      // A step that fills three quarters of the stage at rest, already drawn at half the counter
      // size: at its 22 cpx floor it still stands taller than the 160 cpx kept over the peek.
      const g0 = geoFor(sc.W, sc.H);
      const o = { keepH: 0.75 * (g0.footTop - g0.stepTop), restFit: 0.5 };
      const L = buildLayout(inputFor(roast, at(roast, 10), sc.W, sc.H, o));
      const full = buildLayout(inputFor(roast, at(roast, 10), sc.W, sc.H));
      const g = L.geo;
      const F = atDepth(L, 1);
      const bottom = g.stepTop + L.step!.keepH * F.step!.scale;
      expect(F.step!.scale).toBeGreaterThanOrEqual(22 / (64 * o.restFit) - 1e-6);
      expect(L.peek!.height, "never taller than for a short step").toBeLessThanOrEqual(full.peek!.height);
      // Clear of the drawer by 22 cpx; where even the step in hand alone would stand over it, the
      // peek is folded as far as it goes (the step keeps its 22 cpx floor; the peek covers its tail).
      if (bottom > L.detents[1] - 22 * g.c + 0.5) expect(L.peek!.limit, `folded to the step in hand (${bottom} under ${L.detents[1]})`).toBe(0);
    });
  }
});

describe("the sheet's hold across Prep first's pages", () => {
  it("tells each page in hand apart, so a page turned at the peek or the whole cook lays the sheet out again", () => {
    // The roast's four prep pages share the one prep mark, in hand on each, while the line's end and
    // the time to the table move page by page: a key on the mark alone held the first page's.
    const pages = [0, 1, 2, 3].map((pos) => strip(roast, at(roast, pos), null, 0));
    for (const s of pages) expect(s.marks.find((m) => m.state === "in-hand")?.key).toBe("prep");
    const keys = pages.map(inHandKey);
    expect(new Set(keys).size).toBe(4);
    // The page's own key stands still while it is in hand, so a minute at the peek still lays nothing out.
    expect(inHandKey(strip(roast, at(roast, 2), null, 0))).toBe(keys[2]);
    // And on to the cooking steps, a step in hand is its own key, as before.
    expect(inHandKey(strip(roast, at(roast, 5), null, 0))).not.toBe(inHandKey(strip(roast, at(roast, 6), null, 0)));
  });
});

describe("the strip's fill and the peek's rows by depth", () => {
  it("derived: the end of the step in hand at every level, the whole cook included (v1.63: the line never changes as the sheet moves)", () => {
    const state = at(roast, 10);
    const L = buildLayout(inputFor(roast, state, 1280, 800));
    const s = strip(roast, state, null);
    const now = s.now + 3;
    for (const d of [0, 0.5, 1, 1.5, 1.9, 2]) expect(atDepth(L, d, { now }).fillMin).toBe(s.progress);
  });

  it("as written: filled by the count of steps at every depth", () => {
    const state = at(written, 2, "go");
    const L = buildLayout(inputFor(written, state, 1280, 800));
    const s = strip(written, state, null);
    for (const d of [0, 1, 2]) expect(atDepth(L, d).fillMin).toBe(s.progress);
  });

  it("the peek is not drawn at rest (it stands behind the foot), stands whole from the first move up to level 1, and on to the whole cook, where its rows have turned into the meal's lines; a pass shows none", () => {
    const L = buildLayout(inputFor(roast, at(roast, 10), 1280, 800));
    expect(atDepth(L, 0).peek).toBe(0);
    // The pull moves and fades each row itself (`pull-travel`): the peek stays for it to the end.
    for (const d of [PEEK_IN, 0.3, 1, 1.15, 1.5, 1.9, PEEK_LEAVE.derived[0]]) expect(atDepth(L, d).peek).toBe(1);
    expect(atDepth(L, 2).peek).toBe(0);
    expect(atDepth(L, 0.5, { pass: 1 }).peek).toBe(0);
    expect(atDepth(L, 1.5, { pass: 1 }).peek).toBe(0);
  });

  it("as written has no lines to turn into: its peek gives way to the outline as that comes in, so the sheet is never empty", () => {
    const L = buildLayout(inputFor(written, at(written, 2, "go"), 1280, 800));
    const [from, to] = PEEK_LEAVE.written;
    for (const d of [1, 1.2, from]) expect(atDepth(L, d).peek).toBe(1);
    expect(atDepth(L, to).peek).toBe(0);
    // At every point between, the peek's rows or the outline's words are over half drawn.
    for (let d = 1; d <= 2.0001; d += 0.025) {
      const F = atDepth(L, Math.min(2, d));
      const words = Math.max(0, ...F.labs2.map((b) => b.op));
      expect(Math.max(F.peek ?? 0, words), `at ${d.toFixed(3)}`).toBeGreaterThan(0.5);
    }
  });

  it("as written retires its band and its next steps' names: nothing of them shows at rest or under the peek", () => {
    const L = buildLayout(inputFor(written, at(written, 2, "go"), 1280, 800));
    for (const d of [0, 0.5, 1]) {
      const F = atDepth(L, d);
      expect(F.bars.every((b) => b.op === 0)).toBe(true);
      expect(F.labs1.every((l) => l.op === 0)).toBe(true);
      expect(F.tt.op).toBe(0);
    }
    // The outline's names come in at the whole cook, as before.
    expect(atDepth(L, 2).labs2.some((l) => l.op > 0)).toBe(true);
  });

  it("the time to the table is the whole cook's: none at rest or under the peek, there at the whole cook", () => {
    const L = buildLayout(inputFor(roast, at(roast, 10), 1280, 800));
    expect(atDepth(L, 0).tt.op).toBe(0);
    expect(atDepth(L, 1).tt.op).toBe(0);
    expect(atDepth(L, 2).tt.op).toBeGreaterThan(0);
  });

  it("the Paper's top is the sheet's edge all the way to the peek (it follows the finger)", () => {
    const L = buildLayout(inputFor(roast, at(roast, 10), 1280, 800));
    for (const d of [0, 0.25, 0.5, 1]) {
      const F = atDepth(L, d);
      expect(F.derived!.paperTop).toBeCloseTo(F.sheetTop, 6);
    }
  });
});

describe("rest → the whole cook → rest, every way a cook has (lead's note on call 3)", () => {
  it("by taps alone: the strip, then the ^ arrow; back by the strip, then the ⌄ arrow or the strip again", () => {
    let k: Level = 0;
    k = stripTap(k);
    expect(k).toBe(1);
    k = sheetArrows(k).expand!;
    expect(k).toBe(2);
    // The whole cook has no arrow: the strip's tap brings it back to the peek.
    expect(sheetArrows(k)).toEqual({ collapse: null, expand: null });
    k = stripTap(k);
    expect(k).toBe(1);
    k = sheetArrows(k).collapse!;
    expect(k).toBe(0);
    expect(stripTap(stripTap(2))).toBe(0);
    // At rest there is no arrow on a sheet's edge; the strip's tap is the way in.
    expect(sheetArrows(0)).toEqual({ collapse: null, expand: null });
  });

  it("by keys: ↑ ↑ to the whole cook, ↓ ↓ back; Esc from the whole cook to rest", () => {
    let k: Level = 0;
    k = keyLevel("ArrowUp", k)!;
    k = keyLevel("ArrowUp", k)!;
    expect(k).toBe(2);
    k = keyLevel("ArrowDown", k)!;
    expect(k).toBe(1);
    k = keyLevel("ArrowDown", k)!;
    expect(k).toBe(0);
    expect(keyLevel("Escape", 2)).toBe(0);
    expect(keyLevel("ArrowDown", 0)).toBeNull();
  });

  for (const sc of SCREENS) {
    it(`by pull at ${sc.name}: up from the strip past the peek to the whole cook, then down to rest`, () => {
      const L = buildLayout(inputFor(roast, at(roast, 10), sc.W, sc.H));
      let t = 0;
      let q: ((t: number) => void)[] = [];
      const settled: Level[] = [];
      const host: MotionHost = {
        raf: (cb) => {
          q.push(cb);
          return q.length;
        },
        caf: () => {},
        now: () => t,
        reduced: () => false,
        detents: () => L.detents,
        paint: () => {},
        onLevel: () => {},
        onSettled: (k) => settled.push(k),
        crossfade: (apply) => apply(),
      };
      const run = (ms: number) => {
        const end = t + ms;
        while (t < end) {
          t += 16;
          const f = q;
          q = [];
          for (const cb of f) cb(t);
        }
      };
      const m = new SheetMotion(host);
      m.reflow();
      const lineY = L.stripLine!.y;
      const x = (L.stripLine!.x0 + L.stripLine!.x1) / 2;
      // Up, the finger slowing to a stop just under the whole cook's detent, then lifting.
      m.down({ id: 1, x, y: lineY, t, zone: "band" });
      const to = L.detents[2] + 10;
      for (let i = 1; i <= 30; i++) {
        t += 16;
        m.move({ id: 1, x, y: lineY + ((to - lineY) * i) / 30, t });
      }
      // The sheet's edge follows the finger past the peek.
      expect(m.Y).toBeLessThan(L.detents[1]);
      t += 16;
      m.move({ id: 1, x, y: to - 40, t });
      t += 16;
      m.up({ id: 1, x, y: to - 80, t }, false);
      run(1500);
      expect(m.pinned).toBe(2);
      // Down from the sheet's edge: a push down goes to rest.
      const y0 = L.detents[2] + 30;
      m.down({ id: 2, x, y: y0, t, zone: "sheet" });
      for (let i = 1; i <= 10; i++) {
        t += 16;
        m.move({ id: 2, x, y: y0 + i * 30, t });
      }
      m.up({ id: 2, x, y: y0 + 300, t }, false);
      run(1500);
      expect(m.pinned).toBe(0);
      expect(m.Y).toBe(L.detents[0]);
    });
  }
});

describe("at the whole cook no arrow stands over its top (Gemini's read of v1.62: the ⌄ over Back to step and the first row)", () => {
  type Box = { x: number; y: number; w: number; h: number };
  const over = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
  /** The target the whole cook used to have: ⌄ at the left of the Paper's top. A test that cannot see it overlap is no test. */
  const old = (E: number, c: number): Box => ({ x: E, y: 24 * c - 40 * c, w: 80 * c, h: 80 * c });
  const W = 1280;
  const H = 800;

  for (const withRead of [false, true]) {
    it(`a derived plan (the roast) at 1280×800${withRead ? ", its step read in the header" : ""}: clear of Back to step, the title and the read`, () => {
      const state = at(roast, 10);
      const input = inputFor(roast, state, W, H);
      const L = buildLayout(withRead ? { ...input, read: { key: "k", text: "Sear the beef in batches until browned all over", go: "step" } } : input);
      const c = L.geo.c;
      const ov = L.overview!;
      const wh = ov.whole!;
      // The arrows stand on the Paper's top (CookSheet: the sheet's edge moved by paperTop − Y);
      // the whole cook's header is laid in cpx from Y2. Both on screen, the same frame.
      const paperTop = atDepth(L, 2).derived!.paperTop;
      expect(ov.Y2 + wh.sheet.y * c).toBeCloseTo(paperTop, 6);
      const scr = (b: Box): Box => ({ x: b.x * c, y: ov.Y2 + b.y * c, w: b.w * c, h: b.h * c });
      const parts: [string, Box][] = [["Back to step", scr(wh.back)]];
      if (wh.read) parts.push(["the read", scr(wh.read.box)]);
      else parts.push(["the title", scr({ x: wh.title.x, y: wh.title.y, w: measure(wh.title.text, 24, 600, "text"), h: 28 })]);
      const arrows = sheetArrowTargets(2, W, c).map((a) => ({ ...a, y: paperTop + a.y }));
      for (const a of arrows) for (const [name, b] of parts) expect(over(a, b), `the ${a.mark} arrow over ${name}`).toBe(false);
      // The old ⌄ stood over Back to step: the check sees it.
      const was = old(L.geo.E, c);
      expect(over({ ...was, y: paperTop + was.y }, parts[0][1])).toBe(true);
    });
  }

  for (const withRead of [false, true]) {
    it(`as written at 1280×800${withRead ? ", its step read in a band" : ""}: clear of ${withRead ? "the read band" : "the outline's first row"}`, () => {
      const state = at(written, 1, "go");
      const input = inputFor(written, state, W, H);
      const L = buildLayout(withRead ? { ...input, read: { key: "k", text: "Fry it gently until soft.", go: "step" } } : input);
      const c = L.geo.c;
      const F = atDepth(L, 2);
      // As written's arrows, its band and its rows all stand in the sheet's own frame (from its top edge).
      const parts: [string, Box][] = [];
      if (withRead) {
        const r = L.read!;
        parts.push(["the read band", { x: L.geo.E / 2, y: r.top, w: W - L.geo.E, h: r.height }]);
      } else {
        const j = L.labs2.findIndex((l) => l != null);
        expect(j, "a row named").toBeGreaterThanOrEqual(0);
        const lab = L.labs2[j]!;
        const f = F.labs2[j];
        parts.push(["the outline's first row", { x: f.x, y: f.y, w: lab.w, h: lab.lines.length * L.lh2 }]);
      }
      const arrows = sheetArrowTargets(2, W, c);
      for (const a of arrows) for (const [name, b] of parts) expect(over(a, b), `the ${a.mark} arrow over ${name}`).toBe(false);
      expect(over(old(L.geo.E, c), parts[0][1])).toBe(true);
    });
  }
});
