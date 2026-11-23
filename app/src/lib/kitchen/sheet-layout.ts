/**
 * The cook sheet's drawing: where every part of the look-ahead stands at each
 * of its three pull depths, and at any depth between them (P58, N4, N5; N2-1
 * to N2-4). One sheet, one set of marks: a pull moves the sheet's edge, and
 * every mark travels between its places at the two levels around that depth.
 *
 * A derived plan's levels are the progress line, the strip map on it and the
 * timetable growing out of it (overview slice T3): `sheet-derived.ts`. This
 * file lays out a plan cooked as written, and holds what both share (the
 * frame's shape, the depth, the time to the table's sizes):
 *
 * - Level 0, Now: the strip on the band, every mark at its time.
 * - Level 1, "Until you can step away" (N2-2): the next steps, a row each.
 *   Short of room the rows give way from the end, then the step takes its
 *   ladder to 0.8, then it pages.
 * - Level 2, the outline: one name a row, "and N more" under it, and a read
 *   band at the top.
 * - Whole recipe (level 3) is a borrowed screen over the sheet: it has no
 *   place here.
 *
 * Every box lies inside the screen at every level. Pure: text is measured
 * through an injected `measure` (canvas in the browser, a fixed-width fake in
 * the units), and the DOM's own metrics come in as numbers.
 */

import type { Strip, StripMark } from "./cook-strip";
import { markColors, toTableCountdown } from "./cook-strip";
import { writtenRows } from "./cook-levels";
import { COOK_COPY } from "./cook-view";
import type { OverviewChrome, OverviewPlace } from "./overview-place";
import type { GetOutItem } from "./timetable-layout";
import type { Timetable } from "./timetable-model";
import type { CookTask } from "./cook-plan";
import { derivedFrame, layoutDerived, type DerivedFrame, type DerivedSheet } from "./sheet-derived";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A text's width in px: `family` "text" is Figtree, "display" Caprasimo. */
export type Measure = (text: string, px: number, weight: number, family?: "text" | "display") => number;

export interface SheetGeo {
  /** The viewport. */
  W: number;
  H: number;
  /** One counter px, in CSS px. */
  c: number;
  /** The cook view's edge (`--edge`). */
  E: number;
  /** The top line's bottom: the header's lower edge. */
  top: number;
  /** Where the step's block starts, at rest. */
  stepTop: number;
  /** The foot's top. */
  footTop: number;
  /** The borrowed screen's ledge band top. */
  ledgeTop: number;
  portrait: boolean;
}

/** The step block as the stage drew it at rest (px, untransformed, from its top). */
export interface StepBox {
  /** The bottom of the step's words. */
  textH: number;
  /** The bottom of what stays as the sheet rises: the words, and a running clock's row. */
  keepH: number;
  /** The bottom of the whole block, its meta included. */
  fullH: number;
  /** The widest line of ink, from the edge. */
  inkW: number;
  /** The fit's scale at rest (1.2 … 0.8). */
  restFit: number;
  /** The step's words. */
  text: string;
}

export interface NudgeIn {
  text: string;
  /** The mark it names. */
  targetKey: string;
  /** The plan minute it stands over (the walk-away line: the break's start); else the mark's start. */
  at?: number;
}

