"use client";

/**
 * The peek's rows, drawn where `layoutPeek` placed them (look-ahead slice 1,
 * DS v1.62; the approved drawing):
 * a dot on one rail for each step (filled: the cook's hands; hollow: it goes
 * in to cook by itself), its label, its dish and its minutes; then one ruled
 * row for the break or the table, and "after that" where it applies. No
 * headings. The rows are words to read, not targets (call 4): a touch on them
 * is the sheet's (a pull), and a tap does nothing.
 *
 * What a screen reader hears is each row's own text (`[data-peek-said]`,
 * visually hidden), not an `aria-label` on the item: TalkBack on Chrome may
 * ignore a list item's label, and every drawn word is `aria-hidden` (placed
 * by hand, in pieces). The list itself is named (the sheet's "Look ahead").
 */

import type { PeekDrawing } from "@/lib/kitchen/peek-layout";

/** The arrows on the sheet's edge and over the strip's line: 62% of Back's and Forward's glyph (30 cpx). */
export const SHEET_ARROW = 19;
const CHEV_UP = "M5 15l7-7 7 7";
const CHEV_DOWN = "M5 9l7 7 7-7";

export function SheetArrow({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
      style={{ width: `calc(${SHEET_ARROW} * var(--cpx))`, height: `calc(${SHEET_ARROW} * var(--cpx))` }}
    >
      <path d={dir === "up" ? CHEV_UP : CHEV_DOWN} />
    </svg>
  );
}

/** A row's words as a screen reader hears them; drawn nowhere. */
function Said({ text }: { text: string }) {
  return (
    <span data-peek-said className="sr-only">
      {text}
    </span>
  );
}

export function PeekRows({ d, c, label }: { d: PeekDrawing; c: number; label?: string }) {
  const { type: T, cols } = d;
  const rule = (y: number) => (
    <i aria-hidden className="absolute block h-px bg-ink/[.11]" style={{ left: cols.dot - d.dotR, right: `calc(100% - ${cols.right}px)`, top: y }} />
  );
  return (
    <ol aria-label={label} className="m-0 list-none p-0">
      {d.rail && (
        <i
          aria-hidden
          className="absolute block rounded-full bg-ink/[.16]"
          style={{ left: d.rail.x - 1.5 * c, width: 3 * c, top: d.rail.y0, height: d.rail.y1 - d.rail.y0 }}
        />
      )}
      {d.rows.map((r, i) => {
        const key = r.kind === "step" || r.kind === "after" ? `${r.kind}:${r.key}` : r.kind;
        if (r.kind === "step") {
          const metaY = r.dotY - (T.meta * T.lh) / 2;
          return (
            <li key={key} data-peek-row="step" data-peek-key={r.key} data-peek-now={r.now ? "" : undefined}>
              <Said text={r.said.replace(/^[●○] /, "")} />
              <i
                aria-hidden
                data-peek-dot={r.pot ? "pot" : "hands"}
                className={`absolute block rounded-full ${r.pot ? "bg-paper" : "bg-ink"}`}
                style={{
                  left: cols.dot - d.dotR,
                  top: r.dotY - d.dotR,
                  width: 2 * d.dotR,
                  height: 2 * d.dotR,
                  boxShadow: r.pot ? `inset 0 0 0 ${(3 * c).toFixed(1)}px var(--ink)` : undefined,
                }}
              />
              <span
                aria-hidden
                data-peek-label
                className="absolute block font-semibold text-ink"
                style={{ left: cols.label, top: r.dotY - (T.label * T.lh) / 2, width: r.labelRight - cols.label, fontSize: T.label, lineHeight: T.lh }}
              >
                {r.lines.map((ln, q) => (
                  <span key={q} className="block whitespace-nowrap">
                    {ln}
                  </span>
                ))}
              </span>
              {r.dish && (
                <span
                  aria-hidden
                  data-peek-dish
                  className="absolute block font-medium whitespace-nowrap text-ink-soft"
                  style={
                    cols.dish
                      ? { left: cols.dish.x, top: metaY, fontSize: T.meta, lineHeight: T.lh }
                      : { right: `calc(100% - ${cols.dishRight.toFixed(1)}px)`, top: metaY, fontSize: T.meta, lineHeight: T.lh }
                  }
                >
                  {r.dish}
                </span>
              )}
              {r.minutes && (
                <span
                  aria-hidden
                  data-peek-minutes
                  className="absolute block font-medium whitespace-nowrap text-ink-soft"
                  style={{ right: `calc(100% - ${cols.right}px)`, top: metaY, fontSize: T.meta, lineHeight: T.lh }}
                >
                  {r.minutes}
                </span>
              )}
            </li>
          );
        }
        const first = i > 0 && d.rows[i - 1].kind === "step";
        if (r.kind === "after") {
          return (
            <li key={key} data-peek-row="after">
              <Said text={r.said} />
              {rule(r.y)}
              <span
                aria-hidden
                className="absolute block font-medium text-ink-soft"
                style={{ left: cols.label, top: r.y + (r.h - r.lines.length * T.ruled * T.lh) / 2, fontSize: T.ruled, lineHeight: T.lh }}
              >
                {r.lines.map((ln, q) => (
                  <span key={q} className="block whitespace-nowrap">
                    {ln}
                  </span>
                ))}
              </span>
            </li>
          );
        }
        // A ruled row: the break ("then 50 min free while it roasts") or the table.
        return (
          <li key={key} data-peek-row={r.kind} data-peek-first={first ? "" : undefined}>
            <Said text={r.said} />
            {rule(r.y)}
            <span
              aria-hidden
              className="absolute block font-medium text-ink-soft"
              style={{
                left: cols.label,
                width: cols.right - cols.label,
                top: r.y + (r.h - r.lines.length * T.ruled * T.lh) / 2,
                fontSize: T.ruled,
                lineHeight: T.lh,
              }}
            >
              {r.words.lead} <span className="text-ink">{r.words.main}</span>
              {r.words.tail ? ` ${r.words.tail}` : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
