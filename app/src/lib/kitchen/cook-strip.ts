/**
 * The cook strip: the bottom look-ahead progress strip and schedule derivation (P58, N5, N6).
 *
 * Derived from timeline(), flow() and lanes().
 * Prep is the first mark (an ink block).
 * At rest at Now, the strip shows progress; pulled, it unfolds into the levels.
 */

import { COOK_COPY, cookNow, hasPrepScreen, isDone, prepPages, rowState, stepKey } from "./cook-view";
import { flow, isPot, prepFlow, timeline } from "./cook-schedule";
import { freeAfter, stretchesOf, type FreeTime } from "./cook-chapters";
import { lanes } from "./cook-lanes";
import type { CookPlan } from "./cook-plan";
import type { CookState } from "./cook-view";
import { durationText } from "./time-line";
import type { KitchenTimer } from "./timers";
import type { CookTimers } from "@/components/kitchen/CookFlow";

export type MarkState = "done" | "in-hand" | "running" | "ahead";

export interface StripMark {
  /** Task key or unique identifier for the mark (e.g. stepKey or "prep"). */
  key: string;
  /**
   * Screen position in CookState.pos. Prep's is the Prep screen; in "Prep
   * first", where the prep is step pages (DS v1.59), the page in hand, else
   * the first page with a job not done, else the first page. A prep card's
   * (`prepMarks`) is the Prep screen, or in "Prep first" its first page.
   */
  screen: number;
  /** Strand / branch name. Prep is COOK_COPY.prepChapter. */
  strand: string;
  /** Label for display. */
  label: string;
  /** Start time in minutes. */
  start: number;
  /** End time in minutes. */
  end: number;
  /** Whether the step minds itself (hands-off / pot). */
  pot: boolean;
  /** Whether every slot under it is nominal. */
  nominal: boolean;
  /** State of the mark for current cook position and time. */
  state: MarkState;
  /** Revisit state on Prep screen. */
  revisit?: boolean;
  /**
   * The stretch the step belongs to (an index into `Strip.stretches`); null for
   * Prep and as written (N2).
   */
  stretch: number | null;
  /**
   * Every task under it ticked (`isDone`): the cook's record, which `state`
   * hides under "running" while a pot still minds itself (slice N3).
   */
  done: boolean;
  /** Its tasks' ids: Prep's mise, or the step's tasks (slice N3, for its timer). */
  tasks: string[];
  /**
   * The step marks it waits on: the keys of the steps holding the cook tasks
   * its tasks need (mise, ahead and Prep don't count). Unset for Prep and as
   * written. A one-strand plan's pot keeps its chain in its lane by these.
   */
  after?: string[];
  /**
   * Whether a cook task is under it: false for a step of mise or ahead work
   * alone (As I go puts that in the cook's gaps). Unset for Prep and as
   * written. A one-strand plan's pot chain splits off only beside cook work.
   */
  cook?: boolean;
  /**
   * `lanes()`'s packed lane, where strands that never overlap share one
   * (slice N3's width rung); null for Prep and as written.
   */
  lane: number | null;
  /** Prep only: its mise not yet ticked, on the cook's own record (slice N3). */
  todo?: number;
}

/**
 * A run of steps up to a break of 10+ idle minutes (`stretchesOf`), on the
 * strip's own minutes (N2). `free` is the break after it: from when the
 * cook's hands come free to the next stretch's first start; null on the last.
 */
export interface StripStretch {
  /** Its steps' screens, in cook order. */
  screens: number[];
  free: FreeTime | null;
}

export interface StripRow {
  strand: string;
  marks: StripMark[];
}

