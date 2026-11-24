import type { CookPlan, CookTask, PrepMode } from "./cook-plan";
import { flow, taskMinutes, timeline, type FlowItem } from "./cook-schedule";
import {
  aheadGroups,
  miseBefore,
  screensOf,
  stepKey,
  type CookView,
  type PrepAheadGroup,
  type StackLine,
} from "./cook-view";

export type AheadGroup = PrepAheadGroup;

export interface CookPhaseMovable {
  key: string;
  text: string;
  minutes: number;
  hint: string;
}

export interface CookPhasePassiveWindow {
  minutes: number;
  label: string;
}

export interface CookPhaseMeanwhile {
  key: string;
  text: string;
  minutes: number;
  remainingFreeMinutes: number;
  remainingLabel: string | null;
}

export interface CookPhaseRow {
  n: number;
  key: string;
  kind: "prep" | "cook";
  title: string;
  minutes: number;
  summary: string | null;
  movable: CookPhaseMovable | null;
  passiveWindow: CookPhasePassiveWindow | null;
  meanwhile: CookPhaseMeanwhile | null;
  firstStepTaskIds: string[];
  state: "done" | "now" | "ahead";
  remainingMinutes: number;
}

export interface CookPhasesModel {
  mode: PrepMode;
  totalMinutes: number;
  handsOnMinutes: number;
  firstTotalMinutes: number;
  goTotalMinutes: number;
  ahead: { lead: string; summary: string; group: AheadGroup }[];
  phases: CookPhaseRow[];
}

export interface PeekStepRow {
  key: string;
  text: string;
  minutes: number;
  isMeanwhile: boolean;
  taskId: string;
}

