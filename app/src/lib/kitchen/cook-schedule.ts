/**
 * Cook schedule: orders a cook plan's tasks for one cook.
 *
 * The LLM extracts tasks; this module decides when each happens, so a mode
 * switch reschedules offline and instantly and every ordering rule is a pure,
 * tested function. Two views over the same schedule:
 *
 *   - `timeline` — start/end minutes per task, for the lanes and table maps
 *   - `flow`     — the ordered cards the cook steps through
 *
 * Recipe order: a topological order of the needs graph that walks the recipe
 * a step at a time, each step as early as the steps before it allow, with the
 * work a step needs pulled in just ahead of it (see `recipeOrder`). It breaks
 * every tie below.
 * Within a branch the steps the recipe states also form a chain in that
 * order: a step starts no earlier than the one before it ends, or than it
 * starts when that one is hands-off (the next step goes on while it simmers).
 * So a branch keeps the recipe's order even where the plan gives no need
 * between two steps. Across branches only needs bind.
 *
 * The cook: reverse (as-late-as-possible) list scheduling with the cook's
 * hands as the single resource, working back from the finish:
 *
 *   - Hands-off tasks (simmer, roast, soak) use no cook time; each ends exactly
 *     when its earliest consumer starts, so parallel branches land together.
 *   - Hands-on tasks are placed one at a time into the latest free stretch of
 *     cook time that ends by their deadline (their earliest consumer's start,
 *     or the chain's limit). When several could take the same stretch, the
 *     one placed latest is:
 *       1. a cook task over a mise task, so mise goes before a hands-on run
 *          rather than between two steps at the stove;
 *       2. then the later deadline (mise is done in the order it is used),
 *          the longer run of needs before it, and finally the later place in
 *          recipe order.
 *
 * The effect in "Prep as I go": mise lands as late as the cook's hands allow
 * before its consumer — inside a hands-off window when one is free ("while it
 * cooks, chop the greens"), otherwise just before the hands-on run that leads
 * into the consumer.
 *
 * The prep block: in "Prep first" every mise task is done before the cook
 * starts; in "Prep as I go" only the mise ticked on the Prep screen is, with
 * the mise it needs. The block is packed forward from minute 0: a hands-off
 * task (pickling, marinating) starts as soon as its needs are done and runs
 * while the cook does the rest by hand. The cook takes the task that can start
 * soonest, then the one with the longest run of prep waiting on it, then
 * recipe order. The cook starts when the block ends.
 *
 * Slots are listed by start; at the same start a hands-off task comes first,
 * so the card that starts it precedes the work done while it runs. Ahead
 * tasks are never scheduled — they belong to the day before.
 */

import type { CookPlan, CookTask, PrepMode } from "./cook-plan";

/** Hands-on minutes assumed for a task the plan gave no estimate. */
export const NOMINAL_MINUTES = 2;

export interface Slot {
  task: CookTask;
  start: number;
  end: number;
  handsOff: boolean;
  /** True when the duration is the nominal guess, not the plan's estimate. */
  nominal: boolean;
}

export interface CookTimeline {
  /** Mise done before the cook starts, as task ids; null when there is none. */
  prep: { end: number; tasks: string[] } | null;
  slots: Slot[];
  total: number;
}

export interface FlowItem {
  /** One task, or several consecutive mise tasks merged into one card. */
  tasks: CookTask[];
  start: number;
  end: number;
  /** The hands-off task running while this one happens, if any. */
  during: CookTask | null;
  /**
   * "while" opens a run of work alongside a hands-off task; "then" carries it
   * on, even into the next task's window, so no two cards open with "while".
   */
  lead: "while" | "then" | null;
}

/**
 * A card that is one hands-off task: a pot the cook can leave going. The
 * lanes draw it hands-off, the chapters break after its start, and a chapter
 * runs while it does.
 */
export function isPot(item: FlowItem): boolean {
  return item.tasks.length === 1 && isHandsOff(item.tasks[0]);
}

/**
 * Times are worked in whole thousandths of a minute and turned back into
 * minutes only on the way out, so sums of estimates like 1.2 and 0.1 are
 * exact: in floating point, 12 minutes back from 1.2 + 2 and forward again
 * can leave a simmer a hair after the chop it should start with, and the
 * chop leads. A task is at least one tick long.
 */
