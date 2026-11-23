/**
 * The step-0 dry run (slice B4): every exported library and queue recipe run
 * through the converter, and what it found, without writing anything. The
 * logic behind `scripts/convert-report.ts`, kept here so it is tested on
 * local rows; the script only reads the export files and prints.
 *
 * Export rows are read as the plan's two queries select them (snake_case
 * columns, jsonb as JSON). A row whose shape the stored types don't describe
 * is reported as unreadable with its issues, never guessed into shape: that is
 * itself a finding about the data.
 */

import { z } from "zod";
import type { SchemaIssue } from "@sous/pack";
import type { AsWrittenReason } from "@sous/pack/quantity";
import {
  ingredientAt,
  legacyRecipeSchema,
  legacyToPackRecipe,
  stepAt,
  type ConversionReport,
  type LegacyRecipe,
  type LineKind,
  type MappingStatus,
  type ServesEstimateInput,
} from "./convert";

const legacy = legacyRecipeSchema.shape;

/**
 * `select doc_slug, name, … from doc_recipes where extraction_error is null`:
 * the converter's own reading (`legacyRecipeSchema`), in the export's
 * snake_case columns, each column present.
 */
export const libraryRowSchema = z.object({
  doc_slug: z.string(),
  name: legacy.name,
  ingredients: legacy.ingredients.unwrap(),
  steps: legacy.steps.unwrap(),
  step_ingredients: legacy.stepIngredients,
  serves: legacy.serves.unwrap(),
  estimated_time: legacy.estimatedTime.unwrap(),
  tags: legacy.tags.unwrap(),
  notes: legacy.notes.unwrap(),
});

/** Only the indices matter here; any plan version carries them. */
const storedPlan = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      sourceStep: z.number().nullable(),
      ingredientIdx: z.array(z.number()),
    }),
  ),
});

/** `select id, recipe_data, cook_plan from kitchen_queue where recipe_data is not null` */
export const queueRowSchema = z.object({
  id: z.string(),
  recipe_data: legacyRecipeSchema,
  cook_plan: z.unknown(),
});

export interface RowRef {
  source: "library" | "queue";
  /** The library's `doc_slug`, or the queue row's id. */
  key: string;
  name: string;
}

export interface DryRun {
  rows: number;
  converted: number;
  counts: Record<LineKind, number>;
  /** Every line shown with no number, and why. */
  noNumberLines: (RowRef & {
    index: number;
    item: string;
    kind: "as_written" | "unstated";
    reason?: AsWrittenReason;
    text?: string;
  })[];
  asWrittenReasons: Partial<Record<AsWrittenReason, number>>;
  /** Every line whose amount was read from its joined text, not its stored fields. */
  readFromText: (RowRef & { index: number; text: string; kind: LineKind })[];
  /** Unit spellings outside the reader's table, with how often each appears. */
  unitsOutsideTable: Record<string, number>;
  /** Rows that state no count and carry Sous's estimate (slice B4b). */
  estimatedServes: (RowRef & { count: number })[];
  /** Rows that state no count and have no estimate: refused. */
  noServes: RowRef[];
  emptySteps: RowRef[];
  emptyIngredients: RowRef[];
  /** Rows whose steps get no refs, and why. */
  unusableMappings: (RowRef & { status: Exclude<MappingStatus, "used"> })[];
  multiDurationSteps: (RowRef & { step: number; text: string })[];
  longTimerSteps: (RowRef & { step: number; text: string })[];
  passiveDropped: number;
  failedValidation: (RowRef & { issues: SchemaIssue[] })[];
  unreadableRows: { source: RowRef["source"]; at: number; issues: string[] }[];
  /** Queue rows with a stored plan: how many indices were checked. */
  plansChecked: number;
  indicesChecked: number;
  unreadablePlans: RowRef[];
  /** Every stored plan index past the stored recipe's lines. Expected: none. */
  indicesOutOfRange: PlanIndex[];
  /**
   * Every stored blank line the converter skipped (B4 fix round 2), by stored
   * index. The rest keep their stored index as their id.
   */
  blankLines: (RowRef & { field: "steps" | "ingredients"; index: number })[];
  /** Every stored plan index naming a blank line: it pairs nothing on the cook page. */
  indicesAtBlankLines: PlanIndex[];
}

type PlanIndex = RowRef & {
  task: string;
  field: "sourceStep" | "ingredientIdx";
  index: number;
};

