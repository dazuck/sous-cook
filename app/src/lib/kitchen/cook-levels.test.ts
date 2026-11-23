import { describe, expect, it } from "vitest";
import {
  cookView,
  hasPrepScreen,
  initialCookState,
  next,
  type CookState,
} from "./cook-view";
import { identityPlan, parseCookPlan, type CookPlan } from "./cook-plan";
import { strip, type Strip, type StripMark } from "./cook-strip";
import {
  hitOutline,
  nudge,
  readStepDetails,
  restNudge,
  STRETCH_HORIZON_CAP,
  writtenRows,
  walkAway,
} from "./cook-levels";
import {
  loadCookPlanFixtures,
  loadCookPlanSnapshots,
} from "./__tests__/load-cook-plan-fixtures";

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

const makeStrip = (opts: {
  asWritten?: boolean;
  inHandPot?: boolean;
  inHandDur?: number;
  otherStrandStart?: number;
  otherStrandExists?: boolean;
  now?: number;
}) => {
  const dur = opts.inHandDur ?? 10;
  const marks: StripMark[] = [
    {
      key: "cur",
      strand: "Dal",
      state: "in-hand",
      start: 0,
      end: dur,
      screen: 0,
      label: "Simmer dal",
      pot: opts.inHandPot ?? true,
      nominal: false,
      stretch: 0,
      done: false,
      tasks: [],
      lane: null,
    },
  ];
  if (opts.otherStrandExists ?? true) {
    marks.push({
      key: "other",
      strand: "Tarka",
      state: "ahead",
      start: opts.otherStrandStart ?? 6,
      end: 12,
      screen: 1,
      label: "Heat ghee",
      pot: false,
      nominal: false,
      stretch: 0,
      done: false,
      tasks: [],
      lane: null,
    });
  }
  const result: Strip = {
    marks,
    rows: [],
    now: opts.now ?? 0,
    totalMinutes: 30,
    timeToTable: "30 min",
    handsOnLeft: "10 min",
    asWritten: opts.asWritten ?? false,
    stretches: [],
  };
  return result;
};

