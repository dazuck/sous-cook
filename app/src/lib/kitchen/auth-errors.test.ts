import { randomUUID } from "node:crypto";
import {
  MutationObserver,
  onlineManager,
  QueryObserver,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  TRPCClientError,
} from "@trpc/client";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db, kitchens, members } from "@/lib/db";
import { GET as trpcGet, POST as trpcPost } from "@/app/api/trpc/[trpc]/route";
import { makeQueryClient } from "@/app/providers";
import { resetAuthForTests } from "@/lib/auth/auth";
import { resetDeploymentCheckForTests } from "@/lib/kitchens/deployment";
import { readQueueRecipe } from "@/lib/pack-convert/queue-recipe";
import {
  seedKitchen,
  type AuthUserRow,
  type KitchenRow,
} from "@/lib/__tests__/kitchens";
import {
  signedInHeaders,
  stubSignInEnv,
  TEST_AUTH_ENV,
} from "@/lib/__tests__/test-auth";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import type { AppRouter } from "@/server/routers/_app";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE } from "./__tests__/zucchini-wraps";
import {
  authErrorKind,
  handleAuthError,
  resetAuthErrorsForTests,
} from "./auth-errors";
import {
  recipeFingerprint,
  reduceSession,
  saveSession,
  startSession,
  type CookSession,
  type CookSnapshot,
} from "./cook-session";
import type { CookReport } from "./report-capture";
import { isSignedOut, resetSignedOutForTests } from "./signed-out";

const client = (dbModule as unknown as { client: PGlite }).client;

let kitchenA: KitchenRow;
let userA: AuthUserRow;
let activeWindow: Window | null = null;

const TEST_RECIPE_NO_SERVES = {
  name: "Lemon Garlic Beans",
  ingredients: [
    { item: "white beans", amount: "2", unit: "cans" },
    { item: "garlic cloves", amount: "3" },
  ],
  steps: ["Warm the white beans with minced garlic cloves for 10 minutes."],
};

const ZUCCHINI_ROW = {
  recipeData: {
    name: "Sweet Zucchini Wraps",
    serves: 4,
    ...ZUCCHINI_RECIPE,
  } as KitchenQueueRecipeData,
  servesEstimate: null,
  servesEstimateBasis: null,
};

function createSavedCookFixtures(): {
  fingerprint: string;
  session: CookSession;
  snapshot: CookSnapshot;
} {
  const read = readQueueRecipe({ id: "q1", ...ZUCCHINI_ROW });
  if (read.packRecipe === null) {
    throw new Error(`Fixture recipe unreadable: ${read.conversionError}`);
  }
  let session = startSession(ZUCCHINI_PLAN, { kind: "derived" }, "go");
  session = reduceSession(session, {
    type: "tick",
    id: session.plan.tasks.find((task) => task.kind === "mise")!.id,
  });
  session = reduceSession(session, { type: "next" });
  return {
    fingerprint: recipeFingerprint(ZUCCHINI_ROW),
    session,
    snapshot: {
      recipeData: ZUCCHINI_ROW.recipeData,
      packRecipe: read.packRecipe,
      cookPlan: ZUCCHINI_PLAN,
    },
  };
}

function makeReport(): CookReport {
  return {
    id: randomUUID(),
    capturedAt: "2026-10-04T10:00:00.000Z",
    build: "b-1",
    path: "/kitchen/queue/q1",
    screen: "step",
    queueId: null,
    recipeName: "Mole",
    stepKey: "s1",
    chapterId: null,
    planVersion: 4,
    plan: null,
    state: { mode: "go", pos: 1, ticked: [], passed: [], kept: [] },
    context: {
      viewport: { w: 1280, h: 800, dpr: 2 },
      ua: "test-agent",
      online: true,
      voice: { mode: null, status: "unsupported" },
      ask: { sessionId: "cook-queue-1", open: false },
      layers: { pane: false, card: null, more: false },
      part: null,
    },
    events: [
      {
        at: "2026-10-04T09:59:59.000Z",
        kind: "step",
        detail: "next -> 1",
      },
    ],
    dom: '<div id="root"></div>',
    domTruncated: false,
    note: "",
  };
}

