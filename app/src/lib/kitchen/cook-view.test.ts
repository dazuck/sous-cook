import { describe, it, expect } from "vitest";
import type { CookPlan, CookTask, PrepMode } from "./cook-plan";
import { identityPlan, leadMinutes, parseCookPlan } from "./cook-plan";
import {
  COOK_COPY,
  aheadFirst,
  askStepText,
  back,
  cookView,
  goToMark,
  stepBody,
  stepKey,
  usedIngredients,
  initialCookState,
  isDone,
  jumpTo,
  bindNumbers,
  missedAheadQuestion,
  minutesLabel,
  miseBefore,
  next,
  screenForSourceStep,
  screensOf,
  setMode,
  sourceStepStates,
  toggleTick,
  type CookState,
  type PlanSource,
} from "./cook-view";

import { strip } from "./cook-strip";
import { readStepDetails } from "./cook-levels";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE } from "./__tests__/zucchini-wraps";
import {
  loadCookPlanFixtures,
  loadCookPlanSnapshots,
} from "./__tests__/load-cook-plan-fixtures";

const DERIVED: PlanSource = { kind: "derived" };
const plan = ZUCCHINI_PLAN;

function view(state: CookState, p: CookPlan = plan, source = DERIVED) {
  return cookView(p, source, state);
}

function steps(state: CookState, n: number, p: CookPlan = plan): CookState {
  let s = state;
  for (let i = 0; i < n; i++) s = next(p, s);
  return s;
}

const keys = (state: CookState, p: CookPlan = plan) =>
  view(state, p).stack.map((l) => l.key);

/** Chapter states by id: names can repeat, ids cannot. */
function chapterStates(state: CookState, p: CookPlan = plan) {
  return Object.fromEntries(
    view(state, p).chapters!.map((c) => [c.id, c.state]),
  );
}

/**
 * Zucchini with a 30-minute sauté: 22 idle minutes after it starts, so the
 * steps break into a one-screen chapter and the rest.
 */
const longSaute: CookPlan = {
  ...plan,
  tasks: plan.tasks.map((t) =>
    t.id === "saute" ? { ...t, minutes: { est: 30, handsOff: true } } : t,
  ),
};

describe("cookView: prep first", () => {
  const start = initialCookState("first");

  it("opens on the Prep screen with the mode toggle", () => {
    const v = view(start);
    expect(v.onPrep).toBe(true);
    expect(v.showModeToggle).toBe(true);
    expect(keys(start)).toEqual(["prep"]);
    expect(v.prep!.mise.map((m) => [m.id, m.done, m.when])).toEqual([
      ["onion", false, null],
      ["scape", false, null],
      ["zuc", false, null],
      ["greens", false, "while you sauté"],
    ]);
    expect(v.prep!.aheadNote).toBe(COOK_COPY.nothingAhead);
    expect(v.note).toBeNull();
  });

  it("marks movable mise rows with their in-cook window in prep first, and clears when once ticked", () => {
    const ticked = toggleTick(plan, start, "greens");
    expect(view(ticked).prep!.mise.map((m) => [m.id, m.done, m.when])).toEqual([
      ["onion", false, null],
      ["scape", false, null],
      ["zuc", false, null],
      ["greens", true, null],
    ]);
  });

  it("says once that the prep is assumed when none of it is in the recipe", () => {
    expect(plan.tasks.filter((t) => t.kind === "mise").every((t) => t.implied)).toBe(true);
    expect(view(start).prep!.assumedNote).toBe(COOK_COPY.allAssumed);
    const listed: CookPlan = {
      ...plan,
      tasks: plan.tasks.map((t) =>
        t.id === "onion" ? { ...t, sourceStep: 0, implied: false } : t,
      ),
    };
    expect(view(start, listed).prep!.assumedNote).toBeNull();
  });

  it("hides the toggle once the cook moves off the Prep screen", () => {
    const s = next(plan, start);
    const v = view(s);
    expect(v.onPrep).toBe(false);
    expect(v.showModeToggle).toBe(false);
    expect(v.prep).toBeNull();
    expect(keys(s)).toEqual(["saute"]);
    expect(v.stack[0]).toMatchObject({
      text: plan.tasks[4].text,
      ingredientIdx: [0, 1, 2, 3],
      minutes: "About 15 minutes, mostly hands-free",
      implied: false,
    });
  });

  it("ticks off all the prep when the cook leaves the Prep screen", () => {
    const s = next(plan, start);
    expect([...s.ticked]).toEqual(["onion", "scape", "zuc", "greens"]);
    expect(s.passed.size).toBe(0);
  });

  it("recedes the stack as the cook advances, down to the last step", () => {
    expect(keys(steps(start, 2))).toEqual(["fry"]);
    const last = steps(start, 5);
    expect(keys(last)).toEqual(["chili"]);
    expect(view(last).isLast).toBe(true);
    expect(view(steps(start, 4)).isLast).toBe(false);
  });

  it("has Prep and one chapter of the five steps, named Cook: no wait reaches 10 minutes", () => {
    expect(view(start).chapters!.map((c) => [c.id, c.name])).toEqual([
      ["prep", "Prep"],
      ["stretch:saute", "Cook"],
    ]);
    expect(chapterStates(start)).toEqual({ prep: "now", "stretch:saute": "next" });
    expect(chapterStates(steps(start, 2))).toEqual({ prep: "done", "stretch:saute": "now" });
  });

  it("breaks the chapters where the cook's hands come free, named by their opening move", () => {
    const s = next(longSaute, start);
    expect(view(s, longSaute).chapters!.map((c) => [c.id, c.name])).toEqual([
      ["prep", "Prep"],
      ["stretch:saute", "Sauté"],
      ["stretch:fry", "Fry parathas"],
    ]);
    expect(chapterStates(s, longSaute)).toEqual({
      prep: "done",
      "stretch:saute": "now",
      "stretch:fry": "next",
    });
    // On the fry the sauté is still going: its chapter runs until the pot is
    // done, and reads done on the stir, once it is.
    expect(chapterStates(next(longSaute, s), longSaute)).toEqual({
      prep: "done",
      "stretch:saute": "running",
      "stretch:fry": "now",
    });
    expect(chapterStates(steps(s, 2, longSaute), longSaute)).toEqual({
      prep: "done",
      "stretch:saute": "done",
      "stretch:fry": "now",
    });
  });
});

describe("cookView: place within the chapter", () => {
  const start = initialCookState("first");
  const places = (state: CookState, p: CookPlan = plan) =>
    Object.fromEntries(view(state, p).chapters!.map((c) => [c.id, c.place]));

  it("counts the current chapter's screens, in cook order, and only the current one's", () => {
    expect(places(steps(start, 1))).toEqual({
      prep: null,
      "stretch:saute": { at: 1, of: 5 },
    });
    expect(places(steps(start, 3))["stretch:saute"]).toEqual({ at: 3, of: 5 });
    expect(places(steps(start, 5))["stretch:saute"]).toEqual({ at: 5, of: 5 });
  });

  it("gives no place on a chapter of one screen: '1 of 1' says nothing", () => {
    expect(places(start)).toEqual({ prep: null, "stretch:saute": null });
    const onSaute = next(longSaute, start);
    expect(places(onSaute, longSaute)).toEqual({
      prep: null,
      "stretch:saute": null,
      "stretch:fry": null,
    });
    expect(places(next(longSaute, onSaute), longSaute)["stretch:fry"]).toEqual({
      at: 1,
      of: 4,
    });
  });
});

describe("cookView: as I go", () => {
  const start = initialCookState("go");
  // Into the steps by a jump, which ticks nothing, so the mise done before
  // cooking still has its own card.
  const inSteps = jumpTo(plan, start, 1);

  it("splits the mise at the first cooking step: that before ticks, the rest says when", () => {
    const v = view(start);
    expect(v.prep!.mise.map((m) => [m.id, m.before, m.when])).toEqual([
      ["onion", true, null],
      ["scape", true, null],
      ["zuc", true, null],
      ["greens", false, "while you sauté"],
    ]);
    expect(v.prep!.beforeNote).toBeNull();
  });

  it("times only the mise done before cooking", () => {
    expect(view(start).stack[0].minutes).toBe("About 5 minutes");
    expect(view(toggleTick(plan, start, "onion")).stack[0].minutes).toBe("About 3 minutes");
  });

  it("merges the sauté mise into one sentence", () => {
    expect(view(inSteps).stack.map((l) => l.text)).toEqual([
      "Slice the onion bulb, mince the garlic scape, and cut the zucchini into thin matchsticks.",
    ]);
    expect(view(inSteps).stack[0]).toMatchObject({
      key: "onion+scape+zuc",
      ingredientIdx: [1, 2, 0],
      minutes: "About 5 minutes",
      implied: true,
    });
  });

  it("says Meanwhile on the step you're on too", () => {
    expect(view(steps(inSteps, 3)).stack[0].text).toBe(
      "Fry the parathas in a dry skillet until crisp and flaky.",
    );
    expect(view(steps(inSteps, 2)).stack[0].text).toBe("Meanwhile, chop the onion greens");
  });

  it("tells prep lines from cook lines, so the stack can mark the prep", () => {
    expect(view(start).stack.map((l) => l.kind)).toEqual(["prep"]);
    expect(view(inSteps).stack.map((l) => l.kind)).toEqual(["mise"]);
    const first = initialCookState("first");
    expect(view(first).stack.map((l) => l.kind)).toEqual(["prep"]);
  });

  it("counts the mise before cooking done on leaving Prep, and leaves the rest to the steps", () => {
    const s = next(plan, start);
    expect(s.ticked).toEqual(new Set(["onion", "scape", "zuc"]));
    expect(s.passed.size).toBe(0);
    expect(keys(s)).toEqual(["saute"]);
  });

  it("reads Prep as under way until the last of the mise is done in the steps", () => {
    const s = next(plan, start);
    expect(chapterStates(s).prep).toBe("running");
    // On the greens.
    expect(chapterStates(steps(start, 2)).prep).toBe("running");
    // Past the greens.
    expect(chapterStates(steps(start, 3)).prep).toBe("done");
  });

  it("keeps all six steps after Prep in one stretch: no wait reaches 10, and nothing caps it", () => {
    const s = next(plan, start);
    expect(view(s).chapters!.map((c) => [c.id, c.name, c.state])).toEqual([
      ["prep", "Prep", "running"],
      ["stretch:saute", "Cook", "now"],
    ]);
  });

  it("shows on Prep the row the cook steps through once they leave it", () => {
    // Leaving Prep ticks the sauté mise, so its step goes: the row on Prep is
    // already the one after.
    const row = (state: CookState) => view(state).chapters!.map((c) => [c.id, c.at]);
    expect(row(start)).toEqual([
      ["prep", [0]],
      ["stretch:saute", [1, 2, 3, 4, 5, 6]],
    ]);
    expect(row(next(plan, start))).toEqual(row(start));
    expect(chapterStates(start)).toEqual({ prep: "now", "stretch:saute": "next" });
    // Unticked on Prep, a mise task keeps its step after Prep, and its row
    // does too.
    const kept = toggleTick(plan, toggleTick(plan, start, "onion"), "onion");
    expect(row(kept)).toEqual(row(next(plan, kept)));
    expect(row(kept)).not.toEqual(row(start));
  });

  it("ticks only the mise done before cooking; the rest is done in the steps", () => {
    expect(toggleTick(plan, start, "greens")).toBe(start);
    const s = toggleTick(plan, start, "onion");
    expect(view(s).prep!.mise.find((m) => m.id === "onion")).toMatchObject({
      done: true,
      when: null,
    });
    expect(screensOf(plan, "go", s.ticked)).toHaveLength(8);
    expect(keys(jumpTo(plan, s, 1))).toEqual(["scape+zuc"]);
  });

  it("says so, and times nothing, when all the mise comes up in the steps", () => {
    const stew: CookPlan = {
      version: 1,
      tasks: [
        {
          id: "simmer",
          kind: "cook",
          text: "Simmer the stew.",
          label: "simmer the stew",
          ingredientIdx: [],
          sourceStep: null,
          implied: false,
          needs: [],
          branch: "Stew",
          minutes: { est: 30, handsOff: true },
        },
        {
          id: "parsley",
          kind: "mise",
          text: "Chop the parsley.",
          label: "chop parsley",
          ingredientIdx: [],
          sourceStep: null,
          implied: false,
          needs: [],
          branch: "Stew",
          minutes: { est: 1, handsOff: false },
        },
        {
          id: "finish",
          kind: "cook",
          text: "Stir in the parsley.",
          label: "finish",
          ingredientIdx: [],
          sourceStep: null,
          implied: false,
          needs: ["simmer", "parsley"],
          branch: "Stew",
          minutes: { est: 1, handsOff: false },
        },
      ],
    };
    const v = view(start, stew);
    expect(v.prep!.mise.map((m) => [m.before, m.when])).toEqual([
      [false, "while you simmer the stew"],
    ]);
    expect(v.prep!.beforeNote).toBe(COOK_COPY.nothingBefore);
    expect(v.stack[0].minutes).toBeNull();
    expect(askStepText(v)).toBeUndefined();
    expect(view(initialCookState("first"), stew).prep!.beforeNote).toBeNull();
  });
});

