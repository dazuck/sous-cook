/**
 * The whole meal as lines and stations, laid out (look-ahead slice 2): where
 * each part of `mealLines` stands, in px from the drawing's top left, at what
 * size, and whether it fits its room or scrolls. The approved prototype's
 * `linesTry` and `linesLayout`,
 * ported to the app's units and fonts.
 *
 * Two forms:
 * - **Columns** (landscape, more than one dish): a column per dish, as wide as
 *   its words need; heads on one baseline; stops down the screen in cook order,
 *   each later stop at least a row below the earlier one (a staircase, so the
 *   order reads across columns); breaks as ruled gaps across the board on the
 *   compressed scale; the lines bend into the steps they meet at.
 * - **List** (portrait, the tablet upright and a phone; and any one-dish meal):
 *   the drawing's phone list, as the peek's narrow rows: the dish in a left
 *   column, the dot on one rail, the label, the minutes; ruled break rows.
 *
 * Fit ladder for the columns (the prototype's, in order): roomy rows with a
 * full staircase, then half, then none; then tight rows; then runs fold into
 * one named stop, the biggest saving first (and unfold again where room comes
 * back) (level 0); then every run folds and short pots join their runs
 * (level 1); then, only where it makes the meal fit, the words at 20 cpx
 * (level 2, `SMALL_WORDS`); then the drawing scrolls in its column, at level 1
 * and 22 cpx.
 * Too many dishes across: the two with the fewest stops share a column, named
 * "Slaw and pickles", until the least widths fit.
 *
 * Pure: px in, px out; text measured through `Measure` (px in, px out).
 */

import { durationText } from "./time-line";
import { COOK_COPY } from "./cook-view";
import { cutToWidth, wrapLines, type Measure } from "./sheet-layout";
import { PEEK_TYPE, mainAt } from "./peek-layout";
import { breakRows, runsOf, type LineRun, type LineStop, type MealLines } from "./meal-lines";

/** Type and geometry of the columns form, in cpx (the drawing's px at 1280×800 ÷ 1.333). */
export const LINES_TYPE = {
  /** Labels, heads and break words: the floor, 29 px on the tablet as drawn. */
  size: 22,
  /** A row: roomy, then tight. */
  roomy: 25.5,
  tight: 22.5,
  /** A break's row on the compressed scale (the drawing's 40 px, 33 px tight). */
  breakRow: 30,
  breakRowTight: 24.75,
  /** From a line to its stops' words. */
  pad: 22.5,
  /** The line's centre from its column's left edge. */
  lineX: 9,
  dot: 12,
  nowDot: 18,
  doneDot: 7.5,
  ring: 2.6,
  /** A pale line (a dish waiting) and a heavy one (it cooks). */
  pale: 2.25,
  hot: 3,
  /** The radius a line bends with into the step it meets. */
  bend: 12,
  /** The least a column is; and the most. */
  minCol: 100,
  maxCol: 315,
} as const;

/**
 * The ladder's last level (2), after the folds: the words on the lines at 20 cpx (27 px on the
 * tablet), under the 22 cpx floor, the one exception to it (DS v1.63 §2 and §5). Asked 2026-11-23,
 * "Smaller words when needed": only for a meal the folds alone leave scrolling, and only where the
 * smaller words then fit; a meal that scrolls anyway keeps 22 cpx. False turns the level off.
 */
export const SMALL_WORDS = true;
/** The words at level 3, cpx; rows scale with them, the breaks' rows (the time scale) do not. */
export const SMALL_SIZE = 20;
const SMALL_TYPE = {
  ...LINES_TYPE,
  size: SMALL_SIZE,
  roomy: (LINES_TYPE.roomy * SMALL_SIZE) / LINES_TYPE.size,
  tight: (LINES_TYPE.tight * SMALL_SIZE) / LINES_TYPE.size,
};
type LinesType = typeof SMALL_TYPE;

/** The weights: a job for the hands, the step in hand, a pot, a head. */
export const LINES_WEIGHT = { hands: 500, now: 600, pot: 500, head: 600, words: 500 } as const;

/** A stop's touch target is at least this many CSS px tall (the brief: 48 px) where its neighbours leave room. */
export const STOP_TARGET_PX = 48;

type Box = { x: number; y: number; w: number; h: number };
/**
 * The stops' touches, laid so none takes another's: each kept inside the drawing (moved, not cut,
 * where it stood past the top or the foot), and where two would overlap they part halfway between
 * where one's words end and the next's begin, so a tap on a stop's words reads that stop. A touch
 * keeps 48 px where its neighbours leave room; between close rows it is the rows' own height.
 */
export function tileTargets(items: { box: Box; words: { top: number; bottom: number } }[], height: number): void {
  for (const { box } of items) {
    if (box.h > height) {
      box.y = 0;
      box.h = height;
    } else if (box.y < 0) box.y = 0;
    else if (box.y + box.h > height) box.y = height - box.h;
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const [A, B] = items[i].words.top <= items[j].words.top ? [items[i], items[j]] : [items[j], items[i]];
      const ox = Math.min(A.box.x + A.box.w, B.box.x + B.box.w) - Math.max(A.box.x, B.box.x);
      const oy = Math.min(A.box.y + A.box.h, B.box.y + B.box.h) - Math.max(A.box.y, B.box.y);
      if (ox <= 0.5 || oy <= 0.5) continue;
      // Halfway between the words, kept inside the overlap so the two touches meet with no gap.
      const mid = (A.words.bottom + B.words.top) / 2;
      const cut = Math.min(Math.min(A.box.y + A.box.h, B.words.top), Math.max(mid, B.box.y, A.words.bottom));
      const aBottom = Math.min(A.box.y + A.box.h, cut);
      A.box.h = Math.max(0, aBottom - A.box.y);
      const bBottom = B.box.y + B.box.h;
      B.box.y = Math.max(B.box.y, cut);
      B.box.h = Math.max(0, bBottom - B.box.y);
    }
  }
}

