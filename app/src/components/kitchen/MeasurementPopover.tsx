"use client";

import { useState, useRef, useEffect, useLayoutEffect, ReactNode } from "react";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import type { MeasureRow } from "@/lib/kitchen/ingredient-display";

/**
 * An amount's conversions, opened from its pair (V8). Fed from the pack
 * ingredient (slice B4 step 8, `ingredientLine`): what the recipe states
 * first, then the other units computed from its canonical amount. B5's flip
 * replaces it.
 *
 * It lies whole inside the box that would clip it (the cook view's stage,
 * which ends at the look-ahead band; a scrolling column; else the window),
 * and never over its own amount: under the amount where it fits, else over
 * it, else beside it, moved up or down inside the box (slice B5d: low on the
 * stage it ran under the band, hiding the second stated amount B5d brings
 * back).
 */

interface MeasurementPopoverProps {
  /** Each amount the recipe states, the chip's first. */
  stated: MeasureRow[];
  /** The other units, computed. */
  conversions: MeasureRow[];
  /** Set when scaled (multiplier ≠ 1), so the stated heading reads "Recipe says, for 4". */
  servesBase?: number;
  /** Set on a scaled count line when rounding moved the count ("5⅓", "⅛"), shown as "Exactly 5⅓". */
  exact?: string;
  /** The pair's words, its amount marked `data-amount-words` (the rule's target). */
  children: ReactNode;
  /** The trigger's own box: a button when there is more than the chip to show, else plain words. */
  className?: string;
}

/**
 * The dotted rule under an amount that opens (DS §5; DECISIONS 2026-10-26).
 * Only the button draws it, on the `data-amount-words` inside it, so an
 * amount reads as tappable exactly when it is: a count, the source's own words
 * or a measure with nothing to convert is plain words in the same type. The
 * rule's colour and offset are the amount's own (each caller sets them).
 */
export const AMOUNT_RULE = "[&_[data-amount-words]]:underline [&_[data-amount-words]]:decoration-dotted";

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Where the panel stands, in px from the amount's own box (its top left). */
export interface Placement {
  side: "below" | "above" | "right" | "left";
  top: number;
  left: number;
  /** Over or under the amount: the arrow's left in the panel, pointing at the amount's middle. */
  arrow?: number;
}

const GAP = 8;
const EDGE = 8;
/** The arrow's square, `size-4`. */
const ARROW = 16;

function Rows({ rows }: { rows: MeasureRow[] }) {
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div
          key={row.unit}
          data-row
          className="flex items-center justify-between gap-4 py-1"
        >
          <span className="text-ink-soft">{row.unit}</span>
          <span className="font-semibold text-ink">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/** The room the panel may use: the nearest ancestor that clips, else the window. */
function clipBox(el: HTMLElement): Rect {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== "visible") {
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    }
  }
  return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Under the amount when the panel fits there, centred on it; else over it;
 * else beside it, on the side with more room, its top moved inside the box.
 * Horizontally it is kept inside the box too. Never over the amount itself,
 * so a second tap on the amount always reaches it (and closes the panel).
 */
export function placePanel(trigger: Rect, panel: { width: number; height: number }, box: Rect): Placement {
  const width = trigger.right - trigger.left;
  const height = trigger.bottom - trigger.top;
  const centred = clamp(trigger.left + width / 2 - panel.width / 2, box.left + EDGE, box.right - EDGE - panel.width);
  const below = box.bottom - EDGE - (trigger.bottom + GAP);
  const above = trigger.top - GAP - (box.top + EDGE);
  const arrow = trigger.left + width / 2 - centred - ARROW / 2;
  if (panel.height <= below) return { side: "below", top: height + GAP, left: centred - trigger.left, arrow };
  if (panel.height <= above) return { side: "above", top: -(panel.height + GAP), left: centred - trigger.left, arrow };
  const right = box.right - EDGE - (trigger.right + GAP);
  const left = trigger.left - GAP - (box.left + EDGE);
  const top = clamp(trigger.top + height / 2 - panel.height / 2, box.top + EDGE, box.bottom - EDGE - panel.height) - trigger.top;
  return right >= left
    ? { side: "right", top, left: width + GAP }
    : { side: "left", top, left: -(panel.width + GAP) };
}

const START: Placement = { side: "below", top: 0, left: 0 };

export function MeasurementPopover({
  stated,
  conversions,
  servesBase,
  exact,
  children,
  className,
}: MeasurementPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Placed before paint, from the panel's own size, each time it opens.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const panel = popoverRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    const t = trigger.getBoundingClientRect();
    setPlacement(
      placePanel(
        { top: t.top, bottom: t.bottom, left: t.left, right: t.right },
        { width: panel.offsetWidth, height: panel.offsetHeight },
        clipBox(trigger),
      ),
    );
  }, [isOpen]);

  const hasMoreThanChip =
    exact !== undefined ||
    (servesBase !== undefined && stated.length > 0) ||
    stated.length >= 2 ||
    conversions.length > 0;

  // Nothing past the chip itself: no popover, and no rule.
  if (!hasMoreThanChip) {
    return <span className={className}>{children}</span>;
  }

  const at = placement ?? START;
  const arrow = at.arrow;
  return (
    <span className="relative inline-block" ref={triggerRef}>
      {/* A button, so the amount is reached and named by role (V8). */}
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          if (!isOpen) setPlacement(null);
          setIsOpen(!isOpen);
        }}
        className={`cursor-pointer text-left ${AMOUNT_RULE} ${className ?? ""}`}
      >
        {children}
      </button>

      {/* Open, it holds the cook view's arrow keys (CookFlow). */}
      {isOpen && (
        <div
          ref={popoverRef}
          data-holds-keys
          data-side={at.side}
          // Measured once at the start, then placed; unseen until placed.
          style={{ top: at.top, left: at.left, visibility: placement === null ? "hidden" : undefined }}
          // Paper lifted over the ground, its edge a hairline, no shadow (DS §1, v1.13).
          className="absolute z-50 w-max min-w-[calc(180*var(--cpx))] rounded-[var(--radius-2)] border border-ink/[.11] bg-paper p-4 text-[length:var(--type-meta)] leading-tight font-medium tracking-normal text-ink"
        >
          {/* Arrow: the hairline runs along its two edges toward the amount
              and its Paper covers the panel's edge under it; beside the
              amount there is none. */}
          {arrow !== undefined && (
            <div
              style={{ left: arrow }}
              className={`absolute size-4 rotate-45 bg-paper ${
                at.side === "above" ? "-bottom-[9px] border-r border-b" : "-top-[9px] border-t border-l"
              } border-ink/[.11]`}
              data-arrow
            />
          )}

          {exact !== undefined && (
            <div data-exact data-row className="font-semibold text-ink">
              {COOK_COPY.exactCount(exact)}
            </div>
          )}

          {stated.length > 0 && (
            <>
              {/* Its words at the meta's size, the floor (V fix round 1: 14 and 16 px). */}
              <div
                data-heading
                className={`${exact !== undefined ? "mt-4 " : ""}mb-3 font-semibold text-ink-soft`}
              >
                {servesBase !== undefined
                  ? COOK_COPY.statedHeadingFor(servesBase)
                  : COOK_COPY.statedHeading}
              </div>
              <Rows rows={stated} />
            </>
          )}

          {conversions.length > 0 && (
            <>
              <div
                data-heading
                className="mt-4 mb-3 font-semibold text-ink-soft"
              >
                {COOK_COPY.conversionsHeading}
              </div>
              <Rows rows={conversions} />
            </>
          )}
        </div>
      )}
    </span>
  );
}
