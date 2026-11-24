/**
 * The pull between the peek and the whole cook (asked 2026-11-24, after the
 * prototype's `morphPrep` and `morphAt`):
 * the peek's rows turn into the meal's lines under the finger, so the two
 * levels read as one drawing changing.
 *
 * - Each of the peek's rows rides the sheet's edge up until it reaches its
 *   stop, and stays there: the stop that is the same step in the whole cook,
 *   or the folded run that holds it. In the wide form it narrows into its
 *   dish's column on the way (its dish and minutes go first). At that one
 *   place the row's words give way to the stop's own: over each other where
 *   the two say the same, one after the other where they differ.
 * - The break's ruled row goes to the break's ruled gap, its "50 min free"
 *   the words that travel ("then" and "while it roasts" go first).
 * - The rest of the whole cook stands where it will be and shows as the
 *   sheet uncovers it: under the rows' foot while they ride (what comes after
 *   the break, each dish's line rising from the last step, a stop only once
 *   a stretch of its line stands), and up to the sheet's edge as the rows
 *   reach their stops (the heads, the work done, the pots already going).
 *
 * Two steps, so a pull costs no layout: `planPull` matches rows to stops and
 * notes every place once (when the layout or the lines change), and `pullAt`
 * says each part's shift, scale and opacity at a point of the pull. Pure: px
 * in, px out. Places are in px from the sheet's edge at the whole cook.
 */

import { clamp, lerp, sstep } from "@/lib/kitchen/sheet-layout";
import type { PeekDrawing } from "@/lib/kitchen/peek-layout";
import { LINES_TYPE, type ColumnsDrawing, type LinesDrawing, type ListDrawing } from "@/lib/kitchen/meal-lines-layout";
import type { OverviewPlace } from "@/lib/kitchen/overview-place";

/** When each part of the pull happens, as a share of the way from the peek (0) to the whole cook (1). */
export interface PullTimes {
  /** What a row sheds before it travels: its dish and minutes (the wide form), the break's "then" and "while it roasts", "after that", the peek's rail. */
  meta: readonly [number, number];
  /** The rows go sideways into their columns. */
  x: readonly [number, number];
  /** A row closes on a stop that the sheet's edge alone would not bring it to (a stop nearer the edge than its place in the peek, or under it on a long board). */
  y: readonly [number, number];
  /** A row's words give way to its stop's. */
  swap: readonly [number, number];
  /** The break's row gives way to the ruled gap. */
  brk: readonly [number, number];
}

/** The wide form: the rows shed their dish and minutes, narrow into their columns over the middle of the pull, then give way to their stops. */
export const PULL_COLUMNS: PullTimes = { meta: [0.22, 0.42], x: [0.45, 0.72], y: [0.45, 0.9], swap: [0.72, 0.9], brk: [0.5, 0.7] };
/**
 * The list: the rows are already the list's rows, so they keep their dish and minutes, take the list's
 * columns early (a few px), and give way once they stand in them (each word over its own).
 */
export const PULL_LIST: PullTimes = { meta: [0.22, 0.42], x: [0.16, 0.34], y: [0.3, 0.9], swap: [0.34, 0.62], brk: [0.34, 0.62] };
/** The whole cook's ink: nothing of it is drawn at the peek, and it is all there a tenth of the way in. */
export const PULL_INK = [0, 0.1] as const;
/** How much of its line stands over a stop before the stop shows, cpx, while the rows are on their way. */
export const PULL_LINE_FIRST = 48;
/** How near a level counts as at it, in depth (a three-hundredth of a px of the pull at most). */
export const PULL_AT_LEVEL = 1e-4;

/**
 * The pull's share of the way from the peek (depth 1) to the whole cook (depth 2): 0 and 1 at the
 * levels and within a hair of them, since a glide can land one float step off its level and rest there.
 */
export function pullShare(d: number): number {
  const t = clamp(d - 1, 0, 1);
  return t <= PULL_AT_LEVEL ? 0 : t >= 1 - PULL_AT_LEVEL ? 1 : t;
}

/**
 * Between the two levels both sets are on the page, the peek's rows and the whole cook: the one that
 * is drawn is the one a cook can reach (by touch, by a screen reader), the other is inert. `peek` and
 * `whole`: how much of each is drawn, 0 to 1 (the whole cook's by its header, where its controls are).
 * At a level neither is inert: the level's own rules hold.
 */
