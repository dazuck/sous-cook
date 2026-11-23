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
import { authSession, db, invites } from "@/lib/db";
import { GET as authGet, POST as authPost } from "@/app/api/auth/[...all]/route";
import {
  GOOGLE_SCOPES,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  getAuth,
  resetAuthForTests,
} from "./auth";
import { beforeCreateSession, beforeCreateUser } from "../kitchens/invites";
import { resetDeploymentCheckForTests } from "../kitchens/deployment";
import {
  TEST_AUTH_ENV,
  createTestAuth,
  stubSignInEnv,
} from "../__tests__/test-auth";
import { httpCall } from "../__tests__/trpc-http";
import { homeKitchen } from "../__tests__/kitchens";

const client = (dbModule as unknown as { client: PGlite }).client;

beforeEach(async () => {
  stubSignInEnv();
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  await client.exec(
    "delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");
});

afterEach(() => {
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

async function createInvitedUserWithSession(email: string) {
  const home = await homeKitchen(db);
  await db.insert(invites).values({
    email: email.trim().toLowerCase(),
    kitchenId: home.id,
    role: "owner",
  });

  const testAuth = createTestAuth(db);
  const ctx = await testAuth.$context;
  const userObj = ctx.test.createUser({
    email,
    name: "Test Cook",
    emailVerified: true,
  });
  const savedUser = await ctx.test.saveUser(userObj);
  const login = await ctx.test.login({ userId: savedUser.id });
  return { user: savedUser, login };
}

describe("Better Auth configuration and sessions", () => {
  it("SESS-1: an expired session (expires_at in the past) gives no session", async () => {
    const { login } = await createInvitedUserWithSession("expired@example.com");

    // Live session resolves through getAuth().api.getSession and /api/auth/get-session.
    const live = await getAuth().api.getSession({ headers: login.headers });
    expect(live?.user.email).toBe("expired@example.com");

    // Move expires_at into the past.
    await db
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(authSession.id, login.session.id));

    const expired = await getAuth().api.getSession({ headers: login.headers });
    expect(expired).toBeNull();

    const httpRes = await authGet(
      new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/auth/get-session`, {
        method: "GET",
        headers: login.headers,
      }),
    );
    expect(httpRes.status).toBe(200);
    expect(await httpRes.json()).toBeNull();
  });

  it("SESS-2: a session whose row was deleted (revocation) gives no session on the next request", async () => {
    const { login } = await createInvitedUserWithSession("revoked@example.com");

    const before = await getAuth().api.getSession({ headers: login.headers });
    expect(before?.session.id).toBe(login.session.id);

    await db.delete(authSession).where(eq(authSession.id, login.session.id));

    const after = await getAuth().api.getSession({ headers: login.headers });
    expect(after).toBeNull();
  });

  it("SESS-3: configured lifetime is 90 days sliding by 1 day with cookieCache off and tokens encrypted", () => {
    const auth = getAuth();

    expect(auth.options.session?.expiresIn).toBe(90 * 24 * 60 * 60);
    expect(auth.options.session?.expiresIn).toBe(SESSION_EXPIRES_IN_SECONDS);
    expect(auth.options.session?.updateAge).toBe(24 * 60 * 60);
    expect(auth.options.session?.updateAge).toBe(SESSION_UPDATE_AGE_SECONDS);
    expect(auth.options.session?.cookieCache?.enabled).toBe(false);
    expect(auth.options.account?.encryptOAuthTokens).toBe(true);
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
    expect(auth.options.onAPIError?.errorURL).toBe("/not-invited");
    expect(auth.options.trustedOrigins).toEqual([TEST_AUTH_ENV.BETTER_AUTH_URL]);
    expect(auth.options.plugins).toEqual([]);
    expect(auth.options.databaseHooks?.user?.create?.before).toBe(
      beforeCreateUser,
    );
    expect(auth.options.databaseHooks?.session?.create?.before).toBe(
      beforeCreateSession,
    );
  });

  it("GATE-7: Google provider requests only sign-in scopes with disableDefaultScope, select_account, verified email, and no offline access", async () => {
    const auth = getAuth();
    const googleConfig = auth.options.socialProviders?.google;
    expect(googleConfig).toBeDefined();
    expect(googleConfig?.disableDefaultScope).toBe(true);
    expect(googleConfig?.scope).toEqual(["openid", "email", "profile"]);
    expect(googleConfig?.scope).toEqual([...GOOGLE_SCOPES]);
    expect(googleConfig?.prompt).toBe("select_account");
    expect(googleConfig?.requireEmailVerification).toBe(true);
    expect("accessType" in (googleConfig ?? {})).toBe(false);

    // Also verify the built OAuth provider's authorization URL matches exactly.
    const ctx = await auth.$context;
    const provider = ctx.socialProviders.find((p) => p.id === "google");
    expect(provider).toBeDefined();
    const url = await provider!.createAuthorizationURL({
      state: "test-state",
      codeVerifier: "test-code-verifier",
      redirectURI: `${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/auth/callback/google`,
    });
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "profile",
    ]);
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("access_type")).toBeNull();
  });

  it("forwards Set-Cookie with Max-Age=7776000 on a tRPC call when a session is due for sliding renewal", async () => {
    const { login } = await createInvitedUserWithSession("sliding@example.com");

    const now = Date.now();
    const agedExpiresAt = new Date(now + 88 * 24 * 60 * 60 * 1000);
    const agedUpdatedAt = new Date(now - 2 * 24 * 60 * 60 * 1000);
    await db
      .update(authSession)
      .set({ expiresAt: agedExpiresAt, updatedAt: agedUpdatedAt })
      .where(eq(authSession.id, login.session.id));

    const res = await httpCall<{ result: { data: unknown[] } }>(
      "getKitchenQueue",
      { status: "pending" },
      { method: "GET", headers: login.headers },
    );
    expect(res.status).toBe(200);

    const setCookies = res.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) =>
      /(?:^|__Secure-)better-auth\.session_token=/.test(c),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/Max-Age=7776000/i);
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const [renewed] = await db
      .select({ expiresAt: authSession.expiresAt })
      .from(authSession)
      .where(eq(authSession.id, login.session.id));
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(
      agedExpiresAt.getTime(),
    );
  });

  it("refuses caller-supplied scopes on sign-in/social and link-social while allowing standard Google sign-in", async () => {
    const widenedSignIn = await authPost(
      new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
        },
        body: JSON.stringify({
          provider: "google",
          scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        }),
      }),
    );
    expect(widenedSignIn.status).toBe(400);
    const widenedSignInBody = (await widenedSignIn.json()) as {
      message?: string;
    };
    expect(widenedSignInBody.message).toMatch(/scopes/i);

    const { login } = await createInvitedUserWithSession("linker@example.com");
    const linkHeaders = new Headers(login.headers);
    linkHeaders.set("content-type", "application/json");
    linkHeaders.set("origin", TEST_AUTH_ENV.BETTER_AUTH_URL);

    const widenedLink = await authPost(
      new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/auth/link-social`, {
        method: "POST",
        headers: linkHeaders,
        body: JSON.stringify({
          provider: "google",
          scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        }),
      }),
    );
    expect(widenedLink.status).toBe(400);
    const widenedLinkBody = (await widenedLink.json()) as {
      message?: string;
    };
    expect(widenedLinkBody.message).toMatch(/scopes/i);

    const normalSignIn = await authPost(
      new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
        },
        body: JSON.stringify({
          provider: "google",
        }),
      }),
    );
    expect(normalSignIn.status).toBe(200);
    const normalBody = (await normalSignIn.json()) as { url: string };
    const authUrl = new URL(normalBody.url);
    expect(authUrl.searchParams.get("scope")).toBe("openid email profile");
  });

  it("refuses caller-supplied additionalParams on sign-in/social and link-social while allowing a plain sign-in request", async () => {
    const offlineSignIn = await authPost(
      new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
        },
        body: JSON.stringify({
          provider: "google",
          additionalParams: { access_type: "offline" },
        }),
      }),
    );
    expect(offlineSignIn.status).toBe(400);
    const offlineSignInBody = (await offlineSignIn.json()) as {
      message?: string;
    };
    expect(offlineSignInBody.message).toMatch(/additionalParams/i);

    const { login } = await createInvitedUserWithSession("params@example.com");
    const linkHeaders = new Headers(login.headers);
    linkHeaders.set("content-type", "application/json");
    linkHeaders.set("origin", TEST_AUTH_ENV.BETTER_AUTH_URL);

    const offlineLink = await authPost(
      new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/auth/link-social`, {
        method: "POST",
        headers: linkHeaders,
        body: JSON.stringify({
          provider: "google",
          additionalParams: { access_type: "offline" },
        }),
      }),
    );
    expect(offlineLink.status).toBe(400);
    const offlineLinkBody = (await offlineLink.json()) as {
      message?: string;
    };
    expect(offlineLinkBody.message).toMatch(/additionalParams/i);

    const plainSignIn = await authPost(
      new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
        },
        body: JSON.stringify({
          provider: "google",
        }),
      }),
    );
    expect(plainSignIn.status).toBe(200);
    const plainBody = (await plainSignIn.json()) as { url: string };
    const authUrl = new URL(plainBody.url);
    expect(authUrl.searchParams.get("access_type")).toBeNull();
  });
});
