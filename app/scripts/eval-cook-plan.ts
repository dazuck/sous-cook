/**
 * Cook-plan derivation eval.
 *
 * Derives a plan for every recipe in the labelled corpus
 * (src/lib/kitchen/__tests__/fixtures/cook-plan/), scores it, prints the gate,
 * and writes one snapshot per recipe. The committed snapshots in
 * fixtures/cook-plan/gate/ are what `cook-plan-eval.test.ts` re-scores
 * offline, so re-run this after any change to the prompt or the corpus. A
 * recipe borrowed from the step-ingredient corpus is derived with its
 * labelled mapping (`gateRecipe`). fixtures/cook-plan/derived/ is the fixed
 * set the layout tests cook; this never writes it.
 *
 *   env -u DATABASE_URL pnpm dotenv -o -e .env.local -- npx tsx scripts/eval-cook-plan.ts
 *     [--thinking N]   thinking budget (default: COOK_PLAN_THINKING_BUDGET)
 *     [--only NAME]    derive one recipe (repeatable)
 *     [--out DIR]      write snapshots elsewhere, e.g. to compare budgets
 *                      without touching the committed set
 *
 * Costs real model calls: 15 recipes, one or two calls each.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../src/lib/ai";
import { scriptMeter } from "../src/lib/ai/meter";
import { parseCookPlan } from "../src/lib/kitchen/cook-plan";
import {
  COOK_PLAN_THINKING_BUDGET,
  CookPlanDerivationError,
  deriveCookPlan,
  type DerivationUsage,
} from "../src/lib/kitchen/cook-plan-derive";
import { cookPlanPromptHash } from "../src/lib/kitchen/cook-plan-stamp";
import { microAverage } from "../src/lib/kitchen/step-ingredient-scorer";
import {
  COOK_PLAN_GATES,
  scoreCorpus,
  scoreDerivation,
  type DerivationScore,
} from "../src/lib/kitchen/cook-plan-scorer";
import {
  GATE_DIR,
  gateRecipe,
  loadCookPlanFixtures,
  recipeHash,
  type CookPlanFixture,
  type CookPlanSnapshot,
} from "../src/lib/kitchen/__tests__/load-cook-plan-fixtures";

const CONCURRENCY = 4;

interface Args {
  thinking: number;
  only: string[];
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { thinking: COOK_PLAN_THINKING_BUDGET, only: [], out: GATE_DIR };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--thinking") {
      args.thinking = Number(value);
      if (!Number.isInteger(args.thinking) || args.thinking < 0) {
        throw new Error(`--thinking must be a non-negative integer, got "${value}"`);
      }
    } else if (flag === "--only") {
      args.only.push(value);
    } else if (flag === "--out") {
      args.out = value;
    } else {
      throw new Error(`Unknown flag "${flag}"`);
    }
    i++;
  }
  return args;
}

async function derive(
  fixture: CookPlanFixture,
  thinking: number,
  model: string,
): Promise<CookPlanSnapshot> {
  const started = Date.now();
  const base = {
    model,
    thinkingBudget: thinking,
    promptHash: cookPlanPromptHash(),
    recipeHash: recipeHash(gateRecipe(fixture)),
  };
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const onUsage = (call: DerivationUsage) => {
    usage.calls++;
    usage.inputTokens += call.inputTokens;
    usage.outputTokens += call.outputTokens;
  };
  try {
    const { raw, rejections } = await deriveCookPlan(gateRecipe(fixture), {
      thinkingBudget: thinking,
      onUsage,
      meter: scriptMeter("eval-cook-plan"),
    });
    reasked.set(fixture.name, rejections.map((r) => `${r.rule}: ${r.detail}`));
    return { ...base, ms: Date.now() - started, error: null, raw, usage };
  } catch (err) {
    if (err instanceof CookPlanDerivationError) {
      reasked.set(fixture.name, err.rejections.map((r) => `${r.rule}: ${r.detail}`));
    }
    const error = err instanceof Error ? err.message : String(err);
    return { ...base, ms: Date.now() - started, error, raw: null, usage };
  }
}

/** Replies validation rejected, per recipe (not in the snapshot). */
const reasked = new Map<string, string[]>();

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`.padStart(4);
}

function diff(predicted: number[], gold: number[]): { extra: number[]; missing: number[] } {
  const p = new Set(predicted);
  const g = new Set(gold);
  return {
    extra: [...p].filter((i) => !g.has(i)).sort((a, b) => a - b),
    missing: [...g].filter((i) => !p.has(i)).sort((a, b) => a - b),
  };
}

/** What went wrong in one recipe, in words, for iterating on the prompt. */
function details(fixture: CookPlanFixture, snapshot: CookPlanSnapshot, scored: DerivationScore): string[] {
  const lines: string[] = [];
  if (snapshot.error) lines.push(`error: ${snapshot.error}`);
  if (typeof snapshot.raw === "string") {
    lines.push(`rejected (shape): not JSON, ends ${JSON.stringify(snapshot.raw.slice(-40))}`);
    return lines;
  }
  const result = parseCookPlan(snapshot.raw, gateRecipe(fixture));
  if (!result.ok) {
    lines.push(`rejected (${result.rule}): ${result.detail}`);
    return lines;
  }
  const { plan } = result;
  const { ahead } = scored.score;
  for (const what of ahead.missed) lines.push(`ahead missed: ${what}`);
  for (const text of ahead.falseAlarms) lines.push(`ahead false alarm: ${text}`);

  const ing = (i: number) => `${i} ${gateRecipe(fixture).ingredients[i]?.item ?? "?"}`;
  const mise = diff(
    plan.tasks.filter((t) => t.kind === "mise").flatMap((t) => t.ingredientIdx),
    fixture.gold.mise,
  );
  if (mise.extra.length) lines.push(`mise extra: ${mise.extra.map(ing).join("; ")}`);
  if (mise.missing.length) lines.push(`mise missing: ${mise.missing.map(ing).join("; ")}`);

  const handsOff = diff(
    plan.tasks.flatMap((t) => (t.minutes?.handsOff && t.sourceStep !== null ? [t.sourceStep] : [])),
    fixture.gold.handsOffSteps,
  );
  const step = (i: number) => `${i} "${gateRecipe(fixture).steps[i].slice(0, 60)}"`;
  if (handsOff.extra.length) lines.push(`hands-off extra: ${handsOff.extra.map(step).join("; ")}`);
  if (handsOff.missing.length) lines.push(`hands-off missing: ${handsOff.missing.map(step).join("; ")}`);

  // Per step of the mapping, what the tasks citing it dropped (or listed beyond it).
  gateRecipe(fixture).stepIngredients?.forEach((uses, s) => {
    const listed = diff(
      plan.tasks.filter((t) => t.sourceStep === s).flatMap((t) => t.ingredientIdx),
      uses,
    );
    if (listed.missing.length) lines.push(`step ${s} ingredients dropped: ${listed.missing.map(ing).join("; ")}`);
    if (listed.extra.length) lines.push(`step ${s} ingredients extra: ${listed.extra.map(ing).join("; ")}`);
  });
  return lines;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = getConfig();
  const model = `${config.textProvider}/${config.textModel}`;

  const all = loadCookPlanFixtures();
  const unknown = args.only.filter((name) => !all.some((f) => f.name === name));
  if (unknown.length) throw new Error(`No fixture named ${unknown.join(", ")}`);
  const fixtures = args.only.length ? all.filter((f) => args.only.includes(f.name)) : all;

  console.log(`\nCook-plan eval: ${model}, thinking ${args.thinking}, ${fixtures.length} recipe(s)\n`);
  mkdirSync(args.out, { recursive: true });

  const snapshots = await pool(fixtures, CONCURRENCY, async (fixture) => {
    const snapshot = await derive(fixture, args.thinking, model);
    writeFileSync(join(args.out, `${fixture.name}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
    process.stdout.write(`  derived ${fixture.name} (${(snapshot.ms / 1000).toFixed(1)}s)\n`);
    return snapshot;
  });

  console.log(`\n${"recipe".padEnd(28)} valid  tasks br  ahead  mise P/R  hands-off P/R  step ing P/R   secs`);
  console.log("-".repeat(98));
  const scores = fixtures.map((fixture, i) => {
    const snapshot = snapshots[i];
    const result = parseCookPlan(snapshot.raw, gateRecipe(fixture));
    const scored = scoreDerivation(result, gateRecipe(fixture), fixture.gold);
    const tasks = result.ok ? result.plan.tasks : [];
    const branches = new Set(tasks.map((t) => t.branch)).size;
    const { ahead, mise, handsOff } = scored.score;
    const stepIngredients = scored.score.stepIngredients.length > 0 ? microAverage(scored.score.stepIngredients) : null;
    console.log(
      [
        fixture.name.padEnd(28),
        (scored.valid ? "yes" : (scored.rule ?? "no")).padEnd(6),
        String(tasks.length).padStart(5),
        String(branches).padStart(2),
        `${ahead.found}/${ahead.items}+${ahead.tasks - ahead.matchedTasks}`.padStart(6),
        ` ${pct(mise.precision)}/${pct(mise.recall)}`,
        `    ${pct(handsOff.precision)}/${pct(handsOff.recall)}`,
        (stepIngredients ? `${pct(stepIngredients.precision)}/${pct(stepIngredients.recall)}` : "-").padStart(13),
        (snapshot.ms / 1000).toFixed(1).padStart(8),
      ].join(" "),
    );
    for (const line of details(fixture, snapshot, scored)) console.log(`    ${line}`);
    return scored;
  });

  const corpus = scoreCorpus(scores);
  const slowest = Math.max(...snapshots.map((s) => s.ms)) / 1000;
  console.log("-".repeat(98));
  console.log(`ahead column: items found / items + false alarms. Slowest: ${slowest.toFixed(1)}s\n`);
  const rejected = fixtures.filter((f) => (reasked.get(f.name)?.length ?? 0) > 0);
  console.log(`Re-asked after a rejected reply: ${rejected.length}/${fixtures.length}`);
  for (const f of rejected) {
    for (const why of reasked.get(f.name) ?? []) console.log(`  ${f.name}: ${why.slice(0, 160)}`);
  }
  console.log("");

  const rows: Array<[string, string, string, boolean]> = [
    ["valid plans", `${corpus.valid}/${corpus.plans}`, `>= ${(COOK_PLAN_GATES.validPlans * corpus.plans).toFixed(0)}/${corpus.plans}`, corpus.gates.validPlans],
    ["ahead recall", corpus.ahead.recall.toFixed(3), `= ${COOK_PLAN_GATES.aheadRecall}`, corpus.gates.aheadRecall],
    ["ahead precision", corpus.ahead.precision.toFixed(3), `>= ${COOK_PLAN_GATES.aheadPrecision}`, corpus.gates.aheadPrecision],
    ["mise F1", corpus.mise.f1.toFixed(3), `>= ${COOK_PLAN_GATES.miseF1}`, corpus.gates.miseF1],
    ["hands-off F1", corpus.handsOff.f1.toFixed(3), `>= ${COOK_PLAN_GATES.handsOffF1}`, corpus.gates.handsOffF1],
    ["step ingr. F1", corpus.stepIngredients.f1.toFixed(3), `>= ${COOK_PLAN_GATES.stepIngredientsF1}`, corpus.gates.stepIngredientsF1],
  ];
  for (const [name, value, gate, passed] of rows) {
    console.log(`  ${name.padEnd(16)} ${value.padStart(7)}  ${gate.padEnd(8)}  ${passed ? "pass" : "FAIL"}`);
  }
  console.log(`\nGate: ${corpus.passed ? "PASSED" : "FAILED"}`);
  if (fixtures.length < all.length) console.log("(partial corpus: the gate is defined over all 15)");
  console.log(`Snapshots: ${args.out}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
