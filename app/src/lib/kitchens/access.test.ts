import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../hooks/types");
  return {
    connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, false])),
  };
});
vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db, kitchens, members } from "@/lib/db";
import { resetAuthForTests } from "@/lib/auth/auth";
import { createInvite } from "./admin";
import { resetDeploymentCheckForTests } from "./deployment";
import {
  homeKitchen,
  seedKitchen,
  seedQueueRow,
} from "@/lib/__tests__/kitchens";
import {
  TEST_AUTH_ENV,
  createTestAuth,
  signedInHeaders,
  stubSignInEnv,
} from "@/lib/__tests__/test-auth";
import { httpCall } from "@/lib/__tests__/trpc-http";
import { requireOwnedQueueItem } from "@/server/kitchen-access";
import {
  createTRPCContext,
  kitchenProcedure,
  publicProcedure,
  router,
  type TRPCContext,
} from "@/server/trpc";

const client = (dbModule as unknown as { client: PGlite }).client;

const probeRouter = router({
  health: publicProcedure.query(() => ({ status: "ok" })),
  whoami: kitchenProcedure.query(({ ctx }) => ({
    kitchen: ctx.kitchen,
    member: ctx.member,
  })),
});

async function countAllTables(): Promise<Record<string, number>> {
  const tables = [
    "kitchens",
    "members",
    "invites",
    "auth_user",
    "auth_session",
    "auth_account",
    "auth_verification",
    "kitchen_queue",
    "kitchen_webhook_tokens",
    "conversation_logs",
    "cook_reports",
    "doc_recipes",
    "recipe_ideas_cache",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const res = await client.query<{ n: string }>(
      `select count(*)::text as n from "${table}"`,
    );
    counts[table] = Number(res.rows[0]?.n ?? 0);
  }
  return counts;
}

beforeEach(async () => {
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  await client.exec(
    "delete from kitchen_queue; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");
});

