"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import type { FlagAck, FlagNoteProps } from "@/hooks/useCookFlag";
import type { CookView } from "@/lib/kitchen/cook-view";
import { dishName } from "@/lib/kitchen/dish-name";
import { EDGE_X } from "./cook-edge";
import { HeaderMore } from "./HeaderMore";

/**
 * The top line's one open menu, if any: the cook view holds it. "flag" is the
 * flag's note, hung where More's menu was (cook-fidelity decision 8).
 */
export type HeaderMenu = "more" | "flag" | null;

/** The place's rungs, longest first (N2-6). */
export type PlaceRung = "long" | "short" | "count";
const RUNGS: readonly PlaceRung[] = ["long", "short", "count"];

/**
 * The place's rung for the room the top line has (N2-6): the longest that
 * fits beside the dish's whole name (and its scale note when present), else
 * the count, and the name truncates. Widths in px: `room` the left of the line
 * (the row less More's cell and the gap), `nameW` the name's own width, `sepW`
 * the " · " between them, `scaleNoteW` the sibling "for 8" width.
 */
export function placeRung(
  room: number,
  nameW: number,
  sepW: number,
  rungW: Record<PlaceRung, number>,
  scaleNoteW = 0,
): PlaceRung {
  for (const rung of RUNGS) {
    if (nameW + scaleNoteW + sepW + rungW[rung] <= room + 0.5) return rung;
  }
  return "count";
}

interface RecipeHeaderProps {
  name: string;
  /** The active scale suffix ("for 8") when servings !== serves_base (B5c-4). */
  scaleNote?: string | null;
  /** Where the cook is (`view.place`); omitted when the bottom strip carries progress. */
  place?: CookView["place"];
  /** The place opens the whole cook's chart (N2-6). */
  onPlace?: () => void;
  onShowInfo?: () => void;
  currentQueueItemId?: string;
  /** Other recipes in progress, listed in More (default on). */
  showRecentItems?: boolean;
  /**
   * Whether More is open, held by the cook view: voice's "close" takes it
   * before what is under it, and a borrowed screen shuts it.
   */
  menu: HeaderMenu;
  onMenu: (menu: HeaderMenu) => void;
  /** The flag in More, and how the last one went (B2). */
  onFlag?: () => void;
  flagAck?: FlagAck;
  /** The note on the flag just taken by touch (decision 8; `useFlagNote`). */
  flagNote?: FlagNoteProps;
}

/**
 * The cook view's top line (slice V; DS §6's chrome band): at the left the
 * recipe's name; at the right More. Recipe info lives in More.
 *
 * It sits straight on the ground, with no band, blur or shadow, and hangs off
 * the steps' edges, so the two read as one surface. A recipe with no name is
 * "Untitled recipe" (`dishName`).
 */
