/**
 * Focus coming back to what opened a page (slice S, S-D1). A borrowed
 * screen returns focus to what opened it because it is mounted over the
 * page that holds it; a route (the Cookpacks shelf, a pack) replaces the
 * page instead, so the page it goes back to has to be told where focus was.
 * The way back (a ledge, or Escape) marks what it came from, and the page it
 * lands on focuses the element carrying that mark (`data-return-focus`).
 *
 * Client-side navigation keeps this module, so the mark lasts one hop; a
 * reload forgets it, and the page then takes focus itself.
 */

let pending: string | null = null;

/** Marks the element the next page should focus: its `data-return-focus` value. */
export function markReturn(key: string): void {
  pending = key;
}

/**
 * Focuses the element `markReturn` named, if this page has it, and forgets
 * the mark either way. Whether it found one.
 */
export function takeReturn(root: ParentNode = document): boolean {
  const key = pending;
  pending = null;
  if (key === null) return false;
  const target = root.querySelector<HTMLElement>(`[data-return-focus="${CSS.escape(key)}"]`);
  if (!target) return false;
  target.focus();
  return true;
}
