import { randomUUID } from "node:crypto";
import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { cookReports, db } from "@/lib/db";
import { GET as trpcGet, POST as trpcPost } from "@/app/api/trpc/[trpc]/route";
import { resetAuthForTests } from "@/lib/auth/auth";
import { REPORTS_PER_DAY } from "@/lib/cook-reports";
import { resetDeploymentCheckForTests } from "@/lib/kitchens/deployment";
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
import type { AppRouter } from "@/server/routers/_app";
import type { CookReport } from "./report-capture";
import { recentEvents, resetEventLog } from "./report-events";
import {
  createReportOutbox,
  outcomeOf,
  type StringStore,
} from "./report-outbox";

const client = (dbModule as unknown as { client: PGlite }).client;

let kitchenA: KitchenRow;
let userA: AuthUserRow;
let userB: AuthUserRow;

function memoryStore(): StringStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function makeReport(overrides: Partial<CookReport> = {}): CookReport {
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
    ...overrides,
  };
}

interface RouteClientOptions {
  cookieHeader?: string | null;
  origin?: string;
  onRequest?: () => void;
  fetchImpl?: typeof fetch;
}

function createRouteTrpcClient(options: RouteClientOptions = {}) {
  const routeFetch: typeof fetch =
    options.fetchImpl ??
    (async (input, init) => {
      options.onRequest?.();
      const baseRequest =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(baseRequest.url, TEST_AUTH_ENV.BETTER_AUTH_URL);
      const headers = new Headers(baseRequest.headers);
      if (options.cookieHeader) {
        headers.set("cookie", options.cookieHeader);
      }
      if (options.origin !== undefined) {
        headers.set("origin", options.origin);
      }
      const body =
        baseRequest.method === "GET" || baseRequest.method === "HEAD"
          ? undefined
          : await baseRequest.clone().text();
      const req = new Request(url.toString(), {
        method: baseRequest.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      return req.method === "GET" ? trpcGet(req) : trpcPost(req);
    });

  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${TEST_AUTH_ENV.BETTER_AUTH_URL}/api/trpc`,
        fetch: routeFetch,
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

function trpcErrorCode(err: unknown): string | undefined {
  if (!(err instanceof TRPCClientError)) return undefined;
  const data = err.data as { code?: unknown } | null | undefined;
  return typeof data?.code === "string" ? data.code : undefined;
}

beforeEach(async () => {
  stubSignInEnv();
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  resetEventLog();

  await client.exec(
    "delete from cook_reports; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  const a = await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" });
  kitchenA = a.kitchen;
  userA = a.user;
  const b = await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" });
  userB = b.user;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

describe("OUTBOX-1: report outbox outcomes against the real tRPC route", () => {
  it("classifies CONFLICT from another kitchen's report id as refused", async () => {
    const headersA = await signedInHeaders(userA.id, db);
    const headersB = await signedInHeaders(userB.id, db);
    const clientA = createRouteTrpcClient({
      cookieHeader: headersA.get("cookie"),
      origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
    });
    const clientB = createRouteTrpcClient({
      cookieHeader: headersB.get("cookie"),
      origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
    });

    const report = makeReport();
    await expect(clientA.submitCookReport.mutate(report)).resolves.toEqual({
      id: report.id,
      duplicate: false,
    });

    const conflictErr = await catchRejection(
      clientB.submitCookReport.mutate(report),
    );
    expect(conflictErr).toBeInstanceOf(TRPCClientError);
    expect(trpcErrorCode(conflictErr)).toBe("CONFLICT");
    expect(outcomeOf(conflictErr)).toBe("refused");
  });

  it("classifies BAD_REQUEST as refused and UNAUTHORIZED, FORBIDDEN, TOO_MANY_REQUESTS, and network errors as retry", async () => {
    const headersA = await signedInHeaders(userA.id, db);
    const clientA = createRouteTrpcClient({
      cookieHeader: headersA.get("cookie"),
      origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
    });

    const invalidReport = makeReport({ id: "not-a-uuid" });
    const badRequestErr = await catchRejection(
      clientA.submitCookReport.mutate(invalidReport),
    );
    expect(badRequestErr).toBeInstanceOf(TRPCClientError);
    expect(trpcErrorCode(badRequestErr)).toBe("BAD_REQUEST");
    expect(outcomeOf(badRequestErr)).toBe("refused");

    const signedOutClient = createRouteTrpcClient({
      origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
    });
    const unauthorizedErr = await catchRejection(
      signedOutClient.submitCookReport.mutate(makeReport()),
    );
    expect(unauthorizedErr).toBeInstanceOf(TRPCClientError);
    expect(trpcErrorCode(unauthorizedErr)).toBe("UNAUTHORIZED");
    expect(outcomeOf(unauthorizedErr)).toBe("retry");

    const crossSiteClient = createRouteTrpcClient({
      cookieHeader: headersA.get("cookie"),
      origin: "https://elsewhere.example.com",
    });
    const forbiddenErr = await catchRejection(
      crossSiteClient.submitCookReport.mutate(makeReport()),
    );
    expect(forbiddenErr).toBeInstanceOf(TRPCClientError);
    expect(trpcErrorCode(forbiddenErr)).toBe("FORBIDDEN");
    expect(outcomeOf(forbiddenErr)).toBe("retry");

    const baseRow = makeReport();
    await db.insert(cookReports).values(
      Array.from({ length: REPORTS_PER_DAY }, () => ({
        id: randomUUID(),
        kitchenId: kitchenA.id,
        memberId: null,
        capturedAt: new Date(baseRow.capturedAt),
        build: baseRow.build,
        path: baseRow.path,
        screen: baseRow.screen,
        queueId: null,
        recipeName: baseRow.recipeName,
        stepKey: baseRow.stepKey,
        chapterId: null,
        planVersion: baseRow.planVersion,
        plan: null,
        state: baseRow.state,
        context: baseRow.context,
        events: baseRow.events,
        dom: baseRow.dom,
        domTruncated: false,
        note: "",
        noteAt: null,
      })),
    );
    const rateCapErr = await catchRejection(
      clientA.submitCookReport.mutate(makeReport()),
    );
    expect(rateCapErr).toBeInstanceOf(TRPCClientError);
    expect(trpcErrorCode(rateCapErr)).toBe("TOO_MANY_REQUESTS");
    expect(outcomeOf(rateCapErr)).toBe("retry");

    const offlineClient = createRouteTrpcClient({
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const networkErr = await catchRejection(
      offlineClient.submitCookReport.mutate(makeReport()),
    );
    expect(outcomeOf(networkErr)).toBe("retry");
  });

  it("marks a conflicting report refused in the outbox and does not resend on a second flush", async () => {
    const headersA = await signedInHeaders(userA.id, db);
    const headersB = await signedInHeaders(userB.id, db);
    const clientA = createRouteTrpcClient({
      cookieHeader: headersA.get("cookie"),
      origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
    });

    const conflicting = makeReport();
    await clientA.submitCookReport.mutate(conflicting);

    let routeCalls = 0;
    const clientB = createRouteTrpcClient({
      cookieHeader: headersB.get("cookie"),
      origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
      onRequest: () => {
        routeCalls += 1;
      },
    });

    const outbox = createReportOutbox(memoryStore(), {
      submit: (report) => clientB.submitCookReport.mutate(report),
      annotate: (id, note) => clientB.annotateCookReport.mutate({ id, note }),
    });

    await expect(outbox.add(conflicting)).resolves.toBe("flagged");
    await outbox.flush();

    expect(routeCalls).toBe(1);
    expect(outbox.list()).toHaveLength(1);
    expect(outbox.list()[0]?.id).toBe(conflicting.id);
    expect(outbox.list()[0]?.status).toBe("refused");
    expect(
      recentEvents()
        .filter((event) => event.kind === "flag")
        .map((event) => event.detail),
    ).toContain("the server refused a report");

    await outbox.flush();
    expect(routeCalls).toBe(1);
    expect(outbox.list()[0]?.status).toBe("refused");
  });
});
