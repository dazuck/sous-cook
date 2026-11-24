/**
 * The bottom strip and the peek, laid into a sheet's layout (look-ahead slice
 * 1, DS v1.62). One strip at the bottom edge: the foot's Back and Forward with
 * the progress line between them (`strip-line.ts`), and the sheet rising from
 * the strip's top edge. Its levels become:
 *
 * - **Rest (0):** the strip alone. The sheet's edge stands on the strip's top
 *   (`footTop`): no band is kept over it, so the step has that room back.
 * - **The peek (1):** a drawer of the next steps (`peek-layout.ts`), its edge
 *   the drawer's own height over the strip.
 * - **The whole cook (2):** a derived plan's meal drawn as lines (v1.63), as
 *   written's outline. The strip's line is the only progress line on screen,
 *   and its fill stands at the end of the step in hand here too (v1.63 retired
 *   v1.54's glide to the clock's minute: the lines have no clock axis).
 *
 * As written joins the same strip and peek (call 1, pending review):
 * its band's bars and its level-1 names are retired; its outline at level 2
 * is unchanged.
 *
 * Pure. The layout's other parts (the timetable, the outline, the read) are
 * laid as before; this sets the detents, the step's scale at the peek, and the
 * strip's and the peek's own drawings.
 */

import { clamp, sstep, type Frame, type FrameState, type LayoutInput, type SheetLayout } from "./sheet-layout";
import { PEEK_ARROW_Y, layoutPeek, type PeekDrawing } from "./peek-layout";
import { GAP_MIN, WORK_MIN, linePartsOf, type LinePart } from "./strip-line";
import type { Strip } from "./cook-strip";

/** The line in the strip: its ends, its centre, its parts (px on screen). */
export interface StripLineLayout {
  x0: number;
  x1: number;
  y: number;
  parts: LinePart[];
  /** The minute it fills to at rest (`Strip.progress`). */
  progress: number;
}

/** The least room the step keeps over the peek, cpx: past it the peek folds sooner. */
export const PEEK_STEP_ROOM = 160;
/** The line's least width in the strip, cpx (call 6): the foot's own give-way runs before it. */
export const LINE_MIN = 120;
/** The depth by which the peek's rows have gone on the way to the whole cook (as the stations did). */
export const PEEK_OUT = 1.15;
/** The depth by which the peek is drawn on the way up from rest, where it stood behind the foot. */
export const PEEK_IN = 0.05;

/** The layout with the strip and the peek laid in (no strip on the opening, or with no foot cell measured). */
export function withStrip(L: SheetLayout, input: LayoutInput): SheetLayout {
  const box = input.lineBox;
  if (!box || !input.peek || L.opening) return L;
  const g = L.geo;
  const c = g.c;
  // The step's least scale at the peek: never under 22 cpx a line.
  const floor = input.step ? Math.min(1, 22 / (64 * input.step.restFit)) : 1;
  // The room the step keeps over the peek: 160 cpx, or the step at its floor and 22 cpx under it
  // where that is more (a long step), so the peek folds sooner rather than standing over its words.
  const stepRoom = Math.max(PEEK_STEP_ROOM * c, L.step && input.step ? L.step.keepH * floor + 22 * c : 0);
  const peek: PeekDrawing = layoutPeek(
    input.peek,
    { W: g.W, c, E: g.E, narrow: g.portrait, maxH: Math.max(0, g.footTop - g.stepTop - stepRoom) },
    input.measure,
  );
  const Y0 = g.footTop;
  const Y1 = g.footTop - Math.max(peek.height, 1);
  const Y2 = L.detents[2];
  const stripLine: StripLineLayout = {
    x0: box.x0,
    x1: box.x1,
    y: box.y,
    parts: linePartsOf(input.strip, Math.max(0, box.x1 - box.x0), { gap: GAP_MIN * c, work: WORK_MIN * c }),
    progress: input.strip.progress,
  };

  // The step shrinks as a unit to stand clear of the peek, never under 22 cpx a line.
  let step = L.step;
  if (step && input.step) {
    const avail = Y1 - 22 * c - g.stepTop;
    const sc1 = clamp(avail / Math.max(1, step.keepH), floor, 1);
    step = { ...step, sc1, fit1: input.step.restFit * sc1, pages1: false };
  }

  // The time to the table is said at the whole cook only: at rest and under the peek it waits there, unseen.
  const P = L.P.map((p) => ({ ...p })) as SheetLayout["P"];
  const tt2 = P[2].tt;
  if (L.asWritten) {
    // As written's band and its next steps' names give way to the strip and the peek.
    P[0] = { ...P[0], bars: P[0].bars.map((b) => ({ ...b, op: 0 })), tt: { ...P[0].tt, op: 0 } };
    P[1] = { ...P[1], labs: P[1].labs.map((r) => ({ ...r, op: 0 })), tt: { ...P[1].tt, op: 0 } };
  } else {
    P[0] = { ...P[0], tt: { ...tt2, op: 0 } };
    P[1] = { ...P[1], tt: { ...tt2, op: 0 } };
  }

  const common = {
    detents: [Y0, Y1, Y2] as [number, number, number],
    band: 0,
    P,
    step,
    peek,
    stripLine,
    nudge: L.nudge ? { ...L.nudge, bottom: g.H - Y0 + 10 * c } : null,
    summary: { ...L.summary, fit1: step?.fit1 ?? L.summary.fit1, pages1: false },
  };
  if (L.asWritten) return { ...L, ...common };
  return { ...L, ...common, derived: { ...L.derived, paper: [Y0, Y1, L.derived.paper[2]] } };
}