describe("cookView: re-entering Prep", () => {
  it("brings the toggle back only on the Prep screen", () => {
    const atStir = steps(initialCookState("first"), 3);
    expect(view(atStir).showModeToggle).toBe(false);
    const prep = jumpTo(plan, atStir, 0);
    expect(prep.pos).toBe(0);
    expect(view(prep).showModeToggle).toBe(true);
    expect(view(next(plan, prep)).showModeToggle).toBe(false);
  });

  it("keeps finished work done and resumes at the first unfinished step", () => {
    const atStir = steps(initialCookState("first"), 3);
    const prep = jumpTo(plan, atStir, 0);
    expect(view(prep).prep!.mise.every((m) => m.done)).toBe(true);
    const resumed = next(plan, prep);
    expect(keys(resumed)[0]).toBe("stir");
  });

  it("previews where Next goes, not the steps already done", () => {
    const atStir = steps(initialCookState("first"), 3);
    const prep = jumpTo(plan, atStir, 0);
    const resumed = next(plan, prep);
    expect(keys(prep)).toEqual(["prep"]);
    expect(keys(resumed)[0]).toBe("stir");
  });

  it("previews the resumed steps in the mode just picked", () => {
    const atGreens = steps(initialCookState("go"), 2);
    const first = setMode(jumpTo(plan, atGreens, 0), "first");
    expect(keys(first)).toEqual(["prep"]);
    expect(keys(next(plan, first))[0]).toBe("fry");
  });

  it("switching to As I go mid-cook does not send the cook back to the prep", () => {
    const atStir = steps(initialCookState("first"), 3);
    const go = setMode(jumpTo(plan, atStir, 0), "go");
    // The prep done up front stays out of the steps.
    expect(screensOf(plan, "go", go.ticked)).toHaveLength(6);
    const resumed = next(plan, go);
    expect(keys(resumed)[0]).toBe("stir");
    expect(resumed.pos).toBe(3);
  });

  it("switching to Prep first mid-cook finishes the rest of the prep up front", () => {
    // As I go: the sauté mise ticked on leaving Prep, past the sauté, now on
    // the greens.
    const atGreens = steps(initialCookState("go"), 2);
    expect(keys(atGreens)[0]).toBe("greens");
    const first = setMode(jumpTo(plan, atGreens, 0), "first");
    const v = view(first);
    expect(v.prep!.mise.map((m) => [m.id, m.done])).toEqual([
      ["onion", true],
      ["scape", true],
      ["zuc", true],
      ["greens", false],
    ]);
    expect(keys(next(plan, first))[0]).toBe("fry");
  });

  it("only changes mode on the Prep screen", () => {
    const s = steps(initialCookState("first"), 2);
    expect(setMode(s, "go")).toBe(s);
  });

  it("unticking reopens mise the cook passed in the steps", () => {
    // As I go, past the greens chopped during the sauté, then back on Prep in
    // Prep first: the greens were not actually chopped.
    const past = steps(initialCookState("go"), 3);
    const first = setMode(jumpTo(plan, past, 0), "first");
    expect(view(first).prep!.mise.find((m) => m.id === "greens")!.done).toBe(true);
    const prep = toggleTick(plan, first, "greens");
    expect(prep.passed.has("greens")).toBe(false);
    expect(view(prep).prep!.mise.find((m) => m.id === "greens")).toMatchObject({
      done: false,
      before: true,
    });
  });

  it("an untick on Prep survives Next: the mise comes back as a step", () => {
    // As I go, Next counted the sauté mise done; back on Prep, the onion was
    // not actually chopped.
    const back = jumpTo(plan, next(plan, initialCookState("go")), 0);
    const prep = toggleTick(plan, back, "onion");
    const resumed = next(plan, prep);
    expect(resumed.ticked.has("onion")).toBe(false);
    expect(keys(resumed)[0]).toContain("onion");
    // Ticked again, Next counts it done like the rest.
    expect(next(plan, toggleTick(plan, prep, "onion")).ticked.has("onion")).toBe(true);
  });

  it("in Prep first, Next counts an unticked row done: it has no step to come back as", () => {
    // Also reached by unticking in As I go, then switching.
    const back = jumpTo(plan, next(plan, initialCookState("go")), 0);
    const first = setMode(toggleTick(plan, back, "onion"), "first");
    const resumed = next(plan, first);
    expect(resumed.ticked.has("onion")).toBe(true);
    const onLast = steps(resumed, screensOf(plan, "first", resumed.ticked).length);
    expect(view(onLast).chapters!.find((c) => c.id === "prep")!.state).toBe("done");
  });

  it("only ticks on the Prep screen", () => {
    const s = steps(initialCookState("go"), 2);
    expect(toggleTick(plan, s, "greens")).toBe(s);
  });
});

describe("cookView: moving around", () => {
  const start = initialCookState("first");

  it("back reopens the step it lands on", () => {
    const atStir = steps(start, 3);
    const s = back(plan, atStir);
    expect(keys(s)[0]).toBe("fry");
    expect(s.passed.has("fry")).toBe(false);
    expect(s.passed.has("saute")).toBe(true);
  });

  it("back from the first step returns to Prep without undoing the prep", () => {
    const s = back(plan, next(plan, start));
    expect(s.pos).toBe(0);
    expect(s.ticked.has("onion")).toBe(true);
    expect(back(plan, s)).toBe(s);
  });

  it("jumping reopens the landing step and nothing else", () => {
    const atStuff = steps(start, 4);
    const s = jumpTo(plan, atStuff, 1);
    expect(keys(s)[0]).toBe("saute");
    expect(s.passed.has("saute")).toBe(false);
    expect(s.passed.has("fry")).toBe(true);
  });

  it("finds the screen for a source step in either mode", () => {
    expect(screenForSourceStep(plan, start, 0)).toBe(1);
    expect(screenForSourceStep(plan, start, 4)).toBe(5);
    expect(screenForSourceStep(plan, initialCookState("go"), 0)).toBe(2);
  });

  it("counts ingredients used once a cook step is passed, not when prepped", () => {
    expect(usedIngredients(plan, next(plan, start))).toEqual(new Set());
    const s = steps(start, 2);
    expect(usedIngredients(plan, s)).toEqual(new Set([0, 1, 2, 3]));
  });

  it("leaves Prep undone after a jump past it, until the prep is ticked", () => {
    const s = jumpTo(plan, start, 3);
    expect(chapterStates(s).prep).toBe("next");
    const partly = jumpTo(plan, toggleTick(plan, start, "onion"), 3);
    expect(chapterStates(partly).prep).toBe("running");
    // Next ticks it all, so a Next then a jump reads done.
    expect(chapterStates(jumpTo(plan, next(plan, start), 3)).prep).toBe("done");
  });

  it("reads the stretches a jump skipped as still to come", () => {
    // The long sauté: from the sauté straight to the stir, the sauté never done.
    const s = jumpTo(longSaute, next(longSaute, start), 3);
    expect(keys(s, longSaute)[0]).toBe("stir");
    expect(chapterStates(s, longSaute)).toEqual({
      prep: "done",
      "stretch:saute": "next",
      "stretch:fry": "now",
    });
  });

  it("keeps a stretch passed before a jump back done", () => {
    // At the chili oil, then back: the sauté and the wraps were done; the
    // chili oil never was.
    const atChili = steps(start, 5, longSaute);
    expect(keys(atChili, longSaute)[0]).toBe("chili");
    expect(chapterStates(jumpTo(longSaute, atChili, 1), longSaute)).toEqual({
      prep: "done",
      "stretch:saute": "now",
      "stretch:fry": "running",
    });
  });

  it("ignores a jump outside the sequence", () => {
    const s = steps(start, 2);
    expect(jumpTo(plan, s, 6)).toBe(s);
    expect(jumpTo(plan, s, -1)).toBe(s);
  });

  it("refuses to render a position outside the sequence", () => {
    expect(() => view({ ...start, pos: 6 })).toThrow(RangeError);
  });
});

