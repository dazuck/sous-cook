import { describe, expect, it } from "vitest";
import { COOK_COPY, initialCookState, next, cookView, type CookState } from "./cook-view";
import { identityPlan, parseCookPlan, type CookPlan } from "./cook-plan";
import { strip } from "./cook-strip";
import { restNudge } from "./cook-levels";
import { SIDE } from "./overview-place";
import { buildTimetable } from "./timetable-model";
import type { GetOutItem, Rect } from "./timetable-layout";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "./__tests__/load-cook-plan-fixtures";
import {
  advanceFrame,
  buildLayout,
  depthOf,
  frameAt,
  levelBoxes,
  ROW_BAND,
  type Frame,
  type LayoutInput,
  type Measure,
  type SheetGeo,
  type SheetLayout,
  type StepBox,
} from "./sheet-layout";

function corpusPlan(name: string): CookPlan {
  const fixture = loadCookPlanFixtures().find((f) => f.name === name);
  const raw = loadCookPlanSnapshots().get(name)?.raw;
  if (!fixture || !raw) throw new Error(`no corpus plan ${name}`);
  const parsed = parseCookPlan(raw, fixture.recipe);
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return parsed.plan;
}

function advance(plan: CookPlan, state: CookState, steps: number): CookState {
  let s = state;
  for (let i = 0; i < steps; i++) s = next(plan, s);
  return s;
}

/** A fixed-width stand-in for the browser's text metrics: Figtree about half an em a glyph, Caprasimo wider. */
const measure: Measure = (text, px, weight, family = "text") =>
  text.length * px * (family === "display" ? 0.62 : weight >= 600 ? 0.54 : 0.5);

const VIEWPORTS = [
  { name: "1280×800", W: 1280, H: 800 },
  { name: "1280×680", W: 1280, H: 680 },
  { name: "800×1280", W: 800, H: 1280 },
];

function geoFor(W: number, H: number): SheetGeo {
  const c = Math.min(Math.max(W, H) / 960, Math.min(W, H) / 600);
  const top = 92 * c;
  return {
    W,
    H,
    c,
    E: 48,
    top,
    stepTop: top + (H > W ? 58 : 12) * c,
    footTop: H - 100 * c,
    ledgeTop: H - 96 * c,
    portrait: H > W,
  };
}

/** The step block as the stage would draw it: three lines at 64 cpx, then the meta. */
function stepFor(g: SheetGeo, text: string): StepBox {
  // The fit at rest: the largest rung whose block fits above the band, as the stage fits it.
  const room = g.footTop - 80 * g.c - 26.4 * g.c - g.stepTop;
  const restFit = [1.2, 1.1, 1, 0.9, 0.8].find((f) => blockFor(g, text, f).fullH <= room) ?? 0.8;
  return blockFor(g, text, restFit);
}

function blockFor(g: SheetGeo, text: string, restFit: number): StepBox {
  const px = 64 * g.c * restFit;
  const perLine = Math.max(1, Math.floor((g.W - 2 * g.E) / (px * 0.54)));
  const lines = Math.ceil(text.length / perLine);
  const textH = lines * px * 1.15;
  return {
    textH,
    keepH: textH,
    fullH: textH + 110 * g.c,
    inkW: Math.min(g.W - 2 * g.E, text.length * px * 0.54),
    restFit,
    text,
  };
}

interface Extra {
  stepText?: string;
  read?: string;
  /** The mark read (the step in hand when unset). */
  readKey?: string;
  opening?: boolean;
  /** The number of ingredients in the opening's Get out list. */
  getOutCount?: number;
  /** The voice hint shows (listening, pinned). */
  hint?: boolean;
}

function layoutFor(plan: CookPlan, state: CookState, W: number, H: number, extra: Extra = {}): SheetLayout {
  return buildLayout(inputFor(plan, state, W, H, extra));
}

