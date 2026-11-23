import { describe, it, expect } from "vitest";
import {
  COOK_PLAN_VERSION,
  identityPlan,
  parseCookPlan,
  type CookPlan,
  type CookTask,
} from "./cook-plan";
import { NOMINAL_MINUTES, timeline } from "./cook-schedule";
import {
  NOMINAL_SHARE_LIMIT,
  recipeTimes,
  roundUpToFive,
  shownTimes,
} from "./recipe-times";
import {
  loadCookPlanFixtures,
  loadCookPlanSnapshots,
} from "./__tests__/load-cook-plan-fixtures";

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

function plan(tasks: CookTask[]): CookPlan {
  return { version: COOK_PLAN_VERSION, tasks };
}

/** Chop, then a 30-minute simmer that runs while the onion fries. */
const OVERLAP = plan([
  task({ id: "chop", kind: "mise", minutes: { est: 5, handsOff: false } }),
  task({
    id: "simmer",
    kind: "cook",
    branch: "Beans",
    sourceStep: 0,
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
]);

const fixturePlans = (() => {
  const snapshots = loadCookPlanSnapshots();
  return loadCookPlanFixtures().map((fixture) => {
    const result = parseCookPlan(snapshots.get(fixture.name)?.raw, fixture.recipe);
    if (!result.ok) throw new Error(`${fixture.name}: ${result.detail}`);
    return { name: fixture.name, plan: result.plan };
  });
})();

describe("roundUpToFive", () => {
  it("rounds up to the next 5 and leaves exact multiples alone", () => {
    expect(roundUpToFive(0.001)).toBe(5);
    expect(roundUpToFive(5)).toBe(5);
    expect(roundUpToFive(5.001)).toBe(10);
    expect(roundUpToFive(37)).toBe(40);
    expect(roundUpToFive(60)).toBe(60);
  });

  it("is 0 for no time at all", () => {
    expect(roundUpToFive(0)).toBe(0);
  });
});

describe("recipeTimes", () => {
  it("counts a hands-off stretch once when other work runs inside it", () => {
    const times = recipeTimes(OVERLAP);
    // Prep 5, then the simmer's 30 with the fry inside it, then combine 2.
    expect(times.totalMinutes).toBe(37);
    expect(times.handsOnMinutes).toBe(17);
    expect(times.rounded).toEqual({ total: 40, handsOn: 20 });
  });

  it("counts the prep block in the total, as Prep first does", () => {
    const times = recipeTimes(OVERLAP);
    expect(times.totalMinutes).toBe(timeline(OVERLAP, "first", new Set()).total);
    expect(times.totalMinutes).toBeGreaterThan(
      timeline(OVERLAP, "go", new Set()).total - 1e-9,
    );
  });

  it("leaves ahead work out of both totals", () => {
    const withAhead = plan([
      task({
        id: "soak",
        kind: "ahead",
        lead: "overnight",
        minutes: { est: 600, handsOff: true },
      }),
      ...OVERLAP.tasks,
    ]);
    const times = recipeTimes(withAhead);
    expect(times.totalMinutes).toBe(37);
    expect(times.handsOnMinutes).toBe(17);
    expect(times.ahead).toEqual({ leads: ["overnight"], unled: 0 });
  });

  it("keeps leads in the plan's words and order, once each, and counts unled ahead work", () => {
    const times = recipeTimes(
      plan([
        task({ id: "a1", kind: "ahead", lead: "the night before" }),
        task({ id: "a2", kind: "ahead", lead: "a few hours" }),
        task({ id: "a3", kind: "ahead", lead: "the night before" }),
        task({ id: "a4", kind: "ahead" }),
        task({ id: "c", kind: "cook", needs: ["a1", "a2", "a3", "a4"] }),
      ]),
    );
    expect(times.ahead).toEqual({
      leads: ["the night before", "a few hours"],
      unled: 1,
    });
  });

  it("measures the nominal share: unestimated minutes over hands-on", () => {
    const times = recipeTimes(
      plan([
        task({ id: "m", kind: "mise" }),
        task({
          id: "c",
          kind: "cook",
          needs: ["m"],
          minutes: { est: 6, handsOff: false },
        }),
      ]),
    );
    expect(times.nominalMinutes).toBe(NOMINAL_MINUTES);
    expect(times.handsOnMinutes).toBe(NOMINAL_MINUTES + 6);
    expect(times.nominalShare).toBeCloseTo(2 / 8);
  });

  it("is all nominal for the recipe as written", () => {
    const times = recipeTimes(
      identityPlan({ steps: ["Boil.", "Drain."], ingredients: [] }),
    );
    expect(times.nominalShare).toBe(1);
  });

  describe.each(fixturePlans)("fixture $name", ({ plan: p }) => {
    const times = recipeTimes(p);

    it("totals the first-mode timeline, rounded up to 5", () => {
      const span = timeline(p, "first", new Set()).total;
      expect(times.totalMinutes).toBeCloseTo(span, 6);
      expect(times.rounded.total).toBe(roundUpToFive(span));
      expect(times.rounded.total % 5).toBe(0);
      expect(times.rounded.total).toBeGreaterThanOrEqual(span - 1e-9);
      expect(times.rounded.total - span).toBeLessThan(5);
    });

    it("counts every hands-on minute the schedule uses, and none hands-off or ahead", () => {
      const handsOn = p.tasks
        .filter((t) => t.kind !== "ahead" && !(t.minutes?.handsOff ?? false))
        .reduce((sum, t) => sum + (t.minutes?.est ?? NOMINAL_MINUTES), 0);
      expect(times.handsOnMinutes).toBeCloseTo(handsOn, 6);
      expect(times.handsOnMinutes).toBeLessThanOrEqual(times.totalMinutes + 1e-9);
    });

    it("lists every distinct ahead lead verbatim", () => {
      const leads = [
        ...new Set(
          p.tasks.filter((t) => t.kind === "ahead" && t.lead).map((t) => t.lead!),
        ),
      ];
      expect(times.ahead.leads).toEqual(leads);
    });
  });

  it("dedupes a lead the fixtures repeat across several ahead tasks", () => {
    const repeated = fixturePlans.find(({ plan: p }) => {
      const leads = p.tasks.filter((t) => t.kind === "ahead" && t.lead);
      return new Set(leads.map((t) => t.lead)).size < leads.length;
    });
    expect(repeated).toBeDefined();
    const times = recipeTimes(repeated!.plan);
    expect(new Set(times.ahead.leads).size).toBe(times.ahead.leads.length);
  });
});

describe("shownTimes", () => {
  const stated = { active: 20, passive: 10, total: 35 };

  it("shows the plan's times when the plan is current and mostly estimated", () => {
    expect(shownTimes(OVERLAP, stated)).toEqual({
      source: "plan",
      total: 40,
      handsOn: 20,
      ahead: { leads: [], unled: 0 },
    });
  });

  it("keeps the plan's times at exactly a quarter nominal", () => {
    const quarter = plan([
      task({ id: "m", kind: "mise" }),
      task({
        id: "c",
        kind: "cook",
        needs: ["m"],
        minutes: { est: 3 * NOMINAL_MINUTES, handsOff: false },
      }),
    ]);
    expect(recipeTimes(quarter).nominalShare).toBe(NOMINAL_SHARE_LIMIT);
    expect(shownTimes(quarter, stated).source).toBe("plan");
  });

  it("falls back to the recipe's time, marked nominal, past a quarter", () => {
    const guessy = plan([
      task({ id: "m1", kind: "mise" }),
      task({ id: "m2", kind: "mise" }),
      task({
        id: "c",
        kind: "cook",
        needs: ["m1", "m2"],
        minutes: { est: 6, handsOff: false },
      }),
    ]);
    expect(shownTimes(guessy, stated)).toEqual({
      source: "recipe",
      reason: "nominal",
      total: 35,
      handsOn: 20,
      ahead: { leads: [], unled: 0 },
    });
  });

  it("keeps the plan's ahead leads when the minutes fall back", () => {
    const guessy = plan([
      task({ id: "a", kind: "ahead", lead: "overnight" }),
      task({ id: "c", kind: "cook", needs: ["a"] }),
    ]);
    const shown = shownTimes(guessy, stated);
    expect(shown.source).toBe("recipe");
    expect(shown.ahead).toEqual({ leads: ["overnight"], unled: 0 });
  });

  it("treats no plan, or a stale one, as no plan", () => {
    expect(shownTimes(null, stated)).toMatchObject({
      source: "recipe",
      reason: "no-plan",
    });
    const stale = { ...OVERLAP, version: COOK_PLAN_VERSION - 1 };
    expect(shownTimes(stale, stated)).toMatchObject({
      source: "recipe",
      reason: "no-plan",
      ahead: { leads: [], unled: 0 },
    });
  });

  it("treats a plan that adds up to no minutes as no plan", () => {
    // Only work done ahead: none of it is in the cook's total.
    const aheadOnly = plan([
      task({
        id: "soak",
        kind: "ahead",
        lead: "overnight",
        minutes: { est: 600, handsOff: true },
      }),
    ]);
    expect(recipeTimes(aheadOnly).rounded.total).toBe(0);
    expect(shownTimes(aheadOnly, stated)).toEqual({
      source: "recipe",
      reason: "no-plan",
      total: 35,
      handsOn: 20,
      ahead: { leads: ["overnight"], unled: 0 },
    });
    expect(shownTimes(plan([]), undefined)).toMatchObject({
      source: "none",
      reason: "no-plan",
    });
  });

  it("takes the stated total, else active plus passive, as written", () => {
    expect(shownTimes(null, { active: 12, passive: 33 })).toMatchObject({
      total: 45,
      handsOn: 12,
    });
    // A passive of 0 is stated: the recipe says none of it is hands-off.
    expect(shownTimes(null, { active: 30, passive: 0 })).toMatchObject({
      total: 30,
      handsOn: 30,
    });
    expect(shownTimes(null, { total: 22 })).toMatchObject({
      total: 22,
      handsOn: null,
    });
  });

  // T follow-up, item 4: one part of the time is not the whole of it. With
  // only the active time, the total isn't stated, and adding nothing to it
  // would say "all hands-on" for the recipe; with only the passive time
  // there is neither a total nor a hands-on to show.
  it("makes no total from one part alone", () => {
    expect(shownTimes(null, { active: 30 })).toEqual({
      source: "recipe",
      reason: "no-plan",
      total: null,
      handsOn: 30,
      ahead: { leads: [], unled: 0 },
    });
    expect(shownTimes(null, { passive: 40 })).toEqual({
      source: "none",
      reason: "no-plan",
      ahead: { leads: [], unled: 0 },
    });
    expect(shownTimes(null, { active: 0, passive: 40 })).toMatchObject({
      source: "recipe",
      total: 40,
      handsOn: null,
    });
  });

  it("shows nothing when the recipe states no time", () => {
    for (const none of [undefined, {}, { total: 0 }, { active: Number.NaN }]) {
      expect(shownTimes(null, none)).toEqual({
        source: "none",
        reason: "no-plan",
        ahead: { leads: [], unled: 0 },
      });
    }
    const guessy = plan([task({ id: "c", kind: "cook" })]);
    expect(shownTimes(guessy, undefined)).toMatchObject({
      source: "none",
      reason: "nominal",
    });
  });
});