export interface LinesGeo {
  /** The drawing's room, px. */
  W: number;
  H: number;
  /** One counter px, in px. */
  c: number;
  /** Portrait: the list. */
  narrow: boolean;
}

export interface DrawnStop {
  key: string;
  mark: string;
  screen: number;
  col: number;
  state: LineStop["state"];
  pot: boolean;
  /** Up-front prep (a Prep first page, or As I go's before you start). */
  prep: boolean;
  /** The dot's centre, and its radius. */
  dotX: number;
  dotY: number;
  dotR: number;
  /** The words' box. */
  x: number;
  y: number;
  w: number;
  lines: string[];
  /** A folded run's count ("then 9 more"), under its name, wrapped to its column. */
  more: string[] | null;
  /** A running pot's minutes left, counted to this minute (the page says it from the clock). */
  until: number | null;
  /** The labels inside a folded run, for its read. */
  folded: string[];
  /** The marks inside a folded run (its own first): a peek row of any of them travels to this stop. */
  foldedMarks: string[];
  /** Where a tap lands: at least `STOP_TARGET_PX` tall. Null for work done. */
  target: { x: number; y: number; w: number; h: number } | null;
  /** The step where lines meet: its words under the bar. */
  term: boolean;
  /** What a screen reader hears. */
  said: string;
}

export interface ColumnsDrawing {
  form: "columns";
  /** The drawing's size; `scroll` when it is taller than its room. */
  width: number;
  height: number;
  scroll: boolean;
  /** The step in hand's top, to scroll it into view. */
  nowY: number | null;
  type: { size: number; line: number };
  heads: { col: number; x: number; y: number; w: number; lines: string[] }[];
  /** Each dish's line, pale; `hot` runs over it where something cooks. */
  rails: { col: number; x: number; y0: number; y1: number }[];
  hot: { key: string; x: number; y0: number; y1: number }[];
  /** A line bending into the step it meets: from its column's x down to `y`, then across to `toX`. */
  bends: { col: number; x: number; toX: number; y: number; r: number; hot: boolean }[];
  /** A step two dishes share: the bar between their dots, and the other dish's dot. */
  /** A step two dishes share: its bar, and a dot on each other line (Ember, at the step in hand's size, while it is in hand). */
  shares: { key: string; x0: number; x1: number; y: number; now: boolean; dots: { x: number; pot: boolean }[] }[];
  stops: DrawnStop[];
  /** Work done: one quiet dot at the head of each line. */
  done: { col: number; x: number; y: number }[];
  breaks: { stretch: number; y: number; h: number; x: number; w: number; words: string }[];
  /** "then the last 27 min: four things going", at the right of the last break. */
  finish: { x: number; y: number; w: number; text: string } | null;
  /** Columns merged to fit across (their dishes), for the tests. */
  merged: string[][];
  folded: number;
  /**
   * The fit ladder's level drawn, the lowest that fits (DS v1.63): 0 the prototype's own ladder (runs
   * fold only where they must, the biggest saving first), 1 every run folds and short pots join their
   * runs (a short pot left alone loses its words), 2 level 1 with the words at 20 cpx (`SMALL_WORDS`),
   * drawn only when it fits. Past that the drawing scrolls, at level 1 and 22 cpx.
   */
  level: FitLevel;
  /** Each level tried, in order, and the height it reached (px): the last is the one drawn. */
  tries: { level: FitLevel; height: number; fits: boolean }[];
}

export type FitLevel = 0 | 1 | 2;
/** A pot shorter than this joins its run, or alone loses its words, at level 1 (the prototype's coarsest level). */
export const SHORT_POT_MIN = 15;

export interface ListRow {
  kind: "done" | "step" | "break";
  y: number;
  h: number;
  lines: string[];
  said: string;
  /** A step's. */
  key?: string;
  mark?: string;
  screen?: number;
  state?: LineStop["state"];
  pot?: boolean;
  prep?: boolean;
  dish?: string[];
  minutes?: string | null;
  until?: number | null;
  dotY?: number;
  target?: { x: number; y: number; w: number; h: number } | null;
  /** A break's three parts ("then", "50 min free", "while it roasts"). */
  words?: { lead: string; main: string; tail: string | null };
  /** A break's stretch (`LineBreak.stretch`), and where its main words begin, px from the labels' edge. */
  stretch?: number;
  mainX?: number;
  /** The line of the wrapped row its main words start on. */
  mainLine?: number;
}

export interface ListDrawing {
  form: "list";
  width: number;
  height: number;
  scroll: boolean;
  nowY: number | null;
  type: { label: number; meta: number; ruled: number; lh: number };
  cols: { dish: { x: number; w: number } | null; dot: number; label: number; right: number; minutes: number };
  dotR: number;
  rail: { x: number; y0: number; y1: number } | null;
  rows: ListRow[];
}

export type LinesDrawing = ColumnsDrawing | ListDrawing;

