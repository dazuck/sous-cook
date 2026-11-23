"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import {
  type CreatorOnShelf,
  type HouseholdOnShelf,
  type HouseholdState,
  type ShelfView,
} from "@/lib/shelf/view";
import { LABEL } from "@/components/kitchen/KitchenHome";
import { ClothCover } from "./ClothCover";
import { CLOTH_EDGE, clothSurface } from "./cloth";
import { COOKPACKS_COPY } from "./copy";
import { useWordFit } from "./word-fit";

/** The household title's sizes, largest first: the chip, then the floor. */
const HOUSEHOLD_TITLE_SIZES = ["var(--type-chip)", "var(--type-meta)"] as const;

/** A pack's way in: its view's route. */
export const packHref = (id: string) => `/kitchen/cookpacks/${encodeURIComponent(id)}`;

/** The mark a pack's way in carries, so focus comes back to it from its view. */
export const packReturnKey = (id: string) => `pack:${id}`;

/**
 * A book's press: sand under it while pressed, reaching a little past its
 * edges, and the focus ring outside it. No fill at rest.
 */
const BOOK_TAP = `relative isolate block rounded-[var(--radius-1)] outline-none after:absolute after:-inset-[calc(10*var(--cpx))] after:-z-10 after:rounded-[var(--radius-2)] after:transition-colors after:duration-[320ms] after:ease-[var(--ease)] after:content-[''] active:after:bg-sand focus-visible:after:outline-3 focus-visible:after:outline-ink`;

/**
 * The household pack's label under the shelf: "50 recipes". When it was
 * synced is the pack view's to say ("50 recipes · synced Oct 4" there); on
 * the shelf it wrapped under the 198 cpx book (feel pass craft fix 2).
 */
export function householdLabel(household: HouseholdOnShelf): string {
  if (household.state === "unreadable") return COOKPACKS_COPY.unreadable;
  if (household.state === "empty" && household.missing > 0) return COOKPACKS_COPY.noneCookLabel(household.missing);
  if (household.state === "empty" || household.syncedAt === null) return COOKPACKS_COPY.emptyLabel;
  return COOKPACKS_COPY.recipes(household.cookable);
}

/**
 * "Saved for later" as a slender bookmark slip tucked into the top edge of
 * the household book (P77). Its words are at the meta's 22 cpx, the floor
 * (DS §2; R26 set them at 13 cpx), so it stands 44 cpx proud of the book's
 * top edge, reading "Saved for later" and its count.
 */
function SavedSlip({ ideas, onOpen }: { ideas: number | null; onOpen: () => void }) {
  const count = ideas !== null && ideas > 0 ? ideas : null;
  return (
    <button
      type="button"
      data-saved-for-later
      data-return-focus="saved-for-later"
      onClick={onOpen}
      aria-label={count === null ? COOKPACKS_COPY.saved : `${COOKPACKS_COPY.saved}, ${COOKPACKS_COPY.savedCount(count)}`}
      className="group absolute bottom-full left-[var(--space-3)] z-20 flex h-[var(--target)] cursor-pointer items-end outline-none"
    >
      <span
        data-slip
        className="flex h-[calc(44*var(--cpx))] items-center gap-[var(--space-2)] rounded-t-[calc(3*var(--cpx))] border border-b-0 border-ink/[.16] bg-paper px-[var(--space-3)] text-[length:var(--type-meta)] leading-none font-medium whitespace-nowrap text-ink transition-colors duration-[320ms] ease-[var(--ease)] group-focus-visible:outline-3 group-focus-visible:outline-offset-3 group-focus-visible:outline-ink group-active:bg-sand group-data-[pressed]:bg-sand"
      >
        <span className="font-semibold text-ink">{COOKPACKS_COPY.saved}</span>
        {count !== null && <span className="font-medium text-ink-soft tabular-nums">{count}</span>}
      </span>
    </button>
  );
}

/** A creator's book on the shelf: its cloth board, which opens its view. */
function CreatorBook({ pack }: { pack: CreatorOnShelf }) {
  return (
    <Link
      href={packHref(pack.id)}
      data-creator-book={pack.id}
      data-return-focus={packReturnKey(pack.id)}
      aria-label={`${pack.title}, ${pack.creator}, ${COOKPACKS_COPY.recipes(pack.recipes)}`}
      className={`${BOOK_TAP} shrink-0`}
    >
      <ClothCover title={pack.title} cloth={pack.cloth} />
    </Link>
  );
}

