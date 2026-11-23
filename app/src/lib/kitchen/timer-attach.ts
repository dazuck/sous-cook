/**
 * Which task offers a step's timer (slice B5a, A9; B1 timer reading 1). A
 * cook plan breaks a recipe's step into tasks, and the step's `timer_sec` is
 * offered on one of them: the task whose own words state that duration, else
 * the step's last task in plan order. It shows wherever that task shows as
 * current: the cook flow's step in hand, or a row on Prep.
 *
 * A step is found from a task's `sourceStep` by id, never by position: the
 * converter skips a blank stored step (`stepAt`). A timer over 12 hours is
 * not offered: a day-ahead wait is a lead, Prep's to say, and a screen held
 * awake for a day is no timer.
 */

import type { Recipe } from "@sous/pack";
import { stepAt } from "../pack-convert/ids";
import { durationsIn, type CookPlan } from "./cook-plan";
import type { TimerStart } from "./timer-store";
import { MAX_TIMER_SEC } from "./timers";

/** A step's timer, as a task offers it. */
export interface TimerOffer extends TimerStart {
  /** The recipe's stated length, in seconds. */
  durationSec: number;
}

/** The offers of a cook, keyed by the task that carries each. */
export type TimerOffers = ReadonlyMap<string, TimerOffer>;

function statesLength(text: string, seconds: number): boolean {
  return durationsIn(text).some((d) => d.role === "length" && Math.round(d.minutes * 60) === seconds);
}

/** Capitalise a task's lowercase label for a timer's line ("simmer dal" → "Simmer dal"). */
function labelOf(label: string): string {
  const trimmed = label.trim();
  return trimmed === "" ? "Timer" : trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function timerOffers(
  plan: CookPlan,
  recipe: Recipe,
  cook: { queueId: string; recipeName: string },
): TimerOffers {
  const offers = new Map<string, TimerOffer>();
  const bySource = new Map<number, CookPlan["tasks"]>();
  for (const task of plan.tasks) {
    if (task.sourceStep === null) continue;
    const list = bySource.get(task.sourceStep) ?? [];
    list.push(task);
    bySource.set(task.sourceStep, list);
  }
  for (const [index, tasks] of bySource) {
    const step = stepAt(recipe, index);
    const seconds = step?.timer_sec ?? null;
    if (step === undefined || seconds === null || seconds <= 0 || seconds > MAX_TIMER_SEC) continue;
    const task = tasks.find((t) => statesLength(t.text, seconds)) ?? tasks[tasks.length - 1]!;
    offers.set(task.id, {
      id: `${cook.queueId}:${step.id}`,
      queueId: cook.queueId,
      recipeName: cook.recipeName,
      stepId: step.id,
      label: labelOf(task.label),
      durationMs: seconds * 1000,
      durationSec: seconds,
    });
  }
  return offers;
}

/**
 * The offer for a screen of the cook flow, whose key is its task ids joined
 * with "+" (`StackLine.key`): the first of them that carries one.
 */
export function offerForScreen(offers: TimerOffers, screenKey: string): TimerOffer | null {
  for (const id of screenKey.split("+")) {
    const offer = offers.get(id);
    if (offer !== undefined) return offer;
  }
  return null;
}
