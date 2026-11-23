/**
 * Cook lanes: lanes and bar geometry for the look-ahead and whole recipe.
 *
 * Each branch of the plan (Filling, Wrappers, Assemble) takes a lane; branches
 * that follow one another share one, so a lane reads as "this, then that". Only
 * branches that overlap in time need lanes side by side; with no overlap the
 * layout is one lane (or none, with nothing left in the flow).
 *
 * A bar is a card of the flow, not a task, so every bar is one screen; the
 * merged mise of "As I go" is one bar, its labels joined. A bar sits in its
 * branch's lane even outside the branch's span (mise chopped while another branch
 * simmers), so it can fall under the previous branch's name there. A bar that
 * starts while another in its lane runs (the greens chopped while the sauté goes)
 * is drawn inside it, one depth in.
 */

import { isPot, type CookTimeline, type FlowItem } from "./cook-schedule";

/** A branch's stretch of a lane, from its first cook task to its last. */
export interface LaneBranch {
  name: string;
  start: number;
  end: number;
}

export interface LaneBar {
  /** Index into the flow the layout was made from. */
  item: number;
  lane: number;
  /**
   * The bar it is drawn inside, as an index into the bars: the deepest in its
   * lane still running when it starts. Null on the lane's line.
   */
  parent: number | null;
  /** 0 on the lane's line; one more than its parent. */
  depth: number;
  /**
   * How many of the bars it is drawn inside start when it does. Its top drops
   * as many label rooms, so their labels still show.
   */
  labelsAbove: number;
  start: number;
  end: number;
  handsOff: boolean;
  label: string;
}

export interface LanesLayout {
  /** Lanes left to right; each lists its branches in time order. */
  lanes: LaneBranch[][];
  /** In flow order: bars[i].item === i. */
  bars: LaneBar[];
  /** When the prep band ends, or null when nothing is prepped first. */
  prepEnd: number | null;
  total: number;
}

function branchOf(item: FlowItem): string {
  return item.tasks[0].branch;
}

/**
 * The lanes for a schedule and its flow.
 *
 * A branch spans its cook cards only, so mise done early ("As I go" chops the
 * sauce's shallot while the stock simmers) doesn't widen it into overlap; a
 * branch with no cook cards (a slaw that is all mise) spans its mise instead.
 * Branches go in order of start, ties in flow order, each into the leftmost
 * lane that is free by then. The lanes then read left to right as the
 * chapters do, by each lane's first card in the flow: the shrimp prepped
 * first is the first lane, though the onions pickling beside it start
 * cooking sooner.
 */
export function lanes(timeline: CookTimeline, items: FlowItem[]): LanesLayout {
  const spans = new Map<string, { cook: [number, number] | null; all: [number, number] }>();
  for (const item of items) {
    const name = branchOf(item);
    const span = spans.get(name) ?? { cook: null, all: [item.start, item.end] };
    span.all = [Math.min(span.all[0], item.start), Math.max(span.all[1], item.end)];
    if (item.tasks.some((t) => t.kind === "cook")) {
      span.cook = span.cook
        ? [Math.min(span.cook[0], item.start), Math.max(span.cook[1], item.end)]
        : [item.start, item.end];
    }
    spans.set(name, span);
  }

  // Map iteration is insertion order, so a stable sort breaks ties by first
  // appearance in the flow.
  const branches = [...spans].map(([name, span]) => {
    const [start, end] = span.cook ?? span.all;
    return { name, start, end };
  });
  branches.sort((a, b) => a.start - b.start);

  const assigned: LaneBranch[][] = [];
  for (const branch of branches) {
    let lane = assigned.findIndex((l) => l[l.length - 1].end <= branch.start);
    if (lane === -1) {
      lane = assigned.length;
      assigned.push([]);
    }
    assigned[lane].push(branch);
  }

  const firstCard = new Map<string, number>();
  items.forEach((item, i) => {
    if (!firstCard.has(branchOf(item))) firstCard.set(branchOf(item), i);
  });
  const laneKey = (lane: LaneBranch[]) => Math.min(...lane.map((b) => firstCard.get(b.name)!));
  const laneList = [...assigned].sort((a, b) => laneKey(a) - laneKey(b));
  const laneOf = new Map<string, number>();
  laneList.forEach((lane, i) => lane.forEach((b) => laneOf.set(b.name, i)));

  const bars: LaneBar[] = items.map((item, i) => ({
    item: i,
    lane: laneOf.get(branchOf(item))!,
    parent: null,
    depth: 0,
    labelsAbove: 0,
    start: item.start,
    end: item.end,
    handsOff: isPot(item),
    label: item.tasks.map((t) => t.label).join(", "),
  }));

  // Nesting: within each lane, in order of start (the longer first, then a
  // hands-off bar, so a bar starting with another ends within it), each bar
  // goes inside the deepest bar still running. Not the shallowest depth free:
  // a bar starting as the simmer ends, while the fat heating inside the
  // simmer runs on, would be drawn under the fat and lose its label. Every
  // bar running at once sits at its own depth, so the deepest is the one that
  // started last.
  for (let lane = 0; lane < laneList.length; lane++) {
    const inLane = bars
      .filter((b) => b.lane === lane)
      .sort(
        (a, b) =>
          a.start - b.start ||
          b.end - a.end ||
          Number(b.handsOff) - Number(a.handsOff) ||
          a.item - b.item,
      );
    const placed: LaneBar[] = [];
    for (const bar of inLane) {
      let parent: LaneBar | null = null;
      for (const other of placed) {
        if (other.end > bar.start && (!parent || other.depth > parent.depth)) parent = other;
      }
      if (parent) {
        bar.parent = parent.item;
        bar.depth = parent.depth + 1;
        bar.labelsAbove = parent.start === bar.start ? parent.labelsAbove + 1 : 0;
      }
      placed.push(bar);
    }
  }

  return {
    lanes: laneList,
    bars,
    prepEnd: timeline.prep ? timeline.prep.end : null,
    total: timeline.total,
  };
}

