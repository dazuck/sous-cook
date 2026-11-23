/**
 * What deriving cook plans costs, before and during a paid run (slice P,
 * "Cost"): the estimate printed first by `backfill-library-cook-plans` and
 * `generate-pack-cook-plans`, and the ledger of real usage that keeps a run
 * at or under its cap, checked before every model call (`CostLedger`).
 *
 * Price is `gemini-3.5-flash` (the default text model; thinking budget 0, so
 * no thinking tokens): $1.50 per 1M input and $9.00 per 1M output, the
 * conservative figure from P's Cost section (checked 2026-10-10).
 */

import type { CallBound, DerivationUsage, DeriveMeter } from "./kitchen/cook-plan-derive";

export const PRICE_USD_PER_M_TOKENS = { input: 1.5, output: 9 } as const;

/** Tokens a call is assumed to take before any is measured (P "Cost"). */
export const ASSUMED_CALL_TOKENS = { input: 3_300, output: 1_000 } as const;

/** Calls a recipe is assumed to take: 1, 2 on a rejected reply, a retry on truncation. */
export const ASSUMED_CALLS_PER_RECIPE = 1.3;

/** The default cap of a paid run, in dollars. */
export const DEFAULT_MAX_USD = 2;

export function boundCostUsd(bound: CallBound): number {
  return callCostUsd(bound.inputTokens, bound.outputTokens);
}

export function callCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * PRICE_USD_PER_M_TOKENS.input + outputTokens * PRICE_USD_PER_M_TOKENS.output) / 1_000_000
  );
}

