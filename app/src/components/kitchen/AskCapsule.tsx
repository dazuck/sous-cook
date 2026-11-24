"use client";

import { useImperativeHandle, useRef, type Ref } from "react";
import { actionOf, MicMark, type VoiceProps } from "./VoiceDot";

/** The way into Ask Sous a cook took: which part of the capsule, for focus to come back to. */
export type AskWay = "mic" | "words" | "camera";

/** Placeholder copy for the capsule, awaiting a rewrite. */
export const CAPSULE_COPY = {
  photo: "Take a photo for Sous",
} as const;

/** The camera, at the mic's size. */
export function CameraMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[calc(26*var(--cpx))] shrink-0"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

export interface AskCapsuleHandle {
  /** Puts focus on the part named, or on the words when that part is not drawn. */
  focus: (way: AskWay) => void;
}

export interface AskCapsuleProps {
  /** The words, Ask's own title; the button's name at every width. */
  label: string;
  /** The words where the top line is short (portrait). */
  short: string;
  onWords: () => void;
  /** How the voice stands; the mic is drawn only where the browser can listen. */
  voice?: Pick<VoiceProps, "mode" | "status">;
  onMic?: () => void;
  /** Opens the camera; the camera part is drawn only with it. */
  onPhoto?: () => void;
  /**
   * Where it stands: the cook's top line (the default), or the pinned
   * whole-cook chart's, which hosts it beside More while the top line gives
   * way. The chart's row also holds the dish, Whole recipe and time to the
   * table, so there the capsule is short: no camera (the panel has one), the
   * word "Ask", and the mic only where a tap on it opens Ask. In portrait it
   * is not drawn: that row has no room for it beside the dish's name.
   */
  place?: "top-line" | "chart";
  ref?: Ref<AskCapsuleHandle>;
}

// The pill is 52 cpx tall, drawn inside the row's 80 cpx targets, as an
// action word's hairline is (DS §5): each part's press shows sand inside it.
const PILL = "before:absolute before:top-1/2 before:-z-10 before:-translate-y-1/2 before:rounded-full";
const PART =
  `relative flex h-full shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-2)] ${PILL} before:inset-x-px before:h-[calc(52*var(--cpx)-2px)] before:transition-colors before:duration-[320ms] before:ease-[var(--ease)] active:before:bg-sand focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ink`;
/** A part is a full target across (§0.3). */
const FULL = "min-w-[var(--target)]";
/** The words and the camera give their side room in portrait, as the foot's tight row did; the mic never does. */
const GIVES = `${FULL} portrait:min-w-[calc(64*var(--cpx))]`;
/** On the chart the word gives that room at every width. */
const SHORT = "min-w-[calc(64*var(--cpx))]";

/**
 * Ask Sous, at the right end of the cook's top line (DS §5 Ask, v1.60;
 * DECISIONS 2026-11-22 "Ask Sous is a side panel"): one Paper pill with its
 * hairline, holding three ways into the panel. The mic opens it listening
 * where voice listens on a tap (where it listens all the time there are no
 * spoken questions, and the mic stays voice's on and off switch), the words
 * open it for typing, the camera opens the camera and then the panel with
 * the photo as the cook's turn. The mic is a full target across at
 * every width (§0.3); in portrait the words are "Ask" and they and the camera
 * give their side room.
 */
export function AskCapsule({ label, short, onWords, voice, onMic, onPhoto, place = "top-line", ref }: AskCapsuleProps) {
  const micRef = useRef<HTMLButtonElement>(null);
  const wordsRef = useRef<HTMLButtonElement>(null);
  const cameraRef = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => ({
    focus: (way) => {
      const part = way === "mic" ? micRef.current : way === "camera" ? cameraRef.current : null;
      (part ?? wordsRef.current)?.focus();
    },
  }));
  const chart = place === "chart";
  const speaks =
    voice !== undefined && voice.status !== "unsupported" && onMic !== undefined && (!chart || voice.mode === "tap");
  const mark = chart ? { "data-ask-capsule-chart": "" } : { "data-ask-capsule": "" };

  return (
    <div
      {...mark}
      className={`${chart ? "portrait:hidden " : ""}relative isolate inline-flex h-[var(--target)] shrink-0 items-center text-[length:var(--type-meta)] leading-tight font-medium whitespace-nowrap text-ink ${PILL} before:pointer-events-none before:inset-x-0 before:h-[calc(52*var(--cpx))] before:border before:border-ink/[.11] before:bg-paper`}
    >
      {speaks && (
        <button
          ref={micRef}
          type="button"
          onClick={onMic}
          aria-label={actionOf(voice.mode, voice.status)}
          // Listening on a tap, a tap listens to nothing while Sous speaks.
          aria-disabled={(voice.mode === "tap" && voice.status === "paused") || undefined}
          // How the voice stands. `data-voice` marks the screen's one mic, the top line's;
          // the chart's waits in the page, hidden, while that one shows, so it has its own mark.
          {...(chart ? { "data-chart-voice": voice.status } : { "data-voice": voice.status })}
          className={`${PART} ${FULL} text-ink-soft`}
        >
          <MicMark status={voice.status} />
        </button>
      )}
      <button
        ref={wordsRef}
        type="button"
        onClick={onWords}
        aria-label={label}
        className={`${PART} ${chart ? SHORT : GIVES} px-[calc(6*var(--cpx))]`}
      >
        {chart ? (
          short
        ) : (
          <>
            <span className="portrait:hidden">{label}</span>
            <span className="hidden portrait:inline">{short}</span>
          </>
        )}
      </button>
      {onPhoto && !chart && (
        <button
          ref={cameraRef}
          type="button"
          onClick={onPhoto}
          aria-label={CAPSULE_COPY.photo}
          className={`${PART} ${GIVES} text-ink-soft`}
        >
          <CameraMark />
        </button>
      )}
    </div>
  );
}
