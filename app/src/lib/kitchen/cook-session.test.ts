import { beforeEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { parseCommonsFile, parseRecipe, parseStatesFile } from "@sous/pack";
import { EMPTY_LIBRARY } from "../pack-convert/recipe-library";
import { COOK_PLAN_VERSION, identityPlan, type CookPlan } from "./cook-plan";
import { COOK_COPY, cookView, goToMark, next, prepPages, screensOf, type CookState, type PlanSource } from "./cook-view";
import { flow } from "./cook-schedule";
import {
  effectiveServings,
  initialSessionFor,
  isValidServings,
  loadSession,
  loadTabServings,
  pruneSessions,
  recipeFingerprint,
  reduceSession,
  removeSession,
  removeTabServings,
  resolvePlan,
  resumeFor,
  saveSession,
  saveTabServings,
  sessionKey,
  SESSION_PREFIX,
  SESSION_RESET_COPY,
  SESSION_VERSION,
  startSession,
  steppingCounts,
  tabScaleKey,
  type CookSession,
  type CookSnapshot,
} from "./cook-session";
import { consumeCorruptionNotices, readStored } from "@/lib/persist/safe-storage";
import { readQueueRecipe } from "@/lib/pack-convert/queue-recipe";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE } from "./__tests__/zucchini-wraps";

const PENDING: PlanSource = { kind: "as-written", reason: "pending" };
const FAILED: PlanSource = { kind: "as-written", reason: "failed" };
const DERIVED: PlanSource = { kind: "derived" };

const asWritten = () => identityPlan(ZUCCHINI_RECIPE);

function offer(session: CookSession, plan: CookPlan, source: PlanSource) {
  return reduceSession(session, { type: "offer", plan, source });
}

describe("a plan arriving mid-session", () => {
  it("applies while the cook is still on the first screen", () => {
    const s = offer(startSession(asWritten(), PENDING, "go"), ZUCCHINI_PLAN, DERIVED);
    expect(s.plan).toBe(ZUCCHINI_PLAN);
    expect(s.source).toEqual(DERIVED);
    expect(s.state).toMatchObject({ mode: "go", pos: 0 });
    expect(cookView(s.plan, s.source, s.state).onPrep).toBe(true);
  });

  it("waits for the next open once the cook has moved on, and says so", () => {
    const moved = reduceSession(startSession(asWritten(), PENDING, "first"), {
      type: "next",
    });
    const s = offer(moved, ZUCCHINI_PLAN, DERIVED);
    expect(s.plan).toBe(moved.plan);
    expect(s.state).toBe(moved.state);
    expect(s.source).toEqual({ kind: "as-written", reason: "later" });
    const back = reduceSession(s, { type: "back" });
    expect(cookView(back.plan, back.source, back.state).note).toBe(COOK_COPY.later);
  });

  it("still waits after the cook comes back to the first screen", () => {
    let s = startSession(asWritten(), PENDING, "first");
    s = reduceSession(s, { type: "next" });
    s = reduceSession(s, { type: "back" });
    expect(s.state.pos).toBe(0);
    expect(offer(s, ZUCCHINI_PLAN, DERIVED).plan).toBe(s.plan);
  });

  it("keeps the mode the cook picked on the first screen", () => {
    let s = startSession(ZUCCHINI_PLAN, DERIVED, "first");
    s = reduceSession(s, { type: "mode", mode: "go" });
    const other = { ...ZUCCHINI_PLAN, tasks: ZUCCHINI_PLAN.tasks.slice(0, -1) };
    const swapped = offer(s, other, DERIVED);
    expect(swapped.plan).toBe(other);
    expect(swapped.state.mode).toBe("go");
  });

  it("says the derivation failed, even after the cook has moved on", () => {
    let s = startSession(asWritten(), PENDING, "first");
    s = reduceSession(s, { type: "next" });
    s = offer(s, asWritten(), FAILED);
    expect(s.source).toEqual(FAILED);
    expect(s.state.pos).toBe(1);
  });

  it("keeps the cook's place when the same plan is offered again", () => {
    let s = startSession(ZUCCHINI_PLAN, DERIVED, "first");
    s = reduceSession(s, { type: "tick", id: "onion" });
    const again = offer(s, structuredClone(ZUCCHINI_PLAN), { kind: "derived" });
    expect(again).toBe(s);
  });

  it("keeps the ticks when a different plan arrives after ticking on Prep", () => {
    let s = startSession(ZUCCHINI_PLAN, DERIVED, "first");
    s = reduceSession(s, { type: "tick", id: "onion" });
    const other: CookPlan = { ...ZUCCHINI_PLAN, tasks: ZUCCHINI_PLAN.tasks.slice() };
    other.tasks[0] = { ...other.tasks[0], text: "Slice it thin." };
    expect(offer(s, other, DERIVED)).toBe(s);
  });
});

