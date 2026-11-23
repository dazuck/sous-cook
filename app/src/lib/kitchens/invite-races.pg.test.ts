/**
 * Concurrency tests for invite acceptance and revocation against a real
 * PostgreSQL server with parallel connections.
 *
 * Skipped unless `SOUS_TEST_POSTGRES_URL` points at a migrated, disposable
 * PostgreSQL database. Before connecting or deleting rows, this file refuses
 * to run unless the database name in `SOUS_TEST_POSTGRES_URL` contains "test"
 * (for example `sous_test`):
 *
 *   SOUS_TEST_POSTGRES_URL=postgres://localhost:5432/sous_test \
 *     pnpm --dir app test:run src/lib/kitchens/invite-races.pg.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import * as schema from "../../../drizzle/schema";
import {
  authSession,
  authUser,
  invites,
  kitchens,
  members,
} from "../../../drizzle/schema";
import { resolveAccess } from "./access";
import { KitchenAdminError, createInvite, uninviteEmail } from "./admin";
import { NotInvitedError, createBeforeCreateSession } from "./invites";

const pgUrl = process.env.SOUS_TEST_POSTGRES_URL;
const PARALLEL_CALLS = 10;

function assertTestDatabaseUrl(rawUrl: string): void {
  let dbName: string;
  try {
    const parsed = new URL(rawUrl);
    dbName = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, ""));
  } catch {
    throw new Error(
      'Refusing to run invite concurrency tests: SOUS_TEST_POSTGRES_URL must be a valid PostgreSQL URL whose database name contains "test" (for example, sous_test).',
    );
  }
  if (!dbName || !dbName.toLowerCase().includes("test")) {
    throw new Error(
      `Refusing to run invite concurrency tests: database name "${dbName}" in SOUS_TEST_POSTGRES_URL must contain "test" (for example, sous_test).`,
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

describe.skipIf(!pgUrl)("PostgreSQL invite concurrency", () => {
  let client: Sql | undefined;
  let db: PostgresJsDatabase<typeof schema>;

  beforeAll(async () => {
    assertTestDatabaseUrl(pgUrl!);
    const [{ default: postgres }, { drizzle }] = await Promise.all([
      import("postgres"),
      import("drizzle-orm/postgres-js"),
    ]);
    client = postgres(pgUrl!, { max: 24, prepare: false, onnotice: () => {} });
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  beforeEach(async () => {
    await client!.unsafe(
      "delete from conversation_logs; delete from cook_reports; delete from kitchen_queue; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user; delete from doc_recipes; delete from recipe_ideas_cache; delete from kitchens where slug <> 'home';",
    );
  });

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
      Array.from({ length: PARALLEL_CALLS }, () =>
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
    expect(res.ok).toHaveLength(PARALLEL_CALLS);
    expect(new Set(res.ok.map((r) => r.member?.id)).size).toBe(1);
    expect(
      await db.select().from(kitchens).where(eq(kitchens.slug, "race-kitchen")),
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
      Array.from({ length: PARALLEL_CALLS }, () =>
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
    expect(res.ok).toHaveLength(PARALLEL_CALLS);
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
    for (let i = 0; i < PARALLEL_CALLS; i++) {
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
    expect(res.ok).toHaveLength(PARALLEL_CALLS);
    expect(res.notInvited).toBe(PARALLEL_CALLS);
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
        expect((uninviteOutcome.err as Error).message).toMatch(/remove-member/);
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
