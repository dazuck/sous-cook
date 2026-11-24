import { describe, expect, it } from "vitest";
import { identityPlan, type CookPlan } from "./cook-plan";
import { reduceSession, startSession } from "./cook-session";
import { hasUpfrontPrep, screensOf, type PlanSource } from "./cook-view";
import { hasOpening, OPENING_MIN_STEPS, opensOnChart } from "./cook-opening";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE } from "./__tests__/zucchini-wraps";

const DERIVED: PlanSource = { kind: "derived" };

/** The zucchini plan cut down to these tasks, their needs kept inside it. */
function only(ids: string[]): CookPlan {
  const kept = new Set(ids);
  return {
    ...ZUCCHINI_PLAN,
    tasks: ZUCCHINI_PLAN.tasks
      .filter((t) => kept.has(t.id))
      .map((t) => ({ ...t, needs: t.needs.filter((n) => kept.has(n)) })),
  };
}

function stepScreens(plan: CookPlan, mode: "first" | "go"): number {
  return screensOf(plan, mode, new Set()).filter((s) => s.kind === "step").length;
}

describe("opensOnChart (N2-10)", () => {
  it.each(["first", "go"] as const)(
    "opens a fresh derived cook of several steps on the chart (%s)",
    (mode) => {
      expect(stepScreens(ZUCCHINI_PLAN, mode)).toBeGreaterThanOrEqual(OPENING_MIN_STEPS);
      expect(opensOnChart(startSession(ZUCCHINI_PLAN, DERIVED, mode))).toBe(true);
    },
  );

  it("never opens a settled session on the chart, the resume included, while hasOpening stays true for returning via Back", () => {
    const moved = reduceSession(startSession(ZUCCHINI_PLAN, DERIVED, "first"), { type: "next" });
    expect(moved.settled).toBe(true);
    expect(opensOnChart(moved)).toBe(false);
    expect(hasOpening(moved.plan, moved.source, moved.state.mode, moved.state.ticked)).toBe(true);
    // Back on Prep it stays settled: the chart is the opening on fresh load only,
    // while Back from Prep can return to it via hasOpening.
    const back = reduceSession(moved, { type: "back" });
    expect(back.state.pos).toBe(0);
    expect(opensOnChart(back)).toBe(false);
    expect(hasOpening(back.plan, back.source, back.state.mode, back.state.ticked)).toBe(true);
  });

  it("does not count a mode switch on Prep as progress", () => {
    const switched = reduceSession(startSession(ZUCCHINI_PLAN, DERIVED, "first"), {
      type: "mode",
      mode: "go",
    });
    expect(switched.settled).toBe(false);
    expect(opensOnChart(switched)).toBe(true);
  });

  it("counts a tick on Prep as progress", () => {
    const ticked = reduceSession(startSession(ZUCCHINI_PLAN, DERIVED, "first"), {
      type: "tick",
      id: "onion",
    });
    expect(ticked.settled).toBe(true);
    expect(opensOnChart(ticked)).toBe(false);
  });

  it.each(["pending", "failed", "later"] as const)(
    "never opens a cook as written on the chart (%s)",
    (reason) => {
      const s = startSession(identityPlan(ZUCCHINI_RECIPE), { kind: "as-written", reason }, "first");
      expect(opensOnChart(s)).toBe(false);
      expect(hasOpening(s.plan, s.source, s.state.mode, s.state.ticked)).toBe(false);
    },
  );

  it("opens on two step screens and not on one", () => {
    const two = only(["saute", "fry"]);
    const one = only(["saute"]);
    expect(stepScreens(two, "first")).toBe(2);
    expect(stepScreens(one, "first")).toBe(1);
    expect(opensOnChart(startSession(two, DERIVED, "first"))).toBe(true);
    expect(opensOnChart(startSession(one, DERIVED, "first"))).toBe(false);
  });

  it("counts step screens under the session's mode, not tasks", () => {
    // Mise and one cook step. Prep first: the three jobs are one prep page of
    // tick rows, a step like any other (DS v1.59), then the sauté: two step
    // screens, where the one Prep screen left one. As I go folds the mise
    // into steps of its own.
    const plan = only(["onion", "scape", "zuc", "saute"]);
    expect(stepScreens(plan, "first")).toBe(2);
    expect(opensOnChart(startSession(plan, DERIVED, "first"))).toBe(true);
    expect(stepScreens(plan, "go")).toBeGreaterThanOrEqual(OPENING_MIN_STEPS);
    expect(opensOnChart(startSession(plan, DERIVED, "go"))).toBe(true);
    // One job and one cook step: still two step screens in Prep first.
    expect(stepScreens(only(["onion", "saute"]), "first")).toBe(2);
  });

  it("hasUpfrontPrep distinguishes upfront mise/ahead from all-inline As I go", () => {
    // All mise needed only after the first cook task: upfront in "first", inline in "go".
    const inlineOnly: CookPlan = {
      version: 1,
      tasks: [
        {
          id: "boil",
          kind: "cook",
          text: "Boil water.",
          label: "boil water",
          ingredientIdx: [],
          sourceStep: 0,
          implied: false,
          needs: [],
          minutes: { est: 10, handsOff: true },
          branch: "Main",
        },
        {
          id: "chop",
          kind: "mise",
          text: "Chop herbs.",
          label: "chop herbs",
          ingredientIdx: [],
          sourceStep: 1,
          implied: false,
          needs: [],
          minutes: { est: 2, handsOff: false },
          branch: "Main",
        },
        {
          id: "serve",
          kind: "cook",
          text: "Serve with herbs.",
          label: "serve",
          ingredientIdx: [],
          sourceStep: 1,
          implied: false,
          needs: ["boil", "chop"],
          minutes: { est: 1, handsOff: false },
          branch: "Main",
        },
      ],
    };
    expect(hasUpfrontPrep(inlineOnly, "first")).toBe(true);
    expect(hasUpfrontPrep(inlineOnly, "go")).toBe(false);
    expect(hasUpfrontPrep(ZUCCHINI_PLAN, "first")).toBe(true);
    expect(hasUpfrontPrep(ZUCCHINI_PLAN, "go")).toBe(true);
  });
});

