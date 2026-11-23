/**
 * The cook view's one left edge: the header, the chapters, the steps, Ask's
 * panel, the whole cook and every borrowed screen all hang off it, so the
 * voice dot and the text don't move when one opens. It is the same on every
 * recipe: the foot has a band of its own below the steps (V4), so no gutters
 * are kept for it. The value is `--edge`, set on `.cook-edge` in
 * globals.css, which wraps everything CookScreen draws, and the hub too, for
 * the library and the import on their borrowed screens.
 */
export const EDGE_X = "px-[var(--edge)]";
/** The same edge on the left only, for a row whose right side is its own. */
export const EDGE_L = "pl-[var(--edge)]";

/**
 * `--edge` as it resolves at `el`, in CSS px. A custom property reads back
 * as written (`calc(44 * var(--cpx))` since the edge became the DS's 44 cpx),
 * so `parseFloat` of it is NaN. A probe padded by it reads the length the
 * layout uses, as the sheet reads its stack's padding.
 */
export function edgePx(el: Element): number {
  return probeLength(el, "var(--edge)");
}

/** `n` cpx as it resolves at `el`, in CSS px (read the same way as `--edge`). */
export function cpxLength(el: Element, n: number): number {
  return probeLength(el, `calc(${n} * var(--cpx))`);
}

function probeLength(el: Element, length: string): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;padding:0 0 0 ${length}`;
  el.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).paddingLeft);
  probe.remove();
  return px;
}
