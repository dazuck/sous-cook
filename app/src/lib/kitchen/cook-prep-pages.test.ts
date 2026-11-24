/**
 * Prep as ordinary step pages (2026-11-22, "Prep becomes step pages"): in
 * Prep first the plan's prep cards are screens of the one
 * sequence, before the first cooking step. Each failure mode the design names
 * has its test here.
 */

import { describe, expect, it } from "vitest";
import { COOK_PLAN_VERSION, type CookPlan, type CookTask } from "./cook-plan";
import { flow, prepFlow } from "./cook-schedule";
import { hasOpening } from "./cook-opening";
import {
  COOK_COPY,
  PREP_ROWS_MAX,
  back,
  cookView,
  hasPrepScreen,
  initialCookState,
  isDone,
  jumpTo,
  next,
  prepEyebrow,
  rowsAllAssumed,
  prepPages,
  screensOf,
  setMode,
  stepKey,
  toggleTick,
  type CookState,
  type PlanSource,
} from "./cook-view";
import { timetableCorpus } from "./__tests__/timetable-corpus";

const DERIVED: PlanSource = { kind: "derived" };
const CORPUS = timetableCorpus();

function corpus(name: string): CookPlan {
  const found = CORPUS.find((c) => c.name === name);
  if (!found) throw new Error(`no corpus plan ${name}`);
  return found.plan;
}

function task(t: Partial<CookTask> & Pick<CookTask, "id" | "kind">): CookTask {
  return {
    text: `${t.id}.`,
    label: t.id,
    ingredientIdx: [],
    sourceStep: null,
    implied: false,
    needs: [],
    branch: "Cook",
    minutes: { est: 2, handsOff: false },
    ...t,
  };
}

/** `n` chopping jobs one stir-fry needs: one merged card of `n`. */
function chopPlan(n: number): CookPlan {
  const mise = Array.from({ length: n }, (_, i) => task({ id: `chop-${i + 1}`, kind: "mise", ingredientIdx: [i] }));
  return {
    version: COOK_PLAN_VERSION,
    tasks: [
      ...mise,
      task({ id: "fry", kind: "cook", sourceStep: 0, needs: mise.map((m) => m.id), minutes: { est: 6, handsOff: false } }),
      task({ id: "serve", kind: "cook", sourceStep: 1, needs: ["fry"] }),
    ],
  };
}

const roast = corpus("sunday-roast-dinner");
const stirFry = corpus("weeknight-stir-fry");
const pasta = corpus("spicy-harissa-pasta");
const mole = corpus("multi-component-mole");
const cookies = corpus("chewy-oat-cookies");
const tacos = corpus("lime-shrimp-tacos");

const first = initialCookState("first");
const go = initialCookState("go");

function walk(plan: CookPlan, state: CookState, n: number): CookState {
  let s = state;
  for (let i = 0; i < n; i++) s = next(plan, s);
  return s;
}

const pageKeys = (plan: CookPlan) => prepPages(plan, "first").map(stepKey);

