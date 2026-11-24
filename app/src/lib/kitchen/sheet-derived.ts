/**
 * A derived plan's cook sheet (overview slice T3; build contract
 * `design/overview-arc/r3/SPEC.md` §10–§11, the r3 mock's `drawPeek` and
 * `drawStripMap`): its three levels on one line that never moves.
 *
 * - **Level 0:** the progress line alone, the whole cook on true minutes from
 *   margin to margin, its done part filled. No sheet. The line is level 2's
 *   last time track (`layoutTimetable`, bottom-anchored over the foot).
 * - **Level 1:** a Paper sheet at the line − 150 (190 in portrait), and on the
 *   line the strip map (`strip-map.ts`): the fill folds into "now", the rest
 *   of the line turns Ink and is its rail.
 * - **Level 2:** the timetable (`overview-place.ts`) on its sheet from 18,
 *   bottom-anchored so its last track is the line. Its marks grow up out of
 *   the line on the way there, its words after them.
 *
 * Between levels everything is a place at each level and a curve between
 * them (`derivedFrame`), so a pull costs no layout. Nothing here is laid out
 * on a timer's tick: the line's fill and the map's counting words are said
 * from the clock's minute (`FrameState.now`, `SmWord.live`).
 */

import type { CookTask } from "./cook-plan";
import { SIDE, placeOverview, type OverviewPlace } from "./overview-place";
import {
  clamp,
  depthOf,
  easeIO,
  lerp,
  sstep,
  ttBlock,
  type Frame,
  type FrameState,
  type LayoutInput,
  type LevelPlace,
  type DerivedLayout,
  type SheetLayout,
  type TtPlace,
} from "./sheet-layout";
import { LINE_FROM_FOOT, SHEET1_ABOVE_LINE, layoutStripMap, lineFill, stationName, type StripMapDrawing } from "./strip-map";
import { nowOn } from "./timetable-layout";

/** The sheet's Paper: radius 28, its grabber 60 × 6 at 10 under its top (SPEC §10). */
export const PAPER_R = 28;
export const GRAB = { w: 60, h: 6, top: 10 } as const;
/** The line: a 4 cpx rounded track (SPEC §10). */
export const LINE_H = 4;
/** The track's Ink at level 0 and 2 (13%), the rail's at level 1 (Ink). */
export const TRACK_INK = 0.13;
/** The time to the table on the plate (level 1, landscape): its rung in `ttSizes` (Caprasimo 40, words 22). */
export const TT_PLATE = 3;
/**
 * Level 0's room under the step, cpx over the foot: as written's band floor, so a step keeps the
 * size it fit at before the line (the line's 52 cpx target, centred 56 over the foot, reaches 2
 * into the step's bottom gap).
 */
export const BAND0 = 80;
/**
 * The depth by which the line's fill has gone from the end of the step in hand (levels 0 and 1) to
 * the clock's minute (the whole cook). It eases over nearly the whole way up, so no frame of a
 * glide takes much of it, and stands at the clock's minute just before the sheet lands (the
 * minutes are drawn where they land, T3 fix round).
 */
export const LINE_FILL_NOW = 1.9;
/** Its rung at the header (level 2; portrait's level 1): Caprasimo 40, words 26. */
const TT_HEAD = 1;

export interface DerivedSheet {
  /** The line's centre on screen, px: level 2's last time track, at every level. */
  lineY: number;
  /** The whole cook's minutes, on true minutes (no break compressed). */
  total: number;
  /** The minute the line fills to at rest and under the peek: the end of the screen in hand (`Strip.progress`, v1.54). */
  progress: number;
  /** Level 0: the line from margin to margin, px. */
  line0: { x0: number; x1: number };
  /** Level 1: the strip map, cpx from the line's centre; and its rail, px. */
  map: StripMapDrawing;
  line1: { x0: number; x1: number };
  /** Level 2: the last row's time track and its fill as laid, px; its marks' keys (the line draws them). */
  line2: { x0: number; x1: number; fill: number; keys: string[] };
  /** The line in the timetable's own cpx (from `Y2`): where its marks grow from. */
  growFrom: number;
  /** The sheet's Paper top at each level, px (level 0's is under the screen). */
  paper: [number, number, number];
}

