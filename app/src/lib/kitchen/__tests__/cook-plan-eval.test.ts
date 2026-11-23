import { describe, it, expect, vi } from "vitest";
import { parseCookPlan } from "../cook-plan";
import { COOK_PLAN_THINKING_BUDGET } from "../cook-plan-derive";
import { cookPlanPromptHash } from "../cook-plan-stamp";
import { scoreCorpus, scoreDerivation } from "../cook-plan-scorer";
import {
  loadCookPlanFixtures,
  loadCookPlanSnapshots,
  GATE_DIR,
  gateRecipe,
  recipeHash,
} from "./load-cook-plan-fixtures";

// Only the prompt is needed from cook-plan-derive; keep the provider SDKs out.
vi.mock("../../ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ai")>()),
  chat: vi.fn(),
}));

/**
 * The eval gate, re-scored offline from the snapshots `scripts/eval-cook-plan.ts`
 * committed. Re-scoring catches a change to validation or scoring that would
 * move the gate; the hash checks catch a prompt or corpus change made without
 * re-running the eval, since the snapshots would then no longer measure the
 * shipped prompt.
 */
describe("cook-plan eval gate (committed snapshots)", () => {
  const fixtures = loadCookPlanFixtures();
  const snapshots = loadCookPlanSnapshots(GATE_DIR);

  it("has one snapshot per corpus recipe", () => {
    expect([...snapshots.keys()]).toEqual(fixtures.map((f) => f.name));
  });

  it("was derived from the shipped prompt, thinking budget and corpus", () => {
    const promptHash = cookPlanPromptHash();
    for (const fixture of fixtures) {
      const snapshot = snapshots.get(fixture.name);
      expect(snapshot, fixture.name).toBeDefined();
      expect(snapshot?.promptHash, `${fixture.name}: re-run the eval`).toBe(promptHash);
      expect(snapshot?.thinkingBudget, fixture.name).toBe(COOK_PLAN_THINKING_BUDGET);
      expect(snapshot?.recipeHash, fixture.name).toBe(recipeHash(gateRecipe(fixture)));
    }
  });

  it("passes every gate", () => {
    const corpus = scoreCorpus(
      fixtures.map((fixture) =>
        scoreDerivation(
          parseCookPlan(snapshots.get(fixture.name)?.raw, gateRecipe(fixture)),
          gateRecipe(fixture),
          fixture.gold,
        ),
      ),
    );
    expect(corpus.gates).toEqual({
      validPlans: true,
      aheadRecall: true,
      aheadPrecision: true,
      miseF1: true,
      handsOffF1: true,
      stepIngredientsF1: true,
    });
  });
});