async function setWindowUrl(url: string): Promise<Window> {
  if (activeWindow) {
    await activeWindow.happyDOM.close();
  }
  activeWindow = new Window({ url });
  vi.stubGlobal("window", activeWindow);
  vi.stubGlobal("navigator", activeWindow.navigator);
  return activeWindow;
}

function createRouteFetch(options: {
  cookieHeader?: string | null;
  origin?: string;
} = {}): typeof fetch {
  return async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const resolvedUrl = new URL(rawUrl, TEST_AUTH_ENV.BETTER_AUTH_URL);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }
    if (options.cookieHeader) {
      headers.set("cookie", options.cookieHeader);
    }
    if (options.origin !== undefined) {
      headers.set("origin", options.origin);
    }

    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      if (typeof init?.body === "string") {
        body = init.body;
      } else if (input instanceof Request) {
        body = await input.clone().text();
      }
    }

    const req = new Request(resolvedUrl.toString(), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    return method === "GET" ? trpcGet(req) : trpcPost(req);
  };
}

function createRouteTrpcClient(options: {
  cookieHeader?: string | null;
  origin?: string;
} = {}) {
  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/trpc`,
        fetch: createRouteFetch(options),
      }),
    ],
  });
}

function createBatchRouteTrpcClient(options: {
  cookieHeader?: string | null;
  origin?: string;
  onRequest?: () => void;
} = {}) {
  const routeFetch = createRouteFetch(options);
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/trpc`,
        fetch: async (input, init) => {
          options.onRequest?.();
          return routeFetch(input, init);
        },
      }),
    ],
  });
}

async function catchRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected promise to reject");
}

function trpcErrorData(err: unknown): {
  code?: unknown;
  reason?: unknown;
  allowance?: unknown;
} {
  if (!(err instanceof TRPCClientError)) return {};
  return (err.data as {
    code?: unknown;
    reason?: unknown;
    allowance?: unknown;
  }) ?? {};
}

async function createUninvitedSessionHeaders(): Promise<Headers> {
  const { user } = await seedKitchen(db, {
    slug: `removed-${randomUUID().slice(0, 8)}`,
    name: "Removed Kitchen",
  });
  const headers = await signedInHeaders(user.id, db);
  await db.delete(members).where(eq(members.userId, user.id));
  return headers;
}