describe("moving through a session", () => {
  it("steps, jumps and switches mode through the cook view's rules", () => {
    let s = startSession(ZUCCHINI_PLAN, DERIVED, "first");
    s = reduceSession(s, { type: "mode", mode: "go" });
    expect(s.state.mode).toBe("go");
    s = reduceSession(s, { type: "next" });
    expect(s.state.pos).toBe(1);
    s = reduceSession(s, { type: "mode", mode: "first" });
    expect(s.state.mode).toBe("go");
    s = reduceSession(s, { type: "jump", pos: 0 });
    expect(s.state.pos).toBe(0);
    s = reduceSession(s, { type: "jump", pos: 3 });
    expect(s.state.pos).toBe(3);
  });

  it("returns the same session when an action changes nothing", () => {
    const s = startSession(ZUCCHINI_PLAN, DERIVED, "first");
    expect(reduceSession(s, { type: "back" })).toBe(s);
    expect(reduceSession(s, { type: "jump", pos: 99 })).toBe(s);
    expect(reduceSession(s, { type: "goMark", pos: 99 })).toBe(s);
  });

  it("goes to a chart mark from Prep by leaving Prep, as Next does (N2)", () => {
    const s = startSession(ZUCCHINI_PLAN, DERIVED, "go");
    const left = next(ZUCCHINI_PLAN, s.state);
    const last = screensOf(ZUCCHINI_PLAN, left.mode, left.ticked).length - 1;
    const went = reduceSession(s, { type: "goMark", pos: last });
    expect(went.state).toEqual(goToMark(ZUCCHINI_PLAN, s.state, last));
    expect(went.state.pos).toBe(last);
    expect(went.state.ticked).toEqual(left.ticked);
    expect(went.settled).toBe(true);
  });
});

describe("resolvePlan", () => {
  const stale = { ...ZUCCHINI_PLAN, version: 1 };

  it("cooks the stored plan when it is current", () => {
    expect(resolvePlan(ZUCCHINI_RECIPE, ZUCCHINI_PLAN, "waiting")).toEqual({
      plan: ZUCCHINI_PLAN,
      source: DERIVED,
    });
  });

  it("cooks the recipe as written while the plan is being worked out", () => {
    for (const stored of [null, undefined, stale]) {
      expect(resolvePlan(ZUCCHINI_RECIPE, stored, "waiting")).toEqual({
        plan: asWritten(),
        source: PENDING,
      });
    }
  });

  it("takes the plan the open derived", () => {
    expect(resolvePlan(ZUCCHINI_RECIPE, null, { plan: ZUCCHINI_PLAN })).toEqual({
      plan: ZUCCHINI_PLAN,
      source: DERIVED,
    });
  });

  it("says there is no plan when the open could not derive one", () => {
    for (const ensured of ["failed", { plan: null }, { plan: stale }] as const) {
      expect(resolvePlan(ZUCCHINI_RECIPE, null, ensured)).toEqual({
        plan: asWritten(),
        source: FAILED,
      });
    }
  });

  it("cooks a recipe with no steps as an empty plan", () => {
    expect(resolvePlan({}, null, "failed").plan.tasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The stored session (slice B5b): a reload mid-cook resumes where the cook
// was; a recipe that changed since is discarded, never resumed at a
// mismatched step. Ported from the Player's `sessionStore.test.ts`, recast
// onto the app's per-queue-item sessions.
// ---------------------------------------------------------------------------

/** An in-memory localStorage; `fail` makes the named method throw. */
function memoryStorage(fail: { getItem?: Error; setItem?: Error } = {}) {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => {
      if (fail.getItem) throw fail.getItem;
      return data.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (fail.setItem) throw fail.setItem;
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
  };
}

const ROW = {
  recipeData: { name: "Sweet Zucchini Wraps", serves: 4, ...ZUCCHINI_RECIPE } as KitchenQueueRecipeData,
  servesEstimate: null,
  servesEstimateBasis: null,
};

function snapshot(): CookSnapshot {
  const read = readQueueRecipe({ id: "q1", ...ROW });
  if (read.packRecipe === null) throw new Error(`fixture unreadable: ${read.conversionError}`);
  return { recipeData: ROW.recipeData, packRecipe: read.packRecipe, cookPlan: ZUCCHINI_PLAN };
}

/** A derived cook that has moved on: a tick on Prep, then two steps on. */
function underWay(): CookSession {
  let s = startSession(ZUCCHINI_PLAN, DERIVED, "go");
  s = reduceSession(s, { type: "tick", id: s.plan.tasks.find((t) => t.kind === "mise")!.id });
  s = reduceSession(s, { type: "next" });
  s = reduceSession(s, { type: "next" });
  return s;
}

const NOW = 1_700_000_000_000;

beforeEach(() => {
  consumeCorruptionNotices();
  vi.restoreAllMocks();
});

describe("a stored cook session", () => {
  it("comes back as it was saved: plan, source, place, ticks, passes, kept, settled", () => {
    const store = memoryStorage();
    const session = underWay();
    expect(session.state.pos).toBe(2);
    expect(session.state.ticked.size + session.state.passed.size).toBeGreaterThan(0);
    const fp = recipeFingerprint(ROW);
    expect(saveSession("q1", fp, session, snapshot(), NOW, store)).toBe(true);

    const loaded = loadSession("q1", store);
    expect(loaded).not.toBeNull();
    expect(loaded!.session.plan).toEqual(session.plan);
    expect(loaded!.session.source).toEqual(session.source);
    expect(loaded!.session.settled).toBe(true);
    expect(loaded!.session.state.pos).toBe(session.state.pos);
    expect(loaded!.session.state.mode).toBe("go");
    expect([...loaded!.session.state.ticked]).toEqual([...session.state.ticked]);
    expect([...loaded!.session.state.passed]).toEqual([...session.state.passed]);
    expect([...loaded!.session.state.kept]).toEqual([...session.state.kept]);
    expect(loaded!.session.state.ticked).toBeInstanceOf(Set);
    // A snapshot kept without a library (before B5d) reads as none.
    expect(loaded!.snapshot).toEqual({ ...snapshot(), library: { states: [], commons: [] } });
    expect(loaded!.fingerprint).toBe(fp);
    expect(loaded!.savedAt).toBe(NOW);
    // The cook view reads the loaded session exactly as the saved one.
    expect(cookView(loaded!.session.plan, loaded!.session.source, loaded!.session.state)).toEqual(
      cookView(session.plan, session.source, session.state),
    );
  });

  it("keeps the part of a paged step with the stage width it was paged at, and drops both at the first part", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), snapshot(), NOW, store, 2, 1280);
    expect(loadSession("q1", store)).toMatchObject({ part: 2, partWidth: 1280 });
    saveSession("q1", "a", underWay(), snapshot(), NOW, store, 0, 1280);
    const first = loadSession("q1", store)!;
    expect(first.part).toBeUndefined();
    expect(first.partWidth).toBeUndefined();
  });

  it("keeps an as-written session's reason", () => {
    const store = memoryStorage();
    const s = reduceSession(startSession(identityPlan(ZUCCHINI_RECIPE), PENDING, "first"), { type: "next" });
    const later = offer(s, ZUCCHINI_PLAN, DERIVED);
    saveSession("q1", "a", later, snapshot(), NOW, store);
    expect(loadSession("q1", store)!.session.source).toEqual({ kind: "as-written", reason: "later" });
  });

  it("is kept per queue item", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), snapshot(), NOW, store);
    expect(store.data.has(sessionKey("q1"))).toBe(true);
    expect(loadSession("q2", store)).toBeNull();
  });

  it("isn't saved before the cook has progress, and a session that loses it all is removed", () => {
    const store = memoryStorage();
    const fresh = startSession(ZUCCHINI_PLAN, DERIVED, "first");
    expect(saveSession("q1", "a", fresh, snapshot(), NOW, store)).toBe(false);
    expect(store.data.size).toBe(0);

    saveSession("q1", "a", underWay(), snapshot(), NOW, store);
    expect(store.data.size).toBe(1);
    // Back on Prep with nothing done: nothing to lose, so nothing is kept.
    saveSession("q1", "a", fresh, snapshot(), NOW, store);
    expect(store.data.size).toBe(0);
  });

  it("resumes when the stored recipe is the one it was saved for, and is discarded when it changed", () => {
    const store = memoryStorage();
    const fp = recipeFingerprint(ROW);
    saveSession("q1", fp, underWay(), snapshot(), NOW, store);

    const same = resumeFor(loadSession("q1", store), fp);
    expect(same.kind).toBe("resume");

    const edited = recipeFingerprint({
      ...ROW,
      recipeData: { ...ROW.recipeData, steps: [...ROW.recipeData.steps!.slice(0, 4), "Serve."] },
    });
    expect(resumeFor(loadSession("q1", store), edited)).toEqual({ kind: "changed" });
    expect(resumeFor(null, fp)).toEqual({ kind: "none" });
  });
});

