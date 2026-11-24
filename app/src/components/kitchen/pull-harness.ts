/**
 * The harness of the pull's tests: one cook at one screen shape, laid as the
 * page lays it (the sheet's layout with its peek, the whole cook's lines in
 * their box, and the pull's plan between them), over every stored meal the
 * layout tests use.
 */

import { strip } from "@/lib/kitchen/cook-strip";
import { initialCookState, next, screensOf, type CookState } from "@/lib/kitchen/cook-view";
import type { CookPlan } from "@/lib/kitchen/cook-plan";
import { buildTimetable } from "@/lib/kitchen/timetable-model";
import { advanceMeasure } from "@/lib/kitchen/__tests__/advance-measure";
import { timetableCorpus } from "@/lib/kitchen/__tests__/timetable-corpus";
import { loadKitchenPlans } from "@/lib/kitchen/__tests__/load-kitchen-plans";
import { buildLayout, type LayoutInput, type Measure, type SheetGeo, type SheetLayout } from "@/lib/kitchen/sheet-layout";
import { peekOf } from "@/lib/kitchen/cook-peek";
import { mealLines } from "@/lib/kitchen/meal-lines";
import { layoutMealLines, type LinesDrawing } from "@/lib/kitchen/meal-lines-layout";
import { linesBoxOf, planPull, type PullPlan } from "./pull-travel";

export const measure: Measure = (text, px, weight, family) => advanceMeasure(text, px, weight, family);

/** The three shapes: the tablet both ways, and a phone. */
export const SCREENS = [
  { name: "tablet 1280×800", W: 1280, H: 800 },
  { name: "tablet upright 800×1280", W: 800, H: 1280 },
  { name: "phone 390×844", W: 390, H: 844 },
];

function geoFor(W: number, H: number): SheetGeo {
  const c = Math.min(Math.max(W, H) / 960, Math.min(W, H) / 600);
  const top = 92 * c;
  return { W, H, c, E: 44 * c, top, stepTop: top + (H > W ? 58 : 12) * c, footTop: H - 100 * c, ledgeTop: H - 96 * c, portrait: H > W };
}

/** The sheet's input as CookSheet makes it (as `sheet-strip.test.ts` has it). */
function inputFor(plan: CookPlan, state: CookState, W: number, H: number): LayoutInput {
  const g = geoFor(W, H);
  const s = strip(plan, state, null);
  const mode = state.mode ?? "first";
  const first = mode === "first" ? s : strip(plan, initialCookState("first"), null);
  const go = mode === "go" ? s : strip(plan, initialCookState("go"), null);
  const keepH = 3 * 64 * 1.15 * g.c;
  return {
    strip: s,
    geo: g,
    step: { textH: keepH, keepH, fullH: keepH + 60 * g.c, inkW: g.W - 2 * g.E, restFit: 1, text: "Sear the beef" },
    nudge: null,
    read: null,
    opening: null,
    timetable: { t: buildTimetable(plan, first, go, mode)!, other: buildTimetable(plan, first, go, mode === "first" ? "go" : "first", { now: 0 })! },
    title: "Sunday roast dinner",
    chrome: { more: { w: 56 * g.c, h: 56 * g.c }, controls: null, hint: false },
    measure,
    tasks: new Map(plan.tasks.map((x) => [x.id, x])),
    peek: peekOf(plan, state, s),
    lineBox: { x0: g.E + 88 * g.c, x1: g.W - g.E - 88 * g.c, y: g.footTop + 50 * g.c },
  };
}

export interface Laid {
  L: SheetLayout;
  lines: LinesDrawing;
  plan: PullPlan;
  /** How far the lines stand scrolled when the whole cook opens: the step in hand a third down its box. */
  scroll: number;
}

/** The peek and the whole cook of one cook at one shape, and the pull between them, as the page lays them. */
export function laid(plan: CookPlan, state: CookState, W: number, H: number): Laid {
  const L = buildLayout(inputFor(plan, state, W, H));
  const ov = L.overview!;
  const c = L.geo.c;
  // `Timetable`'s room for the lines: the chart's corner, down to 14 cpx over the foot (`wholeLinesBottom`).
  const box = linesBoxOf(ov, (ov.sheetBottom - ov.Y2) / c - 14)!;
  const lines = layoutMealLines(mealLines(plan, strip(plan, state, null)), { W: ov.whole!.chart.w * c, H: box.h, c, narrow: L.geo.portrait }, measure);
  const pull = planPull({ peek: L.peek!, lines, c, Y1: L.detents[1], Y2: L.detents[2], box });
  const scroll = lines.scroll && lines.nowY !== null ? Math.min(Math.max(0, lines.height - box.h), Math.max(0, lines.nowY - box.h / 3)) : 0;
  return { L, lines, plan: pull, scroll };
}

export const at = (p: CookPlan, pos: number, mode: "first" | "go" = "first") => {
  let s = initialCookState(mode);
  for (let i = 0; i < pos; i++) s = next(p, s);
  return s;
};
export const screens = (p: CookPlan, mode: "first" | "go" = "first") => screensOf(p, mode, new Set()).length;

export const corpus = timetableCorpus();
export const roast = corpus.find((c) => c.name === "sunday-roast-dinner")!.plan;
/** Every stored meal the layout tests use: the derived corpus and the kitchen's plans. */
export const MEALS = [...corpus, ...loadKitchenPlans().map((k) => ({ name: k.name, plan: k.plan }))];
/** Where to stand in each: the first screen, a third of the way, two thirds, and the last but one. */
export const stands = (p: CookPlan) => {
  const n = screens(p);
  return [...new Set([0, Math.floor(n / 3), Math.floor((2 * n) / 3), Math.max(0, n - 2)])];
};