describe("cookView: plans without a Prep screen", () => {
  const asWritten = identityPlan(ZUCCHINI_RECIPE);
  const start = initialCookState("first");

  it("runs the recipe as written with no chapters and no toggle", () => {
    const v = cookView(asWritten, { kind: "as-written", reason: "failed" }, start);
    expect(v.onPrep).toBe(false);
    expect(v.showModeToggle).toBe(false);
    expect(v.chapters).toBeNull();
    expect(v.stack.map((l) => l.key)).toEqual(["s0"]);
    expect(v.stack[0].minutes).toBeNull();
  });

  it("cuts no batches from steps as written, however many: the note row keeps its place", () => {
    const long = identityPlan({ steps: Array.from({ length: 12 }, (_, i) => `Do step ${i + 1}.`) });
    for (const reason of ["pending", "failed", "later"] as const) {
      for (const pos of [0, 6, 11]) {
        const v = cookView(long, { kind: "as-written", reason }, { ...start, pos });
        expect(v.chapters).toBeNull();
        // No row, so no marker of where a chapter begins.
        expect(v.stack.map((l) => l.marker)).toEqual([null, null, null].slice(0, v.stack.length));
      }
    }
  });

  it("says why on the first step only", () => {
    const failed: PlanSource = { kind: "as-written", reason: "failed" };
    const pending: PlanSource = { kind: "as-written", reason: "pending" };
    expect(cookView(asWritten, failed, start).note).toBe(COOK_COPY.failed);
    expect(cookView(asWritten, pending, start).note).toBe(COOK_COPY.pending);
    const s = next(asWritten, start);
    expect(cookView(asWritten, failed, s).note).toBeNull();
  });

  it("handles a recipe with no steps", () => {
    const empty = identityPlan({ steps: [] });
    const v = cookView(empty, { kind: "as-written", reason: "failed" }, start);
    expect(v.screens).toBe(0);
    expect(v.stack).toEqual([]);
    expect(v.isLast).toBe(true);
    expect(next(empty, start)).toBe(start);
  });

  it("gives a recipe with no steps no prep note: there is nothing to plan", () => {
    const empty = identityPlan({ ingredients: [{ item: "salt" }], steps: [] });
    for (const reason of ["pending", "failed", "later"] as const) {
      expect(cookView(empty, { kind: "as-written", reason }, start).note).toBeNull();
    }
  });
});

