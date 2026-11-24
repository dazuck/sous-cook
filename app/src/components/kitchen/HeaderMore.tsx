"use client";

import { useEffect, useId, useLayoutEffect, useRef } from "react";
import Link from "next/link";
import type { FlagAck, FlagNoteProps } from "@/hooks/useCookFlag";
import { dishName } from "@/lib/kitchen/dish-name";
import { trpc } from "@/lib/trpc";
import { MENU_PANEL, MENU_ROW, useMenuDismiss } from "./CookMenu";

/** Placeholder copy for the header's More menu. */
export const MORE_COPY = {
  more: "More",
  /** The dogfood flag (B2): the row, and what the pill says after it. */
  flag: "Flag this screen",
  // Said in More's cell, which is as wide as the widest of what it can say,
  // always: the top line never moves (fix round 2, item 5; slice V, V11).
  // "Noted" carries the flag cut to its ink (panel round 4, the DS §4 voice
  // word, for "Kept").
  flagged: "Noted",
  /**
   * The tablet couldn't keep the flag: neither stored nor sent (F2), or 20
   * still to send (F11). The cell says it alone, without the flag; the
   * hub's label and the panel say which (panel round 4).
    */
  notKept: "Not kept",
  /**
   * The flag's note (cook-fidelity decision 8), hanging where the menu did:
   * what a flag does, said once, and an optional note on it. A flag said
   * ("Sue, flag") opens none.
   */
  flagSaved: "Saved as a report. It doesn't change this recipe.",
  /** The note field's ask, as the reports panel asks it. */
  flagNoteAsk: "What read wrong?",
  flagNoteLabel: "Note on this flag",
  saveNote: "Save note",
  closeNote: "Close",
  info: "Recipe info",
  inProgress: (n: number) => `Also cooking (${n})`,
  exit: "Exit cooking",
} as const;

interface HeaderMoreProps {
  /**
   * Whether the menu is open: the cook view's to know, as voice's "close"
   * takes it before what is under it, and a borrowed screen shuts it.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowInfo?: () => void;
  /** The recipe on screen, left out of the recipes in progress. */
  currentItemId?: string;
  /** Other recipes in progress, one tap away (default on). */
  showRecentItems?: boolean;
  /** Flags the screen (B2); the row is there only with it. */
  onFlag?: () => void;
  /** How the last flag went, said on the pill for a moment (`useCookFlag`). */
  flagAck?: FlagAck;
  /**
   * The flag's note, open after a flag by touch (decision 8), where the menu
   * hung. It closes as the menu does (a press outside, Esc, the screen
   * shutting it) and by its own control; whatever was typed is saved as it
   * goes, and closing with nothing typed keeps the flag as it was.
   */
  flagNote?: FlagNoteProps;
}

/**
 * The top line's one "More": the flag, recipe info, the other recipes in
 * progress, and the way out. Open, it holds the cook view's arrows, swipes and
 * taps (CookFlow reads `data-holds-keys`), and a press outside, Esc or a choice
 * closes it; so does the screen holding it (`open`), as voice's "close" does
 * (`useMenuDismiss`).
 */
