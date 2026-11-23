/**
 * The golden check (slice P decision 7): every registered pack ships with its
 * plans. Each recipe of each registered pack file (`SHELF_SOURCES`) projects,
 * and its entry in `app/pack-plans/<pack-id>.cook-plans.json` is at the
 * running stamp, matches the projection's hash, and re-parses with
 * `parseCookPlan` (or is a reviewed settled failure). A pack edit or a prompt
 * change fails here until `generate-pack-cook-plans --propose` has been run
 * and its diff reviewed. No model calls.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkRegisteredPackPlans, packPlanProblems } from "../../pack-cook-plans";
import { PACK_PLANS_DIR, PACKS_DIR } from "../../shelf/load";
import { SHELF_SOURCES } from "../../shelf/registry";

const dirs = { packsDir: PACKS_DIR, plansDir: PACK_PLANS_DIR };

describe("the golden check", () => {
  it("finds every registered pack's plans current", async () => {
    const registered = await checkRegisteredPackPlans(SHELF_SOURCES, dirs);
    expect(registered.packs.map((p) => p.pack.id)).toEqual(["fannie-farmer-1896"]);
    expect(packPlanProblems(registered)).toEqual([]);
  });

  it("fails naming a registered pack that has no plan file", async () => {
    const plansDir = await mkdtemp(path.join(tmpdir(), "no-pack-plans-"));
    try {
      const registered = await checkRegisteredPackPlans(SHELF_SOURCES, { ...dirs, plansDir });
      const [fannie] = registered.packs;
      expect(fannie).toBeDefined();
      const problems = packPlanProblems(registered);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((p) => p.startsWith(`${fannie!.pack.id}/`))).toBe(true);
      expect(problems.every((p) => /: (missing|doesn't project)/.test(p))).toBe(true);
    } finally {
      await rm(plansDir, { recursive: true });
    }
  });

  it("fails every recipe at a stamp the file wasn't made at", async () => {
    const registered = await checkRegisteredPackPlans(SHELF_SOURCES, { ...dirs, stamp: "4:ffffffffffffffff" });
    const problems = packPlanProblems(registered);
    expect(problems).toHaveLength(registered.packs[0]!.pack.recipes.length);
    expect(problems.every((p) => p.endsWith(": stale (stamp)"))).toBe(true);
  });
});