describe("cookView: other plan shapes", () => {
  function task(
    id: string,
    kind: CookTask["kind"],
    extra: Partial<CookTask> = {},
  ): CookTask {
    return {
      id,
      kind,
      text: `Do ${id}`,
      label: id,
      ingredientIdx: [],
      sourceStep: null,
      implied: true,
      needs: [],
      branch: "Beans",
      ...extra,
    };
  }

  const beans: CookPlan = {
    version: 1,
    tasks: [
      task("soak", "ahead", {
        lead: "overnight",
        text: "Soak the beans",
        label: "soak the beans",
      }),
      task("simmer", "cook", {
        needs: ["soak"],
        minutes: { est: 90, handsOff: true },
      }),
      task("salt", "cook", { needs: ["simmer"] }),
    ],
  };

  it("reads a Prep of ahead work alone as done once the cook moves on", () => {
    // The 90-minute simmer is a break, so the salt is a chapter of its own.
    const s = next(beans, initialCookState("first"));
    expect(view(s, beans).chapters!.map((c) => [c.name, c.state])).toEqual([
      ["Prep", "done"],
      ["Simmer", "now"],
      ["Salt", "next"],
    ]);
  });

  it("shows ahead work on a Prep screen with no toggle when there is no mise", () => {
    const v = view(initialCookState("first"), beans);
    expect(v.onPrep).toBe(true);
    expect(v.showModeToggle).toBe(false);
    expect(v.prep!.ahead).toEqual([
      {
        lead: "overnight",
        items: [
          {
            id: "soak",
            text: "Soak the beans",
            label: "soak the beans",
            lead: "overnight",
          },
        ],
        labels: ["soak the beans"],
      },
    ]);
    expect(v.prep!.aheadNote).toBeNull();
    expect(v.prep!.assumedNote).toBeNull();
  });

  it("groups ahead work by lead, the longest first and untimed work last", () => {
    const many: CookPlan = {
      version: 1,
      tasks: [
        task("butter", "ahead", { lead: "1 hour before" }),
        task("dough", "ahead", { lead: "at least 2 hours before" }),
        task("eggs", "ahead", { lead: "1 hour before" }),
        task("tin", "ahead"),
        task("chill", "ahead", { lead: "at least 2 hours before", needs: ["dough"] }),
        task("bake", "cook", { needs: ["butter", "eggs", "tin", "chill"] }),
      ],
    };
    const groups = view(initialCookState("first"), many).prep!.ahead;
    expect(groups.map((g) => [g.lead, g.items.map((a) => a.id)])).toEqual([
      ["at least 2 hours before", ["dough", "chill"]],
      ["1 hour before", ["butter", "eggs"]],
      [null, ["tin"]],
    ]);
  });

  /** Ahead tasks, each [id, lead, needs], and a bake needing the rest. */
  function aheadOnly(...ahead: [string, string | null, string[]][]): CookPlan {
    const used = new Set(ahead.flatMap(([, , needs]) => needs));
    return {
      version: 4,
      tasks: [
        ...ahead.map(([id, lead, needs]) =>
          task(id, "ahead", { needs, ...(lead ? { lead } : {}) }),
        ),
        task("bake", "cook", {
          needs: ahead.map(([id]) => id).filter((id) => !used.has(id)),
        }),
      ],
    };
  }
  const shape = (p: CookPlan) =>
    view(initialCookState("first"), p).prep!.ahead.map((g) => [
      g.lead,
      g.items.map((a) => a.id),
    ]);

  it("orders a chain of three by its needs, whichever way its leads count", () => {
    // One anchor: each lead counts back from the start of the cook.
    const counted = aheadOnly(
      ["brine", "the day before", []],
      ["dry", "overnight", ["brine"]],
      ["temper", "1 hour before", ["dry"]],
    );
    expect(shape(counted)).toEqual([
      ["the day before", ["brine"]],
      ["overnight", ["dry"]],
      ["1 hour before", ["temper"]],
    ]);
    // Stored with each lead counted from the next task: each need's wait is
    // added to the wait of the work it feeds, so the grinding is 1 hour
    // before the 4-hour ferment starts and the soak half an hour before that.
    const chained = aheadOnly(
      ["soak", "30 minutes before", []],
      ["grind", "1 hour before", ["soak"]],
      ["ferment", "at least 4 hours before", ["grind"]],
    );
    expect(shape(chained)).toEqual([
      ["at least 5½ hours before", ["soak"]],
      ["at least 5 hours before", ["grind"]],
      ["at least 4 hours before", ["ferment"]],
    ]);
    expect(aheadOrderBreaks(chained)).toEqual([]);
    // Only the short link moves; a longer need keeps its own lead.
    const mixed = aheadOnly(
      ["soak", "overnight", []],
      ["grind", "1 hour before", ["soak"]],
      ["ferment", "at least 4 hours", ["grind"]],
    );
    expect(shape(mixed)).toEqual([
      ["overnight", ["soak"]],
      ["at least 5 hours before", ["grind"]],
      ["at least 4 hours before", ["ferment"]],
    ]);
  });

  it("adds a shorter need's lead to its dependent's, since it counted from there", () => {
    // Fix round 1 (H2): showing the dependent's lead alone put the need an
    // hour late every time.
    expect(
      shape(aheadOnly(["warm", "30 minutes before", []], ["rise", "2 hours before", ["warm"]])),
    ).toEqual([
      ["2½ hours before", ["warm"]],
      ["2 hours before", ["rise"]],
    ]);
    // Under an hour, in minutes.
    expect(
      shape(aheadOnly(["thaw", "10 minutes before", []], ["brine", "30 minutes before", ["thaw"]])),
    ).toEqual([
      ["40 minutes before", ["thaw"]],
      ["30 minutes before", ["brine"]],
    ]);
    // Over an hour, up to the quarter hour, never down, and said as "about"
    // when it isn't exact (fix round 2, LOW 5): 1 hour 20 minutes.
    expect(
      shape(aheadOnly(["proof", "20 minutes before", []], ["shape", "1 hour before", ["proof"]])),
    ).toEqual([
      ["about 1½ hours before", ["proof"]],
      ["1 hour before", ["shape"]],
    ]);
    // Bloomed yeast 10 minutes ahead of an hour's rise: 1 hour 10 minutes is
    // about 1¼ hours, not "at least" anything, and not 1½.
    expect(
      shape(aheadOnly(["bloom", "10 minutes before", []], ["rise", "at least 1 hour before", ["bloom"]])),
    ).toEqual([
      ["about 1¼ hours before", ["bloom"]],
      ["at least 1 hour before", ["rise"]],
    ]);
    // An exact quarter hour keeps "at least".
    expect(
      shape(aheadOnly(["zest", "15 minutes before", []], ["steep", "at least 1 hour before", ["zest"]])),
    ).toEqual([
      ["at least 1¼ hours before", ["zest"]],
      ["at least 1 hour before", ["steep"]],
    ]);
    // A lead said in words adds as it reads (overnight, 12 hours).
    expect(
      shape(aheadOnly(["mix-brine", "1 hour before", []], ["brine", "overnight", ["mix-brine"]])),
    ).toEqual([
      ["13 hours before", ["mix-brine"]],
      ["overnight", ["brine"]],
    ]);
    // Two dependents: it counts from the one that starts first.
    expect(
      shape(
        aheadOnly(
          ["soften", "1 hour before", []],
          ["cream", "2 hours before", ["soften"]],
          ["laminate", "at least 4 hours before", ["soften"]],
        ),
      ),
    ).toEqual([
      ["at least 5 hours before", ["soften"]],
      ["at least 4 hours before", ["laminate"]],
      ["2 hours before", ["cream"]],
    ]);
  });

  it("rounds once, at the end of a chain, not at every link", () => {
    // Fix round 2 (LOW 5): the eggs' 70 minutes shows as about 1¼ hours, but
    // the sugar 5 minutes before them is 75 minutes exact, not 1¼ + 5.
    expect(
      shape(
        aheadOnly(
          ["sugar", "5 minutes before", []],
          ["eggs", "10 minutes before", ["sugar"]],
          ["rest", "1 hour before", ["eggs"]],
        ),
      ),
    ).toEqual([
      ["1¼ hours before", ["sugar"]],
      ["about 1¼ hours before", ["eggs"]],
      ["1 hour before", ["rest"]],
    ]);
  });

  it("says a day or more in whole days when it is whole days, else in hours", () => {
    // Fix round 2 (LOW 4).
    expect(
      shape(aheadOnly(["make-stock", "1 day ahead", []], ["braise", "2 days ahead", ["make-stock"]])),
    ).toEqual([
      ["3 days before", ["make-stock"]],
      ["2 days ahead", ["braise"]],
    ]);
    expect(
      shape(aheadOnly(["soak", "overnight", []], ["cook-beans", "the day before", ["soak"]])),
    ).toEqual([
      ["36 hours before", ["soak"]],
      ["the day before", ["cook-beans"]],
    ]);
  });

  it("adds a need's lead to the nearest readable one beyond work it can't read", () => {
    // Fix round 2 (MED 1): the creaming "the morning of" can't be read, but
    // it comes before a 2-hour chill, so the softening's half hour counts
    // from the chill. It showed "30 minutes before", on top, which is false.
    const p = aheadOnly(
      ["soften", "30 minutes before", []],
      ["cream", "the morning of", ["soften"]],
      ["chill", "at least 2 hours before", ["cream"]],
      ["toast", "1½ hours before", []],
    );
    expect(shape(p)).toEqual([
      ["at least 2½ hours before", ["soften"]],
      ["the morning of", ["cream"]],
      ["at least 2 hours before", ["chill"]],
      ["1½ hours before", ["toast"]],
    ]);
    expect(aheadOrderBreaks(p)).toEqual([]);
    // A longer one keeps its own.
    expect(
      shape(
        aheadOnly(
          ["soak", "overnight", []],
          ["cream", "the morning of", ["soak"]],
          ["chill", "at least 2 hours before", ["cream"]],
        ),
      ),
    ).toEqual([
      ["overnight", ["soak"]],
      ["the morning of", ["cream"]],
      ["at least 2 hours before", ["chill"]],
    ]);
  });

  it("splits a lead's group rather than loop it round work in between", () => {
    // Fix round 2: the two hours are one wait, but the morning's work sits
    // between them, so one group would hold the morning both above and below.
    const p = aheadOnly(
      ["thaw", "1 hour before", []],
      ["brine", "the morning of", ["thaw"]],
      ["rest", "1 hour before", ["brine"]],
    );
    expect(shape(p)).toEqual([
      ["1 hour before", ["thaw"]],
      ["the morning of", ["brine"]],
      ["1 hour before", ["rest"]],
    ]);
    expect(aheadOrderBreaks(p)).toEqual([]);
  });

  it("keeps a need's lead it can't read in its own words, with nothing to add", () => {
    // No time to add to the brine's: the words stay, and the need still
    // comes first.
    expect(
      shape(aheadOnly(["thaw", "the morning of", []], ["brine", "at least 2 hours before", ["thaw"]])),
    ).toEqual([
      ["the morning of", ["thaw"]],
      ["at least 2 hours before", ["brine"]],
    ]);
    // An upper bound alone reads as no time too: kept, and first.
    expect(
      shape(aheadOnly(["sauce", "up to 2 days ahead", []], ["marinate", "overnight", ["sauce"]])),
    ).toEqual([
      ["up to 2 days ahead", ["sauce"]],
      ["overnight", ["marinate"]],
    ]);
  });

  it("goes longest lead first wherever its needs allow", () => {
    // Fix round 1 (L1): the thaw, which can't be read, holds up the 2-hour
    // marinade, so it goes before the 1-hour temper with the marinade.
    const p = aheadOnly(
      ["thaw", "the morning of", []],
      ["marinate", "at least 2 hours before", ["thaw"]],
      ["temper", "1 hour before", []],
    );
    expect(shape(p)).toEqual([
      ["the morning of", ["thaw"]],
      ["at least 2 hours before", ["marinate"]],
      ["1 hour before", ["temper"]],
    ]);
    expect(aheadOrderBreaks(p)).toEqual([]);
  });

  it("reads work on the cook's own day as after the night before", () => {
    // Fix round 1 (M1): "the day of" read as a day ahead went above overnight.
    expect(
      shape(aheadOnly(["shop", "the day of", []], ["soak", "overnight", []])),
    ).toEqual([
      ["overnight", ["soak"]],
      ["the day of", ["shop"]],
    ]);
  });

  it("keeps the plan's order between leads of the same length", () => {
    // Two waits said differently, nothing joining them: plan order.
    expect(
      shape(aheadOnly(["rest", "an hour before", []], ["soak", "1 hour before", []])),
    ).toEqual([
      ["an hour before", ["rest"]],
      ["1 hour before", ["soak"]],
    ]);
    // Joined by a need, one wait is one group, under the dependent's words.
    expect(
      shape(aheadOnly(["rest", "60 minutes before", []], ["fold", "1 hour before", ["rest"]])),
    ).toEqual([["1 hour before", ["rest", "fold"]]]);
  });

  it("shows a need with no lead under the lead of the work it feeds", () => {
    expect(
      shape(aheadOnly(["line-tin", null, []], ["chill", "overnight", ["line-tin"]])),
    ).toEqual([["overnight", ["line-tin", "chill"]]]);
    // Untimed work that needs timed work stays untimed, after it.
    expect(
      shape(aheadOnly(["soak", "2 hours before", []], ["drain", null, ["soak"]])),
    ).toEqual([
      ["2 hours before", ["soak"]],
      [null, ["drain"]],
    ]);
  });

  it("puts a lead it can't read before the work that needs it", () => {
    // "The morning of" can't be compared, so it keeps its words; the need
    // still comes first, ahead of the longer wait that would otherwise lead.
    expect(
      shape(
        aheadOnly(
          ["thaw", "the morning of", []],
          ["marinate", "at least 2 hours before", ["thaw"]],
          ["soak", "overnight", []],
        ),
      ),
    ).toEqual([
      ["overnight", ["soak"]],
      ["the morning of", ["thaw"]],
      ["at least 2 hours before", ["marinate"]],
    ]);
  });

  it("shows a lead twice rather than loop the groups", () => {
    // "the morning of" holds a and d, "a few hours ahead" b and c; b needs
    // a and d needs c, so as two groups neither could go first. Until review
    // fix round 3 that folded all four into one untimed group; now d starts
    // a second morning group, after the few hours.
    const loop = aheadOnly(
      ["a", "the morning of", []],
      ["c", "a few hours ahead", []],
      ["b", "a few hours ahead", ["a"]],
      ["d", "the morning of", ["c"]],
    );
    const groups = view(initialCookState("first"), loop).prep!.ahead;
    expect(groups.map((g) => [g.lead, g.items.map((a) => a.id), g.labels])).toEqual([
      ["the morning of", ["a"], ["a"]],
      ["a few hours ahead", ["c", "b"], ["c", "b"]],
      ["the morning of", ["d"], ["d"]],
    ]);
    expect(aheadOrderBreaks(loop)).toEqual([]);
    // Two chains with mixed anchors, crossing the same way (round 3, LOW).
    const crossed = aheadOnly(
      ["a", "the morning of", []],
      ["b", "1 hour", ["a"]],
      ["c", "1 hour", []],
      ["d", "the morning of", ["c"]],
    );
    expect(shape(crossed)).toEqual([
      ["the morning of", ["a"]],
      ["1 hour before", ["b", "c"]],
      ["the morning of", ["d"]],
    ]);
    expect(aheadOrderBreaks(crossed)).toEqual([]);
  });

  it("shows one untimed group in needs order when the needs themselves loop", () => {
    // The parser rejects a loop, so only a plan built some other way has one;
    // no order of the groups is true of it.
    const loop = aheadOnly(["a", "1 hour before", ["b"]], ["b", "the morning of", ["a"]]);
    expect(shape(loop)).toEqual([[null, ["a", "b"]]]);
  });

  it("keeps a lead with no readable time in the recipe's words, adding nothing", () => {
    // Review fix round 3: "before" went on any lead ending in a unit word, so
    // "the same day" showed "the same day before", read as a day ahead.
    for (const lead of [
      "on the day",
      "that day",
      "earlier in the day",
      "the same day",
      "a day ahead or the same day",
      "the day before or on the day",
    ]) {
      expect(shape(aheadOnly(["x", lead, []])), lead).toEqual([[lead, ["x"]]]);
    }
    // Any other lead stopping at its unit gets its "before", readable or
    // not (round 4: "a few hours" alone reads as a duration).
    for (const [lead, shown] of [
      ["1 day", "1 day before"],
      ["a few hours", "a few hours before"],
      ["up to 2 days", "up to 2 days before"],
    ]) {
      expect(shape(aheadOnly(["x", lead, []])), lead).toEqual([[shown, ["x"]]]);
    }
    // The overnight soak isn't counted from a day ahead its dependent may not be.
    expect(
      shape(aheadOnly(["soak", "overnight", []], ["cook", "a day ahead or the same day", ["soak"]])),
    ).toEqual([
      ["overnight", ["soak"]],
      ["a day ahead or the same day", ["cook"]],
    ]);
    // Nor an hour's softening from "earlier in the day before" (25 hours).
    const day = aheadOnly(
      ["soften", "1 hour before", []],
      ["cream", "earlier in the day", ["soften"]],
      ["chill", "at least 2 hours before", ["cream"]],
    );
    expect(shape(day)).toEqual([
      ["at least 3 hours before", ["soften"]],
      ["earlier in the day", ["cream"]],
      ["at least 2 hours before", ["chill"]],
    ]);
    expect(aheadOrderBreaks(day)).toEqual([]);
  });

  it("keeps a need's words when the same wait is reached only through untimed work", () => {
    // Round 3 (LOW): "60 minutes" and "1 hour" are one wait, but the
    // morning's work sits between, so the softening keeps its own words
    // rather than take the chill's.
    expect(
      shape(
        aheadOnly(
          ["soften", "60 minutes before", []],
          ["cream", "the morning of", ["soften"]],
          ["chill", "1 hour before", ["cream"]],
        ),
      ),
    ).toEqual([
      ["60 minutes before", ["soften"]],
      ["the morning of", ["cream"]],
      ["1 hour before", ["chill"]],
    ]);
  });

  it("ranks a group by the longest wait it holds, not its first", () => {
    // Round 4: x (65 minutes) and u (70) both show "about 1¼ hours before".
    // The group holds 70, so it goes above the 68-minute work; ranked by its
    // first item's 65 it would go below.
    expect(
      shape(
        aheadOnly(
          ["x", "5 minutes before", []],
          ["u", "10 minutes before", []],
          ["y", "1 hour before", ["x"]],
          ["v", "1 hour before", ["u"]],
          ["w", "68 minutes before", []],
        ),
      ),
    ).toEqual([
      ["about 1¼ hours before", ["x", "u"]],
      ["68 minutes before", ["w"]],
      ["1 hour before", ["y", "v"]],
    ]);
  });
  it("reads a lead that stops at its duration as one before, so one wait is one group", () => {
    // The yogurt marinade: three tasks "at least 4 hours before", the fourth
    // "at least 4 hours". The cook sees one wait, so the screen shows one.
    const marinade: CookPlan = {
      version: 1,
      tasks: [
        task("garlic", "ahead", { lead: "at least 4 hours before" }),
        task("marinate", "ahead", { lead: "at least 4 hours", needs: ["garlic"] }),
        task("soak", "ahead", { lead: "overnight" }),
        task("rest", "ahead", { lead: "30 Minutes" }),
        task("grill", "cook", { needs: ["marinate", "soak", "rest"] }),
      ],
    };
    const groups = view(initialCookState("first"), marinade).prep!.ahead;
    expect(groups.map((g) => [g.lead, g.items.map((a) => a.id), g.items.map((a) => a.lead)])).toEqual([
      ["overnight", ["soak"], ["overnight"]],
      ["at least 4 hours before", ["garlic", "marinate"], ["at least 4 hours before", "at least 4 hours before"]],
      ["30 Minutes before", ["rest"], ["30 Minutes before"]],
    ]);
    expect(groups[1].labels).toEqual(["garlic", "marinate"]);
  });

  it("reads a lead that stops at an abbreviated unit as one before too (T follow-up, item 3)", () => {
    // "30 min" and "30 min before" are one wait; "2 hr" and "2 hrs" read
    // with "before" like "2 hours" does, so the time line can say "ahead".
    const abbreviated: CookPlan = {
      version: 1,
      tasks: [
        task("brine", "ahead", { lead: "2 hr" }),
        task("chill", "ahead", { lead: "at least 3 hrs" }),
        task("rest", "ahead", { lead: "30 min" }),
        task("thaw", "ahead", { lead: "30 min before" }),
        task("grill", "cook", { needs: ["brine", "chill", "rest", "thaw"] }),
      ],
    };
    const groups = view(initialCookState("first"), abbreviated).prep!.ahead;
    expect(groups.map((g) => [g.lead, g.items.map((a) => a.id)])).toEqual([
      ["at least 3 hrs before", ["chill"]],
      ["2 hr before", ["brine"]],
      ["30 min before", ["rest", "thaw"]],
    ]);
  });

  it("names a single chapter Cook beside Prep", () => {
    // An 8-minute simmer is no break, so the steps are one chapter.
    const quick: CookPlan = {
      ...beans,
      tasks: beans.tasks.map((t) =>
        t.id === "simmer" ? { ...t, minutes: { est: 8, handsOff: true } } : t,
      ),
    };
    const v = view(initialCookState("first"), quick);
    expect(v.chapters!.map((c) => c.name)).toEqual(["Prep", "Cook"]);
  });

  it("names a mise task's first use, not the last one the plan lists", () => {
    // The cumin toasts first, so the garlic comes up in the steps.
    const garlic: CookPlan = {
      version: 1,
      tasks: [
        task("finish", "cook", { needs: ["sweat", "garlic"], label: "finish" }),
        task("toast", "cook", { label: "toast the cumin", minutes: { est: 3, handsOff: false } }),
        task("garlic", "mise", { needs: ["toast"], minutes: { est: 1, handsOff: false } }),
        task("sweat", "cook", {
          needs: ["garlic"],
          label: "sweat onions",
          minutes: { est: 5, handsOff: false },
        }),
      ],
    };
    const v = view(initialCookState("go"), garlic);
    expect(v.prep!.mise[0].when).toBe("before you sweat onions");
  });

  describe("ticking mise that other mise needs", () => {
    // Peel before starting; toast the spices, then pound them with what was
    // peeled, and fry the paste. The pounding comes up in the steps.
    const paste: CookPlan = {
      version: 1,
      tasks: [
        task("peel", "mise", { minutes: { est: 2, handsOff: false } }),
        task("toast", "cook", { minutes: { est: 3, handsOff: false } }),
        task("pound", "mise", {
          needs: ["peel", "toast"],
          minutes: { est: 1, handsOff: false },
        }),
        task("chop", "mise", { minutes: { est: 1, handsOff: false } }),
        task("fry", "cook", {
          needs: ["pound", "chop"],
          minutes: { est: 5, handsOff: false },
        }),
      ],
    };
    const start = initialCookState("go");
    const done = (s: CookState) =>
      view(s, paste).prep!.mise.filter((m) => m.done).map((m) => m.id);

    it("ticking a task ticks what it needs", () => {
      const first = setMode(start, "first");
      const s = toggleTick(paste, first, "pound");
      expect(done(s)).toEqual(["peel", "pound"]);
      // As I go, the pounding is done in the steps, so it has no tick here.
      expect(toggleTick(paste, start, "pound")).toBe(start);
    });

    it("unticking a task unticks what needs it, including passed work", () => {
      // Past the pounding in the steps, then back on Prep: the peeling was
      // not done, so neither was the pounding.
      const passed = jumpTo(paste, steps(start, 3, paste), 0);
      expect(passed.passed).toEqual(new Set(["toast", "pound"]));
      expect(done(passed)).toEqual(["peel", "pound", "chop"]);
      const reopened = toggleTick(paste, passed, "peel");
      expect(reopened.passed).toEqual(new Set(["toast"]));
      expect(done(reopened)).toEqual(["chop"]);
      // Next leaves both open: the cook lands on the peeling, not past it.
      const resumed = next(paste, reopened);
      expect(done(jumpTo(paste, resumed, 0))).toEqual(["chop"]);
      expect(keys(resumed, paste)[0]).toBe("peel");
    });

    it("ignores an id that is not mise", () => {
      expect(toggleTick(paste, start, "fry")).toBe(start);
      expect(toggleTick(paste, start, "nope")).toBe(start);
    });
  });

  it.each<[PrepMode]>([["first"], ["go"]])(
    "keeps ahead tasks out of the steps (%s)",
    (mode) => {
      expect(keys(next(beans, initialCookState(mode)), beans)).toEqual([
        "simmer",
      ]);
    },
  );
});

