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
import { authUser, db, invites, kitchens, members } from "@/lib/db";
import { KitchenAdminError, createInvite } from "./admin";
import { beforeCreateSession, beforeCreateUser } from "./invites";
import {
  DeploymentConfigError,
  checkDeploymentEnv,
  ensureDeploymentReady,
  getDeploymentMode,
  resetDeploymentCheckForTests,
} from "./deployment";
import { resetAuthForTests } from "@/lib/auth/auth";
import { homeKitchen } from "@/lib/__tests__/kitchens";
import {
  TEST_AUTH_ENV,
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
});

async function expectApiForbidden(
  promise: Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toMatchObject({
    status: "FORBIDDEN",
    message: expect.stringMatching(messagePattern),
  });
}

describe("Sign-in and deployment access rules", () => {
  it("a pending invite for one email admits no other verified email through user or session hooks", async () => {
    await createInvite(
      { email: "invited@example.com", newKitchenName: "Invited Kitchen" },
      db,
    );

    await expectApiForbidden(
      beforeCreateUser({
        email: "someone-else@example.com",
        emailVerified: true,
      }),
      /Not invited/,
    );

    await db.insert(authUser).values({
      id: "u-other",
      name: "Other User",
      email: "someone-else@example.com",
      emailVerified: true,
    });

    await expectApiForbidden(
      beforeCreateSession({ userId: "u-other" }),
      /Not invited/,
    );
  });

  it("beforeCreateSession refuses an unverified user even when a member row exists, and refuses an unknown user id", async () => {
    const home = await homeKitchen(db);
    await db.insert(authUser).values({
      id: "u-unverified",
      name: "Unverified Member",
      email: "unverified@example.com",
      emailVerified: false,
    });
    await db.insert(members).values({
      kitchenId: home.id,
      userId: "u-unverified",
      role: "cook",
    });

    await expectApiForbidden(
      beforeCreateSession({ userId: "u-unverified" }),
      /verified/i,
    );
    await expectApiForbidden(
      beforeCreateSession({ userId: "no-such-user" }),
      /Not invited/,
    );
  });

  it("Origin header must equal the configured origin exactly (case, prefix, and malformed port are refused with 403)", async () => {
    const home = await homeKitchen(db);
    await db.insert(authUser).values({
      id: "u-origin",
      name: "Origin User",
      email: "origin@example.com",
      emailVerified: true,
    });
    await db.insert(members).values({
      kitchenId: home.id,
      userId: "u-origin",
      role: "owner",
    });

    const cookie = (await signedInHeaders("u-origin", db)).get("cookie")!;
    for (const origin of [
      "https://APP.example.com",
      "https://app.example.com.example.com",
      "https://app.example.com:443x",
    ]) {
      const res = await httpCall(
        "getKitchenQueue",
        { status: "pending" },
        { method: "GET", headers: { cookie, origin } },
      );
      expect(res.status, origin).toBe(403);
    }

    const ok = await httpCall(
      "getKitchenQueue",
      { status: "pending" },
      { method: "GET", headers: { cookie, origin: TEST_AUTH_ENV.BETTER_AUTH_URL } },
    );
    expect(ok.status).toBe(200);
  });

  it("SOUS_SIGN_IN accepts only exact 'off' for single-kitchen mode and BETTER_AUTH_URL must parse as a URL", () => {
    for (const raw of ["OFF", "false", "0", " off"]) {
      expect(() => getDeploymentMode({ SOUS_SIGN_IN: raw }), raw).toThrow(
        DeploymentConfigError,
      );
    }

    expect(() =>
      checkDeploymentEnv({ ...TEST_AUTH_ENV, BETTER_AUTH_URL: "notaurl" }),
    ).toThrow(DeploymentConfigError);
    expect(() =>
      checkDeploymentEnv({ ...TEST_AUTH_ENV, BETTER_AUTH_URL: "notaurl" }),
    ).toThrow(/BETTER_AUTH_URL/);
  });

  it("a memoized start-up pass is not reused after the environment or cap variables change", async () => {
    expect(await ensureDeploymentReady(db, { SOUS_SIGN_IN: "off" })).toBe(
      "single-kitchen",
    );

    let caught: unknown;
    try {
      await ensureDeploymentReady(db, { SOUS_SIGN_IN: "on" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DeploymentConfigError);
    expect((caught as Error).message).toMatch(/BETTER_AUTH_SECRET/);

    // Changing either cap variable from unset to empty or invalid re-runs the check.
    for (const badCapEnv of [
      { SOUS_SIGN_IN: "off", SOUS_AI_KITCHEN_CAP_USD: "" },
      { SOUS_SIGN_IN: "off", SOUS_AI_KITCHEN_CAP_USD: "-1" },
      { SOUS_SIGN_IN: "off", SOUS_AI_TOTAL_CAP_USD: "" },
      { SOUS_SIGN_IN: "off", SOUS_AI_TOTAL_CAP_USD: "2.555" },
    ]) {
      let capErr: unknown;
      try {
        await ensureDeploymentReady(db, badCapEnv);
      } catch (err) {
        capErr = err;
      }
      expect(capErr, JSON.stringify(badCapEnv)).toBeInstanceOf(
        DeploymentConfigError,
      );
      expect((capErr as Error).message).toMatch(/SOUS_AI_(KITCHEN|TOTAL)_CAP_USD/);
    }

    // Same in sign-in mode: passing once does not mask a later cap change.
    expect(await ensureDeploymentReady(db, { ...TEST_AUTH_ENV })).toBe(
      "sign-in",
    );
    let signInCapErr: unknown;
    try {
      await ensureDeploymentReady(db, {
        ...TEST_AUTH_ENV,
        SOUS_AI_TOTAL_CAP_USD: "-1",
      });
    } catch (err) {
      signInCapErr = err;
    }
    expect(signInCapErr).toBeInstanceOf(DeploymentConfigError);
    expect((signInCapErr as Error).message).toContain("SOUS_AI_TOTAL_CAP_USD");
  });

  it("a new-kitchen invite whose slug matches an existing non-home kitchen is refused at invite time and writes no row", async () => {
    await db.insert(kitchens).values({ slug: "taken", name: "Taken" });

    let caught: unknown;
    try {
      await createInvite(
        { email: "late@example.com", newKitchenName: "Taken" },
        db,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KitchenAdminError);
    expect((caught as Error).message).toMatch(/taken/);
    expect(await db.select().from(invites).where(eq(invites.email, "late@example.com"))).toHaveLength(0);
    expect(await db.select().from(invites)).toHaveLength(0);
  });
});