function inputFor(plan: CookPlan, state: CookState, W: number, H: number, extra: Extra = {}): LayoutInput {
  const g = geoFor(W, H);
  const s = strip(plan, state, null);
  const view = cookView(plan, { kind: "derived" }, state);
  const text = extra.stepText ?? (view.onPrep ? "" : (view.stack[0]?.text ?? ""));
  const nd = restNudge(s, s.now);
  const inHand = s.marks.find((m) => m.state === "in-hand");
  // The timetable as the sheet builds it: this mode's live strip, the other mode from the top.
  const mode = state.mode ?? "first";
  const first = mode === "first" ? s : strip(plan, initialCookState("first"), null);
  const go = mode === "go" ? s : strip(plan, initialCookState("go"), null);
  const t = buildTimetable(plan, first, go, mode);
  const other = buildTimetable(plan, first, go, mode === "first" ? "go" : "first", { now: 0 });
  const getOut: GetOutItem[] = Array.from({ length: extra.getOutCount ?? 0 }, (_, index) => ({
    index,
    amount: index % 3 === 2 ? null : `${index + 1} tbsp`,
    name: ["onion", "garlic cloves", "fresh ginger", "ghee", "cumin seeds", "toor dal", "tomatoes", "cilantro"][index % 8],
  }));
  return {
    strip: s,
    geo: g,
    step: text ? stepFor(g, text) : null,
    nudge: nd ? { text: nd.text, targetKey: nd.target.key, at: nd.at } : null,
    read: extra.read !== undefined && (extra.readKey || inHand) ? { key: extra.readKey ?? inHand!.key, text: extra.read } : null,
    opening: extra.opening ? { getOut, scaleNote: null } : null,
    timetable: t && other ? { t, other } : null,
    title: "Sunday roast dinner with all the trimmings",
    // More and the opening's controls as the browser measures them (cpx).
    chrome: { more: { w: 56 * g.c, h: 56 * g.c }, controls: extra.opening ? { w: 268 * g.c, h: 64 * g.c } : null, hint: extra.hint ?? false },
    measure,
    tasks: new Map(plan.tasks.map((t) => [t.id, t])),
  };
}

const dal = corpusPlan("indian-dal-tadka");
const roast = corpusPlan("sunday-roast-dinner");
const salmon = corpusPlan("simple-weeknight-salmon");
const written = identityPlan({
  steps: [
    "Rinse the toor dal and pressure cook with water and turmeric until soft.",
    "Heat the ghee in a small pan for the tempering.",
    "Temper the whole spices until they crackle and become fragrant.",
    "Add the dried red chiles, garlic, and ginger, and saute until golden.",
    "Add the onion and cook until translucent, then stir in the tomatoes.",
    "Pour the tempering into the cooked dal, add salt, and simmer for 5 minutes.",
    "Garnish with fresh cilantro and serve with rice.",
  ],
});

const FIXTURES: { name: string; plan: CookPlan; state: CookState }[] = [
  { name: "dal", plan: dal, state: advance(dal, initialCookState("first"), 1) },
  { name: "dal on Prep", plan: dal, state: initialCookState("first") },
  { name: "roast", plan: roast, state: advance(roast, initialCookState("first"), 4) },
  { name: "roast late", plan: roast, state: advance(roast, initialCookState("first"), 9) },
  { name: "salmon", plan: salmon, state: advance(salmon, initialCookState("first"), 1) },
  { name: "as written", plan: written, state: advance(written, initialCookState("first"), 1) },
];

const settledAt = (L: SheetLayout, k: number) => frameAt(L, { Y: L.detents[k] });
const EPS = 0.5;

