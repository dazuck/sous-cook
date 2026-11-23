"use client";

import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/**
 * A title on a cover that breaks only between words (feel pass craft fix 1).
 *
 * `break-words` let the household title break inside a word when its longest
 * word was wider than the cover's panel (one letter left on a line of its
 * own, on R26's shelf). Here a title wraps only at spaces and hyphens. If a
 * word is still too wide, the title steps down the closed type scale, one
 * token at a time.
 * Only at the floor, where the scale has nothing smaller (DS §2, "nothing
 * below 22 counter-px"), does it hyphenate. A hyphenated break is marked; a
 * bare mid-word break is not.
 */

/** Which of the sizes to use, given whether each one fits. */
export interface WordFit {
  /** Index into the sizes, largest first. */
  size: number;
  /** True when no size fits whole words, so the floor hyphenates. */
  hyphenate: boolean;
}

/**
 * Picks the first size, largest first, at which every word fits on its own
 * line. If none fits, it takes the last (the floor) and hyphenates.
 * `fits(i)` reports whether size `i` keeps every word whole.
 */
export function chooseWordFit(count: number, fits: (i: number) => boolean): WordFit {
  if (count < 1) throw new Error("chooseWordFit needs at least one size");
  for (let i = 0; i < count; i++) {
    if (fits(i)) return { size: i, hyphenate: false };
  }
  return { size: count - 1, hyphenate: true };
}

/**
 * True when no word in `el` runs past its box. A word wider than the box
 * can't wrap (the element wraps only at spaces and hyphens), so it pushes
 * `scrollWidth` past `clientWidth`. Half a pixel absorbs subpixel rounding.
 */
function wordsFit(el: HTMLElement): boolean {
  return el.scrollWidth <= el.clientWidth + 0.5;
}

/**
 * Fits `text` in the element `ref` points at, returning its style. The
 * element wraps at spaces and hyphens only (`overflow-wrap: normal`,
 * `hyphens: manual` until the floor). `sizes` are CSS font sizes from the
 * type scale, largest first. The fit is measured again when the fonts finish
 * loading and when the element resizes.
 */
export function useWordFit(ref: RefObject<HTMLElement | null>, sizes: readonly string[], text: string): CSSProperties {
  const [fit, setFit] = useState<WordFit>({ size: 0, hyphenate: false });
  const key = sizes.join("|");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const list = key.split("|");
    const measure = () => {
      const prevSize = el.style.fontSize;
      const prevHyphens = el.style.hyphens;
      el.style.hyphens = "manual";
      const next = chooseWordFit(list.length, (i) => {
        el.style.fontSize = list[i];
        return wordsFit(el);
      });
      el.style.fontSize = prevSize;
      el.style.hyphens = prevHyphens;
      setFit((cur) => (cur.size === next.size && cur.hyphenate === next.hyphenate ? cur : next));
    };
    measure();
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [ref, key, text]);

  return {
    fontSize: sizes[fit.size],
    overflowWrap: "normal",
    wordBreak: "normal",
    hyphens: fit.hyphenate ? "auto" : "manual",
  };
}