const TICKS_PER_MINUTE = 1000;

function toMinutes(ticks: number): number {
  return ticks / TICKS_PER_MINUTE;
}

/** In ticks. */
function durationOf(task: CookTask): number {
  const minutes = task.minutes?.est ?? NOMINAL_MINUTES;
  return Math.max(1, Math.round(minutes * TICKS_PER_MINUTE));
}

/**
 * A task's length as the schedule counts it, in minutes: the plan's estimate,
 * or `NOMINAL_MINUTES` when it gave none.
 */
export function taskMinutes(task: CookTask): number {
  return toMinutes(durationOf(task));
}

function isHandsOff(task: CookTask): boolean {
  return task.minutes?.handsOff ?? false;
}

/**
 * The mise tasks among `ids`, with every mise task they need, transitively:
 * mise done on the Prep screen brings what it is made from along with it.
 */
export function withMiseNeeds(plan: CookPlan, ids: Iterable<string>): Set<string> {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const closed = new Set<string>();
  const visit = (id: string) => {
    const task = byId.get(id);
    if (task?.kind !== "mise" || closed.has(id)) return;
    closed.add(id);
    for (const n of task.needs) visit(n);
  };
  for (const id of ids) visit(id);
  return closed;
}

/**
 * Recipe order: a topological order of `tasks` over the needs among them that
 * walks the recipe a step at a time, each step as early as the steps before
 * it allow: step 0 and what it needs, then step 1 and what it still needs,
 * and so on. A step that waits on something the recipe states later (the
 * curry paste step 3 describes, fried at step 0) keeps its place, with that
 * work pulled in ahead of it; the next step is never moved up past it.
 *
 * Built backwards from the finish: of the tasks nothing left needs, the one
 * latest in the recipe goes last. Of all the orders the needs allow, that
 * gives the one that reaches step 0 soonest, then step 1, and so on. Assumed
 * work (no source step) counts as latest, so it lands just before the first
 * task that needs it; ties go by plan position. A step comes after a later
 * one only when something that needs the later one comes first.
 */
function recipeOrder(tasks: CookTask[]): Map<string, number> {
  const ids = new Set(tasks.map((t) => t.id));
  const position = new Map(tasks.map((t, i) => [t.id, i]));
  const unplacedConsumers = new Map(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) {
    for (const n of t.needs) {
      if (ids.has(n)) unplacedConsumers.set(n, unplacedConsumers.get(n)! + 1);
    }
  }

  const step = (t: CookTask) => t.sourceStep ?? Infinity;
  const later = (a: CookTask, b: CookTask) =>
    step(a) > step(b) ||
    (step(a) === step(b) && position.get(a.id)! > position.get(b.id)!);

  const backwards: CookTask[] = [];
  const placed = new Set<string>();
  while (backwards.length < tasks.length) {
    let pick: CookTask | null = null;
    for (const t of tasks) {
      if (placed.has(t.id) || unplacedConsumers.get(t.id)! > 0) continue;
      if (pick === null || later(t, pick)) pick = t;
    }
    if (pick === null) throw new Error("cook plan needs graph has a cycle");
    placed.add(pick.id);
    backwards.push(pick);
    for (const n of pick.needs) {
      if (ids.has(n)) unplacedConsumers.set(n, unplacedConsumers.get(n)! - 1);
    }
  }
  return new Map(backwards.reverse().map((t, i) => [t.id, i]));
}

/** Latest end ≤ deadline such that [end - length, end] avoids every busy span. */
function latestFreeEnd(
  deadline: number,
  length: number,
  busy: Array<[number, number]>,
): number {
  let end = deadline;
  for (;;) {
    let blockedFrom: number | null = null;
    for (const [s, e] of busy) {
      if (s < end && e > end - length) {
        blockedFrom = blockedFrom === null ? s : Math.max(blockedFrom, s);
      }
    }
    if (blockedFrom === null) return end;
    end = blockedFrom;
  }
}

/** By start; at the same start hands-off first, then recipe order. */
function bySpan(order: Map<string, number>) {
  return (
    a: { task: CookTask; start: number },
    b: { task: CookTask; start: number },
  ) =>
    a.start - b.start ||
    Number(isHandsOff(b.task)) - Number(isHandsOff(a.task)) ||
    order.get(a.task.id)! - order.get(b.task.id)!;
}

