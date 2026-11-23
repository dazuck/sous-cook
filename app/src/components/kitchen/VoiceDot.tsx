"use client";

import type { VoiceEcho, VoiceStatus } from "@/hooks/useKitchenVoiceCommands";
import type { VoiceMode } from "@/lib/kitchen/voice-mode";

/**
 * Placeholder copy for the voice dot, awaiting a rewrite. What was heard is
 * shown as Chrome wrote it, so a spelling of "Sous" the wake list misses shows
 * up here rather than failing silently.
 */
export const VOICE_COPY = {
  listening: "Say “Sue, next”",
  /** While a timer rings (B5a). */
  stop: "Say “Sue, stop”",
  armed: "Sue…",
  unknown: (heard: string) => `Didn't catch “${heard}”`,
  nearMiss: (heard: string) => `Heard “${heard}”. Start with “Sue”`,
  asked: (text: string) => `Asking “${text}”`,
  off: "Voice off",
  paused: "Voice paused",
  blocked: "No mic",
  stalled: "Voice stopped",
  turnOn: "Turn voice on",
  turnOff: "Turn voice off",
  // Where voice listens only on a tap (lib/kitchen/voice-mode.ts).
  ready: "Tap to talk",
  hearing: "Listening…",
  silence: "Didn't hear anything",
  trouble: "Couldn't listen. Tap to try again",
  talk: "Talk to Sous",
  stopTalking: "Stop listening",
} as const;

/** The line beside the dot: what was just heard, else what to say or why it isn't listening. */
export function voiceLabel(status: VoiceStatus, echo: VoiceEcho | null, hint?: string): string {
  if (echo?.kind === "armed") return VOICE_COPY.armed;
  if (echo?.kind === "command") return `“${echo.heard}”`;
  if (echo?.kind === "reply") return echo.text;
  if (echo?.kind === "unknown") return VOICE_COPY.unknown(echo.heard);
  if (echo?.kind === "near-miss") return VOICE_COPY.nearMiss(echo.heard);
  if (echo?.kind === "asked") return VOICE_COPY.asked(echo.text);
  if (echo?.kind === "silence") return VOICE_COPY.silence;
  if (echo?.kind === "trouble") return VOICE_COPY.trouble;
  if (status === "listening") return hint ?? VOICE_COPY.listening;
  if (status === "ready") return VOICE_COPY.ready;
  if (status === "hearing") return VOICE_COPY.hearing;
  if (status === "paused") return VOICE_COPY.paused;
  if (status === "blocked") return VOICE_COPY.blocked;
  if (status === "stalled") return VOICE_COPY.stalled;
  return VOICE_COPY.off;
}

export type VoiceProps = {
  mode: VoiceMode | null;
  status: VoiceStatus;
  echo: VoiceEcho | null;
  onTap: () => void;
  /** What to say while listening, in place of "Sue, next" (B5a: "Sue, stop" while a timer rings). */
  hint?: string;
};

export type VoiceDotProps = VoiceProps;

/**
 * What the voice is hearing or just heard, for the line lifted over the
 * foot's Ask Sous (P63 (a)): an echo, a mishearing, a
 * command's reply, or a listen from a tap in progress. Null at rest, so Ask
 * keeps its own words and the row never refits for what was heard.
 */
export function heardLine(voice: VoiceProps | undefined): string | null {
  if (!voice || voice.status === "unsupported") return null;
  if (voice.status !== "hearing" && voice.echo === null) return null;
  return voiceLabel(voice.status, voice.echo);
}

export function actionOf(mode: VoiceMode | null, status: VoiceStatus): string {
  if (mode === "tap") return status === "hearing" ? VOICE_COPY.stopTalking : VOICE_COPY.talk;
  return status === "off" ? VOICE_COPY.turnOn : VOICE_COPY.turnOff;
}