beforeEach(async () => {
  stubSignInEnv();
  vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
  vi.stubEnv("AI_TEXT_PROVIDER", "google");
  vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  resetAuthErrorsForTests();
  resetSignedOutForTests();
  onlineManager.setOnline(true);

  await client.exec(
    "delete from ai_usage; delete from cook_reports; delete from kitchen_queue; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec(
    "delete from kitchens where slug <> 'home'; update kitchens set ai_monthly_cap_micros = null where slug = 'home';",
  );

  const a = await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" });
  kitchenA = a.kitchen;
  userA = a.user;

  await setWindowUrl(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/kitchen`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (activeWindow) {
    await activeWindow.happyDOM.close();
    activeWindow = null;
  }
  vi.unstubAllGlobals();
  onlineManager.setOnline(true);
  resetAuthErrorsForTests();
  resetSignedOutForTests();
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

async function runObservedQuery(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  queryFn: () => Promise<unknown>,
): Promise<unknown> {
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    retryDelay: 0,
  });
  try {
    return await new Promise<unknown>((resolve) => {
      const unsubscribe = observer.subscribe((result) => {
        if (result.status === "error") {
          unsubscribe();
          resolve(result.error);
        } else if (result.status === "success") {
          unsubscribe();
          resolve(null);
        }
      });
    });
  } finally {
    observer.destroy();
  }
}

describe("AUTHERR-1: authErrorKind classifies real tRPC route refusals", () => {
  it("maps UNAUTHORIZED to sign-in, not-invited FORBIDDEN to not-invited, and cross-site or AI cap refusals to null", async () => {
    const signedOutClient = createRouteTrpcClient();
    const unauthorizedErr = await catchRejection(
      signedOutClient.getKitchenQueue.query({}),
    );
    expect(unauthorizedErr).toBeInstanceOf(TRPCClientError);
    expect(trpcErrorData(unauthorizedErr).code).toBe("UNAUTHORIZED");
    expect(authErrorKind(unauthorizedErr)).toBe("sign-in");

    const strangerHeaders = await createUninvitedSessionHeaders();
    const uninvitedClient = createRouteTrpcClient({
      cookieHeader: strangerHeaders.get("cookie"),
    });
    const notInvitedErr = await catchRejection(
      uninvitedClient.getKitchenQueue.query({}),
    );
    expect(notInvitedErr).toBeInstanceOf(TRPCClientError);
    expect(trpcErrorData(notInvitedErr)).toMatchObject({
      code: "FORBIDDEN",
      reason: "not-invited",
    });
    expect(authErrorKind(notInvitedErr)).toBe("not-invited");

    const headersA = await signedInHeaders(userA.id, db);
    const crossSiteClient = createRouteTrpcClient({
      cookieHeader: headersA.get("cookie"),
      origin: "https://elsewhere.example.com",
    });
    const crossSiteErr = await catchRejection(
      crossSiteClient.getKitchenQueue.query({}),
    );
    expect(crossSiteErr).toBeInstanceOf(TRPCClientError);
    expect(trpcErrorData(crossSiteErr).code).toBe("FORBIDDEN");
    expect(trpcErrorData(crossSiteErr).reason).toBeUndefined();
    expect(authErrorKind(crossSiteErr)).toBeNull();

    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 0 })
      .where(eq(kitchens.id, kitchenA.id));
    const cappedClient = createRouteTrpcClient({
      cookieHeader: headersA.get("cookie"),
      origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
    });
    const capErr = await catchRejection(
      cappedClient.addToKitchenQueue.mutate({
        recipeData: TEST_RECIPE_NO_SERVES,
      }),
    );
    expect(capErr).toBeInstanceOf(TRPCClientError);
    expect(trpcErrorData(capErr).code).toBe("TOO_MANY_REQUESTS");
    expect(trpcErrorData(capErr).allowance).toMatchObject({
      scope: "kitchen",
    });
    expect(authErrorKind(capErr)).toBeNull();
  });
});

describe("AUTHERR-2: handleAuthError navigates once per load and makeQueryClient skips auth retries", () => {
  it("replaces once for sign-in, once for not-invited after reset, once on a cook route without a saved session, and ignores null-kind errors", async () => {
    const signedOutClient = createRouteTrpcClient();
    const unauthorizedErr = await catchRejection(
      signedOutClient.getKitchenQueue.query({}),
    );
    const strangerHeaders = await createUninvitedSessionHeaders();
    const uninvitedClient = createRouteTrpcClient({
      cookieHeader: strangerHeaders.get("cookie"),
    });
    const notInvitedErr = await catchRejection(
      uninvitedClient.getKitchenQueue.query({}),
    );
    const headersA = await signedInHeaders(userA.id, db);
    const crossSiteClient = createRouteTrpcClient({
      cookieHeader: headersA.get("cookie"),
      origin: "https://elsewhere.example.com",
    });
    const crossSiteErr = await catchRejection(
      crossSiteClient.getKitchenQueue.query({}),
    );

    const replaced: string[] = [];
    const navigation = {
      replace(url: string) {
        replaced.push(url);
      },
    };

    handleAuthError(unauthorizedErr, { navigation });
    handleAuthError(unauthorizedErr, { navigation });
    handleAuthError(unauthorizedErr, { navigation });
    expect(replaced).toEqual(["/sign-in"]);

    resetAuthErrorsForTests();
    replaced.length = 0;
    handleAuthError(notInvitedErr, { navigation });
    handleAuthError(notInvitedErr, { navigation });
    handleAuthError(notInvitedErr, { navigation });
    expect(replaced).toEqual(["/not-invited"]);

    resetAuthErrorsForTests();
    replaced.length = 0;
    await setWindowUrl(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/kitchen/queue/q1`);
    handleAuthError(unauthorizedErr, { navigation });
    handleAuthError(unauthorizedErr, { navigation });
    handleAuthError(unauthorizedErr, { navigation });
    expect(replaced).toEqual(["/sign-in"]);

    resetAuthErrorsForTests();
    replaced.length = 0;
    await setWindowUrl(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/kitchen`);
    handleAuthError(crossSiteErr, { navigation });
    expect(replaced).toEqual([]);
  });

  it("fetches UNAUTHORIZED once and navigates to /sign-in through makeQueryClient", async () => {
    const replaced: string[] = [];
    const queryClient = makeQueryClient({
      navigation: {
        replace(url: string) {
          replaced.push(url);
        },
      },
    });
    const signedOutClient = createBatchRouteTrpcClient();
    let fetches = 0;

    try {
      const error = await runObservedQuery(
        queryClient,
        ["kitchen-queue-unauthorized"],
        () => {
          fetches += 1;
          return signedOutClient.getKitchenQueue.query({});
        },
      );
      expect(error).toBeInstanceOf(TRPCClientError);
      expect(trpcErrorData(error).code).toBe("UNAUTHORIZED");
      expect(fetches).toBe(1);
      expect(replaced).toEqual(["/sign-in"]);
    } finally {
      queryClient.clear();
    }
  });

  it("replaces with /sign-in once when two batched queries answer UNAUTHORIZED", async () => {
    const replaced: string[] = [];
    const queryClient = makeQueryClient({
      navigation: {
        replace(url: string) {
          replaced.push(url);
        },
      },
    });
    let httpRequests = 0;
    const signedOutClient = createBatchRouteTrpcClient({
      onRequest: () => {
        httpRequests += 1;
      },
    });

    try {
      const [firstErr, secondErr] = await Promise.all([
        runObservedQuery(queryClient, ["kitchen-queue-batch-1"], () =>
          signedOutClient.getKitchenQueue.query({}),
        ),
        runObservedQuery(queryClient, ["kitchen-queue-batch-2"], () =>
          signedOutClient.getKitchenQueue.query({}),
        ),
      ]);
      expect(firstErr).toBeInstanceOf(TRPCClientError);
      expect(trpcErrorData(firstErr).code).toBe("UNAUTHORIZED");
      expect(secondErr).toBeInstanceOf(TRPCClientError);
      expect(trpcErrorData(secondErr).code).toBe("UNAUTHORIZED");
      expect(httpRequests).toBe(1);
      expect(replaced).toEqual(["/sign-in"]);
    } finally {
      queryClient.clear();
    }
  });

  it("fetches not-invited FORBIDDEN once and navigates to /not-invited through makeQueryClient", async () => {
    const strangerHeaders = await createUninvitedSessionHeaders();
    const replaced: string[] = [];
    const queryClient = makeQueryClient({
      navigation: {
        replace(url: string) {
          replaced.push(url);
        },
      },
    });
    const uninvitedClient = createBatchRouteTrpcClient({
      cookieHeader: strangerHeaders.get("cookie"),
    });
    let fetches = 0;

    try {
      const error = await runObservedQuery(
        queryClient,
        ["kitchen-queue-not-invited"],
        () => {
          fetches += 1;
          return uninvitedClient.getKitchenQueue.query({});
        },
      );
      expect(error).toBeInstanceOf(TRPCClientError);
      expect(trpcErrorData(error)).toMatchObject({
        code: "FORBIDDEN",
        reason: "not-invited",
      });
      expect(fetches).toBe(1);
      expect(replaced).toEqual(["/not-invited"]);
    } finally {
      queryClient.clear();
    }
  });

  it("does not navigate on an AI allowance refusal, sends the mutation once, and retries that error three times on queries", async () => {
    const headersA = await signedInHeaders(userA.id, db);
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 0 })
      .where(eq(kitchens.id, kitchenA.id));

    const replaced: string[] = [];
    const queryClient = makeQueryClient({
      navigation: {
        replace(url: string) {
          replaced.push(url);
        },
      },
    });
    const cappedClient = createBatchRouteTrpcClient({
      cookieHeader: headersA.get("cookie"),
      origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
    });
    let calls = 0;

    try {
      const observer = new MutationObserver(queryClient, {
        mutationFn: (recipeData: typeof TEST_RECIPE_NO_SERVES) => {
          calls += 1;
          return cappedClient.addToKitchenQueue.mutate({ recipeData });
        },
      });
      const error = await catchRejection(observer.mutate(TEST_RECIPE_NO_SERVES));
      expect(error).toBeInstanceOf(TRPCClientError);
      expect(trpcErrorData(error).code).toBe("TOO_MANY_REQUESTS");
      expect(trpcErrorData(error).allowance).toMatchObject({
        scope: "kitchen",
      });
      expect(calls).toBe(1);
      expect(replaced).toEqual([]);

      const retry = queryClient.getDefaultOptions().queries?.retry;
      expect(typeof retry).toBe("function");
      if (typeof retry === "function") {
        expect(retry(0, error as Error)).toBe(true);
        expect(retry(1, error as Error)).toBe(true);
        expect(retry(2, error as Error)).toBe(true);
        expect(retry(3, error as Error)).toBe(false);
      }
    } finally {
      queryClient.clear();
    }
  });

  it("sends a mutation answered UNAUTHORIZED to /sign-in once through makeQueryClient", async () => {
    const replaced: string[] = [];
    const queryClient = makeQueryClient({
      navigation: {
        replace(url: string) {
          replaced.push(url);
        },
      },
    });
    const signedOutClient = createBatchRouteTrpcClient({
      origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
    });
    let calls = 0;

    try {
      const observer = new MutationObserver(queryClient, {
        mutationFn: (recipeData: typeof TEST_RECIPE_NO_SERVES) => {
          calls += 1;
          return signedOutClient.addToKitchenQueue.mutate({ recipeData });
        },
      });
      const error = await catchRejection(observer.mutate(TEST_RECIPE_NO_SERVES));
      expect(error).toBeInstanceOf(TRPCClientError);
      expect(trpcErrorData(error).code).toBe("UNAUTHORIZED");
      expect(calls).toBe(1);
      expect(replaced).toEqual(["/sign-in"]);
    } finally {
      queryClient.clear();
    }
  });

  it("retries INTERNAL_SERVER_ERROR three times (four fetches total) and does not navigate", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "yes");
    resetDeploymentCheckForTests(db);

    const replaced: string[] = [];
    const queryClient = makeQueryClient({
      navigation: {
        replace(url: string) {
          replaced.push(url);
        },
      },
    });
    const routeClient = createBatchRouteTrpcClient();
    let fetches = 0;

    try {
      const error = await runObservedQuery(
        queryClient,
        ["kitchen-queue-internal-error"],
        () => {
          fetches += 1;
          return routeClient.getKitchenQueue.query({});
        },
      );
      expect(error).toBeInstanceOf(TRPCClientError);
      expect(trpcErrorData(error).code).toBe("INTERNAL_SERVER_ERROR");
      expect(fetches).toBe(4);
      expect(replaced).toEqual([]);
    } finally {
      queryClient.clear();
    }
  });

  it("succeeds with no session cookie and does not navigate in single-kitchen mode", async () => {
    await client.exec(
      "delete from members; delete from kitchens where slug <> 'home';",
    );
    vi.stubEnv("SOUS_SIGN_IN", "off");
    resetDeploymentCheckForTests(db);

    const replaced: string[] = [];
    const queryClient = makeQueryClient({
      navigation: {
        replace(url: string) {
          replaced.push(url);
        },
      },
    });
    const routeClient = createBatchRouteTrpcClient();

    try {
      let data: unknown;
      const error = await runObservedQuery(
        queryClient,
        ["kitchen-queue-single-mode"],
        async () => {
          data = await routeClient.getKitchenQueue.query({});
          return data;
        },
      );
      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(replaced).toEqual([]);
    } finally {
      queryClient.clear();
    }
  });

  it("seeds onlineManager from navigator.onLine", () => {
    const onLineSpy = vi.spyOn(navigator, "onLine", "get");
    onLineSpy.mockReturnValue(false);
    makeQueryClient();
    expect(onlineManager.isOnline()).toBe(false);

    onLineSpy.mockReturnValue(true);
    makeQueryClient();
    expect(onlineManager.isOnline()).toBe(true);
  });
});

describe("AUTHERR-3: a cook page with a saved session stays open and marks signed out", () => {
  it("does not navigate and sets isSignedOut to true when a saved session exists for the route's queue id", async () => {
    await setWindowUrl(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/kitchen/queue/q1`);
    const { fingerprint, session, snapshot } = createSavedCookFixtures();
    expect(
      saveSession("q1", fingerprint, session, snapshot, 1_700_000_000_000),
    ).toBe(true);

    const signedOutClient = createRouteTrpcClient();
    const unauthorizedErr = await catchRejection(
      signedOutClient.getKitchenQueue.query({}),
    );
    expect(authErrorKind(unauthorizedErr)).toBe("sign-in");

    const replaced: string[] = [];
    const navigation = {
      replace(url: string) {
        replaced.push(url);
      },
    };

    expect(isSignedOut()).toBe(false);
    handleAuthError(unauthorizedErr, { navigation });

    expect(replaced).toEqual([]);
    expect(isSignedOut()).toBe(true);
  });

  it("stays open and marks signed out on not-invited FORBIDDEN when a saved session exists for the route's queue id", async () => {
    await setWindowUrl(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/kitchen/queue/q1`);
    const { fingerprint, session, snapshot } = createSavedCookFixtures();
    expect(
      saveSession("q1", fingerprint, session, snapshot, 1_700_000_000_000),
    ).toBe(true);

    const strangerHeaders = await createUninvitedSessionHeaders();
    const uninvitedClient = createRouteTrpcClient({
      cookieHeader: strangerHeaders.get("cookie"),
    });
    const notInvitedErr = await catchRejection(
      uninvitedClient.getKitchenQueue.query({}),
    );
    expect(trpcErrorData(notInvitedErr)).toMatchObject({
      code: "FORBIDDEN",
      reason: "not-invited",
    });
    expect(authErrorKind(notInvitedErr)).toBe("not-invited");

    const replaced: string[] = [];
    const navigation = {
      replace(url: string) {
        replaced.push(url);
      },
    };

    expect(isSignedOut()).toBe(false);
    handleAuthError(notInvitedErr, { navigation });

    expect(replaced).toEqual([]);
    expect(isSignedOut()).toBe(true);
  });

  it("navigates to /sign-in once and does not mark signed out when a session is saved only for another queue id", async () => {
    await setWindowUrl(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/kitchen/queue/q1`);
    const { fingerprint, session, snapshot } = createSavedCookFixtures();
    expect(
      saveSession("q2", fingerprint, session, snapshot, 1_700_000_000_000),
    ).toBe(true);

    const signedOutClient = createRouteTrpcClient();
    const unauthorizedErr = await catchRejection(
      signedOutClient.getKitchenQueue.query({}),
    );
    expect(authErrorKind(unauthorizedErr)).toBe("sign-in");

    const replaced: string[] = [];
    const navigation = {
      replace(url: string) {
        replaced.push(url);
      },
    };

    expect(isSignedOut()).toBe(false);
    handleAuthError(unauthorizedErr, { navigation });
    handleAuthError(unauthorizedErr, { navigation });

    expect(replaced).toEqual(["/sign-in"]);
    expect(isSignedOut()).toBe(false);
  });
});

