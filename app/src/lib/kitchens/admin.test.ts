import { createHash } from "node:crypto";
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
  kitchenWebhookTokens,
  members,
} from "@/lib/db";
import { homeKitchen, seedKitchen } from "@/lib/__tests__/kitchens";
import {
  createTestAuth,
  signedInHeaders,
  stubSignInEnv,
} from "@/lib/__tests__/test-auth";
import { resetDeploymentCheckForTests } from "./deployment";
import { resolveAccess } from "./access";
import {
  KitchenAdminError,
  createInvite,
  createWebhookToken,
  formatRemoveMemberSummary,
  listKitchens,
  listWebhookTokens,
  removeMember,
  renameKitchen,
  revokeWebhookToken,
  uninviteEmail,
} from "./admin";
import { authenticateWebhookRequest } from "./webhook-tokens";

const client = (dbModule as unknown as { client: PGlite }).client;

async function expectKitchenAdminError(
  promise: Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(KitchenAdminError);
  expect((caught as Error).message).toMatch(messagePattern);
}

beforeEach(async () => {
  stubSignInEnv();
  resetDeploymentCheckForTests(db);
  await client.exec(
    "delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");
  await client.exec("update kitchens set name = 'Home' where slug = 'home'");
});

afterEach(() => {
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

describe("Webhook token admin commands", () => {
  it("creates a token stored only as SHA-256, authenticates requests, lists without secret, and revokes it", async () => {
    await seedKitchen(db, { slug: "north", name: "North Kitchen" });

    const created = await createWebhookToken(
      { kitchenSlug: "north", label: "chat agent" },
      db,
    );
    expect(created.token).toMatch(/^sous_[A-Za-z0-9_-]+$/);
    expect(created.kitchenSlug).toBe("north");
    expect(created.label).toBe("chat agent");

    const [stored] = await db
      .select()
      .from(kitchenWebhookTokens)
      .where(eq(kitchenWebhookTokens.id, created.id));
    expect(stored?.tokenSha256).toBe(
      createHash("sha256").update(created.token).digest("hex"),
    );
    expect(stored?.tokenSha256).not.toBe(created.token);

    // Works for webhook authentication and stamps last_used_at.
    const okAuth = await authenticateWebhookRequest(
      new Request("http://localhost/api/packs", {
        headers: { Authorization: `Bearer ${created.token}` },
      }),
    );
    expect(okAuth.ok).toBe(true);
    if (okAuth.ok) {
      expect(okAuth.kitchen.slug).toBe("north");
    }

    // Listing exposes metadata and never the token or hash.
    const listedAll = await listWebhookTokens({}, db);
    expect(listedAll).toHaveLength(1);
    expect(listedAll[0]).toMatchObject({
      id: created.id,
      kitchenSlug: "north",
      label: "chat agent",
      revokedAt: null,
    });
    expect(listedAll[0]?.lastUsedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(listedAll)).not.toContain(created.token);
    expect(JSON.stringify(listedAll)).not.toContain(stored!.tokenSha256);

    // Filtering by kitchen slug returns only that kitchen's tokens.
    expect(await listWebhookTokens({ kitchenSlug: "home" }, db)).toEqual([]);
    expect(await listWebhookTokens({ kitchenSlug: "north" }, db)).toHaveLength(
      1,
    );

    // Revoking marks revoked_at and stops webhook auth immediately.
    const revoked = await revokeWebhookToken({ id: created.id }, db);
    expect(revoked.id).toBe(created.id);
    expect(revoked.revokedAt).toBeInstanceOf(Date);

    const rejected = await authenticateWebhookRequest(
      new Request("http://localhost/api/packs", {
        headers: { Authorization: `Bearer ${created.token}` },
      }),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.response.status).toBe(401);
    }

    // Revoking again refuses cleanly.
    await expectKitchenAdminError(
      revokeWebhookToken({ id: created.id }, db),
      /already revoked/,
    );
  });

  it("refuses unknown kitchens, empty labels, malformed ids, and missing token ids", async () => {
    await expectKitchenAdminError(
      createWebhookToken({ kitchenSlug: "missing", label: "agent" }, db),
      /not found/,
    );

    await expectKitchenAdminError(
      createWebhookToken({ kitchenSlug: "home", label: "   " }, db),
      /label is required/i,
    );

    await expectKitchenAdminError(
      listWebhookTokens({ kitchenSlug: "missing" }, db),
      /not found/,
    );

    await expectKitchenAdminError(
      revokeWebhookToken({ id: "not-a-uuid" }, db),
      /Invalid token id/,
    );

    await expectKitchenAdminError(
      revokeWebhookToken(
        { id: "00000000-0000-4000-8000-000000000000" },
        db,
      ),
      /not found/,
    );
  });

  it("refuses token create for a memberless kitchen in sign-in mode and allows home in single-kitchen mode", async () => {
    await expectKitchenAdminError(
      createWebhookToken({ kitchenSlug: "home", label: "agent" }, db, {
        SOUS_SIGN_IN: "on",
      }),
      /no members[\s\S]*or set SOUS_SIGN_IN=off if this deployment runs in single-kitchen mode/i,
    );
    expect(await db.select().from(kitchenWebhookTokens)).toHaveLength(0);

    const created = await createWebhookToken(
      { kitchenSlug: "home", label: "home-agent" },
      db,
      { SOUS_SIGN_IN: "off" },
    );
    expect(created.kitchenSlug).toBe("home");
    expect(created.label).toBe("home-agent");
    expect(created.token).toMatch(/^sous_[A-Za-z0-9_-]+$/);
  });
});

describe("Kitchen, invite, and member admin commands", () => {
  it("lists kitchens with their cap, members, pending invites, and pending new-kitchen invites", async () => {
    const { user: northUser } = await seedKitchen(db, {
      slug: "north",
      name: "North Kitchen",
      aiMonthlyCapMicros: 3_500_000,
      email: "north@example.com",
    });
    await createInvite(
      { email: "cook@example.com", kitchenSlug: "north", role: "cook" },
      db,
    );
    await createInvite(
      { email: "south@example.com", newKitchenName: "South House" },
      db,
    );

    const listed = await listKitchens(db);
    expect(listed.kitchens.map((k) => k.slug)).toEqual(["home", "north"]);
    const north = listed.kitchens.find((k) => k.slug === "north");
    expect(north?.name).toBe("North Kitchen");
    expect(north?.aiMonthlyCapMicros).toBe(3_500_000);
    expect(north?.members).toEqual([
      expect.objectContaining({ email: northUser.email, role: "owner" }),
    ]);
    expect(north?.pendingInvites).toEqual([
      expect.objectContaining({ email: "cook@example.com", role: "cook" }),
    ]);
    expect(listed.pendingNewKitchenInvites).toEqual([
      expect.objectContaining({
        email: "south@example.com",
        newKitchenSlug: "south-house",
        newKitchenName: "South House",
        role: "owner",
      }),
    ]);
  });

  it("renames a kitchen without ever changing its slug and refuses invalid names or unknown slugs", async () => {
    await seedKitchen(db, { slug: "north", name: "North Kitchen" });

    const renamed = await renameKitchen(
      { kitchenSlug: "north", name: "  North Family Kitchen  " },
      db,
    );
    expect(renamed).toMatchObject({
      slug: "north",
      oldName: "North Kitchen",
      newName: "North Family Kitchen",
    });

    const [row] = await db
      .select()
      .from(kitchens)
      .where(eq(kitchens.slug, "north"));
    expect(row?.slug).toBe("north");
    expect(row?.name).toBe("North Family Kitchen");

    await expect(
      renameKitchen({ kitchenSlug: "missing", name: "Valid" }, db),
    ).rejects.toThrow(/not found/);
    await expect(
      renameKitchen({ kitchenSlug: "north", name: "   " }, db),
    ).rejects.toThrow(/between 1 and 80/);
    await expect(
      renameKitchen({ kitchenSlug: "north", name: "x".repeat(81) }, db),
    ).rejects.toThrow(/between 1 and 80/);
  });

  it("refuses duplicate invites, existing members, unknown kitchens, and missing uninvite/remove targets", async () => {
    await seedKitchen(db, {
      slug: "north",
      name: "North Kitchen",
      email: "owner@example.com",
    });

    // Already a member (owner and cook articles).
    await expectKitchenAdminError(
      createInvite(
        { email: "OWNER@example.com", kitchenSlug: "home", role: "cook" },
        db,
      ),
      /already an owner/,
    );
    await seedKitchen(db, {
      slug: "west",
      name: "West Kitchen",
      email: "cook@example.com",
      role: "cook",
    });
    await expectKitchenAdminError(
      createInvite(
        { email: "cook@example.com", kitchenSlug: "home", role: "cook" },
        db,
      ),
      /already a cook/,
    );

    // Duplicate pending invite.
    await createInvite(
      { email: "guest@example.com", kitchenSlug: "north", role: "cook" },
      db,
    );
    await expectKitchenAdminError(
      createInvite(
        { email: "GUEST@example.com", kitchenSlug: "home", role: "cook" },
        db,
      ),
      /already has a pending invite/,
    );

    // Unknown kitchen / invalid email.
    await expectKitchenAdminError(
      createInvite(
        { email: "new@example.com", kitchenSlug: "missing", role: "cook" },
        db,
      ),
      /not found/,
    );
    await expectKitchenAdminError(
      createInvite(
        { email: "not-an-email", kitchenSlug: "home", role: "cook" },
        db,
      ),
      /Invalid email/,
    );

    // Missing uninvite / remove-member targets.
    await expectKitchenAdminError(
      uninviteEmail({ email: "nobody@example.com" }, db),
      /No pending or orphaned invite/,
    );
    await expectKitchenAdminError(
      removeMember({ email: "nobody@example.com", tokenAction: "keep" }, db),
      /No member found/,
    );
  });

  it("uninviteEmail revokes a pending invite and refuses an accepted invite whose member exists without changing anything", async () => {
    // 1. Pending invite: revoked.
    const pending = await createInvite(
      { email: "pending@example.com", newKitchenName: "Pending Kitchen" },
      db,
    );
    const revoked = await uninviteEmail({ email: "pending@example.com" }, db);
    expect(revoked.inviteId).toBe(pending.id);
    expect(revoked.wasAcceptedOrphan).toBe(false);
    expect(revoked.revokedAt).toBeInstanceOf(Date);

    const [pendingRow] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, pending.id));
    expect(pendingRow?.revokedAt).toBeInstanceOf(Date);

    // 2. Accepted invite whose member exists: refused naming remove-member, nothing changed.
    const acceptedInvite = await createInvite(
      { email: "joined@example.com", kitchenSlug: "home", role: "cook" },
      db,
    );
    const testAuth = createTestAuth(db);
    const ctx = await testAuth.$context;
    const savedUser = await ctx.test.saveUser(
      ctx.test.createUser({
        email: "joined@example.com",
        name: "Joined Cook",
        emailVerified: true,
      }),
    );
    await signedInHeaders(savedUser.id, db);
    await resolveAccess(
      { mode: "sign-in", user: { id: savedUser.id, email: savedUser.email } },
      db,
    );

    await expectKitchenAdminError(
      uninviteEmail({ email: "joined@example.com" }, db),
      /remove-member/,
    );

    const [inviteAfter] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, acceptedInvite.id));
    expect(inviteAfter?.acceptedAt).toBeInstanceOf(Date);
    expect(inviteAfter?.revokedAt).toBeNull();

    expect(
      await db.select().from(members).where(eq(members.userId, savedUser.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(authSession)
        .where(eq(authSession.userId, savedUser.id)),
    ).toHaveLength(1);
  });

  it("refuses invite, uninvite, and remove-member in single-kitchen mode without writing rows", async () => {
    const singleEnv = { SOUS_SIGN_IN: "off" };

    await expectKitchenAdminError(
      createInvite(
        { email: "single@example.com", newKitchenName: "Extra Kitchen" },
        db,
        singleEnv,
      ),
      /single-kitchen mode.*no members or invites/i,
    );
    await expectKitchenAdminError(
      uninviteEmail({ email: "single@example.com" }, db, singleEnv),
      /single-kitchen mode.*no members or invites/i,
    );
    await expectKitchenAdminError(
      removeMember(
        { email: "single@example.com", tokenAction: "revoke" },
        db,
        singleEnv,
      ),
      /single-kitchen mode.*no members or invites/i,
    );

    expect(await db.select().from(invites)).toHaveLength(0);
  });

  it("formatRemoveMemberSummary reports actual token outcome without contradicting last-member revocation", async () => {
    // Last member removed with --keep-tokens and zero existing tokens.
    const { user: soloUser } = await seedKitchen(db, {
      slug: "solo-empty",
      name: "Solo Empty",
      email: "solo-empty@example.com",
    });
    const removedEmpty = await removeMember(
      { email: soloUser.email, tokenAction: "keep" },
      db,
    );
    const emptyLine = formatRemoveMemberSummary(removedEmpty);
    expect(emptyLine).toContain("last member");
    expect(emptyLine).toContain("no unrevoked webhook tokens");
    expect(emptyLine).not.toContain("Kept");

    // Last member removed with --keep-tokens and an active token -> revoked.
    const { user: soloTokenUser } = await seedKitchen(db, {
      slug: "solo-token",
      name: "Solo Token",
      email: "solo-token@example.com",
    });
    await createWebhookToken(
      { kitchenSlug: "solo-token", label: "tablet" },
      db,
    );
    const removedWithToken = await removeMember(
      { email: soloTokenUser.email, tokenAction: "keep" },
      db,
    );
    const tokenLine = formatRemoveMemberSummary(removedWithToken);
    expect(tokenLine).toContain('Revoked 1 webhook token(s): "tablet"');
    expect(tokenLine).not.toContain("Kept");

    // Non-last member removed with --keep-tokens and an active token -> kept.
    const { kitchen: shared } = await seedKitchen(db, {
      slug: "shared",
      name: "Shared",
      email: "first@example.com",
    });
    await db.insert(authUser).values({
      id: "u-second",
      name: "Second",
      email: "second@example.com",
      emailVerified: true,
    });
    await db.insert(members).values({
      kitchenId: shared.id,
      userId: "u-second",
      role: "cook",
    });
    await createWebhookToken({ kitchenSlug: "shared", label: "agent" }, db);
    const removedKept = await removeMember(
      { email: "second@example.com", tokenAction: "keep" },
      db,
    );
    const keptLine = formatRemoveMemberSummary(removedKept);
    expect(keptLine).toContain("Kept 1 existing webhook token(s)");
    expect(keptLine).not.toContain("Revoked 1 webhook token");
  });

  it("removeMember refuses when more than one user row normalizes to the target email and lists their ids", async () => {
    const home = await homeKitchen(db);
    await db.insert(authUser).values([
      {
        id: "u-dup-1",
        name: "Dup One",
        email: "dup@example.com",
        emailVerified: true,
      },
      {
        id: "u-dup-2",
        name: "Dup Two",
        email: "Dup@Example.com",
        emailVerified: true,
      },
    ]);
    await db.insert(members).values({
      kitchenId: home.id,
      userId: "u-dup-1",
      role: "cook",
    });

    await expectKitchenAdminError(
      removeMember({ email: "dup@example.com", tokenAction: "revoke" }, db),
      /Multiple users.*u-dup-1.*u-dup-2/,
    );

    expect(
      await db.select().from(members).where(eq(members.userId, "u-dup-1")),
    ).toHaveLength(1);
  });
});