/** A book's shelf-edge label: the creator in Figtree 600, then one fact. */
function CreatorLabel({ pack }: { pack: CreatorOnShelf }) {
  return (
    <div className="w-[calc(198*var(--cpx))] shrink-0 last:w-auto last:min-w-[calc(198*var(--cpx))]">
      <p className="text-[length:var(--type-meta)] leading-[1.3] font-semibold text-ink">{pack.creator}</p>
      <p className={`${LABEL} leading-[1.3]`}>{COOKPACKS_COPY.recipes(pack.recipes)}</p>
    </div>
  );
}

/** The household pack's illustrated cover art (4:5 portrait, carries title). */
export const HOUSEHOLD_COVER_SRC = "/kitchen/household-cover.webp";

/**
 * The household pack cover (P77, amends P52): a warm standing volume
 * bound in flax cloth (#D8C9A9) carrying the Household Book cover art
 * (or the inset debossed panel fallback when the doc is unreadable).
 */
export function HouseholdCover({
  title,
  state,
}: {
  title: string;
  state: HouseholdState;
}) {
  const unreadable = state === "unreadable";
  const titleRef = useRef<HTMLSpanElement>(null);
  const titleStyle = useWordFit(titleRef, HOUSEHOLD_TITLE_SIZES, title);
  return (
    <span
      aria-hidden
      data-household-cover
      className={`relative block h-[calc(248*var(--cpx))] w-[calc(198*var(--cpx))] overflow-hidden rounded-[var(--radius-1)] ${CLOTH_EDGE}`}
      style={clothSurface("flax")}
    >
      {!unreadable && (
        <>
          <img
            data-household-cover-art
            src={HOUSEHOLD_COVER_SRC}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-cover select-none"
          />
          <span className="sr-only">{title}</span>
        </>
      )}
      {/* The hinge: a groove 14 cpx in from the spine edge */}
      <span className="pointer-events-none absolute inset-y-0 left-[calc(14*var(--cpx))] z-10 w-[calc(3*var(--cpx))] bg-[linear-gradient(90deg,rgb(20_10_0/0.18),rgb(255_255_255/0.25))]" />
      {/* 1px inset hairline edge above the cover artwork */}
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 z-10 rounded-[var(--radius-1)] ${CLOTH_EDGE}`}
      />
      {unreadable && (
        <span className="absolute top-1/2 right-[calc(14*var(--cpx))] left-[calc(28*var(--cpx))] z-10 -translate-y-[54%] rounded-[calc(3*var(--cpx))] border border-ink/[.16] bg-paper/[.18] px-[calc(8*var(--cpx))] py-[calc(14*var(--cpx))] text-center">
          <span
            ref={titleRef}
            data-cover-title
            style={titleStyle}
            className="block font-[family-name:var(--font-display)] leading-[1.12] font-normal text-ink [font-synthesis:none]"
          >
            {title}
          </span>
          <span className="mt-[calc(6*var(--cpx))] block text-[length:var(--type-meta)] leading-[1.25] font-medium text-ink-soft">
            {COOKPACKS_COPY.unreadable}
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * The household book standing on the shelf: its cover plus tucked slip.
 */
function HouseholdBook({
  household,
  ideas,
  onOpenSaved,
}: {
  household: HouseholdOnShelf;
  ideas: number | null;
  onOpenSaved: () => void;
}) {
  const unreadable = household.state === "unreadable";
  const box = "relative block h-[calc(248*var(--cpx))] w-[calc(198*var(--cpx))] shrink-0";

  return (
    <div className="relative isolate shrink-0">
      <SavedSlip ideas={ideas} onOpen={onOpenSaved} />
      {unreadable ? (
        <div data-household aria-label={household.title} className={box}>
          <HouseholdCover title={household.title} state={household.state} />
        </div>
      ) : (
        <Link
          href={packHref(household.id)}
          data-household
          data-return-focus={packReturnKey(household.id)}
          aria-label={`${household.title}, ${householdLabel(household)}`}
          className={`${BOOK_TAP} ${box}`}
        >
          <HouseholdCover title={household.title} state={household.state} />
        </Link>
      )}
    </div>
  );
}

/**
 * How many creator books stand on the idle home's one row beside the household
 * book (F14): as many as the width holds, counted from the books' own width
 * and the row's gap. The rest are Cookpacks's, one tap away in the foot.
 */
function useOneRow(
  host: React.RefObject<HTMLDivElement | null>,
  row: React.RefObject<HTMLDivElement | null>,
  total: number,
  on: boolean,
  hasHousehold: boolean,
) {
  const [shown, setShown] = useState(total);
  useLayoutEffect(() => {
    if (!on) return;
    const hostEl = host.current;
    const rowEl = row.current;
    if (!hostEl || !rowEl) return;
    const measure = () => {
      const book = rowEl.querySelector<HTMLElement>("[data-household], [data-creator-book]");
      if (!book || book.offsetWidth === 0) return;
      const gap = parseFloat(getComputedStyle(rowEl).columnGap) || 0;
      const perRow = Math.max(1, Math.floor((hostEl.clientWidth + gap) / (book.offsetWidth + gap)));
      setShown(Math.max(0, perRow - (hasHousehold ? 1 : 0)));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(hostEl);
    return () => observer?.disconnect();
  }, [host, row, on, total, hasHousehold]);
  return on ? Math.min(shown, total) : total;
}

/**
 * The Cookpacks shelf (S-D3, redesigned in P77): books standing in a quiet
 * row on a 1px hairline board, each labelled beneath like a shelf-edge label.
 * The household book stands first as a warm flax volume with its tucked
 * "Saved for later" slip, followed by creator cloth boards.
 */
export function Shelf({
  view,
  onOpenSaved,
  oneRow = false,
}: {
  view: ShelfView;
  onOpenSaved: () => void;
  /** The idle home's shelf: one centred row of as many books as fit (F14). */
  oneRow?: boolean;
}) {
  const { household } = view;
  const host = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const count = useOneRow(host, row, view.creators.length, oneRow, household !== null);
  const creators = view.creators.slice(0, count);
  return (
    <div ref={host} className="flex w-full flex-col items-center">
      <div
        data-shelf
        // The home's body sets --shelf-fit on its frame at a short body (D14): the covers
        // scale, the type tokens (already resolved at :root) never do.
        style={{ "--cpx": "calc(var(--cpx-full) * var(--shelf-fit, 1))" } as React.CSSProperties}
        // The shelf starts a target down (DS §6), so the slip's 80 cpx target,
        // which stands above the household book, is whole on the page and
        // clear of the kind line. R26 had 38 cpx here, and the kind line's
        // row took the slip's taps (cookpacks.spec "Saved for later").
        className={`flex flex-col pt-[var(--target)] ${oneRow ? "w-fit max-w-full" : "w-full"}`}
      >
        {/* Books row standing on the shelf line */}
        <div ref={row} className={`flex items-end ${oneRow ? "flex-nowrap" : "flex-wrap"} gap-x-[var(--space-6)] gap-y-[calc(36*var(--cpx))]`}>
          {household !== null && (
            <HouseholdBook household={household} ideas={view.ideas} onOpenSaved={onOpenSaved} />
          )}
          {creators.map((pack) => (
            <CreatorBook key={pack.id} pack={pack} />
          ))}
        </div>

        {/* Shelf board hairline */}
        <div aria-hidden data-shelf-board className={`mt-0 h-px bg-ink/[.18] ${oneRow ? "-mx-[var(--space-4)] w-[calc(100%+2*var(--space-4))]" : "w-full"}`} />

        {/* Shelf labels row directly under the books */}
        <div className="flex flex-wrap gap-x-[var(--space-6)] pt-[calc(14*var(--cpx))]">
          {household !== null && (
            <div className="w-[calc(198*var(--cpx))] shrink-0">
              <p data-household-label className={`${LABEL} leading-[1.3]`}>
                {householdLabel(household)}
              </p>
            </div>
          )}
          {creators.map((pack) => (
            <CreatorLabel key={pack.id} pack={pack} />
          ))}
        </div>
      </div>
    </div>
  );
}
