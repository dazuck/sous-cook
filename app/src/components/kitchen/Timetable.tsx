"use client";

/**
 * The Recipe Opening (R4 two-column Opening: `Get out` + `The flow` in `2..6`
 * natural phases with a movable `--sand` prep capsule) and the Level 2
 * Mid-Cook Phase Outline (`[data-phase-outline]`).
 *
 * - Deck 1 & Deck 2 on the Opening use `ov.opening` geometry so Back, the
 *   recipe title, the voice dot / timer well / `Start` controls, `More`,
 *   `hands-on` minutes, and `Prep first | As I go` with both total times
 *   never collide at any viewport or timer count.
 * - Below Deck 2 on the Opening sits the two-column body:
 *   - Left column (`[data-get-out]`): `Equipment`, `Fridge & counter`, and
 *     `Pantry & spices` rendered as atomic inline-block items (`·` separated,
 *     zero `"and N more"` truncation) with a `Show amounts` toggle.
 *   - Right column (`[data-opening-flow]`): optional `--sand` `Ahead` callout
 *     with `"Missed it? Ask Sous"`, followed by `2..6` numbered phases.
 *     Toggling `Prep first` ↔ `As I go` FLIP-animates `[data-movable-prep]`
 *     and `[data-phase-row]` on `cubic-bezier(0.32, 0.72, 0, 1)`.
 *   - In portrait (DS v1.52) the columns stack: `Get out` at the body's full
 *     width over a hairline, the flow at full width under it, every word
 *     whole (wrapped, never cut with an ellipsis). Which of the flow's
 *     optional lines show is fitted on the real fonts (`stackShedOrder`);
 *     `Get out`'s heads run in before their lists only as the last resort
 *     (`stackRung`).
 * - At Level 2 mid-cook (`ov.whole`), the header (`Back`, title, time-to-table,
 *   `Whole recipe` ghost, or `ReadBar` when a phase/step is tapped) frames
 *   `[data-phase-outline]`, a scannable single-line list of the `2..6` phases
 *   (`✓` / `done`, active `--ember-700` with `min left`, and upcoming phases).
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import Link from "next/link";
import { prepWords } from "@/lib/kitchen/cook-overview";
import { buildCookPhases, type CookPhaseRow } from "@/lib/kitchen/cook-phases";
import type { CookPlan, PrepMode } from "@/lib/kitchen/cook-plan";
import type { Strip } from "@/lib/kitchen/cook-strip";
import { COOK_COPY, missedAheadAsk, type CookState, type PrepAheadGroup } from "@/lib/kitchen/cook-view";
import { buildGetOut, type GetOutItem as CategorizedGetOutItem } from "@/lib/kitchen/get-out";
import { footMask, useMoreBelow } from "@/hooks/useMoreBelow";
import { MeasurementPopover } from "./MeasurementPopover";
import { MealLines, pageMeasure } from "./MealLines";
import { ServingStepper, type ServingStepperProps } from "./ServingStepper";
import { mealLines } from "@/lib/kitchen/meal-lines";
import { layoutMealLines, type LinesDrawing } from "@/lib/kitchen/meal-lines-layout";
import type { Measure } from "@/lib/kitchen/sheet-layout";
import { servingsText, type StoredIngredientLines } from "@/lib/kitchen/ingredient-display";
import { aheadFolds as foldsFor, foldedCount, headRowCpx, listRowsCpx, noteFoldedCpx, noteFullCpx, noteRuns } from "./get-out-room";
import type { OverviewPlace } from "@/lib/kitchen/overview-place";
import { saysOf } from "@/lib/kitchen/says-of";
import {
  fmtMinutes,
  fmtTotal,
  soonerLabelX,
  soonerMinutes,
  type GetOutItem,
} from "@/lib/kitchen/timetable-layout";

/** One curve (SPEC §11): geometry 420 ms, opacity in 280 ms. */
const EASE = "cubic-bezier(0.32,0.72,0,1)";
const MOVE_MS = 420;
/** How long a prep mode's marks glide to their new minutes (SPEC §11). */
export const TIMETABLE_MOVE_MS = MOVE_MS;
const IN_MS = 280;
/** The old serve line's ghost: held 1.9 s, then out over 600 ms. */
const SOONER_HOLD_MS = 1900;
/** Get out's column beside the meal's lines on the opening, cpx: the approved drawing's (DS v1.63). */
export const GET_OUT_LINES = 210;
/** The Ahead note's one row above the flow, with the flow's gap under it (cpx): the lines and the phases leave it this room. */
export const AHEAD_ROW = 40;

/**
 * The room the Ahead note's one row takes above the flow, in px, with the flow's 4 cpx gap under it:
 * its line (26 cpx) and padding (4 cpx each side), and, carrying "Missed it? Ask Sous", the 48 px its
 * target stands at least (review round 3). Never less than `AHEAD_ROW`, so where a unit is 1.333 px
 * (the tablet) nothing moves; where it is less (a Chrome tab, 1280×680) the 48 px is budgeted.
 */
export function aheadRowPx(c: number, ask: boolean): number {
  const note = ask ? Math.max(48, 34 * c) : 34 * c;
  return Math.max(AHEAD_ROW * c, note + 4 * c);
}
/** The Paper the meal's lines leave over the foot, cpx: the opening's 14, at the whole cook too. */
export const LINES_OVER_FOOT = 14;
/** Where the whole cook's lines end, in the sheet's cpx from `Y2`: 14 cpx over the foot. */
export function wholeLinesBottom(ov: OverviewPlace): number {
  return (ov.sheetBottom - ov.Y2) / ov.c - LINES_OVER_FOOT;
}
const SOONER_FADE_MS = 600;
const FOCUS = "outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink";
/** The ring drawn inside a control that stands flush with a column that clips, where a ring outside would be cut. */
const FOCUS_IN = "outline-none focus-visible:outline-3 focus-visible:-outline-offset-4 focus-visible:outline-ink";
/** A scroller that never draws a scrollbar (Whole recipe's rule): its foot's fade is the cue. */
const NO_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
/** The dotted rule's colour and offset under a Get out amount that opens (the step pairs' own; `AMOUNT_RULE` draws it). */
const AMOUNT_RULE_INK = "decoration-ink-soft underline-offset-[0.15em]";

export interface TimetableProps {
  ov: OverviewPlace;
  rootRef: Ref<HTMLDivElement>;
  strip: Strip;
  opening: boolean;
  /** The level is settled here: its parts take focus. */
  live: boolean;
  readMark: string | null;
  onRead: (key: string | null) => void;
  /** The read's Go: to the read step's screen, or to Prep. */
  onGo: (screen: number) => void;
  onWhole: () => void;
  /** Back to the step (level 2's back). */
  onClose: () => void;
  onMode?: (mode: PrepMode) => void;
  getOut: readonly GetOutItem[];
  scaleNote: string | null;
  /** The read step's words in full, for a screen reader (the header may cut them). */
  readText: string | null;
  /**
   * On the cook screen: the sheet draws the Paper and the progress line (the last track, `hide`),
   * and the marks grow from the line, `growFrom` cpx down the drawing (T3).
   */
  onSheet?: { growFrom: number; hide: readonly string[] } | null;
  /** Plan and state for building R4 phases and categorized Get Out. */
  plan?: CookPlan | null;
  state?: CookState;
  ingredients?: StoredIngredientLines;
  steps?: readonly string[];
  /** "Missed it? Ask Sous" under the Ahead note: Ask with the question about all the make-ahead work (DECISIONS 2026-11-24). */
  onAskAhead?: (groups: readonly PrepAheadGroup[]) => void;
  /** The tablet upright or a phone: the whole meal draws as one list (DS v1.63). */
  portrait?: boolean;
  /** The serving stepper at Get out's head on the opening (DS v1.63), as on Prep and Whole recipe. */
  stepper?: Omit<ServingStepperProps, "className"> | null;
  /** Text widths for the whole meal's lines, made fresh per layout pass; the page's canvas when not given. */
  measureText?: () => Measure;
  /**
   * The whole cook's lines as drawn (null on the opening, or with none): told after each drawing is on
   * the page, so the sheet can turn the peek's rows into them on the pull. A stable function.
   */
  onWholeLines?: (drawing: LinesDrawing | null) => void;
}

interface Anim {
  id: number;
  from: OverviewPlace;
  /** What switching to As I go saved, when it ends sooner. */
  sooner: { x: number; y: number; h: number; label: string; labelX: number; labelY: number } | null;
}

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function soonerOf(from: OverviewPlace, to: OverviewPlace, measure: (s: string) => number): Anim["sooner"] {
  const saved = soonerMinutes(from.timetable.total, to.timetable.total);
  if (saved <= 0) return null;
  const a = from.drawing.marks.find((m) => m.role === "serve");
  const b = to.drawing.marks.find((m) => m.role === "serve");
  const label = COOK_COPY.sooner(fmtMinutes(saved));
  const w = measure(label);
  const chart = (to.opening ?? to.whole)?.chart;
  const right = chart ? chart.x + chart.w : Infinity;
  const ax = a?.x ?? (chart ? chart.x + chart.w - 40 : 800);
  const bx = b?.x ?? Math.max(100, ax - 80);
  const ay = a?.y ?? (chart ? chart.y + 8 : 160);
  const ah = a?.h ?? 40;
  return { x: ax + 0.5, y: ay, h: ah, label, labelX: soonerLabelX(ax, bx, w, right), labelY: ay + ah / 2 - 14 };
}

let soonerCtx: CanvasRenderingContext2D | null | undefined;
function measureSooner(s: string): number {
  if (soonerCtx === undefined) soonerCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  if (!soonerCtx) return s.length * 11;
  soonerCtx.font = "600 22px Figtree";
  return soonerCtx.measureText(s).width;
}

/**
 * The order the portrait opening's optional lines give way when its stack is taller than its body
 * (DS v1.52). Phase summaries go first: those of phases with another line of their own before those
 * without, later phases before earlier. Then the hands-off times, the shortest first, a phase's
 * hands-off window and the time left beside its Meanwhile alike, so the longest is the last to go.
 * The movable capsule and Meanwhile's prep never give way.
 */
