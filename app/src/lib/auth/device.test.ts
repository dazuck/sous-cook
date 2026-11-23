import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { Window } from "happy-dom";
import { createAuthClient } from "better-auth/react";

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
import {
  GET as authGet,
  POST as authPost,
} from "@/app/api/auth/[...all]/route";
import { resetAuthForTests } from "./auth";
import { resetDeploymentCheckForTests } from "../kitchens/deployment";
import {
  TEST_AUTH_ENV,
  createTestAuth,
  stubSignInEnv,
} from "../__tests__/test-auth";
import { homeKitchen } from "../__tests__/kitchens";
import {
  forgetDevice,
  signOutOfDevice,
  startSignIn,
  type DeviceNavigation,
} from "./device";

const client = (dbModule as unknown as { client: PGlite }).client;

const SEEDED_LOCAL_KEYS = [
  "sous-feedback",
  "sous-cook:q1",
  "sous-timers",
  "sous-cook-prep-mode",
] as const;

const SEEDED_SESSION_KEYS = ["sous.cook-scale.q1"] as const;

function seedBrowserStorage(): void {
  for (const key of SEEDED_LOCAL_KEYS) {
    window.localStorage.setItem(key, `value-${key}`);
  }
  for (const key of SEEDED_SESSION_KEYS) {
    window.sessionStorage.setItem(key, `value-${key}`);
  }
}

function readStorageKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) {
      keys.push(key);
    }
  }
  return keys.sort();
}

function assertStorageSeeded(): void {
  for (const key of SEEDED_LOCAL_KEYS) {
    expect(window.localStorage.getItem(key)).toBe(`value-${key}`);
  }
  for (const key of SEEDED_SESSION_KEYS) {
    expect(window.sessionStorage.getItem(key)).toBe(`value-${key}`);
  }
}

function assertStorageEmpty(): void {
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
}

interface RecordedRequest {
  path: string;
  body: string | undefined;
  localKeysAtRequest: string[];
  sessionKeysAtRequest: string[];
}

interface RecordingNavigation extends DeviceNavigation {
  assigned: string[];
  replaced: Array<{
    url: string;
    localLengthAtCall: number;
    sessionLengthAtCall: number;
  }>;
}

function createRecordingNavigation(): RecordingNavigation {
  const assigned: string[] = [];
  const replaced: Array<{
    url: string;
    localLengthAtCall: number;
    sessionLengthAtCall: number;
  }> = [];
  return {
    assigned,
    replaced,
    assign(url: string) {
      assigned.push(url);
    },
    replace(url: string) {
      replaced.push({
        url,
        localLengthAtCall: window.localStorage.length,
        sessionLengthAtCall: window.sessionStorage.length,
      });
    },
  };
}

class TestCookieJar {
  private readonly cookies = new Map<string, string>();

  seedFromHeader(cookieHeader: string | null): void {
    if (!cookieHeader) return;
    for (const pair of cookieHeader.split(";")) {
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (name) {
        this.cookies.set(name, value);
      }
    }
  }

  toHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  applySetCookies(headers: Headers): void {
    for (const raw of headers.getSetCookie()) {
      const parts = raw.split(";").map((part) => part.trim());
      const pair = parts[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) continue;

      const attrs = parts.slice(1);
      let expired = value === "";
      for (const attr of attrs) {
        const lower = attr.toLowerCase();
        if (lower.startsWith("max-age=")) {
          const maxAge = Number(attr.slice("max-age=".length));
          if (Number.isFinite(maxAge) && maxAge <= 0) {
            expired = true;
          }
        } else if (lower.startsWith("expires=")) {
          const expiresAt = Date.parse(attr.slice("expires=".length));
          if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
            expired = true;
          }
        }
      }

      if (expired) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
}

type FetchOverride = (
  authPath: string,
  request: Request,
) => Promise<Response> | Response | undefined;

function createInProcessAuthClient(options: {
  initialCookieHeader?: string | null;
  override?: FetchOverride;
}) {
  const jar = new TestCookieJar();
  jar.seedFromHeader(options.initialCookieHeader ?? null);
  const requests: RecordedRequest[] = [];

  const customFetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const baseRequest =
      input instanceof Request ? input : new Request(input, init);
    const url = new URL(baseRequest.url, TEST_AUTH_ENV.BETTER_AUTH_URL);
    const authPath = url.pathname.replace(/^\/api\/auth/, "");

    const headers = new Headers(baseRequest.headers);
    const jarCookie = jar.toHeader();
    if (jarCookie) {
      headers.set("cookie", jarCookie);
    }
    if (!headers.has("origin") && baseRequest.method !== "GET") {
      headers.set("origin", new URL(TEST_AUTH_ENV.BETTER_AUTH_URL).origin);
    }

    const body =
      baseRequest.method === "GET" || baseRequest.method === "HEAD"
        ? undefined
        : await baseRequest.clone().text();

    const routeRequest = new Request(url.toString(), {
      method: baseRequest.method,
      headers,
      body,
    });

    requests.push({
      path: authPath,
      body,
      localKeysAtRequest: readStorageKeys(window.localStorage),
      sessionKeysAtRequest: readStorageKeys(window.sessionStorage),
    });

    if (options.override) {
      const overridden = await options.override(authPath, routeRequest);
      if (overridden) {
        jar.applySetCookies(overridden.headers);
        return overridden;
      }
    }

    const response =
      routeRequest.method === "GET"
        ? await authGet(routeRequest)
        : await authPost(routeRequest);
    jar.applySetCookies(response.headers);
    return response;
  };

  const authClient = createAuthClient({
    fetchOptions: {
      customFetchImpl,
    },
  });

  return { authClient, requests, jar };
}

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

let activeWindow: Window | null = null;