/** The fixture corpus's derived plans, as the snapshots parse. */
function derivedCorpus(): { name: string; plan: CookPlan }[] {
  const snapshots = loadCookPlanSnapshots();
  return loadCookPlanFixtures().map((f) => {
    const raw = snapshots.get(f.name)?.raw;
    const parsed = raw ? parseCookPlan(raw, f.recipe) : null;
    if (!parsed?.ok) throw new Error(`no derived plan parses for ${f.name}`);
    return { name: f.name, plan: parsed.plan };
  });
}

/**
 * Where the make-ahead list shows work before what it needs: a need in a later
 * group than its dependent, later in the same group, or under a shorter lead.
 * Where a need whose own lead is shorter than its dependent's (counted from
 * it) is shown less early than the two added. And where a shorter lead comes
 * above a longer one that nothing it holds up forces.
 */
function aheadOrderBreaks(p: CookPlan): string[] {
  // A plan with no Prep screen (nothing ahead, no mise) has nothing to order.
  const groups = cookView(p, DERIVED, initialCookState("first")).prep?.ahead ?? [];
  const at = new Map<string, [number, number]>();
  groups.forEach((g, gi) => g.items.forEach((a, ai) => at.set(a.id, [gi, ai])));
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const breaks: string[] = [];
  for (const t of p.tasks) {
    if (t.kind !== "ahead") continue;
    const [g, i] = at.get(t.id)!;
    // Shown in its own words, it must read as the recipe's lead does: words
    // added for the screen ("the same day before") must not change the wait.
    const shownLead = groups[g].lead;
    if (t.lead && shownLead?.startsWith(t.lead) && leadMinutes(shownLead) !== leadMinutes(t.lead)) {
      breaks.push(`${t.id} shows "${shownLead}", read ${leadMinutes(shownLead)}; "${t.lead}" reads ${leadMinutes(t.lead)}`);
    }
    for (const n of t.needs) {
      const [ng, ni] = at.get(n)!;
      if (ng > g || (ng === g && ni > i)) breaks.push(`${t.id} before ${n}`);
      const [own, need] = [leadMinutes(groups[g].lead), leadMinutes(groups[ng].lead)];
      if (own !== null && need !== null && need < own) {
        breaks.push(`${n} (${groups[ng].lead}) under ${t.id} (${groups[g].lead})`);
      }
      const said = leadMinutes(byId.get(n)!.lead);
      if (own !== null && said !== null && said < own && (need === null || need < said + own)) {
        breaks.push(`${n} (${groups[ng].lead}) less than ${said} + ${own} minutes ahead`);
      }
    }
    // The same through needs whose own lead can't be read, as the parser
    // checks them: what they need comes earlier still.
    const own = leadMinutes(groups[g].lead);
    if (own === null) continue;
    const seen = new Set<string>();
    const queue = t.needs.filter((n) => leadMinutes(byId.get(n)!.lead) === null);
    while (queue.length > 0) {
      const via = queue.shift()!;
      if (seen.has(via)) continue;
      seen.add(via);
      for (const n of byId.get(via)!.needs) {
        const said = leadMinutes(byId.get(n)!.lead);
        if (said === null) {
          queue.push(n);
          continue;
        }
        const need = leadMinutes(groups[at.get(n)![0]].lead);
        if ((need !== null && need < own) || (said < own && (need === null || need < said + own))) {
          breaks.push(`${n} (${groups[at.get(n)![0]].lead}) less than ${said} + ${own} minutes ahead, through ${via}`);
        }
      }
    }
  }
  // The longest lead each group holds up: its own, or any group's that needs
  // something in it, however far down.
  const dependentsOf = (id: string): string[] =>
    p.tasks.filter((t) => t.needs.includes(id)).flatMap((t) => [t.id, ...dependentsOf(t.id)]);
  const holds = groups.map((g) =>
    Math.max(
      -1,
      ...g.items
        .flatMap((a) => [a.id, ...dependentsOf(a.id)])
        .map((id) => at.get(id))
        .filter((pos) => pos !== undefined)
        .map(([gi]) => leadMinutes(groups[gi].lead) ?? -1),
    ),
  );
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const [a, b] = [leadMinutes(groups[i].lead), leadMinutes(groups[j].lead)];
      if (a !== null && b !== null && a < b && holds[i] < b) {
        breaks.push(`"${groups[i].lead}" before "${groups[j].lead}"`);
      }
    }
  }
  return breaks;
}

/**
 * The cookies as the 2026-09-25 prompt derived them: soften-butter's and
 * room-temp-eggs' leads count back from the step that uses them, the dough's
 * from the start of the cook. Built directly, as a stored plan is read: the
 * parser no longer passes it.
 */
function cookiesMixedAnchors(): CookPlan {
  const f = loadCookPlanFixtures().find((x) => x.name === "chewy-oat-cookies")!;
  const raw = structuredClone(loadCookPlanSnapshots().get(f.name)!.raw) as {
    tasks: CookTask[];
  };
  const old: Record<string, string> = {
    "soften-butter": "1 hour before",
    "room-temp-eggs": "30 minutes before",
  };
  const tasks = raw.tasks.map((t) => {
    const out: CookTask = { ...t };
    for (const k of ["minutes", "cue", "lead"] as const) {
      if (out[k] === null) delete out[k];
    }
    if (old[t.id]) out.lead = old[t.id];
    return out;
  });
  return { version: 4, tasks };
}

/** The cookies' make-ahead groups, under one anchor: longest lead first. */
const COOKIES_AHEAD = [
  ["at least 3 hours before", ["soften-butter"]],
  ["at least 2½ hours before", ["room-temp-eggs"]],
  [
    "at least 2 hours before",
    ["whisk-dry-ingredients", "beat-butter-sugar", "add-eggs-vanilla", "mix-dough", "chill-dough"],
  ],
];

