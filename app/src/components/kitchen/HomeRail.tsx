"use client";

import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Link from "next/link";
import type { FootWord } from "@/lib/kitchen/home-view";
import { ASK_COPY } from "./AskSous";
import { FOCUS } from "./control-style";
import { useMenuDismiss } from "./CookMenu";
import { COOKPACKS_HREF } from "./HomeFoot";
import { HOME_MORE_COPY } from "./HomeMore";
import { Glyph, type GlyphName } from "./home-rail-glyphs";
import { SignOutRow, SignOutScope, SignOutStatus } from "./SignOutItem";

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

/** The rail's and the panel's glyph size in cpx (§5, the kitchen home). */
const GLYPH_CPX = 32;

/** One rail slot: a target tall plus the nav's 2 cpx gap. The panel's rows keep the same pitch so each stands level with its rail icon. */
const SLOT_CPX = 82;

const LONG_PRESS_MS = 320;
const DRAG_OPEN_PX = 14;

const RAIL_ICON_BTN = `group/icon relative inline-flex size-[var(--target)] shrink-0 cursor-pointer items-center justify-center rounded-full text-[length:var(--type-meta)] text-ink-soft transition-colors duration-[320ms] ease-[var(--ease)] hover:text-ink active:bg-sand ${FOCUS}`;

/** The panel row's glyph cell: the rail icon's own column, so each glyph stands exactly where the rail draws it. */
const ICON_CELL = "flex size-[var(--target)] shrink-0 items-center justify-center";

/** The name that fades in beside a rail icon on hover or keyboard focus. Hover-capable pointers only: a touch screen has no hover to show it. */
const RAIL_TIP = `pointer-events-none absolute right-[calc(100%+4*var(--cpx))] top-1/2 -translate-y-1/2 whitespace-nowrap rounded-[var(--radius-2)] border border-ink/[.14] bg-paper px-[calc(14*var(--cpx))] py-[calc(8*var(--cpx))] text-[length:var(--type-meta)] leading-none font-medium text-ink opacity-0 transition-opacity duration-[200ms] ease-[var(--ease)] group-focus-visible/icon:opacity-100 group-hover/icon:opacity-100`;

/** Why Sign out failed: a line under the rows, outside the menu, its words in line with the rows' names. */
const SIGN_OUT_LINE =
  "py-[calc(12*var(--cpx))] pr-[calc(22*var(--cpx))] pl-[calc(92*var(--cpx))] text-[length:var(--type-meta)] leading-tight text-ink-soft";

/** A panel row: the name on the left, its glyph in the rail's own column on the right, so the panel reads as the rail unfolded. */
const TAB_ROW = `flex w-full min-h-[var(--target)] cursor-pointer items-center pl-[calc(92*var(--cpx))] text-left text-[length:var(--type-meta)] leading-tight font-medium text-ink shadow-[inset_0_-1px_0_color-mix(in_oklab,var(--ink)_8%,transparent)] transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ink`;

