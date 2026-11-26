import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db, kitchenShoppingList } from "@/lib/db";
import { seedKitchen, type KitchenRow } from "@/lib/__tests__/kitchens";
import { createDbShoppingListStore } from "./db-shopping-list";

const client = (dbModule as unknown as { client: PGlite }).client;

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;

beforeEach(async () => {
  await client.exec(
    "delete from kitchen_shopping_list; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchenA = (await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" })).kitchen;
  kitchenB = (await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" })).kitchen;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("db-shopping-list", () => {
  it("returns empty list when empty, adds deduplicated items by shopItemKey, and isolates kitchens", async () => {
    const storeA = createDbShoppingListStore(kitchenA.id);
    const storeB = createDbShoppingListStore(kitchenB.id);

    const empty = await storeA.list();
    expect(empty.items).toEqual([]);
    expect(empty.syncedAt).toBeInstanceOf(Date);

    expect(await storeA.add([])).toEqual({ added: [] });

    const first = await storeA.add([
      { item: "Lemons (2)", forRecipe: "Tuesday beans" },
      { item: "lemons", forRecipe: "Soup" }, // same key inside same call -> skipped
      { item: "Paper towels" },
      { item: "(2)" }, // empty shopItemKey -> skipped
    ]);
    expect(first).toEqual({
      added: ["Lemons (2) — Tuesday beans", "Paper towels"],
    });

    // Adding a duplicate against stored rows adds nothing.
    expect(await storeA.add([{ item: "LEMONS, organic" }])).toEqual({ added: [] });

    // Kitchen B is still empty, and can add its own lemons.
    expect((await storeB.list()).items).toEqual([]);
    expect(await storeB.add([{ item: "Lemons (1)", forRecipe: "B tart" }])).toEqual({
      added: ["Lemons (1) — B tart"],
    });

    const listA = await storeA.list();
    expect(listA.items.map((i) => ({ raw: i.raw, aisle: i.aisle, forRecipe: i.forRecipe }))).toEqual([
      { raw: "Lemons (2) — Tuesday beans", aisle: "Produce", forRecipe: "Tuesday beans" },
      { raw: "Paper towels", aisle: "Other", forRecipe: null },
    ]);
  });

  it("removes by exact raw line or shopItemKey, skips blank lines, and clears only its own kitchen", async () => {
    const storeA = createDbShoppingListStore(kitchenA.id);
    const storeB = createDbShoppingListStore(kitchenB.id);

    await storeA.add([
      { item: "Lemons (2)", forRecipe: "Tuesday beans" },
      { item: "Whole milk" },
    ]);
    await db.insert(kitchenShoppingList).values({
      kitchenId: kitchenA.id,
      line: "   ",
    });
    await storeB.add([{ item: "Whole milk" }]);

    expect((await storeA.list()).items.map((i) => i.raw)).toEqual([
      "Lemons (2) — Tuesday beans",
      "Whole milk",
    ]);

    // Remove by key matches "Lemons (2) — Tuesday beans"
    expect(await storeA.remove("lemons")).toEqual({ removed: true });
    expect(await storeA.remove("lemons")).toEqual({ removed: false });

    // Remove by exact raw line
    expect(await storeA.remove("whole milk")).toEqual({ removed: true });
    expect((await storeA.list()).items).toEqual([]);

    // Re-add and test clear() (deletes the 2 added items plus the 1 blank row)
    await storeA.add([{ item: "Olive oil" }, { item: "Garlic" }]);
    expect(await storeA.clear()).toEqual({ cleared: 3 });
    expect(await storeA.clear()).toEqual({ cleared: 0 });
    expect((await storeA.list()).items).toEqual([]);

    // Kitchen B's item is untouched.
    expect((await storeB.list()).items.map((i) => i.raw)).toEqual(["Whole milk"]);
  });
});