/** Every drawn box at a settled level, on screen: [x0, y0, x1, y1, what]. */
function boxesAt(L: SheetLayout, k: number): [number, number, number, number, string][] {
  const g = L.geo;
  const c = g.c;
  const F = settledAt(L, k);
  const Y = F.sheetTop;
  const out: [number, number, number, number, string][] = [];
  F.bars.forEach((b, j) => {
    if (b.op > 0.01 && k > 0) out.push([b.x, Y + b.y, b.x + b.w, Y + b.y + b.h, `bar ${L.marks[j].key}`]);
  });
  const D = L.derived;
  if (D && F.derived && k < 2) {
    // A derived plan: the line, and at level 1 the strip map on it (cpx from the line's centre).
    const ln = F.derived.line;
    out.push([ln.x, D.lineY - 2 * c, ln.x + ln.w, D.lineY + 2 * c, "the line"]);
    if (k === 1) {
      for (const m of D.map.marks) out.push([m.x * c, D.lineY + m.y * c, (m.x + m.w) * c, D.lineY + (m.y + m.h) * c, `map ${m.k}`]);
      // The time to the table among them: the sheet draws it where the map sets it (sheet-derived.test.ts).
      for (const w of D.map.words) {
        out.push([w.x * c, D.lineY + w.y * c, (w.x + w.w) * c, D.lineY + (w.y + w.h) * c, `map ${w.k}`]);
      }
    }
  }
  const labs = k === 1 ? F.labs1 : k === 2 ? F.labs2 : [];
  const src = k === 1 ? L.labs1 : L.labs2;
  const lh = k === 1 ? L.lh1 : L.lh2;
  labs.forEach((l, j) => {
    const lab = src[j];
    if (!lab || l.op < 0.01) return;
    out.push([l.x, Y + l.y, l.x + lab.w, Y + l.y + lab.lines.length * lh, `label ${L.marks[j].key}`]);
  });
  if (k === 2) {
    const ov = L.overview;
    const box = (b: { x: number; y: number; w: number; h: number }, what: string) =>
      out.push([b.x, Y + b.y, b.x + b.w, Y + b.y + b.h, what]);
    if (ov) {
      // A derived plan: the timetable and what stands round it, in cpx from the sheet's edge.
      const cc = ov.c;
      const cbox = (b: Rect, what: string) => out.push([b.x * cc, Y + b.y * cc, (b.x + b.w) * cc, Y + (b.y + b.h) * cc, what]);
      for (const mk of ov.drawing.marks) if (mk.op > 0.01) cbox(mk, `mark ${mk.k}`);
      for (const w of ov.drawing.words) {
        if (w.op < 0.01) continue;
        // An upright word turns about its box's centre.
        if (w.rot) cbox({ x: w.x + w.w / 2 - w.h / 2, y: w.y + w.h / 2 - w.w / 2, w: w.h, h: w.w }, `word ${w.k}`);
        else cbox(w, `word ${w.k}`);
      }
      if (ov.ghost) box(ov.ghost, "ghost");
      if (ov.whole?.read) {
        const r = ov.whole.read;
        cbox(r.box, "read");
        if (r.go) cbox(r.go, "go");
        cbox(r.whole, "read ghost");
      }
      const toggle = ov.opening?.toggle ?? ov.whole?.toggle;
      if (toggle) cbox({ x: toggle.x, y: toggle.y, w: toggle.w, h: toggle.h }, "mode toggle");
      if (ov.opening) {
        const o = ov.opening;
        cbox({ x: o.title.x, y: o.title.y, w: o.title.w, h: o.title.lines.length * o.title.lh }, "title");
        if (o.getOut) cbox(o.getOut.box, "get out");
      }
    } else {
      if (L.ghost) box(L.ghost, "ghost");
      if (L.read) out.push([0, Y + L.read.top, g.W, Y + L.read.top + L.read.height, "read band"]);
      for (const r of L.chart.rows) out.push([L.chart.x0, Y + r.top, L.chart.x1, Y + r.bottom, "row"]);
    }
  }
  if (F.tt.op > 0.01 && !(D && k === 1)) out.push([F.tt.x, Y + F.tt.y, F.tt.x + F.tt.dw, Y + F.tt.y + F.tt.dh, "time to the table"]);
  return out;
}

describe("sheet layout: every level lies inside the screen", () => {
  for (const vp of VIEWPORTS) {
    for (const fx of FIXTURES) {
      for (const extra of [{}, { read: "Sear the beef on every side until browned, about 10 minutes, then lift it out." }] as Extra[]) {
        it(`${fx.name} at ${vp.name}${extra.read ? " with a read band" : ""}`, () => {
          const L = layoutFor(fx.plan, fx.state, vp.W, vp.H, extra);
          const g = L.geo;
          expect(L.detents[0]).toBeGreaterThan(L.detents[1]);
          expect(L.detents[1]).toBeGreaterThanOrEqual(L.detents[2]);
          // The whole cook takes the top line's band for a derived plan (N3-4(f)); as written it stays.
          expect(L.detents[2]).toBe(fx.name === "as written" ? g.top : 0);
          for (const { level: k, top: Y, bottom } of levelBoxes(L)) {
            expect(bottom).toBe(g.footTop);
            for (const [x0, y0, x1, y1, what] of boxesAt(L, k)) {
              expect(x0, `${what} at level ${k} left`).toBeGreaterThanOrEqual(-EPS);
              expect(x1, `${what} at level ${k} right`).toBeLessThanOrEqual(g.W + EPS);
              expect(y0, `${what} at level ${k} top`).toBeGreaterThanOrEqual(Y - EPS);
              expect(y1, `${what} at level ${k} bottom`).toBeLessThanOrEqual(bottom + EPS);
            }
          }
        });
      }
    }
  }
});