export function pullInert(between: boolean, peek: number, whole: number): { peek: boolean; whole: boolean } {
  if (!between) return { peek: false, whole: false };
  const live = whole > 0.02 && whole > peek;
  return { peek: live, whole: !live };
}

/** How much of the peek's rows a frame draws: its most drawn row's words. */
export function rowsDrawn(F: PullFrame): number {
  let op = 0;
  for (const f of F.rows) op = Math.max(op, f.kind === "step" ? f.label.op : f.kind === "ruled" ? f.words.op : f.op);
  return op;
}

export interface PullInput {
  peek: PeekDrawing;
  lines: LinesDrawing;
  c: number;
  /** The sheet's edge at the peek and at the whole cook, px on screen. */
  Y1: number;
  Y2: number;
  /** The lines' box: its corner, px from the sheet's left and from its edge at the whole cook, and its height. */
  box: { x: number; y: number; h: number };
}

/**
 * The lines' box at the whole cook, as `Timetable` sets it: the chart's corner, down to `bottom` (cpx
 * from the sheet's edge, `wholeLinesBottom`), never under 120 cpx tall.
 */
export function linesBoxOf(ov: OverviewPlace, bottom: number): PullInput["box"] | null {
  const chart = ov.whole?.chart;
  if (!chart) return null;
  return { x: chart.x * ov.c, y: chart.y * ov.c, h: Math.max(120, bottom - chart.y) * ov.c };
}

/** A part's shift (px), scale and opacity. */
export interface Mover {
  dx: number;
  dy: number;
  s: number;
  op: number;
}

/** The point of a part's own box that its place is said for (its words' left, on the first line's middle): it scales about it. */
export interface Origin {
  x: number;
  y: number;
}

type StepRow = {
  kind: "step";
  /** In the peek, px from the sheet's edge: the dot's centre and the label's left, on the first line's middle. */
  from: { dotX: number; labelX: number; y: number; size: number; r: number; origin: Origin };
  /**
   * Its stop, in the lines' own px: null where the whole cook draws none (the row holds, then fades).
   * `lead`: the stop comes with this row (the first of a folded run's rows). `gap`: how far under the
   * leading row this one stands in the peek. `same`: the stop says the row's own words.
   */
  to: { stop: number; lead: boolean; gap: number; same: boolean; dotX: number; dotY: number; x: number; y: number; size: number; r: number; origin: Origin } | null;
};
type RuledRow = {
  kind: "ruled";
  /** The main words' left, on the middle of the line they stand on. */
  from: { x: number; y: number; size: number; origin: Origin };
  to: { brk: number; x: number; y: number; size: number; origin: Origin } | null;
};
export type RowPlan = StepRow | RuledRow | { kind: "fade" };

export interface PullPlan {
  form: "columns" | "list";
  T: PullTimes;
  c: number;
  Y1: number;
  Y2: number;
  box: { x: number; y: number; h: number };
  /** The lines scroll in their box, which cuts what stands past it. */
  clips: boolean;
  /** The peek's rows' foot, px from the sheet's edge. */
  peekBottom: number;
  /** One per peek row, in its order. */
  rows: RowPlan[];
  /**
   * The whole cook's parts, each in its drawing's order (the list's stops and breaks are its step and
   * break rows). `twin`: a peek row travels to it. `y`: its top; `mid`: its first line's middle.
   */
  stops: { twin: boolean; y: number; mid: number }[];
  breaks: { twin: boolean; y: number }[];
  rails: { y0: number; y1: number }[];
  hot: { y0: number; y1: number }[];
  bends: number[];
  shares: number[];
  finish: number | null;
  /** The list's rows carry their dish and minutes along: how far each goes sideways. Null in the wide form (they go first). */
  meta: { dish: number; minutes: number } | null;
}

/** A stop's task ids: a step's key is its tasks' ids joined (`stepKey`); a prep card split across dishes keeps its card's. */
const tasksOf = (key: string) => key.split("#")[0].split("+");

interface StopRef {
  marks: string[];
  now: boolean;
  prep: boolean;
}