describe("AUTHERR-4: reportOutbox singleton does not navigate on UNAUTHORIZED", () => {
  it("leaves a report waiting after flush and calls neither location.replace nor location.assign", async () => {
    const win = await setWindowUrl(`${TEST_AUTH_ENV.BETTER_AUTH_URL}/kitchen`);
    const routeFetch = createRouteFetch();
    const responses: Array<{ status: number; code: unknown }> = [];
    const observingFetch: typeof fetch = async (input, init) => {
      const res = await routeFetch(input, init);
      const clone = res.clone();
      const body = (await clone.json()) as {
        error?: { data?: { code?: unknown } };
      };
      responses.push({
        status: res.status,
        code: body.error?.data?.code,
      });
      return res;
    };
    vi.stubGlobal("fetch", observingFetch);
    vi.spyOn(win, "fetch").mockImplementation(
      observingFetch as unknown as typeof win.fetch,
    );

    const replaceSpy = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {});
    const assignSpy = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});

    vi.resetModules();
    const { reportOutbox } = await import("@/hooks/useReportOutbox");
    const outbox = reportOutbox();

    const captured = makeReport();
    await expect(outbox.add(captured)).resolves.toBe("flagged");
    await outbox.flush();

    expect(responses.length).toBeGreaterThanOrEqual(1);
    expect(
      responses.every(
        (response) =>
          response.status === 401 && response.code === "UNAUTHORIZED",
      ),
    ).toBe(true);
    expect(outbox.list()).toHaveLength(1);
    expect(outbox.list()[0]?.id).toBe(captured.id);
    expect(outbox.list()[0]?.status).toBe("waiting");
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
