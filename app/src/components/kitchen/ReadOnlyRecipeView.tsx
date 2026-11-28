"use client";

import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { formatCircleDay } from "@/lib/kitchen/circle-format";
import { EDGE_X } from "./cook-edge";
import { FOOT_FILL, FOOT_FILL_WAITS } from "./control-style";
import { LABEL } from "./KitchenHome";

interface ReadOnlyRecipeViewProps {
  title: string;
  kitchenName: string;
  cookedDay?: string;
  note?: string | null;
  recipe: KitchenQueueRecipeData;
  queuing: boolean;
  queueError: string | null;
  onQueue: () => void;
}

function formatIngredientLine(ing: {
  item: string;
  amount?: string;
  unit?: string;
}): string {
  return [ing.amount, ing.unit, ing.item].filter(Boolean).join(" ");
}

function formatEstimatedTime(
  time: KitchenQueueRecipeData["estimatedTime"],
): string | null {
  if (!time) return null;
  if (time.total) return `${time.total} min total`;
  if (time.active && time.passive) {
    return `${time.active} min active, ${time.passive} min passive`;
  }
  if (time.active) return `${time.active} min active`;
  if (time.passive) return `${time.passive} min passive`;
  return null;
}

/**
 * Plain read-only view of a circle friend's dish or share-linked recipe,
 * with one action to queue an independent copy for the viewer's kitchen.
 */
export function ReadOnlyRecipeView({
  title,
  kitchenName,
  cookedDay,
  note,
  recipe,
  queuing,
  queueError,
  onQueue,
}: ReadOnlyRecipeViewProps) {
  const timeText = formatEstimatedTime(recipe.estimatedTime);
  const ingredients = recipe.ingredients ?? [];
  const steps = recipe.steps ?? [];

  const metaParts: string[] = [`From ${kitchenName}`];
  if (cookedDay) metaParts.push(formatCircleDay(cookedDay));

  const detailParts: string[] = [];
  if (recipe.serves) detailParts.push(`Serves ${recipe.serves}`);
  if (timeText) detailParts.push(timeText);

  return (
    <div className={`min-h-0 flex-1 overflow-y-auto pb-[calc(48*var(--cpx))] ${EDGE_X}`}>
      <div className="max-w-[calc(760*var(--cpx))] pt-[var(--space-4)]">
        <p className={LABEL}>{metaParts.join(" · ")}</p>

        <h2 className="mt-[var(--space-2)] font-[family-name:var(--font-display)] text-[length:var(--type-title)] leading-[1.08] font-normal text-ink [font-synthesis:none]">
          {title}
        </h2>

        {detailParts.length > 0 && (
          <p className={`mt-[var(--space-2)] ${LABEL}`}>{detailParts.join(" · ")}</p>
        )}

        {note && (
          <p
            data-circle-dish-note
            className="mt-[var(--space-3)] border-l-2 border-ink/[.2] pl-[var(--space-3)] text-[length:var(--type-meta)] leading-[1.4] text-ink"
          >
            {note}
          </p>
        )}

        <div className="mt-[var(--space-5)] flex flex-wrap items-center gap-[var(--space-3)]">
          <button
            type="button"
            data-queue-copy
            disabled={queuing}
            aria-disabled={queuing}
            onClick={onQueue}
            className={`${FOOT_FILL} px-[calc(28*var(--cpx))] ${
              queuing ? FOOT_FILL_WAITS : "bg-ember text-paper"
            }`}
          >
            {queuing ? "Adding…" : "Add to Up next"}
          </button>
          {queueError && (
            <p role="status" className="text-[length:var(--type-meta)] font-medium text-ink">
              {queueError}
            </p>
          )}
        </div>

        {ingredients.length > 0 && (
          <section className="mt-[var(--space-6)] border-t border-ink/[.11] pt-[var(--space-4)]">
            <h3 className="font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]">
              Ingredients
            </h3>
            <ul className="mt-[var(--space-3)] flex flex-col gap-y-[var(--space-2)] text-[length:var(--type-meta)] leading-[1.45] text-ink">
              {ingredients.map((ing, i) => (
                <li key={i}>{formatIngredientLine(ing)}</li>
              ))}
            </ul>
          </section>
        )}

        {steps.length > 0 && (
          <section className="mt-[var(--space-6)] border-t border-ink/[.11] pt-[var(--space-4)]">
            <h3 className="font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]">
              Steps
            </h3>
            <ol className="mt-[var(--space-3)] flex list-decimal flex-col gap-y-[var(--space-3)] pl-[var(--space-5)] text-[length:var(--type-meta)] leading-[1.5] text-ink">
              {steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </section>
        )}

        {recipe.notes && (
          <section className="mt-[var(--space-6)] border-t border-ink/[.11] pt-[var(--space-4)]">
            <h3 className="font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]">
              Recipe notes
            </h3>
            <p className="mt-[var(--space-2)] text-[length:var(--type-meta)] leading-[1.5] text-ink">
              {recipe.notes}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
