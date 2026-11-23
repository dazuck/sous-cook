/**
 * Cook plans for the registered packs (slice P decision 6): one committed,
 * reviewed file per pack, `app/pack-plans/<pack-id>.cook-plans.json`, never
 * a table and never inside the pack file (the format keeps derived layers
 * out of it). Not under `packs/`, which is the format's corpus: `@sous/pack`'s
 * differential test parses every JSON there as a pack, commons or states.
 * A cook plan is the app's layer, so its files live with the app and deploy
 * with it (`next.config.ts` traces them into the tRPC function).
 *
 * Each entry is keyed by recipe id and holds the plan (or a settled error)
 * with `planSourceHash` of the recipe's projection
 * (`packRecipeToQueueData(recipe, packId).projection.recipeData`: the text the
 * plan is derived from and the shape queueing uses). The file's `stamp` is
 * `cookPlanStamp()` of what made every entry in it: a proposal at a new stamp
 * starts the entries over, so a file never mixes stamps.
 *
 * - `checkPackPlans`: each recipe's status against the file (the golden test,
 *   `generate-pack-cook-plans` check-only).
 * - `proposePackPlans`: derives what's missing or stale (`--propose`); the
 *   diff is reviewed and committed.
 * - `packPlanFor`: the entry a queue add checks (`storedPlanToCopy`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Pack } from "@sous/pack";
import { hasStepsToPlan, parseCookPlan } from "./kitchen/cook-plan";
import { CookPlanCapReached, type DeriveMeter, type DerivedCookPlan } from "./kitchen/cook-plan-derive";
import { cookPlanStamp, isSettledPlanError, planSourceHash, type StoredPlan } from "./kitchen/cook-plan-stamp";
import type { CostLedger } from "./cook-plan-cost";
import { packRecipeToQueueData } from "./pack-convert/to-queue";
import { loadPackFiles, type ShelfSource } from "./shelf/registry";
import type { KitchenQueueRecipeData } from "../../drizzle/schema";

export const PACK_PLAN_FILE_VERSION = 1;

const PackPlanEntrySchema = z
  .strictObject({
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/, "a sha256 hex digest"),
    plan: z.unknown(),
    error: z.string().min(1).nullable(),
  })
  .refine((entry) => (entry.plan === null) !== (entry.error === null), {
    message: "an entry holds a plan or an error, never both or neither",
  });

export const PackPlanFileSchema = z.strictObject({
  version: z.literal(PACK_PLAN_FILE_VERSION),
  packId: z.string().min(1),
  packVersion: z.union([z.string().min(1), z.number()]),
  model: z.string().min(1),
  stamp: z.string().min(1),
  proposedAt: z.string().min(1),
  recipes: z.record(z.string(), PackPlanEntrySchema),
});

export type PackPlanFile = z.infer<typeof PackPlanFileSchema>;
export type PackPlanEntry = PackPlanFile["recipes"][string];

/** Where a pack's plan file lives in the plans directory (`PACK_PLANS_DIR` in the app). */
export function packPlanPath(plansDir: string, packId: string): string {
  return path.join(plansDir, `${packId}.cook-plans.json`);
}

export type PackPlanRead = { ok: true; file: PackPlanFile | null } | { ok: false; reason: string };

/** A pack's plan file, read and validated: null when the pack has none; the reason when it can't be read. */
export async function readPackPlanFile(plansDir: string, packId: string): Promise<PackPlanRead> {
  const file = packPlanPath(plansDir, packId);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, file: null };
    return { ok: false, reason: `${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `${file}: not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const parsed = PackPlanFileSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  if (parsed.data.packId !== packId) {
    return { ok: false, reason: `${file}: holds plans for pack "${parsed.data.packId}", not "${packId}"` };
  }
  return { ok: true, file: parsed.data };
}

/** The entry a queue add checks, with the file's stamp; null when the file has none for the recipe. */
export function packPlanFor(file: PackPlanFile | null, recipeId: string): StoredPlan | null {
  const entry = file?.recipes[recipeId];
  if (file === null || entry === undefined) return null;
  return { plan: entry.plan, error: entry.error, sourceHash: entry.sourceHash, stamp: file.stamp };
}

export type PackPlanStatus =
  | "current"
  | "failed settled"
  | "no steps"
  | "missing"
  | "stale (hash)"
  | "stale (stamp)"
  | "failed transient"
  | "invalid"
  | "doesn't project";

/** Statuses a pack can ship with: a plan that holds, a reviewed settled failure, or nothing to plan. */
export function isPackPlanReady(status: PackPlanStatus): boolean {
  return status === "current" || status === "failed settled" || status === "no steps";
}

