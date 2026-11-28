"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { reportOutbox } from "@/hooks/useReportOutbox";
import { flagMisses } from "@/lib/kitchen/flag-misses";
import {
  NOTE_MAX_BYTES,
  buildPageReport,
  byteLength,
  insertToFit,
  screenFromPath,
  type CookReport,
  type ReportScreen,
} from "@/lib/kitchen/report-capture";
import { recentEvents } from "@/lib/kitchen/report-events";
import type { FlagResult } from "@/lib/kitchen/report-outbox";
import { ACTION, ACTION_AT_REST, FOCUS, FOOT_FILL, FOOT_FILL_WAITS } from "./control-style";
import { LABEL } from "./KitchenHome";

const DIALOG_CLOSE_BACKDROP_SUPPORT =
  typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype;

export const FEEDBACK_COPY = {
  title: "Send feedback",
  prompt: "What didn't work, or what felt off? Your screen details go with it.",
  noteLabel: "Note (optional)",
  notePlaceholder: "Tell us what happened or what you expected",
  send: "Send note",
  flagForLater: "Flag for later",
  cancel: "Cancel",
  sending: "Sending…",
  failed: "Could not keep this feedback on the tablet.",
  full: "The outbox is full. Clear sent flags before adding more.",
  button: "Feedback",
} as const;

interface FeedbackDialogProps {
  open: boolean;
  screen?: ReportScreen;
  onClose: () => void;
  submitReport?: (report: CookReport) => Promise<FlagResult>;
}

/**
 * Native `<dialog>` feedback capture modal, accessible from HomeRail, Settings,
 * and every BorrowedPage/BorrowedScreen. Uses `showModal()`, `closedby="any"`
 * with a pointerdown/pointerup bounds fallback, an `<h1>` inside `<dialog>`,
 * explicit `<label>`, `insertToFit` byte cap enforcement, and polite `role="status"`.
 */
