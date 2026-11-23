import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";
import {
  getRedirectUrl,
  unstable_doesMiddlewareMatch,
} from "next/experimental/testing/server";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("./lib/__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db } from "@/lib/db";
import { SIGN_IN_MODE_COOKIE } from "@/lib/kitchens/mode";
import { seedKitchen } from "@/lib/__tests__/kitchens";
import { signedInHeaders, stubSignInEnv } from "@/lib/__tests__/test-auth";
import { config, proxy } from "./proxy";

const client = (dbModule as unknown as { client: PGlite }).client;

function assertPassed(response: NextResponse): void {
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(getRedirectUrl(response)).toBeNull();
}

function signInModeSetCookies(response: NextResponse): string[] {
  return response.headers
    .getSetCookie()
    .filter((header) => header.startsWith(`${SIGN_IN_MODE_COOKIE}=`));
}

function assertSetsSignInModeCookie(
  response: NextResponse,
  options: { secure: boolean },
): void {
  const matching = signInModeSetCookies(response);
  expect(matching).toHaveLength(1);

  const parts = matching[0]!.split(";").map((part) => part.trim());
  expect(parts[0]).toBe(`${SIGN_IN_MODE_COOKIE}=1`);

  const attrs = parts.slice(1);
  expect(attrs.some((attr) => attr === "Path=/")).toBe(true);
  expect(attrs.some((attr) => attr.toLowerCase() === "samesite=lax")).toBe(
    true,
  );
  expect(attrs.some((attr) => attr === "Max-Age=31536000")).toBe(true);
  expect(attrs.some((attr) => attr.toLowerCase() === "httponly")).toBe(false);
  expect(attrs.some((attr) => attr.toLowerCase() === "secure")).toBe(
    options.secure,
  );
}

function assertDeletesSignInModeCookie(response: NextResponse): void {
  const matching = signInModeSetCookies(response);
  expect(matching).toHaveLength(1);

  const parts = matching[0]!.split(";").map((part) => part.trim());
  expect(parts[0]).toBe(`${SIGN_IN_MODE_COOKIE}=`);

  const attrs = parts.slice(1);
  expect(attrs.some((attr) => attr === "Path=/")).toBe(true);
  const expiresAttr = attrs.find((attr) =>
    attr.toLowerCase().startsWith("expires="),
  );
  const maxAgeAttr = attrs.find((attr) =>
    attr.toLowerCase().startsWith("max-age="),
  );
  const expiresIn1970 =
    expiresAttr !== undefined &&
    new Date(expiresAttr.slice("expires=".length)).getUTCFullYear() === 1970;
  const maxAgeZero =
    maxAgeAttr !== undefined && maxAgeAttr.slice("max-age=".length) === "0";
  expect(expiresIn1970 || maxAgeZero).toBe(true);
}

async function createSessionCookieHeader(): Promise<string> {
  const { user } = await seedKitchen(db, {
    slug: "proxy-test",
    name: "Proxy Test Kitchen",
  });
  const headers = await signedInHeaders(user.id, db);
  const cookie = headers.get("cookie");
  if (!cookie) {
    throw new Error("Expected signedInHeaders to return a cookie header");
  }
  return cookie;
}

beforeEach(async () => {
  await client.exec(
    "delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PROXY-1: proxy in sign-in mode", () => {
  beforeEach(() => {
    stubSignInEnv();
  });

  it("redirects /kitchen and /kitchen/cookpacks/p1 without a session cookie and sets the mode cookie", () => {
    for (const url of [
      "https://app.example.com/kitchen",
      "https://app.example.com/kitchen/cookpacks/p1",
    ]) {
      const res = proxy(new NextRequest(url));
      expect(getRedirectUrl(res)).toBe("https://app.example.com/sign-in");
      assertSetsSignInModeCookie(res, { secure: true });
    }
  });

  it("passes /kitchen and /kitchen/cookpacks/p1 with a real session cookie and sets the mode cookie", async () => {
    const sessionCookie = await createSessionCookieHeader();

    for (const url of [
      "https://app.example.com/kitchen",
      "https://app.example.com/kitchen/cookpacks/p1",
    ]) {
      const res = proxy(
        new NextRequest(url, { headers: { cookie: sessionCookie } }),
      );
      assertPassed(res);
      assertSetsSignInModeCookie(res, { secure: true });
    }
  });

  it("redirects /kitchen and /kitchen/cookpacks/p1 when only an unrelated cookie is present", () => {
    for (const url of [
      "https://app.example.com/kitchen",
      "https://app.example.com/kitchen/cookpacks/p1",
    ]) {
      const res = proxy(
        new NextRequest(url, { headers: { cookie: "unrelated=abc" } }),
      );
      expect(getRedirectUrl(res)).toBe("https://app.example.com/sign-in");
      assertSetsSignInModeCookie(res, { secure: true });
    }
  });

  it("redirects when only an empty session cookie is present", () => {
    for (const url of [
      "https://app.example.com/kitchen",
      "https://app.example.com/kitchen/cookpacks/p1",
    ]) {
      const res = proxy(
        new NextRequest(url, {
          headers: { cookie: "better-auth.session_token=" },
        }),
      );
      expect(getRedirectUrl(res)).toBe("https://app.example.com/sign-in");
      assertSetsSignInModeCookie(res, { secure: true });
    }
  });

  it("passes /kitchen/queue/q1 with no cookie and sets the mode cookie", () => {
    const res = proxy(new NextRequest("https://app.example.com/kitchen/queue/q1"));
    assertPassed(res);
    assertSetsSignInModeCookie(res, { secure: true });
  });

  it("redirects /kitchen/queue and /kitchen/queue-other without a cookie, and passes a UUID queue path", () => {
    const queueRoot = proxy(
      new NextRequest("https://app.example.com/kitchen/queue"),
    );
    expect(getRedirectUrl(queueRoot)).toBe("https://app.example.com/sign-in");
    assertSetsSignInModeCookie(queueRoot, { secure: true });

    const queueOther = proxy(
      new NextRequest("https://app.example.com/kitchen/queue-other"),
    );
    expect(getRedirectUrl(queueOther)).toBe("https://app.example.com/sign-in");
    assertSetsSignInModeCookie(queueOther, { secure: true });

    const queueUuid = proxy(
      new NextRequest(
        "https://app.example.com/kitchen/queue/11111111-2222-4333-8444-555555555555",
      ),
    );
    assertPassed(queueUuid);
    assertSetsSignInModeCookie(queueUuid, { secure: true });
  });

  it("sets the mode cookie without Secure on http://localhost:3000 and accepts a plain session cookie", () => {
    const redirected = proxy(new NextRequest("http://localhost:3000/kitchen"));
    expect(getRedirectUrl(redirected)).toBe("http://localhost:3000/sign-in");
    assertSetsSignInModeCookie(redirected, { secure: false });

    const passed = proxy(
      new NextRequest("http://localhost:3000/kitchen", {
        headers: { cookie: "better-auth.session_token=made-up-token" },
      }),
    );
    assertPassed(passed);
    assertSetsSignInModeCookie(passed, { secure: false });

    const queue = proxy(
      new NextRequest("http://localhost:3000/kitchen/queue/q1"),
    );
    assertPassed(queue);
    assertSetsSignInModeCookie(queue, { secure: false });
  });

  it("does not set the mode cookie when the request already carries sous-sign-in=1", async () => {
    const sessionCookie = await createSessionCookieHeader();

    const redirected = proxy(
      new NextRequest("https://app.example.com/kitchen", {
        headers: { cookie: `${SIGN_IN_MODE_COOKIE}=1` },
      }),
    );
    expect(getRedirectUrl(redirected)).toBe("https://app.example.com/sign-in");
    expect(signInModeSetCookies(redirected)).toEqual([]);

    const passed = proxy(
      new NextRequest("https://app.example.com/kitchen/cookpacks/p1", {
        headers: { cookie: `${sessionCookie}; ${SIGN_IN_MODE_COOKIE}=1` },
      }),
    );
    assertPassed(passed);
    expect(signInModeSetCookies(passed)).toEqual([]);

    const queue = proxy(
      new NextRequest("https://app.example.com/kitchen/queue/q1", {
        headers: { cookie: `${SIGN_IN_MODE_COOKIE}=1` },
      }),
    );
    assertPassed(queue);
    expect(signInModeSetCookies(queue)).toEqual([]);
  });

  it("overwrites sous-sign-in=0 with sous-sign-in=1", () => {
    const redirected = proxy(
      new NextRequest("https://app.example.com/kitchen", {
        headers: { cookie: `${SIGN_IN_MODE_COOKIE}=0` },
      }),
    );
    expect(getRedirectUrl(redirected)).toBe("https://app.example.com/sign-in");
    assertSetsSignInModeCookie(redirected, { secure: true });

    const queue = proxy(
      new NextRequest("https://app.example.com/kitchen/queue/q1", {
        headers: { cookie: `${SIGN_IN_MODE_COOKIE}=0` },
      }),
    );
    assertPassed(queue);
    assertSetsSignInModeCookie(queue, { secure: true });
  });
});

describe("PROXY-2: proxy in single-kitchen mode", () => {
  beforeEach(() => {
    vi.stubEnv("SOUS_SIGN_IN", "off");
  });

  it("passes every kitchen path with no cookie and with a session cookie, without any Set-Cookie", async () => {
    stubSignInEnv({ SOUS_SIGN_IN: "off" });
    const sessionCookie = await createSessionCookieHeader();

    const urls = [
      "https://app.example.com/kitchen",
      "https://app.example.com/kitchen/cookpacks/p1",
      "https://app.example.com/kitchen/queue/q1",
    ];

    for (const url of urls) {
      const withoutCookie = proxy(new NextRequest(url));
      assertPassed(withoutCookie);
      expect(withoutCookie.headers.getSetCookie()).toEqual([]);

      const withSession = proxy(
        new NextRequest(url, { headers: { cookie: sessionCookie } }),
      );
      assertPassed(withSession);
      expect(withSession.headers.getSetCookie()).toEqual([]);
    }
  });

  it("deletes sous-sign-in when present with value 1 or 0", () => {
    for (const value of ["1", "0"]) {
      const res = proxy(
        new NextRequest("https://app.example.com/kitchen", {
          headers: { cookie: `${SIGN_IN_MODE_COOKIE}=${value}` },
        }),
      );
      assertPassed(res);
      assertDeletesSignInModeCookie(res);
    }
  });
});

describe("PROXY-3: proxy matcher config", () => {
  it("matches /kitchen and its non-image subpaths, and skips image files and other routes", () => {
    for (const url of [
      "/kitchen",
      "/kitchen/",
      "/kitchen/cookpacks",
      "/kitchen/cookpacks/example.pack-v1",
      "/kitchen/queue",
      "/kitchen/queue-other",
      "/kitchen/queue/q1",
      "/kitchen/queue/11111111-2222-4333-8444-555555555555",
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    }

    for (const url of [
      "/kitchen/home-meal.webp",
      "/kitchen/home-idle-cookbooks.webp",
      "/kitchen/household-cover.webp",
      "/api/trpc/x",
      "/api/auth/get-session",
      "/sign-in",
      "/sign-in/done",
      "/not-invited",
      "/kitchenette",
      "/_next/static/a.js",
      "/sw.js",
      "/manifest.json",
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
    }
  });
});
