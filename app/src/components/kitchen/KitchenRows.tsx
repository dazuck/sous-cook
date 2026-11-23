"use client";

import type { ReactNode } from "react";
import { ACTION, ACTION_AT_REST } from "./control-style";

/** A queue item as the kitchen draws it. */
export interface KitchenItem {
  id: string;
  name: string;
  /**
   * The time line (`timeLine`, slice T2): how long it takes and the ahead
   * work it opens with, as its parts, when there is anything to say.
   */
  times?: string[] | null;
}

/** A section's label: the meta line's type, ink-soft. */
export const LABEL = "text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft";

export const hrefOf = (item: KitchenItem) => `/kitchen/queue/${item.id}`;

/**
 * A row's way in: its title, stretched over the whole row, on the ground
 * with no fill at rest. The row's column of words takes no tap, so a tap
 * anywhere on the row falls through to the stretch; this takes it back.
 * Pressed, the row fills sand under its words, its press room reaching a
 * little past the hairline's ends.
 */
export const ROW_TAP =
  "pointer-events-auto block max-w-full cursor-pointer truncate text-left outline-none after:absolute after:inset-y-0 after:-inset-x-[calc(16*var(--cpx))] after:-z-10 after:rounded-[var(--radius-2)] after:transition-colors after:duration-[320ms] after:ease-[var(--ease)] after:content-[''] active:after:bg-sand focus-visible:after:outline-3 focus-visible:after:-outline-offset-3 focus-visible:after:outline-ink";

/**
 * The row's way in (v1.16): the cook foot's forward chevron, ink-soft at a
 * little over the meta's size, its tip on the edge. It takes no tap of its
 * own, so a tap on it is the row's.
 */
function Onward() {
  return (
    <svg
      data-row-go
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="pointer-events-none -mr-[calc(8*var(--cpx))] size-[calc(26*var(--cpx))] shrink-0 text-ink-soft"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

/**
 * One §6 row (P44): at least a target tall, an 11% ink hairline on top, the
 * title in Figtree at 30 cpx/500 on the left and the right slot's words on
 * the right. The slot drops under the title when the two don't fit, and
 * there reads from the title's edge; with an
 * edit in it, the title gives way instead, so the edit stays in reach. A row
 * whose tap goes somewhere ends in a chevron (`go`, v1.16), which the edit
 * replaces while it shows. A pack's rows are these too.
 */
export function Row({
  title,
  slot,
  edit,
  go = false,
  className = "",
}: {
  title: ReactNode;
  slot?: ReactNode;
  edit?: ReactNode;
  go?: boolean;
  className?: string;
}) {
  return (
    <li
      className={`${className} relative isolate flex min-h-[var(--target)] items-center gap-x-[calc(20*var(--cpx))] border-t border-ink/[.11] py-[calc(18*var(--cpx))]`}
    >
      {/* The column of words takes no tap, so a tap on its empty space or
          its fact falls through to the title's stretch under it (ROW_TAP
          takes taps back on the title itself). */}
      <div
        className={`pointer-events-none flex min-w-0 flex-1 items-baseline justify-between gap-x-[calc(20*var(--cpx))] ${edit ? "" : "flex-wrap"}`}
      >
        <h3 className="min-w-0 max-w-full text-[length:var(--type-chip)] leading-tight font-medium text-ink">
          {title}
        </h3>
        {!edit && slot && (
          // Its words start at its own left. Beside the title it sits on the
          // right, the row's justify-between pushing it there; dropped under
          // the title it is alone on its line, which flex puts at the start,
          // so it reads from the title's edge whether one line or more (V fix
          // round 1, item 8; T2 fix round 1, the list's one left edge). It
          // takes no tap of its own (its column takes none): the whole row is the tap.
          <span
            data-row-slot
            className="text-left text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft"
          >
            {slot}
          </span>
        )}
      </div>
      {edit ?? (go && <Onward />)}
    </li>
  );
}

/** A row's edit, above the row's stretched tap so its press never starts the cook. */
export function RowEdit({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`z-10 -my-[calc(18*var(--cpx))] ${ACTION} ${ACTION_AT_REST}`}
    >
      {label}
    </button>
  );
}

