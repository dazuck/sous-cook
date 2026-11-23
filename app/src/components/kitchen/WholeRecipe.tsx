"use client";

/**
 * Whole recipe's column: the deepest level of the cook sheet (P58 (b), N9).
 * The recipe as written in one column the cook may scroll: the ingredients
 * (`IngredientRows`, their checks, the overriding tap and the conversions),
 * Prep, then every step as written, grouped by the cook's stretches with a
 * break divider between two ("about 50 min free"; slice N2, N2-5); as
 * written, or with no break, the steps run unbroken. The step in hand is its "You're here" row
 * (sand, its words in ember-700), which the column opens on. A touched row
 * reads in place: "Go to this step" opens under it (N8), unless no screen of
 * the cook cites that step, when it has no Go.
 *
 * It is drawn inside `CookSheet`, which places it, docks the echo into its
 * "You're here" row and frames it with the borrowed screen's chrome. Every
 * word is at least the meta's 22 cpx (§2's floor).
 */

import { forwardRef, useEffect, useMemo, useRef } from "react";
import type { Recipe } from "@sous/pack";
import { COOK_COPY, chartState, screensOf, type Chapter, type CookState } from "@/lib/kitchen/cook-view";
import type { CookPlan } from "@/lib/kitchen/cook-plan";
import type { StoredIngredientLines } from "@/lib/kitchen/ingredient-display";
import { IngredientRows } from "./IngredientRows";
import { ServingStepper } from "./ServingStepper";

/** Section heads in Whole recipe (placeholder copy). */
export const WHOLE_RECIPE_COPY = {
  ingredients: "Ingredients",
  method: "Method",
  prep: "Prep",
} as const;

export interface ChapterGroup {
  chapter: Chapter;
  steps: Array<{ index: number; text: string }>;
}

/**
 * The steps as written under their cook chapters (N9): a step goes under the
 * first chapter whose screens cite it. Null without chapters (cooked as
 * written, or fewer than two), when the steps run ungrouped. The chapters
 * count the screens the chart does (`chartState`: on Prep, as the cook stands
 * on leaving), so the grouping reads those, not Prep's own (N2 verify round 2).
 */
export function groupStepsByChapter(
  steps: string[],
  plan: CookPlan | null | undefined,
  state: CookState,
  chapters: Chapter[] | null | undefined,
): ChapterGroup[] | null {
  if (!chapters || chapters.length < 2 || !plan) return null;
  const cookChapters = chapters.filter((c) => c.id !== "prep");
  if (cookChapters.length === 0) return null;
  const read = chartState(plan, state);
  const screens = screensOf(plan, read.mode, read.ticked);
  const placed = new Set<number>();
  const groups = cookChapters.map((chapter) => {
    const idx = new Set<number>();
    for (const pos of chapter.at) {
      const sc = screens[pos];
      if (sc?.kind !== "step") continue;
      for (const task of sc.item.tasks) {
        const s = task.sourceStep;
        if (s !== null && s >= 0 && s < steps.length && !placed.has(s)) {
          idx.add(s);
          placed.add(s);
        }
      }
    }
    return { chapter, steps: [...idx].sort((a, b) => a - b).map((index) => ({ index, text: steps[index] })) };
  });
  // A step no cook screen cites (Prep's, or one the plan dropped) goes under
  // the chapter before the next step that is cited, so none is lost.
  const unplaced = steps.map((_, i) => i).filter((i) => !placed.has(i));
  for (const i of unplaced) {
    const g = groups.find((gr) => gr.steps.some((s) => s.index > i)) ?? groups[groups.length - 1];
    g.steps.push({ index: i, text: steps[i] });
    g.steps.sort((a, b) => a.index - b.index);
  }
  return groups.filter((g) => g.steps.length > 0);
}

export interface WholeRecipeProps {
  steps: string[];
  plan: CookPlan | null;
  state: CookState;
  chapters: Chapter[] | null;
  /** Steps as written in hand and done (`sourceStepStates`). */
  current: ReadonlySet<number>;
  done: ReadonlySet<number>;
  /** The Prep line, when the cook has a Prep screen. */
  prepLine: string | null;
  ingredients: StoredIngredientLines;
  usedIngredientIndices: Set<number>;
  ingredientOverrides: Map<number, boolean>;
  onToggleIngredient: (index: number, nextChecked: boolean) => void;
  /** The step as written being read, or null. */
  read: number | null;
  onRead: (index: number | null) => void;
  /** The screen a step as written goes to, or null when none cites it. */
  screenFor: (index: number) => number | null;
  onGo: (screen: number) => void;
  /** Cooked as written: no dividers. */
  asWritten: boolean;
  recipe?: Pick<Recipe, "serves_base" | "serves_estimated">;
  servings?: number;
  scales?: boolean;
  onServingsChange?: (servings: number) => void;
}

// The width rides on each state, not here: a base `w-full` beside the here
// row's wider calc() let whichever Tailwind emitted last win, and the sand
// row came out the column's width shifted left (critic round 2).
const ROW =
  "grid cursor-pointer grid-cols-[1.7em_minmax(0,1fr)] gap-x-[var(--space-2)] rounded-[calc(12*var(--cpx))] text-left text-[length:calc(26*var(--cpx))] leading-[1.38] font-medium outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink";
const HEAD = "mb-[var(--space-3)] text-[length:var(--type-meta)] leading-tight font-semibold text-ink-soft";
/** A break between two stretches (N2-5): the minutes free, in the meta's ink-soft. */
const DIVIDER =
  "mt-[var(--space-2)] mb-[var(--space-4)] text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft";
