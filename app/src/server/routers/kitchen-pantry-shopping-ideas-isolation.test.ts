/**
 * Real-DB two-kitchen isolation tests for Package 5 (pantry, shopping list,
 * ideas) through the tRPC router without mocking hooks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../../lib/__tests__/test-db")).mockDbModule(),
);

import { eq } from "drizzle-orm";
import * as dbModule from "@/lib/db";
import { db, invites } from "@/lib/db";
import {
  callerFor,
  seedKitchen,
  type KitchenRow,
} from "@/lib/__tests__/kitchens";
import { createTestAuth, signedInHeaders, stubSignInEnv } from "@/lib/__tests__/test-auth";
import { resetAuthForTests } from "@/lib/auth/auth";
import { resetDeploymentCheckForTests } from "@/lib/kitchens/deployment";
import { createTRPCContext } from "../trpc";
import { appRouter } from "./_app";

const client = (dbModule as unknown as { client: PGlite }).client;

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;
let callerA: ReturnType<typeof callerFor>;
let callerB: ReturnType<typeof callerFor>;

beforeEach(async () => {
  stubSignInEnv();
  resetAuthForTests();
  resetDeploymentCheckForTests(db);

  await client.exec(
    "delete from kitchen_pantry_items; delete from kitchen_pantry_sections; delete from kitchen_shopping_list; delete from kitchen_ideas; delete from recipe_ideas_cache; delete from kitchen_queue; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchenA = (await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" })).kitchen;
  kitchenB = (await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" })).kitchen;
  callerA = callerFor(kitchenA);
  callerB = callerFor(kitchenB);
});

afterEach(() => {
  resetAuthForTests();
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

describe("Package 5 two-kitchen isolation through tRPC", () => {
  it("isolates pantry reads, adds, and updates between kitchens A and B", async () => {
    expect(await callerA.getPantry()).toEqual({ sections: [] });
    expect(await callerB.getPantry()).toEqual({ sections: [] });

    await callerA.addIngredientsToPantry({
      items: [
        { text: "5 lbs potatoes", section: "Pantry" },
        { text: "sour cream", section: "Fridge" },
      ],
    });

    const pantryA = await callerA.getPantry();
    expect(pantryA.sections.find((s) => s.heading === "pantry")?.items).toEqual([
      "5 lbs potatoes",
    ]);
    expect(pantryA.sections.find((s) => s.heading === "fridge")?.items).toEqual([
      "sour cream",
    ]);
    expect(await callerB.getPantry()).toEqual({ sections: [] });

    // Kitchen B applying updates to Kitchen A's item texts updates nothing in A.
    expect(
      await callerB.applyPantryReconciliation({
        actions: [
          { action: "delete", oldText: "sour cream" },
          { action: "decrement", oldText: "5 lbs potatoes", newText: "1 lb potatoes" },
        ],
      }),
    ).toEqual({ success: true, updated: 0 });

    const pantryAAfterB = await callerA.getPantry();
    expect(pantryAAfterB.sections.find((s) => s.heading === "fridge")?.items).toEqual([
      "sour cream",
    ]);
    expect(pantryAAfterB.sections.find((s) => s.heading === "pantry")?.items).toEqual([
      "5 lbs potatoes",
    ]);

    // Kitchen A updates its own pantry cleanly.
    expect(
      await callerA.applyPantryReconciliation({
        actions: [
          { action: "delete", oldText: "sour cream" },
          { action: "decrement", oldText: "5 lbs potatoes", newText: "4 lbs potatoes" },
        ],
      }),
    ).toEqual({ success: true, updated: 2 });

    const pantryAFinal = await callerA.getPantry();
    expect(pantryAFinal.sections.find((s) => s.heading === "fridge")?.items).toEqual([]);
    expect(pantryAFinal.sections.find((s) => s.heading === "pantry")?.items).toEqual([
      "4 lbs potatoes",
    ]);
  });

  it("isolates shopping list reads, adds, removes, and clears between kitchens A and B", async () => {
    await callerA.addShoppingListItems({
      items: [
        { item: "Lemons (2)", forRecipe: "Tuesday beans" },
        { item: "Whole milk" },
      ],
    });
    await callerB.addShoppingListItems({
      items: [{ item: "Oat milk" }],
    });

    const listA = await callerA.getShoppingList();
    expect(listA.items.map((i) => i.raw)).toEqual([
      "Lemons (2) — Tuesday beans",
      "Whole milk",
    ]);
    const listB = await callerB.getShoppingList();
    expect(listB.items.map((i) => i.raw)).toEqual(["Oat milk"]);

    // Kitchen B cannot remove or clear Kitchen A's items.
    expect(await callerB.removeShoppingListItem({ rawOrKey: "lemons" })).toEqual({
      removed: false,
    });
    expect(await callerB.clearShoppingList()).toEqual({ cleared: 1 });
    expect((await callerB.getShoppingList()).items).toEqual([]);
    expect((await callerA.getShoppingList()).items.map((i) => i.raw)).toEqual([
      "Lemons (2) — Tuesday beans",
      "Whole milk",
    ]);
  });

  it("isolates saved ideas between kitchens A and B", async () => {
    expect((await callerA.getRecipeIdeas()).ideas).toEqual([]);
    expect((await callerB.getRecipeIdeas()).ideas).toEqual([]);

    await callerA.saveRecipeIdea({
      text: "Weeknight Pea Soup — https://example.com/pea-soup",
    });
    await callerB.saveRecipeIdea({
      text: "Herb Omelette",
    });

    const ideasA = await callerA.getRecipeIdeas();
    expect(ideasA.ideas).toEqual([
      "Weeknight Pea Soup — https://example.com/pea-soup",
    ]);
    expect(ideasA.stale).toBe(false);

    const ideasB = await callerB.getRecipeIdeas();
    expect(ideasB.ideas).toEqual(["Herb Omelette"]);
    expect(ideasB.stale).toBe(false);
  });

  it("refuses uninvited signed-in users with FORBIDDEN across all Package 5 calls", async () => {
    await db.insert(invites).values({
      email: "outsider@example.com",
      newKitchenName: "Temp Kitchen",
      newKitchenSlug: "temp-kitchen",
      role: "owner",
    });
    const testAuth = createTestAuth(db);
    const authCtx = await testAuth.$context;
    const user = await authCtx.test.saveUser(
      authCtx.test.createUser({
        email: "outsider@example.com",
        name: "Outsider",
        emailVerified: true,
      }),
    );
    const headers = await signedInHeaders(user.id, db);
    await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.email, "outsider@example.com"));
    const outsiderCaller = appRouter.createCaller(
      await createTRPCContext({
        req: new Request("https://app.example.com/api/trpc/getPantry", {
          headers,
        }),
      }),
    );

    await expect(outsiderCaller.getPantry()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      outsiderCaller.addIngredientsToPantry({ items: [{ text: "Salt" }] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(outsiderCaller.getShoppingList()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      outsiderCaller.addShoppingListItems({ items: [{ item: "Salt" }] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(outsiderCaller.getRecipeIdeas()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      outsiderCaller.saveRecipeIdea({ text: "Soup" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