/**
 * The stop a peek row is by its own step: the same mark, else the folded run that holds it, else a
 * stop sharing one of its tasks (a prep page is part of a card). -1 where the whole cook draws none.
 */
function ownStop(key: string, stops: StopRef[]): number {
  let i = stops.findIndex((s) => s.marks[0] === key);
  if (i >= 0) return i;
  i = stops.findIndex((s) => s.marks.includes(key));
  if (i >= 0 || key === "prep") return i;
  const mine = new Set(tasksOf(key));
  return stops.findIndex((s) => s.marks.some((m) => tasksOf(m).some((t) => mine.has(t))));
}

/**
 * Each peek row's stop: its own step's, and for the Prep screen with none of its own the first prep
 * card, where no other row is that card. A row is never given the stop in hand for being the row in
 * hand: where the step changes under a held finger the peek is the old step's and the lines the new
 * one's, and the old step's row has nowhere to go (it holds, then fades).
 */
function stopsFor(rows: { key: string; now: boolean }[], stops: StopRef[]): number[] {
  const own = rows.map((r) => ownStop(r.key, stops));
  const taken = new Set(own.filter((i) => i >= 0));
  return rows.map((r, k) => {
    if (own[k] >= 0) return own[k];
    const j = r.key === "prep" ? stops.findIndex((s) => s.prep) : -1;
    if (j < 0 || taken.has(j)) return -1;
    taken.add(j);
    return j;
  });
}