/**
 * The prep block, packed forward from minute 0: hands-off prep starts as soon
 * as its needs are done; the cook's hands take one task at a time.
 */
function prepSpans(
  upfront: CookTask[],
  order: Map<string, number>,
  groupOf?: ReadonlyMap<string, number>,
): Map<string, [number, number]> {
  const ids = new Set(upfront.map((t) => t.id));
  const needsOf = new Map(
    upfront.map((t) => [t.id, t.needs.filter((n) => ids.has(n))]),
  );
  const dependentsOf = new Map<string, CookTask[]>(upfront.map((t) => [t.id, []]));
  for (const t of upfront) {
    for (const n of needsOf.get(t.id)!) dependentsOf.get(n)!.push(t);
  }

  // The longest run of prep that waits on a task once it is done.
  const tailMemo = new Map<string, number>();
  function tail(id: string): number {
    const memo = tailMemo.get(id);
    if (memo !== undefined) return memo;
    let longest = 0;
    for (const d of dependentsOf.get(id)!) {
      longest = Math.max(longest, durationOf(d) + tail(d.id));
    }
    tailMemo.set(id, longest);
    return longest;
  }

  const spans = new Map<string, [number, number]>();
  const ready = (t: CookTask) =>
    !spans.has(t.id) && needsOf.get(t.id)!.every((n) => spans.has(n));
  const needsDone = (t: CookTask) =>
    Math.max(0, ...needsOf.get(t.id)!.map((n) => spans.get(n)![1]));
  let handsFree = 0;
  let currentGroup: number | null = null;

  while (spans.size < upfront.length) {
    let placedHandsOff = true;
    while (placedHandsOff) {
      placedHandsOff = false;
      for (const t of upfront) {
        if (isHandsOff(t) && ready(t)) {
          const start = needsDone(t);
          spans.set(t.id, [start, start + durationOf(t)]);
          placedHandsOff = true;
        }
      }
    }

    const candidates = upfront
      .filter((t) => !isHandsOff(t) && ready(t))
      .map((t) => ({
        task: t,
        start: Math.max(handsFree, needsDone(t)),
        tail: tail(t.id),
        group: groupOf?.get(t.id) ?? null,
        order: order.get(t.id)!,
      }));
    if (candidates.length === 0) {
      if (spans.size < upfront.length) {
        throw new Error("cook plan prep block could not be scheduled");
      }
      break;
    }
    candidates.sort(
      (a, b) =>
        a.start - b.start ||
        b.tail - a.tail ||
        (currentGroup !== null
          ? Number(b.group === currentGroup) - Number(a.group === currentGroup)
          : 0) ||
        a.order - b.order,
    );
    const pick = candidates[0];
    handsFree = pick.start + durationOf(pick.task);
    spans.set(pick.task.id, [pick.start, handsFree]);
    currentGroup = pick.group;
  }
  return spans;
}