describe("prep pages: which pages a plan has", () => {
  it("is one page per prep card, in the prep block's order", () => {
    expect(pageKeys(roast)).toEqual(["prep-potatoes", "prep-aromatics", "trim-beans", "chop-shallot"]);
    expect(pageKeys(roast)).toEqual(prepFlow(roast, "first", new Set()).map(stepKey));
  });

  it("keeps a merged card of up to four jobs on one page", () => {
    expect(pageKeys(corpus("day-old-fried-rice"))).toEqual(["beat-eggs+prep-veggies-meat+mince-garlic+prep-rice"]);
    expect(pageKeys(chopPlan(PREP_ROWS_MAX))).toHaveLength(1);
  });

  it("runs a longer merged card on over pages of near-equal length", () => {
    const sizes = (n: number) => prepPages(chopPlan(n), "first").map((p) => p.tasks.length);
    expect(sizes(5)).toEqual([3, 2]);
    expect(sizes(6)).toEqual([3, 3]);
    expect(sizes(7)).toEqual([4, 3]);
    expect(sizes(8)).toEqual([4, 4]);
    expect(sizes(9)).toEqual([3, 3, 3]);
    expect(sizes(13)).toEqual([4, 3, 3, 3]);
    // The stir-fry's one card of six, on the real plan.
    expect(prepPages(stirFry, "first").map((p) => p.tasks.length)).toEqual([3, 3]);
  });

  it("puts every mise task on exactly one page, on every plan the tests hold", () => {
    for (const { name, plan } of CORPUS) {
      const mise = plan.tasks.filter((t) => t.kind === "mise").map((t) => t.id).sort();
      const paged = prepPages(plan, "first").flatMap((p) => p.tasks.map((t) => t.id)).sort();
      expect(paged, name).toEqual(mise);
      for (const page of prepPages(plan, "first")) {
        expect(page.tasks.length, name).toBeLessThanOrEqual(PREP_ROWS_MAX);
        expect(page.end, name).toBeGreaterThan(page.start);
      }
    }
  });

  it("a cut card's pages follow one another in the prep block", () => {
    const pages = prepPages(chopPlan(9), "first");
    for (let i = 1; i < pages.length; i++) expect(pages[i].start).toBeGreaterThanOrEqual(pages[i - 1].end);
  });

  it("has none in As I go, where the mise comes up in the steps", () => {
    expect(prepPages(roast, "go")).toEqual([]);
    expect(prepPages(stirFry, "go")).toEqual([]);
  });
});

describe("prep pages: the one sequence of screens", () => {
  it("Prep first: the pages, then the cooking steps, and no Prep screen", () => {
    const screens = screensOf(roast, "first", new Set());
    expect(screens.every((s) => s.kind === "step")).toBe(true);
    const pages = prepPages(roast, "first");
    const cooking = flow(roast, "first", new Set());
    expect(screens).toHaveLength(pages.length + cooking.length);
    expect(screens.slice(0, pages.length).map((s) => (s.kind === "step" ? stepKey(s.item) : "prep"))).toEqual(pages.map(stepKey));
    expect(hasPrepScreen(roast, "first")).toBe(false);
  });

  it("As I go keeps the Prep screen first, then its steps, as before", () => {
    const screens = screensOf(roast, "go", new Set());
    expect(screens[0]).toEqual({ kind: "prep" });
    expect(screens).toHaveLength(1 + flow(roast, "go", new Set()).length);
    expect(hasPrepScreen(roast, "go")).toBe(true);
  });

  it("a recipe with no prep has no Prep screen and no pages", () => {
    for (const mode of ["first", "go"] as const) {
      const screens = screensOf(mole, mode, new Set());
      expect(prepPages(mole, mode)).toEqual([]);
      expect(hasPrepScreen(mole, mode)).toBe(false);
      expect(screens).toHaveLength(flow(mole, mode, new Set()).length);
      const v = cookView(mole, DERIVED, initialCookState(mode));
      expect(v.onPrep).toBe(false);
      expect(v.now?.kind).toBe("cook");
      expect(v.now?.prep).toBeUndefined();
    }
  });

  it("make-ahead work with no mise keeps the Prep screen in Prep first", () => {
    expect(cookies.tasks.some((t) => t.kind === "mise")).toBe(false);
    expect(hasPrepScreen(cookies, "first")).toBe(true);
    const v = cookView(cookies, DERIVED, first);
    expect(v.onPrep).toBe(true);
    expect(v.prep!.ahead.length).toBeGreaterThan(0);
  });

  it("the opening counts the pages as steps", () => {
    const onePageOneStep: CookPlan = {
      version: COOK_PLAN_VERSION,
      tasks: [task({ id: "chop", kind: "mise" }), task({ id: "fry", kind: "cook", sourceStep: 0, needs: ["chop"] })],
    };
    // One prep page and one cooking step are two step screens: the opening shows.
    expect(screensOf(onePageOneStep, "first", new Set())).toHaveLength(2);
    expect(hasOpening(onePageOneStep, DERIVED, "first", new Set())).toBe(true);
  });
});

