/**
 * Pack cook plans (slice P decision 6) over the repo's real Fannie Farmer
 * pack, with crafted edits for the failure rows: a changed step, a new stamp,
 * a corrupted plan, a settled or transient failure, an entry for a recipe the
 * pack lost, and the cap. Derivation is the real one, the script's, over a
 * stubbed chat that answers each recipe with a plan the real validator
 * accepts (or a refused plan, or a 429).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { Pack } from "@sous/pack";
import { chat } from "./ai";
import { parseCookPlan, type CookPlan } from "./kitchen/cook-plan";
import { chainPlan } from "./kitchen/__tests__/chain-plan";
import { deriveCookPlanOutcome } from "./kitchen/cook-plan-derive";
import { cookPlanStamp, isSettledPlanError } from "./kitchen/cook-plan-stamp";
import { CostLedger } from "./cook-plan-cost";
import {
  checkPackPlans,
  packPlanFor,
  packPlanPath,
  proposePackPlans,
  readPackPlanFile,
  serializePackPlanFile,
  type DeriveForProposal,
  type PackPlanFile,
} from "./pack-cook-plans";
import { fannie } from "./pack-convert/__tests__/fannie-native";

const STAMP = cookPlanStamp();
const SETTLED = "rejected (uncovered-step): step 2 is in no task";
const MODEL = "google/gemini-3.5-flash";

function withStep(pack: Pack, recipeId: string, text: string): Pack {
  return {
    ...pack,
    recipes: pack.recipes.map((r) =>
      r.id === recipeId ? { ...r, steps: r.steps.map((s, i) => (i === 0 ? { ...s, text } : s)) } : r,
    ),
  };
}

/** A file whose every recipe has its chain plan at the running stamp. */
function currentFile(pack: Pack): PackPlanFile {
  const check = checkPackPlans(pack, null);
  return {
    version: 1,
    packId: pack.id,
    packVersion: pack.version,
    model: MODEL,
    stamp: STAMP,
    proposedAt: "2026-10-11T00:00:00.000Z",
    recipes: Object.fromEntries(
      check.recipes
        .filter((r) => r.recipeData !== undefined && r.sourceHash !== undefined && r.status === "missing")
        .map((r) => [r.recipeId, { sourceHash: r.sourceHash!, plan: chainPlan(r.recipeData!), error: null }]),
    ),
  };
}

vi.mock("./ai", () => ({ chat: vi.fn() }));
const mockChat = chat as Mock;

beforeEach(() => {
  mockChat.mockReset();
});

/** The derive `generate-pack-cook-plans --propose` runs: the real one, metered by the run's ledger. */
const derive: DeriveForProposal = (recipeData, meter) =>
  deriveCookPlanOutcome(recipeData, { beforeCall: meter.beforeCall, onUsage: meter.onUsage });

type Answer = "plan" | "refused" | "for now";

/**
 * Answers each call by the recipe in its prompt (its first step): its chain
 * plan, the chain plan missing its last step (refused), or a 429. `reported`
 * usage, or none: a call with none is charged its whole bound.
 */
function stubChat(
  pack: Pack,
  answers: Record<string, Answer> = {},
  reported: { inputTokens: number; outputTokens: number } | null = { inputTokens: 3_000, outputTokens: 1_000 },
) {
  const recipes = checkPackPlans(pack, null).recipes;
  mockChat.mockImplementation(async (args: { messages: Array<{ content: string }> }) => {
    const prompt = args.messages[0]!.content;
    // A step line ends with its ingredients when the projection maps them: "[0] <text> (ingredients: …)".
    const recipe = recipes.find((r) => {
      const first = `[0] ${r.recipeData!.steps![0]}`;
      return prompt.includes(`${first}\n`) || prompt.includes(`${first} (ingredients: `);
    });
    if (!recipe) throw new Error("the stub knows no recipe in this prompt");
    const answer = answers[recipe.recipeId] ?? "plan";
    if (answer === "for now") throw new Error("429 Too Many Requests");
    const plan = chainPlan(recipe.recipeData!);
    if (answer === "refused") plan.tasks = plan.tasks.slice(0, -1);
    return { content: JSON.stringify(plan), finishReason: "stop", usage: reported ?? undefined };
  });
}

describe("the chain plan stub", () => {
  it("is a plan the real validator accepts for every Fannie recipe", () => {
    for (const recipe of checkPackPlans(fannie(), null).recipes) {
      expect(recipe.recipeData).toBeDefined();
      const parsed = parseCookPlan(chainPlan(recipe.recipeData!), recipe.recipeData!);
      expect(parsed.ok, `${recipe.recipeId}: ${parsed.ok ? "" : `${parsed.rule} ${parsed.detail}`}`).toBe(true);
    }
  });
});