export interface LayoutInput {
  strip: Strip;
  geo: SheetGeo;
  step: StepBox | null;
  nudge: NudgeIn | null;
  /** A step being read at level 2: as written a band at the top (N2-4), derived the slot (N3-9), with its Go. */
  read: { key: string; text: string; go?: "step" | "prep" | null } | null;
  /** The opening: what to get out, "for 8" when the cook scaled the recipe, and the hands-on minutes. */
  opening: { getOut: GetOutItem[]; scaleNote: string | null; handsOn?: string | null } | null;
  /** The whole cook as a timetable, this prep mode's and the other's (a derived plan; null as written). */
  timetable?: { t: Timetable; other: Timetable } | null;
  /** The recipe's name: the opening's title and level 2's header. */
  title?: string;
  measure: Measure;
  /** The live chrome the whole cook hosts (More, the opening's controls); measured on screen. */
  chrome?: OverviewChrome;
  /** Keep the top line at the whole cook (N3-4(f)'s alternative). */
  topLine?: boolean;
  /** The plan's tasks, by id: a derived plan's strip map names its steps by them. */
  tasks?: ReadonlyMap<string, CookTask>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const sstep = (a: number, b: number, x: number) => {
  // A step of no width is a switch, past its edge.
  if (b <= a) return x > b ? 1 : 0;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeIO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const STOP = new Set(["the", "a", "an", "and", "with", "in", "into", "for", "of", "to", "until", "then", "on", "or", "at", "it"]);

/** A name as the sheet sets it: its first letter up ("cook dal" → "Cook dal"). */
export function capFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** "25 min", "1 h", "1 h 10": a mark's own minutes, never 0. */
export function hm(m: number): string {
  const r = Math.max(1, Math.round(m));
  if (r < 60) return `${r} min`;
  const h = Math.floor(r / 60);
  const rest = r % 60;
  return rest ? `${h} h ${String(rest).padStart(2, "0")}` : `${h} h`;
}

/** Text cut at a word to `maxW`, never on a stop word, with "…" after it. */
export function cutToWidth(text: string, px: number, wt: number, maxW: number, measure: Measure): string {
  if (measure(text, px, wt) <= maxW) return text;
  const w = text.replace(/[.]$/, "").split(" ");
  for (let k = w.length - 1; k > 0; k--) {
    let kk = k;
    while (kk > 1 && STOP.has(w[kk - 1].toLowerCase().replace(/[,;:]/g, ""))) kk--;
    const t = `${w.slice(0, kk).join(" ").replace(/[,;:]$/, "")}…`;
    if (measure(t, px, wt) <= maxW) return t;
  }
  return `${w[0]}…`;
}

/** Words set in lines no wider than `maxW` (a word wider than that stands alone on its line). */
export function wrapLines(
  text: string,
  px: number,
  wt: number,
  maxW: number,
  measure: Measure,
  family: "text" | "display" = "text",
  /** Where a line may break: any space, or (`/ +/`) only a plain one, keeping no-break spaces whole. */
  breaks: RegExp = /\s+/,
): string[] {
  const words = text.split(breaks).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next, px, wt, family) > maxW) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export interface Axis {
  t0: number;
  T: number;
  x0: number;
  x1: number;
}
export const axX = (a: Axis, t: number) => a.x0 + (t - a.t0) * ((a.x1 - a.x0) / Math.max(1e-6, a.T - a.t0));
export const axK = (a: Axis) => (a.x1 - a.x0) / Math.max(1e-6, a.T - a.t0);

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

/** One name over its mark: one or two lines, and its minutes after the last. */
export interface Label {
  lines: string[];
  /** " · 14 min left", " · 2 min", or "". */
  mn: string;
  w: number;
  /** In hand: semibold. */
  cur: boolean;
}

/** A mark at one level: x and width on screen, its line's middle from the sheet's edge. */
export interface BarPlace {
  x: number;
  w: number;
  cy: number;
  h: number;
  op: number;
  /** px of spent ink from the left. */
  fill: number;
}

/** A word that rides its mark: offset from the mark's left and top at this level. */
export interface RidePlace {
  dx: number;
  dy: number;
  op: number;
}

export interface LinePlace {
  x: number;
  y0: number;
  y1: number;
  op: number;
}

export interface TtPlace {
  x: number;
  top: number;
  /** Size index: 0 the strip's, 1 the stretch's (and the header's), 2 the chart's (with hands-on), 3 the plate's. */
  z: number;
  /** 0: ink-soft, 1: ink. */
  col: number;
  op: number;
  /** Its words' offset from under the number, px: on the plate they stand under the rail (T3). */
  wx: number;
  wy: number;
}

export interface LevelPlace {
  bars: BarPlace[];
  /** The level's own name over each mark (level 0 draws none). */
  labs: RidePlace[];
  now: LinePlace;
  endr: LinePlace;
  tt: TtPlace;
}

/** A chart row's tap band (at least 48 px) and the marks on it. */
export interface ChartRow {
  top: number;
  bottom: number;
  js: number[];
}

/** The as-written outline at level 2: its rows' span, from the sheet's edge there. */
export interface ChartPlace {
  x0: number;
  x1: number;
  rowsTop: number;
  rowsBottom: number;
  rows: ChartRow[];
}

/** The read band (N2-4): the step's words at the largest size that fits a third of the sheet, Go and Whole recipe. */
export interface ReadBand {
  key: string;
  lines: string[];
  px: number;
  /** From the sheet's edge at the chart. */
  top: number;
  height: number;
  textX: number;
  textTop: number;
  textW: number;
  /** The buttons' row: Go then the ghost. */
  btnX: number;
  btnY: number;
}

/**
 * A sheet's layout: a derived plan's (its line, strip map and timetable: `derived` and `overview`
 * both set) or a plan as written's (both null), told apart by `asWritten` (T3 fix round).
 */
export type SheetLayout = SheetLayoutCommon &
  (
    | {
        asWritten: false;
        /** The whole cook: the timetable and what stands round it. */
        overview: OverviewPlace;
        /** The levels: the line, the strip map, the Paper (slice T3). */
        derived: DerivedSheet;
      }
    | { asWritten: true; overview: null; derived: null }
  );

/** A derived plan's layout. */
export type DerivedLayout = Extract<SheetLayout, { asWritten: false }>;

interface SheetLayoutCommon {
  geo: SheetGeo;
  /** The sheet's edge at each pull depth: Now, the stretch, the chart. */
  detents: [number, number, number];
  band: number;
  /** The strip's axis at Now. */
  axA: Axis;
  /** The chart's axis, 0 to the table. */
  axC: Axis;
  marks: StripMark[];
  /** Index of the mark in hand, or -1. */
  inHand: number;
  labs1: (Label | null)[];
  labs2: (Label | null)[];
  px1: number;
  px2: number;
  lh1: number;
  lh2: number;
  looks: { base: string; ring: string }[];
  /** z order: waits under hands-on. */
  order: number[];
  P: [LevelPlace, LevelPlace, LevelPlace];
  /** The nudge, placed over the mark it names. */
  nudge: { text: string; x: number; maxW: number; bottom: number } | null;
  /** The step: its scale at the stretch (relative to rest) and whether it pages there. */
  step: { sc1: number; fit1: number; pages1: boolean; keepH: number; fullH: number; inkW: number } | null;
  /** The cook's minute. */
  now: number;
  tt: {
    num: string;
    words: string;
    sub: string;
    sizes: { n: number; w: number; sub: number }[];
    dims: { w: number; h: number }[];
    /**
     * The number's box, in ems of its own size: the widest it says until the layout is laid again
     * (`widest`). The page says the number from the clock, which counts it down while the layout
     * holds ("1 h" becomes the wider "55 min"), so the box is laid out for all of them; the
     * number is right-set in it where its place is right-set (slice T3, call 13).
     */
    numEm: number;
    /** The widest thing the number says until the layout is laid again (what its place is measured with). */
    widest: string;
  };
  chart: ChartPlace;
  /** The whole cook's "Whole recipe" ghost, under the hands-on line (no read, not the opening). */
  ghost: { x: number; y: number; w: number; h: number } | null;
  /** The as-written read band (N2-4); a derived plan reads in the overview's slot. */
  read: ReadBand | null;
  /** The opening shows (the overview's band, no top line, no foot). */
  opening: boolean;
  /** The top line stays at the whole cook (N3-4(f)'s alternative). */
  topLine: boolean;
  /** As written: "and N more steps" under the outline at the chart. */
  outlineMore: { text: string; y: number; w: number } | null;
  /** The voice hint while pinned. */
  hint: { x: number; y: number };
  /** What the levels chose, for tests and the critic notes. */
  summary: {
    rows1: string[];
    folded1: string[];
    gaveWay1: string[];
    fit1: number;
    pages1: boolean;
    px1: number;
    rows2: number;
    px2: number;
    minutes2: boolean;
    named2: string[];
    shed2: string[];
    /** The chart's rows (and the outline's "and N more") end inside the sheet. */
    fits2: boolean;
  };
}

const BAR = 6;
const LG = 5;
const LH = 1.1;
/** Every row's tap band at the chart, px (N2-4). */
export const ROW_BAND = 48;
/** The Go pill and the ghost: a tap target's height, px. */
const BTN_H = 48;

/**
 * The time-to-the-table block at its sizes (N2-1: 30 / 40 / 48), and the
 * strip map's plate (slice T3: Caprasimo 40, its words at 22 under the rail).
 */
function ttSizes(c: number) {
  return [
    { n: 30 * c, w: 22 * c, sub: 0 },
    { n: 40 * c, w: 26 * c, sub: 0 },
    { n: 48 * c, w: 28 * c, sub: 1 },
    { n: 40 * c, w: 22 * c, sub: 0 },
  ];
}

/** Time to the table's words, its hands-on line, and its block at each size (px). */
export function ttBlock(strip: Strip, c: number, measure: Measure) {
  const tw = tableWords(strip);
  const sub = strip.asWritten || strip.handsOnLeft === null ? "" : strip.handsOnLeft;
  const TZ = ttSizes(c);
  // A derived plan's number counts down with the clock while the layout holds (call 13): its place
  // is measured for the widest it says before then. As written it counts steps, which only an
  // advance changes, and an advance lays the sheet out again.
  const says = strip.asWritten || tw.num === "Ready" ? [tw.num] : toTableCountdown(strip.totalMinutes - strip.now);
  const numW = (n: number) => Math.max(...says.map((s) => measure(s, n, 400, "display")));
  const widest = says.reduce((a, s) => (measure(s, TZ[1].n, 400, "display") > measure(a, TZ[1].n, 400, "display") ? s : a), tw.num);
  const td = TZ.map((z) => {
    const w = Math.max(
      numW(z.n),
      tw.words ? measure(tw.words, z.w, 500) : 0,
      z.sub && sub ? measure(sub, 22 * c, 500) : 0,
    );
    const h = z.n * 1.0 + (tw.words ? z.w * 1.15 : 0) + (z.sub && sub ? 22 * c * 1.3 + 4.4 * c : 0);
    return { w, h };
  });
  const numEm = numW(TZ[1].n) / TZ[1].n;
  return { tw, sub, TZ, td, numEm, widest };
}

/** "35 min" over "to the table"; as written "6 steps" over "to go"; "Ready" alone. */
export function tableWords(strip: Strip): { num: string; words: string } {
  if (strip.timeToTable === "Ready") return { num: "Ready", words: "" };
  if (strip.asWritten) {
    const m = /^(\d+ steps?) (to go)$/.exec(strip.timeToTable);
    if (m) return { num: m[1], words: m[2] };
    return { num: strip.timeToTable, words: "" };
  }
  return { num: strip.timeToTable, words: "to the table" };
}

type Rows1 = {
  cy: Map<number, number>;
  top: number;
  bottom: number;
  pitch: number;
  headTop: number;
  headH: number;
  bottomPad: number;
  foldY: number | null;
};
type Pack2 = { cy: Map<number, number>; rows: ChartRow[]; bottom: number };

/** The read band's sizes, cpx (N2-4). */
const READ_SIZES = [44, 30, 26, 22];

export function buildLayout(input: LayoutInput): SheetLayout {
  // A read band that leaves the chart no room steps down (sizes, then lines
  // at 22) until the chart fits under it. It also steps down its sizes, but
  // never cuts a line, while the chart under it has had to drop the read
  // step's name (critic round 2): the words whole at 22 and the step named
  // where it stands beat larger words over an unnamed mark. Where no size
  // names it, the band keeps the largest size the chart fits under (critic
  // round 3: it had stepped down to 22 for nothing).
  const readShed = (l: SheetLayout) => l.read !== null && l.summary.shed2.includes(l.read.key);
  let L = layoutAt(input, 0);
  let firstFit: SheetLayout | null = L.summary.fits2 ? L : null;
  for (let rung = 1; L.read && (!L.summary.fits2 || (readShed(L) && rung < READ_SIZES.length)); rung++) {
    const atFloor = L.read.px <= 22 * input.geo.c + 1e-6 && L.read.lines.length === 1;
    if (atFloor) break;
    L = layoutAt(input, rung);
    firstFit ??= L.summary.fits2 ? L : null;
  }
  if (L.summary.fits2 && !readShed(L)) return L;
  return firstFit ?? L;
}

function layoutAt(input: LayoutInput, readRung: number): SheetLayout {
  const { strip, geo: g, step, measure } = input;
  // A derived plan's levels are the line, the strip map and the timetable (slice T3).
  if (!strip.asWritten) {
    if (!input.tasks) throw new Error("a derived plan's sheet needs its plan's tasks");
    return layoutDerived(input, input.tasks);
  }
  // As written (N2-4): the strip on the band, the next steps a row each, the outline.
  const c = g.c;
  const marks = strip.marks;
  const n = marks.length;
  const now = strip.now;
  const inHand = marks.findIndex((m) => m.state === "in-hand");
  const all = marks.map((_, j) => j);
  const span = (j: number): [number, number] => [marks[j].start, marks[j].end];

  const { tw, sub, TZ, td, numEm, widest } = ttBlock(strip, c, measure);

  // A name is the step's own words: on one line, else two, cut at a word only past that.
  const chooseLab = (j: number, px: number, room: number): Label => {
    const cur = j === inHand;
    const wt = cur ? 600 : 500;
    const name = capFirst(marks[j].label);
    if (measure(name, px, wt) <= room) return { lines: [name], mn: "", w: measure(name, px, wt), cur };
    const words = name.split(" ");
    let k = 1;
    while (k < words.length && measure(words.slice(0, k + 1).join(" "), px, wt) <= room) k++;
    const first = words.slice(0, k).join(" ");
    const second = cutToWidth(words.slice(k).join(" "), px, wt, room, measure);
    return { lines: [first, second], mn: "", w: Math.max(measure(first, px, wt), measure(second, px, wt)), cur };
  };
  const sizes: [number, number][] = (g.portrait ? ([[30, 12], [28, 10]] as [number, number][]) : []).concat([
    [26, 10],
    [24, 8],
    [22, 6],
    [22, 4],
  ]);

  // ---- Level 0: the band, the strip and the time to the table ----
  const t0 = 0;
  const T = Math.max(t0 + 1e-3, strip.totalMinutes);
  const x1A = g.portrait ? g.W - g.E - 16 * c - td[0].w : g.W - g.E - 16 * c - td[2].w;
  const axA: Axis = { t0, T, x0: g.E, x1: x1A };
  const band = Math.max(80 * c, 44 * c, td[0].h + 24 * c);
  const Y0 = g.footTop - band;
  const restMid = band / 2 + 4 * c;
  const stripBar = (j: number): { x: number; w: number } => {
    const [s0, s1] = span(j);
    const x = axX(axA, s0);
    const x1 = Math.max(x + 4 * c, axX(axA, s1) - 2 * c);
    return { x, w: Math.max(4 * c, x1 - x) };
  };

  // ---- Level 1: the next steps, a row each ----
  const rows1All = writtenRows(strip).map((m) => marks.indexOf(m));
  const keep1 = rows1All.includes(inHand) ? inHand : (rows1All[0] ?? -1);
  // Rows give way from the end; never the anchor step (`keep1`).
  const shed1 = [...rows1All.filter((j) => j !== keep1)].reverse();
  const x1S = g.W - g.E - 24 * c - td[1].w;
  const tt1Top = 22 * c;
  const room1 = x1S - g.E;
  let labs1: (Label | null)[] = marks.map(() => null);
  let px1 = 26 * c;
  const setLabs1 = (fs: number) => {
    px1 = fs * c;
    labs1 = marks.map((_, j) => (rows1All.includes(j) ? chooseLab(j, px1, room1) : null));
  };
  // Portrait has no column beside the rows: the time to the table stands on a row of its own over them.
  const pack1 = (js: number[], rg: number): Rows1 => {
    const headTop = tt1Top + (g.portrait ? td[1].h + 18 * c : 0);
    const rowsTop = headTop;
    const bottomPad = 18 * c;
    const lh = px1 * LH;
    const cy = new Map<number, number>();
    let y = rowsTop;
    let pitch = 0;
    rows1All
      .filter((j) => js.includes(j))
      .forEach((j, q) => {
        if (q > 0) y += rg + 6 * c;
        const L = labs1[j]?.lines.length ?? 1;
        const y0 = y;
        const mid = y + L * lh + LG * c + (BAR * c) / 2;
        cy.set(j, mid);
        y = mid + (BAR * c) / 2;
        pitch = Math.max(pitch, y - y0 + rg);
      });
    return { cy, top: rowsTop, bottom: y, pitch: pitch || 30 * c, headTop, headH: 0, bottomPad, foldY: null };
  };
  const Y1of = (R: Rows1) => g.footTop - (R.bottom + R.bottomPad);
  const stepNeeds = (s: number) => (step ? g.stepTop + step.keepH * s + 22 * c : g.top + 60 * c);
  const ladder = step ? [1.2, 1.1, 1, 0.9, 0.8].filter((f) => f <= step.restFit + 1e-6) : [1];
  const keptAfter = (fits: (js: number[]) => boolean): number[] => {
    let kept = [...rows1All];
    for (const j of shed1) {
      if (fits(kept)) break;
      kept = kept.filter((k) => k !== j);
    }
    return kept;
  };
  let win1 = [...rows1All];
  let fit1 = step ? step.restFit : 1;
  let pages1 = false;
  let rg1 = 10 * c;
  let fs1 = 26;
  {
    // Room order: keep every row whole by stepping the step down its ladder to 0.8 and tightening
    // `[fs, rg]`; then shed rows from the end (never `keep1`); past 0.8 with the floor row alone, it pages.
    type Got = { f: number; fs: number; rg: number; kept: number[] };
    const fitsAt = (s: number, rg: number) => (js: number[]) => Math.min(Y1of(pack1(js, rg)), Y0 - 60 * c) >= stepNeeds(s);
    const rest = step ? step.restFit : 1;
    const fullLadder = step ? [rest, ...ladder.filter((f) => f < rest - 1e-6)] : [1];
    let best: Got | null = null;
    for (const f of fullLadder) {
      for (const [fs, rg] of sizes) {
        setLabs1(fs);
        if (fitsAt(step ? f / rest : 1, rg * c)(rows1All)) {
          best = { f, fs, rg: rg * c, kept: [...rows1All] };
          break;
        }
      }
      if (best) break;
    }
    const fMin = fullLadder[fullLadder.length - 1];
    if (!best) {
      for (const [fs, rg] of sizes) {
        setLabs1(fs);
        const fits = fitsAt(step ? fMin / rest : 1, rg * c);
        const kept = keptAfter(fits);
        if (fits(kept) && (!best || kept.length > best.kept.length)) {
          const fBest = fullLadder.find((f) => fitsAt(step ? f / rest : 1, rg * c)(kept)) ?? fMin;
          best = { f: fBest, fs, rg: rg * c, kept };
        }
      }
    }
    if (best) {
      fit1 = best.f;
      fs1 = best.fs;
      rg1 = best.rg;
      win1 = best.kept;
    } else {
      // Past 0.8 it pages, the floor's rows under it.
      setLabs1(22);
      fs1 = 22;
      rg1 = 4 * c;
      win1 = keep1 >= 0 ? [keep1] : [];
      fit1 = 0.8;
      pages1 = !!step;
    }
  }
  setLabs1(fs1);
  const R1 = pack1(win1, rg1);
  const in1 = new Set(win1);
  const sc1 = step ? fit1 / step.restFit : 1;
  const Y1 = pages1
    ? Math.min(Y1of(R1), Y0 - 60 * c)
    : Math.max(Math.min(Y1of(R1), Y0 - 60 * c), Math.min(stepNeeds(sc1), Y0 - 60 * c));

  // ---- Level 2: the outline, with its read band ----
  const Y2 = g.top;
  const sheetH2 = g.footTop - Y2;
  const ghostW = measure(COOK_COPY.wholeRecipe, 22 * c, 600) + 24 * c;
  const x0C = g.E;
  const x1C = g.portrait ? g.W - g.E : g.W - g.E - 16 * c - Math.max(td[2].w, ghostW);
  let top2 = 18 * c;
  // The read band: the largest of 44, 30, 26, 22 that fits a third of the sheet.
  let readOut: ReadBand | null = null;
  if (input.read) {
    const goW = measure(COOK_COPY.goToStep, 22 * c, 600) + 40 * c;
    const btnRowW = goW + 12 * c + ghostW;
    const pad = 14 * c;
    const textW = g.portrait ? g.W - 2 * g.E : g.W - 2 * g.E - btnRowW - 24 * c;
    const third = sheetH2 / 3;
    const heightFor = (lines: number, px: number) =>
      g.portrait ? pad + lines * px * 1.2 + 12 * c + BTN_H + pad : pad + Math.max(lines * px * 1.2, BTN_H) + pad;
    // `readRung` steps the band down when the outline under it would not fit:
    // first the larger sizes go, then lines at 22.
    let pick: { px: number; lines: string[] } | null = null;
    for (const fs of READ_SIZES.slice(Math.min(readRung, READ_SIZES.length - 1))) {
      const px = fs * c;
      const lines = wrapLines(input.read.text, px, 500, textW, measure);
      if (heightFor(lines.length, px) <= third && readRung < READ_SIZES.length) {
        pick = { px, lines };
        break;
      }
    }
    if (!pick) {
      // At 22 the words are cut at a word on the last line that fits.
      const px = 22 * c;
      const all = wrapLines(input.read.text, px, 500, textW, measure);
      let k = all.length;
      while (k > 1 && heightFor(k, px) > third) k--;
      k = Math.max(1, k - Math.max(0, readRung - (READ_SIZES.length - 1)));
      const lines = all.slice(0, k);
      if (k < all.length) lines[k - 1] = cutToWidth(`${all[k - 1]} ${all.slice(k).join(" ")}`, px, 500, textW, measure);
      pick = { px, lines };
    }
    const height = heightFor(pick.lines.length, pick.px);
    readOut = {
      key: input.read.key,
      lines: pick.lines,
      px: pick.px,
      top: 0,
      height,
      textX: g.E,
      textTop: pad,
      textW,
      btnX: g.portrait ? g.E : g.W - g.E - btnRowW,
      btnY: g.portrait ? pad + pick.lines.length * pick.px * 1.2 + 12 * c : pad,
    };
    top2 = height + 18 * c;
  }
  // Time to the table stands right of the outline (landscape) or over it (portrait).
  const tt2 = { x: g.portrait ? g.W - g.E - td[2].w : x1C + 16 * c, top: top2 };
  if (g.portrait) top2 = tt2.top + td[2].h + 18 * c;
  const axC: Axis = { t0: 0, T, x0: x0C, x1: x1C };
  const rowsTop2 = top2;
  const avail2 = sheetH2 - 60 * c;

  // The outline's names: one a row, a full tap band tall; they give way from the end.
  const room2 = x1C - g.E;
  let labs2: (Label | null)[] = marks.map(() => null);
  let px2 = 26 * c;
  const lifted2 = all.filter((j) => marks[j].state !== "done");
  const setLabs2 = (fs: number, named: Set<number> | null) => {
    px2 = fs * c;
    labs2 = marks.map((_, j) => (lifted2.includes(j) && (!named || named.has(j)) ? chooseLab(j, px2, room2) : null));
  };
  const labX2 = (bx: number, w: number) => Math.max(Math.min(Math.max(bx, x0C), x1C - 4 * c - w), x0C);
  const pack2 = (rg: number): Pack2 => {
    const lh = px2 * LH;
    const cy = new Map<number, number>();
    const rows: ChartRow[] = [];
    let y = rowsTop2;
    lifted2
      .filter((j) => labs2[j])
      .forEach((j) => {
        const L = labs2[j]!.lines.length;
        const ch = L * lh + LG * c + BAR * c;
        const hR = Math.max(ROW_BAND, ch + rg);
        const top = y;
        const mid = y + (hR - ch) / 2 + ch - (BAR * c) / 2;
        cy.set(j, mid);
        y = top + hR;
        rows.push({ top, bottom: y, js: [j] });
      });
    return { cy, rows, bottom: y };
  };
  let P2: Pack2 | null = null;
  let named2: Set<number> | null = null;
  for (const [fs, rg] of sizes) {
    setLabs2(fs, null);
    const p = pack2(rg * c);
    if (p.bottom <= avail2) {
      P2 = p;
      break;
    }
  }
  if (!P2) {
    setLabs2(22, null);
    const p = pack2(4 * c);
    if (p.bottom <= avail2) P2 = p;
  }
  if (!P2) {
    // Names give way from the end; the step in hand keeps its own. The row
    // gap closes before the last names go; the most names kept wins, a tie
    // the wider gap.
    const order = [...lifted2].filter((j) => j !== inHand).reverse();
    const room = avail2 - 22 * c * 1.4;
    const tryShed = (rg: number) => {
      const named = new Set(lifted2);
      setLabs2(22, named);
      let p = pack2(rg);
      for (const j of order) {
        if (p.bottom <= room) break;
        named.delete(j);
        setLabs2(22, named);
        p = pack2(rg);
      }
      return { named, p, fits: p.bottom <= room };
    };
    const tries = [4 * c, 2 * c].map(tryShed);
    const fit = tries.filter((t) => t.fits);
    const best = fit.length ? fit.reduce((x, y) => (y.named.size > x.named.size ? y : x)) : tries[tries.length - 1];
    named2 = best.named;
    setLabs2(22, named2);
    P2 = best.p;
  }
  const rowsBottom2 = P2.bottom;
  let outlineMore: SheetLayout["outlineMore"] = null;
  if (named2) {
    const left = lifted2.filter((j) => !named2!.has(j)).length;
    if (left > 0) {
      const text = COOK_COPY.andMoreSteps(left);
      outlineMore = { text, y: rowsBottom2 + 10 * c, w: measure(text, 22 * c, 500) };
    }
  }

  // ---- each mark's look (the same at every level) ----
  const order = all
    .slice()
    .sort(
      (a, b) =>
        Number(marks[a].state === "in-hand") - Number(marks[b].state === "in-hand") ||
        Number(marks[b].pot) - Number(marks[a].pot) ||
        span(b)[1] - span(b)[0] - (span(a)[1] - span(a)[0]) ||
        a - b,
    );
  const looks = marks.map((m) => {
    const col = markColors(m, true);
    return { base: col.base, ring: col.ring ?? "" };
  });
  const spent = (j: number, w: number) => (marks[j].state === "done" ? w : 0);

  // ---- places ----
  const hidden: RidePlace = { dx: 0, dy: 0, op: 0 };
  const P: LevelPlace[] = [0, 1, 2].map(() => ({
    bars: [] as BarPlace[],
    labs: [] as RidePlace[],
    now: { x: 0, y0: 0, y1: 0, op: 0 },
    endr: { x: 0, y0: 0, y1: 0, op: 0 },
    tt: { x: 0, top: 0, z: 0, col: 0, op: 1, wx: 0, wy: 0 },
  }));
  const lh1 = px1 * LH;
  const lh2 = px2 * LH;
  for (let j = 0; j < n; j++) {
    const sb = stripBar(j);
    P[0].bars[j] = { x: sb.x, w: sb.w, cy: restMid, h: BAR * c, op: 1, fill: spent(j, sb.w) };
    P[0].labs[j] = hidden;

    // Level 1: a row per step; the rest wait above (done) or below (to come).
    if (in1.has(j)) {
      const lab = labs1[j]!;
      P[1].bars[j] = { x: g.E, w: sb.w, cy: R1.cy.get(j)!, h: BAR * c, op: 0, fill: 0 };
      P[1].labs[j] = { dx: 0, dy: -(LG * c + lab.lines.length * lh1), op: 1 };
    } else {
      const before = inHand < 0 || marks[j].screen < marks[inHand].screen || marks[j].state === "done";
      P[1].bars[j] = { x: g.E, w: sb.w, cy: before ? R1.top - R1.pitch : R1.bottom + R1.pitch, h: BAR * c, op: 0, fill: 0 };
      P[1].labs[j] = hidden;
    }

    // Level 2: the outline's names at their rows.
    P[2].bars[j] = { x: g.E, w: sb.w, cy: P2.cy.get(j) ?? rowsBottom2 + 20 * c, h: BAR * c, op: 0, fill: 0 };
    const lab = labs2[j];
    P[2].labs[j] = lab ? { dx: labX2(g.E, lab.w) - g.E, dy: -(LG * c + lab.lines.length * lh2), op: 1 } : hidden;
  }

  // As written there is no now line and no table's wall at any depth.
  P[0].now = { x: axX(axA, now), y0: restMid - 11 * c, y1: restMid + 11 * c, op: 0 };
  P[1].now = { x: g.E, y0: R1.top - 6 * c, y1: R1.bottom + Math.min(8 * c, R1.bottomPad), op: 0 };
  P[2].now = { x: g.E, y0: rowsTop2, y1: rowsTop2, op: 0 };
  P[0].endr = { x: axA.x1, y0: P[0].now.y0, y1: P[0].now.y1, op: 0 };
  P[1].endr = { x: x1S, y0: R1.top - 6 * c, y1: R1.bottom, op: 0 };
  P[2].endr = { x: g.E, y0: rowsTop2, y1: rowsTop2, op: 0 };
  const ttL = x1A + 16 * c;
  P[0].tt = { x: ttL, top: restMid - td[0].h / 2 - 1 * c, z: 0, col: 0, op: 1, wx: 0, wy: 0 };
  P[1].tt = { x: g.W - g.E - td[1].w, top: tt1Top, z: 1, col: 1, op: 1, wx: 0, wy: 0 };
  P[2].tt = { x: tt2.x, top: tt2.top, z: 2, col: 1, op: 1, wx: 0, wy: 0 };

  return {
    geo: g,
    asWritten: true,
    detents: [Y0, Y1, Y2],
    band,
    axA,
    axC,
    marks,
    inHand,
    labs1,
    labs2,
    px1,
    px2,
    lh1,
    lh2,
    looks,
    order,
    P: P as SheetLayout["P"],
    // As written there is no nudge (`restNudge`).
    nudge: null,
    step: step ? { sc1, fit1, pages1, keepH: step.keepH, fullH: step.fullH, inkW: step.inkW } : null,
    now,
    tt: { num: tw.num, words: tw.words, sub, sizes: TZ, dims: td, numEm, widest },
    chart: { x0: x0C, x1: x1C, rowsTop: rowsTop2, rowsBottom: rowsBottom2, rows: P2.rows },
    ghost: null,
    read: readOut,
    overview: null,
    opening: false,
    topLine: input.topLine === true,
    outlineMore,
    hint: { x: ttL, y: 0 },
    derived: null,
    summary: {
      rows1: rows1All.filter((j) => in1.has(j)).map((j) => marks[j].key),
      folded1: [],
      gaveWay1: rows1All.filter((j) => !in1.has(j)).map((j) => marks[j].key),
      fit1,
      pages1,
      px1: +(px1 / c).toFixed(1),
      rows2: P2.rows.length,
      px2: +(px2 / c).toFixed(1),
      minutes2: false,
      named2: lifted2.filter((j) => labs2[j]).map((j) => marks[j].key),
      shed2: lifted2.filter((j) => !labs2[j]).map((j) => marks[j].key),
      fits2: rowsBottom2 + (outlineMore ? 22 * c * 1.4 : 0) <= avail2 + 0.5,
    },
  };
}


// ---------------------------------------------------------------------------
// A frame: every element's place at depth d
// ---------------------------------------------------------------------------

export interface FrameState {
  /** The sheet's edge, px. */
  Y: number;
  /** The cook's minute by the clock: the line's fill is said from it, nothing laid out (T3). Default: as laid. */
  now?: number;
  /** How far this is a glide straight between level 0 and 2 (1: no level-1 parts on the way; 0: the levels' own frames; between: a pass cut short, mixed by it). Default 0 (T3). */
  pass?: number;
}

export interface BarFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  op: number;
  /** px of spent ink from the left. */
  fill: number;
}
export interface TextFrame {
  x: number;
  y: number;
  op: number;
}
export interface Frame {
  d: number;
  /** The sheet's clip: its top and bottom on screen. */
  sheetTop: number;
  sheetBottom: number;
  step: { scale: number; op: number; ember: number; meta: number } | null;
  nudge: { op: number; dy: number };
  bars: BarFrame[];
  /** As written: the next steps' names and the outline's (y from the sheet's edge). */
  labs1: TextFrame[];
  labs2: TextFrame[];
  now: { x: number; y0: number; h: number; op: number };
  endr: { x: number; y0: number; h: number; op: number };
  tt: { x: number; y: number; n: number; w: number; col: number; sub: number; dw: number; dh: number; op: number; wx: number; wy: number };
  hair: number;
  /** As written: the outline's own parts. */
  chart: number;
  /** A derived plan's timetable chrome (More, the ghost, the opening's controls), with its words. */
  lanes: number;
  /** The top line (the header): it gives way to the timetable's words, and is gone on the opening. */
  header: number;
  hint: number;
  /** A derived plan's line, strip map, Paper and timetable growth (T3); null as written. */
  derived: DerivedFrame | null;
}