export function planPull(input: PullInput): PullPlan {
  const { peek, lines, c } = input;
  const columns = lines.form === "columns";
  const lineH = columns ? lines.type.line : 0;

  // The whole cook's stops and breaks, each with where a row lands on it.
  type Anchor = { lines: string[] | null; dotX: number; dotY: number; x: number; y: number; size: number; r: number; top: number; origin: Origin };
  let stopRefs: StopRef[];
  let stopAt: Anchor[];
  let breakAt: { stretch: number | null; x: number; y: number; size: number; top: number; origin: Origin }[];
  if (lines.form === "columns") {
    const d: ColumnsDrawing = lines;
    stopRefs = d.stops.map((s) => ({ marks: [s.mark, ...s.foldedMarks], now: s.state === "now", prep: s.prep }));
    stopAt = d.stops.map((s) => ({
      lines: s.more ? null : s.lines,
      dotX: s.dotX,
      dotY: s.dotY,
      x: s.x,
      y: s.y + lineH / 2,
      size: d.type.size,
      r: s.dotR,
      top: Math.min(s.y, s.dotY - s.dotR),
      origin: { x: 0, y: lineH / 2 },
    }));
    breakAt = d.breaks.map((b) => ({ stretch: b.stretch, x: b.x + LINES_TYPE.pad * c, y: b.y + b.h / 2, size: d.type.size, top: b.y, origin: { x: 0, y: lineH / 2 } }));
  } else {
    const d: ListDrawing = lines;
    const steps = d.rows.filter((r) => r.kind === "step");
    stopRefs = steps.map((r) => ({ marks: [r.mark!], now: r.state === "now", prep: r.prep === true }));
    stopAt = steps.map((r) => ({
      lines: r.lines,
      dotX: d.cols.dot,
      dotY: r.dotY!,
      x: d.cols.label,
      y: r.dotY!,
      size: d.type.label,
      r: r.state === "now" ? d.dotR * 1.25 : d.dotR,
      top: r.y,
      // The list's row moves whole (its dish and minutes with it).
      origin: { x: d.cols.label, y: r.dotY! - r.y },
    }));
    breakAt = d.rows
      .filter((r) => r.kind === "break")
      .map((r) => {
        const half = (d.type.lh * d.type.ruled) / 2;
        const main = r.y + (r.h - r.lines.length * 2 * half) / 2 + half + (r.mainLine ?? 0) * 2 * half;
        return { stretch: r.stretch ?? null, x: d.cols.label + (r.mainX ?? 0), y: main, size: d.type.ruled, top: r.y, origin: { x: r.mainX ?? 0, y: half + (r.mainLine ?? 0) * 2 * half } };
      });
  }

  const stepRows = peek.rows.flatMap((r) => (r.kind === "step" ? [{ key: r.key, now: r.now }] : []));
  const theirs = stopsFor(stepRows, stopRefs);
  /** The row that leads each stop: its place in the peek. */
  const led = new Map<number, number>();
  let twinBreak = -1;
  let nth = 0;
  const rows: RowPlan[] = peek.rows.map((r): RowPlan => {
    if (r.kind === "step") {
      const from = { dotX: peek.cols.dot, labelX: peek.cols.label, y: r.dotY, size: peek.type.label, r: peek.dotR, origin: { x: 0, y: (peek.type.label * peek.type.lh) / 2 } };
      const i = theirs[nth++];
      if (i < 0) return { kind: "step", from, to: null };
      const lead = !led.has(i);
      if (lead) led.set(i, r.dotY);
      const a = stopAt[i];
      // The same lines of the same words cross over each other; the same words broken otherwise
      // (one line in the wide peek, two in a dish's column) would show doubled, so they go in turn.
      const same = lead && a.lines !== null && a.lines.length === r.lines.length && a.lines.every((l, n) => l === r.lines[n]);
      return { kind: "step", from, to: { stop: i, lead, gap: r.dotY - led.get(i)!, same, dotX: a.dotX, dotY: a.dotY, x: a.x, y: a.y, size: a.size, r: a.r, origin: a.origin } };
    }
    if (r.kind === "break" || r.kind === "table") {
      const half = (peek.type.ruled * peek.type.lh) / 2;
      const main = r.y + (r.h - r.lines.length * 2 * half) / 2 + half + r.mainLine * 2 * half;
      const from = { x: peek.cols.label + r.mainX, y: main, size: peek.type.ruled, origin: { x: r.mainX, y: half + r.mainLine * 2 * half } };
      const i = r.kind === "break" ? breakAt.findIndex((b) => b.stretch !== null && b.stretch === r.stretch) : -1;
      if (i < 0) return { kind: "ruled", from, to: null };
      twinBreak = i;
      const b = breakAt[i];
      return { kind: "ruled", from, to: { brk: i, x: b.x, y: b.y, size: b.size, origin: b.origin } };
    }
    return { kind: "fade" };
  });

  const base = {
    form: lines.form,
    T: columns ? PULL_COLUMNS : PULL_LIST,
    c,
    Y1: input.Y1,
    Y2: input.Y2,
    box: input.box,
    clips: lines.scroll,
    peekBottom: Math.max(0, ...peek.rows.map((r) => r.y + r.h)),
    rows,
    stops: stopAt.map((a, i) => ({ twin: led.has(i), y: a.top, mid: a.y })),
    breaks: breakAt.map((b, i) => ({ twin: i === twinBreak, y: b.top })),
  };
  if (lines.form === "list") {
    const dish = peek.cols.dish && lines.cols.dish ? input.box.x + lines.cols.dish.x - peek.cols.dish.x : 0;
    return {
      ...base,
      rails: lines.rail ? [{ y0: lines.rail.y0, y1: lines.rail.y1 }] : [],
      hot: [],
      bends: [],
      shares: [],
      finish: null,
      meta: { dish, minutes: input.box.x + lines.width - peek.cols.right },
    };
  }
  const d = lines;
  return {
    ...base,
    rails: d.rails.map((r) => ({ y0: r.y0, y1: r.y1 })),
    hot: d.hot.map((h) => ({ y0: h.y0, y1: h.y1 })),
    bends: d.bends.map((b) => b.y - b.r),
    shares: d.shares.map((s) => s.y),
    finish: d.finish ? d.finish.y : null,
    meta: null,
  };
}

/** A row of the peek at a point of the pull. `shed`: the ruled row's "then" and "while it roasts", 1 to 0. */
export type RowFrame =
  | { kind: "step"; dot: Mover; label: Mover; dish: Mover; minutes: Mover }
  | { kind: "ruled"; words: Mover; rule: Mover; shed: number }
  | { kind: "fade"; op: number };

/**
 * A stop of the whole cook: its words (the list: its whole row) and its dot. `twin`: at this frame a
 * peek row is travelling to it (not so where its box cuts it: it then stands where it is).
 */
export interface StopFrame extends Mover {
  twin: boolean;
  dot: Mover;
}

