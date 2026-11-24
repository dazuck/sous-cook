/**
 * The whole meal as lines and stations (look-ahead slice 2; 2026-11-22,
 * DECISIONS "The whole meal is drawn as lines and stations…"; the approved
 * prototype's `linesTry`): what the
 * sheet's whole cook and the opening draw, before any measuring.
 *
 * - One column per dish (the plan's `branch`), named at its head. On each, the
 *   dish's stops in cook order: a job for the hands (a filled dot), or where
 *   something goes in to cook (a hollow dot, said with its verb: "roasts",
 *   "oven heats"), the line drawn heavy while it cooks.
 * - Breaks (`Strip.stretches[].free`): ruled gaps across the board, on the
 *   compressed scale confirmed for the lanes (`breakRows`).
 * - A step two dishes share sits on both lines (`also`): derived from the
 *   plan's structure, not the step's name: the step needs a cook task of the
 *   other dish, and a later step of that dish needs it (its line runs through).
 * - The lines meet: a dish whose line ends where a later step needs it bends
 *   into that step (`joins`); the last step takes every line still open.
 * - Runs: hand jobs back to back on one dish, with no cooking or break between,
 *   which the layout may fold into one named stop ("Blend tahini", "then 9 more
 *   steps") when they cannot each keep a label.
 * - Where the cook stands: done work folds (`state` "done"), the step in hand is
 *   "now", a pot still cooking from before is "running".
 *
 * Everything is derived from what a stored plan carries (task `branch`,
 * `needs`, `kind`, `minutes`, `label`) through the strip's marks, so no plan
 * changes. Pure: no DOM, no measuring.
 */

import type { CookPlan } from "./cook-plan";
import type { Strip, StripMark } from "./cook-strip";
import { timeline } from "./cook-schedule";
import { phrase } from "./timetable-model";

/** The plan's catch-all strand: a column the plan never named as a dish. */
export const CATCH_ALL = "Cook";

/** The compressed scale (DECISIONS 2026-11-22, "Yes, keep these steps"): up to 5 minutes 1 row, 6 to 15 1.25, 16 to 30 1.6, longer 1.9. */
export function breakRows(minutes: number): number {
  if (minutes <= 5) return 1;
  if (minutes <= 15) return 1.25;
  if (minutes <= 30) return 1.6;
  return 1.9;
}

export type StopState = "done" | "now" | "running" | "ahead";

export interface LineStop {
  /** The strip mark's key (a prep card split across dishes is `${key}#${dish}`). */
  key: string;
  /** The mark's own key, what a read and Go go by. */
  mark: string;
  /** Where Go takes the cook. */
  screen: number;
  /** Its column, and any other column it sits on (a shared step). */
  col: number;
  also: number[];
  /** Columns whose lines end by bending into this stop. */
  joins: number[];
  /** Something that cooks by itself once it goes in. */
  pot: boolean;
  /** The step's own words, capitalised: what a list row and a read say. */
  label: string;
  /** What the stop says on its line: the label for hands, the cooking verb for a pot ("roasts", "oven heats"). */
  words: string;
  /** Its minutes as the line says them: null for a pot a break already counts. */
  minutes: number | null;
  /** The step's minutes, always (a list row's column). */
  span: number;
  start: number;
  end: number;
  state: StopState;
  /** Up-front prep (a prep page's or the Prep screen's jobs). */
  prep: boolean;
}

export interface LineColumn {
  /** The dish as the plan names it. */
  dish: string;
  /** Its head's words; the catch-all strand has none. */
  name: string | null;
}

export interface LineBreak {
  /** The stretch it follows (`Strip.stretches`). */
  stretch: number;
  /** From when the hands come free (or now, inside it) to the next stretch's first start. */
  from: number;
  to: number;
  minutes: number;
  /** Its height on the compressed scale, in rows. */
  rows: number;
}

export interface LineRun {
  col: number;
  /** Its stops' keys, in order; the first names it. */
  keys: string[];
}

