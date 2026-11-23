import { describe, it, expect } from "vitest";
import type { CookPlan, CookTask } from "./cook-plan";
import { identityPlan } from "./cook-plan";
import { flow, timeline, withMiseNeeds, NOMINAL_MINUTES } from "./cook-schedule";
import { randomCookPlan, seeded } from "./__tests__/random-cook-plan";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE } from "./__tests__/zucchini-wraps";

const NONE = new Set<string>();

function t(
  id: string,
  kind: CookTask["kind"],
  minutes: CookTask["minutes"] | null,
  needs: string[] = [],
  branch = "Cook",
): CookTask {
  return {
    id,
    kind,
    text: id,
    label: id,
    ingredientIdx: [],
    sourceStep: null,
    implied: true,
    needs,
    branch,
    ...(minutes ? { minutes } : {}),
  };
}

/** A task the recipe states, at source step `step`. */
function stated(task: CookTask, step: number): CookTask {
  return { ...task, sourceStep: step, implied: false };
}

const on = (est: number) => ({ est, handsOff: false });
const off = (est: number) => ({ est, handsOff: true });

function spans(plan: CookPlan, mode: "first" | "go", ticked = NONE) {
  const tl = timeline(plan, mode, ticked);
  return Object.fromEntries(tl.slots.map((s) => [s.task.id, [s.start, s.end]]));
}

/** Flow as ids: merged cards joined with "+", with the lead in parentheses. */
function order(plan: CookPlan, mode: "first" | "go", ticked = NONE) {
  return flow(plan, mode, ticked).map((item) => {
    const ids = item.tasks.map((x) => x.id).join("+");
    return item.lead ? `${ids} (${item.lead} ${item.during!.id})` : ids;
  });
}

describe("timeline: zucchini wraps", () => {
  it("prep first: a 6-minute prep block, then the cook with fry inside the sauté", () => {
    const tl = timeline(ZUCCHINI_PLAN, "first", NONE);
    expect(tl.prep).toEqual({
      end: 6,
      tasks: ["onion", "scape", "zuc", "greens"],
    });
    expect(spans(ZUCCHINI_PLAN, "first")).toEqual({
      saute: [6, 21],
      fry: [13, 21],
      stir: [21, 22],
      stuff: [22, 25],
      chili: [25, 26],
    });
    expect(tl.total).toBe(26);
  });

  it("as I go: mise runs before the sauté and the greens fall inside it", () => {
    const tl = timeline(ZUCCHINI_PLAN, "go", NONE);
    expect(tl.prep).toBeNull();
    // The mockup drew the greens at 7.5–8.5 by hand; the scheduler puts them
    // as late as the cook's hands allow, right before the parathas.
    expect(spans(ZUCCHINI_PLAN, "go")).toEqual({
      onion: [0, 2],
      scape: [2, 3],
      zuc: [3, 5],
      saute: [5, 20],
      greens: [11, 12],
      fry: [12, 20],
      stir: [20, 21],
      stuff: [21, 24],
      chili: [24, 25],
    });
    expect(tl.total).toBe(25);
  });

  it("as I go with mise ticked on the Prep screen: ticked tasks form the prep block", () => {
    const ticked = new Set(["onion", "zuc"]);
    const tl = timeline(ZUCCHINI_PLAN, "go", ticked);
    expect(tl.prep).toEqual({ end: 4, tasks: ["onion", "zuc"] });
    expect(tl.slots.map((s) => s.task.id)).not.toContain("onion");
    expect(spans(ZUCCHINI_PLAN, "go", ticked)).toMatchObject({
      scape: [4, 5],
      saute: [5, 20],
    });
  });

  it("never schedules ahead tasks", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("soak", "ahead", off(600)),
        { ...t("simmer", "cook", off(40), ["soak"]) },
      ],
    };
    expect(timeline(plan, "go", NONE).slots.map((s) => s.task.id)).toEqual([
      "simmer",
    ]);
    expect(timeline(plan, "first", NONE).total).toBe(40);
  });
});

