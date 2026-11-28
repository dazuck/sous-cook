/**
 * Get out's column on the wide tablet (DS v1.66): whether the Ahead note heading it folds to one line,
 * so the list under it keeps room for its first two rows (DECISIONS 2026-11-24, "Get out keeps room
 * for two rows"). Worked out by arithmetic from the column's CSS and the page's text measure, as the
 * opening budgets its other columns, so it is the same sum in the browser and in a unit test.
 *
 * Everything is in counter px (cpx), the unit the column is drawn in (`--cpx`).
 */

import type { Measure } from "@/lib/kitchen/sheet-layout";

/** Get out's column beside the meal's lines (DS v1.63); `GET_OUT_LINES` in `Timetable.tsx`. */
export const COLUMN = 210;
/** The column's gap between the note, the head row and the list (`gap-[calc(6*var(--cpx))]`). */
export const COLUMN_GAP = 6;
/** The note's padding: 12 cpx at the sides, 6 above and below (column form). */
const NOTE_PAD_X = 12;
const NOTE_PAD_Y = 6;
/** The note's line (22 cpx type on a 26 cpx line; "Ahead" at 24 on the same line). */
export const NOTE_LINE = 26;
/** A note with its ask, folded or not, stands a 48 px target at least. */
export const TARGET_PX = 48;

/** One run of the note's words, as drawn: its text (its spaces included), size and weight. */
export interface NoteRun {
  text: string;
  size: number;
  weight: number;
}

const run = (text: string, weight = 500, size = 22): NoteRun => ({ text, size, weight });

/**
 * The note's words in their runs, spaced as `Timetable` sets them: "Ahead" (24, 600), each job's summary
 * (700) and "· lead" (500), and with the ask its full stop and words (600).
 */
export function noteRuns(
  ahead: readonly { summary: string; lead: string }[],
  /** Without the plan's jobs, the timetable's own items, name and lead (`op.ahead`). */
  items: readonly { name: string; lead: string }[],
  aheadWord: string,
  askWords: string | null,
): NoteRun[] {
  const runs: NoteRun[] = [run(aheadWord, 600, 24), run(" ")];
  const jobs = ahead.length > 0 ? ahead.map((a) => [a.summary, `· ${a.lead}`] as const) : items.map((a) => [a.name, a.lead] as const);
  jobs.forEach(([what, when], q) => {
    if (q > 0) runs.push(run(" · "));
    runs.push(run(what, 700), run(" "), run(when));
  });
  if (askWords) runs.push(run("."), run(" "), run(askWords, 600));
  return runs;
}

/**
 * The lines the words take in `width` cpx: greedy, breaking only at spaces, as the browser sets them. A
 * word may run across runs (a lead and the full stop after it) and is measured piece by piece.
 */
export function wrapRuns(runs: readonly NoteRun[], width: number, measure: Measure): number {
  const space = measure(" ", 22, 500);
  const words: number[] = [];
  let word: number | null = null;
  for (const r of runs) {
    for (const piece of r.text.split(/( +)/)) {
      if (piece === "") continue;
      if (piece.trim() === "") {
        if (word !== null) words.push(word);
        word = null;
      } else word = (word ?? 0) + measure(piece, r.size, r.weight);
    }
  }
  if (word !== null) words.push(word);
  let lines = words.length > 0 ? 1 : 0;
  let x = 0;
  for (const w of words) {
    if (x === 0) x = w;
    else if (x + space + w <= width + 0.01) x += space + w;
    else {
      lines += 1;
      x = w;
    }
  }
  return lines;
}

/** The note's full height in the column, in cpx: its lines and padding, a target tall at least with its ask. */
export function noteFullCpx(runs: readonly NoteRun[], c: number, measure: Measure, ask: boolean): number {
  const lines = wrapRuns(runs, COLUMN - 2 * NOTE_PAD_X, measure);
  return Math.max(ask ? TARGET_PX / c : 0, lines * NOTE_LINE + 2 * NOTE_PAD_Y);
}

/** The folded note's words after "Ahead": how many make-ahead jobs it holds ("· 3 jobs", "· 1 job"). */
export function foldedCount(jobs: number): string {
  return `· ${jobs} ${jobs === 1 ? "job" : "jobs"}`;
}

/** The folded line's gap between its words and the chevron (`gap-[calc(4*var(--cpx))]`): 4 cpx keeps "· 99 jobs" whole. */
export const FOLDED_GAP = 4;

/** The folded line's width in cpx: its padding, "Ahead" (24, 600), a space, the count (22, 500), the gap and the 22 cpx chevron. */
export function foldedWidthCpx(jobs: number, aheadWord: string, measure: Measure): number {
  return 2 * NOTE_PAD_X + measure(aheadWord, 24, 600) + measure(" ", 22, 500) + measure(foldedCount(jobs), 22, 500) + FOLDED_GAP + 22;
}

/** The folded note's height: one line and its padding, a target tall at least. */
export function noteFoldedCpx(c: number): number {
  return Math.max(TARGET_PX / c, NOTE_LINE + 2 * NOTE_PAD_Y);
}

