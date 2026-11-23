/**
 * The cook sheet's levels 0 and 1 (overview slice T3; build contract
 * `design/overview-arc/r3/SPEC.md` §10, the r3 mock's `drawPeek` and
 * `drawStripMap`): where the progress line and the strip map stand.
 *
 * - **Level 0, the progress line:** the whole cook on true minutes (no break
 *   compressed), edge to edge, its done part filled. It stands where level 2's
 *   last time track stands, so the timetable grows out of it (SPEC §11).
 * - **Level 1, the strip map, on that same line:** now, the wait the cook is
 *   in, the next step large, up to three more, the next free stretch where it
 *   comes before the steps not shown (call 4), "N more", and the plate with
 *   the time to the table. Stations are evenly spaced, the next step taking
 *   1.4 shares; each is as wide as its name set on its lines (2 at most; 3
 *   for the next step on portrait's last rung), or its minutes, plus 30
 *   (call 3); stations that can't fit join "N more" (the next step always
 *   stays), and portrait runs on down its chain (call 6, `StripMapRung`).
 *
 * Which steps are stations is the cook's record, not the clock: every step
 * still to come (`ahead`), by its planned start. The words that count down
 * (a step's "in 12 min", the wait's minutes) carry the minute they count to,
 * so the page says them from the clock without laying anything out again.
 *
 * Pure, in counter px, with the rail's centre at y 0. Text is measured
 * through an injected `Measure` (cpx in, cpx out).
 */

import type { CookTask } from "./cook-plan";
import type { StripMark } from "./cook-strip";
import { COOK_COPY } from "./cook-view";
import { fmtMinutes } from "./timetable-layout";
import { blockName } from "./timetable-model";

/** A text's width in cpx at `size` cpx: `family` "text" is Figtree, "display" Caprasimo. */
export type Measure = (text: string, size: number, weight: number, family?: "text" | "display") => number;

/**
 * The progress line stands this far over the foot's top (cpx): level 2's
 * timetable ends 8 over the foot and its last track stands 48 over that
 * (`layoutWholeCook`, `AXIS_H`), so the line is that track at every level.
 * SPEC §10's "screen height − 130" is the mock's, whose foot is lower.
 */
export const LINE_FROM_FOOT = 56;
/** The level-1 sheet's top over the line (SPEC §10). */
export const SHEET1_ABOVE_LINE = { landscape: 150, portrait: 190 } as const;
/** The line's tap and pull target: about 52 tall, centred on it. */
export const LINE_HIT = 52;
/** The free stretch the map names: 8 minutes or more with no hands-on work. */
const FREE_MIN = 8;
/** "Up to 3 more steps" after the next. */
const SHOWN = 4;
/** The time to the table over the plate: Caprasimo 40, its words at 22 under the rail (the r3 mock's). */
export const TT_NUM = 40;
export const TT_WORDS = 22;

