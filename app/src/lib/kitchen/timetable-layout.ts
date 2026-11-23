/**
 * The timetable's layout: where every mark and word of the whole cook stands
 * on the opening and at the cook sheet's level 2 (DECISIONS 2026-10-20,
 * "Whole-cook overview: the timetable"). The build contract is the repo's
 * `design/overview-arc/r3/SPEC.md`: this module is its §6 (layout, portrait
 * rows), §7 (the label rule), §8 (the chapter-head rule) and the drawing of
 * §9 (done and now). It reads only the model (`timetable-model.ts`).
 *
 * A port of the round-3 mock's `drawTimetable`, `drawOpening` and the level-2
 * header (`design/overview-arc/r3/index.html`), which proved these rules on
 * real plans. Everything here is in counter px (cpx: 1 cpx is about 1.333 CSS
 * px on the Pixel Tablet); the caller scales by its `c`. Pure: text is
 * measured through an injected `Measure` in cpx (canvas in the browser, the
 * fonts' advance widths in the tests).
 *
 * Each drawn part carries a stable key (block key, pot key, chapter number,
 * lane), so a part that exists in two layouts moves between them (SPEC §11).
 */

import { COOK_COPY } from "./cook-view";
import { roundUpToFive } from "./recipe-times";
import { drawnMinutes, type Timetable, type TimetableBlock, type TimetableBreak, type TimetableChapter, type TimetablePot } from "./timetable-model";

/** A text's width in cpx at `size` cpx: `family` "text" is Figtree, "display" Caprasimo. */
export type Measure = (text: string, size: number, weight: number, family?: "text" | "display") => number;

/** A colour from the design system's tokens (no new ones). */
export type Tone = "ink" | "soft" | "paper" | "sand" | "track" | "ember" | "ember7" | "ground";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type MarkRole =
  | "band"
  | "prep"
  | "block"
  | "pot-line"
  | "break"
  | "break-track"
  | "track-gap"
  | "track"
  | "track-fill"
  | "serve"
  | "now";

export type WordRole =
  | "chapter-num"
  | "chapter-name"
  | "chapter-min"
  | "lane"
  | "prep-label"
  | "prep-min"
  | "block-label"
  | "pot-caption"
  | "break-minutes"
  | "break-free"
  | "tick"
  | "total"
  | "now-word"
  | "now-left"
  | "now-free";

/** A drawn mark: a box in a token colour. */
export interface TMark extends Rect {
  k: string;
  role: MarkRole;
  tone: Tone;
  r: number;
  op: number;
  z: number;
  /** A block's key (blocks only). */
  block?: string;
  /** Drawn low: a touch, or a block with nowhere to put its name (SPEC §7.6). */
  low?: boolean;
  /** A chapter band's chapter number. */
  chapter?: number;
  /** A pot line's pot key. */
  pot?: string;
}

/** A drawn word or words: lines at one size, from its top-left (or turned upright about its centre). */
export interface TWord extends Rect {
  k: string;
  role: WordRole;
  lines: string[];
  size: number;
  weight: number;
  family: "text" | "display";
  tone: Tone;
  /** Line height in cpx. */
  lh: number;
  op: number;
  z: number;
  /** -90: set upright, turned about the box's centre. */
  rot?: -90;
  /** A block label's block key. */
  block?: string;
  /** How a block label is placed (SPEC §7). */
  how?: "in" | "in2" | "after" | "up";
  /** A pot caption's pot key. */
  pot?: string;
}

/** A row of a lane in one row of time, for the read's hit test: what lies under a finger. */
export interface HitRow {
  lane: string;
  /** The lane's band, the full row pitch. */
  top: number;
  h: number;
  /**
   * The plan's steps on this lane in this row, by their strip key, left to right: their minutes'
   * span (`x0`–`x1`), and `boxes`, what of them is drawn, where a finger finds them: a step's share
   * of its block, the label drawn after the block, its stretch of pot line, the pot's caption.
   * Empty for a step with nothing of its own drawn (a wait wholly under the work on its line).
   */
  segs: { key: string; x0: number; x1: number; block: string | null; pot: boolean; done: boolean; boxes: [number, number][] }[];
}

export interface TimetableDrawing {
  marks: TMark[];
  words: TWord[];
  hits: HitRow[];
  prepRect: Rect | null;
  /** Where time starts (the margin's end). */
  x0: number;
  /** The last row's time track. */
  trackY: number;
  /** The row pitch and block height (SPEC §6). */
  R: number;
  blockH: number;
  /** The lanes stand clear of each other: the row pitch holds a block and a lane name. */
  fits: boolean;
  /** Blocks with nowhere to put their name, drawn low (SPEC §7.6), as "lane: name". */
  demoted: string[];
  /** The serve-end gutter reserved, cpx (SPEC §7.5). */
  gutter: number;
  /** The chart's drawn extent. */
  top: number;
  bottom: number;
  /**
   * Level 2's clock (null on the opening): the axis as laid, so the now line, the track's fill and
   * the now words stand where the clock says at any minute, the drawing held (`nowOn`; T3 follow-up).
   */
  clock: TimetableClock | null;
  /** Ticks and a break's minutes that give way to now's words at the drawing's minute (`givesWay`). */
  gaveWay: TWord[];
}

/** A row of time's axis as laid: its minutes, where it starts, its scale, its lanes' top and its track. */
export interface ClockRow {
  t0: number;
  t1: number;
  x0: number;
  /** Cpx a drawn minute. */
  k: number;
  laneTop: number;
  trackY: number;
  last: boolean;
  /** Its track fill's mark key. */
  fill: string;
}

/** What the timetable needs to place now at any minute on its held axis (cpx). */
export interface TimetableClock {
  rows: ClockRow[];
  /**
   * The breaks: where each is drawn (its row and its middle; none for one cut by a row's end), and
   * the width of its minutes left as said ("12 min"), by the minutes rounded.
   */
  breaks: (TimetableBreak & { at: { row: number; xm: number } | null; leftW: number[] })[];
  total: number;
  /** The chart's right edge: the now words keep inside it. */
  xR: number;
  /** "now" and "free" as laid. */
  wNow: number;
  wFree: number;
}

/** Now on the held axis: its line, the rows' fills, its words and the room they take. */
export interface NowOn {
  /** The minute, held inside the cook. */
  minute: number;
  row: number;
  /** The line's centre. */
  x: number;
  /** Each row's track fill, by its mark key. */
  fills: Map<string, number>;
  mark: { x: number; y: number; h: number };
  word: { x: number; y: number };
  /** Inside a break: its minutes left and "free" after "now". */
  left: { text: string; x: number; y: number; w: number; freeX: number; freeY: number } | null;
  /** The words' span on the row: ticks and a break's minutes keep off it. */
  span: [number, number];
}

/**
 * Now's words at a minute: "now" beside the line, and inside a break its minutes left and "free"
 * (SPEC §9). The layout draws them with these; the page draws them again as the clock moves.
 */
export function nowWords(c: TimetableClock, at: NowOn): TWord[] {
  const base = { op: 1, z: 5 };
  const out: TWord[] = [
    { ...base, k: "nowt", role: "now-word", x: at.word.x, y: at.word.y, w: c.wNow, h: 22 * 1.15, lines: ["now"], size: 22, weight: 600, family: "text", tone: "ember7", lh: 22 * 1.15 },
  ];
  if (at.left) {
    const l = at.left;
    out.push(
      { ...base, k: "nowl", role: "now-left", x: l.x, y: l.y, w: l.w, h: 28 * 1.15, lines: [l.text], size: 28, weight: 400, family: "display", tone: "ink", lh: 28 * 1.15 },
      { ...base, k: "nowf", role: "now-free", x: l.freeX, y: l.freeY, w: c.wFree, h: 22 * 1.15, lines: ["free"], size: 22, weight: 500, family: "text", tone: "soft", lh: 22 * 1.15 },
    );
  }
  return out;
}

/** A tick under now's words, or a break's minutes within 150 cpx of now on its row: it gives way (SPEC §9). */
export function givesWay(c: TimetableClock, at: NowOn, w: TWord): boolean {
  if (w.role === "tick") {
    return w.y === c.rows[at.row].trackY + 14 && w.x + w.w > at.span[0] - 20 && w.x < at.span[1] + 20;
  }
  if (w.role === "break-minutes" || w.role === "break-free") {
    const b = c.breaks[Number(/^brk:(\d+)/.exec(w.k)![1])];
    if (!b.at) throw new Error(`break ${w.k} has minutes but no place`);
    // Only on now's own row: a break on another row stands clear of its words, however near the
    // row's end now stands (Codex, T3 follow-up). Within 150 of the line, or wherever its words
    // would cross now's (with a tick's 20 of air): inside a break, "35 min free" runs past 150,
    // and the next break's minutes sat on its "free" (Fannie's Parker House rolls, re-derived for
    // the cook-fidelity plan's prompt).
    return (
      b.at.row === at.row &&
      (Math.abs(at.x - b.at.xm) < 150 || (w.x + w.w > at.span[0] - 20 && w.x < at.span[1] + 20))
    );
  }
  return false;
}

