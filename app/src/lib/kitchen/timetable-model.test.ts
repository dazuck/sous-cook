import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COOK_PLAN_VERSION, parseCookPlan, type CookPlan, type CookTask, type PrepMode } from "./cook-plan";
import { taskMinutes } from "./cook-schedule";
import { strip, type Strip } from "./cook-strip";
import { initialCookState, next, type CookState } from "./cook-view";
import {
  BREAK_DRAWN_MINUTES,
  NAME_QUALIFIERS,
  blockName,
  buildTimetable,
  drawnMinutes,
  laneWords,
  phrase,
  potWords,
  shortName,
  verb3,
  type Timetable,
} from "./timetable-model";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "./__tests__/load-cook-plan-fixtures";
import { loadKitchenPlans } from "./__tests__/load-kitchen-plans";
import { timetableCorpus } from "./__tests__/timetable-corpus";

const MODES: PrepMode[] = ["first", "go"];

/** The opening's strips: both modes from the start, nothing ticked. */
function strips(plan: CookPlan): { first: Strip; go: Strip } {
  return {
    first: strip(plan, initialCookState("first"), null, 0),
    go: strip(plan, initialCookState("go"), null, 0),
  };
}

function timetable(plan: CookPlan, mode: PrepMode, options?: { now?: number }): Timetable {
  const s = strips(plan);
  const t = buildTimetable(plan, s.first, s.go, mode, options);
  if (!t) throw new Error("expected a timetable");
  return t;
}

let counter = 0;
function task(t: Partial<CookTask> & { label: string }): CookTask {
  const id = t.id ?? `t${counter++}`;
  return {
    id,
    kind: "cook",
    text: t.label,
    ingredientIdx: [],
    sourceStep: null,
    implied: true,
    needs: [],
    branch: "Main",
    ...t,
  };
}

const min = (est: number, handsOff = false) => ({ minutes: { est, handsOff } });

/** A chain of tasks on one branch, each needing the one before: [label, minutes, handsOff?]. */
function chain(specs: [string, number, boolean?][], branch = "Main", prefix = "c"): CookTask[] {
  return specs.map(([label, est, off], i) =>
    task({ id: `${prefix}${i}`, label, branch, needs: i ? [`${prefix}${i - 1}`] : [], ...min(est, !!off) }),
  );
}

const plan = (tasks: CookTask[]): CookPlan => ({ version: COOK_PLAN_VERSION, tasks });

function corpusPlan(name: string): CookPlan {
  const fixture = loadCookPlanFixtures().find((f) => f.name === name);
  const raw = loadCookPlanSnapshots().get(name)?.raw;
  if (!fixture || !raw) throw new Error(`no corpus plan ${name}`);
  const parsed = parseCookPlan(raw, fixture.recipe);
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return parsed.plan;
}

function kitchenPlan(name: string): CookPlan {
  const f = loadKitchenPlans().find((k) => k.name === name);
  if (!f) throw new Error(`no kitchen plan ${name}`);
  return f.plan;
}

// ---------------------------------------------------------------------------
// Naming (SPEC §3)
// ---------------------------------------------------------------------------

describe("phrase", () => {
  it("reads a block's first clause, split at commas and 'and'", () => {
    expect(phrase("toss greens, season and plate", null)).toEqual({ verb: "toss", object: ["greens"] });
  });

  it("reads a pot's last clause that opens with a cooking verb", () => {
    expect(phrase("drain chickpeas and simmer garlic, stir", null, true)).toEqual({ verb: "simmer", object: ["garlic"] });
  });

  it("counts 'air fry', 'set aside' and 'turn on' as one verb", () => {
    expect(phrase("air fry squash", null).verb).toBe("air fry");
    expect(phrase("set aside dressing", null)).toEqual({ verb: "set aside", object: ["dressing"] });
    expect(phrase("turn on broiler", null)).toEqual({ verb: "turn on", object: ["broiler"] });
  });

  it("cuts the object at the first preposition", () => {
    expect(phrase("place chickpeas in pot", null).object).toEqual(["chickpeas"]);
  });

  it("drops the lane's own words, plurals included, and qualifiers", () => {
    expect(phrase("slice cucumbers", "Cucumber Pickles").object).toEqual([]);
    expect(phrase("add the final garlic", null).object).toEqual(["garlic"]);
    expect(phrase("rough up potatoes", "Potatoes").object).toEqual([]);
  });

  it("keeps at most two words of the object", () => {
    expect(phrase("chop red bell pepper", null).object).toEqual(["red", "bell"]);
  });
});

describe("blockName", () => {
  const t = (label: string, est: number, handsOff = false) => task({ label, ...min(est, handsOff) });

  it("is verb plus object when one task carries the winning verb", () => {
    // wilt 3 beats cook 2, which counts half on a cook block
    expect(blockName([t("wilt greens", 3), t("cook eggs", 2)], null, false)).toBe("wilt greens");
  });

  it("takes the longest task's object when several share a generic verb", () => {
    expect(blockName([t("cook bacon", 2), t("cook eggs", 5)], null, false)).toBe("cook eggs");
  });

  it("is the bare verb when several tasks share a verb that isn't generic", () => {
    expect(blockName([t("blend chickpeas", 3), t("blend tahini", 4)], null, false)).toBe("blend");
  });

  it("halves generic verbs on cook blocks only", () => {
    const tasks = [t("add salt", 4), t("stir sauce", 3)];
    expect(blockName(tasks, null, false)).toBe("stir sauce");
    expect(blockName(tasks, null, true)).toBe("add salt");
  });

  it("gives a tie to the earlier verb", () => {
    expect(blockName([t("chop onion", 3), t("slice leek", 3)], null, true)).toBe("chop onion");
  });
});