/** The done part of the line, from its left end: the whole cook on true minutes. */
export function lineFill(total: number, now: number, x0: number, x1: number): number {
  if (total <= 0) return x1 - x0;
  return (x1 - x0) * Math.max(0, Math.min(1, now / total));
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A step's name on the map: its block's name for several tasks, else its task's label (SPEC §10 item 3). */
export function stationName(mark: StripMark, tasks: ReadonlyMap<string, CookTask>): string {
  if (mark.key === "prep") return COOK_COPY.prepChapter;
  const own = mark.tasks.map((id) => tasks.get(id)).filter((t): t is CookTask => t !== undefined);
  if (own.length > 1) return cap(blockName(own, null, mark.cook === false));
  if (own.length === 1) return cap(own[0].label);
  return cap(mark.label);
}

export interface StripMapInput {
  /** The strip's marks (a derived plan's). */
  marks: readonly StripMark[];
  /** The cook's minute, as the layout is drawn (the words that count down are said from the clock). */
  now: number;
  total: number;
  name: (m: StripMark) => string;
  /** The time to the table as said ("1 h 02"). */
  toTable: string;
  /** The widest the time to the table says before the sheet is laid out again: its place is measured with it (call 13). Default `toTable`. */
  toTableWidest?: string;
  /** Its words under it ("to the table"; none for "Ready"). Default "to the table". */
  toTableWords?: string;
  /** The map's ends, cpx: the cook view's edge on each side. */
  x0: number;
  x1: number;
  measure: Measure;
  /**
   * Portrait: the time to the table leaves the plate for the sheet's top right, right-aligned at
   * `ttRight` (where level 2's header sets it), and the fit's chain runs on (call 6). Else landscape.
   */
  portrait?: { ttRight: number } | null;
}

/**
 * Which rung of the fit's chain the map stands on (call 6, as amended in T3's fix round): 1 every
 * step it would show; 2 later steps joined "N more"; then in portrait the next step's name, at 32
 * on 2 lines, may run on over "N more"'s room above the rail (3); the free stretch joins away (4);
 * the name drops to 26, still 2 lines over that room (5); last, 3 lines at 26 (6), only where its
 * words clear the header's time to the table. 7: nothing fit (the fit gate fails on it).
 */
export type StripMapRung = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type StationKind = "now" | "wait" | "step" | "more" | "plate";

export interface Station {
  key: string;
  kind: StationKind;
  /** Its dot's centre on the rail. */
  x: number;
  /** Its slot's width (the plate's is the room kept for the time to the table). */
  w: number;
  /** A step: the next one, drawn large. */
  big?: boolean;
  /** A step: its name as set on its lines (2 at most, SPEC §10; the next step 3 on portrait's rung 6) or its minutes, plus 30 (call 3). */
  need: number;
  /** "N more": how many. */
  n?: number;
}

/** A mark of the map, from the rail's centre (y 0). */
export interface SmMark {
  k: string;
  station: string;
  role: "now-dot" | "dot" | "open-dot" | "plate" | "gap" | "slash" | "more-dot";
  x: number;
  y: number;
  w: number;
  h: number;
  /** An open dot's ring, cpx. */
  ring?: number;
}

/** Words of the map, from the rail's centre (y 0): their box, set at `align` in it. */
export interface SmWord {
  k: string;
  station: string;
  role: "now" | "label" | "minutes" | "wait-minutes" | "free" | "more" | "tt-num" | "tt-words";
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  size: number;
  weight: number;
  family: "text" | "display";
  tone: "ink" | "soft";
  /** Line height, cpx. */
  lh: number;
  align: "left" | "center" | "right";
  /**
   * Words said from the clock: a step's "in N min" counts to its start (`in`), the wait's minutes
   * to its end (`until`). The page says them from the clock's minute; their box stays.
   */
  live?: { kind: "in" | "until"; at: number };
}

export interface StripMapDrawing {
  stations: Station[];
  marks: SmMark[];
  words: SmWord[];
  /** The rail: from now's dot to the plate's. */
  rail: { x0: number; x1: number };
  rung: StripMapRung;
  /** Every word fits: on the map, inside its box, its name whole, over no other. */
  fits: boolean;
  /** Where the time to the table stands: on the plate (landscape) or at the sheet's top right (portrait). */
  ttAt: "plate" | "header";
}

/** A step's minutes as the map says them: "next" when due, else "in 12 min". */
export function inWords(start: number, now: number): string {
  const m = Math.round(start - now);
  return m <= 0 ? COOK_COPY.stripNext : COOK_COPY.stripIn(m);
}

/** The wait's minutes: to its end, never under 1. */
export function untilWords(at: number, now: number): string {
  return fmtMinutes(Math.max(1, at - now));
}

/** Up to 10 h the countdown says every count; past it, one count per shape stands for the rest. */
const COUNT_EVERY = 600;

/**
 * What the wait's minutes say from `now` to its end, as the clock counts them: the map holds while
 * they count, so their box is laid out for the widest ("1 h" gives way to the wider "59 min").
 * The counts after this minute are every whole minute from 1 to the first. Up to 10 h it says each
 * one; past that, one per shape ("12 h", "12 h 05", "123 h"…), since Caprasimo's figures are all
 * one width (call 13), so a wait read off a clock that says 0 (millions of minutes) lays out at once.
 */
export function untilCountdown(at: number, now: number): string[] {
  const out = [untilWords(at, now)];
  const t0 = Math.floor(now) + 1;
  if (t0 >= at) return out;
  const top = Math.max(1, Math.round(at - t0));
  for (let r = 1; r <= Math.min(top, COUNT_EVERY); r++) out.push(fmtMinutes(r));
  const hMax = Math.floor(top / 60);
  for (let h = 10; h <= hMax; h *= 10) {
    // The smallest hour of this many figures, on the hour and past it.
    if (60 * h > COUNT_EVERY) out.push(fmtMinutes(60 * h));
    const past = Math.min(60 * h + 5, top);
    if (past > Math.max(60 * h, COUNT_EVERY)) out.push(fmtMinutes(past));
  }
  return out;
}

type Item =
  | { kind: "now" }
  | { kind: "wait"; minutes: number; until: number | null }
  | { kind: "step"; m: StripMark; big: boolean }
  | { kind: "more"; n: number }
  | { kind: "plate" };

type Interval = [number, number];

function unionOf(iv: Interval[]): Interval[] {
  const s = iv.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out: Interval[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The first stretch of `min` minutes or more in [lo, hi] with no hands-on work. */
function freeAfter(union: Interval[], lo: number, hi: number): Interval | null {
  let at = lo;
  for (const [a, b] of union) {
    if (b <= at) continue;
    if (a - at >= FREE_MIN && a <= hi) return [at, a];
    at = Math.max(at, b);
  }
  return hi - at >= FREE_MIN ? [at, hi] : null;
}

/** Where portrait's time to the table sits: the sheet's top right, as level 2's header holds it (call 6). */
export const HEADER_TT = { top: 14, num: 40, words: 26, wordsLh: 1.15 } as const;

/** A try at the map: how many steps show, and how the next step's name may set. */
interface Try {
  k: number;
  /** The next step's name: at most this many lines, at this size. */
  lines: 2 | 3;
  size: 32 | 26;
  /** The next free stretch is a station. */
  free: boolean;
  /** The next step's name may run on over "N more"'s room above the rail (rungs 3–6). */
  over: boolean;
  rung: StripMapRung;
}

export function layoutStripMap(input: StripMapInput): StripMapDrawing {
  const { marks, now, measure: tw, x0, x1 } = input;
  const portrait = input.portrait ?? null;
  const ttWords = input.toTableWords ?? COOK_COPY.toTheTable;
  const ttWidest = input.toTableWidest ?? input.toTable;
  const hand = marks.find((m) => m.state === "in-hand") ?? null;
  const after = marks.filter((m) => m.state === "ahead").sort((a, b) => a.start - b.start || a.screen - b.screen);
  const handsOn = unionOf(marks.filter((m) => !m.pot).map((m) => [m.start, m.end] as Interval));
  const names = new Map(after.map((m) => [m.key, input.name(m)]));
  const sheetTop = -(portrait ? SHEET1_ABOVE_LINE.portrait : SHEET1_ABOVE_LINE.landscape);
  const kMax = Math.min(SHOWN, after.length);

  // The chain (SPEC §10, call 6): later steps join "N more", last first; in portrait the next
  // step's name, at 32 on its 2 lines, may then run on over "N more"'s room above the rail, the
  // next free stretch joins away, the name drops to 26 (still 2 lines), and last it takes 3 lines
  // at 26, kept only where its words clear the header (the map's own checks).
  const tries: Try[] = [{ k: kMax, lines: 2, size: 32, free: true, over: false, rung: 1 }];
  for (let k = kMax - 1; k >= 1; k--) tries.push({ k, lines: 2, size: 32, free: true, over: false, rung: 2 });
  if (portrait && kMax >= 1) {
    tries.push({ k: 1, lines: 2, size: 32, free: true, over: true, rung: 3 });
    tries.push({ k: 1, lines: 2, size: 32, free: false, over: true, rung: 4 });
    tries.push({ k: 1, lines: 2, size: 26, free: false, over: true, rung: 5 });
    tries.push({ k: 1, lines: 3, size: 26, free: false, over: true, rung: 6 });
  }
  // The widest count of each wait, by its end: the same for every rung.
  const untilWidest = new Map<number, number>();
  let last: StripMapDrawing | null = null;
  for (const t of tries) {
    const d = build(t);
    if (d.fits) return d;
    last = d;
  }
  return { ...last!, rung: 7 };

  function build(t: Try): StripMapDrawing {
    const sizeOf = (big: boolean) => (big ? t.size : 24);
    const linesOf = (big: boolean) => (big ? t.lines : 2);
    const minW = (big: boolean, start: number) =>
      Math.max(tw("in 00 min", big ? 26 : 22, big ? 600 : 500), tw(inWords(start, now), big ? 26 : 22, big ? 600 : 500));
    // At least as wide as its name set on its lines (its longest word, or wider where the name has
    // more words than its lines hold at that width), or its minutes, plus 30.
    // Rungs 3–6: the next step's name may run on over "N more", so its station needs only its minutes.
    const needOf = (m: StripMark, big: boolean) =>
      Math.max(big && t.over ? 0 : fewLineWidth(names.get(m.key)!, sizeOf(big), linesOf(big), tw), minW(big, m.start)) + 30;

    const shown = after.slice(0, t.k);
    const rest = after.slice(t.k);
    const items: Item[] = [{ kind: "now" }];
    if (hand?.pot) {
      const until = shown[0] ? shown[0].start : hand.end;
      const minutes = Math.round(until - now);
      if (minutes >= 1) items.push({ kind: "wait", minutes, until });
    }
    shown.forEach((m, i) => items.push({ kind: "step", m, big: i === 0 }));
    const lastShown = shown[shown.length - 1];
    const free = t.free ? freeAfter(handsOn, lastShown ? Math.max(lastShown.end, now) : now, input.total) : null;
    // The next free stretch, if it comes before the hidden steps: in time order, so before "N more" (call 4).
    if (free && (!rest.length || rest[0].start >= free[1] - 1e-6)) items.push({ kind: "wait", minutes: Math.round(free[1] - free[0]), until: null });
    if (rest.length) items.push({ kind: "more", n: rest.length });
    items.push({ kind: "plate" });

    // The wait the cook is in counts down while the map holds: its room is its widest count's,
    // worked out once per layout (a long wait counts through many minutes).
    const waitW = (it: Extract<Item, { kind: "wait" }>) => {
      if (it.until === null) return tw(fmtMinutes(it.minutes), 30, 400, "display");
      let w = untilWidest.get(it.until);
      if (w === undefined) {
        w = 0;
        for (const x of untilCountdown(it.until, now)) w = Math.max(w, tw(x, 30, 400, "display"));
        untilWidest.set(it.until, w);
      }
      return w;
    };
    const want = (it: Item) => (it.kind === "now" ? 64 : it.kind === "wait" ? waitW(it) + 48 : it.kind === "more" ? 96 : 0);
    // The plate's room: its ring, or in landscape the time to the table it carries.
    const plateRoom = portrait ? 40 : Math.max(tw(ttWidest, TT_NUM, 400, "display"), ttWords ? tw(ttWords, TT_WORDS, 500) : 0) + 24;
    const room = x1 - x0 - 30 - items.reduce((s, it) => s + want(it), 0) - plateRoom;
    const st = items.filter((it): it is Extract<Item, { kind: "step" }> => it.kind === "step");
    const wt = (it: Extract<Item, { kind: "step" }>) => (it.big ? 1.4 : 1);
    const need = new Map(st.map((it) => [it, needOf(it.m, it.big)]));
    let unit = room / Math.max(1e-6, st.reduce((s, it) => s + wt(it), 0));
    for (let pass = 0; pass < 3; pass++) {
      const open = st.filter((it) => !(need.get(it)! > unit * wt(it)));
      const left = room - st.filter((it) => need.get(it)! > unit * wt(it)).reduce((s, it) => s + need.get(it)!, 0);
      if (open.length) unit = left / open.reduce((s, it) => s + wt(it), 0);
    }
    const widthOf = (it: Item) => (it.kind === "step" ? Math.max(need.get(it)!, unit * wt(it)) : it.kind === "plate" ? plateRoom : want(it));

    const stations: Station[] = [];
    const out: SmMark[] = [];
    const words: SmWord[] = [];
    let x = x0 + 11;
    const keyOf = (it: Item) =>
      it.kind === "step" ? it.m.key : it.kind === "wait" ? (it.until !== null ? "wait" : "free") : it.kind === "more" ? "more" : it.kind === "now" ? "now" : "plate";
    for (const it of items) {
      const cx = it.kind === "plate" ? x1 - 17 : x;
      const w = widthOf(it);
      stations.push({
        key: keyOf(it),
        kind: it.kind,
        x: cx,
        w,
        need: it.kind === "step" ? need.get(it)! : 0,
        ...(it.kind === "step" ? { big: it.big } : {}),
        ...(it.kind === "more" ? { n: it.n } : {}),
      });
      x += w;
    }
    // Where the stations run to: the plate's room starts here.
    const runEnd = x;

    const word = (wd: Omit<SmWord, "w" | "h" | "lh"> & { w?: number; lh?: number }): void => {
      const lh = wd.lh ?? wd.size * 1.2;
      const w = wd.w ?? Math.max(...wd.lines.map((l) => tw(l, wd.size, wd.weight, wd.family)));
      const left = wd.align === "left" ? wd.x : wd.align === "center" ? wd.x - w / 2 : wd.x - w;
      words.push({ ...wd, x: left, w, lh, h: wd.lines.length * lh });
    };
    let prevStart: number | null = null;
    let cut = false;
    stations.forEach((s, i) => {
      const it = items[i];
      const cx = s.x;
      if (it.kind === "now") {
        out.push({ k: "now", station: s.key, role: "now-dot", x: cx - 11, y: -11, w: 22, h: 22 });
        word({ k: "now:w", station: s.key, role: "now", x: cx - 11, y: 22, lines: [COOK_COPY.stripNow], size: 22, weight: 600, family: "text", tone: "ink", align: "left" });
      } else if (it.kind === "wait") {
        const mx = cx + s.w / 2 - 10;
        out.push({ k: `${s.key}:gap`, station: s.key, role: "gap", x: mx - 15, y: -14, w: 30, h: 28 });
        out.push({ k: `${s.key}:slash`, station: s.key, role: "slash", x: mx - 14, y: -16, w: 28, h: 32 });
        word({
          k: `${s.key}:m`,
          station: s.key,
          role: "wait-minutes",
          x: mx,
          y: -62,
          lines: [it.until !== null ? untilWords(it.until, now) : fmtMinutes(it.minutes)],
          w: waitW(it),
          size: 30,
          weight: 400,
          family: "display",
          tone: "ink",
          align: "center",
          lh: 33,
          ...(it.until !== null ? { live: { kind: "until" as const, at: it.until } } : {}),
        });
        word({ k: `${s.key}:f`, station: s.key, role: "free", x: mx, y: 22, lines: [COOK_COPY.freeField.word], size: 22, weight: 500, family: "text", tone: "soft", align: "center" });
      } else if (it.kind === "step") {
        const big = it.big;
        const d = big ? 13 : 9;
        const size = sizeOf(big);
        const lh = size * 1.08;
        // Rungs 3–6: its room runs on over the "N more" station after it (above the rail, nothing else is there).
        const nextUp = big && t.over && items[i + 1]?.kind === "more" ? stations[i + 1].w : 0;
        const roomW = s.w - 22 + nextUp;
        const lines = wrap(names.get(it.m.key)!, size, roomW, tw);
        // Its box is its words as set; a name past its lines, or a word past its room, doesn't fit.
        if (lines.length > linesOf(big) || lines.some((ln) => tw(ln, size, 600) > roomW + 0.5)) cut = true;
        out.push(
          big
            ? { k: `${s.key}:dot`, station: s.key, role: "dot", x: cx - d, y: -d, w: 2 * d, h: 2 * d }
            : { k: `${s.key}:dot`, station: s.key, role: "open-dot", x: cx - d, y: -d, w: 2 * d, h: 2 * d, ring: 3.5 },
        );
        word({ k: `${s.key}:l`, station: s.key, role: "label", x: cx - d, y: -24 - lines.length * lh, lines, size, weight: 600, family: "text", tone: "ink", align: "left", lh });
        const afterWait = items[i - 1]?.kind === "wait";
        // A step's minutes print once: one starting with the step before it says nothing more.
        if (!afterWait && it.m.start !== prevStart) {
          word({
            k: `${s.key}:m`,
            station: s.key,
            role: "minutes",
            x: cx - d,
            y: 22,
            lines: [inWords(it.m.start, now)],
            size: big ? 26 : 22,
            weight: big ? 600 : 500,
            family: "text",
            tone: big ? "ink" : "soft",
            align: "left",
            live: { kind: "in", at: it.m.start },
          });
        }
        prevStart = it.m.start;
      } else if (it.kind === "more") {
        out.push({ k: "more:gap", station: s.key, role: "gap", x: cx + 6, y: -6, w: 70, h: 12 });
        [18, 38, 58].forEach((dd, j) => out.push({ k: `more:${j}`, station: s.key, role: "more-dot", x: cx + dd - 4, y: -4, w: 8, h: 8 }));
        word({ k: "more:w", station: s.key, role: "more", x: cx + 38, y: 22, lines: [COOK_COPY.stripMore(it.n)], size: 22, weight: 500, family: "text", tone: "soft", align: "center" });
      } else {
        out.push({ k: "plate", station: s.key, role: "plate", x: cx - 17, y: -17, w: 34, h: 34, ring: 5 });
        if (portrait) {
          // Portrait: the sheet's top right, level 2's header spot and sizes, so 1→2 moves it nowhere there.
          // As the header sets them: one block, its lines left-set at the block's left.
          const top = sheetTop + HEADER_TT.top;
          const left = portrait.ttRight - Math.max(tw(ttWidest, HEADER_TT.num, 400, "display"), ttWords ? tw(ttWords, HEADER_TT.words, 500) : 0);
          word({ k: "tt", station: s.key, role: "tt-num", x: left, y: top, lines: [input.toTable], w: tw(ttWidest, HEADER_TT.num, 400, "display"), size: HEADER_TT.num, weight: 400, family: "display", tone: "ink", align: "left", lh: HEADER_TT.num });
          if (ttWords)
            word({ k: "ttl", station: s.key, role: "tt-words", x: left, y: top + HEADER_TT.num, lines: [ttWords], size: HEADER_TT.words, weight: 500, family: "text", tone: "ink", align: "left", lh: HEADER_TT.words * HEADER_TT.wordsLh });
        } else {
          // Landscape: on the plate, keyed as level 2's header: the sheet draws it, and it travels there.
          word({ k: "tt", station: s.key, role: "tt-num", x: cx + 17, y: -76, lines: [input.toTable], w: tw(ttWidest, TT_NUM, 400, "display"), size: TT_NUM, weight: 400, family: "display", tone: "ink", align: "right", lh: TT_NUM });
          if (ttWords)
            word({ k: "ttl", station: s.key, role: "tt-words", x: cx + 17, y: 24, lines: [ttWords], size: TT_WORDS, weight: 500, family: "text", tone: "ink", align: "right", lh: TT_WORDS * 1.15 });
        }
      }
    });
    const drawing: StripMapDrawing = { stations, marks: out, words, rail: { x0: stations[0].x, x1: stations[stations.length - 1].x }, rung: t.rung, fits: false, ttAt: portrait ? "header" : "plate" };
    drawing.fits = !cut && runEnd <= x1 - 19 + 0.5 && stripMapBreaches(drawing, { x0, x1, sheetTop, measure: tw }).length === 0;
    return drawing;
  }
}

type Box = { x: number; y: number; w: number; h: number };
const overBox = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;

/** The map's own checks, in real geometry: every word on the map, under the grabber, over the foot, inside its box, and over no other. */
export function stripMapBreaches(d: StripMapDrawing, at: { x0: number; x1: number; sheetTop: number; measure: Measure }): string[] {
  const out: string[] = [];
  const top = at.sheetTop + 24;
  const over = overBox;
  for (const w of d.words) {
    const header = d.ttAt === "header" && (w.role === "tt-num" || w.role === "tt-words");
    if (w.size < 22 - 1e-6) out.push(`${w.k} at ${w.size}`);
    if (w.x < at.x0 - 4 - 1e-6 || w.x + w.w > at.x1 + 1e-6) out.push(`${w.k} off the map ${w.x.toFixed(1)}–${(w.x + w.w).toFixed(1)}`);
    if (!header && w.y < top - 1e-6) out.push(`${w.k} under the grabber at ${w.y.toFixed(1)}`);
    if (w.y + w.h > LINE_FROM_FOOT + 1e-6) out.push(`${w.k} under the foot at ${(w.y + w.h).toFixed(1)}`);
    for (const ln of w.lines) if (at.measure(ln, w.size, w.weight, w.family) > w.w + 0.5) out.push(`${w.k} "${ln}" wider than its box`);
  }
  for (let i = 0; i < d.words.length; i++) for (let j = i + 1; j < d.words.length; j++) if (over(d.words[i], d.words[j])) out.push(`${d.words[i].k} over ${d.words[j].k}`);
  // Words over a mark: a dot, the ring, "N more"'s dots or a wait's slash.
  for (const w of d.words) for (const m of d.marks) if (overBox(w, m)) out.push(`${w.k} over ${m.k}`);
  return out;
}

/**
 * The narrowest a name sets in `lines` lines at most, at `size`/600: the narrowest run of its
 * words whose width, as the line's room, wraps the name in that many lines (its longest word, or
 * wider where the name has more words than its lines hold at that width).
 */
export function fewLineWidth(text: string, size: number, lines: number, tw: Measure): number {
  const w = text.split(/\s+/).filter(Boolean);
  const widths: number[] = [];
  for (let a = 0; a < w.length; a++) for (let b = a + 1; b <= w.length; b++) widths.push(tw(w.slice(a, b).join(" "), size, 600));
  widths.sort((p, q) => p - q);
  // Never narrower than its longest word: `wrap` stands a word wider than its room alone.
  const longest = Math.max(...w.map((x) => tw(x, size, 600)));
  for (const c of widths) if (c >= longest && wrap(text, size, c, tw).length <= lines) return c;
  return tw(w.join(" "), size, 600);
}

/** A name in lines no wider than `room` at `size`/600: a word wider than that stands alone. */
function wrap(text: string, size: number, room: number, tw: Measure): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const nx = line ? `${line} ${w}` : w;
    if (line && tw(nx, size, 600) > room) {
      lines.push(line);
      line = w;
    } else line = nx;
  }
  if (line) lines.push(line);
  return lines;
}
