"use client";

import { useId, useRef, type MouseEvent } from "react";
import { COOK_COPY, bindNumbers, rowsAllAssumed, type PrepRow } from "@/lib/kitchen/cook-view";
import type { IngredientLine, StoredIngredientLines } from "@/lib/kitchen/ingredient-display";
import { Pair, PAIRS_OWN_DOT } from "./StepPairs";
import { TickTile } from "./TickTile";

// A prep page that merges several small jobs (DS v1.59, §5 "Prep pages"): one
// page of tick rows where a step has its words. Each row is a job: its tick,
// its words set like a step (600, tightened) at the chip's size, after them
// on the same line the amounts it uses (the same pairs a step shows, each
// opening its conversions; they wrap under the words when the line is full),
// and its own minutes at the row's end.
//
// The stage's fit ladder sizes the rows as it sizes a step, through the step's
// own font size (the `em` here; 64 cpx at the ladder's 1):
//   - a row is 1.25em tall, a target (80 cpx) at the ladder's 1 and never more
//     for want of words, so at 1280×800 two or three short rows stand a target
//     tall each, and a page of four, or one with a row that wraps, at 0.7 of
//     one, which is what the stage holds under the eyebrow;
//   - the words hold the chip's size down to the ladder's 0.7 (0.67em of the
//     step's size is then the chip's 30 cpx), and only a page that still
//     doesn't fit steps them down, to the meta's size, the floor (DS §2).
const ROW_TEXT =
  "text-[length:clamp(var(--type-meta),0.67em,var(--type-chip))] leading-[1.2] font-semibold tracking-[-0.012em]";
const META = "text-[length:var(--type-meta)] leading-[1.3] font-medium tracking-normal text-ink-soft";
// Parted from the next by a rule in sand. Its padding steps down with the
// ladder too (the first token of the space scale at the ladder's 1), so four
// rows of long jobs still fit the tablet at the ladder's floor.
const ROW =
  "flex min-h-[min(1.25em,var(--target))] cursor-pointer select-none items-center gap-[var(--space-4)] border-t-2 border-sand py-[min(var(--space-1),0.07em)] first:border-t-0";
// The tile on the counter scale, as the rows' words are: 48 cpx, its check 24.
const TILE = "size-[calc(48*var(--cpx))] rounded-[calc(10*var(--cpx))]";
// The tile's hit area, up and down: 12 px past the tile where the row has the room, and never past
// the row, so the hit areas of four short rows don't overlap (a row is at least `min(1.25em,
// target)` tall, its tile centred under a 2 px rule; review round 1 of prep pages).
const TILE_HIT_Y = "clamp(-12px, calc((48 * var(--cpx) - min(1.25em, var(--target))) / 2 + 2px), 0px)";
// Under the look-ahead's sheet a step's amounts fade as it rises (`--look-meta`, 1 at rest to 0;
// `CookSheet`). A row's fade with it, and a line of them dropped under its words (36 px: a pair's
// 48 px pitch less the 6 px it overlaps each way) gives its height back as it goes, half above and
// half below so amounts on the words' own line stay where they are. The rows then stand clear of
// the lifted sheet with no blank band where the amounts were.
const PAIRS_LIFT = {
  opacity: "var(--look-meta, 1)",
  marginBlock: "calc((var(--look-meta, 1) - 1) * 18px)",
} as const;
const TONE = "transition-colors duration-[var(--dur-step)] ease-[var(--ease)] motion-reduce:transition-none";

/**
 * The tick rows of a prep page. A tap anywhere on a row ticks it, its amounts
 * apart: those open their conversions, as on any step. A tick is the cook's
 * own record and is kept with the session; Forward counts the page done
 * whatever is ticked.
 *
 * Two taps tick nothing (review round 1 of prep pages). The press that puts an
 * open conversions panel away only does that, as on the stage (`CookFlow`'s
 * `popoverOpen`) and in Get out. And under the lifted look-ahead (`lifted`)
 * the page is being looked past: its rows tick nothing, its tiles and its
 * amounts (faded out there) are inert, so neither takes a press or the focus,
 * and a tap anywhere on the rows, a tile included, is the stage's own again,
 * which brings the cook back to Now (review round 2: a tile did nothing).
 */