describe("confirmed checkpoints (b5d-followup)", () => {
  it("are kept with the session and come back from storage", () => {
    const store = memoryStorage();
    const session = reduceSession(underWay(), { type: "check", id: ZUCCHINI_PLAN.tasks.find((t) => t.kind === "cook")!.id });
    expect(reduceSession(session, { type: "check", id: [...session.checked!][0]! })).toBe(session);
    saveSession("q1", "a", session, snapshot(), NOW, store);
    expect([...loadSession("q1", store)!.session.checked!]).toEqual([...session.checked!]);
  });

  it("a session kept before them reads as none; one naming a task its plan lacks is cleared", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), snapshot(), NOW, store);
    expect(loadSession("q1", store)!.session.checked).toBeUndefined();
    saveSession("q2", "a", { ...underWay(), checked: new Set(["no-such-task"]) }, snapshot(), NOW, store);
    expect(loadSession("q2", store)).toBeNull();
  });
});

describe("the snapshot's library (B5d D6)", () => {
  const LIBRARY = {
    states: [{ id: "state:custard-coats-the-spoon", name: "Custard coats the spoon", sensory_notes: { look: "An even film." } }],
    commons: [{ id: "commons:tempering-eggs", name: "Tempering eggs" }],
  };

  it("comes back as it was kept, so an offline open draws a checkpoint's evidence", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), { ...snapshot(), library: LIBRARY }, NOW, store);
    expect(loadSession("q1", store)!.snapshot.library).toEqual(LIBRARY);
  });

  it("clears a session whose library isn't one, with the reset line", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), { ...snapshot(), library: { states: [{ id: "bare" }], commons: [] } as never }, NOW, store);
    expect(loadSession("q1", store)).toBeNull();
    expect(consumeCorruptionNotices().map((n) => n.text)).toEqual([SESSION_RESET_COPY]);
  });
});

describe("the snapshot's shown-as-sent mark (cook-fidelity plan)", () => {
  it("comes back as kept, so an offline open still says the recipe reads as sent", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), { ...snapshot(), shownAsSent: true }, NOW, store);
    expect(loadSession("q1", store)!.snapshot.shownAsSent).toBe(true);
  });

  it("is absent on a snapshot kept without it", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), snapshot(), NOW, store);
    expect("shownAsSent" in loadSession("q1", store)!.snapshot).toBe(false);
  });
});