describe("flow: zucchini wraps", () => {
  it("prep first matches the mockup sequence", () => {
    expect(order(ZUCCHINI_PLAN, "first")).toEqual([
      "saute",
      "fry (while saute)",
      "stir",
      "stuff",
      "chili",
    ]);
  });

  it("as I go matches the mockup sequence, sauté mise merged into one card", () => {
    expect(order(ZUCCHINI_PLAN, "go")).toEqual([
      "onion+scape+zuc",
      "saute",
      "greens (while saute)",
      "fry (then saute)",
      "stir",
      "stuff",
      "chili",
    ]);
  });

  it("a merged card spans its tasks", () => {
    const [card] = flow(ZUCCHINI_PLAN, "go", NONE);
    expect([card.start, card.end]).toEqual([0, 5]);
  });

  it("drops mise ticked on the Prep screen from the flow", () => {
    expect(order(ZUCCHINI_PLAN, "go", new Set(["onion", "scape", "zuc"])))
      .toEqual([
        "saute",
        "greens (while saute)",
        "fry (then saute)",
        "stir",
        "stuff",
        "chili",
      ]);
  });

  it("same mode and ticks give the same flow (positions stay stable)", () => {
    expect(flow(ZUCCHINI_PLAN, "go", NONE)).toEqual(
      flow(ZUCCHINI_PLAN, "go", NONE),
    );
  });
});

describe("flow: mise placement", () => {
  // Slice onion, heat oil, cook onions, then add garlic.
  function linear(heatHandsOff: boolean): CookPlan {
    return {
      version: 1,
      tasks: [
        t("slice", "mise", on(2)),
        t("mince", "mise", on(1)),
        t("heat", "cook", heatHandsOff ? off(2) : on(2)),
        t("onions", "cook", on(5), ["heat", "slice"]),
        t("garlic", "cook", on(1), ["onions", "mince"]),
      ],
    };
  }

  it("puts mise into a hands-off window before its consumer when one is free", () => {
    expect(order(linear(true), "go")).toEqual([
      "slice",
      "heat",
      "mince (while heat)",
      "onions",
      "garlic",
    ]);
  });

  it("otherwise puts mise before the hands-on run, never between hot-pan steps", () => {
    expect(order(linear(false), "go")).toEqual([
      "slice+mince",
      "heat",
      "onions",
      "garlic",
    ]);
  });

  it("orders mise by when it is used, not by where the plan lists it", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("parsley", "mise", on(1)),
        t("onion", "mise", on(2)),
        t("sweat", "cook", on(5), ["onion"]),
        t("finish", "cook", on(1), ["sweat", "parsley"]),
      ],
    };
    expect(order(plan, "go")).toEqual(["onion+parsley", "sweat", "finish"]);
  });

  it("does not merge mise from different branches", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("dice", "mise", on(1), [], "Sauce"),
        t("grate", "mise", on(1), [], "Topping"),
        t("cook", "cook", on(5), ["dice", "grate"], "Sauce"),
      ],
    };
    expect(order(plan, "go")).toEqual(["dice", "grate", "cook"]);
  });

  it("keeps a hands-off mise as its own card and schedules into it", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("soak", "mise", off(20)),
        t("chop", "mise", on(2)),
        t("cook", "cook", on(15), ["soak", "chop"]),
      ],
    };
    expect(order(plan, "go")).toEqual(["soak", "chop (while soak)", "cook"]);
  });
});