describe("prep pages: what a page shows", () => {
  it("a single job is a step page with a Prep eyebrow, its place and its dish", () => {
    const v = cookView(roast, DERIVED, first);
    expect(v.onPrep).toBe(false);
    expect(v.prep).toBeNull();
    const now = v.now!;
    expect(now.kind).toBe("mise");
    expect(now.key).toBe("prep-potatoes");
    expect(now.text).toBe(roast.tasks.find((t) => t.id === "prep-potatoes")!.text);
    expect(now.prep).toEqual({ count: { at: 1, of: 4 }, dish: "Potatoes" });
    expect(now.rows).toBeUndefined();
    expect(now.minutes).toBe("About 10 minutes");
    expect(now.ingredientIdx).toEqual([6]);
    expect(cookView(roast, DERIVED, walk(roast, first, 3)).now!.prep).toEqual({ count: { at: 4, of: 4 }, dish: "Gravy" });
  });

  it("the first cooking step after the pages is an ordinary step", () => {
    const state = walk(roast, first, 4);
    const now = cookView(roast, DERIVED, state).now!;
    expect(now.kind).toBe("cook");
    expect(now.prep).toBeUndefined();
    expect(now.key).toBe(stepKey(flow(roast, "first", new Set())[0]));
  });

  it("a recipe with one prep page says Prep with no count", () => {
    expect(prepPages(pasta, "first")).toHaveLength(1);
    expect(cookView(pasta, DERIVED, first).now!.prep).toEqual({ count: null, dish: null });
  });

  it("leaves the dish out of a one-dish plan, and for the planner's generic branch", () => {
    // The stir-fry is one dish, its branch the generic "Cook".
    expect(cookView(stirFry, DERIVED, first).now!.prep!.dish).toBeNull();
    // The dal has two branches, one of them "Cook": that page names no dish.
    const dal = corpus("indian-dal-tadka");
    expect(cookView(dal, DERIVED, first).now!.prep).toEqual({ count: { at: 1, of: 2 }, dish: "Tempering" });
    expect(cookView(dal, DERIVED, walk(dal, first, 1)).now!.prep).toEqual({ count: { at: 2, of: 2 }, dish: null });
  });

  it("a merged card is tick rows, each with its own words, minutes and amounts", () => {
    const now = cookView(stirFry, DERIVED, first).now!;
    expect(now.kind).toBe("mise");
    expect(now.prep).toEqual({ count: { at: 1, of: 2 }, dish: null });
    const tasks = prepPages(stirFry, "first")[0].tasks;
    expect(now.rows).toEqual(
      tasks.map((t) => ({
        id: t.id,
        text: t.text,
        ingredientIdx: t.ingredientIdx,
        minutes: `${t.minutes!.est} min`,
        implied: t.implied,
        done: false,
      })),
    );
    // The page's own minutes are its rows' added up.
    const sum = tasks.reduce((n, t) => n + t.minutes!.est, 0);
    expect(now.minutes).toBe(`About ${sum} minutes`);
  });

  it("a job with no amounts shows its words and time, and no pairs", () => {
    const salad = corpus("butternut-chickpea-salad");
    const single = cookView(salad, DERIVED, first).now!;
    expect(single.ingredientIdx).toEqual([]);
    expect(single.minutes).not.toBeNull();
    const pages = prepPages(salad, "first");
    const merged = pages.findIndex((p) => p.tasks.length > 1);
    const rows = cookView(salad, DERIVED, walk(salad, first, merged)).now!.rows!;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.ingredientIdx.length === 0 && r.minutes !== null)).toBe(true);
  });

  it("a row with no estimate says no minutes", () => {
    const plan = chopPlan(2);
    const bare: CookPlan = { ...plan, tasks: plan.tasks.map((t) => (t.id === "chop-1" ? { ...t, minutes: undefined } : t)) };
    const rows = cookView(bare, DERIVED, first).now!.rows!;
    expect(rows.find((r) => r.id === "chop-1")!.minutes).toBeNull();
    expect(rows.find((r) => r.id === "chop-2")!.minutes).toBe("2 min");
  });

  it("a hands-off prep job is its own page, said as hands-free", () => {
    const pages = prepPages(tacos, "first");
    const pickle = pages.findIndex((p) => stepKey(p) === "pickle-onion");
    expect(pickle).toBeGreaterThanOrEqual(0);
    const now = cookView(tacos, DERIVED, jumpTo(tacos, first, pickle)).now!;
    expect(now.rows).toBeUndefined();
    expect(now.minutes).toBe("About 23 minutes, mostly hands-free");
  });
});

