/**
 * The peek, laid out (look-ahead slice 1, DS v1.62): where each of `peekRows`'
 * rows stands in the drawer, at what size, in how many lines, and how tall the
 * drawer is (the peek's detent hangs from that height).
 *
 * Two forms, by shape, not by device: portrait (the tablet upright and a phone
 * are both 600 cpx across) is the narrow form.
 * - Wide (the drawing's tablet): a dot on the rail, the label, and at the
 *   right the dish and the minutes. The dish stands only where the label fits
 *   beside it on one line; a label wraps to two lines, cut at a word past that.
 * - Narrow (the drawing's phone): the dish in a fixed left column (a scan down
 *   it shows the dishes alternating), the dot, the label wrapped to three
 *   lines, the minutes in a right column.
 *
 * Type (cpx; the approved drawing in CSS px beside it): wide rows 24
 * (32 px at 1280×800, the drawing's 32), words beside them 22 (29.3 px, the
 * drawing's 29), ruled rows 24 (32 px). Narrow rows 30 (19.5 px at 390 wide,
 * the drawing's 19; 40 px upright), words 26 (16.9 px, the drawing's 16),
 * ruled rows 28 (18.2 px). Nothing is under the 22 cpx floor.
 *
 * Pure: px in, px out, with the browser's metrics passed in (`Measure`).
 */

import { durationText } from "./time-line";
import { peekRows, peekWords, ruledWords, type PeekInput, type PeekRow } from "./cook-peek";
import { COOK_COPY } from "./cook-view";
import { cutToWidth, wrapLines, type Measure } from "./sheet-layout";

export const PEEK_TYPE = {
  wide: { label: 24, meta: 22, ruled: 24, lh: 1.2, labelLines: 2 },
  narrow: { label: 30, meta: 26, ruled: 28, lh: 1.25, labelLines: 3 },
} as const;

/** Weights: a step's label, the words beside it, a ruled row. */
export const PEEK_WEIGHT = { label: 600, meta: 500, ruled: 500 } as const;

export interface PeekGeo {
  /** The drawer's width (the screen's, less Ask's room). */
  W: number;
  c: number;
  /** The side margin. */
  E: number;
  narrow: boolean;
  /** The tallest the drawer may stand; past it the peek folds sooner. */
  maxH: number;
}

interface Placed {
  y: number;
  h: number;
  /** The words, as lines. */
  lines: string[];
  /** The row as one line, for a screen reader. */
  said: string;
}
export type PeekDrawn =
  | (Placed & {
      kind: "step";
      key: string;
      now: boolean;
      pot: boolean;
      dish: string | null;
      minutes: string | null;
      /** The dot's centre, from the drawer's top. */
      dotY: number;
      /** Where the label's lines must end. */
      labelRight: number;
    })
  | (Placed & { kind: "break" | "table"; words: { lead: string; main: string; tail: string | null } })
  | (Placed & { kind: "after"; key: string });

export interface PeekDrawing {
  rows: PeekDrawn[];
  /** The drawer's height, its top padding (the arrows' room) and its foot included. */
  height: number;
  /** Type in px. */
  type: { label: number; meta: number; ruled: number; lh: number };
  cols: {
    /** The dot's centre. */
    dot: number;
    /** The labels' and the ruled rows' left edge. */
    label: number;
    /** The narrow form's dish column (its left edge and width); null in the wide form or with one dish. */
    dish: { x: number; w: number } | null;
    /** The wide form's dishes stand right-set to this edge, clear of the minutes' column. */
    dishRight: number;
    /** The right edge every row ends at. */
    right: number;
    labelRight: (r: PeekDrawn) => number;
  };
  dotR: number;
  rail: { x: number; y0: number; y1: number } | null;
  /** The fold `peekRows` was laid with (3 unless the screen is short). */
  limit: number;
}

/**
 * The room over the first row: the arrows on the sheet's edge. Their 80 cpx targets end where the
 * first row begins (`PEEK_ARROW_Y`, the glyphs' centre, is 40 cpx over it), so a tap on a row is
 * never an arrow's; the browser check found the 48 cpx room left a target over the first row.
 */
export const PEEK_TOP = { wide: 64, narrow: 64 };
/** The arrows' centre on the peek's Paper, cpx from its top: their targets end at the first row. */
export const PEEK_ARROW_Y = 24;
const PEEK_FOOT = 14;
/** The gap between the label and what stands at its right, cpx. */
const GAP = 24;

/** Words in at most `max` lines of `maxW`; past that the last line is cut at a word, with "…". */
function clampLines(text: string, px: number, wt: number, maxW: number, max: number, measure: Measure): string[] {
  const lines = wrapLines(text, px, wt, maxW, measure);
  if (lines.length <= max) return lines;
  const keep = lines.slice(0, max - 1);
  const rest = text.split(/\s+/).filter(Boolean).slice(keep.join(" ").split(" ").length).join(" ");
  return [...keep, cutToWidth(rest, px, wt, maxW, measure)];
}

