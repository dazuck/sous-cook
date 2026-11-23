"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type { VoiceEcho, VoiceStatus } from "@/hooks/useKitchenVoiceCommands";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { DotMark, voiceLabel } from "./VoiceDot";
import { EDGE_X } from "./cook-edge";
import { topLayer } from "./layers";
import { LedgeClocks, useLedgeBarClass } from "./LedgeClocks";

export interface BorrowedChromeProps {
  /** The kind line: what borrowed the screen ("The whole cook"). */
  kind: string;
  /**
   * The voice dot's state: the screen covers the header, so the dot moves
   * here. Absent where the screen it covers has no dot (the hub).
   */
  voice?: { status: VoiceStatus; echo: VoiceEcho | null };
  /** The ledge's words: where it goes back to. "Back to cooking" by default. */
  back?: string;
  onClose: () => void;
  /** Whether focus-in, focus return, and Escape listening are active. Defaults to true. */
  active?: boolean;
  headingId?: string;
  className?: string;
  role?: string;
  "aria-modal"?: boolean | "true" | "false";
  "aria-labelledby"?: string;
  "data-holds-keys"?: boolean | string;
  tabIndex?: number;
  style?: CSSProperties;
  containerRef?: RefObject<HTMLDivElement | null>;
  /** Draw the ledge (the cook sheet mounts it only on the way into Whole recipe). */
  showLedge?: boolean;
  /** A control at the kind line's right end (the queue screen's Edit, FP1), on the edge. */
  kindTrailing?: ReactNode;
  children: ReactNode;
}

/** The ledge's words on the hub's borrowed screens (placeholder copy). */
export const BACK_TO_KITCHEN = "Back to the kitchen";

export type KindLineBack =
  | { label: string; onClick: () => void }
  | { label: string; href: string; onClick?: () => void };

/**
 * The top-left back control on a borrowed screen or page (option 1B): an 80 cpx
 * target at the left edge leading with the back chevron and destination label.
 */
export const TOP_BACK =
  "inline-flex h-[var(--target)] min-w-[var(--target)] shrink-0 cursor-pointer items-center gap-[calc(8*var(--cpx))] rounded-full border border-ink/[.14] bg-sand px-[calc(22*var(--cpx))] text-[length:var(--type-meta)] font-semibold text-ink transition-[background-color,border-color,transform] duration-[320ms] ease-[var(--ease)] active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)] focus-visible:outline-3 focus-visible:-outline-offset-2 focus-visible:outline-ink";

/**
 * The kind line: top left, the top-left back control (`data-top-back`) when
 * provided, followed by the borrower's name in ink-soft, beside the voice
 * dot in a cook (the header's dot, which the screen covers) with what the
 * dot just heard after it. Shared by `BorrowedScreen` and `BorrowedPage`, so
 * a route drawn in the grammar sits exactly where a borrowed screen does.
 */
export function KindLine({
  id,
  kind,
  voice,
  as: Heading = "h2",
  back,
  trailing,
}: {
  id?: string;
  kind: string;
  voice?: { status: VoiceStatus; echo: VoiceEcho | null };
  /** The heading level: a borrowed screen's is h2, a page's its h1. */
  as?: "h1" | "h2";
  /** The top-left back button or route link (1B). */
  back?: KindLineBack;
  /** A control at the line's right end, on the edge. */
  trailing?: ReactNode;
}) {
  return (
    <div
      data-kind-line
      data-ledge-bar={back ? "" : undefined}
      className={`flex min-h-[calc(92*var(--cpx))] shrink-0 items-center gap-3 py-[calc(6*var(--cpx))] ${EDGE_X}`}
    >
      {back &&
        ("href" in back ? (
          <Link href={back.href} data-top-back onClick={back.onClick} className={TOP_BACK}>
            <LedgeChevron />
            <span>{back.label}</span>
          </Link>
        ) : (
          <button type="button" data-top-back onClick={back.onClick} className={TOP_BACK}>
            <LedgeChevron />
            <span>{back.label}</span>
          </button>
        ))}
      {back && (
        <span aria-hidden className="shrink-0 text-[length:var(--type-meta)] text-ink-soft/60">
          ·
        </span>
      )}
      {voice && voice.status !== "unsupported" && <DotMark status={voice.status} />}
      <Heading id={id} className="text-[length:var(--type-meta)] leading-tight font-semibold text-ink-soft">
        {kind}
      </Heading>
      {voice?.echo && (
        <span data-voice-echo aria-live="polite" className="min-w-0 truncate text-[length:var(--type-meta)] font-medium text-ink-soft">
          {voiceLabel(voice.status, voice.echo)}
        </span>
      )}
      {back && <LedgeClocks inline />}
      {trailing && <div className="ml-auto shrink-0">{trailing}</div>}
    </div>
  );
}