describe("sheet layout: sizes and rows", () => {
  for (const vp of VIEWPORTS) {
    for (const fx of FIXTURES) {
      it(`${fx.name} at ${vp.name}: names at 22 cpx or more; the whole cook's type at 22 or more, as written every row at least ${ROW_BAND} px`, () => {
        const L = layoutFor(fx.plan, fx.state, vp.W, vp.H);
        expect(L.px1 / L.geo.c).toBeGreaterThanOrEqual(22 - 1e-6);
        expect(L.summary.px1).toBeGreaterThanOrEqual(22 - 1e-6);
        expect(L.summary.px2).toBeGreaterThanOrEqual(22 - 1e-6);
        if (L.overview) {
          for (const w of L.overview.drawing.words.filter((w) => w.role === "block-label")) expect(w.size, w.k).toBeGreaterThanOrEqual(22 - 1e-6);
        } else {
          for (const r of L.chart.rows) expect(r.bottom - r.top).toBeGreaterThanOrEqual(ROW_BAND - 1e-6);
        }
      });
    }
  }

});

describe("sheet layout as written: the next steps", () => {
  it("keeps the step clear of the sheet as written in portrait, its step at the rest fit's top rung", () => {
    // As the e2e sweep found it (800×1280, the cake as written, step 2): a
    // four-line step at 1.2 under an outline whose rows each take two lines.
    const g = { ...geoFor(800, 1280), stepTop: 235, footTop: 1160 };
    const plan = identityPlan({
      steps: [
        "Preheat the oven to 350F and grease two cake pans.",
        "In a large bowl, whisk together the dry ingredients.",
        "In another bowl, beat the eggs, then add the buttermilk, oil and vanilla.",
        "Pour the wet mixture into the dry and stir until just combined.",
        "Divide the batter between the pans and bake for 30 minutes.",
        "Cool the cakes completely before frosting.",
      ],
    });
    const state = advance(plan, initialCookState("first"), 1);
    const s = strip(plan, state, null);
    const L = buildLayout({
      strip: s,
      geo: g,
      step: { textH: 471, keepH: 471, fullH: 520, inkW: 680, restFit: 1.2, text: "In a large bowl, whisk together the dry ingredients." },
      nudge: null,
      read: null,
      opening: null,
      measure,
    });
    const st = L.step!;
    expect(st.pages1).toBe(false);
    // the sheet's edge stands below the step's words (with their gap)
    expect(g.stepTop + st.keepH * st.sc1 + 22 * g.c).toBeLessThanOrEqual(L.detents[1] + EPS);
    // the first upcoming row stays; the outline's later rows give way from the end
    expect(L.labs1[L.inHand]).toBeNull();
    expect(L.labs1[L.inHand + 1]).not.toBeNull();
  });

});

describe("sheet layout as written: the advance (N2-3)", () => {
  it("starts on the old frame and lands on the new one; a finished row moves up and fades", () => {
    const s1 = advance(written, initialCookState("first"), 1);
    const s2 = next(written, s1);
    for (const vp of VIEWPORTS) {
      const a = layoutFor(written, s1, vp.W, vp.H);
      const b = layoutFor(written, s2, vp.W, vp.H);
      const A = settledAt(a, 1);
      const B = settledAt(b, 1);
      const at0 = advanceFrame(a, b, 0);
      const at1 = advanceFrame(a, b, 1);
      const idx = new Map(a.marks.map((m, j) => [m.key, j]));
      b.marks.forEach((m, j) => {
        const i = idx.get(m.key);
        if (i !== undefined) {
          expect(at0.bars[j].x).toBeCloseTo(A.bars[i].x, 6);
          expect(at0.bars[j].y).toBeCloseTo(A.bars[i].y, 6);
        }
        expect(at1.bars[j].x).toBeCloseTo(B.bars[j].x, 6);
        expect(at1.bars[j].y).toBeCloseTo(B.bars[j].y, 6);
        expect(at1.bars[j].op).toBeCloseTo(B.bars[j].op, 6);
      });
      // The old step in hand ends above the rows, faded.
      const old = a.marks[a.inHand].key;
      const jOld = b.marks.findIndex((m) => m.key === old);
      expect(jOld).toBeGreaterThanOrEqual(0);
      if (!b.summary.rows1.includes(old)) {
        expect(at1.bars[jOld].op).toBe(0);
        expect(at1.bars[jOld].y).toBeLessThan(at0.bars[jOld].y);
      }
      // Rows that stay move up: row i of the old is at row i-1 (or above it) after.
      const rowY = (F: Frame, L: SheetLayout, key: string) => F.bars[L.marks.findIndex((m) => m.key === key)].y;
      const shared = a.summary.rows1.filter((k) => b.summary.rows1.includes(k));
      for (const k of shared) expect(rowY(at1, b, k)).toBeLessThanOrEqual(rowY(at0, b, k) + EPS);
    }
  });
});