/** Statuses `--propose` derives. */
export function packPlanNeedsDerive(status: PackPlanStatus): boolean {
  return (
    status === "missing" ||
    status === "stale (hash)" ||
    status === "stale (stamp)" ||
    status === "failed transient" ||
    status === "invalid"
  );
}

export interface PackRecipePlanCheck {
  recipeId: string;
  title: string;
  status: PackPlanStatus;
  /** Why, for `invalid` (the rule), a failure (the error) or `doesn't project`. */
  detail?: string;
  /** The projection's recipe data and its hash, when the recipe projects. */
  recipeData?: KitchenQueueRecipeData;
  sourceHash?: string;
}

export interface PackPlanCheck {
  packId: string;
  recipes: PackRecipePlanCheck[];
  /** Entries for recipe ids the pack no longer has. */
  extra: string[];
}

/** Every recipe of the pack against its plan file (null: the pack has none), in pack order. */
export function checkPackPlans(pack: Pack, file: PackPlanFile | null, stamp: string = cookPlanStamp()): PackPlanCheck {
  const ids = new Set(pack.recipes.map((r) => r.id));
  const recipes = pack.recipes.map((recipe): PackRecipePlanCheck => {
    const base = { recipeId: recipe.id, title: recipe.title };
    const projected = packRecipeToQueueData(recipe, pack.id);
    if (!projected.ok) return { ...base, status: "doesn't project", detail: projected.differences.join("; ") };
    const recipeData = projected.projection.recipeData;
    if (!hasStepsToPlan(recipeData)) return { ...base, status: "no steps", recipeData };
    const sourceHash = planSourceHash(recipeData);
    const withData = { ...base, recipeData, sourceHash };
    const entry = file?.recipes[recipe.id];
    if (file === null || entry === undefined) return { ...withData, status: "missing" };
    if (file.stamp !== stamp) return { ...withData, status: "stale (stamp)" };
    if (entry.sourceHash !== sourceHash) return { ...withData, status: "stale (hash)" };
    if (entry.error !== null) {
      return { ...withData, status: isSettledPlanError(entry.error) ? "failed settled" : "failed transient", detail: entry.error };
    }
    const parsed = parseCookPlan(entry.plan, recipeData);
    if (!parsed.ok) return { ...withData, status: "invalid", detail: `${parsed.rule}: ${parsed.detail}` };
    return { ...withData, status: "current" };
  });
  const extra = file === null ? [] : Object.keys(file.recipes).filter((id) => !ids.has(id));
  return { packId: pack.id, recipes, extra };
}

export interface ProposedRecipe {
  recipeId: string;
  title: string;
  outcome: "plan" | "failed settled" | "failed transient";
  detail?: string;
  rejections: number;
}

export interface PackPlanProposal {
  /** The file to write, or null when nothing in it would change. */
  file: PackPlanFile | null;
  proposed: ProposedRecipe[];
  /** Recipes that needed a derivation the cap left unstarted. */
  left: string[];
  capReached: boolean;
}

/** `deriveCookPlanOutcome` with the ledger's meter, in the script and the tests (over a stubbed chat). */
export type DeriveForProposal = (
  recipeData: KitchenQueueRecipeData,
  meter: DeriveMeter,
) => Promise<DerivedCookPlan>;

/**
 * Derives what's missing or stale, one recipe at a time, each call checked
 * against the ledger's cap before it is made; once the cap refuses a call,
 * that recipe and the rest are `left`. A plan or a settled error is written with the
 * recipe's hash; a transient failure writes nothing (the entry is dropped, so
 * the next proposal retries it and the golden test names it). Entries for
 * recipes the pack no longer has, or with no steps, are dropped. A new stamp
 * starts the entries over.
 */
