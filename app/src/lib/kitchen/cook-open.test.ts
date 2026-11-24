import { describe, expect, it } from "vitest";
import { readQueueRecipe } from "@/lib/pack-convert/queue-recipe";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { cookNotice, openCook, OPEN_COPY, type QueueRead } from "./cook-open";
import {
  effectiveServings,
  initialSessionFor,
  loadSession,
  recipeFingerprint,
  reduceSession,
  saveSession,
  startSession,
  type StoredSession,
} from "./cook-session";
import { storedIngredientLines } from "./ingredient-display";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE } from "./__tests__/zucchini-wraps";

// The cook page's open (slice B5b): which of the fetched recipe, the kept
// session and its snapshot it draws, and what it says.

const recipeData = { name: "Sweet Zucchini Wraps", serves: 4, ...ZUCCHINI_RECIPE } as KitchenQueueRecipeData;
const packRecipe = readQueueRecipe({ id: "q1", recipeData }).packRecipe!;
const ITEM = { recipeData, packRecipe, cookPlan: ZUCCHINI_PLAN, servesEstimate: null, servesEstimateBasis: null };

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

/** A session kept for the recipe as it was when `forRecipe` was stored. */
function kept(forRecipe: KitchenQueueRecipeData = recipeData): StoredSession {
  const store = memory();
  const session = reduceSession(startSession(ZUCCHINI_PLAN, { kind: "derived" }, "first"), { type: "next" });
  saveSession(
    "q1",
    recipeFingerprint({ recipeData: forRecipe }),
    session,
    { recipeData: forRecipe, packRecipe, cookPlan: ZUCCHINI_PLAN },
    1,
    store,
  );
  return loadSession("q1", store)!;
}

const loading: QueueRead = { isLoading: true, paused: false, failures: 0, item: undefined, error: null };
const loaded: QueueRead = { isLoading: false, paused: false, failures: 0, item: ITEM, error: null };
const offline: QueueRead = { isLoading: true, paused: true, failures: 0, item: undefined, error: null };
const failed: QueueRead = {
  isLoading: false,
  paused: false,
  failures: 4,
  item: undefined,
  error: { data: null },
};

describe("openCook with a pack row read natively (B5d D6)", () => {
  const library = { states: [{ id: "state:x", name: "X" }], commons: [] };
  const native: QueueRead = { ...loaded, item: { ...ITEM, reading: "native", library } };

  it("carries the library to the cook, and an empty one for any other row", () => {
    const open = openCook(native, null, null);
    expect(open.kind === "cook" && open.from === "live" && open.library).toEqual(library);
    const other = openCook(loaded, null, null);
    expect(other.kind === "cook" && other.from === "live" && other.library).toEqual({ states: [], commons: [] });
  });

  it("starts over with the note a session kept on the projection, before B5d", () => {
    const open = openCook(native, kept(), null);
    expect(open.kind === "cook" && open.from === "live" && open.start).toEqual({ kind: "changed" });
  });

  it("resumes a session kept on the same native reading", () => {
    const fingerprint = recipeFingerprint(native.item!);
    const open = openCook(native, { ...kept(), fingerprint }, null);
    expect(open.kind === "cook" && open.from === "live" && open.start.kind).toBe("resume");
  });

  it("passes scales through on live opens, and defaults missing scales to false (B5c-13)", () => {
    const withTrue = openCook({ ...loaded, item: { ...ITEM, scales: true } }, null, null);
    expect(withTrue.kind === "cook" && withTrue.from === "live" && withTrue.scales).toBe(true);
    const withFalse = openCook({ ...loaded, item: { ...ITEM, scales: false } }, null, null);
    expect(withFalse.kind === "cook" && withFalse.from === "live" && withFalse.scales).toBe(false);
    const withMissing = openCook(loaded, null, null);
    expect(withMissing.kind === "cook" && withMissing.from === "live" && withMissing.scales).toBe(false);
  });
});

