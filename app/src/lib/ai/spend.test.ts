import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

const fakeProvider = await vi.hoisted(async () => {
  const { FakeProviderController } = await import("../__tests__/fake-provider");
  return new FakeProviderController();
});

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);
vi.mock("@/lib/ai/providers/google", () => ({
  createGoogleProvider: () => fakeProvider.provider("google"),
}));
vi.mock("@/lib/ai/providers/anthropic", () => ({
  createAnthropicProvider: () => fakeProvider.provider("anthropic"),
}));

import * as dbModule from "@/lib/db";
import { aiUsage, kitchens } from "../../../drizzle/schema";
import { migratedTestDb } from "../__tests__/test-db";
import { homeKitchen, seedKitchen, type TestDb } from "../__tests__/kitchens";
import { chat, vision } from "./chat";
import { kitchenMeter, scriptMeter } from "./meter";
import {
  MODEL_PRICES,
  computeCostMicros,
  formatMicrosAsUsd,
  getModelPrice,
  parseUsdToMicros,
  parseUsdToMicrosResult,
  readCapEnv,
  type ModelPrice,
} from "./prices";
import {
  AI_CALL_OVERHEAD_TOKENS,
  AI_IMAGE_OVERHEAD_TOKENS,
  AI_SEARCH_RESERVATION_QUERIES,
  estimateChatUsage,
  estimateVisionUsage,
  failAiCall,
  getMonthlySpendReport,
  monthBounds,
  reserveAiCall,
  settleAiCall,
} from "./spend";
import {
  AllowanceUsedError,
  UnpricedModelError,
  findAllowanceUsed,
  formatResetDateUtc,
  isAllowanceUsed,
} from "./types";

const MADE_UP_PRICES: Readonly<Record<string, ModelPrice>> = {
  ...MODEL_PRICES,
  "test-priced-model": {
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 2.0,
    searchUsdPerQuery: 0.014,
    checkedAt: "2026-11-22",
    sourceUrl: "https://example.com/pricing",
  },
};

