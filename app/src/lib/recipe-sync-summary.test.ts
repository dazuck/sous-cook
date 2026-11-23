import { describe, expect, it } from "vitest";
import { householdStatus, planFixesLine, refreshFailedLine, refreshFailureCause, syncSummary } from "./recipe-sync-summary";

const failure = (name: string) => ({ name, error: "reason" });
const stepsLeftOut = (name: string) => ({
  name,
  kind: "method-dropped" as const,
  message: "Left out 3 steps that aren't in the source.",
});
const notesLeftOut = (name: string) => ({
  name,
  kind: "notes-dropped" as const,
  message: "Left out notes that aren't in the source.",
});
const plans = { derived: 0, reused: 52, pending: 0, failed: [] };
const clean = { succeeded: 52, total: 52, failures: [], notices: [], stale: [], plans };
const planFailed = (name: string, settled: boolean) => ({ name, error: settled ? "rejected (cycle): x" : "429", settled });

describe("syncSummary", () => {
  it("says a clean Refresh in one sentence", () => {
    expect(syncSummary(clean)).toBe("Refreshed all 52 recipes.");
    expect(syncSummary({ ...clean, succeeded: 1, total: 1 })).toBe("Refreshed all 1 recipe.");
  });

  it("names what didn't come through, and says the book keeps what it had", () => {
    expect(
      syncSummary({
        ...clean,
        succeeded: 50,
        failures: [failure("lamb biryani"), failure("Seeded rye crackers")],
      }),
    ).toBe(
      "Refreshed 50 of 52. Lamb biryani and Seeded rye crackers didn't come through, so the book keeps what it had of them.",
    );
    expect(syncSummary({ ...clean, succeeded: 51, failures: [failure("Pizza dough")] })).toBe(
      "Refreshed 51 of 52. Pizza dough didn't come through, so the book keeps what it had of it.",
    );
  });

  it("names three, then counts the rest", () => {
    expect(syncSummary({ ...clean, succeeded: 47, failures: ["A", "B", "C", "D", "E"].map(failure) })).toBe(
      "Refreshed 47 of 52. A, B and C +2 more didn't come through, so the book keeps what it had of them.",
    );
  });

  it("names recipes that came in without a part", () => {
    expect(
      syncSummary({ ...clean, notices: [stepsLeftOut("Coffee slushie"), notesLeftOut("Masala chai")] }),
    ).toBe(
      "Refreshed all 52 recipes. Coffee slushie came in without steps: the recipe library doesn't give them. Masala chai came in without notes: the recipe library doesn't give them.",
    );
  });

  it("names library recipes whose tab is gone", () => {
    expect(syncSummary({ ...clean, stale: ["Minced lamb"] })).toBe(
      "Refreshed all 52 recipes. 1 no longer in the recipe library: Minced lamb.",
    );
  });

  it("names recipes whose plan needs a fix (settled failures only)", () => {
    expect(
      syncSummary({
        ...clean,
        plans: { ...plans, failed: [planFailed("Tomato and herb salad", true), planFailed("Lamb biryani", true)] },
      }),
    ).toBe("Refreshed all 52 recipes. 2 recipes need plan fixes: Tomato and herb salad and Lamb biryani.");
    expect(syncSummary({ ...clean, plans: { ...plans, failed: [planFailed("Tomato and herb salad", true)] } })).toBe(
      "Refreshed all 52 recipes. 1 recipe needs a plan fix: Tomato and herb salad.",
    );
  });

  it("counts plans still to work out: past the budget, or failed for now", () => {
    expect(
      syncSummary({ ...clean, plans: { ...plans, pending: 2, failed: [planFailed("Zucchini wraps", false)] } }),
    ).toBe("Refreshed all 52 recipes. 3 plans are still being worked out, so Refresh again.");
    expect(syncSummary({ ...clean, plans: { ...plans, pending: 1 } })).toBe(
      "Refreshed all 52 recipes. 1 plan is still being worked out, so Refresh again.",
    );
  });

  it("says plan fixes after what didn't come through and what's gone", () => {
    expect(
      syncSummary({
        ...clean,
        succeeded: 51,
        failures: [failure("Pizza dough")],
        stale: ["Minced lamb"],
        plans: { ...plans, pending: 4, failed: ["A", "B", "C", "D"].map((n) => planFailed(n, true)) },
      }),
    ).toBe(
      "Refreshed 51 of 52. Pizza dough didn't come through, so the book keeps what it had of it. " +
        "1 no longer in the recipe library: Minced lamb. 4 recipes need plan fixes: A, B and C +1 more. " +
        "4 plans are still being worked out, so Refresh again.",
    );
  });
});