/**
 * Right-edge appliance icon rail for `/kitchen`:
 * - Direct 1-tap etched line icons for Cookpacks, Up next / queue, Add ingredients, and Import.
 * - Long-pressing (320 ms), dragging left along the bar, or tapping the pull-out handle ("More")
 *   fades in a warm `--paper` panel naming each icon, level with it, and surfacing the destinations the
 *   rail doesn't have (Ask Sous, Shopping list, and Sign out in sign-in mode). The handle is the way out.
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
  const draw = (name: GlyphName) => <Glyph name={name} size={GLYPH_CPX} />;
  // Ask Sous leads the panel, one slot above the rail's first icon, so the rows below it stand level with the rail's icons.
  const rowsAbove = onOpenAsk ? 1 : 0;

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
          {draw("cookpacks")}
          <span aria-hidden="true" className={RAIL_TIP}>{cookpacks}</span>
        </Link>

        {/* 2. Direct 1-tap Import */}
        <button
          type="button"
          data-rail-import
          aria-label="Import recipe"
          onClick={onOpenImport}
          className={RAIL_ICON_BTN}
        >
          {draw("import")}
          <span aria-hidden="true" className={RAIL_TIP}>Import recipe</span>
        </button>

        {/* 3. Up next / Under way / Made recently */}
        {word ? (
          <button
            type="button"
            data-foot-queue
            data-return-focus="queue"
            aria-label={word.label}
            onClick={onOpenQueue}
            className={RAIL_ICON_BTN}
          >
            {draw("queue")}
            <span aria-hidden="true" className={RAIL_TIP}>{word.label}</span>
          </button>
        ) : !ready ? (
          <span aria-hidden="true" className="size-[var(--target)] shrink-0" />
        ) : null}

        {/* 4. Add ingredients */}
        {onOpenAddIngredients && (
          <button
            type="button"
            aria-label={addIngredientsLabel}
            onClick={onOpenAddIngredients}
            className={RAIL_ICON_BTN}
          >
            {draw("ingredients")}
            <span aria-hidden="true" className={RAIL_TIP}>{addIngredientsLabel}</span>
          </button>
        )}

        {/* 5. Pull-out tab handle ("More"): also opens on long-press or drag-left, and closes the panel while it is open */}
        <button
          ref={button}
          type="button"
          data-rail-pull
          aria-label={HOME_MORE_COPY.more}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpenState(!open)}
          // Open, the panel and its left-edge strip are the way out. The handle hides rather than standing
          // as a second chevron under a panel too short to cover it (no Shopping list, no Sign out).
          className={open ? `${RAIL_ICON_BTN} pointer-events-none opacity-0` : RAIL_ICON_BTN}
        >
          {draw(open ? "pullOpen" : "pull")}
          <span aria-hidden="true" className={RAIL_TIP}>{HOME_MORE_COPY.more}</span>
        </button>
      </nav>

      {/*
        The pull-out: a paper panel at the rail's left edge that fades in over 320 ms (200 ms under reduced motion;
        §3 allows only fades). Its rows keep the rail's pitch, so each destination the rail has stands level with
        its own icon, with its name beside it; Ask Sous sits above the first and the rest below the last. The panel
        is as tall as its rows and never taller than the screen: six rows (every hook connected) are 490 cpx, and a
        landscape screen is 600.
        Sign out is a row only in sign-in mode, which refuses connected hooks, so with it the panel
        has at most five rows and room under them for why a sign-out failed. The menu is the rows alone: the
        way out and that line are the panel's, outside it.
      */}
      {open && (
        <SignOutScope>
          <div
            data-rail-tab
            data-holds-keys
            {...panelFocus}
            style={{ top: `calc(${6 - SLOT_CPX * rowsAbove} * var(--cpx) - 1px)` }}
            className="absolute right-0 z-40 w-[calc(440*var(--cpx))] max-w-[calc(100vw-var(--edge)-30*var(--cpx))] overflow-hidden rounded-[var(--radius-2)] border border-ink/[.14] bg-paper opacity-100 shadow-none transition-opacity duration-[320ms] ease-[var(--ease)] starting:opacity-0 motion-reduce:duration-[200ms]"
          >
            {/* The way out: a chevron strip down the panel's left edge, pointing back toward the rail. The panel covers the More handle, so this closes it. */}
            <button
              type="button"
              data-rail-close
              aria-label="Close"
              onClick={choose()}
              className={`absolute inset-y-0 left-0 flex w-[var(--target)] cursor-pointer items-center justify-center text-ink-soft transition-colors duration-[320ms] ease-[var(--ease)] hover:text-ink active:bg-sand ${FOCUS}`}
            >
              {draw("pullOpen")}
            </button>

            <div id={menuId} role="menu" className="flex flex-col gap-y-[calc(2*var(--cpx))]">
              {onOpenAsk && (
                <button type="button" role="menuitem" onClick={choose(onOpenAsk)} className={TAB_ROW}>
                  <span className="flex-1">{ASK_COPY.title}</span>
                  <span className={ICON_CELL}>{draw("ask")}</span>
                </button>
              )}

              <Link href={COOKPACKS_HREF} role="menuitem" onClick={() => setOpenState(false)} className={TAB_ROW}>
                <span className="flex-1">{cookpacks}</span>
                <span className={ICON_CELL}>{draw("cookpacks")}</span>
              </Link>

              <button type="button" role="menuitem" onClick={choose(onOpenImport)} className={TAB_ROW}>
                <span className="flex-1">{HOME_MORE_COPY.import}</span>
                <span className={ICON_CELL}>{draw("import")}</span>
              </button>

              {word && (
                <button type="button" role="menuitem" onClick={choose(onOpenQueue)} className={TAB_ROW}>
                  <span className="flex-1">{word.label}</span>
                  <span className={ICON_CELL}>{draw("queue")}</span>
                </button>
              )}

              {onOpenAddIngredients && (
                <button type="button" role="menuitem" onClick={choose(onOpenAddIngredients)} className={TAB_ROW}>
                  <span className="flex-1">{addIngredientsLabel}</span>
                  <span className={ICON_CELL}>{draw("ingredients")}</span>
                </button>
              )}

              {onOpenShoppingList && (
                <button type="button" role="menuitem" onClick={choose(onOpenShoppingList)} className={TAB_ROW}>
                  <span className="flex-1">{HOME_MORE_COPY.shoppingList}</span>
                  <span className={ICON_CELL}>{draw("shopping")}</span>
                </button>
              )}

              <SignOutRow rowClassName={TAB_ROW} icon={<span className={ICON_CELL}>{draw("signOut")}</span>} />
            </div>
            <SignOutStatus className={SIGN_OUT_LINE} />
          </div>
        </SignOutScope>
      )}
      </aside>
    </>
  );
}