function stackShedOrder(phases: readonly CookPhaseRow[]): string[] {
  const hasWindow = (p: CookPhaseRow) => p.passiveWindow !== null && p.meanwhile === null;
  const hasOther = (p: CookPhaseRow) => p.movable !== null || p.meanwhile !== null || hasWindow(p);
  const summaries = phases.filter((p) => p.summary);
  const handsOff = [
    ...phases.filter(hasWindow).map((p) => ({ id: `window:${p.key}`, minutes: p.passiveWindow!.minutes })),
    ...phases
      .filter((p) => p.meanwhile?.remainingLabel)
      .map((p) => ({ id: `remaining:${p.key}`, minutes: p.meanwhile!.remainingFreeMinutes })),
  ].sort((x, y) => x.minutes - y.minutes);
  return [
    ...summaries.filter(hasOther).reverse().map((p) => `summary:${p.key}`),
    ...summaries.filter((p) => !hasOther(p)).reverse().map((p) => `summary:${p.key}`),
    ...handsOff.map((h) => h.id),
  ];
}

/**
 * One step of the portrait opening's fit (DS v1.52): its row spacing, whether Get out's group heads
 * run in beside their lists, and how many of `stackShedOrder`'s n `lines` have given way. Step 0 is every
 * line at the loose spacing; steps 1..1+n the tight spacing with 0..n lines given way, Get out as the
 * mocks draw it (each head over its list); then, only when that still runs past the body and there is
 * a Get out, steps 2+n..2+2n run the heads in, with every line back and given way again from the first.
 */
function stackRung(step: number, lines: number, hasGetOut: boolean) {
  const runIn = hasGetOut && step > 1 + lines;
  return { tight: step > 0, runIn, shed: runIn ? step - 2 - lines : Math.max(0, step - 1) };
}

/**
 * How many times the portrait opening's fit may re-render before a paint. React throws at 50 nested
 * updates, and the sheet's own share the count; two whole fits of the heaviest opening (13 each) fit
 * inside this, so the fit is cut short only when the place is laid again three times or more as it runs.
 */
const FIT_BURST = 32;

/**
 * How many times the page's fonts have finished loading, for a layout measured on them: the canvas
 * measures with whatever faces are loaded at the time, so a layout made before they arrive is made
 * again after. Off (always 0) when the caller measures by other means.
 */
function useFontsLoaded(on: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on || typeof document === "undefined" || !document.fonts) return;
    const again = () => setN((k) => k + 1);
    document.fonts.addEventListener("loadingdone", again);
    return () => document.fonts.removeEventListener("loadingdone", again);
  }, [on]);
  return n;
}

