/**
 * The opening (slice N2, N2-10): the whole-cook chart before Prep, with the
 * recipe's time line and a single Start.
 *
 * It shows at the cook screen's first render when the session is not settled
 * (nothing moved or ticked), its plan is derived (as written has no minutes to
 * chart), and the plan has two or more step screens (one step needs no chart).
 * Nothing about it is stored (N2 decision 6): a reload before any progress
 * shows it again, and a settled resume never does.
 *
 * The cook screen calls this once, in a `useState` initializer, so a plan
 * arriving later (an as-written start swapped to derived) never summons it.
 */

import type { CookPlan, PrepMode } from "./cook-plan";
import type { CookSession } from "./cook-session";
import { screensOf, type PlanSource } from "./cook-view";

/** The fewest step screens that open on the chart. */
export const OPENING_MIN_STEPS = 2;

export function hasOpening(
  plan: CookPlan,
  source: PlanSource,
  mode: PrepMode,
  ticked: ReadonlySet<string>,
): boolean {
  if (source.kind !== "derived") return false;
  const steps = screensOf(plan, mode, ticked).filter((s) => s.kind === "step");
  return steps.length >= OPENING_MIN_STEPS;
}

export function opensOnChart(session: CookSession): boolean {
  if (session.settled) return false;
  const { plan, source, state } = session;
  return hasOpening(plan, source, state.mode, state.ticked);
}

