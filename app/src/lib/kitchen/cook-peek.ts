/**
 * The peek: the first pull of the bottom strip (look-ahead slice 1, DS v1.62;
 * 2026-11-22, the approved drawing's `queue` and `rowsLayout`). What a cook reads with a hand free: the step
 * in hand, then the steps up to the next time the hands come free, then one
 * ruled row for that break ("then 50 min free while it roasts") or for the
 * table. No headings. Nothing is counted twice: a pot the break covers shows no
 * minutes of its own, since the break says how long it is.
 *
 * - Up to three steps after the one in hand are all shown; past three, two
 *   are, and the ruled row leads with how many more ("6 more steps, then …").
 * - With at most one step before the break, "after that: Check chicken" says
 *   what the cook comes back to.
 * - As written (no minutes) there are no minutes and no breaks, and the table
 *   row has no time.
 *
 * Pure: the screens are the cook view's (`screensOf`), timed and cut by the
 * strip (`Strip.stretches`), so the peek, the line and the eyebrow say one
 * figure for each break.
 */

import { durationText } from "./time-line";
import { chartState, screensOf, stepKey, COOK_COPY, type CookState } from "./cook-view";
import { isPot } from "./cook-schedule";
import { toTableSaid, type Strip } from "./cook-strip";
import type { CookPlan } from "./cook-plan";

/** One screen as the peek reads it. */
export interface PeekScreen {
  key: string;
  label: string;
  /** The dish, or null where it would say nothing (one dish, or the plan's catch-all). */
  dish: string | null;
  start: number;
  end: number;
  /** Something that cooks by itself once it goes in. */
  pot: boolean;
  /** Its stretch (`Strip.stretches`), or null for prep. */
  stretch: number | null;
}

/** A break after a stretch, in plan minutes, and its minutes as said (rounded down to 5). */
export interface PeekFree {
  stretch: number;
  from: number;
  to: number;
  minutes: number;
}

export type PeekRow =
  | { kind: "step"; key: string; label: string; dish: string | null; minutes: number | null; pot: boolean; now: boolean }
  | { kind: "break"; more: number; minutes: number; verb: string | null }
  | { kind: "table"; more: number; minutes: number | null }
  | { kind: "after"; key: string; label: string };

export interface PeekInput {
  screens: readonly PeekScreen[];
  /** The screen in hand. */
  at: number;
  frees: readonly PeekFree[];
  /** Minutes to the table from the clock's minute; null as written. */
  toTable: number | null;
  asWritten: boolean;
}

/** Past this many steps before the break, the peek shows one fewer and folds the rest. */
export const PEEK_MAX_NEXT = 3;

/** Verbs that say what a pot is doing while the cook is free (the drawing's list). */
const COOK_VERBS = new Set([
  "roast", "simmer", "heat", "preheat", "rest", "boil", "broil", "crisp", "cook", "bake", "fry", "steam", "chill",
  "marinate", "soak", "rise", "proof", "braise", "toast", "reduce", "cool", "sear", "brown", "melt", "warm", "poach", "grill",
]);

