"use client";

import { useId, useRef, useState } from "react";
import { FOCUS } from "./control-style";
import { MENU_PANEL, useMenuDismiss } from "./CookMenu";

/** Placeholder copy for the kitchen's More menu. */
export const HOME_MORE_COPY = {
  more: "More",
  shoppingList: "Shopping list",
  import: "Import",
} as const;

/** A More row: a target tall (§0.3), no fill at rest, sand while pressed. */
const ROW =
  "flex w-full min-h-[var(--target)] cursor-pointer items-center px-[calc(26*var(--cpx))] text-left text-[length:var(--type-meta)] leading-tight font-medium text-ink transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ink";

/**
 * The kitchen top line's More ("···", P65): Shopping list, Import.
 * A popover, no scrim, dropped from the top line's right end like the cook's More
 * and dismissed the same way (a press outside, Esc, a choice).
 */
export function HomeMore({
  onImport,
  onShoppingList,
}: {
  onImport: () => void;
  onShoppingList?: () => void;
}) {
  const [open, setOpenState] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { choose, panelFocus } = useMenuDismiss(open, setOpenState, root, button);

  return (
    <div ref={root} className="relative -mr-[calc(26*var(--cpx))]">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpenState(!open)}
        className={`grid size-[var(--target)] shrink-0 cursor-pointer place-items-center rounded-full text-ink-soft transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand ${FOCUS}`}
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className="size-[calc(28*var(--cpx))]">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
        <span className="sr-only">{HOME_MORE_COPY.more}</span>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          data-holds-keys
          {...panelFocus}
          // The root reaches 26 cpx past the edge (the glyph stands on it); the panel's own edge doesn't.
          style={{ right: "calc(26 * var(--cpx))" }}
          className={`${MENU_PANEL} w-[calc(280*var(--cpx))] max-w-[calc(100vw-2*var(--edge))]`}
        >
          {onShoppingList && (
            <button
              type="button"
              role="menuitem"
              onClick={choose(onShoppingList)}
              className={ROW}
            >
              {HOME_MORE_COPY.shoppingList}
            </button>
          )}
          <button type="button" role="menuitem" onClick={choose(onImport)} className={ROW}>
            {HOME_MORE_COPY.import}
          </button>
        </div>
      )}
    </div>
  );
}