export interface MealLines {
  columns: LineColumn[];
  /** Every stop in cook order (done first, then running, then by start). */
  stops: LineStop[];
  breaks: LineBreak[];
  /** Runs of two or more that may fold. */
  runs: LineRun[];
  /** Whether the meal is one dish: drawn as a list in every shape. */
  oneDish: boolean;
  /** After the last break, how long the rest takes and how many dishes are going ("then the last 27 min: four things going"). */
  finish: { minutes: number; going: number; afterLong: boolean } | null;
  /** The clock's minute the drawing reads (a running pot counts down from it). */
  now: number;
  total: number;
}

const EPS = 1e-3;
/** A break this long or longer makes the finish read "then the last …". */
const LONG_BREAK = 20;

const capFirst = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const clean = (t: string) => t.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

/** Cooking verbs a pot says itself by (the drawing's list, and the plan's two-word ones). */
const COOK_VERBS = new Set([
  "roast", "simmer", "heat", "preheat", "rest", "boil", "broil", "crisp", "cook", "bake", "fry", "steam", "chill",
  "marinate", "soak", "rise", "proof", "braise", "toast", "reduce", "cool", "sear", "brown", "melt", "warm", "poach",
  "grill", "air fry", "drain", "temper", "brine", "dry-brine", "pickle", "stand", "char",
]);

