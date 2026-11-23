/**
 * Where the whole cook stands on the screen: the timetable (DECISIONS
 * 2026-10-20, "Whole-cook overview: the timetable"), on the opening and at the
 * cook sheet's level 2, with the chrome round it.
 *
 * `timetable-layout.ts` places everything in counter px (its build contract is
 * `design/overview-arc/r3/SPEC.md` §6–10); this module feeds it the sheet's
 * measured chrome and hands the sheet back the parts it draws itself (time to
 * the table, the ghost "Whole recipe", More, the opening's controls, the voice
 * hint) in px from the sheet's edge at the whole cook (`Y2`).
 *
 * - **The opening:** the title with the controls and More beside it, the
 *   Prep first | As I go toggle with both totals on its own row, the
 *   timetable centred in its room, Ahead and Get out at the foot (SPEC §6).
 * - **Level 2:** a Paper sheet from 18 cpx, its header (back, the recipe's
 *   name, Whole recipe, time to the table, More), the toggle on Prep, and the
 *   timetable bottom-anchored over the foot (SPEC §10). A read replaces the
 *   header, so the timetable never moves under the finger.
 */

import { COOK_COPY } from "./cook-view";
import type { SheetGeo } from "./sheet-layout";
import {
  layoutOpening,
  layoutTimetable,
  layoutWholeCook,
  timetableFloorHeight,
  type GetOutItem,
  type Measure as CpxMeasure,
  type OpeningLayout,
  type TimetableDrawing,
  type WholeCookLayout,
} from "./timetable-layout";
import type { Timetable } from "./timetable-model";

/** The sheet's text measure: px in, px out. */
type PxMeasure = (text: string, px: number, weight: number, family?: "text" | "display") => number;

/** The live chrome the sheet hosts, as measured on screen (px). */
export interface OverviewChrome {
  /** More ("···"), the top line's menu. */
  more: { w: number; h: number };
  /** The opening's controls (voice dot, well, Start), as one group; null when not the opening. */
  controls: { w: number; h: number } | null;
  /** The voice hint ("Say 'Sue, back'") shows at the whole cook. */
  hint: boolean;
}

export interface OverviewPlaceInput {
  /** This prep mode's timetable and the other's (both share one minute scale). */
  timetable: Timetable;
  other: Timetable;
  geo: SheetGeo;
  measure: PxMeasure;
  chrome: OverviewChrome;
  /** The Prep first | As I go toggle shows: a plan with mise, on the opening or on Prep. */
  toggle: boolean;
  /** The recipe's name: the opening's title, level 2's header. */
  title: string;
  /** The opening: what to get out, "for 8" when scaled, and the hands-on minutes. Null at level 2. */
  opening: { getOut: GetOutItem[]; scaleNote: string | null; handsOn?: string | null } | null;
  /** What is read in the header: the words, and whether it has a Go (and which). */
  read: { key: string; text: string; go: "step" | "prep" | null } | null;
  /** Keep the top line at the whole cook (N3-4(f)'s alternative); default: it gives way. */
  topLine: boolean;
  /** Time to the table's dims at its three sizes (30 / 40 / 48), px. */
  ttDims: readonly { w: number; h: number }[];
}

export interface OverviewPlace {
  /** The sheet's edge at the whole cook, on screen. */
  Y2: number;
  /** The sheet's bottom at the whole cook, on screen. */
  sheetBottom: number;
  /** One counter px: the drawing and the frames below are in cpx from `Y2`. */
  c: number;
  timetable: Timetable;
  drawing: TimetableDrawing;
  opening: OpeningLayout | null;
  whole: WholeCookLayout | null;
  /** The read in the header (level 2), with its key. */
  read: { key: string; go: "step" | "prep" | null } | null;
  /** Time to the table at level 2: its size rung and place, px; op 0 under a read or on the opening. */
  tt: { x: number; top: number; z: number; op: number };
  /** The ghost "Whole recipe" in the header, px (level 2, no read). */
  ghost: { x: number; y: number; w: number; h: number } | null;
  more: { x: number; y: number };
  /** The opening's controls' top-left, px. */
  controls: { x: number; y: number } | null;
  hint: { x: number; y: number; align: "left" | "right" } | null;
}