describe("recipeFingerprint", () => {
  it("doesn't depend on key order (jsonb keeps none)", () => {
    const reordered = Object.fromEntries(
      Object.entries(ROW.recipeData).reverse(),
    ) as KitchenQueueRecipeData;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(ROW.recipeData));
    expect(recipeFingerprint({ ...ROW, recipeData: reordered })).toBe(recipeFingerprint(ROW));
  });

  it("changes with a step, an amount, the stated count or the serving estimate", () => {
    const base = recipeFingerprint(ROW);
    const r = ROW.recipeData;
    const variants = [
      { ...ROW, recipeData: { ...r, steps: [...r.steps!, "Eat."] } },
      {
        ...ROW,
        recipeData: { ...r, ingredients: [{ amount: "3", item: "zucchini" }, ...r.ingredients!.slice(1)] },
      },
      { ...ROW, recipeData: { ...r, serves: 6 } },
      { ...ROW, servesEstimate: 4, servesEstimateBasis: "From the dish alone" },
    ];
    const prints = variants.map(recipeFingerprint);
    for (const p of prints) expect(p).not.toBe(base);
    expect(new Set(prints).size).toBe(prints.length);
  });

  it("is unchanged by B5d for any row not read natively (pinned to the pre-B5d value)", () => {
    // The pre-B5d function (main @ 5ac7991e) and today's gave one value for this row.
    // The row's last step was since reworded, and the pin was recomputed with it.
    const zucchini = { recipeData: ZUCCHINI_RECIPE as KitchenQueueRecipeData, servesEstimate: null, servesEstimateBasis: null };
    expect(recipeFingerprint(zucchini)).toBe("ak7bm15hej");
    const packRecipe = readQueueRecipe({ id: "q", recipeData: ROW.recipeData }).packRecipe;
    expect(recipeFingerprint({ ...zucchini, reading: "projection", packRecipe })).toBe("ak7bm15hej");
  });

  it("covers the pack recipe when the row is read natively (B5d D6)", () => {
    const packRecipe = readQueueRecipe({ id: "q", recipeData: ROW.recipeData }).packRecipe!;
    const projection = recipeFingerprint({ ...ROW, reading: "projection", packRecipe });
    const native = recipeFingerprint({ ...ROW, reading: "native", packRecipe });
    expect(native).not.toBe(projection);
    const edited = structuredClone(packRecipe);
    edited.steps[0]!.type = "checkpoint";
    expect(recipeFingerprint({ ...ROW, reading: "native", packRecipe: edited })).not.toBe(native);
    // A session kept on the projection is for another recipe: it starts over with the note.
    const stored = { fingerprint: projection } as Parameters<typeof resumeFor>[0];
    expect(resumeFor(stored, native)).toEqual({ kind: "changed" });
  });

  it("reads a missing estimate as none", () => {
    expect(recipeFingerprint({ recipeData: ROW.recipeData })).toBe(recipeFingerprint(ROW));
    expect(recipeFingerprint(ROW)).toMatch(/^[0-9a-z]+$/);
  });
});