/**
 * Where now stands at minute `at` on a drawing's held axis (SPEC §9: one Ember line up from the end
 * of the filled track): the layout's own rule, so a drawing laid at another minute and this agree
 * exactly with a drawing laid at `at` (timetable-layout.test.ts).
 */
export function nowOn(c: TimetableClock, at: number): NowOn {
  const now = clamp(at, 0, c.total);
  const X = (r: ClockRow, m: number) => r.x0 + (drawnMinutes(c, clamp(m, r.t0, r.t1)) - drawnMinutes(c, r.t0)) * r.k;
  const fills = new Map(c.rows.map((r) => [r.fill, now > r.t0 ? X(r, now) - r.x0 : 0]));
  let row = c.rows.findIndex((r) => now >= r.t0 - 1e-6 && (now < r.t1 || r.last));
  if (row < 0) row = c.rows.length - 1;
  const r = c.rows[row];
  const x = X(r, now);
  const b = c.breaks.find((br) => now >= br.start && now < br.end) ?? null;
  const lw = b ? b.leftW[Math.round(b.end - now)] : 0;
  const wL = b ? 14 + lw + 8 + c.wFree : 0;
  const wordX = x + 10 + c.wNow + wL <= c.xR ? x + 10 : x - 10 - c.wNow - wL;
  const x2 = wordX + c.wNow + 14;
  return {
    minute: now,
    row,
    x,
    fills,
    mark: { x: x - 1.5, y: r.laneTop - 10, h: r.trackY - (r.laneTop - 10) },
    word: { x: wordX, y: r.trackY + 14 },
    left: b ? { text: fmtMinutes(b.end - now), x: x2, y: r.trackY + 8, w: lw, freeX: x2 + lw + 8, freeY: r.trackY + 14 } : null,
    span: [wordX, wordX + c.wNow + wL],
  };
}

export interface TimetableOptions {
  portrait: boolean;
  measure: Measure;
  /** Draw now and done (level 2); the opening draws neither. */
  now: boolean;
  /** The opening centres the chart in its room; the cook screen pins it to the bottom. */
  anchor: "center" | "bottom";
  /** The colour behind the chart: a break's gap in the track is cut in it. */
  ground: Tone;
}

/** "N min", or "1 h 05" from an hour. */
export function fmtMinutes(m: number): string {
  const r = Math.round(m);
  if (r < 60) return `${r} min`;
  const h = Math.floor(r / 60);
  const rest = r % 60;
  return rest ? `${h} h ${String(rest).padStart(2, "0")}` : `${h} h`;
}

/**
 * A meal's total as every surface says it: rounded up to 5 minutes, the time
 * line's rule (DS §5), so the opening's "2 h 15" is the kitchen row's. The axis
 * and a chapter's minutes stay exact.
 */
export function fmtTotal(m: number): string {
  return fmtMinutes(roundUpToFive(m));
}

/** How much sooner a switch makes the cook, from the two totals as said (0: the same said total). */
export function soonerMinutes(from: number, to: number): number {
  return Math.max(0, roundUpToFive(from) - roundUpToFive(to));
}

/**
 * Where "N min sooner" starts after a switch to a shorter cook (SPEC §11), cpx: centred between
 * the old serve line (`oldX`) and the new (`newX`) when it fits there 12 clear of both, else just
 * past the old line when that stays inside the chart (`right`), else ending 12 before the new
 * line. Never on the new serve line.
 */
export function soonerLabelX(oldX: number, newX: number, w: number, right: number): number {
  const gap = 12;
  const mid = (oldX + newX) / 2 - w / 2;
  if (mid >= newX + gap && mid + w <= oldX - gap) return mid;
  if (oldX + gap + w <= right) return oldX + gap;
  return newX - gap - w;
}

