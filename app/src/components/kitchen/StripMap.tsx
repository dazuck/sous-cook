"use client";

/**
 * The strip map at the cook sheet's level 1 (overview slice T3; SPEC §10, the
 * r3 mock's `drawStripMap`): now, the wait the cook is in, the next step large,
 * up to three more, "N more", the next free stretch, and the plate, on the
 * progress line itself. Where everything stands is `layoutStripMap`'s, in
 * counter px from the line's centre; this draws it, scaled by `c`.
 *
 * The time to the table over the plate is the sheet's own button (it travels
 * to level 2's header), so the map leaves it out. The words that count down
 * ("in 12 min", the wait's minutes) are said from the clock's minute, `now`,
 * in the boxes the layout gave them: a tick re-renders words, never the map.
 *
 * At rest the sheet lays the map out again on a minute that changes its
 * stations (a wait ending, a step coming due; T3 follow-up), and asks for it
 * to move (`glide`): every mark and word in both maps moves by its key to its
 * new place on the one curve in 420 ms, the words 160 ms after their marks;
 * what arrives fades in over 280 ms, what leaves fades out over 90 (SPEC §11).
 * A new map without the ask (a level's own layout, a turn) stands at once.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import type { PeekStepRow } from "@/lib/kitchen/cook-phases";
import { SIDE } from "@/lib/kitchen/overview-place";
import { inWords, untilWords, type SmMark, type SmWord, type StripMapDrawing } from "@/lib/kitchen/strip-map";

const INK = "var(--ink)";
/** The map's box over and under the line, cpx: the level-1 sheet's height over it, the foot's under it. */
const ABOVE = 200;
const BELOW = 60;

/** One curve (SPEC §11): geometry 420 ms, opacity in 280 ms, out 90 ms, words 160 ms after their marks. */
const EASE = "cubic-bezier(0.32,0.72,0,1)";
export const MAP_MOVE_MS = 420;
const IN_MS = 280;
const OUT_MS = 90;
export const MAP_WORDS_AFTER_MS = 160;

export interface StripMapProps {
  map: StripMapDrawing;
  /** Counter px. */
  c: number;
  /** The line's centre, px from the top of what holds it. */
  lineTop: number;
  /** The clock's minute: the counting words are said from it. */
  now: number;
  /** Bumped when a new map is to move from the last one by key (a minute's re-layout at rest). */
  glide: number;
  rootRef: Ref<HTMLDivElement>;
  /** Minimal Level 1 3-row upcoming steps drawer (Slice 2B). */
  peekSteps?: PeekStepRow[];
  portrait?: boolean;
  onStepTap?: (row: PeekStepRow) => void;
}

/** A word as said now: its layout's words, or for a counting one, from the clock. */
export function saidNow(w: SmWord, now: number): string[] {
  if (!w.live) return w.lines;
  return [w.live.kind === "in" ? inWords(w.live.at, now) : untilWords(w.live.at, now)];
}

/** A word that moves as itself: the same words at the same size (a counting word counts in its box). */
const sameWord = (a: SmWord, b: SmWord) =>
  a.size === b.size && a.weight === b.weight && a.family === b.family && a.tone === b.tone && (a.live ? !!b.live : a.lines.join("\n") === b.lines.join("\n"));

/** Two maps drawn alike: every station, mark and word the same, in the same place. */
export const sameDrawing = (a: StripMapDrawing, b: StripMapDrawing) => a === b || JSON.stringify(a) === JSON.stringify(b);

interface Glide {
  id: number;
  from: StripMapDrawing;
}

