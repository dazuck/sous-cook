"use client";

import { useEffect, useLayoutEffect, useRef, type FocusEvent, type RefObject } from "react";

/**
 * A menu dropped from the cook's top line (More, and the chapters menu):
 * Paper lifted over the screen with a hairline, no shadow (DS §1), from the
 * top line's right end, so both open in the one place. Open, it holds the
 * cook view's arrows, swipes and taps (`data-holds-keys`); a flag leaves it
 * out of the capture (`data-capture-omit`).
 */
export const MENU_PANEL =
  "absolute top-full right-0 z-50 overflow-hidden rounded-[var(--radius-2)] border border-ink/[.11] bg-paper py-[var(--space-1)]";

/**
 * A menu's row, big enough for a wet finger at arm's length. No fill at rest;
 * a press shows sand, the cook screen's pressed state (DS §1). Its words are
 * at the meta's 22 cpx, the floor (V fix round 1: they were 18 px).
 */
export const MENU_ROW =
  "flex w-full min-h-[var(--target)] cursor-pointer items-center gap-[var(--space-4)] px-[calc(20*var(--cpx))] text-left text-[length:var(--type-meta)] leading-tight font-medium text-ink transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ink";

/**
 * How a top-line menu closes: a press outside it, Esc (one a layer above
 * hasn't taken; it takes the one it closes on), a choice, or the screen
 * holding it shutting it (`open` turned false from outside, as voice's
 * "close" does). Focus comes back to its button on Esc and on a choice, and
 * when it is shut from outside with focus on one of its rows, which would
 * otherwise fall to the page with the row. Under a borrowed screen that shut
 * it, the button can't take focus, and the screen places it.
 */
export function useMenuDismiss(
  open: boolean,
  setOpen: (open: boolean) => void,
  root: RefObject<HTMLElement | null>,
  button: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, root, button]);

  const focusInMenu = useRef(false);
  useLayoutEffect(() => {
    if (open || !focusInMenu.current) return;
    focusInMenu.current = false;
    if (document.activeElement === document.body) button.current?.focus();
  }, [open, button]);

  /** A choice closes the menu, focus back on its button first, then acts. */
  const choose = (action?: () => void) => () => {
    setOpen(false);
    button.current?.focus();
    action?.();
  };

  /** Spread on the panel: tracks whether focus is on one of its rows. */
  const panelFocus = {
    onFocus: () => {
      focusInMenu.current = true;
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget)) focusInMenu.current = false;
    },
  };

  return { choose, panelFocus };
}