describe("timeline: recipe order within a branch", () => {
  it("keeps the recipe's order when the plan lists the steps out of it", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        stated(t("heat", "cook", on(2)), 1),
        stated(t("toast", "cook", on(3)), 0),
        stated(t("serve", "cook", on(1), ["heat", "toast"]), 2),
      ],
    };
    expect(order(plan, "go")).toEqual(["toast", "heat", "serve"]);
  });

  it("keeps a step before the next one in its branch without a need between them", () => {
    // The plan says the sauce does not need the browned meat; the recipe
    // still browns first.
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("onion", "mise", on(2), [], "Meat"),
        stated(t("brown", "cook", on(5), ["onion"], "Meat"), 0),
        stated(t("sauce", "cook", on(3), [], "Meat"), 1),
        stated(t("rice", "cook", off(20), [], "Rice"), 2),
        stated(t("serve", "cook", on(1), ["sauce", "rice"], "Serve"), 3),
      ],
    };
    expect(spans(plan, "go")).toEqual({
      rice: [0, 20],
      onion: [10, 12],
      brown: [12, 17],
      sauce: [17, 20],
      serve: [20, 21],
    });
  });

  it("lets the next step in a branch start while a hands-off step runs", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        stated(t("simmer", "cook", off(20)), 0),
        stated(t("toast", "cook", on(5)), 1),
        stated(t("ladle", "cook", on(1), ["simmer", "toast"]), 2),
      ],
    };
    expect(order(plan, "go")).toEqual(["simmer", "toast (while simmer)", "ladle"]);
    expect(spans(plan, "go")).toEqual({
      simmer: [0, 20],
      toast: [0, 5],
      ladle: [20, 21],
    });
    expect(timeline(plan, "go", NONE).total).toBe(21);
  });

  it("pulls a same-branch 'meanwhile' chain to the start of a passive window so the break follows", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("spices", "mise", on(5), [], "Cook"),
        stated(t("roast", "cook", off(75), [], "Cook"), 0),
        stated(t("simmer-fat", "cook", on(3), ["spices"], "Cook"), 1),
        stated(t("steep-fat", "cook", off(15), ["simmer-fat"], "Cook"), 2),
        stated(t("strain-fat", "cook", on(3), ["steep-fat"], "Cook"), 3),
        stated(t("whip", "cook", on(10), ["roast", "strain-fat"], "Cook"), 4),
      ],
    };
    expect(spans(plan, "first")).toEqual({
      roast: [5, 80],
      "simmer-fat": [5, 8],
      "steep-fat": [8, 23],
      "strain-fat": [23, 26],
      whip: [80, 90],
    });
    expect(spans(plan, "go")).toEqual({
      roast: [0, 75],
      spices: [0, 5],
      "simmer-fat": [5, 8],
      "steep-fat": [8, 23],
      "strain-fat": [23, 26],
      whip: [75, 85],
    });
  });

  it("keeps a step waiting on mise the recipe states later ahead of the next step", () => {
    // Step 0 fries the curry paste that step 3 says how to make. The garlic
    // (step 1) is free from the start and the fry is not, but the fry still
    // comes first: the paste is made when step 0 first needs it.
    const plan: CookPlan = {
      version: 1,
      tasks: [
        stated(t("paste", "mise", on(8)), 3),
        stated(t("fry", "cook", on(5), ["paste"]), 0),
        stated(t("garlic", "cook", on(1)), 1),
        stated(t("simmer", "cook", off(15), ["fry", "garlic"]), 2),
      ],
    };
    expect(order(plan, "go")).toEqual(["paste", "fry", "garlic", "simmer"]);
    expect(order(plan, "first")).toEqual(["fry", "garlic", "simmer"]);
  });

  it("keeps the order of two steps a third one needs, when one waits on mise stated later", () => {
    // Step 0 tosses what steps 1 and 2 make; step 1 needs the chili crisp
    // step 3 describes. Both steps are first needed at step 0, so the tie
    // goes to the next use: the noodles are step 1, the cucumbers step 2.
    const plan: CookPlan = {
      version: 1,
      tasks: [
        stated(t("toss", "cook", on(1), ["noodles", "cucumber"]), 0),
        stated(t("noodles", "cook", on(2), ["crisp"]), 1),
        stated(t("cucumber", "cook", on(3)), 2),
        stated(t("crisp", "mise", on(10)), 3),
      ],
    };
    expect(order(plan, "go")).toEqual(["crisp", "noodles", "cucumber", "toss"]);
    expect(order(plan, "first")).toEqual(["noodles", "cucumber", "toss"]);
  });

  // Across branches the order is free: the zucchini wraps' parathas (step 2)
  // run inside the sauté (step 0) and before the greens (step 1). See "flow:
  // zucchini wraps".
});

describe("timeline: the prep block", () => {
  it("overlaps hands-off prep with the cook's other prep", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("slice", "mise", on(2)),
        t("pickle", "mise", off(25), ["slice"]),
        t("mix", "mise", on(2)),
        t("marinate", "mise", off(18), ["mix"]),
        t("cook", "cook", on(5), ["pickle", "marinate"]),
      ],
    };
    const tl = timeline(plan, "first", NONE);
    expect(tl.prep).toEqual({
      end: 27,
      tasks: ["slice", "pickle", "mix", "marinate"],
    });
    expect(spans(plan, "first")).toEqual({ cook: [27, 32] });
    expect(tl.total).toBe(32);
  });

  it("brings the mise a ticked task needs into the prep block", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("peel", "mise", on(2)),
        t("paste", "mise", on(1), ["peel"]),
        t("fry", "cook", on(5), ["paste"]),
      ],
    };
    const tl = timeline(plan, "go", new Set(["paste"]));
    expect(tl.prep).toEqual({ end: 3, tasks: ["peel", "paste"] });
    expect(tl.slots.map((s) => s.task.id)).toEqual(["fry"]);
  });

  it("closes a set of mise over what it needs", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("peel", "mise", on(2)),
        t("paste", "mise", on(1), ["peel"]),
        t("rub", "mise", on(1), ["paste"]),
        t("chop", "mise", on(1)),
        t("fry", "cook", on(5), ["rub", "chop"]),
      ],
    };
    expect(withMiseNeeds(plan, ["rub"])).toEqual(new Set(["rub", "paste", "peel"]));
    expect(withMiseNeeds(plan, ["chop"])).toEqual(new Set(["chop"]));
    expect(withMiseNeeds(plan, [])).toEqual(new Set());
  });
});

