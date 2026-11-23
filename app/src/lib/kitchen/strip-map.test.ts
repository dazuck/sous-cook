import { describe, expect, it } from "vitest";
import { strip, type StripMark } from "./cook-strip";
import { initialCookState, next, type CookState } from "./cook-view";
import type { CookPlan, CookTask } from "./cook-plan";
import { SIDE } from "./overview-place";
import { advanceMeasure as measure } from "./__tests__/advance-measure";
import { timetableCorpus } from "./__tests__/timetable-corpus";
import {
  LINE_FROM_FOOT,
  SHEET1_ABOVE_LINE,
  layoutStripMap,
  lineFill,
  stationName,
  untilCountdown,
  untilWords,
  type StripMapDrawing,
  type StripMapInput,
} from "./strip-map";

/** A step on the strip, as `strip()` makes one: minutes, a pot or hands-on, and where the cook stands. */
function mk(key: string, start: number, end: number, o: Partial<StripMark> = {}): StripMark {
  return {
    key,
    screen: 0,
    strand: "Main",
    label: key.replace(/-/g, " "),
    start,
    end,
    pot: false,
    nominal: false,
    state: "ahead",
    stretch: 0,
    done: false,
    tasks: [key],
    lane: 0,
    ...o,
  };
}

/** Screens in cook order, as the strip counts them. */
function screens(marks: StripMark[]): StripMark[] {
  return marks.map((m, i) => ({ ...m, screen: i }));
}

const LAND = { x0: SIDE, x1: 960 - SIDE };
/** Portrait: its time to the table at the sheet's top right, short of level 2's More (56 + 16). */
const PORT = { x0: SIDE, x1: 600 - SIDE, portrait: { ttRight: 600 - SIDE - 72 } };
/** A map wide enough for every station the SPEC lists. */
const WIDE = { x0: SIDE, x1: 1600 - SIDE };

function input(marks: StripMark[], now: number, total: number, o: Partial<StripMapInput> = {}): StripMapInput {
  return {
    marks,
    now,
    total,
    name: (m) => m.label.charAt(0).toUpperCase() + m.label.slice(1),
    toTable: "1 h 02",
    ...LAND,
    measure,
    ...o,
  };
}

const kinds = (d: StripMapDrawing) => d.stations.map((s) => (s.kind === "step" ? s.key : s.kind));

describe("level 0: the progress line (SPEC §10)", () => {
  it("is the whole cook on true minutes, edge to edge: done is the part up to now", () => {
    expect(lineFill(100, 0, 44, 916)).toBe(0);
    expect(lineFill(100, 25, 44, 916)).toBeCloseTo(218, 6);
    expect(lineFill(100, 100, 44, 916)).toBeCloseTo(872, 6);
  });

  it("holds the fill at the line's ends: before the start and past the plan", () => {
    expect(lineFill(100, -5, 44, 916)).toBe(0);
    expect(lineFill(100, 130, 44, 916)).toBeCloseTo(872, 6);
    expect(lineFill(0, 3, 44, 916)).toBeCloseTo(872, 6);
  });

  it("stands where level 2's last time track stands, above the 96 cpx foot", () => {
    // `timetable-layout` bottom-anchors the chart 8 cpx over the foot, its track 48 over the chart's foot.
    expect(LINE_FROM_FOOT).toBe(56);
    expect(SHEET1_ABOVE_LINE).toEqual({ landscape: 150, portrait: 190 });
  });
});

