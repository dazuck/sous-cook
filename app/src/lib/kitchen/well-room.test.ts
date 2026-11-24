import { describe, expect, it } from "vitest";
import { parseCookPlan } from "./cook-plan";
import { cookView, initialCookState, next, type CookState } from "./cook-view";
import { offerForScreen, timerOffers, type TimerOffer } from "./timer-attach";
import type { KitchenTimer } from "./timers";
import { wellRoom, wellShapes, type WellShape } from "./well-room";
import { ledgeLead } from "@/components/kitchen/TimerLedge";
import { legacyToPackRecipe } from "../pack-convert/convert";
import { fixtureServesEstimate } from "./__tests__/fixture-serves-estimates";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "./__tests__/load-cook-plan-fixtures";

const NOW = 1_800_000_000_000;

const running = (offer: TimerOffer, startedAgoMs: number): KitchenTimer => ({
  id: offer.id,
  queueId: offer.queueId,
  recipeName: offer.recipeName,
  stepId: offer.stepId,
  label: offer.label,
  durationMs: offer.durationMs,
  endsAtEpochMs: NOW - startedAgoMs + offer.durationMs,
});

/** Another cook's clock in the well, there before the step was reached. */
const OTHER: KitchenTimer = {
  id: "q9:s1",
  queueId: "q9",
  recipeName: "Rice",
  stepId: "s1",
  label: "Simmer rice",
  durationMs: 18 * 60_000,
  endsAtEpochMs: NOW + 9 * 60_000,
};

/** The well's clocks as the cook screen hands them over (`CookScreen`'s `timers`): its own clock off the step at the whole cook. */
function well(offer: TimerOffer | null, own: KitchenTimer | null, atWholeCook: boolean, others: readonly KitchenTimer[]) {
  const runningNow = [...others, ...(own ? [own] : [])];
  const stepTimer = offer && own && !atWholeCook ? own : null;
  return { offer, stepTimer, ledge: runningNow.filter((t) => t.id !== stepTimer?.id) };
}

const ids = (timers: readonly KitchenTimer[] | null) => (timers === null ? null : timers.map((t) => t.id).sort());

/** Every stored meal's screens, each with the offer it makes (the derived plans the e2e seed cooks). */
function storedScreens() {
  const snapshots = loadCookPlanSnapshots();
  const out: { meal: string; pos: number; offer: TimerOffer | null }[] = [];
  for (const f of loadCookPlanFixtures()) {
    const raw = snapshots.get(f.name)?.raw;
    if (!raw) continue;
    const parsed = parseCookPlan(raw, f.recipe);
    if (!parsed.ok) continue;
    const converted = legacyToPackRecipe({ name: f.name, ...f.recipe }, { id: f.name, servesEstimate: fixtureServesEstimate(f.name) });
    if (!converted.ok) throw new Error(`${f.name}: ${JSON.stringify(converted.issues)}`);
    const offers = timerOffers(parsed.plan, converted.recipe, { queueId: "q1", recipeName: f.name });
    for (const mode of ["first", "go"] as const) {
      let state: CookState = initialCookState(mode);
      for (let guard = 0; guard < 200; guard++) {
        const view = cookView(parsed.plan, { kind: "derived" }, state);
        const key = view.onPrep ? null : (view.stack[0]?.key ?? null);
        out.push({ meal: `${f.name} (${mode})`, pos: state.pos, offer: key === null ? null : offerForScreen(offers, key) });
        if (view.isLast) break;
        state = next(parsed.plan, state);
      }
    }
  }
  return out;
}

