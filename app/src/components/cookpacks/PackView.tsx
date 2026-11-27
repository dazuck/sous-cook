"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EDGE_X } from "@/components/kitchen/cook-edge";
import { MENU_PANEL, useMenuDismiss } from "@/components/kitchen/CookMenu";
import { ACTION, ACTION_AT_REST, FOCUS, LABEL, ROW_TAP, Row } from "@/components/kitchen/KitchenHome";
import { ACTION_IN_FORCE } from "@/components/kitchen/control-style";
import { WIDTH } from "@/components/kitchen/ReportsPanel";
import { footMask, useMoreBelow } from "@/hooks/useMoreBelow";
import { usePortrait } from "@/hooks/usePortrait";
import {
  kitchenDate,
  missingRows,
  rowFact,
  searchRows,
  type FlatRow,
  type PackChapterView,
  type PackPageView,
  type PackRowView,
} from "@/lib/shelf/view";
import { clothSurface } from "./cloth";
import { ContentsLine } from "./Contents";
import { COOKPACKS_COPY } from "./copy";

/** Refresh, the household view's action word (S-D13). */
export interface RefreshControl {
  pending: boolean;
  /** The one status line: what the last Refresh said, in ink when it is trouble. */
  status: { text: string; trouble: boolean } | null;
  onRefresh: () => void;
}

export interface CircleShareControl {
  kitchens: Array<{
    kitchenId: string;
    slug: string;
    name: string;
    shared: boolean;
  }>;
  pending: boolean;
  onToggle: (kitchenId: string, shared: boolean) => void;
}

export interface CollectionOwnerActions {
  editHref: string;
  removing: boolean;
  onRemove: () => void;
}

export interface PackViewProps {
  view: PackPageView;
  /** The household pack's Refresh; absent for a creator pack. */
  refresh?: RefreshControl;
  /** The row being queued, while it is. */
  sendingId: string | null;
  /** Why the last tapped row didn't reach the queue. */
  sendFailure: string | null;
  onPick: (rowId: string) => void;
  /** Toggles per-recipe privacy when viewing the household book. */
  onTogglePrivate?: (rowId: string, isPrivate: boolean) => void;
  /** Copies a share link for a non-private household book recipe (sign-in mode). */
  onCopyShareLink?: (docRecipeId: string) => Promise<boolean> | boolean;
  /** Owner-only switches for sharing an owned pack with circle kitchens (sign-in mode). */
  circleSharing?: CircleShareControl;
  /** Owner-only actions for updating or removing an owned collection. */
  ownerActions?: CollectionOwnerActions;
  /** The chapter the URL names (`#baking`); the view opens there if it has it. */
  initialAnchor?: string | null;
  /** The URL follows the chapter a choice in the menu goes to. */
  onAnchor?: (anchor: string) => void;
}

/** How far under the list's top a chapter's head lands when the menu goes to it. */
const HEAD_ROOM = 16;

/** A chapter head: Caprasimo at the chip's 30 cpx, as the Doc writes its name (DS §4). */
const CHAPTER_HEAD =
  "font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-none font-normal text-ink [font-synthesis:none]";

/** The search field: on the ground over an ink-soft line, the library's. */
function SearchField({ value, onChange, className = "" }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <div className={`relative min-w-[min(100%,calc(240*var(--cpx)))] ${className}`}>
      <svg
        aria-hidden
        className="pointer-events-none absolute bottom-[calc(28*var(--cpx))] left-0 size-[var(--type-meta)] text-ink-soft"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <input
        type="search"
        // Escape typed here stays here, rather than leaving the book.
        data-holds-keys
        aria-label={COOKPACKS_COPY.search}
        placeholder={COOKPACKS_COPY.search}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-[var(--target)] w-full border-b border-ink-soft bg-transparent pl-[calc(40*var(--cpx))] font-[family-name:var(--font-text)] text-[length:var(--type-meta)] font-medium text-ink placeholder:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-search-cancel-button]:hidden"
      />
    </div>
  );
}