describe("a stored session that can't be read", () => {
  it("is cleared with a notice when it isn't JSON or has drifted", () => {
    const store = memoryStorage();
    store.data.set(sessionKey("q1"), "{not json");
    expect(loadSession("q1", store)).toBeNull();
    expect(store.data.has(sessionKey("q1"))).toBe(false);

    store.data.set(sessionKey("q2"), JSON.stringify({ version: SESSION_VERSION, state: { pos: "two" } }));
    expect(loadSession("q2", store)).toBeNull();
    const notices = consumeCorruptionNotices();
    expect(notices.map((n) => n.store)).toEqual([sessionKey("q1"), sessionKey("q2")]);
    // Its own words, never the timers' (fix round 1).
    expect(notices.map((n) => n.text)).toEqual([SESSION_RESET_COPY, SESSION_RESET_COPY]);
  });

  it("is cleared with a notice when its plan is of an older plan version (E8)", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), snapshot(), NOW, store);
    const raw = JSON.parse(store.data.get(sessionKey("q1"))!);
    raw.state.session.plan.version = COOK_PLAN_VERSION - 1;
    store.data.set(sessionKey("q1"), JSON.stringify(raw));
    expect(loadSession("q1", store)).toBeNull();
    expect(consumeCorruptionNotices()).toHaveLength(1);
  });

  it("is cleared with a notice when its snapshot's recipe isn't a pack recipe", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), snapshot(), NOW, store);
    const raw = JSON.parse(store.data.get(sessionKey("q1"))!);
    delete raw.state.snapshot.packRecipe.steps;
    store.data.set(sessionKey("q1"), JSON.stringify(raw));
    expect(loadSession("q1", store)).toBeNull();
    expect(consumeCorruptionNotices()).toHaveLength(1);
  });

  it("a place past the plan's screens is drift, never a resume at a mismatched step", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), snapshot(), NOW, store);
    const raw = JSON.parse(store.data.get(sessionKey("q1"))!);
    raw.state.session.state.pos = 99;
    store.data.set(sessionKey("q1"), JSON.stringify(raw));
    expect(loadSession("q1", store)).toBeNull();
    expect(consumeCorruptionNotices()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sessions saved before Prep became step pages (version 1; DECISIONS
// 2026-11-22). In "Prep first" the old sequence was the Prep screen and then
// the cooking steps; now it is the prep pages and then the cooking steps. A
// session saved under the old numbering is renumbered on load, never reset: a
// reset mid-cook sends the cook back to the start of a meal.
// ---------------------------------------------------------------------------
describe("a session saved before Prep became step pages (version 1)", () => {
  const mise = ZUCCHINI_PLAN.tasks.filter((t) => t.kind === "mise").map((t) => t.id);
  const pages = prepPages(ZUCCHINI_PLAN, "first");
  const cooking = flow(ZUCCHINI_PLAN, "first", new Set());

  /** A version-1 envelope for a cook in `mode` at `pos`, as the old release wrote it. */
  function storeV1(
    store: ReturnType<typeof memoryStorage>,
    state: { mode: "first" | "go"; pos: number; ticked: string[]; passed: string[] },
    plan: CookPlan = ZUCCHINI_PLAN,
    source: PlanSource = DERIVED,
  ) {
    saveSession("q1", "a", underWay(), snapshot(), NOW, store);
    const raw = JSON.parse(store.data.get(sessionKey("q1"))!);
    raw.version = 1;
    raw.state.session.plan = plan;
    raw.state.session.source = source;
    raw.state.session.state = { ...state, kept: [] };
    store.data.set(sessionKey("q1"), JSON.stringify(raw));
  }

  it("the plan it is tested on has two prep pages before its cooking steps", () => {
    expect(SESSION_VERSION).toBe(2);
    expect(pages.map((p) => p.tasks.map((t) => t.id))).toEqual([["onion", "scape", "zuc"], ["greens"]]);
    expect(cooking.length).toBeGreaterThan(2);
  });

  it("saved on the Prep screen with some ticked: lands on the first prep page with a job left, ticks kept", () => {
    const store = memoryStorage();
    storeV1(store, { mode: "first", pos: 0, ticked: ["onion", "scape", "zuc"], passed: [] });
    const loaded = loadSession("q1", store)!;
    expect(loaded).not.toBeNull();
    expect(loaded.session.state.pos).toBe(1);
    expect([...loaded.session.state.ticked]).toEqual(["onion", "scape", "zuc"]);
    expect(cookView(ZUCCHINI_PLAN, DERIVED, loaded.session.state).now!.key).toBe("greens");
    expect(consumeCorruptionNotices()).toEqual([]);
    // Rewritten at the new version, so the next load reads it as it stands.
    expect(JSON.parse(store.data.get(sessionKey("q1"))!).version).toBe(SESSION_VERSION);
    expect(loadSession("q1", store)!.session.state.pos).toBe(1);
  });

  it("saved on the Prep screen with one job ticked: stays on the first page, its row ticked", () => {
    const store = memoryStorage();
    storeV1(store, { mode: "first", pos: 0, ticked: ["onion"], passed: [] });
    const { state } = loadSession("q1", store)!.session;
    expect(state.pos).toBe(0);
    expect(cookView(ZUCCHINI_PLAN, DERIVED, state).now!.rows!.map((r) => [r.id, r.done])).toEqual([
      ["onion", true],
      ["scape", false],
      ["zuc", false],
    ]);
  });

  it("saved on the Prep screen with everything ticked: lands on the last prep page", () => {
    const store = memoryStorage();
    storeV1(store, { mode: "first", pos: 0, ticked: mise, passed: [] });
    expect(loadSession("q1", store)!.session.state.pos).toBe(pages.length - 1);
  });

  it("saved mid-cook: keeps its step, its ticks and its passed steps", () => {
    const store = memoryStorage();
    // The old numbering: Prep at 0, so the third cooking step was position 3.
    const passed = cooking.slice(0, 2).flatMap((c) => c.tasks.map((t) => t.id));
    storeV1(store, { mode: "first", pos: 3, ticked: mise, passed });
    const { state } = loadSession("q1", store)!.session;
    expect(state.pos).toBe(pages.length + 2);
    expect(cookView(ZUCCHINI_PLAN, DERIVED, state).now!.key).toBe(cooking[2].tasks.map((t) => t.id).join("+"));
    expect([...state.ticked]).toEqual(mise);
    expect([...state.passed]).toEqual(passed);
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("saved on the last step: lands on the last step", () => {
    const store = memoryStorage();
    const passed = cooking.slice(0, -1).flatMap((c) => c.tasks.map((t) => t.id));
    storeV1(store, { mode: "first", pos: cooking.length, ticked: mise, passed });
    const { state } = loadSession("q1", store)!.session;
    expect(state.pos).toBe(screensOf(ZUCCHINI_PLAN, "first", state.ticked).length - 1);
    expect(cookView(ZUCCHINI_PLAN, DERIVED, state).isLast).toBe(true);
  });

  it("As I go keeps its numbering: the Prep screen is still first", () => {
    const store = memoryStorage();
    storeV1(store, { mode: "go", pos: 2, ticked: ["onion"], passed: [] });
    const { state } = loadSession("q1", store)!.session;
    expect(state.pos).toBe(2);
    expect(state.mode).toBe("go");
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("a recipe cooked as written has no prep, so its place stands", () => {
    const store = memoryStorage();
    const written = asWritten();
    storeV1(store, { mode: "first", pos: 2, ticked: [], passed: [written.tasks[0].id, written.tasks[1].id] }, written, PENDING);
    expect(loadSession("q1", store)!.session.state.pos).toBe(2);
  });

  it("a version-1 session that doesn't read is cleared with the notice, as before", () => {
    const store = memoryStorage();
    storeV1(store, { mode: "first", pos: 99, ticked: mise, passed: [] });
    expect(loadSession("q1", store)).toBeNull();
    expect(store.data.has(sessionKey("q1"))).toBe(false);
    store.data.set(sessionKey("q1"), JSON.stringify({ version: 1, state: { session: { state: { pos: "two" } } } }));
    expect(loadSession("q1", store)).toBeNull();
    expect(consumeCorruptionNotices().map((n) => n.text)).toEqual([SESSION_RESET_COPY, SESSION_RESET_COPY]);
  });

  it("a version-1 session whose plan can't be walked (a needs cycle) is cleared with the notice, never thrown", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStorage();
    const [first, second] = ZUCCHINI_PLAN.tasks;
    const cyclic = {
      ...ZUCCHINI_PLAN,
      tasks: ZUCCHINI_PLAN.tasks.map((t) =>
        t.id === first.id ? { ...t, needs: [second.id] } : t.id === second.id ? { ...t, needs: [first.id] } : t,
      ),
    };
    storeV1(store, { mode: "first", pos: 0, ticked: [], passed: [] }, cyclic);
    expect(() => loadSession("q1", store)).not.toThrow();
    expect(store.data.has(sessionKey("q1"))).toBe(false);
    expect(consumeCorruptionNotices().map((n) => n.text)).toEqual([SESSION_RESET_COPY]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a session from a version the app doesn't know is cleared with the notice", () => {
    const store = memoryStorage();
    storeV1(store, { mode: "first", pos: 0, ticked: ["onion"], passed: [] });
    const raw = JSON.parse(store.data.get(sessionKey("q1"))!);
    raw.version = SESSION_VERSION + 1;
    store.data.set(sessionKey("q1"), JSON.stringify(raw));
    expect(loadSession("q1", store)).toBeNull();
    expect(consumeCorruptionNotices()).toHaveLength(1);
  });
});

describe("storage that refuses", () => {
  it("a full or blocked store: the save reports false and is logged, nothing throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const full = memoryStorage({ setItem: new DOMException("full", "QuotaExceededError") });
    expect(saveSession("q1", "a", underWay(), snapshot(), NOW, full)).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("an unreadable store: nothing to resume, no notice", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocked = memoryStorage({ getItem: new Error("SecurityError") });
    expect(loadSession("q1", blocked)).toBeNull();
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("no storage at all (the server): nothing saved, nothing loaded, nothing pruned", () => {
    expect(saveSession("q1", "a", underWay(), snapshot(), NOW, null)).toBe(false);
    expect(loadSession("q1", null)).toBeNull();
    expect(() => pruneSessions([], null)).not.toThrow();
  });
});

describe("removeSession and pruneSessions", () => {
  it("Finish removes the session", () => {
    const store = memoryStorage();
    saveSession("q1", "a", underWay(), snapshot(), NOW, store);
    removeSession("q1", store);
    expect(loadSession("q1", store)).toBeNull();
  });

  it("prunes finished items and keeps the most recently saved ten, leaving other keys alone", () => {
    const store = memoryStorage();
    store.data.set("sous-cook-prep-mode", "go");
    for (let i = 0; i < 13; i++) {
      saveSession(`q${i}`, "a", underWay(), snapshot(), NOW + i * 1000, store);
    }
    pruneSessions(["q12", "q5"], store);
    const kept = [...store.data.keys()].filter((k) => k.startsWith(SESSION_PREFIX)).sort();
    // q12 and q5 finished; of the other eleven, the oldest (q0) goes.
    expect(kept).toEqual(
      ["q1", "q2", "q3", "q4", "q6", "q7", "q8", "q9", "q10", "q11"].map(sessionKey).sort(),
    );
    expect(store.data.get("sous-cook-prep-mode")).toBe("go");
  });

  it("an unreadable entry is pruned first, without a notice (it isn't the cook on screen)", () => {
    const store = memoryStorage();
    for (let i = 0; i < 10; i++) saveSession(`q${i}`, "a", underWay(), snapshot(), NOW + i, store);
    store.data.set(sessionKey("junk"), "{");
    pruneSessions([], store);
    expect(store.data.has(sessionKey("junk"))).toBe(false);
    expect([...store.data.keys()]).toHaveLength(10);
    expect(consumeCorruptionNotices()).toEqual([]);
  });
});

describe("B5c serving count in the session and per-tab store (B5c-5, B5c-13)", () => {
  it("steppingCounts and isValidServings cover whole bases and non-whole bases (2.5 → cap 10)", () => {
    expect(steppingCounts(4)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(steppingCounts(2.5)).toEqual([1, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(isValidServings(4, 4)).toBe(true);
    expect(isValidServings(1, 4)).toBe(true);
    expect(isValidServings(16, 4)).toBe(true);
    expect(isValidServings(0, 4)).toBe(false);
    expect(isValidServings(-2, 4)).toBe(false);
    expect(isValidServings(0.5, 4)).toBe(false);
    expect(isValidServings(2.5, 4)).toBe(false);
    expect(isValidServings(17, 4)).toBe(false);

    expect(isValidServings(2.5, 2.5)).toBe(true);
    expect(isValidServings(2, 2.5)).toBe(true);
    expect(isValidServings(3, 2.5)).toBe(true);
    expect(isValidServings(10, 2.5)).toBe(true);
    expect(isValidServings(3.5, 2.5)).toBe(false);
    expect(isValidServings(11, 2.5)).toBe(false);
  });

  it("setting servings in reduceSession never sets settled, and unsettled offer carries servings", () => {
    let s = startSession(asWritten(), PENDING, "first");
    s = reduceSession(s, { type: "servings", servings: 8 });
    expect(s.servings).toBe(8);
    expect(s.settled).toBe(false);
    expect(reduceSession(s, { type: "servings", servings: 8 })).toBe(s);

    const offered = offer(s, ZUCCHINI_PLAN, DERIVED);
    expect(offered.plan).toBe(ZUCCHINI_PLAN);
    expect(offered.servings).toBe(8);
    expect(offered.settled).toBe(false);
    expect(offered.checked).toBeUndefined();
  });

  it("saveSession writes nothing without progress even with a count set, and drops servings when back at base", () => {
    const store = memoryStorage();
    const scaledNoProgress = reduceSession(startSession(ZUCCHINI_PLAN, DERIVED, "first"), {
      type: "servings",
      servings: 8,
    });
    expect(saveSession("q1", "fp", scaledNoProgress, snapshot(), NOW, store)).toBe(false);
    expect(store.data.size).toBe(0);

    const activeAt8 = reduceSession(underWay(), { type: "servings", servings: 8 });
    expect(saveSession("q1", "fp", activeAt8, { ...snapshot(), scales: true }, NOW, store)).toBe(true);
    const loaded8 = loadSession("q1", store)!;
    expect(loaded8.session.servings).toBe(8);
    expect(loaded8.snapshot.scales).toBe(true);

    // Setting back to base (4) omits `servings` from the stored JSON.
    const backToBase = reduceSession(activeAt8, { type: "servings", servings: 4 });
    saveSession("q1", "fp", backToBase, { ...snapshot(), scales: true }, NOW, store);
    const rawJson = JSON.parse(store.data.get(sessionKey("q1"))!);
    expect("servings" in rawJson.state.session).toBe(false);
    expect(loadSession("q1", store)!.session.servings).toBeUndefined();
  });

  it("an older stored session without servings or snapshot.scales resumes with progress at base and locked snapshot", () => {
    const store = memoryStorage();
    saveSession("q1", "fp", underWay(), snapshot(), NOW, store);
    const loaded = loadSession("q1", store)!;
    expect(loaded.session.servings).toBeUndefined();
    expect(loaded.snapshot.scales).toBeUndefined();
    expect(effectiveServings(loaded.snapshot.packRecipe, loaded.session, loaded.snapshot.scales ?? false)).toBe(4);
  });

  it("a session with servings and snapshot.scales read by R43/R45's schema copy strips both and keeps progress", () => {
    const store = memoryStorage();
    const activeAt8 = reduceSession(underWay(), { type: "servings", servings: 8 });
    saveSession("q1", "fp", activeAt8, { ...snapshot(), scales: true }, NOW, store);

    // Exact copy of R43/R45's storedSchema (without `servings` or `snapshot.scales`; R45's schema has the same shape as R43's).
    const r43PlanSchema = z
      .object({
        version: z.literal(COOK_PLAN_VERSION),
        tasks: z.array(
          z
            .object({
              id: z.string().min(1),
              kind: z.enum(["ahead", "mise", "cook"]),
              text: z.string(),
              label: z.string(),
              ingredientIdx: z.array(z.number()),
              sourceStep: z.number().int().nullable(),
              implied: z.boolean(),
              needs: z.array(z.string()),
              branch: z.string(),
            })
            .passthrough(),
        ),
      })
      .passthrough();
    const r43SourceSchema = z.union([
      z.object({ kind: z.literal("derived") }),
      z.object({ kind: z.literal("as-written"), reason: z.enum(["pending", "failed", "later"]) }),
    ]);
    const r43StoredSchema = z
      .object({
        fingerprint: z.string().min(1),
        savedAt: z.number(),
        part: z.number().int().nonnegative().optional(),
        partWidth: z.number().int().positive().optional(),
        session: z.object({
          plan: r43PlanSchema,
          source: r43SourceSchema,
          settled: z.boolean(),
          state: z.object({
            mode: z.enum(["first", "go"]),
            pos: z.number().int().nonnegative(),
            ticked: z.array(z.string()),
            passed: z.array(z.string()),
            kept: z.array(z.string()),
          }),
          checked: z.array(z.string()).optional(),
        }),
        snapshot: z.object({
          recipeData: z.object({ name: z.string() }).passthrough(),
          packRecipe: z.unknown(),
          cookPlan: z.unknown(),
          library: z.object({ states: z.unknown(), commons: z.unknown() }).optional(),
        }),
      })
      .transform((stored) => {
        const pack = parseRecipe(stored.snapshot.packRecipe);
        if (!pack.ok) throw new Error("bad pack");
        const states = stored.snapshot.library ? parseStatesFile(stored.snapshot.library.states) : null;
        const commons = stored.snapshot.library ? parseCommonsFile(stored.snapshot.library.commons) : null;
        const state: CookState = {
          mode: stored.session.state.mode,
          pos: stored.session.state.pos,
          ticked: new Set(stored.session.state.ticked),
          passed: new Set(stored.session.state.passed),
          kept: new Set(stored.session.state.kept),
        };
        return {
          fingerprint: stored.fingerprint,
          savedAt: stored.savedAt,
          session: {
            plan: stored.session.plan as CookPlan,
            source: stored.session.source,
            settled: stored.session.settled,
            state,
          },
          snapshot: {
            recipeData: stored.snapshot.recipeData,
            packRecipe: pack.value,
            cookPlan: stored.snapshot.cookPlan,
            library: states?.ok && commons?.ok ? { states: states.value, commons: commons.value } : EMPTY_LIBRARY,
          },
        };
      });

    const readByR43 = readStored(sessionKey("q1"), r43StoredSchema, store, SESSION_VERSION, SESSION_RESET_COPY);
    expect(readByR43).not.toBeNull();
    expect("servings" in readByR43!.session).toBe(false);
    expect("scales" in readByR43!.snapshot).toBe(false);
    expect(readByR43!.session.state.pos).toBe(activeAt8.state.pos);
    expect([...readByR43!.session.state.ticked]).toEqual([...activeAt8.state.ticked]);
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it.each([0, -2, 0.5, 2.5, 17, 99])(
    "out-of-range stored servings (%s) drops only the count, keeps progress, logs a warning, and emits no reset notice",
    (badServings) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = memoryStorage();
      const active = underWay();
      saveSession("q1", "fp-123", active, { ...snapshot(), scales: true }, NOW, store);
      const raw = JSON.parse(store.data.get(sessionKey("q1"))!);
      raw.state.session.servings = badServings;
      store.data.set(sessionKey("q1"), JSON.stringify(raw));

      const loaded = loadSession("q1", store);
      expect(loaded).not.toBeNull();
      expect(loaded!.session.servings).toBeUndefined();
      expect(loaded!.session.state.pos).toBe(active.state.pos);
      expect([...loaded!.session.state.ticked]).toEqual([...active.state.ticked]);
      expect(consumeCorruptionNotices()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("fp-123"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(badServings)));
    },
  );

  it("per-tab scale entry: saves, reads, removes on base, and quietly drops fingerprint mismatch or out-of-range", () => {
    const tab = memoryStorage();
    saveTabServings("q1", "fp-1", 8, 4, tab);
    expect(loadTabServings("q1", "fp-1", 4, tab)).toBe(8);

    // Setting back to base removes the entry.
    saveTabServings("q1", "fp-1", 4, 4, tab);
    expect(tab.data.has(tabScaleKey("q1"))).toBe(false);
    expect(loadTabServings("q1", "fp-1", 4, tab)).toBeNull();

    // Fingerprint mismatch (recipe changed or degraded) removes quietly, no notice.
    saveTabServings("q1", "fp-1", 8, 4, tab);
    expect(loadTabServings("q1", "fp-2", 4, tab)).toBeNull();
    expect(tab.data.has(tabScaleKey("q1"))).toBe(false);
    expect(consumeCorruptionNotices()).toEqual([]);

    // Out-of-range value in storage is removed quietly, no notice.
    tab.data.set(tabScaleKey("q1"), JSON.stringify({ fingerprint: "fp-1", servings: 99 }));
    expect(loadTabServings("q1", "fp-1", 4, tab)).toBeNull();
    expect(tab.data.has(tabScaleKey("q1"))).toBe(false);
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("malformed per-tab entry is removed with console.info and emits no corruption notice", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const tab = memoryStorage();

    tab.data.set(tabScaleKey("q1"), "{bad json");
    expect(loadTabServings("q1", "fp-1", 4, tab)).toBeNull();
    expect(tab.data.has(tabScaleKey("q1"))).toBe(false);
    expect(info).toHaveBeenCalled();

    tab.data.set(tabScaleKey("q1"), JSON.stringify({ fingerprint: "fp-1", servings: "eight" }));
    expect(loadTabServings("q1", "fp-1", 4, tab)).toBeNull();
    expect(tab.data.has(tabScaleKey("q1"))).toBe(false);
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("missing or throwing sessionStorage logs a warning and never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadTabServings("q1", "fp", 4, null)).toBeNull();
    expect(() => saveTabServings("q1", "fp", 8, 4, null)).not.toThrow();
    expect(() => removeTabServings("q1", null)).not.toThrow();

    const throwing = memoryStorage({
      getItem: new Error("SecurityError"),
      setItem: new Error("QuotaExceededError"),
    });
    expect(loadTabServings("q1", "fp", 4, throwing)).toBeNull();
    expect(() => saveTabServings("q1", "fp", 8, 4, throwing)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("initialSessionFor: resumed session with progress wins over tab entry; fresh open uses tab entry; snapshot open ignores tab entry", () => {
    const store = memoryStorage();
    const tab = memoryStorage();
    const snap = { ...snapshot(), scales: true };
    const fp = recipeFingerprint(ROW);

    // 1. Fresh open with tab entry at 8 -> starts at 8.
    saveTabServings("q1", fp, 8, 4, tab);
    const freshWithTab = initialSessionFor({
      id: "q1",
      recipe: ROW.recipeData,
      packRecipe: snap.packRecipe,
      storedPlan: ZUCCHINI_PLAN,
      fingerprint: fp,
      start: { kind: "none" },
      mode: "first",
      tabBacking: tab,
    });
    expect(freshWithTab.servings).toBe(8);

    // 2. Resumed session with progress at 12 wins over tab entry at 8.
    const activeAt12 = reduceSession(underWay(), { type: "servings", servings: 12 });
    saveSession("q1", fp, activeAt12, snap, NOW, store);
    const stored = loadSession("q1", store)!;
    const resumed = initialSessionFor({
      id: "q1",
      recipe: ROW.recipeData,
      packRecipe: snap.packRecipe,
      storedPlan: ZUCCHINI_PLAN,
      fingerprint: fp,
      start: { kind: "resume", stored },
      mode: "first",
      tabBacking: tab,
    });
    expect(resumed.servings).toBe(12);

    // 3. Snapshot open uses stored session and never consults tab entry.
    const fromSnap = initialSessionFor({
      id: "q1",
      recipe: ROW.recipeData,
      packRecipe: snap.packRecipe,
      storedPlan: ZUCCHINI_PLAN,
      fingerprint: fp,
      start: { kind: "resume", stored },
      fromSnapshot: true,
      mode: "first",
      tabBacking: tab,
    });
    expect(fromSnap.servings).toBe(12);

    // 4. Recipe changed (or row degraded from native to projection): tab entry with old fp is dropped quietly.
    const changed = initialSessionFor({
      id: "q1",
      recipe: ROW.recipeData,
      packRecipe: snap.packRecipe,
      storedPlan: ZUCCHINI_PLAN,
      fingerprint: "new-fp-after-degrade",
      start: { kind: "changed" },
      mode: "first",
      tabBacking: tab,
    });
    expect(changed.servings).toBeUndefined();
    expect(tab.data.has(tabScaleKey("q1"))).toBe(false);
  });
});