const EPS = 1e-3;
const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** "then 9 more", one wording everywhere: the prototype's, as approved (it saves a line at any size). */
export const moreSteps = (n: number) => `then ${n} more`;
/** A running pot's words: "roasts, 12 min left". */
export const minutesLeft = (words: string, left: number) => `${words}, ${durationText(Math.max(1, left))} left`;
/** The finish's words: "then the last 27 min: four things going". */
export function finishWords(f: NonNullable<MealLines["finish"]>): string {
  return `${f.afterLong ? "then the last" : "the last"} ${durationText(f.minutes)}: ${NUM[f.going] ?? f.going} things going`;
}

const listWords = (a: string[]) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

/**
 * Two columns become one: the two with the fewest stops share, named by each dish's last word
 * ("Cabbage Slaw" and "Cucumber Pickles": "Slaw and pickles"), stacked in one column.
 */
export function mergeColumns(L: MealLines, a: number, b: number): MealLines {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const remap = (c: number) => (c === hi ? lo : c > hi ? c - 1 : c);
  const parts = (c: number) => (L.columns[c].name ?? L.columns[c].dish).split(" + ");
  const both = [...parts(lo), ...parts(hi)];
  const short = both.map((d) => d.split(/\s+/).pop()!.toLowerCase());
  const name = short[0].charAt(0).toUpperCase() + listWords(short).slice(1);
  const columns = L.columns.filter((_, i) => i !== hi).map((col, i) => (i === lo ? { dish: both.join(" + "), name } : col));
  const uniq = (xs: number[], own: number) => [...new Set(xs.map(remap))].filter((c) => c !== own).sort((x, y) => x - y);
  const stops = L.stops.map((q) => {
    const col = remap(q.col);
    return { ...q, col, also: uniq(q.also, col), joins: uniq(q.joins, col) };
  });
  return { ...L, columns, stops, runs: L.runs.map((r) => ({ ...r, col: remap(r.col) })), oneDish: columns.length <= 1 };
}

/** The drawing, in the form its shape and dishes call for. */
export function layoutMealLines(L0: MealLines, g: LinesGeo, measure: Measure, opts: LadderOpts = {}): LinesDrawing {
  if (g.narrow || L0.oneDish) return layoutList(L0, g, measure);
  return layoutColumns(L0, g, measure, opts);
}

/** `level` draws that one level of the fit ladder whether it fits or not (to compare the levels; 2 even with `SMALL_WORDS` off). */
export interface LadderOpts {
  level?: FitLevel;
}

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

interface Q {
  s: LineStop;
  i: number;
  rank: number;
  t: number;
  skip: boolean;
  fold: Q | null;
  own: string[];
  L: string[];
  more: string[] | null;
  members: Q[] | null;
  y: number;
  h: number;
  cy: number;
  jy: number;
  term: boolean;
  labCol: number;
  until: number | null;
  foldEnd: number;
  /** Level 2: a short pot alone, drawn as its dot with no words. */
  mute: boolean;
  /** A folded run that starts with a short pot but is named by a job for the hands: drawn as hands. */
  asWork: boolean;
}

export function layoutColumns(L0: MealLines, g: LinesGeo, measure: Measure, opts: LadderOpts = {}): ColumnsDrawing {
  const small = () => {
    const d = ladder(L0, g, measure, [1], SMALL_TYPE);
    return { ...d, level: 2 as const, tries: d.tries.map((t) => ({ ...t, level: 2 as const })) };
  };
  if (opts.level === 2) return small();
  const d = ladder(L0, g, measure, opts.level !== undefined ? [opts.level] : [0, 1], LINES_TYPE);
  if (opts.level !== undefined || !d.scroll || !SMALL_WORDS) return d;
  // The folds alone leave it scrolling: the smaller words, if they make it fit. A meal that scrolls
  // anyway keeps the floor's 22 cpx (smaller words that still scroll cost the size and buy no glance).
  const s = small();
  return s.scroll ? { ...d, tries: [...d.tries, ...s.tries] } : { ...s, tries: [...d.tries, ...s.tries] };
}

