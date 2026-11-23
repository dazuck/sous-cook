import { describe, expect, it } from "vitest";
import {
  COOK_COPY,
  initialCookState,
  next,
  type CookState,
} from "./cook-view";
import { identityPlan, parseCookPlan, type CookPlan } from "./cook-plan";
import {
  cookStrip,
  markColors,
  packRows,
  strip,
  type StripMark,
} from "./cook-strip";
import {
  loadCookPlanFixtures,
  loadCookPlanSnapshots,
} from "./__tests__/load-cook-plan-fixtures";
import type { KitchenTimer } from "./timers";

function corpusPlan(name: string): CookPlan {
  const fixture = loadCookPlanFixtures().find((f) => f.name === name);
  const raw = loadCookPlanSnapshots().get(name)?.raw;
  if (!fixture || !raw) throw new Error(`no corpus plan ${name}`);
  const parsed = parseCookPlan(raw, fixture.recipe);
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return parsed.plan;
}

function advance(plan: CookPlan, state: CookState, steps: number): CookState {
  let s = state;
  for (let i = 0; i < steps; i++) s = next(plan, s);
  return s;
}

describe("cook-strip", () => {
  const dal = corpusPlan("indian-dal-tadka");
  const roast = corpusPlan("sunday-roast-dinner");
  const salmon = corpusPlan("simple-weeknight-salmon");
  const asWritten = identityPlan({
    steps: [
      "Rinse toor dal and boil.",
      "Heat ghee.",
      "Temper whole spices.",
      "Pour into dal and simmer.",
    ],
  });

  it("cookStrip is an alias of strip", () => {
    expect(cookStrip).toBe(strip);
  });

  it("a mark per LaneBar, Prep first", () => {
    const s = strip(dal, initialCookState("first"));
    // Dal has a prep screen, so Prep is marks[0]
    expect(s.marks[0].key).toBe("prep");
    expect(s.marks[0].strand).toBe(COOK_COPY.prepChapter);
    expect(s.marks[0].screen).toBe(0);

    // Following marks correspond to layout bars
    expect(s.marks.length).toBeGreaterThan(1);
    expect(s.marks.slice(1).every((m) => m.screen >= 1)).toBe(true);
  });

  it("marks hasMise and mode in As I go even when all mise is deferred to cooking steps (yogurt)", () => {
    const yogurt = corpusPlan("yogurt-marinated-chicken");
    const s = strip(yogurt, initialCookState("go"));
    expect(s.hasMise).toBe(true);
    expect(s.mode).toBe("go");
    expect(s.onPrep).toBe(true);
    // No upfront prep mark in the timeline strip when all mise happens during cooking
    expect(s.marks.find((m) => m.key === "prep")).toBeUndefined();
  });

  it("strand names: flow item branch, and Prep is prepChapter", () => {
    const s = strip(dal, initialCookState("first"));
    expect(s.marks[0].strand).toBe(COOK_COPY.prepChapter);
    const strands = new Set(s.marks.map((m) => m.strand));
    expect(strands.has("Cook")).toBe(true);
    expect(strands.has("Tempering")).toBe(true);
  });

  it("rows by first-fit packing against prototype outputs for dal and roast", () => {
    // Dal: 1 row for Cook, 1 row for Tempering (plus Prep)
    const dalStrip = strip(dal, initialCookState("first"));
    const dalRows = packRows(dalStrip.marks);
    const dalStrandRows = new Map<string, number>();
    for (const r of dalRows) {
      dalStrandRows.set(r.strand, (dalStrandRows.get(r.strand) ?? 0) + 1);
    }
    expect(dalStrandRows.get("Cook")).toBe(1);
    expect(dalStrandRows.get("Tempering")).toBe(1);

    // Roast: 2 rows for Chicken, 2 rows for Potatoes, 1 for Gravy, 1 for Beans
    const roastStrip = strip(roast, initialCookState("first"));
    const roastRows = packRows(roastStrip.marks);
    const roastStrandRows = new Map<string, number>();
    for (const r of roastRows) {
      roastStrandRows.set(r.strand, (roastStrandRows.get(r.strand) ?? 0) + 1);
    }
    expect(roastStrandRows.get("Chicken")).toBe(2);
    expect(roastStrandRows.get("Potatoes")).toBe(2);
    expect(roastStrandRows.get("Gravy")).toBe(1);
    expect(roastStrandRows.get("Beans")).toBe(1);
  });

  it("colours per state obey tokens and use no bare hex outside tokens", () => {
    const marks: StripMark[] = [
      {
        key: "done-step",
        screen: 1,
        strand: "Cook",
        label: "Done",
        start: 0,
        end: 10,
        pot: false,
        nominal: false,
        stretch: 0,
        state: "done",
        done: false,
        tasks: [],
        lane: null,
      },
      {
        key: "in-hand-step",
        screen: 2,
        strand: "Cook",
        label: "Now",
        start: 10,
        end: 20,
        pot: false,
        nominal: false,
        stretch: 0,
        state: "in-hand",
        done: false,
        tasks: [],
        lane: null,
      },
      {
        key: "pot-step",
        screen: 3,
        strand: "Cook",
        label: "Simmer",
        start: 20,
        end: 40,
        pot: true,
        nominal: false,
        stretch: 0,
        state: "ahead",
        done: false,
        tasks: [],
        lane: null,
      },
      {
        key: "ahead-step",
        screen: 4,
        strand: "Cook",
        label: "Ahead",
        start: 40,
        end: 50,
        pot: false,
        nominal: false,
        stretch: 0,
        state: "ahead",
        done: false,
        tasks: [],
        lane: null,
      },
    ];

    for (const m of marks) {
      const c = markColors(m, false);
      expect(c.base).toMatch(/^var\(--(ink|sand|ember)\)/);
      if (c.ring) {
        expect(c.ring).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      }
    }

    // Done is ink
    expect(markColors(marks[0], false).base).toBe("var(--ink)");
    // In-hand is solid ember
    expect(markColors(marks[1], false)).toEqual({
      base: "var(--ember)",
    });
    // Hands-free (pot) is Sand
    expect(markColors(marks[2], false).base).toBe("var(--sand)");
    // Hands-on ahead is solid ink
    expect(markColors(marks[3], false).base).toBe("var(--ink)");

    // Cooked as written
    expect(markColors(marks[0], true).base).toBe("var(--ink)");
    expect(markColors(marks[1], true)).toEqual({
      base: "var(--ember)",
    });
    expect(markColors(marks[3], true).base).toBe("var(--ink)");
  });

  it("now with and without a running timer (capped at step's end)", () => {
    // Dal step 1 (screen 1: cook-dal) runs 14 to 39 (start: 14, end: 39)
    const onCookDal = advance(dal, initialCookState("first"), 1);

    // Without timer: now is step start (14)
    const withoutTimer = strip(dal, onCookDal, null);
    expect(withoutTimer.now).toBe(14);

    // With timer running: 10 minutes elapsed -> now is 24
    const timer10m: KitchenTimer = {
      id: "timer-1",
      queueId: "queue-1",
      recipeName: "Indian dal tadka",
      stepId: "cook-dal",
      label: "Cook dal",
      durationMs: 25 * 60_000,
      endsAtEpochMs: Date.now() + 15 * 60_000, // 10 minutes elapsed
    };
    const withTimer = strip(dal, onCookDal, timer10m);
    expect(withTimer.now).toBe(24);

    // With timer elapsed beyond step end (e.g. 30 min elapsed on 25 min step):
    // capped at step end (39)
    const timer30m: KitchenTimer = {
      id: "timer-1",
      queueId: "queue-1",
      recipeName: "Indian dal tadka",
      stepId: "cook-dal",
      label: "Cook dal",
      durationMs: 25 * 60_000,
      endsAtEpochMs: Date.now() - 5 * 60_000, // over by 5 min
    };
    const capped = strip(dal, onCookDal, timer30m);
    expect(capped.now).toBe(39);
  });

  it("back on Prep mid-cook: now holds where Next resumes; Prep mark reads in hand and done", () => {
    const first = initialCookState("first");
    // Start on Prep, advance 2 steps (cook-dal is done, now on heat-ghee)
    const onHeatGhee = advance(dal, first, 2);
    const backOnPrep = { ...onHeatGhee, pos: 0 };

    const s = strip(dal, backOnPrep);
    // Now holds where Next resumes (heat-ghee starts at 28)
    expect(s.now).toBe(28);
    // Prep mark reads in-hand and done/revisit
    const prepMark = s.marks.find((m) => m.key === "prep")!;
    expect(prepMark.state).toBe("in-hand");
    expect(prepMark.revisit).toBe(true);

    // On Prep before any step is done: now is 0
    const startPrep = strip(dal, first);
    expect(startPrep.now).toBe(0);
    expect(startPrep.marks[0].revisit).toBeUndefined();
  });

  it("the time to the table is rounded up to 5, and Ready at 0", () => {
    const s = strip(dal, initialCookState("first"));
    // Total is 46 min, rounded up to 5 is 50 min
    expect(s.timeToTable).toBe("50 min");

    // At completion (or past end), time to table is Ready
    const finishedState: CookState = {
      ...initialCookState("first"),
      pos: 10,
      ticked: new Set(dal.tasks.map((t) => t.id)),
      passed: new Set(dal.tasks.map((t) => t.id)),
    };
    const finishedStrip = strip(dal, finishedState);
    expect(finishedStrip.timeToTable).toBe("Ready");
  });

  it("hands-on time left, and no hands-on line at 0 (durationText never called with 0)", () => {
    const s = strip(dal, initialCookState("first"));
    expect(s.handsOnLeft).toMatch(/hands-on$/);

    // When all hands-on tasks are done or past now:
    const handsOnZeroState: CookState = {
      ...initialCookState("first"),
      pos: 6, // at end of cook
      ticked: new Set(dal.tasks.map((t) => t.id)),
      passed: new Set(dal.tasks.map((t) => t.id)),
    };
    const atEnd = strip(dal, handsOnZeroState);
    expect(atEnd.handsOnLeft).toBeNull();
  });

  it("nominal marks have nominal: true and count in total", () => {
    const s = strip(asWritten, initialCookState("first"));
    expect(s.marks.every((m) => m.nominal)).toBe(true);
    expect(s.totalMinutes).toBe(8);
  });

  it("a step a Go jumped over stays to come, though its time is behind now", () => {
    const at = advance(dal, initialCookState("first"), 1);
    const s0 = strip(dal, at);
    const garnish = s0.marks.find((m) => m.key.includes("garnish"))!;
    const jumped = strip(dal, { ...at, pos: garnish.screen });
    const ghee = jumped.marks.find((m) => m.key === "heat-ghee")!;
    expect(ghee.end).toBeLessThanOrEqual(jumped.now);
    expect(ghee.state).toBe("ahead");
  });

  it("as written, a mark is named by its step's own words, not its first three", () => {
    const s = strip(asWritten, initialCookState("first"));
    expect(s.marks.map((m) => m.label)).toEqual([
      "Rinse toor dal and boil.",
      "Heat ghee.",
      "Temper whole spices.",
      "Pour into dal and simmer.",
    ]);
  });

  it("recipes cooked as written: equal marks, no axis, outline, and N steps to go", () => {
    const s = strip(asWritten, initialCookState("first"));
    expect(s.asWritten).toBe(true);
    expect(s.timeToTable).toBe("4 steps to go");
    expect(s.outline?.length).toBe(4);
    expect(s.marks[0].state).toBe("in-hand");
    expect(s.marks[1].state).toBe("ahead");

    // Advance 1 step
    const s1 = strip(asWritten, { ...initialCookState("first"), pos: 1 });
    expect(s1.timeToTable).toBe("3 steps to go");
    expect(s1.marks[0].state).toBe("done");
    expect(s1.marks[1].state).toBe("in-hand");

    // All steps done
    const sDone = strip(asWritten, { ...initialCookState("first"), pos: 4 });
    expect(sDone.timeToTable).toBe("Ready");
  });

  it("single-strand recipe (salmon) has one strand and marks in one lane", () => {
    const s = strip(salmon, initialCookState("first"));
    const strands = new Set(s.marks.map((m) => m.strand));
    // Excluding Prep, exactly one cooking strand
    const cookStrands = [...strands].filter((st) => st !== COOK_COPY.prepChapter);
    expect(cookStrands.length).toBe(1);
  });

  it("generated 34-step plan is supported cleanly", () => {
    const synthetic = identityPlan({
      steps: Array.from({ length: 34 }, (_, i) => `Synthetic step ${i + 1}.`),
    });
    const s = strip(synthetic, initialCookState("first"));
    expect(s.marks.length).toBe(34);
    expect(s.timeToTable).toBe("34 steps to go");
    expect(s.stretches).toEqual([]);
    expect(s.marks.every((m) => m.stretch === null)).toBe(true);
  });

  describe("stretches (N2-1)", () => {
    it("cuts the roast at its breaks, by screen, with each break's free time", () => {
      const s = strip(roast, initialCookState("first"));
      expect(s.stretches.map((x) => x.screens)).toEqual([
        [1],
        [2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12, 13, 14, 15, 16, 17],
      ]);
      expect(s.stretches.map((x) => x.free?.minutes ?? null)).toEqual([10, 10, 50, null]);
    });

    it("tags each step mark with the stretch holding its screen, and Prep with none", () => {
      for (const mode of ["first", "go"] as const) {
        const s = strip(roast, advance(roast, initialCookState(mode), 3));
        for (const m of s.marks) {
          if (m.screen === 0 && s.marks[0] === m) {
            expect(m.stretch).toBeNull();
            continue;
          }
          expect(m.stretch).not.toBeNull();
          expect(s.stretches[m.stretch!].screens).toContain(m.screen);
        }
      }
    });

    it("keeps the cut as the cook moves: done steps stay in their stretch", () => {
      const fresh = strip(roast, initialCookState("first"));
      const later = strip(roast, advance(roast, initialCookState("first"), 9));
      expect(later.stretches).toEqual(fresh.stretches);
    });
  });
});