/** The level-2 last row's track and fill marks, in the drawing (cpx from `Y2`). */
function lastTrack(ov: OverviewPlace) {
  const tracks = ov.drawing.marks.filter((m) => m.role === "track");
  if (!tracks.length) throw new Error("the timetable drew no time track");
  const trk = tracks.reduce((a, b) => (b.y > a.y ? b : a));
  const fill = ov.drawing.marks.find((m) => m.role === "track-fill" && m.k === trk.k.replace(/^trk/, "trkf"));
  if (!fill) throw new Error(`the timetable's track ${trk.k} has no fill`);
  return { trk, fill };
}

export function layoutDerived(input: LayoutInput, tasks: ReadonlyMap<string, CookTask>): DerivedLayout {
  const { strip, geo: g, step, measure } = input;
  const c = g.c;
  const tt2In = input.timetable;
  if (!tt2In) throw new Error("a derived plan's sheet needs its timetable");
  const opening = input.opening;
  const { tw, sub, TZ, td, numEm, widest } = ttBlock(strip, c, measure);
  const overview = placeOverview({
    timetable: tt2In.t,
    other: tt2In.other,
    geo: g,
    measure,
    chrome: input.chrome ?? { more: { w: 0, h: 0 }, controls: null, hint: false },
    // The mode still switches at the first screen (`setMode`): the Prep screen, or "Prep first"'s first prep page.
    toggle: (opening !== null || strip.modeOpen === true) && strip.hasMise === true,
    title: input.title ?? "",
    opening,
    read: input.read && !opening ? { key: input.read.key, text: input.read.text, go: input.read.go ?? null } : null,
    topLine: input.topLine === true,
    ttDims: td,
  });
  const Y2 = overview.Y2;
  const portrait = g.portrait;

  // ---- the line: level 2's last track, where it stands on the cook screen ----
  // On the opening the timetable has the whole screen and no level 0 or 1: the line stands where
  // the cook screen's will, over the foot.
  const lt = opening ? null : lastTrack(overview);
  const lineY = lt ? Y2 + (lt.trk.y + lt.trk.h / 2) * c : g.footTop - LINE_FROM_FOOT * c;
  const growFrom = (lineY - Y2) / c;
  const x0c = SIDE;
  const x1c = g.W / c - SIDE;
  const above = portrait ? SHEET1_ABOVE_LINE.portrait : SHEET1_ABOVE_LINE.landscape;

  // ---- level 1: the strip map, on the line ----
  const ttRight = (overview.tt.x + td[TT_HEAD].w) / c;
  const map = layoutStripMap({
    marks: strip.marks,
    now: strip.now,
    total: strip.totalMinutes,
    name: (m) => stationName(m, tasks),
    toTable: tw.num,
    toTableWidest: widest,
    toTableWords: tw.words,
    x0: x0c,
    x1: x1c,
    measure: (text, size, weight, family) => measure(text, size * c, weight, family) / c,
    portrait: portrait ? { ttRight } : null,
  });

  // ---- the detents: the stage's floor over the line, the sheet at level 1, the timetable's ----
  const Y0 = g.footTop - BAND0 * c;
  const Y1 = lineY - above * c;
  const paper: [number, number, number] = [g.H + 10 * c, Y1, Y2 + 18 * c];
  const band = g.footTop - Y0;

  // The step shrinks as a unit to stand clear of the level-1 sheet, never under 22 cpx a line.
  let stepOut: SheetLayout["step"] = null;
  if (step) {
    const avail = Y1 - 22 * c - g.stepTop;
    const floor = Math.min(1, 22 / (64 * step.restFit));
    const sc1 = clamp(avail / Math.max(1, step.keepH), floor, 1);
    stepOut = { sc1, fit1: step.restFit * sc1, pages1: false, keepH: step.keepH, fullH: step.fullH, inkW: step.inkW };
  }

  // ---- time to the table: on the plate (landscape) or the sheet's top right (portrait), then the header ----
  const tts = (top: number, at: "plate" | "head"): TtPlace => {
    if (at === "head") return { x: overview.tt.x, top, z: TT_HEAD, col: 1, op: 1, wx: 0, wy: 0 };
    // On the plate: "1 h 02" right-set over it in Caprasimo 40, "to the table" right-set under the rail.
    const num = map.words.find((w) => w.role === "tt-num")!;
    const words = map.words.find((w) => w.role === "tt-words");
    const x = num.x * c;
    const wx = words ? (words.x - num.x) * c : 0;
    const wy = words ? (words.y - (num.y + TZ[TT_PLATE].n / c)) * c : 0;
    return { x, top, z: TT_PLATE, col: 1, op: 1, wx, wy };
  };
  const tt1 =
    map.ttAt === "header"
      ? tts(paper[1] + 14 * c - Y1, "head")
      : tts(lineY + map.words.find((w) => w.role === "tt-num")!.y * c - Y1, "plate");
  // Level 0 shows none: it stands where level 1's will, faded, so the pull brings it in where it stays.
  const tt0: TtPlace =
    map.ttAt === "header" ? { ...tt1, top: paper[0] + 14 * c - Y0, op: 0 } : { ...tt1, top: tt1.top + Y1 - Y0, op: 0 };
  const tt2: TtPlace = { x: overview.tt.x, top: overview.tt.top, z: overview.tt.z, col: 1, op: overview.tt.op, wx: 0, wy: 0 };
  const place = (tt: TtPlace): LevelPlace => ({
    bars: [],
    labs: [],
    now: { x: 0, y0: 0, y1: 0, op: 0 },
    endr: { x: 0, y0: 0, y1: 0, op: 0 },
    tt,
  });

  const line2 = lt
    ? { x0: lt.trk.x * c, x1: (lt.trk.x + lt.trk.w) * c, fill: lt.fill.w * c, keys: [lt.trk.k, lt.fill.k] }
    : { x0: x0c * c, x1: x1c * c, fill: 0, keys: [] };

  // ---- the nudge: at the edge, over the line's tap target ----
  const nudgeOut: SheetLayout["nudge"] = input.nudge ? { text: input.nudge.text, x: g.E, maxW: g.W - 2 * g.E, bottom: g.H - Y0 + 10 * c } : null;
  const marks = strip.marks;
  const named = overview.drawing.words.filter((w) => w.role === "block-label" && w.block).map((w) => w.block!);

  return {
    geo: g,
    asWritten: false,
    detents: [Y0, Y1, Y2],
    band,
    axA: { t0: 0, T: Math.max(1e-3, strip.totalMinutes), x0: x0c * c, x1: x1c * c },
    axC: { t0: 0, T: Math.max(1e-3, strip.totalMinutes), x0: x0c * c, x1: x1c * c },
    marks,
    inHand: marks.findIndex((m) => m.state === "in-hand"),
    labs1: marks.map(() => null),
    labs2: marks.map(() => null),
    px1: 22 * c,
    px2: 22 * c,
    lh1: 0,
    lh2: 0,
    looks: marks.map(() => ({ base: "", ring: "" })),
    order: [],
    P: [place(tt0), place(tt1), place(tt2)],
    nudge: nudgeOut,
    step: stepOut,
    now: strip.now,
    tt: { num: tw.num, words: tw.words, sub, sizes: TZ, dims: td, numEm, widest },
    chart: { x0: 0, x1: 0, rowsTop: 0, rowsBottom: 0, rows: [] },
    ghost: overview.ghost,
    read: null,
    overview,
    opening: overview.opening != null,
    topLine: input.topLine === true,
    outlineMore: null,
    hint: { x: 0, y: 0 },
    derived: {
      lineY,
      total: strip.totalMinutes,
      progress: strip.progress,
      line0: { x0: x0c * c, x1: x1c * c },
      map,
      line1: { x0: map.rail.x0 * c, x1: map.rail.x1 * c },
      line2,
      growFrom,
      paper,
    },
    summary: {
      rows1: map.stations.filter((s) => s.kind === "step").map((s) => s.key),
      folded1: [],
      gaveWay1: [],
      fit1: stepOut?.fit1 ?? 1,
      pages1: false,
      px1: Math.min(...map.words.map((w) => w.size)),
      rows2: overview.drawing.hits.length,
      px2: Math.min(...overview.drawing.words.map((w) => w.size)),
      minutes2: true,
      named2: named,
      shed2: overview.drawing.demoted,
      fits2: overview.drawing.fits,
    },
  };
}