describe("timeline: joins and durations", () => {
  it("starts the long hands-off branch first so both land together", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("a1", "cook", on(3), [], "A"),
        t("a2", "cook", on(3), ["a1"], "A"),
        t("roast", "cook", off(20), [], "B"),
        t("serve", "cook", on(1), ["a2", "roast"], "Serve"),
      ],
    };
    expect(spans(plan, "go")).toEqual({
      roast: [0, 20],
      a1: [14, 17],
      a2: [17, 20],
      serve: [20, 21],
    });
    expect(order(plan, "go")).toEqual([
      "roast",
      "a1 (while roast)",
      "a2 (then roast)",
      "serve",
    ]);
  });

  it("fills the latest free stretch first, so the cook finishes sooner", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("sear", "cook", on(4)),
        t("rest", "cook", off(2), ["sear"]),
        t("bread", "mise", on(3)),
        t("serve", "cook", on(1), ["rest", "bread"]),
      ],
    };
    // Placing the sear first (cook before mise) would push the bread to the
    // front and finish at 10.
    expect(spans(plan, "go")).toEqual({
      sear: [0, 4],
      bread: [4, 7],
      rest: [5, 7],
      serve: [7, 8],
    });
    expect(timeline(plan, "go", NONE).total).toBe(8);
  });

  it("gives tasks without an estimate a nominal hands-on slot and flags it", () => {
    const tl = timeline(identityPlan(ZUCCHINI_RECIPE), "first", NONE);
    expect(tl.slots.every((s) => s.nominal && !s.handsOff)).toBe(true);
    expect(tl.total).toBe(5 * NOMINAL_MINUTES);
  });

  it("runs the as-written plan in recipe order with no prep block", () => {
    const plan = identityPlan(ZUCCHINI_RECIPE);
    expect(timeline(plan, "first", NONE).prep).toBeNull();
    expect(order(plan, "first")).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(order(plan, "go")).toEqual(order(plan, "first"));
  });

  it("lists a hands-off task before a hands-on one that starts with it", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("stew", "cook", on(20), [], "Stew"),
        t("rice", "cook", off(20), [], "Rice"),
        t("serve", "cook", on(1), ["stew", "rice"], "Serve"),
      ],
    };
    expect(spans(plan, "go")).toMatchObject({ stew: [0, 20], rice: [0, 20] });
    expect(order(plan, "go")).toEqual(["rice", "stew (while rice)", "serve"]);
  });

  it("never leads with a hands-off task the cook has not started yet", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("rice", "cook", off(20), [], "Rice"),
        t("dal", "cook", off(20), [], "Dal"),
        t("serve", "cook", on(1), ["rice", "dal"], "Serve"),
      ],
    };
    expect(order(plan, "go")).toEqual(["rice", "dal (while rice)", "serve"]);
  });

  it("starts together what should, whatever decimals the estimates carry", () => {
    // Worked in floating point, 1.2 and 2 minutes back from the finish and
    // 12 forward again leave the simmer a hair after the chop it starts with,
    // and the chop leads.
    const plan: CookPlan = {
      version: 1,
      tasks: [
        stated(t("brown", "cook", on(1), [], "Main"), 0),
        stated(t("simmer", "cook", off(12), ["brown"], "Garnish"), 1),
        stated(t("chop", "cook", on(2), [], "Garnish"), 2),
        stated(t("finish", "cook", on(1.2), ["chop"], "Main"), 3),
      ],
    };
    for (const mode of ["first", "go"] as const) {
      expect(order(plan, mode)).toEqual([
        "brown",
        "simmer",
        "chop (while simmer)",
        "finish (then simmer)",
      ]);
      expect(spans(plan, mode)).toEqual({
        brown: [0, 1],
        simmer: [1, 13],
        chop: [1, 3],
        finish: [3, 4.2],
      });
    }
  });

  it("follows on with then when the window changes, so no two cards open with while", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("roast", "cook", off(30), [], "Roast"),
        t("rice", "cook", off(15), [], "Rice"),
        t("herbs", "cook", on(3), [], "Herbs"),
        t("serve", "cook", on(1), ["roast", "rice", "herbs"], "Serve"),
      ],
    };
    expect(order(plan, "go")).toEqual([
      "roast",
      "rice (while roast)",
      "herbs (then rice)",
      "serve",
    ]);
  });

  it("opens with while again once a stretch with nothing running has passed", () => {
    const plan: CookPlan = {
      version: 1,
      tasks: [
        t("bake", "cook", off(10), [], "Cook"),
        t("glaze", "cook", on(5), [], "Cook"),
        t("cool", "cook", on(4), ["bake", "glaze"], "Cook"),
        t("chill", "cook", off(10), ["cool"], "Cook"),
        t("whip", "cook", on(5), [], "Cook"),
        t("serve", "cook", on(1), ["chill", "whip"], "Cook"),
      ],
    };
    expect(order(plan, "go")).toEqual([
      "bake",
      "glaze (while bake)",
      "cool",
      "chill",
      "whip (while chill)",
      "serve",
    ]);
  });

  it("is empty for an empty plan", () => {
    const empty: CookPlan = { version: 1, tasks: [] };
    expect(timeline(empty, "go", NONE)).toEqual({
      prep: null,
      slots: [],
      total: 0,
    });
    expect(flow(empty, "go", NONE)).toEqual([]);
  });
});

