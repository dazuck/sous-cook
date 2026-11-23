"use client";

import { useState } from "react";
import {
  howMuch as howMuchOf,
  type IngredientLine,
  type StoredIngredientLines,
} from "@/lib/kitchen/ingredient-display";
import { MeasurementPopover } from "./MeasurementPopover";

export interface IngredientRowsProps {
  /**
   * The pack recipe's ingredients as the cook reads them (slice B4 step 8), by
   * stored index: null where a blank stored line was skipped.
   */
  ingredients: StoredIngredientLines;
  /** Indices of ingredients that have been used in completed steps */
  usedIngredientIndices?: Set<number>;
  /** Optional external map of manual overrides index -> checked */
  manualOverrides?: Map<number, boolean>;
  /** Optional callback when an ingredient checkbox is toggled */
  onToggle?: (index: number, nextChecked: boolean) => void;
  /** Optional className for the container div */
  className?: string;
  /**
   * The rows' type size. The Ingredients sheet's 18 px predates the counter
   * scale; Whole recipe sets them on it (24 cpx), above the 22 cpx floor.
   */
  textSize?: string;
  /** Compact amount + name rows without checkboxes, for the opening's "Get out" list. */
  compact?: boolean;
  /** Number of columns in compact mode (1 in landscape, 2 in portrait). */
  columns?: 1 | 2;
  /** Maximum height (px) for compact mode's scrollable container. */
  maxHeight?: number;
}

// The rule's colour and offset, for when the popover's button draws it
// (AMOUNT_RULE): only an amount that opens (its conversions, or a moved
// count's "Exactly") wears the rule.
const AMOUNT = "font-semibold decoration-ink-soft underline-offset-4";

function stripCompactParentheticals(name: string): string {
  return name.replace(/\s*\([^)]*\)/g, "").replace(/\s+,/g, ",").trim();
}

/** The amount column: the stated amount, a count, the source's own words, or a dash. */
export function Amount({ line }: { line: IngredientLine }) {
  switch (line.kind) {
    case "amount":
      return (
        <MeasurementPopover
          stated={line.stated}
          conversions={line.conversions}
          servesBase={line.servesBase}
        >
          <span data-amount-words className={AMOUNT}>{line.amount}</span>
        </MeasurementPopover>
      );
    case "count":
      if (line.exact !== undefined) {
        return (
          <MeasurementPopover stated={[]} conversions={[]} exact={line.exact}>
            <span data-amount-words className={AMOUNT}>{line.amount}</span>
          </MeasurementPopover>
        );
      }
      return <span data-amount-words className={AMOUNT}>{line.amount}</span>;
    case "as_written":
      return <span data-amount-words className={AMOUNT}>{line.amount}</span>;
    case "to_taste":
    case "unstated":
      return <span className="text-ink-soft">—</span>;
  }
}