describe("sheet layout: the whole cook (the timetable, slice T2)", () => {
  /** The sheet's edge at depth d between the stretch and the whole cook. */
  const atDepth = (L: SheetLayout, d: number) => frameAt(L, { Y: L.detents[1] - (d - 1) * (L.detents[1] - L.detents[2]) });

  it("keeps the top line at the whole cook where asked (N3-4(f)'s alternative), and as written", () => {
    const st = advance(roast, initialCookState("first"), 4);
    const kept = buildLayout({ ...inputFor(roast, st, 1280, 800), topLine: true });
    expect(kept.detents[2]).toBe(kept.geo.top);
    expect(atDepth(kept, 2).header).toBe(1);
    // The Paper carries its own hairline (T3): the as-written sheet edge's hairline is not drawn.
    expect(atDepth(kept, 2).hair).toBe(0);
    expect(atDepth(kept, 2).lanes).toBe(1);
    expect(atDepth(kept, 2).derived!.paperTop).toBeCloseTo(kept.detents[2] + 18 * kept.geo.c, 6);
    const w = layoutFor(written, advance(written, initialCookState("first"), 1), 1280, 800);
    expect(w.overview).toBeNull();
    expect(atDepth(w, 2).header).toBe(1);
    expect(atDepth(w, 2).lanes).toBe(0);
    expect(atDepth(w, 2).chart).toBe(1);
  });

  for (const vp of VIEWPORTS) {
    it(`level 2 at ${vp.name}: a header over the timetable (More at the top right, time to the table, the ghost, the hint), the timetable on the sheet`, () => {
      const L = layoutFor(roast, advance(roast, initialCookState("first"), 4), vp.W, vp.H, { hint: true });
      const g = L.geo;
      const ov = L.overview!;
      const wh = ov.whole!;
      const c = ov.c;
      const chartTop = wh.chart.y * c;
      expect(ov.opening).toBeNull();
      expect(ov.more.x + 56 * g.c).toBeCloseTo(g.W - SIDE * g.c, 6);
      expect(ov.tt.op).toBe(1);
      expect(ov.ghost).not.toBeNull();
      // The hint stands only where it has room, clear of the name and the ghost; a short name leaves it room.
      const short = buildLayout({ ...inputFor(roast, advance(roast, initialCookState("first"), 4), vp.W, vp.H, { hint: true }), title: "Roast" });
      expect(short.overview!.hint).not.toBeNull();
      const tt = L.tt.dims[ov.tt.z];
      expect(ov.tt.top + tt.h).toBeLessThanOrEqual(chartTop + EPS);
      expect(ov.ghost!.y + ov.ghost!.h).toBeLessThanOrEqual(chartTop + EPS);
      expect(ov.more.y + 56 * g.c).toBeLessThanOrEqual(chartTop + EPS);
      for (const o of [ov, short.overview!]) {
        if (!o.hint || !o.ghost) continue;
        const hw = measure(COOK_COPY.saySueBack, 22 * c, 500);
        const hintBox = { x: o.hint.x, y: o.hint.y, w: hw, h: 22 * c * 1.3 };
        const clear = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
          a.x + a.w <= b.x + EPS || b.x + b.w <= a.x + EPS || a.y + a.h <= b.y + EPS || b.y + b.h <= a.y + EPS;
        expect(clear(hintBox, o.ghost)).toBe(true);
        expect(o.hint.y + hintBox.h).toBeLessThanOrEqual(o.whole!.chart.y * c + EPS);
        expect(o.hint.x).toBeGreaterThanOrEqual(o.whole!.title.x * c + measure(o.whole!.title.text, 24 * c, 600) - EPS);
      }
      // The drawing stands inside its box, on the sheet, above the foot.
      expect(ov.drawing.top).toBeGreaterThanOrEqual(wh.chart.y - EPS);
      expect(ov.drawing.bottom).toBeLessThanOrEqual(wh.chart.y + wh.chart.h + EPS);
      expect(wh.chart.y).toBeGreaterThanOrEqual(wh.sheet.y - EPS);
      expect(L.detents[2] + (wh.chart.y + wh.chart.h) * c).toBeLessThanOrEqual(g.footTop + EPS);
      expect(ov.drawing.fits).toBe(true);
    });

    it(`the read at ${vp.name} replaces the header: the timetable never moves under the finger`, () => {
      const st = advance(roast, initialCookState("first"), 4);
      const bare = layoutFor(roast, st, vp.W, vp.H);
      const ahead = bare.marks.find((m) => m.state === "ahead")!;
      const text = "Sear the beef on every side until well browned, about 10 minutes, then lift it out onto a board to rest.";
      const L = buildLayout({ ...inputFor(roast, st, vp.W, vp.H), read: { key: ahead.key, text, go: "step" } });
      const ov = L.overview!;
      const at = (d: typeof ov.drawing) => d.marks.map((mk) => [mk.k, mk.x, mk.y, mk.w, mk.h]);
      expect(at(ov.drawing)).toEqual(at(bare.overview!.drawing));
      expect(ov.whole!.chart).toEqual(bare.overview!.whole!.chart);
      expect(ov.tt.op).toBe(0);
      expect(ov.ghost).toBeNull();
      expect(ov.read).toEqual({ key: ahead.key, go: "step" });
      const r = ov.whole!.read!;
      expect(r.size).toBeGreaterThanOrEqual(22 - 1e-6);
      expect(r.go).not.toBeNull();
      const c = ov.c;
      for (const ln of r.lines) expect(measure(ln, r.size * c, 500) / c, ln).toBeLessThanOrEqual(r.box.w + EPS);
      expect(r.box.y + r.box.h).toBeLessThanOrEqual(ov.whole!.chart.y + EPS);
      expect(r.go!.y + r.go!.h).toBeLessThanOrEqual(ov.whole!.chart.y + EPS);
    });

    it(`the opening at ${vp.name}: the whole screen, the title over the timetable, the controls beside More`, () => {
      const L = layoutFor(roast, initialCookState("first"), vp.W, vp.H, { opening: true, hint: true });
      const g = L.geo;
      const ov = L.overview!;
      const o = ov.opening!;
      const c = ov.c;
      expect(L.opening).toBe(true);
      expect(L.detents[2]).toBe(0);
      expect(ov.sheetBottom).toBe(g.H);
      expect(ov.whole).toBeNull();
      expect(ov.ghost).toBeNull();
      expect(ov.hint).toBeNull();
      expect(ov.tt.op).toBe(0);
      expect(L.P[2].tt.op).toBe(0);
      expect(o.title.y + o.title.lines.length * o.title.lh).toBeLessThanOrEqual(o.chart.y + EPS);
      expect((o.title.x + o.title.w) * c).toBeLessThanOrEqual(g.W - SIDE * c + EPS);
      expect(ov.drawing.top).toBeGreaterThanOrEqual(o.chart.y - EPS);
      expect(ov.drawing.bottom).toBeLessThanOrEqual(o.chart.y + o.chart.h + EPS);
      expect((o.chart.y + o.chart.h) * c).toBeLessThanOrEqual(g.H + EPS);
      expect(ov.more.x + 56 * g.c).toBeCloseTo(g.W - SIDE * g.c, 6);
      // The controls end before More, on its row.
      expect(ov.controls!.x + 268 * g.c).toBeLessThanOrEqual(ov.more.x + EPS);
      expect(ov.controls!.y + 64 * g.c).toBeLessThanOrEqual(o.chart.y * c + EPS);
      // A plan with mise: the toggle with both totals.
      expect(o.toggle!.items.map((it) => it.mode)).toEqual(["first", "go"]);
      expect(o.toggle!.items.find((it) => it.on)!.mode).toBe("first");
      for (const k of [0, 1, 2]) expect(frameAt(L, { Y: L.detents[k] }).header, `depth ${k}`).toBe(0);
      for (const k of [0, 1, 2]) expect(frameAt(L, { Y: L.detents[k] }).hair, `hairline at depth ${k}`).toBe(0);
    });

    it(`the opening at ${vp.name} with Get out ingredients: at the foot, under the timetable, inside the screen`, () => {
      const L = layoutFor(dal, initialCookState("first"), vp.W, vp.H, { opening: true, getOutCount: 10 });
      const g = L.geo;
      const ov = L.overview!;
      const o = ov.opening!;
      const go = o.getOut!;
      const c = ov.c;
      expect(go).not.toBeNull();
      expect(go.items.length).toBeGreaterThan(0);
      expect(go.box.y).toBeGreaterThanOrEqual(o.chart.y + o.chart.h - EPS);
      expect((go.box.y + go.box.h) * c).toBeLessThanOrEqual(g.H + EPS);
      expect(go.box.x).toBeGreaterThanOrEqual(SIDE - EPS);
      expect((go.box.x + go.box.w) * c).toBeLessThanOrEqual(g.W - SIDE * c + EPS);
      // What doesn't show is said: "and N more".
      if (go.items.length < 10) expect(go.more?.text).toBe(COOK_COPY.andMore(10 - go.items.length));
      expect(ov.drawing.fits).toBe(true);
    });

    it(`as written at ${vp.name}: the read band is a third of the sheet at most, the outline under it`, () => {
      const L = layoutFor(written, advance(written, initialCookState("first"), 1), vp.W, vp.H, {
        read: "Rinse the toor dal and pressure cook with water and turmeric until soft, about 20 minutes.",
      });
      const sheet = L.geo.footTop - L.detents[2];
      expect(L.read).not.toBeNull();
      expect(L.read!.height).toBeLessThanOrEqual(sheet / 3 + EPS);
      expect(L.read!.px / L.geo.c).toBeGreaterThanOrEqual(22 - 1e-6);
      expect(L.chart.rowsTop).toBeGreaterThanOrEqual(L.read!.top + L.read!.height - EPS);
      expect(L.ghost).toBeNull();
    });
  }

  it("says Go to Prep when Prep is read; the read has no Go when there's nowhere to go", () => {
    const st = advance(dal, initialCookState("first"), 1);
    const prep = buildLayout({ ...inputFor(dal, st, 1280, 800), read: { key: "prep", text: "4 to do · 21 min", go: "prep" } });
    expect(prep.overview!.read!.go).toBe("prep");
    expect(prep.overview!.whole!.read!.go).not.toBeNull();
    const none = buildLayout({ ...inputFor(dal, st, 1280, 800), read: { key: "prep", text: "Prep · done", go: null } });
    expect(none.overview!.read!.go).toBeNull();
    expect(none.overview!.whole!.read!.go).toBeNull();
    expect(none.overview!.whole!.read!.whole).toBeDefined();
  });

  it("draws no timetable as written, and the opening's room is the sheet's", () => {
    const w = layoutFor(written, initialCookState("first"), 1280, 800, { opening: true });
    expect(w.overview).toBeNull();
  });
});

