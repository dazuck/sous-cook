"use client";

import type { CSSProperties } from "react";

const FOCUS =
  "focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink";

/**
 * A tick: a hairline tile (V9) in ink-soft, which holds a control's 3:1 on the
 * ground where ink at 11% would not; ticked, it fills ink. Its hit area runs
 * 12 px past the tile on every side; `hitY` holds it to less above and below,
 * where rows stand closer than that. The Prep screen's rows and a prep page's
 * tick rows (DS v1.59) share it; `size` is the tile's own box. `inert` puts it
 * out of reach, as a prep page's are under the lifted look-ahead.
 */
export function TickTile({
  checked,
  labelledBy,
  onToggle,
  size = "size-12 rounded-[10px]",
  mark = 24,
  hitY,
  inert = false,
}: {
  checked: boolean;
  /** The id of the words that name it: the row's own line. */
  labelledBy: string;
  onToggle: () => void;
  /** The tile's box and corner, as classes. */
  size?: string;
  /** The check's box, as a CSS length or px. */
  mark?: number | string;
  /** How far the hit area runs past the tile above and below, as a CSS length (negative is past it). */
  hitY?: string;
  /** Out of reach: no focus, no press, and a tap on it lands on what is under it (its row). */
  inert?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={onToggle}
      inert={inert}
      style={hitY === undefined ? undefined : ({ "--tick-hit-y": hitY } as CSSProperties)}
      className={`relative grid ${size} shrink-0 cursor-pointer place-items-center border transition-colors duration-[320ms] ease-[var(--ease)] before:absolute before:inset-x-[-12px] before:inset-y-[var(--tick-hit-y,-12px)] before:content-[''] ${FOCUS} ${
        checked ? "border-ink bg-ink text-paper" : "border-ink-soft text-ink active:bg-sand"
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ width: mark, height: mark }}
        className={`transition-opacity duration-[320ms] ease-[var(--ease)] ${checked ? "opacity-100" : "opacity-0"}`}
      >
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    </button>
  );
}
