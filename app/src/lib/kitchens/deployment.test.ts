import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { connected } from "@/lib/hooks/connected";
import { HOOK_NAMES } from "@/lib/hooks/types";
import { GET as authGet } from "@/app/api/auth/[...all]/route";
import { GET as packsGet } from "@/app/api/packs/route";
import { register } from "@/instrumentation";
import { resetAuthForTests } from "@/lib/auth/auth";
import {
  DeploymentConfigError,
  REQUIRED_SIGN_IN_ENV_VARS,
  checkDeploymentEnv,
  getDeploymentMode,
  resetDeploymentCheckForTests,
} from "./deployment";
import { homeKitchen, mintToken } from "@/lib/__tests__/kitchens";
import { TEST_AUTH_ENV } from "@/lib/__tests__/test-auth";
import { httpCall } from "@/lib/__tests__/trpc-http";

const client = (dbModule as unknown as { client: PGlite }).client;

beforeEach(async () => {
  for (const name of HOOK_NAMES) {
    connected[name] = false;
  }
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  await client.exec(
    "delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");
});

afterEach(() => {
  for (const name of HOOK_NAMES) {
    connected[name] = false;
  }
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Deployment modes and start-up checks", () => {
  it("MODE-1: resolves SOUS_SIGN_IN=off as single-kitchen, unset or on as sign-in, and refuses unknown values", () => {
    expect(getDeploymentMode({ SOUS_SIGN_IN: "off" })).toBe("single-kitchen");
    expect(getDeploymentMode({})).toBe("sign-in");
    expect(getDeploymentMode({ SOUS_SIGN_IN: "on" })).toBe("sign-in");

    expect(() => getDeploymentMode({ SOUS_SIGN_IN: "yes" })).toThrow(
      DeploymentConfigError,
    );
    expect(() => getDeploymentMode({ SOUS_SIGN_IN: "yes" })).toThrow(
      /SOUS_SIGN_IN.*"yes"/,
    );
  });

  it("MODE-2: single-kitchen mode refuses extra kitchens, members, invites, or a missing home kitchen with tRPC INTERNAL_SERVER_ERROR and webhook 500", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "off");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const home = await homeKitchen(db);
    const token = await mintToken(db, home.id, "home-agent");

    async function assertBothRefuse(expectedPattern: RegExp) {
      resetDeploymentCheckForTests(db);
      const trpcRes = await httpCall<{
        error: { message: string; data: { code: string } };
      }>("getKitchenQueue", { status: "pending" }, { method: "GET" });
      expect(trpcRes.status).toBe(500);
      expect(trpcRes.body.error.data.code).toBe("INTERNAL_SERVER_ERROR");
      expect(trpcRes.body.error.message).toMatch(expectedPattern);

      const whRes = await packsGet(
        new Request("http://localhost:3000/api/packs", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(whRes.status).toBe(500);
      const whBody = (await whRes.json()) as { error: string };
      expect(whBody.error).toMatch(expectedPattern);
    }

    // 1. Extra kitchen other than home: caller sees the error without slugs;
    // server logs include the found slugs once.
    await db.insert(kitchens).values({ slug: "extra", name: "Extra Kitchen" });
    resetDeploymentCheckForTests(db);
    const extraTrpcRes = await httpCall<{
      error: { message: string; data: { code: string } };
    }>("getKitchenQueue", { status: "pending" }, { method: "GET" });
    expect(extraTrpcRes.status).toBe(500);
    expect(extraTrpcRes.body.error.data.code).toBe("INTERNAL_SERVER_ERROR");
    expect(extraTrpcRes.body.error.message).toMatch(/other than "home"/i);
    expect(extraTrpcRes.body.error.message).not.toContain("extra");

    const extraWhRes = await packsGet(
      new Request("http://localhost:3000/api/packs", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(extraWhRes.status).toBe(500);
    const extraWhBody = (await extraWhRes.json()) as { error: string };
    expect(extraWhBody.error).toMatch(/other than "home"/i);
    expect(extraWhBody.error).not.toContain("extra");

    const extraLogs = errSpy.mock.calls.filter((call) =>
      String(call[0]).includes("found: extra"),
    );
    expect(extraLogs).toHaveLength(1);
    await client.exec("delete from kitchens where slug <> 'home'");

    // 2. Member row present.
    await db.insert(authUser).values({
      id: "u-single",
      name: "Single",
      email: "single@example.com",
      emailVerified: true,
    });
    await db.insert(members).values({
      kitchenId: home.id,
      userId: "u-single",
      role: "owner",
    });
    await assertBothRefuse(/members/i);
    await client.exec("delete from members; delete from auth_user;");

    // 3. Invite row present.
    await db.insert(invites).values({
      email: "invited@example.com",
      kitchenId: home.id,
      role: "cook",
    });
    await assertBothRefuse(/invites/i);
    await client.exec("delete from invites;");

    // 4. Missing home kitchen (e.g. database built with db:push).
    await client.exec(
      "delete from kitchen_webhook_tokens; delete from kitchens where slug = 'home';",
    );
    try {
      await assertBothRefuse(/db:migrate/);
    } finally {
      await client.query(
        `insert into kitchens (id, slug, name) values ($1, 'home', 'Home')`,
        [home.id],
      );
    }

    // Distinct failure messages were logged once each.
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("MODE-3: sign-in mode refuses when any required variable is missing, naming each and mentioning SOUS_SIGN_IN=off", () => {
    const emptyEnv: Record<string, string | undefined> = { SOUS_SIGN_IN: "on" };
    let caught: unknown;
    try {
      checkDeploymentEnv(emptyEnv);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DeploymentConfigError);
    const allMsg = (caught as Error).message;
    for (const varName of REQUIRED_SIGN_IN_ENV_VARS) {
      expect(allMsg).toContain(varName);
    }
    expect(allMsg).toContain("SOUS_SIGN_IN=off");

    // Missing any single variable also refuses and names it.
    for (const missingVar of REQUIRED_SIGN_IN_ENV_VARS) {
      const partial: Record<string, string | undefined> = { ...TEST_AUTH_ENV };
      delete partial[missingVar];
      expect(() => checkDeploymentEnv(partial)).toThrow(
        new RegExp(`${missingVar}[\\s\\S]*SOUS_SIGN_IN=off`),
      );
    }

    // With all required variables set and hooks off, check passes.
    expect(checkDeploymentEnv({ ...TEST_AUTH_ENV })).toBe("sign-in");
  });

  it("MODE-4: sign-in mode refuses when any hook is connected, naming the hook", () => {
    for (const hookName of HOOK_NAMES) {
      for (const n of HOOK_NAMES) connected[n] = false;
      connected[hookName] = true;

      expect(() => checkDeploymentEnv({ ...TEST_AUTH_ENV })).toThrow(
        DeploymentConfigError,
      );
      expect(() => checkDeploymentEnv({ ...TEST_AUTH_ENV })).toThrow(
        new RegExp(hookName),
      );
    }
  });

  it("MODE-5: route modules and instrumentation load cleanly with an empty environment; register runs checks only in nodejs runtime", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "");
    for (const varName of REQUIRED_SIGN_IN_ENV_VARS) {
      vi.stubEnv(varName, "");
    }
    vi.stubEnv("NEXT_RUNTIME", "");

    // Importing the auth and tRPC route handlers with empty env does not throw.
    const authRoute = await import("@/app/api/auth/[...all]/route");
    const trpcRoute = await import("@/app/api/trpc/[trpc]/route");
    expect(typeof authRoute.GET).toBe("function");
    expect(typeof authRoute.POST).toBe("function");
    expect(typeof trpcRoute.GET).toBe("function");
    expect(typeof trpcRoute.POST).toBe("function");

    // register() is a no-op outside the nodejs runtime (e.g. build/edge).
    await expect(register()).resolves.toBeUndefined();

    // register() is also a no-op during next build even if NEXT_RUNTIME is nodejs.
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(register()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();

    // In nodejs server runtime with missing sign-in env, register() logs and exits 1.
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    await register();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/BETTER_AUTH_SECRET[\s\S]*SOUS_SIGN_IN=off/),
    );

    // In nodejs runtime with valid single-kitchen mode, register() succeeds without exiting.
    exitSpy.mockClear();
    errSpy.mockClear();
    vi.stubEnv("SOUS_SIGN_IN", "off");
    await expect(register()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("refuses BETTER_AUTH_SECRET shorter than 32 characters after trimming in sign-in mode", () => {
    for (const badSecret of [
      "a".repeat(31),
      `   ${"a".repeat(30)}   `,
    ]) {
      let caught: unknown;
      try {
        checkDeploymentEnv({
          ...TEST_AUTH_ENV,
          BETTER_AUTH_SECRET: badSecret,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DeploymentConfigError);
      expect((caught as Error).message).toMatch(/BETTER_AUTH_SECRET.*32/);
    }

    expect(
      checkDeploymentEnv({
        ...TEST_AUTH_ENV,
        BETTER_AUTH_SECRET: "a".repeat(32),
      }),
    ).toBe("sign-in");
  });

  it("requires https for BETTER_AUTH_URL unless the host is localhost, 127.0.0.1, or [::1]", () => {
    for (const badUrl of [
      "http://app.example.com",
      "http://app.example.com:3000",
      "http://localhost.example.com",
      "http://127.0.0.2:3000",
    ]) {
      let caught: unknown;
      try {
        checkDeploymentEnv({ ...TEST_AUTH_ENV, BETTER_AUTH_URL: badUrl });
      } catch (err) {
        caught = err;
      }
      expect(caught, badUrl).toBeInstanceOf(DeploymentConfigError);
      expect((caught as Error).message, badUrl).toMatch(
        /BETTER_AUTH_URL.*https/i,
      );
    }

    for (const goodUrl of [
      "https://app.example.com",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      expect(
        checkDeploymentEnv({ ...TEST_AUTH_ENV, BETTER_AUTH_URL: goodUrl }),
        goodUrl,
      ).toBe("sign-in");
    }
  });

  it("MODE-7: single-kitchen mode answers 404 on /api/auth/get-session without calling getAuth()", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "off");
    for (const varName of REQUIRED_SIGN_IN_ENV_VARS) {
      vi.stubEnv(varName, "");
    }

    const res = await authGet(
      new Request("http://localhost:3000/api/auth/get-session", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(404);
  });
});