function emptyDryRun(): DryRun {
  return {
    rows: 0,
    converted: 0,
    counts: { measured: 0, compound: 0, count: 0, to_taste: 0, unstated: 0, as_written: 0 },
    noNumberLines: [],
    asWrittenReasons: {},
    readFromText: [],
    unitsOutsideTable: {},
    estimatedServes: [],
    noServes: [],
    emptySteps: [],
    emptyIngredients: [],
    unusableMappings: [],
    multiDurationSteps: [],
    longTimerSteps: [],
    passiveDropped: 0,
    failedValidation: [],
    unreadableRows: [],
    plansChecked: 0,
    indicesChecked: 0,
    unreadablePlans: [],
    indicesOutOfRange: [],
    blankLines: [],
    indicesAtBlankLines: [],
  };
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

function record(run: DryRun, ref: RowRef, legacy: LegacyRecipe, report: ConversionReport): void {
  for (const kind of Object.keys(report.counts) as LineKind[]) {
    run.counts[kind] += report.counts[kind];
  }
  for (const line of report.lines) {
    if (line.readFromText !== undefined) {
      run.readFromText.push({ ...ref, index: line.index, text: line.readFromText, kind: line.kind });
    }
    if (line.kind === "as_written") {
      run.noNumberLines.push({
        ...ref,
        index: line.index,
        item: line.item,
        kind: "as_written",
        reason: line.reason,
        text: line.text,
      });
      run.asWrittenReasons[line.reason!] = (run.asWrittenReasons[line.reason!] ?? 0) + 1;
    } else if (line.kind === "unstated") {
      run.noNumberLines.push({ ...ref, index: line.index, item: line.item, kind: "unstated" });
    }
  }
  for (const unit of report.unitsOutsideTable) {
    run.unitsOutsideTable[unit] = (run.unitsOutsideTable[unit] ?? 0) + 1;
  }
  for (const index of report.blankIngredients) {
    run.blankLines.push({ ...ref, field: "ingredients", index });
  }
  for (const index of report.blankSteps) run.blankLines.push({ ...ref, field: "steps", index });
  if (report.serves === "no-estimate") run.noServes.push(ref);
  // Empty as converted: none stored, or every one blank.
  if ((legacy.steps ?? []).length === report.blankSteps.length) run.emptySteps.push(ref);
  if ((legacy.ingredients ?? []).length === report.blankIngredients.length) {
    run.emptyIngredients.push(ref);
  }
  if (report.mapping !== "used") run.unusableMappings.push({ ...ref, status: report.mapping });
  for (const step of report.multiDurationSteps) {
    run.multiDurationSteps.push({ ...ref, step, text: legacy.steps![step]! });
  }
  for (const step of report.longTimerSteps) {
    run.longTimerSteps.push({ ...ref, step, text: legacy.steps![step]! });
  }
  if (report.passiveDropped) run.passiveDropped += 1;
}

function convertRow(
  run: DryRun,
  ref: RowRef,
  legacy: LegacyRecipe,
  servesEstimate: ServesEstimateInput | undefined,
) {
  run.rows += 1;
  const result = legacyToPackRecipe(legacy, { id: ref.key, servesEstimate });
  if (result.report.serves === "estimated") {
    run.estimatedServes.push({ ...ref, count: servesEstimate!.count });
  }
  record(run, ref, legacy, result.report);
  if (!result.ok) {
    run.failedValidation.push({ ...ref, issues: result.issues });
    return null;
  }
  run.converted += 1;
  return { recipe: result.recipe, report: result.report };
}

/**
 * Where a stored plan index lands in the converted recipe: a line (looked up
 * by its stored-index id), a blank line the converter skipped, or past the
 * stored list.
 */
function placeIndex(
  run: DryRun,
  at: PlanIndex,
  found: boolean,
  blank: readonly number[],
): void {
  run.indicesChecked += 1;
  if (found) return;
  if (blank.includes(at.index)) run.indicesAtBlankLines.push(at);
  else run.indicesOutOfRange.push(at);
}

/**
 * Run both exports through the converter. `library` and `queue` are the
 * export files' parsed JSON: arrays of rows.
 */
export function dryRun({
  library,
  queue,
  estimates = new Map(),
}: {
  library: unknown[];
  queue: unknown[];
  /**
   * Sous's estimates by row (`library:<slug>`, `queue:<id>`), e.g. from the
   * reviewed file (`scripts/data/serves-estimates.json`); an export has none.
   */
  estimates?: ReadonlyMap<string, ServesEstimateInput>;
}): DryRun {
  const run = emptyDryRun();

  library.forEach((raw, at) => {
    const parsed = libraryRowSchema.safeParse(raw);
    if (!parsed.success) {
      run.unreadableRows.push({ source: "library", at, issues: issuesOf(parsed.error) });
      return;
    }
    const row = parsed.data;
    convertRow(
      run,
      { source: "library", key: row.doc_slug, name: row.name },
      {
        name: row.name,
        ingredients: row.ingredients,
        steps: row.steps,
        estimatedTime: row.estimated_time,
        serves: row.serves,
        tags: row.tags,
        notes: row.notes,
        // The converter checks the mapping's shape and reports a malformed one.
        stepIngredients: row.step_ingredients as LegacyRecipe["stepIngredients"],
      },
      estimates.get(`library:${row.doc_slug}`),
    );
  });

  queue.forEach((raw, at) => {
    const parsed = queueRowSchema.safeParse(raw);
    if (!parsed.success) {
      run.unreadableRows.push({ source: "queue", at, issues: issuesOf(parsed.error) });
      return;
    }
    const { id, recipe_data: data, cook_plan: cookPlan } = parsed.data;
    const ref: RowRef = { source: "queue", key: id, name: data.name };
    const converted = convertRow(
      run,
      ref,
      { ...data, stepIngredients: data.stepIngredients as LegacyRecipe["stepIngredients"] },
      estimates.get(`queue:${id}`),
    );
    if (cookPlan === null || cookPlan === undefined || converted === null) return;
    const { recipe, report } = converted;

    const plan = storedPlan.safeParse(cookPlan);
    if (!plan.success) {
      run.unreadablePlans.push(ref);
      return;
    }
    run.plansChecked += 1;
    for (const task of plan.data.tasks) {
      if (task.sourceStep !== null) {
        const index = task.sourceStep;
        placeIndex(
          run,
          { ...ref, task: task.id, field: "sourceStep", index },
          stepAt(recipe, index) !== undefined,
          report.blankSteps,
        );
      }
      for (const index of task.ingredientIdx) {
        placeIndex(
          run,
          { ...ref, task: task.id, field: "ingredientIdx", index },
          ingredientAt(recipe, index) !== undefined,
          report.blankIngredients,
        );
      }
    }
  });

  return run;
}

function label(ref: RowRef): string {
  return `${ref.source} ${ref.key} (${ref.name})`;
}

function section(title: string, lines: string[]): string[] {
  return [`\n${title}: ${lines.length}`, ...lines.map((l) => `  ${l}`)];
}

/** The dry run as the text the slice report quotes. */
export function formatDryRun(run: DryRun): string {
  const out: string[] = [];
  out.push(
    `${run.rows} recipe(s) read, ${run.converted} converted, ${run.failedValidation.length} refused by the format, ${run.unreadableRows.length} unreadable row(s).`,
  );
  const lines = Object.values(run.counts).reduce((a, b) => a + b, 0);
  out.push(`\nLines by class (${lines}):`);
  for (const [kind, n] of Object.entries(run.counts)) out.push(`  ${kind.padEnd(10)} ${n}`);
  out.push(
    ...section(
      "As-written reasons",
      Object.entries(run.asWrittenReasons).map(([r, n]) => `${r}: ${n}`),
    ),
  );
  out.push(
    ...section(
      "Lines shown with no number (as written, unstated)",
      run.noNumberLines.map((l) =>
        l.kind === "as_written"
          ? `${label(l)} #${l.index} as written [${l.reason}]: ${JSON.stringify(l.text)}`
          : `${label(l)} #${l.index} unstated: ${JSON.stringify(l.item)}`,
      ),
    ),
  );
  out.push(
    ...section(
      "Amounts read from the line's text",
      run.readFromText.map((l) => `${label(l)} #${l.index} ${l.kind}: ${JSON.stringify(l.text)}`),
    ),
  );
  out.push(
    ...section(
      "Unit spellings outside the table",
      Object.entries(run.unitsOutsideTable)
        .sort((a, b) => b[1] - a[1])
        .map(([u, n]) => `${JSON.stringify(u)} ×${n}`),
    ),
  );
  out.push(
    ...section(
      "Blank lines skipped",
      run.blankLines.map((b) => `${label(b)} ${b.field} #${b.index}`),
    ),
  );
  out.push(
    ...section(
      "Serves: Sous's estimate",
      run.estimatedServes.map((r) => `${label(r)}: ${r.count}`),
    ),
  );
  out.push(...section("Serves: none, refused", run.noServes.map(label)));
  out.push(...section("Empty steps", run.emptySteps.map(label)));
  out.push(...section("Empty ingredients", run.emptyIngredients.map(label)));
  out.push(
    ...section(
      "Without a usable mapping",
      run.unusableMappings.map((r) => `${label(r)}: ${r.status}`),
    ),
  );
  out.push(
    ...section(
      "Multi-duration steps (timer is the first)",
      run.multiDurationSteps.map((s) => `${label(s)} step ${s.step}: ${JSON.stringify(s.text)}`),
    ),
  );
  out.push(
    ...section(
      "Timers over 12 hours (kept as stated)",
      run.longTimerSteps.map((s) => `${label(s)} step ${s.step}: ${JSON.stringify(s.text)}`),
    ),
  );
  out.push(`\nPassive time dropped (no pack field): ${run.passiveDropped}`);
  out.push(
    ...section(
      "Refused by the format",
      run.failedValidation.map(
        (f) => `${label(f)}: ${f.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
      ),
    ),
  );
  out.push(
    ...section(
      "Unreadable rows",
      run.unreadableRows.map((r) => `${r.source} row ${r.at}: ${r.issues.join("; ")}`),
    ),
  );
  out.push(`\nStored plans checked: ${run.plansChecked}, ${run.indicesChecked} index(es).`);
  out.push(...section("Unreadable stored plans", run.unreadablePlans.map(label)));
  out.push(
    ...section(
      "Stored plan indices out of range (expected 0)",
      run.indicesOutOfRange.map((o) => `${label(o)} task ${o.task} ${o.field} ${o.index}`),
    ),
  );
  out.push(
    ...section(
      "Stored plan indices at a blank line (pair nothing)",
      run.indicesAtBlankLines.map((o) => `${label(o)} task ${o.task} ${o.field} ${o.index}`),
    ),
  );
  return out.join("\n") + "\n";
}