describe("checkPackPlans", () => {
  it("finds every recipe missing when the pack has no plan file", () => {
    const check = checkPackPlans(fannie(), null);
    expect(check.recipes.map((r) => r.status)).toEqual(["missing", "missing", "missing", "missing", "missing"]);
    expect(check.extra).toEqual([]);
  });

  it("finds every recipe current against a file made for it", () => {
    const pack = fannie();
    expect(checkPackPlans(pack, currentFile(pack)).recipes.every((r) => r.status === "current")).toBe(true);
  });

  it("finds only the edited recipe stale by hash", () => {
    const pack = fannie();
    const file = currentFile(pack);
    const edited = withStep(pack, pack.recipes[1]!.id, "Beat the eggs until light, then add the sugar.");
    expect(checkPackPlans(edited, file).recipes.map((r) => r.status)).toEqual([
      "current",
      "stale (hash)",
      "current",
      "current",
      "current",
    ]);
  });

  it("finds every recipe stale by stamp after a prompt change", () => {
    const pack = fannie();
    const check = checkPackPlans(pack, currentFile(pack), "4:ffffffffffffffff");
    expect(new Set(check.recipes.map((r) => r.status))).toEqual(new Set(["stale (stamp)"]));
  });

  it("tells a settled failure from a transient one, and names a plan that no longer validates", () => {
    const pack = fannie();
    const file = currentFile(pack);
    const [a, b, c] = pack.recipes.map((r) => r.id);
    file.recipes[a!] = { ...file.recipes[a!]!, plan: null, error: SETTLED };
    file.recipes[b!] = { ...file.recipes[b!]!, plan: null, error: "Cook plan derivation timed out after 45 s" };
    const plan = file.recipes[c!]!.plan as CookPlan;
    file.recipes[c!] = { ...file.recipes[c!]!, plan: { ...plan, tasks: plan.tasks.slice(1) } };
    const check = checkPackPlans(pack, file);
    expect(check.recipes.slice(0, 3).map((r) => [r.status, r.detail])).toEqual([
      ["failed settled", SETTLED],
      ["failed transient", "Cook plan derivation timed out after 45 s"],
      ["invalid", expect.stringMatching(/^(uncovered-step|dangling-need)/)],
    ]);
  });

  it("lists entries for recipes the pack no longer has", () => {
    const pack = fannie();
    const file = currentFile(pack);
    file.recipes["gone"] = { ...file.recipes[pack.recipes[0]!.id]! };
    expect(checkPackPlans(pack, file).extra).toEqual(["gone"]);
  });
});