describe("cookView: make-ahead order", () => {
  it("never shows the cookies' creaming before the butter it needs softened (stored, mixed anchors)", () => {
    // Fix round 1 (H2): the butter's hour and the eggs' half hour count from
    // the 2-hour dough, so they show as 3 hours and 2½ hours: the same Prep
    // screen the plan derived under one anchor gives.
    const p = cookiesMixedAnchors();
    expect(aheadOrderBreaks(p)).toEqual([]);
    const shown = (q: CookPlan) =>
      cookView(q, DERIVED, initialCookState("first")).prep!.ahead.map((g) => [
        g.lead,
        g.items.map((a) => a.id),
      ]);
    expect(shown(p)).toEqual(COOKIES_AHEAD);
    const { plan: fixed } = derivedCorpus().find((d) => d.name === "chewy-oat-cookies")!;
    expect(shown(p)).toEqual(shown(fixed));
  });

  it("shows the cookies as derived under one anchor longest lead first", () => {
    const { plan: p } = derivedCorpus().find((d) => d.name === "chewy-oat-cookies")!;
    const groups = cookView(p, DERIVED, initialCookState("first")).prep!.ahead;
    expect(groups.map((g) => [g.lead, g.items.map((a) => a.id)])).toEqual(COOKIES_AHEAD);
  });

  it("never shows ahead work before what it needs, over every derived plan", () => {
    for (const { name, plan: p } of derivedCorpus()) {
      expect(aheadOrderBreaks(p), name).toEqual([]);
    }
  });

  it("keeps two same-day tasks apart when joining them would put a shorter lead above a longer one", () => {
    // One "on the day" task needs the hour's work; the six hours' work needs
    // the other. As one group the hour stood above the six hours (KNOWN-ISSUES,
    // closed in slice V). Apart, the six hours' chain goes first.
    const p = aheadPlan(
      ["t0", "1 hour before", []],
      ["t1", "on the day", ["t0"]],
      ["t2", "on the day", []],
      ["t5", "6 hours before", ["t2"]],
    );
    expect(aheadOrderBreaks(p)).toEqual([]);
    const groups = cookView(p, DERIVED, initialCookState("first")).prep!.ahead;
    expect(groups.map((g) => [g.lead, g.items.map((a) => a.id)])).toEqual([
      ["on the day", ["t2"]],
      ["6 hours before", ["t5"]],
      ["1 hour before", ["t0"]],
      ["on the day", ["t1"]],
    ]);
    // Two same-day tasks with nothing timed across them still share one line.
    const shared = aheadPlan(
      ["a", "6 hours before", []],
      ["b", "on the day", ["a"]],
      ["c", "on the day", []],
      ["d", "1 hour before", ["b", "c"]],
    );
    expect(
      cookView(shared, DERIVED, initialCookState("first")).prep!.ahead.map((g) => [g.lead, g.items.map((x) => x.id)]),
    ).toEqual([
      ["6 hours before", ["a"]],
      ["on the day", ["b", "c"]],
      ["1 hour before", ["d"]],
    ]);
  });

  it("keeps same-day tasks apart when the shorter lead above is two unreadable steps away", () => {
    // As above, but the hour's work reaches the joined group only through a
    // task under another lead that can't be read. The split has to look past
    // that task to the hour (the verifier's reach mutant, which looked one
    // step only, kept them together and put the hour above the six hours).
    const p = aheadPlan(
      ["t0", "1 hour before", []],
      ["tm", "the morning of", ["t0"]],
      ["t1", "on the day", ["tm"]],
      ["t2", "on the day", []],
      ["t5", "6 hours before", ["t2"]],
    );
    expect(aheadOrderBreaks(p)).toEqual([]);
    const groups = cookView(p, DERIVED, initialCookState("first")).prep!.ahead;
    const holding = (id: string) => groups.findIndex((g) => g.items.some((a) => a.id === id));
    expect(holding("t1")).not.toBe(holding("t2"));
    expect(holding("t5")).toBeLessThan(holding("t0"));
  });

  it("never shows a restated lead above a longer one that hangs off a chain of unreadable leads", () => {
    // The B4 verifier's repro (KNOWN-ISSUES, routed to B5a): t2's half hour is
    // restated as 1½ hours behind t5's hour, and t5 shared a group with t0,
    // which the 6-hour t4 needs through two leads that can't be read. The
    // group held t2 above the six hours. Apart, the six hours go first.
    const p = aheadPlan(
      ["t0", null, []],
      ["t2", "30 minutes before", []],
      ["t1", "the morning of", ["t0"]],
      ["t5", "1 hour before", ["t0", "t2"]],
      ["t3", "on the day", ["t1"]],
      ["t4", "6 hours before", ["t3"]],
    );
    expect(aheadOrderBreaks(p)).toEqual([]);
    const groups = cookView(p, DERIVED, initialCookState("first")).prep!.ahead;
    const holding = (id: string) => groups.findIndex((g) => g.items.some((a) => a.id === id));
    expect(holding("t4")).toBeLessThan(holding("t2"));
  });

  it("keeps the same wait on one line through a dependent with no lead of its own (B5a verify round 1)", () => {
    // t0's day ahead and t4's day before are one wait; t1, with no lead,
    // only passes it on. Reading through t1 must not part them.
    const p = aheadPlan(
      ["t0", "a day ahead", []],
      ["t1", null, ["t0"]],
      ["t2", "at least 1 hour before", []],
      ["t3", null, ["t2"]],
      ["t4", "the day before", ["t1", "t2", "t3"]],
    );
    expect(aheadOrderBreaks(p)).toEqual([]);
    const groups = cookView(p, DERIVED, initialCookState("first")).prep!.ahead;
    const holding = (id: string) => groups.findIndex((g) => g.items.some((a) => a.id === id));
    expect(holding("t0")).toBe(holding("t4"));
  });

  it("never shows ahead work out of order over 5000 plans built around unreadable chains", () => {
    // B5a: the walk below never drew the repro's shape. This one does: most
    // leads can't be read, and needs reach back further.
    let seed = 20261007;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    const LEADS = [
      "30 minutes before",
      "1 hour before",
      "6 hours before",
      "on the day",
      "the morning of",
      // A holding time names no wait (B5a verify round 2, M1).
      "keeps, covered, 3 days",
      null,
      null,
    ];
    const found: string[] = [];
    for (let k = 0; k < 5000; k++) {
      const n = 5 + Math.floor(rand() * 4);
      const ahead: [string, string | null, string[]][] = [];
      for (let i = 0; i < n; i++) {
        // Mostly a chain off the last task or two, so unreadable leads line up.
        const needs = ahead
          .map(([id]) => id)
          .filter((_, j) => rand() < (j >= ahead.length - 2 ? 0.5 : 0.2));
        ahead.push([`t${i}`, LEADS[Math.floor(rand() * LEADS.length)], needs]);
      }
      for (let i = ahead.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [ahead[i], ahead[j]] = [ahead[j], ahead[i]];
      }
      const breaks = aheadOrderBreaks(aheadPlan(...ahead));
      if (breaks.length > 0) found.push(`${JSON.stringify(ahead)}: ${breaks.join("; ")}`);
    }
    expect(found.slice(0, 3), `${found.length} plans out of order; first: ${found[0] ?? ""}`).toEqual([]);
  }, 30_000);

  it("never shows ahead work out of order over 5000 seeded random plans", () => {
    // A seeded walk over small plans of mixed leads, needs only on earlier
    // tasks (so none loop), listed in a shuffled order.
    let seed = 20261005;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    const LEADS = [
      "30 minutes before",
      "1 hour before",
      "at least 2 hours before",
      "6 hours before",
      "overnight",
      "the day before",
      "on the day",
      "the morning of",
      null,
    ];
    const found: string[] = [];
    for (let k = 0; k < 5000; k++) {
      const n = 2 + Math.floor(rand() * 5);
      const ahead: [string, string | null, string[]][] = [];
      for (let i = 0; i < n; i++) {
        const needs = ahead.map(([id]) => id).filter(() => rand() < 0.3);
        ahead.push([`t${i}`, LEADS[Math.floor(rand() * LEADS.length)], needs]);
      }
      for (let i = ahead.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [ahead[i], ahead[j]] = [ahead[j], ahead[i]];
      }
      const breaks = aheadOrderBreaks(aheadPlan(...ahead));
      if (breaks.length > 0) found.push(`${JSON.stringify(ahead)}: ${breaks.join("; ")}`);
    }
    expect(found.slice(0, 3), `${found.length} plans out of order`).toEqual([]);
    // The walk took 1.5 s at load 8–10; the timeout leaves room for a busier
    // pre-push run.
  }, 20_000);
});

/** Ahead tasks, each [id, lead, needs], and a bake needing the rest. */
function aheadPlan(...ahead: [string, string | null, string[]][]): CookPlan {
  const used = new Set(ahead.flatMap(([, , needs]) => needs));
  const task = (id: string, kind: CookTask["kind"], extra: Partial<CookTask>): CookTask => ({
    id,
    kind,
    text: `Do ${id}`,
    label: id,
    ingredientIdx: [],
    sourceStep: null,
    implied: true,
    needs: [],
    branch: "Beans",
    ...extra,
  });
  return {
    version: 4,
    tasks: [
      ...ahead.map(([id, lead, needs]) => task(id, "ahead", { needs, ...(lead ? { lead } : {}) })),
      task("bake", "cook", { needs: ahead.map(([id]) => id).filter((id) => !used.has(id)) }),
    ],
  };
}

describe("cookView: As I go's Prep split, over the derived plans", () => {
  const corpus = derivedCorpus();
  // A plan of cooking alone has no Prep screen.
  const withPrep = corpus.filter((c) => c.plan.tasks.some((t) => t.kind !== "cook"));

  it("has the corpus to check", () => {
    expect(corpus).toHaveLength(15);
    expect(withPrep).toHaveLength(14);
  });

  it.each(withPrep.map((c) => [c.name, c.plan] as const))(
    "%s: each mise row in one group, the before group ahead of any cooking",
    (_name, p) => {
      const prep = view(initialCookState("go"), p).prep!;
      const mise = p.tasks.filter((t) => t.kind === "mise");
      expect(prep.mise.map((m) => m.id)).toEqual(mise.map((t) => t.id));
      for (const m of prep.mise) {
        // Before rows tick and say no when; the rest say when they come up.
        expect(m.when === null, m.id).toBe(m.before);
      }
      const screens = screensOf(p, "go", new Set());
      const firstCook = screens.findIndex(
        (s) => s.kind === "step" && s.item.tasks.some((t) => t.kind === "cook"),
      );
      const screenOf = (id: string) =>
        screens.findIndex((s) => s.kind === "step" && s.item.tasks.some((t) => t.id === id));
      for (const m of prep.mise) {
        if (firstCook === -1) expect(m.before, m.id).toBe(true);
        else expect(screenOf(m.id) < firstCook, m.id).toBe(m.before);
      }
      const before = prep.mise.filter((m) => m.before);
      expect(prep.beforeNote).toBe(
        mise.length > 0 && before.length === 0 ? COOK_COPY.nothingBefore : null,
      );
    },
  );

  it.each(withPrep.map((c) => [c.name, c.plan] as const))(
    "%s: the Prep line's minutes add up the before group's",
    (_name, p) => {
      const before = p.tasks.filter((t) => miseBefore(p, "go").has(t.id));
      const expected =
        before.length === 0 || before.some((t) => !t.minutes)
          ? null
          : minutesLabel(
              before.reduce((sum, t) => sum + t.minutes!.est, 0),
              before.every((t) => t.minutes!.handsOff),
            );
      expect(view(initialCookState("go"), p).stack[0].minutes).toBe(expected);
    },
  );

  it("puts all of a stir-fry's mise before cooking, and none of a dal's", () => {
    const byName = new Map(corpus.map((c) => [c.name, c.plan]));
    const stirFry = byName.get("weeknight-stir-fry")!;
    const dal = byName.get("indian-dal-tadka")!;
    expect(view(initialCookState("go"), stirFry).prep!.mise.every((m) => m.before)).toBe(true);
    const dalPrep = view(initialCookState("go"), dal).prep!;
    expect(dalPrep.mise.some((m) => m.before)).toBe(false);
    expect(dalPrep.beforeNote).toBe(COOK_COPY.nothingBefore);
  });
});

