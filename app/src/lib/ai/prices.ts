import { PRICE_USD_PER_M_TOKENS } from "../cook-plan-cost";

export interface ModelPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  searchUsdPerQuery: number;
  checkedAt: string;
  sourceUrl: string;
}

/**
 * Paid rate for Google Search grounding ($14 per 1,000 queries after the free
 * band). Every reported query is metered at the paid rate so caps never
 * undercount.
 */
export const GOOGLE_SEARCH_USD_PER_QUERY = 0.014;

/**
 * Model price table keyed by model id.
 *
 * - `gemini-3.5-flash` rates come from `app/src/lib/cook-plan-cost.ts`
 *   (checked 2026-10-10; re-verify against the pricing page before a paid run).
 * - `gemini-2.5-flash` rates were read on 2026-11-22 (thinking tokens included
 *   in output; re-verify on 1 December 2026 when routing changes).
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gemini-3.5-flash": {
    inputUsdPerMillion: PRICE_USD_PER_M_TOKENS.input,
    outputUsdPerMillion: PRICE_USD_PER_M_TOKENS.output,
    searchUsdPerQuery: GOOGLE_SEARCH_USD_PER_QUERY,
    checkedAt: "2026-10-10",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  "gemini-2.5-flash": {
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 2.5,
    searchUsdPerQuery: GOOGLE_SEARCH_USD_PER_QUERY,
    checkedAt: "2026-11-22",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
};

export function getModelPrice(
  model: string,
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): ModelPrice | null {
  return Object.prototype.hasOwnProperty.call(prices, model)
    ? (prices[model] ?? null)
    : null;
}

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  searchQueries: number;
}

const ZERO = BigInt(0);
const ONE = BigInt(1);
const HUNDRED = BigInt(100);
const TEN_THOUSAND = BigInt(10_000);
const SCALE = BigInt(1_000_000);

/**
 * Computes a call's cost in whole micro-dollars (1 USD = 1,000,000 micros),
 * rounding up once on the row's total using exact integer arithmetic.
 */
export function computeCostMicros(
  price: ModelPrice,
  usage: UsageTokens,
): number {
  const inputTokens = Math.max(0, Math.trunc(usage.inputTokens));
  const outputTokens = Math.max(0, Math.trunc(usage.outputTokens));
  const searchQueries = Math.max(0, Math.trunc(usage.searchQueries));

  // Scale each USD-per-million rate by 1,000,000 to get an exact integer in
  // 1e-6 micro-dollars per token, and each per-query rate to micro-dollars.
  const inputScaled = BigInt(Math.round(price.inputUsdPerMillion * 1_000_000));
  const outputScaled = BigInt(Math.round(price.outputUsdPerMillion * 1_000_000));
  const searchMicros = BigInt(Math.round(price.searchUsdPerQuery * 1_000_000));

  const numerator =
    BigInt(inputTokens) * inputScaled +
    BigInt(outputTokens) * outputScaled +
    BigInt(searchQueries) * searchMicros * SCALE;

  if (numerator <= ZERO) return 0;
  const micros = (numerator + SCALE - ONE) / SCALE;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Computed AI cost exceeds safe integer range");
  }
  return Number(micros);
}

/** Dollars with at most two decimal places, no sign. */
export const CAP_USD_PATTERN = /^\d+(\.\d{1,2})?$/;

export type ParseUsdToMicrosResult =
  | { ok: true; micros: number }
  | { ok: false; reason: "format" | "too-large" };

/**
 * Parses a cap string matching `^\d+(\.\d{1,2})?$` into whole micro-dollars
 * without floating-point arithmetic, distinguishing invalid syntax from an
 * amount too large to store.
 */
export function parseUsdToMicrosResult(raw: string): ParseUsdToMicrosResult {
  if (!CAP_USD_PATTERN.test(raw)) {
    return { ok: false, reason: "format" };
  }
  const [dollarsPart, centsPart = ""] = raw.split(".");
  const paddedCents = centsPart.padEnd(2, "0");
  const cents = BigInt(dollarsPart!) * HUNDRED + BigInt(paddedCents);
  const micros = cents * TEN_THOUSAND;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, reason: "too-large" };
  }
  return { ok: true, micros: Number(micros) };
}

/**
 * Parses a cap string matching `^\d+(\.\d{1,2})?$` into whole micro-dollars
 * without floating-point arithmetic. Returns null if invalid.
 */
export function parseUsdToMicros(raw: string): number | null {
  const result = parseUsdToMicrosResult(raw);
  return result.ok ? result.micros : null;
}

/**
 * Formats whole micro-dollars as a dollar amount using integer arithmetic
 * (for operator output), showing as many decimals as the amount needs and at
 * least two.
 */
export function formatMicrosAsUsd(micros: number): string {
  const whole = BigInt(Math.trunc(micros));
  const sign = whole < ZERO ? "-" : "";
  const abs = whole < ZERO ? -whole : whole;
  const dollars = abs / SCALE;
  const rem = abs % SCALE;
  const frac6 = rem.toString().padStart(6, "0");
  const trimmed = frac6.replace(/0+$/, "");
  const frac = trimmed.length < 2 ? frac6.slice(0, 2) : trimmed;
  return `${sign}$${dollars.toString()}.${frac}`;
}

export interface ParsedCapEnv {
  kitchenCapMicros: number | null;
  totalCapMicros: number | null;
}

/**
 * Reads `SOUS_AI_KITCHEN_CAP_USD` and `SOUS_AI_TOTAL_CAP_USD` from the
 * environment. Unset variables resolve to `null`; an empty string or any
 * non-matching value throws.
 */
export function readCapEnv(
  env: Record<string, string | undefined> = process.env,
): ParsedCapEnv {
  const parseOptional = (name: string): number | null => {
    const raw = env[name];
    if (raw === undefined) return null;
    const parsed = parseUsdToMicrosResult(raw);
    if (!parsed.ok) {
      if (parsed.reason === "too-large") {
        throw new Error(
          `Invalid ${name} value "${raw}". Dollar amount is too large to store.`,
        );
      }
      throw new Error(
        `Invalid ${name} value "${raw}". Expected a plain non-negative dollar amount with at most two decimals (for example, 2 or 0.25).`,
      );
    }
    return parsed.micros;
  };
  return {
    kitchenCapMicros: parseOptional("SOUS_AI_KITCHEN_CAP_USD"),
    totalCapMicros: parseOptional("SOUS_AI_TOTAL_CAP_USD"),
  };
}
