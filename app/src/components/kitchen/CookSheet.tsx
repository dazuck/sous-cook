"use client";

/**
 * The cook sheet: one look-ahead at three depths, pulled up from the bottom
 * strip (look-ahead slice 1, DS v1.62). At rest the strip alone: Back and
 * Forward with the progress line between them, drawn as work segments with
 * gaps at breaks (`sheet-strip.ts`, `strip-line.ts`). Pulled one level, the
 * peek: a drawer of the next steps rising from the strip's top edge, with ⌄
 * and ^ on its edge (`cook-peek.ts`, `peek-layout.ts`, `PeekRows`). Pulled
 * again, the whole cook: for a derived plan the timetable (`Timetable`) grows
 * up, the top line giving way to it, a touched step read in its header; as
 * written the outline with its read band. The whole cook has no arrow: the
 * strip, Back to step, the down key or Esc leave it. The opening is the
 * timetable over the whole screen. Whole recipe (level 3) is a borrowed screen
 * over it, entered by a cross-fade; the sheet's edge stays where it was.
 *
 * The drawing is `sheet-layout.ts` (where everything stands at each level and
 * between); the motion is `sheet-motion.ts` (the finger, the spring, the
 * glide). This component measures the page, builds the layout, and paints
 * each frame onto element refs, so a pull costs no React render.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { COOK_COPY, initialCookState, levelSaid, type PrepAheadGroup } from "@/lib/kitchen/cook-view";
import { strip as stripOf, type Strip } from "@/lib/kitchen/cook-strip";
import { hitOutline, readStepDetails, type Nudge } from "@/lib/kitchen/cook-levels";
import { prepWords, timedKey, timedStrip, type PotTimer } from "@/lib/kitchen/cook-overview";
import { peekOf } from "@/lib/kitchen/cook-peek";
import { keyLevel, sheetArrowTargets, stripTap } from "@/lib/kitchen/sheet-strip";
import type { PrepMode } from "@/lib/kitchen/cook-plan";
import type { GetOutItem } from "@/lib/kitchen/timetable-layout";
import { buildTimetable } from "@/lib/kitchen/timetable-model";
import {
  advanceFrame,
  buildLayout,
  capFirst,
  clamp,
  frameAt,
  sstep,
  hm,
  tableWords,
  type Frame,
  type Measure,
  type SheetLayout,
} from "@/lib/kitchen/sheet-layout";
import { LINE_H, PAPER_R, TRACK_INK } from "@/lib/kitchen/sheet-derived";
import { JUMP_MS, JUMP_REDUCED_MS, SheetMotion, type Level } from "@/lib/kitchen/sheet-motion";
import type { StripMapDrawing } from "@/lib/kitchen/strip-map";
import { SHEET_CONSTANTS, type PointerZone } from "@/lib/kitchen/sheet-release";
import { ease } from "@/lib/kitchen/spring";
import { keyBelongsToTarget } from "@/lib/kitchen/key-target";
import type { VoiceEcho, VoiceStatus } from "@/hooks/useKitchenVoiceCommands";
import { BorrowedChrome, LEDGE_BAR_CPX } from "./BorrowedChrome";
import { TIMETABLE_MOVE_MS, Timetable } from "./Timetable";
import { EDGE_X } from "./cook-edge";
import { PeekRows, SheetArrow } from "./PeekRows";
import { WholeRecipe, type WholeRecipeProps } from "./WholeRecipe";

export type { Level };

/** The sheet's edge starts this far above its top, so names may stand over it. */
const PAD = 48;

/** Next at the stretch: the rows move up one over this long (N2-3). */
const ADVANCE_MS = 400;

/** A cross-fade (reduced motion, a read band arriving, Whole recipe). */
const FADE_MS = 200;
const FADE_EASE = "cubic-bezier(0.32,0.72,0,1)";

/** The levels' names, for a screen reader and the band's label: a derived plan's level 1 is "Look ahead" (T3). */
export function levelNames(asWritten: boolean): readonly [string, string, string, string] {
  return ["Now", asWritten ? COOK_COPY.untilStepAway : COOK_COPY.lookAhead, COOK_COPY.wholeCook, COOK_COPY.wholeRecipe];
}

export interface CookSheetHandle {
  /** The sheet's own claim on the last touch (N3a), for the swipe hook. */
  claimed: () => boolean;
  /** Glide to a level (a word or a key). */
  goTo: (k: Level) => void;
}

export interface CookSheetProps {
  strip: Strip;
  /** The level asked for (CookScreen's). */
  level: Level;
  onLevel: (k: Level) => void;
  /** The sheet came to rest on a level; `folded`: the step has faded out there (the chart). */
  onSettled?: (k: Level, folded: boolean) => void;
  handleRef: RefObject<CookSheetHandle | null>;
  /** The stage, the stack (the step's block), the foot and the band's slot in the flow. */
  stageRef: RefObject<HTMLDivElement | null>;
  stackRef: RefObject<HTMLDivElement | null>;
  footRef: RefObject<HTMLDivElement | null>;
  slotRef: RefObject<HTMLDivElement | null>;
  /** The foot's middle cell: the strip's line is drawn there, and is the way in (look-ahead slice 1). */
  middleRef?: RefObject<HTMLDivElement | null>;
  /** The step's fit at rest, and what makes its block change (its words, its part, its clock). */
  fit: number;
  /**
   * The fit has run for this step: its block is its size. The fit is the
   * flow's layout effect, which runs after this one, so on Next the step is
   * measured only once it has (else at its unfitted size, and a fit whose
   * scale stays the same would never say so).
   */
  fitReady: boolean;
  stepText: string | null;
  stepShape: string;
  nudge: Nudge | null;
  /** The fit kept room for the nudge's line: draw it (N10). */
  nudgeShown?: boolean;
  /** The nudge's height where it stands, with its gap, for the fit's reserve. */
  onNudgeHeight?: (px: number) => void;
  /** A timer rings: the sheet is not armed; a tap stops the alarm and moves nothing (N10). */
  alarm: boolean;
  onAlarmTap: () => void;
  /** The steps hold the keys (no modal, no panel). */
  keysLive: boolean;
  /** A mark read at the chart (its key). */
  readMark: string | null;
  onReadMark: (key: string | null) => void;
  /** The read mark's Go: a mark's screen as the strip counts it (`goToMark`). */
  onGoToMark: (screen: number) => void;
  whole: Omit<WholeRecipeProps, "asWritten">;
  voice?: { status: VoiceStatus; echo: VoiceEcho | null };
  /** Draw "Say 'Sue, back'" while a level is pinned (voice listening). */
  sayBack: boolean;
  /**
   * The opening (N2-10, N3): the timetable before Prep, with the title over
   * it, on the whole screen. The pull, the band, reading and keys are
   * disarmed while it shows.
   */
  opening: { title: string; handsOn: string | null } | null;
  /** The recipe's name, for the whole cook's header. */
  title: string;
  /** The pots' started timers (by task id) and the wall clock: a timer started re-lays the whole cook (N3-1). */
  pots?: { timers: ReadonlyMap<string, PotTimer>; nowEpochMs: number };
  /** More (`HeaderMore`), hosted at the whole cook and on the opening, where the top line gives way (N3-4(d), (f)). */
  more?: ReactNode;
  /** The opening's controls (`OpeningControls`): the voice dot, the well and Start. */
  openingControls?: ReactNode;
  /** Keep the top line at the whole cook (N3-4(f)'s alternative). */
  topLine?: boolean;
  /** Change the prep mode ("Prep first" | "As I go") from the whole cook's toggle. */
  onMode?: (mode: PrepMode) => void;
  /** Ask Sous when the cook missed an ahead item on the Opening. */
  onAskAhead?: (group: PrepAheadGroup) => void;
}