function RefreshWord({ refresh, className = "" }: { refresh: RefreshControl; className?: string }) {
  return (
    <button
      type="button"
      data-refresh
      onClick={refresh.onRefresh}
      disabled={refresh.pending}
      className={`${ACTION} ${ACTION_AT_REST} disabled:cursor-default disabled:before:border-ink/[.11] ${className}`}
    >
      {refresh.pending ? COOKPACKS_COPY.refreshing : COOKPACKS_COPY.refresh}
    </button>
  );
}

/** The down chevron after the chapter word. */
function Down() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[calc(20*var(--cpx))] shrink-0"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * The chapters menu (S-D6): the running head's chapter word, a ghost on a
 * target-tall hit area, opens the book's contents again, a lifted Paper
 * panel under the head (the cook's chapters-menu make): entries a target
 * tall, three columns in landscape and two in portrait, each a name, a
 * dotted leader and a count, the chapter in view at 600. A choice scrolls
 * the list to that chapter's head; Escape, a tap outside, or a choice
 * closes it. Past the screen's height the panel scrolls inside itself.
 */
function ChapterWord({
  chapters,
  here,
  onChapter,
  menuRoot,
  columns,
}: {
  chapters: { anchor: string; title: string; count: number }[];
  /** Three in landscape (two for four chapters or fewer), two in portrait. */
  columns: number;
  here: string;
  onChapter: (anchor: string) => void;
  menuRoot: React.RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { choose, panelFocus } = useMenuDismiss(open, setOpen, menuRoot, button);
  const hereEntry = chapters.find((c) => c.anchor === here) ?? chapters[0]!;
  return (
    <>
      <span aria-hidden className="shrink-0 text-[length:var(--type-meta)] text-ink-soft">
        ·
      </span>
      <button
        ref={button}
        type="button"
        data-chapter-word
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={COOKPACKS_COPY.chapterLabel(hereEntry.title)}
        onClick={() => setOpen(!open)}
        className={`-ml-[calc(10*var(--cpx))] inline-flex h-[var(--target)] min-w-0 shrink cursor-pointer items-center gap-[calc(8*var(--cpx))] rounded-full px-[calc(14*var(--cpx))] text-[length:var(--type-meta)] whitespace-nowrap transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand ${FOCUS} ${open ? "font-semibold text-ink" : "font-medium text-ink-soft"}`}
      >
        <span className="min-w-0 truncate">{hereEntry.title}</span>
        <Down />
      </button>
      {open && (
        <div
          id={menuId}
          data-holds-keys
          data-chapters-menu
          {...panelFocus}
          className={`${MENU_PANEL} top-full right-[calc(var(--edge)-12*var(--cpx))] left-[calc(var(--edge)-12*var(--cpx))] max-h-[calc(100dvh-var(--band-foot)-75px-var(--target)-16px)] overflow-y-auto px-[calc(24*var(--cpx))] py-[calc(10*var(--cpx))]`}
        >
          <nav aria-label={COOKPACKS_COPY.chapters}>
            {/* Three columns in landscape, two in portrait; a book of four
                chapters or fewer keeps the shelf's two, so none is left alone. */}
            <ul
              className="grid gap-x-[calc(44*var(--cpx))]"
              // Read down the columns, as the shelf's contents are.
              style={{
                gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${String(Math.ceil(chapters.length / columns))}, auto)`,
                gridAutoFlow: "column",
              }}
            >
              {chapters.map((c) => {
                const isHere = c.anchor === hereEntry.anchor;
                return (
                  <li key={c.anchor} className="min-w-0">
                    <button
                      type="button"
                      data-chapter-entry={c.anchor}
                      aria-current={isHere ? "location" : undefined}
                      onClick={choose(() => onChapter(c.anchor))}
                      className={`flex min-h-[var(--target)] w-full cursor-pointer items-baseline gap-[calc(8*var(--cpx))] rounded-[var(--radius-1)] pt-[calc(26*var(--cpx))] text-left text-[length:var(--type-meta)] leading-tight text-ink transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ink ${isHere ? "font-semibold" : "font-medium"}`}
                    >
                      <ContentsLine entry={c} here={isHere} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      )}
    </>
  );
}

/** One row of the book: a §6 row (P44) that queues its recipe, or a missing one, named (S-D8). */
function PackRow({
  row,
  chapter,
  sendingId,
  copiedShareId,
  onPick,
  onTogglePrivate,
  onCopyShareLink,
}: {
  row: PackRowView;
  chapter?: string | null;
  sendingId: string | null;
  copiedShareId?: string | null;
  onPick: (id: string) => void;
  onTogglePrivate?: (rowId: string, isPrivate: boolean) => void;
  onCopyShareLink?: (docRecipeId: string) => void;
}) {
  const fact = rowFact(row, chapter).join(" ");
  const isPrivate = Boolean(row.isPrivate);
  const canShare = Boolean(
    onCopyShareLink && row.missing === null && !isPrivate && row.docRecipeId,
  );
  const copied = canShare && copiedShareId === row.docRecipeId;
  const shareButton = canShare ? (
    <button
      type="button"
      data-share-link={row.docRecipeId}
      aria-label={`Copy share link: ${row.title}`}
      onClick={() => onCopyShareLink!(row.docRecipeId!)}
      className={`z-10 -my-[calc(18*var(--cpx))] ${ACTION} ${copied ? ACTION_IN_FORCE : ACTION_AT_REST}`}
    >
      {copied ? "Copied" : "Copy share link"}
    </button>
  ) : undefined;
  const privateToggle = onTogglePrivate ? (
    <button
      type="button"
      data-private-toggle={row.id}
      aria-pressed={isPrivate}
      aria-label={`Private: ${row.title}`}
      onClick={() => onTogglePrivate(row.id, !isPrivate)}
      className={`z-10 -my-[calc(18*var(--cpx))] ${ACTION} ${isPrivate ? ACTION_IN_FORCE : ACTION_AT_REST}`}
    >
      Private
    </button>
  ) : undefined;
  const trailing =
    shareButton || privateToggle ? (
      <span className="z-10 flex items-center gap-[calc(8*var(--cpx))]">
        {shareButton}
        {privateToggle}
      </span>
    ) : undefined;
  if (row.missing !== null) {
    // Not a button and no chevron: the title in ink-soft, why in ink.
    return (
      <Row
        title={
          <span data-missing-row={row.missing} className="text-ink-soft">
            {row.title}
          </span>
        }
        slot={<span className="text-ink">{fact}</span>}
        trailing={trailing}
      />
    );
  }
  const sending = sendingId === row.id;
  const waitingOther = sendingId !== null && !sending;
  return (
    <Row
      // While one recipe is being queued, the rest step back in ink-soft.
      className={`transition-colors duration-[320ms] ease-[var(--ease)] ${waitingOther ? "text-ink-soft" : ""}`}
      title={
        <button
          type="button"
          data-pack-row={row.id}
          onClick={() => onPick(row.id)}
          disabled={sendingId !== null}
          aria-busy={sending}
          className={`${ROW_TAP} disabled:cursor-not-allowed ${waitingOther ? "text-ink-soft" : ""}`}
        >
          {row.title}
        </button>
      }
      slot={sending ? COOKPACKS_COPY.sending : fact || undefined}
      trailing={trailing}
      go
    />
  );
}

/**
 * A creator pack's title page (S-D6, compact since the S follow-up, DS
 * v1.20): the running head already names the book in Caprasimo, so the page
 * under it is the creator at 30 cpx, a 64 cpx rule and the count, centred
 * and type only. At 1280×800 a five-recipe book shows two rows whole under
 * it and the third's title, its fact line under the foot's fade. Cover art
 * stays on the shelf (pack-identity decision 7).
 */
function TitlePage({ view }: { view: PackPageView }) {
  return (
    <div data-title-page className="pt-[calc(14*var(--cpx))] pb-[calc(12*var(--cpx))] text-center">
      <p className="text-[length:var(--type-chip)] leading-[1.3] font-medium text-ink">{view.creator}</p>
      {view.fromKitchenName && (
        <p data-from-kitchen className={`mt-[calc(6*var(--cpx))] ${LABEL}`}>
          {COOKPACKS_COPY.fromKitchen(view.fromKitchenName)}
        </p>
      )}
      <div aria-hidden className="mx-auto mt-[calc(12*var(--cpx))] mb-[calc(10*var(--cpx))] h-px w-[calc(64*var(--cpx))] bg-ink/[.3]" />
      <p className={LABEL}>{COOKPACKS_COPY.recipes(view.cookable)}</p>
    </div>
  );
}

/**
 * Where the scroller stands: the chapter whose head has reached its top
 * (the first one above it, else the first), and whether it has scrolled.
 */
function chapterAt(scroller: HTMLElement, anchors: string[]): string | undefined {
  const top = scroller.getBoundingClientRect().top;
  let at = anchors[0];
  for (const anchor of anchors) {
    const head = scroller.querySelector<HTMLElement>(`[data-chapter="${CSS.escape(anchor)}"]`);
    if (head && head.getBoundingClientRect().top - top <= HEAD_ROOM + 8) at = anchor;
  }
  return at;
}

/**
 * A pack, opened (S-D6, P54). The household book opens at its first
 * chapter under a running head: its title in Caprasimo, " · ", the chapter
 * in view as a ghost word that opens the chapters menu, and (in landscape)
 * the search and Refresh; the head stays while the list scrolls under it,
 * a hairline under it once scrolled. The meta line, the chapters (a
 * Caprasimo head over P44 rows) and the rows stay on the ground. A creator
 * pack keeps a band of its cloth down the left margin as its binding and
 * opens on a type-only title page. A search, or the "didn't come through"
 * filter, flattens the list, each row's fact leading with its chapter.
 */
export function PackView({ view, refresh, sendingId, sendFailure, onPick, onTogglePrivate, onCopyShareLink, circleSharing, ownerActions, initialAnchor, onAnchor }: PackViewProps) {
  const portrait = usePortrait();
  const [query, setQuery] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  useEffect(() => {
    if (!confirmingRemove || ownerActions?.removing) return;
    const timer = setTimeout(() => setConfirmingRemove(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmingRemove, ownerActions?.removing]);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);
  const handleCopyShareLink = useCallback(
    (docRecipeId: string) => {
      if (!onCopyShareLink) return;
      try {
        const result = onCopyShareLink(docRecipeId);
        if (typeof result === "boolean") {
          if (result) setCopiedShareId(docRecipeId);
          return;
        }
        void Promise.resolve(result).then(
          (copied) => {
            if (copied) setCopiedShareId(docRecipeId);
          },
          () => {},
        );
      } catch {
        // Leave copied state unchanged when clipboard copy fails.
      }
    },
    [onCopyShareLink],
  );
  const searching = query.trim() !== "";
  const flat = searching || onlyMissing;

  const titled = useMemo(
    () => view.chapters.filter((c): c is PackChapterView & { anchor: string; title: string } => c.anchor !== null && c.title !== null),
    [view.chapters],
  );
  const contents = useMemo(
    () => titled.map((c) => ({ anchor: c.anchor, title: c.title, count: c.rows.filter((r) => r.missing === null).length })),
    [titled],
  );
  const anchors = useMemo(() => titled.map((c) => c.anchor), [titled]);
  const household = view.kind === "household";
  const ok = view.state === "ok";
  // Every pack opens under its running head (P54; a creator pack's too,
  // since the S follow-up, so its search sits there in landscape).
  const hasHead = true;
  const showChapterWord = ok && titled.length > 0 && !flat;
  // The view opens at the chapter the URL names, if the book has it; else at its first.
  const [openAt] = useState(() => (initialAnchor && anchors.includes(initialAnchor) ? initialAnchor : null));
  const [here, setHere] = useState<string>(() => openAt ?? anchors[0] ?? "");
  const [scrolled, setScrolled] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);

  const flatRows: FlatRow[] = useMemo(
    () => (onlyMissing ? missingRows(view.chapters) : searching ? searchRows(view.chapters, query) : []),
    [onlyMissing, searching, query, view.chapters],
  );

  /** Brings a chapter's head to the top of the list. */
  const scrollToChapter = useCallback((anchor: string) => {
    const box = scroller.current;
    const target = box?.querySelector<HTMLElement>(`[data-chapter="${CSS.escape(anchor)}"]`);
    if (!box || !target) return;
    // The head lands a little under the running head's rule, not against it.
    box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - HEAD_ROOM;
  }, []);

  // A chapter the cook went to stays named while its head is in view, even
  // where the list ends before that head can reach the top (a short last
  // chapter): the scroll that brought it there doesn't rename it.
  const pinned = useRef<string | null>(openAt);
  useLayoutEffect(() => {
    if (openAt !== null) scrollToChapter(openAt);
  }, [openAt, scrollToChapter]);

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setScrolled(box.scrollTop > 0);
        if (pinned.current !== null) {
          const head = box.querySelector<HTMLElement>(`[data-chapter="${CSS.escape(pinned.current)}"]`);
          const view = box.getBoundingClientRect();
          const top = head?.getBoundingClientRect().top;
          if (top !== undefined && top >= view.top - 1 && top < view.bottom) return;
          pinned.current = null;
        }
        const at = chapterAt(box, anchors);
        if (at !== undefined) setHere(at);
      });
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      box.removeEventListener("scroll", onScroll);
    };
  }, [anchors]);

  const below = useMoreBelow(
    scroller,
    `${flat}|${query}|${view.chapters.length}|${view.cookable}|${view.missing}|${sendingId ?? ""}|${refresh?.status?.text ?? ""}`,
  );
  const mask = footMask(below);

  // A new search or filter reads from the top (not on mount, which may
  // have opened at the URL's chapter).
  const listKey = `${flat}|${query}`;
  const lastList = useRef(listKey);
  useEffect(() => {
    if (lastList.current === listKey) return;
    lastList.current = listKey;
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [listKey]);

  const field = <SearchField value={query} onChange={(v) => { setOnlyMissing(false); setQuery(v); }} />;
  // Every pack can be searched (P54); the field sits in the running head in
  // landscape, else on the row under it (a creator pack with no chapters has
  // no head: its row comes under the title page). Refresh is the household's.
  const fieldInHead = hasHead && ok && !portrait && !onlyMissing;
  const refreshInHead = household && view.state !== "unreadable" && !portrait && ok;

  const meta: ReactNode = onlyMissing ? (
    COOKPACKS_COPY.missingFilter(view.missing)
  ) : searching ? (
    flatRows.length === 0 ? COOKPACKS_COPY.noMatches(query.trim()) : COOKPACKS_COPY.matches(flatRows.length, query.trim())
  ) : !household ? null : (
    <>
      {COOKPACKS_COPY.recipes(view.cookable)}
      {view.syncedAt && ` · ${COOKPACKS_COPY.synced(kitchenDate(view.syncedAt))}`}
      {view.missing > 0 && (
        <>
          {" · "}
          <button
            type="button"
            data-missing-filter
            onClick={() => {
              setQuery("");
              setOnlyMissing(true);
            }}
            className={`relative cursor-pointer rounded-[var(--radius-1)] underline decoration-ink/[.3] decoration-1 underline-offset-[calc(6*var(--cpx))] after:absolute after:-inset-x-[calc(8*var(--cpx))] after:-inset-y-[calc(26*var(--cpx))] after:content-[''] active:bg-sand ${FOCUS}`}
          >
            {COOKPACKS_COPY.missingCount(view.missing)}
          </button>
        </>
      )}
    </>
  );

  const status = sendFailure ? { text: sendFailure, trouble: true } : (refresh?.status ?? null);

  let body: ReactNode;
  if (view.state === "unreadable") {
    body = <p className="max-w-[calc(620*var(--cpx))] py-[calc(24*var(--cpx))] text-[length:var(--type-chip)] leading-[1.3] font-medium text-balance">{COOKPACKS_COPY.unreadableView}</p>;
  } else if (view.state === "empty") {
    body = (
      <div className="max-w-[calc(620*var(--cpx))] py-[calc(24*var(--cpx))]">
        <p className="text-[length:var(--type-chip)] leading-[1.3] font-medium text-balance">
          {view.missing > 0 ? COOKPACKS_COPY.noneCook(view.missing) : COOKPACKS_COPY.empty}
        </p>
        <p className={`mt-[calc(8*var(--cpx))] text-balance ${LABEL} leading-[1.3]`}>{COOKPACKS_COPY.emptyHow}</p>
        {refresh && <RefreshWord refresh={refresh} className="mt-[calc(8*var(--cpx))]" />}
        {/* Every recipe failed: the rows that didn't come through say which. */}
        {view.missing > 0 && (
          <ul aria-label={COOKPACKS_COPY.missingCount(view.missing)} className="mt-[calc(20*var(--cpx))]">
            {missingRows(view.chapters).map(({ row, chapter }) => (
              <PackRow key={row.id} row={row} chapter={chapter} sendingId={sendingId} copiedShareId={copiedShareId} onPick={onPick} onTogglePrivate={onTogglePrivate} onCopyShareLink={onCopyShareLink ? handleCopyShareLink : undefined} />
            ))}
          </ul>
        )}
      </div>
    );
  } else if (flat) {
    body = (
      <ul aria-label={household ? COOKPACKS_COPY.search : view.title} className="mt-[calc(20*var(--cpx))]">
        {flatRows.map(({ row, chapter }) => (
          <PackRow key={row.id} row={row} chapter={chapter} sendingId={sendingId} copiedShareId={copiedShareId} onPick={onPick} onTogglePrivate={onTogglePrivate} onCopyShareLink={onCopyShareLink ? handleCopyShareLink : undefined} />
        ))}
      </ul>
    );
  } else {
    body = view.chapters.map((chapter, i) => (
      <section
        key={chapter.anchor ?? `tail-${i}`}
        data-chapter={chapter.anchor ?? undefined}
        aria-label={chapter.title ?? undefined}
        className={i === 0 ? "mt-[var(--space-4)]" : "mt-[var(--space-6)]"}
      >
        {chapter.title !== null && <h2 className={`mb-[var(--space-1)] ${CHAPTER_HEAD}`}>{chapter.title}</h2>}
        <ul>
          {chapter.rows.map((row) => (
            <PackRow key={row.id} row={row} sendingId={sendingId} copiedShareId={copiedShareId} onPick={onPick} onTogglePrivate={onTogglePrivate} onCopyShareLink={onCopyShareLink ? handleCopyShareLink : undefined} />
          ))}
        </ul>
      </section>
    ));
  }

  const cloth = view.kind === "creator" && view.cloth !== null ? view.cloth : null;

  return (
    <div data-pack-view={view.id} className="relative flex min-h-0 flex-1 flex-col">
      {cloth && (
        // The binding: a band of the creator's cloth down the left margin (S-D6).
        <span
          aria-hidden
          data-binding={cloth}
          className="fixed top-0 bottom-0 left-0 w-[calc(14*var(--cpx))] shadow-[inset_-1px_0_0_color-mix(in_oklab,var(--ink)_22%,transparent)]"
          style={clothSurface(cloth, { sidelight: false })}
        />
      )}
      {hasHead && (
        <div
          ref={head}
          data-running-head
          className={`relative z-10 flex min-h-[var(--target)] shrink-0 items-center gap-[calc(12*var(--cpx))] border-b ${scrolled ? "border-ink/[.11]" : "border-transparent"} ${EDGE_X}`}
        >
          <h2 className="min-w-0 shrink-[0.001] truncate portrait:whitespace-normal font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-[1.1] font-normal text-ink [font-synthesis:none]">
            {view.title}
          </h2>
          {showChapterWord && <ChapterWord chapters={contents} here={here} onChapter={(a) => { pinned.current = a; scrollToChapter(a); setHere(a); onAnchor?.(a); }} menuRoot={head} columns={portrait || contents.length <= 4 ? 2 : 3} />}
          {fieldInHead && <span className="flex-1" />}
          {fieldInHead && <div className="mr-[calc(12*var(--cpx))] min-w-[calc(220*var(--cpx))] flex-[0_1000_calc(300*var(--cpx))]">{field}</div>}
          {refresh && refreshInHead && (
            <RefreshWord refresh={refresh} className={fieldInHead ? "" : "ml-auto"} />
          )}
        </div>
      )}
      <div
        ref={scroller}
        data-pack-list
        className={`min-h-0 flex-1 overflow-y-auto pb-[calc(112*var(--cpx))] ${EDGE_X}`}
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        <div className={WIDTH}>
          {view.kind === "creator" && !flat && <TitlePage view={view} />}
          {ok && (household || meta !== null || !fieldInHead) && (
            <div
              data-pack-tools
              className="flex flex-wrap items-end justify-between gap-x-[calc(32*var(--cpx))]"
            >
              <p role="status" data-pack-meta className={`max-w-[calc(560*var(--cpx))] ${LABEL} leading-[1.3] ${!fieldInHead ? "pb-[calc(26*var(--cpx))]" : ""}`}>
                {meta}
              </p>
              {onlyMissing ? (
                <span className="flex gap-[calc(12*var(--cpx))]">
                  <button type="button" data-show-all onClick={() => setOnlyMissing(false)} className={`${ACTION} ${ACTION_AT_REST}`}>
                    {COOKPACKS_COPY.showAll}
                  </button>
                  {portrait && refresh && <RefreshWord refresh={refresh} />}
                </span>
              ) : (
                !fieldInHead && (
                  <>
                    <div className="flex-[0_1_calc(320*var(--cpx))]">{field}</div>
                    {refresh && portrait && <RefreshWord refresh={refresh} />}
                  </>
                )
              )}
            </div>
          )}
          {status && (
            <p
              role="status"
              data-pack-status
              className={`mt-[calc(14*var(--cpx))] max-w-[calc(820*var(--cpx))] text-[length:var(--type-meta)] leading-[1.3] font-medium ${status.trouble ? "text-ink" : "text-ink-soft"}`}
            >
              {status.text}
            </p>
          )}
          {ownerActions && !flat && (
            <div
              data-pack-owner-actions
              className="mt-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-3)]"
            >
              <Link
                href={ownerActions.editHref}
                data-update-collection
                className={`${ACTION} ${ACTION_AT_REST}`}
              >
                {COOKPACKS_COPY.updateCollection}
              </Link>
              <button
                type="button"
                data-remove-collection
                disabled={ownerActions.removing}
                onClick={() => {
                  if (!confirmingRemove) {
                    setConfirmingRemove(true);
                    return;
                  }
                  setConfirmingRemove(false);
                  ownerActions.onRemove();
                }}
                className={`${ACTION} ${confirmingRemove ? ACTION_IN_FORCE : ACTION_AT_REST}`}
              >
                {ownerActions.removing
                  ? COOKPACKS_COPY.removingCollection
                  : confirmingRemove
                    ? COOKPACKS_COPY.confirmRemoveCollection
                    : COOKPACKS_COPY.removeCollection}
              </button>
            </div>
          )}
          {circleSharing && circleSharing.kitchens.length > 0 && !flat && (
            <section
              data-pack-circle-sharing
              aria-labelledby="share-with-circle-heading"
              className="mt-[var(--space-4)] border-t border-ink/[.11] pt-[var(--space-4)]"
            >
              <h3 id="share-with-circle-heading" className={LABEL}>
                Share with circle
              </h3>
              <ul className="mt-[var(--space-2)]">
                {circleSharing.kitchens.map((k) => (
                  <li
                    key={k.kitchenId}
                    data-circle-share-kitchen={k.slug}
                    className="flex min-h-[var(--target)] items-center justify-between gap-[var(--space-4)] border-t border-ink/[.11] py-[calc(10*var(--cpx))]"
                  >
                    <span className="text-[length:var(--type-meta)] font-medium text-ink">
                      {k.name}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={k.shared}
                      aria-label={`Share with ${k.name}`}
                      disabled={circleSharing.pending}
                      onClick={() => circleSharing.onToggle(k.kitchenId, !k.shared)}
                      className={`${ACTION} ${k.shared ? ACTION_IN_FORCE : ACTION_AT_REST}`}
                    >
                      {k.shared ? "Shared" : "Off"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {body}
        </div>
      </div>
    </div>
  );
}