/** When each task happens under a prep mode, in minutes from the start. */
export function timeline(
  plan: CookPlan,
  mode: PrepMode,
  ticked: ReadonlySet<string>,
): CookTimeline {
  const order = recipeOrder(plan.tasks.filter((t) => t.kind !== "ahead"));
  const upfrontIds =
    mode === "first"
      ? new Set(plan.tasks.filter((t) => t.kind === "mise").map((t) => t.id))
      : withMiseNeeds(plan, ticked);
  const upfront = plan.tasks.filter((t) => upfrontIds.has(t.id));
  const prep = prepSpans(upfront, order);
  const prepEnd = Math.max(0, ...[...prep.values()].map(([, end]) => end));

  const scheduled = plan.tasks.filter(
    (t) => t.kind !== "ahead" && !upfrontIds.has(t.id),
  );
  const inSchedule = new Set(scheduled.map((t) => t.id));
  const needsOf = new Map(
    scheduled.map((t) => [t.id, t.needs.filter((n) => inSchedule.has(n))]),
  );
  const consumersOf = new Map<string, string[]>(
    scheduled.map((t) => [t.id, []]),
  );
  for (const t of scheduled) {
    for (const n of needsOf.get(t.id)!) consumersOf.get(n)!.push(t.id);
  }
  const byId = new Map(scheduled.map((t) => [t.id, t]));

  // Each branch's stated steps, chained in recipe order.
  const chainNext = new Map<string, string>();
  const chainLast = new Map<string, string>();
  const stated = scheduled
    .filter((t) => t.kind === "cook" && t.sourceStep !== null)
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  for (const t of stated) {
    const last = chainLast.get(t.branch);
    if (last !== undefined) chainNext.set(last, t.id);
    chainLast.set(t.branch, t.id);
  }

  const headMemo = new Map<string, number>();
  function head(id: string): number {
    const memo = headMemo.get(id);
    if (memo !== undefined) return memo;
    let longest = 0;
    for (const n of needsOf.get(id)!) {
      longest = Math.max(longest, durationOf(byId.get(n)!) + head(n));
    }
    headMemo.set(id, longest);
    return longest;
  }

  const placed = new Map<string, [number, number]>();
  const busy: Array<[number, number]> = [];

  // The latest a task may end: when its first consumer starts, and when the
  // next step in its chain starts (or, for a hands-off task, starts plus its
  // own length, since the next step may begin as soon as it is under way).
  const deadlineOf = (t: CookTask) => {
    const limits = consumersOf.get(t.id)!.map((c) => placed.get(c)![0]);
    const next = chainNext.get(t.id);
    if (next !== undefined) {
      const nextStart = placed.get(next)![0];
      limits.push(isHandsOff(t) ? nextStart + durationOf(t) : nextStart);
    }
    return limits.length === 0 ? 0 : Math.min(...limits);
  };
  const ready = (t: CookTask) => {
    const next = chainNext.get(t.id);
    return (
      !placed.has(t.id) &&
      consumersOf.get(t.id)!.every((c) => placed.has(c)) &&
      (next === undefined || placed.has(next))
    );
  };

  while (placed.size < scheduled.length) {
    let placedHandsOff = true;
    while (placedHandsOff) {
      placedHandsOff = false;
      for (const t of scheduled) {
        if (isHandsOff(t) && ready(t)) {
          const deadline = deadlineOf(t);
          placed.set(t.id, [deadline - durationOf(t), deadline]);
          placedHandsOff = true;
        }
      }
    }

    const candidates = scheduled
      .filter((t) => !isHandsOff(t) && ready(t))
      .map((t) => {
        const deadline = deadlineOf(t);
        const end = latestFreeEnd(deadline, durationOf(t), busy);
        return {
          task: t,
          end,
          deadline,
          cook: t.kind === "cook",
          head: head(t.id),
          order: order.get(t.id)!,
        };
      });
    if (candidates.length === 0) {
      if (placed.size < scheduled.length) {
        throw new Error("cook plan could not be scheduled");
      }
      break;
    }

    candidates.sort(
      (a, b) =>
        b.end - a.end ||
        Number(b.cook) - Number(a.cook) ||
        b.deadline - a.deadline ||
        b.head - a.head ||
        b.order - a.order,
    );
    const pick = candidates[0];
    const span: [number, number] = [pick.end - durationOf(pick.task), pick.end];
    placed.set(pick.task.id, span);
    busy.push(span);
  }

  // Pull same-branch "Meanwhile" cook tasks (and any in-window mise they need)
  // to the start of the passive hands-off window they sit inside when every
  // task starting in that window moves together, so the walk-away break lands
  // after the active steps rather than before them without splitting a multi-
  // branch cluster.
  const origPlaced = new Map(
    [...placed.entries()].map(([id, [s, e]]) => [id, [s, e] as [number, number]]),
  );
  const sortedTasks = scheduled.slice().sort(
    (a, b) =>
      origPlaced.get(a.id)![0] - origPlaced.get(b.id)![0] ||
      Number(isHandsOff(b)) - Number(isHandsOff(a)) ||
      order.get(a.id)! - order.get(b.id)!,
  );
  const shiftable = new Set<string>();
  const hostStartOf = new Map<string, number>();
  for (let hIdx = 0; hIdx < sortedTasks.length; hIdx++) {
    const h = sortedTasks[hIdx];
    if (!isHandsOff(h)) continue;
    const [hStart, hEnd] = origPlaced.get(h.id)!;
    const inWin = sortedTasks
      .slice(hIdx + 1)
      .filter((u) => {
        const [uStart] = origPlaced.get(u.id)!;
        return hStart <= uStart && uStart < hEnd;
      });
    if (inWin.length === 0) continue;
    const winIds = new Set(inWin.map((u) => u.id));
    const eligible = new Set<string>();
    for (const u of inWin) {
      const [, uEnd] = origPlaced.get(u.id)!;
      if (uEnd <= hEnd && u.kind === "cook" && u.branch === h.branch) {
        eligible.add(u.id);
      }
    }
    for (let k = inWin.length - 1; k >= 0; k--) {
      const u = inWin[k];
      const [, uEnd] = origPlaced.get(u.id)!;
      if (
        uEnd <= hEnd &&
        u.kind === "mise" &&
        !isHandsOff(u) &&
        consumersOf.get(u.id)!.some((c) => eligible.has(c)) &&
        consumersOf.get(u.id)!.every((c) => !winIds.has(c) || eligible.has(c))
      ) {
        eligible.add(u.id);
      }
    }
    if (eligible.size === inWin.length) {
      for (const id of eligible) {
        shiftable.add(id);
        const cur = hostStartOf.get(id);
        const hPlacedStart = placed.get(h.id)![0];
        if (cur === undefined || hPlacedStart < cur) {
          hostStartOf.set(id, hPlacedStart);
        }
      }
    }
  }
  for (let i = 0; i < sortedTasks.length; i++) {
    const t = sortedTasks[i];
    if (!shiftable.has(t.id)) continue;
    const [origStart, origEnd] = origPlaced.get(t.id)!;
    let minStart = hostStartOf.get(t.id) ?? origStart;
    for (const dep of needsOf.get(t.id)!) {
      minStart = Math.max(minStart, placed.get(dep)![1]);
    }
    for (let k = 0; k < i; k++) {
      const prev = sortedTasks[k];
      const [, prevOrigEnd] = origPlaced.get(prev.id)!;
      const [pStart, pEnd] = placed.get(prev.id)!;
      if (!isHandsOff(prev) || prevOrigEnd <= origStart) {
        minStart = Math.max(minStart, pEnd);
      } else {
        const orderTie =
          isHandsOff(t) && order.get(prev.id)! > order.get(t.id)! ? 1 : 0;
        minStart = Math.max(minStart, pStart + orderTie);
      }
    }
    if (minStart < origStart) {
      const dur = origEnd - origStart;
      placed.set(t.id, [minStart, minStart + dur]);
    }
  }

  const earliest = Math.min(0, ...[...placed.values()].map(([s]) => s));
  const offset = prepEnd - earliest;
  const slots = scheduled
    .map((task) => {
      const [start, end] = placed.get(task.id)!;
      return {
        task,
        start: toMinutes(start + offset),
        end: toMinutes(end + offset),
        handsOff: isHandsOff(task),
        nominal: task.minutes === undefined,
      };
    })
    .sort(bySpan(order));

  return {
    prep:
      upfront.length > 0
        ? {
            end: toMinutes(prepEnd),
            tasks: upfront
              .map((task) => ({ task, start: prep.get(task.id)![0] }))
              .sort(bySpan(order))
              .map(({ task }) => task.id),
          }
        : null,
    slots,
    total: Math.max(toMinutes(prepEnd), ...slots.map((s) => s.end)),
  };
}