describe("wellRoom: the well holds its room on a step with a timer, so the progress line never jumps (DECISIONS 2026-11-24)", () => {
  const screens = storedScreens();

  it("covers stored meals' steps with timers and without", () => {
    expect(screens.filter((s) => s.offer !== null).length).toBeGreaterThanOrEqual(10);
    expect(screens.filter((s) => s.offer === null).length).toBeGreaterThanOrEqual(50);
  });

  it("a step with no timer holds no room: its line is the whole line, whatever runs in the well", () => {
    for (const s of screens.filter((x) => x.offer === null)) {
      expect(wellRoom(well(null, null, false, []), NOW), `${s.meal} screen ${s.pos}`).toBeNull();
      expect(wellRoom(well(null, null, true, [OTHER]), NOW), `${s.meal} screen ${s.pos}`).toBeNull();
    }
  });

  it("on every step with a timer the room is the same clocks at every moment: not started, started, landing at the whole cook, leaving it, with a second timer running", () => {
    for (const s of screens.filter((x) => x.offer !== null)) {
      const offer = s.offer!;
      const where = `${s.meal} screen ${s.pos}`;
      for (const others of [[], [OTHER]] as const) {
        const own = running(offer, 60_000);
        const moments = [
          ["not started", well(offer, null, false, others)],
          ["started, on the step", well(offer, own, false, others)],
          ["landed at the whole cook", well(offer, own, true, others)],
          ["back on the step", well(offer, own, false, others)],
        ] as const;
        // Where the clock lands (the well at the whole cook) is the room held at every other moment.
        const landed = ids(wellRoom(moments[2][1], NOW));
        expect(landed, where).toEqual(ids([...others, own]));
        for (const [moment, t] of moments) expect(ids(wellRoom(t, NOW)), `${where}, ${moment}, ${others.length} other`).toEqual(landed);
      }
    }
  });

  it("holds the running clock itself while it runs, and before it starts a clock of the step's whole length", () => {
    const offer = screens.find((x) => x.offer !== null)!.offer!;
    const own = running(offer, 90_000);
    expect(wellRoom(well(offer, own, false, []), NOW)).toEqual([own]);
    const [held] = wellRoom(well(offer, null, false, []), NOW)!;
    expect(held).toEqual({ ...own, endsAtEpochMs: NOW + offer.durationMs });
    // At the whole cook the room is the well's own clocks, the very list it draws.
    const landed = well(offer, own, true, [OTHER]);
    expect(wellRoom(landed, NOW)).toBe(landed.ledge);
  });

  /** What the well draws: its lead, and the clock beside it (the soonest of the rest). */
  const drawn = (ledge: readonly KitchenTimer[], at: number): string | null => {
    const lead = ledgeLead(ledge, at);
    if (lead === null) return null;
    const second = ledge.filter((t) => t.id !== lead.id).sort((a, b) => a.endsAtEpochMs - b.endsAtEpochMs)[0];
    return `${ledge.map((t) => t.id).sort().join("+")}|${lead.id}|${second?.id ?? "-"}`;
  };
  const shapeKeys = (shapes: readonly WellShape[] | null) =>
    shapes === null ? null : shapes.map((x) => `${x.timers.map((t) => t.id).sort().join("+")}|${x.lead}|${x.second ?? "-"}`).sort();

  it("the shapes held are the same at every moment, and every well drawn on the step is one of them, whichever clock leads (review round 2)", () => {
    /** A second clock, shorter than the step's: it leads the well alone, and loses the lead to the step's clock as the minutes pass. */
    const SHORT: KitchenTimer = { ...OTHER, id: "q9:s2", label: "Boil", durationMs: 30 * 60_000, endsAtEpochMs: NOW + 40 * 60_000 };
    for (const s of screens.filter((x) => x.offer !== null)) {
      const offer = s.offer!;
      const where = `${s.meal} screen ${s.pos}`;
      for (const others of [[], [OTHER], [OTHER, SHORT]] as const) {
        const own = running(offer, 0);
        const moments = [
          well(offer, null, false, others),
          well(offer, own, false, others),
          well(offer, own, true, others),
        ];
        const held = shapeKeys(wellShapes(moments[0], NOW));
        for (const t of moments) {
          for (const at of [NOW, NOW + 30 * 60_000]) {
            expect(shapeKeys(wellShapes(t, at)), `${where}, ${others.length} other`).toEqual(held);
            const d = drawn(t.ledge, at);
            if (d !== null) expect(held, `${where}, ${others.length} other, drawn ${d}`).toContain(d);
          }
        }
      }
    }
  });

  it("a step with no timer holds no shapes", () => {
    expect(wellShapes(well(null, null, false, [OTHER]), NOW)).toBeNull();
  });
});