afterEach(() => {
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

describe("Kitchen access context (CTX-1 to CTX-4)", () => {
  it("CTX-1: sign-in mode resolves A's kitchen and member from session cookie, and createTRPCContext alone writes nothing", async () => {
    stubSignInEnv();
    const { kitchen: kitchenA, member: memberA, user: userA } =
      await seedKitchen(db, {
        slug: "kitchen-a",
        name: "Kitchen A",
      });

    const headers = await signedInHeaders(userA.id, db);
    const countsBefore = await countAllTables();

    const ctx = await createTRPCContext({
      req: new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/trpc/whoami`, {
        method: "GET",
        headers,
      }),
    });

    // createTRPCContext alone writes nothing to any table.
    expect(await countAllTables()).toEqual(countsBefore);
    expect(ctx.session?.user.id).toBe(userA.id);

    const caller = probeRouter.createCaller(ctx);
    const result = await caller.whoami();
    expect(result).toEqual({
      kitchen: { id: kitchenA.id, slug: "kitchen-a" },
      member: { id: memberA.id, role: "owner" },
    });
  });

  it("CTX-2: sign-in mode with no cookie has no session and answers UNAUTHORIZED", async () => {
    stubSignInEnv();

    const ctx = await createTRPCContext({
      req: new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/trpc/whoami`, {
        method: "GET",
      }),
    });
    expect(ctx.session).toBeNull();

    const caller = probeRouter.createCaller(ctx);
    await expect(caller.whoami()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign in required",
    });
  });

  it("CTX-3: single-kitchen mode with no cookie gives the home kitchen and a null member", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "off");
    const home = await homeKitchen(db);

    const req = new Request("http://localhost:3000/api/trpc/whoami", {
      method: "GET",
    });
    const ctx = await createTRPCContext({ req });
    const caller = probeRouter.createCaller(ctx);

    const result = await caller.whoami();
    expect(result).toEqual({
      kitchen: { id: home.id, slug: "home" },
      member: null,
    });
  });

  it("CTX-4: sign-in mode refuses cross-site Origin and Sec-Fetch-Site headers before accepting invites or running procedures", async () => {
    stubSignInEnv();
    const { kitchen: kitchenA, user: userA } = await seedKitchen(db, {
      slug: "kitchen-a",
      name: "Kitchen A",
    });
    await seedQueueRow(db, kitchenA.id, {
      recipeData: { name: "Pasta", steps: ["Boil."], serves: 2 },
    });
    const sessionHeaders = await signedInHeaders(userA.id, db);

    // POST mutation with evil Origin -> FORBIDDEN.
    const evilOriginHeaders = new Headers(sessionHeaders);
    evilOriginHeaders.set("Origin", "https://evil.example.com");
    const badOriginRes = await httpCall<{
      error: { data: { code: string } };
    }>(
      "removeFromKitchenQueue",
      { queueId: "00000000-0000-4000-8000-000000000000" },
      { method: "POST", headers: evilOriginHeaders },
    );
    expect(badOriginRes.status).toBe(403);
    expect(badOriginRes.body.error.data.code).toBe("FORBIDDEN");

    // GET query with Sec-Fetch-Site: cross-site and same-site -> FORBIDDEN.
    for (const badSite of ["cross-site", "same-site"]) {
      const badSiteHeaders = new Headers(sessionHeaders);
      badSiteHeaders.set("Sec-Fetch-Site", badSite);
      const res = await httpCall<{ error: { data: { code: string } } }>(
        "getKitchenQueue",
        { status: "pending" },
        { method: "GET", headers: badSiteHeaders },
      );
      expect(res.status).toBe(403);
      expect(res.body.error.data.code).toBe("FORBIDDEN");
    }

    // Same GET with same-origin, none, and neither header is served.
    for (const goodSite of ["same-origin", "none", null]) {
      const okHeaders = new Headers(sessionHeaders);
      if (goodSite !== null) {
        okHeaders.set("Sec-Fetch-Site", goodSite);
      }
      const res = await httpCall<{ result: { data: unknown[] } }>(
        "getKitchenQueue",
        { status: "pending" },
        { method: "GET", headers: okHeaders },
      );
      expect(res.status).toBe(200);
      expect(res.body.result.data).toHaveLength(1);
    }

    // Pending new-kitchen invite + fresh session: cross-site request and health
    // create no kitchen and no member; first same-origin call does.
    await createInvite(
      { email: "pending@example.com", newKitchenName: "Fresh House" },
      db,
    );
    const testAuth = createTestAuth(db);
    const authCtx = await testAuth.$context;
    const pendingUser = await authCtx.test.saveUser(
      authCtx.test.createUser({
        email: "pending@example.com",
        name: "Pending Owner",
        emailVerified: true,
      }),
    );
    const pendingHeaders = await signedInHeaders(pendingUser.id, db);

    const crossSitePendingHeaders = new Headers(pendingHeaders);
    crossSitePendingHeaders.set("Sec-Fetch-Site", "cross-site");
    const blockedRes = await httpCall<{ error: { data: { code: string } } }>(
      "getKitchenQueue",
      { status: "pending" },
      { method: "GET", headers: crossSitePendingHeaders },
    );
    expect(blockedRes.status).toBe(403);
    expect(blockedRes.body.error.data.code).toBe("FORBIDDEN");

    const healthRes = await httpCall<{ result: { data: { status: string } } }>(
      "health",
      undefined,
      { method: "GET", headers: pendingHeaders },
    );
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.result.data.status).toBe("ok");

    expect(
      await db.select().from(kitchens).where(eq(kitchens.slug, "fresh-house")),
    ).toEqual([]);
    expect(
      await db.select().from(members).where(eq(members.userId, pendingUser.id)),
    ).toEqual([]);

    // First same-origin call accepts the invite and creates kitchen + member.
    const sameOriginHeaders = new Headers(pendingHeaders);
    sameOriginHeaders.set("Sec-Fetch-Site", "same-origin");
    const firstCall = await httpCall<{ result: { data: unknown[] } }>(
      "getKitchenQueue",
      { status: "pending" },
      { method: "GET", headers: sameOriginHeaders },
    );
    expect(firstCall.status).toBe(200);
    expect(
      await db.select().from(kitchens).where(eq(kitchens.slug, "fresh-house")),
    ).toHaveLength(1);
    expect(
      await db.select().from(members).where(eq(members.userId, pendingUser.id)),
    ).toHaveLength(1);
  });

  it("gated test seam cannot be reached over HTTP or via a plain forged context object", async () => {
    stubSignInEnv();
    const { kitchen: kitchenA } = await seedKitchen(db, {
      slug: "kitchen-a",
      name: "Kitchen A",
    });

    // Forging a plain context object carrying a `kitchen` property does NOT bypass kitchenProcedure.
    const forgedCtx = {
      db,
      headers: new Headers(),
      mode: "sign-in",
      session: null,
      kitchen: { id: kitchenA.id, slug: kitchenA.slug },
      member: null,
    } as unknown as TRPCContext;
    const forgedCaller = probeRouter.createCaller(forgedCtx);
    await expect(forgedCaller.whoami()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign in required",
    });

    // HTTP requests carrying kitchen / kitchenId headers or inputs without a session get UNAUTHORIZED.
    const httpRes = await httpCall<{ error: { data: { code: string } } }>(
      "getKitchenQueue",
      { status: "pending", kitchenId: kitchenA.id },
      {
        method: "GET",
        headers: {
          "x-kitchen-id": kitchenA.id,
          "x-test-context": "true",
        },
      },
    );
    expect(httpRes.status).toBe(401);
    expect(httpRes.body.error.data.code).toBe("UNAUTHORIZED");
  });

  it("refuses in single-kitchen mode when the home kitchen is missing", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "off");
    const home = await homeKitchen(db);
    await client.exec("delete from kitchens where slug = 'home'");

    try {
      await expect(
        createTRPCContext({
          req: new Request("http://localhost:3000/api/trpc/whoami"),
        }),
      ).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: expect.stringContaining("db:migrate"),
      });
    } finally {
      await client.query(
        `insert into kitchens (id, slug, name) values ($1, 'home', 'Home')`,
        [home.id],
      );
    }
  });

  it("requireOwnedQueueItem returns the kitchen's own row and throws NOT_FOUND for missing or other kitchens' ids", async () => {
    const home = await homeKitchen(db);
    const { kitchen: other } = await seedKitchen(db, {
      slug: "other-kitchen",
      name: "Other Kitchen",
    });
    const homeRow = await seedQueueRow(db, home.id, {
      recipeData: { name: "Home Soup" },
    });
    const otherRow = await seedQueueRow(db, other.id, {
      recipeData: { name: "Other Stew" },
    });

    const found = await requireOwnedQueueItem(home.id, homeRow.id);
    expect(found.id).toBe(homeRow.id);

    const missingErr = await requireOwnedQueueItem(
      home.id,
      "00000000-0000-4000-8000-000000000000",
    ).catch((e: unknown) => e);
    const foreignErr = await requireOwnedQueueItem(home.id, otherRow.id).catch(
      (e: unknown) => e,
    );

    expect(missingErr).toBeInstanceOf(TRPCError);
    expect(foreignErr).toBeInstanceOf(TRPCError);
    expect((missingErr as TRPCError).code).toBe("NOT_FOUND");
    expect((foreignErr as TRPCError).code).toBe("NOT_FOUND");
    expect((foreignErr as TRPCError).message).toBe(
      (missingErr as TRPCError).message,
    );
  });
});
