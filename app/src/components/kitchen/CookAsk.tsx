"use client";

import { useId, useRef, useState } from "react";
import type { CookAsk } from "@/lib/kitchen-cook-log";
import { dishName } from "@/lib/kitchen/dish-name";
import { ACTION, ACTION_AT_REST, ACTION_IN_FORCE, FOCUS, RING } from "./control-style";
import { LABEL } from "./KitchenHome";

/** The ask's words (placeholder copy, awaiting a rewrite). */
export const ASK_COPY = {
  ask: "How was it?",
  rate: (n: number) => `${n} out of 5`,
  addNote: "Add a note",
  note: "Note",
  notePlaceholder: "A note to go with your rating",
  notNow: "Not now",
  notLogged: "Not in the cook log yet.",
  stillNotLogged: "Still not in the cook log.",
  retry: "Try again",
  rowMoved: "Its row in the cook log moved, so rate it there.",
  rateFailed: "The cook log didn't take it. Tap again to try again.",
  stillWriting: "Still writing it to the cook log. Try again in a moment.",
  unread: "Can't reach the cook log just now.",
  error: "That didn't go through. Try again.",
} as const;

/**
 * How a rating went, as the line words it: "rated" and "gone" (the cook was
 * reopened, or isn't there) leave the kitchen to take the line away;
 * "row-moved" leaves it to redraw the line in that state.
 */
export type RateAnswer = "rated" | "failed" | "writing" | "row-moved" | "gone" | "error";
/** How a retry went: "logged" and "gone" leave the kitchen to redraw the line. */
export type RetryAnswer = "logged" | "failed" | "writing" | "gone" | "error";

/**
 * What a refused rating or retry means for the line. The server answers a
 * Cook Log conflict with CONFLICT and the reason as its message ("writing",
 * "row-moved", "not-completed") and a missing item with NOT_FOUND; a cook
 * reopened or gone is no longer the line's to ask of. Anything else is an
 * error the line says as one.
 */
export function refusedAnswer(err: unknown): "writing" | "row-moved" | "gone" | "error" {
  const code = (err as { data?: { code?: unknown } } | null)?.data?.code;
  const message = err instanceof Error ? err.message : "";
  if (code === "CONFLICT" && message === "writing") return "writing";
  if (code === "CONFLICT" && message === "row-moved") return "row-moved";
  if (code === "CONFLICT" || code === "NOT_FOUND") return "gone";
  return "error";
}

/**
 * How long the kitchen waits before reading the ask again, for
 * `refetchInterval`. A row still being written is read again in 2 s, so its
 * taps come live within seconds of Done; anything else once a minute, which
 * lets midnight and a rating written to the cook log elsewhere take the line
 * away. A failed read keeps the last answer, so a "writing" row would go on
 * being read every 2 s, each with its retries, for as long as the server
 * fails: a failed read waits the minute instead (T follow-up, item 1).
 */
export function askPollInterval(query: {
  state: { data?: CookAsk | null; status: "pending" | "error" | "success" };
}): number {
  return query.state.status !== "error" && query.state.data?.state === "writing" ? 2000 : 60_000;
}

/** The Cook Log's limit on a note (`rateCook`'s, in characters). */
const NOTE_LIMIT = 500;

interface CookAskLineProps {
  ask: CookAsk;
  /** Rates the cook, with the note ("" for none). */
  onRate: (rating: number, note: string) => Promise<RateAnswer>;
  onRetry: () => Promise<RetryAnswer>;
  onDismiss: () => void;
}

/**
 * "How was it?" (T2, DS §6): today's latest finished cook, asked once on the
 * kitchen. The dish's name over five taps that rate it in the Cook Log, a
 * note that rides with the rating, and Not now. Ink and ghosts: a rating is
 * not heat, time or money, so none of it is ember. Each cook asked of starts
 * the line afresh.
 */
export function CookAskLine(props: CookAskLineProps) {
  return <AskLine key={props.ask.queueId} {...props} />;
}

const RATE_WORDS: Partial<Record<RateAnswer | RetryAnswer, string>> = {
  failed: ASK_COPY.rateFailed,
  writing: ASK_COPY.stillWriting,
  error: ASK_COPY.error,
};

/**
 * A rating's tap: a target square, its numeral at the glances' size in a
 * hairline ring 56 cpx across (v1.16), ink at 20% at rest and ink once rated.
 */
const RATE = `relative isolate inline-flex size-[var(--target)] cursor-pointer items-center justify-center disabled:cursor-default ${RING} before:inset-[calc(12*var(--cpx))] before:rounded-full`;

