/**
 * What kind of step a cook screen is (slice B5d, B5.md §B5d D7–D10), from the
 * pack step its task cites. Only a `pack:` row read natively has step types:
 * every other recipe's steps are actions, and so are all their screens.
 *
 * - A cook screen holds one task; a screen of merged mise is always an action.
 * - A step cited by several tasks gives its type to the last of them in plan
 *   order; the others are actions (as A9 gives a step's timer).
 * - An implied task (no step) is an action.
 */

import type { Recipe, Step } from "@sous/pack";
import { stepAt } from "../pack-convert/ids";
import type { RecipeLibrary } from "../pack-convert/recipe-library";
import type { CookPlan, CookTask } from "./cook-plan";

/** One state a checkpoint asks the cook to look for: its name and how it looks. */
export interface Evidence {
  name: string;
  look: string | null;
}

export type ScreenStep =
  | { kind: "action" }
  /** A wait reads as an action; its timer is B5a's offer (D10). */
  | { kind: "wait" }
  /** The step's words are the gate; forward confirms it (D8). */
  | { kind: "checkpoint"; evidence: Evidence[]; hints: string[] }
  /** An aside: drawn small, never ember, collapsed once seen (D9). */
  | { kind: "interlude"; title: string; keys: string[] };

const ACTION: ScreenStep = { kind: "action" };

/** The pack step a screen of `tasks` is, if it takes its step's type. */
function typedStep(plan: CookPlan, recipe: Recipe, tasks: readonly CookTask[]): Step | null {
  if (tasks.length !== 1) return null;
  const task = tasks[0]!;
  if (task.kind !== "cook" || task.sourceStep === null) return null;
  const step = stepAt(recipe, task.sourceStep);
  if (step === undefined || step.type === "action") return null;
  const citing = plan.tasks.filter((t) => t.sourceStep === task.sourceStep);
  return citing[citing.length - 1]?.id === task.id ? step : null;
}

/**
 * The kind of step a screen is. `recipeKey` names the recipe for an
 * interlude with no technique to count it by (its queue row's source).
 */
export function screenStep(
  plan: CookPlan,
  recipe: Recipe,
  library: RecipeLibrary,
  tasks: readonly CookTask[],
  recipeKey: string,
): ScreenStep {
  const step = typedStep(plan, recipe, tasks);
  if (step === null) return ACTION;
  switch (step.type) {
    case "wait":
      return { kind: "wait" };
    case "checkpoint": {
      const evidence = (step.state_refs ?? []).flatMap((ref) => {
        const state = library.states.find((s) => s.id === ref);
        return state === undefined ? [] : [{ name: state.name, look: state.sensory_notes?.look ?? null }];
      });
      return { kind: "checkpoint", evidence, hints: [...(step.coach_hints ?? [])] };
    }
    case "interlude": {
      const techniques = step.technique_refs ?? [];
      const commonsName = techniques
        .map((ref) => library.commons.find((c) => c.id === ref)?.name)
        .find((name) => name !== undefined);
      return {
        kind: "interlude",
        title: step.title ?? commonsName ?? "",
        keys: techniques.length > 0 ? [...techniques] : [`${recipeKey}#${step.id}`],
      };
    }
    default:
      return ACTION;
  }
}

/**
 * What "Not yet" shows in the step's place (D8): each state's name and how it
 * looks, first ref first, then the hints, as the words the stage fits and
 * pages like a step's.
 */
export function howToCheckText(step: Extract<ScreenStep, { kind: "checkpoint" }>): string {
  const states = step.evidence.map((e) => (e.look === null ? `${e.name}.` : `${e.name}. ${e.look}`));
  return [...states, ...step.hints].join(" ");
}

/** Whether a checkpoint has anything behind "Not yet" (D8): evidence or a hint. */
export function hasHowToCheck(step: ScreenStep): boolean {
  return step.kind === "checkpoint" && (step.evidence.length > 0 || step.hints.length > 0);
}