export function depthOf(L: SheetLayout, Y: number): number {
  const D = L.detents;
  if (Y >= D[0]) return 0;
  for (let k = 0; k < 2; k++) {
    if (Y >= D[k + 1]) return k + (D[k] - Y) / Math.max(1e-6, D[k] - D[k + 1]);
  }
  return 2;
}

/**
 * Every element's place at the sheet edge `s.Y`. A derived plan's is
 * `derivedFrame`'s. As written, the two levels around the depth,
 * interpolated: marks travel between their places across all three levels;
 * each level's names ride their marks and fade (the next steps' in over the
 * last 30% of 0→1 and out over the first 30% of 1→2; the outline's in over
 * the last 30% of 1→2). The layout keeps names clear of each other at each
 * level, so nothing between levels needs to judge collisions.
 */
export function frameAt(L: SheetLayout, s: FrameState): Frame {
  if (!L.asWritten) return derivedFrame(L, s);
  const g = L.geo;
  const c = g.c;
  const Y = s.Y;
  const d = depthOf(L, Y);
  const k = Math.min(1, Math.floor(d));
  const t = d - k;
  const A = L.P[k];
  const B = L.P[k + 1];
  const n = L.marks.length;
  const te = easeIO(t);
  const tq = k === 1 ? t : te;

  const ndOp = L.nudge ? 1 - sstep(0, 0.3, d) : 0;
  const ndDy = Math.max(0, Y - L.detents[0]);

  // The step shrinks to stay above the rising sheet (never under the
  // stretch's scale), its meta gone within the first 40 px of a pull; past the
  // stretch it turns ink-soft and fades.
  let stepF: Frame["step"] = null;
  if (L.step) {
    const st = L.step;
    const m = sstep(0, 40, L.detents[0] - Y);
    const avail = Math.min(Y, L.detents[0]) - g.stepTop - 22 * c;
    const need = st.keepH + (st.fullH - st.keepH) * (1 - m);
    const sc = d > 1 ? st.sc1 : clamp(avail / Math.max(1, need), st.sc1, 1);
    stepF = { scale: sc, op: 1 - sstep(1.0, 1.35, d), ember: 1 - sstep(1.0, 1.2, d), meta: 1 - m };
  }

  const bars: BarFrame[] = [];
  const labs1: TextFrame[] = [];
  const labs2: TextFrame[] = [];
  const in1 = k === 0 ? sstep(0.7, 1, t) : 1 - sstep(0, 0.3, t);
  const in2 = k === 1 ? sstep(0.7, 1, t) : 0;
  for (let j = 0; j < n; j++) {
    const a = A.bars[j];
    const b = B.bars[j];
    const tj = k === 1 ? easeIO(clamp((t - 0.1) / 0.75, 0, 1)) : easeIO(clamp(t / 0.75, 0, 1));
    const x = lerp(a.x, b.x, tj);
    const w = lerp(a.w, b.w, tj);
    const cy = lerp(a.cy, b.cy, tj);
    const h = lerp(a.h, b.h, tj);
    const op = a.op === b.op ? a.op : a.op > b.op ? 1 - sstep(0, 0.35, t) : k === 1 ? sstep(0.4, 0.9, t) : sstep(0.05, 0.45, tj);
    const fill = clamp(lerp(a.fill, b.fill, tj), 0, w);
    const top = cy - h / 2;
    bars[j] = { x, y: top, w, h, op, fill };
    const r1 = L.P[1].labs[j];
    labs1[j] = { x: x + r1.dx, y: top + r1.dy, op: L.labs1[j] ? r1.op * in1 : 0 };
    const r2 = L.P[2].labs[j];
    labs2[j] = { x: x + r2.dx, y: top + r2.dy, op: L.labs2[j] ? r2.op * in2 : 0 };
  }

  const ta = A.tt;
  const tb = B.tt;
  const za = L.tt.sizes[ta.z];
  const zb = L.tt.sizes[tb.z];
  const da = L.tt.dims[ta.z];
  const db = L.tt.dims[tb.z];
  const na = A.now;
  const nb = B.now;
  const ea = A.endr;
  const eb = B.endr;
  return {
    d,
    sheetTop: Y,
    sheetBottom: g.footTop,
    step: stepF,
    nudge: { op: ndOp, dy: ndDy },
    bars,
    labs1,
    labs2,
    now: { x: lerp(na.x, nb.x, tq), y0: lerp(na.y0, nb.y0, tq), h: Math.max(0, lerp(na.y1 - na.y0, nb.y1 - nb.y0, tq)), op: lerp(na.op, nb.op, tq) },
    endr: { x: lerp(ea.x, eb.x, tq), y0: lerp(ea.y0, eb.y0, tq), h: Math.max(0, lerp(ea.y1 - ea.y0, eb.y1 - eb.y0, tq)), op: lerp(ea.op, eb.op, tq) },
    tt: {
      x: lerp(ta.x, tb.x, tq),
      y: lerp(ta.top, tb.top, tq),
      n: lerp(za.n, zb.n, tq),
      w: lerp(za.w, zb.w, tq),
      col: lerp(ta.col, tb.col, tq),
      sub: lerp(za.sub, zb.sub, sstep(0.5, 1, t)),
      dw: lerp(da.w, db.w, tq),
      dh: lerp(da.h, db.h, tq),
      op: lerp(ta.op, tb.op, k === 1 ? sstep(0, 0.4, t) : tq),
      wx: lerp(ta.wx, tb.wx, tq),
      wy: lerp(ta.wy, tb.wy, tq),
    },
    hair: sstep(0.02, 0.35, d),
    chart: in2,
    lanes: 0,
    header: 1,
    hint: sstep(0.6, 1, d),
    derived: null,
  };
}