export function PrepRows({
  rows,
  ingredients,
  onTick,
  discussed = null,
  lifted = false,
}: {
  rows: readonly PrepRow[];
  /** The recipe's ingredients as the cook reads them, by the plan's stored index. */
  ingredients: StoredIngredientLines;
  onTick: (id: string) => void;
  /** The stored index of the pair "how much" just answered, drawn as discussed. */
  discussed?: number | null;
  /** The look-ahead's sheet is up over the page (levels 1 and 2). */
  lifted?: boolean;
}) {
  const lineId = useId();
  // Whether a conversions panel stood open when the press went down. The panel is put away on the
  // press itself, before the click, so the click can't tell; a key press is never that press.
  const closesPanel = useRef(false);
  const tick = (id: string) => {
    if (lifted) return;
    if (closesPanel.current) {
      closesPanel.current = false;
      return;
    }
    onTick(id);
  };
  // Jobs the recipe lists none of say so once, in the page's eyebrow (`prepEyebrow`).
  const markAssumed = !rowsAllAssumed(rows);
  return (
    // The rows are the page's job: a tap on one is its tick, never a page turn.
    <ul
      data-prep-rows
      data-face="rows"
      data-no-tap={lifted ? undefined : ""}
      onPointerDownCapture={() => {
        closesPanel.current = document.querySelector("[data-measure-panel]") !== null;
      }}
      onKeyDownCapture={() => {
        closesPanel.current = false;
      }}
      className="max-w-[calc(872*var(--cpx))]"
    >
      {rows.map((row, i) => {
        const pairs = row.ingredientIdx
          .map((index) => ({ index, line: ingredients[index] }))
          .filter(
            (pair): pair is { index: number; line: IngredientLine } => pair.line !== undefined && pair.line !== null,
          );
        const onRow = (e: MouseEvent) => {
          const target = e.target instanceof Element ? e.target : null;
          // The tile ticks itself; an amount opens its conversions.
          if (target?.closest("button, a, [data-row-pairs]")) return;
          tick(row.id);
        };
        return (
          <li key={row.id} data-row={row.id} data-done={row.done ? "" : undefined} onClick={onRow} className={ROW}>
            <TickTile
              checked={row.done}
              labelledBy={`${lineId}-${i}`}
              onToggle={() => tick(row.id)}
              size={TILE}
              mark="calc(24*var(--cpx))"
              hitY={TILE_HIT_Y}
              inert={lifted}
            />
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-[var(--space-4)]">
              <p className={`${ROW_TEXT} ${TONE} min-w-0 text-pretty ${row.done ? "text-ink-soft" : "text-ink"}`}>
                <span id={`${lineId}-${i}`}>{bindNumbers(row.text)}</span>
                {row.implied && markAssumed && (
                  <span data-row-assumed className={`ml-[var(--space-3)] whitespace-nowrap ${META}`}>
                    {COOK_COPY.assumed}
                  </span>
                )}
              </p>
              {pairs.length > 0 && (
                <ul data-row-pairs inert={lifted} className={PAIRS_OWN_DOT} style={PAIRS_LIFT}>
                  {pairs.map((pair, at) => (
                    // A pair keeps its 48 px pitch for the finger (`StepPairs`); in a row it
                    // overlaps the line above and below by 6 px each, as a tight step's pairs
                    // do (`CookFlow`'s fit), so amounts under a job's words cost the row one line.
                    // Each but the last draws its own dot after its words (`PAIRS_OWN_DOT`).
                    <li key={pair.index} className="my-[-6px]">
                      <Pair line={pair.line} discussed={discussed === pair.index} sep={at < pairs.length - 1} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {row.minutes && (
              <span data-row-minutes className={`shrink-0 whitespace-nowrap ${META}`}>
                {bindNumbers(row.minutes)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
