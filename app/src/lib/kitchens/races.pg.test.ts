/**
 * Concurrency tests against a real PostgreSQL server with parallel connections,
 * covering:
 * - invite acceptance and revocation races
 * - AI monthly spend cap reservation races and database-clock month bounds
 *
 * Every real-PostgreSQL test lives in this one file because the test runner
 * executes separate test files concurrently; split across files against the same
 * database, each file's clean-up would delete the other's rows mid-test. Tests
 * within one file run one after another, so they can safely share the database.
 *
 * Skipped unless `SOUS_TEST_POSTGRES_URL` points at a migrated, disposable
 * PostgreSQL database. Before connecting or deleting rows, this file refuses
 * to run unless the database name in `SOUS_TEST_POSTGRES_URL` contains "test"
 * (for example `sous_test`):
 *
 *   SOUS_TEST_POSTGRES_URL=postgres://localhost:5432/sous_test \
 *     pnpm --dir app test:run src/lib/kitchens/races.pg.test.ts
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import * as schema from "../../../drizzle/schema";
import {
  aiUsage,
  authSession,
  authUser,
  invites,
  kitchens,
  members,
} from "../../../drizzle/schema";
import { computeCostMicros, type ModelPrice } from "../ai/prices";
import { monthBounds, reserveAiCall } from "../ai/spend";
import { AllowanceUsedError, type AllowanceScope } from "../ai/types";
import { resolveAccess } from "./access";
import { KitchenAdminError, createInvite, uninviteEmail } from "./admin";
import { NotInvitedError, createBeforeCreateSession } from "./invites";

const pgUrl = process.env.SOUS_TEST_POSTGRES_URL;
const INVITE_PARALLEL_CALLS = 10;
const CAP_PARALLEL_CALLS = 12;

const TEST_PRICES: Readonly<Record<string, ModelPrice>> = {
  "race-test-model": {
    inputUsdPerMillion: 10.0,
    outputUsdPerMillion: 0,
    searchUsdPerQuery: 0,
    checkedAt: "2026-11-22",
    sourceUrl: "https://example.com/pricing",
  },
};

const ONE_ESTIMATE = { inputTokens: 1_000, outputTokens: 0, searchQueries: 0 };
const ONE_COST = computeCostMicros(
  TEST_PRICES["race-test-model"]!,
  ONE_ESTIMATE,
); // 10,000 micros ($0.01)

function assertTestDatabaseUrl(rawUrl: string): void {
  let dbName: string;
  try {
    const parsed = new URL(rawUrl);
    dbName = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, ""));
  } catch {
    throw new Error(
      'Refusing to run PostgreSQL concurrency tests: SOUS_TEST_POSTGRES_URL must be a valid PostgreSQL URL whose database name contains "test" (for example, sous_test).',
    );
  }
  if (!dbName || !dbName.toLowerCase().includes("test")) {
    throw new Error(
      `Refusing to run PostgreSQL concurrency tests: database name "${dbName}" in SOUS_TEST_POSTGRES_URL must contain "test" (for example, sous_test).`,
    );
  }
}

async function settle<T>(promises: Promise<T>[]) {
  const results = await Promise.allSettled(promises);
  return {
    ok: results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<T>> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value),
    notInvited: results.filter(
      (r) => r.status === "rejected" && r.reason instanceof NotInvitedError,
    ).length,
    otherErrors: results
      .filter(
        (r) =>
          r.status === "rejected" && !(r.reason instanceof NotInvitedError),
      )
      .map((r) =>
        String(
          (r as PromiseRejectedResult).reason?.message ??
            (r as PromiseRejectedResult).reason,
        ),
      ),
  };
}

function tallyReserves<T>(
  results: PromiseSettledResult<T>[],
  expectedScope: AllowanceScope,
) {
  return {
    ok: results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<T>> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value),
    capped: results.filter(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof AllowanceUsedError &&
        r.reason.scope === expectedScope,
    ).length,
    otherErrors: results
      .filter(
        (r) =>
          r.status === "rejected" &&
          !(
            r.reason instanceof AllowanceUsedError &&
            r.reason.scope === expectedScope
          ),
      )
      .map((r) =>
        String(
          (r as PromiseRejectedResult).reason?.message ??
            (r as PromiseRejectedResult).reason,
        ),
      ),
  };
}

describe.skipIf(!pgUrl)("PostgreSQL concurrency", () => {
  let client: Sql | undefined;
  let capHolder: Sql | undefined;
  let watcher: Sql | undefined;
  let db: PostgresJsDatabase<typeof schema>;

  beforeAll(async () => {
    assertTestDatabaseUrl(pgUrl!);
    const [{ default: postgres }, { drizzle }] = await Promise.all([
      import("postgres"),
      import("drizzle-orm/postgres-js"),
    ]);
    client = postgres(pgUrl!, { max: 24, prepare: false, onnotice: () => {} });
    capHolder = postgres(pgUrl!, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    watcher = postgres(pgUrl!, { max: 1, prepare: false, onnotice: () => {} });
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    vi.useRealTimers();
    await Promise.all([client?.end(), capHolder?.end(), watcher?.end()]);
  });

  beforeEach(async () => {
    vi.useRealTimers();
    await client!.unsafe(
      [
        "delete from ai_usage;",
        "delete from conversation_logs;",
        "delete from cook_reports;",
        "delete from kitchen_queue;",
        "delete from kitchen_webhook_tokens;",
        "delete from doc_recipes;",
        "delete from recipe_ideas_cache;",
        "delete from invites;",
        "delete from members;",
        "delete from auth_session;",
        "delete from auth_account;",
        "delete from auth_verification;",
        "delete from auth_user;",
        "delete from kitchens where slug <> 'home';",
        "insert into kitchens (slug, name) values ('home', 'Home') on conflict (slug) do nothing;",
        "update kitchens set ai_monthly_cap_micros = null where slug = 'home';",
      ].join(" "),
    );
    // Warm the pool so all N connections exist before each forced race.
    await Promise.all(
      Array.from(
        { length: CAP_PARALLEL_CALLS },
        () => client!`select pg_sleep(0.05)`,
      ),
    );
  });

  describe("PostgreSQL invite concurrency", () => {
    async function addVerifiedUser(id: string, email: string) {
      await db
        .insert(authUser)
        .values({ id, name: id, email, emailVerified: true });
    }

    it("parallel first requests on a new-kitchen invite create one kitchen and one member and answer every request", async () => {
      await createInvite(
        { email: "racer@example.com", newKitchenName: "Race Kitchen" },
        db,
        { SOUS_SIGN_IN: "on" },
      );
      await addVerifiedUser("u-racer", "racer@example.com");

      const res = await settle(
        Array.from({ length: INVITE_PARALLEL_CALLS }, () =>
          resolveAccess(
            {
              mode: "sign-in",
              user: { id: "u-racer", email: "racer@example.com" },
            },
            db,
          ),
        ),
      );

      expect(res.otherErrors).toEqual([]);
      expect(res.notInvited).toBe(0);
      expect(res.ok).toHaveLength(INVITE_PARALLEL_CALLS);
      expect(new Set(res.ok.map((r) => r.member?.id)).size).toBe(1);
      expect(
        await db
          .select()
          .from(kitchens)
          .where(eq(kitchens.slug, "race-kitchen")),
      ).toHaveLength(1);
      expect(await db.select().from(members)).toHaveLength(1);
    });

    it("parallel first requests on an existing-kitchen invite create one member and answer every request", async () => {
      await createInvite(
        { email: "homecook@example.com", kitchenSlug: "home", role: "cook" },
        db,
        { SOUS_SIGN_IN: "on" },
      );
      await addVerifiedUser("u-home", "homecook@example.com");

      const res = await settle(
        Array.from({ length: INVITE_PARALLEL_CALLS }, () =>
          resolveAccess(
            {
              mode: "sign-in",
              user: { id: "u-home", email: "homecook@example.com" },
            },
            db,
          ),
        ),
      );

      expect(res.otherErrors).toEqual([]);
      expect(res.notInvited).toBe(0);
      expect(res.ok).toHaveLength(INVITE_PARALLEL_CALLS);
      expect(new Set(res.ok.map((r) => r.member?.id)).size).toBe(1);
      expect(await db.select().from(members)).toHaveLength(1);
    });

    it("two users whose emails normalize alike racing one invite yield one member and refuse the other user as not invited", async () => {
      await createInvite(
        { email: "shared@example.com", newKitchenName: "Shared Kitchen" },
        db,
        { SOUS_SIGN_IN: "on" },
      );
      await addVerifiedUser("u-one", "shared@example.com");
      await addVerifiedUser("u-two", "Shared@Example.com");

      const calls: Promise<unknown>[] = [];
      for (let i = 0; i < INVITE_PARALLEL_CALLS; i++) {
        calls.push(
          resolveAccess(
            {
              mode: "sign-in",
              user: { id: "u-one", email: "shared@example.com" },
            },
            db,
          ),
        );
        calls.push(
          resolveAccess(
            {
              mode: "sign-in",
              user: { id: "u-two", email: "Shared@Example.com" },
            },
            db,
          ),
        );
      }

      const res = await settle(calls);
      const memberRows = await db.select().from(members);

      expect(res.otherErrors).toEqual([]);
      expect(memberRows).toHaveLength(1);
      expect(res.ok).toHaveLength(INVITE_PARALLEL_CALLS);
      expect(res.notInvited).toBe(INVITE_PARALLEL_CALLS);
      expect(
        await db
          .select()
          .from(kitchens)
          .where(eq(kitchens.slug, "shared-kitchen")),
      ).toHaveLength(1);
    });

    it("uninvite waits for an in-flight invite acceptance and then refuses because the member exists", async () => {
      await createInvite(
        { email: "late@example.com", newKitchenName: "Late Kitchen" },
        db,
        { SOUS_SIGN_IN: "on" },
      );
      await addVerifiedUser("u-late", "late@example.com");
      await db.insert(authSession).values({
        id: "s-late",
        token: "tok-late",
        userId: "u-late",
        expiresAt: new Date(Date.now() + 86_400_000),
        updatedAt: new Date(),
      });

      // Hold a SHARE lock on `kitchens` from a third connection so `acceptInvite`
      // acquires the invite row's FOR UPDATE lock and blocks on inserting the kitchen.
      const holder = await client!.reserve();
      try {
        await holder`begin`;
        await holder`lock table kitchens in share mode`;

        const accepting = resolveAccess(
          {
            mode: "sign-in",
            user: { id: "u-late", email: "late@example.com" },
          },
          db,
        );
        await new Promise((r) => setTimeout(r, 300));

        let uninviteSettledEarly = false;
        const uninviting = uninviteEmail(
          { email: "late@example.com" },
          db,
          { SOUS_SIGN_IN: "on" },
        ).then(
          (value) => {
            uninviteSettledEarly = true;
            return { ok: true as const, value };
          },
          (err: unknown) => {
            uninviteSettledEarly = true;
            return { ok: false as const, err };
          },
        );
        await new Promise((r) => setTimeout(r, 300));
        expect(uninviteSettledEarly).toBe(false);

        await holder`commit`;

        const [accepted, uninviteOutcome] = await Promise.all([
          accepting,
          uninviting,
        ]);

        expect(accepted.kitchen.slug).toBe("late-kitchen");
        expect(accepted.member?.role).toBe("owner");

        expect(uninviteOutcome.ok).toBe(false);
        if (!uninviteOutcome.ok) {
          expect(uninviteOutcome.err).toBeInstanceOf(KitchenAdminError);
          expect((uninviteOutcome.err as Error).message).toMatch(
            /remove-member/,
          );
        }

        const memberRows = await db
          .select()
          .from(members)
          .where(eq(members.userId, "u-late"));
        expect(memberRows).toHaveLength(1);

        const [inv] = await db
          .select()
          .from(invites)
          .where(eq(invites.email, "late@example.com"));
        expect(inv?.acceptedAt).toBeInstanceOf(Date);
        expect(inv?.revokedAt).toBeNull();

        const sessions = await db
          .select()
          .from(authSession)
          .where(eq(authSession.userId, "u-late"));
        expect(sessions).toHaveLength(1);

        await expect(
          createBeforeCreateSession(db)({ userId: "u-late" }),
        ).resolves.toBeUndefined();
      } finally {
        await holder`rollback`.catch(() => {});
        holder.release();
      }
    });
  });

  describe("PostgreSQL AI cap concurrency", () => {
    // Each race case uses a separate holder connection to acquire an exclusive
    // lock on `kitchens`, forcing all N reservation transactions to block
    // together until every call is waiting, then releases the lock so they
    // contend at once.
    async function runForcedRace<T>(
      start: () => Promise<T>[],
    ): Promise<PromiseSettledResult<T>[]> {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const hold = capHolder!.begin(async (tx) => {
        await tx`lock table kitchens in access exclusive mode`;
        locked();
        await released;
      });
      await isLocked;

      const calls = start();
      try {
        // Wait until every call is parked behind either the advisory lock or the table lock.
        const deadline = Date.now() + 20_000;
        for (;;) {
          const [row] = await watcher!<Array<{ n: number }>>`
            select count(*)::int as n from pg_locks where not granted
          `;
          if ((row?.n ?? 0) >= calls.length) break;
          if (Date.now() > deadline) {
            throw new Error(
              `Timed out waiting for ${calls.length} blocked calls; only ${row?.n ?? 0} waiting`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        release();
        await hold;
      }

      return Promise.allSettled(calls);
    }

    it("forced race from one kitchen under a cap fitting 1 more call lets exactly 1 of 12 through", async () => {
      const [kitchen] = await db
        .insert(kitchens)
        .values({
          slug: "race-kitchen-cap",
          name: "Race Kitchen Cap",
          aiMonthlyCapMicros: ONE_COST * 2,
        })
        .returning();

      // Pre-spend 1 call so exactly 1 more call fits under the kitchen cap.
      await db.insert(aiUsage).values({
        kitchenId: kitchen!.id,
        feature: "ask",
        provider: "google",
        model: "race-test-model",
        status: "settled",
        reservedMicros: ONE_COST,
        costMicros: ONE_COST,
        settledAt: new Date(),
      });

      const settled = await runForcedRace(() =>
        Array.from({ length: CAP_PARALLEL_CALLS }, () =>
          reserveAiCall(
            {
              kitchenId: kitchen!.id,
              memberId: null,
              feature: "ask",
              provider: "google",
              model: "race-test-model",
              estimate: ONE_ESTIMATE,
            },
            { database: db, env: {}, prices: TEST_PRICES },
          ),
        ),
      );
      const res = tallyReserves(settled, "kitchen");

      expect(res.otherErrors).toEqual([]);
      expect(res.ok).toHaveLength(1);
      expect(res.capped).toBe(CAP_PARALLEL_CALLS - 1);

      const reservedRows = await db
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.status, "reserved"));
      expect(reservedRows).toHaveLength(1);
    });

    it("forced race across two kitchens under a deployment cap fitting 1 more call lets exactly 1 of 12 through", async () => {
      const [kitchenA, kitchenB] = await db
        .insert(kitchens)
        .values([
          {
            slug: "race-overall-a",
            name: "Race Overall A",
            aiMonthlyCapMicros: 5_000_000,
          },
          {
            slug: "race-overall-b",
            name: "Race Overall B",
            aiMonthlyCapMicros: 5_000_000,
          },
        ])
        .returning();

      // Overall cap is $0.02 (20,000 micros); pre-spend $0.01 (10,000 micros) in A
      // so exactly 1 more $0.01 call fits across A and B combined.
      await db.insert(aiUsage).values({
        kitchenId: kitchenA!.id,
        feature: "ask",
        provider: "google",
        model: "race-test-model",
        status: "settled",
        reservedMicros: ONE_COST,
        costMicros: ONE_COST,
        settledAt: new Date(),
      });

      const env = { SOUS_AI_TOTAL_CAP_USD: "0.02" };
      const half = CAP_PARALLEL_CALLS / 2;
      const settled = await runForcedRace(() => [
        ...Array.from({ length: half }, () =>
          reserveAiCall(
            {
              kitchenId: kitchenA!.id,
              memberId: null,
              feature: "ask",
              provider: "google",
              model: "race-test-model",
              estimate: ONE_ESTIMATE,
            },
            { database: db, env, prices: TEST_PRICES },
          ),
        ),
        ...Array.from({ length: half }, () =>
          reserveAiCall(
            {
              kitchenId: kitchenB!.id,
              memberId: null,
              feature: "ask",
              provider: "google",
              model: "race-test-model",
              estimate: ONE_ESTIMATE,
            },
            { database: db, env, prices: TEST_PRICES },
          ),
        ),
      ]);
      const res = tallyReserves(settled, "overall");

      expect(res.otherErrors).toEqual([]);
      expect(res.ok).toHaveLength(1);
      expect(res.capped).toBe(CAP_PARALLEL_CALLS - 1);

      const reservedRows = await db
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.status, "reserved"));
      expect(reservedRows).toHaveLength(1);
    });

    it("forced race from one kitchen under a cap fitting 3 calls lets exactly 3 of 12 through", async () => {
      const [kitchen] = await db
        .insert(kitchens)
        .values({
          slug: "race-kitchen-three",
          name: "Race Kitchen Three",
          aiMonthlyCapMicros: ONE_COST * 3,
        })
        .returning();

      const settled = await runForcedRace(() =>
        Array.from({ length: CAP_PARALLEL_CALLS }, () =>
          reserveAiCall(
            {
              kitchenId: kitchen!.id,
              memberId: null,
              feature: "ask",
              provider: "google",
              model: "race-test-model",
              estimate: ONE_ESTIMATE,
            },
            { database: db, env: {}, prices: TEST_PRICES },
          ),
        ),
      );
      const res = tallyReserves(settled, "kitchen");

      expect(res.otherErrors).toEqual([]);
      expect(res.ok).toHaveLength(3);
      expect(res.capped).toBe(CAP_PARALLEL_CALLS - 3);

      const reservedRows = await db
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.status, "reserved"));
      expect(reservedRows).toHaveLength(3);
    });

    it("uses PostgreSQL's own clock for month bounds even when the Node.js app clock is moved to another month", async () => {
      const [kitchen] = await db
        .insert(kitchens)
        .values({
          slug: "race-clock",
          name: "Race Clock",
          aiMonthlyCapMicros: 0,
        })
        .returning();

      const bounds = monthBounds();
      const [dbWindow] = await db
        .select({ end: bounds.end })
        .from(sql`(select 1) as _w`);
      const expectedResetsAt = new Date(dbWindow!.end).toISOString();

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2030-07-15T12:00:00.000Z"));

      let caught: unknown;
      try {
        await reserveAiCall(
          {
            kitchenId: kitchen!.id,
            memberId: null,
            feature: "ask",
            provider: "google",
            model: "race-test-model",
            estimate: { inputTokens: 100, outputTokens: 0, searchQueries: 0 },
          },
          { database: db, env: {}, prices: TEST_PRICES },
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AllowanceUsedError);
      expect((caught as AllowanceUsedError).resetsAt.toISOString()).toBe(
        expectedResetsAt,
      );
    });
  });
});