/** What Get out's head row holds: its heading, the serving stepper (its words, − and + or not) and Show amounts. */
export interface HeadRow {
  /** "Get out", and the scale note after it where there is no stepper. */
  heading: string;
  scaleNote: string | null;
  stepper: { words: string; scales: boolean } | null;
  amounts: boolean;
}

/** `--space-2` and `--space-3` (8.8 and 13.2 cpx), the stepper's gaps. */
const SPACE_2 = 8.8;
const SPACE_3 = 13.2;
/** The stepper's words: `--type-meta` (22 cpx) on `leading-tight` (1.25). */
const STEPPER_LINE = 22 * 1.25;
/** A − or + : 24 cpx each side of its glyph, a target (80 cpx) tall less the 24 cpx it hangs over each side. */
const STEP_BTN_PAD = 24;
const STEP_BTN_H = 80 - 2 * 24;
/** The stepper keeps 24 cpx under itself in the head row (`mb-[calc(24*var(--cpx))]`). */
const STEPPER_MB = 24;

/** Get out's head row in the column, in cpx: a flex row that wraps, 10 cpx apart, each line as tall as its tallest. */
export function headRowCpx(row: HeadRow, measure: Measure): number {
  const items: { w: number; h: number }[] = [];
  const heading = measure(row.heading, 24, 600) + (row.scaleNote && !row.stepper ? measure(` ${row.scaleNote}`, 22, 500) : 0);
  items.push({ w: Math.min(COLUMN, heading), h: 28 });
  if (row.stepper) {
    const words = measure(row.stepper.words, 22, 500);
    const group = row.stepper.scales ? 2 * (2 * STEP_BTN_PAD) + measure("−", 22, 500) + measure("+", 22, 500) + SPACE_2 : 0;
    const max = words + (group ? SPACE_3 + group : 0);
    const w = Math.min(COLUMN, max);
    const wordLines = words <= w + 0.01 ? 1 : wrapWords(row.stepper.words, w, measure);
    const inner = !group
      ? wordLines * STEPPER_LINE
      : max <= w + 0.01
        ? Math.max(STEPPER_LINE, STEP_BTN_H)
        : wordLines * STEPPER_LINE + SPACE_2 + STEP_BTN_H;
    items.push({ w, h: inner + STEPPER_MB });
  }
  if (row.amounts) items.push({ w: measure("Show amounts", 22, 600), h: 26 });
  let total = 0;
  let lineW = 0;
  let lineH = 0;
  for (const it of items) {
    if (lineW > 0 && lineW + 10 + it.w <= COLUMN + 0.01) {
      lineW += 10 + it.w;
      lineH = Math.max(lineH, it.h);
    } else {
      total += lineH;
      lineW = it.w;
      lineH = it.h;
    }
  }
  return total + lineH;
}

function wrapWords(text: string, width: number, measure: Measure): number {
  return wrapRuns([run(text)], width, measure);
}

/** A group of the list: its heading and its items' words as drawn at rest (each but the last with its dot). */
export interface ListGroup {
  items: readonly string[];
}

/** A group's heading (25 cpx), the 1 cpx under it; a row of items (26 cpx); groups 6 cpx apart. */
const GROUP_HEAD = 25;
const GROUP_HEAD_GAP = 1;
const ROW = 26;

/**
 * The list's height down to the end of its `rows`-th row of things to get out (a group's heading is no
 * row), or the whole list where it has fewer. Items are inline boxes set side by side, each with its dot
 * but the last; an item wider than the column wraps inside it.
 */
export function listRowsCpx(groups: readonly ListGroup[], measure: Measure, rows = 2): number {
  const dot = measure(" · ", 22, 500);
  let y = 0;
  let seen = 0;
  groups.forEach((g, gi) => {
    if (seen >= rows || g.items.length === 0) return;
    y += (gi > 0 && y > 0 ? COLUMN_GAP : 0) + GROUP_HEAD + GROUP_HEAD_GAP;
    let x = 0;
    let lines = 0;
    g.items.forEach((it, i) => {
      const w = measure(it, 22, 500) + (i < g.items.length - 1 ? dot : 0);
      if (w > COLUMN) {
        const own = wrapWords(it, COLUMN, measure);
        lines += (x > 0 ? 1 : 0) + own;
        x = 0;
        return;
      }
      if (x === 0) {
        lines += 1;
        x = w;
      } else if (x + w <= COLUMN + 0.01) x += w;
      else {
        lines += 1;
        x = w;
      }
    });
    const take = Math.min(lines, rows - seen);
    y += take * ROW;
    seen += take;
  });
  return y;
}

/**
 * Whether the note folds: at its full height it would leave the list less than its first two rows (or
 * less than the whole list, where that is shorter) in a column `avail` cpx tall. A note no taller than
 * its folded line (`folded`, `noteFoldedCpx`) never folds: folding it would gain the list nothing.
 */
export function aheadFolds(r: { avail: number; noteFull: number; folded: number; head: number; rows: number }): boolean {
  if (r.noteFull <= r.folded + 0.01) return false;
  return r.noteFull + COLUMN_GAP + r.head + COLUMN_GAP + r.rows > r.avail + 0.01;
}