describe("AI prices and error classes", () => {
  it("formats AllowanceUsedError messages in UTC and walks cause chains", () => {
    const resetsAt = new Date("2026-12-01T00:00:00.000Z");
    expect(formatResetDateUtc(resetsAt)).toBe("1 December");

    const kitchenErr = new AllowanceUsedError("kitchen", resetsAt);
    expect(kitchenErr.name).toBe("AllowanceUsedError");
    expect(kitchenErr.scope).toBe("kitchen");
    expect(kitchenErr.resetsAt).toBe(resetsAt);
    expect(kitchenErr.message).toBe(
      "This kitchen's AI allowance for this month is used up. It resets on 1 December. Cooking from saved plans still works.",
    );

    const overallErr = new AllowanceUsedError("overall", resetsAt);
    expect(overallErr.scope).toBe("overall");
    expect(overallErr.message).toBe(
      "Sous's AI allowance for this month is used up for everyone. It resets on 1 December. Cooking from saved plans still works.",
    );

    const wrapped = new Error("outer", {
      cause: new Error("middle", { cause: kitchenErr }),
    });
    expect(isAllowanceUsed(kitchenErr)).toBe(true);
    expect(isAllowanceUsed(wrapped)).toBe(true);
    expect(findAllowanceUsed(wrapped)).toBe(kitchenErr);
    expect(isAllowanceUsed(new Error("unrelated"))).toBe(false);

    // Cycle in cause chain terminates cleanly.
    const cyclic: Error & { cause?: unknown } = new Error("cycle");
    cyclic.cause = cyclic;
    expect(isAllowanceUsed(cyclic)).toBe(false);
  });

  it("formats UnpricedModelError naming the model and prices file", () => {
    const err = new UnpricedModelError("mystery-model-9");
    expect(err.name).toBe("UnpricedModelError");
    expect(err.model).toBe("mystery-model-9");
    expect(err.message).toBe(
      "no price for model mystery-model-9; add it to app/src/lib/ai/prices.ts",
    );
  });

  it("parses USD cap strings strictly in micro-dollars without floating point", () => {
    expect(parseUsdToMicros("0")).toBe(0);
    expect(parseUsdToMicros("2")).toBe(2_000_000);
    expect(parseUsdToMicros("2.5")).toBe(2_500_000);
    expect(parseUsdToMicros("0.25")).toBe(250_000);
    expect(parseUsdToMicros("10.05")).toBe(10_050_000);

    for (const bad of ["", "-1", "NaN", "1e3", "2.555", "+2", " 2", "2.", ".5"]) {
      expect(parseUsdToMicros(bad), bad).toBeNull();
      expect(parseUsdToMicrosResult(bad), bad).toEqual({
        ok: false,
        reason: "format",
      });
    }

    expect(parseUsdToMicrosResult("9007199254.74")).toEqual({
      ok: true,
      micros: 9007199254740000,
    });
    expect(parseUsdToMicrosResult("9007199254.75")).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(parseUsdToMicros("99999999999999")).toBeNull();
    expect(parseUsdToMicrosResult("99999999999999")).toEqual({
      ok: false,
      reason: "too-large",
    });

    // readCapEnv treats unset as null and refuses empty strings and too-large amounts.
    expect(readCapEnv({})).toEqual({
      kitchenCapMicros: null,
      totalCapMicros: null,
    });
    expect(() => readCapEnv({ SOUS_AI_KITCHEN_CAP_USD: "" })).toThrow(
      /SOUS_AI_KITCHEN_CAP_USD/,
    );
    expect(() => readCapEnv({ SOUS_AI_TOTAL_CAP_USD: "" })).toThrow(
      /SOUS_AI_TOTAL_CAP_USD/,
    );
    expect(() =>
      readCapEnv({ SOUS_AI_TOTAL_CAP_USD: "9007199254.75" }),
    ).toThrow(/too large/i);
  });

  it("formats micro-dollar amounts with exact integer arithmetic without rounding sub-cent values", () => {
    expect(formatMicrosAsUsd(0)).toBe("$0.00");
    expect(formatMicrosAsUsd(1)).toBe("$0.000001");
    expect(formatMicrosAsUsd(50)).toBe("$0.00005");
    expect(formatMicrosAsUsd(500)).toBe("$0.0005");
    expect(formatMicrosAsUsd(15_000)).toBe("$0.015");
    expect(formatMicrosAsUsd(50_000)).toBe("$0.05");
    expect(formatMicrosAsUsd(65_000)).toBe("$0.065");
    expect(formatMicrosAsUsd(999_999)).toBe("$0.999999");
    expect(formatMicrosAsUsd(2_500_000)).toBe("$2.50");
    expect(formatMicrosAsUsd(10_000_000)).toBe("$10.00");
    expect(formatMicrosAsUsd(-5)).toBe("-$0.000005");
  });

  it("rounds fractional micro-dollar costs up once on the row total", () => {
    const flash25 = getModelPrice("gemini-2.5-flash")!;
    // 1,024 input tokens at $0.30/M = 307.2 micro-dollars -> 308.
    expect(
      computeCostMicros(flash25, {
        inputTokens: 1_024,
        outputTokens: 0,
        searchQueries: 0,
      }),
    ).toBe(308);
    // Exact integer value does not over-round: 1,000 * 0.30 = 300.
    expect(
      computeCostMicros(flash25, {
        inputTokens: 1_000,
        outputTokens: 0,
        searchQueries: 0,
      }),
    ).toBe(300);
    // Single ceiling on combined total: 1024 * 0.30 (307.2) + 1 * 2.50 (2.5) = 309.7 -> 310 (not 308 + 3 = 311).
    expect(
      computeCostMicros(flash25, {
        inputTokens: 1_024,
        outputTokens: 1,
        searchQueries: 0,
      }),
    ).toBe(310);
    // Search queries at $0.014 each = 14,000 micros per query.
    expect(
      computeCostMicros(flash25, {
        inputTokens: 0,
        outputTokens: 0,
        searchQueries: 2,
      }),
    ).toBe(28_000);
  });

  it("computes conservative upper-bound estimates for chat and vision calls", () => {
    const schema = {
      type: "object" as const,
      properties: { ok: { type: "boolean" as const } },
      required: ["ok"],
    };
    const schemaBytes = new TextEncoder().encode(JSON.stringify(schema)).length;
    const chatEst = estimateChatUsage("google", {
      systemPrompt: "sys",
      messages: [
        { role: "user", content: "hi", image: { base64: "abc" } },
        { role: "user", content: "there", image: { base64: "def" } },
      ],
      responseSchema: schema,
      maxTokens: 1000,
      thinkingBudget: 500,
      googleSearch: true,
      responseFormat: "json",
    });
    expect(chatEst.inputTokens).toBe(
      3 + 2 + 5 + schemaBytes + AI_CALL_OVERHEAD_TOKENS + 2 * AI_IMAGE_OVERHEAD_TOKENS,
    );
    expect(chatEst.outputTokens).toBe(1500);
    // JSON mode suppresses Google Search tool attachment.
    expect(chatEst.searchQueries).toBe(0);

    const searchEst = estimateChatUsage("google", {
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 500,
      googleSearch: true,
    });
    expect(searchEst.searchQueries).toBe(AI_SEARCH_RESERVATION_QUERIES);

    const anthropicSearchEst = estimateChatUsage("anthropic", {
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 500,
      googleSearch: true,
    });
    expect(anthropicSearchEst.searchQueries).toBe(0);

    const visionEst = estimateVisionUsage({
      prompt: "read recipe",
      maxTokens: 2048,
      thinkingBudget: 256,
    });
    expect(visionEst).toEqual({
      inputTokens:
        new TextEncoder().encode("read recipe").length +
        AI_CALL_OVERHEAD_TOKENS +
        AI_IMAGE_OVERHEAD_TOKENS,
      outputTokens: 2048 + 256,
      searchQueries: 0,
    });
  });
});

