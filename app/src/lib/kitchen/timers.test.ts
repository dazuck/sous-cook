import { describe, expect, it } from "vitest";
import {
  CHIME_REPEATS,
  CHIMER_STALE_MS,
  CHIME_LATE_MS,
  chimeDue,
  electChimer,
  expiredBetween,
  formatCountdown,
  formatDuration,
  formatFinishedAgo,
  inTimerRange,
  timerView,
  type KitchenTimer,
} from "./timers";

// Ported from the Player's `tests/timers.test.ts` (B5a, A13), reshaped to the
// app's timer; the chime repeats and the chimer are new (A11).

const T0 = Date.UTC(2026, 9, 6, 18, 0, 0);

function timer(over: Partial<KitchenTimer> = {}): KitchenTimer {
  return {
    id: "q1:step-3",
    queueId: "q1",
    recipeName: "Dal",
    stepId: "step-3",
    label: "Simmer dal",
    durationMs: 9 * 60_000,
    endsAtEpochMs: T0 + 9 * 60_000,
    ...over,
  };
}

describe("formatCountdown", () => {
  it.each([
    [90_000, "1:30"],
    [600_000, "10:00"],
    [3_725_000, "1:02:05"],
    [1, "0:01"],
    [0, "0:00"],
    [59_001, "1:00"],
  ])("%i ms reads %s", (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
  });
});

describe("formatDuration", () => {
  it.each([
    [30, "30 sec"],
    [540, "9 min"],
    [5400, "1 h 30 min"],
    [7200, "2 h"],
    [89, "1 min"],
  ])("%i s reads %s", (sec, text) => {
    expect(formatDuration(sec)).toBe(text);
  });
});

describe("formatFinishedAgo", () => {
  it.each([
    [10_000, "Finished just now"],
    [45 * 60_000, "Finished 45 min ago"],
    [135 * 60_000, "Finished 2 h 15 min ago"],
    [120 * 60_000, "Finished 2 h ago"],
  ])("%i ms overdue reads %s", (ms, text) => {
    expect(formatFinishedAgo(ms)).toBe(text);
  });
});

describe("timerView", () => {
  // A timer away from its cook names its recipe, so two "Simmer" clocks, or
  // another cook's alarm on this one's screen, are told apart (B5a verify,
  // M3; B5.md's failure table: "labelled with the recipe and step").
  it("names its recipe first away from its own cook, and only its step on it", () => {
    expect(timerView(timer(), T0, "q1").label).toBe("Simmer dal");
    expect(timerView(timer(), T0, "q2").label).toBe("Dal · Simmer dal");
    expect(timerView(timer(), T0).label).toBe("Dal · Simmer dal");
    // One said by voice belongs to no recipe.
    expect(timerView(timer({ queueId: null, recipeName: null, label: "Timer" }), T0, "q1").label).toBe("Timer");
  });

  it("runs, then enters its final ten seconds, then expires", () => {
    const t = timer();
    expect(timerView(t, T0)).toMatchObject({ phase: "running", digits: "9:00", finalTen: false });
    expect(timerView(t, T0 + 8 * 60_000 + 50_500)).toMatchObject({
      phase: "running",
      digits: "0:10",
      finalTen: true,
    });
    const done = timerView(t, T0 + 9 * 60_000);
    expect(done).toMatchObject({ phase: "expired", digits: "0:00", finishedText: "Finished just now" });
  });

  it("says how long ago a timer finished while the tablet slept (no state but the end time)", () => {
    const view = timerView(timer(), T0 + 9 * 60_000 + 47 * 60_000);
    expect(view.phase).toBe("expired");
    expect(view.finishedText).toBe("Finished 47 min ago");
  });
});