/** The third person: "roast" → "roasts", "fry" → "fries", "air fry" → "air fries", "preheat" → "heats". */
function third(verb: string): string {
  const v = verb === "preheat" ? "heat" : verb;
  const parts = v.split(" ");
  const w = parts[parts.length - 1];
  const s = /(s|sh|ch|x|z)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`;
  return [...parts.slice(0, -1), s].join(" ");
}

/**
 * What a pot says on its dish's line: its verb alone, the prototype's short
 * form ("roasts", "heats", "boils"; DS v1.63), since the dish's name heads the
 * column and the stop sits on its line. The one exception is the oven: a bare
 * "heats" would not say what heats, so a pot that heats the oven says "oven
 * heats". A label with no cooking verb says "cooks".
 */
export function potWords(label: string, dish: string | null): string {
  const p = phrase(label, dish, true);
  if (!COOK_VERBS.has(p.verb)) return /\boven\b/i.test(label) ? "oven heats" : "cooks";
  const v = p.verb === "preheat" ? "heat" : p.verb;
  if (p.object.some((w) => /^ovens?$/i.test(w))) return "oven heats";
  return third(v);
}

/** The three-part input: the plan, its timed strip, and whether this is the opening (nothing in hand yet). */
export function mealLines(plan: CookPlan, s: Strip, opts: { opening?: boolean } = {}): MealLines {
  const opening = opts.opening === true;
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const dishOfTask = (id: string) => byId.get(id)?.branch || CATCH_ALL;
  const now = opening ? 0 : s.now;

  // Up-front prep: Prep first's pages (one mark per card) or As I go's "before you start" cards.
  // A card's jobs go to their own dishes' lines, so a card spanning dishes splits.
  const prepCards = (s.prepMarks ?? []).flatMap((m) => {
    const groups = new Map<string, string[]>();
    for (const id of m.tasks) {
      const d = dishOfTask(id);
      groups.set(d, [...(groups.get(d) ?? []), id]);
    }
    const split = groups.size > 1;
    return [...groups.entries()].map(([dish, ids]) => ({ m, dish, ids, key: split ? `${m.key}#${dish}` : m.key }));
  });
  const steps = s.marks.filter((m) => m.key !== "prep");

  const stateOf = (m: StripMark): StopState => {
    if (opening) return "ahead";
    if (m.state === "in-hand") return "now";
    if (m.state === "running") return "running";
    if (m.state === "done") return "done";
    return "ahead";
  };

  const frees = s.stretches.flatMap((st, k) => (st.free ? [{ stretch: k, ...st.free }] : []));
  const covered = (a: number, b: number) => frees.some((f) => f.from < b - EPS && f.to > a + EPS);

  interface Draft extends Omit<LineStop, "col" | "also" | "joins"> {
    dish: string;
    after: string[];
    order: number;
  }
  const drafts: Draft[] = [];
  for (const { m, dish, ids, key } of prepCards) {
    const labels = ids.map((id) => byId.get(id)?.label || "").filter(Boolean);
    const label = capFirst(clean(labels.join(", ") || m.label));
    const span = Math.max(1, Math.round(m.end - m.start));
    drafts.push({
      key, mark: m.key, screen: m.screen, dish, after: [], pot: false, label, words: label,
      minutes: span, span, start: m.start, end: m.end, state: stateOf(m), prep: true, order: drafts.length,
    });
  }
  for (const m of steps) {
    const dish = m.strand || CATCH_ALL;
    const label = capFirst(clean(m.label));
    const span = Math.max(1, Math.round(m.end - m.start));
    drafts.push({
      key: m.key, mark: m.key, screen: m.screen, dish, after: m.after ?? [], pot: m.pot, label,
      words: m.pot ? potWords(m.label, dish === CATCH_ALL ? null : dish) : label,
      minutes: m.pot && covered(m.start, m.end) ? null : span,
      span, start: m.start, end: m.end, state: stateOf(m), prep: false, order: drafts.length,
    });
  }

  // Cook order: done, then running, then the rest by start (prep before a step starting with it).
  const rank = (d: Draft) => (d.state === "done" ? 0 : d.state === "running" ? 1 : 2);
  drafts.sort((a, b) => rank(a) - rank(b) || a.start - b.start || Number(b.prep) - Number(a.prep) || a.screen - b.screen || a.order - b.order);

  // Columns: in the order each dish first goes on the heat in the Prep first schedule (ties in plan order), so
  // they hold still when the prep mode changes; dishes never cooked (a slaw tossed, a dressing made) after, in
  // plan order.
  const present = new Set(drafts.map((d) => d.dish));
  const firstCook = new Map<string, number>();
  for (const sl of timeline(plan, "first", new Set()).slots) {
    if (sl.task.kind !== "cook") continue;
    const d = sl.task.branch || CATCH_ALL;
    if (!firstCook.has(d) || sl.start < firstCook.get(d)!) firstCook.set(d, sl.start);
  }
  const planAt = new Map<string, number>();
  plan.tasks.forEach((t, i) => {
    const d = t.branch || CATCH_ALL;
    if (!planAt.has(d)) planAt.set(d, i);
  });
  const order = [...present].sort((x, y) => {
    const fx = firstCook.get(x) ?? Infinity;
    const fy = firstCook.get(y) ?? Infinity;
    return fx - fy || (planAt.get(x) ?? 0) - (planAt.get(y) ?? 0);
  });
  const dishes = order;
  const colOf = new Map(dishes.map((d, i) => [d, i]));
  const columns: LineColumn[] = dishes.map((d) => ({ dish: d, name: d === CATCH_ALL ? null : d }));

  const stops: LineStop[] = drafts.map((d) => ({
    key: d.key, mark: d.mark, screen: d.screen, col: colOf.get(d.dish)!, also: [], joins: [], pot: d.pot, label: d.label,
    words: d.words, minutes: d.minutes, span: d.span, start: d.start, end: d.end, state: d.state, prep: d.prep,
  }));
  const afterOf = new Map(drafts.map((d) => [d.key, d.after]));
  const indexOf = new Map(stops.map((q, i) => [q.key, i]));
  const colOfKey = (k: string) => {
    const i = indexOf.get(k);
    return i === undefined ? undefined : stops[i].col;
  };

  // Shared steps: a step needing a cook task of another dish whose later step needs it.
  stops.forEach((q, i) => {
    if (q.prep) return;
    const needsFrom = new Set((afterOf.get(q.key) ?? []).map(colOfKey).filter((c): c is number => c !== undefined && c !== q.col));
    for (const c of needsFrom) {
      // The meal's last step needs everything: needing this one there is the lines meeting, not a share.
      const through = stops.some((o, j) => j > i && j < stops.length - 1 && o.col === c && (afterOf.get(o.key) ?? []).includes(q.key));
      if (through) q.also.push(c);
    }
    q.also.sort((a, b) => a - b);
  });

  // Joins: a dish whose line ends where a later step needs it bends into that step.
  const lastOf = (c: number) => {
    for (let j = stops.length - 1; j >= 0; j--) if (stops[j].col === c || stops[j].also.includes(c)) return j;
    return -1;
  };
  const joined = new Set<number>();
  stops.forEach((q, i) => {
    if (q.prep) return;
    for (const k of afterOf.get(q.key) ?? []) {
      const c = colOfKey(k);
      if (c === undefined || c === q.col || q.also.includes(c) || joined.has(c)) continue;
      if (lastOf(c) < i) {
        q.joins.push(c);
        joined.add(c);
      }
    }
  });
  // The last step takes every line still open: the lines meet at the end.
  const last = stops[stops.length - 1];
  if (last && columns.length > 1) {
    const li = stops.length - 1;
    for (let c = 0; c < columns.length; c++) {
      if (c === last.col || last.also.includes(c) || joined.has(c)) continue;
      if (lastOf(c) < li) {
        last.joins.push(c);
        joined.add(c);
      }
    }
  }
  stops.forEach((q) => q.joins.sort((a, b) => a - b));
  // Where the lines meet, the step says itself in full ("Rest and serve", not "rests"), under the bar.
  if (last && last.joins.length > 0) last.words = last.label;

  // Breaks still to come (or the part of one the cook is in).
  const breaks: LineBreak[] = frees
    .map((f) => {
      const from = Math.max(f.from, now);
      const minutes = f.from >= now ? f.minutes : Math.max(1, Math.floor(f.to - now));
      return { stretch: f.stretch, from, to: f.to, minutes, rows: breakRows(minutes) };
    })
    .filter((b) => b.to - b.from > EPS);

  const runs = runsOf(stops, columns.length, breaks, 0);

  // After the last break: how long, and how many dishes are going.
  const lastFree = frees[frees.length - 1];
  let finish: MealLines["finish"] = null;
  if (lastFree && lastFree.to > now) {
    const going = new Set(stops.filter((q) => q.state !== "done" && q.end > lastFree.to + EPS).flatMap((q) => [q.col, ...q.also]));
    finish = { minutes: Math.max(1, Math.round(s.totalMinutes - lastFree.to)), going: going.size, afterLong: frees.some((f) => f.minutes >= LONG_BREAK) };
  }

  return {
    columns,
    stops,
    breaks,
    runs: runs.filter((r) => r.keys.length > 1),
    oneDish: columns.length <= 1,
    finish,
    now,
    total: s.totalMinutes,
  };
}