describe("openCook", () => {
  it("waits for the tablet's storage before deciding (the first render matches the server's)", () => {
    expect(openCook(loaded, undefined, null)).toEqual({ kind: "wait" });
  });

  it("waits while the first fetch is in flight", () => {
    expect(openCook(loading, null, null)).toEqual({ kind: "wait" });
    expect(openCook(loading, kept(), null)).toEqual({ kind: "wait" });
  });

  it("a fetched recipe with nothing kept starts fresh", () => {
    const open = openCook(loaded, null, null);
    expect(open).toMatchObject({ kind: "cook", from: "live", start: { kind: "none" } });
  });

  it("resumes a session kept for the same stored recipe", () => {
    const open = openCook(loaded, kept(), null);
    expect(open).toMatchObject({ kind: "cook", from: "live", start: { kind: "resume" } });
  });

  it("discards a session kept for a recipe that has changed since", () => {
    const edited = { ...recipeData, steps: [...recipeData.steps!, "Serve warm."] };
    const open = openCook(loaded, kept(edited), null);
    expect(open).toMatchObject({ kind: "cook", from: "live", start: { kind: "changed" } });
  });

  it("offline with a kept session draws its snapshot at once, without waiting on the paused query", () => {
    const stored = kept();
    expect(openCook(offline, stored, null)).toEqual({ kind: "cook", from: "snapshot", stored });
  });

  it("a failed fetch with a kept session draws its snapshot too", () => {
    const stored = kept();
    expect(openCook(failed, stored, null)).toEqual({ kind: "cook", from: "snapshot", stored });
  });

  it("a first failed try with a kept session draws its snapshot, without waiting out the retries", () => {
    const stored = kept();
    expect(openCook({ ...loading, failures: 1 }, stored, null)).toEqual({ kind: "cook", from: "snapshot", stored });
    // With nothing kept it waits for the retries, as today.
    expect(openCook({ ...loading, failures: 1 }, null, null)).toEqual({ kind: "wait" });
  });

  it("stays on the snapshot once drawn from it, when the connection comes back", () => {
    const stored = kept();
    expect(openCook(loaded, stored, "snapshot")).toEqual({ kind: "cook", from: "snapshot", stored });
  });

  it("offline with nothing kept: the error screen, for offline", () => {
    expect(openCook(offline, null, null)).toEqual({ kind: "fail", code: "OFFLINE" });
  });

  it("online failures keep today's codes", () => {
    expect(openCook({ ...loaded, item: null }, null, null)).toEqual({ kind: "fail", code: "NOT_FOUND" });
    expect(openCook({ ...failed, error: { data: { code: "BAD_REQUEST" } } }, null, null)).toEqual({
      kind: "fail",
      code: "BAD_REQUEST",
    });
    expect(
      openCook({ ...loaded, item: { ...ITEM, packRecipe: null, conversionError: "x" } }, null, null),
    ).toEqual({ kind: "fail", code: "UNREADABLE" });
  });

  it("a removed item with a kept session online is not found (its session is then removed)", () => {
    expect(openCook({ ...loaded, item: null }, kept(), null)).toEqual({ kind: "fail", code: "NOT_FOUND" });
  });
});

// Cook-fidelity plan: the page asks for intake before it opens an item still
// waiting for it, so the cook never meets the recipe as sent and then the cut.
describe("openCook and intake", () => {
  const withIntake = (state: "none" | "pending" | "normalized" | "as-sent"): QueueRead => ({
    ...loaded,
    item: { ...ITEM, intake: { state, error: state === "as-sent" ? "quota exceeded" : null } },
  });
  const live = (open: ReturnType<typeof openCook>) =>
    open.kind === "cook" && open.from === "live" ? { shownAsSent: open.shownAsSent, plans: open.plans } : open;

  it("waits on an item still waiting for intake until the page has asked, with nothing kept", () => {
    expect(openCook(withIntake("pending"), null, null)).toEqual({ kind: "wait" });
  });

  it("a cook already under way (a session kept) never waits on intake: it goes on as sent, with no plan", () => {
    const open = openCook(withIntake("pending"), kept(), null);
    expect(live(open)).toEqual({ shownAsSent: true, plans: false });
    expect(open.kind === "cook" && open.from === "live" && open.start.kind).toBe("resume");
  });

  it("a cut landing under a cook started on the recipe as sent: the cook stays on what it started, from its snapshot", () => {
    const stored = { ...kept(), snapshot: { ...kept().snapshot, shownAsSent: true } };
    const cut: QueueRead = {
      ...loaded,
      item: { ...ITEM, recipeData: { ...recipeData, steps: [...recipeData.steps!, "Serve warm."] }, intake: { state: "normalized", error: null } },
    };
    expect(openCook(cut, stored, null)).toEqual({ kind: "cook", from: "snapshot", stored });
  });

  it("the ask's own answer decides, not a re-read: a cut answered while the read still says waiting opens the cut", () => {
    const cutRecipe = { ...recipeData, name: "Sweet Zucchini Wraps (cut)" };
    const answer = { ...ITEM, recipeData: cutRecipe, intake: { state: "normalized" as const, error: null } };
    const open = openCook(withIntake("pending"), null, null, { intakeAsked: true, intakeAnswer: answer });
    expect(live(open)).toEqual({ shownAsSent: false, plans: true });
    expect(open.kind === "cook" && open.from === "live" && open.recipe.name).toBe("Sweet Zucchini Wraps (cut)");
  });

  it("still waiting after the ask (it failed): cooks as sent, said so, and takes no plan", () => {
    expect(live(openCook(withIntake("pending"), null, null, { intakeAsked: true }))).toEqual({
      shownAsSent: true,
      plans: false,
    });
  });

  it("a cut, or a row never sent for cutting: opens at once, plans as usual", () => {
    for (const state of ["normalized", "none"] as const) {
      expect(live(openCook(withIntake(state), null, null))).toEqual({ shownAsSent: false, plans: true });
    }
    expect(live(openCook(loaded, null, null))).toEqual({ shownAsSent: false, plans: true });
  });

  it("an intake that failed: opens at once as sent, said so, plans as usual", () => {
    expect(live(openCook(withIntake("as-sent"), null, null))).toEqual({ shownAsSent: true, plans: true });
  });

  it("offline with a kept session still draws the snapshot: nothing to ask", () => {
    const stored = kept();
    expect(openCook(offline, stored, null)).toEqual({ kind: "cook", from: "snapshot", stored });
  });
});

