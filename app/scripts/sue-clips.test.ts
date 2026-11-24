import { describe, expect, it } from "vitest";
import { LIMITS, callCostUsd, gainToTarget, pickTakesByPace, problemsWith } from "./sue-clips";

describe("pickTakesByPace", () => {
  const takes = [1.1, 0.9, 1.4, 1.0, 1.25, 1.31].map((seconds, i) => ({ take: i + 1, seconds }));

  it("keeps the quickest and the slowest, and one between, so the three differ in pace", () => {
    const kept = pickTakesByPace(takes, 3);
    expect(kept.map((t) => t.seconds)).toEqual([0.9, 1.25, 1.4]);
  });

  it("skips takes too close to one kept, filling from the rest", () => {
    const close = [1.0, 1.005, 1.01, 1.5].map((seconds, i) => ({ take: i + 1, seconds }));
    const kept = pickTakesByPace(close, 3);
    expect(kept.map((t) => t.seconds)).toEqual([1.0, 1.5]);
  });

  it("gives fewer when there are fewer takes, and none for none", () => {
    expect(pickTakesByPace(takes.slice(0, 2), 3)).toHaveLength(2);
    expect(pickTakesByPace([], 3)).toEqual([]);
    expect(pickTakesByPace(takes, 0)).toEqual([]);
  });
});

describe("what a call costs", () => {
  it("is tokens at the listed rates: 5 in and 31 audio out is a few hundredths of a cent", () => {
    expect(callCostUsd(5, 31)).toBeCloseTo((5 * 0.5 + 31 * 6) / 1e6, 10);
    expect(callCostUsd(5, 31)).toBeLessThan(0.0005);
  });
});

describe("the checks a finished clip passes", () => {
  const good = { seconds: 1.2, peakDb: -1.2, rmsDb: -21 };

  it("passes a clip of about a second at the target level", () => {
    expect(problemsWith("flagged", good)).toEqual([]);
  });

  it("names each way a clip fails", () => {
    expect(problemsWith("a", { ...good, seconds: 0.1 })[0]).toMatch(/too short/);
    expect(problemsWith("a", { ...good, seconds: 5 })[0]).toMatch(/too long/);
    expect(problemsWith("a", { ...good, peakDb: -0.1 })[0]).toMatch(/clip/);
    expect(problemsWith("a", { ...good, peakDb: -20 }).join()).toMatch(/too quiet/);
    expect(problemsWith("a", { ...good, rmsDb: -30 })[0]).toMatch(/target/);
  });

  it("fails a measurement that isn't a number rather than passing it", () => {
    expect(problemsWith("a", { seconds: NaN, peakDb: NaN, rmsDb: NaN }).length).toBeGreaterThan(0);
  });

  it("the gain reaches the target but never past the peak ceiling", () => {
    expect(gainToTarget({ peakDb: -10, rmsDb: -26 })).toBe(5);
    expect(gainToTarget({ peakDb: -3, rmsDb: -26 })).toBe(2);
    expect(LIMITS.peakMaxDb).toBeLessThan(0);
  });
});