describe("level 1: the strip map's stations (SPEC §10)", () => {
  const roastish = () =>
    screens([
      mk("prep", 0, 20, { state: "done", stretch: null, lane: null }),
      mk("stuff-chicken", 20, 30, { state: "done" }),
      mk("roast", 30, 80, { pot: true, state: "in-hand" }),
      mk("check-chicken", 80, 84),
      mk("skim-fat", 84, 86),
      mk("rest-chicken", 86, 96, { pot: true }),
      mk("make-gravy", 88, 94),
      mk("carve", 96, 100),
      mk("plate-up", 100, 104),
    ]);

  it("runs now, the wait you're in, the next step large, three more, N more, then the plate", () => {
    const d = layoutStripMap(input(roastish(), 45, 104, WIDE));
    expect(kinds(d)).toEqual(["now", "wait", "check-chicken", "skim-fat", "rest-chicken", "make-gravy", "more", "plate"]);
    expect(d.rung).toBe(1);
    const next = d.stations.find((s) => s.key === "check-chicken")!;
    expect(next.big).toBe(true);
    expect(d.stations.filter((s) => s.kind === "step" && s.big)).toHaveLength(1);
    expect(d.stations.find((s) => s.kind === "more")!.n).toBe(2);
    // the wait's minutes run to the next step: 80 - 45
    const wait = d.words.find((w) => w.role === "wait-minutes")!;
    expect(wait.live).toEqual({ kind: "until", at: 80 });
    expect(wait.lines).toEqual(["35 min"]);
  });

  it("lays the wait's minutes out for every count the clock says before the next layout, the hour's crossing included", () => {
    // 65 min to the next step: "1 h 05" counts down through "1 h" to the wider "59 min" while the map holds.
    const d = layoutStripMap(input(roastish(), 15, 104, WIDE));
    const wait = d.words.find((w) => w.role === "wait-minutes")!;
    expect(wait.lines).toEqual(["1 h 05"]);
    const says = Array.from({ length: 65 }, (_, j) => untilWords(80, 15 + j));
    const width = (s: string) => measure(s, 30, 400, "display");
    expect(says.some((s) => width(s) > width("1 h 05") + 1), "the count grows on the way").toBe(true);
    for (const s of says) expect(wait.w, s).toBeGreaterThanOrEqual(width(s) - 1e-6);
    // Its station keeps the room for it.
    const st = d.stations.find((s) => s.key === "wait")!;
    expect(st.w).toBeGreaterThanOrEqual(Math.max(...says.map(width)) + 48 - 1e-6);
  });

  it("counts a wait's minutes by their shapes, so a wait of years lays out at once (a clock read as 0 gives one)", () => {
    // Every count 1..top, as the clock says them minute by minute.
    const every = (top: number) => new Set(Array.from({ length: top }, (_, j) => untilWords(top - j, 0)));
    for (const top of [1, 59, 60, 61, 125, 600, 601]) expect(new Set(untilCountdown(top + 0.4, 0.2)), String(top)).toEqual(every(top));
    // Past 10 h one count per shape stands for the rest: the figures are all one width (call 13).
    const t0 = performance.now();
    const says = untilCountdown(29_000_000, 0);
    expect(performance.now() - t0).toBeLessThan(50);
    const shape = (s: string) => s.replace(/\d/g, "0");
    expect(new Set(says.map(shape))).toEqual(new Set(["0 min", "00 min", "0 h", "0 h 00", "00 h", "00 h 00", "000 h", "000 h 00", "0000 h", "0000 h 00", "00000 h", "00000 h 00", "000000 h", "000000 h 00"]));
    // The map with it: the wait the cook is in, read on a clock that says 0.
    const t1 = performance.now();
    const d = layoutStripMap(input(roastish(), 45 - 29_000_000, 104, WIDE));
    expect(performance.now() - t1).toBeLessThan(200);
    expect(d.words.find((w) => w.role === "wait-minutes")!.live).toEqual({ kind: "until", at: 80 });
  });

  it("starts at the rail's left with now, ends at the plate 17 in from the right", () => {
    const d = layoutStripMap(input(roastish(), 45, 104));
    expect(d.stations[0].x).toBe(LAND.x0 + 11);
    expect(d.stations.at(-1)!.x).toBe(LAND.x1 - 17);
    expect(d.rail).toEqual({ x0: LAND.x0 + 11, x1: LAND.x1 - 17 });
  });

  it("has no wait station on hands-on work", () => {
    const m = roastish().map((x) => (x.key === "roast" ? { ...x, state: "done" as const } : x.key === "check-chicken" ? { ...x, state: "in-hand" as const } : x));
    const d = layoutStripMap(input(m, 80, 104));
    expect(kinds(d)[0]).toBe("now");
    expect(kinds(d)[1]).toBe("skim-fat");
  });

  it("says when each step starts, and nothing more for a step starting with the one before it", () => {
    const m = screens([
      mk("a", 0, 10, { state: "in-hand" }),
      mk("b", 10, 14),
      mk("c", 10, 20, { pot: true }),
      mk("d", 20, 24),
    ]);
    const d = layoutStripMap(input(m, 0, 24));
    const mins = (k: string) => d.words.find((w) => w.role === "minutes" && w.station === k);
    expect(mins("b")!.lines).toEqual(["in 10 min"]);
    expect(mins("b")!.live).toEqual({ kind: "in", at: 10 });
    expect(mins("c"), "starts with b").toBeUndefined();
    expect(mins("d")!.lines).toEqual(["in 20 min"]);
  });

  it("says next for a step due now, and for one the plan says is late", () => {
    const m = screens([mk("a", 0, 10, { state: "done" }), mk("b", 10, 14, { state: "in-hand" }), mk("c", 14, 20)]);
    const d = layoutStripMap(input(m, 16, 20));
    expect(d.words.find((w) => w.role === "minutes" && w.station === "c")!.lines).toEqual(["next"]);
  });

  it("puts the next free stretch in time order, before the hidden steps it comes before", () => {
    const m = screens([
      mk("a", 0, 4, { state: "in-hand" }),
      mk("b", 4, 8),
      mk("c", 8, 12),
      mk("d", 12, 14),
      mk("e", 14, 16),
      mk("simmer", 16, 60, { pot: true }),
      mk("f", 60, 64),
      mk("g", 64, 66),
    ]);
    const d = layoutStripMap(input(m, 0, 66, WIDE));
    // b c d e shown; simmer, f, g hidden: the stove is free 16..60, before f.
    // simmer starts at 16, before the free stretch ends: it's the free stretch's own wait, so it hides
    // inside "N more" and the free stretch stays out (it doesn't come before every hidden step).
    expect(kinds(d)).toEqual(["now", "b", "c", "d", "e", "more", "plate"]);
    const m2 = m.filter((x) => x.key !== "simmer").map((x) => (x.key === "e" ? { ...x, end: 16 } : x));
    const d2 = layoutStripMap(input(screens(m2), 0, 66, WIDE));
    expect(kinds(d2)).toEqual(["now", "b", "c", "d", "e", "wait", "more", "plate"]);
    const free = d2.words.find((w) => w.role === "wait-minutes")!;
    expect(free.lines).toEqual(["44 min"]);
    expect(free.live).toBeUndefined();
  });

  it("shows a free stretch after the last step when nothing is hidden, and none under 8 min", () => {
    // A pot running on from before holds the table to 40: the stove is free 12..40 after the last step.
    const m = screens([mk("bake", 0, 40, { pot: true, state: "running" }), mk("a", 0, 4, { state: "in-hand" }), mk("b", 4, 8), mk("c", 8, 12)]);
    expect(kinds(layoutStripMap(input(m, 0, 40)))).toEqual(["now", "b", "c", "wait", "plate"]);
    const short = screens([mk("bake", 0, 19, { pot: true, state: "running" }), mk("a", 0, 4, { state: "in-hand" }), mk("b", 4, 8), mk("c", 8, 12)]);
    expect(kinds(layoutStripMap(input(short, 0, 19)))).toEqual(["now", "b", "c", "plate"]);
    // A pot shown among the stations is a station; the time it frees between them is its own.
    const bake = screens([mk("a", 0, 4, { state: "in-hand" }), mk("b", 4, 8), mk("bake", 8, 40, { pot: true }), mk("c", 40, 44)]);
    expect(kinds(layoutStripMap(input(bake, 0, 44)))).toEqual(["now", "b", "bake", "c", "plate"]);
  });

  it("gives the next step 1.4 shares when every station has room", () => {
    const m = screens([mk("a", 0, 4, { state: "in-hand" }), mk("b", 4, 8), mk("c", 8, 12), mk("d", 12, 16), mk("e", 16, 20)]);
    const d = layoutStripMap(input(m, 0, 20));
    const w = (k: string) => d.stations.find((s) => s.key === k)!.w;
    expect(w("b") / w("c")).toBeCloseTo(1.4, 6);
    expect(w("c")).toBeCloseTo(w("d"), 6);
  });

  it("sends stations that can't fit their longest word into N more, and always keeps the next step", () => {
    const long = (k: string, s: number) => mk(k, s, s + 4, { label: `${k} Worcestershire` });
    const m = screens([mk("a", 0, 4, { state: "in-hand" }), long("b", 4), long("c", 8), long("d", 12), long("e", 16)]);
    const d = layoutStripMap(input(m, 0, 20, PORT));
    const shown = d.stations.filter((s) => s.kind === "step");
    expect(shown.length).toBeLessThan(4);
    expect(shown[0].key).toBe("b");
    expect(d.stations.find((s) => s.kind === "more")!.n).toBe(4 - shown.length);
    for (const s of shown) expect(s.w).toBeGreaterThanOrEqual(s.need - 1e-6);
  });

  it("names a step of several tasks by its block's name, one task by its own label", () => {
    const task = (id: string, label: string, kind: "mise" | "cook", est: number): CookTask => ({
      id,
      label,
      kind,
      text: `${label}.`,
      minutes: { est, handsOff: false },
      branch: "Main",
      needs: [],
      ingredientIdx: [],
      sourceStep: null,
      implied: false,
    });
    const byId = new Map([task("t1", "dice onions", "mise", 4), task("t2", "mince garlic", "mise", 2), task("t3", "sear beef", "cook", 6)].map((t) => [t.id, t]));
    // dice carries the most minutes: the block is named by it, with its object
    expect(stationName(mk("s1", 0, 6, { tasks: ["t1", "t2"], cook: false }), byId)).toBe("Dice onions");
    expect(stationName(mk("s2", 0, 6, { tasks: ["t3"] }), byId)).toBe("Sear beef");
    // a task the plan doesn't hold: the mark's own label
    expect(stationName(mk("s3", 0, 6, { tasks: ["t9"], label: "rest chicken" }), byId)).toBe("Rest chicken");
  });

  it("has just now and the plate at the end of the cook", () => {
    const m = screens([mk("a", 0, 4, { state: "done" }), mk("b", 4, 8, { state: "in-hand" })]);
    expect(kinds(layoutStripMap(input(m, 4, 8)))).toEqual(["now", "plate"]);
  });
});