const GO =
  "mt-[var(--space-2)] ml-[calc(1.7em+var(--space-2))] inline-flex min-h-[var(--target)] cursor-pointer items-center rounded-full bg-sand px-[calc(32*var(--cpx))] text-[length:var(--type-meta)] font-semibold whitespace-nowrap text-ink transition-[background-color] duration-[320ms] ease-[var(--ease)] active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink";

export const WholeRecipe = forwardRef<HTMLDivElement, WholeRecipeProps>(function WholeRecipe(
  {
    steps,
    plan,
    state,
    chapters,
    current,
    done,
    prepLine,
    ingredients,
    usedIngredientIndices,
    ingredientOverrides,
    onToggleIngredient,
    read,
    onRead,
    screenFor,
    onGo,
    asWritten,
    recipe,
    servings,
    scales = true,
    onServingsChange,
  },
  ref,
) {
  const groups = useMemo(
    () => (asWritten ? null : groupStepsByChapter(steps, plan, state, chapters)),
    [asWritten, steps, plan, state, chapters],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  // A step read from the map scrolls the method to its row (N8).
  useEffect(() => {
    if (read === null) return;
    rootRef.current?.querySelector(`[data-step-row="${read}"]`)?.scrollIntoView({ block: "nearest" });
  }, [read]);
  const here = Math.min(...[...current].filter((i) => i < steps.length), Infinity);

  const row = (index: number, text: string) => {
    const isHere = index === here;
    const isDone = !isHere && done.has(index);
    const isRead = read === index;
    const screen = isRead && !isHere ? screenFor(index) : null;
    return (
      <li key={index} data-step-row={index} data-state={isHere ? "current" : isDone ? "done" : "ahead"} className="mb-[var(--space-4)]">
        <button
          type="button"
          aria-current={isHere ? "step" : undefined}
          aria-expanded={isHere ? undefined : isRead}
          data-here={isHere ? "" : undefined}
          onClick={() => onRead(isRead ? null : index)}
          className={`${ROW} ${
            isHere
              ? "-mx-[var(--space-4)] w-[calc(100%+2*var(--space-4))] bg-sand px-[var(--space-4)] py-[var(--space-3)]"
              : isRead
                ? "-mx-[var(--space-4)] w-[calc(100%+2*var(--space-4))] px-[calc(var(--space-4)-2px)] py-[calc(var(--space-3)-2px)] ring-2 ring-ink"
                : "w-full active:bg-sand"
          } ${isDone ? "text-ink-soft" : "text-ink"}`}
        >
          <span className="font-semibold text-ink-soft">{index + 1}</span>
          <span>
            {isHere && (
              <span data-you-are-here className="block text-[length:var(--type-meta)] leading-[1.3] font-semibold text-ink">
                {COOK_COPY.youAreHere}
              </span>
            )}
            <span data-step-text className={isHere ? "font-semibold text-ember-700" : ""}>
              {text}
            </span>
          </span>
        </button>
        {screen !== null && (
          <button type="button" data-go-to-step onClick={() => onGo(screen)} className={GO}>
            {COOK_COPY.goToStep}
          </button>
        )}
      </li>
    );
  };

  const hasIngredients = ingredients.some((l) => l !== null);
  return (
    <div
      ref={(el) => {
        rootRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      data-method-column className="pb-[var(--space-6)]">
      {(hasIngredients || recipe) && (
        <section data-section="ingredients" className="mb-[var(--space-6)]">
          <h3 className={HEAD}>{WHOLE_RECIPE_COPY.ingredients}</h3>
          {recipe && (
            <ServingStepper
              recipe={recipe}
              servings={servings ?? recipe.serves_base}
              scales={scales}
              onChange={onServingsChange ?? (() => {})}
              className={hasIngredients ? "mb-[var(--space-3)]" : ""}
            />
          )}
          {hasIngredients && (
            <IngredientRows
              className=""
              textSize="text-[length:calc(24*var(--cpx))]"
              ingredients={ingredients}
              usedIngredientIndices={usedIngredientIndices}
              manualOverrides={ingredientOverrides}
              onToggle={onToggleIngredient}
            />
          )}
        </section>
      )}
      {prepLine && (
        <section data-section="prep" className="mb-[var(--space-6)]">
          <h3 className={HEAD}>{WHOLE_RECIPE_COPY.prep}</h3>
          <p className="text-[length:var(--type-meta)] leading-[1.45] font-medium text-ink-soft">{prepLine}</p>
        </section>
      )}
      {steps.length > 0 && (
        <section data-section="steps">
          <h3 data-method-head className={HEAD}>
            {WHOLE_RECIPE_COPY.method}
          </h3>
          {groups ? (
            groups.map((g, i) => {
              // The break before this group: the one after the group above it.
              const free = i > 0 ? groups[i - 1].chapter.free : null;
              return (
                <div key={g.chapter.id} data-chapter-group={g.chapter.id}>
                  {free !== null && (
                    <p data-free-divider className={DIVIDER}>
                      {COOK_COPY.freeDivider(free.minutes)}
                    </p>
                  )}
                  <ol className="list-none p-0">{g.steps.map(({ index, text }) => row(index, text))}</ol>
                </div>
              );
            })
          ) : (
            <ol className="list-none p-0">{steps.map((text, index) => row(index, text))}</ol>
          )}
        </section>
      )}
    </div>
  );
});