/** Canvas text metrics with the app's faces, scoped to one layout pass so font-load rebuilds re-measure cleanly. */
function canvasMeasure(ctx: CanvasRenderingContext2D): Measure {
  const cache = new Map<string, number>();
  let lastFont = "";
  return (text, px, weight, family = "text") => {
    const key = `${family}\0${weight}\0${px}\0${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const font = `${weight} ${px}px ${family === "display" ? "Caprasimo" : "Figtree"}`;
    if (font !== lastFont) {
      ctx.font = font;
      lastFont = font;
    }
    const w = ctx.measureText(text).width;
    cache.set(key, w);
    return w;
  };
}

const reducedQuery = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Ink-soft to ember-700, never ember faded through the ground (§1). */
const emberMix = (a: number) => `color-mix(in oklab, var(--ember-700) ${(a * 100).toFixed(1)}%, var(--ink-soft))`;

/** What a rebuild changes, for choosing its transition: the step in hand, the read, the marks. */
function shapeOf(L: SheetLayout): { hand: string; read: string; marks: string } {
  return {
    hand: L.inHand >= 0 ? L.marks[L.inHand].key : "",
    read: L.read?.key ?? L.overview?.read?.key ?? "",
    marks: `${L.asWritten}|${L.marks.map((m) => m.key).join(",")}`,
  };
}

/**
 * Two strip maps whose stations stand alike: the same stations, marks and words in the same places
 * (the counting words and the time to the table not by what they say or their boxes' width). A
 * minute at rest at level 1 that leaves them so lays nothing out (T3 follow-up).
 */
function sameStations(a: StripMapDrawing, b: StripMapDrawing): boolean {
  const st = (m: StripMapDrawing) =>
    JSON.stringify([
      m.rung,
      m.ttAt,
      m.rail,
      m.stations.map((x) => [x.key, x.kind, x.x, x.w, x.big ?? null, x.n ?? null]),
      m.marks.map((x) => [x.k, x.role, x.x, x.y, x.w, x.h, x.ring ?? null]),
      // A counting word's box is measured for the counts still to come, so it narrows as they do: its
      // station's place says where it stands. The time to the table is the sheet's button, said from
      // the clock in the place `ttAt` names.
      m.words
        .filter((x) => x.role !== "tt-num" && x.role !== "tt-words")
        .map((x) => (x.live ? [x.k, x.role, x.y, x.h, x.size] : [x.k, x.role, x.x, x.y, x.w, x.h, x.size, x.lines])),
    ]);
  return st(a) === st(b);
}

/**
 * The peek's rows said the same and the strip's line cut the same (a minute at rest at the peek lays
 * out again only where either changes: a running timer moves the plan's minutes, and with them the
 * line's segments, so a held line would draw the clock's minute at the old place on the way up).
 */
function samePeek(a: SheetLayout, b: SheetLayout): boolean {
  const said = (L: SheetLayout) => (L.peek ? L.peek.rows.map((r) => r.said).join("|") : "");
  const cut = (L: SheetLayout) => (L.stripLine ? L.stripLine.parts.map((p) => `${p.kind}:${p.from.toFixed(2)}-${p.to.toFixed(2)}`).join("|") : "");
  return said(a) === said(b) && cut(a) === cut(b);
}

/** Text placed by a frame: on whole tenths, hidden when clear. */
function place(el: HTMLElement | null | undefined, f: { x: number; y: number; op: number }) {
  if (!el) return;
  el.style.transform = `translate(${f.x.toFixed(1)}px, ${f.y.toFixed(1)}px)`;
  el.style.opacity = f.op.toFixed(3);
  el.style.visibility = f.op > 0.02 ? "visible" : "hidden";
}

/** A part shown at an opacity, hidden when clear. */
function shown(el: HTMLElement | null | undefined, op: number) {
  if (!el) return;
  el.style.opacity = op.toFixed(3);
  el.style.visibility = op > 0.02 ? "visible" : "hidden";
}

function shownOverview(el: HTMLElement | null | undefined, op: number) {
  if (!el) return;
  const vis = op > 0.02;
  el.style.opacity = vis ? "1" : "0";
  el.style.visibility = vis ? "visible" : "hidden";
  el.style.setProperty("--lanes-op", op.toFixed(3));
}

export function CookSheet(props: CookSheetProps) {
  const {
    strip,
    level,
    onLevel,
    onSettled,
    handleRef,
    stageRef,
    stackRef,
    footRef,
    slotRef,
    middleRef,
    fit,
    fitReady,
    stepText,
    stepShape,
    nudge,
    nudgeShown = true,
    onNudgeHeight,
    alarm,
    onAlarmTap,
    keysLive,
    readMark,
    onReadMark,
    onGoToMark,
    whole,
    voice,
    sayBack,
    opening,
    title,
    pots,
    more,
    openingControls,
    topLine = false,
    onMode,
    onAskAhead,
  } = props;
  const hasMore = more != null;
  const hasControls = openingControls != null;

  const layerRef = useRef<HTMLDivElement>(null);
  const wholeRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<HTMLDivElement>(null);
  const nudgeRef = useRef<HTMLDivElement>(null);
  const barEls = useRef<(HTMLElement | null)[]>([]);
  const lab1Els = useRef<(HTMLElement | null)[]>([]);
  const lab2Els = useRef<(HTMLElement | null)[]>([]);
  const nowRef = useRef<HTMLDivElement>(null);
  const endrRef = useRef<HTMLDivElement>(null);
  const hairRef = useRef<HTMLDivElement>(null);
  /** A derived plan's parts (T3): what stands on the screen's own place, the Paper, the line, the strip map. */
  const derivedRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  /** The strip's line (its work segments' fills), the arrow over it, the peek and the arrows on the sheet's edge. */
  const segEls = useRef<(HTMLElement | null)[]>([]);
  const restArrowRef = useRef<HTMLSpanElement>(null);
  const peekRef = useRef<HTMLDivElement>(null);
  const arrows1Ref = useRef<HTMLDivElement>(null);
  /** The foot's middle cell, once mounted: the strip's line is drawn into it. */
  const [cell, setCell] = useState<HTMLDivElement | null>(null);
  // Every commit: the cell is the foot's, a sibling committed after the sheet, so its ref is read
  // once it is there; set only when it changed, so this settles in one pass.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = middleRef?.current ?? null;
    if (el !== cell) setCell(el);
  });
  const ghostRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  /** More and the opening's controls, hosted in the sheet (measured for the layout). */
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const controlsWrapRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const ttRef = useRef<HTMLButtonElement>(null);
  const ttNumRef = useRef<HTMLSpanElement>(null);
  const ttWRef = useRef<HTMLSpanElement>(null);
  const ttSubRef = useRef<HTMLSpanElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const bandRef = useRef<HTMLButtonElement>(null);
  const colRef = useRef<HTMLDivElement>(null);

  const [layout, setLayout] = useState<SheetLayout | null>(null);
  const layoutRef = useRef<SheetLayout | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const [settled, setSettled] = useState<Level>(0);
  const settledRef = useRef<Level>(0);
  const wholeRead = whole.read;
  const onWholeRead = whole.onRead;
  const live = useRef({ alarm, onAlarmTap, onLevel, onSettled, level, keysLive, readMark, onReadMark, nudgeShown, wholeRead, onWholeRead, opening });
  useLayoutEffect(() => {
    live.current = { alarm, onAlarmTap, onLevel, onSettled, level, keysLive, readMark, onReadMark, nudgeShown, wholeRead, onWholeRead, opening };
  });
  /** A rebuild arrived while the sheet moved: build again once it rests. */
  const dirty = useRef(false);
  const keepMeta = useRef(false);
  /** Next at the stretch: the old layout to glide from, and the glide's frame. */
  const tweenFrom = useRef<SheetLayout | null>(null);
  const tweenRaf = useRef(0);
  /** A snapshot of the old look, faded out once the new one is drawn, over its time. */
  const fadeGhost = useRef<HTMLElement | null>(null);
  const fadeMs = useRef(FADE_MS);
  /**
   * A glide draws a layout that is current when it starts (T3 fix round). A level asked for at rest,
   * or a pull's first move, captures the strip as it is (`cap` counts the captures); the layout is
   * laid from it, then the glide starts (`pendingGo`), and never again mid-glide for its own sake.
   * `ownLayout` is the layout laid for the motion under way: its arrival in the DOM must not stand
   * the sheet at a level, which would end the motion it was laid for. `moving` is the cook's pull
   * from rest at Now, which holds Now's strip like any other level.
   */
  const [moving, setMoving] = useState(false);
  const [cap, setCap] = useState(0);
  const capRef = useRef(0);
  const pendingGo = useRef<{ cap: number } | null>(null);
  /** The capture a pull's first move made, until its layout is laid. */
  const prePull = useRef(-1);
  const ownLayout = useRef<SheetLayout | null>(null);
  /**
   * What the last layout was laid for: an outside change (a resize, fonts, the strip's content) ends a
   * glide; the strip it drew, so a minute at rest at level 1 is seen.
   */
  const lastBuilt = useRef<{ rebuild: number; content: string; strip: Strip } | null>(null);
  /**
   * Level 1 at rest is laid out again on a minute that changes its stations, which then move by key
   * (T3 follow-up): `probe` is that layout's capture until laid, `mapGlide` asks the map to move, and
   * `owed` keeps a minute that came while a finger was down for when it lifts (`lifted`).
   */
  const probe = useRef(-1);
  const [, setMapGlide] = useState(0);
  const owed = useRef(false);
  const [lifted, setLifted] = useState(0);
  /**
   * The strip map's or timetable's own reads and Whole recipe answer at rest only (T3 fix round): no
   * glide, spring or pull under way, a glide turned back to the level it left included (T3 follow-up).
   */
  const restsOn = (k: Level) => {
    const m = motion.current;
    return !!m && m.pinned === k && m.resting && !tweenRaf.current;
  };
  /** A pull's first move: capture the strip as it is now and lay it out under the finger. */
  const pullBegan = () => {
    capRef.current += 1;
    prePull.current = capRef.current;
    setMoving(true);
    setCap(capRef.current);
  };
  /** The strip the last layout drew: a new one on the opening is a plan offered there. */
  const drawnStrip = useRef<Strip | null>(null);

  // ---- painting ----
  /** The clock's minute: the whole cook's fill is said from it at every paint, nothing laid out (T3). */
  const liveNow = useRef<number | null>(null);
  /** The end of the step in hand, by the clock's strip: the line's fill at rest is said from it (v1.54). */
  const liveProgress = useRef<number | null>(null);
  /** How far the frames are a straight pass between levels 0 and 2 (0..1): a repaint mid-glide keeps it. */
  const passing = useRef(0);
  const paint = useCallback(
    (s: { Y: number; smooth: boolean; pass?: number }) => {
      const L = layoutRef.current;
      if (!L || !clipRef.current) return;
      if (s.pass !== undefined) passing.current = s.pass;
      const F = frameAt(L, { Y: s.Y, now: liveNow.current ?? undefined, progress: liveProgress.current ?? undefined, pass: passing.current });
      frameRef.current = F;
      apply(L, F, !s.smooth);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** The sheet came to rest on k (from the motion, or a layout standing it there). */
  const rested = useCallback((k: Level) => {
    const was = settledRef.current;
    settledRef.current = k;
    setSettled(k);
    setMoving(false);
    ownLayout.current = null;
    // Back at Now from a level, focus returns to the band (it was hidden while pinned).
    if (k === 0 && was !== 0) {
      const a = document.activeElement;
      // (Whole recipe's screen, open or fading out, hands focus back here too.)
      if (!a || a === document.body || layerRef.current?.contains(a) || wholeRef.current?.contains(a)) {
        requestAnimationFrame(() => bandRef.current?.focus({ preventScroll: true }));
      }
    }
    // At the chart the step has faded out: its clock walks to the well (N10).
    live.current.onSettled?.(k, k >= 2);
    if (dirty.current) {
      dirty.current = false;
      setRebuild((n) => n + 1);
    }
  }, []);

  // ---- the motion ----
  const motion = useRef<SheetMotion | null>(null);
  if (motion.current === null && typeof window !== "undefined") {
    motion.current = new SheetMotion({
      raf: (cb) => requestAnimationFrame(cb),
      caf: (id) => cancelAnimationFrame(id),
      now: () => performance.now(),
      reduced: reducedQuery,
      detents: () => layoutRef.current?.detents ?? null,
      paint: (s) => paint(s),
      onLevel: (k) => live.current.onLevel(k),
      onSettled: (k) => rested(k),
      crossfade: (applyIt, ms) => {
        const g = snapshot();
        applyIt();
        if (g) fadeOut(g, ms);
      },
    });
  }
  useEffect(
    () => () => {
      motion.current?.dispose();
      if (tweenRaf.current) cancelAnimationFrame(tweenRaf.current);
      // The top line is the page's again (the sheet faded it at the whole cook).
      const header = document.querySelector<HTMLElement>("[data-cook-header]");
      if (header) {
        header.style.opacity = "";
        header.style.visibility = "";
      }
    },
    [],
  );

  // A level asked for by a word, a key or a tap: glide there. Declared before
  // the layout's effect, so a level and a layout changing together (Start on
  // the opening) glide on the old layout and rebuild once at rest.
  // The opening's Start is a cut under a 320 ms cross-fade (N3-3): the lanes
  // fade out over Now, and the top line and the foot fade in.
  const wasOpening = useRef(opening !== null);
  useLayoutEffect(() => {
    const m = motion.current;
    const started = wasOpening.current && opening === null;
    wasOpening.current = opening !== null;
    if (!m) return;
    if (started && level === 0) {
      if (tweenRaf.current) finishTween();
      m.jump(0);
      const ms = reducedQuery() ? JUMP_REDUCED_MS : JUMP_MS;
      const header = document.querySelector<HTMLElement>("[data-cook-header]");
      for (const el of [header, footRef.current]) el?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: FADE_EASE });
      return;
    }
    if (m.pinned === level) return;
    if (tweenRaf.current) finishTween();
    // The strip is captured for the level asked for: laid out again from it (T3 fix round).
    capRef.current += 1;
    setCap(capRef.current);
    // From rest, between Now and the chart, the glide waits for that layout (the effect after the
    // layout's); a glide redirected mid-way keeps the layout it is drawing, and Whole recipe borrows
    // the screen without one.
    if (level !== 3 && m.pinned !== 3 && !m.pulling && m.settled === m.pinned) {
      pendingGo.current = { cap: capRef.current };
      return;
    }
    m.goTo(level);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, opening]);

  // The alarm returns a pinned stretch or chart to Now, and it stays (N10);
  // the opening doesn't fold on an alarm (N2-10).
  useEffect(() => {
    if (alarm && !opening && (level === 1 || level === 2)) live.current.onLevel(0);
  }, [alarm, level, opening]);

  handleRef.current = {
    claimed: () => motion.current?.claimed() ?? false,
    goTo: (k) => live.current.onLevel(k),
  };

  // What the sheet draws is held at a resting level (N3-1, T3): it is laid
  // out again when a level is asked for (before its glide), a pull begins, on
  // an advance, a timer started or a prep mode chosen, never on a tick, a whole
  // minute's included (the strip itself is rebuilt every minute while a timer
  // runs). The line's fill and the strip map's counting words are said from
  // the clock without a layout. At rest at Now (the line alone) the sheet is
  // laid out on the minute, so a pull from there draws the strip as it is
  // (T3 fix round).
  const inHandKey = strip.marks.find((m) => m.state === "in-hand")?.key ?? "";
  const timersKey = pots
    ? [...pots.timers.entries()]
        .map(([id, t]) => `${id}:${t.endsAtEpochMs}`)
        .sort()
        .join(",")
    : "";
  const marksKey = strip.marks.map((m) => m.key).join(",");
  const contentKey = `${strip.mode}|${inHandKey}|${timersKey}|${strip.asWritten}|${marksKey}`;
  const atNow = level === 0 && settled === 0 && !moving;
  const holdKey = !opening && !atNow ? `${cap}|${contentKey}` : null;
  // The pots' timers decide their ends and their done (N3): drawn so when laid out, and live for the steps' states.
  // Read through `timedKey`: the same key, the same timed strip, so the clock's half-second tick lays
  // nothing out again at any level; a minute or a timer's end does (cook-overview.test.ts).
  const potsKey = pots ? timedKey(pots.timers, pots.nowEpochMs) : null;
  const timed = useMemo(
    () => (pots ? timedStrip(strip, pots.timers, pots.nowEpochMs) : strip),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pots` is read through `potsKey` (above)
    [strip, potsKey],
  );
  const [held, setHeld] = useState<{ key: string | null; strip: Strip }>(() => ({ key: holdKey, strip: timed }));
  if (held.key !== holdKey) setHeld({ key: holdKey, strip: timed });
  const drawn = holdKey !== null && held.key === holdKey ? held.strip : timed;
  const plan = whole.plan;
  const state = whole.state;
  // The plan's tasks, by id: the strip map names its steps by them.
  const tasks = useMemo(() => (plan ? new Map(plan.tasks.map((t) => [t.id, t])) : undefined), [plan]);
  // The nudge's place is laid out; its words are said as they come (a tick changes them, not the layout).
  const nudgeKey = nudge ? `${nudge.kind}|${nudge.target.key}|${nudge.at}` : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read through `nudgeKey`
  const nudgeIn = useMemo(() => (nudge ? { text: nudge.text, targetKey: nudge.target.key, at: nudge.at } : null), [nudgeKey]);

  // The read at the whole cook: the touched step's words (N2-4, N3-9). A gap
  // in the timetable reads nothing (DECISIONS 2026-10-20, T2 call 8).
  const readIn = useMemo((): { key: string; text: string; go: "step" | "prep" | null } | null => {
    if (readMark === null || level !== 2) return null;
    const mark = drawn.marks.find((m) => m.key === readMark) ?? drawn.prepMarks?.find((m) => m.key === readMark);
    if (!mark) {
      if (readMark === "prep" && drawn.hasMise && !drawn.asWritten) {
        return {
          key: "prep",
          text: `${COOK_COPY.prepChapter} · ${drawn.onPrep ? COOK_COPY.prepAllAsYouCook : COOK_COPY.prepDone}`,
          go: "prep",
        };
      }
      return null;
    }
    if (mark.key === "prep" && !drawn.asWritten) return { key: mark.key, text: prepWords(mark, false).read, go: "prep" };
    // A prep card goes to the Prep screen, or in "Prep first" to its own prep page, a step like any other (DS v1.59).
    return { key: mark.key, text: readStepDetails(mark, plan, state).text, go: drawn.prepScreen && mark.screen === 0 ? "prep" : "step" };
  }, [readMark, level, drawn, plan, state]);

  // Each prep mode's plan from the top: the other mode's scale (both share one) and the lanes' order.
  const fresh = useMemo(
    () => (!plan || drawn.asWritten ? null : { plan, first: stripOf(plan, initialCookState("first")), go: stripOf(plan, initialCookState("go")) }),
    [plan, drawn.asWritten],
  );
  const timetable = useMemo(() => {
    if (!fresh) return null;
    const mode: PrepMode = drawn.mode ?? "first";
    const first = mode === "first" ? drawn : fresh.first;
    const go = mode === "go" ? drawn : fresh.go;
    const t = buildTimetable(fresh.plan, first, go, mode);
    const other = buildTimetable(fresh.plan, first, go, mode === "first" ? "go" : "first", { now: 0 });
    return t && other ? { t, other } : null;
  }, [drawn, fresh]);
  // Get out: the recipe's lines as stored, a blank one left out.
  const getOut = useMemo<GetOutItem[]>(
    () =>
      whole.ingredients.flatMap((l, index) =>
        l === null ? [] : [{ index, amount: l.kind === "to_taste" || l.kind === "unstated" ? null : l.amount, name: l.name }],
      ),
    [whole.ingredients],
  );
  const scaleNote =
    whole.recipe && whole.scales !== false && whole.servings !== undefined && whole.servings !== whole.recipe.serves_base
      ? COOK_COPY.scaleNote(whole.servings)
      : null;

  // ---- the layout: measured from the page ----
  const [rebuild, setRebuild] = useState(0);
  /** Until when a prep mode's marks glide (performance.now()): the timetable takes no reads before. */
  const glideUntil = useRef(0);
  const canvasCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  useLayoutEffect(() => {
    const stack = stackRef.current;
    const foot = footRef.current;
    const slot = slotRef.current;
    if (!foot || !slot || !fitReady) return;
    const m = motion.current;
    // Laid for a motion about to start, or just started under the finger (T3 fix round).
    const own = pendingGo.current?.cap === cap || prePull.current === cap;
    if (!own) {
      // A finger down on the sheet or the line, pulling or not yet (T3 follow-up): nothing is laid
      // out under it; it is when the finger lifts (or the pull lands).
      if (tweenRaf.current || m?.touching) {
        dirty.current = true;
        return;
      }
      // Mid-glide, what the glide itself brings (a read put away with its level) waits for it to
      // land; anything from outside it (a rotation, fonts, Next, a timer, a prep mode) ends it, the
      // marks landing in the new layout's place (T3 fix round).
      const lb = lastBuilt.current;
      if (m && m.settled !== m.pinned && lb && lb.rebuild === rebuild && lb.content === contentKey) {
        dirty.current = true;
        return;
      }
    }
    if (!canvasCtxRef.current) {
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) throw new Error("no 2d canvas to measure the sheet's names");
      canvasCtxRef.current = ctx;
    }
    const measure = canvasMeasure(canvasCtxRef.current);
    const VW = document.documentElement.clientWidth;
    const H = window.innerHeight;
    // Beside Ask's side panel the sheet's layer gives up the panel's width, as the stage does
    // (`--ask-room`; DS §5 Ask, v1.60): the line and its marks are laid in what is left. The
    // frame's unit and its posture stay the screen's.
    const room = layerRef.current ? VW - layerRef.current.getBoundingClientRect().width : 0;
    const W = room > 0.5 ? VW - room : VW;
    const c = Math.min(Math.max(VW, H) / 960, Math.min(VW, H) / 600);
    const header = document.querySelector<HTMLElement>("[data-cook-header]");
    const top = header ? header.getBoundingClientRect().bottom : 92 * c;
    const nowEl = stack?.querySelector<HTMLElement>(':scope > [data-role="now"]') ?? null;
    const was = stack?.style.transform ?? "";
    const wasMeta = stack?.style.getPropertyValue("--look-meta") ?? "";
    if (stack) {
      stack.style.transform = "none";
      // The step as it rests, its meta whole, whatever level the sheet stands at.
      stack.style.setProperty("--look-meta", "1");
    }
    const E = stack ? parseFloat(getComputedStyle(stack).paddingLeft) : 48;
    let step: Parameters<typeof buildLayout>[0]["step"] = null;
    if (nowEl && stepText) {
      const r = nowEl.getBoundingClientRect();
      const face = nowEl.querySelector<HTMLElement>("[data-face]:not([hidden])");
      let textB = face ? face.getBoundingClientRect().bottom : r.top;
      if (stack && face?.dataset.face === "rows") {
        // A prep page's tick rows (DS v1.59): the lines their amounts dropped to go as the sheet
        // rises (`PrepRows`), so what stays is the rows without them, measured as they then stand.
        stack.style.setProperty("--look-meta", "0");
        textB = face.getBoundingClientRect().bottom;
        stack.style.setProperty("--look-meta", "1");
      }
      const time = nowEl.querySelector<HTMLElement>("[data-time]");
      // A part of pairs alone has no words: its meta is what it says, and stays.
      const wordless = !face || !face.textContent?.trim();
      keepMeta.current = wordless;
      const keep = wordless
        ? r.bottom
        : time && time.querySelector('[data-timer="running"]')
          ? time.getBoundingClientRect().bottom
          : textB;
      let ink = 0;
      if (face) {
        const rg = document.createRange();
        rg.selectNodeContents(face);
        for (const q of rg.getClientRects()) ink = Math.max(ink, q.right - E);
      }
      step = {
        textH: textB - r.top,
        keepH: Math.max(textB, keep) - r.top,
        fullH: r.height,
        inkW: Math.max(ink, 1),
        restFit: fit,
        text: stepText,
      };
    }
    const stepTop = nowEl ? nowEl.getBoundingClientRect().top : top;
    if (stack) {
      stack.style.transform = was;
      if (wasMeta) stack.style.setProperty("--look-meta", wasMeta);
      else stack.style.removeProperty("--look-meta");
    }
    // The chrome the whole cook hosts, at its size on screen (N3-4(d), (f)).
    const mw = moreWrapRef.current;
    const cw = controlsWrapRef.current;
    const chrome = {
      more: { w: mw?.offsetWidth ?? 0, h: mw?.offsetHeight ?? 0 },
      controls: opening && cw ? { w: cw.offsetWidth, h: cw.offsetHeight } : null,
      hint: sayBack && !opening,
    };
    // The strip's line: the foot's middle cell, where the sheet draws it (look-ahead slice 1).
    // FIXME(look-ahead slice 1): when the step's own running clock walks into the well on landing
    // at the whole cook (N10, `clockInWell`), the cell narrows and the line is laid again in one
    // step, so its left end jumps by the clock's width (about 245 px at 1280 wide), and back on
    // leaving it. The fill holds its minute through it; a glide of the line's box (or the well's
    // room kept while the step's clock runs) is the fix, left for a later design round
    // (DECISIONS 2026-11-23, look-ahead slice 1, "the line makes room for the well's clock").
    const cellR = opening ? null : (middleRef?.current?.getBoundingClientRect() ?? null);
    const lineBox = cellR && cellR.width > 0 ? { x0: cellR.left, x1: cellR.right, y: cellR.top + cellR.height / 2 } : null;
    const L = buildLayout({
      strip: drawn,
      geo: {
        W,
        H,
        c,
        E,
        top,
        stepTop,
        footTop: foot.getBoundingClientRect().top,
        ledgeTop: H - LEDGE_BAR_CPX * c,
        portrait: H > VW,
      },
      step,
      nudge: nudgeIn,
      read: readIn,
      opening: opening ? { getOut, scaleNote, handsOn: opening.handsOn } : null,
      timetable,
      title: opening ? opening.title : title,
      measure,
      chrome,
      topLine,
      tasks,
      peek: plan && !opening ? peekOf(plan, state, drawn) : null,
      lineBox,
    });
    const prev = layoutRef.current;
    // A minute at rest at level 1 (T3 follow-up): laid out again only where its stations change;
    // the map is held as it was where they don't (the counting words say the minute in their boxes).
    const probing = probe.current === cap;
    if (probing) probe.current = -1;
    if (probing && prev?.derived && L.derived && sameStations(prev.derived.map, L.derived.map) && samePeek(prev, L)) return;
    // How the new look arrives: Next at a pinned stretch glides the rows
    // (N2-3; a cross-fade under reduced motion); a read arriving or leaving at
    // the whole cook cross-fades (N2-4).
    const modeChanged = drawnStrip.current !== null && drawnStrip.current.mode !== drawn.mode;
    fadeMs.current = FADE_MS;
    // Any re-layout but a prep mode's own ends its glide (`Timetable` snaps the marks to the new
    // layout), and with it the wait for the marks to land: a tap reads what is drawn at once.
    glideUntil.current = 0;
    // A prep mode chosen: the timetable moves its marks by key to their new minutes (SPEC §11,
    // `Timetable`); under reduced motion the old look cross-fades out instead, opacity only.
    // A plan offered on the opening re-lays the timetable under Start's cross-fade (N3, failure
    // row "Plan offered while the opening shows"): 320 ms, 200 under reduced motion.
    if (probing && prev?.derived && prev.geo.W === W && prev.geo.H === H) {
      // Its stations move by key to their new places (SPEC §11); under reduced motion the old map
      // cross-fades out over 200 ms, opacity only.
      if (reducedQuery()) fadeGhost.current = snapshot();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM-measured layout triggers strip-map key glide before paint
      else setMapGlide((n) => n + 1);
    } else if (modeChanged && prev && prev.geo.W === W && prev.geo.H === H) {
      if (reducedQuery()) fadeGhost.current = snapshot();
      // While the marks glide to their new minutes, a tap would read where they are going, not
      // where they are drawn: the timetable takes no reads until they land.
      else glideUntil.current = performance.now() + TIMETABLE_MOVE_MS;
    } else if (opening && prev?.overview?.opening && drawnStrip.current !== drawn && !modeChanged && prev.geo.W === W && prev.geo.H === H) {
      fadeGhost.current = snapshot();
      fadeMs.current = reducedQuery() ? JUMP_REDUCED_MS : JUMP_MS;
    } else if (!own && prev && m && m.pinned === level && m.pinned === m.settled && prev.geo.W === W && prev.geo.H === H) {
      // (A layout laid for a level about to glide arrives with the glide: no cross-fade over it.)
      const a = shapeOf(prev);
      const b = shapeOf(L);
      const k = m.pinned;
      if (k === 1 && a.hand !== b.hand) {
        // FIXME(T3): a derived plan's strip map cross-fades on Next rather than moving its stations
        // by key (SPEC §11's "a mark that exists before and after moves" has no level-1 advance
        // spelled out; DECISIONS 2026-10-21 "Slice T3", call 10).
        if (reducedQuery() || L.derived) fadeGhost.current = snapshot();
        else tweenFrom.current = prev;
      } else if (k === 2 && !modeChanged && (a.read !== b.read || a.marks !== b.marks)) {
        fadeGhost.current = snapshot();
      }
    }
    drawnStrip.current = drawn;
    liveNow.current = timed.now;
    liveProgress.current = timed.progress;
    layoutRef.current = L;
    lastBuilt.current = { rebuild, content: contentKey, strip: drawn };
    if (own) ownLayout.current = L;
    setLayout(L);
    // How many layouts it has laid, for the e2e: what lays the sheet out again, and what doesn't.
    if (layerRef.current) layerRef.current.dataset.layouts = String(Number(layerRef.current.dataset.layouts ?? 0) + 1);
    // the band's slot holds the band's height in the flow
    slot.style.height = `${L.band}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `timed.now` is painted, not laid out (the held rule)
  }, [drawn, fit, fitReady, stepText, stepShape, nudgeIn, readIn, opening, title, getOut, scaleNote, timetable, topLine, sayBack, tasks, rebuild, stackRef, footRef, slotRef]);

  // Resizes, rotations and fonts rebuild it.
  useEffect(() => {
    const again = () => setRebuild((n) => n + 1);
    // A rotation mid-pull: the browser cancels the pointer; the prior level
    // is drawn in the new layout at once (N3, failure row "Rotation mid-pull").
    const turned = () => {
      if (motion.current?.pulling) {
        motion.current.reflow();
        setMoving(false);
      }
      again();
    };
    window.addEventListener("resize", turned);
    document.fonts.addEventListener("loadingdone", again);
    const ro = new ResizeObserver(again);
    if (stageRef.current) ro.observe(stageRef.current);
    // More and the opening's controls change size (a well arriving, "Noted"): place them again.
    for (const el of [moreWrapRef.current, controlsWrapRef.current, cell]) if (el) ro.observe(el);
    return () => {
      window.removeEventListener("resize", turned);
      document.fonts.removeEventListener("loadingdone", again);
      ro.disconnect();
    };
  }, [stageRef, hasMore, hasControls, cell]);

  // A new layout drawn into the DOM: stand at the pinned level (or glide the rows there).
  useLayoutEffect(() => {
    if (!layout) return;
    const nd = nudgeRef.current;
    if (nd && onNudgeHeight) onNudgeHeight(Math.ceil(nd.offsetHeight + 10 * layout.geo.c));
    const from = tweenFrom.current;
    tweenFrom.current = null;
    if (from) {
      const t0 = performance.now();
      const tick = () => {
        const p = Math.min(1, (performance.now() - t0) / ADVANCE_MS);
        const F = advanceFrame(from, layout, ease(p));
        frameRef.current = F;
        apply(layout, F);
        if (p >= 1) finishTween();
        else tweenRaf.current = requestAnimationFrame(tick);
      };
      tweenRaf.current = requestAnimationFrame(tick);
      tick();
    } else if (layout === ownLayout.current) {
      // Laid for the motion under way (T3 fix round): it carries on, drawn in this layout.
      ownLayout.current = null;
      const m = motion.current;
      if (m) paint({ Y: m.Y, smooth: m.pulling || m.settled !== m.pinned });
      syncSettled();
    } else {
      const m = motion.current;
      m?.reflow();
      syncSettled();
      // A re-layout ends any motion but a pull in hand (a rotation's reflow cancelled that too).
      if (!m?.pulling) setMoving(false);
    }
    const g = fadeGhost.current;
    fadeGhost.current = null;
    if (g) fadeOut(g, fadeMs.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // A level asked for at rest glides once its layout is laid (the level's effect, above); a pull's
  // capture is spent once laid (T3 fix round).
  useLayoutEffect(() => {
    if (prePull.current === cap) prePull.current = -1;
    const p = pendingGo.current;
    if (!p || p.cap !== cap) return;
    pendingGo.current = null;
    const m = motion.current;
    if (m && m.pinned !== level) m.goTo(level);
  });

  // A minute at rest at level 1 (T3 follow-up): the strip as the clock has it now is laid out, and
  // the stations move to it if they changed. Only the clock's own changes come here (anything else
  // that changes the strip lays it out on its own way), never the half-second tick (`timed` is the
  // same strip within a minute), and not under a finger: then once it lifts.
  useEffect(() => {
    const m = motion.current;
    const lb = lastBuilt.current;
    if (!m || opening || level !== 1 || !layoutRef.current?.derived || !lb || lb.content !== contentKey || lb.strip === timed) return;
    if (m.touching) {
      owed.current = true;
      return;
    }
    owed.current = false;
    if (!restsOn(1)) return;
    capRef.current += 1;
    probe.current = capRef.current;
    setCap(capRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the clock's strip (and a lifted finger) bring it
  }, [timed, lifted]);

  // The alarm, the fit's room for the nudge, the read's ring and the clock's minute (the line's
  // fill) change what draws, not where: draw again.
  useEffect(() => {
    liveNow.current = timed.now;
    liveProgress.current = timed.progress;
    const m = motion.current;
    if (m && layoutRef.current && !tweenRaf.current) paint({ Y: m.Y, smooth: false });
  }, [alarm, nudgeShown, readMark, timed.now, timed.progress, paint]);

  /** The rows' glide is done (or cut short by a touch or a level): stand at the level. */
  function finishTween() {
    if (tweenRaf.current) cancelAnimationFrame(tweenRaf.current);
    tweenRaf.current = 0;
    motion.current?.reflow();
    syncSettled();
    if (dirty.current) {
      dirty.current = false;
      setRebuild((n) => n + 1);
    }
  }

  /**
   * A level reached with no layout to glide in (the first one, the opening's
   * level 2) rests without the motion saying so: say it here.
   */
  function syncSettled() {
    const m = motion.current;
    if (m && m.settled === m.pinned && settledRef.current !== m.settled) rested(m.settled);
  }

  // ---- cross-fades: the old look, cloned, fades out over the new one ----
  function snapshot(): HTMLElement | null {
    const layer = layerRef.current;
    if (!layer?.parentElement) return null;
    const ghost = layer.cloneNode(true) as HTMLElement;
    // The ghost is a picture: none of its parts answer to the page's names (the e2e's, a reader's).
    for (const el of [ghost, ...ghost.querySelectorAll("*")]) {
      for (const a of [...el.attributes]) if (a.name.startsWith("data-") || a.name === "id") el.removeAttribute(a.name);
    }
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    ghost.style.cssText += ";pointer-events:none;z-index:1";
    layer.parentElement.appendChild(ghost);
    return ghost;
  }
  function fadeOut(ghost: HTMLElement, ms = FADE_MS) {
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: FADE_EASE, fill: "forwards" });
    fade.onfinish = () => ghost.remove();
  }

  // ---- apply a frame to the DOM ----
  /** `rest`: the frame the sheet stands at (a landing, a layout, a minute), not one of a motion's. */
  function apply(L: SheetLayout, F: Frame, rest = false) {
    const g = L.geo;
    const c = g.c;
    const clip = clipRef.current!;
    const Y = F.sheetTop;
    clip.style.top = `${(Y - PAD).toFixed(1)}px`;
    clip.style.height = `${Math.max(PAD + 2, F.sheetBottom - Y + PAD).toFixed(1)}px`;
    if (planRef.current) planRef.current.style.transform = `translateY(${PAD}px)`;
    const stack = stackRef.current;
    if (stack && F.step) {
      stack.style.transformOrigin = "var(--edge) 0";
      // A motion's frames scale the step on the compositor; the frame it rests at sets the resting
      // scale once, painted fresh at that scale, so no glyph cached at one of the motion's scales is
      // what it rests on (the look-stretch pixels varied run to run before; T3 fix round).
      stack.style.willChange = rest ? "" : "transform";
      stack.style.transform = F.step.scale < 0.9999 ? `scale(${F.step.scale.toFixed(4)})` : "";
      stack.style.opacity = F.step.op < 0.9999 ? F.step.op.toFixed(3) : "";
      // The step's ember turns ink-soft before it fades (§1): only while it moves.
      if (F.step.ember < 0.999) stack.style.setProperty("--look-tone", emberMix(F.step.ember));
      else stack.style.removeProperty("--look-tone");
      stack.style.setProperty("--look-meta", keepMeta.current ? "1" : F.step.meta.toFixed(3));
    } else if (stack) {
      stack.style.willChange = "";
      stack.style.transform = "";
      stack.style.opacity = "";
    }
    const nd = nudgeRef.current;
    if (nd) {
      // The nudge steps aside for the alarm, and where the fit kept no room for it.
      const op = live.current.alarm || !live.current.nudgeShown ? 0 : F.nudge.op;
      nd.style.opacity = op.toFixed(3);
      nd.style.transform = `translateY(${F.nudge.dy.toFixed(1)}px)`;
      nd.style.visibility = op > 0.001 ? "visible" : "hidden";
    }
    const rm = live.current.readMark;
    for (const j of L.order) {
      const el = barEls.current[j];
      const b = F.bars[j];
      if (!el || !b) continue;
      // Marks stand on whole pixels: a fractional edge is antialiased per
      // raster tile, so two draws of one frame could differ by a shade.
      const x0 = Math.round(b.x);
      const y0 = Math.round(b.y);
      const w = Math.max(1, Math.round(b.x + b.w) - x0);
      const h = Math.max(1, Math.round(b.y + b.h) - y0);
      const fill = Math.round(b.fill);
      el.style.transform = `translate(${x0}px, ${y0}px)`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.opacity = b.op.toFixed(3);
      const base = L.looks[j].base;
      el.style.background =
        fill > 0 && fill < w
          ? `linear-gradient(to right, var(--ink) 0 ${fill}px, ${base} ${fill}px)`
          : fill >= w
            ? "var(--ink)"
            : base;
      const read = rm !== null && L.marks[j].key === rm && F.d > 1.5;
      el.style.boxShadow = read ? "0 0 0 2px var(--ink)" : L.looks[j].ring || "none";
    }
    F.labs1.forEach((f, j) => place(lab1Els.current[j], f));
    F.labs2.forEach((f, j) => place(lab2Els.current[j], f));
    // A derived plan (T3): its parts stand on the screen's own place, the Paper rising, the line still.
    const D = L.derived;
    const DF = F.derived;
    if (D && DF) {
      if (derivedRef.current) derivedRef.current.style.transform = `translateY(${(L.detents[2] - Y).toFixed(1)}px)`;
      if (paperRef.current) paperRef.current.style.transform = `translateY(${(DF.paperTop - L.detents[2]).toFixed(1)}px)`;
      const ov = overviewRef.current;
      shownOverview(ov, DF.lanes);
      ov?.style.setProperty("--grow", DF.grow.toFixed(4));
      ov?.style.setProperty("--words-op", DF.words.toFixed(3));
    } else {
      // As written: the outline (level 2's lanes are a derived plan's only).
      shownOverview(overviewRef.current, F.lanes);
    }
    // The strip's line (look-ahead slice 1): each work segment filled to the frame's minute (the end
    // of the step in hand at rest and under the peek; a derived plan's glides to the clock's minute on
    // the way to the whole cook); the arrow over it while the sheet rests; the peek's rows; the arrows
    // on the sheet's edge, on the Paper's top.
    const SL = L.stripLine;
    if (SL && F.fillMin !== undefined) {
      let k = 0;
      for (const p of SL.parts) {
        if (p.kind !== "work") continue;
        const el = segEls.current[k++];
        if (el) el.style.transform = `scaleX(${clamp((F.fillMin - p.from) / Math.max(1e-9, p.to - p.from), 0, 1).toFixed(4)})`;
      }
    }
    shown(restArrowRef.current, L.peek ? 1 - sstep(0, 0.3, F.d) : 0);
    shown(peekRef.current, F.peek ?? 0);
    const edge = DF ? DF.paperTop - Y : 0;
    const arrows = arrows1Ref.current;
    if (arrows) {
      arrows.style.transform = `translateY(${edge.toFixed(1)}px)`;
      shown(arrows, 1 - clamp(Math.abs(F.d - 1) / 0.25, 0, 1));
    }
    if (nowRef.current) {
      nowRef.current.style.transform = `translate(${(F.now.x - 1).toFixed(1)}px, ${F.now.y0.toFixed(1)}px)`;
      nowRef.current.style.height = `${F.now.h.toFixed(1)}px`;
      nowRef.current.style.opacity = F.now.op.toFixed(3);
    }
    if (endrRef.current) {
      // A hairline on whole pixels: at a fractional x the raster tiles antialias it unevenly.
      endrRef.current.style.transform = `translate(${Math.round(F.endr.x)}px, ${Math.round(F.endr.y0)}px)`;
      endrRef.current.style.height = `${Math.round(F.endr.h)}px`;
      endrRef.current.style.opacity = F.endr.op.toFixed(3);
    }
    if (hairRef.current) {
      hairRef.current.style.transform = `translate(${g.E}px, 0px)`;
      hairRef.current.style.width = `${g.W - 2 * g.E}px`;
      hairRef.current.style.opacity = F.hair.toFixed(3);
    }
    shown(ghostRef.current, L.overview ? F.lanes : F.chart);
    shown(moreRef.current, F.chart);
    shown(readRef.current, F.chart);
    // The whole cook (derived): the chrome the timetable hosts comes in with its words.
    shown(moreWrapRef.current, L.overview && (!L.topLine || L.opening) ? F.lanes : 0);
    shown(controlsWrapRef.current, L.opening ? F.lanes : 0);
    // The top line gives way to the lanes (N3-4(f)); on the opening it is gone.
    const header = document.querySelector<HTMLElement>("[data-cook-header]");
    if (header) shown(header, F.header);
    if (ttRef.current && ttNumRef.current && ttWRef.current && ttSubRef.current) {
      ttRef.current.style.transform = `translate(${F.tt.x.toFixed(1)}px, ${F.tt.y.toFixed(1)}px)`;
      ttRef.current.style.color = `color-mix(in oklab, var(--ink) ${(F.tt.col * 100).toFixed(1)}%, var(--ink-soft))`;
      // Its plate is the ground it stands on (as written); a derived plan's stands on its Paper, clear of
      // every mark, and keeps none (its words would cover the plate's ring).
      ttRef.current.style.setProperty("--tt-bg", L.derived ? "transparent" : "var(--ground)");
      shown(ttRef.current, L.derived ? (DF ? DF.lanes * F.tt.op : 0) : F.tt.op);
      ttNumRef.current.style.fontSize = `${F.tt.n.toFixed(2)}px`;
      // On the plate the number is right-set over the ring: a count to fewer figures keeps that edge.
      ttNumRef.current.style.textAlign = L.derived?.map.ttAt === "plate" && F.d <= 1.5 ? "right" : "left";
      ttWRef.current.style.fontSize = `${F.tt.w.toFixed(2)}px`;
      // On the plate its words stand under the rail (T3).
      ttWRef.current.style.transform = F.tt.wx || F.tt.wy ? `translate(${F.tt.wx.toFixed(1)}px, ${F.tt.wy.toFixed(1)}px)` : "";
      ttSubRef.current.style.opacity = F.tt.sub.toFixed(3);
      // Unseen, the hands-on line takes no taps: it hangs under the button, over what stands there.
      ttSubRef.current.style.pointerEvents = F.tt.sub > 0.5 ? "" : "none";
    }
    const hint = hintRef.current;
    if (hint) {
      hint.style.opacity = F.hint.toFixed(3);
      // Under the time to the table (and the ghost under it, at the chart);
      // in portrait, where the rows run under it, level with its last line on the left.
      let x: number;
      let y: number;
      const oh = L.overview?.hint;
      if (oh && F.d > 1.5) {
        // At the whole cook the hint stands where the overview put it (under the ghost).
        x = oh.align === "right" ? oh.x - hint.offsetWidth : oh.x;
        y = oh.y;
      } else if (L.overview && F.d > 1.5) {
        hint.style.opacity = "0";
        x = g.E;
        y = 0;
      } else if (L.derived && F.derived) {
        // At level 1 the Paper's top left, beside the grabber: the strip map's words stand under 24 (T3).
        x = L.derived.line0.x0;
        y = F.derived.paperTop + 14 * c - Y;
      } else if (g.portrait) {
        x = g.E;
        y = F.tt.y + F.tt.dh - 22 * c * 1.3;
      } else {
        x = Math.min(F.tt.x, g.W - g.E - hint.offsetWidth);
        y = F.tt.y + F.tt.dh + 18 * c + (L.ghost ? (L.ghost.h + 10 * c) * F.chart : 0);
      }
      hint.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
    clip.dataset.depth = F.d.toFixed(2);
    // Where each level's edge stands, for the e2e's frame reads.
    if (layerRef.current) layerRef.current.dataset.detents = L.detents.map((v) => v.toFixed(1)).join(",");
  }

  // ---- pointers: the band, the sheet, the foot, and the stage while pinned ----
  // When the last pull (or held press) ended; a click within 400 ms of it is its own, and swallowed.
  const swallow = useRef(Number.NEGATIVE_INFINITY);
  /** The press under way: its input, and what lets it go, cancelled, when it ended where the page didn't hear it. */
  const lostPress = useRef<{ type: string; lost: () => void } | null>(null);
  useEffect(() => {
    const m = motion.current;
    if (!m) return;
    const zoneFor = (el: "band" | "sheet" | "foot" | "stage", x: number, y: number): PointerZone => {
      const W = document.documentElement.clientWidth;
      const H = window.innerHeight;
      if (x < SHEET_CONSTANTS.DEAD_SIDE || x > W - SHEET_CONSTANTS.DEAD_SIDE || y > H - SHEET_CONSTANTS.DEAD_FOOT) return "none";
      if (m.pinned === 3) return "none";
      if (el === "sheet") return m.pinned === 0 ? "band" : "sheet";
      return el;
    };
    const downOn = (el: "band" | "sheet" | "foot" | "stage") => (e: PointerEvent) => {
      if (!e.isPrimary || e.button > 0) return;
      // A mouse pressed again while a mouse press is held was let go where the page didn't hear it
      // (outside the window): that press ended unseen, and ends now, cancelled. A mouse down while a
      // finger or a pen holds the sheet is another input (a trackpad on a touch screen): the finger keeps it.
      const held = lostPress.current;
      if (e.pointerType === "mouse" && held?.type === "mouse") held.lost();
      // Only the first pointer down counts (`SheetMotion.down`): another while it is held is not the
      // sheet's, and touches nothing of the held press, its claim included (Codex, T3 follow-up).
      if (m.touching) return;
      // A new touch: the last one's claim is spent, wherever this one lands.
      m.clearClaim();
      // More and its menu are the top line's, hosted here: a touch there is theirs, never a pull.
      if (e.target instanceof Element && e.target.closest("[data-sheet-more]")) return;
      // In the foot, the strip's line is the way in (the band, at every level); Back, Forward and the
      // clocks beside them are buttons, and a drag that starts on one is never a pull.
      let at = el;
      if (el === "foot" && e.target instanceof Element) {
        if (e.target.closest("[data-strip]")) at = "band";
        else if (e.target.closest("button, a, [role=button]")) return;
      }
      // The stage is the steps' own at Now: the sheet doesn't listen there (N3a).
      if (el === "stage" && m.pinned === 0) return;
      // While a timer rings, the sheet is not armed (N10); on the opening the pull is disarmed (N2-10).
      if (live.current.alarm || live.current.opening) return;
      // A touch lands the rows' glide where it was going.
      if (tweenRaf.current) finishTween();
      m.down({ id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, zone: zoneFor(at, e.clientX, e.clientY) });
      const target = e.currentTarget as HTMLElement;
      let last = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId === e.pointerId) {
          // A mouse back over the page with nothing held was let go outside the window (Codex, T3
          // follow-up). A finger or a pen in contact always holds a button.
          if (e.pointerType === "mouse" && ev.buttons === 0) return finish(last, true);
          last = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
        }
        if (m.move({ id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: ev.timeStamp })) {
          pullBegan();
          try {
            target.setPointerCapture(ev.pointerId);
          } catch {
            /* the pointer already went */
          }
        }
      };
      // Every way a press ends lets it go: up, cancel, and one the page never hears (let go outside the
      // window, the window losing focus, the page hidden), cancelled, so nothing waits on it forever.
      const finish = (p: { id: number; x: number; y: number; t: number }, cancelled: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", lost);
        document.removeEventListener("visibilitychange", hidden);
        if (lostPress.current?.lost === lost) lostPress.current = null;
        const r = m.up(p, cancelled);
        if (r.swallow) swallow.current = performance.now();
        // What waited for the finger is laid out now it lifted (a pull's landing does it at rest).
        if (dirty.current && m.resting && !tweenRaf.current) {
          dirty.current = false;
          setRebuild((n) => n + 1);
        }
        if (owed.current) setLifted((n) => n + 1);
      };
      const end = (cancelled: boolean) => (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        finish({ id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: ev.timeStamp }, cancelled);
      };
      const up = end(false);
      const cancel = end(true);
      const lost = () => finish(last, true);
      const hidden = () => {
        if (document.visibilityState === "hidden") lost();
      };
      lostPress.current = { type: e.pointerType, lost };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", lost);
      document.addEventListener("visibilitychange", hidden);
    };
    const pairs: [HTMLElement | null, "band" | "sheet" | "foot" | "stage"][] = [
      [bandRef.current, "band"],
      [clipRef.current, "sheet"],
      [footRef.current, "foot"],
      [stageRef.current, "stage"],
    ];
    const offs = pairs.map(([el, z]) => {
      if (!el) return () => {};
      const h = downOn(z);
      el.addEventListener("pointerdown", h);
      return () => el.removeEventListener("pointerdown", h);
    });
    // A pull, or a press held still, swallows the click it would make.
    const onClick = (e: MouseEvent) => {
      if (performance.now() - swallow.current < 400) {
        e.stopPropagation();
        e.preventDefault();
        swallow.current = Number.NEGATIVE_INFINITY;
      }
    };
    window.addEventListener("click", onClick, true);
    return () => {
      offs.forEach((off) => off());
      window.removeEventListener("click", onClick, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [footRef, stageRef]);

  // ---- keys: ↑ deeper, ↓ toward Now, Esc to Now (N11) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const m = motion.current;
      if (!m) return;
      const lv = live.current;
      if (keyBelongsToTarget(e)) return;
      const k = m.pinned;
      if (k === 3) {
        // Whole recipe holds the keys: ↑ and ↓ scroll its method; Esc and the ledge leave (BorrowedChrome),
        // Esc putting a step read there away first (N11's order).
        if (e.key === "Escape" && lv.wholeRead !== null) {
          e.preventDefault();
          lv.onWholeRead(null);
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const col = colRef.current;
          if (col && !col.contains(document.activeElement)) {
            e.preventDefault();
            col.scrollBy({ top: e.key === "ArrowDown" ? 80 : -80 });
          }
        }
        return;
      }
      // The opening's keys are Start's (CookScreen): the levels are disarmed (N2-10).
      if (lv.opening || !lv.keysLive || lv.alarm || document.querySelector("[data-holds-keys]")) return;
      if (e.key === "Escape" && lv.readMark !== null) {
        e.preventDefault();
        lv.onReadMark(null);
        return;
      }
      const to = keyLevel(e.key, k);
      if (to !== null) {
        e.preventDefault();
        lv.onLevel(to);
      }
    };
    // Capture: before the borrowed screen's own Escape, so a read goes first.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // ---- taps ----
  const deeper = () => {
    if (alarm) {
      onAlarmTap();
      return;
    }
    if (opening) return;
    const k = motion.current?.pinned ?? 0;
    if (k < 2) onLevel((k + 1) as Level);
  };
  const onClipClick = (e: React.MouseEvent) => {
    if (alarm) {
      onAlarmTap();
      return;
    }
    if (opening) return;
    const k = motion.current?.pinned ?? 0;
    // At rest the sheet is shut: a tap on it opens the peek. The peek's rows are words to read, not
    // targets (call 4): a tap there does nothing (its arrows and a pull are the ways on).
    if (k === 0) onLevel(1);
    if (k <= 1) return;
    const L = layoutRef.current;
    const F = frameRef.current;
    // Mid-glide nothing reads: the marks under the finger are not yet where they land (T3 fix round).
    if (!restsOn(2) || !L || !F) return;
    const Y = F.sheetTop;
    // The timetable: what is drawn under the finger (a step's block or label, its stretch of pot
    // line or caption) or the shared Prep block; anywhere else puts the read away. Nothing while a
    // prep mode's marks glide.
    const ov = L.overview;
    if (ov) {
      const root = overviewRef.current;
      const animRunning =
        root
          ?.getAnimations({ subtree: true })
          .some((a) => a.playState === "running" && Number(a.effect?.getComputedTiming().duration ?? 0) <= TIMETABLE_MOVE_MS + 50) ?? false;
      if (performance.now() < glideUntil.current && animRunning) return;
      let hitKey: string | null = null;
      if (root) {
        for (const el of root.querySelectorAll<HTMLElement>("[data-prep-card], [data-card]")) {
          const r = el.getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            hitKey = el.hasAttribute("data-prep-card") ? "prep" : el.getAttribute("data-card");
            break;
          }
        }
      }
      onReadMark(hitKey && readMark !== hitKey ? hitKey : null);
      return;
    }
    // As written: the outline's name under the finger, on its row's band (N2-4).
    const hit = hitOutline(
      e.clientX,
      e.clientY,
      L.chart.rows.map((r) => ({ rect: { x: 0, y: Y + r.top, width: L.geo.W, height: r.bottom - r.top }, mark: L.marks[r.js[0]] })),
    );
    if (hit) onReadMark(readMark === hit.key ? null : hit.key);
  };

  // ---- Whole recipe: mounted while open and while it fades out ----
  const [prevLevel, setPrevLevel] = useState(level);
  const [leaving, setLeaving] = useState(false);
  if (prevLevel !== level) {
    setPrevLevel(level);
    setLeaving(prevLevel === 3 && level !== 3);
  }
  const wholeOpen = level === 3;
  // ---- what draws ----
  const L = layout;
  const pinned = level;
  const tw = L?.tt;
  // The number and its words are said from the clock, in the box the held layout gave them (the
  // held rule, T3 call 13): it counts down, and at "Ready" the words go.
  const ttLive = tw ? tableWords(timed) : null;
  const ttNum = ttLive?.num ?? "";
  const ttWordsLive = ttLive?.words ?? "";
  const names = levelNames(strip.asWritten);
  const levelName = names[settled];
  const nextName = names[Math.min(3, settled + 1)];
  const srMarks = useMemo(
    () =>
      strip.marks.map((m) => {
        const st = m.state === "in-hand" ? "in hand" : m.state === "running" ? COOK_COPY.stateUnderWay : m.state === "done" ? COOK_COPY.stateDone : COOK_COPY.stateToCome;
        const mins = strip.asWritten || m.nominal ? "" : `, ${hm(m.end - m.start)}`;
        return `${capFirst(m.label)}, ${st}${mins}`;
      }),
    [strip],
  );
  const atChart = settled === 2 && pinned === 2 && !opening;
  const readM = L?.read ? (strip.marks.find((m) => m.key === L.read!.key) ?? null) : null;
  const D = L?.derived ?? null;
  // On the cook screen a derived plan's timetable grows out of the line, on the sheet's Paper (T3).
  const onSheet = D && !L?.opening ? { growFrom: D.growFrom, hide: D.line2.keys } : null;

  return (
    <>
      <div
        inert={wholeOpen}
        className="pointer-events-none fixed inset-y-0 right-[var(--ask-room,0px)] left-0 z-30 font-[family-name:var(--font-text)] text-ink"
      >
        <div ref={layerRef} data-cook-sheet tabIndex={-1} data-level={pinned} data-settled={settled} className="absolute inset-0 outline-none">
          {/* The nudge, over the minute it names (N7, N2-8): a tap on it is a tap on the band. */}
          {L?.nudge && (
            <div
              ref={nudgeRef}
              data-nudge
              data-no-swipe
              aria-live="polite"
              onClick={deeper}
              style={{ left: L.nudge.x, bottom: L.nudge.bottom, maxWidth: L.nudge.maxW, opacity: 0 }}
              className="pointer-events-auto absolute text-[length:var(--type-chip)] leading-[1.25] font-medium text-balance text-ink"
            >
              {nudge?.text ?? L.nudge.text}
            </div>
          )}

          {/* The sheet: at rest it is the band; pulled, the look-ahead. */}
          <div
            ref={clipRef}
            data-sheet
            data-no-swipe
            onClick={onClipClick}
            style={{ touchAction: opening ? "pan-y" : "none", top: "100%" }}
            className="pointer-events-none absolute inset-x-0 overflow-hidden"
          >
            {/* Only the sheet itself takes a touch: the 48 px over its edge, where names may stand, is the stage's. */}
            {/* A derived plan's sheet is its Paper, rising from the line (T3); the opening's timetable has
                the whole screen, on the ground, over the first step standing under it. */}
            <div className={`pointer-events-auto absolute inset-x-0 bottom-0 ${D && !L?.opening ? "" : "bg-ground"}`} style={{ top: PAD }} />
            <div ref={planRef} className="absolute inset-0" style={{ transform: `translateY(${PAD}px)` }}>
              <div aria-hidden className="pointer-events-none absolute inset-0">
                <div ref={hairRef} className="absolute top-0 left-0 z-[1] h-px bg-ink/[.11]" />

                {L?.order.map((j) => (
                  <i
                    key={`b${j}`}
                    ref={(el) => {
                      barEls.current[j] = el;
                    }}
                    data-mark={L.marks[j].key}
                    data-mark-state={L.marks[j].state}
                    className="absolute top-0 left-0 z-[1] block rounded-[2px]"
                  />
                ))}
                <div ref={nowRef} data-now-line className="absolute top-0 left-0 z-[1] w-[2px] rounded-[1px] bg-ink" />

                {/* As written, the next steps' names over their rows: words to read, not targets. */}
                {L?.marks.map((m, j) => {
                  const lab = L.labs1[j];
                  if (!lab) return null;
                  return (
                    <span
                      key={`s${j}`}
                      ref={(el) => {
                        lab1Els.current[j] = el;
                      }}
                      data-stretch-label={m.key}
                      style={{
                        fontSize: L.px1,
                        lineHeight: 1.1,
                        background: "var(--ground)",
                        boxShadow: "0.25em 0 var(--ground), -0.25em 0 var(--ground)",
                        borderRadius: "var(--radius-1)",
                        visibility: "hidden",
                      }}
                      className={`absolute top-0 left-0 z-[2] block whitespace-nowrap text-ink ${lab.cur ? "font-semibold" : "font-medium"}`}
                    >
                      {lab.lines.map((ln, q) => (
                        <span key={q} className="block">
                          {ln}
                          {q === lab.lines.length - 1 && lab.mn ? <span className="font-medium text-ink-soft">{lab.mn}</span> : null}
                        </span>
                      ))}
                    </span>
                  );
                })}
              </div>

              {/* The table's wall, drawn over the names: a name never breaks it. */}
              <div ref={endrRef} data-endr aria-hidden className="pointer-events-none absolute top-0 left-0 z-[3] w-px bg-ink/[.22]" />
              {/* A derived plan's parts stand on the screen's own place (from level 2's edge), not the sheet's edge:
                  the Paper rises under them, the line never moves, the timetable grows out of it (T3). */}
              {/* This box is moved (a transform), so what it holds stacks as one, under More and the opening's
                  controls (z-[6]) beside it. While a Get out amount's panel is open on the opening it stacks
                  over them, so the panel is never drawn under Start, the well or More should it reach them
                  (review round 1); it takes no touches itself, so they stay in reach. */}
              {L?.overview && D && (
                <div
                  ref={derivedRef}
                  data-derived-sheet
                  className={`pointer-events-none absolute inset-x-0 top-0${L.opening ? " has-[[data-measure-panel]]:z-[7]" : ""}`}
                  style={{ height: L.geo.H }}
                >
                  {!L.opening && (
                    <div
                      ref={paperRef}
                      data-sheet-paper
                      aria-hidden
                      className="absolute left-0 w-full bg-paper ring-1 ring-ink/[.11] ring-inset"
                      style={{ top: 0, height: L.geo.H, borderRadius: PAPER_R * L.geo.c }}
                    />
                  )}
                  <Timetable
                    ov={L.overview}
                    rootRef={overviewRef}
                    strip={timed}
                    opening={opening !== null}
                    live={atChart}
                    readMark={readMark}
                    onRead={(k) => {
                      if (restsOn(2)) onReadMark(k);
                    }}
                    onGo={onGoToMark}
                    onWhole={() => {
                      if (restsOn(2)) onLevel(3);
                    }}
                    onClose={() => onLevel(0)}
                    onMode={onMode}
                    getOut={getOut}
                    scaleNote={scaleNote}
                    readText={readIn?.text ?? null}
                    onSheet={onSheet}
                    plan={plan}
                    state={state}
                    ingredients={whole.ingredients}
                    steps={whole.steps}
                    onAskAhead={onAskAhead}
                  />
                </div>
              )}
              {/* The peek (look-ahead slice 1): the next steps, to the next time the hands come free.
                  As written has no Paper of its own: the peek brings one. */}
              {L?.peek && (
                <div
                  ref={peekRef}
                  data-peek
                  data-limit={L.peek.limit}
                  className="pointer-events-none absolute inset-x-0 top-0 z-[5]"
                  style={{ height: L.peek.height, opacity: 0, visibility: "hidden" }}
                >
                  {L.asWritten && (
                    <div
                      aria-hidden
                      className="absolute inset-x-0 top-0 bg-paper ring-1 ring-ink/[.11] ring-inset"
                      style={{ height: L.geo.H, borderRadius: PAPER_R * L.geo.c }}
                    />
                  )}
                  <PeekRows d={L.peek} c={L.geo.c} label={COOK_COPY.lookAhead} />
                </div>
              )}
              {/* The arrows on the sheet's top edge, at the peek only: ⌄ puts it away and ^ opens
                  the whole cook. Each a full 80 cpx target. The whole cook has none (DS v1.62):
                  its top holds Back to step, the title and the read. */}
              {L?.peek && (
                <div ref={arrows1Ref} className="pointer-events-none absolute top-0 left-0 z-[7] w-full" style={{ opacity: 0, visibility: "hidden" }}>
                  {sheetArrowTargets(1, L.geo.W, L.geo.c).map((a) => (
                    <button
                      key={a.mark}
                      type="button"
                      data-sheet-arrow={a.mark}
                      tabIndex={settled === 1 ? 0 : -1}
                      aria-label={a.mark === "collapse" ? COOK_COPY.peekCollapse : COOK_COPY.peekExpand}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!restsOn(1) || opening) return;
                        onLevel(a.to);
                      }}
                      style={{ left: a.x, top: a.y, width: a.w, height: a.h }}
                      className="pointer-events-auto absolute grid cursor-pointer place-items-center rounded-full text-ink active:bg-sand focus-visible:outline-3 focus-visible:-outline-offset-4 focus-visible:outline-ink"
                    >
                      <SheetArrow dir={a.dir} />
                    </button>
                  ))}
                </div>
              )}
              {/* More, hosted where the top line gives way (N3-4(d), (f)); measured always, shown with the lanes. */}
              {more != null && (
                <div
                  ref={moreWrapRef}
                  data-sheet-more
                  onClick={(e) => e.stopPropagation()}
                  className="pointer-events-auto absolute top-0 left-0 z-[6] w-max"
                  style={{
                    transform: L?.overview ? `translate(${L.overview.more.x.toFixed(1)}px, ${L.overview.more.y.toFixed(1)}px)` : undefined,
                    opacity: 0,
                    visibility: "hidden",
                  }}
                >
                  {more}
                </div>
              )}
              {/* The opening's controls: the voice dot, the well, Start. */}
              {openingControls != null && (
                <div
                  ref={controlsWrapRef}
                  data-sheet-controls
                  onClick={(e) => e.stopPropagation()}
                  className="pointer-events-auto absolute top-0 left-0 z-[6] w-max"
                  style={{
                    transform: L?.overview?.controls
                      ? `translate(${L.overview.controls.x.toFixed(1)}px, ${L.overview.controls.y.toFixed(1)}px)`
                      : undefined,
                    opacity: 0,
                    visibility: "hidden",
                  }}
                >
                  {openingControls}
                </div>
              )}
              {L?.marks.map((m, j) => {
                const lab = L.labs2[j];
                if (!lab) return null;
                return (
                  <button
                    key={`l${j}`}
                    type="button"
                    ref={(el) => {
                      lab2Els.current[j] = el;
                    }}
                    data-label={m.key}
                    tabIndex={atChart ? 0 : -1}
                    aria-label={`${srMarks[j]}. Read it`}
                    onClick={(e) => {
                      if (!restsOn(2) || opening) return;
                      e.stopPropagation();
                      onReadMark(readMark === m.key ? null : m.key);
                    }}
                    style={{
                      fontSize: L.px2,
                      lineHeight: 1.1,
                      background: "var(--ground)",
                      boxShadow: "0.25em 0 var(--ground), -0.25em 0 var(--ground)",
                      borderRadius: "var(--radius-1)",
                      visibility: "hidden",
                    }}
                    className={`pointer-events-auto absolute top-0 left-0 z-[2] origin-top-left cursor-pointer text-left whitespace-nowrap text-ink outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink ${lab.cur ? "font-semibold" : "font-medium"}`}
                  >
                    {lab.lines.map((ln, q) => (
                      <span key={q} className="block">
                        {ln}
                        {q === lab.lines.length - 1 && lab.mn ? <span className="font-medium text-ink-soft">{lab.mn}</span> : null}
                      </span>
                    ))}
                  </button>
                );
              })}
              {L && tw && (
                <button
                  ref={ttRef}
                  type="button"
                  data-time-to-table
                  tabIndex={atChart ? 0 : -1}
                  aria-label={`${ttNum}${ttWordsLive ? ` ${ttWordsLive}` : ""}${tw.sub ? `, ${tw.sub}` : ""}. ${COOK_COPY.wholeRecipe}`}
                  onClick={(e) => {
                    if (!restsOn(2) || alarm || opening) return;
                    e.stopPropagation();
                    onLevel(3);
                  }}
                  className="pointer-events-auto absolute top-0 left-0 z-[4] flex cursor-pointer flex-col items-start bg-[var(--tt-bg,var(--ground))] text-left whitespace-nowrap outline-none [box-shadow:0.25em_0_var(--tt-bg,var(--ground)),-0.25em_0_var(--tt-bg,var(--ground))] focus-visible:outline-3 focus-visible:outline-ink"
                >
                  <span
                    ref={ttNumRef}
                    data-tt-num
                    className="font-[family-name:var(--font-display)] leading-none font-normal [font-synthesis:none]"
                    style={{ width: `${tw.numEm.toFixed(4)}em` }}
                  >
                    {ttNum}
                  </span>
                  {tw.words ? (
                    <span ref={ttWRef} data-tt-words className="leading-[1.15] font-medium">
                      {ttWordsLive}
                    </span>
                  ) : (
                    <span ref={ttWRef} />
                  )}
                  <span
                    ref={ttSubRef}
                    data-hands-on
                    className="absolute top-full left-0 bg-[var(--tt-bg,var(--ground))] pt-[var(--space-1)] text-[length:var(--type-meta)] leading-[1.3] font-medium whitespace-nowrap text-ink-soft opacity-0"
                  >
                    {tw.sub}
                  </span>
                </button>
              )}
              {/* Without a read, Whole recipe is a ghost under the hands-on line (N2-4). */}
              {L?.ghost && (
                <button
                  ref={ghostRef}
                  type="button"
                  data-whole-recipe-ghost
                  tabIndex={atChart ? 0 : -1}
                  onClick={(e) => {
                    if (!restsOn(2) || opening) return;
                    e.stopPropagation();
                    onLevel(3);
                  }}
                  style={{ left: L.ghost.x, top: L.ghost.y, width: L.ghost.w, height: L.ghost.h, opacity: 0, visibility: "hidden" }}
                  className={`pointer-events-auto absolute z-[4] inline-flex cursor-pointer items-center justify-center rounded-full border border-ink/[.14] ${L.overview ? "bg-paper" : "bg-ground"} text-[length:var(--type-meta)] font-semibold whitespace-nowrap text-ink active:bg-sand focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink`}
                >
                  {COOK_COPY.wholeRecipe}
                </button>
              )}
              {L?.outlineMore && (
                <button
                  ref={moreRef}
                  type="button"
                  data-outline-more
                  tabIndex={atChart ? 0 : -1}
                  onClick={(e) => {
                    if (!restsOn(2)) return;
                    e.stopPropagation();
                    onLevel(3);
                  }}
                  style={{ left: L.geo.E, top: L.outlineMore.y, opacity: 0, visibility: "hidden" }}
                  className="pointer-events-auto absolute cursor-pointer text-[length:var(--type-meta)] font-medium whitespace-nowrap text-ink-soft"
                >
                  {L.outlineMore.text}
                </button>
              )}
              {/* The read band at the chart's top: the step's words, Go, and Whole recipe (N2-4). */}
              {L?.read && readM && (
                <div
                  ref={readRef}
                  data-read-step={L.read.key}
                  onClick={(e) => e.stopPropagation()}
                  className="pointer-events-auto absolute z-[5] rounded-[var(--radius-2)] bg-paper ring-1 ring-ink/[.11] ring-inset"
                  style={{ left: L.geo.E / 2, right: L.geo.E / 2, top: L.read.top, height: L.read.height, opacity: 0, visibility: "hidden" }}
                >
                  <p
                    role="button"
                    tabIndex={atChart ? 0 : -1}
                    aria-label={readStepDetails(readM, plan, state).text}
                    onClick={() => onReadMark(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onReadMark(null);
                      }
                    }}
                    className="absolute m-0 cursor-pointer font-medium text-ink outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    style={{ left: L.read.textX - L.geo.E / 2, top: L.read.textTop, width: L.read.textW, fontSize: L.read.px, lineHeight: 1.2 }}
                  >
                    {L.read.lines.map((ln, q) => (
                      <span key={q} className="block">
                        {ln}
                      </span>
                    ))}
                  </p>
                  <div className="absolute flex items-center gap-[calc(12*var(--cpx))]" style={{ left: L.read.btnX - L.geo.E / 2, top: L.read.btnY }}>
                    <button
                      type="button"
                      data-go-to-step
                      tabIndex={atChart ? 0 : -1}
                      onClick={() => onGoToMark(readM.screen)}
                      className="inline-flex h-12 cursor-pointer items-center rounded-full bg-sand px-[calc(20*var(--cpx))] text-[length:var(--type-meta)] font-semibold whitespace-nowrap text-ink active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink"
                    >
                      {COOK_COPY.goToStep}
                    </button>
                    <button
                      type="button"
                      data-whole-recipe-ghost
                      tabIndex={atChart ? 0 : -1}
                      onClick={() => onLevel(3)}
                      className="inline-flex h-12 cursor-pointer items-center rounded-full border border-ink/[.14] px-[calc(12*var(--cpx))] text-[length:var(--type-meta)] font-semibold whitespace-nowrap text-ink active:bg-sand focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      {COOK_COPY.wholeRecipe}
                    </button>
                  </div>
                </div>
              )}
              {sayBack && (
                <p
                  ref={hintRef}
                  data-say-back
                  aria-hidden={settled === 0}
                  className="pointer-events-none absolute top-0 left-0 z-[4] m-0 text-[length:var(--type-meta)] font-medium whitespace-nowrap text-ink-soft opacity-0"
                >
                  {COOK_COPY.saySueBack}
                </p>
              )}
            </div>
          </div>

          {/* The strip's line, drawn into the foot's middle cell (look-ahead slice 1): work in
              segments, a gap at each break, filled to the end of the step in hand. The whole cell
              is one target: a tap goes rest ↔ the peek (call 3), a pull moves the sheet. */}
          {cell &&
            L?.stripLine &&
            !opening &&
            createPortal(
              <button
                ref={bandRef}
                type="button"
                data-cook-band
                data-strip
                data-no-swipe
                onClick={() => {
                  if (alarm) {
                    onAlarmTap();
                    return;
                  }
                  if (opening) return;
                  onLevel(stripTap((motion.current?.pinned ?? 0) as Level));
                }}
                // Said as the band was (the time to the table, then the way in), so a screen reader
                // still hears where the cook stands; under the peek it puts the peek away.
                aria-label={
                  pinned === 1 ? COOK_COPY.peekCollapse : tw ? `${ttNum}${ttWordsLive ? ` ${ttWordsLive}` : ""}. Show ${names[1]}` : names[1]
                }
                aria-expanded={pinned === 1 || pinned === 2}
                aria-describedby="cook-sheet-marks"
                style={{ touchAction: "none" }}
                className="absolute inset-0 cursor-pointer rounded-[var(--radius-2)] bg-transparent outline-none focus-visible:outline-3 focus-visible:-outline-offset-4 focus-visible:outline-ink"
              >
                <span
                  ref={restArrowRef}
                  aria-hidden
                  data-strip-arrow
                  className="absolute left-1/2 grid -translate-x-1/2 place-items-center text-ink-soft"
                  style={{ bottom: `calc(50% + ${(8 * L.geo.c).toFixed(1)}px)` }}
                >
                  <SheetArrow dir="up" />
                </span>
                <span aria-hidden data-strip-line className="absolute inset-x-0 top-1/2 block" style={{ height: LINE_H * L.geo.c, marginTop: (-LINE_H * L.geo.c) / 2 }}>
                  {L.stripLine.parts
                    .filter((p) => p.kind === "work")
                    .map((p, k) => (
                      <span
                        key={`${p.from}-${p.to}`}
                        data-strip-seg
                        data-from={p.from}
                        data-to={p.to}
                        className="absolute top-0 block h-full overflow-hidden rounded-full"
                        style={{ left: p.x0, width: p.x1 - p.x0, background: `color-mix(in oklab, var(--ink) ${TRACK_INK * 100}%, transparent)` }}
                      >
                        <span
                          ref={(el) => {
                            segEls.current[k] = el;
                          }}
                          className="absolute inset-0 block origin-left bg-ink"
                          style={{ transform: "scaleX(0)" }}
                        />
                      </span>
                    ))}
                </span>
              </button>,
              cell,
            )}

          {/* What a screen reader hears of the strip and the level. */}
          <div className="sr-only">
            <p data-level-said="" aria-live="polite">
              {settled > 0 && !opening ? levelSaid(levelName, voice?.status === "listening") : ""}
            </p>
            <ul id="cook-sheet-marks" aria-label={`${levelName}: the rest of the cook. Next: ${nextName}`}>
              {srMarks.map((t, j) => (
                <li key={j}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {(wholeOpen || leaving) && (
        <WholeRecipeScreen
          rootRef={wholeRef}
          open={wholeOpen}
          onGone={() => setLeaving(false)}
          onClose={() => onLevel(0)}
          voice={voice}
          colRef={colRef}
        >
          <WholeRecipe {...whole} asWritten={strip.asWritten} />
        </WholeRecipeScreen>
      )}
    </>
  );
}

/**
 * Whole recipe (N2-5): N9's column at the reading width, framed as a borrowed
 * screen. It enters and leaves by a 200 ms cross-fade, modal only while open,
 * and opens scrolled to "You're here".
 */
function WholeRecipeScreen({
  rootRef,
  open,
  onGone,
  onClose,
  voice,
  colRef,
  children,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  onGone: () => void;
  onClose: () => void;
  voice?: { status: VoiceStatus; echo: VoiceEcho | null };
  colRef: RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const gone = useRef(onGone);
  useLayoutEffect(() => {
    gone.current = onGone;
  });
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const fade = el.animate(open ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], {
      duration: FADE_MS,
      easing: FADE_EASE,
      fill: "forwards",
    });
    if (!open) fade.onfinish = () => gone.current();
    return () => fade.cancel();
  }, [open, rootRef]);
  // Opening: the column scrolls to "You're here" (the method's head while it is one of the first two).
  useLayoutEffect(() => {
    const col = colRef.current;
    if (!open || !col) return;
    const lis = [...col.querySelectorAll<HTMLElement>("[data-step-row]")];
    const cur = col.querySelector<HTMLElement>("[data-here]")?.closest<HTMLElement>("[data-step-row]") ?? null;
    const head = col.querySelector<HTMLElement>("[data-method-head]");
    const el = !cur || lis.indexOf(cur) <= 1 ? head : cur;
    col.scrollTop = el ? Math.max(0, el.offsetTop - 12) : 0;
  }, [open, colRef]);
  return (
    <BorrowedChrome
      kind={COOK_COPY.wholeRecipe}
      voice={voice}
      onClose={onClose}
      active={open}
      role="dialog"
      aria-modal={open}
      data-holds-keys={open}
      containerRef={rootRef}
      className={`fixed inset-0 z-50 flex flex-col bg-ground font-[family-name:var(--font-text)] text-ink outline-none ${open ? "" : "pointer-events-none"}`}
    >
      <div
        ref={colRef}
        data-rec
        style={{ touchAction: "pan-y", overscrollBehavior: "contain" }}
        className={`relative min-h-0 flex-1 overflow-y-auto pb-[calc(48*var(--cpx))] ${EDGE_X} [mask-image:linear-gradient(to_bottom,#000_calc(100%-48*var(--cpx)),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}
      >
        <div className="max-w-[calc(880*var(--cpx))]">{children}</div>
      </div>
    </BorrowedChrome>
  );
}