beforeEach(async () => {
  stubSignInEnv();
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  await client.exec(
    "delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  activeWindow = new Window({ url: TEST_AUTH_ENV.BETTER_AUTH_URL });
  vi.stubGlobal("window", activeWindow);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (activeWindow) {
    await activeWindow.happyDOM.close();
    activeWindow = null;
  }
  vi.unstubAllGlobals();
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

describe("DEVICE-1: forgetDevice clears localStorage and sessionStorage", () => {
  it("empties all seeded keys from both localStorage and sessionStorage", () => {
    seedBrowserStorage();
    assertStorageSeeded();

    forgetDevice();

    assertStorageEmpty();
  });
});

describe("DEVICE-2: startSignIn clears storage only after sign-out succeeds and redirects to Google", () => {
  it("signs out, empties storage, requests Google sign-in, and navigates via assign", async () => {
    const { login } = await createInvitedUserWithSession("cook@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient, requests } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("started");
    expect(requests.map((r) => r.path)).toEqual([
      "/sign-out",
      "/sign-in/social",
    ]);
    expect(requests[0]!.localKeysAtRequest).toEqual(
      [...SEEDED_LOCAL_KEYS].sort(),
    );
    expect(requests[0]!.sessionKeysAtRequest).toEqual(
      [...SEEDED_SESSION_KEYS].sort(),
    );
    expect(requests[1]!.localKeysAtRequest).toEqual([]);
    expect(requests[1]!.sessionKeysAtRequest).toEqual([]);
    expect(JSON.parse(requests[1]!.body ?? "")).toMatchObject({
      provider: "google",
      callbackURL: "/sign-in/done",
      disableRedirect: true,
    });
    assertStorageEmpty();

    expect(navigation.assigned).toHaveLength(1);
    expect(
      navigation.assigned[0]!.startsWith("https://accounts.google.com/"),
    ).toBe(true);
    expect(navigation.replaced).toEqual([]);

    const remainingSessions = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.id, login.session.id));
    expect(remainingSessions).toEqual([]);
  });

  it("keeps storage intact and returns network when sign-out fails to fetch", async () => {
    const { login } = await createInvitedUserWithSession("net@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient, requests } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-out") {
          throw new TypeError("Failed to fetch");
        }
        return undefined;
      },
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("network");
    expect(requests.map((r) => r.path)).toEqual(["/sign-out"]);
    assertStorageSeeded();
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);
  });

  it("keeps storage intact and returns refused when sign-out answers 500", async () => {
    const { login } = await createInvitedUserWithSession("err500@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient, requests } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-out") {
          return new Response("{}", {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return undefined;
      },
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("refused");
    expect(requests.map((r) => r.path)).toEqual(["/sign-out"]);
    assertStorageSeeded();
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);
  });

  it("returns too-many-tries and does not navigate when sign-in/social answers 429", async () => {
    const { login } = await createInvitedUserWithSession("rate@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient, requests } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-in/social") {
          return new Response("{}", {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return undefined;
      },
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("too-many-tries");
    expect(requests.map((r) => r.path)).toEqual([
      "/sign-out",
      "/sign-in/social",
    ]);
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);
  });

  it("returns refused and does not navigate when sign-in/social answers 500", async () => {
    const { login } = await createInvitedUserWithSession("soc500@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient, requests } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-in/social") {
          return new Response("{}", {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return undefined;
      },
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("refused");
    expect(requests.map((r) => r.path)).toEqual([
      "/sign-out",
      "/sign-in/social",
    ]);
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);
  });

  it("keeps storage and session intact and returns refused when sign-out answers 200 HTML", async () => {
    const { login } = await createInvitedUserWithSession("html200@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient, requests } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-out") {
          return new Response("<!doctype html><html><body>Login</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return undefined;
      },
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("refused");
    expect(requests.map((r) => r.path)).toEqual(["/sign-out"]);
    assertStorageSeeded();
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);

    const remainingSessions = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.id, login.session.id));
    expect(remainingSessions).toHaveLength(1);
  });

  it("keeps storage and session intact and returns refused when sign-out answers 200 with success false", async () => {
    const { login } = await createInvitedUserWithSession("false200@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient, requests } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-out") {
          return new Response(JSON.stringify({ success: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return undefined;
      },
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("refused");
    expect(requests.map((r) => r.path)).toEqual(["/sign-out"]);
    assertStorageSeeded();
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);

    const remainingSessions = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.id, login.session.id));
    expect(remainingSessions).toHaveLength(1);
  });

  it("returns refused and does not navigate when sign-in/social answers a javascript URL", async () => {
    const { login } = await createInvitedUserWithSession("jsurl@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-in/social") {
          return new Response(
            JSON.stringify({ url: "javascript:alert(1)", redirect: false }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return undefined;
      },
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("refused");
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);
  });

  it("returns refused and does not navigate when sign-in/social answers a non-Google URL", async () => {
    const { login } = await createInvitedUserWithSession("otherurl@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-in/social") {
          return new Response(
            JSON.stringify({
              url: "https://elsewhere.example.com/o/oauth2/v2/auth",
              redirect: false,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return undefined;
      },
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("refused");
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);
  });

  it("starts sign-in and empties storage on a first-time sign-in with no session cookie", async () => {
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient, requests } = createInProcessAuthClient({
      initialCookieHeader: null,
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("started");
    expect(requests.map((r) => r.path)).toEqual([
      "/sign-out",
      "/sign-in/social",
    ]);
    assertStorageEmpty();
    expect(navigation.assigned).toHaveLength(1);
    expect(
      navigation.assigned[0]!.startsWith("https://accounts.google.com/"),
    ).toBe(true);
    expect(navigation.replaced).toEqual([]);
  });

  it("returns network without navigating when sign-in/social throws after sign-out", async () => {
    const { login } = await createInvitedUserWithSession("socnet@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient, requests } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-in/social") {
          throw new TypeError("Failed to fetch");
        }
        return undefined;
      },
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("network");
    expect(requests.map((r) => r.path)).toEqual([
      "/sign-out",
      "/sign-in/social",
    ]);
    assertStorageEmpty();
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);
  });

  it("returns refused and does not navigate when sign-in/social answers 200 without a url", async () => {
    const { login } = await createInvitedUserWithSession("nourl@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-in/social") {
          return new Response(JSON.stringify({ redirect: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return undefined;
      },
    });

    const outcome = await startSignIn(authClient, navigation);

    expect(outcome).toBe("refused");
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);
  });
});

describe("DEVICE-3: forgetDevice handles blocked storage and rethrows unexpected errors", () => {
  it("skips localStorage on SecurityError and still clears sessionStorage", () => {
    seedBrowserStorage();
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(() => forgetDevice()).not.toThrow();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("rethrows a non-SecurityError DOMException thrown by the localStorage getter", () => {
    seedBrowserStorage();
    const invalidState = new DOMException("x", "InvalidStateError");
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw invalidState;
    });

    expect(() => forgetDevice()).toThrow(invalidState);
  });

  it("rethrows a TypeError thrown by the localStorage getter", () => {
    seedBrowserStorage();
    const unexpected = new TypeError("storage getter failed");
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw unexpected;
    });

    expect(() => forgetDevice()).toThrow(unexpected);
  });
});

describe("SIGNOUT-2: signOutOfDevice clears storage and navigates only after sign-out succeeds", () => {
  it("deletes the live session, clears storage before replace, and navigates to /sign-in", async () => {
    const { login } = await createInvitedUserWithSession("out@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
    });

    const outcome = await signOutOfDevice(authClient, navigation);

    expect(outcome).toBe("signed-out");
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([
      {
        url: "/sign-in",
        localLengthAtCall: 0,
        sessionLengthAtCall: 0,
      },
    ]);
    assertStorageEmpty();

    const remainingSessions = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.id, login.session.id));
    expect(remainingSessions).toEqual([]);
  });

  it("returns network and keeps storage and session intact on a thrown fetch", async () => {
    const { login } = await createInvitedUserWithSession("outnet@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-out") {
          throw new TypeError("Failed to fetch");
        }
        return undefined;
      },
    });

    const outcome = await signOutOfDevice(authClient, navigation);

    expect(outcome).toBe("network");
    assertStorageSeeded();
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);

    const remainingSessions = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.id, login.session.id));
    expect(remainingSessions).toHaveLength(1);
  });

  it("returns refused and keeps storage and session intact when sign-out answers 500", async () => {
    const { login } = await createInvitedUserWithSession("out500@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-out") {
          return new Response("{}", {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return undefined;
      },
    });

    const outcome = await signOutOfDevice(authClient, navigation);

    expect(outcome).toBe("refused");
    assertStorageSeeded();
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);

    const remainingSessions = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.id, login.session.id));
    expect(remainingSessions).toHaveLength(1);
  });

  it("returns refused and keeps storage and session intact when sign-out answers 404", async () => {
    const { login } = await createInvitedUserWithSession("out404@example.com");
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-out") {
          return new Response("Not Found", { status: 404 });
        }
        return undefined;
      },
    });

    const outcome = await signOutOfDevice(authClient, navigation);

    expect(outcome).toBe("refused");
    assertStorageSeeded();
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);

    const remainingSessions = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.id, login.session.id));
    expect(remainingSessions).toHaveLength(1);
  });

  it("returns refused and keeps storage and session intact when sign-out answers 200 HTML", async () => {
    const { login } = await createInvitedUserWithSession(
      "outhtml200@example.com",
    );
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-out") {
          return new Response("<!doctype html><html><body>Login</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return undefined;
      },
    });

    const outcome = await signOutOfDevice(authClient, navigation);

    expect(outcome).toBe("refused");
    assertStorageSeeded();
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);

    const remainingSessions = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.id, login.session.id));
    expect(remainingSessions).toHaveLength(1);
  });

  it("returns refused and keeps storage and session intact when sign-out answers 200 with success false", async () => {
    const { login } = await createInvitedUserWithSession(
      "outfalse200@example.com",
    );
    seedBrowserStorage();
    const navigation = createRecordingNavigation();
    const { authClient } = createInProcessAuthClient({
      initialCookieHeader: login.headers.get("cookie"),
      override: (path) => {
        if (path === "/sign-out") {
          return new Response(JSON.stringify({ success: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return undefined;
      },
    });

    const outcome = await signOutOfDevice(authClient, navigation);

    expect(outcome).toBe("refused");
    assertStorageSeeded();
    expect(navigation.assigned).toEqual([]);
    expect(navigation.replaced).toEqual([]);

    const remainingSessions = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.id, login.session.id));
    expect(remainingSessions).toHaveLength(1);
  });
});