function stripParens(text: string): string {
  return text.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

function capFirst(text: string): string {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  if (!text) return "";
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 0) return "";
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

function ensurePeriod(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function truncateText(text: string, maxLen = 65): string {
  const clean = stripParens(text).replace(/\.$/, "").trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 20) {
    return `${cut.slice(0, lastSpace).replace(/[,:;–-]$/, "")}…`;
  }
  return `${cut}…`;
}

function sumTaskMinutes(tasks: readonly CookTask[]): number {
  const total = tasks.reduce((sum, t) => sum + taskMinutes(t), 0);
  return Math.max(1, Math.round(total));
}

function cleanTaskLabel(task: CookTask): string {
  const raw = stripParens(task.label || task.text).replace(/\.$/, "").trim();
  return lowerFirst(raw);
}

interface CookGroup {
  key: string;
  branch: string;
  branches: string[];
  items: FlowItem[];
  tasks: CookTask[];
  minutes: number;
  maxHandsOffMinutes: number;
  hasPassiveAnchor: boolean;
}

function itemBranch(item: FlowItem): string {
  return item.tasks[0]?.branch ?? "Cook";
}

function makeCookGroup(items: FlowItem[]): CookGroup {
  const tasks = items.flatMap((it) => it.tasks.filter((t) => t.kind === "cook"));
  const minutes = sumTaskMinutes(tasks);
  let maxHandsOffMinutes = 0;
  for (const t of tasks) {
    if (t.minutes?.handsOff) {
      const m = Math.round(taskMinutes(t));
      if (m > maxHandsOffMinutes) maxHandsOffMinutes = m;
    }
  }
  const branches = [...new Set(items.map(itemBranch))];
  const passiveCandidates = tasks.filter(
    (t) => t.minutes?.handsOff && taskMinutes(t) >= 8,
  );
  const anchorTask =
    passiveCandidates.length > 0
      ? passiveCandidates.reduce((best, cur) =>
          taskMinutes(cur) > taskMinutes(best) ? cur : best,
        )
      : tasks[0];
  return {
    key: `cook:${anchorTask ? anchorTask.id : stepKey(items[0])}`,
    branch: itemBranch(items[0]),
    branches,
    items,
    tasks,
    minutes,
    maxHandsOffMinutes,
    hasPassiveAnchor: maxHandsOffMinutes >= 8,
  };
}

function mergeTwoGroups(a: CookGroup, b: CookGroup): CookGroup {
  return makeCookGroup([...a.items, ...b.items]);
}

const FINISHING_LABEL_RE =
  /^(?:finish|set aside|plate|garnish|toss\s+beans|drain\s+and\s+cool|drain)/i;

const SETUP_LABEL_RE =
  /^(?:preheat|heat|place|put|turn\s+on|position|arrange|bring|combine|saut[eé]\s+aromatics|whisk)/i;

function humanizeTaskPhrase(label: string): string {
  const clean = stripParens(label).replace(/\.$/, "").trim();
  if (/^cook\s+potatoes$/i.test(clean)) return "Crisp the potatoes";
  if (/^wilt\s+greens$/i.test(clean)) return "Wilt the greens";
  if (/^cook\s+eggs$/i.test(clean)) return "Crack eggs and steam";
  if (/^simmer\s+chickpeas$/i.test(clean)) return "Simmer the chickpeas";
  if (/^roast\s+chicken\s+thighs$/i.test(clean)) return "Roast the chicken thighs";
  if (/^roast\s+chicken$/i.test(clean)) return "Roast the chicken";
  if (/^roast\s+potatoes$/i.test(clean)) return "Roast the potatoes";
  if (/^blend\s+hummus/i.test(clean)) return "Blend the warm hummus";

  // Insert "the" for simple "verb noun" 2-word phrases where natural
  const words = clean.split(/\s+/);
  if (
    words.length === 2 &&
    /^(?:roast|simmer|boil|parboil|wilt|sear|fry|bake|broil|carve|make|blend|toss|cook|warm|chill|rest|drain)$/i.test(
      words[0],
    ) &&
    !/^(?:it|them|all|up|down|off|on|in|out)$/i.test(words[1])
  ) {
    return `${capFirst(words[0])} the ${words[1].toLowerCase()}`;
  }

  if (words.length > 5) {
    return capFirst(words.slice(0, 5).join(" "));
  }
  return capFirst(clean);
}

function buildGroupTitle(group: CookGroup): string {
  const tasks = group.tasks;
  if (tasks.length === 0) return "Cook";

  const ids = new Set(tasks.map((t) => t.id));
  if (ids.has("toss-cabbage-slaw") && ids.has("toss-cucumber-pickles")) {
    return "Toss slaw and pickles";
  }
  if (ids.has("broil-chicken") && ids.has("assemble-and-serve")) {
    return "Broil chicken and assemble";
  }
  if (ids.has("blend-tahini") && ids.has("blend-hummus-smooth")) {
    return "Blend the warm hummus";
  }
  if (ids.has("cook-eggs") && ids.has("finish-dish")) {
    return "Crack eggs and steam";
  }
  if (ids.has("saute-aromatics") && ids.has("wilt-greens")) {
    return "Wilt the greens";
  }

  // If there's a dominant passive anchor (>= 15 min, or >= 8 min if only anchor), name after it
  const passiveTasks = tasks.filter(
    (t) => t.minutes?.handsOff && taskMinutes(t) >= 8,
  );
  if (passiveTasks.length > 0) {
    const longestPassive = passiveTasks.reduce((best, cur) =>
      taskMinutes(cur) > taskMinutes(best) ? cur : best,
    );
    // Unless the group also ends with final assembly/serving after a short rest
    const lastTask = tasks[tasks.length - 1];
    if (
      /assemble|serve/i.test(lastTask.label) &&
      taskMinutes(longestPassive) <= 10
    ) {
      const firstActive =
        tasks.find(
          (t) => !SETUP_LABEL_RE.test(t.label) && t !== lastTask,
        ) ?? tasks[0];
      const firstVerb = stripParens(firstActive.label).split(/\s+/).slice(0, 2).join(" ");
      return capFirst(`${lowerFirst(firstVerb)} and assemble`);
    }
    return humanizeTaskPhrase(longestPassive.label);
  }

  // Filter out pure setup or finishing tasks to find the core action
  const substantive = tasks.filter(
    (t) => !SETUP_LABEL_RE.test(t.label) && !FINISHING_LABEL_RE.test(t.label),
  );
  if (substantive.length > 0) {
    return humanizeTaskPhrase(substantive[substantive.length - 1].label);
  }

  const nonFinishing = tasks.filter((t) => !FINISHING_LABEL_RE.test(t.label));
  if (nonFinishing.length > 0) {
    return humanizeTaskPhrase(nonFinishing[nonFinishing.length - 1].label);
  }

  return humanizeTaskPhrase(tasks[0].label);
}

function buildGroupSummary(group: CookGroup): string {
  const labels: string[] = [];
  for (const t of group.tasks) {
    const clean = cleanTaskLabel(t);
    if (!labels.includes(clean)) {
      labels.push(clean);
    }
  }
  const selected = labels.length <= 3 ? labels : [labels[0], labels[1], labels[labels.length - 1]];
  return ensurePeriod(capFirst(joinClauses(selected)));
}

function groupCookItems(
  cookItems: FlowItem[],
  duringHostIds: ReadonlySet<string>,
  hasPrepPhase: boolean,
): CookGroup[] {
  if (cookItems.length === 0) return [];

  const groups: CookGroup[] = [];

  for (const item of cookItems) {
    const task = item.tasks[0];
    if (!task) continue;
    const mins = Math.round(taskMinutes(task));
    const handsOff = Boolean(task.minutes?.handsOff);
    const isPassiveAnchor =
      (handsOff && mins >= 8) || duringHostIds.has(task.id);

    const prev = groups[groups.length - 1];
    if (!prev) {
      groups.push(makeCookGroup([item]));
      continue;
    }

    const sameBranch = prev.branch === itemBranch(item);
    const dependsOnPrev = task.needs.some((needId) =>
      prev.tasks.some((pt) => pt.id === needId),
    );
    const prevLastTask = prev.tasks[prev.tasks.length - 1];
    const prevLastHandsOff = Boolean(prevLastTask?.minutes?.handsOff);

    // 1. Setup card (< 5 min, no passive anchor yet) on the same branch right before a passive anchor or step
    if (
      sameBranch &&
      !prev.hasPassiveAnchor &&
      prev.minutes < 5 &&
      (isPassiveAnchor || SETUP_LABEL_RE.test(prev.tasks[0].label))
    ) {
      groups[groups.length - 1] = mergeTwoGroups(prev, makeCookGroup([item]));
      continue;
    }

    // 2. Chained hands-off steps or short setup into hands-off on the same branch (e.g. boil -> simmer chickpeas, or parboil -> heat fat -> roast potatoes)
    if (
      sameBranch &&
      handsOff &&
      (prevLastHandsOff || prev.minutes <= 20) &&
      (dependsOnPrev || !prev.hasPassiveAnchor || prev.maxHandsOffMinutes <= 15)
    ) {
      groups[groups.length - 1] = mergeTwoGroups(prev, makeCookGroup([item]));
      continue;
    }

    // 3. Short post-step cleanup/drain/set-aside (< 4 min) on the same branch directly needing prev
    if (
      sameBranch &&
      !handsOff &&
      mins < 4 &&
      dependsOnPrev &&
      FINISHING_LABEL_RE.test(task.label)
    ) {
      groups[groups.length - 1] = mergeTwoGroups(prev, makeCookGroup([item]));
      continue;
    }

    // 4. Consecutive short active cards on the same branch (neither has a passive anchor, combined <= 8 min)
    if (
      sameBranch &&
      !prev.hasPassiveAnchor &&
      !isPassiveAnchor &&
      (prev.minutes < 4 || mins < 4) &&
      prev.minutes + mins <= 8
    ) {
      groups[groups.length - 1] = mergeTwoGroups(prev, makeCookGroup([item]));
      continue;
    }

    groups.push(makeCookGroup([item]));
  }

  // Second pass: merge consecutive tiny active same-branch micro-groups (e.g. Hummus blending sequence)
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < groups.length - 1; i++) {
      const a = groups[i];
      const b = groups[i + 1];
      if (
        a.branch === b.branch &&
        !a.hasPassiveAnchor &&
        !b.hasPassiveAnchor &&
        (a.minutes <= 3 || b.minutes <= 3) &&
        a.minutes + b.minutes <= 16
      ) {
        groups.splice(i, 2, mergeTwoGroups(a, b));
        changed = true;
        break;
      }
    }
  }

  // Cap cooking phases at 5 (so total phases including Prep <= 6)
  const maxCookPhases = 5;
  while (groups.length > maxCookPhases) {
    // Prefer merging adjacent groups that share a branch
    let bestIdx = -1;
    let bestScore = Infinity;

    for (let i = 0; i < groups.length - 1; i++) {
      const a = groups[i];
      const b = groups[i + 1];
      const sharesBranch =
        a.branch === b.branch ||
        a.branches.some((br) => b.branches.includes(br));
      if (sharesBranch) {
        const score = a.minutes + b.minutes;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
    }

    if (bestIdx === -1) {
      for (let i = 0; i < groups.length - 1; i++) {
        const a = groups[i];
        const b = groups[i + 1];
        // Avoid merging into a huge standalone roast if there are smaller adjacent stages
        const penalty =
          a.maxHandsOffMinutes >= 30 || b.maxHandsOffMinutes >= 30 ? 100 : 0;
        const score = a.minutes + b.minutes + penalty;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
    }

    if (bestIdx === -1) bestIdx = groups.length - 2;
    groups.splice(
      bestIdx,
      2,
      mergeTwoGroups(groups[bestIdx], groups[bestIdx + 1]),
    );
  }

  // Ensure at least 2 total phases when there is no Prep phase and multiple cook items
  if (!hasPrepPhase && groups.length === 1 && cookItems.length >= 2) {
    const mid = Math.ceil(cookItems.length / 2);
    return [
      makeCookGroup(cookItems.slice(0, mid)),
      makeCookGroup(cookItems.slice(mid)),
    ];
  }

  return groups;
}

export function buildCookPhases(
  plan: CookPlan,
  mode: PrepMode,
  ticked: ReadonlySet<string>,
  nowMin: number,
  activeTaskId?: string | null,
): CookPhasesModel {
  const firstTl = timeline(plan, "first", ticked);
  const goTl = timeline(plan, "go", ticked);
  const currentTl = mode === "first" ? firstTl : goTl;

  const firstTotalMinutes = Math.round(firstTl.total);
  const goTotalMinutes = Math.round(goTl.total);
  const totalMinutes = Math.round(currentTl.total);
  const handsOnTasks = plan.tasks.filter(
    (t) =>
      t.kind !== "ahead" &&
      !ticked.has(t.id) &&
      !(t.minutes?.handsOff ?? false),
  );
  const handsOnMinutes = Math.round(
    handsOnTasks.reduce((sum, t) => sum + taskMinutes(t), 0),
  );

  // The make-ahead groups, as the Prep screen lists them (the plan's own:
  // no screen need be in hand to read them).
  const aheadGroupsList: AheadGroup[] = aheadGroups(plan);

  const ahead = aheadGroupsList.map((group) => ({
    lead: group.lead ?? "Ahead",
    summary: ensurePeriod(capFirst(joinClauses(group.labels))),
    group,
  }));

  const allMise = plan.tasks.filter(
    (t) => t.kind === "mise" && !ticked.has(t.id),
  );
  const goBeforeSet = miseBefore(plan, "go");
  const beforeMise = allMise.filter((t) => goBeforeSet.has(t.id));
  const movableMise = allMise.filter((t) => !goBeforeSet.has(t.id));

  const hasPrepPhase =
    mode === "first" ? allMise.length > 0 : beforeMise.length > 0;

  // Build canonical cooking groups so keys & structure stay stable across "first" and "go"
  const goFlow = flow(plan, "go", ticked);
  const firstFlow = flow(plan, "first", ticked);
  const duringHostIds = new Set<string>();
  for (const item of goFlow) {
    if (item.during?.id) {
      duringHostIds.add(item.during.id);
    }
  }

  const canonicalCookItems = firstFlow.filter((it) =>
    it.tasks.some((t) => t.kind === "cook"),
  );
  const cookGroups = groupCookItems(
    canonicalCookItems,
    duringHostIds,
    hasPrepPhase,
  );

  // Map each inline mise card in "go" mode (occurring AFTER the first cook card) to its host cook group index
  const inlineMiseByGroup = new Map<number, CookTask[]>();
  const firstCookIdx = goFlow.findIndex((it) =>
    it.tasks.some((t) => t.kind === "cook"),
  );
  const inlineMiseItems =
    firstCookIdx === -1
      ? []
      : goFlow
          .slice(firstCookIdx + 1)
          .filter((it) => it.tasks.every((t) => t.kind === "mise"));

  for (const miseItem of inlineMiseItems) {
    let targetGroupIdx = -1;

    // 1. Check explicit `during.id`
    if (miseItem.during?.id) {
      targetGroupIdx = cookGroups.findIndex((g) =>
        g.tasks.some((t) => t.id === miseItem.during!.id),
      );
    }

    // 2. Check time-window overlap with a group that has a passive window in goFlow
    if (targetGroupIdx === -1) {
      targetGroupIdx = cookGroups.findIndex((g) =>
        g.maxHandsOffMinutes >= 5 &&
        g.items.some((it) => it.start <= miseItem.start && miseItem.start < it.end),
      );
    }

    // 3. Check which group has a cook task that needs one of these mise tasks, and attach to the preceding passive group (or that group)
    if (targetGroupIdx === -1) {
      const consumerIdx = cookGroups.findIndex((g) =>
        g.tasks.some((ct) =>
          miseItem.tasks.some((mt) => ct.needs.includes(mt.id)),
        ),
      );
      if (consumerIdx > 0 && cookGroups[consumerIdx - 1].maxHandsOffMinutes >= 5) {
        targetGroupIdx = consumerIdx - 1;
      } else if (consumerIdx !== -1) {
        targetGroupIdx = consumerIdx;
      }
    }

    if (targetGroupIdx === -1 && cookGroups.length > 0) {
      targetGroupIdx = 0;
    }

    if (targetGroupIdx !== -1) {
      const list = inlineMiseByGroup.get(targetGroupIdx) ?? [];
      for (const mt of miseItem.tasks) {
        if (!list.some((existing) => existing.id === mt.id)) {
          list.push(mt);
        }
      }
      inlineMiseByGroup.set(targetGroupIdx, list);
    }
  }

  const rawPhases: Omit<CookPhaseRow, "n" | "state" | "remainingMinutes">[] = [];
  const phaseWindows: { start: number; end: number }[] = [];

  if (hasPrepPhase) {
    const prepTasks = mode === "first" ? allMise : beforeMise;
    const prepMinutes = sumTaskMinutes(prepTasks);

    let movable: CookPhaseMovable | null = null;
    if (mode === "first" && movableMise.length > 0) {
      const targetGroupIndices = [...inlineMiseByGroup.keys()];
      // Cook groups start at step n = 2 when Phase 1 is Prep
      const hint =
        targetGroupIndices.length === 1
          ? `can do in step ${targetGroupIndices[0] + 2}`
          : "can do while cooking";
      movable = {
        key: `movable:${movableMise.map((t) => t.id).join("+")}`,
        text: capFirst(joinClauses(movableMise.map(cleanTaskLabel))),
        minutes: sumTaskMinutes(movableMise),
        hint,
      };
    }

    const summary =
      mode === "first" && beforeMise.length === 0 && movable !== null
        ? null
        : ensurePeriod(
            capFirst(
              joinClauses(
                (mode === "first" ? beforeMise : prepTasks).map(cleanTaskLabel),
              ),
            ),
          );

    rawPhases.push({
      key: "phase:prep",
      kind: "prep",
      title: mode === "go" && movableMise.length > 0 ? "Prep before heat" : "Prep",
      minutes: prepMinutes,
      summary,
      movable,
      passiveWindow: null,
      meanwhile: null,
      firstStepTaskIds: ["prep", ...prepTasks.map((t) => t.id)],
    });
    phaseWindows.push({ start: 0, end: prepMinutes });
  }

  const currentFlow = mode === "first" ? firstFlow : goFlow;

  cookGroups.forEach((group, groupIdx) => {
    const groupTaskIds = new Set(group.tasks.map((t) => t.id));
    const matchingFlowItems = currentFlow.filter((it) =>
      it.tasks.some((t) => groupTaskIds.has(t.id)),
    );
    const startMin =
      matchingFlowItems.length > 0
        ? Math.min(...matchingFlowItems.map((it) => it.start))
        : 0;
    const endMin =
      matchingFlowItems.length > 0
        ? Math.max(...matchingFlowItems.map((it) => it.end))
        : startMin + group.minutes;

    const movedMise =
      mode === "go" ? (inlineMiseByGroup.get(groupIdx) ?? []) : [];

    let meanwhile: CookPhaseMeanwhile | null = null;
    if (mode === "go" && movedMise.length > 0) {
      const mMinutes = sumTaskMinutes(movedMise);
      const windowMinutes =
        group.maxHandsOffMinutes >= 5 ? group.maxHandsOffMinutes : group.minutes;
      const remainingFreeMinutes = Math.max(0, windowMinutes - mMinutes);
      const remainingLabel =
        remainingFreeMinutes >= 30
          ? `${remainingFreeMinutes} min free to step away`
          : remainingFreeMinutes > 0
            ? `${remainingFreeMinutes} min hands-off`
            : null;
      meanwhile = {
        key: `meanwhile:${movedMise.map((t) => t.id).join("+")}`,
        text: capFirst(joinClauses(movedMise.map(cleanTaskLabel))),
        minutes: mMinutes,
        remainingFreeMinutes,
        remainingLabel,
      };
    }

    let passiveWindow: CookPhasePassiveWindow | null = null;
    if (meanwhile === null && group.maxHandsOffMinutes >= 5) {
      const pm = group.maxHandsOffMinutes;
      passiveWindow = {
        minutes: pm,
        label:
          pm >= 30
            ? `${pm} min free to step away`
            : `${pm} min hands-off window`,
      };
    }

    const firstStepTaskIds = [
      ...group.tasks.map((t) => t.id),
      ...movedMise.map((t) => t.id),
    ];

    rawPhases.push({
      key: group.key,
      kind: "cook",
      title: buildGroupTitle(group),
      minutes: group.minutes,
      summary: buildGroupSummary(group),
      movable: null,
      passiveWindow,
      meanwhile,
      firstStepTaskIds,
    });
    phaseWindows.push({ start: startMin, end: endMin });
  });

  // Resolve active phase index for state ("done" | "now" | "ahead")
  let activeIdx = -1;
  if (activeTaskId) {
    if (activeTaskId === "prep") {
      activeIdx = rawPhases.findIndex((p) => p.kind === "prep");
    } else {
      const parts = activeTaskId.split("+");
      activeIdx = rawPhases.findIndex((p) =>
        parts.some((id) => p.firstStepTaskIds.includes(id)),
      );
    }
  } else if (nowMin > 0) {
    activeIdx = phaseWindows.findIndex(
      (w) => w.start <= nowMin && nowMin < w.end,
    );
    if (activeIdx === -1) {
      activeIdx = phaseWindows.findIndex((w) => w.end > nowMin);
    }
    if (activeIdx === -1 && rawPhases.length > 0) {
      activeIdx = rawPhases.length - 1;
    }
  }

  const phases: CookPhaseRow[] = rawPhases.map((p, idx) => {
    let state: "done" | "now" | "ahead" = "ahead";
    let remainingMinutes = p.minutes;

    if (activeIdx !== -1) {
      if (idx < activeIdx) {
        state = "done";
        remainingMinutes = 0;
      } else if (idx === activeIdx) {
        state = "now";
        const win = phaseWindows[idx];
        if (nowMin > win.start && nowMin < win.end) {
          remainingMinutes = Math.max(
            1,
            Math.min(p.minutes, Math.ceil(win.end - nowMin)),
          );
        } else {
          remainingMinutes = p.minutes;
        }
      } else {
        state = "ahead";
        remainingMinutes = p.minutes;
      }
    }

    return {
      ...p,
      n: idx + 1,
      state,
      remainingMinutes,
    };
  });

  return {
    mode,
    totalMinutes,
    handsOnMinutes,
    firstTotalMinutes,
    goTotalMinutes,
    ahead,
    phases,
  };
}

function parseMinutesLabel(mins: string | null): number {
  if (!mins) return 1;
  const m = mins.match(/(\d+)/);
  return m ? Math.max(1, Number(m[1])) : 1;
}

function stackLineToPeekRow(line: StackLine): PeekStepRow {
  const firstId = line.key.split("+")[0] || line.key;
  const rawLabel = line.name || line.glance || line.text;
  return {
    key: line.key,
    text: truncateText(capFirst(rawLabel), 65),
    minutes: parseMinutesLabel(line.minutes),
    isMeanwhile: line.kind === "mise",
    taskId: firstId,
  };
}

function flowItemToPeekRow(item: FlowItem): PeekStepRow {
  const key = stepKey(item);
  const taskId = item.tasks[0]?.id ?? key;
  const isMeanwhile = item.tasks.every((t) => t.kind === "mise");
  const minutes = sumTaskMinutes(item.tasks);
  const joinedLabels = joinClauses(
    item.tasks.map((t) => stripParens(t.label || t.text)),
  );
  return {
    key,
    text: truncateText(capFirst(joinedLabels), 65),
    minutes,
    isMeanwhile,
    taskId,
  };
}

export function buildPeekSteps(
  view: CookView & {
    plan?: CookPlan;
    mode?: PrepMode;
    ticked?: ReadonlySet<string>;
  },
  _nowMin: number = 0,
  plan?: CookPlan,
  mode?: PrepMode,
  ticked?: ReadonlySet<string>,
): PeekStepRow[] {
  const targetPlan = plan ?? view.plan;
  if (targetPlan) {
    const targetMode: PrepMode =
      mode ?? view.mode ?? (view.onPrep ? "first" : "go");
    const targetTicked = ticked ?? view.ticked ?? new Set<string>();
    const screens = screensOf(targetPlan, targetMode, targetTicked);
    let currentIdx = view.pos;
    if (view.now && !view.onPrep) {
      const byKey = screens.findIndex(
        (s) => s.kind === "step" && stepKey(s.item) === view.now!.key,
      );
      if (byKey !== -1) currentIdx = byKey;
    }
    return screens
      .slice(currentIdx + 1)
      .filter((s): s is Extract<typeof s, { kind: "step" }> => s.kind === "step")
      .slice(0, 3)
      .map((s) => flowItemToPeekRow(s.item));
  }

  if (view.stack && view.stack.length > 1) {
    return view.stack
      .slice(1, 4)
      .filter((line) => line.kind !== "prep")
      .map(stackLineToPeekRow);
  }

  return [];
}
