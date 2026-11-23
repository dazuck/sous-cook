/**
 * The registered packs' cook plans (slice P decision 6): one committed,
 * reviewed file per pack, `app/pack-plans/<pack-id>.cook-plans.json`.
 *
 * Check-only (the default, free, no network): every recipe of every
 * registered pack file against its plan file, with the cost estimate for
 * what `--propose` would derive. Exits 1 when a pack can't ship as it stands
 * (the golden test, `cook-plan-golden.test.ts`, fails on the same lines).
 *
 * `--propose` (paid): derives what's missing or stale with the default text
 * model, one recipe at a time under the cap, and writes only the plan files.
 * Review the diff and commit it with the pack change. Exits 1 if a recipe
 * failed transiently (re-run to retry it) or the cap stopped the run.
 *
 *   npx tsx scripts/generate-pack-cook-plans.ts                       # check only
 *   env -u DATABASE_URL pnpm dotenv -o -e <env file> -- npx tsx scripts/generate-pack-cook-plans.ts --propose [--max-usd 2]
 *
 * Run from `app/` (the packs are `../packs`, the plans `pack-plans/`). `--propose` needs
 * GOOGLE_AI_API_KEY and refuses to run with AI_TEXT_MODEL or AI_TEXT_PROVIDER
 * set: plans use the model the eval was tuned on (P non-goal 8).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CostLedger, describeEstimate, estimateCost, formatUsd, maxUsdArg } from "../src/lib/cook-plan-cost";
import { scriptMeter } from "../src/lib/ai/meter";
import { deriveCookPlanOutcome } from "../src/lib/kitchen/cook-plan-derive";
import {
  checkRegisteredPackPlans,
  packPlanNeedsDerive,
  packPlanPath,
  packPlanProblems,
  proposePackPlans,
  serializePackPlanFile,
  type DeriveForProposal,
} from "../src/lib/pack-cook-plans";
import { PACK_PLANS_DIR, PACKS_DIR } from "../src/lib/shelf/load";
import { SHELF_SOURCES } from "../src/lib/shelf/registry";
import { defaultModelOrRefuse } from "./default-model";

const derive: DeriveForProposal = (recipeData, meter) =>
  deriveCookPlanOutcome(recipeData, {
    beforeCall: meter.beforeCall,
    onUsage: meter.onUsage,
    meter: scriptMeter("generate-pack-cook-plans"),
  });

async function main(): Promise<void> {
  const propose = process.argv.includes("--propose");
  const maxUsd = maxUsdArg(process.argv);
  const registered = await checkRegisteredPackPlans(SHELF_SOURCES, { packsDir: PACKS_DIR, plansDir: PACK_PLANS_DIR });

  let toDerive = 0;
  for (const { pack, file, readError, check } of registered.packs) {
    const fileLine = readError ?? (file === null ? "no plan file" : `stamp ${file.stamp}, proposed ${file.proposedAt}`);
    console.log(`${pack.id} (version ${pack.version}, ${pack.recipes.length} recipes): ${fileLine}`);
    for (const recipe of check.recipes) {
      if (packPlanNeedsDerive(recipe.status)) toDerive++;
      console.log(`  ${recipe.status.padEnd(16)} ${recipe.recipeId}${recipe.detail ? `: ${recipe.detail}` : ""}`);
    }
    for (const id of check.extra) console.log(`  ${"extra".padEnd(16)} ${id} (dropped by --propose)`);
  }
  for (const error of registered.loadErrors) console.error(`Load error: ${error}`);
  console.log(`\n${toDerive} recipe(s) to derive.`);
  console.log(describeEstimate(estimateCost(toDerive), "assumed per-call tokens, P \"Cost\""));

  if (!propose) {
    const problems = packPlanProblems(registered);
    if (problems.length === 0) {
      console.log("Every registered pack ships with current plans.");
      return;
    }
    console.log("\nCheck only. Re-run with --propose to derive what's missing or stale, then review the diff.");
    throw new Error(`${problems.length} problem(s) stop a pack from shipping`);
  }

  if (registered.loadErrors.length > 0) throw new Error("A registered pack didn't load; fix it before proposing.");
  const model = defaultModelOrRefuse("--propose");
  const ledger = new CostLedger(maxUsd);
  console.log(`\nProposing with ${model}, cap ${formatUsd(maxUsd)}.`);

  let transient = 0;
  let capReached = false;
  for (const { pack, file, readError } of registered.packs) {
    if (readError !== undefined) throw new Error(`${pack.id}: the plan file is unreadable; fix or remove it first.`);
    const proposal = await proposePackPlans(pack, file, derive, ledger, { model });
    for (const p of proposal.proposed) {
      const rejections = p.rejections > 0 ? ` after ${p.rejections} rejection(s)` : "";
      console.log(`  ${p.outcome.padEnd(16)} ${pack.id}/${p.recipeId}${rejections}${p.detail ? `: ${p.detail}` : ""}`);
      if (p.outcome === "failed transient") transient++;
    }
    for (const id of proposal.left) console.log(`  ${"left (cap)".padEnd(16)} ${pack.id}/${id}`);
    capReached ||= proposal.capReached;
    if (proposal.file === null) {
      console.log(`${pack.id}: nothing to change.`);
      continue;
    }
    const out = packPlanPath(PACK_PLANS_DIR, pack.id);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, serializePackPlanFile(proposal.file));
    console.log(`${pack.id}: wrote ${path.relative(process.cwd(), out)}. Review the diff before committing.`);
  }

  console.log(`\n${ledger.describe()}`);
  const observed = ledger.observedEstimate(toDerive);
  if (observed) console.log(describeEstimate(observed, "observed means of this run"));
  if (capReached) throw new Error(`The cap of ${formatUsd(maxUsd)} stopped the run before every recipe was derived.`);
  if (transient > 0) throw new Error(`${transient} recipe(s) failed transiently; re-run --propose to retry them.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
