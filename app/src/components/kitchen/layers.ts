/**
 * What is drawn over the cook, read from the document, for the layers that
 * take Escape one at a time: the full screen's card, a borrowed screen, the
 * pane's card, the pane.
 */

/**
 * The layer drawn on top: the last whole-screen modal in the document. They
 * are all fixed at the same z, so the later one paints over the earlier;
 * the profile picker, mounted after the page, is above every screen.
 */
export function topLayer(): Element | null {
  const layers = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
  return layers.item(layers.length - 1);
}

/**
 * Whether anything over the steps holds the keys: a borrowed screen, the
 * header's More menu, an amount's popover (each marked `data-holds-keys`).
 */
export function keysHeld(): boolean {
  return document.querySelector("[data-holds-keys]") !== null;
}

/**
 * Whether nothing is drawn over the steps and the pane beside them, so an
 * Escape there is theirs: no modal, nothing holding the keys.
 */
export function stepsOnTop(): boolean {
  return topLayer() === null && !keysHeld();
}
