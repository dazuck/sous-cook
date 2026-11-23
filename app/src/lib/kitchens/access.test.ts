import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db } from "@/lib/db";
import {
  homeKitchen,
  seedKitchen,
  seedQueueRow,
} from "@/lib/__tests__/kitchens";
import { requireOwnedQueueItem } from "@/server/kitchen-access";
import {
  createTRPCContext,
  kitchenProcedure,
  publicProcedure,
  router,
} from "@/server/trpc";

const client = (dbModule as unknown as { client: PGlite }).client;

const probeRouter = router({
  health: publicProcedure.query(() => ({ status: "ok" })),
  whoami: kitchenProcedure.query(({ ctx }) => ({
    kitchen: ctx.kitchen,
    member: ctx.member,
  })),
});

beforeEach(async () => {
  await client.exec("delete from kitchen_queue");
  await client.exec("delete from kitchens where slug <> 'home'");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Kitchen access context (single-kitchen mode)", () => {
  it("CTX-3: single-kitchen mode with no cookie gives the home kitchen and a null member", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "off");
    const home = await homeKitchen(db);

    const req = new Request("http://localhost:3000/api/trpc/whoami", {
      method: "GET",
    });
    const ctx = await createTRPCContext({ req });
    const caller = probeRouter.createCaller(ctx);

    const result = await caller.whoami();
    expect(result).toEqual({
      kitchen: { id: home.id, slug: "home" },
      member: null,
    });
  });

  it("refuses kitchenProcedure when SOUS_SIGN_IN is not set to off", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "");

    const ctx = await createTRPCContext({
      req: new Request("http://localhost:3000/api/trpc/whoami"),
    });
    const caller = probeRouter.createCaller(ctx);

    await expect(caller.whoami()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.stringContaining("SOUS_SIGN_IN=off"),
    });

    // Public procedures still work without SOUS_SIGN_IN=off.
    await expect(caller.health()).resolves.toEqual({ status: "ok" });
  });

  it("refuses in single-kitchen mode when the home kitchen is missing", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "off");
    const home = await homeKitchen(db);
    await client.exec("delete from kitchens where slug = 'home'");

    try {
      const ctx = await createTRPCContext({
        req: new Request("http://localhost:3000/api/trpc/whoami"),
      });
      const caller = probeRouter.createCaller(ctx);

      await expect(caller.whoami()).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: expect.stringContaining("db:migrate"),
      });
    } finally {
      await client.query(
        `insert into kitchens (id, slug, name) values ($1, 'home', 'Home')`,
        [home.id],
      );
    }
  });

  it("requireOwnedQueueItem returns the kitchen's own row and throws NOT_FOUND for missing or other kitchens' ids", async () => {
    const home = await homeKitchen(db);
    const { kitchen: other } = await seedKitchen(db, {
      slug: "other-kitchen",
      name: "Other Kitchen",
    });
    const homeRow = await seedQueueRow(db, home.id, {
      recipeData: { name: "Home Soup" },
    });
    const otherRow = await seedQueueRow(db, other.id, {
      recipeData: { name: "Other Stew" },
    });

    const found = await requireOwnedQueueItem(home.id, homeRow.id);
    expect(found.id).toBe(homeRow.id);

    const missingErr = await requireOwnedQueueItem(
      home.id,
      "00000000-0000-4000-8000-000000000000",
    ).catch((e: unknown) => e);
    const foreignErr = await requireOwnedQueueItem(home.id, otherRow.id).catch(
      (e: unknown) => e,
    );

    expect(missingErr).toBeInstanceOf(TRPCError);
    expect(foreignErr).toBeInstanceOf(TRPCError);
    expect((missingErr as TRPCError).code).toBe("NOT_FOUND");
    expect((foreignErr as TRPCError).code).toBe("NOT_FOUND");
    expect((foreignErr as TRPCError).message).toBe(
      (missingErr as TRPCError).message,
    );
  });
});
