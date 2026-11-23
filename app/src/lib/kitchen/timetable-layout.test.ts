import { describe, expect, it } from "vitest";
import { SIDE } from "./overview-place";
import { COOK_PLAN_VERSION, type CookPlan, type CookTask, type PrepMode } from "./cook-plan";
import { strip } from "./cook-strip";
import { initialCookState } from "./cook-view";
import {
  fmtMinutes,
  fmtTotal,
  hitTimetable,
  laneMargin,
  layoutOpening,
  layoutTimetable,
  layoutWholeCook,
  givesWay,
  nowOn,
  rowsOfTime,
  soonerLabelX,
  soonerMinutes,
  timetableFloorHeight,
  type Rect,
  type TimetableDrawing,
  type TWord,
} from "./timetable-layout";
import { buildTimetable, drawnMinutes, type Timetable } from "./timetable-model";
import { advanceMeasure as measure } from "./__tests__/advance-measure";
import { loadKitchenPlans } from "./__tests__/load-kitchen-plans";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "./__tests__/load-cook-plan-fixtures";
import { parseCookPlan } from "./cook-plan";
import { timetableCorpus } from "./__tests__/timetable-corpus";
import { recipeTimes, shownTimes } from "./recipe-times";
import { handsOnWords } from "./time-line";

const MODES: PrepMode[] = ["first", "go"];

function both(plan: CookPlan, options?: { now?: number }): Record<PrepMode, Timetable> {
  const first = strip(plan, initialCookState("first"), null, 0);
  const go = strip(plan, initialCookState("go"), null, 0);
  const a = buildTimetable(plan, first, go, "first", options);
  const b = buildTimetable(plan, first, go, "go", options);
  if (!a || !b) throw new Error("expected a timetable");
  return { first: a, go: b };
}

function kitchenPlan(name: string): CookPlan {
  const f = loadKitchenPlans().find((k) => k.name === name);
  if (!f) throw new Error(`no kitchen plan ${name}`);
  return f.plan;
}

function corpusPlan(name: string): CookPlan {
  const fixture = loadCookPlanFixtures().find((f) => f.name === name);
  const raw = loadCookPlanSnapshots().get(name)?.raw;
  if (!fixture || !raw) throw new Error(`no corpus plan ${name}`);
  const parsed = parseCookPlan(raw, fixture.recipe);
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return parsed.plan;
}

const roastPlan = () => corpusPlan("sunday-roast-dinner");

let counter = 0;
function task(t: Partial<CookTask> & { label: string }): CookTask {
  return {
    id: t.id ?? `t${counter++}`,
    kind: "cook",
    text: t.label,
    ingredientIdx: [],
    sourceStep: null,
    implied: true,
    needs: [],
    branch: "Main",
    ...t,
  };
}
const min = (est: number, handsOff = false) => ({ minutes: { est, handsOff } });
const plan = (tasks: CookTask[]): CookPlan => ({ version: COOK_PLAN_VERSION, tasks });

/** The three screens the fit gate holds, in counter px (cpx = min(max/960, min/600)). */
const VIEWS = [
  { name: "1280×800", W: 960, H: 600, portrait: false },
  { name: "1280×680", W: 1280 / (680 / 600), H: 600, portrait: false },
  { name: "800×1280", W: 600, H: 960, portrait: true },
] as const;
type View = (typeof VIEWS)[number];

/** The mock's own opening frame: a 35 cpx side, Start as the only control. */
const MOCK_CHROME = { side: 35, controls: { w: measure("Start", 30, 600) + 84, h: 64 }, more: { w: 0, h: 0 } };
/** The app's: the same 35 cpx side (`overview-place.ts` SIDE), the controls group and More beside it. */
const APP_CHROME = { side: SIDE, controls: { w: 150, h: 60 }, more: { w: 40, h: 40 } };

function opening(
  tt: Record<PrepMode, Timetable>,
  mode: PrepMode,
  v: View,
  chrome = APP_CHROME,
  getOut = 12,
  title = "A weeknight dinner of several parts",
  handsOn: string | null = null,
) {
  const t = tt[mode];
  const lay = layoutOpening({
    W: v.W,
    H: v.H,
    portrait: v.portrait,
    side: chrome.side,
    title,
    controls: chrome.controls,
    more: chrome.more,
    toggle: tt.first.total !== tt.go.total || tt.first.prep ? { mode, first: tt.first.total, go: tt.go.total } : null,
    ahead: t.ahead.map((a) => ({ name: a.name, lead: a.lead })),
    getOut: Array.from({ length: getOut }, (_, i) => ({ index: i, amount: `${i + 1} tbsp`, name: `ingredient number ${i + 1}, chopped` })),
    scaleNote: null,
    handsOn,
    chartFloor: timetableFloorHeight(t, v.portrait, measure),
    measure,
  });
  const d = layoutTimetable(t, tt[mode === "first" ? "go" : "first"], lay.chart, { portrait: v.portrait, measure, now: false, anchor: "center", ground: "ground" });
  return { lay, d };
}

function wholeCook(tt: Record<PrepMode, Timetable>, mode: PrepMode, v: View, extra: Partial<Parameters<typeof layoutWholeCook>[0]> = {}) {
  const t = tt[mode];
  const lay = layoutWholeCook({
    W: v.W,
    footTop: v.H - 96,
    portrait: v.portrait,
    side: SIDE,
    title: "A weeknight dinner",
    tt: { w: 120, h: 72 },
    more: { w: 40, h: 40 },
    ghost: { w: measure("Whole recipe", 22, 600) + 24, h: 36 },
    toggle: null,
    read: null,
    hint: null,
    btnH: 36,
    measure,
    ...extra,
  });
  const d = layoutTimetable(t, tt[mode === "first" ? "go" : "first"], lay.chart, { portrait: v.portrait, measure, now: true, anchor: "bottom", ground: "paper" });
  return { lay, d };
}

/** A word's box on screen (an upright word turns about its centre). */
function wordBox(w: TWord): Rect {
  if (w.rot !== -90) return w;
  const cx = w.x + w.w / 2;
  const cy = w.y + w.h / 2;
  return { x: cx - w.h / 2, y: cy - w.w / 2, w: w.h, h: w.w };
}
const overlap = (a: Rect, b: Rect, slack = 0.5) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > slack && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > slack;

