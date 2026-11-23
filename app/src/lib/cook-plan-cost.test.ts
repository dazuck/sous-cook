import { describe, expect, it } from "vitest";
import {
  CostLedger,
  DEFAULT_MAX_USD,
  boundCostUsd,
  callCostUsd,
  describeEstimate,
  estimateCost,
  maxUsdArg,
} from "./cook-plan-cost";

describe("callCostUsd", () => {
  it("prices input at $1.50 and output at $9.00 per million tokens", () => {
    expect(callCostUsd(1_000_000, 0)).toBeCloseTo(1.5);
    expect(callCostUsd(0, 1_000_000)).toBeCloseTo(9);
    expect(callCostUsd(3_300, 1_000)).toBeCloseTo(0.01395);
  });
});

describe("estimateCost", () => {
  it("matches P's arithmetic: 57 recipes is about 74 calls and about a dollar", () => {
    const estimate = estimateCost(57);
    expect(estimate.calls).toBeCloseTo(74.1);
    expect(estimate.inputTokens).toBe(244_530);
    expect(estimate.outputTokens).toBe(74_100);
    expect(estimate.usd).toBeCloseTo(1.03, 2);
  });

  it("is nothing for nothing", () => {
    expect(estimateCost(0)).toEqual({ recipes: 0, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
  });

  it("reads in a sentence with its basis", () => {
    expect(describeEstimate(estimateCost(5), "assumed")).toBe(
      "Estimate for 5 recipe(s): about 6.5 calls, 21,450 input + 6,500 output tokens, about $0.09 (assumed).",
    );
  });
});

describe("CostLedger", () => {
  /** A first call's bound: about 12,500 input bytes and the 8,192-token output budget. */
  const BOUND = { inputTokens: 12_500, outputTokens: 8_192 };
  const RETRY = { inputTokens: 12_500, outputTokens: 16_384 };

  /** A call the ledger allowed, then its report. */
  function call(ledger: CostLedger, bound: typeof BOUND, inputTokens: number, outputTokens: number) {
    expect(ledger.beforeCall(bound)).toBe(true);
    ledger.record({ call: 1, inputTokens, outputTokens, bound });
  }

  it("adds each call's real usage", () => {
    const ledger = new CostLedger(2);
    call(ledger, BOUND, 3_000, 900);
    call(ledger, BOUND, 4_000, 1_100);
    ledger.finishRecipe();
    expect(ledger.calls).toBe(2);
    expect(ledger.spentUsd).toBeCloseTo(callCostUsd(7_000, 2_000));
    expect(ledger.committedUsd).toBeCloseTo(ledger.spentUsd);
    expect(ledger.unreported).toBe(0);
  });

  it("charges a call with no reported tokens (or one that threw) at its bound", () => {
    const ledger = new CostLedger(2);
    call(ledger, BOUND, 0, 0);
    expect(ledger.unreported).toBe(1);
    expect(ledger.spentUsd).toBeCloseTo(boundCostUsd(BOUND));
    expect(ledger.describe()).toMatch(/1 unreported call\(s\) charged at their bound/);
  });

  it("reserves a call's bound until it reports", () => {
    const ledger = new CostLedger(2);
    expect(ledger.beforeCall(BOUND)).toBe(true);
    expect(ledger.spentUsd).toBe(0);
    expect(ledger.committedUsd).toBeCloseTo(boundCostUsd(BOUND));
    ledger.record({ call: 1, inputTokens: 3_000, outputTokens: 1_000, bound: BOUND });
    expect(ledger.committedUsd).toBeCloseTo(callCostUsd(3_000, 1_000));
  });

  it("refuses a call whose bound would pass the cap, at the edge", () => {
    // Room for exactly one first call and nothing more.
    const ledger = new CostLedger(boundCostUsd(BOUND));
    expect(ledger.beforeCall(BOUND)).toBe(true);
    // With that call in flight, even the smallest call is refused.
    expect(ledger.beforeCall({ inputTokens: 1, outputTokens: 0 })).toBe(false);
    ledger.record({ call: 1, inputTokens: 3_000, outputTokens: 1_000, bound: BOUND });
    // Its real usage freed the rest of its reservation, but not room for a retry's bound.
    expect(ledger.beforeCall(RETRY)).toBe(false);
    expect(ledger.refused).toBe(2);
    expect(ledger.spentUsd).toBeLessThanOrEqual(ledger.maxUsd);
  });

  it("never passes the cap with two recipes in flight, each charged its whole bound", () => {
    const ledger = new CostLedger(2);
    const inFlight: Array<typeof BOUND> = [];
    let allowed = 0;
    // Two derivations take turns asking; each allowed call is billed its full bound.
    for (let turn = 0; turn < 100; turn++) {
      const bound = turn % 3 === 0 ? BOUND : RETRY;
      if (ledger.beforeCall(bound)) {
        allowed++;
        inFlight.push(bound);
      }
      if (inFlight.length === 2 || (turn % 2 === 1 && inFlight.length > 0)) {
        const done = inFlight.shift()!;
        ledger.record({ call: 1, inputTokens: done.inputTokens, outputTokens: done.outputTokens, bound: done });
      }
      expect(ledger.committedUsd).toBeLessThanOrEqual(ledger.maxUsd);
    }
    for (const done of inFlight) {
      ledger.record({ call: 1, inputTokens: done.inputTokens, outputTokens: done.outputTokens, bound: done });
    }
    expect(allowed).toBeGreaterThan(5);
    expect(ledger.refused).toBeGreaterThan(0);
    expect(ledger.spentUsd).toBeLessThanOrEqual(2);
  });

  it("counts a call that reports more tokens than its bound, and says so", () => {
    const ledger = new CostLedger(2);
    call(ledger, BOUND, 3_000, 9_000);
    expect(ledger.overBound).toBe(1);
    expect(ledger.describe()).toMatch(/1 call\(s\) reported more tokens than their bound/);
  });

  it("hands a derivation a meter over the same ledger", () => {
    const ledger = new CostLedger(boundCostUsd(BOUND));
    const meter = ledger.meter();
    expect(meter.beforeCall(BOUND, 1)).toBe(true);
    meter.onUsage({ call: 1, inputTokens: 3_000, outputTokens: 1_000, bound: BOUND });
    expect(ledger.calls).toBe(1);
    expect(meter.beforeCall(RETRY, 2)).toBe(false);
  });

  it("estimates the rest from observed means once a recipe finished", () => {
    const ledger = new CostLedger(2);
    expect(ledger.observedEstimate(10)).toBeNull();
    call(ledger, BOUND, 4_000, 2_000);
    ledger.finishRecipe();
    call(ledger, BOUND, 2_000, 1_000);
    call(ledger, BOUND, 2_000, 1_000);
    ledger.finishRecipe();
    expect(ledger.observedEstimate(10)).toEqual({
      recipes: 10,
      calls: 15,
      inputTokens: 40_000,
      outputTokens: 20_000,
      usd: callCostUsd(40_000, 20_000),
    });
  });
});

describe("maxUsdArg", () => {
  it("defaults to $2.00", () => {
    expect(maxUsdArg(["--derive"])).toBe(DEFAULT_MAX_USD);
    expect(DEFAULT_MAX_USD).toBe(2);
  });

  it("reads a positive amount", () => {
    expect(maxUsdArg(["--max-usd", "0.5"])).toBe(0.5);
  });

  it("refuses a missing, zero or non-numeric amount", () => {
    expect(() => maxUsdArg(["--max-usd"])).toThrow(/positive dollar amount/);
    expect(() => maxUsdArg(["--max-usd", "0"])).toThrow(/positive dollar amount/);
    expect(() => maxUsdArg(["--max-usd", "lots"])).toThrow(/positive dollar amount/);
  });
});
