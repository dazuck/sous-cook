import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  authSession,
  authUser,
  db,
  invites,
  kitchens,
  members,
} from "@/lib/db";
import {
  KitchenAdminError,
  createInvite,
  createWebhookToken,
  removeMember,
  uninviteEmail,
} from "./admin";
import { resolveAccess } from "./access";
import { resetDeploymentCheckForTests } from "./deployment";
import {
  NotInvitedError,
  acceptInvite,
  beforeCreateSession,
  beforeCreateUser,
} from "./invites";
import { slugFromName } from "./slug";
import { authenticateWebhookRequest } from "./webhook-tokens";
import { getAuth, resetAuthForTests } from "@/lib/auth/auth";
import { homeKitchen, seedQueueRow } from "@/lib/__tests__/kitchens";
import {
  TEST_AUTH_ENV,
  createTestAuth,
  signedInHeaders,
  stubSignInEnv,
} from "@/lib/__tests__/test-auth";
import { httpCall } from "@/lib/__tests__/trpc-http";

const client = (dbModule as unknown as { client: PGlite }).client;

beforeEach(async () => {
  stubSignInEnv();
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  await client.exec(
    "delete from conversation_logs; delete from cook_reports; delete from kitchen_queue; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");
});

afterEach(() => {
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function expectApiForbidden(
  promise: Promise<unknown>,
  messagePattern: RegExp,
) {
  try {
    await promise;
  } catch (err) {
    expect(err).toMatchObject({
      status: "FORBIDDEN",
      message: expect.stringMatching(messagePattern),
    });
    return;
  }
  throw new Error("Expected FORBIDDEN APIError");
}

describe("Invites, gates, slugs, and membership", () => {
  it("GATE-1: beforeCreateUser refuses uninvited, revoked, and accepted-orphan emails and writes no auth_user row", async () => {
    const auth = getAuth();
    expect(auth.options.databaseHooks?.user?.create?.before).toBe(
      beforeCreateUser,
    );
    const testAuth = createTestAuth(db);
    const ctx = await testAuth.$context;

    // 1. No invite at all.
    await expectApiForbidden(
      beforeCreateUser({
        email: "stranger@example.com",
        emailVerified: true,
      }),
      /Not invited/,
    );
    await expectApiForbidden(
      ctx.internalAdapter.createUser(
        {
          name: "Stranger",
          email: "stranger@example.com",
          emailVerified: true,
        },
        { method: "test" },
      ),
      /Not invited/,
    );

    // 2. Only invite is revoked.
    await createInvite(
      { email: "revoked@example.com", newKitchenName: "Revoked Kitchen" },
      db,
    );
    await uninviteEmail({ email: "revoked@example.com" }, db);
    await expectApiForbidden(
      beforeCreateUser({
        email: "revoked@example.com",
        emailVerified: true,
      }),
      /Not invited/,
    );
    await expectApiForbidden(
      ctx.internalAdapter.createUser(
        {
          name: "Revoked",
          email: "revoked@example.com",
          emailVerified: true,
        },
        { method: "test" },
      ),
      /Not invited/,
    );

    // 3. Only invite is already accepted, and its earlier user was deleted.
    await createInvite(
      { email: "accepted-gone@example.com", newKitchenName: "Old Kitchen" },
      db,
    );
    const firstUser = await ctx.test.saveUser(
      ctx.test.createUser({
        email: "accepted-gone@example.com",
        name: "First User",
        emailVerified: true,
      }),
    );
    const joined = await acceptInvite(
      firstUser.id,
      "accepted-gone@example.com",
      db,
    );
    expect(joined?.kitchen.slug).toBe("old-kitchen");
    // Deleting auth_user cascades to members while leaving the accepted invite.
    await db.delete(authUser).where(eq(authUser.id, firstUser.id));

    await expectApiForbidden(
      beforeCreateUser({
        email: "accepted-gone@example.com",
        emailVerified: true,
      }),
      /Not invited/,
    );
    await expectApiForbidden(
      ctx.internalAdapter.createUser(
        {
          name: "Returning",
          email: "accepted-gone@example.com",
          emailVerified: true,
        },
        { method: "test" },
      ),
      /Not invited/,
    );

    const remainingUsers = await db.select().from(authUser);
    expect(remainingUsers).toEqual([]);
  });

  it("GATE-2: invited email passes case-insensitively with trimmed spaces; first resolution creates kitchen and owner once, even under 10 concurrent calls", async () => {
    await createInvite(
      { email: "  Chef@Example.COM ", newKitchenName: "Sunny Kitchen" },
      db,
    );

    // Passes beforeCreateUser with mixed case and leading/trailing spaces.
    await expect(
      beforeCreateUser({
        email: "  CHEF@example.com  ",
        emailVerified: true,
      }),
    ).resolves.toBeUndefined();

    const testAuth = createTestAuth(db);
    const ctx = await testAuth.$context;
    const savedUser = await ctx.test.saveUser(
      ctx.test.createUser({
        email: "  Chef@Example.com  ",
        name: "Chef",
        emailVerified: true,
      }),
    );

    // Ten concurrent first resolutions create exactly one kitchen and one member.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        resolveAccess(
          {
            mode: "sign-in",
            user: { id: savedUser.id, email: "  CHEF@EXAMPLE.COM " },
          },
          db,
        ),
      ),
    );

    const first = results[0]!;
    expect(first.kitchen.slug).toBe("sunny-kitchen");
    expect(first.member?.role).toBe("owner");
    for (const res of results) {
      expect(res).toEqual(first);
    }

    const createdKitchens = await db
      .select()
      .from(kitchens)
      .where(eq(kitchens.slug, "sunny-kitchen"));
    expect(createdKitchens).toHaveLength(1);

    const createdMembers = await db
      .select()
      .from(members)
      .where(eq(members.userId, savedUser.id));
    expect(createdMembers).toHaveLength(1);

    const [inviteRow] = await db
      .select()
      .from(invites)
      .where(eq(invites.email, "chef@example.com"));
    expect(inviteRow?.acceptedAt).toBeInstanceOf(Date);
    expect(inviteRow?.acceptedUserId).toBe(savedUser.id);

    // Second resolution creates nothing new and returns the same membership.
    const second = await resolveAccess(
      {
        mode: "sign-in",
        user: { id: savedUser.id, email: savedUser.email },
      },
      db,
    );
    expect(second).toEqual(first);
    expect(await db.select().from(members)).toHaveLength(1);
  });

  it("GATE-2 (defect path): a database error inside acceptInvite logs the invite id and answers INTERNAL_SERVER_ERROR, never not-invited", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await createInvite(
      { email: "clash@example.com", newKitchenName: "Clash Kitchen" },
      db,
    );
    const testAuth = createTestAuth(db);
    const ctx = await testAuth.$context;
    const savedUser = await ctx.test.saveUser(
      ctx.test.createUser({
        email: "clash@example.com",
        name: "Clash",
        emailVerified: true,
      }),
    );
    const headers = await signedInHeaders(savedUser.id, db);

    // Simulate an out-of-band slug clash so acceptInvite's kitchen insert fails.
    await db
      .insert(kitchens)
      .values({ slug: "clash-kitchen", name: "Existing Clash" });

    const res = await httpCall<{
      error: { data: { code: string; reason?: string } };
    }>("getKitchenQueue", { status: "pending" }, { method: "GET", headers });
    expect(res.status).toBe(500);
    expect(res.body.error.data.code).toBe("INTERNAL_SERVER_ERROR");
    expect(res.body.error.data.reason).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      "[invites] acceptInvite failed",
      expect.objectContaining({ inviteId: created.id }),
    );
    errSpy.mockRestore();
  });

  it("GATE-3: inviting someone into existing kitchen home as cook lets them see home's queue", async () => {
    const home = await homeKitchen(db);
    const row = await seedQueueRow(db, home.id, {
      recipeData: { name: "Home Soup", steps: ["Simmer."], serves: 4 },
    });

    await createInvite(
      { email: "cook@example.com", kitchenSlug: "home", role: "cook" },
      db,
    );

    const testAuth = createTestAuth(db);
    const ctx = await testAuth.$context;
    const savedUser = await ctx.test.saveUser(
      ctx.test.createUser({
        email: "cook@example.com",
        name: "Home Cook",
        emailVerified: true,
      }),
    );
    const headers = await signedInHeaders(savedUser.id, db);

    const res = await httpCall<{
      result: { data: Array<{ id: string }> };
    }>("getKitchenQueue", { status: "pending" }, { method: "GET", headers });
    expect(res.status).toBe(200);
    expect(res.body.result.data.map((r) => r.id)).toEqual([row.id]);

    const [member] = await db
      .select()
      .from(members)
      .where(eq(members.userId, savedUser.id));
    expect(member?.kitchenId).toBe(home.id);
    expect(member?.role).toBe("cook");
  });

  it("GATE-4: an unverified email is refused at user creation and writes no auth_user row", async () => {
    await createInvite(
      { email: "unverified@example.com", newKitchenName: "Unverified Kitchen" },
      db,
    );

    await expectApiForbidden(
      beforeCreateUser({
        email: "unverified@example.com",
        emailVerified: false,
      }),
      /not verified/i,
    );

    const testAuth = createTestAuth(db);
    const ctx = await testAuth.$context;
    await expectApiForbidden(
      ctx.internalAdapter.createUser(
        {
          name: "Unverified",
          email: "unverified@example.com",
          emailVerified: false,
        },
        { method: "test" },
      ),
      /not verified/i,
    );

    expect(await db.select().from(authUser)).toEqual([]);
  });

  it("GATE-5: removeMember revokes invite, deletes member and sessions, handles mixed-case email, requires token flag, and revokes tokens when last member", async () => {
    const home = await homeKitchen(db);
    // Insert a member whose auth_user.email has capital letters.
    await createInvite(
      { email: "person@example.com", kitchenSlug: "home", role: "owner" },
      db,
    );
    await db.insert(authUser).values({
      id: "user-cap",
      name: "Person",
      email: "Person@Example.com",
      emailVerified: true,
    });
    const access = await resolveAccess(
      {
        mode: "sign-in",
        user: { id: "user-cap", email: "Person@Example.com" },
      },
      db,
    );
    expect(access.kitchen.id).toBe(home.id);
    const headersCap = await signedInHeaders("user-cap", db);

    // Add a second member so home is not left empty during the first removal.
    await createInvite(
      { email: "second@example.com", kitchenSlug: "home", role: "cook" },
      db,
    );
    await db.insert(authUser).values({
      id: "user-second",
      name: "Second",
      email: "second@example.com",
      emailVerified: true,
    });
    await resolveAccess(
      {
        mode: "sign-in",
        user: { id: "user-second", email: "second@example.com" },
      },
      db,
    );

    const token1 = await createWebhookToken(
      { kitchenSlug: "home", label: "kitchen-tablet-agent" },
      db,
    );

    // Without a token flag, refuses, lists the token by label, and changes nothing.
    await expect(
      removeMember({ email: "person@example.com" }, db),
    ).rejects.toThrow(
      new RegExp(
        `kitchen-tablet-agent.*--revoke-tokens.*--keep-tokens`,
        "s",
      ),
    );
    expect(
      await db.select().from(members).where(eq(members.userId, "user-cap")),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(authSession)
        .where(eq(authSession.userId, "user-cap")),
    ).toHaveLength(1);

    // With --keep-tokens while another member remains: removes person, keeps token live.
    const removed1 = await removeMember(
      { email: "person@example.com", tokenAction: "keep" },
      db,
    );
    expect(removed1.sessionsDeleted).toBe(1);
    expect(removed1.invitesRevoked).toBe(1);
    expect(removed1.wasLastMember).toBe(false);
    expect(removed1.revokedTokens).toEqual([]);

    // Next request with person's old session cookie answers UNAUTHORIZED.
    const afterRemoveRes = await httpCall<{
      error: { data: { code: string } };
    }>(
      "getKitchenQueue",
      { status: "pending" },
      { method: "GET", headers: headersCap },
    );
    expect(afterRemoveRes.status).toBe(401);
    expect(afterRemoveRes.body.error.data.code).toBe("UNAUTHORIZED");

    // Signing in again is refused by beforeCreateSession.
    await expectApiForbidden(
      beforeCreateSession({ userId: "user-cap" }),
      /Not invited/,
    );

    // Token stayed live because second member remains and --keep-tokens was passed.
    const stillValid = await authenticateWebhookRequest(
      new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/packs`, {
        headers: { Authorization: `Bearer ${token1.token}` },
      }),
    );
    expect(stillValid.ok).toBe(true);

    // Removing the last member with --keep-tokens STILL revokes the kitchen's tokens.
    const removedLast = await removeMember(
      { email: "second@example.com", tokenAction: "keep" },
      db,
    );
    expect(removedLast.wasLastMember).toBe(true);
    expect(removedLast.revokedTokens.map((t) => t.label)).toEqual([
      "kitchen-tablet-agent",
    ]);

    const revokedAuth = await authenticateWebhookRequest(
      new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/packs`, {
        headers: { Authorization: `Bearer ${token1.token}` },
      }),
    );
    expect(revokedAuth.ok).toBe(false);
    if (!revokedAuth.ok) {
      expect(revokedAuth.response.status).toBe(401);
    }

    // Also verify --revoke-tokens revokes tokens even when another member remains.
    await createInvite(
      { email: "stay@example.com", kitchenSlug: "home", role: "owner" },
      db,
    );
    await createInvite(
      { email: "leave@example.com", kitchenSlug: "home", role: "cook" },
      db,
    );
    await db.insert(authUser).values([
      { id: "user-stay", name: "Stay", email: "stay@example.com", emailVerified: true },
      { id: "user-leave", name: "Leave", email: "leave@example.com", emailVerified: true },
    ]);
    await resolveAccess(
      { mode: "sign-in", user: { id: "user-stay", email: "stay@example.com" } },
      db,
    );
    await resolveAccess(
      { mode: "sign-in", user: { id: "user-leave", email: "leave@example.com" } },
      db,
    );
    const token2 = await createWebhookToken(
      { kitchenSlug: "home", label: "second-agent" },
      db,
    );
    const removedRevoke = await removeMember(
      { email: "leave@example.com", tokenAction: "revoke" },
      db,
    );
    expect(removedRevoke.wasLastMember).toBe(false);
    expect(removedRevoke.revokedTokens.map((t) => t.label)).toEqual([
      "second-agent",
    ]);
    const token2Auth = await authenticateWebhookRequest(
      new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/packs`, {
        headers: { Authorization: `Bearer ${token2.token}` },
      }),
    );
    expect(token2Auth.ok).toBe(false);
    if (!token2Auth.ok) {
      expect(token2Auth.response.status).toBe(401);
    }
  });

  it("GATE-6: a signed-in user with no member and no pending invite gets FORBIDDEN not-invited and beforeCreateSession refuses", async () => {
    // Give the user a pending invite just long enough to create a genuine session cookie,
    // then revoke the invite directly (leaving the session row intact to exercise the runtime gate).
    await createInvite(
      { email: "dropped@example.com", newKitchenName: "Dropped Kitchen" },
      db,
    );
    const testAuth = createTestAuth(db);
    const ctx = await testAuth.$context;
    const savedUser = await ctx.test.saveUser(
      ctx.test.createUser({
        email: "dropped@example.com",
        name: "Dropped",
        emailVerified: true,
      }),
    );
    const headers = await signedInHeaders(savedUser.id, db);
    await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.email, "dropped@example.com"));

    const res = await httpCall<{
      error: { data: { code: string; reason?: string } };
    }>("getKitchenQueue", { status: "pending" }, { method: "GET", headers });
    expect(res.status).toBe(403);
    expect(res.body.error.data.code).toBe("FORBIDDEN");
    expect(res.body.error.data.reason).toBe("not-invited");

    await expectApiForbidden(
      beforeCreateSession({ userId: savedUser.id }),
      /Not invited/,
    );
  });

  it("GATE-8: slugFromName derives slugs, enforces rules, reserves slugs on pending invites, and acceptInvite uses the stored slug", async () => {
    expect(slugFromName("Their Kitchen!")).toBe("their-kitchen");
    expect(slugFromName("Crème Brûlée Club")).toBe("creme-brulee-club");

    const longSlug = slugFromName(
      "A Very Long Household Kitchen Name With Plenty Of Extra Words Beyond Forty",
    );
    expect(longSlug.length).toBeLessThanOrEqual(40);
    expect(longSlug.endsWith("-")).toBe(false);

    expect(slugFromName("!!!")).toBe("");
    expect(slugFromName("料理教室")).toBe("");

    await expect(
      createInvite({ email: "punct@example.com", newKitchenName: "!!!" }, db),
    ).rejects.toThrow(KitchenAdminError);
    await expect(
      createInvite({ email: "punct@example.com", newKitchenName: "!!!" }, db),
    ).rejects.toThrow(/--slug/);

    await expect(
      createInvite({ email: "nonlatin@example.com", newKitchenName: "料理教室" }, db),
    ).rejects.toThrow(/--slug/);

    // Explicit --slug works for non-Latin names.
    const explicit = await createInvite(
      {
        email: "nonlatin@example.com",
        newKitchenName: "料理教室",
        slug: "ryori-club",
      },
      db,
    );
    expect(explicit.kitchenSlug).toBe("ryori-club");

    // "Home" clashes with existing home kitchen.
    await expect(
      createInvite({ email: "home2@example.com", newKitchenName: "Home" }, db),
    ).rejects.toThrow(/home/);

    // Second pending invite producing the same slug refuses.
    await createInvite(
      { email: "first@example.com", newKitchenName: "Their Kitchen!" },
      db,
    );
    await expect(
      createInvite(
        { email: "second@example.com", newKitchenName: "their kitchen" },
        db,
      ),
    ).rejects.toThrow(/their-kitchen/);

    // Invalid --slug refuses.
    await expect(
      createInvite(
        {
          email: "badslug@example.com",
          newKitchenName: "Valid Name",
          slug: "Bad_Slug!",
        },
        db,
      ),
    ).rejects.toThrow(/Invalid kitchen slug/);

    // Stored slug is used verbatim by acceptInvite.
    const [storedInvite] = await db
      .select()
      .from(invites)
      .where(eq(invites.email, "nonlatin@example.com"));
    expect(storedInvite?.newKitchenSlug).toBe("ryori-club");

    await db.insert(authUser).values({
      id: "user-ryori",
      name: "Ryori Owner",
      email: "nonlatin@example.com",
      emailVerified: true,
    });
    const accepted = await acceptInvite(
      "user-ryori",
      "nonlatin@example.com",
      db,
    );
    expect(accepted?.kitchen.slug).toBe("ryori-club");
  });

  it("GATE-9: deleting a member's auth_user or member row gives no way back in through an old accepted invite; uninvite clears the orphan for a new invite", async () => {
    await createInvite(
      { email: "once@example.com", newKitchenName: "Once Kitchen" },
      db,
    );
    const testAuth = createTestAuth(db);
    const ctx = await testAuth.$context;
    const user1 = await ctx.test.saveUser(
      ctx.test.createUser({
        email: "once@example.com",
        name: "Once",
        emailVerified: true,
      }),
    );
    const headers1 = await signedInHeaders(user1.id, db);

    const firstAccess = await resolveAccess(
      { mode: "sign-in", user: { id: user1.id, email: user1.email } },
      db,
    );
    expect(firstAccess.kitchen.slug).toBe("once-kitchen");

    // Case A: member row deleted while auth_user and session still exist -> FORBIDDEN not-invited, no second kitchen created.
    await db.delete(members).where(eq(members.userId, user1.id));
    await expect(
      resolveAccess(
        { mode: "sign-in", user: { id: user1.id, email: user1.email } },
        db,
      ),
    ).rejects.toBeInstanceOf(NotInvitedError);

    const forbiddenRes = await httpCall<{
      error: { data: { code: string; reason?: string } };
    }>(
      "getKitchenQueue",
      { status: "pending" },
      { method: "GET", headers: headers1 },
    );
    expect(forbiddenRes.status).toBe(403);
    expect(forbiddenRes.body.error.data.reason).toBe("not-invited");
    expect(await db.select().from(kitchens)).toHaveLength(2); // home + once-kitchen only

    // Case B: auth_user deleted (cascading to members/sessions) -> signing in again refused at user creation.
    await db.delete(authUser).where(eq(authUser.id, user1.id));
    await expectApiForbidden(
      ctx.internalAdapter.createUser(
        { name: "Once Again", email: "once@example.com", emailVerified: true },
        { method: "test" },
      ),
      /Not invited/,
    );

    // uninvite revokes the orphaned accepted invite so a fresh invite is allowed.
    const uninvited = await uninviteEmail({ email: "once@example.com" }, db);
    expect(uninvited.wasAcceptedOrphan).toBe(true);

    const reInvited = await createInvite(
      { email: "once@example.com", kitchenSlug: "once-kitchen", role: "owner" },
      db,
    );
    expect(reInvited.kitchenSlug).toBe("once-kitchen");
  });

  it("GATE-10: uninvite deletes pre-first-request sessions so next request is UNAUTHORIZED, and refuses for active members pointing to remove-member", async () => {
    await createInvite(
      { email: "signed-only@example.com", newKitchenName: "Never Joined" },
      db,
    );
    const testAuth = createTestAuth(db);
    const ctx = await testAuth.$context;
    const user = await ctx.test.saveUser(
      ctx.test.createUser({
        email: "signed-only@example.com",
        name: "Signed Only",
        emailVerified: true,
      }),
    );
    const headers = await signedInHeaders(user.id, db);

    // They signed in (session row exists) but have not made a tRPC request yet (no member row).
    expect(
      await db.select().from(authSession).where(eq(authSession.userId, user.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(members).where(eq(members.userId, user.id)),
    ).toHaveLength(0);

    const result = await uninviteEmail(
      { email: "signed-only@example.com" },
      db,
    );
    expect(result.wasAcceptedOrphan).toBe(false);
    expect(result.sessionsDeleted).toBe(1);

    // Next request answers UNAUTHORIZED (session was deleted).
    const res = await httpCall<{ error: { data: { code: string } } }>(
      "getKitchenQueue",
      { status: "pending" },
      { method: "GET", headers },
    );
    expect(res.status).toBe(401);
    expect(res.body.error.data.code).toBe("UNAUTHORIZED");

    // Active member: uninvite refuses and points to remove-member.
    await createInvite(
      { email: "active@example.com", kitchenSlug: "home", role: "cook" },
      db,
    );
    const activeUser = await ctx.test.saveUser(
      ctx.test.createUser({
        email: "active@example.com",
        name: "Active",
        emailVerified: true,
      }),
    );
    await resolveAccess(
      { mode: "sign-in", user: { id: activeUser.id, email: activeUser.email } },
      db,
    );

    await expect(
      uninviteEmail({ email: "active@example.com" }, db),
    ).rejects.toThrow(/remove-member/);
  });
});