/** What breaks the layout's rules (SPEC §6–8), in words; empty when it holds. */
function breaches(d: TimetableDrawing, t: Timetable, screen: { W: number; H: number }, box: Rect): string[] {
  const out: string[] = [];
  const words = d.words;
  for (const w of words) {
    if (w.size < 22) out.push(`${w.k} "${w.lines.join(" ")}" is set at ${w.size} cpx`);
    const b = wordBox(w);
    if (b.x < -0.5 || b.y < -0.5 || b.x + b.w > screen.W + 0.5 || b.y + b.h > screen.H + 0.5) out.push(`${w.k} runs off the screen`);
    if (b.x < box.x - 0.5 || b.x + b.w > box.x + box.w + 0.5) out.push(`${w.k} "${w.lines.join(" ")}" runs out of the chart's width`);
  }
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      if (overlap(wordBox(words[i]), wordBox(words[j]))) out.push(`${words[i].k} "${words[i].lines.join(" ")}" overlaps ${words[j].k} "${words[j].lines.join(" ")}"`);
    }
  }
  // A word stands on a block only when it is that block's own label inside it (or Prep's on Prep).
  for (const m of d.marks) {
    if (m.role !== "block" && m.role !== "prep" && m.role !== "pot-line" && m.role !== "break") continue;
    for (const w of words) {
      if (!overlap(wordBox(w), m, 1)) continue;
      if (m.role === "block" && w.role === "block-label" && w.block === m.block && w.how !== "after") continue;
      if (m.role === "prep" && (w.role === "prep-label" || w.role === "prep-min")) continue;
      out.push(`${w.k} "${w.lines.join(" ")}" stands on ${m.role} ${m.k}`);
    }
  }
  // Blocks never overlap each other on a lane.
  const blocks = d.marks.filter((m) => m.role === "block");
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) if (overlap(blocks[i], blocks[j], 1)) out.push(`${blocks[i].k} overlaps ${blocks[j].k}`);
  // Every chapter head is one line, numeral first.
  for (const c of t.chapters) {
    if (!words.some((w) => w.k === `chn:${c.n}`)) out.push(`chapter ${c.n} has no head`);
    const name = words.find((w) => w.k === `chname:${c.n}`);
    if (name && name.lines.length !== 1) out.push(`chapter ${c.n}'s head runs to ${name.lines.length} lines`);
  }
  // Every block is named or drawn as a touch.
  for (const m of blocks) {
    if (m.low) continue;
    if (!words.some((w) => w.role === "block-label" && w.block === m.block)) out.push(`${m.k} is drawn full and named nowhere`);
  }
  if (!d.fits) out.push(`the lanes don't fit: row pitch ${d.R.toFixed(1)}, block ${d.blockH}`);
  // Nothing on a lane reaches into another: its blocks, lines, marks, labels and name stay in its band.
  const bands = d.hits;
  const inBand = (r: Rect, what: string) => {
    const cy = r.y + r.h / 2;
    const band = bands.find((b) => cy >= b.top && cy < b.top + b.h);
    if (!band) return;
    if (r.y < band.top - 0.5 || r.y + r.h > band.top + band.h + 0.5) out.push(`${what} leaves lane ${band.lane}'s band`);
  };
  for (const m of d.marks) if (m.role === "block" || m.role === "pot-line" || m.role === "break") inBand(m, m.k);
  for (const w of words) if (w.role === "block-label" || w.role === "pot-caption" || w.role === "lane") inBand(wordBox(w), `${w.k} "${w.lines.join(" ")}"`);
  return out;
}

describe("minutes", () => {
  it("read as minutes under an hour, then hours and two-digit minutes", () => {
    expect([fmtMinutes(18), fmtMinutes(60), fmtMinutes(85), fmtMinutes(133)]).toEqual(["18 min", "1 h", "1 h 25", "2 h 13"]);
  });
});

describe("rows of time (SPEC §6)", () => {
  it("are one in landscape and two in portrait, cut at the chapter start that keeps the longer row shortest", () => {
    const t = both(corpusPlan("sunday-roast-dinner")).first;
    expect(rowsOfTime(t, false)).toEqual([{ t0: 0, t1: t.total }]);
    const rows = rowsOfTime(t, true);
    expect(rows).toHaveLength(2);
    expect(t.chapters.map((c) => c.start)).toContain(rows[0].t1);
    expect(rows[1]).toEqual({ t0: rows[0].t1, t1: t.total });
  });

  it("wrap a one-chapter cook onto one row even in portrait", () => {
    const t = both(plan([task({ label: "toss salad", ...min(6) })])).first;
    expect(t.chapters).toHaveLength(1);
    expect(rowsOfTime(t, true)).toHaveLength(1);
  });
});

describe("the label rule (SPEC §7)", () => {
  const v = VIEWS[0];

  it("names a block inside it when it fits, on two lines where the lanes are tall", () => {
    const { d } = opening(both(kitchenPlan("skillet-eggs-potatoes-greens")), "first", v, MOCK_CHROME, 8);
    const labels = d.words.filter((w) => w.role === "block-label").map((w) => [w.lines.join(" "), w.how]);
    // the mock's skillet: "wilt greens" and "cook eggs", each two lines in its block
    expect(labels).toEqual([
      ["wilt greens", "in2"],
      ["cook eggs", "in2"],
    ]);
  });

  it("names a block after it on its own lane when it doesn't fit inside, never above or to its left", () => {
    const { d } = opening(both(corpusPlan("sunday-roast-dinner")), "first", v, MOCK_CHROME, 16);
    const label = (s: string) => d.words.find((w) => w.role === "block-label" && w.lines.join(" ") === s);
    // the mock's roast: "stuff", "rough" and "deglaze" after their blocks, "carve" inside its own
    for (const s of ["stuff", "rough", "deglaze"]) {
      const w = label(s)!;
      expect(w, s).toBeDefined();
      expect(w.how).toBe("after");
      const blk = d.marks.find((m) => m.role === "block" && m.block === w.block)!;
      expect(w.x).toBeGreaterThanOrEqual(blk.x + blk.w);
      // centred on its block, give or take the mock's 1 cpx optical nudge
      expect(Math.abs(w.y + w.h / 2 - (blk.y + blk.h / 2))).toBeLessThanOrEqual(1.5);
    }
    expect(label("carve")!.how).toBe("in");
  });

  it("captions pot lines inside, else after, never one that names a chapter in full", () => {
    const { d } = opening(both(corpusPlan("sunday-roast-dinner")), "first", v, MOCK_CHROME, 16);
    const caps = d.words.filter((w) => w.role === "pot-caption").map((w) => w.lines[0]);
    expect(caps.sort()).toEqual(["cooks", "crisps", "rests", "simmers"]);
  });

  it("draws a block it can't name low, as a touch (pita's drain and slice tomatoes in landscape)", () => {
    const { d } = opening(both(kitchenPlan("chicken-pita-wraps")), "first", v, MOCK_CHROME, 37);
    expect(d.demoted.sort()).toEqual(["Assembly: slice tomatoes", "Hummus: drain"]);
    for (const m of d.marks.filter((x) => x.role === "block" && x.low)) expect(m.h).toBe(Math.round(d.blockH * 0.42));
  });

  it("keeps a gutter past the serve line for a block that ends there and can't hold its name (pita's assemble)", () => {
    const { d } = opening(both(kitchenPlan("chicken-pita-wraps")), "first", v, MOCK_CHROME, 37);
    expect(d.gutter).toBeCloseTo(measure("assemble", 24, 600) + 16, 6);
    const serve = d.marks.find((m) => m.role === "serve")!;
    const w = d.words.find((x) => x.role === "block-label" && x.lines[0] === "assemble")!;
    expect(w.x).toBeGreaterThan(serve.x + serve.w);
  });

  it("sets a narrow tall portrait Prep upright (pita, portrait)", () => {
    const { d } = opening(both(kitchenPlan("chicken-pita-wraps")), "first", VIEWS[2], MOCK_CHROME, 37);
    const prep = d.words.find((w) => w.k === "prep:t")!;
    expect(prep.rot).toBe(-90);
    expect(prep.lines).toEqual(["Prep"]);
  });
});