describe("expiredBetween", () => {
  const a = timer({ id: "a", endsAtEpochMs: T0 + 1000 });
  const b = timer({ id: "b", endsAtEpochMs: T0 + 2000 });

  it("finds an end inside the window, exclusive at the start", () => {
    expect(expiredBetween([a, b], T0, T0 + 1000).map((t) => t.id)).toEqual(["a"]);
    expect(expiredBetween([a, b], T0 + 1000, T0 + 2000).map((t) => t.id)).toEqual(["b"]);
  });

  it("covers a long window, as a throttled or sleeping tab's tick does", () => {
    expect(expiredBetween([a, b], T0, T0 + 3_600_000).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("chimeDue (B1 reading 3: every 60 s, up to 5 times)", () => {
  const t = timer({ endsAtEpochMs: T0 });

  it("chimes at the end and each minute after, five times in all", () => {
    const at = (prev: number, now: number) => chimeDue([t], prev, now);
    expect(at(T0 - 500, T0)).toBe(true);
    expect(at(T0, T0 + 500)).toBe(false);
    expect(at(T0 + 59_600, T0 + 60_100)).toBe(true);
    expect(at(T0 + 239_900, T0 + 240_000)).toBe(true);
    expect(at(T0 + 299_900, T0 + 300_100)).toBe(false);
    expect(CHIME_REPEATS).toBe(5);
  });

  it("chimes once for a window holding several due chimes (a throttled tick)", () => {
    expect(chimeDue([t, timer({ id: "b", endsAtEpochMs: T0 + 1 })], T0 - 1, T0 + 65_000)).toBe(true);
  });

  // Independent verify of 11790c5, item 3: a tick that wakes from a sleep
  // sees a window spanning it; only a chime due in the last 90 s sounds (a
  // throttled hidden tab ticks about once a minute and must still chime).
  it("never chimes late after a sleep, and still chimes a throttled tick's minute late", () => {
    expect(CHIME_LATE_MS).toBe(90_000);
    // Slept from before the end to ten minutes after: silent.
    expect(chimeDue([t], T0 - 1_000, T0 + 10 * 60_000)).toBe(false);
    // A throttled tick a minute wide: the end is in it, so it chimes.
    expect(chimeDue([t], T0 - 30_000, T0 + 30_000)).toBe(true);
    // Woken five minutes on: the repeats due in the last 90 s still sound.
    expect(chimeDue([t], T0 - 1_000, T0 + 4 * 60_000 + 10_000)).toBe(true);
    expect(chimeDue([t], T0 - 1_000, T0 + 4 * 60_000 + 95_000)).toBe(false);
  });

  it("never chimes for what was due before the window opened (no late chime after a reload)", () => {
    expect(chimeDue([timer({ endsAtEpochMs: T0 - 10 * 60_000 })], T0, T0 + 500)).toBe(false);
  });

  it("chimes again within the five minutes for a reload just after the end", () => {
    // Expired 30 s before the page loaded: the reload says nothing, the next
    // repeat at +60 s still sounds.
    const e = timer({ endsAtEpochMs: T0 - 30_000 });
    expect(chimeDue([e], T0, T0 + 500)).toBe(false);
    expect(chimeDue([e], T0 + 29_900, T0 + 30_100)).toBe(true);
  });
});

describe("electChimer (A11: one tab chimes, and never nobody)", () => {
  it("a visible tab always takes the chime", () => {
    const r = electChimer({ tab: "other", at: T0 }, "me", true, T0 + 100);
    expect(r).toEqual({ claim: { tab: "me", at: T0 + 100 }, chimer: true });
  });

  it("a hidden tab keeps a chime it holds, so a cook who walked away still hears it", () => {
    const r = electChimer({ tab: "me", at: T0 }, "me", false, T0 + 60_000);
    expect(r).toEqual({ claim: { tab: "me", at: T0 + 60_000 }, chimer: true });
  });

  it("a hidden tab leaves a fresh claim alone", () => {
    const r = electChimer({ tab: "other", at: T0 }, "me", false, T0 + 1000);
    expect(r).toEqual({ claim: null, chimer: false });
  });

  it("a hidden tab takes a stale claim (its holder closed)", () => {
    const r = electChimer({ tab: "other", at: T0 }, "me", false, T0 + CHIMER_STALE_MS + 1);
    expect(r).toEqual({ claim: { tab: "me", at: T0 + CHIMER_STALE_MS + 1 }, chimer: true });
  });

  it("a lone hidden tab with no claim takes it", () => {
    expect(electChimer(null, "me", false, T0).chimer).toBe(true);
  });
});

describe("inTimerRange (A12: 10 s to 12 h)", () => {
  it.each([
    [9, false],
    [10, true],
    [43_200, true],
    [43_201, false],
    [Number.NaN, false],
  ])("%d s is %s", (sec, ok) => {
    expect(inTimerRange(sec)).toBe(ok);
  });
});