function AskLine({ ask, onRate, onRetry, onDismiss }: CookAskLineProps) {
  const ids = useId();
  const [rating, setRating] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const [say, setSay] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // One call at a time, double taps included: state lags a render behind.
  const busy = useRef(false);
  const noteRef = useRef<HTMLInputElement>(null);

  const rate = async (n: number) => {
    if (busy.current) return;
    busy.current = true;
    setRating(n);
    setSay(null);
    const answer = await onRate(n, note?.trim() ?? "");
    if (answer === "rated" || answer === "gone") return; // held until the kitchen redraws
    busy.current = false;
    setRating(null);
    setSay(RATE_WORDS[answer] ?? null);
  };

  const retry = async () => {
    if (busy.current) return;
    busy.current = true;
    setRetrying(true);
    setSay(null);
    const answer = await onRetry();
    busy.current = false;
    setRetrying(false);
    setRetryFailed(answer === "failed");
    if (answer !== "failed") setSay(RATE_WORDS[answer] ?? null);
  };

  const words =
    say ??
    (ask.state === "failed" ? (retryFailed ? ASK_COPY.stillNotLogged : ASK_COPY.notLogged) : null) ??
    (ask.state === "row-moved" ? ASK_COPY.rowMoved : null) ??
    // T follow-up, item 2: the Cook Log didn't answer the kitchen's read. The
    // cook did nothing, so nothing to retry; the taps stay live and the next
    // read clears it.
    (ask.state === "unread" ? ASK_COPY.unread : null);
  const rateable = ask.state !== "row-moved";

  return (
    <section aria-labelledby={`${ids}-ask`}>
      <h2 id={`${ids}-ask`} className={LABEL}>
        {ASK_COPY.ask}
      </h2>
      <p className="mt-[calc(8*var(--cpx))] line-clamp-2 font-[family-name:var(--font-display)] text-[length:var(--type-step)] leading-[1.05] font-normal break-words text-ink [font-synthesis:none]">
        {dishName(ask.name)}
      </p>
      {/* The words' ring sits on the edge too, whether they follow the
          numerals or wrap under them (portrait). */}
      <div className="mt-[calc(20*var(--cpx))] flex flex-wrap items-center gap-x-[calc(28*var(--cpx))]">
        {rateable && (
          // The first numeral's ring sits on the edge, its target past it.
          <div
            role="group"
            aria-labelledby={`${ids}-ask`}
            className="-ml-[calc(12*var(--cpx))] flex gap-x-[calc(4*var(--cpx))] text-[length:var(--type-chip)] leading-none font-semibold tabular-nums"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={ASK_COPY.rate(n)}
                aria-pressed={rating === n}
                disabled={rating !== null || ask.state === "writing"}
                onClick={() => rate(n)}
                className={`${RATE} ${
                  rating === n ? "text-ink before:border-ink" : "text-ink before:border-ink/[.2] disabled:text-ink-soft"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-x-[calc(12*var(--cpx))]">
          {/* Open, it stays where it was, in force, so Not now never moves
              under a finger; tapped again it takes the cook back to the field. */}
          {rateable && (
            <button
              type="button"
              aria-expanded={note !== null}
              aria-controls={note !== null ? `${ids}-note` : undefined}
              onClick={() => (note === null ? setNote("") : noteRef.current?.focus())}
              className={`${ACTION} ${note === null ? ACTION_AT_REST : ACTION_IN_FORCE}`}
            >
              {/* One cell, as wide at rest as in force: the 600 copy under
                  it holds the room, so the weight's change moves nothing. */}
              <span className="grid">
                <span className="col-start-1 row-start-1">{ASK_COPY.addNote}</span>
                <span aria-hidden className="invisible col-start-1 row-start-1 font-semibold">
                  {ASK_COPY.addNote}
                </span>
              </span>
            </button>
          )}
          <button type="button" onClick={onDismiss} className={`${ACTION} ${ACTION_AT_REST}`}>
            {ASK_COPY.notNow}
          </button>
        </div>
      </div>
      {rateable && note !== null && (
        <input
          // Asked for, so the keyboard comes with it.
          autoFocus
          ref={noteRef}
          id={`${ids}-note`}
          type="text"
          aria-label={ASK_COPY.note}
          placeholder={ASK_COPY.notePlaceholder}
          maxLength={NOTE_LIMIT}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          // Unboxed, as the reports panel's notes: a 1 px ink ring on focus,
          // a hairline's weight, not the controls' 3 px (DS §5, P47). It is
          // drawn inside the field, the column's full width, so it closes on
          // the column's edge, never past it; the padding keeps the words
          // off it (critic round 1, gap 4).
          className="mt-[calc(8*var(--cpx))] h-[var(--target)] w-full rounded-[var(--radius-2)] bg-transparent px-[calc(16*var(--cpx))] text-[length:var(--type-meta)] font-medium text-ink placeholder:text-ink-soft focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ink"
        />
      )}
      {/* What went wrong, last: under the taps and the field, so a line
          that comes after a tap moves nothing the cook is reaching for
          (critic round 2, gap 6). From "failed" the taps stay live, since a
          tap writes the row first (T-D8). */}
      {words && (
        <p role="status" className={`mt-[calc(4*var(--cpx))] ${LABEL}`}>
          <span>{words}</span>
          {ask.state === "failed" && (
            <>
              {" "}
              <button
                type="button"
                disabled={retrying}
                onClick={retry}
                className={`cursor-pointer rounded-[var(--radius-1)] py-[calc(12*var(--cpx))] font-semibold text-ink underline decoration-[length:calc(2*var(--cpx))] underline-offset-[6px] transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand disabled:cursor-default disabled:text-ink-soft ${FOCUS}`}
              >
                {ASK_COPY.retry}
              </button>
            </>
          )}
        </p>
      )}
    </section>
  );
}
