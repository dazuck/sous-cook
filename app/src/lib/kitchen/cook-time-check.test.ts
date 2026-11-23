import { describe, it, expect } from "vitest";
import {
  COOK_PLAN_VERSION,
  type CookPlan,
  type CookTask,
} from "./cook-plan";
import {
  ABANDONED_RATIO,
  checkCook,
  checkCookTimes,
  median,
  type FinishedCook,
} from "./cook-time-check";

function task(
  partial: Pick<CookTask, "id" | "kind"> & Partial<CookTask>,
): CookTask {
  return {
    text: partial.id,
    label: partial.id,
    ingredientIdx: [],
    sourceStep: partial.kind === "cook" ? 0 : null,
    implied: false,
    needs: [],
    branch: "Main",
    ...partial,
  };
}

/** 37 minutes scheduled (chop 5, fry 10 inside a 30-minute simmer, combine 2), shown as 40. */
const PLAN: CookPlan = {
  version: COOK_PLAN_VERSION,
  tasks: [
    task({ id: "chop", kind: "mise", minutes: { est: 5, handsOff: false } }),
    task({
      id: "simmer",
      kind: "cook",
      branch: "Beans",
      minutes: { est: 30, handsOff: true },
    }),
    task({
      id: "fry",
      kind: "cook",
      sourceStep: 1,
      needs: ["chop"],
      minutes: { est: 10, handsOff: false },
    }),
    task({
      id: "combine",
      kind: "cook",
      sourceStep: 2,
      needs: ["simmer", "fry"],
      minutes: { est: 2, handsOff: false },
    }),
  ],
};

/** One estimated 2-minute task beside three unestimated ones: 75% nominal. */
const GUESSED: CookPlan = {
  version: COOK_PLAN_VERSION,
  tasks: [
    task({ id: "a", kind: "cook", minutes: { est: 2, handsOff: false } }),
    task({ id: "b", kind: "cook", sourceStep: 1, needs: ["a"] }),
    task({ id: "c", kind: "cook", sourceStep: 2, needs: ["b"] }),
    task({ id: "d", kind: "cook", sourceStep: 3, needs: ["c"] }),
  ],
};

const START = new Date("2026-10-04T22:00:00Z");
const after = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

function cook(overrides: Partial<FinishedCook> = {}): FinishedCook {
  return {
    id: "q",
    name: "Dal",
    startedAt: START,
    completedAt: after(50),
    cookPlan: PLAN,
    cookLog: null,
    finishedBy: "pressed",
    ...overrides,
  };
}

describe("checkCook", () => {
  it("measures actual minutes against the shown total", () => {
    expect(checkCook(cook())).toEqual({
      id: "q",
      name: "Dal",
      completedAt: after(50),
      actualMinutes: 50,
      derivedMinutes: 37,
      shownMinutes: 40,
      ratio: 1.25,
      nominalHeavy: false,
      excluded: null,
      logged: null,
      finishedBy: "pressed",
    });
  });

  it("reads serialized stamps", () => {
    const checked = checkCook(
      cook({
        startedAt: START.toISOString(),
        completedAt: after(20).toISOString(),
      }),
    );
    expect(checked.actualMinutes).toBe(20);
    expect(checked.ratio).toBe(0.5);
  });

  it.each([
    ["before-T", { completedAt: null }],
    ["no-start", { startedAt: null }],
    ["no-plan", { cookPlan: null }],
    ["no-plan", { cookPlan: { ...PLAN, version: COOK_PLAN_VERSION - 1 } }],
    ["no-plan", { cookPlan: { version: COOK_PLAN_VERSION, tasks: [] } }],
    ["invalid", { completedAt: START }],
    ["invalid", { completedAt: after(-5) }],
  ] as const)("excludes %s", (reason, overrides) => {
    expect(checkCook(cook(overrides)).excluded).toBe(reason);
  });

  it("names before-T first when neither stamp exists", () => {
    expect(checkCook(cook({ startedAt: null, completedAt: null })).excluded).toBe(
      "before-T",
    );
  });

  it("keeps a cook at exactly 3x the shown total and excludes one past it", () => {
    const limit = 40 * ABANDONED_RATIO;
    expect(checkCook(cook({ completedAt: after(limit) })).excluded).toBeNull();
    expect(checkCook(cook({ completedAt: after(limit + 1) })).excluded).toBe(
      "abandoned",
    );
  });

  it("flags a nominal-heavy plan and keeps it", () => {
    const checked = checkCook(cook({ cookPlan: GUESSED, completedAt: after(12) }));
    expect(checked.nominalHeavy).toBe(true);
    expect(checked.excluded).toBeNull();
    expect(checked.shownMinutes).toBe(10);
    expect(checked.ratio).toBe(1.2);
  });

  it("says how the Cook Log row came about", () => {
    const log = { row: 2, timestamp: "2026-10-04 18:50", recipeName: "Dal" };
    expect(checkCook(cook({ cookLog: { ...log, adopted: true } })).logged).toBe(
      "adopted",
    );
    expect(checkCook(cook({ cookLog: { ...log, adopted: false } })).logged).toBe(
      "appended",
    );
  });
});

