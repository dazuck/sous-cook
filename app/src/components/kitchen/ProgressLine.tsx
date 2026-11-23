"use client";

/**
 * The progress line (overview slice T3; SPEC §10): the cook sheet's one mark
 * that never moves. At level 0 it is the whole cook on true minutes from
 * margin to margin, a 4 cpx rounded track in Ink 13% with the done part
 * filled in Ink; at level 1 it is the strip map's rail; at level 2 it is the
 * timetable's last time track. Its ends, its fill and its Ink are painted on
 * every frame by the sheet (`paintLine`), so a pull costs no render.
 */

import type { Ref } from "react";
import { LINE_H, TRACK_INK } from "@/lib/kitchen/sheet-derived";
import type { LineFrame } from "@/lib/kitchen/sheet-derived";

export interface ProgressLineProps {
  /** The line's centre, px from the top of what holds it. */
  lineTop: number;
  c: number;
  trackRef: Ref<HTMLDivElement>;
  fillRef: Ref<HTMLDivElement>;
}

export function ProgressLine({ lineTop, c, trackRef, fillRef }: ProgressLineProps) {
  const h = LINE_H * c;
  return (
    <div
      ref={trackRef}
      data-progress-line
      aria-hidden
      className="pointer-events-none absolute left-0 rounded-full"
      style={{ top: lineTop - h / 2, height: h, width: 0 }}
    >
      <div ref={fillRef} data-progress-fill className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: 0 }} />
    </div>
  );
}

/** The track's colour: Ink 13% at 0, Ink at 1 (the rail). */
export const trackInk = (ink: number) => `color-mix(in oklab, var(--ink) ${((TRACK_INK + (1 - TRACK_INK) * ink) * 100).toFixed(1)}%, transparent)`;

/** Paint a frame's line onto the track and its fill (on whole tenths). */
export function paintLine(track: HTMLElement | null, fill: HTMLElement | null, f: LineFrame) {
  if (!track || !fill) return;
  track.style.transform = `translateX(${f.x.toFixed(1)}px)`;
  track.style.width = `${Math.max(0, f.w).toFixed(1)}px`;
  track.style.background = trackInk(f.ink);
  fill.style.width = `${Math.max(0, Math.min(f.w, f.fill)).toFixed(1)}px`;
}
