/**
 * The bottom strip's progress line (look-ahead slice 1, DS v1.62;
 * 2026-11-22: "the progress line drawn as work segments with gaps at
 * breaks"). The whole cook folded flat: a segment for each run of work at its
 * true minutes, and a gap where each break is (the strip's stretches, the
 * same breaks the cook hears as "about 50 min free"), drawn on the compressed
 * scale confirmed for the lanes, so a long break is a wider gap, never a
 * huge one. The fill is Ink to the end of the step in hand (`Strip.progress`,
 * v1.54) and is never drawn inside a gap.
 *
 * Pure: widths in whatever unit the caller gives (px on screen), floors in the
 * same unit.
 */

import type { Strip } from "./cook-strip";

/** A gap's weight is this share of the cook's work minutes, times its step on the scale. */
export const GAP_SHARE = 0.018;
/** The narrowest a gap is drawn, cpx: still read as a gap at arm's length. */
export const GAP_MIN = 8;
/** The narrowest a segment of work is drawn, cpx. */
export const WORK_MIN = 6;

/**
 * The compressed scale (DECISIONS 2026-11-22, "Yes, keep these steps"): up to 5 minutes is one
 * row, 6 to 15 a quarter taller, 16 to 30 about one and a half, longer just under two.
 */
export function gapRows(minutes: number): number {
  if (minutes <= 5) return 1;
  if (minutes <= 15) return 1.25;
  if (minutes <= 30) return 1.6;
  return 1.9;
}

export interface LinePart {
  kind: "work" | "gap";
  /** Plan minutes. */
  from: number;
  to: number;
  /** Where it is drawn, from the line's left end, in the caller's unit. */
  x0: number;
  x1: number;
}

export interface LineFloors {
  gap: number;
  work: number;
}

/**
 * Natural widths, then any part under its floor raised to it and the rest shrunk in proportion,
 * until every part holds its floor (or, past what the width can give, every floor shares the
 * shortfall alike).
 */
function fit(weights: number[], floors: number[], W: number): number[] {
  const floorSum = floors.reduce((a, b) => a + b, 0);
  if (floorSum >= W) return floors.map((f) => (f * W) / floorSum);
  const pinned = new Set<number>();
  for (;;) {
    const room = W - [...pinned].reduce((a, i) => a + floors[i], 0);
    const free = weights.reduce((a, w, i) => (pinned.has(i) ? a : a + w), 0);
    const out = weights.map((w, i) => (pinned.has(i) ? floors[i] : (w * room) / free));
    const under = out.findIndex((w, i) => !pinned.has(i) && w < floors[i] - 1e-9);
    if (under === -1) return out;
    out.forEach((w, i) => {
      if (!pinned.has(i) && w < floors[i] - 1e-9) pinned.add(i);
    });
  }
}

/** The line's parts, left to right, over `width`. Breaks are `{ from, to }` in plan minutes. */
export function lineParts(
  total: number,
  breaks: readonly { from: number; to: number }[],
  width: number,
  floors: LineFloors = { gap: GAP_MIN, work: WORK_MIN },
): LinePart[] {
  if (!(width > 0) || !(total > 0)) return [];
  // A break that touches either end of the cook would open or close the line on a gap: no such break.
  const cuts = breaks
    .filter((b) => b.from > 0 && b.to < total && b.to > b.from)
    .slice()
    .sort((a, b) => a.from - b.from);
  const spans: { kind: LinePart["kind"]; from: number; to: number }[] = [];
  let t = 0;
  for (const b of cuts) {
    if (b.from < t) continue; // overlapping breaks: the first one holds
    spans.push({ kind: "work", from: t, to: b.from });
    spans.push({ kind: "gap", from: b.from, to: b.to });
    t = b.to;
  }
  spans.push({ kind: "work", from: t, to: total });

  const workMinutes = spans.filter((s) => s.kind === "work").reduce((a, s) => a + (s.to - s.from), 0);
  const weights = spans.map((s) => (s.kind === "work" ? s.to - s.from : GAP_SHARE * workMinutes * gapRows(s.to - s.from)));
  const widths = fit(
    weights,
    spans.map((s) => (s.kind === "gap" ? floors.gap : floors.work)),
    width,
  );
  let x = 0;
  return spans.map((s, i) => {
    const x0 = x;
    x = i === spans.length - 1 ? width : x + widths[i];
    return { ...s, x0, x1: x };
  });
}

/** How full each segment of work is, 0 to 1, with the fill ending at `progress` minutes. */
export function lineFills(parts: readonly LinePart[], progress: number): number[] {
  return parts
    .filter((p) => p.kind === "work")
    .map((p) => Math.min(1, Math.max(0, (progress - p.from) / Math.max(1e-9, p.to - p.from))));
}

/** The strip's line: its breaks are its stretches' free times (none as written). */
export function linePartsOf(s: Strip, width: number, floors?: LineFloors): LinePart[] {
  const breaks = s.stretches.flatMap((st) => (st.free ? [{ from: st.free.from, to: st.free.to }] : []));
  return lineParts(s.totalMinutes, breaks, width, floors);
}
