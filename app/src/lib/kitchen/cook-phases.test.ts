import { describe, expect, it } from "vitest";
import { buildCookPhases } from "./cook-phases";
import { parseCookPlan, type CookPlan } from "./cook-plan";
import { loadKitchenPlans } from "./__tests__/load-kitchen-plans";
import {
  loadCookPlanFixtures,
  loadCookPlanSnapshots,
} from "./__tests__/load-cook-plan-fixtures";

describe("buildCookPhases", () => {
  const kitchenPlans = loadKitchenPlans();
  const cookFixtures = loadCookPlanFixtures();
  const cookSnapshots = loadCookPlanSnapshots();

  function getCookPlan(name: string): CookPlan {
    const snap = cookSnapshots.get(name);
    const fix = cookFixtures.find((f) => f.name === name);
    expect(snap).toBeDefined();
    expect(fix).toBeDefined();
    const parsed = parseCookPlan(snap!.raw, fix!.recipe);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    return parsed.plan;
  }

  it("groups Skillet Eggs into 4 natural phases in both Prep first and As I go with stable cooking keys", () => {
    const skillet = kitchenPlans.find(
      (p) => p.name === "skillet-eggs-potatoes-greens",
    )!.plan;

    const first = buildCookPhases(skillet, "first", new Set(), 0);
    const go = buildCookPhases(skillet, "go", new Set(), 0);

    expect(first.mode).toBe("first");
    expect(first.firstTotalMinutes).toBe(40);
    expect(first.goTotalMinutes).toBe(28);
    expect(first.totalMinutes).toBe(40);
    expect(first.handsOnMinutes).toBe(28);
    expect(first.ahead).toEqual([]);

    expect(first.phases.map((p) => ({
      n: p.n,
      key: p.key,
      kind: p.kind,
      title: p.title,
      minutes: p.minutes,
    }))).toEqual([
      { n: 1, key: "phase:prep", kind: "prep", title: "Prep", minutes: 18 },
      {
        n: 2,
        key: "cook:cook-potatoes",
        kind: "cook",
        title: "Crisp the potatoes",
        minutes: 12,
      },
      {
        n: 3,
        key: "cook:saute-aromatics",
        kind: "cook",
        title: "Wilt the greens",
        minutes: 5,
      },
      {
        n: 4,
        key: "cook:cook-eggs",
        kind: "cook",
        title: "Crack eggs and steam",
        minutes: 5,
      },
    ]);

    // Phase 1 in "first" mode has summary for upfront mise ("Dice potatoes and slice onion.") and movable capsule for the 4 movable tasks (10 min)
    expect(first.phases[0].summary).toBe("Dice potatoes and slice onion.");
    expect(first.phases[0].movable).toEqual({
      key: "movable:prep-spinach+prep-escarole+slice-garlic+slice-chile",
      text: "Prep spinach, prep escarole, slice garlic, and slice chile",
      minutes: 10,
      hint: "can do in step 2",
    });

    // Phase 2 in "first" mode has a 12-min passive window and no meanwhile prep
    expect(first.phases[1].passiveWindow).toEqual({
      minutes: 12,
      label: "12 min hands-off window",
    });
    expect(first.phases[1].meanwhile).toBeNull();

    // In "go" mode, total is 28 min and still 4 phases with identical cooking keys
    expect(go.totalMinutes).toBe(28);
    expect(go.phases).toHaveLength(4);
    expect(go.phases.slice(1).map((p) => p.key)).toEqual(
      first.phases.slice(1).map((p) => p.key),
    );

    expect(go.phases[0]).toMatchObject({
      n: 1,
      key: "phase:prep",
      kind: "prep",
      title: "Prep before heat",
      minutes: 8,
      summary: "Dice potatoes and slice onion.",
      movable: null,
    });

    // In "go" mode, the 4 movable mise tasks (10 min) move into Phase 2's 12-min window, leaving 2 min hands-off
    expect(go.phases[1].passiveWindow).toBeNull();
    expect(go.phases[1].meanwhile).toEqual({
      key: "meanwhile:slice-garlic+slice-chile+prep-spinach+prep-escarole",
      text: "Slice garlic, slice chile, prep spinach, and prep escarole",
      minutes: 10,
      remainingFreeMinutes: 2,
      remainingLabel: "2 min hands-off",
    });
  });

  it("sets Phase 1 summary to null in Prep first when 100% of upfront mise is movable (Chicken Pita Wraps) and omits Prep in As I go", () => {
    const wraps = kitchenPlans.find(
      (p) => p.name === "chicken-pita-wraps",
    )!.plan;

    const first = buildCookPhases(wraps, "first", new Set(), 0);
    const go = buildCookPhases(wraps, "go", new Set(), 0);

    // Ahead group is populated from the 2-6 hours before marinade chain
    expect(first.ahead).toHaveLength(1);
    expect(first.ahead[0].lead).toBe("2-6 hours before");
    expect(first.ahead[0].summary).toContain("Mince garlic");

    // In "first" mode: Phase 1 is Prep with summary: null because 100% of mise is movable
    expect(first.phases).toHaveLength(6);
    expect(first.phases[0]).toMatchObject({
      n: 1,
      key: "phase:prep",
      kind: "prep",
      title: "Prep",
      minutes: 8,
      summary: null,
      movable: {
        key: "movable:chop-garlic-hummus+slice-cabbage+slice-cucumbers",
        text: "Chop garlic, slice cabbage, and slice cucumbers",
        minutes: 8,
        hint: "can do in step 2",
      },
    });

    // In "go" mode: upfront prep is empty so Phase 1 Prep disappears (5 phases total) and cook keys match 1-to-1
    expect(go.phases).toHaveLength(5);
    expect(go.phases.every((p) => p.kind === "cook")).toBe(true);
    expect(go.phases.map((p) => p.key)).toEqual(
      first.phases.slice(1).map((p) => p.key),
    );

    // The moved mise tasks appear in `meanwhile` on their host cooking phases
    const meanwhilePhases = go.phases.filter((p) => p.meanwhile !== null);
    expect(meanwhilePhases.length).toBeGreaterThanOrEqual(1);
    const allMeanwhileIds = meanwhilePhases
      .flatMap((p) => p.meanwhile!.key.replace(/^meanwhile:/, "").split("+"));
    expect(allMeanwhileIds).toEqual([
      "chop-garlic-hummus",
      "slice-cucumbers",
      "slice-cabbage",
    ]);
  });

  it("computes passive windows and remaining free time on Sunday Roast Dinner", () => {
    const roast = getCookPlan("sunday-roast-dinner");

    const first = buildCookPhases(roast, "first", new Set(), 0);
    const go = buildCookPhases(roast, "go", new Set(), 0);

    expect(first.phases.length).toBeGreaterThanOrEqual(5);
    expect(first.phases.length).toBeLessThanOrEqual(6);

    // Phase 1 in "first" mode has 21 min total mise, 18 min movable (prep-potatoes + trim-beans + chop-shallot)
    expect(first.phases[0]).toMatchObject({
      n: 1,
      kind: "prep",
      minutes: 21,
      movable: {
        key: "movable:prep-potatoes+trim-beans+chop-shallot",
        minutes: 18,
      },
    });

    // Main roast phase has a 50 min free-to-step-away passive window in "first" mode
    const mainRoastPhaseFirst = first.phases.find(
      (p) => p.key === "cook:roast-chicken-and-potatoes",
    )!;
    expect(mainRoastPhaseFirst).toBeDefined();
    expect(mainRoastPhaseFirst.passiveWindow).toEqual({
      minutes: 50,
      label: "50 min free to step away",
    });

    // In "go" mode, movable mise moves into the cooking phases' meanwhile slots
    const meanwhilePhasesGo = go.phases.filter((p) => p.meanwhile !== null);
    expect(meanwhilePhasesGo.length).toBeGreaterThanOrEqual(1);
    const movedIds = meanwhilePhasesGo.flatMap((p) =>
      p.meanwhile!.key.replace(/^meanwhile:/, "").split("+"),
    );
    expect(movedIds).toEqual(
      expect.arrayContaining(["prep-potatoes", "trim-beans", "chop-shallot"]),
    );
  });

  it("marks phases done, now, and ahead and calculates remainingMinutes for activeTaskId", () => {
    const skillet = kitchenPlans.find(
      (p) => p.name === "skillet-eggs-potatoes-greens",
    )!.plan;

    const midCook = buildCookPhases(
      skillet,
      "first",
      new Set(),
      22,
      "cook-potatoes",
    );

    expect(midCook.phases.map((p) => ({
      n: p.n,
      state: p.state,
      remainingMinutes: p.remainingMinutes,
    }))).toEqual([
      { n: 1, state: "done", remainingMinutes: 0 },
      { n: 2, state: "now", remainingMinutes: 8 },
      { n: 3, state: "ahead", remainingMinutes: 5 },
      { n: 4, state: "ahead", remainingMinutes: 5 },
    ]);
  });

  it("keeps phase counts between 2 and 6 across all kitchen-plan and cook-plan fixtures", () => {
    const allPlans: CookPlan[] = [...kitchenPlans.map((p) => p.plan)];
    for (const [name, snap] of cookSnapshots.entries()) {
      const fix = cookFixtures.find((f) => f.name === name);
      if (!fix || !snap.raw) continue;
      const parsed = parseCookPlan(snap.raw, fix.recipe);
      if (parsed.ok && parsed.plan.tasks.some((t) => t.kind === "cook")) {
        allPlans.push(parsed.plan);
      }
    }

    for (const plan of allPlans) {
      for (const mode of ["first", "go"] as const) {
        const res = buildCookPhases(plan, mode, new Set(), 0);
        expect(res.phases.length).toBeGreaterThanOrEqual(2);
        expect(res.phases.length).toBeLessThanOrEqual(6);
      }
    }
  });
});
