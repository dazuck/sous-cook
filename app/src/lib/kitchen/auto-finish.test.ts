import { describe, expect, it } from "vitest";
import { AUTO_FINISH_IDLE_MS, autoFinishDue, lastScreenActivity } from "./auto-finish";

const T = Date.UTC(2026, 9, 25, 22, 0);
const MIN = 60_000;

describe("lastScreenActivity", () => {
  it("is nothing anywhere but the last screen, however long it sat", () => {
    expect(lastScreenActivity({ onLastScreen: false, lastInteraction: T, timerEnds: [] })).toBeNull();
    expect(autoFinishDue(lastScreenActivity({ onLastScreen: false, lastInteraction: T, timerEnds: [] }))).toBeNull();
  });

  it("is the last interaction on the last screen", () => {
    expect(lastScreenActivity({ onLastScreen: true, lastInteraction: T, timerEnds: [] })).toBe(T);
  });

  it("is the end of a running timer, so the cook is never idle while it runs", () => {
    const ends = T + 30 * MIN;
    const active = lastScreenActivity({ onLastScreen: true, lastInteraction: T, timerEnds: [ends] });
    expect(active).toBe(ends);
    // Due only 45 minutes after the timer is done, never while it runs.
    expect(autoFinishDue(active)).toBe(ends + AUTO_FINISH_IDLE_MS);
  });

  it("is the interaction when it came after a timer ended", () => {
    expect(lastScreenActivity({ onLastScreen: true, lastInteraction: T, timerEnds: [T - 5 * MIN] })).toBe(T);
  });
});

describe("autoFinishDue", () => {
  it("is 45 minutes after the last activity by default", () => {
    expect(AUTO_FINISH_IDLE_MS).toBe(45 * MIN);
    expect(autoFinishDue(T)).toBe(T + 45 * MIN);
  });

  it("takes another wait", () => {
    expect(autoFinishDue(T, 5000)).toBe(T + 5000);
  });
});