/** "roast chicken" → "roasts"; a label with no cooking verb in it → "cooks". */
export function cookVerb(label: string): string {
  const w = label.toLowerCase().split(/[^a-z]+/).find((x) => COOK_VERBS.has(x));
  if (!w) return "cooks";
  if (/(s|sh|ch|x)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

const EPS = 1e-3;

/**
 * `limit`: the most steps after the one in hand the peek shows before it folds (3, the drawing's).
 * Past it, one fewer than the limit are shown and the ruled row counts the rest; a peek too tall for
 * its screen is laid again with a lower limit (`layoutPeek`).
 */
export function peekRows(input: PeekInput, limit = PEEK_MAX_NEXT): PeekRow[] {
  const { screens, at, frees, toTable, asWritten } = input;
  const cur = screens[at];
  if (!cur) return [];
  const freeAfter = (stretch: number | null) => (stretch === null ? undefined : frees.find((f) => f.stretch === stretch));

  // The steps after the one in hand, up to the next break (a change of stretch with a break after the old one).
  const next: number[] = [];
  let brk: PeekFree | undefined;
  let stretch = cur.stretch;
  let i = at + 1;
  for (; i < screens.length; i++) {
    const s = screens[i];
    if (s.stretch !== stretch) {
      const f = freeAfter(stretch);
      if (f) {
        brk = f;
        break;
      }
      stretch = s.stretch;
    }
    next.push(i);
  }
  const after = brk ? screens[i] : undefined;

  // A pot whose cooking a break covers shows no minutes: the break counts that wait.
  const counted = (s: PeekScreen) => s.pot && frees.some((f) => f.from < s.end - EPS && f.to > s.start + EPS);
  const stepRow = (k: number, now: boolean): PeekRow => {
    const s = screens[k];
    return {
      kind: "step",
      key: s.key,
      label: s.label,
      dish: s.dish,
      // A screen with no minutes at all (As I go's Prep with nothing before the start) shows none.
      minutes: asWritten || counted(s) || s.end <= s.start ? null : Math.max(1, Math.round(s.end - s.start)),
      pot: s.pot,
      now,
    };
  };

  const shown = next.length <= limit ? next : next.slice(0, Math.max(0, limit - 1));
  const more = next.length - shown.length;
  const rows: PeekRow[] = [stepRow(at, true), ...shown.map((k) => stepRow(k, false))];

  if (brk) {
    // The pot going in as the hands come free names the break: the last such in cook order.
    const going = screens.filter((s) => s.pot && s.start <= brk.from + EPS && s.end > brk.from + EPS).pop();
    rows.push({ kind: "break", more, minutes: brk.minutes, verb: going ? cookVerb(going.label) : null });
    // Folded all the way (limit 0) the peek is the step in hand and its ruled row alone.
    if (limit > 0 && next.length <= 1 && after) rows.push({ kind: "after", key: after.key, label: after.label });
  } else {
    rows.push({ kind: "table", more, minutes: asWritten || toTable === null ? null : Math.max(toTable, EPS) });
  }
  return rows;
}

/** The ruled row's lead: "then", or how many more steps and then. */
const lead = (more: number) => (more > 0 ? COOK_COPY.peekMore(more) : COOK_COPY.peekThen);

/** A ruled row's words, in its three parts (the middle one carries the weight). */
export function ruledWords(row: Extract<PeekRow, { kind: "break" | "table" }>): { lead: string; main: string; tail: string | null } {
  if (row.kind === "break") return { lead: lead(row.more), main: COOK_COPY.peekFree(row.minutes), tail: row.verb ? COOK_COPY.peekWhile(row.verb) : null };
  return { lead: lead(row.more), main: COOK_COPY.peekTable, tail: row.minutes === null ? null : COOK_COPY.peekIn(toTableSaid(row.minutes)) };
}

/** One row as one line: what a screen reader hears, and what the tests read (● hands, ○ goes in to cook). */
export function peekWords(row: PeekRow): string {
  switch (row.kind) {
    case "step":
      return [`${row.pot ? "○" : "●"} ${row.label}`, row.dish, row.minutes === null ? null : durationText(row.minutes)].filter(Boolean).join(" · ");
    case "break":
    case "table": {
      const w = ruledWords(row);
      return [w.lead, w.main, w.tail].filter(Boolean).join(" ");
    }
    case "after":
      return COOK_COPY.peekAfter(row.label);
  }
}

const capFirst = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const stripParens = (t: string) => t.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

/** The plan's catch-all strand: never named as a dish (as prep's eyebrow, DS v1.59). */
const CATCH_ALL = "Cook";

/**
 * The peek's input for the cook in hand: the cook view's screens, timed and cut by the strip.
 * The screens are counted on the state the strip reads (`chartState`): on As I go's Prep, the cook
 * as they will stand on leaving, the mise ticked and the steps recut, so each mark's screen is the
 * peek's screen of the same step and the rows after Prep are the steps the cook steps into.
 */
export function peekOf(plan: CookPlan, state: CookState, s: Strip): PeekInput {
  const read = chartState(plan, state);
  const screens = screensOf(plan, read.mode, read.ticked);
  const marks = new Map(s.marks.filter((m) => m.key !== "prep").map((m) => [m.screen, m]));
  const stretchOf = new Map<number, number>();
  s.stretches.forEach((st, k) => st.screens.forEach((sc) => stretchOf.set(sc, k)));
  const prep = s.marks.find((m) => m.key === "prep");
  const strands = new Set(
    screens.flatMap((sc) => (sc.kind === "step" ? sc.item.tasks.map((t) => t.branch ?? CATCH_ALL) : [])),
  );
  const multi = strands.size > 1;
  const peekScreens: PeekScreen[] = screens.map((sc, k) => {
    if (sc.kind === "prep") {
      return { key: "prep", label: COOK_COPY.prepChapter, dish: null, start: prep?.start ?? 0, end: prep?.end ?? 0, pot: false, stretch: null };
    }
    const item = sc.item;
    const strand = item.tasks[0]?.branch ?? CATCH_ALL;
    const mark = marks.get(k);
    return {
      key: stepKey(item),
      // As written a task's label is its first three words (`identityPlan`), a fragment
      // ("fry it gently"): the row shows the step's own words, as the recipe has them,
      // and the peek wraps and cuts them as it does any row.
      label: s.asWritten
        ? item.tasks.map((t) => t.text).join(" ")
        : capFirst(stripParens(item.tasks.map((t) => t.label || t.text).join(", "))),
      dish: multi && strand !== CATCH_ALL ? strand : null,
      start: mark?.start ?? item.start,
      end: mark?.end ?? item.end,
      pot: isPot(item),
      stretch: stretchOf.get(k) ?? null,
    };
  });
  const frees: PeekFree[] = s.stretches.flatMap((st, k) => (st.free ? [{ stretch: k, ...st.free }] : []));
  return {
    screens: peekScreens,
    at: state.pos,
    frees,
    toTable: s.asWritten ? null : s.totalMinutes - s.now,
    asWritten: s.asWritten,
  };
}