function laid(rows: PeekRow[], g: PeekGeo, measure: Measure, limit: number): PeekDrawing {
  const T = g.narrow ? PEEK_TYPE.narrow : PEEK_TYPE.wide;
  const c = g.c;
  const px = { label: T.label * c, meta: T.meta * c, ruled: T.ruled * c };
  const lh = T.lh;
  const right = g.W - g.E;
  const minsOf = (r: PeekRow) => (r.kind === "step" && r.minutes !== null ? durationText(r.minutes) : null);
  const dishes = rows.flatMap((r) => (r.kind === "step" && r.dish ? [r.dish] : []));

  // The columns.
  let dishCol: { x: number; w: number } | null = null;
  let dot: number;
  if (g.narrow && dishes.length) {
    const w = Math.min(150 * c, Math.max(...dishes.map((d) => measure(d, px.meta, PEEK_WEIGHT.meta))));
    dishCol = { x: g.E, w };
    dot = g.E + w + 14 * c + 9 * c;
  } else dot = g.E + 14 * c;
  const labelX = dot + 25 * c;
  const minW = Math.max(0, ...rows.map((r) => (minsOf(r) ? measure(minsOf(r)!, px.meta, PEEK_WEIGHT.meta) : 0)));

  const out: PeekDrawn[] = [];
  let y = (g.narrow ? PEEK_TOP.narrow : PEEK_TOP.wide) * c;
  const pad = g.narrow ? 18 * c : 2.1 * c;
  const ruledGap = 8 * c;
  // The wide form's minutes are a column at the right; the dishes stand right-set before it.
  const minsRoom = minW ? minW + GAP * c : 0;
  const dishRight = right - minsRoom;
  for (const r of rows) {
    const said = peekWords(r).replace(/\u00a0/g, " ");
    if (r.kind === "step") {
      const mins = minsOf(r);
      let dish = r.dish;
      let labelRight: number;
      if (g.narrow) {
        labelRight = right - (minW ? minW + GAP * c : 0);
        if (dish && dishCol && measure(dish, px.meta, PEEK_WEIGHT.meta) > dishCol.w) dish = cutToWidth(dish, px.meta, PEEK_WEIGHT.meta, dishCol.w, measure);
      } else {
        const dishRoom = dish ? measure(dish, px.meta, PEEK_WEIGHT.meta) + GAP * c : 0;
        // The dish stands only where the label fits beside it on one line.
        if (dish && labelX + measure(r.label, px.label, PEEK_WEIGHT.label) + dishRoom > dishRight) dish = null;
        labelRight = dish ? dishRight - dishRoom : mins ? dishRight : right;
      }
      const lines = clampLines(r.label, px.label, PEEK_WEIGHT.label, labelRight - labelX, T.labelLines, measure);
      const h = lines.length * lh * px.label + 2 * pad;
      out.push({ kind: "step", key: r.key, now: r.now, pot: r.pot, dish, minutes: mins, lines, said, y, h, dotY: y + pad + (lh * px.label) / 2, labelRight });
      y += h;
    } else if (r.kind === "break" || r.kind === "table") {
      const w = ruledWords(r);
      const room = right - labelX;
      const one = (t: string | null) => [w.lead, w.main, t].filter(Boolean).join(" ");
      // A tail that would wrap the row is dropped first (the drawing's rule).
      const tail = w.tail && measure(one(w.tail), px.ruled, PEEK_WEIGHT.ruled) > room ? null : w.tail;
      const lines = wrapLines(one(tail), px.ruled, PEEK_WEIGHT.ruled, room, measure, "text", / +/);
      y += ruledGap;
      const h = lines.length * lh * px.ruled + 2 * (g.narrow ? 14 * c : 8 * c);
      out.push({ kind: r.kind, words: { ...w, tail }, lines, said, y, h });
      y += h;
    } else {
      const lines = clampLines(COOK_COPY.peekAfter(r.label), px.ruled, PEEK_WEIGHT.ruled, right - labelX, 2, measure);
      const h = lines.length * lh * px.ruled + 2 * (g.narrow ? 12 * c : 6 * c);
      out.push({ kind: "after", key: r.key, lines, said, y, h });
      y += h;
    }
  }
  const steps = out.filter((r): r is Extract<PeekDrawn, { kind: "step" }> => r.kind === "step");
  const rail = steps.length > 1 ? { x: dot, y0: steps[0].dotY, y1: steps[steps.length - 1].dotY } : null;
  return {
    rows: out,
    height: out.length ? y + PEEK_FOOT * c : 0,
    type: { ...px, lh },
    cols: {
      dot,
      label: labelX,
      dish: dishCol,
      dishRight,
      right,
      labelRight: (r) => (r.kind === "step" ? r.labelRight : right),
    },
    dotR: (g.narrow ? 8 : 9) * c,
    rail,
    limit,
  };
}

/** The peek laid out; folded sooner, down to the step in hand, where it stands taller than `maxH`. */
export function layoutPeek(input: PeekInput, g: PeekGeo, measure: Measure): PeekDrawing {
  let d = laid(peekRows(input), g, measure, 3);
  for (let limit = 2; d.height > g.maxH && limit >= 0; limit--) d = laid(peekRows(input, limit), g, measure, limit);
  return d;
}