export function RecipeHeader({
  name,
  scaleNote = null,
  place = null,
  onPlace,
  onShowInfo,
  currentQueueItemId,
  showRecentItems = true,
  menu,
  onMenu,
  onFlag,
  flagAck,
  flagNote,
}: RecipeHeaderProps) {
  const shown = dishName(name);
  const row = useRef<HTMLDivElement>(null);
  const moreCell = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [rung, setRung] = useState<PlaceRung>("long");

  // The rung is read from the words' own widths, measured off-screen in the
  // line's type, against the room the line has: again on a resize, a new
  // place and the faces arriving.
  const long = place?.long ?? "";
  const short = place?.short ?? "";
  const count = place?.count ?? "";
  useLayoutEffect(() => {
    const line = row.current;
    const more = moreCell.current;
    const words = probe.current;
    if (!line || !more || !words) return;
    const width = (key: string) => words.querySelector<HTMLElement>(`[data-probe="${key}"]`)!.getBoundingClientRect().width;
    const fit = () => {
      const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
      const room = line.clientWidth - more.getBoundingClientRect().width - gap;
      const scaleW = words.querySelector<HTMLElement>('[data-probe="scale"]')?.getBoundingClientRect().width ?? 0;
      setRung(
        placeRung(
          room,
          width("name"),
          width("sep"),
          { long: width("long"), short: width("short"), count: width("count") },
          scaleW,
        ),
      );
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(line);
    ro.observe(more);
    document.fonts.addEventListener("loadingdone", fit);
    return () => {
      ro.disconnect();
      document.fonts.removeEventListener("loadingdone", fit);
    };
  }, [shown, scaleNote, long, short, count]);

  const words = place ? place[rung] : null;
  return (
    <header className={`sticky top-0 z-20 bg-ground py-[calc(6*var(--cpx))] ${EDGE_X}`}>
      <div
        ref={row}
        className="relative flex h-[var(--target)] items-center justify-between gap-[var(--space-3)] text-[length:var(--type-meta)] leading-none font-medium text-ink-soft"
      >
        <div className="flex min-w-0 items-center">
          <Link
            href="/kitchen"
            prefetch={false}
            data-header-back
            aria-label="Back to the kitchen"
            className="relative -ml-[calc(38*var(--cpx))] mr-[calc(4*var(--cpx))] inline-flex h-[var(--target)] w-[calc(34*var(--cpx))] shrink-0 items-center justify-center rounded-full text-ink-soft transition-colors duration-[320ms] ease-[var(--ease)] after:absolute after:inset-y-0 after:-inset-x-[calc(24*var(--cpx))] hover:text-ink active:bg-sand focus-visible:outline-3 focus-visible:outline-ink"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="size-[calc(26*var(--cpx))] shrink-0"
            >
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </Link>
          <h1 className="min-w-0 truncate py-[0.2em] font-semibold text-ink">{shown}</h1>
          {scaleNote && (
            <span
              data-scale-note
              className="ml-[0.35em] shrink-0 text-[length:var(--type-meta)] font-medium text-ink-soft"
            >
              {scaleNote}
            </span>
          )}
          {place && words !== null && (
            <>
              <span aria-hidden className="shrink-0 px-[0.35em]">
                ·
              </span>
              <button type="button" data-place data-place-rung={rung} onClick={onPlace} className={PLACE}>
                {words}
              </button>
            </>
          )}
        </div>
        <div ref={moreCell} data-more-cell className="flex shrink-0 items-center">
          <HeaderMore
            open={menu === "more"}
            onOpenChange={(open) => onMenu(open ? "more" : null)}
            onShowInfo={onShowInfo}
            currentItemId={currentQueueItemId}
            showRecentItems={showRecentItems}
            onFlag={onFlag}
            flagAck={flagAck}
            flagNote={flagNote}
          />
        </div>
        {/* The ladder's rulers: the name and every rung in the line's own type, never seen. */}
        {place && (
          <span
            ref={probe}
            aria-hidden
            data-capture-omit
            className="pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap"
          >
            <span data-probe="name" className="font-semibold">
              {shown}
            </span>
            {scaleNote && (
              <span data-probe="scale" className="ml-[0.35em] font-medium">
                {scaleNote}
              </span>
            )}
            <span data-probe="sep" className="px-[0.35em]">
              ·
            </span>
            <span data-probe="long">{long}</span>
            <span data-probe="short">{short}</span>
            <span data-probe="count">{count}</span>
          </span>
        )}
      </div>
    </header>
  );
}

/**
 * The place: a ghost in the eyebrow's words, ink-soft at the meta size, on a
 * target-tall hit area; a press shows sand, as every ghost on the cook
 * screen. It never shrinks: the ladder picks words that fit, and the dish's
 * name is what truncates once the count alone is left.
 */
const PLACE =
  "inline-flex h-[var(--target)] shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full px-[calc(10*var(--cpx))] -mx-[calc(10*var(--cpx))] text-ink-soft transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-3 focus-visible:outline-ink";