/**
 * The chevron pointing back on the ledge capsule.
 */
export function LedgeChevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[calc(20*var(--cpx))] shrink-0 text-ink-soft"
    >
      <path d="M15 19l-7-7 7-7" />
    </svg>
  );
}

/** The ledge band's height in counter px (the sheet's Whole recipe ends at its top). */
export const LEDGE_BAR_CPX = 96;

/**
 * The ledge footer container: 96 cpx (`--band-foot`) on the screen's ground, centering the capsule.
 */
export const LEDGE_BAR =
  "flex h-[var(--band-foot)] w-full shrink-0 items-center justify-center px-[calc(20*var(--cpx))]";

/**
 * The ledge: a floating tactile pill in sand over the ground, as drawn in the
 * device mockups and prototypes (hold/index.html .rfoot .ledge). Pill radius,
 * hairline edge, generous padding, with a quiet chevron pointing back.
 */
export const LEDGE =
  "inline-flex h-[var(--target)] max-w-[calc(100%-40*var(--cpx))] cursor-pointer items-center justify-center gap-[calc(10*var(--cpx))] rounded-full border border-ink/[.14] bg-sand px-[calc(32*var(--cpx))] text-[length:var(--type-meta)] font-semibold text-ink transition-[background-color,border-color,transform] duration-[320ms] ease-[var(--ease)] active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)] focus-visible:outline-3 focus-visible:-outline-offset-2 focus-visible:outline-ink";

/**
 * The ledge footer bar containing the back button and the kitchen's clocks.
 */
export function LedgeBar({
  back = COOK_COPY.backToCooking,
  onClose,
}: {
  back?: string;
  onClose: () => void;
}) {
  const ledgeBar = useLedgeBarClass();
  return (
    <div data-ledge-bar className={`${LEDGE_BAR} ${ledgeBar}`}>
      <button type="button" onClick={onClose} className={LEDGE}>
        <LedgeChevron />
        <span>{back}</span>
      </button>
      <LedgeClocks />
    </div>
  );
}

/**
 * The chrome of a borrowed screen: the top-left back control and kind line at
 * the top, content in the body, and kitchen timers in the top bar.
 * Handles focus management on mount/unmount and Escape key via topLayer().
 */
export function BorrowedChrome({
  kind,
  voice,
  back = COOK_COPY.backToCooking,
  onClose,
  active = true,
  headingId: customHeadingId,
  className = "fixed inset-0 z-50 flex flex-col bg-ground font-[family-name:var(--font-text)] text-ink outline-none",
  role = "dialog",
  "aria-modal": ariaModal = true,
  "data-holds-keys": holdsKeys = true,
  tabIndex = -1,
  style,
  containerRef,
  showLedge = true,
  kindTrailing,
  children,
}: BorrowedChromeProps) {
  const generatedId = useId();
  const headingId = customHeadingId ?? generatedId;
  const internalRef = useRef<HTMLDivElement | null>(null);
  const rootRef = containerRef ?? internalRef;

  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!active) return;
    const was =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    rootRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (rootRef.current !== topLayer()) return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (was && was !== document.body && document.contains(was)) {
        was.focus();
      } else {
        document.querySelector<HTMLElement>("[data-cook-sheet]")?.focus();
      }
    };
  }, [active, rootRef]);

  return (
    <div
      ref={rootRef}
      role={role}
      aria-modal={ariaModal ? "true" : undefined}
      aria-labelledby={headingId}
      tabIndex={tabIndex}
      data-holds-keys={holdsKeys ? "" : undefined}
      // The sheet keeps Whole recipe's chrome drawn; it is the borrowed screen only while open.
      data-whole-recipe={kind === COOK_COPY.wholeRecipe && ariaModal ? "" : undefined}
      style={style}
      className={className}
    >
      <KindLine
        id={headingId}
        kind={kind}
        voice={voice}
        back={showLedge ? { label: back, onClick: onClose } : undefined}
        trailing={kindTrailing}
      />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