/** A tap target's height, px (the Go pill and the ghost). */
const BTN_H = 48;
/**
 * The timetable's content box stands 35 cpx in from each side, as the r3 mock
 * draws it (SPEC §6 "the content box"), not at the cook view's 44 cpx edge:
 * the 18 cpx it gives back is what lets the roast's "carve" sit inside its
 * block and its last pots keep their captions (DECISIONS 2026-10-20, T2).
 */
export const SIDE = 35;
/** Time to the table in level 2's header: the 40 rung, as on the plate (SPEC §10). */
const TT_RUNG = 1;

export function placeOverview(input: OverviewPlaceInput): OverviewPlace {
  const { geo: g, measure, chrome } = input;
  const c = g.c;
  const m: CpxMeasure = (text, size, weight, family = "text") => measure(text, size * c, weight, family) / c;
  const t = input.timetable;
  const toggle = input.toggle ? { mode: t.mode, first: t.mode === "first" ? t.total : input.other.total, go: t.mode === "go" ? t.total : input.other.total } : null;
  const W = g.W / c;
  const H = g.H / c;
  const side = SIDE;

  if (input.opening) {
    const opening = layoutOpening({
      W,
      H,
      portrait: g.portrait,
      side,
      title: input.title,
      controls: chrome.controls ? { w: chrome.controls.w / c, h: chrome.controls.h / c } : { w: 0, h: 0 },
      more: { w: chrome.more.w / c, h: chrome.more.h / c },
      toggle,
      ahead: t.ahead.map((a) => ({ name: a.name, lead: a.lead })),
      getOut: input.opening.getOut,
      scaleNote: input.opening.scaleNote,
      handsOn: input.opening.handsOn ?? null,
      chartFloor: timetableFloorHeight(t, g.portrait, m),
      measure: m,
    });
    const drawing = layoutTimetable(t, input.other, opening.chart, { portrait: g.portrait, measure: m, now: false, anchor: "center", ground: "ground" });
    return {
      Y2: 0,
      sheetBottom: g.H,
      c,
      timetable: t,
      drawing,
      opening,
      whole: null,
      read: null,
      tt: { x: g.W - g.E - input.ttDims[TT_RUNG].w, top: 0, z: TT_RUNG, op: 0 },
      ghost: null,
      more: { x: opening.more.x * c, y: opening.more.y * c },
      controls: chrome.controls ? { x: opening.controls.x * c, y: opening.controls.y * c } : null,
      hint: null,
    };
  }

  // ---- Level 2: the top line gives way (or stays, `topLine`), the foot stays ----
  const Y2 = input.topLine ? g.top : 0;
  const sheetBottom = g.footTop;
  const btnH = BTN_H / c;
  const read = input.read;
  const goLabel = read?.go === "prep" ? COOK_COPY.goToPrep : COOK_COPY.goToStep;
  const td = input.ttDims[TT_RUNG];
  const whole = layoutWholeCook({
    W,
    footTop: (g.footTop - Y2) / c,
    portrait: g.portrait,
    side,
    title: input.title,
    tt: { w: td.w / c, h: td.h / c },
    more: { w: chrome.more.w / c, h: chrome.more.h / c },
    ghost: { w: m(COOK_COPY.wholeRecipe, 22, 600) + 24, h: btnH },
    toggle,
    read: read ? { text: read.text, go: read.go ? { w: m(goLabel, 22, 600) + 40 } : null } : null,
    hint: chrome.hint ? { w: m(COOK_COPY.saySueBack, 22, 500) } : null,
    btnH,
    measure: m,
  });
  const drawing = layoutTimetable(t, input.other, whole.chart, { portrait: g.portrait, measure: m, now: true, anchor: "bottom", ground: "paper" });
  return {
    Y2,
    sheetBottom,
    c,
    timetable: t,
    drawing,
    opening: null,
    whole,
    read: read ? { key: read.key, go: read.go } : null,
    tt: { x: whole.tt.x * c, top: whole.tt.y * c, z: TT_RUNG, op: whole.tt.op },
    ghost: whole.ghost ? { x: whole.ghost.x * c, y: whole.ghost.y * c, w: whole.ghost.w * c, h: whole.ghost.h * c } : null,
    more: { x: whole.more.x * c, y: whole.more.y * c },
    controls: null,
    hint: whole.hint ? { x: whole.hint.x * c, y: whole.hint.y * c, align: "left" } : null,
  };
}
