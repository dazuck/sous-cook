import { useEffect, useState, type RefObject } from "react";
import { FADE } from "@/components/kitchen/ReportsPanel";

/**
 * Whether a scrolling list has more below its visible foot, for the foot's
 * fade (slice S follow-up, DS v1.20; P56).
 *
 * It replaces the library's `useFootLift`, which at rest lifted the list's
 * foot (shrank the scroller) so the fade lay over the space between rows.
 * Shrinking the scroller when a scroll stopped moved what the cook was about
 * to tap: the visible foot jumped up to 120 px, a row at the edge vanished,
 * and at the end the scroll clamped and rows jumped down, so a tap could
 * queue the row above. Here the scroller never changes size: the list keeps
 * a constant `FADE` px fade at its foot while there is more below, which may
 * lie over the top of the next row's words at rest. Rows never move or
 * disappear when a scroll stops; a tap lands on the row under the finger.
 *
 * `content` is any string that changes when the list does.
 */
export function useMoreBelow(ref: RefObject<HTMLElement | null>, content: string): boolean {
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => setBelow(box.scrollTop + box.clientHeight < box.scrollHeight - 1);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(box);
    for (const child of box.children) resize.observe(child);
    box.addEventListener("scroll", measure, { passive: true });
    return () => {
      resize.disconnect();
      box.removeEventListener("scroll", measure);
    };
  }, [ref, content]);
  return below;
}

/** The mask that fades a list's last `FADE` px while there is more below; it never resizes the list. */
export function footMask(below: boolean): string | undefined {
  return below
    ? `linear-gradient(to bottom, #000 0, #000 calc(100% - ${String(FADE)}px), transparent 100%)`
    : undefined;
}