export interface PullFrame {
  t: number;
  /** The peek: its rows, and its rail. */
  rows: RowFrame[];
  rail: number;
  /** The whole cook, each in its drawing's order. */
  stops: StopFrame[];
  breaks: Mover[];
  /** How far up from its foot each line is drawn, 0 to 1, and the lines' ink (none at the peek). */
  rails: number[];
  hot: number[];
  ink: number;
  bends: number[];
  shares: number[];
  finish: number;
  heads: number;
  done: number;
}

const STILL: Mover = { dx: 0, dy: 0, s: 1, op: 1 };

/**
 * Every part's place at `t` of the way from the peek (0) to the whole cook (1), the lines scrolled
 * `scroll` px in their box. `pass` (0 to 1): how far the frame is a glide straight between rest and
 * the whole cook, which shows no peek: the whole cook's parts then stand in their places.
 */
export function pullAt(plan: PullPlan, t0: number, scroll = 0, pass = 0): PullFrame {
  const t = clamp(t0, 0, 1);
  const { T, c, box } = plan;
  const span = plan.Y1 - plan.Y2;
  const columns = plan.form === "columns";
  // The sheet's edge, and the lines' own corner, from the edge at the whole cook.
  const edge = span * (1 - t);
  const oy = box.y - scroll;
  const qx = sstep(T.x[0], T.x[1], t);
  const qy = sstep(T.y[0], T.y[1], t);
  const swap = sstep(T.swap[0], T.swap[1], t);
  // Words that differ never stand over each other: the row's go over the first half, the stop's come over the second.
  const half = (T.swap[0] + T.swap[1]) / 2;
  const wordsOut = sstep(T.swap[0], half, t);
  const wordsIn = sstep(half, T.swap[1], t);
  const shed = 1 - sstep(T.meta[0], T.meta[1], t);
  const ink = sstep(PULL_INK[0], PULL_INK[1], t);
  // The reveal's soft edge, and how near its stop a row is "coming in": both of the pull's own length too,
  // so a hundredth of the pull never brings a part in whole (a phone's cpx are small, its pull long).
  const feather = Math.max(40 * c, 0.16 * span);
  const near = Math.max(140 * c, 0.3 * span);

  const stops: StopFrame[] = plan.stops.map(() => ({ ...STILL, twin: false, dot: { ...STILL } }));
  const breaks: Mover[] = plan.breaks.map(() => ({ ...STILL }));
  const twinBreak = plan.breaks.map(() => false);
  /** Whether a place is in the lines' box, where the box cuts (a meal that scrolls). */
  const seen = (y: number) => !plan.clips || (y >= box.y - 2 && y <= box.y + box.h - 12 * c);

  /** How far off its stop the furthest travelling row still is, px, and how many travel. */
  let far = 0;
  let travellers = 0;
  /** The sheet's edge as the rows stand to it: a row that has stopped is under where the edge had it. */
  let ridden = edge;
  /**
   * A travelling row's height on the way, from the edge at the whole cook: `fromY` its place under
   * the sheet's edge in the peek, `target` its stop. It rides the edge up until it reaches its stop
   * and stays: rows go one way, never pass their stops, never stand over the sheet's edge, and at
   * the peek stand exactly where the peek has them. Where its stop is nearer the edge than its own
   * place in the peek (the lines scrolled on, or a stop high in another column), it closes that on the
   * clock; so too a stop under where the peek has it (a long board).
   *
   * Until the rows stand in their own columns they are one over the other, so a row keeps its
   * peek's gap under the row before it (two steps at one height in two columns close up only as
   * they narrow; `mate`: the row before is of its own folded run, which it closes on and gives way to).
   *
   * A row whose stop the lines' box cuts (a meal that scrolls) has no place to go: it rides the
   * edge and leaves early, never nearer the row before it than the peek has it.
   */
  let before: { y: number; fromY: number; there: boolean } | null = null;
  const heightAt = (fromY: number, target: number, there: boolean, mate = false) => {
    const ride = edge + fromY;
    // A row with a place to go is not held by one that has none (that one rides over it and is gone early).
    const held = before && !mate && !(there && !before.there) ? before.y + (fromY - before.fromY) * (there ? 1 - qx : 1) : -Infinity;
    let y: number;
    if (there) {
      y = target < span + fromY ? Math.max(target, edge + lerp(fromY, Math.min(fromY, target), qy)) : lerp(ride, target, qy);
      y = Math.max(y, held);
      far = Math.max(far, Math.abs(y - target));
      travellers++;
    } else {
      y = Math.max(ride, held);
    }
    ridden = Math.max(ridden, y - fromY);
    before = { y, fromY, there };
    return y;
  };

  /**
   * How far a row with no stop of its own stands under where the edge has it: it rides the edge, but
   * never nearer the row before it than the peek has it (a row ahead can stop low in the lines' box
   * while the edge still rises). It holds no row after it (`heightAt` keeps `before`).
   */
  const unmoved = (fromY: number) => (before ? Math.max(0, before.y + (fromY - before.fromY) - (edge + fromY)) : 0);
  const orphans: Mover[] = [];
  /** Where each leading row stands, by its stop: a second row of its run gives way as it closes on it. */
  const leadY = new Map<number, number>();
  const rows = plan.rows.map((r): RowFrame => {
    if (r.kind === "fade") return { kind: "fade", op: shed };
    if (r.kind === "step") {
      const to = r.to;
      if (!to) {
        // No stop to go to: it holds its row until the lines have something to read (set below).
        const gone: Mover = { dx: 0, dy: unmoved(r.from.y), s: 1, op: 1 };
        orphans.push(gone);
        return { kind: "step", dot: gone, label: gone, dish: gone, minutes: gone };
      }
      const ride = edge + r.from.y;
      const target = oy + to.y;
      const there = seen(target);
      const y = heightAt(r.from.y, target, there, !to.lead);
      const lx = there ? box.x + to.x - r.from.labelX : 0;
      const ddx = there ? box.x + to.dotX - r.from.dotX : 0;
      // The dot's own way to its place beside the words (the wide form's stands a little off the first line).
      const off = there ? to.dotY - to.y : 0;
      if (to.lead) leadY.set(to.stop, y);
      // A second row of a folded run closes on the first and is gone as it reaches it.
      const fold = to.lead ? 1 : sstep(0.35, 1, (y - (leadY.get(to.stop) ?? y)) / Math.max(1, to.gap));
      const vis = (there ? 1 : shed) * fold;
      const label: Mover = { dx: qx * lx, dy: y - ride, s: lerp(1, to.size / r.from.size, qx), op: (1 - (to.same ? swap : wordsOut)) * vis };
      const dot: Mover = { dx: qx * ddx, dy: y - ride + qx * off, s: lerp(1, to.r / r.from.r, qx), op: (1 - swap) * vis };
      if (to.lead && there) {
        stops[to.stop] = {
          dx: -(1 - qx) * lx,
          dy: y - target,
          s: lerp(r.from.size / to.size, 1, qx),
          op: to.same ? swap : wordsIn,
          twin: true,
          dot: { dx: -(1 - qx) * ddx, dy: y - target - (1 - qx) * off, s: lerp(r.from.r / to.r, 1, qx), op: swap },
        };
      }
      // The list's row carries its dish and minutes along, each to its own column; the wide form's go first.
      const m = plan.meta;
      const dish: Mover = m ? { dx: qx * m.dish, dy: y - ride, s: 1, op: label.op } : { dx: 0, dy: y - ride, s: 1, op: shed * vis };
      const minutes: Mover = m ? { dx: qx * m.minutes, dy: y - ride, s: 1, op: label.op } : { dx: 0, dy: y - ride, s: 1, op: shed * vis };
      return { kind: "step", dot, label, dish, minutes };
    }
    const to = r.to;
    if (!to) {
      const gone: Mover = { dx: 0, dy: unmoved(r.from.y), s: 1, op: shed };
      return { kind: "ruled", words: gone, rule: gone, shed: 1 };
    }
    const out = sstep(T.brk[0], T.brk[1], t);
    const ride = edge + r.from.y;
    const target = oy + to.y;
    const there = seen(target);
    const y = heightAt(r.from.y, target, there);
    const lx = there ? box.x + to.x - r.from.x : 0;
    const op = (1 - out) * (there ? 1 : shed);
    if (there) {
      breaks[to.brk] = { dx: -(1 - qx) * lx, dy: y - target, s: lerp(r.from.size / to.size, 1, qx), op: out };
      twinBreak[to.brk] = true;
    }
    const words: Mover = { dx: qx * lx, dy: y - ride, s: lerp(1, to.size / r.from.size, qx), op };
    // The rule over the row goes with it, at its own width; "then" and "while it roasts" go before it travels.
    return { kind: "ruled", words, rule: { dx: 0, dy: words.dy, s: 1, op }, shed };
  });

  // The line under which the rest of the whole cook shows: the peek's rows' foot while they ride the
  // edge, rising to the sheet's edge as the rows come to their stops (in the wide form, as they stand
  // in their columns too; by the end, whatever their stops), as far under the edge as the lines' top
  // stands at the whole cook (the header's row rides there). With no row travelling it rises on the clock.
  const top = edge + scroll - feather - 2 * c;
  const foot = ridden + plan.peekBottom + 10 * c - oy;
  // The line stands as far under the top as the furthest row is off its stop (once that is `near`): it
  // rises as fast as that row closes, however tall the lines are.
  const come = travellers ? 1 - clamp(far / Math.max(near, foot - top), 0, 1) : sstep(T.x[0], T.swap[1], t);
  const landed = Math.max(Math.min(come, columns ? sstep(T.x[0], T.swap[1], t) : 1), sstep(0.8, 1, t));
  const reveal = lerp(Math.max(foot, top), top, landed);
  // A part waits for a stretch of its line to stand over it (the lines' top row, to the pull's end).
  const first = PULL_LINE_FIRST * c * (1 - sstep(0.8, 1, t));
  // A part scrolled over the box's top is cut there, so the box's top is the highest it is seen.
  const shown = (y: number) => clamp((Math.max(y, scroll) - first - reveal) / feather, 0, 1) * ink;
  plan.stops.forEach((p, i) => {
    if (stops[i].twin) return;
    stops[i].op = shown(p.y);
    stops[i].dot.op = stops[i].op;
  });
  plan.breaks.forEach((p, i) => {
    if (!twinBreak[i]) breaks[i].op = shown(p.y);
  });
  if (orphans.length) {
    // Only a stop in the lines' box counts: one past its foot is not there to read.
    const inBox = (i: number) => plan.stops[i].mid - scroll >= 0 && plan.stops[i].mid - scroll <= box.h - 12 * c;
    const lines = Math.max(0, ...stops.map((s, i) => (inBox(i) ? s.op : 0)));
    for (const m of orphans) m.op = 1 - clamp((lines - 0.15) / 0.85, 0, 1);
  }
  // A line is drawn up from its foot, to the reveal's line.
  const lineTop = reveal <= scroll ? -Infinity : reveal;
  const grown = (r: { y0: number; y1: number }) => clamp((r.y1 - Math.max(r.y0, lineTop)) / Math.max(1, r.y1 - r.y0), 0, 1);

  const F: PullFrame = {
    t,
    rows,
    // The list has its own rail beside the peek's: the peek's goes as the rows take the list's columns.
    rail: plan.meta ? Math.min(shed, 1 - qx) : shed,
    stops,
    breaks,
    rails: plan.rails.map(grown),
    hot: plan.hot.map(grown),
    ink,
    bends: plan.bends.map(shown),
    shares: plan.shares.map(shown),
    finish: plan.finish === null ? ink : shown(plan.finish),
    heads: shown(0),
    done: shown(0),
  };
  const pw = clamp(pass, 0, 1);
  if (pw === 0) return F;
  // A straight pass: the whole cook's parts toward their own places, whole.
  const whole = (v: number) => lerp(v, 1, pw);
  const home = (m: Mover) => {
    m.dx *= 1 - pw;
    m.dy *= 1 - pw;
    m.s = whole(m.s);
    m.op = whole(m.op);
  };
  for (const s of F.stops) {
    home(s);
    home(s.dot);
  }
  F.breaks.forEach(home);
  F.rails = F.rails.map(whole);
  F.hot = F.hot.map(whole);
  F.ink = whole(F.ink);
  F.bends = F.bends.map(whole);
  F.shares = F.shares.map(whole);
  F.finish = whole(F.finish);
  F.heads = whole(F.heads);
  F.done = whole(F.done);
  return F;
}