describe("AI spend ledger (PGlite)", () => {
  let client: PGlite;
  let db: TestDb;

  beforeEach(async () => {
    const migrated = await migratedTestDb();
    client = migrated.client;
    db = migrated.db;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await client.close();
  });

  it("enforces per-kitchen and overall caps independently and logs overall refusals", async () => {
    const { kitchen: kitchenA, member: memberA } = await seedKitchen(db, {
      slug: "kitchen-a",
      name: "Kitchen A",
      aiMonthlyCapMicros: 500,
    });
    const { kitchen: kitchenB } = await seedKitchen(db, {
      slug: "kitchen-b",
      name: "Kitchen B",
      aiMonthlyCapMicros: 500,
    });
    const clock = new Date("2026-11-15T12:00:00.000Z");
    const env = { SOUS_AI_TOTAL_CAP_USD: "0.01" }; // 10,000 micros

    // Estimate cost: 300 input * $1/M = 300 micros. Fits under A's 500 cap.
    const r1 = await reserveAiCall(
      {
        kitchenId: kitchenA.id,
        memberId: memberA.id,
        feature: "ask",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 300, outputTokens: 0, searchQueries: 0 },
        clock,
      },
      { database: db, env, prices: MADE_UP_PRICES },
    );
    expect(r1.reservedMicros).toBe(300);

    // Second 300-micro call for A exceeds A's 500 cap (300 + 300 > 500).
    await expect(
      reserveAiCall(
        {
          kitchenId: kitchenA.id,
          memberId: memberA.id,
          feature: "ask",
          provider: "google",
          model: "test-priced-model",
          estimate: { inputTokens: 300, outputTokens: 0, searchQueries: 0 },
          clock,
        },
        { database: db, env, prices: MADE_UP_PRICES },
      ),
    ).rejects.toMatchObject({
      name: "AllowanceUsedError",
      scope: "kitchen",
      message: expect.stringContaining("This kitchen's AI allowance"),
    });

    // Settling r1 down to 100 micros frees room for A's second 300-micro call (100 + 300 <= 500).
    await settleAiCall(r1, { inputTokens: 100, outputTokens: 0 }, db);
    const r2 = await reserveAiCall(
      {
        kitchenId: kitchenA.id,
        memberId: memberA.id,
        feature: "ask",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 300, outputTokens: 0, searchQueries: 0 },
        clock,
      },
      { database: db, env, prices: MADE_UP_PRICES },
    );
    await settleAiCall(r2, { inputTokens: 300, outputTokens: 0 }, db);

    // Overall cap check across A and B (A spent 400; raise A & B caps and lower overall cap to 600).
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 2_000_000 })
      .where(eq(kitchens.id, kitchenB.id));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Tight overall cap: $0.00 (0 micros) refuses immediately as overall cap.
    await expect(
      reserveAiCall(
        {
          kitchenId: kitchenB.id,
          memberId: null,
          feature: "import-text",
          provider: "google",
          model: "test-priced-model",
          estimate: { inputTokens: 100, outputTokens: 0, searchQueries: 0 },
          clock,
        },
        { database: db, env: { SOUS_AI_TOTAL_CAP_USD: "0" }, prices: MADE_UP_PRICES },
      ),
    ).rejects.toMatchObject({
      name: "AllowanceUsedError",
      scope: "overall",
      message: expect.stringContaining("used up for everyone"),
    });
    expect(errSpy).toHaveBeenCalledWith("[ai-cap] overall monthly cap reached", {
      month: "2026-11",
    });
  });

  it("CAP-8: a failed call settles at its reservation, and a left-reserved row counts at its reservation in the next sum", async () => {
    const { kitchen } = await seedKitchen(db, {
      slug: "cap8-kitchen",
      name: "CAP8 Kitchen",
      aiMonthlyCapMicros: 1_000,
    });
    const clock = new Date("2026-11-15T12:00:00.000Z");

    // First call reserves 400 micros and fails -> settles as failed with cost_micros = 400.
    const r1 = await reserveAiCall(
      {
        kitchenId: kitchen.id,
        memberId: null,
        feature: "ask",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 400, outputTokens: 0, searchQueries: 0 },
        clock,
      },
      { database: db, env: {}, prices: MADE_UP_PRICES },
    );
    await failAiCall(r1, db);

    const [failedRow] = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.id, r1.usageId));
    expect(failedRow?.status).toBe("failed");
    expect(failedRow?.costMicros).toBe(400);
    expect(failedRow?.settledAt).toBeInstanceOf(Date);

    // Second call reserves 400 micros and is never settled (simulates crash mid-call).
    const r2 = await reserveAiCall(
      {
        kitchenId: kitchen.id,
        memberId: null,
        feature: "ask",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 400, outputTokens: 0, searchQueries: 0 },
        clock,
      },
      { database: db, env: {}, prices: MADE_UP_PRICES },
    );
    const [reservedRow] = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.id, r2.usageId));
    expect(reservedRow?.status).toBe("reserved");
    expect(reservedRow?.settledAt).toBeNull();

    // Total committed is 400 (failed) + 400 (reserved) = 800; a 300-micro call exceeds 1,000.
    await expect(
      reserveAiCall(
        {
          kitchenId: kitchen.id,
          memberId: null,
          feature: "ask",
          provider: "google",
          model: "test-priced-model",
          estimate: { inputTokens: 300, outputTokens: 0, searchQueries: 0 },
          clock,
        },
        { database: db, env: {}, prices: MADE_UP_PRICES },
      ),
    ).rejects.toMatchObject({
      name: "AllowanceUsedError",
      scope: "kitchen",
    });

    // A 200-micro call fits (800 + 200 <= 1,000).
    const r3 = await reserveAiCall(
      {
        kitchenId: kitchen.id,
        memberId: null,
        feature: "ask",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 200, outputTokens: 0, searchQueries: 0 },
        clock,
      },
      { database: db, env: {}, prices: MADE_UP_PRICES },
    );
    expect(r3.reservedMicros).toBe(200);
  });

  it("CAP-9: unpriced model throws UnpricedModelError when any cap applies, and records zero reservation with null cost when uncapped", async () => {
    const home = await homeKitchen(db);
    const clock = new Date("2026-11-15T12:00:00.000Z");

    // 1. Env cap set -> refuses before reserving any row.
    await expect(
      reserveAiCall(
        {
          kitchenId: home.id,
          memberId: null,
          feature: "ask",
          provider: "google",
          model: "unpriced-test-model",
          estimate: { inputTokens: 100, outputTokens: 100, searchQueries: 0 },
          clock,
        },
        {
          database: db,
          env: { SOUS_AI_KITCHEN_CAP_USD: "2", SOUS_AI_TOTAL_CAP_USD: "10" },
        },
      ),
    ).rejects.toThrow(UnpricedModelError);
    expect(await db.select().from(aiUsage)).toHaveLength(0);

    // 2. No env cap, but kitchen row has a cap set -> still refuses.
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 5_000_000 })
      .where(eq(kitchens.id, home.id));
    await expect(
      reserveAiCall(
        {
          kitchenId: home.id,
          memberId: null,
          feature: "ask",
          provider: "google",
          model: "unpriced-test-model",
          estimate: { inputTokens: 100, outputTokens: 100, searchQueries: 0 },
          clock,
        },
        { database: db, env: {} },
      ),
    ).rejects.toThrow(UnpricedModelError);
    expect(await db.select().from(aiUsage)).toHaveLength(0);

    // 3. No cap in force at all -> proceeds with reserved_micros = 0 and cost_micros = null on both settle and fail.
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: null })
      .where(eq(kitchens.id, home.id));

    const okRes = await reserveAiCall(
      {
        kitchenId: home.id,
        memberId: null,
        feature: "ask",
        provider: "google",
        model: "unpriced-test-model",
        estimate: { inputTokens: 100, outputTokens: 100, searchQueries: 0 },
        clock,
      },
      { database: db, env: {} },
    );
    expect(okRes.reservedMicros).toBe(0);
    expect(okRes.price).toBeNull();
    await settleAiCall(okRes, { inputTokens: 42, outputTokens: 17 }, db);

    const [settledRow] = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.id, okRes.usageId));
    expect(settledRow).toMatchObject({
      status: "settled",
      reservedMicros: 0,
      costMicros: null,
      inputTokens: 42,
      outputTokens: 17,
    });

    const failRes = await reserveAiCall(
      {
        kitchenId: home.id,
        memberId: null,
        feature: "ask",
        provider: "google",
        model: "unpriced-test-model",
        estimate: { inputTokens: 100, outputTokens: 100, searchQueries: 0 },
        clock,
      },
      { database: db, env: {} },
    );
    await failAiCall(failRes, db);

    const [failedRow] = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.id, failRes.usageId));
    expect(failedRow).toMatchObject({
      status: "failed",
      reservedMicros: 0,
      costMicros: null,
    });
  });

  it("CAP-10: month bounds use the database clock in UTC regardless of app clock or session TimeZone", async () => {
    const { kitchen } = await seedKitchen(db, {
      slug: "cap10-kitchen",
      name: "CAP10 Kitchen",
      aiMonthlyCapMicros: 500,
    });

    // Compute the database's current UTC month bounds directly.
    const dbBounds = monthBounds();
    const [nowBounds] = await db
      .select({ start: dbBounds.start, end: dbBounds.end })
      .from(sql`(select 1) as _t`);
    const currentMonthStart = new Date(nowBounds!.start);
    const currentResetsAt = new Date(nowBounds!.end);
    const prevMonthInstant = new Date(currentMonthStart.getTime() - 60_000);

    // Insert a large settled row in the previous UTC month; it must not count toward this month's cap.
    await db.insert(aiUsage).values({
      kitchenId: kitchen.id,
      feature: "ask",
      provider: "google",
      model: "test-priced-model",
      status: "settled",
      reservedMicros: 900,
      costMicros: 900,
      createdAt: prevMonthInstant,
      settledAt: prevMonthInstant,
    });

    const r1 = await reserveAiCall(
      {
        kitchenId: kitchen.id,
        memberId: null,
        feature: "ask",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 400, outputTokens: 0, searchQueries: 0 },
      },
      { database: db, env: {}, prices: MADE_UP_PRICES },
    );
    await settleAiCall(r1, { inputTokens: 400, outputTokens: 0 }, db);

    // Second 200-micro call exceeds 500 cap and resetsAt matches the DB's next UTC month.
    let capErr: unknown;
    try {
      await reserveAiCall(
        {
          kitchenId: kitchen.id,
          memberId: null,
          feature: "ask",
          provider: "google",
          model: "test-priced-model",
          estimate: { inputTokens: 200, outputTokens: 0, searchQueries: 0 },
        },
        { database: db, env: {}, prices: MADE_UP_PRICES },
      );
    } catch (err) {
      capErr = err;
    }
    expect(capErr).toBeInstanceOf(AllowanceUsedError);
    expect((capErr as AllowanceUsedError).resetsAt.toISOString()).toBe(
      currentResetsAt.toISOString(),
    );

    // Move the Node.js app clock to another year/month: SQL-clock month bounds
    // and reserveAiCall are unaffected by JS Date. (In PGlite, WASM's `now()`
    // itself reads JS `Date.now()`, so we also verify the default SQL uses
    // Postgres `now()` rather than a JS date parameter, and pass an explicit
    // SQL timestamp expression while JS Date is moved to 2030-07.)
    const defaultQuery = db
      .select({ start: dbBounds.start, end: dbBounds.end })
      .from(sql`(select 1) as _t`)
      .toSQL();
    expect(defaultQuery.sql).toContain("now() at time zone 'UTC'");
    expect(defaultQuery.params).toEqual([]);

    const { kitchen: fixedKitchen } = await seedKitchen(db, {
      slug: "cap10-fixed",
      name: "CAP10 Fixed",
      aiMonthlyCapMicros: 500,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-07-15T12:00:00.000Z"));
    const novClock = sql`'2026-11-15 12:00:00'::timestamp`;
    const novRow = await reserveAiCall(
      {
        kitchenId: fixedKitchen.id,
        memberId: null,
        feature: "ask",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 400, outputTokens: 0, searchQueries: 0 },
        clock: novClock,
      },
      { database: db, env: {}, prices: MADE_UP_PRICES },
    );
    await settleAiCall(novRow, { inputTokens: 400, outputTokens: 0 }, db);

    let novCapErr: unknown;
    try {
      await reserveAiCall(
        {
          kitchenId: fixedKitchen.id,
          memberId: null,
          feature: "ask",
          provider: "google",
          model: "test-priced-model",
          estimate: { inputTokens: 200, outputTokens: 0, searchQueries: 0 },
          clock: novClock,
        },
        { database: db, env: {}, prices: MADE_UP_PRICES },
      );
    } catch (err) {
      novCapErr = err;
    }
    expect(novCapErr).toBeInstanceOf(AllowanceUsedError);
    expect((novCapErr as AllowanceUsedError).resetsAt.toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );

    vi.useRealTimers();

    // Test monthBounds under non-UTC session time zones (DST transitions & month lengths).
    const checkBoundsInZone = async (
      zoneSql: string,
      cases: Array<[string, string, string]>,
    ) => {
      await client.exec(`SET TIME ZONE ${zoneSql}`);
      try {
        for (const [instant, expectedStart, expectedEnd] of cases) {
          const b = monthBounds(new Date(instant));
          const [row] = await db
            .select({ start: b.start, end: b.end })
            .from(sql`(select 1) as _tz`);
          expect(new Date(row!.start).toISOString(), `${zoneSql} ${instant} start`).toBe(
            expectedStart,
          );
          expect(new Date(row!.end).toISOString(), `${zoneSql} ${instant} end`).toBe(
            expectedEnd,
          );
        }
      } finally {
        await client.exec(`SET TIME ZONE 'UTC'`);
      }
    };

    await checkBoundsInZone(`'America/New_York'`, [
      ["2026-03-30T12:00:00.000Z", "2026-03-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"],
      ["2026-10-31T12:00:00.000Z", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
      ["2026-11-15T12:00:00.000Z", "2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"],
    ]);
    await checkBoundsInZone(`'Pacific/Auckland'`, [
      ["2026-09-15T12:00:00.000Z", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
    ]);

    // Reserve, settle, and second reserve while session TimeZone is America/New_York.
    const { kitchen: nyKitchen } = await seedKitchen(db, {
      slug: "ny-kitchen",
      name: "NY Kitchen",
      aiMonthlyCapMicros: 500,
    });
    await client.exec(`SET TIME ZONE 'America/New_York'`);
    try {
      const first = await reserveAiCall(
        {
          kitchenId: nyKitchen.id,
          memberId: null,
          feature: "ask",
          provider: "google",
          model: "test-priced-model",
          estimate: { inputTokens: 300, outputTokens: 0, searchQueries: 0 },
        },
        { database: db, env: {}, prices: MADE_UP_PRICES },
      );
      await settleAiCall(first, { inputTokens: 300, outputTokens: 0 }, db);

      await expect(
        reserveAiCall(
          {
            kitchenId: nyKitchen.id,
            memberId: null,
            feature: "ask",
            provider: "google",
            model: "test-priced-model",
            estimate: { inputTokens: 300, outputTokens: 0, searchQueries: 0 },
          },
          { database: db, env: {}, prices: MADE_UP_PRICES },
        ),
      ).rejects.toMatchObject({
        name: "AllowanceUsedError",
        scope: "kitchen",
      });
    } finally {
      await client.exec(`SET TIME ZONE 'UTC'`);
    }

    // Sentence formatting for 2026-12-01T00:00Z says "1 December".
    const decErr = new AllowanceUsedError(
      "kitchen",
      new Date("2026-12-01T00:00:00.000Z"),
    );
    expect(decErr.message).toContain("1 December");
  });

  it("CAP-14: a settlement write that fails logs [ai-meter] settle failed, leaves the row reserved, and does not throw", async () => {
    const { kitchen } = await seedKitchen(db, {
      slug: "cap14-kitchen",
      name: "CAP14 Kitchen",
      aiMonthlyCapMicros: 2_000_000,
    });
    const clock = new Date("2026-11-15T12:00:00.000Z");

    const reservation = await reserveAiCall(
      {
        kitchenId: kitchen.id,
        memberId: null,
        feature: "ask",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 500, outputTokens: 0, searchQueries: 0 },
        clock,
      },
      { database: db, env: {}, prices: MADE_UP_PRICES },
    );

    await client.exec(`
      CREATE OR REPLACE FUNCTION fail_ai_usage_update() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'simulated settle failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER ai_usage_block_update
        BEFORE UPDATE ON "ai_usage"
        FOR EACH ROW EXECUTE FUNCTION fail_ai_usage_update();
    `);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      settleAiCall(reservation, { inputTokens: 100, outputTokens: 0 }, db),
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith(
      "[ai-meter] settle failed",
      expect.objectContaining({ usageId: reservation.usageId }),
    );

    const [row] = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.id, reservation.usageId));
    expect(row?.status).toBe("reserved");
    expect(row?.reservedMicros).toBe(500);
    expect(row?.settledAt).toBeNull();
  });

  it("builds monthly spend reports with per-kitchen totals, feature breakdowns, and stale reservations", async () => {
    const { kitchen: kitchenA } = await seedKitchen(db, {
      slug: "report-a",
      name: "Report A",
      aiMonthlyCapMicros: 3_000_000,
    });
    const novMid = new Date("2026-11-15T12:00:00.000Z");
    const novEarly = new Date("2026-11-15T10:00:00.000Z"); // > 1h before novMid
    const novRecent = new Date("2026-11-15T11:30:00.000Z"); // < 1h before novMid

    const rSettled = await reserveAiCall(
      {
        kitchenId: kitchenA.id,
        memberId: null,
        feature: "ask",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 1000, outputTokens: 0, searchQueries: 0 },
        clock: novEarly,
      },
      { database: db, env: {}, prices: MADE_UP_PRICES },
    );
    await settleAiCall(rSettled, { inputTokens: 500, outputTokens: 0 }, db);

    const rStale = await reserveAiCall(
      {
        kitchenId: kitchenA.id,
        memberId: null,
        feature: "cook-plan",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 700, outputTokens: 0, searchQueries: 0 },
        clock: novEarly,
      },
      { database: db, env: {}, prices: MADE_UP_PRICES },
    );
    await reserveAiCall(
      {
        kitchenId: kitchenA.id,
        memberId: null,
        feature: "cook-plan",
        provider: "google",
        model: "test-priced-model",
        estimate: { inputTokens: 200, outputTokens: 0, searchQueries: 0 },
        clock: novRecent,
      },
      { database: db, env: {}, prices: MADE_UP_PRICES },
    );

    const report = await getMonthlySpendReport({
      month: "2026-11",
      clock: novMid,
      database: db,
      env: { SOUS_AI_KITCHEN_CAP_USD: "2", SOUS_AI_TOTAL_CAP_USD: "10" },
    });

    expect(report.month).toBe("2026-11");
    expect(report.totalSpentMicros).toBe(500 + 700 + 200);
    expect(report.totalCapMicros).toBe(10_000_000);
    expect(report.defaultKitchenCapMicros).toBe(2_000_000);

    const rowA = report.byKitchen.find((k) => k.slug === "report-a");
    expect(rowA).toMatchObject({
      spentMicros: 1_400,
      effectiveCapMicros: 3_000_000,
      overrideCapMicros: 3_000_000,
      callCount: 3,
    });
    expect(report.byFeature).toEqual([
      { feature: "ask", spentMicros: 500, callCount: 1 },
      { feature: "cook-plan", spentMicros: 900, callCount: 2 },
    ]);
    expect(report.staleReserved).toHaveLength(1);
    expect(report.staleReserved[0]?.id).toBe(rStale.usageId);
  });

  it("enforces the deployment's default kitchen cap when a kitchen has no cap of its own and no overall cap is set", async () => {
    const { kitchen } = await seedKitchen(db, {
      slug: "default-cap-kitchen",
      name: "Default Cap Kitchen",
      aiMonthlyCapMicros: null,
    });
    const env = { SOUS_AI_KITCHEN_CAP_USD: "0.01" };
    const prices: Readonly<Record<string, ModelPrice>> = {
      "ten-per-million": {
        inputUsdPerMillion: 10,
        outputUsdPerMillion: 0,
        searchUsdPerQuery: 0,
        checkedAt: "2026-11-22",
        sourceUrl: "https://example.com/pricing",
      },
    };
    const input = {
      kitchenId: kitchen.id,
      memberId: null,
      feature: "ask" as const,
      provider: "google" as const,
      model: "ten-per-million",
      estimate: { inputTokens: 1_000, outputTokens: 0, searchQueries: 0 },
    };

    const first = await reserveAiCall(input, { database: db, env, prices });
    expect(first.reservedMicros).toBe(10_000);

    const err = await reserveAiCall(input, { database: db, env, prices }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AllowanceUsedError);
    expect((err as AllowanceUsedError).scope).toBe("kitchen");
  });

  it("excludes usage rows dated at or after the first instant of the next UTC month", async () => {
    const { kitchen } = await seedKitchen(db, {
      slug: "next-month-kitchen",
      name: "Next Month Kitchen",
      aiMonthlyCapMicros: null,
    });
    const env = { SOUS_AI_KITCHEN_CAP_USD: "0.01" };
    const prices: Readonly<Record<string, ModelPrice>> = {
      "ten-per-million": {
        inputUsdPerMillion: 10,
        outputUsdPerMillion: 0,
        searchUsdPerQuery: 0,
        checkedAt: "2026-11-22",
        sourceUrl: "https://example.com/pricing",
      },
    };

    await db.insert(aiUsage).values({
      kitchenId: kitchen.id,
      feature: "ask",
      provider: "google",
      model: "ten-per-million",
      status: "settled",
      reservedMicros: 10_000,
      costMicros: 10_000,
      settledAt: new Date(),
      createdAt: sql`(date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC'`,
    });

    await expect(
      reserveAiCall(
        {
          kitchenId: kitchen.id,
          memberId: null,
          feature: "ask",
          provider: "google",
          model: "ten-per-million",
          estimate: { inputTokens: 1_000, outputTokens: 0, searchQueries: 0 },
        },
        { database: db, env, prices },
      ),
    ).resolves.toMatchObject({ reservedMicros: 10_000 });
  });
});

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      out.push(...walkTsFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("Metered chat and vision through fake provider", () => {
  const sharedClient = (dbModule as unknown as { client: PGlite }).client;
  const sharedDb = dbModule.db as unknown as TestDb;

  beforeEach(async () => {
    fakeProvider.reset();
    vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("AI_TEXT_PROVIDER", "google");
    vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");
    vi.stubEnv("AI_VISION_PROVIDER", "google");
    vi.stubEnv("AI_VISION_MODEL", "gemini-2.5-flash");
    vi.stubEnv("SOUS_AI_KITCHEN_CAP_USD", undefined);
    vi.stubEnv("SOUS_AI_TOTAL_CAP_USD", undefined);
    await sharedClient.exec(
      "delete from ai_usage; delete from members; delete from auth_user; delete from kitchens where slug <> 'home'; update kitchens set ai_monthly_cap_micros = null where slug = 'home';",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("CAP-3: 20 concurrent calls under a cap fitting 3 reservations make exactly 3 provider calls and refuse 17", async () => {
    // Compute exact reservation cost for one call on gemini-2.5-flash.
    const model = "gemini-2.5-flash";
    const price = getModelPrice(model)!;
    const options = {
      messages: [{ role: "user" as const, content: "Quick question" }],
      maxTokens: 100,
      model,
    };
    const oneEst = estimateChatUsage("google", options);
    const oneReserved = computeCostMicros(price, oneEst);

    const { kitchen, member } = await seedKitchen(sharedDb, {
      slug: "cap3-kitchen",
      name: "CAP3 Kitchen",
      aiMonthlyCapMicros: oneReserved * 3,
    });

    // Hold all provider responses until every reservation attempt has run so
    // reservations stay in flight and cannot settle early.
    const resolvers: Array<() => void> = [];
    fakeProvider.setDefaultChat(
      () =>
        new Promise((resolve) => {
          resolvers.push(() =>
            resolve({
              content: "Done",
              finishReason: "stop",
              usage: { inputTokens: 10, outputTokens: 10 },
            }),
          );
        }),
    );

    const meter = kitchenMeter(kitchen.id, member.id, "ask");
    const settledPromise = Promise.allSettled(
      Array.from({ length: 20 }, () => chat(options, meter)),
    );

    // Wait until the 3 allowed calls reach the provider, then release them.
    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(3);
    });
    for (const release of resolvers) release();

    const settled = await settledPromise;
    const ok = settled.filter((r) => r.status === "fulfilled");
    const refused = settled.filter(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof AllowanceUsedError &&
        r.reason.scope === "kitchen",
    );

    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(17);
    expect(fakeProvider.chatCalls).toHaveLength(3);
  });

  it("CAP-7: scriptMeter writes no rows, ignores caps and unpriced models, and no production code bypasses chat/vision", async () => {
    vi.stubEnv("SOUS_AI_KITCHEN_CAP_USD", "0");
    vi.stubEnv("SOUS_AI_TOTAL_CAP_USD", "0");

    const res = await chat(
      {
        messages: [{ role: "user", content: "Eval prompt" }],
        maxTokens: 200,
        model: "unpriced-eval-model",
      },
      scriptMeter("eval-script"),
    );
    expect(res.content).toBe("OK");
    expect(await sharedDb.select().from(aiUsage)).toHaveLength(0);

    // Static tree checks across app/src and app/scripts.
    const appDir = fileURLToPath(new URL("../../..", import.meta.url));
    const srcFiles = walkTsFiles(path.join(appDir, "src"));
    const scriptFiles = walkTsFiles(path.join(appDir, "scripts"));

    const meterFile = path.join(appDir, "src", "lib", "ai", "meter.ts");
    const aiDir = path.join(appDir, "src", "lib", "ai") + path.sep;
    const isTestFile = (file: string) =>
      file.endsWith(".test.ts") ||
      file.endsWith(".test.tsx") ||
      file.includes(`${path.sep}__tests__${path.sep}`);

    for (const file of srcFiles) {
      if (isTestFile(file)) continue;
      const content = readFileSync(file, "utf8");
      if (file !== meterFile) {
        expect(
          content,
          `Unexpected scriptMeter( in ${path.relative(appDir, file)}`,
        ).not.toContain("scriptMeter(");
      }
    }

    const forbidden = [
      "@/lib/ai/providers/",
      "getTextProvider",
      "getVisionProvider",
      "createAnthropicProvider",
      "createGoogleProvider",
    ];
    for (const file of [...srcFiles, ...scriptFiles]) {
      if (isTestFile(file) || file.startsWith(aiDir)) continue;
      const content = readFileSync(file, "utf8");
      for (const token of forbidden) {
        expect(
          content,
          `Forbidden AI bypass "${token}" in ${path.relative(appDir, file)}`,
        ).not.toContain(token);
      }
    }
  });

  it("CAP-13: Google search metering settles 0 without grounding metadata, 2 at $0.014 each, 3 on failure, and reserves none for Anthropic or JSON", async () => {
    const { kitchen } = await seedKitchen(sharedDb, {
      slug: "cap13-kitchen",
      name: "CAP13 Kitchen",
    });
    const meter = kitchenMeter(kitchen.id, null, "ask");
    const price = getModelPrice("gemini-3.5-flash")!;

    // 1. Google Ask with no grounding metadata -> settles search_queries = 0, no search cost.
    fakeProvider.onNextChat(() => ({
      content: "Simmer 10 min.",
      finishReason: "stop",
      usage: { inputTokens: 1000, outputTokens: 100 },
    }));
    await chat(
      {
        messages: [{ role: "user", content: "How long?" }],
        maxTokens: 200,
        googleSearch: true,
      },
      meter,
    );

    // 2. Google Ask reporting 2 search queries -> settles 2 at $0.014 each.
    fakeProvider.onNextChat(() => ({
      content: "74°C.",
      finishReason: "stop",
      searchQueries: 2,
      usage: { inputTokens: 1000, outputTokens: 100 },
    }));
    await chat(
      {
        messages: [{ role: "user", content: "Safe chicken temp?" }],
        maxTokens: 200,
        googleSearch: true,
      },
      meter,
    );

    // 3. Failed Google Ask -> settles at reserved 3 search queries + reserved tokens.
    fakeProvider.onNextChat(() => {
      throw new Error("provider timeout");
    });
    await expect(
      chat(
        {
          messages: [{ role: "user", content: "Will fail" }],
          maxTokens: 200,
          googleSearch: true,
        },
        meter,
      ),
    ).rejects.toThrow("provider timeout");

    // 4. Google call with responseFormat: "json" -> reserves 0 search queries.
    fakeProvider.onNextChat(() => ({
      content: "{}",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 10 },
    }));
    await chat(
      {
        messages: [{ role: "user", content: "JSON please" }],
        maxTokens: 200,
        responseFormat: "json",
        googleSearch: true,
      },
      meter,
    );

    // 5. Anthropic Ask with googleSearch: true -> reserves 0 search queries.
    vi.stubEnv("AI_TEXT_PROVIDER", "anthropic");
    fakeProvider.onNextChat(() => ({
      content: "Anthropic reply",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 10 },
    }));
    await chat(
      {
        messages: [{ role: "user", content: "Anthropic ask" }],
        maxTokens: 200,
        googleSearch: true,
      },
      meter,
    );

    const rows = await sharedDb
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.kitchenId, kitchen.id))
      .orderBy(aiUsage.createdAt);

    expect(rows).toHaveLength(5);

    const expectedBaseCost = computeCostMicros(price, {
      inputTokens: 1000,
      outputTokens: 100,
      searchQueries: 0,
    });
    const expectedTwoSearchCost = computeCostMicros(price, {
      inputTokens: 1000,
      outputTokens: 100,
      searchQueries: 2,
    });
    const expectedFailedReserve = computeCostMicros(
      price,
      estimateChatUsage("google", {
        messages: [{ role: "user", content: "Will fail" }],
        maxTokens: 200,
        googleSearch: true,
      }),
    );
    const expectedJsonReserve = computeCostMicros(
      price,
      estimateChatUsage("google", {
        messages: [{ role: "user", content: "JSON please" }],
        maxTokens: 200,
        responseFormat: "json",
        googleSearch: true,
      }),
    );
    const expectedAnthropicReserve = computeCostMicros(
      price,
      estimateChatUsage("anthropic", {
        messages: [{ role: "user", content: "Anthropic ask" }],
        maxTokens: 200,
        googleSearch: true,
      }),
    );

    expect(rows[0]).toMatchObject({
      status: "settled",
      searchQueries: 0,
      costMicros: expectedBaseCost,
    });
    expect(rows[1]).toMatchObject({
      status: "settled",
      searchQueries: 2,
      costMicros: expectedTwoSearchCost,
    });
    expect(expectedTwoSearchCost - expectedBaseCost).toBe(28_000);
    expect(rows[2]).toMatchObject({
      status: "failed",
      searchQueries: 3,
      reservedMicros: expectedFailedReserve,
      costMicros: expectedFailedReserve,
    });
    expect(rows[3]).toMatchObject({
      status: "settled",
      searchQueries: 0,
      reservedMicros: expectedJsonReserve,
    });
    expect(rows[4]).toMatchObject({
      provider: "anthropic",
      status: "settled",
      searchQueries: 0,
      reservedMicros: expectedAnthropicReserve,
    });
  });

  it("CAP-16: estimate components, required maxTokens type check, ceiling micro-dollars, and Google vision thinking tokens", async () => {
    const { kitchen } = await seedKitchen(sharedDb, {
      slug: "cap16-kitchen",
      name: "CAP16 Kitchen",
    });
    const flash25 = getModelPrice("gemini-2.5-flash")!;

    // Type-level check (verified by tsc): leaving out maxTokens is a type error.
    const _assertMaxTokensRequired = () => {
      // @ts-expect-error maxTokens is required on public chat()
      void chat({ messages: [{ role: "user", content: "hi" }] }, scriptMeter("t"));
      // @ts-expect-error maxTokens is required on public vision()
      void vision({ imageBase64: "abc", prompt: "hi" }, scriptMeter("t"));
    };
    expect(typeof _assertMaxTokensRequired).toBe("function");

    // 1. Fractional micro-dollars (1,024 input tokens of gemini-2.5-flash = 307.2 -> 308)
    // stored rounded up in both reserved_micros and cost_micros.
    fakeProvider.onNextChat(() => ({
      content: "ok",
      finishReason: "stop",
      usage: { inputTokens: 1_024, outputTokens: 0 },
    }));
    await chat(
      {
        messages: [{ role: "user", content: "" }],
        maxTokens: 0,
        model: "gemini-2.5-flash",
      },
      kitchenMeter(kitchen.id, null, "ask"),
    );

    // 2. responseSchema bytes + 1,024 overhead + two images (12,000) + maxTokens + thinkingBudget.
    const schema = {
      type: "object" as const,
      properties: { title: { type: "string" as const } },
      required: ["title"],
    };
    const multiOpts = {
      messages: [
        { role: "user" as const, content: "a", image: { base64: "img1" } },
        { role: "user" as const, content: "bb", image: { base64: "img2" } },
      ],
      responseFormat: "json" as const,
      responseSchema: schema,
      maxTokens: 400,
      thinkingBudget: 200,
      model: "gemini-2.5-flash",
    };
    const expectedMultiReserve = computeCostMicros(
      flash25,
      estimateChatUsage("google", multiOpts),
    );
    fakeProvider.onNextChat(() => ({
      content: '{"title":"Soup"}',
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50 },
    }));
    await chat(multiOpts, kitchenMeter(kitchen.id, null, "import-text"));

    // 3. vision() reserves prompt bytes + overhead + 1 image and settles output_tokens = 500
    // when Google reports 100 candidate + 400 thought tokens.
    const realGoogleModule = await vi.importActual<
      typeof import("./providers/google")
    >("./providers/google");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: '{"name":"Toast"}' }] },
              finishReason: "STOP",
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 200,
            candidatesTokenCount: 100,
            thoughtsTokenCount: 400,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const realVisionRes = await realGoogleModule
      .createGoogleProvider("real-vision-key")
      .vision({
        imageBase64: "aGVsbG8=",
        prompt: "Extract this recipe",
        maxTokens: 500,
      });
    fetchSpy.mockRestore();
    expect(realVisionRes.usage).toEqual({ inputTokens: 200, outputTokens: 500 });

    fakeProvider.onNextVision(() => realVisionRes);
    const visionOpts = {
      imageBase64: "aGVsbG8=",
      prompt: "Extract this recipe",
      maxTokens: 500,
      model: "gemini-2.5-flash",
    };
    const expectedVisionReserve = computeCostMicros(
      flash25,
      estimateVisionUsage(visionOpts),
    );
    const visionText = await vision(
      visionOpts,
      kitchenMeter(kitchen.id, null, "import-photo"),
    );
    expect(visionText).toBe('{"name":"Toast"}');

    const rows = await sharedDb
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.kitchenId, kitchen.id))
      .orderBy(aiUsage.createdAt);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      reservedMicros: 308,
      costMicros: 308,
      inputTokens: 1_024,
      outputTokens: 0,
    });
    expect(rows[1]).toMatchObject({
      reservedMicros: expectedMultiReserve,
    });
    expect(rows[2]).toMatchObject({
      feature: "import-photo",
      reservedMicros: expectedVisionReserve,
      inputTokens: 200,
      outputTokens: 500,
    });
  });

  it("settles a provider answer with no usage at its reservation rather than zero", async () => {
    const { kitchen } = await seedKitchen(sharedDb, {
      slug: "no-usage-kitchen",
      name: "No Usage Kitchen",
    });
    fakeProvider.onNextChat(() => ({
      content: "OK",
      finishReason: "stop",
      usage: undefined,
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await chat(
      { messages: [{ role: "user", content: "Hi" }], maxTokens: 100 },
      kitchenMeter(kitchen.id, null, "ask"),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      "[ai-meter] provider returned no usage; settling at reservation",
      expect.objectContaining({ provider: "google", model: "gemini-3.5-flash" }),
    );
    const [row] = await sharedDb.select().from(aiUsage);
    expect(row).toMatchObject({
      status: "settled",
      inputTokens: null,
      outputTokens: null,
    });
    expect(row!.reservedMicros).toBeGreaterThan(0);
    expect(row!.costMicros).toBe(row!.reservedMicros);
  });
});