export function FeedbackDialog({
  open,
  screen,
  onClose,
  submitReport = (report) => reportOutbox().add(report),
}: FeedbackDialogProps) {
  const headingId = useId();
  const fieldId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressedOutsideRef = useRef(false);

  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      if (!el.open && typeof el.showModal === "function") {
        el.showModal();
      }
    } else if (el.open && typeof el.close === "function") {
      el.close();
    }
  }, [open]);

  const handleClose = () => {
    if (sending) return;
    setStatusText(null);
    onClose();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDialogElement>) => {
    if (DIALOG_CLOSE_BACKDROP_SUPPORT) return;
    const el = dialogRef.current;
    if (!el || e.target !== el) {
      pressedOutsideRef.current = false;
      return;
    }
    const r = el.getBoundingClientRect();
    const inside =
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom;
    pressedOutsideRef.current = !inside;
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDialogElement>) => {
    if (DIALOG_CLOSE_BACKDROP_SUPPORT) return;
    const el = dialogRef.current;
    const wasOutside = pressedOutsideRef.current;
    pressedOutsideRef.current = false;
    if (!wasOutside || !el || e.target !== el) return;
    const r = el.getBoundingClientRect();
    const inside =
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom;
    if (!inside) {
      handleClose();
    }
  };

  const submitWithNote = async (text: string) => {
    if (sending) return;
    setSending(true);
    setStatusText(null);
    try {
      const href = typeof window !== "undefined" ? window.location.href : "https://localhost/kitchen";
      const pathname = new URL(href).pathname;
      const resolvedScreen = screen ?? screenFromPath(pathname);
      const report = buildPageReport({
        id: crypto.randomUUID(),
        now: Date.now(),
        build: process.env.SOUS_BUILD_ID ?? "dev",
        href,
        screen: resolvedScreen,
        note: text,
        viewport: {
          w: typeof window !== "undefined" ? window.innerWidth : 1280,
          h: typeof window !== "undefined" ? window.innerHeight : 800,
          dpr: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
        },
        ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
        online: typeof navigator !== "undefined" ? navigator.onLine : true,
        events: recentEvents(),
        root: (typeof document !== "undefined" ? document.body : null) as Element,
      });

      const result = await submitReport(report);
      if (result === "flagged") {
        setNote("");
        setSending(false);
        setStatusText(null);
        onClose();
        return;
      }
      if (result === "full") {
        flagMisses.add("full");
        setStatusText(FEEDBACK_COPY.full);
      } else {
        flagMisses.add("failed");
        setStatusText(FEEDBACK_COPY.failed);
      }
    } catch {
      flagMisses.add("failed");
      setStatusText(FEEDBACK_COPY.failed);
    } finally {
      setSending(false);
    }
  };

  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submitWithNote(note.trim());
  };

  const bytesUsed = byteLength(JSON.stringify(note)) - 2;
  const trimmedEmpty = note.trim().length === 0;

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby={open ? headingId : undefined}
      data-feedback-dialog={open ? "" : undefined}
      data-holds-keys={open ? "" : undefined}
      data-capture-omit
      onCancel={(e) => {
        e.preventDefault();
        handleClose();
      }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      className={
        open
          ? "m-auto w-[min(calc(100vw-2*var(--edge)),calc(640*var(--cpx)))] rounded-[var(--radius-2)] border border-ink/[.14] bg-paper p-[var(--space-5)] text-ink shadow-none backdrop:bg-ink/25"
          : "hidden"
      }
    >
      {open && (
        <div className="flex flex-col gap-[var(--space-4)]">
          <div>
            <h1
              id={headingId}
              className="font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]"
            >
              {FEEDBACK_COPY.title}
            </h1>
            <p className={`mt-[var(--space-2)] ${LABEL} leading-[1.35]`}>
              {FEEDBACK_COPY.prompt}
            </p>
          </div>

          <form onSubmit={onFormSubmit} className="flex flex-col gap-[var(--space-4)]">
            <div>
              <label
                htmlFor={fieldId}
                className="block text-[length:var(--type-meta)] font-medium text-ink"
              >
                {FEEDBACK_COPY.noteLabel}
              </label>
              <textarea
                id={fieldId}
                autoFocus
                rows={4}
                value={note}
                onChange={(e) => {
                  const el = e.target;
                  const fitted = insertToFit(
                    note,
                    el.value,
                    el.selectionStart ?? el.value.length,
                    NOTE_MAX_BYTES,
                  );
                  setNote(fitted.text);
                  setStatusText(null);
                  if (fitted.cut) {
                    requestAnimationFrame(() => {
                      el.setSelectionRange(fitted.caret, fitted.caret);
                    });
                  }
                }}
                placeholder={FEEDBACK_COPY.notePlaceholder}
                className={`mt-[var(--space-2)] w-full rounded-[var(--radius-2)] border border-ink/[.2] bg-ground p-[var(--space-3)] font-[family-name:var(--font-text)] text-[length:var(--type-meta)] leading-[1.45] font-medium text-ink placeholder:text-ink-soft ${FOCUS}`}
              />
              {bytesUsed > NOTE_MAX_BYTES - 512 && (
                <p className={`mt-[var(--space-1)] ${LABEL}`}>
                  {Math.max(0, bytesUsed)} / {NOTE_MAX_BYTES} bytes
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-[var(--space-3)]">
              <button
                type="button"
                disabled={sending}
                onClick={handleClose}
                className={`${ACTION} ${ACTION_AT_REST}`}
              >
                {FEEDBACK_COPY.cancel}
              </button>
              <button
                type="button"
                data-feedback-flag-later
                disabled={sending}
                onClick={() => void submitWithNote("")}
                className={`${ACTION} ${ACTION_AT_REST}`}
              >
                {FEEDBACK_COPY.flagForLater}
              </button>
              <button
                type="submit"
                data-feedback-send
                disabled={sending || trimmedEmpty}
                aria-disabled={sending || trimmedEmpty}
                className={`${FOOT_FILL} px-[calc(28*var(--cpx))] ${
                  sending || trimmedEmpty ? FOOT_FILL_WAITS : "bg-ember text-paper"
                }`}
              >
                {sending ? FEEDBACK_COPY.sending : FEEDBACK_COPY.send}
              </button>
            </div>

            <p role="status" aria-live="polite" className={statusText ? LABEL : "sr-only"}>
              {statusText ?? ""}
            </p>
          </form>
        </div>
      )}
    </dialog>
  );
}

/**
 * Compact header or settings button that opens `FeedbackDialog` for the current screen.
 */
export function FeedbackTrigger({
  screen,
  label = FEEDBACK_COPY.button,
}: {
  screen?: ReportScreen;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        data-feedback-trigger
        onClick={() => setOpen(true)}
        className={`${ACTION} ${ACTION_AT_REST}`}
      >
        {label}
      </button>
      <FeedbackDialog open={open} screen={screen} onClose={() => setOpen(false)} />
    </>
  );
}