describe("refreshFailureCause", () => {
  it("reads a library out of reach, before anything was written", () => {
    expect(refreshFailureCause("Couldn't read the recipe library: 500 backend error")).toBe("unreached");
  });

  it("reads a library that was reached but holds no recipe tab", () => {
    expect(refreshFailureCause("No recipes found in the recipe library. Each recipe should be its own tab")).toBe("no-recipes");
  });

  it("reads anything else as a Refresh that may have stopped partway", () => {
    expect(refreshFailureCause("FUNCTION_INVOCATION_TIMEOUT")).toBe("stopped");
    expect(refreshFailureCause("Failed to fetch")).toBe("stopped");
  });
});

describe("refreshFailedLine", () => {
  it("says nothing changed and what the book shows, when the doc was out of reach", () => {
    expect(refreshFailedLine("unreached", "Oct 4")).toBe(
      "Couldn't reach the recipe library, so nothing changed: these are the recipes from Oct 4.",
    );
  });

  it("has no date to give before the first sync", () => {
    expect(refreshFailedLine("unreached", null)).toBe("Couldn't reach the recipe library, so nothing changed.");
  });

  it("says a doc with no recipe tabs was read, not out of reach", () => {
    expect(refreshFailedLine("no-recipes", "Oct 4")).toBe(
      "The recipe library has no recipe tabs to read (each recipe is its own tab, inside a category tab), so nothing changed: these are the recipes from Oct 4.",
    );
    expect(refreshFailedLine("no-recipes", null)).not.toMatch(/reach/);
  });

  it("never says nothing changed of a Refresh that stopped partway", () => {
    const line = refreshFailedLine("stopped", "Oct 4");
    expect(line).not.toMatch(/nothing changed/);
    expect(line).toBe(
      "The Refresh stopped before it finished: the book keeps what it had, with any recipes that came in before it stopped.",
    );
  });
});

describe("planFixesLine", () => {
  it("counts the recipes whose plan failed for good", () => {
    expect(planFixesLine(1)).toBe("1 recipe needs a plan fix.");
    expect(planFixesLine(3)).toBe("3 recipes need plan fixes.");
  });
});

describe("householdStatus", () => {
  const base = { running: false, refreshed: null, needFixes: null, runningText: "Reading the doc." };
  const refreshed = { text: "Refreshed all 52 recipes.", trouble: false };

  it("says a Refresh is running before anything else", () => {
    expect(householdStatus({ ...base, running: true, refreshed, needFixes: 2 })).toEqual({
      text: "Reading the doc.",
      trouble: false,
    });
  });

  it("keeps the last Refresh's own words over the plan count", () => {
    expect(householdStatus({ ...base, refreshed, needFixes: 2 })).toBe(refreshed);
  });

  it("names the plan fixes in ink while no Refresh has spoken", () => {
    expect(householdStatus({ ...base, needFixes: 2 })).toEqual({ text: "2 recipes need plan fixes.", trouble: true });
  });

  it("says nothing with no plan fixes, or while the report is out of reach", () => {
    expect(householdStatus({ ...base, needFixes: 0 })).toBeNull();
    expect(householdStatus(base)).toBeNull();
  });
});