/**
 * Next while the stretch is pinned (N2-3): the frame between the old layout
 * and the new one, both at the stretch, matched by mark key. A finished row
 * moves up a row and fades out at the top; rows to come move up and left
 * along time; a row joining fades in. `t` is the eased progress, 0 → 1.
 */
export function advanceFrame(prev: SheetLayout, next: SheetLayout, t: number): Frame {
  const A = frameAt(prev, { Y: prev.detents[1] });
  const B = frameAt(next, { Y: next.detents[1] });
  const at = new Map(prev.marks.map((m, j) => [m.key, j]));
  const mix = (p: TextFrame | undefined, q: TextFrame): TextFrame =>
    p ? { x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t), op: lerp(p.op, q.op, t) } : { ...q, op: q.op * t };
  const bars = B.bars.map((q, j) => {
    const i = at.get(next.marks[j].key);
    const p = i === undefined ? undefined : A.bars[i];
    if (!p) return { ...q, op: q.op * t };
    return {
      x: lerp(p.x, q.x, t),
      y: lerp(p.y, q.y, t),
      w: lerp(p.w, q.w, t),
      h: lerp(p.h, q.h, t),
      op: lerp(p.op, q.op, t),
      fill: lerp(p.fill, q.fill, t),
    };
  });
  const pick = (arrA: TextFrame[], arrB: TextFrame[]) =>
    arrB.map((q, j) => {
      const i = at.get(next.marks[j].key);
      return mix(i === undefined ? undefined : arrA[i], q);
    });
  const lin = <O extends Record<string, number>>(p: O, q: O): O => {
    const o = { ...q };
    for (const key of Object.keys(q) as (keyof O)[]) o[key] = lerp(p[key] as number, q[key] as number, t) as O[keyof O];
    return o;
  };
  return {
    ...B,
    sheetTop: lerp(A.sheetTop, B.sheetTop, t),
    bars,
    labs1: pick(A.labs1, B.labs1),
    labs2: pick(A.labs2, B.labs2),
    now: lin(A.now, B.now),
    endr: lin(A.endr, B.endr),
    tt: lin(A.tt, B.tt),
  };
}

/** Every level's own box on screen (px): where the sheet stands at rest on that level. */
export function levelBoxes(L: SheetLayout): { level: number; top: number; bottom: number }[] {
  return L.detents.map((Y, level) => ({ level, top: Y, bottom: level === 2 && L.overview ? L.overview.sheetBottom : L.geo.footTop }));
}
