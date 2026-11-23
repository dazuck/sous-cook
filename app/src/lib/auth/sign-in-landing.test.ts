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
import { authSession, authUser, db, invites, members } from "@/lib/db";
import {
  GET as authGet,
  POST as authPost,
} from "@/app/api/auth/[...all]/route";
import { resetAuthForTests } from "./auth";
import { resetDeploymentCheckForTests } from "../kitchens/deployment";
import { TEST_AUTH_ENV, stubSignInEnv } from "../__tests__/test-auth";
import { homeKitchen } from "../__tests__/kitchens";

const client = (dbModule as unknown as { client: PGlite }).client;

const SESSION_COOKIE_NAMES = new Set([
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
]);

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function buildUnsignedIdToken(claims: {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT", kid: "k1" });
  const payload = base64UrlJson({
    iss: "https://accounts.google.com",
    aud: TEST_AUTH_ENV.GOOGLE_CLIENT_ID,
    sub: claims.sub,
    email: claims.email,
    email_verified: claims.email_verified,
    name: claims.name,
    iat,
    exp,
  });
  const signature = Buffer.from("test-signature").toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function sessionCookies(headers: Headers): Array<{ name: string; value: string }> {
  return headers
    .getSetCookie()
    .map((cookie) => {
      const pair = cookie.split(";")[0] ?? "";
      const eqIdx = pair.indexOf("=");
      if (eqIdx < 0) return null;
      const name = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      return SESSION_COOKIE_NAMES.has(name) ? { name, value } : null;
    })
    .filter((entry): entry is { name: string; value: string } => entry !== null);
}

async function runGoogleSignInRoundTrip(profile: {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}): Promise<Response> {
  const startRes = await authPost(
    new Request(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
      },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/sign-in/done",
        disableRedirect: true,
      }),
    }),
  );

  expect(startRes.status).toBe(200);
  const startBody = (await startRes.json()) as {
    url: string;
    redirect: boolean;
  };
  expect(startBody.redirect).toBe(false);

  const authUrl = new URL(startBody.url);
  const state = authUrl.searchParams.get("state");
  expect(state).toBeTruthy();

  const cookieHeader = startRes.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair.length > 0)
    .join("; ");

  const idToken = buildUnsignedIdToken(profile);

  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request): Promise<Response> => {
      const targetUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (targetUrl !== "https://oauth2.googleapis.com/token") {
        throw new Error(`Unexpected outbound request to ${targetUrl}`);
      }
      return new Response(
        JSON.stringify({
          access_token: "test-google-access-token",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );

  try {
    return await authGet(
      new Request(
        `${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/auth/callback/google?code=test&state=${encodeURIComponent(state!)}`,
        {
          method: "GET",
          headers: {
            cookie: cookieHeader,
          },
        },
      ),
    );
  } finally {
    vi.unstubAllGlobals();
  }
}

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
  vi.unstubAllGlobals();
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

describe("AUTH-3: Google sign-in callback redirects refused users to /not-invited with error code", () => {
  it("redirects an uninvited verified email to /not-invited?error=not_invited with no session or user row", async () => {
    const email = "stranger@example.com";
    const callbackRes = await runGoogleSignInRoundTrip({
      sub: "google-sub-uninvited",
      email,
      email_verified: true,
      name: "Uninvited Cook",
    });

    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("location");
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!, TEST_AUTH_ENV.BETTER_AUTH_URL);
    expect(redirectUrl.pathname).toBe("/not-invited");
    expect(redirectUrl.searchParams.get("error")).toBe("not_invited");

    expect(sessionCookies(callbackRes.headers)).toEqual([]);

    const rows = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, email));
    expect(rows).toEqual([]);
  });

  it("redirects an invited verified email to /sign-in/done and sets a session cookie", async () => {
    const email = "invited@example.com";
    const home = await homeKitchen(db);
    await db.insert(invites).values({
      email,
      kitchenId: home.id,
      role: "owner",
    });

    const callbackRes = await runGoogleSignInRoundTrip({
      sub: "google-sub-invited",
      email,
      email_verified: true,
      name: "Invited Cook",
    });

    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("location");
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!, TEST_AUTH_ENV.BETTER_AUTH_URL);
    expect(redirectUrl.pathname).toBe("/sign-in/done");

    const cookies = sessionCookies(callbackRes.headers);
    expect(cookies.length).toBeGreaterThan(0);
    expect(cookies.some((c) => c.value.length > 0)).toBe(true);
  });

  it("redirects an invited unverified email to /not-invited?error=email_not_verified with no session or user row", async () => {
    const email = "unverified@example.com";
    const home = await homeKitchen(db);
    await db.insert(invites).values({
      email,
      kitchenId: home.id,
      role: "owner",
    });

    const callbackRes = await runGoogleSignInRoundTrip({
      sub: "google-sub-unverified",
      email,
      email_verified: false,
      name: "Unverified Cook",
    });

    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("location");
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!, TEST_AUTH_ENV.BETTER_AUTH_URL);
    expect(redirectUrl.pathname).toBe("/not-invited");
    expect(redirectUrl.searchParams.get("error")).toBe("email_not_verified");

    expect(sessionCookies(callbackRes.headers)).toEqual([]);

    const rows = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, email));
    expect(rows).toEqual([]);
  });

  it("redirects an existing user with no member row and no pending invite to /not-invited?error=not_invited with no session", async () => {
    const email = "returning@example.com";
    const sub = "google-sub-returning";
    const home = await homeKitchen(db);
    await db.insert(invites).values({
      email,
      kitchenId: home.id,
      role: "owner",
    });

    const firstRes = await runGoogleSignInRoundTrip({
      sub,
      email,
      email_verified: true,
      name: "Returning Cook",
    });

    expect(firstRes.status).toBe(302);
    const firstLocation = firstRes.headers.get("location");
    expect(firstLocation).toBeTruthy();
    const firstRedirectUrl = new URL(
      firstLocation!,
      TEST_AUTH_ENV.BETTER_AUTH_URL,
    );
    expect(firstRedirectUrl.pathname).toBe("/sign-in/done");

    const [existingUser] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, email));
    expect(existingUser).toBeDefined();

    // Leave the user row in place while removing their sessions, membership,
    // and invite so the next sign-in skips user creation and hits the session hook.
    await db.delete(authSession).where(eq(authSession.userId, existingUser!.id));
    await db.delete(members).where(eq(members.userId, existingUser!.id));
    await db.delete(invites).where(eq(invites.email, email));

    const secondRes = await runGoogleSignInRoundTrip({
      sub,
      email,
      email_verified: true,
      name: "Returning Cook",
    });

    expect(secondRes.status).toBe(302);
    const secondLocation = secondRes.headers.get("location");
    expect(secondLocation).toBeTruthy();

    const secondRedirectUrl = new URL(
      secondLocation!,
      TEST_AUTH_ENV.BETTER_AUTH_URL,
    );
    expect(secondRedirectUrl.pathname).toBe("/not-invited");
    expect(secondRedirectUrl.searchParams.get("error")).toBe("not_invited");

    expect(sessionCookies(secondRes.headers)).toEqual([]);

    const sessions = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.userId, existingUser!.id));
    expect(sessions).toEqual([]);
  });
});