/** A frame's line: its left end and width, its fill, and its Ink (0 the 13% track, 1 the rail's Ink). */
export interface LineFrame {
  x: number;
  w: number;
  fill: number;
  ink: number;
}

export interface DerivedFrame {
  /** The Paper's top on screen, px. */
  paperTop: number;
  line: LineFrame;
  /**
   * The progress line's fill as painted, px on level 0's track (the line never moves): to the end of
   * the step in hand at rest and under the peek (levels 0 and 1), gliding to the clock's minute on
   * the way to the whole cook, where it stands by `LINE_FILL_NOW` (just before the sheet lands).
   */
  fill: number;
  /** The strip map's stations. */
  stations: number;
  /** The timetable: shown (its marks growing from the line, `grow` 0 → 1), and its words. */
  lanes: number;
  grow: number;
  words: number;
}

const lineAt = (a: LineFrame, b: LineFrame, t: number): LineFrame => ({
  x: lerp(a.x, b.x, t),
  w: lerp(a.w, b.w, t),
  fill: lerp(a.fill, b.fill, t),
  ink: lerp(a.ink, b.ink, t),
});

/**
 * Every part's place at depth d (SPEC §11): the sheet rises from under the
 * screen to level 1 and on to the top; the line stays where it is, its fill
 * folding into now and its track turning Ink (0 → 1), then back to the track
 * with the fill out to now (1 → 2). The stations fade in over the second half
 * of 0 → 1 and out over the first 15% of 1 → 2, before the timetable's marks
 * grow up out of the line; its words follow over the last 45%. A glide
 * straight between 0 and 2 (`pass` 1) shows no stations: the line goes
 * straight from one track to the other. A pass cut short eases its weight
 * out: between 0 and 1 the frame is the two drawings mixed by it, so the
 * picture carries on from where it was (T3 fix round); at depths 0 and 2
 * the two are one picture.
 */