export async function proposePackPlans(
  pack: Pack,
  file: PackPlanFile | null,
  derive: DeriveForProposal,
  ledger: CostLedger,
  { model, now = new Date(), stamp = cookPlanStamp() }: { model: string; now?: Date; stamp?: string },
): Promise<PackPlanProposal> {
  const check = checkPackPlans(pack, file, stamp);
  const kept: Record<string, PackPlanEntry> = file !== null && file.stamp === stamp ? { ...file.recipes } : {};
  let changed = file === null || file.stamp !== stamp || file.packVersion !== pack.version || file.model !== model;
  for (const id of check.extra) {
    delete kept[id];
    changed = true;
  }

  const proposed: ProposedRecipe[] = [];
  const left: string[] = [];
  let capReached = false;
  for (const recipe of check.recipes) {
    if (recipe.status === "no steps" && kept[recipe.recipeId] !== undefined) {
      delete kept[recipe.recipeId];
      changed = true;
    }
    if (!packPlanNeedsDerive(recipe.status) || recipe.recipeData === undefined || recipe.sourceHash === undefined) {
      continue;
    }
    if (capReached) {
      left.push(recipe.recipeId);
      continue;
    }
    let derived: DerivedCookPlan;
    try {
      derived = await derive(recipe.recipeData, ledger.meter());
    } catch (err) {
      if (!(err instanceof CookPlanCapReached)) throw err;
      // The cap had no room for one of its calls: its entry stays as it was.
      capReached = true;
      left.push(recipe.recipeId);
      continue;
    }
    ledger.finishRecipe();
    const base = { recipeId: recipe.recipeId, title: recipe.title, rejections: derived.rejections.length };
    changed = true;
    if (derived.plan !== null) {
      kept[recipe.recipeId] = { sourceHash: recipe.sourceHash, plan: derived.plan, error: null };
      proposed.push({ ...base, outcome: "plan" });
    } else if (isSettledPlanError(derived.error)) {
      kept[recipe.recipeId] = { sourceHash: recipe.sourceHash, plan: null, error: derived.error };
      proposed.push({ ...base, outcome: "failed settled", detail: derived.error });
    } else {
      delete kept[recipe.recipeId];
      proposed.push({ ...base, outcome: "failed transient", detail: derived.error });
    }
  }

  if (!changed) return { file: null, proposed, left, capReached };
  // Pack order, so the diff reads like the pack.
  const recipes: Record<string, PackPlanEntry> = {};
  for (const recipe of pack.recipes) {
    const entry = kept[recipe.id];
    if (entry !== undefined) recipes[recipe.id] = entry;
  }
  return {
    file: {
      version: PACK_PLAN_FILE_VERSION,
      packId: pack.id,
      packVersion: pack.version,
      model,
      stamp,
      proposedAt: now.toISOString(),
      recipes,
    },
    proposed,
    left,
    capReached,
  };
}

export interface RegisteredPackPlans {
  pack: Pack;
  /** The pack's plan file; null when it has none or it can't be read. */
  file: PackPlanFile | null;
  /** Why the plan file couldn't be read, when it couldn't. */
  readError?: string;
  check: PackPlanCheck;
}

export interface RegisteredPackPlansCheck {
  packs: RegisteredPackPlans[];
  /** Registered pack files that didn't load, so nothing of theirs could be checked. */
  loadErrors: string[];
}

/** Every registered pack file's recipes against its plan file (the golden test, the script's check-only). */
export async function checkRegisteredPackPlans(
  sources: readonly ShelfSource[],
  { packsDir, plansDir, stamp = cookPlanStamp() }: { packsDir: string; plansDir: string; stamp?: string },
): Promise<RegisteredPackPlansCheck> {
  const loaded = await loadPackFiles(sources, { packsDir });
  const loadErrors = loaded.errors.map((e) => `${e.sourceId}: ${e.reason}`);
  if (loaded.libraries === null) loadErrors.push("the pack libraries didn't load");
  const packs: RegisteredPackPlans[] = [];
  for (const pack of loaded.packs) {
    const read = await readPackPlanFile(plansDir, pack.id);
    const file = read.ok ? read.file : null;
    packs.push({
      pack,
      file,
      ...(!read.ok && { readError: read.reason }),
      check: checkPackPlans(pack, file, stamp),
    });
  }
  return { packs, loadErrors };
}

/**
 * What stops a pack from shipping, one line each, naming the pack and recipe:
 * a recipe whose status isn't ready, an entry for a recipe the pack lost, an
 * unreadable plan file or a pack that didn't load. Empty when every
 * registered pack ships with its plans.
 */
export function packPlanProblems(registered: RegisteredPackPlansCheck): string[] {
  const problems = [...registered.loadErrors];
  for (const { pack, readError, check } of registered.packs) {
    if (readError !== undefined) problems.push(`${pack.id}: plan file unreadable: ${readError}`);
    for (const recipe of check.recipes) {
      if (isPackPlanReady(recipe.status)) continue;
      problems.push(`${pack.id}/${recipe.recipeId}: ${recipe.status}${recipe.detail ? ` (${recipe.detail})` : ""}`);
    }
    for (const id of check.extra) problems.push(`${pack.id}/${id}: plan entry for a recipe the pack doesn't have`);
  }
  return problems;
}

/** The file as committed: two-space JSON with a trailing newline. */
export function serializePackPlanFile(file: PackPlanFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
