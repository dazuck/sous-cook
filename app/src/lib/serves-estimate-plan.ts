/**
 * The reviewed-estimates file and what to do with it (slice B4b). The prod
 * recipes that state no serving count get Sous's estimate from a file made
 * once by `scripts/estimate-serves.ts --propose`, reviewed, and committed
 * (`scripts/data/serves-estimates.json`), so what lands in prod is exactly
 * what was reviewed. The deploy's check-only compares that file with prod
 * (`planServesEstimates`, pure and free) and `--apply` writes it.
 *
 * A row is matched by its table and key (a `doc_recipes` slug, a
 * `kitchen_queue` id) and by a hash of the source the estimate was made from
 * (`raw_doc_text`, or the stored recipe), so a recipe edited since its review
 * is never given an estimate made for older text.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export const ESTIMATE_TABLES = ["doc_recipes", "kitchen_queue"] as const;
export type EstimateTable = (typeof ESTIMATE_TABLES)[number];

export const estimateEntrySchema = z.strictObject({
  table: z.enum(ESTIMATE_TABLES),
  /** The doc slug, or the queue row's id. */
  key: z.string().min(1),
  name: z.string(),
  /** `sourceHash` of the source the estimate was made from. */
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  count: z.number().int().min(1).max(48),
  basis: z.string().min(1).max(240),
  /** Whether any line gave an amount; false means the count rests on the dish alone. */
  hasAmounts: z.boolean(),
});
export type EstimateEntry = z.infer<typeof estimateEntrySchema>;

export const estimateFileSchema = z
  .strictObject({
    version: z.literal(1),
    proposedAt: z.string().min(1),
    model: z.string().min(1),
    entries: z.array(estimateEntrySchema),
  })
  .refine(
    (file) =>
      new Set(file.entries.map((e) => `${e.table}:${e.key}`)).size === file.entries.length,
    { error: "an entry appears twice (same table and key)" },
  );
export type EstimateFile = z.infer<typeof estimateFileSchema>;

/** JSON with every object's keys sorted, so a hash doesn't depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The hash a file entry keeps of its source: sha256 of a library row's
 * `raw_doc_text`, or of a queue row's `recipe_data` as canonical JSON.
 */
export function sourceHash(table: EstimateTable, source: unknown): string {
  const text = table === "doc_recipes" ? String(source) : canonicalJson(source);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A row as the plan reads it, from prod or from an export. */
export interface EstimateRow {
  table: EstimateTable;
  key: string;
  name: string;
  /** `raw_doc_text`, or the stored `recipe_data`. */
  source: unknown;
  /** The count the source states; null when it states none. */
  stated: number | null;
  estimate: number | null;
  basis: string | null;
  /** `sourceHash` of the text the stored estimate was made from. */
  estimateSourceHash: string | null;
}

export type RowPlanKind =
  /** In the file, no estimate yet, source unchanged: `--apply` writes it. */
  | "write"
  /** Already holds exactly the file's estimate, for the same source. */
  | "applied"
  /**
   * In the file, but needs it no more: the source states a count now, or the
   * row holds another estimate (the sync's, for newer text). Left alone.
   */
  | "superseded"
  /** Not in the file, holds an estimate a sync or an add made: left alone. */
  | "estimated-elsewhere"
  /**
   * A warning, not the release's fault: states no count, has no estimate, and
   * isn't in the file (a recipe that arrived since). `--propose-missing`
   * fills it.
   */
  | "missing"
  /**
   * In an applied file, but the row is gone since (the family's Remove
   * deletes a queue row): nothing to write, nothing lost. Listed, exit 0.
   */
  | "removed"
  // Problems: a file row that still needs its write and can't have it. The
  // check exits 1 and `--apply` writes nothing.
  /** In the file, no estimate yet, but its source changed since the estimate was made. */
  | "stale"
  /** In a file not yet applied, and no such row: its write can't land. */
  | "gone";

export const PROBLEMS: ReadonlySet<RowPlanKind> = new Set(["stale", "gone"]);
export const WARNINGS: ReadonlySet<RowPlanKind> = new Set(["missing"]);

export interface RowPlan {
  kind: RowPlanKind;
  table: EstimateTable;
  key: string;
  name: string;
  /** The file's entry, when there is one. */
  entry?: EstimateEntry;
}

export interface EstimatePlan {
  rows: RowPlan[];
  counts: Record<RowPlanKind, number>;
  /** False when any row is a problem (warnings don't count). */
  ok: boolean;
}

const rowId = (table: EstimateTable, key: string) => `${table}:${key}`;

/** One row's plan against its entry (or none). */
export function planRow(row: EstimateRow | undefined, entry: EstimateEntry | undefined): RowPlan | null {
  if (row === undefined) {
    // Only an entry can name a row that isn't there.
    return entry ? { kind: "gone", table: entry.table, key: entry.key, name: entry.name, entry } : null;
  }
  const base = { table: row.table, key: row.key, name: row.name };
  if (entry === undefined) {
    if (row.stated !== null) return null;
    return { ...base, kind: row.estimate === null ? "missing" : "estimated-elsewhere" };
  }
  const withEntry = { ...base, entry };
  if (row.stated !== null) return { ...withEntry, kind: "superseded" };
  if (row.estimate !== null) {
    const same =
      row.estimate === entry.count &&
      row.basis === entry.basis &&
      row.estimateSourceHash === entry.sourceHash;
    return { ...withEntry, kind: same ? "applied" : "superseded" };
  }
  if (sourceHash(row.table, row.source) !== entry.sourceHash) return { ...withEntry, kind: "stale" };
  return { ...withEntry, kind: "write" };
}

/**
 * What the file would do to these rows: one plan per row that states no
 * count or that the file names, in the file's order, then the rest.
 */
export function planServesEstimates(rows: readonly EstimateRow[], file: EstimateFile): EstimatePlan {
  const byId = new Map(rows.map((row) => [rowId(row.table, row.key), row]));
  const plans: RowPlan[] = [];
  const named = new Set<string>();
  for (const entry of file.entries) {
    const id = rowId(entry.table, entry.key);
    named.add(id);
    plans.push(planRow(byId.get(id), entry)!);
  }
  for (const row of rows) {
    if (named.has(rowId(row.table, row.key))) continue;
    const plan = planRow(row, undefined);
    if (plan) plans.push(plan);
  }
  // Once the file is applied, a row gone since was applied before it went:
  // benign. Before the apply, a gone row is one whose write can't land. A file
  // row holding any estimate (its own, or the sync's since) is the evidence:
  // before the apply, no file row can hold one.
  const applied = plans.some(
    (plan) => plan.entry !== undefined && (byId.get(rowId(plan.table, plan.key))?.estimate ?? null) !== null,
  );
  if (applied) {
    for (const plan of plans) if (plan.kind === "gone") plan.kind = "removed";
  }
  const counts = {
    write: 0,
    applied: 0,
    superseded: 0,
    "estimated-elsewhere": 0,
    missing: 0,
    removed: 0,
    stale: 0,
    gone: 0,
  } satisfies Record<RowPlanKind, number>;
  for (const plan of plans) counts[plan.kind] += 1;
  return { rows: plans, counts, ok: plans.every((plan) => !PROBLEMS.has(plan.kind)) };
}

/** A queue row's stated count: `recipe_data.serves` when it is a number. */
export function statedInRecipeData(recipeData: unknown): number | null {
  if (recipeData === null || typeof recipeData !== "object") return null;
  const serves = (recipeData as { serves?: unknown }).serves;
  return typeof serves === "number" ? serves : null;
}