/**
 * The indicator dot (DS §5: one dot; here it means listening) with a line
 * beside it: what to say, or what was just heard. Soft ink in every state,
 * never an accent: it breathes while listening, and is a ring otherwise.
 * Nothing where the browser can't listen.
 *
 * Where the header is narrow (portrait, or a small landscape screen) the line
 * would push the recipe name onto a second row, so there only what was just
 * heard shows, as a chip under the dot that leaves the header's layout alone.
 */
export function VoiceDot({ mode, status, echo, onTap, hint }: VoiceDotProps) {
  if (status === "unsupported") return null;
  const action = actionOf(mode, status);
  const text = voiceLabel(status, echo, hint);
  // Listening on a tap, a tap does nothing while Ask has the mic.
  const inert = mode === "tap" && status === "paused";

  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={action}
      aria-disabled={inert || undefined}
      title={action}
      data-voice={status}
      // -ml-3 puts the dot itself, not its hit area, on the cook view's edge.
      // The line is at the meta's 22 cpx, the floor (V fix round 1: 16 px).
      className="relative -ml-3 flex min-h-12 min-w-12 max-w-[calc(400*var(--cpx))] cursor-pointer items-center gap-[var(--space-3)] rounded-full px-3 py-2 text-ink-soft focus-visible:outline-3 focus-visible:outline-ink"
    >
      <DotMark status={status} />
      <span aria-live="polite" className="sr-only">
        {text}
      </span>
      <span
        aria-hidden
        data-voice-line
        className="hidden truncate text-[length:var(--type-meta)] leading-tight font-medium lg:landscape:block"
      >
        {text}
      </span>
      {echo && (
        <span
          aria-hidden
          data-voice-echo
          // Keyed by the line, so each new echo fades in afresh.
          key={text}
          className="absolute top-full left-0 mt-1 animate-dot-in whitespace-nowrap rounded-full border border-ink/[.11] bg-paper px-3 py-1.5 text-[length:var(--type-meta)] font-medium text-ink-soft motion-reduce:animate-none lg:landscape:hidden"
        >
          {text}
        </span>
      )}
    </button>
  );
}

/** The statuses in which the mic is open. */
const LIVE: ReadonlySet<VoiceStatus> = new Set(["listening", "hearing"]);

/** The dot itself: filled and breathing while listening, a ring otherwise. */
export function DotMark({ status }: { status: VoiceStatus }) {
  return (
    <span
      aria-hidden
      data-voice-dot={status}
      className={`size-[calc(14*var(--cpx))] shrink-0 rounded-full ${
        LIVE.has(status)
          ? "animate-dot-breathe bg-ink-soft motion-reduce:animate-none"
          : "border-[calc(3*var(--cpx))] border-ink-soft"
      }`}
    />
  );
}

/**
 * The same voice as the bar's, as the dot alone, at the start of Ask's open
 * field. What it hears shows as the field's hint, or as the question asked.
 */
export function VoiceDotButton({
  ref,
  ...voice
}: VoiceProps & { ref?: import("react").Ref<HTMLButtonElement> }) {
  const action = actionOf(voice.mode, voice.status);
  const inert = voice.mode === "tap" && voice.status === "paused";
  return (
    <button
      ref={ref}
      type="button"
      onClick={voice.onTap}
      aria-label={action}
      aria-disabled={inert || undefined}
      data-voice={voice.status}
      className="flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <DotMark status={voice.status} />
    </button>
  );
}

/**
 * What the voice says, for a screen reader: the line the bar shows. It lives
 * apart from the bar and the field, mounted whether Ask is open or not, since
 * a spoken question opens Ask as it is asked.
 */
export function VoiceSaid({ mode, status, echo, hint }: Omit<VoiceProps, "onTap">) {
  const speaks = mode !== null && status !== "unsupported";
  return (
    <span data-voice-said aria-live="polite" className="sr-only">
      {speaks ? voiceLabel(status, echo, hint) : ""}
    </span>
  );
}