describe("prep pages: moving through them", () => {
  it("Forward and Back step through the pages like any step", () => {
    const one = next(roast, first);
    expect(one.pos).toBe(1);
    expect(isDone(one, "prep-potatoes")).toBe(true);
    expect(one.ticked.size).toBe(0);
    const backAgain = back(roast, one);
    expect(backAgain.pos).toBe(0);
    expect(isDone(backAgain, "prep-potatoes")).toBe(false);
  });

  it("walks every plan from its first screen to its last, one screen a Forward", () => {
    for (const { name, plan } of CORPUS) {
      const screens = screensOf(plan, "first", new Set());
      let s = first;
      for (let i = 0; i < screens.length - 1; i++) {
        const moved = next(plan, s);
        expect(moved.pos, `${name} at ${i}`).toBe(i + 1);
        s = moved;
      }
      if (screens.length > 0) expect(cookView(plan, DERIVED, s).isLast, name).toBe(true);
    }
  });

  it("the Prep chapter spans the pages and says the page's place; cooking stretches start after", () => {
    const v = cookView(roast, DERIVED, next(roast, first));
    const prep = v.chapters!.find((c) => c.id === "prep")!;
    expect(prep.at).toEqual([0, 1, 2, 3]);
    expect(prep.state).toBe("now");
    expect(prep.place).toEqual({ at: 2, of: 4 });
    expect(v.stretch).toBeNull();
    const firstStretch = v.chapters!.find((c) => c.id !== "prep")!;
    expect(firstStretch.at[0]).toBe(4);
    // Once the cook is cooking, Prep reads done and the stretch is in hand.
    const cooking = cookView(roast, DERIVED, walk(roast, first, 4));
    expect(cooking.chapters!.find((c) => c.id === "prep")!.state).toBe("done");
    expect(cooking.stretch).not.toBeNull();
  });
});

describe("prep pages: ticks", () => {
  const rowIds = prepPages(stirFry, "first")[0].tasks.map((t) => t.id);

  it("a tick marks its row done and is undone by a second", () => {
    const ticked = toggleTick(stirFry, first, rowIds[1]);
    expect(cookView(stirFry, DERIVED, ticked).now!.rows!.map((r) => r.done)).toEqual([false, true, false]);
    const undone = toggleTick(stirFry, ticked, rowIds[1]);
    expect(cookView(stirFry, DERIVED, undone).now!.rows!.map((r) => r.done)).toEqual([false, false, false]);
  });

  it("ticks hold through Forward and Back", () => {
    const ticked = toggleTick(stirFry, first, rowIds[0]);
    const there = next(stirFry, ticked);
    const backAgain = back(stirFry, there);
    expect(backAgain.pos).toBe(0);
    expect(cookView(stirFry, DERIVED, backAgain).now!.rows!.map((r) => r.done)).toEqual([true, false, false]);
  });

  it("Forward counts the page done whether or not its rows were ticked", () => {
    const on = next(stirFry, first);
    expect(rowIds.every((id) => isDone(on, id))).toBe(true);
    expect(on.ticked.size).toBe(0);
  });

  it("only a row on the page in hand ticks", () => {
    const other = prepPages(stirFry, "first")[1].tasks[0].id;
    expect(toggleTick(stirFry, first, other)).toBe(first);
    // A single-job page has no rows to tick.
    expect(toggleTick(roast, first, "prep-potatoes")).toBe(first);
    // A cooking step ticks nothing.
    const cooking = walk(stirFry, first, 2);
    expect(toggleTick(stirFry, cooking, rowIds[0])).toBe(cooking);
  });

  it("the page's order and keys do not move when a row is ticked", () => {
    const before = screensOf(stirFry, "first", new Set()).map((s) => (s.kind === "step" ? stepKey(s.item) : "prep"));
    const ticked = toggleTick(stirFry, first, rowIds[0]);
    const after = screensOf(stirFry, "first", ticked.ticked).map((s) => (s.kind === "step" ? stepKey(s.item) : "prep"));
    expect(after).toEqual(before);
  });
});