export function HeaderMore({
  open,
  onOpenChange: setOpen,
  onShowInfo,
  currentItemId,
  showRecentItems = true,
  onFlag,
  flagAck = "idle",
  flagNote,
}: HeaderMoreProps) {
  // The root is not positioned: the panel hangs from the top line's right
  // end, where the chapters menu hangs too (`CookMenu`).
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { choose, panelFocus } = useMenuDismiss(open, setOpen, root, button);
  const noteOpen = flagNote?.open ?? false;
  const closeNote = () => flagNote?.onClose();
  const note = useMenuDismiss(
    noteOpen,
    (o) => {
      if (!o) closeNote();
    },
    root,
    button,
  );
  // The cook's own recipes in progress.
  const asks = showRecentItems;

  const { data: recent } = trpc.getRecentCookingItems.useQuery(
    { limit: 5 },
    { enabled: asks },
  );
  const others = asks ? (recent ?? []).filter((item) => item.id !== currentItemId).slice(0, 3) : [];

  return (
    <div ref={root} data-more-cell className="flex shrink-0">
      <button
        ref={button}
        type="button"
        // With the note open, More puts it away (saving what was typed)
        // rather than open the menu over it.
        onClick={() => (noteOpen ? closeNote() : setOpen(!open))}
        aria-expanded={open || noteOpen}
        aria-controls={open || noteOpen ? menuId : undefined}
        className={GHOST}
      >
        {/* After a flag the cell says how it went for 1.6 s, in ink at 600,
            then the dots again: "Noted" with the flag where the dots sit
            (fix round 2, item 5), or "Not kept" (panel round 4), which then
            waits in the hub's label rather than over the cook. The three
            share one grid cell, always drawn, so the cell is as wide
            whichever shows and the top line never moves. No fill (V11), as
            every ghost on the cook screen. */}
        <span className="grid">
          <PillLabel shown={flagAck === "idle"} layout="justify-center text-ink-soft">
            <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className="size-[calc(28*var(--cpx))]">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
            <span className="sr-only">{MORE_COPY.more}</span>
          </PillLabel>
          <PillLabel shown={flagAck === "flagged"} layout={`gap-[calc(5*var(--cpx))] ${SAYS}`}>
            <FlagGlyph />
            <span>{MORE_COPY.flagged}</span>
          </PillLabel>
          <PillLabel shown={flagAck === "failed" || flagAck === "full"} layout={SAYS}>
            <span>{MORE_COPY.notKept}</span>
          </PillLabel>
        </span>
      </button>

      {noteOpen && flagNote && !open && (
        <FlagNote
          id={menuId}
          focus={note.panelFocus}
          draft={flagNote.draft}
          onDraft={flagNote.onDraft}
          onSave={flagNote.onSave}
          onDone={note.choose()}
        />
      )}

      {open && (
        <div
          id={menuId}
          data-holds-keys
          data-capture-omit
          {...panelFocus}
          className={`${MENU_PANEL} ${others.length >= 3 ? "!py-0" : ""} w-[calc(320*var(--cpx))] max-w-[calc(100vw-2*var(--edge))]`}
        >
          <ul>
            {onFlag && (
              <li>
                <button type="button" onClick={choose(onFlag)} className={MENU_ROW}>
                  {MORE_COPY.flag}
                </button>
              </li>
            )}
            {onShowInfo && (
              <li>
                <button type="button" onClick={choose(onShowInfo)} className={MENU_ROW}>
                  {MORE_COPY.info}
                </button>
              </li>
            )}
            {others.length > 0 && (
              <li>
                <h2
                  className={`px-[calc(20*var(--cpx))] ${others.length >= 3 ? "pt-0.5 pb-0 leading-none" : "pt-4 pb-1"} text-[length:var(--type-meta)] font-semibold text-ink-soft`}
                >
                  {MORE_COPY.inProgress(others.length)}
                </h2>
                <ul>
                  {others.map((item) => (
                    <li key={item.id}>
                      <Link
                        href={`/kitchen/queue/${item.id}`}
                        onClick={choose()}
                        className={MENU_ROW}
                      >
                        {dishName(item.recipeData?.name, item.recipeNotionId)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            )}
            <li>
              <Link href="/kitchen" className={MENU_ROW}>
                {MORE_COPY.exit}
              </Link>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The flag's note (cook-fidelity decision 8): Paper lifted where the menu
 * hung, as the menu is (DS §1), never over the stage's whole width. One line
 * says what a flag does; under it the note field, unboxed and asking as the
 * reports panel asks, then the one control: "Close" with nothing typed,
 * "Save note" once something is. The note is saved as the panel goes, by its
 * control or any other way out, so a press outside never loses what was
 * typed; with nothing typed the flag stays as it was taken, and a note
 * cleared and closed is removed. Left out of a
 * flag's capture, and holding the cook view's keys while open.
 */
function FlagNote({
  id,
  focus,
  draft,
  onDraft,
  onSave,
  onDone,
}: {
  id: string;
  focus: ReturnType<typeof useMenuDismiss>["panelFocus"];
  draft: string;
  onDraft: (draft: string) => void;
  onSave: (note: string) => void;
  onDone: () => void;
}) {
  // Read as the panel goes, whichever way it goes.
  const kept = useRef({ draft, onSave });
  useLayoutEffect(() => {
    kept.current = { draft, onSave };
  });
  useEffect(
    // Saved whatever it holds, empty included: a note cleared is removed
    // (the save writes only a change, so an untouched empty field writes nothing).
    () => () => kept.current.onSave(kept.current.draft.trim()),
    [],
  );
  const typed = draft.trim() !== "";
  return (
    <div
      id={id}
      role="dialog"
      aria-label={MORE_COPY.flagged}
      data-flag-note
      data-holds-keys
      data-capture-omit
      {...focus}
      className={`${MENU_PANEL} flex w-[calc(480*var(--cpx))] max-w-[calc(100vw-2*var(--edge))] flex-col gap-[var(--space-2)] !pb-0 !pt-[calc(20*var(--cpx))]`}
    >
      <p data-flag-saved className="px-[calc(20*var(--cpx))] text-[length:var(--type-meta)] leading-tight font-medium text-ink">
        {MORE_COPY.flagSaved}
      </p>
      <textarea
        aria-label={MORE_COPY.flagNoteLabel}
        placeholder={MORE_COPY.flagNoteAsk}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        rows={2}
        className="mx-[calc(20*var(--cpx))] block resize-none field-sizing-content min-h-[calc(2*1.3*var(--type-meta))] max-h-[calc(5*1.3*var(--type-meta))] bg-transparent p-0 text-[length:var(--type-meta)] leading-[1.3] font-medium text-ink placeholder:text-ink-soft focus-visible:outline-1 focus-visible:outline-offset-[6px] focus-visible:outline-ink"
      />
      <div className="flex justify-end">
        <button type="button" onClick={onDone} className={`${MENU_ROW} !w-auto`}>
          <span className="grid">
            <span aria-hidden={typed ? true : undefined} className={`[grid-area:1/1] text-right ${typed ? "invisible" : ""}`}>
              {MORE_COPY.closeNote}
            </span>
            <span aria-hidden={typed ? undefined : true} className={`[grid-area:1/1] text-right ${typed ? "" : "invisible"}`}>
              {MORE_COPY.saveNote}
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * One of the cell's labels, in the grid cell they share; the hidden ones keep
 * their room, so the cell is as wide as the widest.
 */
function PillLabel({
  shown,
  layout,
  children,
}: {
  shown: boolean;
  /** The label's alignment, spacing and type. */
  layout: string;
  children: React.ReactNode;
}) {
  return (
    <span
      data-pill-label
      aria-hidden={shown ? undefined : true}
      className={`flex items-center ${layout} [grid-area:1/1] ${shown ? "" : "invisible"}`}
    >
      {children}
    </span>
  );
}

/**
 * The flag, at the word's cap height and a little over: a pole and a pennant,
 * in the label's colour, its box cut to its ink.
 */
function FlagGlyph() {
  return (
    <svg
      data-flag-glyph
      aria-hidden
      viewBox="4 0 15.4 24"
      fill="currentColor"
      className="h-[0.82em] w-[0.526em] shrink-0"
    >
      <rect x="4" y="3" width="2.5" height="18" rx="1.25" />
      <path d="M6.5 4h12.2a.8.8 0 0 1 .66 1.25L16.6 9.5l2.76 4.25a.8.8 0 0 1-.66 1.25H6.5z" />
    </svg>
  );
}

/** What a flag says in the cell: the eyebrow's size, in ink at 600. */
const SAYS = "justify-center whitespace-nowrap text-[length:var(--type-meta)] font-semibold text-ink";

/**
 * More: a ghost, the dots alone on a target-sized cell with no fill (V11). A
 * press shows sand, as every ghost on the cook screen.
 */
const GHOST =
  "flex h-[var(--target)] min-w-[var(--target)] cursor-pointer items-center justify-center rounded-full px-[calc(8*var(--cpx))] transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ink";