export function derivedFrame(L: DerivedLayout, s: FrameState): Frame {
  const D = L.derived;
  const g = L.geo;
  const c = g.c;
  const ov = L.overview;
  const Y = s.Y;
  const d = depthOf(L, Y);
  const pw = clamp(s.pass ?? 0, 0, 1);
  const now = s.now ?? L.now;
  // Level 0's fill ends where the step in hand ends, not at the clock's minute (v1.54): a timer's
  // minutes don't move it. The whole cook (level 2) keeps the clock's minute.
  const progress = s.progress ?? D.progress;
  const fill0 = lineFill(D.total, progress, D.line0.x0, D.line0.x1);
  const fill = L.opening ? fill0 : lerp(fill0, lineFill(D.total, now, D.line0.x0, D.line0.x1), sstep(1, LINE_FILL_NOW, d));
  const P0: LineFrame = { x: D.line0.x0, w: D.line0.x1 - D.line0.x0, fill: fill0, ink: 0 };
  const P1: LineFrame = { x: D.line1.x0, w: D.line1.x1 - D.line1.x0, fill: 0, ink: 1 };
  // Level 2's fill is the clock's too (its end is the now line; T3 follow-up), on the held axis.
  const clock = ov.drawing.clock;
  const fill2 = clock && D.line2.keys.length ? nowOn(clock, now).fills.get(D.line2.keys[1])! * c : D.line2.fill;
  const P2: LineFrame = { x: D.line2.x0, w: D.line2.x1 - D.line2.x0, fill: fill2, ink: 0 };
  const own = d <= 1 ? lineAt(P0, P1, easeIO(d)) : lineAt(P1, P2, easeIO(d - 1));
  const line = L.opening ? P2 : lineAt(own, lineAt(P0, P2, easeIO(d / 2)), pw);
  const paperTop = d <= 1 ? lerp(D.paper[0], D.paper[1], d) : lerp(D.paper[1], D.paper[2], d - 1);
  const stations = L.opening ? 0 : (1 - pw) * (d <= 1 ? sstep(0.5, 1, d) : 1 - sstep(1, 1.15, d));
  const grow = L.opening ? 1 : sstep(1, 2, d);
  const words = L.opening ? 1 : sstep(1.55, 2, d);

  // The step stays clear of the rising Paper, its meta gone within the first 40 px of a pull; past
  // level 1 it turns ink-soft and fades under the timetable.
  let step: Frame["step"] = null;
  if (L.step) {
    const st = L.step;
    const m = sstep(0, 40, L.detents[0] - Y);
    const avail = Math.min(paperTop, L.detents[0]) - g.stepTop - 22 * c;
    const need = st.keepH + (st.fullH - st.keepH) * (1 - m);
    const sc = d > 1 ? st.sc1 : clamp(avail / Math.max(1, need), st.sc1, 1);
    step = { scale: sc, op: 1 - sstep(1.0, 1.35, d), ember: 1 - sstep(1.0, 1.2, d), meta: 1 - m };
  }

  // Time to the table: in with the stations, along to the header; on a pass it fades in at the header.
  const A = L.P[0].tt;
  const B = L.P[1].tt;
  const C = L.P[2].tt;
  const z = L.tt.sizes;
  const dims = L.tt.dims;
  const ttOf = (a: TtPlace, b: TtPlace, t: number, op: number): Frame["tt"] => ({
    x: lerp(a.x, b.x, t),
    y: lerp(a.top, b.top, t),
    n: lerp(z[a.z].n, z[b.z].n, t),
    w: lerp(z[a.z].w, z[b.z].w, t),
    col: 1,
    sub: lerp(z[a.z].sub, z[b.z].sub, t),
    dw: lerp(dims[a.z].w, dims[b.z].w, t),
    dh: lerp(dims[a.z].h, dims[b.z].h, t),
    op,
    wx: lerp(a.wx, b.wx, t),
    wy: lerp(a.wy, b.wy, t),
  });
  // Sheet-local tops are linear in depth, as the sheet's edge is: the plate's stays put on screen.
  // On a pass it stands at the header's place on screen and fades in.
  const head: TtPlace = { ...C, top: C.top + (L.detents[2] - Y) };
  const mixTt = (a: Frame["tt"], b: Frame["tt"], t: number): Frame["tt"] => ({
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    n: lerp(a.n, b.n, t),
    w: lerp(a.w, b.w, t),
    col: 1,
    sub: lerp(a.sub, b.sub, t),
    dw: lerp(a.dw, b.dw, t),
    dh: lerp(a.dh, b.dh, t),
    op: lerp(a.op, b.op, t),
    wx: lerp(a.wx, b.wx, t),
    wy: lerp(a.wy, b.wy, t),
  });
  const ownTt = d <= 1 ? ttOf(A, B, d, sstep(0.5, 1, d)) : ttOf(B, C, d - 1, lerp(B.op, C.op, d - 1));
  const tt = L.opening ? ttOf(C, C, 1, C.op) : pw === 0 ? ownTt : mixTt(ownTt, ttOf(head, head, 1, C.op * sstep(1.5, 2, d)), pw);

  // The top line gives way to the timetable's words (N3-4(f)); it is gone on the opening.
  const header = L.opening ? 0 : L.topLine ? 1 : 1 - words;
  const off = { x: 0, y0: 0, h: 0, op: 0 };
  return {
    d,
    sheetTop: Y,
    sheetBottom: lerp(g.footTop, ov.sheetBottom, grow),
    step,
    nudge: { op: 1 - sstep(0, 0.3, d), dy: Math.max(0, Y - L.detents[0]) },
    bars: [],
    labs1: [],
    labs2: [],
    now: off,
    endr: off,
    tt,
    hair: 0,
    chart: 0,
    lanes: words,
    header,
    hint: sstep(0.6, 1, d),
    derived: { paperTop, line, fill, stations, lanes: d > 1.001 || L.opening ? 1 : 0, grow, words },
  };
}
