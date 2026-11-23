import { describe, expect, it } from "vitest";
import { emberHolder, type EmberClaims, type EmberHolder } from "./ember-holder";

const NONE: EmberClaims = { alarm: false, finish: false, offer: false, timer: false };

describe("emberHolder: one ember per cook screen (slice V, V2; slice B5a, A10)", () => {
  it("is the step's when nothing else claims it", () => {
    expect(emberHolder(NONE)).toBe("step");
  });

  it("goes to the Finish check on the step's last part", () => {
    expect(emberHolder({ ...NONE, finish: true })).toBe("finish");
  });

  it("goes to a running timer over the step (P42 as accepted)", () => {
    expect(emberHolder({ ...NONE, timer: true })).toBe("timer");
  });

  it("leaves an unstarted offer ink on a step that isn't the last (B5a question 1, as recommended)", () => {
    expect(emberHolder({ ...NONE, offer: true })).toBe("step");
    expect(emberHolder({ ...NONE, offer: true, timer: true })).toBe("timer");
  });

  it("on the last part, gives the ember to the next act: the offer, then Finish (2026-10-03)", () => {
    expect(emberHolder({ ...NONE, finish: true, offer: true })).toBe("offer");
    // Started: the offer is gone and the clock runs; Finish holds it, which
    // reverses slice V's call 4 ("a timer beats Finish").
    expect(emberHolder({ ...NONE, finish: true, timer: true })).toBe("finish");
    expect(emberHolder({ ...NONE, finish: true, offer: true, timer: true })).toBe("offer");
  });

  it("gives an alarm the ember over everything, as danger (DS §1)", () => {
    const claims: EmberClaims[] = [
      { ...NONE, alarm: true },
      { ...NONE, alarm: true, finish: true },
      { ...NONE, alarm: true, finish: true, offer: true },
      { ...NONE, alarm: true, timer: true },
      { alarm: true, finish: true, offer: true, timer: true },
    ];
    for (const c of claims) expect(emberHolder(c), JSON.stringify(c)).toBe("alarm");
  });

  it("decides every combination, one holder each", () => {
    const seen = new Set<EmberHolder>();
    for (const alarm of [false, true])
      for (const finish of [false, true])
        for (const offer of [false, true])
          for (const timer of [false, true]) seen.add(emberHolder({ alarm, finish, offer, timer }));
    expect([...seen].sort()).toEqual(["alarm", "finish", "offer", "step", "timer"]);
  });

  it("reads claims left out as absent", () => {
    expect(emberHolder({ finish: true, timer: false })).toBe("finish");
  });
});

describe("a pair being discussed (slice B5d, D13)", () => {
  it("holds the ember over the next act, a running timer and the step, for its linger", () => {
    for (const finish of [false, true])
      for (const offer of [false, true])
        for (const timer of [false, true]) expect(emberHolder({ discussed: true, finish, offer, timer })).toBe("discussed");
  });

  it("yields to an alarm", () => {
    expect(emberHolder({ alarm: true, discussed: true, finish: true, timer: true })).toBe("alarm");
  });

  it("decides every combination, one holder each", () => {
    const seen = new Set<EmberHolder>();
    for (const alarm of [false, true])
      for (const discussed of [false, true])
        for (const finish of [false, true])
          for (const offer of [false, true])
            for (const timer of [false, true]) seen.add(emberHolder({ alarm, discussed, finish, offer, timer }));
    expect([...seen].sort()).toEqual(["alarm", "discussed", "finish", "offer", "step", "timer"]);
  });
});