function ladder(L0: MealLines, g: LinesGeo, measure: Measure, levels: readonly (0 | 1)[], T: LinesType): ColumnsDrawing {
  const c = g.c;
  const fs = T.size * c;
  const textW = (t: string, wt: number) => measure(t, fs, wt);
  const longestWord = (t: string, wt: number) => Math.max(0, ...t.split(/\s+/).map((w) => textW(w, wt)));

  // Too many dishes across: merge the two with the fewest stops until the least widths fit.
  let L = L0;
  const merged: string[][] = [];
  // A stop's words stand in its label's column: a shared step's is the right-most of its lines.
  const labColOf = (q: LineStop) => Math.max(q.col, ...q.also);
  const leastOf = (M: MealLines) =>
    M.columns.map((col, k) => {
      const mine = M.stops.filter((q) => labColOf(q) === k && q.state !== "done");
      return Math.max(
        T.minCol * c,
        longestWord(col.name ?? "", LINES_WEIGHT.head) + 12 * c,
        ...mine.map((q) => longestWord(q.words, q.pot ? LINES_WEIGHT.pot : LINES_WEIGHT.hands) + T.pad * c + 8 * c),
        k === 0 ? T.pad * c + Math.max(0, ...M.breaks.map((b) => textW(COOK_COPY.peekFree(b.minutes), LINES_WEIGHT.words))) + 18 * c : 0,
      );
    });
  // FIXME(review bug 2, 2026-11-23): two columns whose least widths pass the room are drawn past it
  // (the second column's words under the box's clip). No stored plan on a supported screen reaches it:
  // columns are drawn only on the tablet wide, in 867 px or more; the stored plans first stand past
  // their room at 360 px. A landscape window that narrow (a split screen) would; the list should draw it.
  while (L.columns.length > 2 && leastOf(L).reduce((a, b) => a + b, 0) > g.W) {
    const counts = L.columns.map((_, k) => L.stops.filter((q) => q.col === k).length);
    const [a, b] = counts
      .map((n, k) => [n, k] as const)
      .sort((x, y) => x[0] - y[0] || y[1] - x[1])
      .slice(0, 2)
      .map((x) => x[1]);
    merged.push([L.columns[a].dish, L.columns[b].dish]);
    L = mergeColumns(L, a, b);
  }
  const n = L.columns.length;

  const isPot = (q: Q) => q.s.pot && !q.asWork;
  const fontOf = (q: Q) => (q.s.state === "now" ? LINES_WEIGHT.now : isPot(q) && !q.term ? LINES_WEIGHT.pot : LINES_WEIGHT.hands);
  const lastIndex = L.stops.length - 1;

  const st: Q[] = L.stops.map((s, i) => {
    const rank = s.state === "done" ? 0 : s.state === "running" ? 1 : 2;
    return {
      s, i, rank, t: rank < 2 ? L.now - 1 : s.start, skip: false, fold: null, own: [], L: [], more: null, members: null,
      y: 0, h: 0, cy: 0, jy: 0, term: s.joins.length > 0 && i === lastIndex, labCol: Math.max(s.col, ...s.also),
      until: s.state === "running" ? s.end : null, foldEnd: s.end, mute: false, asWork: false,
    };
  });
  // Done work: one quiet dot per line, the last done one standing for the rest.
  for (let k = 0; k < n; k++) {
    const done = st.filter((q) => q.s.col === k && q.rank === 0);
    done.forEach((q, j) => {
      if (j < done.length - 1) q.skip = true;
    });
  }

  // Columns: even first, as drawn (each at most the widest a column is); when that is too tall,
  // each as wide as its words want, the spare filling the narrowest first (the prototype's ladder).
  const words = (q: Q) => (q.until !== null ? minutesLeft(q.s.words, q.until - L.now) : q.s.pot && q.s.minutes !== null && !q.term ? `${q.s.words} ${durationText(q.s.minutes)}` : q.s.words);
  const least = leastOf(L);
  const want = L.columns.map((col, k) => {
    const mine = st.filter((q) => q.labCol === k && q.rank > 0 && !q.term);
    return Math.min(
      T.maxCol * c,
      Math.max(least[k], textW(col.name ?? "", LINES_WEIGHT.head) + 16 * c, ...mine.map((q) => textW(words(q), fontOf(q)) + T.pad * c + 10 * c)),
    );
  });
  const widthsOf = (content: boolean): number[] => {
    if (!content) return L.columns.map(() => Math.floor(Math.min(g.W / n, T.maxCol * c)));
    const w = least.slice();
    let spare = g.W - w.reduce((x, y) => x + y, 0);
    for (let guard = 0; guard < 4 * n && spare > 0.5; guard++) {
      const open = [...w.keys()].filter((k) => want[k] - w[k] > 0.5);
      if (!open.length) break;
      const low = Math.min(...open.map((k) => w[k]));
      const atLow = open.filter((k) => w[k] <= low + 0.5);
      const nextUp = Math.min(...open.filter((k) => w[k] > low + 0.5).map((k) => w[k]), ...atLow.map((k) => want[k]));
      const each = Math.min(nextUp - low, spare / atLow.length);
      for (const k of atLow) w[k] += each;
      spare -= each * atLow.length;
    }
    const even = Math.max(0, Math.min(spare / n, 24 * c));
    return w.map((v) => Math.floor(v + even));
  };
  let colW: number[] = [];
  let colX: number[] = [0];
  let usedW = 0;
  const lx = (k: number) => colX[k] + T.lineX * c;
  const labW = (k: number) => colW[k] - (T.pad + 3) * c;

  // A stop's words in at most `max` lines, or null.
  const tryLines = (q: Q, text: string, max: number, w: number): string[] | null => {
    const lines = wrapLines(text, fs, fontOf(q), w, measure);
    if (lines.length > max || lines.some((ln) => textW(ln, fontOf(q)) > w + 0.5)) return null;
    return lines;
  };
  const wordsFor = (q: Q, max: number): string[] | null => {
    const w = q.term ? usedW - colX[q.s.col] : labW(q.labCol);
    if (q.until !== null) return tryLines(q, minutesLeft(q.s.words, q.until - L.now), max, w);
    if (q.s.pot && !q.term && q.s.minutes !== null) {
      const mm = durationText(q.s.minutes);
      const base = wrapLines(q.s.words, fs, fontOf(q), w, measure);
      const lastLn = base[base.length - 1];
      if (textW(`${lastLn} ${mm}`, fontOf(q)) <= w) return base.length <= max ? [...base.slice(0, -1), `${lastLn} ${mm}`] : null;
      return base.length + 1 <= max ? [...base, mm] : null;
    }
    return tryLines(q, q.s.words, max, w);
  };
  const forced = (q: Q) => {
    const w = q.term ? usedW - colX[q.s.col] : labW(q.labCol);
    const lines = wrapLines(words(q), fs, fontOf(q), w, measure);
    if (lines.length <= 4) return lines;
    // Past four lines the words are cut, never the time: a pot's minutes (a running one's minutes left) keep the last line.
    const time = q.until !== null ? `${durationText(Math.max(1, q.until - L.now))} left` : q.s.pot && q.s.minutes !== null && !q.term ? durationText(q.s.minutes) : null;
    const base = time ? wrapLines(q.s.words, fs, fontOf(q), w, measure) : lines;
    const keep = time ? 3 : 4;
    const cut = base.length <= keep ? base : [...base.slice(0, keep - 1), cutToWidth(base.slice(keep - 1).join(" "), fs, fontOf(q), w, measure)];
    return time ? [...cut, time] : cut;
  };
  // The runs that may fold, with what folding saves (at the widths in hand).
  const byKey = new Map(st.map((q) => [q.s.key, q]));
  type Run = { members: Q[]; lab: string[]; more: string[]; on: boolean; save: number; asWork: boolean };
  let RUNS: Run[] = [];
  // The fit ladder's level in hand: its runs, whether they all fold, and the short pots that go quiet.
  let level: FitLevel = 0;
  let runSrc: LineRun[] = [];
  const configure = (lvl: 0 | 1) => {
    level = lvl;
    // Runs on the columns as drawn: two dishes merged into one column are one line, so a job of the
    // other dish between two of this one's breaks their run (`L.runs` were found before the merge).
    const all = runsOf(L.stops, n, L.breaks, lvl === 1 ? SHORT_POT_MIN : 0);
    runSrc = all.filter((r) => r.keys.length > 1);
    for (const q of st) q.mute = false;
    if (lvl === 1) {
      for (const r of all) {
        const q = r.keys.length === 1 ? byKey.get(r.keys[0]) : undefined;
        if (q && q.s.pot) q.mute = true;
      }
    }
  };
  /** Sets the columns' widths and every stop's words at them. */
  const setWidths = (content: boolean) => {
    colW = widthsOf(content);
    colX = [0];
    for (let k = 0; k < n; k++) colX.push(colX[k] + colW[k]);
    usedW = Math.min(g.W, colX[n]);
    for (const q of st) q.asWork = false;
    for (const q of st) if (q.rank > 0 && !q.skip) q.own = q.mute ? [] : (wordsFor(q, 2) ?? wordsFor(q, 3) ?? forced(q));
    RUNS = runSrc.map((r) => {
      const members = r.keys.map((k) => byKey.get(k)!).filter(Boolean);
      // A run is named by its first job for the hands (a short pot that starts it is part of its count).
      const named = members.find((m) => !m.s.pot) ?? members[0];
      const lab = wordsFor(named, 1) ?? named.own;
      const more = wrapLines(moreSteps(members.length - 1), fs, LINES_WEIGHT.words, labW(members[0].labCol), measure);
      const save = members.reduce((t, m) => t + m.own.length, 0) - lab.length - more.length;
      return { members, lab, more, on: level >= 1, save, asWork: !named.s.pot && members[0].s.pot };
    });
  };

  const apply = () => {
    for (const q of st) {
      if (q.rank > 0 && !q.skip) {
        q.L = q.own;
        q.more = null;
        q.fold = null;
        q.members = null;
        q.foldEnd = q.s.end;
        q.asWork = false;
      }
    }
    for (const r of RUNS) {
      if (!r.on) continue;
      const [head, ...rest] = r.members;
      for (const m of rest) m.fold = head;
      head.L = r.lab;
      head.more = r.more;
      head.members = r.members;
      head.asWork = r.asWork;
      head.foldEnd = Math.max(...r.members.map((m) => m.s.end));
    }
  };

  const top = 0;
  const limit = g.H;
  let LINE = T.roomy * c;
  let ROW = T.breakRow * c;
  const R = T.bend * c;
  let nameY: number[] = [];
  let nameH: number[] = [];
  let maxNh = 0;
  let headLines: string[][] = [];
  let knots: [number, number][] = [];
  let total = 0;
  let drawn: Q[] = [];
  const frees = L.breaks.map((b) => ({ ...b, y: 0, h: 0 }));

  const place = (ord: number): boolean => {
    apply();
    headLines = L.columns.map((col, k) => (col.name ? wrapLines(col.name, fs, LINES_WEIGHT.head, colW[k] - 12 * c, measure).slice(0, 2) : []));
    nameH = headLines.map((a) => (a.length ? a.length * LINE + 4 * c : 0));
    maxNh = Math.max(0, ...nameH);
    nameY = nameH.map((h) => top + maxNh - h);
    drawn = st.filter((q) => !q.skip && !q.fold);
    type Ev = { q?: Q; f?: (typeof frees)[number]; t: number; k: number; i: number };
    const evs: Ev[] = [
      ...drawn.map((q) => ({ q, t: q.t, k: q.rank, i: q.i })),
      ...frees.map((f) => ({ f, t: f.from, k: 3, i: 0 })),
    ].sort((a, b) => a.t - b.t || a.k - b.k || a.i - b.i);
    const yL: (number | null)[] = Array(n).fill(null);
    let floor = top + maxNh;
    knots = [];
    for (const ev of evs) {
      if (ev.f) {
        const f = ev.f;
        const y0 = Math.max(floor, ...yL.filter((v): v is number => v !== null)) + 3 * c;
        f.y = y0;
        f.h = Math.round(f.rows * ROW);
        const bot = y0 + f.h + 3 * c;
        for (let k = 0; k < n; k++) if (yL[k] !== null) yL[k] = bot;
        floor = bot;
        knots.push([f.from, y0], [f.to, bot]);
        continue;
      }
      const q = ev.q!;
      const col = q.s.col;
      // A shared step's bar crosses every column between its lines: it stands below all of them.
      const span = q.s.also.length ? [Math.min(col, ...q.s.also), Math.max(col, ...q.s.also)] : [col, col];
      let y = Math.max(floor, yL[col] ?? 0);
      for (let a = span[0]; a <= span[1]; a++) y = Math.max(y, yL[a] ?? 0);
      if (q.s.joins.length) y = Math.max(y, ...q.s.joins.map((j) => (yL[j] ?? 0) + R + 4 * c)) + (q.term ? 0 : 8 * c);
      const rows = q.rank === 0 ? 0 : q.L.length + (q.more?.length ?? 0);
      q.y = y;
      if (q.term) q.h = 24 * c + rows * LINE;
      else if (q.rank === 0) q.h = 14 * c;
      else if (q.mute) q.h = 16 * c;
      // A job for the hands stands as tall as its minutes on the compressed scale, as drawn.
      else q.h = Math.max(rows * LINE, isPot(q) || q.more ? 0 : Math.round(breakRows(q.s.span) * LINE));
      q.cy = q.y + (q.term ? 10 * c : q.rank === 0 ? 7 * c : q.mute ? 8 * c : LINE / 2);
      q.jy = q.term ? q.cy : q.y - 5 * c;
      yL[col] = q.y + q.h;
      for (let a = span[0]; a <= span[1]; a++) yL[a] = q.y + q.h;
      if (q.rank === 2) floor = q.y + ord * LINE;
      knots.push([q.rank === 2 ? q.s.start : L.now, q.cy]);
    }
    total = Math.max(top, ...yL.filter((v): v is number => v !== null));
    return total <= limit;
  };

  let fits = false;
  const tryOrds = () => {
    for (const ord of [1, 0.5, 0]) if ((fits = place(ord))) return true;
    return false;
  };
  // The ladder: even columns roomy, then tight; columns to their words roomy, then tight; then runs fold.
  const rung = (content: boolean, tight: boolean) => {
    setWidths(content);
    LINE = (tight ? T.tight : T.roomy) * c;
    ROW = (tight ? T.breakRowTight : T.breakRow) * c;
    return tryOrds();
  };
  /** Tight rows at these widths, then runs folded and labels to one line until it fits; the height it got to. */
  const squeeze = (content: boolean): number => {
    if (rung(content, true)) return total;
    // Too tall: a run whose jobs cannot each keep a label becomes one stop, the biggest saving first.
    const order = level === 0 ? RUNS.filter((r) => r.save > 0).sort((a, b) => b.save - a.save) : [];
    for (const r of order) {
      r.on = true;
      if ((fits = place(0))) break;
    }
    if (fits && order.length) {
      // And back where there is room after all, the smallest saving first.
      for (const r of order.slice().reverse()) {
        if (!r.on) continue;
        r.on = false;
        if (!place(0)) r.on = true;
      }
    }
    fits = place(0);
    return total;
  };
  /** One level of the ladder: even columns, then to their words; roomy rows, then tight. Its height. */
  // Even columns only where every column's longest word (a stop's, or its name's) fits its share:
  // else that word would stand past its column, so the columns go to their words straight away.
  const evenW = Math.floor(Math.min(g.W / n, T.maxCol * c));
  const evenOk = L.columns.every((col, k) => {
    const mine = st.filter((q) => q.labCol === k && q.rank > 0 && !q.term);
    const word = Math.max(
      longestWord(col.name ?? "", LINES_WEIGHT.head) + 12 * c,
      ...mine.map((q) => longestWord(words(q), fontOf(q)) + (T.pad + 3) * c),
    );
    return word <= evenW + 0.5;
  });
  const atLevel = (lvl: 0 | 1): number => {
    configure(lvl);
    if (!evenOk) {
      if (!rung(true, false)) squeeze(true);
      return total;
    }
    if (n > 1 ? rung(false, false) || rung(true, false) : rung(false, false)) return total;
    // Even columns first; to their words when that is shorter (the prototype keeps the best try, not the last).
    const even = squeeze(false);
    if (fits || n === 1) return total;
    const toWords = squeeze(true);
    if (!fits && even < toWords) squeeze(false);
    return total;
  };
  // The lowest level that fits the room, so a meal that fits keeps its detail. The breaks' words and
  // the finish line are never folded at any level. Past level 1 it scrolls at level 1.
  const tries: ColumnsDrawing["tries"] = [];
  for (const lvl of levels) {
    const h = atLevel(lvl);
    tries.push({ level: lvl, height: Math.round(h), fits });
    if (fits) break;
  }

  knots.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const Y = (t: number) => {
    const k = knots.find((x) => x[0] >= t - 0.01);
    return k ? k[1] : total;
  };

  // The lines.
  const rails: ColumnsDrawing["rails"] = [];
  const hot: ColumnsDrawing["hot"] = [];
  const bends: ColumnsDrawing["bends"] = [];
  const shares: ColumnsDrawing["shares"] = [];
  for (let k = 0; k < n; k++) {
    const mine = drawn.filter((q) => q.s.col === k || q.s.also.includes(k));
    if (!mine.length) continue;
    const term = drawn.find((q) => q.s.joins.includes(k));
    const lastQ = mine[mine.length - 1];
    const yA = mine[0].y > top + maxNh + 1 ? top + maxNh + 4 * c : mine[0].cy;
    let yB = term ? term.jy - R : lastQ.cy;
    if (!term && lastQ.rank > 0 && (lastQ.s.pot || lastQ.more)) yB = Math.max(yB, Math.min(total, Y(lastQ.more ? lastQ.foldEnd : lastQ.s.end)));
    const cx = lx(k);
    if (yB > yA) rails.push({ col: k, x: cx, y0: yA, y1: yB });
    let hotEnd = false;
    for (const q of mine) {
      if (!isPot(q) || q.rank === 0 || q.term) continue;
      const a = q.cy;
      const b = Math.min(yB, Math.max(a, Y(q.s.end)));
      if (b - a > 2 * c) {
        hot.push({ key: `${q.s.key}:${k}`, x: cx, y0: a, y1: b });
        if (b >= yB - 1) hotEnd = true;
      }
    }
    if (term) bends.push({ col: k, x: cx, toX: lx(term.s.col), y: term.jy, r: R, hot: hotEnd });
  }
  for (const q of drawn) {
    if (!q.s.also.length || q.rank === 0) continue;
    const xs = [q.s.col, ...q.s.also].map(lx);
    shares.push({
      key: q.s.key, x0: Math.min(...xs), x1: Math.max(...xs), y: q.cy, now: q.s.state === "now",
      dots: q.s.also.map((a) => ({ x: lx(a), pot: q.s.pot })),
    });
  }

  // The stops.
  const stops: DrawnStop[] = [];
  /** Each stop's words, top to bottom: its touch never takes another's. */
  const boxes: { top: number; bottom: number }[] = [];
  const done: ColumnsDrawing["done"] = [];
  for (const q of drawn) {
    if (q.rank === 0) {
      done.push({ col: q.s.col, x: lx(q.s.col), y: q.cy });
      continue;
    }
    const x = q.term ? colX[q.s.col] : colX[q.labCol] + T.pad * c;
    const w = q.term ? usedW - colX[q.s.col] : labW(q.labCol);
    const dotR = ((q.s.state === "now" ? T.nowDot : T.dot) * c) / 2;
    const h = q.term ? q.h : Math.max(q.h, (q.L.length + (q.more?.length ?? 0)) * LINE);
    const th = Math.max(STOP_TARGET_PX, h);
    const left = Math.min(q.s.col, ...q.s.also);
    const folded = q.members ? q.members.map((m) => m.s.label) : [];
    // What the touch must cover: the stop's words, and the finish's join dot above its words.
    boxes.push({ top: q.y, bottom: q.term ? q.y + q.h : q.y + h });
    stops.push({
      key: q.s.key,
      mark: q.s.mark,
      screen: q.s.screen,
      col: q.s.col,
      state: q.s.state,
      pot: isPot(q) && !q.term,
      prep: q.s.prep,
      dotX: lx(q.s.col),
      dotY: q.cy,
      dotR,
      x,
      y: q.term ? q.y + 24 * c : q.y,
      w,
      lines: q.L,
      more: q.more,
      until: q.until,
      folded,
      foldedMarks: q.members ? q.members.map((m) => m.s.mark) : [],
      target: { x: colX[left], y: q.y + h / 2 - th / 2, w: (q.term ? usedW : colX[q.labCol + 1]) - colX[left], h: th },
      term: q.term,
      said: [folded.length ? `${listWords(folded)}` : q.s.label, !folded.length && q.s.pot && q.s.minutes ? durationText(q.s.minutes) : null]
        .filter(Boolean)
        .join(", "),
    });
  }
  const height = fits ? Math.min(g.H, total) : total + 34 * c;
  tileTargets(stops.map((s, i) => ({ box: s.target!, words: boxes[i] })), height);

  const breaks = frees.map((f) => ({ stretch: f.stretch, y: f.y, h: f.h, x: 0, w: usedW, words: COOK_COPY.peekFree(f.minutes) }));
  let finish: ColumnsDrawing["finish"] = null;
  if (L.finish && L.finish.going >= 2 && breaks.length) {
    const lb = breaks[breaks.length - 1];
    const text = finishWords(L.finish);
    const w = textW(text, LINES_WEIGHT.words) + 20 * c;
    if (lb.h >= LINE && T.pad * c + textW(lb.words, LINES_WEIGHT.words) + 40 * c + w <= usedW) finish = { x: usedW - w, y: lb.y + (lb.h - LINE) / 2, w, text };
  }
  const now = stops.find((s) => s.state === "now");
  return {
    form: "columns",
    width: usedW,
    height,
    scroll: !fits,
    nowY: now ? now.y : null,
    type: { size: fs, line: LINE },
    heads: L.columns.map((_, k) => ({ col: k, x: colX[k], y: nameY[k], w: colW[k] - 8 * c, lines: headLines[k] })),
    rails,
    hot,
    bends,
    shares,
    stops,
    done,
    breaks,
    finish,
    merged,
    folded: RUNS.filter((r) => r.on).length,
    level,
    tries,
  };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function layoutList(L: MealLines, g: LinesGeo, measure: Measure): ListDrawing {
  const T = g.narrow ? PEEK_TYPE.narrow : PEEK_TYPE.wide;
  const c = g.c;
  const px = { label: T.label * c, meta: T.meta * c, ruled: T.ruled * c };
  const lh = T.lh;
  const right = g.W;
  const showDish = !L.oneDish;
  const dishNames = (q: LineStop) => [q.col, ...q.also].map((k) => L.columns[k].name).filter((d): d is string => d !== null);
  const live = L.stops.filter((q) => q.state !== "done");
  const doneQ = L.stops.filter((q) => q.state === "done");

  let dishCol: ListDrawing["cols"]["dish"] = null;
  let dot: number;
  if (showDish) {
    const all = live.flatMap(dishNames);
    const w = Math.min(150 * c, Math.max(0, ...all.map((d) => measure(d, px.meta, 500))));
    dishCol = { x: 0, w };
    dot = w + 14 * c + 9 * c;
  } else dot = 14 * c;
  const labelX = dot + 25 * c;
  const minsOf = (q: LineStop) => (q.state === "running" ? null : q.pot && q.minutes === null ? null : durationText(q.span));
  const minW = Math.max(0, ...live.map((q) => (minsOf(q) ? measure(minsOf(q)!, px.meta, 500) : 0)));
  const labelRight = right - (minW ? minW + 24 * c : 0);

  const rows: ListRow[] = [];
  let y = 0;
  const pad = (g.narrow ? 18 : 10) * c;

  if (doneQ.length) {
    // "Done: prep potatoes, prep aromatics and 8 more": as many names as fit on one line.
    const names = doneQ.map((q) => q.label.charAt(0).toLowerCase() + q.label.slice(1));
    let text = `Done: ${listWords(names)}`;
    for (let k = names.length; k >= 1 && measure(text, px.meta, 500) > right; k--) {
      text = k === names.length ? `Done: ${listWords(names)}` : `Done: ${names.slice(0, k).join(", ")} and ${names.length - k} more`;
    }
    if (measure(text, px.meta, 500) > right) text = `Done: ${names.length} ${names.length === 1 ? "step" : "steps"}`;
    const h = lh * px.meta + 2 * pad;
    rows.push({ kind: "done", y, h, lines: [text], said: text });
    y += h;
  }

  const brks = L.breaks.slice();
  const ruled = (b: MealLines["breaks"][number]) => {
    const going = L.stops.filter((q) => q.pot && q.start <= b.from + EPS && q.end > b.from + EPS).pop();
    const verb = going ? going.words.split(" ").pop()! : null;
    // The pot's verb as said after "while it": "roasts".
    const words = { lead: COOK_COPY.peekThen, main: COOK_COPY.peekFree(b.minutes), tail: verb ? COOK_COPY.peekWhile(verb) : null };
    const one = (t: string | null) => [words.lead, words.main, t].filter(Boolean).join(" ");
    // "while it roasts" wraps to a second line rather than go unsaid; past two lines it is left off.
    const tail = words.tail && wrapLines(one(words.tail), px.ruled, 500, right - labelX, measure, "text", / +/).length > 2 ? null : words.tail;
    const lines = wrapLines(one(tail), px.ruled, 500, right - labelX, measure, "text", / +/);
    y += 8 * c;
    const h = lines.length * lh * px.ruled + 2 * (g.narrow ? 14 : 8) * c;
    const main = mainAt(lines, words.lead, px.ruled, 500, measure);
    rows.push({ kind: "break", y, h, lines, said: one(tail), words: { ...words, tail }, stretch: b.stretch, mainX: main.x, mainLine: main.line });
    y += h;
  };

  for (const q of live) {
    while (brks.length && q.state === "ahead" && brks[0].from <= q.start + EPS && brks[0].from < q.start) ruled(brks.shift()!);
    const weight = 600;
    const text = q.state === "running" ? minutesLeft(q.label, q.end - L.now) : q.label;
    const lines = wrapLines(text, px.label, weight, labelRight - labelX, measure);
    const kept = lines.length <= 3 ? lines : [...lines.slice(0, 2), cutToWidth(lines.slice(2).join(" "), px.label, weight, labelRight - labelX, measure)];
    const dish = showDish ? dishNames(q) : [];
    const rowLines = Math.max(kept.length, dish.length);
    const h = rowLines * lh * px.label + 2 * pad;
    const th = Math.max(STOP_TARGET_PX, h);
    rows.push({
      kind: "step", y, h, lines: kept, key: q.key, mark: q.mark, screen: q.screen, state: q.state, pot: q.pot, prep: q.prep, dish,
      minutes: minsOf(q), until: q.state === "running" ? q.end : null, dotY: y + pad + (lh * px.label) / 2,
      target: { x: 0, y: y + h / 2 - th / 2, w: right, h: th },
      said: [q.label, ...dish, minsOf(q)].filter(Boolean).join(" · ").replace(/ /g, " "),
    });
    y += h;
  }
  for (const b of brks) ruled(b);
  tileTargets(
    rows.flatMap((r) => (r.target ? [{ box: r.target, words: { top: r.y, bottom: r.y + r.h } }] : [])),
    y,
  );

  const steps = rows.filter((r) => r.kind === "step");
  const now = steps.find((r) => r.state === "now");
  return {
    form: "list",
    width: right,
    height: y,
    scroll: y > g.H + EPS,
    nowY: now ? now.y : null,
    type: { ...px, lh },
    cols: { dish: dishCol, dot, label: labelX, right, minutes: right },
    dotR: (g.narrow ? 8 : 9) * c,
    rail: steps.length > 1 ? { x: dot, y0: steps[0].dotY!, y1: steps[steps.length - 1].dotY! } : null,
    rows,
  };
}