/** Words wrapped at spaces to `maxW` (a word wider than it stands alone on its line). */
export function wrapWords(s: string, size: number, weight: number, maxW: number, measure: Measure, family: "text" | "display" = "text"): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of s.split(" ").filter(Boolean)) {
    const t = cur ? `${cur} ${w}` : w;
    if (!cur || measure(t, size, weight, family) <= maxW) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

type Interval = [number, number];
function unionOf(iv: Interval[]): Interval[] {
  const s = iv.map(([a, b]): Interval => [a, b]).sort((p, q) => p[0] - q[0]);
  const out: Interval[] = [];
  for (const [a, b] of s) {
    const l = out[out.length - 1];
    if (l && a <= l[1]) l[1] = Math.max(l[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** A done pot steps back (SPEC §9): its line, and its caption. */
export const POT_DONE = { line: 0.35, caption: 0.45 } as const;

/** The time track, ticks and total under a row (SPEC §6). */
export const AXIS_H = 62;
const HEAD_H = 50;
const ROW_GAP = 18;

/** One row of time: landscape draws one, portrait two (SPEC §6, "systems"). */
interface System {
  t0: number;
  t1: number;
}

/**
 * Portrait wraps time onto two rows, cut at the chapter start that makes the
 * longer row's drawn span shortest; landscape draws one (SPEC §6).
 */
export function rowsOfTime(t: Pick<Timetable, "chapters" | "breaks" | "total">, portrait: boolean): System[] {
  const g = (m: number) => drawnMinutes(t, m);
  const G = g(t.total);
  if (!portrait || t.chapters.length < 2) return [{ t0: 0, t1: t.total }];
  let best: { at: number; span: number } | null = null;
  for (const c of t.chapters.slice(1)) {
    const span = Math.max(g(c.start), G - g(c.start));
    if (!best || span < best.span - 1e-6) best = { at: c.start, span };
  }
  return [
    { t0: 0, t1: best!.at },
    { t0: best!.at, t1: t.total },
  ];
}

const spanOf = (t: Pick<Timetable, "breaks">, s: System) => drawnMinutes(t, s.t1) - drawnMinutes(t, s.t0);

/** A lane's name in the margin: its short form when too wide at 23/600 (SPEC §2). */
function laneLabel(lane: { name: string; short: string }, measure: Measure): string {
  return measure(lane.name, 23, 600) > 124 && lane.name.includes(" ") ? lane.short : lane.name;
}

/**
 * The widest a lane's word may make the margin: half again its wrap width (186 cpx landscape, 156
 * portrait). A word wider than its wrap width widens the margin to hold it whole up to this (the
 * kitchen's widest, "Garbanzos", is 107 at portrait's 22); past it the word is cut to fit, on one
 * line, so time keeps its room (DECISIONS 2026-10-21 "Slice T3", call 14).
 */
const MARGIN_CAP = 1.5;

/** A word too wide for `room`, cut at a letter with "…" after it (`room` holds the cut). */
function cutWord(s: string, size: number, room: number, measure: Measure): string {
  if (measure(s, size, 600) <= room + 1e-6) return s;
  let k = s.length - 1;
  while (k > 1 && measure(`${s.slice(0, k)}…`, size, 600) > room + 1e-6) k--;
  return `${s.slice(0, k)}…`;
}

/** The margin: the lanes' names wrapped, and its width (SPEC §6), never wider than its cap. */
export function laneMargin(t: Pick<Timetable, "lanes">, portrait: boolean, measure: Measure): { size: number; lines: Map<string, string[]>; w: number } {
  const size = portrait ? 22 : 23;
  const maxW = portrait ? 104 : 124;
  const cap = maxW * MARGIN_CAP;
  const lines = new Map(
    t.lanes.map((l) => [l.name, wrapWords(laneLabel(l, measure), size, 600, maxW, measure).map((s) => cutWord(s, size, cap, measure))]),
  );
  const widest = Math.max(0, ...[...lines.values()].flat().map((s) => measure(s, size, 600)));
  return { size, lines, w: widest + (portrait ? 16 : 22) };
}

/**
 * The least chart height at which the timetable keeps its floor: every lane at least a block tall
 * (36 landscape, 34 portrait) and its name's lines inside its row. The opening's portrait frame
 * gives Get out's rows up until the chart has it.
 */
export function timetableFloorHeight(t: Timetable, portrait: boolean, measure: Measure): number {
  const systems = rowsOfTime(t, portrait);
  const has = (lane: string, s: System) =>
    t.blocks.some((b) => b.lane === lane && b.start < s.t1 && b.end > s.t0) || t.pots.some((p) => p.lane === lane && p.start < s.t1 && p.end > s.t0);
  const nRows = systems.reduce((n, s) => n + Math.max(1, portrait ? t.lanes.filter((l) => has(l.name, s)).length : t.lanes.length), 0);
  const margin = laneMargin(t, portrait, measure);
  const nameH = Math.max(1, ...[...margin.lines.values()].map((ls) => ls.length)) * 25;
  const floorR = Math.max(portrait ? 34 : 36, nameH - 2);
  return systems.length * (HEAD_H + AXIS_H) + (systems.length - 1) * ROW_GAP + nRows * floorR;
}

interface Row extends System {
  si: number;
  sfx: string;
  last: boolean;
  lanes: string[];
  prepOnly: boolean;
  headY: number;
  laneTop: number;
  laneBot: number;
  trackY: number;
  rowY: (i: number) => number;
}

interface Head {
  c: TimetableChapter;
  x: number;
  numW: number;
  name: string | null;
  mins: string | null;
  full: boolean;
}

interface Label {
  b: TimetableBlock;
  r: Rect;
  how: "in" | "in2" | "after" | "up";
  lines: string[];
  x: number;
  w: number;
}

interface Caption {
  p: TimetablePot;
  xa: number;
  xb: number;
  cap: { s: string; x: number; w: number } | null;
}

interface LanePlace {
  lane: string;
  i: number;
  y: number;
  cy: number;
  rects: Map<TimetableBlock, Rect>;
  labels: Label[];
  caps: Caption[];
  occ: Interval[];
  demoted: TimetableBlock[];
  marks: { b: TimetableBreak; x: number }[];
}

interface RowPlace {
  s: Row;
  X: (t: number) => number;
  /** Cpx a drawn minute. */
  k: number;
  xs: number;
  brks: TimetableBreak[];
  brkX: number[];
  heads: Head[];
  lanes: LanePlace[];
}

/**
 * The timetable in `box` (SPEC §6–9). `other` is the other prep mode's
 * timetable: both share one minute scale, so As I go visibly ends sooner.
 * The serve-end gutter is part of that scale: it is the larger of the two
 * modes' (§7.5, "the gutter shrinks the scale for both modes alike").
 */
export function layoutTimetable(t: Timetable, other: Timetable | null, box: Rect, o: TimetableOptions): TimetableDrawing {
  const floor = other ? drawTimetable(other, t, box, o, null) : 0;
  return drawTimetable(t, other, box, o, floor);
}

/** The gutter `t` needs on its own (`gutterFloor` null), or its drawing with a gutter at least `gutterFloor`. */
function drawTimetable(t: Timetable, other: Timetable | null, box: Rect, o: TimetableOptions, gutterFloor: null): number;
function drawTimetable(t: Timetable, other: Timetable | null, box: Rect, o: TimetableOptions, gutterFloor: number): TimetableDrawing;
function drawTimetable(t: Timetable, other: Timetable | null, box: Rect, o: TimetableOptions, gutterFloor: number | null): TimetableDrawing | number {
  const { portrait, measure } = o;
  const tw = (s: string, size: number, weight = 500, family: "text" | "display" = "text") => measure(s, size, weight, family);
  const now = o.now ? t.now : null;
  // Held at the total (a cook run past the plan), everything is done: a pot a timer carried past it too.
  const done = (m: number) => now !== null && (m <= now + 1e-6 || now >= t.total - 1e-6);
  const INSET = portrait ? 8 : 9;
  const margin = laneMargin(t, portrait, measure);
  const x0 = box.x + margin.w;
  const xR = box.x + box.w - 4;
  const g = (m: number) => drawnMinutes(t, m);
  const systems = rowsOfTime(t, portrait);
  // One scale for both prep modes: landscape the model's shared span; portrait the longest row of either.
  const maxSpan = portrait
    ? Math.max(...systems.map((s) => spanOf(t, s)), ...(other ? rowsOfTime(other, true).map((s) => spanOf(other, s)) : []))
    : t.axis.span;

  const has = (lane: string, s: System) =>
    t.blocks.some((b) => b.lane === lane && b.start < s.t1 && b.end > s.t0) || t.pots.some((p) => p.lane === lane && p.start < s.t1 && p.end > s.t0);
  const laneSets = systems.map((s) => {
    const lanes = portrait ? t.lanes.map((l) => l.name).filter((l) => has(l, s)) : t.lanes.map((l) => l.name);
    return lanes.length ? { lanes, prepOnly: false } : { lanes: [""], prepOnly: true };
  });
  const nRows = laneSets.reduce((n, s) => n + s.lanes.length, 0);
  const fixedH = systems.length * (HEAD_H + AXIS_H) + (systems.length - 1) * ROW_GAP;
  const R = Math.min(portrait ? 92 : 116, (box.h - fixedH) / nRows);
  // Past the block floor (7 or 8 dishes in landscape), the blocks and the pitch thin until the lanes
  // fit: a 3 cpx gap between lanes, labels at 22 cpx, never less (DECISIONS 2026-10-20, T2).
  const floorBh = portrait ? 34 : 36;
  const thin = R < floorBh;
  const Bh = thin ? R - 3 : portrait ? clamp(R - 18, 34, 68) : clamp(R - 18, 36, 82);
  const FS = portrait || thin ? 22 : 24;
  const LH = Math.round(FS * 1.1);
  const twoOK = Bh >= 2 * LH + 10;
  const used = fixedH + R * nRows;
  let y = o.anchor === "bottom" ? box.y + box.h - used : box.y + (box.h - used) / 2;
  const top = y;
  const rows: Row[] = systems.map((s, si) => {
    const laneTop = y + HEAD_H;
    const n = laneSets[si].lanes.length;
    const row: Row = {
      ...s,
      si,
      sfx: si ? `@${si}` : "",
      last: si === systems.length - 1,
      lanes: laneSets[si].lanes,
      prepOnly: laneSets[si].prepOnly,
      headY: y + 2,
      laneTop,
      laneBot: laneTop + R * n,
      trackY: laneTop + R * n + 14,
      rowY: (i: number) => laneTop + i * R + (R - Bh) / 2,
    };
    y = row.laneBot + AXIS_H + ROW_GAP;
    return row;
  });
  // A lane's name, wrapped in the margin; where its lines are taller than the lane's pitch (25 a line,
  // centred 1 low, so a name of n lines needs a pitch of 25n + 1; seven or
  // eight dishes thinned, or a three-line name on a short lane), one line: the whole name when it fits
  // the margin, else the longest run of its last words that does ("Butternut Squash Soup" → "Squash
  // Soup", else "Soup"), the short form's rule carried past two words (DECISIONS 2026-10-20, T2 call 12). The last
  // word always fits: the margin is as wide as the widest wrapped line, which holds it.
  const laneLines = new Map(
    t.lanes.map((l) => {
      const wrapped = margin.lines.get(l.name) ?? [l.name];
      if (wrapped.length * 25 <= R - 1) return [l.name, wrapped];
      const room = margin.w - (portrait ? 16 : 22);
      const words = l.name.split(" ");
      const tails = words.map((_, i) => words.slice(i).join(" "));
      // A last word past the margin's cap was cut to it in the margin's lines: the same cut here.
      return [l.name, [tails.find((s) => tw(s, margin.size, 600) <= room + 1e-6) ?? cutWord(tails.at(-1)!, margin.size, room, measure)]];
    }),
  );
  const nameH = Math.max(1, ...[...laneLines.values()].map((ls) => ls.length)) * 25;
  const fits = R >= Bh && nameH <= R - 1;

  /* ---- placement: where everything goes for a given right gutter ---- */
  function place(gut: number): { res: RowPlace[]; unlabeledAtServe: number[] } {
    const k = (xR - gut - x0) / maxSpan;
    const unlabeledAtServe: number[] = [];
    const labelled = new Set<TimetableBlock>();
    const captioned = new Set<TimetablePot>();
    const res: RowPlace[] = rows.map((s) => {
      const X = (m: number) => x0 + (g(clamp(m, s.t0, s.t1)) - g(s.t0)) * k;
      const xs = X(s.t1);
      const brks = t.breaks.filter((b) => b.start >= s.t0 && b.end <= s.t1);
      const brkX = brks.map((b) => (X(b.start) + X(b.end)) / 2);
      // CHAPTER-HEAD RULE (§8): one line, always. Numeral + name + minutes; else numeral + name;
      // else (finish only) numeral + its first word; else the numeral alone.
      const chs = t.chapters.filter((c) => c.start >= s.t0 - 1e-6 && c.start < s.t1);
      let prevEnd = -Infinity;
      const heads = chs.map((c, i): Head => {
        const x0h = X(c.start) + 10;
        const lim = i + 1 < chs.length ? X(chs[i + 1].start) - 12 : xR;
        const numW = tw(String(c.n), 34, 400, "display");
        const forms: [string | null, string | null][] = [
          [c.name, fmtMinutes(c.minutes)],
          [c.name, null],
        ];
        if (c.headShort) forms.push([c.headShort, null]);
        forms.push([null, null]);
        const wOf = ([nm, mn]: [string | null, string | null]) => numW + (nm ? 10 + tw(nm, 24, 600) : 0) + (mn ? 10 + tw(mn, 22, 500) : 0);
        const f = forms.find((fm) => x0h + wOf(fm) <= lim) ?? forms[forms.length - 1];
        // A chapter too narrow even for its numeral (a last minute or two at the serve line): the
        // numeral steps left to end at the edge, never into the head before it. Beyond the mock,
        // which never met one; the corpus has them (pack plans, dal).
        const x = Math.max(prevEnd + 12, Math.min(x0h, lim - wOf(f)));
        prevEnd = x + wOf(f);
        return { c, x, numW, name: f[0], mins: f[1], full: f[0] === c.name };
      });
      return { s, X, k, xs, brks, brkX, heads, lanes: [] };
    });
    const potNamedByHead = new Set(res.flatMap((r) => r.heads).filter((h) => h.full && h.c.pot).map((h) => h.c.pot!));
    for (const rs of res) {
      const { s, X, xs, brks, brkX } = rs;
      s.lanes.forEach((lane, i) => {
        const ly = s.rowY(i);
        const cy = ly + Bh / 2;
        // A break mark sits only on a lane whose line runs through the break (and always on the track).
        const marks = brks
          .map((b, j) => ({ b, x: brkX[j] }))
          .filter(({ b }) => t.pots.some((p) => p.lane === lane && p.start < b.start + 1 && p.end > b.end - 1));
        const occ: Interval[] = marks.map(({ x }) => [x - 13, x + 13]);
        const bl = t.blocks.filter((b) => b.lane === lane && b.start < s.t1 && b.end > s.t0).sort((a, b) => a.start - b.start);
        const rects = new Map<TimetableBlock, Rect>();
        for (const b of bl) {
          const xa = X(Math.max(b.start, s.t0));
          const xb = Math.max(X(Math.min(b.end, s.t1)), xa + 6);
          const r: Rect = { x: xa, y: ly, w: xb - xa - 2, h: Bh };
          if (b.touch) {
            r.h = Math.round(Bh * 0.42);
            r.y = cy - r.h / 2;
          }
          rects.set(b, r);
          occ.push([r.x - 2, r.x + r.w + 2]);
        }
        const free = (a: number, e: number) => !occ.some(([p, q]) => a < q && e > p);
        const labels: Label[] = [];
        const demoted: TimetableBlock[] = [];
        // LABEL RULE (§7): inside the block when it fits (one line; two where lanes are tall), otherwise
        // directly after it on its own lane; the full name first, then the short form; upright in a
        // narrow tall portrait block last. Never above or to the left. A block ending at the serve line
        // may put its label past the line, in a gutter. A block that can't be named is drawn as a touch.
        for (const b of bl) {
          if (b.touch || labelled.has(b)) continue;
          const r = rects.get(b)!;
          const atServe = s.last && b.end >= t.total - 0.5;
          const limit = atServe ? xR : xs - 4;
          const forms = b.short !== b.name ? [b.name, b.short] : [b.name];
          const tries: ["in" | "in2" | "after" | "up", string][] = [];
          for (const f of forms) {
            tries.push(["in", f]);
            if (twoOK) tries.push(["in2", f]);
            tries.push(["after", f]);
          }
          if (portrait) for (const f of forms) tries.push(["up", f]);
          let got: Omit<Label, "b" | "r"> | null = null;
          for (const [how, f] of tries) {
            const w = tw(f, FS, 600);
            if (how === "in" && w + 2 * INSET <= r.w && LH + 2 <= r.h) {
              got = { how, lines: [f], x: r.x + INSET, w };
              break;
            }
            if (how === "in2") {
              const ls = wrapWords(f, FS, 600, r.w - 2 * INSET, measure);
              if (ls.length === 2 && Math.max(...ls.map((l) => tw(l, FS, 600))) + 2 * INSET <= r.w) {
                got = { how, lines: ls, x: r.x + INSET, w: r.w - 2 * INSET };
                break;
              }
            }
            if (how === "up" && w + 2 * INSET <= r.h && FS * 1.3 <= r.w) {
              got = { how, lines: [f], x: r.x, w };
              break;
            }
            if (how === "after" && LH <= R) {
              const a = r.x + r.w + 8;
              const e = a + w;
              if (e <= limit && free(a - 4, e + 14)) {
                got = { how, lines: [f], x: a, w };
                occ.push([a - 6, e + 6]);
                break;
              }
            }
          }
          if (got) {
            labels.push({ b, r, ...got });
            labelled.add(b);
          } else if (atServe && !gut) unlabeledAtServe.push(tw(b.name, FS, 600));
          else if (b.end <= s.t1 + 1e-6) {
            demoted.push(b);
            r.h = Math.round(Bh * 0.42);
            r.y = cy - r.h / 2;
          }
        }
        // Pot lines: named once by the same rule (inside the line, else right after it), unless the
        // chapter head above already says it in full (§4.7, §7.7).
        const caps: Caption[] = [];
        const lanePots = t.pots.filter((p) => p.lane === lane && p.start < s.t1 && p.end > s.t0);
        for (const p of lanePots) {
          const roomy = 22 * 1.15 <= R;
          // A caption after its line must not sit on the lane's next line (it would name that one).
          const onOther = (a: number, e: number) => lanePots.some((q) => q !== p && X(q.start) < e && X(q.end) > a);
          const xa = X(Math.max(p.start, s.t0));
          const xb = X(Math.min(p.end, s.t1));
          if (potNamedByHead.has(p.key) || captioned.has(p) || !roomy) {
            caps.push({ p, xa, xb, cap: null });
            continue;
          }
          let got: Caption["cap"] = null;
          const blockEnds = [...rects.values()].filter((r) => r.x + r.w > xa && r.x + r.w < xb).map((r) => r.x + r.w + 14);
          for (const f of [...new Set([`${p.words} ${fmtMinutes(p.minutes)}`, p.words, p.short])]) {
            const w = tw(f, 22, 500);
            for (const at of [xa + 24, ...blockEnds]) {
              if (at + w <= xb - 18 && free(at - 6, at + w + 6)) {
                got = { s: f, x: at, w };
                break;
              }
            }
            if (!got && p.end <= s.t1 && xb + 8 + w <= xs - 8 && free(xb + 2, xb + 8 + w + 14) && !onOther(xb + 2, xb + 8 + w + 6)) {
              got = { s: f, x: xb + 8, w };
            }
            if (got) break;
          }
          if (got) {
            occ.push([got.x - 7, got.x + got.w + 7]);
            captioned.add(p);
          }
          caps.push({ p, xa, xb, cap: got });
        }
        rs.lanes.push({ lane, i, y: ly, cy, rects, labels, caps, occ, demoted, marks });
      });
    }
    return { res, unlabeledAtServe };
  }

  let L = place(0);
  const need = L.unlabeledAtServe.length ? Math.max(...L.unlabeledAtServe) + 16 : 0;
  if (gutterFloor === null) return need;
  const gutter = Math.max(need, gutterFloor);
  if (gutter) L = place(gutter);

  const marks: TMark[] = [];
  const words: TWord[] = [];
  const hits: HitRow[] = [];
  const mark = (m: Omit<TMark, "r" | "op" | "z"> & Partial<Pick<TMark, "r" | "op" | "z">>) => marks.push({ r: 0, op: 1, z: 1, ...m });
  const word = (
    k: string,
    role: WordRole,
    x: number,
    yy: number,
    s: string | string[],
    w: Partial<Pick<TWord, "size" | "weight" | "family" | "tone" | "op" | "z" | "rot" | "block" | "how" | "lh" | "w" | "pot">> & { align?: "left" | "right" } = {},
  ) => {
    const lines = Array.isArray(s) ? s : [s];
    const size = w.size ?? 22;
    const weight = w.weight ?? 500;
    const family = w.family ?? "text";
    const width = w.w ?? Math.max(...lines.map((l) => tw(l, size, weight, family)));
    const lh = w.lh ?? size * 1.15;
    words.push({
      k,
      role,
      x: w.align === "right" ? x - width : x,
      y: yy,
      w: width,
      h: lines.length * lh,
      lines,
      size,
      weight,
      family,
      tone: w.tone ?? "ink",
      lh,
      op: w.op ?? 1,
      z: w.z ?? 5,
      rot: w.rot,
      block: w.block,
      how: w.how,
      pot: w.pot,
    });
  };
  let prepRect: Rect | null = null;
  // Level 2's clock: the axis as laid, from which now is placed here and by the page at any minute.
  const clock: TimetableClock | null =
    now === null
      ? null
      : {
          rows: L.res.map((rs) => ({ t0: rs.s.t0, t1: rs.s.t1, x0, k: rs.k, laneTop: rs.s.laneTop, trackY: rs.s.trackY, last: rs.s.last, fill: `trkf${rs.s.sfx}` })),
          breaks: t.breaks.map((b) => ({
            ...b,
            at: null,
            leftW: Array.from({ length: Math.round(b.minutes) + 2 }, (_, r) => tw(fmtMinutes(r), 28, 400, "display")),
          })),
          total: t.total,
          xR,
          wNow: tw("now", 22, 600),
          wFree: tw("free", 22, 500),
        };
  const at = clock && now !== null ? nowOn(clock, now) : null;

  for (const rs of L.res) {
    const { s, X, xs, brks, brkX, heads } = rs;
    const sfx = s.sfx;
    // Chapter bands: every second chapter in Sand, from 10 above its head to 6 below its lanes (§6).
    t.chapters.forEach((c, i) => {
      if (i % 2 === 0 || c.end <= s.t0 || c.start >= s.t1) return;
      const xa = X(c.start);
      const xb = X(c.end);
      mark({ k: `band:${c.n}${sfx}`, role: "band", x: xa, y: s.headY - 10, w: xb - xa, h: s.laneBot + 6 - (s.headY - 10), tone: "sand", op: 0.62, z: 0, chapter: c.n });
    });
    for (const h of heads) {
      const n = h.c.n;
      word(`chn:${n}`, "chapter-num", h.x, s.headY, String(n), { size: 34, weight: 400, family: "display" });
      if (h.name) word(`chname:${n}`, "chapter-name", h.x + h.numW + 10, s.headY + 8, h.name, { size: 24, weight: 600 });
      if (h.name && h.mins) word(`chmin:${n}`, "chapter-min", h.x + h.numW + 10 + tw(h.name, 24, 600) + 10, s.headY + 10, h.mins, { tone: "soft" });
    }
    // The lanes' names in the margin.
    if (!s.prepOnly) {
      s.lanes.forEach((l, i) => {
        const ls = laneLines.get(l) ?? [l];
        const cy = s.rowY(i) + Bh / 2;
        word(`lane:${l}${sfx}`, "lane", box.x, cy - (ls.length * 25) / 2 + 1, ls, { size: margin.size, weight: 600, lh: 25, w: margin.w - 10 });
      });
    }
    // The shared prep block, down every lane of the first row at minute 0 (§6).
    if (t.prep && s.t0 === 0) {
      const xa = X(0);
      const xb = X(t.prep.end);
      const nL = s.lanes.length;
      const r: Rect = { x: xa, y: s.rowY(0), w: xb - xa - 3, h: s.rowY(nL - 1) + Bh - s.rowY(0) };
      prepRect = r;
      const pd = done(t.prep.end);
      mark({ k: "prep", role: "prep", ...r, tone: "soft", r: 8, op: pd ? 0.35 : 1 });
      const lop = pd ? 0.7 : 1;
      // Its label: "Prep" over its minutes; else on one line; else "Prep" at 24, at 22; else upright.
      const t1 = COOK_COPY.prepChapter;
      const t2 = fmtMinutes(t.prep.end);
      const both = `${t1} ${t2}`;
      if (Math.max(tw(t1, 26, 600), tw(t2, 22, 500)) + 20 <= r.w && r.h >= 66) {
        word("prep:t", "prep-label", r.x + 10, r.y + 10, t1, { size: 26, weight: 600, tone: "paper", op: lop });
        word("prep:m", "prep-min", r.x + 10, r.y + 40, t2, { tone: "paper", op: 0.85 * lop });
      } else if (tw(both, 24, 600) + 18 <= r.w) {
        word("prep:t", "prep-label", r.x + 10, r.y + r.h / 2 - 13, both, { size: 24, weight: 600, tone: "paper", op: lop });
      } else if (tw(t1, 24, 600) + 14 <= r.w) {
        word("prep:t", "prep-label", r.x + 7, r.y + 10, t1, { size: 24, weight: 600, tone: "paper", op: lop });
      } else if (tw(t1, 22, 600) + 10 <= r.w) {
        word("prep:t", "prep-label", r.x + 5, r.y + 10, t1, { size: 22, weight: 600, tone: "paper", op: lop });
      } else if (tw(t1, 24, 600) + 16 <= r.h && r.w >= 32) {
        const w = tw(t1, 24, 600);
        word("prep:t", "prep-label", r.x + r.w / 2 - w / 2 - 1, r.y + r.h / 2 - 13, t1, { size: 24, weight: 600, tone: "paper", op: lop, rot: -90, lh: 26, w: w + 2 });
      }
    }
    // Lanes: blocks, their labels, the pot lines and their captions, the break marks.
    for (const ln of rs.lanes) {
      for (const [b, r] of ln.rects) {
        const low = b.touch || ln.demoted.includes(b);
        mark({ k: `${b.key}${sfx}`, role: "block", ...r, tone: b.sand ? "soft" : "ink", r: low ? 4 : 7, op: done(b.end) ? 0.35 : 1, block: b.key, low });
      }
      for (const lb of ln.labels) {
        const dn = done(lb.b.end);
        if (lb.how === "up") {
          const w = lb.w + 2;
          word(`bl:${lb.b.key}`, "block-label", lb.r.x + lb.r.w / 2 - w / 2, lb.r.y + lb.r.h / 2 - LH / 2, lb.lines, {
            size: FS,
            weight: 600,
            tone: "paper",
            lh: LH,
            w,
            rot: -90,
            op: dn ? 0.7 : 1,
            block: lb.b.key,
            how: "up",
          });
          continue;
        }
        const inside = lb.how !== "after";
        word(`bl:${lb.b.key}`, "block-label", lb.x, ln.cy - (lb.lines.length * LH) / 2 + 1, lb.lines, {
          size: FS,
          weight: 600,
          tone: inside ? "paper" : "ink",
          lh: LH,
          w: lb.w + 2,
          op: dn ? (inside ? 0.7 : 0.4) : 1,
          block: lb.b.key,
          how: lb.how,
        });
      }
      const pieces = new Map<TimetablePot, Interval[]>();
      for (const c of ln.caps) {
        const dn = done(c.p.end);
        if (c.cap) word(`pc:${c.p.key}`, "pot-caption", c.cap.x, ln.cy - 13, c.cap.s, { tone: "soft", op: dn ? POT_DONE.caption : 1, pot: c.p.key });
        // The line is the wait; it is cut around anything sitting on it.
        const cuts = unionOf(ln.occ.filter(([a, b]) => b > c.xa && a < c.xb));
        let a = c.xa;
        let piece = 0;
        const drawnPieces: Interval[] = [];
        for (const [c0, c1] of [...cuts, [c.xb, c.xb] as Interval]) {
          const e = Math.min(c0, c.xb);
          if (e - a > 10) {
            mark({ k: `pl:${c.p.key}:${piece++}${sfx}`, role: "pot-line", x: a, y: ln.cy - 1.5, w: e - a, h: 3, tone: "soft", op: dn ? POT_DONE.line : 1, pot: c.p.key });
            drawnPieces.push([a, e]);
          }
          a = Math.max(a, c1);
        }
        pieces.set(c.p, drawnPieces);
      }
      for (const { b, x } of ln.marks) {
        const bh = Math.min(28, R - 2);
        mark({ k: `brk:${t.breaks.indexOf(b)}:${ln.lane}`, role: "break", x: x - 12, y: ln.cy - bh / 2, w: 24, h: bh, tone: "soft", z: 3, op: now !== null && b.end <= now ? 0.4 : 1 });
      }
      // What lies under a finger on this lane (the read's hit test): what is drawn of each step.
      const here = t.segments.filter((sg) => sg.lane === ln.lane && sg.start < s.t1 && sg.end > s.t0);
      const xa = (sg: { start: number }) => X(Math.max(sg.start, s.t0));
      const xb = (sg: { end: number }) => X(Math.min(sg.end, s.t1));
      const boxes = new Map<string, Interval[]>(here.map((sg) => [sg.key, []]));
      const longest = (ss: typeof here) => ss.reduce((a, b) => (xb(b) - xa(b) > xb(a) - xa(a) ? b : a));
      for (const [b, r] of ln.rects) {
        // A block is its steps' side by side, a gap between two shared at its middle; its label after it is its longest step's.
        const own = here.filter((sg) => !sg.pot && b.tasks.includes(sg.tasks[0])).sort((p, q) => p.start - q.start);
        own.forEach((sg, i) => {
          const a = i === 0 ? r.x : (xb(own[i - 1]) + xa(sg)) / 2;
          const e = i === own.length - 1 ? r.x + r.w : (xb(sg) + xa(own[i + 1])) / 2;
          boxes.get(sg.key)!.push([a, e]);
        });
        // (the label as drawn: its words' box is 2 wider than their measure)
        const lb = ln.labels.find((l) => l.b === b);
        if (lb && lb.how === "after" && own.length) boxes.get(longest(own).key)!.push([lb.x, lb.x + lb.w + 2]);
      }
      for (const c of ln.caps) {
        // A pot is its line as drawn, cut around what sits on it, and its caption.
        const own = here.filter((sg) => sg.pot && c.p.tasks.includes(sg.tasks[0]));
        for (const sg of own) {
          for (const [pa, pe] of pieces.get(c.p) ?? []) {
            const a = Math.max(pa, xa(sg));
            const e = Math.min(pe, xb(sg));
            if (e > a) boxes.get(sg.key)!.push([a, e]);
          }
        }
        if (c.cap && own.length) boxes.get(longest(own).key)!.push([c.cap.x, c.cap.x + c.cap.w]);
      }
      const segs = here
        .map((sg) => {
          const blk = t.blocks.find((b) => b.tasks.includes(sg.tasks[0]) && b.lane === sg.lane && !sg.pot) ?? null;
          const bx = boxes.get(sg.key)!;
          return { key: sg.key, x0: xa(sg), x1: xb(sg), block: blk ? blk.key : null, pot: sg.pot, done: done(sg.end), boxes: bx };
        })
        .sort((p, q) => p.x0 - q.x0);
      hits.push({ lane: ln.lane, top: s.laneTop + ln.i * R, h: R, segs });
    }
    const trackY = s.trackY;
    // A long wait inside a row: a gap in the track, its mark, and its real minutes under it.
    const noteSpans: Interval[] = [];
    // The total at the serve line's foot (opening, last row), placed first so the free notes keep off it.
    const tot = fmtTotal(t.total);
    const totW = tw(tot, 36, 400, "display");
    const totR = Math.min(xs + totW / 2, xR + 4);
    const totL = s.last && now === null ? totR - totW : Infinity;
    brks.forEach((b, j) => {
      const xm = brkX[j];
      const bi = t.breaks.indexOf(b);
      mark({ k: `trkgap:${bi}`, role: "track-gap", x: xm - 12, y: trackY - 4, w: 24, h: 8, tone: o.ground, z: 3 });
      mark({ k: `brk:${bi}:track`, role: "break-track", x: xm - 10, y: trackY - 12, w: 20, h: 24, tone: "soft", z: 4 });
      if (clock) clock.breaks[bi].at = { row: s.si, xm };
      // Laid whatever the minute: near now it gives way to now's words (`givesWay`), at any minute.
      {
        const bm = fmtMinutes(b.minutes);
        const wm = tw(bm, 32, 400, "display");
        const wf = tw("free", 22, 500);
        // Clamped inside the chart (§6), and, beyond the mock, clear of the total and of the note
        // before it: a break near the serve line or close behind another (pack plans) would sit on them.
        // Squeezed between those, the note drops "free", then goes; the break's // marks stay.
        const prev = noteSpans.length ? noteSpans[noteSpans.length - 1][1] + 20 : -Infinity;
        const limit = Math.min(xR, totL - 20);
        for (const wAll of [wm + 8 + wf, wm]) {
          const xl = Math.max(prev, Math.min(xm - wAll / 2, limit - wAll));
          if (xl + wAll > limit + 1e-6) continue;
          word(`brk:${bi}m`, "break-minutes", xl, trackY + 10, bm, { size: 32, weight: 400, family: "display" });
          if (wAll > wm) word(`brk:${bi}f`, "break-free", xl + wm + 8, trackY + 18, "free", { tone: "soft" });
          noteSpans.push([xl, xl + wAll]);
          break;
        }
      }
    });
    // The time track: the progress line's own mark; done is its filled part (§9).
    mark({ k: `trk${sfx}`, role: "track", x: x0, y: trackY - 2, w: xs - x0, h: 4, tone: "track", r: 2, z: 2 });
    mark({ k: `trkf${sfx}`, role: "track-fill", x: x0, y: trackY - 2, w: at?.fills.get(`trkf${sfx}`) ?? 0, h: 4, tone: "ink", r: 2, z: 2 });
    // The serve line, and on the opening the total at its foot.
    if (s.last) {
      mark({ k: "serve", role: "serve", x: xs - 1.5, y: s.laneTop - 6, w: 3.5, h: trackY + 6 - (s.laneTop - 6), tone: "ink", z: 3 });
      if (now === null) word("total", "total", totR, trackY + 8, tot, { size: 36, weight: 400, family: "display", align: "right" });
    }
    // Quiet minute ticks under the track: none inside a break, under the total or a free note; under
    // now's words they give way (`givesWay`).
    const real = t.total - t.breaks.reduce((a, b) => a + b.minutes, 0);
    const step = real > 70 ? 30 : t.total > 35 ? 10 : 5;
    const nowIn = at !== null && at.row === s.si;
    for (let m = Math.ceil(s.t0 / step) * step; m < s.t1; m += step) {
      if (t.breaks.some((b) => m > b.start - 2 && m < b.end + 2)) continue;
      const x = X(m);
      const str = String(m);
      const w = tw(str, 22, 500);
      const xl = m === s.t0 ? x : x - w / 2;
      if (xl + w > totL - 24 || x + w / 2 > xs - 10) continue;
      if (noteSpans.some(([a, b]) => xl + w > a - 20 && xl < b + 20)) continue;
      word(`tick:${m}`, "tick", xl, trackY + 14, str, { tone: "soft" });
    }
    // Now (level 2): one Ember line up through the lanes from the end of the filled track (§9).
    if (nowIn) {
      mark({ k: "now", role: "now", ...at.mark, w: 3, tone: "ember", z: 4 });
      words.push(...nowWords(clock!, at));
    }
  }

  // What gives way to now's words at this minute is held aside: drawn again when now moves off it.
  const gaveWay = clock && at ? words.filter((w) => givesWay(clock, at, w)) : [];
  const shownWords = gaveWay.length ? words.filter((w) => !gaveWay.includes(w)) : words;
  const demoted = L.res.flatMap((rs) => rs.lanes.flatMap((l) => l.demoted.map((b) => `${b.lane}: ${b.name}`)));
  const last = rows[rows.length - 1];
  return {
    marks,
    words: shownWords,
    gaveWay,
    hits,
    prepRect,
    x0,
    trackY: last.trackY,
    R,
    blockH: Bh,
    fits,
    demoted,
    gutter,
    clock,
    top,
    bottom: top + used,
  };
}

/** What a finger at (x, y) touches on the timetable: the prep block, or a step on the lane under it. */
export function hitTimetable(d: TimetableDrawing, x: number, y: number): { kind: "prep" } | { kind: "step"; key: string } | null {
  const p = d.prepRect;
  if (p && x >= p.x - 4 && x <= p.x + p.w + 4 && y >= p.y - 4 && y <= p.y + p.h + 4) return { kind: "prep" };
  const row = d.hits.find((r) => y >= r.top && y < r.top + r.h);
  if (!row || !row.segs.length) return null;
  // What is drawn under the finger: a step's share of its block, the label after it, its stretch of
  // pot line or the pot's caption. A thing drawn narrower than a finger (a touch, a sliver of a block)
  // is a finger wide about its middle. Work takes the finger before any wait does, its finger's width
  // included, so a touch sitting on a pot's line reads as the touch a few cpx to either side of it;
  // of pots alone, the shortest, so a short wait inside a long one (heat the fat while the potatoes
  // simmer) still has a place of its own.
  const reach = ([a, b]: [number, number]): [number, number] =>
    b - a >= FINGER ? [a, b] : [Math.min(a, (a + b) / 2 - FINGER / 2), Math.max(b, (a + b) / 2 + FINGER / 2)];
  const on = (sg: HitSeg, grown: boolean) =>
    sg.boxes.some((bx) => {
      const [a, b] = grown ? reach(bx) : bx;
      return x >= a && x <= b;
    });
  const nearest = (ss: HitSeg[]) => {
    const off = (sg: HitSeg) => Math.min(...sg.boxes.map(([a, b]) => (x < a ? a - x : x > b ? x - b : 0)));
    return ss.reduce((a, b) => (off(b) < off(a) ? b : a));
  };
  const shortest = (ss: HitSeg[]) => ss.reduce((a, b) => (b.x1 - b.x0 < a.x1 - a.x0 ? b : a));
  for (const grown of [false, true]) {
    const work = row.segs.filter((sg) => !sg.pot && on(sg, grown));
    if (work.length) return { kind: "step", key: nearest(work).key };
  }
  // Of the waits, the shortest under the finger, its finger-wide reach counted with the others' exact
  // lines: a short wait over a long one keeps its finger beside its line, where the long line runs.
  const pots = row.segs.filter((sg) => sg.pot && on(sg, true));
  if (pots.length) return { kind: "step", key: shortest(pots).key };
  // A step with nothing of its own drawn still has its minutes where nothing drawn takes the touch.
  const hidden = row.segs.filter((sg) => !sg.boxes.length && x >= sg.x0 && x <= sg.x1);
  return hidden.length ? { kind: "step", key: shortest(hidden).key } : null;
}

type HitSeg = TimetableDrawing["hits"][number]["segs"][number];

/** A finger's width, cpx: the least a drawn step is wide to a touch. */
const FINGER = 24;

// ---------------------------------------------------------------------------
// The opening (SPEC §6, the mock's drawOpening)
// ---------------------------------------------------------------------------

/** An ingredient as Get out lists it: its amount (bold) and name. */
export interface GetOutItem {
  index: number;
  amount: string | null;
  name: string;
}

export interface OpeningInput {
  /** The screen, cpx. */
  W: number;
  H: number;
  portrait: boolean;
  /** The side margin, cpx (the cook view's edge). */
  side: number;
  title: string;
  /** The controls group (voice dot, well, Start) and More, as measured, cpx; a zero box when absent. */
  controls: { w: number; h: number };
  more: { w: number; h: number };
  /** Both modes' totals when the toggle shows (a plan with mise), else null. */
  toggle: { mode: "first" | "go"; first: number; go: number } | null;
  ahead: { name: string; lead: string }[];
  getOut: GetOutItem[];
  /** "for 8" beside Get out when the cook scaled the recipe. */
  scaleNote: string | null;
  /** The hands-on words as the kitchen row's time line says them (`handsOnWords`), else null. */
  handsOn?: string | null;
  /** The chart height the timetable needs for its floor (`timetableFloorHeight`); portrait's Get out gives rows up to reach it. */
  chartFloor?: number;
  measure: Measure;
}

export interface ToggleItem {
  mode: "first" | "go";
  label: string;
  on: boolean;
  x: number;
  w: number;
  minutes: string;
  minutesX: number;
}

export interface OpeningLayout {
  back: Rect;
  title: { x: number; y: number; w: number; lines: string[]; size: number; lh: number };
  controls: { x: number; y: number };
  more: { x: number; y: number };
  toggle: { y: number; h: number; items: ToggleItem[]; x: number; w: number } | null;
  /** "45 min hands-on", once, quietly, at the head of the toggle's row (or on a line of its own under the title). */
  handsOn: { x: number; y: number; w: number; h: number; text: string } | null;
  ahead: { x: number; y: number; items: { name: string; lead: string; x: number; w: number }[] } | null;
  getOut: {
    head: { x: number; y: number; w: number };
    /** Each shown entry: its place, and its name as shown (a long one drops its note). */
    items: { index: number; amount: string | null; name: string; x: number; y: number; w: number }[];
    more: { x: number; y: number; text: string } | null;
    box: Rect;
  } | null;
  chart: Rect;
}

const stripParens = (s: string) => s.replace(/\s*\([^)]*\)/g, "").trim();

export function layoutOpening(i: OpeningInput): OpeningLayout {
  const { W, H, side, measure } = i;
  const tw = (s: string, size: number, weight = 500, family: "text" | "display" = "text") => measure(s, size, weight, family);
  const top = 22;
  const ctlH = Math.max(64, i.controls.h);
  const moreX = W - side - i.more.w;
  // The controls stand left of More; a row too wide for that (a well of other cooks' timers, in
  // portrait) takes a row of its own under More, the full width, and the title goes under it.
  const own = i.more.w > 0 && i.controls.w > moreX - 12 - side;
  const moreH = Math.max(40, i.more.h);
  const ctlTop = own ? top + moreH + 8 : top;
  const ctlX = (i.more.w && !own ? moreX - 12 : W - side) - i.controls.w;
  const mid = ctlTop + ctlH / 2;
  const titleX = side + 30;
  const titleMax = ctlX - 30 - titleX;
  // The title beside the controls, as the mock draws it; a title that would take more than two lines
  // there (the app's controls and More are wider than the mock's lone Start, most of all in portrait)
  // goes full width under the controls' row instead, so the chart keeps its height. So does one
  // with a word wider than the room beside the controls ("Weeknight" in portrait).
  const beside = wrapWords(i.title, 44, 400, titleMax, measure, "display");
  const under = own || beside.length > 2 || beside.some((ln) => measure(ln, 44, 400, "display") > titleMax);
  const lines = under ? wrapWords(i.title, 44, 400, W - side - titleX, measure, "display") : beside;
  const titleY = under ? ctlTop + ctlH + 4 : top + 6;
  let rowY = under ? titleY + lines.length * 48 + 6 + 16 : top + Math.max(ctlH, lines.length * 48 + 6) + 16;

  // "Prep first 40 min   As I go 30 min": both totals visible, so the trade-off reads before the tap.
  let toggle: OpeningLayout["toggle"] = null;
  let togW = 0;
  let toggleItems: { mode: "first" | "go"; label: string; on: boolean; minutes: string; wl: number; wm: number }[] | null = null;
  if (i.toggle) {
    const tg = i.toggle;
    const items = (
      [
        ["first", COOK_COPY.prepFirst, tg.first],
        ["go", COOK_COPY.asIGo, tg.go],
      ] as const
    ).map(([mode, label, mins]) => {
      const on = tg.mode === mode;
      return { mode, label, on, minutes: fmtTotal(mins), wl: tw(label, 28, on ? 600 : 500), wm: tw(fmtTotal(mins), 22, 500) };
    });
    const gap = 28;
    togW = items.reduce((s, it) => s + it.wl + 8 + it.wm, 0) + gap;
    toggleItems = items;
  }
  // The hands-on minutes: at the head of the toggle's row, with the totals;
  // where the toggle leaves no room for them, on a line of their own under the title.
  let handsOn: OpeningLayout["handsOn"] = null;
  let handsEnd = side;
  if (i.handsOn) {
    const text = i.handsOn;
    const w = tw(text, 22, 500);
    const onRow = side + w + 40 <= W - side - togW;
    // On the row it stands as the toggle's minutes do (4 lower than the row); alone, the row moves under it.
    handsOn = { x: side, y: onRow ? rowY + 4 : rowY, w, h: 36, text };
    if (onRow) handsEnd = side + w + 32;
    else rowY += 36;
  }
  if (toggleItems) {
    const gap = 28;
    let x = W - side - togW;
    const out: ToggleItem[] = [];
    for (const it of toggleItems) {
      out.push({ mode: it.mode, label: it.label, on: it.on, x, w: it.wl, minutes: it.minutes, minutesX: x + it.wl + 8 });
      x += it.wl + 8 + it.wm + gap;
    }
    toggle = { y: rowY, h: 36, items: out, x: W - side - togW, w: togW };
  }

  const aheadW = (a: { name: string; lead: string }) => tw(a.name, 22, 700) + 6 + tw(a.lead, 22, 500);
  const aheadHeadW = tw(COOK_COPY.ahead, 24, 600);
  const aheadAll = i.ahead.length ? aheadHeadW + 20 + i.ahead.reduce((s, a) => s + aheadW(a) + 26, 0) : 0;
  // Landscape: on the toggle's row when it fits; portrait: always above Get out (SPEC §6).
  const aheadOnRow = !i.portrait && i.ahead.length > 0 && handsEnd + aheadAll + 40 <= W - side - togW;
  const aheadAt = (x: number, y: number): OpeningLayout["ahead"] => {
    let ax = x + aheadHeadW + 20;
    const items = i.ahead.map((a) => {
      const it = { ...a, x: ax, w: aheadW(a) };
      ax += it.w + 26;
      return it;
    });
    return { x, y, items };
  };
  let ahead: OpeningLayout["ahead"] = aheadOnRow ? aheadAt(handsEnd, rowY + 4) : null;

  const headW = tw(COOK_COPY.getOut, 24, 600) + (i.scaleNote ? 8 + tw(i.scaleNote, 22, 500) : 0);
  const entryW = (it: { amount: string | null; name: string }) =>
    (it.amount ? tw(it.amount, 22, 700) + tw(" ", 22, 500) : 0) + tw(it.name, 22, 500);
  const items = i.getOut.map((g) => ({ index: g.index, amount: g.amount === null ? null : stripParens(g.amount) || null, name: stripParens(g.name) }));
  let getOut: OpeningLayout["getOut"] = null;
  let chartBottom: number;
  if (!i.portrait) {
    // Landscape: Get out is one quiet footer line (ahead goes above it when the toggle row is full).
    const fy = H - 18 - 34;
    const aheadAbove = i.ahead.length > 0 && !aheadOnRow;
    if (aheadAbove) ahead = aheadAt(side, items.length ? fy - 40 : fy);
    chartBottom = (aheadAbove && items.length ? fy - 40 : aheadAbove ? fy : items.length ? fy : H - 18) - 14;
    if (items.length) {
      let x = side + headW + 20;
      const xmax = W - side;
      const shown: NonNullable<OpeningLayout["getOut"]>["items"] = [];
      for (const it of items) {
        const w = entryW(it) + 6;
        const left = items.length - shown.length - 1;
        const moreW = left > 0 ? tw(COOK_COPY.andMore(left), 22, 600) + 24 : 0;
        if (x + w > xmax - moreW) break;
        shown.push({ ...it, x, y: fy + 2, w });
        x += w + 22;
      }
      const rest = items.length - shown.length;
      getOut = {
        head: { x: side, y: fy, w: headW },
        items: shown,
        more: rest > 0 ? { x, y: fy + 2, text: COOK_COPY.andMore(rest) } : null,
        box: { x: side, y: fy, w: W - 2 * side, h: 34 },
      };
    }
  } else {
    // Portrait: the height goes to the lanes; Ahead and Get out sit below the chart, Get out in 2 columns of 3.
    // The lanes come first: Get out gives up rows (3, then 2, then 1) until the chart reaches its floor.
    const colW = (W - 2 * side - 30) / 2;
    const aheadBelow = i.ahead.length > 0 && !aheadOnRow;
    const cyTop = rowY + 48;
    const footOf = (n: number) => H - 22 - (items.length ? 38 + n * 30 + 4 : 0) - (aheadBelow ? 44 : 0);
    let rowsN = Math.min(3, Math.ceil(items.length / 2));
    while (rowsN > 1 && i.chartFloor !== undefined && footOf(rowsN) - 26 - cyTop < i.chartFloor) rowsN--;
    const fy0 = footOf(rowsN);
    chartBottom = fy0 - 26;
    let yy = fy0;
    if (aheadBelow) {
      ahead = aheadAt(side, yy);
      yy += 44;
    }
    if (items.length) {
      const headY = yy;
      yy += 38;
      const y0 = yy;
      const shown: NonNullable<OpeningLayout["getOut"]>["items"] = [];
      let more: { x: number; y: number; text: string } | null = null;
      let k = 0;
      for (let col = 0; col < 2; col++) {
        let y = y0;
        const cap = rowsN - (col === 1 && items.length > 2 * rowsN ? 1 : 0);
        for (let r = 0; r < cap && k < items.length; r++, k++) {
          const it = items[k];
          // One line each: an entry longer than its column drops its note after the comma.
          let name = it.name;
          if (entryW({ ...it, name }) > colW) name = name.split(",")[0].trim();
          while (entryW({ ...it, name }) > colW && name.includes(" ")) name = `${name.split(" ").slice(0, -1).join(" ")}`;
          shown.push({ ...it, name, x: side + col * (colW + 30), y, w: Math.min(colW, entryW({ ...it, name }) + 4) });
          y += 30;
        }
        if (col === 1 && k < items.length) more = { x: side + colW + 30, y, text: COOK_COPY.andMore(items.length - k) };
      }
      getOut = { head: { x: side, y: headY, w: headW }, items: shown, more, box: { x: side, y: headY, w: W - 2 * side, h: yy - headY + rowsN * 30 } };
    }
  }
  const cy = rowY + 48;
  return {
    back: { x: side - 8, y: titleY, w: 32, h: 48 },
    title: { x: titleX, y: titleY, w: under ? W - side - titleX : titleMax, lines, size: 44, lh: 48 },
    controls: { x: ctlX, y: mid - i.controls.h / 2 },
    more: { x: moreX, y: (own ? top + moreH / 2 : mid) - i.more.h / 2 },
    toggle,
    handsOn,
    ahead,
    getOut,
    chart: { x: side, y: cy, w: W - 2 * side, h: chartBottom - cy },
  };
}

// ---------------------------------------------------------------------------
// The whole cook at the cook sheet's level 2 (SPEC §10, the mock's drawPeek(2))
// ---------------------------------------------------------------------------

/** A name cut to one line at a word, with "…"; a single word too long is cut inside it. */
function cutTitle(title: string, max: number, width: (s: string) => number): string {
  if (width(title) <= max) return title;
  let words = title.split(" ");
  while (words.length > 1) {
    words = words.slice(0, -1);
    const text = `${words.join(" ").replace(/[,:;–-]$/, "")}…`;
    if (width(text) <= max) return text;
  }
  let word = words[0];
  while (word.length > 1 && width(`${word}…`) > max) word = word.slice(0, -1);
  return `${word}…`;
}

export interface WholeCookInput {
  W: number;
  /** Where the sheet's foot band starts, cpx: the chart ends above it. */
  footTop: number;
  portrait: boolean;
  side: number;
  title: string;
  /** Time to the table at 40 (its words under it), as measured, cpx. */
  tt: { w: number; h: number };
  more: { w: number; h: number };
  /** "Whole recipe": the way to level 3. */
  ghost: { w: number; h: number };
  /** The toggle on Prep (a plan with mise), else null. */
  toggle: { mode: "first" | "go"; first: number; go: number } | null;
  /** A step read in the header: its words, and Go's and Whole recipe's widths. */
  read: { text: string; go: { w: number } | null } | null;
  /** The voice hint shows. */
  hint: { w: number } | null;
  /** A tap target's height, cpx (48 px). */
  btnH: number;
  measure: Measure;
}

export interface WholeCookLayout {
  /** The sheet's paper, from 18 cpx (SPEC §10), and its grabber. */
  sheet: Rect;
  grab: Rect;
  back: Rect;
  title: { x: number; y: number; w: number; text: string };
  tt: { x: number; y: number; op: number };
  more: { x: number; y: number };
  ghost: Rect | null;
  hint: { x: number; y: number } | null;
  toggle: OpeningLayout["toggle"];
  read: { box: Rect; lines: string[]; size: number; textX: number; textY: number; go: Rect | null; whole: Rect } | null;
  chart: Rect;
}

/** The narrowest the read's words stand beside its buttons; narrower, the buttons go under them. */
const READ_MIN_TEXT_W = 240;

export function layoutWholeCook(i: WholeCookInput): WholeCookLayout {
  const { W, side, measure } = i;
  const tw = (s: string, size: number, weight = 500, family: "text" | "display" = "text") => measure(s, size, weight, family);
  const top = 18;
  const right = W - side;
  // The header (SPEC §10): the name on the left, time to the table on the right. The app's own
  // chrome stands with them: More at the far right, and "Whole recipe" with the voice hint, beside
  // the name in landscape, on a second row under it in portrait (one row can't hold them all).
  const moreX = right - i.more.w;
  const ttRight = i.more.w ? moreX - 16 : right;
  const ttX = ttRight - i.tt.w;
  const titleX = side + 22;
  const rowY = top + 40;
  // Portrait's second row starts under time to the table (its words run to 2 lines).
  const row2Y = Math.max(top + 92, top + 14 + i.tt.h + 6);
  const ghost = i.portrait
    ? { x: titleX, y: row2Y + 2, w: i.ghost.w, h: i.btnH }
    : { x: ttX - 24 - i.ghost.w, y: rowY - i.btnH / 2, w: i.ghost.w, h: i.btnH };
  const titleMax = (i.portrait ? ttX : ghost.x) - 24 - titleX;
  const text = cutTitle(i.title, titleMax, (s) => tw(s, 24, 600));
  const title = { x: titleX, y: top + 30, w: titleMax, text };
  // The hint goes where it has room: after the name (landscape) or after Whole recipe (portrait), else not at all.
  // A read replaces the header, so the hint goes with it.
  let hint: { x: number; y: number } | null = null;
  if (i.hint && !i.read) {
    const x = i.portrait ? ghost.x + ghost.w + 20 : titleX + tw(text, 24, 600) + 24;
    const limit = i.portrait ? right : ghost.x - 20;
    if (x + i.hint.w <= limit) hint = { x, y: i.portrait ? row2Y + 2 + i.btnH / 2 - 14 : top + 32 };
  }
  const headH = i.portrait ? row2Y + 2 + i.btnH + 12 - top : 92;
  let read: WholeCookLayout["read"] = null;
  if (i.read) {
    const goW = i.read.go?.w ?? 0;
    const btns = (goW ? goW + 12 : 0) + i.ghost.w;
    // It replaces the header, More aside: More stays where it was. It starts under the sheet's grabber.
    const boxR = i.more.w ? moreX - 12 : right + 12;
    const box = { x: side - 12, y: top + 18, w: boxR - (side - 12), h: headH - 22 };
    // The words beside the buttons (landscape); where that leaves them too narrow, as in
    // portrait, the buttons take a row of their own under the words, at the box's right.
    const beside = box.w - btns - 48 >= READ_MIN_TEXT_W;
    const textW = beside ? box.w - btns - 48 : box.w - 24;
    const textH = beside ? box.h - 12 : box.h - i.btnH - 24;
    let pick: { size: number; lines: string[] } | null = null;
    for (const size of [26, 24, 22]) {
      const lines = wrapWords(i.read.text, size, 500, textW, measure);
      if (lines.length * size * 1.2 <= textH) {
        pick = { size, lines };
        break;
      }
    }
    if (!pick) {
      const all = wrapWords(i.read.text, 22, 500, textW, measure);
      const k = Math.max(1, Math.floor(textH / (22 * 1.2)));
      const lines = all.slice(0, k);
      if (k < all.length) {
        let last = `${lines[k - 1]}…`;
        while (tw(last, 22, 500) > textW && last.includes(" ")) last = `${last.split(" ").slice(0, -2).join(" ")}…`;
        lines[k - 1] = last;
      }
      pick = { size: 22, lines };
    }
    const by = beside ? box.y + box.h / 2 - i.btnH / 2 : box.y + box.h - 10 - i.btnH;
    const wholeX = box.x + box.w - 12 - i.ghost.w;
    const textBlock = pick.lines.length * pick.size * 1.2;
    read = {
      box,
      lines: pick.lines,
      size: pick.size,
      textX: box.x + 12,
      textY: beside ? box.y + box.h / 2 - textBlock / 2 : box.y + 6 + (textH - textBlock) / 2,
      go: i.read.go ? { x: wholeX - 12 - goW, y: by, w: goW, h: i.btnH } : null,
      whole: { x: wholeX, y: by, w: i.ghost.w, h: i.btnH },
    };
  }
  let toggle: WholeCookLayout["toggle"] = null;
  let chartTop = top + headH;
  if (i.toggle) {
    const lay = layoutOpening({
      W,
      H: 2000,
      portrait: i.portrait,
      side,
      title: "",
      controls: { w: 0, h: 0 },
      more: { w: 0, h: 0 },
      toggle: i.toggle,
      ahead: [],
      getOut: [],
      scaleNote: null,
      measure,
    });
    toggle = lay.toggle && { ...lay.toggle, y: chartTop };
    chartTop += 44;
  }
  const chartBottom = i.footTop - 8;
  return {
    sheet: { x: 0, y: top, w: W, h: i.footTop - top + 40 },
    grab: { x: W / 2 - 30, y: top + 10, w: 60, h: 6 },
    back: { x: side - 8, y: top + 18, w: 32, h: 48 },
    title,
    tt: { x: ttX, y: top + 14, op: read ? 0 : 1 },
    more: { x: moreX, y: rowY - i.more.h / 2 },
    ghost: read ? null : ghost,
    hint,
    toggle,
    read,
    chart: { x: side, y: chartTop, w: W - 2 * side, h: chartBottom - chartTop },
  };
}