function CompactIngredientRows({
  ingredients,
  className = "",
  textSize = "text-[length:var(--type-meta)]",
  columns = 1,
  maxHeight,
}: {
  ingredients: StoredIngredientLines;
  className?: string;
  textSize?: string;
  columns?: 1 | 2;
  maxHeight?: number;
}) {
  const valid = ingredients
    .map((line, index) => (line !== null ? { line, index } : null))
    .filter((x): x is { line: IngredientLine; index: number } => x !== null);

  return (
    <div
      data-get-out-scroll
      tabIndex={0}
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
      className={`overflow-y-auto overscroll-contain [touch-action:pan-y] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${className}`}
    >
      <ul
        className={
          columns === 2
            ? "m-0 grid list-none grid-cols-2 gap-x-[calc(18*var(--cpx))] gap-y-[calc(4*var(--cpx))] p-0"
            : "m-0 flex list-none flex-col gap-y-[calc(4*var(--cpx))] p-0"
        }
      >
        {valid.map(({ line, index }) => {
          const hasAmount = line.kind !== "to_taste" && line.kind !== "unstated";
          const displayName = stripCompactParentheticals(line.name);
          return (
            <li
              key={index}
              data-row
              data-ingredient-index={index}
              className={`min-w-0 leading-[var(--leading-body)] ${textSize}`}
            >
              {hasAmount && (
                <>
                  <span
                    data-amount
                    className="font-sans font-bold text-ink [font-variant-numeric:lining-nums_tabular-nums] [&_span]:font-bold"
                  >
                    <Amount line={line} />
                  </span>{" "}
                </>
              )}
              <span data-ingredient-name className="font-serif font-medium text-ink">
                {displayName}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The ingredient rows component: renders checkboxes, amounts, and names in a subgrid.
 * Used by IngredientsModal, WholeRecipe, and (in `compact` mode) the opening's "Get out" list.
 */
export function IngredientRows({
  ingredients,
  usedIngredientIndices = new Set(),
  manualOverrides: externalOverrides,
  onToggle,
  className = "max-w-3xl",
  textSize = "text-[length:var(--type-chip)]",
  compact = false,
  columns = 1,
  maxHeight,
}: IngredientRowsProps) {
  const [internalOverrides, setInternalOverrides] = useState<Map<number, boolean>>(new Map());
  const manualOverrides = externalOverrides ?? internalOverrides;

  if (compact) {
    return (
      <CompactIngredientRows
        ingredients={ingredients}
        className={className}
        textSize={textSize}
        columns={columns}
        maxHeight={maxHeight}
      />
    );
  }

  const isChecked = (index: number): boolean => {
    if (manualOverrides.has(index)) {
      return manualOverrides.get(index)!;
    }
    return usedIngredientIndices.has(index);
  };

  const toggleIngredient = (index: number) => {
    const currentlyChecked = isChecked(index);
    const nextChecked = !currentlyChecked;
    if (onToggle) {
      onToggle(index, nextChecked);
    }
    if (!externalOverrides) {
      setInternalOverrides((prev) => {
        const next = new Map(prev);
        next.set(index, nextChecked);
        return next;
      });
    }
  };

  return (
    <div className={className}>
      {/* One grid for the whole list, each row a subgrid of it: the
          amount column is as wide as the widest amount, so the source's
          own words ("a handful of") sit on one line and every name
          starts at one edge (B4 fix round 1). */}
      <ul className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        {ingredients.map((line, index) => {
          // A blank stored line has no row; the rest keep their stored
          // index, which the plan's used set holds.
          if (line === null) return null;
          const checked = isChecked(index);
          // Under the name, how much when the line has no number to show.
          const howMuch = howMuchOf(line);

          return (
            <li key={index} className="col-span-3 grid grid-cols-subgrid">
              {/* State is ink weight (DS §1): the box is an ink ring, ink
                  filled once checked; a checked row goes ink-soft and
                  keeps its strike (§5, struck through = already added). */}
              {/* A div, not a label: a label's first control is the
                  amount's button, so a tap on the name would open its
                  conversions (V8). */}
              <div
                data-row
                className="col-span-3 grid min-h-[var(--target)] grid-cols-subgrid items-center rounded-[var(--radius-2)] p-3"
              >
                {/* Checkbox */}
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={`Toggle ${line.name}`}
                  onClick={() => toggleIngredient(index)}
                  className={`relative grid size-[calc(44*var(--cpx))] shrink-0 cursor-pointer place-items-center rounded-[10px] border transition-colors duration-[320ms] ease-[var(--ease)] before:absolute before:-inset-[calc(18*var(--cpx))] before:content-[''] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink ${
                    checked
                      ? "border-ink bg-ink text-paper"
                      : "border-ink-soft text-ink active:bg-sand"
                  }`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="22"
                    height="22"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className={`transition-opacity duration-[320ms] ease-[var(--ease)] ${
                      checked ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </button>

                {/* Amount: at least the old 80 px, at most 12rem, past
                    which an amount wraps inside the column. */}
                <div
                  className={`min-w-20 max-w-48 text-right ${textSize} ${
                    checked ? "text-ink-soft" : "text-ink"
                  }`}
                >
                  <Amount line={line} />
                </div>

                {/* Name */}
                <div
                  onClick={() => toggleIngredient(index)}
                  className={`min-w-0 cursor-pointer select-none ${textSize} font-medium ${
                    checked ? "text-ink-soft line-through" : "text-ink"
                  }`}
                >
                  {line.name}
                  {/* The name's own size, in ink-soft: the sheet's type
                      predates the counter scale, so the meta token would
                      draw it louder than the name it qualifies. */}
                  {howMuch !== null && (
                    <span data-how-much className="block text-ink-soft">
                      {howMuch}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