describe("cookView: now alone in the stack", () => {
  const glances = (state: CookState, p: CookPlan = plan, source = DERIVED) =>
    view(state, p, source).stack.map((l) => l.glance);

  it("reads the step as its label with its lead, sentence-cased", () => {
    const go = initialCookState("go");
    expect(glances(go)).toEqual(["Get set up"]);
    expect(glances(next(plan, go))).toEqual(["Sauté"]);
    // "Then" reads only ahead, as the text does.
    expect(glances(steps(go, 3))[0]).toBe("Fry parathas");
    expect(glances(next(plan, initialCookState("first")))).toEqual(["Sauté"]);
  });

  it("joins merged mise's labels as one run, with no closing stop", () => {
    const inSteps = jumpTo(plan, initialCookState("go"), 1);
    expect(glances(inSteps)[0]).toBe("Slice onion, mince scape, and cut zucchini");
    expect(view(inSteps).stack[0].text).toBe(
      "Slice the onion bulb, mince the garlic scape, and cut the zucchini into thin matchsticks.",
    );
  });

  it("reads a recipe as written by its text: its labels are only its steps' first words", () => {
    const asWritten = identityPlan(ZUCCHINI_RECIPE);
    expect(asWritten.tasks[0].label).toBe("sauté the onion");
    const source: PlanSource = { kind: "as-written", reason: "failed" };
    const v = view(initialCookState("first"), asWritten, source);
    expect(v.stack.map((l) => l.glance)).toEqual(v.stack.map((l) => l.text));
    const onStep = view(next(asWritten, initialCookState("first")), asWritten, source);
    expect(onStep.stack[0].glance).toBe("Stir in the onion greens at the very end.");
  });

  it("names each line by its label or, as written, its text, with no lead", () => {
    const names = (state: CookState, p: CookPlan = plan, source = DERIVED) =>
      view(state, p, source).stack.map((l) => l.name);
    expect(names(initialCookState("go"))).toEqual(["Get set up"]);
    expect(names(next(plan, initialCookState("go")))).toEqual(["Sauté"]);
    expect(names(jumpTo(plan, initialCookState("go"), 1))[0]).toBe(
      "Slice onion, mince scape, and cut zucchini",
    );
    const asWritten = identityPlan(ZUCCHINI_RECIPE);
    const onStep = view(next(asWritten, initialCookState("first")), asWritten, { kind: "as-written", reason: "failed" });
    expect(onStep.stack[0].name).toBe("Stir in the onion greens at the very end.");
  });
});

describe("cookView: chapters", () => {
  const corpus = derivedCorpus();
  /** Every state Next reaches from the first step on, in both modes. */
  const walks = corpus.flatMap(({ name, plan: p }) =>
    (["first", "go"] as const).map((mode) => {
      let s = initialCookState(mode);
      if (view(s, p).onPrep) s = next(p, s);
      const states = [s];
      while (!view(s, p).isLast) {
        s = next(p, s);
        states.push(s);
      }
      return { label: `${name} ${mode}`, p, mode, states };
    }),
  );

  it.each(walks.map((w) => [w.label, w] as const))(
    "%s: a chapter runs while the strip shows one of its pots running, or while it is part done",
    (_label, { p, mode, states }) => {
      const s0 = strip(p, states[0]);
      if (!s0) return;
      const chapterAt = new Map(
        states.map((s) => [s.pos, view(s, p).chapters?.find((c) => c.state === "now")?.id]),
      );
      const screens = screensOf(p, mode, states[0].ticked);
      const tasksOf = (id: string) =>
        id === "prep"
          ? p.tasks.filter((t) => t.kind === "mise").map((t) => t.id)
          : screens.flatMap((sc, i) =>
              sc.kind === "step" && chapterAt.get(i) === id ? sc.item.tasks.map((t) => t.id) : [],
            );
      for (const s of states) {
        const sData = strip(p, s);
        const running = new Set(
          sData ? sData.marks.filter((b) => b.state === "running").map((b) => chapterAt.get(b.screen)) : [],
        );
        for (const c of view(s, p).chapters ?? []) {
          if (c.state === "now") continue;
          const done = tasksOf(c.id).filter((t) => isDone(s, t)).length;
          const partDone = done > 0 && done < tasksOf(c.id).length;
          expect(c.state === "running", `pos ${s.pos} ${c.id}`).toBe(running.has(c.id) || partDone);
        }
      }
    },
  );

  it("meets a chapter running on its pot in the corpus", () => {
    expect(
      walks.some(({ p, states }) =>
        states.some((s) => view(s, p).chapters?.some((c) => c.state === "running")),
      ),
    ).toBe(true);
  });

  /**
   * One source (N2 orchestrator review, item 4): the free time the eyebrow and
   * Whole recipe say is the one the chart draws. Read off the strip's own
   * marks, the break runs from the latest hands-end (a pot frees the hands at
   * its start) up to the next stretch's first start, and equals the view's.
   */
  it.each(walks.map((w) => [w.label, w] as const))(
    "%s: every stretch's free time is the strip marks' hands-end to the next start",
    (_label, { p, states }) => {
      for (const s of states) {
        const st = strip(p, s);
        const stretches = view(s, p).chapters!.filter((c) => c.id !== "prep");
        expect(st.stretches.map((x) => x.screens)).toEqual(stretches.map((c) => c.at));
        stretches.forEach((c, k) => {
          expect(st.stretches[k].free).toEqual(c.free);
          if (c.free === null) return;
          const last = c.at[c.at.length - 1];
          const steps = st.marks.filter((m) => m.stretch !== null);
          const handsFree = Math.max(
            ...steps.filter((m) => m.screen <= last).map((m) => (m.pot ? m.start : m.end)),
          );
          const nextStart = Math.min(
            ...steps.filter((m) => m.stretch === k + 1).map((m) => m.start),
          );
          expect(c.free.from, `pos ${s.pos} stretch ${k}`).toBeCloseTo(handsFree, 3);
          expect(c.free.to, `pos ${s.pos} stretch ${k}`).toBeCloseTo(nextStart, 3);
          expect(c.free.minutes % 5).toBe(0);
          expect(c.free.minutes).toBeGreaterThanOrEqual(10);
          expect(c.free.minutes).toBeLessThanOrEqual(c.free.to - c.free.from + 1e-9);
        });
      }
    },
  );
});