describe("timeline and flow: properties over random plans", () => {
  const rnd = seeded(20260925);
  const cases = Array.from({ length: 600 }, () => {
    const plan = randomCookPlan(rnd);
    const mise = plan.tasks.filter((x) => x.kind === "mise").map((x) => x.id);
    const tickSets = [NONE, new Set(mise), new Set(mise.filter(() => rnd() < 0.5))];
    return (["first", "go"] as const).flatMap((mode) =>
      tickSets.map((ticked) => ({ plan, mode, ticked })),
    );
  }).flat();

  /** Replays a failing case: the plan as [id, kind, step, branch, needs, minutes]. */
  const describeCase = (c: (typeof cases)[number]) =>
    JSON.stringify({
      mode: c.mode,
      ticked: [...c.ticked],
      tasks: c.plan.tasks.map((x) => [
        x.id,
        x.kind,
        x.sourceStep,
        x.branch,
        x.needs,
        x.minutes,
      ]),
    });

  function check(failures: string[], c: (typeof cases)[number]) {
    if (failures.length > 0) {
      throw new Error(`${failures.join("; ")}\n${describeCase(c)}`);
    }
  }

  function needEdges(plan: CookPlan) {
    const byId = new Map(plan.tasks.map((x) => [x.id, x]));
    return plan.tasks
      .filter((b) => b.kind !== "ahead")
      .flatMap((b) =>
        b.needs.filter((a) => byId.get(a)!.kind !== "ahead").map((a) => [a, b.id]),
      );
  }

  it("places every task but the ahead ones exactly once, in the timeline and the flow", () => {
    for (const c of cases) {
      const tl = timeline(c.plan, c.mode, c.ticked);
      const placed = [...(tl.prep?.tasks ?? []), ...tl.slots.map((s) => s.task.id)];
      const flowed = flow(c.plan, c.mode, c.ticked).flatMap((i) => i.tasks.map((x) => x.id));
      const expected = c.plan.tasks.filter((x) => x.kind !== "ahead").map((x) => x.id);
      const failures: string[] = [];
      if (placed.length !== expected.length || new Set(placed).size !== placed.length) {
        failures.push(`timeline places ${placed}`);
      }
      if ([...expected].sort().join() !== [...placed].sort().join()) {
        failures.push(`timeline places ${placed}, not ${expected}`);
      }
      const inSlots = tl.slots.map((s) => s.task.id);
      if (flowed.join() !== inSlots.join()) {
        failures.push(`flow ${flowed} is not the slots ${inSlots}`);
      }
      check(failures, c);
    }
  });

  it("starts a task only after everything it needs is done", () => {
    for (const c of cases) {
      const tl = timeline(c.plan, c.mode, c.ticked);
      const slot = new Map(tl.slots.map((s) => [s.task.id, s]));
      const prepAt = new Map((tl.prep?.tasks ?? []).map((id, i) => [id, i]));
      const prepEnd = tl.prep?.end ?? 0;
      const flowAt = new Map<string, number>();
      flow(c.plan, c.mode, c.ticked).forEach((item, i) =>
        item.tasks.forEach((x) => flowAt.set(x.id, i)),
      );
      const failures: string[] = [];
      for (const [a, b] of needEdges(c.plan)) {
        const sa = slot.get(a);
        const sb = slot.get(b);
        if (sa && sb && sa.end > sb.start) failures.push(`${a} ends after ${b} starts`);
        if (sa && !sb) failures.push(`${a} is in the cook but ${b} in the prep block`);
        if (!sa && sb && prepEnd > sb.start) failures.push(`${b} starts before prep ends`);
        if (!sa && !sb && prepAt.get(a)! > prepAt.get(b)!) {
          failures.push(`prep lists ${b} before ${a}`);
        }
        if (sa && sb && flowAt.get(a)! > flowAt.get(b)!) {
          failures.push(`flow shows ${b} before ${a}`);
        }
      }
      check(failures, c);
    }
  });

  it("never needs the cook's hands for two things at once, or before prep ends", () => {
    for (const c of cases) {
      const tl = timeline(c.plan, c.mode, c.ticked);
      const prepEnd = tl.prep?.end ?? 0;
      const handsOn = tl.slots.filter((s) => !s.handsOff);
      const failures: string[] = [];
      for (const s of tl.slots) {
        if (s.start < prepEnd) failures.push(`${s.task.id} starts before prep ends`);
      }
      for (const [i, a] of handsOn.entries()) {
        for (const b of handsOn.slice(i + 1)) {
          if (a.start < b.end && b.start < a.end) {
            failures.push(`${a.task.id} overlaps ${b.task.id}`);
          }
        }
      }
      check(failures, c);
    }
  });

  // The recipe walked a step at a time: take the earliest step not yet placed,
  // place what it still needs (in this same order), then the step. Assumed
  // work counts as after every step; ties go by plan position. Of all the
  // orders the needs allow it reaches step 0 soonest, then step 1, and so on.
  // Comparing two steps alone can't be the rule: if step 0 needs step 2, step 2
  // must come before step 1 or step 0 would wait on step 1.
  function recipeWalk(tasks: CookTask[]): string[] {
    const byId = new Map(tasks.map((x) => [x.id, x]));
    const rank = (x: CookTask) => [x.sourceStep ?? Infinity, tasks.indexOf(x)];
    const earlier = (a: CookTask, b: CookTask) => {
      const [ra, rb] = [rank(a), rank(b)];
      return ra[0] < rb[0] || (ra[0] === rb[0] && ra[1] < rb[1]);
    };
    const walk: string[] = [];
    const placeAll = (ids: Set<string>) => {
      for (;;) {
        let first: CookTask | null = null;
        for (const id of ids) {
          const x = byId.get(id)!;
          if (!walk.includes(id) && (first === null || earlier(x, first))) first = x;
        }
        if (first === null) return;
        const stillNeeds = new Set<string>();
        const visit = (id: string) => {
          for (const n of byId.get(id)!.needs) {
            if (!byId.has(n) || walk.includes(n) || stillNeeds.has(n)) continue;
            stillNeeds.add(n);
            visit(n);
          }
        };
        visit(first.id);
        placeAll(stillNeeds);
        walk.push(first.id);
      }
    };
    placeAll(new Set(byId.keys()));
    return walk;
  }

  it("keeps each branch's steps in the order of the recipe walked a step at a time", () => {
    for (const c of cases) {
      const cooking = c.plan.tasks.filter((x) => x.kind !== "ahead");
      const walk = recipeWalk(cooking);
      const flowAt = new Map<string, number>();
      flow(c.plan, c.mode, c.ticked).forEach((item, i) =>
        item.tasks.forEach((x) => flowAt.set(x.id, i)),
      );
      const failures: string[] = [];
      for (const branch of new Set(cooking.map((x) => x.branch))) {
        const walked = walk.filter((id) => {
          const x = cooking.find((t) => t.id === id)!;
          return x.branch === branch && x.kind === "cook" && x.sourceStep !== null;
        });
        const shown = [...walked].sort((a, b) => flowAt.get(a)! - flowAt.get(b)!);
        if (shown.join() !== walked.join()) {
          failures.push(`${branch} shows ${shown}, not ${walked}`);
        }
      }
      check(failures, c);
    }
  });
});
