/**
 * What is drawn under a tap at (`x`, `y`), in client px, on the sheet's timetable: a step's card (its
 * strip mark), "prep" for the shared Prep block, or null.
 *
 * The meal's lines scroll in their own box (DS v1.63), so a card can be scrolled out of sight while
 * its box still says it is under the finger: only the part its scroll box shows counts, or a tap on
 * the header above a scrolled list would read a stop the cook cannot see (review: touch 4).
 */
export function cardUnder(root: ParentNode, x: number, y: number): string | null {
  const inside = (r: DOMRect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  for (const el of root.querySelectorAll<HTMLElement>("[data-prep-card], [data-card]")) {
    if (!inside(el.getBoundingClientRect())) continue;
    const box = el.closest<HTMLElement>("[data-lines-scroll]");
    if (box && !inside(box.getBoundingClientRect())) continue;
    return el.hasAttribute("data-prep-card") ? "prep" : el.getAttribute("data-card");
  }
  return null;
}