describe("cookNotice", () => {
  const base = { changed: false, moved: false, fromSnapshot: false, online: true };

  it("says nothing on an ordinary open or resume", () => {
    expect(cookNotice(base)).toBeNull();
  });

  it("says the recipe changed until the first move", () => {
    expect(cookNotice({ ...base, changed: true })).toBe(OPEN_COPY.changed);
    expect(cookNotice({ ...base, changed: true, moved: true })).toBeNull();
  });

  it("says Offline while a snapshot cook is offline, and nothing once back", () => {
    expect(cookNotice({ ...base, fromSnapshot: true, online: false })).toBe(OPEN_COPY.offline);
    expect(cookNotice({ ...base, fromSnapshot: true, online: true })).toBeNull();
  });
});

describe("openCook snapshot scaling and count lock (B5c-5, B5c-13)", () => {
  it("snapshot open at 8 (native pack row) draws at 8 under read.paused and latched: 'snapshot'", () => {
    const store = memory();
    const library = { states: [{ id: "state:x", name: "X" }], commons: [] };
    let session = reduceSession(startSession(ZUCCHINI_PLAN, { kind: "derived" }, "first"), { type: "next" });
    session = reduceSession(session, { type: "servings", servings: 8 });
    saveSession(
      "q1",
      recipeFingerprint({ recipeData, packRecipe, reading: "native" }),
      session,
      { recipeData, packRecipe, cookPlan: ZUCCHINI_PLAN, library, scales: true },
      1,
      store,
    );
    const stored = loadSession("q1", store)!;
    const pausedOpen = openCook(offline, stored, null);
    expect(pausedOpen).toEqual({ kind: "cook", from: "snapshot", stored });
    if (pausedOpen.kind === "cook" && pausedOpen.from === "snapshot") {
      const scales = pausedOpen.stored.snapshot.scales === true;
      const eff = effectiveServings(pausedOpen.stored.snapshot.packRecipe, pausedOpen.stored.session, scales);
      expect(scales).toBe(true);
      expect(eff).toBe(8);
      const lines = storedIngredientLines(
        pausedOpen.stored.snapshot.packRecipe,
        pausedOpen.stored.snapshot.recipeData.ingredients?.length ?? 0,
        eff,
      );
      expect(lines[0]).toMatchObject({ kind: "count", amount: "4", name: "zucchini" });
    }

    const latchedOpen = openCook(loaded, stored, "snapshot");
    expect(latchedOpen).toEqual({ kind: "cook", from: "snapshot", stored });
  });

  it("snapshot open at 8 (household row) draws at 8 under read.paused and latched: 'snapshot'", () => {
    const store = memory();
    let session = reduceSession(startSession(ZUCCHINI_PLAN, { kind: "derived" }, "first"), { type: "next" });
    session = reduceSession(session, { type: "servings", servings: 8 });
    saveSession(
      "q1",
      recipeFingerprint({ recipeData }),
      session,
      { recipeData, packRecipe, cookPlan: ZUCCHINI_PLAN, scales: true },
      1,
      store,
    );
    const stored = loadSession("q1", store)!;
    const pausedOpen = openCook(offline, stored, null);
    expect(pausedOpen).toEqual({ kind: "cook", from: "snapshot", stored });
    if (pausedOpen.kind === "cook" && pausedOpen.from === "snapshot") {
      const scales = pausedOpen.stored.snapshot.scales === true;
      const eff = effectiveServings(pausedOpen.stored.snapshot.packRecipe, pausedOpen.stored.session, scales);
      expect(scales).toBe(true);
      expect(eff).toBe(8);
    }

    const latchedOpen = openCook(loaded, stored, "snapshot");
    expect(latchedOpen).toEqual({ kind: "cook", from: "snapshot", stored });
  });

  it("snapshot open of a degraded pack row stays locked at the recipe's count (scales: false)", () => {
    const store = memory();
    let session = reduceSession(startSession(ZUCCHINI_PLAN, { kind: "derived" }, "first"), { type: "next" });
    session = reduceSession(session, { type: "servings", servings: 8 });
    saveSession(
      "q1",
      recipeFingerprint({ recipeData }),
      session,
      { recipeData, packRecipe, cookPlan: ZUCCHINI_PLAN, scales: false },
      1,
      store,
    );
    const stored = loadSession("q1", store)!;
    const pausedOpen = openCook(offline, stored, null);
    expect(pausedOpen).toEqual({ kind: "cook", from: "snapshot", stored });
    if (pausedOpen.kind === "cook" && pausedOpen.from === "snapshot") {
      const scales = pausedOpen.stored.snapshot.scales === true;
      expect(scales).toBe(false);
      expect(effectiveServings(pausedOpen.stored.snapshot.packRecipe, pausedOpen.stored.session, scales)).toBe(4);
    }

    // Offline tick on a degraded row keeps scales: false across reload
    const nextSession = reduceSession(stored.session, { type: "tick", id: "onion" });
    saveSession(
      "q1",
      stored.fingerprint,
      nextSession,
      {
        recipeData: stored.snapshot.recipeData,
        packRecipe: stored.snapshot.packRecipe,
        cookPlan: stored.snapshot.cookPlan,
        scales: stored.snapshot.scales === true,
      },
      1,
      store,
    );
    const reloaded = loadSession("q1", store)!;
    expect(reloaded.snapshot.scales).toBe(false);
  });

  it("snapshot stored before B5c (no scales, no servings) opens locked at the recipe's count, then unlocks on a later live open", () => {
    const store = memory();
    const session = reduceSession(startSession(ZUCCHINI_PLAN, { kind: "derived" }, "first"), { type: "next" });
    saveSession("q1", recipeFingerprint({ recipeData }), session, { recipeData, packRecipe, cookPlan: ZUCCHINI_PLAN }, 1, store);
    const stored = loadSession("q1", store)!;
    expect(stored.snapshot.scales).toBeUndefined();

    // Offline snapshot open: locked for the rest of that page load (latched)
    const snapOpen = openCook(offline, stored, null);
    expect(snapOpen).toEqual({ kind: "cook", from: "snapshot", stored });
    if (snapOpen.kind === "cook" && snapOpen.from === "snapshot") {
      const scales = snapOpen.stored.snapshot.scales === true;
      expect(scales).toBe(false);
      expect(effectiveServings(snapOpen.stored.snapshot.packRecipe, snapOpen.stored.session, scales)).toBe(4);
    }
    const latchedOpen = openCook({ ...loaded, item: { ...ITEM, scales: true } }, stored, "snapshot");
    expect(latchedOpen).toEqual({ kind: "cook", from: "snapshot", stored });

    // Later live open unlocks it, and its first save writes the flag
    const liveOpen = openCook({ ...loaded, item: { ...ITEM, scales: true } }, stored, null);
    expect(liveOpen).toMatchObject({ kind: "cook", from: "live", scales: true, start: { kind: "resume" } });
    saveSession(
      "q1",
      recipeFingerprint({ recipeData }),
      stored.session,
      { recipeData, packRecipe, cookPlan: ZUCCHINI_PLAN, scales: true },
      1,
      store,
    );
    expect(loadSession("q1", store)?.snapshot.scales).toBe(true);
  });

  it("offline at 8, tick, reload still offline: keep saves snapshot with scales: true and reload draws at 8", () => {
    const store = memory();
    // Prep first, on its first prep page (the sauté jobs as tick rows, DS v1.59): one row ticked is progress to keep.
    let session = reduceSession(startSession(ZUCCHINI_PLAN, { kind: "derived" }, "first"), { type: "tick", id: "scape" });
    session = reduceSession(session, { type: "servings", servings: 8 });
    saveSession(
      "q1",
      recipeFingerprint({ recipeData }),
      session,
      { recipeData, packRecipe, cookPlan: ZUCCHINI_PLAN, scales: true },
      1,
      store,
    );
    const firstOffline = openCook(offline, loadSession("q1", store)!, null);
    expect(firstOffline.kind === "cook" && firstOffline.from === "snapshot").toBe(true);
    if (firstOffline.kind === "cook" && firstOffline.from === "snapshot") {
      const viewScales = firstOffline.stored.snapshot.scales === true;
      const ticked = reduceSession(firstOffline.stored.session, { type: "tick", id: "onion" });
      saveSession(
        "q1",
        firstOffline.stored.fingerprint,
        ticked,
        {
          recipeData: firstOffline.stored.snapshot.recipeData,
          packRecipe: firstOffline.stored.snapshot.packRecipe,
          cookPlan: firstOffline.stored.snapshot.cookPlan,
          scales: viewScales,
        },
        1,
        store,
      );
    }
    const secondOffline = openCook(offline, loadSession("q1", store)!, null);
    expect(secondOffline.kind === "cook" && secondOffline.from === "snapshot").toBe(true);
    if (secondOffline.kind === "cook" && secondOffline.from === "snapshot") {
      const scales = secondOffline.stored.snapshot.scales === true;
      expect(scales).toBe(true);
      expect(effectiveServings(secondOffline.stored.snapshot.packRecipe, secondOffline.stored.session, scales)).toBe(8);
      expect(secondOffline.stored.session.state.ticked.has("onion")).toBe(true);
    }
  });

  it("out-of-range servings in stored session drops only the count on both live and snapshot opens (read.paused and latched: 'snapshot')", () => {
    const store = memory();
    // A row ticked on the first prep page, then on to the next (DS v1.59).
    let session = reduceSession(startSession(ZUCCHINI_PLAN, { kind: "derived" }, "first"), { type: "tick", id: "onion" });
    session = reduceSession(session, { type: "next" });
    session = reduceSession(session, { type: "servings", servings: 8 });
    saveSession(
      "q1",
      recipeFingerprint({ recipeData }),
      session,
      { recipeData, packRecipe, cookPlan: ZUCCHINI_PLAN, scales: true },
      1,
      store,
    );
    // Tamper stored servings out of range (> 4 * 4 = 16)
    const raw = JSON.parse(store.getItem("sous-cook:q1")!);
    raw.state.session.servings = 99;
    store.setItem("sous-cook:q1", JSON.stringify(raw));

    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const stored = loadSession("q1", store)!;
      expect(stored.session.servings).toBeUndefined();
      expect(stored.session.state.ticked.has("onion")).toBe(true);
      expect(warnings.length).toBe(1);

      // Live open: resumes progress at base count (4)
      const liveOpen = openCook({ ...loaded, item: { ...ITEM, scales: true } }, stored, null);
      expect(liveOpen).toMatchObject({ kind: "cook", from: "live", start: { kind: "resume" } });
      if (liveOpen.kind === "cook" && liveOpen.from === "live") {
        const init = initialSessionFor({
          id: "q1",
          recipe: ZUCCHINI_RECIPE,
          packRecipe,
          storedPlan: ZUCCHINI_PLAN,
          fingerprint: recipeFingerprint({ recipeData }),
          start: liveOpen.start,
          mode: "first",
        });
        expect(effectiveServings(packRecipe, init, liveOpen.scales)).toBe(4);
        expect(init.state.ticked.has("onion")).toBe(true);
      }

      // Snapshot open under read.paused: resumes progress at base count (4)
      const pausedOpen = openCook(offline, stored, null);
      expect(pausedOpen).toEqual({ kind: "cook", from: "snapshot", stored });
      if (pausedOpen.kind === "cook" && pausedOpen.from === "snapshot") {
        const scales = pausedOpen.stored.snapshot.scales === true;
        expect(effectiveServings(pausedOpen.stored.snapshot.packRecipe, pausedOpen.stored.session, scales)).toBe(4);
        expect(pausedOpen.stored.session.state.ticked.has("onion")).toBe(true);
      }

      // Snapshot open under latched: "snapshot": resumes progress at base count (4)
      const latchedOpen = openCook(loaded, stored, "snapshot");
      expect(latchedOpen).toEqual({ kind: "cook", from: "snapshot", stored });
      if (latchedOpen.kind === "cook" && latchedOpen.from === "snapshot") {
        const scales = latchedOpen.stored.snapshot.scales === true;
        expect(effectiveServings(latchedOpen.stored.snapshot.packRecipe, latchedOpen.stored.session, scales)).toBe(4);
      }
    } finally {
      console.warn = warn;
    }
  });
});