// ---------------------------------------------------------------------------
// Portrait's chain (call 6)
// ---------------------------------------------------------------------------

describe("portrait: the strip map's chain (call 6)", () => {
  /** The corpus cook `name` at `pos`, mapped in portrait. */
  const at = (name: string, mode: "first" | "go", pos: number) => {
    const c = timetableCorpus().find((x) => x.name === name)!;
    const byId = new Map(c.plan.tasks.map((t) => [t.id, t]));
    let s = initialCookState(mode);
    for (let i = 0; i < pos; i++) s = next(c.plan, s);
    const st = strip(c.plan, s, null, 0);
    const d = layoutStripMap({ marks: st.marks, now: st.now, total: st.totalMinutes, name: (m) => stationName(m, byId), toTable: st.timeToTable, measure, ...PORT });
    return { d, st };
  };

  it("sets the time to the table at the sheet's top right, as level 2's header does, and the plate keeps its ring", () => {
    const m = screens([mk("a", 0, 4, { state: "in-hand" }), mk("b", 4, 8), mk("c", 8, 12)]);
    const d = layoutStripMap(input(m, 0, 12, PORT));
    expect(d.ttAt).toBe("header");
    const tt = d.words.find((w) => w.role === "tt-num")!;
    const ttl = d.words.find((w) => w.role === "tt-words")!;
    // One block as the header sets it: its lines left-set, the block right-set at ttRight.
    expect(ttl.x).toBe(tt.x);
    expect(Math.max(tt.x + tt.w, ttl.x + ttl.w)).toBeCloseTo(PORT.portrait.ttRight, 6);
    expect(tt.y).toBe(-SHEET1_ABOVE_LINE.portrait + 14);
    expect([tt.size, ttl.size]).toEqual([40, 26]);
    expect(ttl.y).toBe(tt.y + 40);
    const plate = d.stations.at(-1)!;
    expect(plate.kind).toBe("plate");
    expect(plate.w).toBe(40);
    expect(d.marks.find((x) => x.role === "plate")).toMatchObject({ w: 34, ring: 5 });
    // Landscape keeps it on the plate.
    expect(layoutStripMap(input(m, 0, 12)).ttAt).toBe("plate");
  });

  /** The next step's name may run on over "N more"'s room above the rail, never the plate's. */
  const overMore = (d: StripMapDrawing) => {
    const step = d.stations.find((s) => s.kind === "step" && s.big)!;
    const more = d.stations.find((s) => s.kind === "more");
    const lab = d.words.find((w) => w.role === "label" && w.station === step.key)!;
    return { step, more, lab, into: lab.x + lab.w > step.x + step.w - 22 + 0.5 };
  };

  it("first sends later steps into N more, then sets the next step's name on 2 lines at 32 over N more's room (Codex's case)", () => {
    // "Adjust hummus texture with ice water": two lines at 32 fit over N more, so it never takes three.
    const { d } = at("chicken-pita-wraps", "first", 19);
    expect(d.fits).toBe(true);
    expect(d.rung).toBe(3);
    const { more, lab, into } = overMore(d);
    expect([lab.size, lab.lines.length]).toEqual([32, 2]);
    expect(into, "it runs on into N more's room").toBe(true);
    expect(lab.x + lab.w, "never the plate's").toBeLessThanOrEqual(more!.x + more!.w);
    expect(d.stations.filter((s) => s.kind === "step")).toHaveLength(1);
  });

  it("walks the chain in order: 32 on 2 lines over N more, the free stretch away, 26 on 2 lines, then 3 lines at 26", () => {
    const order = (d: StripMapDrawing) => {
      const lab = overMore(d).lab;
      return { rung: d.rung, size: lab.size, lines: lab.lines.length, free: d.stations.some((s) => s.key === "free") };
    };
    const marks = screens([mk("a", 0, 4, { state: "in-hand" }), mk("b", 4, 8), mk("c", 30, 34), mk("d", 34, 38), mk("e", 38, 42), mk("f", 42, 46)]);
    const map = (nm: string, o: Partial<StripMapInput> = {}) => layoutStripMap(input(marks, 0, 46, { ...PORT, name: (m) => (m.key === "b" ? nm : m.label), ...o }));
    // A free stretch (8 to 30) comes before the hidden steps; the name fits 2 lines at 32 over N more only without it.
    expect(order(map("Whisk the eggs and sugar together until pale"))).toMatchObject({ rung: 4, size: 32, lines: 2, free: false });
    // Too long for 2 lines at 32 even then, not at 26.
    expect(order(map("Whisk the eggs and the sugar together until pale and thick"))).toMatchObject({ rung: 5, size: 26, lines: 2, free: false });
    // Longer still: 3 lines at 26, the last resort, only where its words clear the header's time to the
    // table. Under "1 h 02 / to the table" they don't, so no rung fits (the fit gate reports it);
    // under a bare "Ready" they do.
    const long = "Whisk the eggs and the sugar together until it is pale and thick";
    expect(map(long).fits).toBe(false);
    expect(map(long).rung).toBe(7);
    const d6 = map(long, { toTable: "Ready", toTableWords: "" });
    expect(d6.fits).toBe(true);
    expect(order(d6)).toMatchObject({ rung: 6, size: 26, lines: 3 });
  });

  it("keeps the next step's name at 26 or more on 2 lines over N more, beside the wait the cook is in (the pita wraps' first step)", () => {
    // The doughnuts at their eleventh task were this case's real witness for the drop to 26 until
    // their plan was re-derived for the cook-fidelity prompt (2026-10-26): the cook is in no wait
    // there any more. The synthetic chain above still drives the drop to 26.
    for (const [nm, mode, pos] of [["chicken-pita-wraps", "first", 1]] as const) {
      const { d } = at(nm, mode, pos);
      expect(d.fits, nm).toBe(true);
      expect(d.rung, nm).toBeLessThanOrEqual(5);
      const { more, lab } = overMore(d);
      expect(lab.lines.length, nm).toBeLessThanOrEqual(2);
      expect(lab.size, nm).toBeGreaterThanOrEqual(26);
      if (more) expect(lab.x + lab.w, "never the plate's").toBeLessThanOrEqual(more.x + more.w);
      // the wait the cook is in stays a station
      expect(d.stations.some((s) => s.key === "wait")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The fit, corpus × 3 screens × every step
// ---------------------------------------------------------------------------

/** The three screens the fit gate holds, in counter px. */
const VIEWS = [
  { name: "1280×800", W: 960, H: 600, portrait: false },
  { name: "1280×680", W: 1280 / (680 / 600), H: 600, portrait: false },
  { name: "800×1280", W: 600, H: 960, portrait: true },
];

function walk(plan: CookPlan, mode: "first" | "go"): { state: CookState; marks: StripMark[]; now: number; total: number; toTable: string }[] {
  const out = [];
  let s = initialCookState(mode);
  for (let i = 0; i < 60; i++) {
    const st = strip(plan, s, null, 0);
    if (st.asWritten) return [];
    out.push({ state: s, marks: st.marks, now: st.now, total: st.totalMinutes, toTable: st.timeToTable });
    if (!st.marks.some((m) => m.state === "in-hand")) break;
    const n = next(plan, s);
    if (n.pos === s.pos) break;
    s = n;
  }
  return out;
}

type Box = { x: number; y: number; w: number; h: number };
const over = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;

describe("the strip map fits, corpus × 3 screens × every step (SPEC §10, §12; call 6)", () => {
  it("never sets a word under 22 cpx, over another, off the map or under the foot, and never cuts a name", () => {
    const breaches: string[] = [];
    let n = 0;
    let more = 0;
    const rungs = new Map<number, number>();
    for (const c of timetableCorpus()) {
      const byId = new Map(c.plan.tasks.map((t) => [t.id, t]));
      for (const mode of ["first", "go"] as const) {
        for (const at of walk(c.plan, mode)) {
          for (const v of VIEWS) {
            const x0 = SIDE;
            const x1 = v.W - SIDE;
            const portrait = v.portrait ? { ttRight: x1 - 72 } : null;
            const d = layoutStripMap({ marks: at.marks, now: at.now, total: at.total, name: (m) => stationName(m, byId), toTable: at.toTable, x0, x1, measure, portrait });
            n++;
            if (d.stations.some((s) => s.kind === "more")) more++;
            const where = `${c.name} ${mode} pos ${at.state.pos} ${v.name}`;
            if (v.portrait) rungs.set(d.rung, (rungs.get(d.rung) ?? 0) + 1);
            else if (d.rung > 2) breaches.push(`${where}: landscape on rung ${d.rung}`);
            if (!d.fits) breaches.push(`${where}: no rung fits`);
            const words = d.words;
            const top = -(v.portrait ? SHEET1_ABOVE_LINE.portrait : SHEET1_ABOVE_LINE.landscape) + 24;
            for (const w of words) {
              const header = v.portrait && (w.role === "tt-num" || w.role === "tt-words");
              if (w.size < 22 - 1e-6) breaches.push(`${where}: ${w.k} at ${w.size}`);
              if (w.x < x0 - 4 - 1e-6 || w.x + w.w > x1 + 1e-6) breaches.push(`${where}: ${w.k} off the map ${w.x.toFixed(1)}–${(w.x + w.w).toFixed(1)}`);
              // Portrait's time to the table is the sheet's header: beside the grabber (60 wide, centred), never under it.
              if (header && w.x < v.W / 2 + 30 + 8) breaches.push(`${where}: ${w.k} under the grabber`);
              if (!header && w.y < top - 1e-6) breaches.push(`${where}: ${w.k} under the grabber at ${w.y.toFixed(1)}`);
              if (w.y + w.h > LINE_FROM_FOOT + 1e-6) breaches.push(`${where}: ${w.k} under the foot at ${(w.y + w.h).toFixed(1)}`);
              for (const ln of w.lines) if (measure(ln, w.size, w.weight, w.family) > w.w + 0.5) breaches.push(`${where}: ${w.k} "${ln}" wider than its box`);
            }
            for (let i = 0; i < words.length; i++)
              for (let j = i + 1; j < words.length; j++) if (over(words[i], words[j])) breaches.push(`${where}: ${words[i].k} over ${words[j].k}`);
            for (const w of words) for (const mk of d.marks) if (over(w, mk)) breaches.push(`${where}: ${w.k} over ${mk.k}`);
            for (const s of d.stations) {
              if (s.kind !== "step") continue;
              const lab = words.find((w) => w.role === "label" && w.station === s.key)!;
              const name = stationName(at.marks.find((m) => m.key === s.key)!, byId);
              if (lab.lines.join(" ") !== name) breaches.push(`${where}: ${s.key} named "${lab.lines.join(" / ")}" for "${name}"`);
              // SPEC §10's two lines; three only on the chain's last resort (rung 6), at 26.
              if (lab.lines.length > (s.big && d.rung === 6 ? 3 : 2)) breaches.push(`${where}: ${s.key} on ${lab.lines.length} lines`);
              if (lab.lines.length === 3 && lab.size !== 26) breaches.push(`${where}: ${s.key} on 3 lines at ${lab.size}`);
            }
          }
        }
      }
    }
    // How often the cook gets the reduced forms in portrait (reported with the slice).
    console.info(`strip map, portrait rungs: ${[...rungs].sort((p, q) => p[0] - q[0]).map(([r, k]) => `${r}: ${k}`).join(", ")}`);
    expect(n).toBeGreaterThan(500);
    expect(more, "some maps hide steps under N more").toBeGreaterThan(0);
    expect(breaches.slice(0, 30)).toEqual([]);
  });
});
