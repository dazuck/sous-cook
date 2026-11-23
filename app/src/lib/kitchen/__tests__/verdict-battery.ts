/**
 * Plans to check the validator's verdicts against: every committed corpus
 * snapshot, and each one broken in three ways, one change per plan. Each task
 * retagged to each other kind (the phase rules, and the coverage rules an
 * ahead task's lead changes); each ahead task given a short lead (lead
 * order); each task dropped, with every need on it (coverage and the
 * every-task-leads-somewhere rules). Deterministic, so a count of verdicts by
 * rule pins which plans pass and which rule each failure is named for.
 */

import type { RecipeForPlan } from "../cook-plan";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "./load-cook-plan-fixtures";

interface RawTask {
  id: string;
  kind: string;
  lead?: string | null;
  needs: string[];
}

export interface BatteryCase {
  name: string;
  raw: unknown;
  recipe: RecipeForPlan;
}

const KINDS = ["ahead", "mise", "cook"] as const;

export function verdictBattery(): BatteryCase[] {
  const snapshots = loadCookPlanSnapshots();
  const cases: BatteryCase[] = [];
  for (const fixture of loadCookPlanFixtures()) {
    const raw = snapshots.get(fixture.name)?.raw as { tasks: RawTask[] } | undefined;
    if (!raw || !Array.isArray(raw.tasks)) continue;
    const recipe = fixture.recipe;
    const edit = (name: string, change: (tasks: RawTask[]) => RawTask[]) => {
      const copy = structuredClone(raw);
      cases.push({ name: `${fixture.name}: ${name}`, raw: { ...copy, tasks: change(copy.tasks) }, recipe });
    };
    cases.push({ name: fixture.name, raw: structuredClone(raw), recipe });
    raw.tasks.forEach((task, i) => {
      for (const kind of KINDS) {
        if (kind === task.kind) continue;
        edit(`${task.id} as ${kind}`, (tasks) => {
          tasks[i].kind = kind;
          return tasks;
        });
      }
      if (task.kind === "ahead") {
        edit(`${task.id} 10 minutes before`, (tasks) => {
          tasks[i].lead = "10 minutes before";
          return tasks;
        });
      }
      edit(`${task.id} dropped`, (tasks) =>
        tasks
          .filter((_, j) => j !== i)
          .map((t) => ({ ...t, needs: t.needs.filter((n) => n !== task.id) })),
      );
    });
  }
  return cases;
}