/**
 * Runs: jobs back to back on one dish, none in hand, shared or joined, with no break between, and
 * no cooking between unless it is shorter than `potUnder` minutes (the fit ladder's last level,
 * where a short pot joins the run it is part of, as the prototype's coarsest level). Every run is
 * returned, a lone stop included; a run of one never folds.
 */
export function runsOf(stops: LineStop[], columns: number, breaks: LineBreak[], potUnder: number): LineRun[] {
  const runs: LineRun[] = [];
  for (let c = 0; c < columns; c++) {
    let cur: LineStop[] | null = null;
    for (const q of stops) {
      if (q.state === "done" || q.state === "running") continue;
      if (q.col !== c) {
        if (q.also.includes(c)) cur = null;
        continue;
      }
      const short = q.pot && q.end - q.start < potUnder;
      const foldable = (!q.pot || short) && q.state === "ahead" && q.also.length === 0 && q.joins.length === 0;
      if (!foldable) {
        cur = null;
        continue;
      }
      const prev = cur ? cur[cur.length - 1] : null;
      // A break between them starts after `prev` begins and before `q` does: one starting as `q` goes in
      // (a short pot opening it) follows `q`, so `q` still joins the run.
      const breakBetween = prev ? breaks.some((b) => b.from >= prev.start - EPS && b.from < q.start - EPS) : true;
      if (prev && !breakBetween) cur!.push(q);
      else {
        cur = [q];
        runs.push({ col: c, keys: [] });
      }
      runs[runs.length - 1].keys = cur!.map((x) => x.key);
    }
  }
  return runs;
}
