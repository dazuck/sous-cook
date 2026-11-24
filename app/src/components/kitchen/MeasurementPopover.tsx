"use client";

import { useState, useRef, useEffect, useLayoutEffect, ReactNode } from "react";
import { createPortal } from "react-dom";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { opensMore, type MeasureRow } from "@/lib/kitchen/ingredient-display";

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
 *
 * An amount in a scrolling box too small to hold the panel (the opening's Get
 * out column; asked 2026-11-22) names a layer to draw it in instead: the
 * nearest ancestor marked `data-popover-layer`, a positioned box that doesn't
 * clip. The panel is then drawn in that layer, whole inside it by the same
 * rule, clear of the column's clip and its foot's fade, and put away when
 * anything scrolls or the window changes size (it no longer rides its amount).
 *
 * Open, it is put away by a press outside it, by Escape (the key taken, the
 * focus back on its amount) and by the focus moving to anything else, so two
 * panels never stand at once.
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
  /** The layer the panel is drawn in, found as it opens; null beside its amount, as everywhere else. */
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  // Put away by a press outside it, by the focus moving to anything else (Tab to the next amount, so
  // Enter there never opens a second panel beside this one), and by Escape.
  useEffect(() => {
    if (!isOpen) return;

    function outside(target: EventTarget | null): boolean {
      const node = target instanceof Node ? target : null;
      return (
        popoverRef.current !== null &&
        !popoverRef.current.contains(node) &&
        triggerRef.current !== null &&
        !triggerRef.current.contains(node)
      );
    }
    function handleClickOutside(event: MouseEvent) {
      if (outside(event.target)) setIsOpen(false);
    }
    // The focus leaving: it lands on something that is neither the panel, the amount, nor a box
    // that holds them. A press on the panel's words (which take no focus) hands the focus to the
    // nearest box that does, the sheet's own (`[data-cook-sheet]`, tabIndex -1), and that is the
    // cook still on the panel, not the focus leaving (review round 2).
    function handleFocusOutside(event: FocusEvent) {
      const node = event.target instanceof Node ? event.target : null;
      if (node !== null && (node.contains(popoverRef.current) || node.contains(triggerRef.current))) return;
      if (outside(node)) setIsOpen(false);
    }
    // Escape is the panel's while it is open: taken (so the screen under it doesn't leave or step
    // back on it), unless a handler ahead already took it; the focus goes back to the amount.
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.querySelector("button")?.focus();
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("focusin", handleFocusOutside);
    // Capture: before the page's own Escape (the back link, a borrowed screen's close).
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("focusin", handleFocusOutside);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [isOpen]);

  // Placed before paint, from the panel's own size, each time it opens.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const panel = popoverRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    const t = trigger.getBoundingClientRect();
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    if (layer === null) {
      setPlacement(placePanel({ top: t.top, bottom: t.bottom, left: t.left, right: t.right }, size, clipBox(trigger)));
      return;
    }
    // In its layer: whole inside the layer's box on the screen, and placed from the layer's corner.
    const l = layer.getBoundingClientRect();
    const box = {
      top: Math.max(l.top, 0),
      bottom: Math.min(l.bottom, window.innerHeight),
      left: Math.max(l.left, 0),
      right: Math.min(l.right, window.innerWidth),
    };
    const at = placePanel({ top: t.top, bottom: t.bottom, left: t.left, right: t.right }, size, box);
    setPlacement({ ...at, top: t.top - l.top + at.top, left: t.left - l.left + at.left });
  }, [isOpen, layer]);

  // In a layer the panel doesn't ride its amount: a scroll under it or a new window size puts it away.
  useEffect(() => {
    if (!isOpen || layer === null) return;
    const close = () => setIsOpen(false);
    document.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [isOpen, layer]);

  // Nothing past the chip itself: no popover, and no rule.
  if (!opensMore({ stated, conversions, servesBase, exact })) {
    return <span className={className}>{children}</span>;
  }

  const at = placement ?? START;
  const arrow = at.arrow;
  const panel = isOpen && (
        <div
          ref={popoverRef}
          data-holds-keys
          data-measure-panel
          data-side={at.side}
          // Measured once at the start, then placed; unseen until placed.
          style={{ top: at.top, left: at.left, visibility: placement === null ? "hidden" : undefined }}
          // Paper lifted over the ground, its edge a hairline, no shadow (DS §1, v1.13).
          className="pointer-events-auto absolute z-50 w-max min-w-[calc(180*var(--cpx))] rounded-[var(--radius-2)] border border-ink/[.11] bg-paper p-4 text-[length:var(--type-meta)] leading-tight font-medium tracking-normal text-ink"
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
              {/* Alone in the panel (Get out's sum of two lines states nothing), it opens it with no gap above. */}
              <div
                data-heading
                className={`${exact !== undefined || stated.length > 0 ? "mt-4 " : ""}mb-3 font-semibold text-ink-soft`}
              >
                {COOK_COPY.conversionsHeading}
              </div>
              <Rows rows={conversions} />
            </>
          )}
        </div>
  );
  return (
    <span className="relative inline-block" ref={triggerRef}>
      {/* A button, so the amount is reached and named by role (V8). */}
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          if (!isOpen) {
            setPlacement(null);
            setLayer(triggerRef.current?.closest<HTMLElement>("[data-popover-layer]") ?? null);
          }
          setIsOpen(!isOpen);
        }}
        className={`cursor-pointer text-left ${AMOUNT_RULE} ${className ?? ""}`}
      >
        {children}
      </button>

      {/* Open, it holds the cook view's arrow keys (CookFlow). */}
      {panel && layer ? createPortal(panel, layer) : panel}
    </span>
  );
}
