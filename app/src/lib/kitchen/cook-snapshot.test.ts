import { describe, expect, it } from "vitest";
import { ZUCCHINI_PLAN } from "./__tests__/zucchini-wraps";
import { identityPlan } from "./cook-plan";
import { reduceSession, startSession, type CookSession } from "./cook-session";
import { cookSnapshot, layerChanges, type CookLayers, type SnapshotInputs } from "./cook-snapshot";
import { ZUCCHINI_RECIPE } from "./__tests__/zucchini-wraps";

// What the cook screen hands a flag (B2 decision 5): the screen in hand or
// the one that borrowed it, the step and chapter under it, and the session's
// committed state as plain data.

const CLOSED: CookLayers = {
  allSteps: false,
  ingredients: false,
  info: false,
  wholeCook: false,
  pane: false,
  card: null,
  more: false,
};

function inputs(session: CookSession, overrides?: Partial<SnapshotInputs>): SnapshotInputs {
  return {
    queueId: "4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
    recipeName: "Zucchini wraps",
    session,
    layers: CLOSED,
    part: null,
    voice: { mode: "always", status: "listening" },
    ask: { sessionId: "cook-queue-1770000000000", open: false },
    ...overrides,
  };
}

/** The Prep screen: As I go's, since Prep first walks prep pages (DS v1.59). */
const onPrep = () => startSession(ZUCCHINI_PLAN, { kind: "derived" }, "go");
/** Prep first opens on the first of its two prep pages: the sauté jobs as tick rows, then the greens. */
const onPage = () => startSession(ZUCCHINI_PLAN, { kind: "derived" }, "first");
/** Prep first, past both prep pages, on the first cooking step. */
const onSaute = () => {
  let session = reduceSession(onPage(), { type: "next" });
  session = reduceSession(session, { type: "next" });
  return session;
};

describe("cookSnapshot", () => {
  it("names Prep, its chapter, and the plan with its version", () => {
    const snap = cookSnapshot(inputs(onPrep()));
    expect(snap).toMatchObject({
      queueId: "4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
      recipeName: "Zucchini wraps",
      screen: "prep",
      stepKey: "prep",
      chapterId: "prep",
      planVersion: 4,
      part: null,
    });
    expect(snap.plan).toBe(ZUCCHINI_PLAN);
  });

  it("names a prep page as a step, in the Prep chapter", () => {
    expect(cookSnapshot(inputs(onPage()))).toMatchObject({
      screen: "step",
      stepKey: "onion+scape+zuc",
      chapterId: "prep",
    });
    expect(cookSnapshot(inputs(reduceSession(onPage(), { type: "next" })))).toMatchObject({
      screen: "step",
      stepKey: "greens",
      chapterId: "prep",
    });
  });

  it("names the step in hand by its key, and the chapter it is in", () => {
    const session = reduceSession(onSaute(), { type: "next" });
    const snap = cookSnapshot(inputs(session, { part: { at: 2, of: 3 } }));
    expect(snap).toMatchObject({
      screen: "step",
      stepKey: "fry",
      chapterId: "stretch:saute",
      part: { at: 2, of: 3 },
    });
  });

  it("gives the panel's row the step in hand, counted without the Prep screen, and none on it (C3)", () => {
    expect(cookSnapshot(inputs(onPrep())).step).toBeNull();
    // As I go: the Prep screen is not counted; the six steps after it are.
    expect(cookSnapshot(inputs(reduceSession(onPrep(), { type: "next" }))).step).toMatchObject({ n: 1, of: 6, name: "Sauté" });
    // Prep first: its prep pages are steps, and are counted (DS v1.59).
    expect(cookSnapshot(inputs(onPage())).step).toMatchObject({
      n: 1,
      of: 7,
      name: "Slice onion, mince scape, and cut zucchini",
    });
    let session = onSaute();
    expect(cookSnapshot(inputs(session)).step).toMatchObject({ n: 3, of: 7, name: "Sauté" });
    session = reduceSession(session, { type: "next" });
    expect(cookSnapshot(inputs(session)).step).toMatchObject({ n: 4, of: 7, name: "Fry parathas" });
    // A borrowed screen keeps the step under it.
    expect(
      cookSnapshot(inputs(session, { layers: { ...CLOSED, ingredients: true } })).step?.n,
    ).toBe(4);
  });

  it("keeps the line the step screen drew, lead and all, for the row to quote (panel round 4)", () => {
    let session = onSaute();
    expect(cookSnapshot(inputs(session)).step?.line).toBe(
      "Sauté the onion, garlic scape and zucchini with a pinch of cumin until sweet and caramelized, about 15 minutes.",
    );
    session = reduceSession(session, { type: "next" });
    expect(cookSnapshot(inputs(session)).step?.line).toBe(
      "Meanwhile, fry the parathas in a dry skillet until crisp and flaky.",
    );
  });

  it("names a recipe as written's step by its text", () => {
    const asWritten = identityPlan(ZUCCHINI_RECIPE);
    const session = startSession(asWritten, { kind: "as-written", reason: "failed" }, "first");
    expect(cookSnapshot(inputs(session)).step).toMatchObject({
      n: 1,
      of: 5,
      name: "Sauté the onion, garlic scape and zucchini with a pinch of cumin until sweet and caramelized, about 15 minutes.",
    });
  });

  it("gives the session's state as plain lists", () => {
    let session = reduceSession(onPage(), { type: "tick", id: "onion" });
    session = reduceSession(session, { type: "next" });
    const { state } = cookSnapshot(inputs(session));
    expect(state.mode).toBe("first");
    expect(state.pos).toBe(1);
    expect(state.ticked).toEqual(["onion"]);
    expect(state.ticked).toEqual([...session.state.ticked]);
    expect(state.passed).toEqual([...session.state.passed]);
    expect(state.kept).toEqual([...session.state.kept]);
    expect(Array.isArray(state.ticked)).toBe(true);
  });

  it("names a borrowed screen over the step, which it still keys", () => {
    const session = onSaute();
    for (const [layer, screen] of [
      ["allSteps", "all-steps"],
      ["ingredients", "ingredients"],
      ["info", "info"],
      ["wholeCook", "whole-cook"],
    ] as const) {
      const snap = cookSnapshot(inputs(session, { layers: { ...CLOSED, [layer]: true } }));
      expect(snap.screen).toBe(screen);
      expect(snap.stepKey).toBe("saute");
    }
  });

  it("carries the pane, a card and More's menu as they are", () => {
    const snap = cookSnapshot(
      inputs(onPrep(), { layers: { ...CLOSED, pane: true, card: "pane", more: true } }),
    );
    expect(snap.layers).toEqual({ pane: true, card: "pane", more: true });
  });

  it("has no chapter on a cook too short to show chapters", () => {
    const asWritten = identityPlan(ZUCCHINI_RECIPE);
    const session = startSession(asWritten, { kind: "as-written", reason: "failed" }, "first");
    const snap = cookSnapshot(inputs(session));
    expect(snap.screen).toBe("step");
    expect(snap.planVersion).toBe(asWritten.version);
    expect(snap.chapterId).toBeNull();
  });
});