describe("cook-levels", () => {
  const dal = corpusPlan("indian-dal-tadka");
  const roast = corpusPlan("sunday-roast-dinner");
  const asWritten = identityPlan({
    steps: [
      "Rinse toor dal and boil.",
      "Heat ghee.",
      "Temper whole spices.",
      "Pour into dal and simmer.",
    ],
  });

  describe("nudge (N7)", () => {
    it("names a step still to start, never one already under way in another strand", () => {
      let st = initialCookState("first");
      for (let i = 0; i < 12; i++) {
        const s = strip(roast, st, null);
        const inHand = s.marks.find((m) => m.state === "in-hand");
        if (inHand?.key === "roast-chicken-initial") break;
        st = next(roast, st);
      }
      const s = strip(roast, st, null);
      expect(s.marks.find((m) => m.state === "in-hand")?.key).toBe("roast-chicken-initial");
      // simmer-potatoes runs in the potatoes strand already: the nudge is for what starts next there
      const n = nudge(s, s.now)!;
      expect(n.target.key).toBe("heat-fat");
      expect(n.minutes).toBeGreaterThan(0);
    });

    it("7 vs 8 minutes: 7 minutes returns null, 8 minutes proceeds", () => {
      const s7 = makeStrip({ inHandDur: 7, otherStrandStart: 5 });
      expect(nudge(s7, 0)).toBeNull();

      const s8 = makeStrip({ inHandDur: 8, otherStrandStart: 5 });
      expect(nudge(s8, 0)).not.toBeNull();
      expect(nudge(s8, 0)?.text).toBe("Start the tarka in about 5 minutes");
    });

    it("pot vs hands-on: hands-on returns null, pot proceeds", () => {
      const sHandsOn = makeStrip({ inHandPot: false, inHandDur: 10 });
      expect(nudge(sHandsOn, 0)).toBeNull();

      const sPot = makeStrip({ inHandPot: true, inHandDur: 10 });
      expect(nudge(sPot, 0)).not.toBeNull();
    });

    it("no other strand: returns null", () => {
      const sSingle = makeStrip({ otherStrandExists: false, inHandDur: 10 });
      expect(nudge(sSingle, 0)).toBeNull();
    });

    it("as written: returns null", () => {
      const sWritten = makeStrip({ asWritten: true, inHandDur: 10 });
      expect(nudge(sWritten, 0)).toBeNull();
    });

    it("countdown with a clock, held without one", () => {
      const s = makeStrip({ inHandDur: 15, otherStrandStart: 10 });
      // Without running clock (now = 0): holds at 10 minutes
      expect(nudge(s, 0)?.text).toBe("Start the tarka in about 10 minutes");

      // With running clock (now = 4): counts down to 6 minutes
      expect(nudge(s, 4)?.text).toBe("Start the tarka in about 6 minutes");
    });

    it("now at <= 0: reads Start the {strand} now", () => {
      const s = makeStrip({ inHandDur: 15, otherStrandStart: 10 });
      expect(nudge(s, 10)?.text).toBe("Start the tarka now");
      expect(nudge(s, 11)?.text).toBe("Start the tarka now");
    });

    it("singular at 1: reads 1 minute, plural at > 1 reads minutes", () => {
      const s = makeStrip({ inHandDur: 15, otherStrandStart: 10 });
      expect(nudge(s, 9)?.text).toBe("Start the tarka in about 1 minute");
      expect(nudge(s, 8)?.text).toBe("Start the tarka in about 2 minutes");
    });
  });

  describe("hitOutline: as written, the outline's names (N8)", () => {
    const mark = (key: string): StripMark => ({
      key,
      strand: "Dal",
      state: "ahead",
      start: 0,
      end: 20,
      screen: 0,
      label: "Dal",
      pot: false,
      nominal: false,
      stretch: null,
      done: false,
      tasks: [],
      lane: null,
    });
    const a = mark("a");
    const b = mark("b");
    const names = [
      { rect: { x: 0, y: 300, width: 1280, height: 48 }, mark: a },
      { rect: { x: 0, y: 348, width: 1280, height: 48 }, mark: b },
    ];

    it("reads the name whose band is under the finger, edges included", () => {
      expect(hitOutline(150, 310, names)).toBe(a);
      expect(hitOutline(1280, 348, names)).toBe(a);
      expect(hitOutline(5, 390, names)).toBe(b);
    });

    it("reads nothing off every band, and nothing with no names", () => {
      expect(hitOutline(150, 299, names)).toBeNull();
      expect(hitOutline(150, 397, names)).toBeNull();
      expect(hitOutline(150, 310, [])).toBeNull();
    });
  });

  describe("readStepDetails (Step 14, N8)", () => {
    it("derives step words and minutes for prep mark", () => {
      const state = initialCookState("first");
      const s = strip(dal, state);
      const prepMark = s.marks.find((m) => m.key === "prep")!;

      const details = readStepDetails(prepMark, dal, state);
      expect(details.isCurrent).toBe(true);
      expect(details.text).toBeTruthy();
      expect(details.minutes).toBeTruthy();
    });

    it("derives step words, minutes, and isCurrent for cooking steps", () => {
      const state = initialCookState("first");
      const s = strip(dal, state);
      const dalMark = s.marks.find((m) => m.key === "cook-dal")!;

      // At initial state (on prep), cook-dal is not current
      const detailsAhead = readStepDetails(dalMark, dal, state);
      expect(detailsAhead.isCurrent).toBe(false);
      expect(detailsAhead.text).toContain("Rinse the toor dal");
      expect(detailsAhead.minutes).toBe("25 min");

      // Advance to cook-dal screen (screen 2)
      const stateOnDal: CookState = { ...state, pos: dalMark.screen };
      const detailsCurrent = readStepDetails(dalMark, dal, stateOnDal);
      expect(detailsCurrent.isCurrent).toBe(true);
    });

    it("derives as-written step words from steps array or task", () => {
      const steps = ["Chop vegetables.", "Roast in oven for 30 minutes."];
      const plan = identityPlan({ steps });
      const state = initialCookState("first");
      const s = strip(plan, state);

      const mark0 = s.marks[0];
      const mark1 = s.marks[1];

      const d0 = readStepDetails(mark0, plan, state, steps);
      expect(d0.text).toBe("Chop vegetables.");
      expect(d0.isCurrent).toBe(true);

      const d1 = readStepDetails(mark1, plan, state, steps);
      expect(d1.text).toBe("Roast in oven for 30 minutes.");
      expect(d1.isCurrent).toBe(false);
    });
  });

  /** The roast in Prep first: stretches [1], [2–4], [5–8], [9–17]. */
  const roastAt = (pos: number) => strip(roast, advance(roast, initialCookState("first"), pos), null);

  describe("writtenRows (N2-2, as written)", () => {
    it("hides the step in hand and lists the next steps up to STRETCH_HORIZON_CAP", () => {
      const s = strip(asWritten, initialCookState("first"));
      expect(s.stretches).toEqual([]);
      expect(writtenRows(s).map((m) => m.screen)).toEqual([1, 2, 3]);
    });

    it("on the last step lists the step in hand alone; past it, nothing", () => {
      const n = asWritten.tasks.length;
      const last = strip(asWritten, advance(asWritten, initialCookState("first"), n - 1));
      const inHand = last.marks.find((m) => m.state === "in-hand");
      expect(inHand).toBeDefined();
      expect(writtenRows(last)).toEqual([inHand]);
      expect(STRETCH_HORIZON_CAP).toBe(4);
    });
  });

  describe("the strip's stretches on Prep (N2-2)", () => {
    it("in either mode they are the view's chapters, and Prep is in hand when it has a block", () => {
      const plans = loadCookPlanFixtures()
        .map((f) => ({ raw: loadCookPlanSnapshots().get(f.name)?.raw, f }))
        .filter(({ raw }) => raw)
        .map(({ raw, f }) => ({ name: f.name, parsed: parseCookPlan(raw, f.recipe) }))
        .flatMap(({ name, parsed }) => (parsed.ok && hasPrepScreen(parsed.plan) ? [{ name, plan: parsed.plan }] : []));
      expect(plans.length).toBeGreaterThan(5);
      let noBlock = 0;
      for (const { name, plan } of plans) {
        for (const mode of ["first", "go"] as const) {
          const state = initialCookState(mode);
          const s = strip(plan, state, null);
          const view = cookView(plan, { kind: "derived" }, state);
          const where = `${name} ${mode}`;
          const prep = s.marks.find((m) => m.key === "prep");
          if (prep) expect(prep.state, where).toBe("in-hand");
          else {
            // nothing done before cooking (As I go, or a Prep of make-ahead only): no block
            expect(s.marks.some((m) => m.state === "in-hand"), where).toBe(false);
            noBlock++;
          }
          expect(
            s.stretches.map((st) => st.screens),
            where,
          ).toEqual((view.chapters ?? []).filter((c) => c.id !== "prep").map((c) => c.at));
        }
      }
      // the corpus holds both cases
      expect(noBlock).toBeGreaterThan(0);
      expect(noBlock).toBeLessThan(plans.length);
    });
  });

  describe("walkAway (N2-8)", () => {
    it("says the break's free time on the last step of a stretch, and nowhere else", () => {
      const lines = Array.from({ length: 18 }, (_, pos) => walkAway(roastAt(pos))?.text ?? null);
      expect(lines).toEqual([
        null,
        "After this step: about 10 min free. Step away.",
        null,
        null,
        "After this step: about 10 min free. Step away.",
        null,
        null,
        null,
        "After this step: about 50 min free. Step away.",
        null, null, null, null, null, null, null, null,
        null,
      ]);
    });

    it("stands over the break's start and names the step in hand", () => {
      const s = roastAt(8);
      const w = walkAway(s)!;
      expect(w.kind).toBe("step-away");
      expect(w.target.state).toBe("in-hand");
      expect(w.at).toBe(s.stretches[2].free!.from);
      expect(w.minutes).toBe(s.stretches[2].free!.minutes);
    });

    it("says the minutes the strip carries, already rounded down to 5", () => {
      const base = makeStrip({ inHandPot: false, otherStrandExists: false });
      const s: Strip = {
        ...base,
        stretches: [{ screens: [0], free: { from: 10, to: 29, minutes: 15 } }],
      };
      expect(walkAway(s)?.text).toBe("After this step: about 15 min free. Step away.");
    });

    it("is silent as written", () => {
      expect(walkAway(strip(asWritten, initialCookState("first")))).toBeNull();
    });
  });

  describe("restNudge (N2-8)", () => {
    const withBreak = (s: Strip): Strip => ({
      ...s,
      stretches: [{ screens: [0, 1], free: null }],
      marks: s.marks.map((m) => ({ ...m, stretch: 0 })),
    });

    it("prefers the start nudge, which counts down, over the walk-away line", () => {
      const base = makeStrip({ inHandDur: 15, otherStrandStart: 10 });
      const s: Strip = {
        ...base,
        stretches: [{ screens: [0], free: { from: 15, to: 40, minutes: 25 } }],
        marks: base.marks.map((m) => ({ ...m, stretch: m.key === "cur" ? 0 : null })),
      };
      expect(walkAway(s)).not.toBeNull();
      expect(restNudge(s, 0)?.kind).toBe("start");
    });

    it("falls to the walk-away line when no start nudge applies", () => {
      const base = makeStrip({ inHandPot: false, otherStrandExists: false });
      const s: Strip = {
        ...base,
        stretches: [{ screens: [0], free: { from: 10, to: 40, minutes: 30 } }],
      };
      expect(nudge(s, 0)).toBeNull();
      expect(restNudge(s, 0)?.kind).toBe("step-away");
    });

    it("is null with neither", () => {
      expect(restNudge(withBreak(makeStrip({ inHandPot: false })), 0)).toBeNull();
    });
  });
});