/**
 * The hands-off task running when `slots[at]` starts, latest-started first.
 * Only slots listed before it count: the cook has started those.
 */
function duringOf(slots: Slot[], at: number): CookTask | null {
  const slot = slots[at];
  let found: Slot | null = null;
  for (const h of slots.slice(0, at)) {
    if (
      h.handsOff &&
      h.start <= slot.start &&
      slot.start < h.end &&
      (found === null || h.start > found.start)
    ) {
      found = h;
    }
  }
  return found?.task ?? null;
}

/** The cards the cook steps through after the Prep screen, in order. */
export function flow(
  plan: CookPlan,
  mode: PrepMode,
  ticked: ReadonlySet<string>,
): FlowItem[] {
  const { slots } = timeline(plan, mode, ticked);
  const items: FlowItem[] = [];
  let last: { slot: Slot; item: FlowItem } | null = null;

  for (const [at, slot] of slots.entries()) {
    const during = duringOf(slots, at);
    const merges =
      last !== null &&
      slot.task.kind === "mise" &&
      !slot.handsOff &&
      last.slot.task.kind === "mise" &&
      !last.slot.handsOff &&
      last.item.during === during &&
      last.slot.task.branch === slot.task.branch;

    if (merges && last) {
      last.item.tasks.push(slot.task);
      last.item.end = Math.max(last.item.end, slot.end);
      last.slot = slot;
      continue;
    }

    const previous = items[items.length - 1];
    const item: FlowItem = {
      tasks: [slot.task],
      start: slot.start,
      end: slot.end,
      during,
      lead: during === null ? null : previous?.during ? "then" : "while",
    };
    items.push(item);
    last = { slot, item };
  }
  return items;
}