describe("the chapter-head rule (SPEC §8)", () => {
  it("reads numeral, name and minutes where there's room, and drops the minutes, then words, where there isn't", () => {
    const tt = both(corpusPlan("sunday-roast-dinner"));
    const { d } = opening(tt, "first", VIEWS[0], MOCK_CHROME, 16);
    const head = (n: number) => d.words.filter((w) => w.k.endsWith(`:${n}`) && w.k.startsWith("ch")).map((w) => w.lines[0]);
    // the mock's roast: "1 Prep" (its minutes don't fit before chapter 2), "2 Chicken roasts 1 h 25", "3 Finish and plate"
    expect(head(1)).toEqual(["1", "Prep"]);
    expect(head(2)).toEqual(["2", "Chicken roasts", "1 h 25"]);
    expect(head(3)).toEqual(["3", "Finish and plate"]);
  });

  it("captions a wait's pot on its own line when its head falls to the numeral", () => {
    const tt = both(kitchenPlan("chicken-pita-wraps"));
    const { d } = opening(tt, "first", VIEWS[2], MOCK_CHROME, 37);
    // portrait pita: chapter 1 (Prep) is the numeral alone; Prep's own block names it
    expect(d.words.some((w) => w.k === "chname:1")).toBe(false);
    expect(d.words.find((w) => w.k === "prep:t")).toBeDefined();
  });
});