// Decision 7: an auto-finished cook is dated to its last activity, so the
// minutes it sat idle on its last screen before the app finished it are never
// counted, and it is measured like any other cook.
describe("checkCook: a cook the app finished", () => {
  it("measures to its last activity, not to when the app noticed", () => {
    // Left at 50 minutes; the app finished it 45 idle minutes later, dated 50.
    const checked = checkCook(cook({ completedAt: after(50), finishedBy: "auto" }));
    expect(checked.actualMinutes).toBe(50);
    expect(checked.ratio).toBe(1.25);
    expect(checked.excluded).toBeNull();
    expect(checked.finishedBy).toBe("auto");
  });

  it("is counted apart in the summary", () => {
    const summary = checkCookTimes([
      cook({ id: "a", finishedBy: "auto" }),
      cook({ id: "b" }),
      cook({ id: "c", finishedBy: null }),
    ]);
    expect(summary.finished).toEqual({ pressed: 1, auto: 1, unknown: 1 });
    expect(summary.measured).toBe(3);
  });
});

describe("median", () => {
  it("takes the middle of an odd count and the mean of the middle two of an even", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("is null for nothing", () => {
    expect(median([])).toBeNull();
  });
});

describe("checkCookTimes", () => {
  it("medians the measured cooks only and counts each exclusion", () => {
    const summary = checkCookTimes([
      cook({ id: "a", completedAt: after(20) }), // 0.5
      cook({ id: "b", completedAt: after(40) }), // 1
      cook({ id: "c", completedAt: after(60) }), // 1.5
      cook({ id: "d", cookPlan: GUESSED, completedAt: after(30) }), // 3, nominal-heavy
      cook({ id: "e", completedAt: after(600) }), // abandoned
      cook({ id: "f", startedAt: null }),
      cook({ id: "g", completedAt: null }),
      cook({ id: "h", cookPlan: null }),
    ]);

    expect(summary.measured).toBe(4);
    expect(summary.medianRatio).toBe(1.25);
    expect(summary.nominalHeavy).toBe(1);
    expect(summary.excluded).toEqual({
      "before-T": 1,
      "no-start": 1,
      "no-plan": 1,
      invalid: 0,
      abandoned: 1,
    });
    expect(summary.cooks.map((c) => c.id)).toEqual([
      "a", "b", "c", "d", "e", "f", "g", "h",
    ]);
  });

  it("counts appended, adopted and unlogged cooks", () => {
    const log = { row: 2, timestamp: "2026-10-04 18:50", recipeName: "Dal" };
    const summary = checkCookTimes([
      cook({ cookLog: { ...log, adopted: false } }),
      cook({ cookLog: { ...log, adopted: true } }),
      cook({ cookLog: { ...log, adopted: true } }),
      cook(),
    ]);
    expect(summary.logged).toEqual({ appended: 1, adopted: 2, none: 1 });
  });

  it("has no median with nothing measured", () => {
    const summary = checkCookTimes([cook({ startedAt: null })]);
    expect(summary.measured).toBe(0);
    expect(summary.medianRatio).toBeNull();
  });
});