describe("shortName", () => {
  it("is the verb, or the object when the verb is generic", () => {
    expect(shortName("cook eggs")).toBe("eggs");
    expect(shortName("slice meat")).toBe("slice");
    expect(shortName("set aside dressing")).toBe("dressing");
    expect(shortName("blend")).toBe("blend");
  });
});

describe("pot words", () => {
  const t = (label: string) => task({ label, ...min(10, true) });

  it("puts the verb in the third person", () => {
    expect(verb3("toss")).toBe("tosses");
    expect(verb3("fry")).toBe("fries");
    expect(verb3("stay")).toBe("stays");
    expect(verb3("air fry")).toBe("air-fries");
    expect(verb3("roast")).toBe("roasts");
  });

  it("is object plus verb, the verb agreeing with a plural object", () => {
    expect(potWords(t("preheat oven"), null, null)).toBe("oven heats");
    expect(potWords(t("simmer chickpeas"), null, null)).toBe("chickpeas simmer");
    expect(potWords(t("air fry potatoes"), null, null)).toBe("potatoes air-fry");
  });

  it("is the bare verb when the object was the dish, or the subject given", () => {
    expect(potWords(t("roast chicken"), "Chicken", null)).toBe("roasts");
    expect(potWords(t("roast chicken"), "Chicken", "Chicken")).toBe("Chicken roasts");
  });
});

// ---------------------------------------------------------------------------
// Grouping (SPEC §2)
// ---------------------------------------------------------------------------

describe("lanes", () => {
  it("are Board and Stove for a one-branch plan, moved prep on Board", () => {
    const p = plan([
      task({ id: "dice", kind: "mise", label: "dice onion", ...min(5) }),
      task({ id: "grate", kind: "mise", label: "grate cheese", ...min(4) }),
      task({ id: "fry", label: "fry onion", needs: ["dice"], ...min(6) }),
      task({ id: "simmer", label: "simmer sauce", needs: ["fry"], ...min(20, true) }),
      task({ id: "eggs", label: "crack eggs", needs: ["simmer", "grate"], ...min(4) }),
    ]);
    const first = timetable(p, "first");
    const go = timetable(p, "go");
    expect(first.lanes.map((l) => l.name)).toEqual(["Board", "Stove"]);
    expect(first.onePan).toBe(true);
    expect(first.blocks.filter((b) => b.lane === "Board")).toEqual([]);
    expect(go.blocks.filter((b) => b.lane === "Board")).toMatchObject([{ sand: true, name: "grate cheese", start: 27, end: 31 }]);
    expect(first.prep).toMatchObject({ start: 0, end: 9 });
    expect(go.prep).toMatchObject({ start: 0, end: 5 });
  });

  it("are one per branch, ordered by their first stove step", () => {
    const t = timetable(kitchenPlan("chicken-pita-wraps"), "first");
    expect(t.lanes.map((l) => l.name)).toEqual(["Chicken", "Hummus", "Assembly", "Cabbage Slaw", "Cucumber Pickles"]);
  });

  it("give a two-word lane its last word as the short form", () => {
    const t = timetable(kitchenPlan("chicken-pita-wraps"), "first");
    expect(t.lanes.find((l) => l.name === "Cucumber Pickles")?.short).toBe("Pickles");
    expect(t.lanes.find((l) => l.name === "Hummus")?.short).toBe("Hummus");
  });
});

describe("blocks", () => {
  it("merge hands-on runs 3 min apart or less, and no further", () => {
    const p = plan([
      ...chain([["sear steak", 5], ["rest steak", 3, true], ["slice steak", 3], ["rest board", 4, true], ["carve roast", 3]], "Steak"),
      task({ label: "toss salad", branch: "Salad", ...min(4) }),
    ]);
    const steak = timetable(p, "first").blocks.filter((b) => b.lane === "Steak");
    expect(steak.map((b) => [b.start, b.end])).toEqual([[0, 11], [15, 18]]);
    expect(steak[0].tasks).toEqual(["c0", "c2"]);
  });

  it("merge the two closest runs until a lane has 4", () => {
    const p = plan([
      ...chain([["chop a", 2], ["rest a", 5, true], ["chop b", 2], ["rest b", 6, true], ["chop c", 2], ["rest c", 4, true], ["chop d", 2], ["rest d", 7, true], ["chop e", 2]]),
      task({ label: "toss salad", branch: "Salad", ...min(4) }),
    ]);
    const main = timetable(p, "first").blocks.filter((b) => b.lane === "Main");
    // the gaps are 5, 6, 4 and 7 minutes: the 4-minute one closes
    expect(main.map((b) => [b.start, b.end])).toEqual([[0, 2], [7, 9], [15, 23], [30, 32]]);
  });

  it("split a long one-pan stove run in two where its halves read differently", () => {
    const t = timetable(plan(chain([["sear chicken", 4], ["stir sauce", 4], ["fold herbs", 3]])), "first");
    expect(t.blocks.map((b) => [b.name, b.start, b.end])).toEqual([
      ["sear chicken", 0, 4],
      ["stir sauce", 4, 11],
    ]);
  });

  it("don't split when the lane already has 4 runs", () => {
    const waits = (n: number): [string, number, boolean?][] =>
      ["onion", "garlic", "tomato"].slice(0, n).flatMap((x): [string, number, boolean?][] => [[`stir ${x}`, 2], [`simmer ${x}`, 10, true]]);
    const tail: [string, number][] = [["sear chicken", 4], ["stir sauce", 4], ["fold herbs", 3]];
    const four = timetable(plan(chain([...waits(3), ...tail])), "first").blocks;
    expect(four.map((b) => [b.start, b.end])).toEqual([[0, 2], [12, 14], [24, 26], [36, 47]]);
    const three = timetable(plan(chain([...waits(2), ...tail])), "first").blocks;
    expect(three.map((b) => [b.name, b.start, b.end])).toEqual([
      ["stir onion", 0, 2],
      ["stir garlic", 12, 14],
      ["sear chicken", 24, 28],
      ["stir sauce", 28, 35],
    ]);
  });

  it("are touches, never named, under 3 min of hands-on work", () => {
    const p = plan([
      ...chain([["stir sauce", 2], ["simmer sauce", 10, true], ["fold herbs", 3]], "Sauce"),
      task({ label: "toss salad", branch: "Salad", ...min(4) }),
    ]);
    const sauce = timetable(p, "first").blocks.filter((b) => b.lane === "Sauce");
    expect(sauce.map((b) => [b.work, b.touch])).toEqual([[2, true], [3, false]]);
  });
});

