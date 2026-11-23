// Invisible tap zones over the step stage: a tap on the left third goes
// back, on the right two thirds goes on (DECISIONS 2026-09-28, after the
// Player's reading of the same zones). Only a tap counts, so a scroll or a
// swipe never turns the page twice, and the zones never finish the cook:
// that takes the finish control itself.

/** How far the finger may wander, in CSS px, and still be a tap. */
export const TAP_SLOP = 10;
/** How long a press may last, in ms, and still be a tap. */
export const TAP_MS = 500;

export interface TapPoint {
  x: number;
  y: number;
  /** A timestamp in ms, as on a pointer event. */
  t: number;
}

/** Where the cook stands in the flow, which decides what a zone may do. */
export interface TapFlow {
  atStart: boolean;
  isLast: boolean;
}

export type TapMove = "back" | "next";

/**
 * What a press on the stage does: back, next, or nothing. The zone is read
 * from where the finger went down, and the stage is measured by its box on
 * screen (`left` and `width` from getBoundingClientRect).
 */
export function tapZone(
  down: TapPoint,
  up: TapPoint,
  box: { left: number; width: number },
  flow: TapFlow,
): TapMove | null {
  if (box.width <= 0) return null;
  if (Math.hypot(up.x - down.x, up.y - down.y) > TAP_SLOP) return null;
  if (up.t - down.t > TAP_MS) return null;
  const back = down.x - box.left < box.width / 3;
  if (back) return flow.atStart ? null : "back";
  return flow.isLast ? null : "next";
}

// Anything that answers a tap itself, and `[data-no-tap]` for what doesn't
// look it but is (a measurement that opens its conversions, the chapter row).
const FENCED = [
  "button",
  "a[href]",
  "label",
  "input",
  "textarea",
  "select",
  "summary",
  ...["button", "link", "checkbox", "switch", "tab", "menuitem", "option"].map(
    (role) => `[role=${role}]`,
  ),
  "[contenteditable]:not([contenteditable=false])",
  "[data-no-tap]",
].join(",");

/** True when a tap on `target` belongs to it rather than to the zones. */
export function tapFenced(target: Element | null): boolean {
  return target === null || target.closest(FENCED) !== null;
}
