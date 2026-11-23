/**
 * Step-ingredient assignment eval.
 *
 * Scores how well each approach maps ingredients to cooking steps against the
 * labeled corpus in src/lib/kitchen/__tests__/fixtures/step-ingredients/.
 *
 *   Regex (default, no API key needed):
 *     npx tsx scripts/eval-step-ingredients.ts
 *     npx tsx scripts/eval-step-ingredients.ts --approach regex
 *
 *   LLM-assigned (requires GOOGLE_AI_API_KEY — runs the real model on the
 *   fixture's exact ingredient + step lists, so indices stay aligned to the
 *   golden labels and the score reflects assignment quality, not extraction):
 *     env -u DATABASE_URL pnpm dotenv -o -e .env.local -- npx tsx scripts/eval-step-ingredients.ts --approach llm-assigned
 *
 * Use this to capture the regex baseline, then compare the LLM approach.
 */

import {
  loadStepIngredientFixtures,
  regexPredictions,
  fixtureIngredientStrings,
  type StepIngredientFixture,
} from "../src/lib/kitchen/__tests__/load-step-ingredient-fixtures";
import {
  scoreStepIngredients,
  type ScoreResult,
} from "../src/lib/kitchen/step-ingredient-scorer";

type Approach = "regex" | "llm-assigned";

function parseApproach(argv: string[]): Approach {
  const idx = argv.indexOf("--approach");
  if (idx === -1) return "regex";
  const value = argv[idx + 1];
  if (value === "regex" || value === "llm-assigned") return value;
  throw new Error(`Unknown --approach "${value}" (use regex|llm-assigned)`);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`.padStart(6);
}

/**
 * Ask the model to assign ingredients to steps for ONE recipe, using the
 * fixture's exact (numbered) ingredient list and steps so the returned indices
 * line up with the golden labels. Returns null if the model's array length does
 * not match the step count (we only score aligned outputs).
 */
async function llmAssign(
  fixture: StepIngredientFixture,
): Promise<number[][] | null> {
  const { chat } = await import("../src/lib/ai");

  const ingredientStrings = fixtureIngredientStrings(fixture);
  const ingredientList = ingredientStrings
    .map((s, i) => `${i}: ${s}`)
    .join("\n");
  const stepList = fixture.steps.map((s, i) => `${i}: ${s}`).join("\n");

  const prompt = `You are assigning recipe ingredients to the cooking steps that use them.

INGREDIENTS (index: text):
${ingredientList}

STEPS (index: text):
${stepList}

For each step, list the indices of the ingredients ACTIVELY USED in that step.
Rules:
- Attribute each ingredient to the step where it is first added or measured. A grouped reference ("the dry ingredients", "the wet ingredients", "the spice blend") means its specific ingredients - resolve it at the step where they are combined.
- Do NOT re-list ingredients already combined into a component. When a later step uses a previously-made component ("pour in the sauce", "add the tempering"), list ONLY the ingredients newly introduced at that step.
- Pervasive seasonings (salt, pepper, oil) only on their FIRST real use, not every step that mentions cooking.
- Garnishes / finishing ingredients only on the plating/finishing step.
- Use [] for technique or timing steps that introduce no ingredient.
- Only indices that exist in the ingredient list above.

Return ONLY JSON: {"stepIngredients": [[..], [..], ...]} with EXACTLY ${fixture.steps.length} arrays, one per step in order.`;

  const response = await chat({
    messages: [{ role: "user", content: prompt }],
    responseFormat: "json",
    thinkingBudget: 0,
    maxTokens: 4096,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    return null;
  }
  const raw = (parsed as { stepIngredients?: unknown }).stepIngredients;
  if (!Array.isArray(raw) || raw.length !== fixture.steps.length) return null;

  return raw.map((arr) =>
    Array.isArray(arr)
      ? arr.filter((n): n is number => typeof n === "number")
      : [],
  );
}

async function main(): Promise<void> {
  const approach = parseApproach(process.argv.slice(2));
  const fixtures = loadStepIngredientFixtures();

  console.log(`\nStep-ingredient eval — approach: ${approach}\n`);
  console.log(
    `${"fixture".padEnd(28)} ${"macroF1"} ${"microF1"} ${"  prec"} ${"recall"}  steps`,
  );
  console.log("-".repeat(70));

  const allPredictions: number[][] = [];
  const allGolden: number[][] = [];
  let skipped = 0;

  for (const fixture of fixtures) {
    let predictions: number[][] | null;
    if (approach === "regex") {
      predictions = regexPredictions(fixture);
    } else {
      predictions = await llmAssign(fixture);
    }

    if (predictions === null) {
      skipped++;
      console.log(
        `${fixture.name.padEnd(28)} ${"—".padStart(6)} (skipped: step count mismatch)`,
      );
      continue;
    }

    const result: ScoreResult = scoreStepIngredients(
      predictions,
      fixture.golden,
    );
    allPredictions.push(...predictions);
    allGolden.push(...fixture.golden);

    console.log(
      `${fixture.name.padEnd(28)} ${pct(result.macroF1)} ${pct(result.microF1)} ${pct(result.microPrecision)} ${pct(result.microRecall)}  ${fixture.steps.length}`,
    );
  }

  console.log("-".repeat(70));
  if (allGolden.length > 0) {
    const corpus = scoreStepIngredients(allPredictions, allGolden);
    console.log(
      `${"CORPUS".padEnd(28)} ${pct(corpus.macroF1)} ${pct(corpus.microF1)} ${pct(corpus.microPrecision)} ${pct(corpus.microRecall)}  ${allGolden.length}`,
    );
    console.log(
      `\nCorpus macro F1: ${(corpus.macroF1 * 100).toFixed(1)}%  |  micro F1: ${(corpus.microF1 * 100).toFixed(1)}%  |  scored steps: ${corpus.scoredSteps}/${allGolden.length}`,
    );
  }
  if (skipped > 0) {
    console.log(`\n${skipped} fixture(s) skipped (step-count mismatch).`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