describe("pots", () => {
  it("merge food pots that touch, keep the oven heating its own line, and read their longest task", () => {
    const p = plan([
      ...chain([["boil water", 5, true], ["simmer potatoes", 20, true], ["preheat oven", 10, true], ["roast potatoes", 30, true], ["toss potatoes", 3]], "Potatoes"),
      task({ label: "toss salad", branch: "Salad", ...min(4) }),
    ]);
    const pots = timetable(p, "first").pots;
    expect(pots.map((x) => [x.start, x.end, x.equipment, x.lead, x.words, x.short])).toEqual([
      [0, 25, false, "c1", "simmers", "simmers"],
      [25, 35, true, "c2", "oven heats", "heats"],
      [35, 65, false, "c3", "roasts", "roasts"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Chapters (SPEC §4) and breaks (SPEC §5)
// ---------------------------------------------------------------------------

describe("chapters", () => {
  const sauce = () =>
    plan([
      task({ id: "dice", kind: "mise", label: "dice onion", ...min(5) }),
      task({ id: "fry", label: "fry onion", needs: ["dice"], ...min(6) }),
      task({ id: "simmer", label: "simmer sauce", needs: ["fry"], ...min(20, true) }),
      task({ id: "eggs", label: "crack eggs", needs: ["simmer"], ...min(4) }),
      task({ id: "bake", label: "bake eggs", needs: ["eggs"], ...min(10, true) }),
      task({ id: "serve", label: "scatter cheese", needs: ["bake"], ...min(4) }),
    ]);

  it("are Prep, the waits folded when under 8 min apart and named for their pot, then Finish and plate", () => {
    const t = timetable(sauce(), "first");
    // the simmer (11–31) and the bake (35–45) are 4 min apart, so one wait, named for the longer pot
    expect(t.chapters.map((c) => [c.n, c.kind, c.name, c.start, c.end, c.minutes])).toEqual([
      [1, "prep", "Prep", 0, 5, 5],
      [2, "wait", "Sauce simmers", 5, 45, 40],
      [3, "finish", "Finish and plate", 45, 49, 4],
    ]);
    expect(t.chapters[1].pot).toBe(t.pots.find((p) => p.lead === "simmer")?.key);
    expect(t.pots.find((p) => p.lead === "simmer")?.namesChapter).toBe(true);
    expect(t.chapters[2].headShort).toBe("Finish");
  });

  it("are Cook and plate when the stove is never free for 8 min", () => {
    const p = plan([
      ...chain([["sear steak", 8], ["rest steak", 10, true], ["slice steak", 3]], "Steak"),
      task({ id: "x", label: "toss salad", branch: "Salad", ...min(4) }),
    ]);
    expect(timetable(p, "first").chapters.map((c) => [c.name, c.start, c.end])).toEqual([["Cook and plate", 0, 21]]);
  });

  it("join a Prep under 4 min to the chapter after it", () => {
    const t = timetable(corpusPlan("sunday-roast-dinner"), "go");
    expect(t.prep?.end).toBe(3);
    expect(t.chapters.map((c) => [c.name, c.start, c.end])).toEqual([
      ["Chicken roasts", 0, 88],
      ["Finish and plate", 88, 115],
    ]);
  });

  it("are never more than 4, the shortest middle one merging", () => {
    // five 10-min waits, 10 min of work apart, alternating between two pots: six chapters before the cap
    const lanes = ["Sauce", "Stock"];
    const specs: [string, number, boolean][] = [];
    for (let i = 0; i < 5; i++) specs.push([`stir ${lanes[i % 2].toLowerCase()}`, 10, false], [`simmer ${lanes[i % 2].toLowerCase()}`, 10, true]);
    specs.push(["plate", 10, false]);
    const tasks = specs.map(([label, est, off], i) =>
      task({ id: `w${i}`, label, branch: lanes[Math.floor(i / 2) % 2], needs: i ? [`w${i - 1}`] : [], ...min(est, off) }),
    );
    const t = timetable(plan(tasks), "first");
    // the cap merges [20,40] into [40,60], then [60,80] into [80,100]; the two Stock waits it
    // leaves side by side then merge as same-named neighbours (a deliberate step past the mock)
    expect(t.chapters.map((c) => [c.kind, c.name, c.start, c.end])).toEqual([
      ["wait", "Sauce simmers", 0, 20],
      ["wait", "Stock simmers", 20, 100],
      ["finish", "Finish and plate", 100, 110],
    ]);
  });
});

describe("breaks", () => {
  const braise = (minutes: number) => plan(chain([["sear beef", 10], ["braise beef", minutes, true], ["plate stew", 5]]));

  it("compress a free stretch of 30+ min in a cook over 75 min", () => {
    const t = timetable(braise(61), "first");
    expect(t.breaks).toEqual([{ start: 10, end: 71, minutes: 61 }]);
    expect(drawnMinutes(t, 10)).toBe(10);
    expect(drawnMinutes(t, 71)).toBe(10 + BREAK_DRAWN_MINUTES);
    expect(drawnMinutes(t, 76)).toBe(15 + BREAK_DRAWN_MINUTES);
    expect(t.axis.span).toBe(15 + BREAK_DRAWN_MINUTES);
  });

  it("don't happen in a cook of 75 min or less", () => {
    const t = timetable(braise(60), "first");
    expect(t.total).toBe(75);
    expect(t.breaks).toEqual([]);
    expect(t.axis.span).toBe(75);
  });
});

describe("the axis", () => {
  it("is shared by both modes, scaled to the longer one", () => {
    const p = kitchenPlan("skillet-eggs-potatoes-greens");
    const first = timetable(p, "first");
    const go = timetable(p, "go");
    expect([first.total, go.total]).toEqual([40, 30]);
    expect(first.axis.span).toBe(40);
    expect(go.axis.span).toBe(40);
    expect(go.axis.drawnEnd).toBe(30);
  });

  it("stays 0 to the total when the cook runs past the plan: now holds at the end, all done", () => {
    const t = timetable(kitchenPlan("skillet-eggs-potatoes-greens"), "first", { now: 46 });
    expect(t.now).toBe(40);
    expect(t.axis).toEqual({ drawnEnd: 40, span: 40 });
    expect(t.toTable).toBe(0);
    expect(t.prep?.done).toBe(true);
    for (const b of t.blocks) expect(b.done, b.key).toBe(true);
    for (const p of t.pots) expect(p.done, p.key).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Done and now (SPEC §9)
// ---------------------------------------------------------------------------

describe("done and now", () => {
  it("reads now from the mode's strip as the cook moves on", () => {
    const p = kitchenPlan("skillet-eggs-potatoes-greens");
    let state: CookState = initialCookState("first");
    state = next(p, state); // off Prep, onto the first step
    state = next(p, state);
    const first = strip(p, state, null, 0);
    const go = strip(p, initialCookState("go"), null, 0);
    const t = buildTimetable(p, first, go, "first");
    expect(t?.now).toBe(first.now);
    expect(first.now).toBeGreaterThan(0);
  });

  it("marks what ended by now done, and says how much of a break is left", () => {
    const t = timetable(corpusPlan("sunday-roast-dinner"), "first", { now: 70 });
    expect(t.prep?.done).toBe(true);
    for (const b of t.blocks) expect(b.done).toBe(b.end <= 70);
    for (const p of t.pots) expect(p.done).toBe(p.end <= 70);
    expect(t.nowBreak).toEqual({ start: 56, end: 106, minutes: 50, left: 36 });
    expect(t.toTable).toBe(133 - 70);
  });

  it("has no break note outside a break", () => {
    expect(timetable(corpusPlan("sunday-roast-dinner"), "first", { now: 20 }).nowBreak).toBeNull();
  });
});

describe("ahead notes", () => {
  it("group ahead tasks by lead, named like a block", () => {
    const p = plan([
      task({ id: "soak", kind: "ahead", label: "soak beans", branch: "Beans", lead: "overnight", ...min(5) }),
      task({ id: "mix", kind: "ahead", label: "mix marinade", branch: "Chicken", lead: "2-6 hours before", ...min(5) }),
      task({ id: "mar", kind: "ahead", label: "marinate chicken", branch: "Chicken", lead: "2-6 hours before", needs: ["mix"], ...min(120, true) }),
      task({ id: "cook", label: "simmer beans", branch: "Beans", needs: ["soak"], ...min(30, true) }),
      task({ id: "grill", label: "grill chicken", branch: "Chicken", needs: ["mar"], ...min(10) }),
    ]);
    expect(timetable(p, "first").ahead).toEqual([
      { lead: "overnight", name: "soak", tasks: ["soak"] },
      { lead: "2–6 hours before", name: "marinate", tasks: ["mix", "mar"] },
    ]);
  });
});

describe("no timetable", () => {
  const none = (p: CookPlan) => {
    const s = strips(p);
    return MODES.map((mode) => buildTimetable(p, s.first, s.go, mode));
  };

  it("as written", () => {
    const p = plan([task({ label: "do it" }), task({ label: "eat it" })]);
    expect(strips(p).first.asWritten).toBe(true);
    expect(none(p)).toEqual([null, null]);
  });

  it("for an empty plan", () => {
    expect(none(plan([]))).toEqual([null, null]);
  });

  it("but there is one for a plan that is only prep: a prep block and a finish", () => {
    const p = plan([task({ id: "m", kind: "mise", label: "slice cucumber", ...min(5) })]);
    for (const mode of MODES) {
      const t = timetable(p, mode);
      expect(t.prep).toEqual({ start: 0, end: 5, tasks: ["m"], done: false });
      expect(t.blocks).toEqual([]);
      expect(t.pots).toEqual([]);
      expect(t.chapters.map((c) => [c.kind, c.name, c.start, c.end])).toEqual([["finish", "Cook and plate", 0, 5]]);
      expect(t.lanes.map((l) => l.name)).toEqual(["Board", "Stove"]);
    }
  });

  it("for a plan that is all ahead work, with no steps to draw", () => {
    const p = plan([task({ kind: "ahead", label: "soak beans", lead: "overnight", ...min(5) })]);
    expect(strips(p).first.marks.filter((m) => m.key !== "prep")).toEqual([]);
    expect(none(p)).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------
// Rules from the SPEC text (independent of the mock)
// ---------------------------------------------------------------------------

describe("the finish chapter", () => {
  it("keeps its name when it is under 4 min, instead of joining the wait before it", () => {
    const p = plan([
      task({ id: "dice", kind: "mise", label: "dice onion", ...min(5) }),
      task({ id: "fry", label: "fry onion", needs: ["dice"], ...min(6) }),
      task({ id: "simmer", label: "simmer sauce", needs: ["fry"], ...min(20, true) }),
      task({ id: "eggs", label: "crack eggs", needs: ["simmer"], ...min(4) }),
      task({ id: "bake", label: "bake eggs", needs: ["eggs"], ...min(10, true) }),
      task({ id: "serve", label: "scatter cheese", needs: ["bake"], ...min(2) }),
    ]);
    expect(timetable(p, "first").chapters.map((c) => [c.kind, c.name, c.start, c.end])).toEqual([
      ["prep", "Prep", 0, 5],
      ["wait", "Sauce simmers", 5, 45],
      ["finish", "Finish and plate", 45, 47],
    ]);
  });

  it("keeps a short finish when the 4-chapter cap merges the chapter before it", () => {
    // four waits on four branches (10 on, 20 off; 10+20; 10+20; 8+8), then 2 min of plating:
    // five chapters before the cap, and the shortest middle one sits just before the finish
    const pairs: [string, number, number][] = [["Soup", 10, 20], ["Beans", 10, 20], ["Rice", 10, 20], ["Stock", 8, 8]];
    const tasks: CookTask[] = [];
    pairs.forEach(([b, on, off], i) => {
      const lower = b.toLowerCase();
      tasks.push(task({ id: `${lower}-on`, label: `stir ${lower}`, branch: b, needs: i ? [`${pairs[i - 1][0].toLowerCase()}-off`] : [], ...min(on) }));
      tasks.push(task({ id: `${lower}-off`, label: `simmer ${lower}`, branch: b, needs: [`${lower}-on`], ...min(off, true) }));
    });
    tasks.push(task({ id: "plate", label: "plate up", branch: "Stock", needs: ["stock-off"], ...min(2) }));
    const t = timetable(plan(tasks), "first");
    expect(t.total).toBe(108);
    expect(t.chapters).toHaveLength(4);
    expect(t.chapters[t.chapters.length - 1]).toMatchObject({ kind: "finish", name: "Finish and plate", start: 106, end: 108 });
    expect(t.chapters.map((c) => [c.start, c.end])).toEqual([[0, 30], [30, 60], [60, 106], [106, 108]]);
  });

  it("is the last chapter when the cook ends in a hands-off stretch, its pot naming no chapter", () => {
    const p = plan(chain([["sear beef", 10], ["simmer beef", 20, true], ["stir sauce", 10], ["bake gratin", 20, true]]));
    const t = timetable(p, "first");
    expect(t.chapters.map((c) => [c.kind, c.name, c.start, c.end, c.pot])).toEqual([
      ["wait", "Beef simmers", 0, 30, t.pots[0].key],
      ["finish", "Finish and plate", 30, 60, null],
    ]);
    expect(t.pots.map((x) => x.namesChapter)).toEqual([true, false]);
  });

  it("is Cook and plate for a cook that is one hands-off task", () => {
    const t = timetable(plan([task({ label: "chill dessert", ...min(30, true) })]), "first");
    expect(t.blocks).toEqual([]);
    expect(t.pots).toMatchObject([{ lane: "Stove", start: 0, end: 30, words: "dessert chills", namesChapter: false }]);
    expect(t.chapters.map((c) => [c.kind, c.name, c.start, c.end])).toEqual([["finish", "Cook and plate", 0, 30]]);
  });
});

describe("tasks without real minutes", () => {
  it("count what the schedule gives them, in names and in work", () => {
    // no estimate: the schedule's nominal 2 min; an estimate of 0: the schedule's one tick
    const p = plan([
      ...chain([["stir sauce", 1], ["fold herbs", Number.NaN], ["taste sauce", 0]], "Sauce"),
      task({ label: "toss salad", branch: "Salad", needs: ["c2"], ...min(4) }),
    ]).tasks.map((x) => (Number.isNaN(x.minutes?.est) ? { ...x, minutes: undefined } : x));
    const t = timetable(plan(p), "first");
    const [sauce] = t.blocks.filter((b) => b.lane === "Sauce");
    const byId = new Map(p.map((x) => [x.id, x]));
    expect(sauce.tasks).toEqual(["c0", "c1", "c2"]);
    expect(sauce.work).toBeCloseTo(taskMinutes(byId.get("c0")!) + taskMinutes(byId.get("c1")!) + taskMinutes(byId.get("c2")!), 9);
    expect(sauce.work).toBeCloseTo(3.001, 9);
    // the unestimated fold (2 min) outscores the 1-min stir
    expect(sauce.name).toBe("fold herbs");
    expect(sauce.touch).toBe(false);
    // a mark's length is its tasks' scheduled minutes
    const fold = strips(plan(p)).first.marks.find((m) => m.key === "c1")!;
    expect(fold.end - fold.start).toBe(taskMinutes(byId.get("c1")!));
  });
});

describe("now at a break", () => {
  it("is in the break from its first minute", () => {
    const t = timetable(plan(chain([["sear beef", 10], ["braise beef", 61, true], ["plate stew", 5]])), "first", { now: 10 });
    expect(t.nowBreak).toEqual({ start: 10, end: 71, minutes: 61, left: 61 });
  });

  it("is out of it at its last", () => {
    const t = timetable(plan(chain([["sear beef", 10], ["braise beef", 61, true], ["plate stew", 5]])), "first", { now: 71 });
    expect(t.nowBreak).toBeNull();
  });
});

describe("a very long wait", () => {
  it("is drawn as 12 min behind its break, the rest to scale", () => {
    const t = timetable(plan(chain([["sear beef", 10], ["braise beef", 300, true], ["plate stew", 5]])), "first");
    expect(t.total).toBe(315);
    expect(t.breaks).toEqual([{ start: 10, end: 310, minutes: 300 }]);
    expect(t.axis.span).toBe(10 + BREAK_DRAWN_MINUTES + 5);
    expect(drawnMinutes(t, 160)).toBeCloseTo(10 + BREAK_DRAWN_MINUTES / 2, 9);
    expect(t.chapters.map((c) => [c.kind, c.name, c.start, c.end])).toEqual([
      ["wait", "Beef braises", 0, 310],
      ["finish", "Finish and plate", 310, 315],
    ]);
  });
});

describe("runs per lane", () => {
  it("are at most 4 across cooking and moved prep together", () => {
    // As I go: four stir runs on the sauce, and the parsley chop lands in its last simmer
    const sauce = [
      ...chain([["stir onion", 4], ["simmer onion", 10, true], ["stir garlic", 4], ["simmer garlic", 10, true], ["stir tomato", 4], ["simmer tomato", 10, true]], "Sauce", "s"),
      task({ id: "chop", kind: "mise", label: "chop parsley", branch: "Sauce", ...min(5) }),
      task({ id: "cream", label: "stir cream", branch: "Sauce", needs: ["s5", "chop"], ...min(4) }),
      task({ id: "x", label: "toss salad", branch: "Salad", ...min(4) }),
    ];
    const lane = timetable(plan(sauce), "go").blocks.filter((b) => b.lane === "Sauce");
    // five runs: the closest two (the first two stirs, 10 min apart, the earliest such) merge
    expect(lane.map((b) => [b.sand, b.start, b.end])).toEqual([
      [false, 0, 18],
      [false, 28, 32],
      [false, 42, 46],
      [true, 33, 38],
    ]);
  });

  it("hold across many branches mixing cooking and moved prep", () => {
    const tasks = ["Beans", "Greens", "Rice"].flatMap((b, i) => [
      task({ id: `${b}-chop`, kind: "mise", label: `chop ${["onion", "garlic", "scallion"][i]}`, branch: b, ...min(3) }),
      task({ id: `${b}-sear`, label: `sear ${b.toLowerCase()}`, branch: b, ...min(4) }),
      task({ id: `${b}-simmer`, label: `simmer ${b.toLowerCase()}`, branch: b, needs: [`${b}-sear`], ...min(20, true) }),
      task({ id: `${b}-fold`, label: `fold ${["herbs", "butter", "sesame"][i]}`, branch: b, needs: [`${b}-simmer`, `${b}-chop`], ...min(3) }),
    ]);
    const t = timetable(plan(tasks), "go");
    expect(t.lanes.map((l) => l.name)).toEqual(["Beans", "Greens", "Rice"]);
    expect(t.prep).toBeNull();
    for (const b of ["Beans", "Greens", "Rice"]) {
      const lane = t.blocks.filter((x) => x.lane === b);
      expect(lane.length).toBeLessThanOrEqual(4);
      // the chop, moved into this lane's simmer, is its own moved-prep block of mise only
      const sand = lane.filter((x) => x.sand);
      expect(sand.map((x) => x.tasks)).toEqual([[`${b}-chop`]]);
      expect(lane.filter((x) => !x.sand).flatMap((x) => x.tasks).sort()).toEqual([`${b}-fold`, `${b}-sear`]);
    }
    expect(t.pots.map((p) => p.lane)).toEqual(["Beans", "Greens", "Rice"]);
  });
});

describe("lanes, decided", () => {
  it("are one per branch, seven for seven, by first stove step", () => {
    const names = ["Soup", "Bread", "Salad", "Dip", "Rice", "Fish", "Sauce"];
    const tasks = names.map((b, i) => task({ id: `b${i}`, label: "stir pot", branch: b, ...min(3 + i) }));
    const t = timetable(plan(tasks), "first");
    expect(t.lanes.map((l) => l.name)).toEqual(names);
    for (const b of names) expect(t.blocks.filter((x) => x.lane === b)).toHaveLength(1);
  });

  it("leave out a branch that is only ahead work, whose note still shows", () => {
    const p = plan([
      task({ id: "brine", kind: "ahead", label: "brine chicken", branch: "Brine", lead: "overnight", ...min(5) }),
      task({ id: "roast", label: "roast chicken", branch: "Chicken", needs: ["brine"], ...min(40, true) }),
      task({ id: "slaw", label: "toss slaw", branch: "Slaw", ...min(5) }),
    ]);
    const t = timetable(p, "first");
    expect(t.lanes.map((l) => l.name)).toEqual(["Chicken", "Slaw"]);
    expect(t.onePan).toBe(false);
    expect(t.ahead).toEqual([{ lead: "overnight", name: "brine chicken", tasks: ["brine"] }]);
  });

  it("is Board and Stove when only one branch has work on the day", () => {
    const p = plan([
      task({ id: "brine", kind: "ahead", label: "brine chicken", branch: "Brine", lead: "overnight", ...min(5) }),
      task({ id: "roast", label: "roast chicken", branch: "Chicken", needs: ["brine"], ...min(40, true) }),
    ]);
    expect(timetable(p, "first").lanes.map((l) => l.name)).toEqual(["Board", "Stove"]);
  });

  it("shorten only a two-word name, to its last word", () => {
    const p = plan([
      task({ label: "mash potato", branch: "Sweet Potato Mash", ...min(5) }),
      task({ label: "trim beans", branch: "Green Beans", ...min(5) }),
      task({ label: "stir gravy", branch: "Gravy", ...min(5) }),
    ]);
    const short = Object.fromEntries(timetable(p, "first").lanes.map((l) => [l.name, l.short]));
    expect(short).toEqual({ "Sweet Potato Mash": "Sweet Potato Mash", "Green Beans": "Beans", Gravy: "Gravy" });
  });
});

// ---------------------------------------------------------------------------
// The r3 mock: the model is a port of design/overview-arc/r3/index.html
// ---------------------------------------------------------------------------

interface MockMode {
  lanes: string[];
  total: number;
  prepEnd: number;
  span: number;
  drawnTotal: number;
  chapters: { n: number; kind: string; name: string; start: number; end: number; pot: string | null }[];
  blocks: { key: string; lane: string; name: string; short: string; start: number; end: number; sand: boolean; touch: boolean; work: number }[];
  pots: { key: string; lane: string; words: string; short: string; start: number; end: number; equipment: boolean; lead: string; namesChapter: boolean }[];
  breaks: { start: number; end: number; minutes: number }[];
  ahead: { lead: string; name: string }[];
}

const MOCK = JSON.parse(
  readFileSync(new URL("./__tests__/fixtures/timetable-r3-mock.json", import.meta.url), "utf8"),
) as { recipes: Record<string, { first: MockMode; go: MockMode }> };

const ROUND_ONE: Record<string, () => CookPlan> = {
  "skillet-eggs-potatoes-greens": () => kitchenPlan("skillet-eggs-potatoes-greens"),
  "butternut-chickpea-salad": () => kitchenPlan("butternut-chickpea-salad"),
  "tomato-beans-greens": () => kitchenPlan("tomato-beans-greens"),
  "chicken-pita-wraps": () => kitchenPlan("chicken-pita-wraps"),
  "crispy-skin-salmon": () => corpusPlan("crispy-skin-salmon"),
  "sunday-roast-dinner": () => corpusPlan("sunday-roast-dinner"),
};

/**
 * The mock is a reference, not the authority: SPEC and the T1 review rulings are. Where a ruling
 * changes what a round-1 recipe gives, the pinned expectation is adjusted here, with why.
 */
function rulingsOver(name: string, mode: PrepMode, mock: MockMode): MockMode {
  const want: MockMode = structuredClone(mock);
  if (name === "chicken-pita-wraps" && mode === "go") {
    // At most 4 runs per lane across cooking and moved prep (ruling 4; the mock capped each kind).
    // Hummus As I go holds 4 cooking runs and the moved garlic chop: blend (49–62) and plate
    // (68–75), the closest pair, merge into one block named for its longer verb.
    const i = want.blocks.findIndex((b) => b.key === "k:Hummus:blend-tahini");
    const j = want.blocks.findIndex((b) => b.key === "k:Hummus:plate-hummus");
    want.blocks[i] = { ...want.blocks[i], end: want.blocks[j].end, work: want.blocks[i].work + want.blocks[j].work };
    want.blocks.splice(j, 1);
  }
  return want;
}

describe("the round-3 mock's six recipes", () => {
  it("covers all six", () => {
    expect(Object.keys(MOCK.recipes).sort()).toEqual(Object.keys(ROUND_ONE).sort());
  });

  for (const [name, load] of Object.entries(ROUND_ONE)) {
    for (const mode of MODES) {
      it(`${name}, ${mode === "first" ? "Prep first" : "As I go"}: the same model as the mock`, () => {
        const want = rulingsOver(name, mode, MOCK.recipes[name][mode]);
        const t = timetable(load(), mode);
        expect(t.lanes.map((l) => l.name)).toEqual(want.lanes);
        expect(t.total).toBe(want.total);
        expect(t.prep?.end ?? 0).toBe(want.prepEnd);
        expect(t.axis.span).toBe(want.span);
        expect(drawnMinutes(t, t.total)).toBe(want.drawnTotal);
        expect(t.chapters.map(({ n, kind, name: nm, start, end, pot }) => ({ n, kind, name: nm, start, end, pot }))).toEqual(want.chapters);
        expect(
          t.blocks.map(({ key, lane, name: nm, short, start, end, sand, touch, work }) => ({ key, lane, name: nm, short, start, end, sand, touch, work })),
        ).toEqual(want.blocks);
        expect(
          t.pots.map(({ key, lane, words, short, start, end, equipment, lead, namesChapter }) => ({ key, lane, words, short, start, end, equipment, lead, namesChapter })),
        ).toEqual(want.pots);
        expect(t.breaks.map(({ start, end, minutes }) => ({ start, end, minutes }))).toEqual(want.breaks);
        expect(t.ahead.map(({ lead, name: nm }) => ({ lead, name: nm }))).toEqual(want.ahead);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Corpus: every plan the app's tests cook from, in both modes
// ---------------------------------------------------------------------------

const corpus = timetableCorpus;

describe("corpus", () => {
  const cases = corpus().flatMap((c) =>
    MODES.map((mode) => {
      const s = strips(c.plan);
      return { ...c, mode, strip: mode === "first" ? s.first : s.go, t: buildTimetable(c.plan, s.first, s.go, mode) };
    }),
  ).filter((c) => !c.strip.asWritten);

  it("is the whole corpus, both modes", () => {
    expect(cases.length).toBeGreaterThanOrEqual(2 * 20);
    for (const c of cases) expect(c.t, c.name).not.toBeNull();
  });

  for (const c of cases) {
    const label = `${c.name} (${c.mode})`;
    const t = c.t as Timetable;

    it(`${label}: every hands-on block is named or a touch, at most 4 named per lane`, () => {
      for (const b of t.blocks) {
        if (!b.touch) {
          expect(b.name, b.key).toMatch(/\S/);
          expect(b.short, b.key).toMatch(/\S/);
        }
      }
      for (const lane of t.lanes) {
        expect(t.blocks.filter((b) => b.lane === lane.name && !b.touch).length, lane.name).toBeLessThanOrEqual(4);
      }
    });

    it(`${label}: at most 4 named chapters tiling the axis`, () => {
      expect(t.chapters.length).toBeGreaterThanOrEqual(1);
      expect(t.chapters.length).toBeLessThanOrEqual(4);
      expect(t.chapters[0].start).toBe(0);
      expect(t.chapters[t.chapters.length - 1].end).toBe(t.total);
      t.chapters.forEach((ch, i) => {
        expect(ch.n).toBe(i + 1);
        expect(ch.name).toMatch(/\S/);
        expect(ch.end).toBeGreaterThan(ch.start);
        if (i) expect(ch.start).toBe(t.chapters[i - 1].end);
        if (ch.kind === "wait") expect(ch.pot, ch.name).not.toBeNull();
      });
      // the chapter that ends at the total is always the finish (SPEC §4.2, §4.6), and only it
      const last = t.chapters[t.chapters.length - 1];
      expect(last.kind).toBe("finish");
      expect(last.pot).toBeNull();
      expect(last.name).toBe(t.chapters.some((ch) => ch.kind === "wait") ? "Finish and plate" : "Cook and plate");
      expect(t.chapters.filter((ch) => ch.kind === "finish")).toHaveLength(1);
    });

    it(`${label}: minutes conserve the strip's`, () => {
      expect(t.total).toBe(c.strip.totalMinutes);
      expect(t.chapters.reduce((s, ch) => s + ch.minutes, 0)).toBeCloseTo(c.strip.totalMinutes, 9);
      const prepMark = c.strip.marks.find((m) => m.key === "prep");
      expect(t.prep?.end ?? null).toBe(prepMark ? prepMark.end : null);
      // The model's blocks and pots hold exactly the strip's step tasks: each once, none extra.
      const steps = c.strip.marks.filter((m) => m.key !== "prep");
      const seen = new Map<string, number>();
      for (const id of [...t.blocks.flatMap((b) => b.tasks), ...t.pots.flatMap((p) => p.tasks)]) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      const want = steps.flatMap((m) => m.tasks);
      expect([...seen.keys()].sort()).toEqual([...want].sort());
      for (const [id, n] of seen) expect(n, id).toBe(1);
      // and each step sits inside the block or pot holding it
      for (const m of steps) {
        const holder = [...t.blocks, ...t.pots].find((h) => h.tasks.includes(m.tasks[0]));
        expect(holder, m.key).toBeDefined();
        expect(holder!.start, m.key).toBeLessThanOrEqual(m.start);
        expect(holder!.end, m.key).toBeGreaterThanOrEqual(m.end);
        for (const id of m.tasks) expect(holder!.tasks, m.key).toContain(id);
      }
      // hands-on work is the hands-on steps' scheduled minutes, all of it
      const byId = new Map(c.plan.tasks.map((x) => [x.id, x]));
      const handsOn = steps
        .filter((m) => !m.pot)
        .flatMap((m) => m.tasks)
        .reduce((s, id) => {
          const x = byId.get(id)!;
          return s + (x.minutes?.handsOff ? 0 : taskMinutes(x));
        }, 0);
      expect(t.blocks.reduce((s, b) => s + b.work, 0)).toBeCloseTo(handsOn, 9);
      for (const br of t.breaks) expect(br.minutes).toBeGreaterThanOrEqual(30);
    });

    it(`${label}: names carry no dish word and no qualifier`, () => {
      // The dish is the lane: its words never name the object ("slice", not "slice cucumbers",
      // on the Cucumber Pickles lane). The verb may echo a lane named for an action ("cookies
      // bake" on Bake), so only the object words are checked against the lane.
      const check = (text: string, object: string[], lane: string | null, what: string) => {
        const dish = lane ? laneWords(lane) : new Set<string>();
        for (const w of object) expect(dish.has(w), `${what} "${text}" names its dish (${lane})`).toBe(false);
        for (const w of text.toLowerCase().split(/\s+/)) {
          expect(NAME_QUALIFIERS.has(w), `${what} "${text}" has a qualifier`).toBe(false);
        }
      };
      for (const b of t.blocks) {
        check(b.name, b.name.split(" ").slice(1), b.lane, "block");
        check(b.short, [], b.lane, "short");
      }
      for (const p of t.pots) {
        check(p.words, p.words.split(" ").slice(0, -1), t.onePan ? null : p.lane, "pot");
        check(p.short, [], null, "pot short");
      }
      for (const a of t.ahead) check(a.name, [], null, "ahead");
    });
  }
});
