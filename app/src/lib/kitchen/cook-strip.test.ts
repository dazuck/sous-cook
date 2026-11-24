import { describe, expect, it } from "vitest";
import {
  COOK_COPY,
  initialCookState,
  next,
  prepPages,
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
import { timetableCorpus } from "./__tests__/timetable-corpus";
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
  const stirFry = corpusPlan("weeknight-stir-fry");
  /**
   * The dal's prep pages in Prep first (DS v1.59): the four tempering jobs as
   * tick rows (0–12), then the cilantro (12–14). Its k-th cooking step is
   * screen `D + k - 1`, where before that slice (one Prep screen) it was `k`.
   */
  const D = prepPages(dal, "first").length;
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
    // Dal has prep, so Prep is marks[0]: in Prep first it stands for the prep pages
    expect(D).toBe(2);
    expect(s.prepScreen).toBe(false);
    expect(s.marks[0].key).toBe("prep");
    expect(s.marks[0].strand).toBe(COOK_COPY.prepChapter);
    expect(s.marks[0].screen).toBe(0);

    // Following marks correspond to layout bars, after the prep pages
    expect(s.marks.length).toBeGreaterThan(1);
    expect(s.marks.slice(1).every((m) => m.screen >= D)).toBe(true);
    expect(s.marks[1].screen).toBe(D);
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
    // Dal's first cooking step (cook-dal, after the prep pages) runs 14 to 39 (start: 14, end: 39)
    const onCookDal = advance(dal, initialCookState("first"), D);

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

  // Asked 2026-11-22 (DS v1.54): "on the progress bar at the bottom, it should show where you
  // are at the end of that step not the beginning, as it's confusing to be on the last step but
  // still showing a lot of room on the progress bar."
  describe("progress: the line's end is the end of the screen the cook is on", () => {
    const first = initialCookState("first");
    /** The dal, Prep first: total 46; prep 0–14; cook-dal 14–39 (a pot); heat-ghee 28–30; temper-spices 30–31; add-aromatics 31–33; cook-onions-tomatoes 33–39 (a pot); combine-and-simmer 39–45 (a pot); garnish-and-serve 45–46. */
    /** The dal on its `step`-th cooking step, past its prep pages. */
    const dalAt = (step: number) => strip(dal, advance(dal, first, D + step - 1), null);

    it("on step N the fill ends at step N's end, where now is its start", () => {
      const heatGhee = dalAt(2);
      expect(heatGhee.marks.find((m) => m.state === "in-hand")).toMatchObject({ key: "heat-ghee", start: 28, end: 30 });
      expect(heatGhee.now).toBe(28);
      expect(heatGhee.progress).toBe(30);
      const temper = dalAt(3);
      expect([temper.now, temper.progress]).toEqual([30, 31]);
      const aromatics = dalAt(4);
      expect([aromatics.now, aromatics.progress]).toEqual([31, 33]);
    });

    it("on the last step the progress line is full, though its minutes aren't spent", () => {
      const last = dalAt(7);
      expect(last.marks.find((m) => m.state === "in-hand")).toMatchObject({ key: "garnish-and-serve" });
      expect(last.totalMinutes).toBe(46);
      expect(last.now).toBe(45);
      expect(last.progress).toBe(46);
    });

    it("a cook with every step done is the whole line, whichever screen is in view", () => {
      // `next` does nothing on the last screen, so a finished cook is stated: every task passed (the
      // state the time to the table reads "Ready" from).
      const everyTask = new Set(dal.tasks.map((t) => t.id));
      const finishedAt = (pos: number): CookState => ({ ...initialCookState("first"), pos, ticked: everyTask, passed: everyTask });
      // Looking back at Heat ghee (28–30), where an unfinished cook's line ends at 30.
      expect(dalAt(2).progress).toBe(30);
      const lookingBack = strip(dal, finishedAt(D + 1), null);
      expect(lookingBack.timeToTable).toBe("Ready");
      expect([lookingBack.now, lookingBack.progress, lookingBack.totalMinutes]).toEqual([46, 46, 46]);
      // And on the first prep page, on the last step, and past the last screen.
      for (const pos of [0, D + 6, 10]) {
        const s = strip(dal, finishedAt(pos), null);
        expect([s.now, s.progress], `screen ${String(pos)}`).toEqual([46, 46]);
      }
    });

    it("a pot still going when the next step starts ends at that start: the line never steps back", () => {
      // Cook the dal simmers 14–39; the cook leaves its screen for Heat ghee at 28.
      const cookDal = dalAt(1);
      expect(cookDal.marks.find((m) => m.state === "in-hand")).toMatchObject({ key: "cook-dal", start: 14, end: 39, pot: true });
      expect(cookDal.progress).toBe(28);
      expect(dalAt(2).progress).toBeGreaterThanOrEqual(cookDal.progress);
      // A pot the next step waits for ends at its own end.
      expect(dalAt(5).progress).toBe(39);
      expect(dalAt(6).progress).toBe(45);
    });

    it("stands still while the step's timer runs, where now walks on", () => {
      const onCookDal = advance(dal, first, D);
      const timer = (elapsedMin: number): KitchenTimer => ({
        id: "timer-1",
        queueId: "queue-1",
        recipeName: "Indian dal tadka",
        stepId: "cook-dal",
        label: "Cook dal",
        durationMs: 25 * 60_000,
        endsAtEpochMs: Date.now() + (25 - elapsedMin) * 60_000,
      });
      const at10 = strip(dal, onCookDal, timer(10));
      expect(at10.now).toBe(24);
      expect(at10.progress).toBe(28);
      // Even with the timer run out on this screen (now capped at the pot's end, 39).
      const over = strip(dal, onCookDal, timer(30));
      expect(over.now).toBe(39);
      expect(over.progress).toBe(28);
    });

    it("a prep page is a step: the fill ends at the page's end, and the last page's is the prep block's", () => {
      // Prep first (DS v1.59): the dal's two prep pages, 0–12 and 12–14, inside Prep's mark (0–14).
      const page1 = strip(dal, first, null);
      expect(page1.onPrep).toBe(false);
      expect(page1.marks[0]).toMatchObject({ key: "prep", start: 0, end: 14, state: "in-hand", screen: 0 });
      expect([page1.now, page1.progress]).toEqual([0, 12]);
      const page2 = strip(dal, advance(dal, first, 1), null);
      expect(page2.marks[0]).toMatchObject({ key: "prep", state: "in-hand", screen: 1 });
      expect([page2.now, page2.progress]).toEqual([12, 14]);
      // Then the first cooking step picks up where the prep block ends.
      expect(dalAt(1).now).toBe(14);
      expect(dalAt(1).marks[0]).toMatchObject({ key: "prep", state: "done" });
    });

    // Review rounds 1 and 2 of prep pages. The tacos' prep pages overlap on the clock: the onion
    // stands from 0 to 23 while the limes are cut (0–5), the shrimp marinates from 5 to 23, the
    // avocado is sliced (5–10). A page that starts something that keeps going follows the rule a
    // cooking step does (the fill stands at the next page's start, the jar still standing), and the
    // last prep page stands at the block's end, where the step rule left it at 10 of 23. Round 1's
    // "the page's own end" read 23 on all four pages: a line that stands still tells the cook nothing.
    it("a prep page that starts something standing fills to the next page's start, and the last page to the prep block's end", () => {
      const tacos = corpusPlan("lime-shrimp-tacos");
      const pages = prepPages(tacos, "first");
      expect(pages.map((page) => [page.start, page.end])).toEqual([
        [0, 23],
        [0, 5],
        [5, 23],
        [5, 10],
      ]);
      const fills = pages.map((_, i) => strip(tacos, advance(tacos, first, i), null).progress);
      expect(fills).toEqual([0, 5, 5, 23]);
    });

    it("across the fixture cooks: a prep page fills as a cooking step does, the last to the prep block's end, and the fill never steps back", () => {
      let seen = 0;
      let standing = 0;
      for (const { name, plan } of timetableCorpus()) {
        const pages = prepPages(plan, "first");
        let before = 0;
        pages.forEach((page, i) => {
          const s = strip(plan, advance(plan, initialCookState("first"), i), null);
          const where = `${name}, prep page ${String(i + 1)}`;
          const next = pages[i + 1];
          const want =
            next === undefined
              ? Math.max(...pages.map((p) => p.end))
              : Math.max(page.start, Math.min(page.end, next.start));
          expect(s.progress, where).toBe(want);
          if (next === undefined) expect(s.progress, where).toBe(s.marks[0]!.end);
          else if (next.start < page.end) standing++;
          expect(s.progress, where).toBeGreaterThanOrEqual(before);
          before = s.progress;
          seen++;
        });
        // Nor from the last prep page to the first cooking step.
        if (pages.length > 0) {
          const cooking = strip(plan, advance(plan, initialCookState("first"), pages.length), null);
          expect(cooking.progress, `${name}, the first cooking step`).toBeGreaterThanOrEqual(before);
        }
      }
      expect(seen).toBeGreaterThan(20);
      // The case is in the corpus: a page whose job outlasts the next page's start.
      expect(standing).toBeGreaterThan(0);
    });

    it("on the Prep screen it is the end of the up-front prep block; with no such block the line is empty, as before", () => {
      // As I go on the stir-fry: all its mise is done before cooking, 0–17.
      const prep = strip(stirFry, initialCookState("go"), null);
      expect(prep.onPrep).toBe(true);
      expect(prep.prepScreen).toBe(true);
      expect(prep.marks[0]).toMatchObject({ key: "prep", start: 0, end: 17 });
      expect([prep.now, prep.progress]).toEqual([0, 17]);
      // As I go on the dal: a Prep screen, and nothing done up front.
      const go = strip(dal, initialCookState("go"), null);
      expect(go.onPrep).toBe(true);
      expect(go.marks.some((m) => m.key === "prep")).toBe(false);
      expect([go.now, go.progress]).toEqual([0, 0]);
    });

    it("back on the Prep screen mid-cook it holds where Next resumes, as now does", () => {
      // The Prep screen is As I go's: the stir-fry, three steps in, back on Prep.
      const backOnPrep = { ...advance(stirFry, initialCookState("go"), 3), pos: 0 };
      const s = strip(stirFry, backOnPrep);
      expect(s.onPrep).toBe(true);
      expect([s.now, s.progress]).toEqual([26, 26]);
    });

    it("back on a prep page mid-cook it reads as that page, like any step gone back to", () => {
      const backOnPage = { ...advance(dal, first, D + 1), pos: 0 };
      const s = strip(dal, backOnPage);
      expect([s.now, s.progress]).toEqual([0, 12]);
      expect(s.marks[0]).toMatchObject({ key: "prep", state: "in-hand", screen: 0 });
      expect(s.marks[0].revisit).toBeUndefined();
    });

    it("as written it is the end of the bar in hand", () => {
      const written = initialCookState("first");
      expect(strip(asWritten, written).progress).toBe(2);
      const last = strip(asWritten, advance(asWritten, written, 3));
      expect([last.now, last.progress, last.totalMinutes]).toEqual([6, 8, 8]);
    });

    it("across the test corpus's plans, in both modes: never behind the screen's start, never past the total, never back as the cook steps on, full on the last screen", () => {
      let screensSeen = 0;
      for (const { name, plan } of timetableCorpus()) {
        for (const mode of ["first", "go"] as const) {
          let state = initialCookState(mode);
          let before = -1;
          for (let i = 0; i < 80; i++) {
            const s = strip(plan, state, null);
            const where = `${name} (${mode}) screen ${String(state.pos)}`;
            expect(s.progress, where).toBeGreaterThanOrEqual(s.now);
            expect(s.progress, where).toBeLessThanOrEqual(s.totalMinutes);
            expect(s.progress, `${where}: back from ${String(before)}`).toBeGreaterThanOrEqual(before);
            before = s.progress;
            screensSeen++;
            const after = next(plan, state);
            if (after.pos === state.pos) {
              // The last screen in hand (`next` goes no further): the whole line.
              expect(s.progress, `${where}, the last screen`).toBe(s.totalMinutes);
              break;
            }
            state = after;
          }
        }
      }
      expect(screensSeen).toBeGreaterThan(200);
    });
  });

  it("back on the Prep screen mid-cook: now holds where Next resumes; Prep mark reads in hand and done", () => {
    // The Prep screen is As I go's since DS v1.59 (Prep first walks prep
    // pages): the stir-fry, whose mise is all done before cooking.
    const go = initialCookState("go");
    // Start on Prep, advance 3 steps (heat-wok and cook-chicken done, now on cook-veggies)
    const onVeggies = advance(stirFry, go, 3);
    expect(strip(stirFry, onVeggies).marks.find((m) => m.state === "in-hand")!.key).toBe("cook-veggies");
    const backOnPrep = { ...onVeggies, pos: 0 };

    const s = strip(stirFry, backOnPrep);
    // Now holds where Next resumes (cook-veggies starts at 26)
    expect(s.now).toBe(26);
    // Prep mark reads in-hand and done/revisit
    const prepMark = s.marks.find((m) => m.key === "prep")!;
    expect(prepMark.state).toBe("in-hand");
    expect(prepMark.revisit).toBe(true);

    // On Prep before any step is done: now is 0
    const startPrep = strip(stirFry, go);
    expect(startPrep.now).toBe(0);
    expect(startPrep.marks[0].revisit).toBeUndefined();
  });

  it("Prep first: a prep card's mark goes to its own page, and a card cut over pages to its first", () => {
    const first = initialCookState("first");
    // The roast: four cards, four pages, one each.
    const r = strip(roast, first);
    expect(r.prepMarks!.map((m) => [m.key, m.screen, m.state])).toEqual([
      ["prep-potatoes", 0, "in-hand"],
      ["prep-aromatics", 1, "ahead"],
      ["trim-beans", 2, "ahead"],
      ["chop-shallot", 3, "ahead"],
    ]);
    const onBeans = strip(roast, advance(roast, first, 2));
    expect(onBeans.prepMarks!.map((m) => m.state)).toEqual(["done", "done", "in-hand", "ahead"]);
    expect(onBeans.modeOpen).toBe(false);
    expect(r.modeOpen).toBe(true);
    // The stir-fry: one card of six jobs, cut over two pages; one mark, in hand on either.
    const sf = strip(stirFry, first);
    expect(prepPages(stirFry, "first")).toHaveLength(2);
    expect(sf.prepMarks).toHaveLength(1);
    expect(sf.prepMarks![0]).toMatchObject({ screen: 0, state: "in-hand", todo: 6 });
    const sf2 = strip(stirFry, advance(stirFry, first, 1));
    expect(sf2.prepMarks![0]).toMatchObject({ screen: 0, state: "in-hand", todo: 3 });
    expect(sf2.marks[0]).toMatchObject({ key: "prep", screen: 1, todo: 3 });
    // As I go: a prep card's mark goes to the Prep screen, as before.
    const go = strip(stirFry, initialCookState("go"));
    expect(go.prepMarks!.every((m) => m.screen === 0)).toBe(true);
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
      // After the roast's four prep pages (screens 0–3; DS v1.59).
      const s = strip(roast, initialCookState("first"));
      expect(s.stretches.map((x) => x.screens)).toEqual([
        [4],
        [5, 6, 7],
        [8, 9, 10, 11],
        [12, 13, 14, 15, 16, 17, 18, 19, 20],
      ]);
      expect(s.stretches.map((x) => x.free?.minutes ?? null)).toEqual([10, 10, 50, null]);
    });

    it("tags each step mark with the stretch holding its screen, and Prep with none", () => {
      for (const mode of ["first", "go"] as const) {
        const s = strip(roast, advance(roast, initialCookState(mode), 3));
        for (const m of s.marks) {
          if (m.key === "prep") {
            expect(s.marks[0]).toBe(m);
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