/**
 * A card's tasks as runs of at most `max`, near-equal in length, the longer
 * runs first; one run, as given, when the card fits or there is no `max`. A
 * cut card's tasks go by when the prep block starts them (`startOf`), so its
 * runs follow one another in time.
 */
function nearEqualRuns(
  tasks: CookTask[],
  max: number | undefined,
  startOf: (task: CookTask) => number,
): CookTask[][] {
  if (max === undefined || tasks.length <= max) return [tasks];
  const ordered = tasks
    .map((task, at) => ({ task, at }))
    .sort((a, b) => startOf(a.task) - startOf(b.task) || a.at - b.at)
    .map(({ task }) => task);
  const runs = Math.ceil(ordered.length / max);
  const base = Math.floor(ordered.length / runs);
  const longer = ordered.length % runs;
  const out: CookTask[][] = [];
  let from = 0;
  for (let i = 0; i < runs; i++) {
    const size = base + (i < longer ? 1 : 0);
    out.push(ordered.slice(from, from + size));
    from += size;
  }
  return out;
}

/**
 * The upfront mise cards in the prep block (`[0, prep.end]`), grouped using
 * the same card groupings as `flow(plan, "go", new Set())` so each prep card
 * keeps a 1-to-1 matching key and label when switching between "Prep first"
 * and "As I go".
 *
 * With `maxTasks`, a card of more tasks than that is cut into runs of
 * near-equal length, none longer (5 at 4 a run is 3 + 2, never 4 + 1), its
 * tasks taken in the order the prep block does them: the pages the cook steps
 * through in "Prep first" (`prepPages`, DS §5), where a card of nine chopping
 * jobs would not fit one screen.
 */
export function prepFlow(
  plan: CookPlan,
  mode: PrepMode,
  ticked: ReadonlySet<string>,
  maxTasks?: number,
): FlowItem[] {
  const order = recipeOrder(plan.tasks.filter((t) => t.kind !== "ahead"));
  const upfrontIds =
    mode === "first"
      ? new Set(plan.tasks.filter((t) => t.kind === "mise").map((t) => t.id))
      : withMiseNeeds(plan, ticked);
  const upfront = plan.tasks.filter((t) => upfrontIds.has(t.id));
  if (upfront.length === 0) return [];

  const goItems = flow(plan, "go", new Set());
  const groupOf = new Map<string, number>();
  goItems.forEach((item, idx) => {
    for (const t of item.tasks) {
      if (upfrontIds.has(t.id)) groupOf.set(t.id, idx);
    }
  });

  const prep = prepSpans(upfront, order, groupOf);
  const items: FlowItem[] = [];
  const placedIds = new Set<string>();

  for (const goItem of goItems) {
    const tasks = goItem.tasks.filter((t) => upfrontIds.has(t.id));
    if (tasks.length === 0) continue;
    for (const t of tasks) placedIds.add(t.id);
    for (const run of nearEqualRuns(tasks, maxTasks, (t) => prep.get(t.id)![0])) {
      items.push({
        tasks: run,
        start: toMinutes(Math.min(...run.map((t) => prep.get(t.id)![0]))),
        end: toMinutes(Math.max(...run.map((t) => prep.get(t.id)![1]))),
        during: null,
        lead: null,
      });
    }
  }

  for (const t of upfront) {
    if (placedIds.has(t.id)) continue;
    const [s, e] = prep.get(t.id)!;
    items.push({
      tasks: [t],
      start: toMinutes(s),
      end: toMinutes(e),
      during: null,
      lead: null,
    });
  }

  return items.sort(
    (a, b) =>
      a.start - b.start ||
      Number(isPot(b)) - Number(isPot(a)) ||
      order.get(a.tasks[0]!.id)! - order.get(b.tasks[0]!.id)!,
  );
}