describe("done and now (SPEC §9)", () => {
  const roast = () => corpusPlan("sunday-roast-dinner");

  it("fills the passed track in Ink and steps the marks above it back", () => {
    const tt = both(roast(), { now: 70 });
    const { d } = wholeCook(tt, "first", VIEWS[0]);
    const fill = d.marks.find((m) => m.k === "trkf")!;
    const now = d.marks.find((m) => m.role === "now")!;
    expect(fill.x + fill.w).toBeCloseTo(now.x + 1.5, 6);
    expect(d.marks.find((m) => m.role === "prep")!.op).toBe(0.35);
    expect(now.tone).toBe("ember");
    expect(now.op).toBe(1);
  });

  it("says how much of a long wait is left beside now when now is inside it", () => {
    const tt = both(roast(), { now: 70 });
    const { d } = wholeCook(tt, "first", VIEWS[0]);
    expect(tt.first.nowBreak).not.toBeNull();
    expect(d.words.find((w) => w.k === "nowt")!.lines).toEqual(["now"]);
    expect(d.words.find((w) => w.k === "nowl")!.lines).toEqual([fmtMinutes(tt.first.nowBreak!.left)]);
    // the break's own "50 min free" gives way to it
    expect(d.words.some((w) => w.role === "break-minutes")).toBe(false);
  });

  it("holds now at the serve line past the total, the whole track filled, the note inside the chart", () => {
    const tt = both(roast(), { now: 10_000 });
    const { d, lay } = wholeCook(tt, "first", VIEWS[0]);
    const serve = d.marks.find((m) => m.role === "serve")!;
    const now = d.marks.find((m) => m.role === "now")!;
    expect(now.x + 1.5).toBeCloseTo(serve.x + 1.5, 6);
    const trk = d.marks.find((m) => m.k === "trk")!;
    expect(d.marks.find((m) => m.k === "trkf")!.w).toBeCloseTo(trk.w, 6);
    // the note stays right of the line while it fits inside the chart (roast's right gutter holds it), else flips left
    const word = d.words.find((w) => w.k === "nowt")!;
    const right = now.x + 1.5 + 10 + word.w <= lay.chart.x + lay.chart.w - 4;
    if (right) expect(word.x).toBeGreaterThan(now.x);
    else expect(word.x + word.w).toBeLessThan(now.x);
    expect(word.x + word.w).toBeLessThanOrEqual(lay.chart.x + lay.chart.w);
    for (const m of d.marks.filter((x) => x.role === "block")) expect(m.op).toBe(0.35);
  });

  it("places now on a drawing held from another minute where a drawing laid at that minute puts it (T3 follow-up)", () => {
    // Level 2 holds its drawing at rest; its now line, the track's fill and the now words follow the
    // clock on it (`nowOn`), so leaving the level and laying it out again moves none of them.
    let checked = 0;
    for (const { name, plan: p } of timetableCorpus()) {
      for (const v of VIEWS) {
        const held = wholeCook(both(p, { now: 0 }), "first", v).d;
        expect(held.clock, `${name}, ${v.name}: level 2 has a clock`).not.toBeNull();
        const total = both(p).first.total;
        // Every minute through a break (its minutes left count), else about forty minutes across the cook.
        const step = Math.max(1, Math.floor(total / 40));
        const nows = new Set<number>();
        for (let now = 0; now <= total + 3; now += step) nows.add(now);
        for (const b of both(p).first.breaks) for (let now = Math.floor(b.start) - 1; now <= b.end + 1; now++) nows.add(now);
        for (const now of nows) {
          const d = wholeCook(both(p, { now }), "first", v).d;
          expect(d.clock!.rows, `${name}, ${v.name} at ${now}: one axis`).toEqual(held.clock!.rows);
          const at = nowOn(held.clock!, now);
          const where = `${name}, ${v.name} at ${now}`;
          const nowMark = d.marks.find((m) => m.role === "now")!;
          expect({ x: at.mark.x, y: at.mark.y, h: at.mark.h }, `${where}: the line`).toEqual({ x: nowMark.x, y: nowMark.y, h: nowMark.h });
          for (const f of d.marks.filter((m) => m.role === "track-fill")) expect(at.fills.get(f.k), `${where}: ${f.k}`).toBeCloseTo(f.w, 9);
          const word = d.words.find((w) => w.k === "nowt")!;
          expect(at.word, `${where}: "now"`).toEqual({ x: word.x, y: word.y });
          const left = d.words.find((w) => w.k === "nowl");
          const free = d.words.find((w) => w.k === "nowf");
          if (left && free) {
            expect(at.left, `${where}: minutes left`).toEqual({ text: left.lines[0], x: left.x, y: left.y, w: left.w, freeX: free.x, freeY: free.y });
          } else expect(at.left, `${where}: no minutes left`).toBeNull();
          // What gives way to now, read off the fresh drawing's own geometry (SPEC §9), not `givesWay`:
          // only a word on now's row, a tick under now's words or a break's minutes within 150 of the
          // line or crossing now's words.
          const aside = (w: TWord) => w.role === "tick" || w.role === "break-minutes" || w.role === "break-free";
          const nowTrack = nowMark.y + nowMark.h;
          const onNowRow = (w: TWord) => w.y > nowTrack && w.y <= nowTrack + 20;
          const nowWordsDrawn = d.words.filter((w) => w.k === "nowt" || w.k === "nowl" || w.k === "nowf");
          const span = [Math.min(...nowWordsDrawn.map((w) => w.x)), Math.max(...nowWordsDrawn.map((w) => w.x + w.w))];
          const breakAt = (w: TWord) => {
            const m = d.marks.find((k) => k.k === `brk:${/^brk:(\d+)/.exec(w.k)![1]}:track` && k.y < w.y && w.y - k.y < 40)!;
            return m.x + 10;
          };
          const crosses = (w: TWord) => w.x + w.w > span[0] - 20 && w.x < span[1] + 20;
          const yields = (w: TWord) =>
            onNowRow(w) &&
            (w.role === "tick" ? crosses(w) : Math.abs(breakAt(w) - (nowMark.x + 1.5)) < 150 || crosses(w));
          const laid = [...d.words, ...d.gaveWay].filter(aside);
          expect(d.gaveWay.map((w) => w.k).sort(), `${where}: what gives way to now`).toEqual(laid.filter(yields).map((w) => w.k).sort());
          // The held drawing gives way to now at this minute as the fresh one does.
          const shown = [...held.words, ...held.gaveWay].filter((w) => aside(w) && !givesWay(held.clock!, at, w)).map((w) => w.k);
          expect(shown.sort(), `${where}: what the held drawing shows`).toEqual(d.words.filter(aside).map((w) => w.k).sort());
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
    // Over 3,000 fresh layouts: about 2 s alone, past vitest's 5 s default under the full parallel suite.
  }, 30_000);

  it("draws no now and no done on the opening", () => {
    const { d } = opening(both(roast()), "first", VIEWS[0]);
    expect(d.marks.some((m) => m.role === "now")).toBe(false);
    expect(d.marks.find((m) => m.k === "trkf")!.w).toBe(0);
    expect(d.words.find((w) => w.k === "total")!.lines).toEqual(["2 h 15"]);
  });
});

describe("the sooner ghost's words (SPEC §11)", () => {
  it("stand between the old serve line and the new, else past the old, else before the new: never on the new line", () => {
    const on = (x: number, w: number, line: number) => x < line + 12 && x + w > line - 12;
    // room between
    expect(soonerLabelX(800, 600, 120, 925)).toBe(640);
    // too close: past the old line, inside the chart
    const past = soonerLabelX(800, 760, 120, 960);
    expect(past).toBe(812);
    // too close and no room past the old line: before the new one
    const before = soonerLabelX(900, 860, 120, 925);
    expect(before + 120).toBe(848);
    for (const [o, n] of [
      [800, 600],
      [800, 760],
      [900, 860],
      [905, 899],
    ]) {
      expect(on(soonerLabelX(o, n, 120, 925), 120, n), `${o} → ${n}`).toBe(false);
    }
  });
});

describe("one total, one rounding (DS §5, the time line)", () => {
  it("rounds a total up to 5 minutes, as the kitchen's row says it", () => {
    expect([fmtTotal(133), fmtTotal(115), fmtTotal(41), fmtTotal(45), fmtTotal(60.0004)]).toEqual(["2 h 15", "1 h 55", "45 min", "45 min", "1 h"]);
  });

  it("says the same total at the serve line, on the toggle at the opening and at level 2, and in the sooner ghost", () => {
    const tt = both(roastPlan());
    const { lay, d } = opening(tt, "first", VIEWS[0]);
    const total = d.words.find((w) => w.k === "total")!.lines[0];
    expect(total).toBe(fmtTotal(recipeTimes(roastPlan()).totalMinutes));
    expect(lay.toggle!.items.find((i) => i.mode === "first")!.minutes).toBe(total);
    const toggle = { mode: "first" as const, first: tt.first.total, go: tt.go.total };
    const w = wholeCook(tt, "first", VIEWS[0], { toggle }).lay.toggle!;
    expect(w.items.map((i) => i.minutes)).toEqual(lay.toggle!.items.map((i) => i.minutes));
    expect(soonerMinutes(tt.first.total, tt.go.total)).toBe(135 - 115);
    // two totals in one 5 say nothing sooner
    expect(soonerMinutes(44, 41)).toBe(0);
  });

  it("keeps the axis exact: the parts of the cook are not rounded", () => {
    const tt = both(roastPlan());
    const { d } = opening(tt, "first", VIEWS[0]);
    // the roast's Prep is 21 min, and says so
    expect(tt.first.prep!.end % 5).not.toBe(0);
    expect(d.words.find((w) => w.k === "prep:m")!.lines).toEqual([fmtMinutes(tt.first.prep!.end)]);
  });
});

describe("hands-on time on the opening", () => {
  it("says the hands-on minutes once, quietly, at the head of the toggle's row, or on a line of its own under the title", () => {
    const tt = both(roastPlan());
    for (const v of VIEWS) {
      const { lay } = opening(tt, "first", v, APP_CHROME, 12, "Roast", "45 min hands-on");
      const h = lay.handsOn!;
      expect(h.text, v.name).toBe("45 min hands-on");
      expect(h.w, v.name).toBeCloseTo(measure("45 min hands-on", 22, 500), 6);
      const tg = lay.toggle!;
      const others: Rect[] = [
        { x: tg.x, y: tg.y, w: tg.w, h: tg.h },
        { x: lay.title.x, y: lay.title.y, w: lay.title.w, h: lay.title.lines.length * lay.title.lh },
        { ...lay.controls, ...APP_CHROME.controls },
        lay.chart,
      ];
      if (lay.ahead) others.push({ x: lay.ahead.x, y: lay.ahead.y, w: lay.ahead.items.at(-1)!.x + lay.ahead.items.at(-1)!.w - lay.ahead.x, h: 30 });
      for (const r of others) expect(overlap(h, r, 0), `${v.name}: ${JSON.stringify(r)}`).toBe(false);
      expect(h.x + h.w, v.name).toBeLessThanOrEqual(v.W - SIDE);
      // above the chart, under the title
      expect(h.y, v.name).toBeGreaterThanOrEqual(lay.title.y + lay.title.lines.length * lay.title.lh);
      expect(h.y + h.h, v.name).toBeLessThanOrEqual(lay.chart.y);
      // landscape has room beside the toggle: the same row, the same line as its minutes
      if (!v.portrait) expect(h.y, v.name).toBe(tg.y + 4);
    }
  });

  it("says nothing with no hands-on minutes, and is never on level 2's toggle", () => {
    const tt = both(roastPlan());
    expect(opening(tt, "first", VIEWS[0]).lay.handsOn).toBeNull();
    const toggle = { mode: "first" as const, first: tt.first.total, go: tt.go.total };
    expect(wholeCook(tt, "first", VIEWS[0], { toggle }).lay.toggle).not.toBeNull();
  });
});

/** Every corpus plan that draws a timetable in both modes. */
function corpusCases(): { name: string; plan: CookPlan; tt: Record<PrepMode, Timetable> }[] {
  return timetableCorpus().flatMap((c) => {
    const s1 = strip(c.plan, initialCookState("first"), null, 0);
    if (s1.asWritten) return [];
    const go = strip(c.plan, initialCookState("go"), null, 0);
    const a = buildTimetable(c.plan, s1, go, "first");
    const b = buildTimetable(c.plan, s1, go, "go");
    if (!a || !b) return [];
    return [{ name: c.name, plan: c.plan, tt: { first: a, go: b } as Record<PrepMode, Timetable> }];
  });
}

describe("one scale for both prep modes (SPEC §6)", () => {
  it("draws As I go ending sooner on the same minutes per cpx", () => {
    const tt = both(kitchenPlan("skillet-eggs-potatoes-greens"));
    const a = opening(tt, "first", VIEWS[0]);
    const b = opening(tt, "go", VIEWS[0]);
    const serve = (d: TimetableDrawing) => d.marks.find((m) => m.role === "serve")!.x;
    const per = (d: TimetableDrawing, t: Timetable) => (serve(d) + 1.5 - d.x0) / t.total;
    expect(per(a.d, tt.first)).toBeCloseTo(per(b.d, tt.go), 6);
    expect(serve(b.d)).toBeLessThan(serve(a.d));
  });

  it("keeps one minutes-per-cpx and one serve-end gutter in both modes, corpus × 3 screens, opening and level 2", () => {
    // The gutter shrinks the scale for both modes alike (SPEC §7.5): butternut-chickpea-salad's
    // Prep first needs one in landscape, its As I go doesn't.
    const perMinute = (d: TimetableDrawing, t: Timetable, portrait: boolean) => {
      const last = rowsOfTime(t, portrait).at(-1)!;
      const serve = d.marks.find((m) => m.role === "serve")!.x + 1.5;
      return (serve - d.x0) / (drawnMinutes(t, last.t1) - drawnMinutes(t, last.t0));
    };
    let n = 0;
    for (const c of corpusCases()) {
      for (const v of VIEWS) {
        const at = `${c.name}, ${v.name}`;
        const o = { first: opening(c.tt, "first", v), go: opening(c.tt, "go", v) };
        expect(o.first.d.gutter, at).toBeCloseTo(o.go.d.gutter, 6);
        expect(perMinute(o.first.d, c.tt.first, v.portrait), at).toBeCloseTo(perMinute(o.go.d, c.tt.go, v.portrait), 6);
        const w = { first: wholeCook(c.tt, "first", v), go: wholeCook(c.tt, "go", v) };
        expect(w.first.d.gutter, `${at}, level 2`).toBeCloseTo(w.go.d.gutter, 6);
        expect(perMinute(w.first.d, c.tt.first, v.portrait), `${at}, level 2`).toBeCloseTo(perMinute(w.go.d, c.tt.go, v.portrait), 6);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(60);
  });
});

describe("the header at the whole cook", () => {
  it("shows the voice hint where it has room, and never while a read replaces the header", () => {
    const tt = both(corpusPlan("sunday-roast-dinner"));
    for (const v of VIEWS) {
      const hint = { w: measure("Say “Sue, back”", 22, 500) };
      expect(wholeCook(tt, "first", v, { title: "Roast", hint }).lay.hint, v.name).not.toBeNull();
      const read = { text: "Carve the chicken and serve it with the potatoes, the gravy and the beans.", go: { w: 160 } };
      expect(wholeCook(tt, "first", v, { title: "Roast", hint, read }).lay.hint, `${v.name}, reading`).toBeNull();
    }
  });
});

describe("the read at the whole cook", () => {
  it("keeps its words clear of Go and Whole recipe, inside its box, in every view", () => {
    const tt = both(corpusPlan("sunday-roast-dinner"));
    const texts = ["Garnish with fresh cilantro and serve with rice.", "Carve."];
    for (const v of VIEWS) {
      for (const text of texts) {
        const go = { w: measure("Go to this step", 22, 600) + 32 };
        const r = wholeCook(tt, "first", v, { title: "Dal", read: { text, go } }).lay.read!;
        const at = `${v.name}: ${text}`;
        const words = { x: r.textX, y: r.textY, w: Math.max(...r.lines.map((l) => measure(l, r.size, 500))), h: r.lines.length * r.size * 1.2 };
        for (const b of [r.go!, r.whole]) {
          expect(overlap(words, b, 0), at).toBe(false);
          expect(b.x >= r.box.x && b.x + b.w <= r.box.x + r.box.w && b.y >= r.box.y && b.y + b.h <= r.box.y + r.box.h, at).toBe(true);
        }
        expect(overlap(r.go!, r.whole, 0), at).toBe(false);
        expect(words.x + words.w <= r.box.x + r.box.w && words.y >= r.box.y && words.y + words.h <= r.box.y + r.box.h, at).toBe(true);
        // The short read stays whole; the longer one keeps at least its first two words a line.
        expect(r.lines.join(" ").replace(/…$/, ""), at).not.toBe("");
        if (text === texts[0]) expect(r.lines[0].split(" ").length, at).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("the read's hit test: a tap hits what is drawn", () => {
  const blockOfHit = (d: TimetableDrawing, x: number, y: number) => {
    const h = hitTimetable(d, x, y);
    if (h?.kind !== "step") return null;
    for (const row of d.hits) for (const sg of row.segs) if (sg.key === h.key) return sg.block;
    return null;
  };

  it("reads a block from anywhere on it, and from the far end of a label drawn after it, corpus × 3 screens at level 2", () => {
    let afters = 0;
    for (const c of corpusCases()) {
      for (const v of VIEWS) {
        const tt = both(c.plan, { now: Math.round(c.tt.first.total * 0.4) });
        const { d } = wholeCook(tt, "first", v);
        const at = `${c.name}, ${v.name}`;
        for (const m of d.marks.filter((x) => x.role === "block" && !x.low && x.w >= 4)) {
          expect(blockOfHit(d, m.x + m.w / 2, m.y + m.h / 2), `${at}: ${m.k}`).toBe(m.block);
        }
        for (const w of d.words.filter((x) => x.role === "block-label" && x.how === "after")) {
          afters++;
          // the label's far end, inset 1 cpx: on the label, past every minute of its block
          expect(blockOfHit(d, w.x + w.w - 1, w.y + w.h / 2), `${at}: the end of ${w.k} "${w.lines[0]}"`).toBe(w.block);
        }
      }
    }
    expect(afters, "labels after their blocks to tap").toBeGreaterThan(20);
  });

  it("a touch sitting on a wait's line takes a finger's width either side of it; well off it the line reads its pot", () => {
    let touches = 0;
    let offs = 0;
    for (const c of corpusCases()) {
      for (const v of VIEWS) {
        for (const level of ["opening", "level 2"] as const) {
          const tt = both(c.plan, level === "level 2" ? { now: Math.round(c.tt.first.total * 0.4) } : undefined);
          const { d } = level === "opening" ? opening(tt, "first", v) : wholeCook(tt, "first", v);
          for (const row of d.hits) {
            const cy = row.top + row.h / 2;
            const potsOn = (x: number) => row.segs.filter((sg) => sg.pot && sg.boxes.some(([a, b]) => x >= a && x <= b));
            for (const sg of row.segs.filter((q) => !q.pot && q.boxes.length)) {
              const thin = sg.boxes.filter(([a, b]) => b - a < 12);
              for (const [a, b] of thin) {
                const mid = (a + b) / 2;
                // only a touch sitting on a pot: its line drawn just beside it
                for (const side of [-1, 1]) {
                  const x = mid + side * 9;
                  if (!potsOn(x).length) continue;
                  // another step's work drawn there takes it by the first rule, not this one
                  if (row.segs.some((q) => !q.pot && q.key !== sg.key && q.boxes.some(([qa, qb]) => x >= qa && x <= qb))) continue;
                  touches++;
                  const at = `${c.name}, ${v.name}, ${level}: ${side < 0 ? "left" : "right"} of ${sg.key}`;
                  expect(hitTimetable(d, x, cy), at).toEqual({ kind: "step", key: sg.key });
                  // well off it (past a finger and any other work), the pot's line reads its pot
                  const far = mid + side * 40;
                  const potsFar = potsOn(far);
                  const workNear = row.segs.some((q) => !q.pot && q.boxes.some(([qa, qb]) => far >= Math.min(qa, (qa + qb) / 2 - 12) && far <= Math.max(qb, (qa + qb) / 2 + 12)));
                  if (potsFar.length && !workNear) {
                    offs++;
                    const h = hitTimetable(d, far, cy);
                    expect(h?.kind === "step" && potsFar.some((q) => q.key === h.key), `${at}, 40 off`).toBe(true);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(touches, "touches on a wait's line to tap beside").toBeGreaterThan(5);
    expect(offs, "taps well off a touch onto its wait's line").toBeGreaterThan(5);
  });

  it("reads a pot from its caption, and nothing where nothing is drawn", () => {
    const tt = both(roastPlan(), { now: 40 });
    const { d } = wholeCook(tt, "first", VIEWS[0]);
    const caps = d.words.filter((w) => w.role === "pot-caption");
    expect(caps.length).toBeGreaterThan(0);
    for (const w of caps) {
      const h = hitTimetable(d, w.x + w.w - 1, w.y + w.h / 2);
      const pot = tt.first.pots.find((p) => w.k === `pc:${p.key}`)!;
      const seg = tt.first.segments.find((s) => s.key === (h as { key: string } | null)?.key);
      expect(seg && seg.pot && pot.tasks.includes(seg.tasks[0]), `${w.k}`).toBe(true);
    }
  });

  it("reads nothing past everything drawn on a lane (corpus, every view)", () => {
    for (const v of VIEWS) {
      let gaps = 0;
      for (const c of corpusCases()) {
        const tt = both(c.plan, { now: Math.round(c.tt.first.total * 0.4) });
        const { d } = wholeCook(tt, "first", v);
        const serve = d.marks.find((m) => m.role === "serve")!.x;
        for (const row of d.hits) {
          const inRow = (r: { y: number; h: number }) => Math.abs(r.y + r.h / 2 - (row.top + row.h / 2)) < row.h / 2;
          const right = (r: { x: number; w: number }) => r.x + r.w;
          const drawn = [
            ...d.marks.filter((m) => (m.role === "block" || m.role === "pot-line" || m.role === "break") && inRow(m)),
            ...d.words.filter((w) => (w.role === "block-label" || w.role === "pot-caption") && inRow(w)),
          ];
          if (!drawn.length) continue;
          const lastX = Math.max(...drawn.map(right));
          if (lastX + 40 >= serve) continue;
          if (row.segs.some((sg) => !sg.boxes.length && sg.x1 >= lastX + 30)) continue;
          gaps++;
          expect(hitTimetable(d, lastX + 30, row.top + row.h / 2), `${c.name}, ${v.name}: ${row.lane}`).toBeNull();
        }
      }
      // The precondition is asserted, not assumed: every view has lanes with room past their last mark.
      expect(gaps, `${v.name}: lanes with room past their last mark`).toBeGreaterThan(3);
    }
  });
});

describe("the read's hit test", () => {
  it("of two waits under a finger, reads the shorter, its finger-wide reach against the long one's exact line (T2 fix-check 2)", () => {
    // A 12 cpx "heat the fat" wait drawn over a long simmer: a tap 5 cpx beside the short line is
    // on the simmer's line exactly and inside the short wait's finger: the short one is read.
    const seg = (key: string, x0: number, x1: number) => ({ key, x0, x1, block: null, pot: true, done: false, boxes: [[x0, x1]] as [number, number][] });
    const d: TimetableDrawing = {
      marks: [],
      words: [],
      hits: [{ lane: "Potatoes", top: 100, h: 60, segs: [seg("simmer", 200, 600), seg("heat-fat", 400, 412)] }],
      prepRect: null,
      x0: 150,
      trackY: 300,
      R: 60,
      blockH: 42,
      fits: true,
      demoted: [],
      clock: null,
      gaveWay: [],
      gutter: 0,
      top: 50,
      bottom: 330,
    };
    expect(hitTimetable(d, 395, 130)).toEqual({ kind: "step", key: "heat-fat" });
    expect(hitTimetable(d, 417, 130)).toEqual({ kind: "step", key: "heat-fat" });
    // past the short wait's finger, the long line is the simmer's
    expect(hitTimetable(d, 380, 130)).toEqual({ kind: "step", key: "simmer" });
  });

  it("finds the step under a finger on its lane, and the Prep block", () => {
    const tt = both(corpusPlan("sunday-roast-dinner"));
    const { d } = opening(tt, "first", VIEWS[0]);
    const p = d.prepRect!;
    expect(hitTimetable(d, p.x + p.w / 2, p.y + p.h / 2)).toEqual({ kind: "prep" });
    const carve = d.marks.find((m) => m.role === "block" && m.block?.includes("carve"))!;
    const hit = hitTimetable(d, carve.x + carve.w / 2, carve.y + carve.h / 2);
    expect(hit?.kind).toBe("step");
    const seg = tt.first.segments.find((s) => s.key === (hit as { key: string }).key)!;
    expect(tt.first.blocks.find((b) => b.key === carve.block)!.tasks).toContain(seg.tasks[0]);
    expect(hitTimetable(d, 2, 2)).toBeNull();
  });

  it("gives every step on the roast a place of its own, a pot's wait inside another pot's included", () => {
    const tt = both(corpusPlan("sunday-roast-dinner"));
    for (const view of VIEWS) {
      for (const mode of ["first", "go"] as const) {
        const { d } = opening(tt, mode, view);
        for (const row of d.hits) {
          for (const sg of row.segs) {
            const xs = Array.from({ length: 21 }, (_, i) => sg.x0 + ((sg.x1 - sg.x0) * i) / 20);
            const hit = xs.some((x) => {
              const h = hitTimetable(d, x, row.top + row.h / 2);
              return h?.kind === "step" && h.key === sg.key;
            });
            expect(hit, `${view.name} ${mode}: ${sg.key}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("the opening's frame (SPEC §6)", () => {
  it("puts the toggle with both totals on its own row, the ahead notes above Get out when they don't fit beside it, Get out at the foot", () => {
    const tt = both(corpusPlan("sunday-roast-dinner"));
    const { lay } = opening(tt, "first", VIEWS[0], MOCK_CHROME, 16);
    expect(lay.toggle!.items.map((i) => [i.label, i.minutes, i.on])).toEqual([
      ["Prep first", "2 h 15", true],
      ["As I go", "1 h 55", false],
    ]);
    // the mock's roast: the toggle's row is full, so Ahead sits on its own line between the chart and Get out
    expect(lay.ahead!.y).toBeGreaterThan(lay.chart.y + lay.chart.h);
    expect(lay.ahead!.y).toBeLessThan(lay.getOut!.head.y);
    expect(lay.getOut!.items.length).toBeGreaterThan(0);
    expect(lay.getOut!.more!.text).toMatch(/^and \d+ more$/);
    expect(lay.getOut!.head.y).toBeGreaterThan(lay.chart.y + lay.chart.h);
  });

  it("puts Ahead on the toggle's row in landscape when it fits, and always above Get out in portrait (SPEC §6)", () => {
    const at = (v: View) =>
      layoutOpening({
        W: v.W,
        H: v.H,
        portrait: v.portrait,
        side: SIDE,
        title: "Roast",
        controls: APP_CHROME.controls,
        more: APP_CHROME.more,
        toggle: null,
        ahead: [{ name: "brine", lead: "overnight" }],
        getOut: [{ index: 0, amount: "1", name: "chicken" }],
        scaleNote: null,
        measure,
      });
    const land = at(VIEWS[0]);
    expect(land.ahead!.y).toBeLessThan(land.chart.y);
    const port = at(VIEWS[2]);
    expect(port.ahead!.y).toBeGreaterThanOrEqual(port.chart.y + port.chart.h);
    expect(port.ahead!.y).toBeLessThan(port.getOut!.head.y);
  });

  it("lists Get out in two columns of three in portrait", () => {
    const tt = both(corpusPlan("sunday-roast-dinner"));
    const { lay } = opening(tt, "first", VIEWS[2], MOCK_CHROME, 16);
    const xs = new Set(lay.getOut!.items.map((i) => i.x));
    expect(xs.size).toBe(2);
    expect(lay.getOut!.items).toHaveLength(5);
    expect(lay.getOut!.more!.text).toBe("and 11 more");
  });

  it("puts a title full width under the controls' row when a word of it can't stand beside them", () => {
    const tt = both(corpusPlan("sunday-roast-dinner"));
    const wide = { ...APP_CHROME, controls: { w: 260, h: 64 } };
    const { lay } = opening(tt, "first", VIEWS[2], wide, 12, "Weeknight stir fry");
    const ctlX = VIEWS[2].W - SIDE - wide.more.w - 12 - wide.controls.w;
    expect(lay.title.y).toBeGreaterThanOrEqual(lay.controls.y + wide.controls.h);
    for (const ln of lay.title.lines) expect(lay.title.x + measure(ln, 44, 400, "display")).toBeLessThanOrEqual(VIEWS[2].W - SIDE + 0.5);
    // beside the controls it would have run under them
    expect(lay.title.x + measure("Weeknight", 44, 400, "display")).toBeGreaterThan(ctlX - 30);
  });

  it("gives controls too wide to stand left of More a row of their own under it, inside the content box, the title under them", () => {
    const tt = both(corpusPlan("sunday-roast-dinner"));
    const v = VIEWS[2];
    const wide = { ...APP_CHROME, controls: { w: 480, h: 80 } };
    const { lay } = opening(tt, "first", v, wide, 12, "Roast");
    const more = { ...lay.more, ...wide.more };
    const ctl = { ...lay.controls, ...wide.controls };
    expect(ctl.x).toBeGreaterThanOrEqual(SIDE - 0.5);
    expect(ctl.x + ctl.w).toBeLessThanOrEqual(v.W - SIDE + 0.5);
    expect(overlap(ctl, more, 0)).toBe(false);
    expect(ctl.y).toBeGreaterThanOrEqual(more.y + more.h);
    expect(lay.title.y).toBeGreaterThanOrEqual(ctl.y + ctl.h);
    expect(lay.chart.y).toBeGreaterThan(lay.title.y);
    // Narrow enough, they stay beside More on one row.
    const { lay: one } = opening(tt, "first", v, APP_CHROME, 12, "Roast");
    expect(Math.abs(one.controls.y + APP_CHROME.controls.h / 2 - (one.more.y + APP_CHROME.more.h / 2))).toBeLessThan(0.5);
  });
});

describe("corpus × 3 screens: the layout's rules hold", () => {
  const cases = corpusCases();

  it("is the whole corpus", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const c of cases) {
    for (const v of VIEWS) {
      for (const mode of MODES) {
        it(`${c.name}, ${mode}, ${v.name}: the opening`, () => {
          // the recipe's own name as its title (the fixture's slug), as the e2e gate has it
          const name = c.name.replace(/^pack:/, "").replace(/-/g, " ");
          // the row's own words for this plan, else the longest the row says (a recipe's stated time)
          const handsOn = handsOnWords(shownTimes(c.plan, undefined)) ?? "Recipe says 1\u00a0h\u00a045 hands-on";
          const { lay, d } = opening(c.tt, mode, v, APP_CHROME, 12, name[0].toUpperCase() + name.slice(1), handsOn);
          expect(breaches(d, c.tt[mode], v, lay.chart)).toEqual([]);
          expect(d.top).toBeGreaterThanOrEqual(lay.chart.y - 0.5);
          expect(d.bottom).toBeLessThanOrEqual(lay.chart.y + lay.chart.h + 0.5);
          // The hands-on minutes stand clear of the toggle, Ahead, the title and the chart.
          if (handsOn) {
            const h = lay.handsOn!;
            const near: Rect[] = [lay.chart, { x: lay.title.x, y: lay.title.y, w: lay.title.w, h: lay.title.lines.length * lay.title.lh }];
            if (lay.toggle) near.push({ x: lay.toggle.x, y: lay.toggle.y, w: lay.toggle.w, h: lay.toggle.h });
            if (lay.ahead) near.push({ x: lay.ahead.x, y: lay.ahead.y, w: lay.ahead.items.at(-1)!.x + lay.ahead.items.at(-1)!.w - lay.ahead.x, h: 30 });
            for (const r of near) expect(overlap(h, r, 0), JSON.stringify(r)).toBe(false);
          }
        });
        it(`${c.name}, ${mode}, ${v.name}: level 2 mid-cook`, () => {
          const t0 = c.tt[mode];
          const tt = both(c.plan, { now: Math.round(t0.total * 0.55) });
          const { lay, d } = wholeCook(tt, mode, v);
          expect(breaches(d, tt[mode], v, lay.chart)).toEqual([]);
          expect(d.bottom).toBeLessThanOrEqual(lay.chart.y + lay.chart.h + 0.5);
        });
      }
    }
  }
});

/** Dishes named as a menu names them: two, three and four words, some too wide for the margin on one line. */
const LONG_DISHES = [
  "Roasted Butternut Squash Soup",
  "Garlic Herb Focaccia",
  "Shaved Fennel Salad",
  "Smoky Aubergine Dip",
  "Saffron Pilaf Rice",
  "Crispy Skin Trout",
  "Worcestershire Gravy",
  "Charred Spring Greens",
];

/** A plan of n dishes, each its own branch: a chop, a sear, a long simmer, a finish (plus a slaw-like side). */
function manyDishes(n: number, names: readonly string[] = ["Soup", "Bread", "Salad", "Dip", "Rice", "Fish", "Sauce", "Greens"]): CookPlan {
  return plan(
    names.slice(0, n).flatMap((b, i) => {
      const id = b.toLowerCase().replace(/\W+/g, "-");
      return [
        task({ id: `${id}-chop`, kind: "mise", label: `chop ${["onion", "garlic", "fennel", "herbs", "scallion", "lemon", "shallot", "chard"][i]}`, branch: b, ...min(3 + (i % 3)) }),
        task({ id: `${id}-sear`, label: `sear ${["leeks", "dough", "radish", "beans", "rice", "fish", "tomato", "kale"][i]}`, branch: b, needs: [`${id}-chop`], ...min(4 + (i % 2)) }),
        task({ id: `${id}-simmer`, label: `simmer ${b.split(" ").at(-1)!.toLowerCase()}`, branch: b, needs: [`${id}-sear`], ...min(12 + 3 * i, true) }),
        task({ id: `${id}-fold`, label: `fold ${["cream", "butter", "dressing", "oil", "peas", "capers", "basil", "garlic"][i]}`, branch: b, needs: [`${id}-simmer`], ...min(3 + (i % 3)) }),
      ];
    }),
  );
}

describe("six to eight dishes: the floor", () => {
  // Past the block floor (7 and 8 dishes in landscape) the blocks and the lane pitch thin until the
  // lanes fit; text never goes under 22 cpx and nothing reaches into another lane; a label with no
  // room inside its block goes after it, else the block is drawn as a touch (DECISIONS 2026-10-20, T2).
  for (const n of [6, 7, 8]) {
    for (const v of VIEWS) {
      it(`${n} dishes, ${v.name}: holds on the opening and at level 2`, () => {
        const tt = both(manyDishes(n));
        expect(tt.first.lanes).toHaveLength(n);
        for (const mode of MODES) {
          const { lay, d } = opening(tt, mode, v);
          expect(breaches(d, tt[mode], v, lay.chart), `${mode}, the opening`).toEqual([]);
          expect(d.blockH, `${mode}, the opening: a block holds a 22 cpx line`).toBeGreaterThanOrEqual(Math.round(22 * 1.1) + 2);
          const mid = both(manyDishes(n), { now: Math.round(tt[mode].total * 0.55) });
          const w = wholeCook(mid, mode, v);
          expect(breaches(w.d, mid[mode], v, w.lay.chart), `${mode}, level 2`).toEqual([]);
        }
      });
    }
  }

  for (const n of [6, 7, 8]) {
    for (const v of VIEWS) {
      it(`${n} dishes with long names, ${v.name}: each name stays in its lane, on one line where two don't fit, at 22 cpx or more`, () => {
        const tt = both(manyDishes(n, LONG_DISHES));
        expect(tt.first.lanes).toHaveLength(n);
        for (const mode of MODES) {
          const mid = both(manyDishes(n, LONG_DISHES), { now: Math.round(tt[mode].total * 0.55) });
          for (const [level, { lay, d }, t] of [
            ["the opening", opening(tt, mode, v), tt[mode]],
            ["level 2", wholeCook(mid, mode, v), mid[mode]],
          ] as const) {
            const at = `${mode}, ${level}`;
            expect(breaches(d, t, v, lay.chart), at).toEqual([]);
            for (const w of d.words.filter((x) => x.role === "lane")) {
              expect(w.size, `${at}: ${w.k}`).toBeGreaterThanOrEqual(22);
              // a name wraps only where its lines fit the lane's pitch
              if (w.lines.length > 1) expect(w.lines.length * 25, `${at}: ${w.k} "${w.lines.join(" / ")}"`).toBeLessThanOrEqual(d.R - 1);
              // a word of the dish's name, as the menu writes it
              const name = t.lanes.find((l) => w.k === `lane:${l.name}` || w.k.startsWith(`lane:${l.name}@`))!.name;
              for (const line of w.lines) expect(name.includes(line.replace(/…$/, "")), `${at}: "${line}" from "${name}"`).toBe(true);
            }
          }
        }
      });
    }
  }

  it("caps the margin for one very long word: the word takes one line, cut to the cap at 22 cpx or more, and time keeps its room (T2 fix-check 2)", () => {
    const LONG = "Pneumonoultramicroscopicsilicovolcanoconiosis";
    const names = ["Soup", LONG, "Salad"];
    const tt = both(manyDishes(3, names));
    for (const v of VIEWS) {
      const cap = (v.portrait ? 104 : 124) * 1.5;
      const pad = v.portrait ? 16 : 22;
      const m = laneMargin(tt.first, v.portrait, measure);
      expect(m.w, `${v.name}: the margin`).toBeLessThanOrEqual(cap + pad + 1e-6);
      for (const mode of MODES) {
        const mid = both(manyDishes(3, names), { now: Math.round(tt[mode].total * 0.55) });
        for (const [level, { lay, d }, t] of [
          ["the opening", opening(tt, mode, v), tt[mode]],
          ["level 2", wholeCook(mid, mode, v), mid[mode]],
        ] as const) {
          const at = `${v.name}, ${mode}, ${level}`;
          expect(breaches(d, t, v, lay.chart), at).toEqual([]);
          expect(d.x0 - lay.chart.x, `${at}: the margin`).toBeLessThanOrEqual(cap + pad + 1e-6);
          const w = d.words.find((x) => x.role === "lane" && x.k.startsWith(`lane:${LONG}`))!;
          expect(w.lines, at).toHaveLength(1);
          expect(w.size, at).toBeGreaterThanOrEqual(22);
          expect(w.lines[0].endsWith("…"), `${at}: "${w.lines[0]}"`).toBe(true);
          expect(LONG.startsWith(w.lines[0].slice(0, -1)), at).toBe(true);
          expect(measure(w.lines[0], w.size, 600), `${at}: "${w.lines[0]}" inside the margin`).toBeLessThanOrEqual(d.x0 - lay.chart.x - pad + 1e-6);
        }
      }
    }
  });

  it("leaves a real long dish word whole: the cap is past every word in the kitchen's plans", () => {
    // Garbanzos is the widest at 22 cpx (107), over portrait's 104 wrap: it widens the margin, uncut.
    const names = new Set(loadKitchenPlans().flatMap((k) => k.plan.tasks.map((t) => t.branch).filter((b): b is string => !!b)));
    expect(names.has("Garbanzos") || [...names].some((n) => n.includes("Garbanzos")), "the widest word is in the plans").toBe(true);
    for (const portrait of [false, true]) {
      const m = laneMargin({ lanes: [...names].map((name) => ({ name, short: name.split(" ").at(-1)! })) }, portrait, measure);
      expect([...m.lines.values()].flat().filter((l) => l.endsWith("…")), portrait ? "portrait" : "landscape").toEqual([]);
    }
  });

  it("thins the blocks only past the floor: 6 dishes keep the 36 cpx block in landscape", () => {
    const six = opening(both(manyDishes(6)), "first", VIEWS[0]).d;
    expect(six.blockH).toBe(36);
    const eight = opening(both(manyDishes(8)), "first", VIEWS[0]).d;
    expect(eight.blockH).toBeLessThan(36);
    expect(eight.R).toBeGreaterThanOrEqual(eight.blockH);
  });
});