describe("depthOf", () => {
  it("runs 0 to 2 over the three detents", () => {
    const L = layoutFor(dal, advance(dal, initialCookState("first"), 1), 1280, 800);
    const [Y0, Y1, Y2] = L.detents;
    expect(depthOf(L, Y0 + 50)).toBe(0);
    expect(depthOf(L, Y0)).toBe(0);
    expect(depthOf(L, Y1)).toBeCloseTo(1, 6);
    expect(depthOf(L, (Y0 + Y1) / 2)).toBeCloseTo(0.5, 6);
    expect(depthOf(L, Y2)).toBeCloseTo(2, 6);
    expect(depthOf(L, Y2 - 40)).toBe(2);
  });

  it("is continuous: no element jumps across a detent", () => {
    for (const L of [
      layoutFor(roast, advance(roast, initialCookState("first"), 4), 1280, 800),
      layoutFor(roast, advance(roast, initialCookState("first"), 4), 800, 1280),
      layoutFor(written, advance(written, initialCookState("first"), 1), 1280, 800),
    ]) {
      for (const Yd of [L.detents[1]]) {
        const a = frameAt(L, { Y: Yd + 0.01 });
        const b = frameAt(L, { Y: Yd - 0.01 });
        a.bars.forEach((bar, j) => {
          expect(Math.abs(bar.x - b.bars[j].x)).toBeLessThan(1);
          expect(Math.abs(bar.y - b.bars[j].y)).toBeLessThan(1);
        });
        for (const key of ["x", "y", "n", "w", "wx", "wy", "op"] as const) expect(Math.abs(a.tt[key] - b.tt[key]), `tt.${key}`).toBeLessThan(1);
        if (a.derived && b.derived) {
          expect(Math.abs(a.derived.paperTop - b.derived.paperTop)).toBeLessThan(1);
          for (const key of ["x", "w", "fill"] as const) expect(Math.abs(a.derived.line[key] - b.derived.line[key]), `line.${key}`).toBeLessThan(1);
          expect(Math.abs(a.derived.stations - b.derived.stations)).toBeLessThan(0.01);
        }
      }
    }
  });
});

