/**
 * The golden comparison of a `pack:` row's two readings (slice B5d, B5.md
 * §2d step 2): its projection (the stored shape converted, today's reading)
 * against its pack recipe read natively. A **wrong number** is anything the
 * cook would read differently that the native read shouldn't change:
 *
 * - a line whose kind, shown amount or name differs;
 * - a measured line whose first stated amount differs, or a stated amount the
 *   projection showed that the native read lost;
 * - a step whose text or ingredient refs differ (by stored index);
 * - a step whose native `timer_sec` differs from the projection's (its text's
 *   reading, B5a);
 * - a serving count or estimate mark that differs;
 * - a popover conversion that differs, other than one a second stated amount
 *   now stands for (conversions are computed from the amount shown).
 *
 * What the native read is meant to change is reported, never counted: a
 * second stated amount, and the step types the projection never held. Used by `native-read.test.ts` and `scripts/native-read-check.ts`.
 */

import type { Recipe } from "@sous/pack";
import { storedIngredientLines, type IngredientLine, type MeasureRow } from "../kitchen/ingredient-display";
import { stepAt } from "./ids";

export interface GoldenResult {
  wrong: string[];
  /** Differences the native read is meant to make, for the record. */
  expected: string[];
}

function rows(rowsOf: readonly MeasureRow[]): string[] {
  return rowsOf.map((row) => `${row.value} ${row.unit}`);
}

function shownOf(line: IngredientLine | null): string {
  if (line === null) return "(none)";
  return JSON.stringify(["amount" in line ? [line.kind, line.amount] : [line.kind], line.name]);
}

export function compareReadings(
  projection: Recipe,
  native: Recipe,
  stored: { ingredients: number; steps: number },
): GoldenResult {
  const wrong: string[] = [];
  const expected: string[] = [];
  const before = storedIngredientLines(projection, stored.ingredients);
  const after = storedIngredientLines(native, stored.ingredients);
  for (let i = 0; i < stored.ingredients; i++) {
    const was = before[i] ?? null;
    const now = after[i] ?? null;
    if (shownOf(was) !== shownOf(now)) {
      wrong.push(`line ${String(i)}: shows ${shownOf(was)}, natively ${shownOf(now)}`);
      continue;
    }
    if (was?.kind === "amount" && now?.kind === "amount") {
      const wasStated = rows(was.stated);
      const nowStated = rows(now.stated);
      if (wasStated[0] !== nowStated[0]) wrong.push(`line ${String(i)}: first stated ${wasStated[0]}, natively ${nowStated[0]}`);
      const lost = wasStated.filter((row) => !nowStated.includes(row));
      if (lost.length > 0) wrong.push(`line ${String(i)}: natively loses stated ${lost.join(", ")}`);
      const gained = nowStated.filter((row) => !wasStated.includes(row));
      if (gained.length > 0) expected.push(`line ${String(i)} (${now.name}): recipe also says ${gained.join(", ")}`);
      // The popover's conversions are computed from the amount the cook sees,
      // so they may move only where a second stated amount took a unit's
      // place (verify round 1: a canonical amount beside the hint must never
      // reach a computed number).
      const wasConv = was.conversions.filter((row) => !now.stated.some((s) => s.unit === row.unit));
      const nowConv = rows(now.conversions).join(", ");
      if (rows(wasConv).join(", ") !== nowConv) {
        wrong.push(`line ${String(i)} (${now.name}): conversions [${rows(wasConv).join(", ")}], natively [${nowConv}]`);
      }
    }
  }
  for (let i = 0; i < stored.steps; i++) {
    const was = stepAt(projection, i);
    const now = stepAt(native, i);
    if (was === undefined || now === undefined) {
      if (was !== now) wrong.push(`step ${String(i)}: present in only one reading`);
      continue;
    }
    if (was.text !== now.text) wrong.push(`step ${String(i)}: text differs`);
    const wasRefs = (was.ingredient_refs ?? []).join(",");
    const nowRefs = (now.ingredient_refs ?? []).join(",");
    if (wasRefs !== nowRefs) wrong.push(`step ${String(i)}: refs [${wasRefs}], natively [${nowRefs}]`);
    if ((was.timer_sec ?? null) !== (now.timer_sec ?? null)) {
      wrong.push(`step ${String(i)}: timer ${String(was.timer_sec ?? null)}, natively ${String(now.timer_sec ?? null)}`);
    }
    if (now.type !== "action") expected.push(`step ${String(i)}: ${now.type}`);
  }
  if (projection.serves_base !== native.serves_base || projection.serves_estimated !== native.serves_estimated) {
    wrong.push(
      `serves ${String(projection.serves_base)}${projection.serves_estimated ? " (estimate)" : ""}, natively ${String(native.serves_base)}${native.serves_estimated ? " (estimate)" : ""}`,
    );
  }
  return { wrong, expected };
}
