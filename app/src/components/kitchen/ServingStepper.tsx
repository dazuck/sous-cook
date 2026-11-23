"use client";

import type { Recipe } from "@sous/pack";
import { servingsText } from "@/lib/kitchen/ingredient-display";
import { ACTION, ACTION_AT_REST } from "./control-style";

export interface ServingStepperProps {
  recipe: Pick<Recipe, "serves_base" | "serves_estimated">;
  servings: number;
  /** False when the row cannot be scaled (e.g. a pack row read from its projection). */
  scales?: boolean;
  onChange: (servings: number) => void;
  className?: string;
}

/**
 * The counts the stepper steps through (B5c-3): whole numbers from 1 to
 * floor(4 × servesBase), plus servesBase itself so a non-whole base (e.g. 2.5)
 * stays reachable in order (2 ← 2.5 → 3, cap 10).
 */
export function servingSteps(servesBase: number): number[] {
  const cap = Math.max(1, Math.floor(4 * servesBase));
  const set = new Set<number>();
  for (let n = 1; n <= cap; n++) set.add(n);
  if (Number.isFinite(servesBase) && servesBase >= 1 && servesBase <= cap) {
    set.add(servesBase);
  }
  return [...set].sort((a, b) => a - b);
}

/** Next serving count in `delta` direction (-1 or 1), clamped at the ends. */
export function stepServings(servesBase: number, current: number, delta: -1 | 1): number {
  const steps = servingSteps(servesBase);
  const idx = steps.indexOf(current);
  if (idx !== -1) {
    const nextIdx = Math.max(0, Math.min(steps.length - 1, idx + delta));
    return steps[nextIdx]!;
  }
  if (delta < 0) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]! < current) return steps[i]!;
    }
    return steps[0]!;
  }
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]! > current) return steps[i]!;
  }
  return steps[steps.length - 1]!;
}

const STEP_BTN = `-my-[calc(24*var(--cpx))] ${ACTION} ${ACTION_AT_REST} aria-disabled:cursor-default aria-disabled:opacity-35 aria-disabled:active:before:bg-transparent`;

/**
 * The serving stepper (B5c-3, P82, DS v1.40): "serves 4", then "−" and "+" as
 * action words in the hairline ring (DS v1.16). While `scales` is false (B5c-13),
 * "serves 4" stands alone with no "−" or "+".
 */
export function ServingStepper({
  recipe,
  servings,
  scales = true,
  onChange,
  className = "",
}: ServingStepperProps) {
  const shownServings = scales ? servings : recipe.serves_base;
  const steps = servingSteps(recipe.serves_base);
  const min = steps[0] ?? 1;
  const max = steps[steps.length - 1] ?? Math.max(1, Math.floor(4 * recipe.serves_base));
  const atMin = shownServings <= min;
  const atMax = shownServings >= max;

  return (
    <div
      data-serving-stepper
      data-no-tap
      className={`flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-medium tracking-normal text-ink-soft ${className}`.trim()}
    >
      <span data-servings-text>{servingsText(recipe, shownServings)}</span>
      {scales && (
        <div role="group" aria-label="Servings" className="inline-flex items-center gap-[var(--space-2)]">
          <button
            type="button"
            data-step-down
            aria-label="Decrease servings"
            aria-disabled={atMin || undefined}
            onClick={() => {
              if (atMin) return;
              onChange(stepServings(recipe.serves_base, shownServings, -1));
            }}
            className={STEP_BTN}
          >
            −
          </button>
          <button
            type="button"
            data-step-up
            aria-label="Increase servings"
            aria-disabled={atMax || undefined}
            onClick={() => {
              if (atMax) return;
              onChange(stepServings(recipe.serves_base, shownServings, 1));
            }}
            className={STEP_BTN}
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}