/**
 * Nothing is shed: as written every lifted row keeps its name; a timetable
 * names every block or draws it low as a touch (SPEC §7.6).
 */
function expectNamed(L: SheetLayout, where: string) {
  const ov = L.overview;
  if (!ov) {
    expect(L.summary.shed2, `${where}: zero steps shed`).toEqual([]);
    return;
  }
  const named = new Set(ov.drawing.words.filter((w) => w.role === "block-label" && w.block).map((w) => w.block));
  for (const mk of ov.drawing.marks) {
    if (mk.role === "block" && !mk.low) expect(named.has(mk.block), `${where}: ${mk.block} named`).toBe(true);
  }
}

describe("sheet layout across the corpus", () => {
  const plans = loadCookPlanFixtures()
    .map((f) => ({ name: f.name, raw: loadCookPlanSnapshots().get(f.name)?.raw, recipe: f.recipe }))
    .filter((f) => f.raw)
    .map((f) => ({ name: f.name, parsed: parseCookPlan(f.raw, f.recipe) }))
    .filter((f) => f.parsed.ok)
    .map((f) => ({ name: f.name, plan: (f.parsed as { ok: true; plan: CookPlan }).plan }));

  it("lays out every step of every plan inside the screen at every viewport", () => {
    expect(plans.length).toBeGreaterThan(5);
    let checked = 0;
    for (const { name, plan } of plans) {
      let st = initialCookState("first");
      for (let i = 0; i < 30; i++) {
        const view = cookView(plan, { kind: "derived" }, st);
        const read = "Sear the beef on every side until well browned, about 10 minutes, then lift it out onto a board to rest.";
        for (const [vp, extra] of VIEWPORTS.flatMap((v) => [[v, {}], [v, { read }]] as const)) {
          const L = layoutFor(plan, st, vp.W, vp.H, extra);
          for (const { level: k, top, bottom } of levelBoxes(L)) {
            for (const [x0, y0, x1, y1, what] of boxesAt(L, k)) {
              const where = `${name} pos ${st.pos} ${vp.name} level ${k}: ${what}`;
              expect(x0, where).toBeGreaterThanOrEqual(-EPS);
              expect(x1, where).toBeLessThanOrEqual(vp.W + EPS);
              expect(y0, where).toBeGreaterThanOrEqual(top - EPS);
              expect(y1, where).toBeLessThanOrEqual(bottom + EPS);
            }
          }
          expect(L.summary.px2, name).toBeGreaterThanOrEqual(22 - 1e-6);
          expect(L.summary.fits2, `${name} pos ${st.pos} ${vp.name}`).toBe(true);
          expectNamed(L, `${name} pos ${st.pos} ${vp.name}`);
          checked++;
        }
        const n2 = next(plan, st);
        if (n2.pos === st.pos || view.isLast) break;
        st = n2;
      }
    }
    expect(checked).toBeGreaterThan(50);
  }, 30_000);

  it("lays out Prep in As I go, with or without a Prep block, inside the screen at every viewport", () => {
    let checked = 0;
    for (const { name, plan } of plans) {
      const st = initialCookState("go");
      for (const vp of VIEWPORTS) {
        const L = layoutFor(plan, st, vp.W, vp.H, {});
        for (const { level: k, top, bottom } of levelBoxes(L)) {
          for (const [x0, y0, x1, y1, what] of boxesAt(L, k)) {
            const where = `${name} go Prep ${vp.name} level ${k}: ${what}`;
            expect(x0, where).toBeGreaterThanOrEqual(-EPS);
            expect(x1, where).toBeLessThanOrEqual(vp.W + EPS);
            expect(y0, where).toBeGreaterThanOrEqual(top - EPS);
            expect(y1, where).toBeLessThanOrEqual(bottom + EPS);
          }
        }
        expect(L.summary.fits2, `${name} go Prep ${vp.name}`).toBe(true);
        expectNamed(L, `${name} go Prep ${vp.name}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });

  it("left-aligns the nudge at g.E, the edge's width", () => {
    const L = layoutFor(dal, advance(dal, initialCookState("first"), 1), 1280, 800);
    expect(L.nudge).not.toBeNull();
    expect(L.nudge!.x).toBe(L.geo.E);
    expect(L.nudge!.maxW).toBe(L.geo.W - 2 * L.geo.E);
    // It stands over the line's tap target, never on the line.
    expect(L.geo.H - L.nudge!.bottom).toBeLessThanOrEqual(L.detents[0] + EPS);
  });
});