describe("prep pages: switching mode at the first page", () => {
  it("to As I go lands on the Prep screen with the ticks kept, and back lands on page 1", () => {
    const rowIds = prepPages(stirFry, "first")[0].tasks.map((t) => t.id);
    const ticked = toggleTick(stirFry, first, rowIds[0]);
    const asIGo = setMode(ticked, "go");
    expect(asIGo.mode).toBe("go");
    const goView = cookView(stirFry, DERIVED, asIGo);
    expect(goView.onPrep).toBe(true);
    expect(goView.prep!.mise.find((m) => m.id === rowIds[0])!.done).toBe(true);
    const again = setMode(asIGo, "first");
    const v = cookView(stirFry, DERIVED, again);
    expect(v.onPrep).toBe(false);
    expect(v.now!.prep!.count).toEqual({ at: 1, of: 2 });
    expect(v.now!.rows!.map((r) => r.done)).toEqual([true, false, false]);
  });

  it("the mode does not switch past the first page", () => {
    const on = next(stirFry, first);
    expect(setMode(on, "go")).toBe(on);
  });

  it("As I go's own prep steps are unchanged: one sentence, a Prep kind, no rows", () => {
    const state = next(stirFry, { ...go, kept: new Set(stirFry.tasks.filter((t) => t.kind === "mise").map((t) => t.id)) });
    const now = cookView(stirFry, DERIVED, state).now!;
    expect(now.kind).toBe("mise");
    expect(now.prep).toBeUndefined();
    expect(now.rows).toBeUndefined();
  });

  it("COOK_COPY names the eyebrow's parts", () => {
    expect(COOK_COPY.prepChapter).toBe("Prep");
    expect(COOK_COPY.prepPlace(2, 4)).toBe("2 of 4");
  });

  it("the eyebrow says the page's place, its dish, and a tick-row page's minutes", () => {
    // A single job: place and dish; its time stays under its words.
    expect(prepEyebrow(cookView(roast, DERIVED, first).now!)).toEqual(["1 of 4", "Potatoes"]);
    // Tick rows, one dish: place, then the page's minutes in the eyebrow's lower case.
    const rows = cookView(stirFry, DERIVED, first).now!;
    expect(rows.minutes).toMatch(/^About \d+ minutes$/);
    const said = (line: typeof rows) => (rowsAllAssumed(line.rows!) ? ["assumed"] : []);
    expect(prepEyebrow(rows)).toEqual(["1 of 2", rows.minutes!.replace("About", "about"), ...said(rows)]);
    // The only prep page: no place. The pasta's is tick rows, so its minutes; a single job says "Prep" alone.
    const pastaPage = cookView(pasta, DERIVED, first).now!;
    expect(prepEyebrow(pastaPage)).toEqual(["about 8 minutes", ...said(pastaPage)]);
    expect(prepEyebrow({ prep: { count: null, dish: null }, minutes: "About 3 minutes" })).toEqual([]);
    // Rows the recipe lists none of say "assumed" once, last; a page where only some are read from the steps does not.
    const row = (implied: boolean) => ({ id: "x", text: "x", ingredientIdx: [], minutes: null, implied, done: false });
    const page = { prep: { count: { at: 1, of: 2 }, dish: "Filling" }, minutes: "About 5 minutes" };
    expect(prepEyebrow({ ...page, rows: [row(true), row(true)] })).toEqual(["1 of 2", "Filling", "about 5 minutes", "assumed"]);
    expect(prepEyebrow({ ...page, rows: [row(true), row(false)] })).toEqual(["1 of 2", "Filling", "about 5 minutes"]);
    expect(rowsAllAssumed([])).toBe(false);
    // Not a prep page: nothing.
    expect(prepEyebrow(cookView(roast, DERIVED, walk(roast, first, 4)).now!)).toEqual([]);
    expect(prepEyebrow(cookView(roast, DERIVED, initialCookState("go")).now ?? { minutes: null })).toEqual([]);
  });
});