describe("proposePackPlans", () => {
  it("derives every missing recipe and writes them in pack order with the stamp, model and pack version", async () => {
    const pack = fannie();
    stubChat(pack);
    const ledger = new CostLedger(2);
    const proposal = await proposePackPlans(pack, null, derive, ledger, {
      model: MODEL,
      now: new Date("2026-10-11T12:00:00Z"),
    });
    expect(proposal.proposed.map((p) => p.outcome)).toEqual(["plan", "plan", "plan", "plan", "plan"]);
    expect(proposal.file).toMatchObject({
      version: 1,
      packId: pack.id,
      packVersion: pack.version,
      model: MODEL,
      stamp: STAMP,
      proposedAt: "2026-10-11T12:00:00.000Z",
    });
    expect(Object.keys(proposal.file!.recipes)).toEqual(pack.recipes.map((r) => r.id));
    expect(checkPackPlans(pack, proposal.file).recipes.every((r) => r.status === "current")).toBe(true);
    expect(ledger.calls).toBe(5);
    expect(ledger.recipes).toBe(5);
  });

  it("changes nothing and calls nothing when every entry is current", async () => {
    const pack = fannie();
    stubChat(pack);
    const proposal = await proposePackPlans(pack, currentFile(pack), derive, new CostLedger(2), { model: MODEL });
    expect(proposal.file).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("re-derives only the edited recipe and keeps the rest as they were", async () => {
    const pack = fannie();
    const file = currentFile(pack);
    const id = pack.recipes[1]!.id;
    const edited = withStep(pack, id, "Beat the eggs until light, then add the sugar.");
    stubChat(edited);
    const proposal = await proposePackPlans(edited, file, derive, new CostLedger(2), { model: MODEL });
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(proposal.proposed.map((p) => p.recipeId)).toEqual([id]);
    for (const other of pack.recipes.filter((r) => r.id !== id)) {
      expect(proposal.file!.recipes[other.id]).toEqual(file.recipes[other.id]);
    }
    expect(checkPackPlans(edited, proposal.file).recipes.every((r) => r.status === "current")).toBe(true);
  });

  it("starts over at a new stamp, so the file never mixes stamps", async () => {
    const pack = fannie();
    stubChat(pack);
    const proposal = await proposePackPlans(pack, currentFile(pack), derive, new CostLedger(2), {
      model: MODEL,
      stamp: "4:ffffffffffffffff",
    });
    expect(mockChat).toHaveBeenCalledTimes(5);
    expect(proposal.file!.stamp).toBe("4:ffffffffffffffff");
  });

  it("writes a settled failure with its hash, and drops a transient one so the next proposal retries it", async () => {
    const pack = fannie();
    const [first, second] = pack.recipes.map((r) => r.id);
    stubChat(pack, { [first!]: "refused", [second!]: "for now" });
    const proposal = await proposePackPlans(pack, null, derive, new CostLedger(2), { model: MODEL });
    const settled = proposal.file!.recipes[first!];
    expect(settled).toMatchObject({ plan: null, error: expect.stringMatching(/^rejected \(uncovered-step\): /) });
    expect(isSettledPlanError(settled!.error!)).toBe(true);
    expect(proposal.proposed.find((p) => p.recipeId === first)?.rejections).toBe(2);
    expect(proposal.file!.recipes[second!]).toBeUndefined();
    expect(checkPackPlans(pack, proposal.file).recipes.slice(0, 2).map((r) => r.status)).toEqual([
      "failed settled",
      "missing",
    ]);
  });

  it("drops entries for recipes the pack no longer has", async () => {
    const pack = fannie();
    const file = currentFile(pack);
    file.recipes["gone"] = { ...file.recipes[pack.recipes[0]!.id]! };
    stubChat(pack);
    const proposal = await proposePackPlans(pack, file, derive, new CostLedger(2), { model: MODEL });
    expect(proposal.file!.recipes["gone"]).toBeUndefined();
  });

  it("stops at the call the cap can't cover, naming what's left, every call charged its bound", async () => {
    const pack = fannie();
    // No usage reported, so each call is charged its whole bound (about $0.09):
    // room for one, not two.
    stubChat(pack, {}, null);
    const ledger = new CostLedger(0.15);
    const proposal = await proposePackPlans(pack, null, derive, ledger, { model: MODEL });
    expect(proposal.capReached).toBe(true);
    expect(proposal.proposed.map((p) => p.outcome)).toEqual(["plan"]);
    expect(proposal.left).toEqual(pack.recipes.slice(1).map((r) => r.id));
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(ledger.unreported).toBe(1);
    expect(ledger.spentUsd).toBeGreaterThan(0.075);
    expect(ledger.spentUsd).toBeLessThanOrEqual(0.15);
  });
});

describe("the plan file on disk", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pack-plans-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads as null when the pack has none", async () => {
    expect(await readPackPlanFile(dir, "fannie-farmer-1896")).toEqual({ ok: true, file: null });
  });

  it("round-trips through its serialization", async () => {
    const file = currentFile(fannie());
    await writeFile(packPlanPath(dir, file.packId), serializePackPlanFile(file));
    expect(await readPackPlanFile(dir, file.packId)).toEqual({ ok: true, file });
  });

  it("refuses a file that isn't JSON, breaks the shape, or names another pack", async () => {
    const at = packPlanPath(dir, "fannie-farmer-1896");
    await writeFile(at, "{");
    expect(await readPackPlanFile(dir, "fannie-farmer-1896")).toMatchObject({ ok: false, reason: expect.stringMatching(/not JSON/) });

    const file = currentFile(fannie());
    const id = Object.keys(file.recipes)[0]!;
    await writeFile(at, JSON.stringify({ ...file, recipes: { [id]: { ...file.recipes[id], error: SETTLED } } }));
    expect(await readPackPlanFile(dir, "fannie-farmer-1896")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/a plan or an error, never both/),
    });

    await writeFile(at, JSON.stringify({ ...file, packId: "other" }));
    expect(await readPackPlanFile(dir, "fannie-farmer-1896")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/holds plans for pack "other"/),
    });
  });
});

describe("packPlanFor", () => {
  it("gives the recipe's entry with the file's stamp, or null", () => {
    const file = currentFile(fannie());
    const id = Object.keys(file.recipes)[0]!;
    expect(packPlanFor(file, id)).toEqual({
      plan: file.recipes[id]!.plan,
      error: null,
      sourceHash: file.recipes[id]!.sourceHash,
      stamp: STAMP,
    });
    expect(packPlanFor(file, "nope")).toBeNull();
    expect(packPlanFor(null, id)).toBeNull();
  });
});
