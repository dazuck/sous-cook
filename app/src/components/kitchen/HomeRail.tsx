"use client";

import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Link from "next/link";
import type { FootWord } from "@/lib/kitchen/home-view";
import { ASK_COPY } from "./AskSous";
import { FOCUS } from "./control-style";
import { useMenuDismiss } from "./CookMenu";
import { COOKPACKS_HREF } from "./HomeFoot";
import { HOME_MORE_COPY } from "./HomeMore";
import { SignOutItem } from "./SignOutItem";

interface HomeRailProps {
  cookpacks: string;
  word: FootWord;
  queueCount?: number;
  ready?: boolean;
  onOpenQueue: () => void;
  onOpenImport: () => void;
  onOpenAddIngredients?: () => void;
  onOpenShoppingList?: () => void;
  onOpenAsk?: () => void;
  addIngredientsLabel: string;
  flagged?: ReactNode;
}

const LONG_PRESS_MS = 320;
const DRAG_OPEN_PX = 14;

const RAIL_ICON_BTN = `group/icon relative inline-flex size-[var(--target)] shrink-0 cursor-pointer items-center justify-center rounded-full text-[length:var(--type-meta)] text-ink-soft transition-colors duration-[320ms] ease-[var(--ease)] hover:text-ink active:bg-sand ${FOCUS}`;

const TAB_ROW = `flex w-full min-h-[var(--target)] min-w-[var(--target)] cursor-pointer items-center gap-[calc(14*var(--cpx))] px-[calc(22*var(--cpx))] text-left text-[length:var(--type-meta)] leading-tight font-medium text-ink transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ink`;

/**
 * Right-edge appliance icon rail for `/kitchen`:
 * - Direct 1-tap etched line icons for Cookpacks, Up next / queue, Add ingredients, and Import.
 * - Long-pressing (320 ms), dragging left along the bar, or tapping the pull-out handle ("More")
 *   slides out a warm `--paper` tab naming each icon and surfacing secondary options
 *   (Shopping list, Ask Sous, Flagged screens).
 */