export interface CostEstimate {
  recipes: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** The estimate for `recipes` derivations at the assumed (or observed) per-recipe cost. */
export function estimateCost(
  recipes: number,
  perRecipe: { calls: number; inputTokens: number; outputTokens: number } = {
    calls: ASSUMED_CALLS_PER_RECIPE,
    inputTokens: ASSUMED_CALLS_PER_RECIPE * ASSUMED_CALL_TOKENS.input,
    outputTokens: ASSUMED_CALLS_PER_RECIPE * ASSUMED_CALL_TOKENS.output,
  },
): CostEstimate {
  const inputTokens = Math.round(recipes * perRecipe.inputTokens);
  const outputTokens = Math.round(recipes * perRecipe.outputTokens);
  return {
    recipes,
    calls: Math.round(recipes * perRecipe.calls * 10) / 10,
    inputTokens,
    outputTokens,
    usd: callCostUsd(inputTokens, outputTokens),
  };
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function describeEstimate(estimate: CostEstimate, basis: string): string {
  return (
    `Estimate for ${estimate.recipes} recipe(s): about ${estimate.calls} calls, ` +
    `${estimate.inputTokens.toLocaleString("en-US")} input + ${estimate.outputTokens.toLocaleString("en-US")} output tokens, ` +
    `about ${formatUsd(estimate.usd)} (${basis}).`
  );
}

/**
 * The running spend of a paid run, and the cap it never passes.
 *
 * Every model call is checked before it is made (`beforeCall`, the
 * derive's `DeriveMeter`): it goes ahead only if what is spent, plus the
 * bound of every call still in flight, plus its own bound (`CallBound`: its
 * `maxTokens` of output and a byte count of its input) fits under the cap,
 * and its bound stays reserved until it reports. So spend stays at or under
 * the cap with any number of recipes in flight, retries included, as long as
 * no call is billed past its bound (`overBound` counts any that report more).
 * A call that reports no tokens, or throws, is charged at its bound. A
 * refused call ends its recipe unstored (`CookPlanCapReached`, which carries
 * any reply already rejected, for the log). The backfill and the pack
 * proposals then stop and their next run resumes; a Refresh leaves that
 * recipe `pending` and its later recipes still ask (`REFRESH_MAX_USD`).
 */
export class CostLedger {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  unreported = 0;
  overBound = 0;
  refused = 0;
  recipes = 0;
  private pendingInput = 0;
  private pendingOutput = 0;

  constructor(readonly maxUsd: number) {}

  /**
   * May a call with this bound go ahead? If so, its bound is reserved until it reports.
   *
   * Refusals can come early with derivations in flight together (two in the
   * backfill, up to four in a Refresh): each holds its whole bound, about 9
   * cents for a first call, until it reports about 2 cents. So a call is
   * refused when the in-flight bounds fill the room, though the cap would
   * have had room for it once they reported. Nothing is overspent: the run
   * stops (the backfill) or leaves the recipe `pending` (a Refresh) below the
   * cap, by up to the in-flight bounds, and the next run derives it. Waiting
   * for the in-flight calls to report before refusing would spend closer to
   * the cap, at the cost of a queue here; this refuses at once instead.
   */
  beforeCall(bound: CallBound): boolean {
    const committed = callCostUsd(
      this.inputTokens + this.pendingInput + bound.inputTokens,
      this.outputTokens + this.pendingOutput + bound.outputTokens,
    );
    if (committed > this.maxUsd) {
      this.refused++;
      return false;
    }
    this.pendingInput += bound.inputTokens;
    this.pendingOutput += bound.outputTokens;
    return true;
  }

  /** A call `beforeCall` allowed has reported: release its reservation, charge its tokens (its bound when none). */
  record(usage: DerivationUsage): void {
    this.calls++;
    this.pendingInput -= usage.bound.inputTokens;
    this.pendingOutput -= usage.bound.outputTokens;
    if (usage.inputTokens === 0 && usage.outputTokens === 0) {
      this.unreported++;
      this.inputTokens += usage.bound.inputTokens;
      this.outputTokens += usage.bound.outputTokens;
      return;
    }
    if (usage.inputTokens > usage.bound.inputTokens || usage.outputTokens > usage.bound.outputTokens) {
      this.overBound++;
    }
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }

  /** What a derivation reports to this ledger. */
  meter(): DeriveMeter {
    return { beforeCall: (bound) => this.beforeCall(bound), onUsage: (usage) => this.record(usage) };
  }

  /** One recipe's derivation finished with an outcome (not stopped by the cap). */
  finishRecipe(): void {
    this.recipes++;
  }

  get spentUsd(): number {
    return callCostUsd(this.inputTokens, this.outputTokens);
  }

  /** Spent plus the bounds of the calls still in flight. */
  get committedUsd(): number {
    return callCostUsd(this.inputTokens + this.pendingInput, this.outputTokens + this.pendingOutput);
  }

  /** The estimate for `recipes` more, from the means observed so far; null before any recipe finished. */
  observedEstimate(recipes: number): CostEstimate | null {
    if (this.recipes === 0) return null;
    return estimateCost(recipes, {
      calls: this.calls / this.recipes,
      inputTokens: this.inputTokens / this.recipes,
      outputTokens: this.outputTokens / this.recipes,
    });
  }

  describe(): string {
    const unreported = this.unreported > 0 ? `, ${this.unreported} unreported call(s) charged at their bound` : "";
    const over =
      this.overBound > 0
        ? ` ${this.overBound} call(s) reported more tokens than their bound: the cap's guarantee assumes none, so check the bound.`
        : "";
    return (
      `Spent ${formatUsd(this.spentUsd)} of ${formatUsd(this.maxUsd)}: ${this.calls} call(s) over ${this.recipes} recipe(s), ` +
      `${this.inputTokens.toLocaleString("en-US")} input + ${this.outputTokens.toLocaleString("en-US")} output tokens${unreported}.${over}`
    );
  }
}

/** `--max-usd <n>` from a script's arguments, defaulting to the cap; refuses anything not a positive number. */
export function maxUsdArg(argv: readonly string[]): number {
  const at = argv.indexOf("--max-usd");
  if (at === -1) return DEFAULT_MAX_USD;
  const value = Number(argv[at + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--max-usd needs a positive dollar amount, got "${argv[at + 1] ?? ""}"`);
  }
  return value;
}
