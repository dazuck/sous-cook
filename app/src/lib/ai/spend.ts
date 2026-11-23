import { and, asc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import { aiUsage, db, kitchens, type AiFeature, type AiUsageProvider } from "../db";
import {
  computeCostMicros,
  getModelPrice,
  MODEL_PRICES,
  readCapEnv,
  type ModelPrice,
  type UsageTokens,
} from "./prices";
import {
  AllowanceUsedError,
  UnpricedModelError,
  type ChatOptions,
  type VisionOptions,
} from "./types";

export type SpendDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Transaction-scoped advisory lock serializing AI monthly cap reservations. */
export const AI_SPEND_LOCK = 5_802_203;

/** Fixed per-call input token overhead (role markers, framing). */
export const AI_CALL_OVERHEAD_TOKENS = 1_024;

/** Conservative per-image input token bound for reservations. */
export const AI_IMAGE_OVERHEAD_TOKENS = 6_000;

/** Number of Google Search queries reserved when search grounding is active. */
export const AI_SEARCH_RESERVATION_QUERIES = 3;

const textEncoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return textEncoder.encode(text).length;
}

export interface MonthBoundsSql {
  start: SQL<Date>;
  end: SQL<Date>;
}

/**
 * Builds SQL expressions for the UTC calendar month start and next-month start
 * from a UTC wall-clock `timestamp` expression (never a `timestamptz`), so
 * adding `interval '1 month'` is unaffected by the Postgres session's TimeZone.
 */
export function monthBounds(utcWallClock?: SQL | Date): MonthBoundsSql {
  const clock: SQL =
    utcWallClock instanceof Date
      ? sql`${utcWallClock.toISOString()}::timestamptz at time zone 'UTC'`
      : (utcWallClock ?? sql`now() at time zone 'UTC'`);
  return {
    start: sql<Date>`date_trunc('month', ${clock}) at time zone 'UTC'`,
    end: sql<Date>`(date_trunc('month', ${clock}) + interval '1 month') at time zone 'UTC'`,
  };
}

/**
 * Whether Google Search grounding is actually attached for this call.
 */
export function isGoogleSearchActive(
  provider: AiUsageProvider,
  options: Pick<ChatOptions, "googleSearch" | "responseFormat">,
): boolean {
  return (
    provider === "google" &&
    options.googleSearch === true &&
    options.responseFormat !== "json"
  );
}

/**
 * Upper-bound token and search estimate for a `chat()` call, used for
 * reserving spend before the provider request goes out.
 */
export function estimateChatUsage(
  provider: AiUsageProvider,
  options: Pick<
    ChatOptions,
    "messages" | "systemPrompt" | "responseSchema" | "thinkingBudget" | "googleSearch" | "responseFormat"
  > & { maxTokens: number },
): UsageTokens {
  let inputBytes = options.systemPrompt ? utf8Bytes(options.systemPrompt) : 0;
  let imageCount = 0;
  for (const msg of options.messages) {
    inputBytes += utf8Bytes(msg.content);
    if (msg.image !== undefined) {
      imageCount += 1;
    }
  }
  if (options.responseSchema !== undefined) {
    inputBytes += utf8Bytes(JSON.stringify(options.responseSchema));
  }

  const inputTokens =
    inputBytes +
    AI_CALL_OVERHEAD_TOKENS +
    imageCount * AI_IMAGE_OVERHEAD_TOKENS;
  const thinking =
    typeof options.thinkingBudget === "number" && options.thinkingBudget > 0
      ? options.thinkingBudget
      : 0;
  const outputTokens = Math.max(0, options.maxTokens) + thinking;
  const searchQueries = isGoogleSearchActive(provider, options)
    ? AI_SEARCH_RESERVATION_QUERIES
    : 0;

  return { inputTokens, outputTokens, searchQueries };
}

/**
 * Upper-bound token estimate for a `vision()` call, used for reserving spend
 * before the provider request goes out.
 */
export function estimateVisionUsage(
  options: Pick<VisionOptions, "prompt" | "thinkingBudget"> & {
    maxTokens: number;
  },
): UsageTokens {
  const inputTokens =
    utf8Bytes(options.prompt) +
    AI_CALL_OVERHEAD_TOKENS +
    AI_IMAGE_OVERHEAD_TOKENS;
  const thinking =
    typeof options.thinkingBudget === "number" && options.thinkingBudget > 0
      ? options.thinkingBudget
      : 0;
  const outputTokens = Math.max(0, options.maxTokens) + thinking;
  return { inputTokens, outputTokens, searchQueries: 0 };
}

function toUtcDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatUtcYearMonth(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export interface ReserveAiCallInput {
  kitchenId: string;
  memberId: string | null;
  feature: AiFeature;
  provider: AiUsageProvider;
  model: string;
  estimate: UsageTokens;
  /** Optional clock override for deterministic tests; defaults to database `now()`. */
  clock?: Date | SQL;
}

export interface AiReservation {
  usageId: string;
  kitchenId: string;
  provider: AiUsageProvider;
  model: string;
  reservedMicros: number;
  reservedSearchQueries: number;
  price: ModelPrice | null;
}

/**
 * Reserves spend for one kitchen-metered model call under `AI_SPEND_LOCK`.
 * Checks both the kitchen's monthly cap and the deployment's overall monthly
 * cap against the current UTC month's spend + this call's upper-bound estimate.
 */
export async function reserveAiCall(
  input: ReserveAiCallInput,
  deps: {
    database?: SpendDb;
    env?: Record<string, string | undefined>;
    prices?: Readonly<Record<string, ModelPrice>>;
  } = {},
): Promise<AiReservation> {
  const database = deps.database ?? db;
  const envCaps = readCapEnv(deps.env ?? process.env);
  const prices = deps.prices ?? MODEL_PRICES;

  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AI_SPEND_LOCK})`);

    const [kitchenRow] = await tx
      .select({
        id: kitchens.id,
        aiMonthlyCapMicros: kitchens.aiMonthlyCapMicros,
      })
      .from(kitchens)
      .where(eq(kitchens.id, input.kitchenId))
      .limit(1);

    if (!kitchenRow) {
      throw new Error(`Kitchen not found for AI metering: ${input.kitchenId}`);
    }

    const kitchenCap = kitchenRow.aiMonthlyCapMicros ?? envCaps.kitchenCapMicros;
    const totalCap = envCaps.totalCapMicros;
    const capInForce = kitchenCap !== null || totalCap !== null;

    const price = getModelPrice(input.model, prices);
    if (!price && capInForce) {
      throw new UnpricedModelError(input.model);
    }

    const reservedMicros = price
      ? computeCostMicros(price, input.estimate)
      : 0;

    const bounds = monthBounds(input.clock);
    const [totals] = await tx
      .select({
        kitchenSpent: sql<string>`coalesce(sum(case when ${aiUsage.kitchenId} = ${input.kitchenId} then (case when ${aiUsage.status} = 'reserved' then ${aiUsage.reservedMicros} else coalesce(${aiUsage.costMicros}, 0) end) else 0 end), 0)::text`,
        totalSpent: sql<string>`coalesce(sum(case when ${aiUsage.status} = 'reserved' then ${aiUsage.reservedMicros} else coalesce(${aiUsage.costMicros}, 0) end), 0)::text`,
        monthStart: bounds.start,
        resetsAt: bounds.end,
      })
      .from(aiUsage)
      .where(
        and(
          gte(aiUsage.createdAt, bounds.start),
          lt(aiUsage.createdAt, bounds.end),
        ),
      );

    const kitchenSpent = BigInt(totals?.kitchenSpent ?? "0");
    const totalSpent = BigInt(totals?.totalSpent ?? "0");
    const reservedBig = BigInt(reservedMicros);
    const monthStart = toUtcDate(totals!.monthStart);
    const resetsAt = toUtcDate(totals!.resetsAt);

    if (
      kitchenCap !== null &&
      (kitchenCap === 0 || kitchenSpent + reservedBig > BigInt(kitchenCap))
    ) {
      throw new AllowanceUsedError("kitchen", resetsAt);
    }

    if (
      totalCap !== null &&
      (totalCap === 0 || totalSpent + reservedBig > BigInt(totalCap))
    ) {
      console.error("[ai-cap] overall monthly cap reached", {
        month: formatUtcYearMonth(monthStart),
      });
      throw new AllowanceUsedError("overall", resetsAt);
    }

    const [inserted] = await tx
      .insert(aiUsage)
      .values({
        kitchenId: input.kitchenId,
        memberId: input.memberId,
        feature: input.feature,
        provider: input.provider,
        model: input.model,
        status: "reserved",
        reservedMicros,
        costMicros: null,
        inputTokens: null,
        outputTokens: null,
        searchQueries: null,
        ...(input.clock instanceof Date
          ? { createdAt: input.clock }
          : input.clock !== undefined
            ? { createdAt: sql`${input.clock} at time zone 'UTC'` }
            : {}),
      })
      .returning({ id: aiUsage.id });

    if (!inserted) {
      throw new Error("Failed to insert ai_usage reservation row");
    }

    return {
      usageId: inserted.id,
      kitchenId: input.kitchenId,
      provider: input.provider,
      model: input.model,
      reservedMicros,
      reservedSearchQueries: input.estimate.searchQueries,
      price,
    };
  });
}

export interface SettleSuccessUsage {
  inputTokens: number;
  outputTokens: number;
  searchQueries?: number;
}

/**
 * Settles a reserved usage row after a successful provider call.
 * A failed database write is logged and swallowed so the paid answer is still
 * returned and the row continues counting at its reservation.
 */
export async function settleAiCall(
  reservation: AiReservation,
  reported: SettleSuccessUsage | undefined,
  database: SpendDb = db,
): Promise<void> {
  const searchQueries =
    reservation.reservedSearchQueries > 0
      ? Math.max(0, Math.trunc(reported?.searchQueries ?? 0))
      : 0;

  let costMicros: number | null;
  let inputTokens: number | null;
  let outputTokens: number | null;

  if (reported === undefined) {
    if (reservation.price !== null) {
      console.warn(
        "[ai-meter] provider returned no usage; settling at reservation",
        {
          usageId: reservation.usageId,
          provider: reservation.provider,
          model: reservation.model,
        },
      );
      costMicros = reservation.reservedMicros;
    } else {
      costMicros = null;
    }
    inputTokens = null;
    outputTokens = null;
  } else {
    inputTokens = Math.max(0, Math.trunc(reported.inputTokens));
    outputTokens = Math.max(0, Math.trunc(reported.outputTokens));
    costMicros = reservation.price
      ? computeCostMicros(reservation.price, {
          inputTokens,
          outputTokens,
          searchQueries,
        })
      : null;
  }

  try {
    await database
      .update(aiUsage)
      .set({
        status: "settled",
        costMicros,
        inputTokens,
        outputTokens,
        searchQueries,
        settledAt: sql`now()`,
      })
      .where(
        and(
          eq(aiUsage.id, reservation.usageId),
          eq(aiUsage.kitchenId, reservation.kitchenId),
        ),
      );
  } catch (error) {
    console.error("[ai-meter] settle failed", {
      usageId: reservation.usageId,
      error,
    });
  }
}

/**
 * Marks a reserved usage row as `failed` after a provider error, counting it
 * at its reservation (or `null` for an unpriced model with no cap in force).
 * A failed database write is logged and swallowed so the caller still receives
 * the provider's error.
 */
export async function failAiCall(
  reservation: AiReservation,
  database: SpendDb = db,
): Promise<void> {
  const costMicros =
    reservation.price !== null ? reservation.reservedMicros : null;
  try {
    await database
      .update(aiUsage)
      .set({
        status: "failed",
        costMicros,
        searchQueries: reservation.reservedSearchQueries,
        settledAt: sql`now()`,
      })
      .where(
        and(
          eq(aiUsage.id, reservation.usageId),
          eq(aiUsage.kitchenId, reservation.kitchenId),
        ),
      );
  } catch (error) {
    console.error("[ai-meter] settle failed", {
      usageId: reservation.usageId,
      error,
    });
  }
}

export interface KitchenSpendRow {
  kitchenId: string;
  slug: string;
  name: string;
  spentMicros: number;
  effectiveCapMicros: number | null;
  overrideCapMicros: number | null;
  callCount: number;
}

export interface FeatureSpendRow {
  feature: AiFeature;
  spentMicros: number;
  callCount: number;
}

export interface StaleReservedRow {
  id: string;
  kitchenSlug: string;
  feature: AiFeature;
  provider: AiUsageProvider;
  model: string;
  reservedMicros: number;
  createdAt: Date;
}

export interface MonthlySpendReport {
  month: string;
  monthStart: Date;
  resetsAt: Date;
  totalSpentMicros: number;
  totalCapMicros: number | null;
  defaultKitchenCapMicros: number | null;
  byKitchen: KitchenSpendRow[];
  byFeature: FeatureSpendRow[];
  staleReserved: StaleReservedRow[];
}

const YEAR_MONTH_PATTERN = /^(2\d{3})-(0[1-9]|1[0-2])$/;

/**
 * Computes the operator spend report for a UTC calendar month (`YYYY-MM`, or
 * the database's current UTC month when omitted).
 */
export async function getMonthlySpendReport(
  options: {
    month?: string;
    clock?: Date | SQL;
    database?: SpendDb;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<MonthlySpendReport> {
  const database = options.database ?? db;
  const envCaps = readCapEnv(options.env ?? process.env);

  let boundsInput: SQL | Date | undefined = options.clock;
  if (options.month !== undefined) {
    if (!YEAR_MONTH_PATTERN.test(options.month)) {
      throw new Error(
        `Invalid month "${options.month}". Expected YYYY-MM with year 2000–2999 and month 01–12 (for example, 2026-11).`,
      );
    }
    boundsInput = sql`${`${options.month}-01`}::timestamp`;
  }

  const bounds = monthBounds(boundsInput);
  const nowExpr: SQL =
    options.clock instanceof Date
      ? sql`${options.clock.toISOString()}::timestamptz`
      : sql`now()`;

  const [windowRow] = await database
    .select({
      monthStart: bounds.start,
      resetsAt: bounds.end,
    })
    .from(sql`(select 1) as _window`);

  const monthStart = toUtcDate(windowRow!.monthStart);
  const resetsAt = toUtcDate(windowRow!.resetsAt);
  const month = formatUtcYearMonth(monthStart);

  const kitchenRows = await database
    .select({
      id: kitchens.id,
      slug: kitchens.slug,
      name: kitchens.name,
      aiMonthlyCapMicros: kitchens.aiMonthlyCapMicros,
    })
    .from(kitchens)
    .orderBy(asc(kitchens.slug));

  const kitchenSpendRows = await database
    .select({
      kitchenId: aiUsage.kitchenId,
      spentMicros: sql<string>`coalesce(sum(case when ${aiUsage.status} = 'reserved' then ${aiUsage.reservedMicros} else coalesce(${aiUsage.costMicros}, 0) end), 0)::text`,
      callCount: sql<number>`count(*)::int`,
    })
    .from(aiUsage)
    .where(
      and(
        gte(aiUsage.createdAt, bounds.start),
        lt(aiUsage.createdAt, bounds.end),
      ),
    )
    .groupBy(aiUsage.kitchenId);

  const spendByKitchenId = new Map<
    string,
    { spentMicros: number; callCount: number }
  >();
  let totalSpentBig = BigInt(0);
  for (const row of kitchenSpendRows) {
    const spentBig = BigInt(row.spentMicros);
    totalSpentBig += spentBig;
    spendByKitchenId.set(row.kitchenId, {
      spentMicros: Number(spentBig),
      callCount: row.callCount,
    });
  }

  const featureRows = await database
    .select({
      feature: aiUsage.feature,
      spentMicros: sql<string>`coalesce(sum(case when ${aiUsage.status} = 'reserved' then ${aiUsage.reservedMicros} else coalesce(${aiUsage.costMicros}, 0) end), 0)::text`,
      callCount: sql<number>`count(*)::int`,
    })
    .from(aiUsage)
    .where(
      and(
        gte(aiUsage.createdAt, bounds.start),
        lt(aiUsage.createdAt, bounds.end),
      ),
    )
    .groupBy(aiUsage.feature)
    .orderBy(asc(aiUsage.feature));

  const staleReservedRows = await database
    .select({
      id: aiUsage.id,
      kitchenSlug: kitchens.slug,
      feature: aiUsage.feature,
      provider: aiUsage.provider,
      model: aiUsage.model,
      reservedMicros: aiUsage.reservedMicros,
      createdAt: aiUsage.createdAt,
    })
    .from(aiUsage)
    .innerJoin(kitchens, eq(aiUsage.kitchenId, kitchens.id))
    .where(
      and(
        eq(aiUsage.status, "reserved"),
        gte(aiUsage.createdAt, bounds.start),
        lt(aiUsage.createdAt, bounds.end),
        lt(aiUsage.createdAt, sql`${nowExpr} - interval '1 hour'`),
      ),
    )
    .orderBy(asc(aiUsage.createdAt), asc(aiUsage.id));

  return {
    month,
    monthStart,
    resetsAt,
    totalSpentMicros: Number(totalSpentBig),
    totalCapMicros: envCaps.totalCapMicros,
    defaultKitchenCapMicros: envCaps.kitchenCapMicros,
    byKitchen: kitchenRows.map((k) => {
      const agg = spendByKitchenId.get(k.id);
      return {
        kitchenId: k.id,
        slug: k.slug,
        name: k.name,
        spentMicros: agg?.spentMicros ?? 0,
        effectiveCapMicros: k.aiMonthlyCapMicros ?? envCaps.kitchenCapMicros,
        overrideCapMicros: k.aiMonthlyCapMicros,
        callCount: agg?.callCount ?? 0,
      };
    }),
    byFeature: featureRows.map((f) => ({
      feature: f.feature,
      spentMicros: Number(BigInt(f.spentMicros)),
      callCount: f.callCount,
    })),
    staleReserved: staleReservedRows,
  };
}