export function StripMap({ map, c, lineTop, now, glide, rootRef, peekSteps, portrait, onStepTap }: StripMapProps) {
  const px = (v: number) => v * c;

  // The map it moves from, while it moves.
  const [shown, setShown] = useState<{ map: StripMapDrawing; glide: number; anim: Glide | null; snap: number }>({ map, glide, anim: null, snap: 0 });
  if (shown.map !== map) {
    const moves = glide !== shown.glide;
    // A map laid out again as it was (a pull's first move lays the sheet out under the finger) changes
    // nothing: a move under way runs on to where it was going (Codex, T3 follow-up).
    if (!moves && sameDrawing(shown.map, map)) setShown({ ...shown, map });
    else setShown({ map, glide, anim: moves ? { id: glide, from: shown.map } : null, snap: !moves && shown.anim ? shown.snap + 1 : shown.snap });
  }
  const anim = shown.anim;
  useEffect(() => {
    if (!anim) return;
    const t = window.setTimeout(
      () => setShown((s) => (s.anim?.id === anim.id ? { ...s, anim: null } : s)),
      MAP_MOVE_MS + MAP_WORDS_AFTER_MS + 100,
    );
    return () => window.clearTimeout(t);
  }, [anim]);

  const root = useRef<HTMLDivElement | null>(null);
  /* eslint-disable react-hooks/immutability -- handing the node to the parent's ref object is what a forwarded ref is for */
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      if (typeof rootRef === "function") rootRef(el);
      else if (rootRef) (rootRef as { current: HTMLDivElement | null }).current = el;
    },
    [rootRef],
  );
  /* eslint-enable react-hooks/immutability */
  // A move cut short (the map laid out again for a level, a turn): what it set running ends where it would.
  useLayoutEffect(() => {
    if (!shown.snap) return;
    for (const a of root.current?.getAnimations({ subtree: true }) ?? []) a.finish();
  }, [shown.snap]);
  // What arrives fades in (its words after their marks); what leaves fades out.
  useLayoutEffect(() => {
    const el = root.current;
    if (!anim || !el) return;
    for (const e of el.querySelectorAll<HTMLElement>("[data-sm-in]")) {
      const word = e.dataset.smIn === "word";
      e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: IN_MS, delay: word ? MAP_WORDS_AFTER_MS : 0, easing: EASE, fill: "backwards" });
    }
    for (const e of el.querySelectorAll<HTMLElement>("[data-sm-out]")) {
      e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: OUT_MS, easing: EASE, fill: "forwards" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per move
  }, [anim?.id]);

  if (peekSteps !== undefined) {
    return (
      <div
        ref={setRoot}
        data-strip-map
        data-rung={map.rung}
        data-fits="true"
        data-tt-at={map.ttAt}
        data-stations={map.stations.map((s) => `${s.key}:${s.kind}`).join(",")}
        data-moving={anim ? "" : undefined}
        className="pointer-events-none absolute left-0 w-full"
        style={{ top: lineTop - px(ABOVE), height: px(ABOVE + BELOW) }}
      >
        <div
          data-peek-list
          className="absolute flex flex-col justify-center gap-[calc(4*var(--cpx))]"
          style={{
            left: px(SIDE),
            right: px(SIDE),
            top: px(ABOVE - (portrait ? 190 : 150) + 38),
            bottom: px(BELOW + 6),
          }}
        >
          {peekSteps.map((row) => (
            <div
              key={row.key}
              data-peek-step={row.key}
              data-station={row.key}
              data-station-kind="step"
              onClick={
                onStepTap
                  ? (e) => {
                      e.stopPropagation();
                      onStepTap(row);
                    }
                  : undefined
              }
              className={`flex min-w-0 items-baseline justify-between gap-[calc(12*var(--cpx))] ${
                onStepTap ? "pointer-events-auto cursor-pointer" : ""
              }`}
            >
              <div className="flex min-w-0 items-baseline gap-[calc(10*var(--cpx))]">
                {row.isMeanwhile && (
                  <span
                    data-peek-meanwhile
                    data-sand=""
                    className="shrink-0 rounded-full bg-sand px-[calc(10*var(--cpx))] py-[calc(2*var(--cpx))] font-semibold whitespace-nowrap text-ink"
                    style={{ fontSize: px(22), lineHeight: `${px(26)}px` }}
                  >
                    Meanwhile
                  </span>
                )}
                <span
                  data-peek-text
                  className="min-w-0 truncate font-medium text-ink"
                  style={{ fontSize: px(24), lineHeight: `${px(28)}px` }}
                >
                  {row.text}
                </span>
              </div>
              <span
                data-peek-minutes
                className="shrink-0 font-medium whitespace-nowrap text-ink-soft tabular-nums"
                style={{ fontSize: px(22), lineHeight: `${px(26)}px` }}
              >
                {row.minutes} min
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const from = anim?.from ?? null;
  const oldMark = new Map((from?.marks ?? []).map((m) => [m.k, m]));
  const oldWord = new Map((from?.words ?? []).map((w) => [w.k, w]));
  const moveMark: CSSProperties | undefined = anim
    ? { transition: `left ${MAP_MOVE_MS}ms ${EASE}, top ${MAP_MOVE_MS}ms ${EASE}, width ${MAP_MOVE_MS}ms ${EASE}, height ${MAP_MOVE_MS}ms ${EASE}` }
    : undefined;
  const moveWord: CSSProperties | undefined = anim
    ? {
        transition: `left ${MAP_MOVE_MS}ms ${EASE} ${MAP_WORDS_AFTER_MS}ms, top ${MAP_MOVE_MS}ms ${EASE} ${MAP_WORDS_AFTER_MS}ms, width ${MAP_MOVE_MS}ms ${EASE} ${MAP_WORDS_AFTER_MS}ms`,
      }
    : undefined;

  const markEl = (m: SmMark, how: "stay" | "in" | "out") => {
    const box: CSSProperties = { left: px(m.x), top: px(m.y + ABOVE), width: px(m.w), height: px(m.h), ...(how === "stay" ? moveMark : {}) };
    const tags = how === "out" ? { "data-sm-out": "" } : { "data-sm-mark": m.role, ...(how === "in" ? { "data-sm-in": "mark" } : {}) };
    const key = how === "out" ? `out:${m.k}:${anim?.id}` : m.k;
    if (m.role === "slash") {
      return (
        <svg key={key} {...tags} aria-hidden viewBox="0 0 28 32" className="absolute overflow-visible" style={box}>
          <path d="M5 30 L13 2 M15 30 L23 2" stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" />
        </svg>
      );
    }
    const round = m.role !== "gap";
    const ring = m.ring ? `inset 0 0 0 ${px(m.ring)}px ${INK}` : undefined;
    const fill = m.role === "gap" || m.role === "open-dot" || m.role === "plate" ? "var(--paper)" : INK;
    return (
      <div
        key={key}
        {...tags}
        aria-hidden
        className="absolute"
        style={{ ...box, background: fill, boxShadow: ring, borderRadius: round ? "9999px" : undefined }}
      />
    );
  };

  const wordEl = (w: SmWord, how: "stay" | "in" | "out") => {
    const tags = how === "out" ? { "data-sm-out": "" } : { "data-sm-word": w.role, ...(how === "in" ? { "data-sm-in": "word" } : {}) };
    // A word that changed (its name set anew, a step grown large) is a new element: the old one goes.
    const key = how === "out" ? `out:${w.k}:${anim?.id}` : how === "in" && oldWord.has(w.k) ? `${w.k}~${anim?.id}` : w.k;
    return (
      <div
        key={key}
        {...tags}
        className="absolute whitespace-nowrap [font-synthesis:none]"
        style={{
          left: px(w.x),
          top: px(w.y + ABOVE),
          width: px(w.w + 1),
          height: px(w.h),
          fontSize: px(w.size),
          lineHeight: `${px(w.lh)}px`,
          fontWeight: w.weight,
          fontFamily: w.family === "display" ? "var(--font-display)" : "var(--font-text)",
          color: w.tone === "soft" ? "var(--ink-soft)" : INK,
          textAlign: w.align,
          ...(how === "stay" ? moveWord : {}),
        }}
      >
        {saidNow(w, now).map((ln, q) => (
          <span key={q} className="block">
            {ln}
          </span>
        ))}
      </div>
    );
  };

  const markHow = (m: SmMark): "stay" | "in" => (!from || oldMark.has(m.k) ? "stay" : "in");
  const wordHow = (w: SmWord): "stay" | "in" => {
    if (!from) return "stay";
    const o = oldWord.get(w.k);
    return o && sameWord(o, w) ? "stay" : "in";
  };
  const newMark = new Set(map.marks.map((m) => m.k));
  const newWord = new Map(map.words.map((w) => [w.k, w]));
  const leavingMarks = from ? from.marks.filter((m) => !newMark.has(m.k)) : [];
  const leavingWords = from
    ? from.words.filter((w) => w.role !== "tt-num" && w.role !== "tt-words" && (!newWord.has(w.k) || !sameWord(w, newWord.get(w.k)!)))
    : [];

  return (
    <div
      ref={setRoot}
      data-strip-map
      data-rung={map.rung}
      data-fits={map.fits ? "true" : "false"}
      data-tt-at={map.ttAt}
      data-moving={anim ? "" : undefined}
      aria-hidden
      className="pointer-events-none absolute left-0 w-full"
      style={{ top: lineTop - px(ABOVE), height: px(ABOVE + BELOW) }}
    >
      {map.stations.map((s) => (
        <div key={s.key} data-station={s.key} data-station-kind={s.kind} className="absolute inset-0">
          {map.marks.filter((m) => m.station === s.key).map((m) => markEl(m, markHow(m)))}
          {map.words
            .filter((w) => w.station === s.key && w.role !== "tt-num" && w.role !== "tt-words")
            .map((w) => wordEl(w, wordHow(w)))}
        </div>
      ))}
      {(leavingMarks.length > 0 || leavingWords.length > 0) && (
        <div className="absolute inset-0">
          {leavingMarks.map((m) => markEl(m, "out"))}
          {leavingWords.map((w) => wordEl(w, "out"))}
        </div>
      )}
    </div>
  );
}
