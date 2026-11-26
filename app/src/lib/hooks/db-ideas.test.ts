import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db, recipeIdeasCache } from "@/lib/db";
import { seedKitchen, type KitchenRow } from "@/lib/__tests__/kitchens";
import { createDbIdeasStore } from "./db-ideas";

const client = (dbModule as unknown as { client: PGlite }).client;

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;

beforeEach(async () => {
  await client.exec(
    "delete from kitchen_ideas; delete from recipe_ideas_cache; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchenA = (await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" })).kitchen;
  kitchenB = (await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" })).kitchen;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("db-ideas", () => {
  it("returns empty string when empty, appends trimmed lines in order, allows duplicate lines, isolates kitchens, and never writes recipe_ideas_cache", async () => {
    const storeA = createDbIdeasStore(kitchenA.id);
    const storeB = createDbIdeasStore(kitchenB.id);

    expect(await storeA.readText()).toBe("");
    await expect(storeA.append("   ")).rejects.toThrow(/empty/i);

    await storeA.append("  Weeknight Pea Soup — https://example.com/pea-soup  ");
    await storeA.append("Quick Cucumber Salad");
    await storeA.append("Quick Cucumber Salad");

    await storeB.append("Kitchen B Pasta");

    expect(await storeA.readText()).toBe(
      "Weeknight Pea Soup — https://example.com/pea-soup\nQuick Cucumber Salad\nQuick Cucumber Salad",
    );
    expect(await storeB.readText()).toBe("Kitchen B Pasta");

    // append() must never write recipe_ideas_cache.
    expect(await db.select().from(recipeIdeasCache)).toEqual([]);
  });
});