export interface Strip {
  /** All marks in flow order, Prep first if present. */
  marks: StripMark[];
  /** Individual upfront prep marks in [0, prep.end] for the whole-cook overview, keyed identically to As I go. */
  prepMarks?: StripMark[];
  /** Marks packed into rows within each strand (first-fit packing). */
  rows: StripRow[];
  /** Current time in minutes (step start + elapsed timer minutes). */
  now: number;
  /**
   * Where the progress line's fill ends, in minutes: the end of the screen the cook is on, not its
   * start (`now`), so the last step reads full (asked 2026-11-22; DS v1.54). A step's end is
   * the minute the cook leaves its screen: its own end, or the next step's start when that comes
   * first (a pot still going past it), so the line never steps back as the cook steps on, and it
   * stands still while the step's timer runs. The last screen and a finished cook are the whole
   * line. On Prep it is the end of the up-front prep block, or `now` where the cook has none (As I
   * go) or has come back to Prep mid-cook. A prep page (Prep first) follows the step rule: its own
   * end, or the next page's start where that comes first (prep pages overlap on the clock: a
   * pickle stands while the next page's limes are cut); the last prep page is the end of the prep
   * block, the longest stand included.
   */
  progress: number;
  /** Total recipe cook time in minutes. */
  totalMinutes: number;
  /** Formatted time to table: "N min", "1 h", "Ready" at 0, or "N steps to go" as written. */
  timeToTable: string;
  /** Formatted hands-on time left, or null if <= 0. */
  handsOnLeft: string | null;
  /** Whether cooked as written (equal marks, one row, no axis). */
  asWritten: boolean;
  /** For as-written recipes: outline of step titles. */
  outline?: string[];
  /** The steps cut at their breaks (N2); empty as written. */
  stretches: StripStretch[];
  /** True when the plan has any mise tasks (so the Prep mode choice applies). */
  hasMise?: boolean;
  /** The cook's selected prep mode ("first" | "go"). */
  mode?: CookState["mode"];
  /** True when the cook is currently on the Prep screen (pos === 0). */
  onPrep?: boolean;
  /** True when the sequence opens on the Prep screen (`hasPrepScreen`): Prep's mark then reads in place as Prep, not as a step. */
  prepScreen?: boolean;
  /** True at the first screen, where the prep mode can still switch (`setMode`). */
  modeOpen?: boolean;
}

export interface MarkColors {
  base: string;
  ring?: string;
}

/**
 * Colors for a mark per state, obeying DS §1 (no hex outside tokens, no grey).
 */
/** The time to the table as said: rounded up to 5 minutes, "Ready" at 0. */
export function toTableSaid(minutesRemaining: number): string {
  return minutesRemaining <= 0 ? "Ready" : durationText(Math.ceil(minutesRemaining / 5) * 5);
}

/**
 * Everything the time to the table says from `minutesRemaining` down to "Ready" as the clock
 * counts (slice T3: the sheet holds its layout while the number counts down, so the number's box
 * is laid out for the widest of these).
 */
export function toTableCountdown(minutesRemaining: number): string[] {
  const out = [toTableSaid(minutesRemaining)];
  for (let m = Math.ceil(minutesRemaining / 5) * 5 - 5; m > 0; m -= 5) out.push(toTableSaid(m));
  if (minutesRemaining > 0) out.push("Ready");
  return out;
}

export function markColors(mark: StripMark, asWritten: boolean): MarkColors {
  if (mark.state === "in-hand") {
    return { base: "var(--ember)" };
  }
  if (asWritten) {
    return { base: "var(--ink)" };
  }
  if (mark.state === "done") {
    return { base: "var(--ink)" };
  }
  if (mark.pot) {
    const edge = mark.state === "ahead" ? "0.16" : "0.3";
    return {
      base: "var(--sand)",
      ring: `inset 0 0 0 1px color-mix(in oklab, var(--ink) ${Math.round(parseFloat(edge) * 100)}%, transparent)`,
    };
  }
  return { base: "var(--ink)" };
}

/**
 * Packs marks within a strand into rows using first-fit non-overlapping intervals.
 * Matches prototype packLanes row packing.
 */
export function packRows(marks: StripMark[]): StripRow[] {
  // If only one cooking strand exists, pack Prep into that same strand so one strand gets one row
  const cookStrands = new Set(
    marks.filter((m) => m.key !== "prep").map((m) => m.strand),
  );
  const singleCookStrand = cookStrands.size === 1 ? [...cookStrands][0] : null;

  // Group by strand, keeping strand order of first appearance
  const strandOrder: string[] = [];
  const byStrand = new Map<string, StripMark[]>();

  for (const m of marks) {
    const strand = m.key === "prep" && singleCookStrand ? singleCookStrand : m.strand;
    if (!byStrand.has(strand)) {
      strandOrder.push(strand);
      byStrand.set(strand, []);
    }
    byStrand.get(strand)!.push(m);
  }

  const result: StripRow[] = [];

  for (const strand of strandOrder) {
    const strandMarks = [...byStrand.get(strand)!].sort(
      (a, b) => a.start - b.start || a.screen - b.screen,
    );

    const rows: StripMark[][] = [];

    for (const m of strandMarks) {
      // Find first row where mark doesn't overlap any mark in that row
      let placed = false;
      for (const row of rows) {
        const overlaps = row.some(
          (existing) => m.start < existing.end && existing.start < m.end,
        );
        if (!overlaps) {
          row.push(m);
          placed = true;
          break;
        }
      }
      if (!placed) {
        rows.push([m]);
      }
    }

    for (const row of rows) {
      result.push({ strand, marks: row });
    }
  }

  return result;
}

