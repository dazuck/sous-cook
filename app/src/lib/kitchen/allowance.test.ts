import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeProvider = await vi.hoisted(async () => {
  const { FakeProviderController } = await import("../__tests__/fake-provider");
  return new FakeProviderController();
});

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);
vi.mock("@/lib/ai/providers/google", () => ({
  createGoogleProvider: () => fakeProvider.provider("google"),
}));
vi.mock("@/lib/ai/providers/anthropic", () => ({
  createAnthropicProvider: () => fakeProvider.provider("anthropic"),
}));

import * as dbModule from "@/lib/db";
import { db, kitchens } from "@/lib/db";
import { GET as trpcGet, POST as trpcPost } from "@/app/api/trpc/[trpc]/route";
import { AllowanceUsedError } from "@/lib/ai/types";
import { resetAuthForTests } from "@/lib/auth/auth";
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
import { allowanceError } from "./__tests__/allowance-error";
import { allowanceSentence } from "./allowance";

const client = (dbModule as unknown as { client: PGlite }).client;

let kitchenA: KitchenRow;
let userA: AuthUserRow;

const TEST_RECIPE_NO_SERVES = {
  name: "Lemon Garlic Beans",
  ingredients: [
    { item: "white beans", amount: "2", unit: "cans" },
    { item: "garlic cloves", amount: "3" },
  ],
  steps: ["Warm the white beans with minced garlic cloves for 10 minutes."],
};

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

async function catchRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected promise to reject");
}

beforeEach(async () => {
  fakeProvider.reset();
  stubSignInEnv({
    SOUS_AI_KITCHEN_CAP_USD: "2",
    SOUS_AI_TOTAL_CAP_USD: "10",
  });
  vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
  vi.stubEnv("AI_TEXT_PROVIDER", "google");
  vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");
  resetAuthForTests();
  resetDeploymentCheckForTests(db);

  await client.exec(
    "delete from ai_usage; delete from cook_reports; delete from kitchen_queue; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec(
    "delete from kitchens where slug <> 'home'; update kitchens set ai_monthly_cap_micros = null where slug = 'home';",
  );

  const a = await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" });
  kitchenA = a.kitchen;
  userA = a.user;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

describe("allowanceSentence", () => {
  it("returns the server's sentence for a real cap refusal and matches the shared error fixture", async () => {
    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 0 })
      .where(eq(kitchens.id, kitchenA.id));

    const headersA = await signedInHeaders(userA.id, db);
    const cappedClient = createRouteTrpcClient({
      cookieHeader: headersA.get("cookie"),
      origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
    });

    const realErr = await catchRejection(
      cappedClient.addToKitchenQueue.mutate({
        recipeData: TEST_RECIPE_NO_SERVES,
      }),
    );

    expect(realErr).toBeInstanceOf(TRPCClientError);
    const trpcErr = realErr as TRPCClientError<AppRouter>;
    expect(trpcErr.data?.code).toBe("TOO_MANY_REQUESTS");
    const realAllowance = trpcErr.data?.allowance;
    expect(realAllowance).toEqual({
      scope: "kitchen",
      resetsAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/),
    });

    const resetsAt = new Date(realAllowance!.resetsAt);
    const expectedSentence = new AllowanceUsedError("kitchen", resetsAt).message;
    expect(trpcErr.message).toBe(expectedSentence);
    expect(allowanceSentence(trpcErr)).toBe(expectedSentence);

    const fixture = allowanceError("kitchen", resetsAt);
    expect(fixture.message).toBe(trpcErr.message);
    expect(fixture.data?.code).toBe(trpcErr.data?.code);
    expect(fixture.data?.allowance).toEqual(realAllowance);

    expect(fakeProvider.chatCalls).toHaveLength(0);
    expect(fakeProvider.visionCalls).toHaveLength(0);
  });

  it("returns null for a real UNAUTHORIZED refusal, plain errors, and incomplete allowance payloads", async () => {
    const signedOutClient = createRouteTrpcClient();
    const unauthorizedErr = await catchRejection(
      signedOutClient.getKitchenQueue.query({}),
    );
    expect(unauthorizedErr).toBeInstanceOf(TRPCClientError);
    expect((unauthorizedErr as TRPCClientError<AppRouter>).data?.code).toBe(
      "UNAUTHORIZED",
    );
    expect(allowanceSentence(unauthorizedErr)).toBeNull();

    expect(allowanceSentence(new Error("x"))).toBeNull();

    const missingAllowance = TRPCClientError.from<AppRouter>({
      error: {
        code: -32029,
        message: "Too many requests",
        data: {
          code: "TOO_MANY_REQUESTS",
          httpStatus: 429,
        },
      },
    });
    expect(allowanceSentence(missingAllowance)).toBeNull();

    const missingResetsAt = TRPCClientError.from<AppRouter>({
      error: {
        code: -32029,
        message: "Too many requests",
        data: {
          code: "TOO_MANY_REQUESTS",
          httpStatus: 429,
          allowance: { scope: "kitchen" },
        },
      },
    });
    expect(allowanceSentence(missingResetsAt)).toBeNull();

    const missingScope = TRPCClientError.from<AppRouter>({
      error: {
        code: -32029,
        message: "Too many requests",
        data: {
          code: "TOO_MANY_REQUESTS",
          httpStatus: 429,
          allowance: { resetsAt: "2026-12-01T00:00:00.000Z" },
        },
      },
    });
    expect(allowanceSentence(missingScope)).toBeNull();
  });
});