// The `layer` events of a flag's lead-up (B2 decision 9): a borrowed screen,
// the pane or a card, opening or closing. More's menu is not a layer here: a
// flag by touch always opens it.
describe("layerChanges", () => {
  it("names nothing when nothing moved", () => {
    expect(layerChanges(CLOSED, { ...CLOSED })).toEqual([]);
    expect(layerChanges(CLOSED, { ...CLOSED, more: true })).toEqual([]);
  });

  it("names each borrowed screen as it opens and closes", () => {
    expect(layerChanges(CLOSED, { ...CLOSED, allSteps: true })).toEqual(["all-steps open"]);
    expect(layerChanges({ ...CLOSED, allSteps: true }, { ...CLOSED, ingredients: true })).toEqual([
      "all-steps close",
      "ingredients open",
    ]);
    expect(layerChanges({ ...CLOSED, info: true }, CLOSED)).toEqual(["info close"]);
    expect(layerChanges(CLOSED, { ...CLOSED, wholeCook: true })).toEqual(["whole-cook open"]);
  });

  it("names the pane, and a card with the surface it is on", () => {
    expect(layerChanges(CLOSED, { ...CLOSED, pane: true })).toEqual(["pane open"]);
    const pane = { ...CLOSED, pane: true };
    expect(layerChanges(pane, { ...pane, card: "pane" })).toEqual(["card open (pane)"]);
    expect(layerChanges({ ...pane, card: "pane" }, CLOSED)).toEqual([
      "pane close",
      "card close (pane)",
    ]);
    expect(
      layerChanges({ ...CLOSED, wholeCook: true, card: "screen" }, { ...pane, card: "pane" }),
    ).toEqual(["whole-cook close", "pane open", "card close (screen)", "card open (pane)"]);
  });

  it("names look-ahead transitions by N2's depths and read open/close (Step 15, N13, N2-9)", () => {
    expect(
      layerChanges(
        { ...CLOSED, level: 0 },
        { ...CLOSED, level: 1 },
      ),
    ).toEqual(["look-ahead now → until you can step away"]);

    expect(
      layerChanges(
        { ...CLOSED, level: 1 },
        { ...CLOSED, level: 2 },
      ),
    ).toEqual(["look-ahead until you can step away → whole cook"]);

    expect(
      layerChanges(
        { ...CLOSED, level: 2 },
        { ...CLOSED, level: 3 },
      ),
    ).toEqual(["look-ahead whole cook → whole recipe"]);

    expect(
      layerChanges(
        { ...CLOSED, level: 2, read: false },
        { ...CLOSED, level: 2, read: true },
      ),
    ).toEqual(["read open"]);

    expect(
      layerChanges(
        { ...CLOSED, level: 2, read: true },
        { ...CLOSED, level: 2, read: false },
      ),
    ).toEqual(["read close"]);
  });

  it("returns whole-cook screen when level is 3 (Step 15, N13)", () => {
    const session = reduceSession(onPrep(), { type: "next" });
    const snap = cookSnapshot(inputs(session, { layers: { ...CLOSED, level: 3 } }));
    expect(snap.screen).toBe("whole-cook");
    expect(snap.layers.level).toBe(3);
  });
});