/**
 * Checks if a recipe is cooked as written (no branches, identity plan or explicit asWritten).
 */
export function isAsWritten(plan: CookPlan): boolean {
  if (plan.tasks.length === 0) return true;
  return plan.tasks.every((t) => t.minutes === undefined);
}

/**
 * Builds the Strip representation for a plan, state, and optional running timers.
 */
export function strip(
  plan: CookPlan,
  state: CookState,
  timers?: readonly KitchenTimer[] | CookTimers | KitchenTimer | null,
  nowEpochMs: number = Date.now(),
): Strip {
  const asWritten = isAsWritten(plan);

  // If cooked as written, generate equal marks in one row and no axis
  if (asWritten) {
    const marks: StripMark[] = plan.tasks.map((task, idx) => {
      const screen = idx;
      let markState: MarkState = "ahead";
      if (screen < state.pos || isDone(state, task.id)) {
        markState = "done";
      } else if (screen === state.pos) {
        markState = "in-hand";
      }

      return {
        key: task.id,
        screen,
        strand: task.branch || "Cook",
        // As written the step's own words name it: its short label is a guess at its first words.
        label: task.text || task.label,
        start: idx * 2,
        end: (idx + 1) * 2,
        pot: false,
        nominal: true,
        state: markState,
        stretch: null,
        done: isDone(state, task.id),
        tasks: [task.id],
        lane: null,
      };
    });

    const stepsRemaining = marks.filter(
      (m) => m.state === "ahead" || m.state === "in-hand",
    ).length;

    const timeToTable =
      stepsRemaining === 0
        ? "Ready"
        : `${stepsRemaining} ${stepsRemaining === 1 ? "step" : "steps"} to go`;

    return {
      marks,
      rows: [{ strand: "Cook", marks }],
      now: state.pos * 2,
      // As written there is no line, only the equal bars (the step in hand is a whole bar in Ember);
      // the value is the end of that bar, for the one meaning everywhere.
      progress: Math.min(marks.length, state.pos + 1) * 2,
      totalMinutes: marks.length * 2,
      timeToTable,
      handsOnLeft: null,
      asWritten: true,
      outline: plan.tasks.map((t) => t.label || t.text),
      stretches: [],
    };
  }

  // What stands before the first cooking step: the Prep screen, or "Prep
  // first"'s prep pages (DS v1.59), which are steps of the one sequence.
  const prepScreen = hasPrepScreen(plan, state.mode) ? 1 : 0;
  const pages = prepPages(plan, state.mode);
  const offset = prepScreen + pages.length;
  const onPrep = prepScreen === 1 && state.pos === 0;
  // On Prep the strip reads the cook as it will stand on leaving, as the
  // view's row does (`rowState`): in As I go leaving ticks the mise done
  // before cooking, which makes the Prep block and recuts the stretches, so
  // Prep is in hand and its stretch is the one the cook steps into.
  const read = rowState(plan, state, onPrep);
  const times = timeline(plan, read.mode, read.ticked);
  const items = flow(plan, read.mode, read.ticked);
  const layout = lanes(times, items);
  // The steps as the cook walks them: the prep pages, then the cooking steps.
  const steps = [...pages, ...items];
  const at = state.pos - prepScreen;
  const onPage = !onPrep && at >= 0 && at < pages.length;

  const done = items.map((item) => item.tasks.every((t) => isDone(read, t.id)));
  const anyDone = done.some(Boolean);
  const allDone = done.length > 0 && done.every(Boolean);
  const revisit = onPrep && anyDone;

  let baseNow = cookNow(plan, state);
  if (allDone) {
    baseNow = layout.total;
  } else if (onPrep && !anyDone) {
    baseNow = 0;
  }

  // Calculate now advancement from running timer on current step (N6)
  let timerElapsedMinutes = 0;
  if (timers && !onPrep) {
    let activeTimer: KitchenTimer | null = null;
    if ("stepTimer" in timers && timers.stepTimer) {
      activeTimer = timers.stepTimer;
    } else if (Array.isArray(timers)) {
      activeTimer =
        timers.find((t) => {
          const currentItem = steps[at];
          return (
            currentItem &&
            (t.stepId === currentItem.tasks[0]?.id ||
              currentItem.tasks.some((task) => t.id.includes(task.id)))
          );
        }) ?? null;
    } else if ("durationMs" in timers) {
      activeTimer = timers;
    }

    if (activeTimer && activeTimer.endsAtEpochMs > 0) {
      const elapsedMs = Math.max(
        0,
        activeTimer.durationMs - (activeTimer.endsAtEpochMs - nowEpochMs),
      );
      timerElapsedMinutes = Math.floor(elapsedMs / 60_000);
    }
  }

  const currentItem = !onPrep ? steps[at] : null;
  const stepEnd = currentItem ? currentItem.end : baseNow;
  const now = allDone ? baseNow : Math.min(stepEnd, baseNow + timerElapsedMinutes);

  // The progress line's end (see `Strip.progress`): the end of the screen the cook is on.
  const nextItem = currentItem ? steps[at + 1] : undefined;
  let progress: number;
  if (allDone) {
    progress = layout.total;
  } else if (onPage && at === pages.length - 1) {
    // The last prep page: the end of the prep block, whichever page's job stands longest (the
    // tacos' onion stands to 23 while the last page's avocado is sliced by 10). The pages before
    // it follow the step rule below, as a cooking step that starts a pot does.
    progress = Math.max(...pages.map((page) => page.end));
  } else if (currentItem) {
    progress = nextItem
      ? Math.max(currentItem.start, Math.min(currentItem.end, nextItem.start))
      : layout.total;
  } else {
    progress = Math.max(now, times.prep ? times.prep.end : 0);
  }

  const marks: StripMark[] = [];
  const prepMarks: StripMark[] = [];

  // Prep mark (Prep's mise is the first mark, an ink block)
  if (offset > 0 && times.prep) {
    const prepDone = times.prep.tasks.every((id) => isDone(read, id));
    let prepState: MarkState = "ahead";
    if (onPrep || onPage) {
      prepState = "in-hand";
    } else if (prepDone) {
      prepState = "done";
    }
    const pageOpen = pages.findIndex((page) => page.tasks.some((t) => !isDone(state, t.id)));

    marks.push({
      key: "prep",
      screen: onPage ? state.pos : Math.max(0, pageOpen),
      strand: COOK_COPY.prepChapter,
      label: COOK_COPY.prepChapter,
      start: 0,
      end: times.prep.end,
      pot: false,
      nominal: false,
      state: prepState,
      revisit: revisit ? true : undefined,
      stretch: null,
      done: prepDone,
      tasks: [...times.prep.tasks],
      lane: null,
      // On the cook's own record, not the leaving read: As I go reads Prep's
      // mise ticked on the way out, and the card says what is still to do.
      todo: times.prep.tasks.filter((id) => !isDone(state, id)).length,
    });

    // The cards whole, as As I go keys them: a card "Prep first" cuts into
    // pages is still one mark, which goes to its first page.
    const pItems = prepFlow(plan, state.mode, read.ticked);
    const pageOf = new Map<string, number>();
    pages.forEach((page, i) => {
      for (const t of page.tasks) pageOf.set(t.id, i);
    });
    for (const item of pItems) {
      const itemDone = item.tasks.every((t) => isDone(read, t.id));
      const itemPages = item.tasks.flatMap((t) => pageOf.get(t.id) ?? []);
      let itemState: MarkState = "ahead";
      if (onPage) {
        if (itemPages.includes(at)) itemState = "in-hand";
        else if (itemDone) itemState = "done";
      } else if (itemDone) {
        itemState = "done";
      } else if (onPrep) {
        itemState = "in-hand";
      }
      const itemSlots = times.slots.filter((s) =>
        item.tasks.some((t) => t.id === s.task.id),
      );
      const nominal = itemSlots.length > 0 && itemSlots.every((s) => s.nominal);
      prepMarks.push({
        key: stepKey(item),
        screen: itemPages.length > 0 ? Math.min(...itemPages) : 0,
        strand: item.tasks[0]?.branch ?? "Cook",
        label: item.tasks.map((t) => t.label).join(", "),
        start: item.start,
        end: item.end,
        pot: false,
        nominal,
        state: itemState,
        revisit: revisit ? true : undefined,
        stretch: null,
        done: itemDone,
        tasks: item.tasks.map((t) => t.id),
        lane: null,
        todo: item.tasks.filter((t) => !isDone(state, t.id)).length,
        cook: false,
        after: [],
      });
    }
  }

  // The stretches, from the same items the marks are drawn from (one source).
  const cut = stretchesOf(items);
  const stretchOf = new Map<number, number>();
  cut.forEach((run, k) => {
    for (let i = run.start; i < run.end; i++) stretchOf.set(i, k);
  });
  const stretches: StripStretch[] = cut.map((run) => ({
    screens: Array.from({ length: run.end - run.start }, (_, i) => run.start + i + offset),
    free: freeAfter(items, run),
  }));

  // Step marks from layout bars
  for (const bar of layout.bars) {
    const item = items[bar.item];
    const screen = bar.item + offset;
    const barDone = done[bar.item];

    let markState: MarkState = "ahead";
    if (screen === state.pos) {
      markState = "in-hand";
    } else if (barDone && bar.handsOff && bar.start <= now && now < bar.end) {
      markState = "running";
    } else if (barDone) {
      // Done is the cook's record, not the clock: a step a Go jumped over stays to come (N8).
      markState = "done";
    }

    const itemSlots = times.slots.filter((s) =>
      item.tasks.some((t) => t.id === s.task.id),
    );
    const nominal = itemSlots.length > 0 && itemSlots.every((s) => s.nominal);

    marks.push({
      key: stepKey(item),
      screen,
      strand: item.tasks[0]?.branch ?? "Cook",
      label: bar.label,
      start: bar.start,
      end: bar.end,
      pot: isPot(item),
      nominal,
      state: markState,
      stretch: stretchOf.get(bar.item) ?? null,
      done: barDone,
      tasks: item.tasks.map((t) => t.id),
      lane: bar.lane,
    });
  }

  // What each step waits on, by step mark: only cook tasks count, as a mise
  // or ahead task is done before or around the cook, not in its order.
  const taskById = new Map(plan.tasks.map((t) => [t.id, t]));
  const markOfTask = new Map<string, string>();
  for (const m of marks) if (m.key !== "prep") for (const id of m.tasks) markOfTask.set(id, m.key);
  for (const m of marks) {
    if (m.key === "prep") continue;
    const after: string[] = [];
    for (const id of m.tasks) {
      for (const need of taskById.get(id)?.needs ?? []) {
        if (taskById.get(need)?.kind !== "cook") continue;
        const k = markOfTask.get(need);
        if (k && k !== m.key && !after.includes(k)) after.push(k);
      }
    }
    m.after = after;
    m.cook = m.tasks.some((id) => taskById.get(id)?.kind === "cook");
  }

  const rows = packRows(marks);

  // Time to table: total - now
  const totalMinutes = layout.total;
  const minutesRemaining = totalMinutes - now;

  const timeToTable = toTableSaid(minutesRemaining);

  // Hands-on time left: sum of hands-on minutes ahead of now
  let handsOnMinutes = 0;
  for (const m of marks) {
    if (!m.pot) {
      if (m.end <= now) {
        continue;
      } else if (m.start >= now) {
        handsOnMinutes += m.end - m.start;
      } else {
        handsOnMinutes += m.end - now;
      }
    }
  }

  let handsOnLeft: string | null = null;
  if (handsOnMinutes > 0) {
    const roundedHandsOn = Math.ceil(handsOnMinutes / 5) * 5;
    handsOnLeft = `${durationText(roundedHandsOn)} hands-on`;
  }

  return {
    marks,
    prepMarks,
    rows,
    now,
    progress,
    totalMinutes,
    timeToTable,
    handsOnLeft,
    asWritten: false,
    stretches,
    hasMise: plan.tasks.some((t) => t.kind === "mise"),
    mode: state.mode,
    onPrep,
    prepScreen: prepScreen === 1,
    modeOpen: state.pos === 0,
  };
}

export const cookStrip = strip;