/** What the strip and the peek add to a frame: the peek's rows shown, the line's fill minute, the hint's turn. */
export function stripFrame(L: SheetLayout, F: Frame, s: FrameState, fillNow: number): Frame {
  if (!L.peek) return F;
  const pw = clamp(s.pass ?? 0, 0, 1);
  const d = F.d;
  return {
    ...F,
    // At rest the peek stands behind the foot: drawn from the first move up, so at rest it is
    // neither seen nor read out.
    peek: (1 - pw) * sstep(0, PEEK_IN, d) * (1 - sstep(1, PEEK_OUT, d)),
    // The voice hint is the whole cook's: the peek's top is the arrows'.
    hint: sstep(1.6, 2, d),
    fillMin: fillNow,
  };
}

// ---------------------------------------------------------------------------
// The ways between the levels by hand (call 3, pending review): each a move a cook can
// see, so the whole cook is one obvious move from the peek, and rest one from either.
// ---------------------------------------------------------------------------

type Lvl = 0 | 1 | 2 | 3;

/** A tap on the strip's line: rest ↔ the peek; from the whole cook, the peek. */
export function stripTap(k: Lvl): Lvl {
  return k === 0 ? 1 : k === 1 ? 0 : k === 2 ? 1 : k;
}

/**
 * The arrows on the sheet's top edge, at the level it stands on: where each
 * goes. Only the peek has them. At the whole cook the Paper's top holds Back to
 * step, the title and (as written) the read band and the outline's first row,
 * so an arrow there stood over one of them; the cook leaves the whole cook by a
 * tap on the strip, Back to step, the down key or Esc.
 */
export function sheetArrows(k: Lvl): { collapse: Lvl | null; expand: Lvl | null } {
  if (k === 1) return { collapse: 0, expand: 2 };
  return { collapse: null, expand: null };
}

/** One arrow's target: where it goes, its glyph, and its 80 cpx square from the sheet's top edge (px). */
export interface ArrowTarget {
  mark: "collapse" | "expand";
  to: Lvl;
  dir: "up" | "down";
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The arrows' targets at a level, on a screen W wide at scale c: either side
 * of the centre, centred `PEEK_ARROW_Y` under the sheet's top edge.
 */
export function sheetArrowTargets(k: Lvl, W: number, c: number): ArrowTarget[] {
  const go = sheetArrows(k);
  const T = 80 * c;
  const y = PEEK_ARROW_Y * c - T / 2;
  const out: ArrowTarget[] = [];
  if (go.collapse != null) out.push({ mark: "collapse", to: go.collapse, dir: "down", x: W / 2 - 44 * c - T / 2, y, w: T, h: T });
  if (go.expand != null) out.push({ mark: "expand", to: go.expand, dir: "up", x: W / 2 + 44 * c - T / 2, y, w: T, h: T });
  return out;
}

/** The keys (N11, unchanged): ↑ deeper (on to Whole recipe), ↓ back a level, Esc to rest. */
export function keyLevel(key: string, k: Lvl): Lvl | null {
  if (key === "ArrowUp") return Math.min(3, k + 1) as Lvl;
  if (key === "ArrowDown" && k > 0) return (k - 1) as Lvl;
  if (key === "Escape" && k > 0) return 0;
  return null;
}

/**
 * The step in hand, as the sheet's hold reads it (`CookSheet`'s content key): its mark and the
 * screen it stands on. Prep first's pages share one mark (`prep`), in hand on each page, so the
 * screen is what tells them apart: a page turned at the peek or the whole cook lays the sheet out
 * again, as a step does, and its time to the table and its fill move with it.
 */
export function inHandKey(s: Strip): string {
  const m = s.marks.find((x) => x.state === "in-hand");
  return m ? `${m.key}:${m.screen}` : "";
}