describe("the chart's read and Go: one numbering, Prep included (N2 verify round 1)", () => {
  const corpus = derivedCorpus();
  /**
   * Prep as opened, Prep with a mise the cook leaves for the steps (As I go's
   * "not done yet"), and every step Next reaches, in both modes.
   */
  const cases = corpus.flatMap(({ name, plan: p }) =>
    (["first", "go"] as const).flatMap((mode) => {
      const open = initialCookState(mode);
      const states: CookState[] = [];
      if (view(open, p).onPrep) {
        states.push(open);
        const early = [...miseBefore(p, mode)][0];
        if (early !== undefined) {
          const ticked = toggleTick(p, open, early);
          states.push(ticked, toggleTick(p, ticked, early));
        }
      }
      let s = view(open, p).onPrep ? next(p, open) : open;
      states.push(s);
      while (!view(s, p).isLast) {
        s = next(p, s);
        states.push(s);
      }
      return [[`${name} ${mode}`, p, states] as const];
    }),
  );

  it.each(cases)("%s: a touched mark reads its own step and Go lands on it", (_label, p, states) => {
    let checked = 0;
    for (const s of states) {
      const st = strip(p, s);
      if (st.asWritten) return;
      for (const m of st.marks) {
        const landed = goToMark(p, s, m.screen);
        const screen = screensOf(p, landed.mode, landed.ticked)[landed.pos];
        if (m.key === "prep") {
          expect(screen.kind, `pos ${s.pos}: Prep's Go`).toBe("prep");
          continue;
        }
        const at = `pos ${s.pos} ticked [${[...s.ticked]}]: mark ${m.key}`;
        expect(screen.kind, at).toBe("step");
        if (screen.kind !== "step") continue;
        expect(stepKey(screen.item), at).toBe(m.key);
        expect(readStepDetails(m, p, s).text, at).toBe(stepBody(screen.item));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.each(cases)("%s: a Go from Prep to a step leaves Prep as Next does", (_label, p, states) => {
    for (const s of states.filter((x) => view(x, p).onPrep)) {
      const left = next(p, s);
      for (const m of strip(p, s).marks.filter((x) => x.key !== "prep")) {
        const landed = goToMark(p, s, m.screen);
        expect([...landed.ticked].sort(), `mark ${m.key}`).toEqual([...left.ticked].sort());
        expect(landed.kept).toEqual(s.kept);
      }
      // Prep's own Go stays on Prep and ticks nothing.
      expect(goToMark(p, s, 0)).toEqual(s);
    }
  });

  it("does nothing out of range", () => {
    const s = initialCookState("go");
    expect(goToMark(plan, s, -1)).toBe(s);
    expect(goToMark(plan, s, 1.5)).toBe(s);
    expect(goToMark(plan, s, 999)).toBe(s);
    const onStep = next(plan, s);
    expect(goToMark(plan, onStep, 999)).toBe(onStep);
  });
});

describe("cookView: the stretch in hand and the eyebrow's place (N2-6)", () => {
  const byName = new Map(derivedCorpus().map((c) => [c.name, c.plan]));
  const roast = byName.get("sunday-roast-dinner")!;

  it("counts down the roast's stretches, Prep first, and turns over after each break", () => {
    const first = initialCookState("first");
    const places: Array<string | undefined> = [];
    let s = next(roast, first);
    for (;;) {
      places.push(view(s, roast).place?.long);
      if (view(s, roast).isLast) break;
      s = next(roast, s);
    }
    expect(places).toEqual([
      "this step, then about 10 min free",
      "3 steps, then about 10 min free",
      "2 steps, then about 10 min free",
      "this step, then about 10 min free",
      "4 steps, then about 50 min free",
      "3 steps, then about 50 min free",
      "2 steps, then about 50 min free",
      "this step, then about 50 min free",
      "9 steps to the table",
      "8 steps to the table",
      "7 steps to the table",
      "6 steps to the table",
      "5 steps to the table",
      "4 steps to the table",
      "3 steps to the table",
      "2 steps to the table",
      "last step",
    ]);
  });

  it("steps down its ladder: without 'about', then the count alone", () => {
    const s = steps(initialCookState("first"), 5, roast);
    expect(view(s, roast).stretch).toEqual({ left: 4, free: 50 });
    expect(view(s, roast).place).toEqual({
      long: "4 steps, then about 50 min free",
      short: "4 steps, then 50 min free",
      count: "4 steps",
    });
    const beforeBreak = steps(initialCookState("first"), 8, roast);
    expect(view(beforeBreak, roast).place).toEqual({
      long: "this step, then about 50 min free",
      short: "this step, then 50 min free",
      count: "this step",
    });
    const toTable = steps(initialCookState("first"), 9, roast);
    expect(view(toTable, roast).place).toEqual({
      long: "9 steps to the table",
      short: "9 steps to the table",
      count: "9 steps",
    });
    const last = steps(initialCookState("first"), 17, roast);
    expect(view(last, roast).place).toEqual({ long: "last step", short: "last step", count: "last step" });
  });

  it("says 'Prep' on Prep, with no stretch in hand", () => {
    const v = view(initialCookState("first"), roast);
    expect(v.stretch).toBeNull();
    expect(v.place).toEqual({ long: "Prep", short: "Prep", count: "Prep" });
  });

  it("says no place as written", () => {
    const asWritten = identityPlan(ZUCCHINI_RECIPE);
    const v = view(next(asWritten, initialCookState("first")), asWritten, {
      kind: "as-written",
      reason: "pending",
    });
    expect(v.chapters).toBeNull();
    expect(v.stretch).toBeNull();
    expect(v.place).toBeNull();
  });

  it("with no break, counts the steps to the table: tacos", () => {
    const tacos = byName.get("lime-shrimp-tacos")!;
    const onFirst = next(tacos, initialCookState("first"));
    expect(view(onFirst, tacos).place?.long).toBe("3 steps to the table");
    expect(view(steps(onFirst, 2, tacos), tacos).place?.long).toBe("last step");
  });

  it("says 'last step' on a one-step plan", () => {
    const one: CookPlan = { ...plan, tasks: plan.tasks.filter((t) => t.id === "saute") };
    const v = view(initialCookState("first"), one);
    expect(v.screens).toBe(1);
    expect(v.place?.long).toBe("last step");
  });
});

describe("minutesLabel", () => {
  it("reads estimates the way a cook says them", () => {
    expect(minutesLabel(1, false)).toBe("About 1 minute");
    expect(minutesLabel(0.5, false)).toBe("About 1 minute");
    expect(minutesLabel(15, true)).toBe("About 15 minutes, mostly hands-free");
    expect(minutesLabel(90, true)).toBe("About 1½ hours, mostly hands-free");
    expect(minutesLabel(120, false)).toBe("About 2 hours");
  });
});

describe("sourceStepStates", () => {
  const start = initialCookState("first");

  it("marks nothing on the Prep screen before the cook starts", () => {
    expect(sourceStepStates(plan, start)).toEqual({
      current: new Set(),
      done: new Set(),
    });
  });

  it("marks the steps on screen current and the steps passed done", () => {
    // Prep first: prep, sauté (0), fry (2), stir (1), stuff (3), chili (4).
    expect(sourceStepStates(plan, steps(start, 3))).toEqual({
      current: new Set([1]),
      done: new Set([0, 2]),
    });
  });

  it("reopens a step the cook goes back to", () => {
    const s = jumpTo(plan, steps(start, 4), 1);
    expect(sourceStepStates(plan, s)).toEqual({
      current: new Set([0]),
      done: new Set([2, 1]),
    });
  });

  it("holds a step open until every task citing it is done", () => {
    // Slicing the onion is written into the sauté step.
    const cited: CookPlan = {
      ...plan,
      tasks: plan.tasks.map((t) =>
        t.id === "onion" ? { ...t, sourceStep: 0, implied: false } : t,
      ),
    };
    const ticked = toggleTick(cited, start, "onion");
    expect(sourceStepStates(cited, ticked).done).toEqual(new Set());
    const s = steps(initialCookState("first"), 2, cited);
    expect(sourceStepStates(cited, s).done).toEqual(new Set([0]));
  });

  it("marks each step a merged screen cites current", () => {
    // The cake's As I go puts whisking the dry and mixing the wet on one screen.
    const f = loadCookPlanFixtures().find((x) => x.name === "baking-chocolate-cake");
    const raw = f && loadCookPlanSnapshots().get(f.name)?.raw;
    const parsed = f && raw ? parseCookPlan(raw, f.recipe) : null;
    if (!parsed?.ok) throw new Error("no derived cake plan");
    const cake = parsed.plan;
    let s = initialCookState("go");
    const seen: Set<number>[] = [];
    for (let i = 0; i < screensOf(cake, "go", new Set()).length; i++) {
      seen.push(sourceStepStates(cake, s).current);
      s = next(cake, s);
    }
    expect(seen).toContainEqual(new Set([1, 2]));
  });

  it("never marks a step only ahead work cites", () => {
    const soaked: CookPlan = {
      version: plan.version,
      tasks: [
        {
          id: "soak",
          kind: "ahead",
          text: "Soak the beans",
          label: "soak beans",
          ingredientIdx: [],
          sourceStep: 0,
          implied: false,
          needs: [],
          branch: "Beans",
          lead: "overnight",
        },
        {
          id: "simmer",
          kind: "cook",
          text: "Simmer the beans",
          label: "simmer",
          ingredientIdx: [],
          sourceStep: 1,
          implied: false,
          needs: ["soak"],
          branch: "Beans",
        },
      ],
    };
    const s = steps(initialCookState("first"), 1, soaked);
    expect(sourceStepStates(soaked, s)).toEqual({
      current: new Set([1]),
      done: new Set(),
    });
  });
});

describe("aheadFirst", () => {
  function ahead(id: string, extra: Partial<CookTask> = {}): CookTask {
    return {
      id,
      kind: "ahead",
      text: `Do ${id}`,
      label: id,
      ingredientIdx: [],
      sourceStep: null,
      implied: true,
      needs: [],
      branch: "Main",
      ...extra,
    };
  }
  const withTasks = (...tasks: CookTask[]): CookPlan => ({
    version: plan.version,
    tasks,
  });

  it("names the one thing to start ahead, with its lead", () => {
    const p = withTasks(ahead("soak chickpeas", { lead: "the night before" }));
    expect(aheadFirst(p)).toEqual({ label: "soak chickpeas", lead: "the night before" });
  });

  it("leads with the longest wait", () => {
    const p = withTasks(
      ahead("temper chicken", {
        lead: "1 hour before",
        minutes: { est: 60, handsOff: true },
      }),
      ahead("dry-brine chicken", {
        lead: "overnight",
        minutes: { est: 1440, handsOff: true },
      }),
      ahead("grate garlic"),
    );
    expect(aheadFirst(p)).toEqual({ label: "dry-brine chicken", lead: "overnight" });
  });

  it("leaves out a missing lead", () => {
    expect(aheadFirst(withTasks(ahead("chill rice")))).toEqual({ label: "chill rice", lead: null });
  });

  it("names the first thing on the Prep screen, not the longest job", () => {
    // Fix round 1: the card picked the longest estimate, the 2-hour chill,
    // while Prep opened with the butter 3 hours out.
    const { plan: cookies } = derivedCorpus().find((d) => d.name === "chewy-oat-cookies")!;
    expect(aheadFirst(cookies)).toEqual({ label: "soften butter", lead: "at least 3 hours before" });
    // The same plan stored with mixed anchors gives the same card.
    expect(aheadFirst(cookiesMixedAnchors())).toEqual(aheadFirst(cookies));
    // A long job under a short lead doesn't outrank a short one far out.
    const p = withTasks(
      ahead("braise", { lead: "1 hour before", minutes: { est: 180, handsOff: true } }),
      ahead("salt", { lead: "overnight", minutes: { est: 5, handsOff: false } }),
    );
    expect(aheadFirst(p)).toEqual({ label: "salt", lead: "overnight" });
    // In the first group, the longest job is the one named.
    const q = withTasks(
      ahead("zest", { lead: "1 hour before", minutes: { est: 5, handsOff: false } }),
      ahead("steep", { lead: "1 hour before", minutes: { est: 60, handsOff: true } }),
    );
    expect(aheadFirst(q)).toEqual({ label: "steep", lead: "1 hour before" });
  });

  it("gives the lead Prep opens with, over every derived plan", () => {
    for (const { name, plan: p } of derivedCorpus()) {
      const first = cookView(p, DERIVED, initialCookState("first")).prep?.ahead[0];
      const named = aheadFirst(p);
      if (!first) {
        expect(named, name).toBeNull();
        continue;
      }
      expect(named?.lead, name).toBe(first.lead);
      expect(first.labels, name).toContain(named?.label);
    }
  });

  it("says nothing without ahead work or a current plan", () => {
    expect(aheadFirst(plan)).toBeNull();
    expect(aheadFirst(null)).toBeNull();
    expect(aheadFirst(undefined)).toBeNull();
    expect(aheadFirst({ version: 1, tasks: [ahead("soak")] })).toBeNull();
  });
});

describe("askStepText", () => {
  const start = initialCookState("first");

  it("gives Claude the prep still to do while the cook is on Prep", () => {
    const s = toggleTick(plan, toggleTick(plan, start, "onion"), "greens");
    expect(askStepText(view(s))).toBe(
      "Mince the garlic scape; Cut the zucchini into thin matchsticks",
    );
  });

  it("gives nothing on Prep once the prep is all done", () => {
    const s = ["onion", "scape", "zuc", "greens"].reduce(
      (acc, id) => toggleTick(plan, acc, id),
      start,
    );
    expect(askStepText(view(s))).toBeUndefined();
  });

  it("gives the current line on every other screen", () => {
    const s = next(plan, start);
    expect(askStepText(view(s))).toBe(view(s).stack[0].text);
    expect(askStepText(view(s))).toMatch(/^Sauté the onion/);
  });
});

describe("missedAheadQuestion", () => {
  const soak = {
    id: "a1",
    text: "Soak the chickpeas overnight.",
    label: "soak chickpeas",
    lead: "the night before",
  };

  it("asks Claude for a way through, in the cook's words", () => {
    expect(missedAheadQuestion({ lead: soak.lead, items: [soak], labels: ["soak chickpeas"] })).toBe(
      "I was meant to soak chickpeas the night before and didn't. What's the quickest way through?",
    );
  });

  it("says ahead when the plan gives no lead", () => {
    const rice = { id: "a1", text: "Chill the rice.", label: "chill rice", lead: null };
    expect(missedAheadQuestion({ lead: null, items: [rice], labels: ["chill rice"] })).toBe(
      "I was meant to chill rice ahead and didn't. What's the quickest way through?",
    );
  });

  it("lists every task in a group", () => {
    const brine = { ...soak, id: "a2", label: "brine the chicken" };
    expect(missedAheadQuestion({
        lead: soak.lead,
        items: [soak, brine],
        labels: ["soak chickpeas", "brine the chicken"],
      })).toBe(
      "I was meant to do these the night before and didn't: soak chickpeas; brine the chicken. What's the quickest way through?",
    );
  });
});

describe("bindNumbers", () => {
  const NB = "\u00a0";

  it("keeps a number on the line with the word after it", () => {
    expect(bindNumbers("Soften 1 cup (225 g) butter for 1 ½ hours")).toBe(
      `Soften 1${NB}cup (225${NB}g) butter for 1${NB}½${NB}hours`,
    );
    expect(bindNumbers("Chill 8 to 10 hours.")).toBe(`Chill 8${NB}to 10${NB}hours.`);
  });

  it("leaves text without numbers, and a number ending the text, alone", () => {
    expect(bindNumbers("Stir well")).toBe("Stir well");
    expect(bindNumbers("Serves 4 ")).toBe("Serves 4 ");
  });
});