export function HomeRail({
  cookpacks,
  word,
  ready = true,
  onOpenQueue,
  onOpenImport,
  onOpenAddIngredients,
  onOpenShoppingList,
  onOpenAsk,
  addIngredientsLabel,
  flagged,
}: HomeRailProps) {
  const [open, setOpenState] = useState(false);
  const root = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { choose, panelFocus } = useMenuDismiss(open, setOpenState, root, button);

  // Long-press or drag-left along the rail pulls out the labeled tab.
  const gesture = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | null; triggered: boolean } | null>(null);
  const suppressClick = useRef(false);

  const clearGesture = () => {
    if (gesture.current?.timer) clearTimeout(gesture.current.timer);
    gesture.current = null;
  };

  useEffect(() => clearGesture, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!e.isPrimary || e.button !== 0 || open) return;
    suppressClick.current = false;
    clearGesture();
    const timer = setTimeout(() => {
      if (gesture.current) {
        gesture.current.triggered = true;
        suppressClick.current = true;
        setOpenState(true);
      }
    }, LONG_PRESS_MS);
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, timer, triggered: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (dx < -DRAG_OPEN_PX && Math.abs(dx) > Math.abs(dy)) {
      if (g.timer) clearTimeout(g.timer);
      g.timer = null;
      g.triggered = true;
      suppressClick.current = true;
      setOpenState(true);
    } else if (Math.hypot(dx, dy) > 10) {
      if (g.timer) clearTimeout(g.timer);
      g.timer = null;
    }
  };

  const onPointerUpOrCancel = () => {
    clearGesture();
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  const onNavClickCapture = (e: React.MouseEvent<HTMLElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <>
      {flagged && (
        <div
          data-kitchen-room
          className="fixed top-[calc(14*var(--cpx))] right-[calc(96*var(--cpx))] z-30 flex w-[calc(100vw-730*var(--cpx))] items-center justify-end portrait:w-[calc(100vw-130*var(--cpx))]"
        >
          {flagged}
        </div>
      )}
      <aside
        ref={root}
        data-home-rail
        data-home-foot
        data-rail-expanded={open ? "" : undefined}
        aria-label="Kitchen actions"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUpOrCancel}
        onPointerCancel={onPointerUpOrCancel}
        className="fixed top-1/2 right-[calc(10*var(--cpx))] z-30 flex -translate-y-1/2 flex-col items-end [body:has([data-reports-list])_&]:pointer-events-none"
      >

      {/* Collapsed vertical appliance icon rail */}
      <nav
        aria-label="Kitchen shortcuts"
        onClickCapture={onNavClickCapture}
        className="flex flex-col items-center gap-y-[calc(2*var(--cpx))] rounded-full py-[calc(6*var(--cpx))]"
      >
        {/* 1. Cookpacks */}
        <Link
          href={COOKPACKS_HREF}
          data-return-focus="cookpacks"
          aria-label={cookpacks}
          className={RAIL_ICON_BTN}
        >
          <CookpacksGlyph />
        </Link>

        {/* 2. Up next / Under way / Made recently */}
        {word ? (
          <button
            type="button"
            data-foot-queue
            data-return-focus="queue"
            aria-label={word.label}
            onClick={onOpenQueue}
            className={RAIL_ICON_BTN}
          >
            <QueueGlyph />
          </button>
        ) : !ready ? (
          <span aria-hidden="true" className="size-[var(--target)] shrink-0" />
        ) : null}

        {/* 3. Add ingredients */}
        {onOpenAddIngredients && (
          <button
            type="button"
            aria-label={addIngredientsLabel}
            onClick={onOpenAddIngredients}
            className={RAIL_ICON_BTN}
          >
            <IngredientsGlyph />
          </button>
        )}

        {/* 4. Direct 1-tap Import */}
        <button
          type="button"
          data-rail-import
          aria-label="Import recipe"
          onClick={onOpenImport}
          className={RAIL_ICON_BTN}
        >
          <ImportGlyph />
        </button>

        {/* 5. Pull-out tab handle ("More") — also opens on long-press or drag-left */}
        <button
          ref={button}
          type="button"
          data-rail-pull
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpenState(!open)}
          className={RAIL_ICON_BTN}
        >
          <PullTabGlyph open={open} />
          <span className="sr-only">{HOME_MORE_COPY.more}</span>
        </button>
      </nav>

      {/* Pull-out labeled paper tab */}
      {open && (
        <div
          id={menuId}
          role="menu"
          data-rail-tab
          data-holds-keys
          {...panelFocus}
          className="fixed top-1/2 right-[calc(94*var(--cpx))] z-40 w-[calc(300*var(--cpx))] max-w-[calc(100vw-var(--edge)-94*var(--cpx))] -translate-y-1/2 rounded-[var(--radius-2)] border border-ink/[.14] bg-paper py-[calc(10*var(--cpx))] shadow-none"
        >
          <div className="flex items-center justify-between border-b border-ink/[.08] px-[calc(22*var(--cpx))] pb-[calc(6*var(--cpx))]">
            <span className="text-[length:calc(16*var(--cpx))] font-semibold tracking-[0.06em] uppercase text-ink-soft">
              Kitchen
            </span>
            <button
              type="button"
              aria-label="Close kitchen tab"
              onClick={() => setOpenState(false)}
              className={`inline-flex size-[var(--target)] -mr-[calc(14*var(--cpx))] cursor-pointer items-center justify-center rounded-full text-ink-soft hover:text-ink active:bg-sand ${FOCUS}`}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-[calc(22*var(--cpx))]">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          </div>

          <div className="flex flex-col py-[calc(4*var(--cpx))]">
            <Link
              href={COOKPACKS_HREF}
              role="menuitem"
              onClick={() => setOpenState(false)}
              className={TAB_ROW}
            >
              <CookpacksGlyph />
              <span>{cookpacks}</span>
            </Link>

            {word && (
              <button
                type="button"
                role="menuitem"
                onClick={choose(onOpenQueue)}
                className={TAB_ROW}
              >
                <QueueGlyph />
                <span>{word.label}</span>
              </button>
            )}

            {onOpenAddIngredients && (
              <button
                type="button"
                role="menuitem"
                onClick={choose(onOpenAddIngredients)}
                className={TAB_ROW}
              >
                <IngredientsGlyph />
                <span>{addIngredientsLabel}</span>
              </button>
            )}

            {onOpenShoppingList && (
              <button
                type="button"
                role="menuitem"
                onClick={choose(onOpenShoppingList)}
                className={TAB_ROW}
              >
                <ShoppingListGlyph />
                <span>{HOME_MORE_COPY.shoppingList}</span>
              </button>
            )}

            <button
              type="button"
              role="menuitem"
              onClick={choose(onOpenImport)}
              className={TAB_ROW}
            >
              <ImportGlyph />
              <span>{HOME_MORE_COPY.import}</span>
            </button>

            {onOpenAsk && (
              <button
                type="button"
                role="menuitem"
                onClick={choose(onOpenAsk)}
                className={TAB_ROW}
              >
                <AskGlyph />
                <span>{ASK_COPY.title}</span>
              </button>
            )}
            <SignOutItem rowClassName={TAB_ROW} />
          </div>
        </div>
      )}
      </aside>
    </>
  );
}

function CookpacksGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[calc(26*var(--cpx))] shrink-0"
    >
      <path d="M12 6.5c-2.2-1.4-5.2-1.7-8-1.2v13c2.8-.5 5.8-.2 8 1.2m0-13c2.2-1.4 5.2-1.7 8-1.2v13c-2.8-.5-5.8-.2-8 1.2m0-13v13" />
    </svg>
  );
}

function QueueGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[calc(26*var(--cpx))] shrink-0"
    >
      <path d="M4 13.5h16M6 13.5v2a3.5 3.5 0 0 0 3.5 3.5h5a3.5 3.5 0 0 0 3.5-3.5v-2" />
      <path d="M9.5 6.5c0 1.2 1 1.8 1 3M14 5.5c0 1.4 1 2 1 3.5" />
    </svg>
  );
}

function IngredientsGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[calc(26*var(--cpx))] shrink-0"
    >
      <path d="M6.5 17.5c1.5-5.5 5.5-9.5 11.5-11-.8 6-4.5 10-11.5 11Z" />
      <path d="M5.5 18.5 12 12" />
      <path d="M17 15v5M14.5 17.5h5" />
    </svg>
  );
}

function ShoppingListGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[calc(26*var(--cpx))] shrink-0"
    >
      <path d="M5 7h2.5M10 7h9M5 12h2.5M10 12h9M5 17h2.5M10 17h9" />
    </svg>
  );
}

function ImportGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[calc(26*var(--cpx))] shrink-0"
    >
      <path d="M12 4.5v10m0 0-3.5-3.5M12 14.5l3.5-3.5" />
      <path d="M5.5 15.5v2A2.5 2.5 0 0 0 8 20h8a2.5 2.5 0 0 0 2.5-2.5v-2" />
    </svg>
  );
}

function AskGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[calc(26*var(--cpx))] shrink-0"
    >
      <path d="M12 4.5c4.7 0 8.5 3.1 8.5 7 0 2.1-1.1 4-2.9 5.3l.7 3.2-3.6-1.6c-.9.2-1.8.3-2.7.3-4.7 0-8.5-3.1-8.5-7.2S7.3 4.5 12 4.5Z" />
    </svg>
  );
}

function PullTabGlyph({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[calc(26*var(--cpx))] shrink-0"
    >
      <path d={open ? "M11 7l5 5-5 5" : "M14 7l-5 5 5 5"} />
      <circle cx="17.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="16" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