export function Timetable(props: TimetableProps) {
  const {
    ov,
    rootRef,
    strip,
    opening,
    live,
    readMark,
    onRead,
    onGo,
    onWhole,
    onClose,
    onMode,
    getOut,
    scaleNote,
    readText,
    onSheet = null,
    plan = null,
    state,
    ingredients,
    steps,
    onAskAhead,
    portrait = false,
    stepper = null,
    measureText,
    onWholeLines,
  } = props;

  /** The Ahead note's words, which its "Missed it?" button is described by: the button lies over them. */
  const aheadNoteId = useId();
  const [showAmounts, setShowAmounts] = useState(false);

  /** The words and the header: in after the marks have grown (the sheet's `--words-op`). */
  const wordsOp = "var(--words-op, 1)";
  const c = ov.c;
  const d = ov.drawing;
  const tab = live ? 0 : -1;
  const px = (v: number) => v * c;

  // Build categorized Get Out model (Equipment, Fridge & counter, Pantry & spices)
  const getOutModel = useMemo(() => {
    if (ingredients && ingredients.length > 0) {
      return buildGetOut({
        ingredients,
        steps: steps ?? [],
        taskTexts: plan?.tasks.map((t) => t.text),
      });
    }
    return {
      equipment: [] as string[],
      fridge: getOut.map<CategorizedGetOutItem>((g) => ({
        index: g.index,
        key: `${g.index}:${g.name}`,
        bare: g.name,
        withAmount: g.amount ? `${g.amount} ${g.name}` : g.name,
        amount: g.amount,
      })),
      pantry: [] as CategorizedGetOutItem[],
    };
  }, [ingredients, steps, plan, getOut]);

  const stripMarks = strip.marks;
  const activeTaskId = useMemo(() => {
    if (!plan || opening) return null;
    const inHand = stripMarks.find((m) => m.state === "in-hand");
    return inHand?.tasks[0] ?? null;
  }, [plan, opening, stripMarks]);

  const phasesModel = useMemo(() => {
    if (!plan) return null;
    const effectiveTicked = opening ? (state?.ticked ?? new Set<string>()) : new Set<string>();
    return buildCookPhases(
      plan,
      ov.timetable.mode,
      effectiveTicked,
      opening ? 0 : strip.now,
      activeTaskId,
    );
  }, [plan, ov.timetable.mode, state?.ticked, opening, strip.now, activeTaskId]);

  const phaseMarksMap = useMemo(() => {
    const map = new Map<string, (typeof stripMarks)[number][]>();
    if (!phasesModel) return map;
    const cookPhases = phasesModel.phases.filter((p) => p.kind === "cook");
    for (const p of cookPhases) map.set(p.key, []);
    if (cookPhases.length === 0) return map;
    for (const m of stripMarks) {
      if (m.key === "prep") continue;
      const target =
        cookPhases.find((p) => m.tasks.some((id) => p.firstStepTaskIds.includes(id))) ??
        cookPhases[cookPhases.length - 1];
      map.get(target.key)!.push(m);
    }
    return map;
  }, [phasesModel, stripMarks]);

  // A prep mode chosen moves the capsule and phases (FLIP): track mode switches and interruptions.
  const [shown, setShown] = useState<{ ov: OverviewPlace; anim: Anim | null; n: number; snap: number }>({
    ov,
    anim: null,
    n: 0,
    snap: 0,
  });
  if (shown.ov !== ov) {
    const prev = shown.ov;
    const switched =
      prev.timetable.mode !== ov.timetable.mode &&
      prev.c === c &&
      (prev.opening === null) === (ov.opening === null) &&
      prev.sheetBottom === ov.sheetBottom &&
      !reduced();
    const n = switched ? shown.n + 1 : shown.n;
    const snap = !switched && shown.anim ? shown.snap + 1 : shown.snap;
    setShown({
      ov,
      n,
      anim: switched ? { id: n, from: prev, sooner: soonerOf(prev, ov, measureSooner) } : null,
      snap,
    });
  }
  const anim = shown.anim;
  useEffect(() => {
    if (!anim) return;
    const t = window.setTimeout(
      () => setShown((s) => (s.anim?.id === anim.id ? { ...s, anim: null } : s)),
      SOONER_HOLD_MS + SOONER_FADE_MS + 100,
    );
    return () => window.clearTimeout(t);
  }, [anim]);

  const rootEl = useRef<HTMLDivElement | null>(null);
  const lastFlipRects = useRef<Map<string, DOMRect>>(new Map());
  const lastAnimId = useRef<number>(-1);
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootEl.current = el;
      if (typeof rootRef === "function") rootRef(el);
      else if (rootRef && "current" in rootRef) Object.assign(rootRef, { current: el });
    },
    [rootRef],
  );

  // A switch ended early (resize, font load, rotation): finish running animations immediately.
  useLayoutEffect(() => {
    if (!shown.snap) return;
    const root = rootEl.current;
    for (const a of root?.getAnimations({ subtree: true }) ?? []) {
      if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
    }
    if (root) {
      const nextRects = new Map<string, DOMRect>();
      for (const el of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) nextRects.set(el.dataset.flipId!, r);
      }
      lastFlipRects.current = nextRects;
    }
  }, [shown.snap]);

  // The opening in portrait (DS v1.52): Get out stacks over the flow and no word is cut, so how the
  // flow sits is fitted on the real fonts rather than by arithmetic. Step 0 shows every line at the
  // loose spacing; step 1 the same at landscape's tight spacing; each step after gives one optional
  // line way (`stackShedOrder`); past the last, Get out's heads run in beside their lists and the lines
  // come back to give way again (`stackRung`), until the stack stands inside its body, or there is
  // nothing left to try and the body scrolls (§6 Frame geometry). A fit holds for the inputs it was
  // made on; new inputs start again from step 0. Each step re-renders before paint, so only the fit
  // is ever seen. Until the last step still runs past it, the body clips rather than scrolls: a row
  // mid-glide past its edge never brings a scrollbar in to reflow the words (round 2 review).
  //
  // The step wanted is the first that fits, and it is searched for, not walked to (review round 1 of
  // prep pages): each re-render before paint is a nested update, React allows 50 before it throws,
  // and a walk of the roast's 22 steps, started over when the sheet lays the place again, ran it out.
  // Within a rung (heads over their lists, then heads run in) each step gives one more line way, so
  // the stack only gets shorter: from a step that runs over, the next tried is twice as far into the
  // rung (0, 1, 3, 7, ...), and once one fits the first that fits is halved in on (`lo`, `hi`). The
  // heaviest opening (twelve lines to give way) is fitted in 13 re-renders where the walk took 28.
  // And whatever starts the fit over, it re-renders at most `FIT_BURST` times before a paint: past
  // that it goes on from the next frame, one unfinished frame drawn in place of a page gone down.
  const phases = phasesModel?.phases ?? [];
  const stacked = ov.opening !== null && ov.sheetBottom > (ov.opening.chart.w + 2 * ov.opening.chart.x) * c;
  const hasGetOut = getOutModel.equipment.length > 0 || getOutModel.fridge.length > 0 || getOutModel.pantry.length > 0;
  const hasAhead = (phasesModel?.ahead?.length ?? 0) > 0 || Boolean(ov.opening?.ahead && ov.opening.ahead.items.length > 0);
  /** The note carries "Missed it? Ask Sous" (its 48 px target): there is make-ahead work to ask about, and a way to ask. */
  const aheadAsks = Boolean(onAskAhead) && (phasesModel?.ahead?.length ?? 0) > 0;

  // The whole meal as lines and stations (DS v1.63): the opening's flow and level 2 both draw it.
  // As written has no minutes to draw lines from: it keeps the phase outline.
  const lines = useMemo(() => (plan && !strip.asWritten ? mealLines(plan, strip, { opening }) : null), [plan, strip, opening]);
  // The lines are laid out for their room, not for the place object: the sheet lays a new place on a
  // read put up or away with the same room, and the fit ladder measures every label again (review
  // React 1). The fonts arriving change the words' widths, not the room, so they count too.
  const fontsLoaded = useFontsLoaded(measureText === undefined);
  // At the whole cook the lines take the sheet down to the foot, as the opening's do: the strip stands
  // in the foot's row (DS v1.62), so nothing stands over the foot any more (the line the old
  // timetable's marks grew from, `onSheet.growFrom`, kept 72 cpx of Paper empty there).
  const room = ov.opening
    ? { kind: "opening" as const, y: ov.opening.chart.y, w: ov.opening.chart.w, bottom: ov.sheetBottom }
    : ov.whole
      ? { kind: "whole" as const, y: ov.whole.chart.y, w: ov.whole.chart.w, bottom: wholeLinesBottom(ov) }
      : null;
  const roomKey = room ? `${room.kind}|${room.y}|${room.w}|${room.bottom}` : "";
  const linesDrawing = useMemo((): LinesDrawing | null => {
    if (!lines || !room) return null;
    const measure = (measureText ?? pageMeasure)();
    if (room.kind === "opening") {
      const bodyHeight = Math.max(180 * c, room.bottom - room.y * c - LINES_OVER_FOOT * c);
      const W = stacked ? room.w * c : room.w * c - (hasGetOut ? (GET_OUT_LINES + 18) * c : 0);
      // With no Get out to head, Ahead stands above the lines in the flow's column: they get the rest.
      const aheadAbove = !stacked && hasAhead && !hasGetOut;
      return layoutMealLines(lines, { W, H: bodyHeight - (aheadAbove ? aheadRowPx(c, aheadAsks) : 0), c, narrow: stacked }, measure);
    }
    const avail = Math.max(120, room.bottom - room.y);
    return layoutMealLines(lines, { W: room.w * c, H: avail * c, c, narrow: portrait }, measure);
    // `room` is read through `roomKey`: the same numbers, the same drawing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, roomKey, c, stacked, hasGetOut, hasAhead, aheadAsks, portrait, measureText, fontsLoaded]);

  // Get out keeps room for two rows (DS v1.66, DECISIONS 2026-11-24): heading Get out's column on the
  // wide tablet, the Ahead note folds to one line where at its full height it would leave the list less
  // than its first two rows. Worked out from the room and the words, never from what is drawn, so a note
  // that fits never moves. It starts folded each time the opening is shown.
  // The stepper's words and whether it scales, not the object: the cook page builds a fresh one each
  // render (every timer tick), and the note is measured again only when what it reads changes.
  const stepperWords = stepper ? servingsText(stepper.recipe, stepper.scales === false ? stepper.recipe.serves_base : stepper.servings) : null;
  const stepperScales = stepper ? stepper.scales !== false : false;
  const aheadFolds = useMemo((): boolean => {
    if (!room || room.kind !== "opening" || stacked || linesDrawing === null || !hasGetOut || !hasAhead) return false;
    const measure = (measureText ?? pageMeasure)();
    const ahead = phasesModel?.ahead ?? [];
    const runs = noteRuns(
      ahead,
      ov.opening?.ahead?.items ?? [],
      COOK_COPY.ahead,
      aheadAsks ? missedAheadAsk(ahead.map((a) => a.group)).words : null,
    );
    const bodyHeight = Math.max(180 * c, room.bottom - room.y * c - LINES_OVER_FOOT * c);
    const groups = [
      getOutModel.equipment,
      getOutModel.fridge.map((it) => it.bare),
      getOutModel.pantry.map((it) => it.bare),
    ].map((items) => ({ items }));
    return foldsFor({
      avail: bodyHeight / c,
      noteFull: noteFullCpx(runs, c, measure, aheadAsks),
      folded: noteFoldedCpx(c),
      head: headRowCpx(
        {
          heading: COOK_COPY.getOut,
          scaleNote,
          stepper: stepperWords !== null ? { words: stepperWords, scales: stepperScales } : null,
          amounts: getOutModel.fridge.length > 0 || getOutModel.pantry.length > 0,
        },
        measure,
      ),
      rows: listRowsCpx(groups, measure),
    });
    // `room` is read through `roomKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, c, stacked, linesDrawing, hasGetOut, hasAhead, aheadAsks, phasesModel, ov.opening, getOutModel, scaleNote, stepperWords, stepperScales, measureText, fontsLoaded]);
  const [aheadOpen, setAheadOpen] = useState(false);
  const [openingShown, setOpeningShown] = useState(opening);
  if (openingShown !== opening) {
    setOpeningShown(opening);
    if (opening) setAheadOpen(false);
  }
  /** Where the focus goes once the note is opened or folded by its mark: to the mark that undoes it. */
  const aheadFoldMoved = useRef(false);
  const aheadFoldRef = useCallback((el: HTMLButtonElement | null) => {
    if (el && aheadFoldMoved.current) {
      aheadFoldMoved.current = false;
      el.focus({ preventScroll: true });
    }
  }, []);
  const shedOrder = stacked && !linesDrawing ? stackShedOrder(phases) : [];
  /** The last step of the first rung: tight, every optional line given way, Get out's heads over their lists. */
  const rungEnd = 1 + shedOrder.length;
  const lastStep = rungEnd + (hasGetOut ? 1 + shedOrder.length : 0);
  // The place by what it says, not which object says it: the sheet lays a new one out for the step
  // standing under the opening too (a prep page settling its own fit, DS v1.59), and one that says
  // the same must not start this fit again. Two full fits and a third begun pass React's limit of
  // 50 updates before paint, which took the page down (the roast in portrait, a timer ringing).
  const ovSays = useMemo(() => saysOf(ov), [ov]);
  const fitInputs = useMemo<readonly unknown[]>(
    () => [ovSays, showAmounts, scaleNote, phasesModel, getOutModel],
    [ovSays, showAmounts, scaleNote, phasesModel, getOutModel],
  );
  const [stackFit, setStackFit] = useState<{
    inputs: readonly unknown[];
    step: number;
    scrolls: boolean;
    /** The furthest step of the rung in hand known to run over; one before the rung's first until one has. */
    lo: number;
    /** The nearest step known to fit; null until one has. */
    hi: number | null;
  } | null>(null);
  const fitNow = stackFit !== null && stackFit.inputs === fitInputs ? stackFit : null;
  const stackStep = fitNow?.step ?? 0;
  const fitLo = fitNow?.lo ?? -1;
  const fitHi = fitNow?.hi ?? null;
  /** The fit has run out of steps and the stack still runs past its body: only now may the body scroll. */
  const stackScrolls = fitNow?.scrolls ?? false;
  const openingBodyRef = useRef<HTMLDivElement | null>(null);
  const openingFlowRef = useRef<HTMLElement | null>(null);
  // What scrolls says so with the list foot's fade while there is more below (§6 Lists, `useMoreBelow`;
  // asked 2026-11-22): Get out's list in its column, and portrait's stack at its last resort.
  const getOutScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollKey = `${ov.opening !== null}|${stacked}|${stackScrolls}|${stackStep}|${showAmounts}|${hasGetOut}`;
  const getOutMask = footMask(useMoreBelow(getOutScrollRef, scrollKey));
  const stackBelow = useMoreBelow(openingBodyRef, scrollKey);
  const stackMask = stacked && stackScrolls ? footMask(stackBelow) : undefined;
  // The lines past the fit ladder scroll in their own column (DS v1.63), under the foot's fade.
  const linesScrollRef = useRef<HTMLDivElement | null>(null);
  const linesScroll = linesDrawing !== null && linesDrawing.scroll && !stacked;
  // The lines' box is a new one each time the prep mode is chosen (its `key`, the cross-fade): the mode
  // is in the fade's key so it listens to the box on screen, whatever the heights.
  const linesMask = footMask(useMoreBelow(linesScrollRef, `${scrollKey}|${ov.timetable.mode}|${linesDrawing?.height ?? 0}`));
  const linesNowY = linesDrawing?.nowY ?? null;
  // The step in hand starts in view when the whole meal scrolls. Before the sheet is told of the
  // lines (below): a pull in hand takes the lines where they stand.
  useLayoutEffect(() => {
    const box = linesScrollRef.current;
    if (!box || !linesScroll || linesNowY === null) return;
    box.scrollTop = Math.max(0, linesNowY - box.clientHeight / 3);
  }, [linesScroll, linesNowY]);
  // A finger scrolls the lines in their box. At the list's top the browser takes only a drag up
  // (`pan-down`: the pull-to-refresh pattern, Pointer Events §touch-action), so a drag down from
  // there is the sheet's pull, back toward the step (CookSheet's `downOn`); off its top, both ways.
  useEffect(() => {
    const box = linesScrollRef.current;
    if (!box || !linesScroll) return;
    const sync = () => {
      box.style.touchAction = box.scrollTop <= 0.5 ? "pan-down" : "pan-y";
    };
    sync();
    box.addEventListener("scroll", sync, { passive: true });
    return () => {
      box.removeEventListener("scroll", sync);
      box.style.touchAction = "";
    };
  }, [linesScroll, linesDrawing]);
  // The whole cook's lines, told to the sheet once they are on the page (and again when their box is a new one).
  const wholeLines = ov.whole && !opening ? linesDrawing : null;
  useLayoutEffect(() => {
    onWholeLines?.(wholeLines);
    // Gone from the page (or drawn anew): the sheet lets go of the old parts.
    return () => onWholeLines?.(null);
  }, [onWholeLines, wholeLines, ov.timetable.mode]);
  /** This commit is a step of the fit: the glide waits for the stack it lands in. */
  const refitting = useRef(false);
  /**
   * The fit's re-renders since the last paint (`FIT_BURST`), and the frame asked for that starts
   * the count over, null when none is. The count is started over by the frame and by nothing
   * else, so whenever a step is counted and no frame is asked for, one is: an unmount cancels the
   * frame and StrictMode rehearses an unmount on every mount in development, where a count armed
   * only at zero was never started over again and every fit past its 32nd step ran a step a
   * frame (review round 2 of prep pages).
   */
  const fitBurst = useRef<{ steps: number; reset: number | null }>({ steps: 0, reset: null });
  useEffect(() => {
    const burst = fitBurst.current;
    return () => {
      if (burst.reset !== null) cancelAnimationFrame(burst.reset);
      burst.reset = null;
      burst.steps = 0;
    };
  }, []);
  useLayoutEffect(() => {
    refitting.current = false;
    const body = openingBodyRef.current;
    const flow = openingFlowRef.current;
    if (!stacked || !body || !flow) return;
    // The sections' own boxes, which the glide's transforms (on the rows inside) never move.
    const b = body.getBoundingClientRect();
    const over = flow.getBoundingClientRect().bottom - b.top + body.scrollTop > b.height + 0.5;
    let to: { step: number; scrolls: boolean; lo: number; hi: number | null } | null = null;
    if (!over) {
      // It fits here. The first step that does lies after the last known to run over.
      if (!stackScrolls && stackStep - fitLo > 1) {
        to = { step: fitLo + Math.floor((stackStep - fitLo) / 2), scrolls: false, lo: fitLo, hi: stackStep };
      }
    } else if (fitHi !== null && fitHi > stackStep) {
      // It runs over here and fits at `hi`: halve in, or take `hi` when it is the next step.
      const gap = fitHi - stackStep;
      to = { step: gap > 1 ? stackStep + Math.floor(gap / 2) : fitHi, scrolls: false, lo: stackStep, hi: fitHi };
    } else {
      // It runs over and no step is known to fit: twice as far into this rung, to the rung's end;
      // from the first rung's end on to the second, where the lines come back; past the last, it scrolls.
      const first = stackStep > rungEnd ? rungEnd + 1 : 0;
      const end = stackStep > rungEnd ? lastStep : rungEnd;
      if (stackStep < end) {
        to = { step: Math.min(end, first + 2 * (stackStep - first) + 1), scrolls: false, lo: stackStep, hi: null };
      } else if (stackStep < lastStep) {
        to = { step: stackStep + 1, scrolls: false, lo: stackStep, hi: null };
      } else if (!stackScrolls) {
        // The body's scrollbar may narrow the stack, so the glide waits for this commit too.
        to = { step: stackStep, scrolls: true, lo: stackStep, hi: null };
      }
    }
    if (to === null) return;
    refitting.current = true;
    const next = { inputs: fitInputs, ...to };
    const burst = fitBurst.current;
    // The count starts over once a frame has been drawn.
    burst.reset ??= requestAnimationFrame(() => {
      burst.reset = null;
      burst.steps = 0;
    });
    burst.steps++;
    if (burst.steps <= FIT_BURST) {
      // Measured on the page: each step re-renders before paint.
      setStackFit(next);
      return;
    }
    // Past the cap this step waits for the next frame. It is the step from what was measured here:
    // if the fit moves on before the frame comes (a new place laid and drawn), the step is dropped
    // with this effect, or it would land on the newer fit and start it over from step 0.
    const later = requestAnimationFrame(() => setStackFit(next));
    return () => cancelAnimationFrame(later);
  }, [stacked, stackStep, stackScrolls, fitLo, fitHi, rungEnd, lastStep, fitInputs]);

  // FLIP animation on mode toggle (`[data-flip-id]`) + "N min sooner" fade.
  useLayoutEffect(() => {
    const root = rootEl.current;
    if (!root || refitting.current) return;
    const prevRects = lastFlipRects.current;

    if (anim && anim.id !== lastAnimId.current) {
      lastAnimId.current = anim.id;
      const nextRects = new Map<string, DOMRect>();
      for (const el of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
        const id = el.dataset.flipId!;
        const prev = prevRects.get(id);
        const next = el.getBoundingClientRect();
        if (next.width > 0 && next.height > 0) nextRects.set(id, next);
        if (prev && next.width > 0 && next.height > 0) {
          const dx = prev.left - next.left;
          const dy = prev.top - next.top;
          el.animate(
            [
              { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` },
              { transform: "translate(0px, 0px)" },
            ],
            { duration: MOVE_MS, easing: EASE },
          );
        } else if (!prev) {
          el.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: MOVE_MS,
            easing: EASE,
            fill: "backwards",
          });
        }
      }
      lastFlipRects.current = nextRects;

      const label = root.querySelector<HTMLElement>("[data-sooner]");
      const all = SOONER_HOLD_MS + SOONER_FADE_MS;
      label?.animate(
        [
          { opacity: 0, offset: 0, easing: EASE },
          { opacity: 0, offset: 250 / all, easing: EASE },
          { opacity: 1, offset: 550 / all, easing: EASE },
          { opacity: 1, offset: SOONER_HOLD_MS / all, easing: EASE },
          { opacity: 0, offset: 1 },
        ],
        { duration: all, fill: "forwards" },
      );
    } else if (!anim) {
      const nextRects = new Map<string, DOMRect>();
      for (const el of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) nextRects.set(el.dataset.flipId!, r);
      }
      lastFlipRects.current = nextRects;
    }
  });

  const markOf = (key: string) =>
    strip.marks.find((m) => m.key === key) ?? strip.prepMarks?.find((m) => m.key === key) ?? null;
  const prepMark = strip.marks.find((m) => m.key === "prep") ?? null;
  const op = ov.opening;
  const wh = ov.whole;
  const toggle = op?.toggle ?? wh?.toggle ?? null;
  const read = ov.read && wh?.read ? { key: ov.read.key, kind: ov.read.go, ...wh.read } : null;
  const goLabel = read?.kind === "prep" ? COOK_COPY.goToPrep : COOK_COPY.goToStep;

  // An item is one piece on its line (it moves to the next line whole), and wraps inside the column
  // only when it alone is wider than the column, so no word is ever cut at the column's edge.
  const renderIngredientItems = (items: readonly CategorizedGetOutItem[]) =>
    items.map((it, idx) => {
      // The dot rides the item's last word (no-break spaces), so a wrapped line never starts with it.
      // A pair that opens is a button, one box: its dot is set inside it, after the name. Outside,
      // a pair wider than the column left the dot alone on a line of its own (review round 1).
      const dot = idx < items.length - 1 && (
        <span data-dot aria-hidden="true" className="text-ink-soft">
          {"\u00a0·\u00a0"}
        </span>
      );
      const opens = showAmounts && it.amount ? it.opens : undefined;
      return (
        <li
          key={it.index}
          data-row
          data-ingredient-index={it.index}
          className="inline-block max-w-full"
          style={{ fontSize: px(22), lineHeight: `${px(26)}px` }}
        >
          {showAmounts && it.amount ? (
            opens ? (
              // An amount with conversions is its pair's button, as on a step (DS §5): the dotted rule
              // under the amount, the panel drawn in the opening's layer, clear of the column's clip.
              <MeasurementPopover
                stated={opens.stated}
                conversions={opens.conversions}
                servesBase={opens.servesBase}
                exact={opens.exact}
                className={FOCUS}
              >
                <span data-amount data-amount-words className={`font-bold text-ink ${AMOUNT_RULE_INK}`}>
                  {it.amount}
                </span>{" "}
                <span data-ingredient-name className="font-medium text-ink">
                  {it.bare.charAt(0).toLowerCase() + it.bare.slice(1)}
                </span>
                {dot}
              </MeasurementPopover>
            ) : (
              <>
                <span data-amount className="font-bold text-ink">
                  {it.amount}
                </span>{" "}
                <span data-ingredient-name className="font-medium text-ink">
                  {it.bare.charAt(0).toLowerCase() + it.bare.slice(1)}
                </span>
              </>
            )
          ) : (
            <>
              {it.amount && (
                <span data-amount className="sr-only">
                  {it.amount}{" "}
                </span>
              )}
              <span data-ingredient-name className="font-medium text-ink">
                {it.bare}
              </span>
            </>
          )}
          {!opens && dot}
        </li>
      );
    });

  const firstMeanwhilePhaseKey = phases.find((p) => p.meanwhile !== null)?.key ?? null;

  return (
    <div
      ref={setRoot}
      data-overview
      data-timetable
      data-opening-lanes={opening ? "" : undefined}
      data-fits={d.fits ? "true" : "false"}
      data-row-pitch={d.R.toFixed(1)}
      data-block-h={d.blockH.toFixed(1)}
      data-lane-count={ov.timetable.lanes.length}
      data-demoted={d.demoted.length}
      data-gutter={d.gutter.toFixed(1)}
      data-mode={ov.timetable.mode}
      className="absolute inset-0 z-[1]"
      style={{ opacity: 0, visibility: "hidden" }}
    >
      <div className="pointer-events-none absolute inset-0" style={{ opacity: "var(--lanes-op, 1)" }}>
        {/* Level 2's own sheet when rendered standalone outside CookSheet's derived Paper. */}
        {wh && !onSheet && (
          <>
            <div
              data-whole-sheet
              aria-hidden
              className="absolute bg-paper ring-1 ring-ink/[.11] ring-inset"
              style={{
                left: px(wh.sheet.x),
                top: px(wh.sheet.y),
                width: px(wh.sheet.w),
                height: px(wh.sheet.h),
                borderRadius: px(28),
              }}
            />
            <div
              aria-hidden
              className="absolute rounded-full bg-ink/[.22]"
              style={{ left: px(wh.grab.x), top: px(wh.grab.y), width: px(wh.grab.w), height: px(wh.grab.h) }}
            />
          </>
        )}

        {/* Prep first | As I go, with both totals: the trade-off reads before the tap. */}
        {toggle && onMode && (
          <div
            role="group"
            aria-label={COOK_COPY.modeGroup}
            data-mode-toggle
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="pointer-events-none absolute z-[7]"
            style={{ left: 0, top: px(toggle.y), width: "100%", height: px(toggle.h), opacity: wordsOp }}
          >
            {toggle.items.map((it) => (
              <span key={it.mode}>
                <button
                  type="button"
                  tabIndex={live || opening ? 0 : -1}
                  aria-pressed={it.on}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMode(it.mode);
                  }}
                  className={`pointer-events-auto absolute cursor-pointer whitespace-nowrap after:absolute after:-inset-x-[calc(8*var(--cpx))] after:-inset-y-[calc(8*var(--cpx))] active:bg-sand ${FOCUS} ${
                    it.on
                      ? "font-semibold text-ink underline decoration-ink decoration-[length:calc(2*var(--cpx))] underline-offset-[5px]"
                      : "font-medium text-ink-soft"
                  }`}
                  style={{ left: px(it.x), top: 0, height: px(toggle.h), fontSize: px(28), lineHeight: `${px(toggle.h)}px` }}
                >
                  {it.label}
                </button>
                <span
                  data-mode-minutes={it.mode}
                  className="absolute font-medium whitespace-nowrap text-ink-soft"
                  style={{ left: px(it.minutesX), top: px(4), height: px(toggle.h), fontSize: px(22), lineHeight: `${px(toggle.h)}px` }}
                >
                  {it.minutes}
                </span>
              </span>
            ))}
          </div>
        )}

        {/* The opening's hands-on minutes, once, quietly, at the head of the toggle's row. */}
        {op?.handsOn && (
          <p
            data-opening-hands-on
            className="absolute m-0 font-medium whitespace-nowrap text-ink-soft"
            style={{
              left: px(op.handsOn.x),
              top: px(op.handsOn.y),
              height: px(op.handsOn.h),
              fontSize: px(22),
              lineHeight: `${px(op.handsOn.h)}px`,
            }}
          >
            {op.handsOn.text}
          </p>
        )}

        {/* THE OPENING: Two-Column Recipe Opening (`Get out` + `The flow`). */}
        {op && (() => {
          const bodyTop = px(op.chart.y);
          const bodyHeight = Math.max(px(180), ov.sheetBottom - bodyTop - px(14));
          const availCpx = bodyHeight / c;
          // Landscape: Get out's column beside the flow, its spacing and lines budgeted by arithmetic.
          // Portrait (DS v1.52): stacked, each the body's full width, both fitted (`stackStep`).
          // Beside the meal's lines Get out narrows to the drawing's column (DS v1.63), so the lines have the room.
          const leftColWidth = px(linesDrawing ? GET_OUT_LINES : 380);
          const rung = stackRung(stackStep, shedOrder.length, hasGetOut);
          const aheadList = phasesModel?.ahead ?? [];
          const ask = aheadList.length > 0 ? missedAheadAsk(aheadList.map((a) => a.group)) : null;
          // In the flow (no Get out to head) the note's row is its real height; heading Get out it is not in the flow.
          const aheadInFlowRow = !stacked && !(linesDrawing !== null && hasGetOut);
          const flowAvailCpx = availCpx - (hasAhead ? (aheadInFlowRow ? aheadRowPx(c, aheadAsks) / c : AHEAD_ROW) : 0);
          const tightFlow = stacked ? rung.tight : flowAvailCpx < phases.length * 66;
          const baseRowCpx = tightFlow ? 31 : 38;
          const maxSubLines = Math.max(0, Math.floor((flowAvailCpx - 14 - phases.length * baseRowCpx) / 27));

          // With the lines, Ahead heads Get out's column, as drawn (DS v1.63), so the meal's shape is the
          // first thing in the flow's.
          const aheadInGetOut = linesDrawing !== null && hasGetOut;
          // In Get out's narrow column (210 cpx) the note wraps, and the ask sits under its words on
          // a line of its own: beside them it took the column's whole width and was clipped itself.
          const aheadColumn = !stacked && aheadInGetOut;
          const aheadWraps = stacked || aheadInGetOut;
          // Built only when there is a note: an opening with no Ahead has nothing to read it from.
          // "Missed it? Ask Sous" (DECISIONS 2026-11-24): the Prep screen's shortcut, as the note's last
          // words, about all the make-ahead work at once (`missedAheadAsk`). The note draws "Missed it?"
          // ("Missed these?"), which fits one line of Get out's column: it costs the note one line at most,
          // none where the words fit on its last one. Its target is the whole note, which stands 48 px tall
          // at least, so the target never hangs past it into the body's clip or the stepper's touch (review
          // round 2). In the one-line form (no Get out beside the lines) the words follow the cut text,
          // never cut themselves.
          const askHere = onAskAhead && ask ? ask : null;
          const askWords = askHere && (
            <span data-ask-words aria-hidden="true" className="shrink-0 font-semibold whitespace-nowrap text-ink underline decoration-ink/[.35] underline-offset-[4px]">
              {askHere.words}
            </span>
          );
          const aheadWords = (
            <>
              <span className="font-semibold text-ink" style={{ fontSize: px(24), lineHeight: `${px(26)}px` }}>
                {COOK_COPY.ahead}
              </span>{" "}
              {aheadList.length > 0
                ? aheadList.map((a, q) => (
                    <span key={q} className={aheadWraps ? undefined : "whitespace-nowrap"}>
                      {q > 0 ? " · " : ""}
                      <span className="font-bold text-ink">{a.summary}</span>{" "}
                      <span className="font-medium text-ink-soft">· {a.lead}</span>
                    </span>
                  ))
                : (op.ahead?.items ?? []).map((a, q) => (
                    <span key={q} className={aheadWraps ? undefined : "whitespace-nowrap"}>
                      {q > 0 ? " · " : ""}
                      <span className="font-bold text-ink">{a.name}</span>{" "}
                      <span className="font-medium text-ink-soft">{a.lead}</span>
                    </span>
                  ))}
            </>
          );
          // Get out keeps room for two rows (DS v1.66): folded, the note is one line, "Ahead · 3 jobs", and
          // the mark that opens it, the whole line its target; opened, it is drawn as ever with the same
          // mark turned in its corner to fold it again.
          const folding = aheadColumn && aheadFolds;
          const aheadJobs = aheadList.length > 0 ? aheadList.length : (op.ahead?.items.length ?? 0);
          const aheadText = `${COOK_COPY.ahead} ${
            aheadList.length > 0
              ? aheadList.map((a) => `${a.summary} · ${a.lead}`).join(" · ")
              : (op.ahead?.items ?? []).map((a) => `${a.name} ${a.lead}`).join(" · ")
          }`;
          const foldTo = (open: boolean) => (e: React.MouseEvent) => {
            e.stopPropagation();
            aheadFoldMoved.current = true;
            setAheadOpen(open);
          };
          const aheadFolded = folding && !aheadOpen && (
            <button
              type="button"
              ref={aheadFoldRef}
              data-ahead
              data-sand=""
              data-ahead-form="column"
              data-ahead-fold="folded"
              aria-expanded={false}
              aria-label={`${aheadText}. Show all`}
              onClick={foldTo(true)}
              className={`pointer-events-auto relative flex min-h-[48px] w-full shrink-0 cursor-pointer items-center gap-[calc(4*var(--cpx))] rounded-[var(--radius-2)] bg-sand px-[calc(12*var(--cpx))] py-[calc(6*var(--cpx))] text-left ${FOCUS_IN}`}
            >
              <span aria-hidden="true" data-ahead-count className="min-w-0 flex-1 whitespace-nowrap" style={{ fontSize: px(22), lineHeight: `${px(26)}px` }}>
                <span className="font-semibold text-ink" style={{ fontSize: px(24), lineHeight: `${px(26)}px` }}>
                  {COOK_COPY.ahead}
                </span>{" "}
                <span className="font-medium text-ink-soft">{foldedCount(aheadJobs)}</span>
              </span>
              <span aria-hidden="true" className="inline-flex shrink-0 text-ink">
                <Chevron size={px(22)} turn="down" />
              </span>
            </button>
          );
          const aheadBlock = hasAhead && (aheadFolded || (
                    <div
                      data-ahead
                      data-sand=""
                      data-ahead-form={stacked ? "stacked" : aheadColumn ? "column" : "row"}
                      data-ahead-fold={folding ? "open" : undefined}
                      className={
                        aheadColumn
                          ? `relative flex shrink-0 flex-col items-start justify-center gap-[calc(4*var(--cpx))] rounded-[var(--radius-2)] bg-sand px-[calc(12*var(--cpx))] py-[calc(6*var(--cpx))]${askHere ? " min-h-[48px]" : ""}`
                          : stacked
                          ? `relative flex shrink-0 items-center justify-between gap-[calc(10*var(--cpx))] rounded-[var(--radius-2)] bg-sand px-[calc(12*var(--cpx))] py-[calc(4*var(--cpx))]${askHere ? " min-h-[48px]" : ""}`
                          : `flex shrink-0 flex-nowrap justify-between gap-[calc(10*var(--cpx))] rounded-[var(--radius-2)] bg-sand px-[calc(12*var(--cpx))] py-[calc(4*var(--cpx))] ${askHere ? "relative min-h-[48px] items-center" : "items-baseline overflow-hidden"}`
                      }
                    >
                      <p
                        id={aheadNoteId}
                        className={aheadWraps ? "m-0 min-w-0 flex-1" : "m-0 flex min-w-0 flex-1 items-baseline whitespace-nowrap"}
                        style={{ fontSize: px(22), lineHeight: `${px(26)}px` }}
                      >
                        {/* Opened from its fold, the words keep clear of the mark in the corner. */}
                        {folding && (
                          <span
                            aria-hidden="true"
                            className="float-right block"
                            style={{ width: Math.max(0, 48 - px(12)), height: Math.max(0, 48 - px(6)) }}
                          />
                        )}
                        {/* One line: the note's words cut with an ellipsis, the ask's after them, whole, in
                            the same text and at its size (review round 3). */}
                        {aheadWraps ? (
                          aheadWords
                        ) : (
                          // The full stop ends the part that is cut, so a cut note never reads "…. Missed it?".
                          <span className="min-w-0 truncate">
                            {aheadWords}
                            {askHere && <span className="font-medium text-ink-soft">.</span>}
                          </span>
                        )}
                        {/* The words' first half, marked as the opening's inline asks are (an underline),
                            one line in Get out's column; the note's button below carries the whole, so
                            they are said once. */}
                        {askHere &&
                          (aheadWraps ? (
                            <>
                              <span className="font-medium text-ink-soft">.</span> {askWords}
                            </>
                          ) : (
                            <>
                              <span className="shrink-0 whitespace-pre"> </span>
                              {askWords}
                            </>
                          ))}
                      </p>
                      {/* Before the ask, so Tab and a swipe go from it to the ask (it takes the focus on opening).
                          Its whole 48 px square is its target, corners and all, so a finger near its corner
                          never falls through to the ask under it; the ring, on the span, keeps the note's corner. */}
                      {folding && (
                        <button
                          type="button"
                          ref={aheadFoldRef}
                          data-ahead-fold-back
                          aria-expanded={true}
                          aria-label="Show less"
                          onClick={foldTo(false)}
                          className="group pointer-events-auto absolute top-0 right-0 z-[1] inline-flex h-[48px] w-[48px] cursor-pointer items-center justify-center text-ink outline-none"
                        >
                          <span
                            aria-hidden="true"
                            data-ahead-fold-ring
                            className="pointer-events-none absolute inset-0 rounded-tr-[var(--radius-2)] group-focus-visible:outline-3 group-focus-visible:-outline-offset-4 group-focus-visible:outline-ink"
                          />
                          <Chevron size={px(22)} turn="up" />
                        </button>
                      )}
                      {askHere && onAskAhead && (
                        <button
                          type="button"
                          data-ask-ahead
                          aria-label={askHere.label}
                          // It lies over the note's words: a finger exploring the note lands on it, so it says them too.
                          aria-describedby={aheadNoteId}
                          onClick={(e) => {
                            e.stopPropagation();
                            onAskAhead(aheadList.map((a) => a.group));
                          }}
                          // The ring is drawn inside the note: it stands flush with columns that clip, where a ring outside would be cut.
                          className={`pointer-events-auto absolute inset-0 cursor-pointer rounded-[var(--radius-2)] ${FOCUS_IN}`}
                        />
                      )}
                    </div>
          ));
          const allowedPassiveKeys = new Set<string>();
          const allowedSummaryKeys = new Set<string>();
          /** Portrait: the optional lines the fit has given way so far. */
          const shed = new Set(shedOrder.slice(0, rung.shed));
          /** Portrait, the fit's last resort before shedding again: each Get out head runs in before its list. */
          const runIn = stacked && rung.runIn;
          if (stacked) {
            for (const p of phases) {
              if (p.passiveWindow !== null && p.meanwhile === null && !shed.has(`window:${p.key}`)) allowedPassiveKeys.add(p.key);
              if (p.summary && !shed.has(`summary:${p.key}`)) allowedSummaryKeys.add(p.key);
            }
          } else {
            let usedSubLines = phases.filter((p) => p.movable !== null || p.meanwhile !== null).length;
            const passiveCandidates = phases
              .filter((p) => p.passiveWindow !== null && p.meanwhile === null)
              .sort((a, b) => (b.passiveWindow?.minutes ?? 0) - (a.passiveWindow?.minutes ?? 0));
            for (const p of passiveCandidates) {
              if (usedSubLines < maxSubLines || allowedPassiveKeys.size === 0) {
                allowedPassiveKeys.add(p.key);
                usedSubLines += 1;
              }
            }
            const summaryPrimary = phases.filter(
              (p) => p.summary && !p.movable && !p.meanwhile && !allowedPassiveKeys.has(p.key),
            );
            const summarySecondary = phases.filter(
              (p) => p.summary && (p.movable || p.meanwhile || allowedPassiveKeys.has(p.key)),
            );
            for (const p of [...summaryPrimary, ...summarySecondary]) {
              if (usedSubLines < maxSubLines) {
                allowedSummaryKeys.add(p.key);
                usedSubLines += 1;
              }
            }
          }

          return (
            // The layer a Get out amount's conversions are drawn in (`MeasurementPopover`): the whole
            // opening, so the panel stands clear of the column that scrolls.
            <div data-opening data-popover-layer className="absolute inset-0">
              <Link
                href="/kitchen"
                prefetch={false}
                data-opening-back
                aria-label="Back to the kitchen"
                onClick={(e) => e.stopPropagation()}
                style={{ left: px(op.back.x), top: px(op.back.y), width: px(op.back.w), height: px(op.back.h) }}
                className={`pointer-events-auto absolute z-[6] inline-flex items-center justify-center rounded-full text-ink transition-colors duration-[320ms] ease-[var(--ease)] after:absolute after:-inset-x-[calc(16*var(--cpx))] after:-inset-y-[calc(12*var(--cpx))] active:bg-sand ${FOCUS}`}
              >
                <Chevron size={px(26)} />
              </Link>
              <h1
                data-opening-title
                className="absolute m-0 font-[family-name:var(--font-display)] font-normal whitespace-nowrap text-ink [font-synthesis:none]"
                style={{ left: px(op.title.x), top: px(op.title.y), fontSize: px(op.title.size), lineHeight: `${px(op.title.lh)}px` }}
              >
                {op.title.lines.map((ln, q) => (
                  <span key={q} className="block">
                    {q > 0 ? ` ${ln}` : ln}
                  </span>
                ))}
              </h1>
              <span data-tt-role="total" className="sr-only">
                {fmtTotal(ov.timetable.total)}
              </span>

              {/* Subtle hairline below Deck 2 */}
              <div
                aria-hidden
                className="absolute h-px bg-ink/[.11]"
                style={{ left: px(op.chart.x), top: px(op.chart.y - 8), width: px(op.chart.w) }}
              />

              {/* Two-Column Body: Left = Get out, Right = The flow; in portrait, Get out over the flow */}
              <div
                ref={openingBodyRef}
                data-opening-body
                data-stack-step={stacked ? stackStep : undefined}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                className={
                  stacked
                    ? `pointer-events-auto absolute flex flex-col gap-[calc(18*var(--cpx))] overflow-x-hidden ${stackScrolls ? "overflow-y-auto" : "overflow-y-hidden"}`
                    : "pointer-events-auto absolute flex items-start gap-[calc(18*var(--cpx))] overflow-hidden"
                }
                style={{
                  left: px(op.chart.x),
                  top: bodyTop,
                  width: px(op.chart.w),
                  height: bodyHeight,
                  // Portrait's last resort, the stack scrolling: the foot's fade says there is more below (§6 Lists).
                  maskImage: stackMask,
                  WebkitMaskImage: stackMask,
                }}
              >
                {/* Left Column: Get out. Its head stays; its list scrolls in the column when it is taller
                    than the body (landscape), under the foot's fade while there is more below. */}
                {hasGetOut && (
                  <section
                    data-get-out
                    aria-label={COOK_COPY.getOut}
                    className="flex shrink-0 flex-col gap-[calc(6*var(--cpx))]"
                    style={stacked ? undefined : { width: leftColWidth, maxHeight: bodyHeight }}
                  >
                    {hasAhead && aheadInGetOut && aheadBlock}
                    {/* With no Ahead note over it this row is the body's first, and the stepper's − and +
                        stand their 80 cpx touch 24 cpx above it (`STEP_BTN`'s -my), past the body's
                        clip: the row keeps that room over itself (review touch 3). Under them too: the
                        stepper keeps 24 cpx under itself, so what follows it (Show amounts, wrapped under
                        it in Get out's narrow column, or the list) sits clear of their touch and, by
                        14 cpx, of their rings. */}
                    <div
                      data-get-out-head-row
                      className="flex shrink-0 flex-wrap items-baseline justify-between gap-x-[calc(10*var(--cpx))]"
                      // Upright the row is one line under the note, and the − and +'s touch would reach
                      // into the note's (review round 2): the row keeps it the same room there.
                      style={stepper && (stacked || !(hasAhead && aheadInGetOut)) ? { paddingTop: px(24) } : undefined}
                    >
                      <h2
                        data-get-out-head
                        className="m-0 font-semibold whitespace-nowrap text-ink"
                        style={{ fontSize: px(24), lineHeight: `${px(28)}px` }}
                      >
                        {COOK_COPY.getOut}
                        {scaleNote && !stepper && (
                          <>
                            {" "}
                            <span data-scale-note className="font-medium text-ink-soft" style={{ fontSize: px(22) }}>
                              {scaleNote}
                            </span>
                          </>
                        )}
                      </h2>
                      {stepper && <ServingStepper {...stepper} className="mr-auto mb-[calc(24*var(--cpx))]" />}
                      {(getOutModel.fridge.length > 0 || getOutModel.pantry.length > 0) && (
                        <button
                          type="button"
                          data-show-amounts
                          aria-pressed={showAmounts}
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowAmounts((v) => !v);
                          }}
                          className={`pointer-events-auto cursor-pointer font-semibold whitespace-nowrap text-ink-soft hover:text-ink ${FOCUS}`}
                          style={{ fontSize: px(22), lineHeight: `${px(26)}px` }}
                        >
                          {showAmounts ? "Hide amounts" : "Show amounts"}
                        </button>
                      )}
                    </div>

                    {/* The list: in landscape the column's own scroller. A finger pans it (the sheet's pull
                        is off on the opening); it never shows a scrollbar, which would narrow the column
                        and reflow its words, and never changes size when a scroll stops (§6 Lists). In
                        portrait it is no scroller at all (the stack holds it whole and scrolls as one),
                        so a finger on it pans the stack. */}
                    <div
                      ref={getOutScrollRef}
                      data-get-out-scroll
                      className={`flex flex-col gap-[calc(6*var(--cpx))]${
                        stacked ? "" : ` min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain [touch-action:pan-y] ${NO_SCROLLBAR}`
                      }`}
                      style={stacked ? undefined : { maskImage: getOutMask, WebkitMaskImage: getOutMask }}
                    >
                    {getOutModel.equipment.length > 0 && (
                      <div
                        data-get-out-group="equipment"
                        className={runIn ? undefined : "flex flex-col gap-[calc(1*var(--cpx))]"}
                        style={runIn ? { fontSize: px(22), lineHeight: `${px(26)}px` } : undefined}
                      >
                        <h3
                          data-get-out-subhead="equipment"
                          className={`m-0 ${runIn ? "inline " : ""}font-semibold whitespace-nowrap text-ink-soft`}
                          style={{ fontSize: px(22), lineHeight: `${px(25)}px`, marginRight: runIn ? px(10) : undefined }}
                        >
                          Equipment
                        </h3>
                        <ul data-get-out-equipment className={runIn ? "m-0 inline list-none p-0" : "m-0 list-none p-0 leading-none"}>
                          {getOutModel.equipment.map((eq, idx) => (
                            <li
                              key={eq}
                              data-equipment-item
                              className="inline-block whitespace-nowrap font-medium text-ink"
                              style={{ fontSize: px(22), lineHeight: `${px(26)}px` }}
                            >
                              <span>{eq}</span>
                              {idx < getOutModel.equipment.length - 1 && (
                                <span data-dot aria-hidden="true" className="text-ink-soft">
                                  {"\u00a0·\u00a0"}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {getOutModel.fridge.length > 0 && (
                      <div
                        data-get-out-group="fridge"
                        className={runIn ? undefined : "flex flex-col gap-[calc(1*var(--cpx))]"}
                        style={runIn ? { fontSize: px(22), lineHeight: `${px(26)}px` } : undefined}
                      >
                        <h3
                          data-get-out-subhead="fridge"
                          className={`m-0 ${runIn ? "inline " : ""}font-semibold whitespace-nowrap text-ink-soft`}
                          style={{ fontSize: px(22), lineHeight: `${px(25)}px`, marginRight: runIn ? px(10) : undefined }}
                        >
                          Fridge &amp; counter
                        </h3>
                        <ul data-get-out-fridge className={runIn ? "m-0 inline list-none p-0" : "m-0 list-none p-0 leading-none"}>
                          {renderIngredientItems(getOutModel.fridge)}
                        </ul>
                      </div>
                    )}

                    {getOutModel.pantry.length > 0 && (
                      <div
                        data-get-out-group="pantry"
                        className={runIn ? undefined : "flex flex-col gap-[calc(1*var(--cpx))]"}
                        style={runIn ? { fontSize: px(22), lineHeight: `${px(26)}px` } : undefined}
                      >
                        <h3
                          data-get-out-subhead="pantry"
                          className={`m-0 ${runIn ? "inline " : ""}font-semibold whitespace-nowrap text-ink-soft`}
                          style={{ fontSize: px(22), lineHeight: `${px(25)}px`, marginRight: runIn ? px(10) : undefined }}
                        >
                          Pantry &amp; spices
                        </h3>
                        <ul data-get-out-pantry className={runIn ? "m-0 inline list-none p-0" : "m-0 list-none p-0 leading-none"}>
                          {renderIngredientItems(getOutModel.pantry)}
                        </ul>
                      </div>
                    )}
                    </div>
                  </section>
                )}

                {/* Right Column: The flow (`2..6` natural phases + movable prep capsule) */}
                <section
                  ref={openingFlowRef}
                  data-opening-flow
                  aria-label="The flow"
                  className={
                    stacked
                      ? `relative shrink-0 flex flex-col gap-[calc(4*var(--cpx))]${
                          hasGetOut ? " border-t border-ink/[.11] pt-[calc(8*var(--cpx))]" : ""
                        }`
                      : "relative min-w-0 flex-1 flex flex-col gap-[calc(4*var(--cpx))] overflow-hidden"
                  }
                  style={stacked ? undefined : { maxHeight: bodyHeight }}
                >
                  {hasAhead && !aheadInGetOut && aheadBlock}

                  {anim?.sooner && (
                    <div
                      data-sooner
                      className="pointer-events-none absolute top-0 right-0 z-10 font-semibold whitespace-nowrap text-ink-soft"
                      style={{ fontSize: px(22), lineHeight: `${px(26)}px`, opacity: 0 }}
                    >
                      {anim.sooner.label}
                    </div>
                  )}

                  {linesDrawing ? (
                    <div
                      ref={linesScrollRef}
                      data-lines-scroll
                      // A prep mode chosen redraws the lines: they cross-fade in (DS v1.63), never glide.
                      key={ov.timetable.mode}
                      className={`motion-safe:animate-[dot-in_280ms_var(--ease)] ${
                        linesScroll ? `min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain [touch-action:pan-y] ${NO_SCROLLBAR}` : ""
                      }`}
                      style={linesScroll ? { maskImage: linesMask, WebkitMaskImage: linesMask } : undefined}
                    >
                      <MealLines drawing={linesDrawing} c={c} onRead={null} readMark={null} tab={-1} ground />
                    </div>
                  ) : (
                  <ol
                    data-phase-list
                    className={`m-0 flex flex-col list-none p-0 ${
                      tightFlow ? "gap-[calc(2*var(--cpx))]" : "gap-[calc(4*var(--cpx))]"
                    }`}
                  >
                    {phases.map((phase) => {
                      const pMarks = phaseMarksMap.get(phase.key) ?? [];
                      const showSummary = allowedSummaryKeys.has(phase.key);
                      const showPassive = allowedPassiveKeys.has(phase.key);
                      const isFirstMeanwhile = phase.key === firstMeanwhilePhaseKey;
                      const rowAttr = phase.kind === "prep" ? "prep" : phase.key;

                      return (
                        <li
                          key={phase.key}
                          data-phase-row={rowAttr}
                          data-phase-key={phase.key}
                          data-phase-kind={phase.kind}
                          data-flip-id={`phase:${phase.key}`}
                          className={`relative flex items-start gap-[calc(10*var(--cpx))] border-b border-ink/[.08] last:border-b-0 ${
                            tightFlow ? "py-[calc(2*var(--cpx))]" : "py-[calc(4*var(--cpx))]"
                          }`}
                        >
                          <span
                            data-phase-num
                            className="shrink-0 font-[family-name:var(--font-display)] font-normal text-ink [font-synthesis:none]"
                            style={{ width: px(24), fontSize: px(26), lineHeight: `${px(tightFlow ? 25 : 27)}px` }}
                          >
                            {phase.n}
                          </span>
                          <div className="min-w-0 flex-1 flex flex-col gap-[calc(2*var(--cpx))]">
                            <div className="flex items-baseline justify-between gap-[calc(10*var(--cpx))]">
                              <span
                                data-phase-title
                                className={stacked ? "min-w-0 font-semibold text-ink" : "min-w-0 truncate font-semibold text-ink"}
                                style={{ fontSize: px(24), lineHeight: `${px(tightFlow ? 25 : 27)}px` }}
                              >
                                {phase.title}
                              </span>
                              <span
                                data-phase-minutes
                                className="shrink-0 font-medium whitespace-nowrap text-ink-soft tabular-nums"
                                style={{ fontSize: px(22), lineHeight: `${px(tightFlow ? 25 : 26)}px` }}
                              >
                                {fmtMinutes(phase.minutes)}
                              </span>
                            </div>

                            {showSummary && (
                              <p
                                data-phase-summary
                                className={stacked ? "m-0 font-medium text-ink-soft" : "m-0 truncate font-medium text-ink-soft"}
                                style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                              >
                                {phase.summary}
                              </p>
                            )}

                            {phase.movable && (
                              <div
                                data-movable-prep={phase.movable.key}
                                data-flip-id="movable-prep"
                                data-sand=""
                                className={
                                  stacked
                                    ? "flex flex-wrap items-baseline justify-between gap-x-[calc(8*var(--cpx))] rounded-[var(--radius-1)] bg-sand px-[calc(10*var(--cpx))] py-[calc(2*var(--cpx))]"
                                    : "flex flex-nowrap items-baseline justify-between gap-[calc(8*var(--cpx))] overflow-hidden rounded-[var(--radius-1)] bg-sand px-[calc(10*var(--cpx))] py-[calc(2*var(--cpx))]"
                                }
                              >
                                <span
                                  className={stacked ? "min-w-0 font-semibold text-ink" : "min-w-0 flex-1 truncate font-semibold text-ink"}
                                  style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                                >
                                  {phase.movable.text}
                                </span>
                                <span
                                  className="shrink-0 font-medium whitespace-nowrap text-ink-soft"
                                  style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                                >
                                  {fmtMinutes(phase.movable.minutes)} · {phase.movable.hint}
                                </span>
                              </div>
                            )}

                            {showPassive && phase.passiveWindow && (
                              <div
                                data-passive-window=""
                                className={`${stacked ? "" : "truncate whitespace-nowrap "}rounded-[var(--radius-1)] border border-dashed border-ink/[.18] px-[calc(10*var(--cpx))] py-[calc(1*var(--cpx))] font-medium text-ink-soft`}
                                style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                              >
                                {phase.passiveWindow.label}
                              </div>
                            )}

                            {phase.meanwhile && (
                              <div
                                data-passive-window={phase.meanwhile.key}
                                className={
                                  stacked
                                    ? "flex flex-wrap items-baseline gap-x-[calc(8*var(--cpx))] gap-y-[calc(2*var(--cpx))]"
                                    : "flex flex-nowrap items-baseline gap-[calc(8*var(--cpx))] overflow-hidden"
                                }
                              >
                                {/* Portrait: one wrapping run of words in the sand, never cut. */}
                                <div
                                  data-movable-prep={phase.meanwhile.key}
                                  data-flip-id={isFirstMeanwhile ? "movable-prep" : phase.meanwhile.key}
                                  data-sand=""
                                  className={
                                    stacked
                                      ? "min-w-0 rounded-[var(--radius-1)] bg-sand px-[calc(10*var(--cpx))] py-[calc(2*var(--cpx))]"
                                      : "inline-flex min-w-0 items-baseline gap-[calc(6*var(--cpx))] overflow-hidden rounded-[var(--radius-1)] bg-sand px-[calc(10*var(--cpx))] py-[calc(2*var(--cpx))]"
                                  }
                                  style={stacked ? { fontSize: px(22), lineHeight: `${px(24)}px` } : undefined}
                                >
                                  <span
                                    className="shrink-0 font-semibold text-ink"
                                    style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                                  >
                                    Meanwhile ·
                                  </span>
                                  {stacked && " "}
                                  <span
                                    className={stacked ? "font-medium text-ink" : "min-w-0 truncate font-medium text-ink"}
                                    style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                                  >
                                    {phase.meanwhile.text}
                                  </span>
                                  {stacked && " "}
                                  <span
                                    className="shrink-0 font-medium whitespace-nowrap text-ink-soft tabular-nums"
                                    style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                                  >
                                    · {fmtMinutes(phase.meanwhile.minutes)}
                                  </span>
                                </div>
                                {phase.meanwhile.remainingLabel && !shed.has(`remaining:${phase.key}`) && (
                                  <span
                                    data-remaining-free
                                    className="shrink-0 font-medium whitespace-nowrap text-ink-soft"
                                    style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                                  >
                                    + {phase.meanwhile.remainingLabel}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Card markers for screen readers & geometry invariants */}
                          <div aria-hidden className="pointer-events-none absolute inset-0 flex">
                            {phase.kind === "prep" ? (
                              <span data-prep-card className="block h-full w-full" />
                            ) : (
                              pMarks.map((m) => (
                                <span
                                  key={m.key}
                                  data-card={m.key}
                                  data-card-kind={m.pot ? "pot" : "hands-on"}
                                  data-card-state={m.state}
                                  aria-label={`${cardName(m.label, !!m.pot, m.state)}. Read it`}
                                  className="block h-full flex-1"
                                />
                              ))
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                  )}
                </section>
              </div>
            </div>
          );
        })()}

        {/* LEVEL 2: Mid-cook Phase Outline (`!opening && wh`). */}
        {wh && !opening && linesDrawing && (
          <div
            ref={linesScrollRef}
            data-whole-lines
            data-lines-scroll
            // Where it scrolls, the box takes its own touches (the layer above it takes none): a finger
            // on a head, a break or a gap scrolls the list rather than falling through to the sheet.
            // Whether a press is a pull is the sheet's to say (`downOn`), which listens before React.
            className={`absolute ${linesScroll ? `pointer-events-auto overflow-x-hidden overflow-y-auto overscroll-contain [touch-action:pan-y] ${NO_SCROLLBAR}` : ""}`}
            style={{
              left: px(wh.chart.x),
              top: px(wh.chart.y),
              width: px(wh.chart.w),
              height: px(Math.max(120, wholeLinesBottom(ov) - wh.chart.y)),
              // The pull from the peek draws the lines part by part (`pull-paint`): the box shows through it.
              opacity: "var(--lines-op, 1)",
              maskImage: linesScroll ? linesMask : undefined,
              WebkitMaskImage: linesScroll ? linesMask : undefined,
            }}
          >
            <MealLines
              drawing={linesDrawing}
              c={c}
              readMark={readMark}
              tab={tab}
              onRead={(k) => {
                onRead(k);
              }}
            />
          </div>
        )}
        {wh && !opening && !linesDrawing && (() => {
          const whAvailCpx = Math.max(120, (onSheet?.growFrom ?? wh.chart.y + wh.chart.h) - wh.chart.y - 16);
          const tightWh = whAvailCpx < phases.length * 46;
          const showWhMeanwhile = whAvailCpx >= phases.length * (tightWh ? 32 : 44) + 30;

          return (
            <div
              data-phase-outline
              className={`absolute flex flex-col justify-center ${
                tightWh ? "gap-[calc(2*var(--cpx))]" : "gap-[calc(6*var(--cpx))]"
              }`}
              style={{
                left: px(wh.chart.x),
                top: px(wh.chart.y),
                width: px(wh.chart.w),
                height: px(whAvailCpx),
                opacity: wordsOp,
              }}
            >
              {phases.map((phase) => {
                const isDone = phase.state === "done";
                const isNow = phase.state === "now";
                const pMarks = phaseMarksMap.get(phase.key) ?? [];
                const isRead =
                  readMark !== null &&
                  (phase.kind === "prep" ? readMark === "prep" : pMarks.some((m) => m.key === readMark));
                const isFirstMeanwhile = phase.key === firstMeanwhilePhaseKey;
                const rowAttr = phase.kind === "prep" ? "prep" : phase.key;

                return (
                  <div
                    key={phase.key}
                    data-phase-row={rowAttr}
                    data-phase-key={phase.key}
                    data-phase-kind={phase.kind}
                    data-phase-state={phase.state}
                    data-read-ring={isRead ? "" : undefined}
                    data-flip-id={`phase:${phase.key}`}
                    className={`relative flex items-center justify-between gap-[calc(14*var(--cpx))] rounded-[var(--radius-1)] px-[calc(8*var(--cpx))] ${
                      tightWh ? "py-[calc(2*var(--cpx))]" : "py-[calc(5*var(--cpx))]"
                    } ${isRead ? "ring-2 ring-ink" : ""}`}
                  >
                    <span
                      data-phase-num
                      className={`shrink-0 font-[family-name:var(--font-display)] font-normal [font-synthesis:none] ${
                        isDone ? "text-ink-soft" : isNow ? "text-[color:var(--ember-700)]" : "text-ink"
                      }`}
                      style={{ width: px(28), fontSize: px(26), lineHeight: `${px(tightWh ? 26 : 28)}px` }}
                    >
                      {isDone ? "✓" : phase.n}
                    </span>

                    <div className="min-w-0 flex-1 flex flex-col gap-[calc(2*var(--cpx))]">
                      <span
                        data-phase-title
                        className={`truncate ${
                          isDone
                            ? "font-medium text-ink-soft"
                            : isNow
                              ? "font-semibold text-[color:var(--ember-700)]"
                              : "font-semibold text-ink"
                        }`}
                        style={{ fontSize: px(24), lineHeight: `${px(tightWh ? 26 : 28)}px` }}
                      >
                        {phase.title}
                      </span>

                      {isNow && showWhMeanwhile && phase.meanwhile && (
                        <div
                          data-passive-window={phase.meanwhile.key}
                          className="flex flex-nowrap items-baseline gap-[calc(8*var(--cpx))] overflow-hidden"
                        >
                          <span
                            data-movable-prep={phase.meanwhile.key}
                            data-flip-id={isFirstMeanwhile ? "movable-prep" : phase.meanwhile.key}
                            data-sand=""
                            className="inline-flex min-w-0 items-baseline gap-[calc(6*var(--cpx))] overflow-hidden rounded-full bg-sand px-[calc(10*var(--cpx))] py-[calc(2*var(--cpx))]"
                          >
                            <span
                              className="shrink-0 font-semibold text-ink"
                              style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                            >
                              Meanwhile ·
                            </span>
                            <span
                              className="min-w-0 truncate font-medium text-ink"
                              style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                            >
                              {phase.meanwhile.text}
                            </span>
                            <span
                              className="shrink-0 font-medium whitespace-nowrap text-ink-soft tabular-nums"
                              style={{ fontSize: px(22), lineHeight: `${px(24)}px` }}
                            >
                              · {fmtMinutes(phase.meanwhile.minutes)}
                            </span>
                          </span>
                        </div>
                      )}
                    </div>

                    <span
                      data-phase-status
                      className={`shrink-0 whitespace-nowrap tabular-nums ${
                        isDone
                          ? "font-medium text-ink-soft"
                          : isNow
                            ? "font-semibold text-[color:var(--ember-700)]"
                            : "font-medium text-ink-soft"
                      }`}
                      style={{ fontSize: px(22), lineHeight: `${px(tightWh ? 26 : 28)}px` }}
                    >
                      {isDone
                        ? "done"
                        : isNow
                          ? `${fmtMinutes(phase.remainingMinutes)} left`
                          : fmtMinutes(phase.minutes)}
                    </span>

                    <div className="pointer-events-none absolute inset-0 flex">
                      {phase.kind === "prep" ? (
                        <button
                          type="button"
                          data-prep-card
                          tabIndex={tab}
                          aria-label={`${prepMark ? prepWords(prepMark, false).aria : COOK_COPY.prepChapter}. Read it`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRead(readMark === "prep" ? null : "prep");
                          }}
                          className={`pointer-events-none h-full w-full cursor-pointer bg-transparent ${FOCUS}`}
                        />
                      ) : (
                        pMarks.map((m) => (
                          <button
                            key={m.key}
                            type="button"
                            data-card={m.key}
                            data-card-kind={m.pot ? "pot" : "hands-on"}
                            data-card-state={m.state}
                            tabIndex={tab}
                            aria-label={`${cardName(m.label, !!m.pot, m.state)}. Read it`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onRead(readMark === m.key ? null : m.key);
                            }}
                            className={`pointer-events-none h-full flex-1 cursor-pointer bg-transparent ${FOCUS}`}
                          />
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Level 2's header: back and the recipe's name; a read takes its place. */}
        {wh && !read && (
          <>
            <button
              type="button"
              data-overview-back
              tabIndex={tab}
              aria-label="Back to step"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              style={{ left: px(wh.back.x), top: px(wh.back.y), width: px(wh.back.w), height: px(wh.back.h), opacity: wordsOp }}
              className={`pointer-events-auto absolute z-[7] inline-flex cursor-pointer items-center justify-center rounded-full text-ink after:absolute after:-inset-x-[calc(16*var(--cpx))] after:-inset-y-[calc(12*var(--cpx))] active:bg-sand ${FOCUS}`}
            >
              <Chevron size={px(26)} />
            </button>
            <p
              data-whole-title
              className="absolute z-[7] m-0 font-semibold whitespace-nowrap text-ink"
              style={{ left: px(wh.title.x), top: px(wh.title.y), fontSize: px(24), lineHeight: `${px(28)}px`, opacity: wordsOp }}
            >
              {wh.title.text}
            </p>
          </>
        )}
        {wh && read && (
          <div
            data-read-step={read.key}
            onClick={(e) => e.stopPropagation()}
            className="pointer-events-auto absolute z-[7] rounded-[var(--radius-2)] bg-paper ring-1 ring-ink/[.11] ring-inset"
            style={{ left: px(read.box.x), top: px(read.box.y), width: px(read.box.w), height: px(read.box.h), opacity: wordsOp }}
          >
            <p
              role="button"
              tabIndex={tab}
              aria-label={readText ?? read.lines.join(" ")}
              onClick={(e) => {
                e.stopPropagation();
                onRead(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onRead(null);
                }
              }}
              className={`absolute m-0 cursor-pointer font-medium text-ink ${FOCUS}`}
              style={{ left: px(read.textX - read.box.x), top: px(read.textY - read.box.y), fontSize: px(read.size), lineHeight: 1.2 }}
            >
              {read.lines.map((ln, q) => (
                <span key={q} className="block whitespace-nowrap">
                  {q > 0 ? ` ${ln}` : ln}
                </span>
              ))}
            </p>
            {read.go && (
              <button
                type="button"
                data-go-to-step
                tabIndex={tab}
                onClick={(e) => {
                  e.stopPropagation();
                  if (read.key === "prep") {
                    // Prep's mark knows where Prep is: the Prep screen, or in "Prep first" the prep page with work left.
                    onGo(prepMark?.screen ?? 0);
                    return;
                  }
                  const mark = markOf(read.key);
                  if (mark) onGo(mark.screen);
                }}
                style={{ left: px(read.go.x - read.box.x), top: px(read.go.y - read.box.y), height: px(read.go.h) }}
                className="absolute inline-flex cursor-pointer items-center rounded-full bg-sand px-[calc(20*var(--cpx))] text-[length:var(--type-meta)] font-semibold whitespace-nowrap text-ink active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink"
              >
                {goLabel}
              </button>
            )}
            <button
              type="button"
              data-whole-recipe-ghost
              tabIndex={tab}
              onClick={(e) => {
                e.stopPropagation();
                onWhole();
              }}
              style={{ left: px(read.whole.x - read.box.x), top: px(read.whole.y - read.box.y), width: px(read.whole.w), height: px(read.whole.h) }}
              className="absolute inline-flex cursor-pointer items-center justify-center rounded-full border border-ink/[.14] bg-paper text-[length:var(--type-meta)] font-semibold whitespace-nowrap text-ink active:bg-sand focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {COOK_COPY.wholeRecipe}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A step as a screen reader hears it: "Garnish and serve, hands-on, in hand". */
function cardName(label: string, pot: boolean, state: string): string {
  const st = state === "in-hand" ? ", in hand" : state === "done" ? ", done" : state === "running" ? ", running" : "";
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}, ${pot ? "pot" : "hands-on"}${st}`;
}

function Chevron({ size, turn }: { size: number; turn?: "down" | "up" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ width: size, height: size, transform: turn === "down" ? "rotate(-90deg)" : turn === "up" ? "rotate(90deg)" : undefined }}
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}
