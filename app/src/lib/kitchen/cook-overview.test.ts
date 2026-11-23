import { describe, expect, it } from "vitest";
import type { CookPlan } from "./cook-plan";
import { strip, type Strip, type StripMark } from "./cook-strip";
import { initialCookState, next, type CookState } from "./cook-view";
import { timedKey, timedStrip, type PotTimer } from "./cook-overview";
import { layoutTimetable } from "./timetable-layout";
import { buildTimetable, type Timetable } from "./timetable-model";
import { advanceMeasure as measure } from "./__tests__/advance-measure";
import { loadKitchenPlans } from "./__tests__/load-kitchen-plans";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

/**
 * A plan cooked on to the step after its first pot, so the pot runs: the
 * strip, the pot's mark and the plan.
 */
function runningPot(): { plan: CookPlan; s: Strip; pot: StripMark } {
  for (const f of loadKitchenPlans()) {
    const plan = f.plan;
    let state: CookState = initialCookState("first");
    for (let i = 0; i < 40; i++) {
      const s = strip(plan, state, null, T0);
      const pot = s.marks.find((m) => m.pot && m.state === "running" && m.end - s.now >= 4);
      if (pot) return { plan, s, pot };
      const n = next(plan, state);
      if (n === state) break;
      state = n;
    }
  }
  throw new Error("no fixture runs a pot");
}

describe("timedStrip: the timer decides a carried pot (N3)", () => {
  it("returns the strip as it came with no timers, or none on a pot", () => {
    const { s } = runningPot();
    expect(timedStrip(s, undefined, T0)).toBe(s);
    expect(timedStrip(s, new Map(), T0)).toBe(s);
    expect(timedStrip(s, new Map([["no-such-task", { endsAtEpochMs: T0 + MIN, done: false }]]), T0)).toBe(s);
  });

  it("a running timer ends the pot when it does, running, the plan's minutes aside", () => {
    const { s, pot } = runningPot();
    const timers = new Map<string, PotTimer>([[pot.tasks[0], { endsAtEpochMs: T0 + 2.2 * MIN, done: false }]]);
    const t = timedStrip(s, timers, T0);
    const m = t.marks.find((x) => x.key === pot.key)!;
    expect(m.end).toBe(s.now + 3);
    expect(m.state).toBe("running");
    // Every other mark is the same object.
    for (const x of t.marks) if (x.key !== pot.key) expect(x).toBe(s.marks.find((y) => y.key === x.key));
  });

  it("a timer longer than the plan keeps the pot running past its planned end", () => {
    const { s, pot } = runningPot();
    const timers = new Map<string, PotTimer>([[pot.tasks[0], { endsAtEpochMs: T0 + (pot.end - s.now + 10) * MIN, done: false }]]);
    const m = timedStrip(s, timers, T0).marks.find((x) => x.key === pot.key)!;
    expect(m.end).toBe(pot.end + 10);
    expect(m.state).toBe("running");
  });

  it("a timer that rang, or was stopped, ends the pot now, done", () => {
    const { s, pot } = runningPot();
    for (const t of [
      { endsAtEpochMs: T0 - 1, done: false },
      { endsAtEpochMs: T0 + 5 * MIN, done: true },
    ]) {
      const m = timedStrip(s, new Map([[pot.tasks[0], t]]), T0).marks.find((x) => x.key === pot.key)!;
      expect(m.end).toBe(Math.max(pot.start, s.now));
      expect(m.state).toBe("done");
    }
  });
});

describe("timedKey: what of the timers the timed strip reads (never on a tick)", () => {
  it("is the same on every half-second tick inside a minute, and moves at the minute and when the timer is over", () => {
    const { pot } = runningPot();
    const end = T0 + 10 * MIN + 30_000;
    const timers = new Map<string, PotTimer>([[pot.tasks[0], { endsAtEpochMs: end, done: false }]]);
    const keys = new Set<string>();
    for (let now = end - 4 * MIN; now < end - 3 * MIN; now += 500) keys.add(timedKey(timers, now));
    expect(keys.size).toBe(1);
    expect(timedKey(timers, end - 3 * MIN)).not.toBe(timedKey(timers, end - 3 * MIN - 1));
    expect(timedKey(timers, end)).not.toBe(timedKey(timers, end - 1));
    expect(timedKey(new Map([[pot.tasks[0], { endsAtEpochMs: end, done: true }]]), T0)).toBe(timedKey(timers, end));
    expect(timedKey(undefined, T0)).toBe("");
  });

  it("the same key, the same timed strip: a memo on it is exact", () => {
    const { s, pot } = runningPot();
    const timers = new Map<string, PotTimer>([[pot.tasks[0], { endsAtEpochMs: T0 + 3 * MIN + 12_345, done: false }]]);
    const byKey = new Map<string, Strip>();
    for (let now = T0; now <= T0 + 5 * MIN; now += 500) {
      const k = timedKey(timers, now);
      const t = timedStrip(s, timers, now);
      if (byKey.has(k)) expect(t, `${now - T0} ms`).toEqual(byKey.get(k));
      else byKey.set(k, t);
    }
    expect(byKey.size).toBeGreaterThan(2);
  });
});

describe("a carried pot past the total (overrun)", () => {
  it("can end past the plan's total; once now is held at the total it reads done", () => {
    const { plan, s, pot } = runningPot();
    const past = s.totalMinutes - s.now + 15;
    const timers = new Map<string, PotTimer>([[pot.tasks[0], { endsAtEpochMs: T0 + past * MIN, done: false }]]);
    const timed = timedStrip(s, timers, T0);
    expect(timed.marks.find((m) => m.key === pot.key)!.end).toBeGreaterThan(s.totalMinutes);
    const go = strip(plan, initialCookState("go"), null, T0);
    const own = (t: Timetable | null) => t!.pots.find((p) => p.tasks.includes(pot.tasks[0]))!;
    // Mid-cook it runs; with now held at the total (the cook run past the plan) everything is done, it too.
    expect(own(buildTimetable(plan, timed, go, "first")).done).toBe(false);
    const over = buildTimetable(plan, timed, go, "first", { now: s.totalMinutes + 5 })!;
    expect(over.now).toBe(over.total);
    expect(own(over).done).toBe(true);
    const box = { x: 35, y: 100, w: 890, h: 400 };
    const d = layoutTimetable(over, buildTimetable(plan, timed, go, "go", { now: 0 }), box, { portrait: false, measure, now: true, anchor: "bottom", ground: "paper" });
    const lines = d.marks.filter((m) => m.role === "pot-line" && m.k.startsWith(`pl:${own(over).key}:`));
    expect(lines.length).toBeGreaterThan(0);
    for (const m of lines) expect(m.op).toBe(0.35);
  });
});
