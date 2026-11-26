import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
import {
  db,
  docRecipes,
  kitchenCookLog,
  kitchenIdeas,
  kitchenPantryItems,
  kitchenPantrySections,
  kitchenQueue,
  kitchenShoppingList,
  kitchens,
} from "@/lib/db";
import { homeKitchen, seedKitchen, snapshotRow } from "@/lib/__tests__/kitchens";
import { stubSignInEnv } from "@/lib/__tests__/test-auth";
import { parseCommand } from "../../../scripts/kitchens";
import { KitchenAdminError } from "./admin";
import { resetDeploymentCheckForTests } from "./deployment";
import {
  exportKitchenData,
  formatExportSummary,
  formatImportSummary,
  importKitchenData,
  parseKitchenExportJson,
} from "./export-import";

const client = (dbModule as unknown as { client: PGlite }).client;

async function expectKitchenAdminError(
  fn: () => unknown | Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(KitchenAdminError);
  expect((caught as Error).message).toMatch(messagePattern);
}

beforeEach(async () => {
  stubSignInEnv();
  resetDeploymentCheckForTests(db);
  await client.exec(
    "delete from kitchen_pantry_items; delete from kitchen_pantry_sections; delete from kitchen_shopping_list; delete from kitchen_ideas; delete from kitchen_cook_log; delete from kitchen_queue; delete from doc_recipes; delete from ai_usage; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec(
    "delete from kitchens where slug <> 'home'; update kitchens set name = 'Home', about = '', ai_monthly_cap_micros = null where slug = 'home';",
  );
});

afterEach(() => {
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

describe("Kitchen export and import", () => {
  it("round-trips a kitchen through an empty kitchen byte-for-byte while making imported cook-log notes private and dishes held back", async () => {
    const { kitchen: kitchenA, member: memberA } = await seedKitchen(db, {
      slug: "alpha",
      name: "Alpha Kitchen",
    });
    const { kitchen: kitchenB } = await seedKitchen(db, {
      slug: "beta",
      name: "Beta Kitchen",
    });
    const { kitchen: kitchenC } = await seedKitchen(db, {
      slug: "gamma",
      name: "Gamma Kitchen",
    });

    await db
      .update(kitchens)
      .set({ about: "Gas range, cast iron pan, no shellfish." })
      .where(eq(kitchens.id, kitchenA.id));

    await db
      .update(kitchens)
      .set({ about: "Unrelated kitchen C context." })
      .where(eq(kitchens.id, kitchenC.id));

    const [recipe1] = await db
      .insert(docRecipes)
      .values({
        kitchenId: kitchenA.id,
        docSlug: "pancakes",
        name: "Buttermilk Pancakes",
        category: "breakfast",
        categoryTitle: "Breakfast",
        docPosition: 2,
        ingredients: [
          { item: "flour", amount: "2", unit: "cups" },
          { item: "buttermilk", amount: "2", unit: "cups" },
        ],
        steps: ["Mix dry ingredients.", "Whisk in buttermilk.", "Cook on griddle."],
        estimatedTime: { active: 15, total: 25 },
        serves: 4,
        tags: ["weekend", "sweet"],
        notes: "Rest batter 10 minutes.",
        stepIngredients: [[0], [1], []],
        rawDocText: "Buttermilk Pancakes\n2 cups flour...",
        extractionError: null,
        syncedAt: new Date("2026-11-20T10:00:00.000Z"),
        servesEstimate: null,
        servesEstimateBasis: null,
        servesEstimateSourceHash: null,
        cookPlan: {
          version: 4,
          tasks: [
            {
              id: "t1",
              kind: "mise",
              text: "Mix dry ingredients.",
              label: "mix dry",
              ingredientIdx: [0],
              sourceStep: 0,
              implied: false,
              needs: [],
              branch: "Batter",
            },
            {
              id: "t2",
              kind: "cook",
              text: "Cook on griddle.",
              label: "cook pancakes",
              ingredientIdx: [],
              sourceStep: 2,
              implied: false,
              needs: ["t1"],
              minutes: { est: 10, handsOff: false },
              cue: "until golden",
              branch: "Batter",
            },
          ],
        },
        cookPlanError: null,
        cookPlanSourceHash: "hash-pancakes",
        cookPlanStamp: "stamp-v4",
        isPrivate: false,
      })
      .returning();

    await db.insert(docRecipes).values({
      kitchenId: kitchenA.id,
      docSlug: "secret-broth",
      name: "Secret Broth",
      category: "soups",
      categoryTitle: "Soups",
      docPosition: 1,
      ingredients: [{ item: "bones", amount: "2", unit: "lb" }],
      steps: ["Simmer for 4 hours."],
      rawDocText: "Secret Broth...",
      syncedAt: new Date("2026-11-20T09:00:00.000Z"),
      servesEstimate: 6,
      servesEstimateBasis: "2 lb bones yields about 6 bowls",
      servesEstimateSourceHash: "hash-broth",
      cookPlan: null,
      cookPlanError: "missing simmer temperature",
      cookPlanSourceHash: "plan-hash-broth",
      cookPlanStamp: "stamp-v4",
      isPrivate: true,
    });

    // Unrelated recipe in kitchen C that must never leak into A or B.
    const [recipeC] = await db
      .insert(docRecipes)
      .values({
        kitchenId: kitchenC.id,
        docSlug: "gamma-soup",
        name: "Gamma Soup",
        rawDocText: "Gamma Soup...",
        syncedAt: new Date("2026-11-20T08:00:00.000Z"),
      })
      .returning();

    const [queue1] = await db
      .insert(kitchenQueue)
      .values({
        kitchenId: kitchenA.id,
        recipeNotionId: null,
        recipeData: {
          name: "Buttermilk Pancakes",
          ingredients: [{ item: "flour", amount: "2", unit: "cups" }],
          steps: ["Mix and cook."],
          estimatedTime: { total: 20, active: 15 },
          serves: 4,
          stepIngredients: [[0]],
          source: "https://example.com/pancakes",
        },
        targetUser: "legacy-slug",
        status: "completed",
        createdAt: new Date("2026-11-21T13:00:00.000Z"),
        startedAt: new Date("2026-11-21T13:15:00.000Z"),
        completedAt: new Date("2026-11-21T13:45:00.000Z"),
        cookLog: {
          row: 1,
          timestamp: "2026-11-21 08:45",
          recipeName: "Buttermilk Pancakes",
          adopted: false,
        },
        cookLogClaimedAt: new Date("2026-11-21T13:45:05.000Z"),
        ratingClosedAt: new Date("2026-11-21T13:46:00.000Z"),
        finishedBy: "pressed",
        isPrivate: true,
        completedByMemberId: memberA.id,
      })
      .returning();

    await db.insert(kitchenQueue).values({
      kitchenId: kitchenA.id,
      recipeNotionId: "notion-dal-1",
      recipeData: {
        name: "Weeknight Dal",
        ingredients: [{ item: "red lentils", amount: "1", unit: "cup" }],
        steps: ["Simmer lentils."],
      },
      status: "pending",
      createdAt: new Date("2026-11-22T18:00:00.000Z"),
      intakeRecipe: {
        name: "Weeknight Dal",
        ingredients: [{ item: "red lentils", amount: "1", unit: "cup" }],
        steps: ["Rinse and simmer lentils."],
      },
      intakeSourceHash: "intake-hash-1",
      intakeStamp: "intake-stamp-1",
      intakeAttempts: 1,
      intakeNudges: ["missing salt amount"],
      isPrivate: false,
    });

    await db.insert(kitchenCookLog).values([
      {
        kitchenId: kitchenA.id,
        queueId: queue1!.id,
        docRecipeId: recipe1!.id,
        packSource: null,
        recipeSnapshot: null,
        recipeTitle: "Buttermilk Pancakes",
        timestampText: "2026-11-21 08:45",
        cookedDay: "2026-11-21",
        cookedAt: new Date("2026-11-21T13:45:00.000Z"),
        cookedByMemberId: memberA.id,
        rating: 5,
        notes: "Extra crispy edges this morning.",
        notePrivate: false,
        noteUpdatedAt: new Date("2026-11-21T13:46:00.000Z"),
        heldBack: false,
        visibilityChosen: false,
      },
      {
        kitchenId: kitchenA.id,
        queueId: null,
        docRecipeId: null,
        packSource: "fannie-farmer-1896/waffles",
        recipeSnapshot: {
          name: "Waffles",
          ingredients: [{ item: "flour", amount: "2", unit: "cups" }],
          steps: ["Bake in waffle iron."],
        },
        recipeTitle: "Waffles",
        timestampText: "2026-11-22 09:00",
        cookedDay: "2026-11-22",
        cookedAt: new Date("2026-11-22T14:00:00.000Z"),
        cookedByMemberId: memberA.id,
        rating: 4,
        notes: "",
        notePrivate: false,
        noteUpdatedAt: null,
        heldBack: false,
        visibilityChosen: true,
      },
    ]);

    const [secFridgeA, secSetupA] = await db
      .insert(kitchenPantrySections)
      .values([
        { kitchenId: kitchenA.id, rawHeading: "Fridge" },
        { kitchenId: kitchenA.id, rawHeading: "Our setup" },
      ])
      .returning();
    await db.insert(kitchenPantryItems).values([
      { kitchenId: kitchenA.id, sectionId: secFridgeA!.id, text: "2 avocados" },
      { kitchenId: kitchenA.id, sectionId: secFridgeA!.id, text: "oat milk" },
      { kitchenId: kitchenA.id, sectionId: secSetupA!.id, text: "cast iron skillet" },
    ]);

    // Unrelated pantry section in kitchen C must not leak.
    const [secC] = await db
      .insert(kitchenPantrySections)
      .values({ kitchenId: kitchenC.id, rawHeading: "Gamma Fridge" })
      .returning();
    await db.insert(kitchenPantryItems).values({
      kitchenId: kitchenC.id,
      sectionId: secC!.id,
      text: "gamma cheese",
    });

    await db.insert(kitchenShoppingList).values([
      { kitchenId: kitchenA.id, line: "Lemons (2) — Tuesday beans" },
      { kitchenId: kitchenA.id, line: "Whole milk" },
    ]);
    await db.insert(kitchenShoppingList).values({
      kitchenId: kitchenC.id,
      line: "Gamma butter",
    });

    await db.insert(kitchenIdeas).values([
      { kitchenId: kitchenA.id, line: "Weeknight Pea Soup — https://example.com/pea-soup" },
      { kitchenId: kitchenA.id, line: "Herb Omelette" },
    ]);
    await db.insert(kitchenIdeas).values({
      kitchenId: kitchenC.id,
      line: "Gamma Tart",
    });

    const exportedA = await exportKitchenData({ kitchenSlug: "alpha" }, db);
    expect(exportedA.counts).toEqual({
      about: true,
      recipes: 2,
      queue: 2,
      cookLog: 2,
      pantry: 3,
      shoppingList: 2,
      ideas: 2,
    });
    // Sensitive / local-only fields must never appear in exported JSON.
    expect(exportedA.json).not.toContain(kitchenA.id);
    expect(exportedA.json).not.toContain(memberA.id);
    expect(exportedA.json).not.toContain("Gamma Soup");
    expect(exportedA.json).not.toContain("gamma cheese");
    expect(exportedA.json).not.toContain("Gamma butter");
    expect(exportedA.json).not.toContain("Gamma Tart");
    expect(exportedA.json).not.toContain("notePrivate");
    expect(exportedA.json).not.toContain("heldBack");
    expect(exportedA.json).not.toContain("visibilityChosen");
    expect(exportedA.json).not.toContain("exportedAt");
    expect(exportedA.json).not.toContain("legacy-slug");

    // Recipes sorted by docPosition asc (secret-broth: 1 before pancakes: 2).
    expect(exportedA.data.recipes.map((r) => r.docSlug)).toEqual([
      "secret-broth",
      "pancakes",
    ]);

    const importRes = await importKitchenData(
      { kitchenSlug: "beta", data: exportedA.json },
      db,
    );
    expect(importRes).toEqual({
      kitchenSlug: "beta",
      dryRun: false,
      about: { included: true, updated: true },
      recipes: { total: 2, inserted: 2, skipped: 0 },
      queue: { total: 2, inserted: 2, skipped: 0 },
      cookLog: { total: 2, inserted: 2, skipped: 0 },
      pantry: { total: 3, inserted: 3, skipped: 0, sectionsInserted: 2 },
      shoppingList: { total: 2, inserted: 2, skipped: 0 },
      ideas: { total: 2, inserted: 2, skipped: 0 },
    });

    // Verify B's DB state: notes arrived private, dishes arrived held back, member refs cleared.
    const [betaRow] = await db
      .select()
      .from(kitchens)
      .where(eq(kitchens.id, kitchenB.id));
    expect(betaRow?.about).toBe("Gas range, cast iron pan, no shellfish.");

    const betaRecipes = await db
      .select()
      .from(docRecipes)
      .where(eq(docRecipes.kitchenId, kitchenB.id));
    expect(betaRecipes).toHaveLength(2);
    const betaPancakes = betaRecipes.find((r) => r.docSlug === "pancakes");
    expect(betaPancakes).toBeDefined();
    expect(betaPancakes?.id).not.toBe(recipe1!.id);

    const betaQueue = await db
      .select()
      .from(kitchenQueue)
      .where(eq(kitchenQueue.kitchenId, kitchenB.id));
    expect(betaQueue).toHaveLength(2);
    for (const q of betaQueue) {
      expect(q.completedByMemberId).toBeNull();
      expect(q.targetUser).toBeNull();
      expect(q.cookLogClaimedAt).toBeNull();
    }

    const betaCookLog = await db
      .select()
      .from(kitchenCookLog)
      .where(eq(kitchenCookLog.kitchenId, kitchenB.id));
    expect(betaCookLog).toHaveLength(2);
    for (const entry of betaCookLog) {
      expect(entry.notePrivate).toBe(true);
      expect(entry.heldBack).toBe(true);
      expect(entry.visibilityChosen).toBe(true);
      expect(entry.cookedByMemberId).toBeNull();
      expect(entry.queueId).toBeNull();
    }
    const betaPancakesLog = betaCookLog.find(
      (e) => e.recipeTitle === "Buttermilk Pancakes",
    );
    expect(betaPancakesLog?.docRecipeId).toBe(betaPancakes!.id);
    expect(betaPancakesLog?.notes).toBe("Extra crispy edges this morning.");
    expect(betaPancakesLog?.rating).toBe(5);

    // Export B and verify byte-for-byte identical JSON to A!
    const exportedB = await exportKitchenData({ kitchenSlug: "beta" }, db);
    expect(exportedB.json).toBe(exportedA.json);

    // Kitchen A and C were completely untouched.
    expect(await snapshotRow(db, kitchens, kitchenC.id)).toMatchObject({
      about: "Unrelated kitchen C context.",
    });
    expect(await snapshotRow(db, docRecipes, recipeC!.id)).not.toBeNull();
  });

  it("is idempotent when run twice without creating duplicates", async () => {
    const { kitchen: kitchenA } = await seedKitchen(db, {
      slug: "alpha",
      name: "Alpha",
    });
    const { kitchen: kitchenB } = await seedKitchen(db, {
      slug: "beta",
      name: "Beta",
    });

    await db
      .update(kitchens)
      .set({ about: "Wood-fired oven." })
      .where(eq(kitchens.id, kitchenA.id));

    const [recipe] = await db
      .insert(docRecipes)
      .values({
        kitchenId: kitchenA.id,
        docSlug: "pizza",
        name: "Pizza Dough",
        rawDocText: "Flour, water, yeast, salt.",
        syncedAt: new Date("2026-11-20T12:00:00.000Z"),
      })
      .returning();

    await db.insert(kitchenQueue).values({
      kitchenId: kitchenA.id,
      recipeData: { name: "Pizza Dough", steps: ["Knead and proof."] },
      status: "completed",
      createdAt: new Date("2026-11-20T15:00:00.000Z"),
    });

    await db.insert(kitchenCookLog).values({
      kitchenId: kitchenA.id,
      docRecipeId: recipe!.id,
      recipeTitle: "Pizza Dough",
      timestampText: "2026-11-20 18:00",
      cookedDay: "2026-11-20",
      cookedAt: new Date("2026-11-20T23:00:00.000Z"),
      rating: 5,
      notes: "Great blister.",
    });

    const [pantrySec] = await db
      .insert(kitchenPantrySections)
      .values({ kitchenId: kitchenA.id, rawHeading: "Fridge" })
      .returning();
    await db.insert(kitchenPantryItems).values([
      { kitchenId: kitchenA.id, sectionId: pantrySec!.id, text: "yeast" },
      { kitchenId: kitchenA.id, sectionId: pantrySec!.id, text: "mozzarella" },
    ]);
    await db.insert(kitchenShoppingList).values([
      { kitchenId: kitchenA.id, line: "Basil — Pizza night" },
    ]);
    await db.insert(kitchenIdeas).values([
      { kitchenId: kitchenA.id, line: "Focaccia" },
    ]);

    const exported = await exportKitchenData({ kitchenSlug: "alpha" }, db);

    const first = await importKitchenData(
      { kitchenSlug: "beta", data: exported.json },
      db,
    );
    expect(first.recipes).toEqual({ total: 1, inserted: 1, skipped: 0 });
    expect(first.queue).toEqual({ total: 1, inserted: 1, skipped: 0 });
    expect(first.cookLog).toEqual({ total: 1, inserted: 1, skipped: 0 });
    expect(first.pantry).toEqual({
      total: 2,
      inserted: 2,
      skipped: 0,
      sectionsInserted: 1,
    });
    expect(first.shoppingList).toEqual({ total: 1, inserted: 1, skipped: 0 });
    expect(first.ideas).toEqual({ total: 1, inserted: 1, skipped: 0 });
    expect(first.about).toEqual({ included: true, updated: true });

    const second = await importKitchenData(
      { kitchenSlug: "beta", data: exported.json },
      db,
    );
    expect(second.recipes).toEqual({ total: 1, inserted: 0, skipped: 1 });
    expect(second.queue).toEqual({ total: 1, inserted: 0, skipped: 1 });
    expect(second.cookLog).toEqual({ total: 1, inserted: 0, skipped: 1 });
    expect(second.pantry).toEqual({
      total: 2,
      inserted: 0,
      skipped: 2,
      sectionsInserted: 0,
    });
    expect(second.shoppingList).toEqual({ total: 1, inserted: 0, skipped: 1 });
    expect(second.ideas).toEqual({ total: 1, inserted: 0, skipped: 1 });
    expect(second.about).toEqual({ included: true, updated: false });

    expect(
      await db
        .select()
        .from(docRecipes)
        .where(eq(docRecipes.kitchenId, kitchenB.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(kitchenQueue)
        .where(eq(kitchenQueue.kitchenId, kitchenB.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(kitchenCookLog)
        .where(eq(kitchenCookLog.kitchenId, kitchenB.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(kitchenPantryItems)
        .where(eq(kitchenPantryItems.kitchenId, kitchenB.id)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(kitchenShoppingList)
        .where(eq(kitchenShoppingList.kitchenId, kitchenB.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(kitchenIdeas)
        .where(eq(kitchenIdeas.kitchenId, kitchenB.id)),
    ).toHaveLength(1);
  });

  it("supports --dry-run by printing accurate counts and writing nothing", async () => {
    const { kitchen: kitchenB } = await seedKitchen(db, {
      slug: "beta",
      name: "Beta",
    });

    await db.insert(docRecipes).values({
      kitchenId: kitchenB.id,
      docSlug: "existing-toast",
      name: "Toast",
      rawDocText: "Bread.",
      syncedAt: new Date("2026-11-19T00:00:00.000Z"),
    });
    const [existingFridgeB] = await db
      .insert(kitchenPantrySections)
      .values({ kitchenId: kitchenB.id, rawHeading: "Fridge" })
      .returning();
    await db.insert(kitchenPantryItems).values({
      kitchenId: kitchenB.id,
      sectionId: existingFridgeB!.id,
      text: "butter",
    });
    await db.insert(kitchenShoppingList).values({
      kitchenId: kitchenB.id,
      line: "Lemons (2) — Tuesday beans",
    });
    await db.insert(kitchenIdeas).values({
      kitchenId: kitchenB.id,
      line: "Existing Idea",
    });

    const payload = JSON.stringify({
      format: 1,
      about: "Updated about text.",
      recipes: [
        {
          docSlug: "existing-toast",
          name: "Toast",
          rawDocText: "Bread.",
          syncedAt: "2026-11-19T00:00:00.000Z",
        },
        {
          docSlug: "new-oats",
          name: "Oatmeal",
          rawDocText: "Oats and water.",
          syncedAt: "2026-11-20T00:00:00.000Z",
        },
      ],
      queue: [
        {
          status: "pending",
          createdAt: "2026-11-21T10:00:00.000Z",
          recipeData: { name: "Oatmeal", steps: ["Simmer oats."] },
        },
      ],
      cookLog: [
        {
          recipeTitle: "Toast",
          timestampText: "2026-11-20 08:00",
          cookedDay: "2026-11-20",
          cookedAt: "2026-11-20T13:00:00.000Z",
          rating: 4,
          notes: "Crunchy.",
        },
      ],
      pantry: [
        { rawHeading: "Fridge", items: ["butter", "oat milk"] },
        { rawHeading: "Freezer", items: ["frozen peas"] },
      ],
      shoppingList: ["lemons", "Oats"],
      ideas: ["Existing Idea", "New Idea"],
    });

    const dryRes = await importKitchenData(
      { kitchenSlug: "beta", data: payload, dryRun: true },
      db,
    );
    expect(dryRes).toEqual({
      kitchenSlug: "beta",
      dryRun: true,
      about: { included: true, updated: true },
      recipes: { total: 2, inserted: 1, skipped: 1 },
      queue: { total: 1, inserted: 1, skipped: 0 },
      cookLog: { total: 1, inserted: 1, skipped: 0 },
      pantry: { total: 3, inserted: 2, skipped: 1, sectionsInserted: 1 },
      shoppingList: { total: 2, inserted: 1, skipped: 1 },
      ideas: { total: 2, inserted: 1, skipped: 1 },
    });
    expect(formatImportSummary(dryRes)).toContain("Dry run for kitchen \"beta\"");
    expect(formatImportSummary(dryRes)).toContain("recipes: 1 new (1 skipped)");
    expect(formatImportSummary(dryRes)).toContain("pantry: 2 new (1 skipped, 1 sections)");
    expect(formatImportSummary(dryRes)).toContain("shopping list: 1 new (1 skipped)");
    expect(formatImportSummary(dryRes)).toContain("ideas: 1 new (1 skipped)");

    // Confirm zero database changes occurred.
    const [betaRow] = await db
      .select()
      .from(kitchens)
      .where(eq(kitchens.id, kitchenB.id));
    expect(betaRow?.about).toBe("");
    expect(
      await db
        .select()
        .from(docRecipes)
        .where(eq(docRecipes.kitchenId, kitchenB.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(kitchenQueue)
        .where(eq(kitchenQueue.kitchenId, kitchenB.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(kitchenCookLog)
        .where(eq(kitchenCookLog.kitchenId, kitchenB.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(kitchenPantrySections)
        .where(eq(kitchenPantrySections.kitchenId, kitchenB.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(kitchenPantryItems)
        .where(eq(kitchenPantryItems.kitchenId, kitchenB.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(kitchenShoppingList)
        .where(eq(kitchenShoppingList.kitchenId, kitchenB.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(kitchenIdeas)
        .where(eq(kitchenIdeas.kitchenId, kitchenB.id)),
    ).toHaveLength(1);
  });

  it("allows optional sections independently without overwriting omitted sections", async () => {
    const { kitchen: kitchenB } = await seedKitchen(db, {
      slug: "beta",
      name: "Beta",
    });

    await db
      .update(kitchens)
      .set({ about: "Keep this about." })
      .where(eq(kitchens.id, kitchenB.id));

    const recipesOnly = await importKitchenData(
      {
        kitchenSlug: "beta",
        data: {
          format: 1,
          recipes: [
            {
              docSlug: "rice",
              name: "Steamed Rice",
              rawDocText: "Rinse and steam.",
            },
          ],
        },
      },
      db,
    );
    expect(recipesOnly.about).toEqual({ included: false, updated: false });
    expect(recipesOnly.recipes).toEqual({ total: 1, inserted: 1, skipped: 0 });
    expect(recipesOnly.queue).toEqual({ total: 0, inserted: 0, skipped: 0 });
    expect(recipesOnly.cookLog).toEqual({ total: 0, inserted: 0, skipped: 0 });
    expect(recipesOnly.pantry).toEqual({
      total: 0,
      inserted: 0,
      skipped: 0,
      sectionsInserted: 0,
    });
    expect(recipesOnly.shoppingList).toEqual({ total: 0, inserted: 0, skipped: 0 });
    expect(recipesOnly.ideas).toEqual({ total: 0, inserted: 0, skipped: 0 });

    const [betaRow] = await db
      .select()
      .from(kitchens)
      .where(eq(kitchens.id, kitchenB.id));
    expect(betaRow?.about).toBe("Keep this about.");
  });

  it("checks the whole file upfront, names the first fault, and writes nothing on error", async () => {
    const { kitchen: kitchenB } = await seedKitchen(db, {
      slug: "beta",
      name: "Beta",
    });

    await expectKitchenAdminError(
      () => parseKitchenExportJson("{bad json"),
      /^Invalid JSON:/,
    );
    await expectKitchenAdminError(
      () => parseKitchenExportJson("[]"),
      /^root: expected a JSON object/,
    );
    await expectKitchenAdminError(
      () => parseKitchenExportJson("{}"),
      /^format: expected integer 1/,
    );
    await expectKitchenAdminError(
      () => parseKitchenExportJson(JSON.stringify({ format: 2 })),
      /^format: unsupported export format 2 \(expected 1\)/,
    );
    await expectKitchenAdminError(
      () => parseKitchenExportJson(JSON.stringify({ format: 1, bogusSection: [] })),
      /^root\.bogusSection: unknown section "bogusSection"/,
    );
    await expectKitchenAdminError(
      () => parseKitchenExportJson(JSON.stringify({ format: 1, pantry: "nope" })),
      /^pantry: expected array/,
    );
    await expectKitchenAdminError(
      () =>
        parseKitchenExportJson(
          JSON.stringify({ format: 1, pantry: [{ rawHeading: "", items: [] }] }),
        ),
      /^pantry\[0\]\.rawHeading: expected non-empty string/,
    );
    await expectKitchenAdminError(
      () =>
        parseKitchenExportJson(
          JSON.stringify({
            format: 1,
            pantry: [
              { rawHeading: "Fridge", items: [] },
              { rawHeading: "fridge", items: [] },
            ],
          }),
        ),
      /^pantry\[1\]\.rawHeading: duplicate pantry section "fridge"/,
    );
    await expectKitchenAdminError(
      () =>
        parseKitchenExportJson(
          JSON.stringify({ format: 1, pantry: [{ rawHeading: "Fridge", items: [""] }] }),
        ),
      /^pantry\[0\]\.items\[0\]: expected non-empty string/,
    );
    await expectKitchenAdminError(
      () => parseKitchenExportJson(JSON.stringify({ format: 1, shoppingList: [123] })),
      /^shoppingList\[0\]: expected string/,
    );
    await expectKitchenAdminError(
      () => parseKitchenExportJson(JSON.stringify({ format: 1, ideas: ["   "] })),
      /^ideas\[0\]: expected non-empty string/,
    );
    await expectKitchenAdminError(
      () =>
        parseKitchenExportJson(
          JSON.stringify({ format: 1, about: "a".repeat(2001) }),
        ),
      /^about: must be at most 2000 characters \(got 2001\)/,
    );

    // 2000 astral Unicode code points are accepted (matches Postgres char_length).
    const emojiAbout = parseKitchenExportJson(
      JSON.stringify({ format: 1, about: "🍳".repeat(2000) }),
    );
    expect(emojiAbout.about).toBe("🍳".repeat(2000));

    await expectKitchenAdminError(
      () =>
        parseKitchenExportJson(
          JSON.stringify({
            format: 1,
            recipes: [
              { docSlug: "a", name: "A", rawDocText: "x" },
              { docSlug: "a", name: "A2", rawDocText: "y" },
            ],
          }),
        ),
      /^recipes\[1\]\.docSlug: duplicate docSlug "a"/,
    );
    await expectKitchenAdminError(
      () =>
        parseKitchenExportJson(
          JSON.stringify({
            format: 1,
            recipes: [
              {
                docSlug: "a",
                name: "A",
                rawDocText: "x",
                servesEstimate: 4,
              },
            ],
          }),
        ),
      /^recipes\[0\]\.servesEstimateBasis: must be a string when servesEstimate is set/,
    );
    await expectKitchenAdminError(
      () =>
        parseKitchenExportJson(
          JSON.stringify({
            format: 1,
            recipes: [
              {
                docSlug: "a",
                name: "A",
                rawDocText: "x",
                cookPlan: { version: 4, tasks: [{ id: "1", text: "Cook" }] },
                cookPlanError: "nope",
              },
            ],
          }),
        ),
      /^recipes\[0\]\.cookPlanError: must be null when cookPlan is set/,
    );
    await expectKitchenAdminError(
      () =>
        parseKitchenExportJson(
          JSON.stringify({
            format: 1,
            queue: [
              {
                status: "bogus",
                createdAt: "2026-11-20T10:00:00.000Z",
              },
            ],
          }),
        ),
      /^queue\[0\]\.status: expected one of pending, cooking, completed, cancelled/,
    );
    await expectKitchenAdminError(
      () =>
        parseKitchenExportJson(
          JSON.stringify({
            format: 1,
            queue: [
              {
                status: "pending",
                createdAt: "2026-02-30T10:00:00.000Z",
              },
            ],
          }),
        ),
      /^queue\[0\]\.createdAt: expected valid ISO-8601 date string/,
    );

    // Valid section + valid row 0 followed by invalid row 1: refuses whole import and writes nothing!
    await expectKitchenAdminError(
      () =>
        importKitchenData(
          {
            kitchenSlug: "beta",
            data: {
              format: 1,
              about: "Should not be saved",
              recipes: [
                {
                  docSlug: "good-recipe",
                  name: "Good",
                  rawDocText: "Good recipe.",
                },
              ],
              cookLog: [
                {
                  recipeTitle: "Good",
                  timestampText: "2026-11-20 10:00",
                  cookedDay: "2026-11-20",
                  cookedAt: "2026-11-20T15:00:00.000Z",
                  rating: 5,
                },
                {
                  recipeTitle: "Bad",
                  timestampText: "2026-11-20 11:00",
                  cookedDay: "2026-11-20",
                  cookedAt: "2026-11-20T16:00:00.000Z",
                  rating: 7,
                },
              ],
            },
          },
          db,
        ),
      /^cookLog\[1\]\.rating: expected integer between 1 and 5/,
    );

    const [betaRow] = await db
      .select()
      .from(kitchens)
      .where(eq(kitchens.id, kitchenB.id));
    expect(betaRow?.about).toBe("");
    expect(
      await db
        .select()
        .from(docRecipes)
        .where(eq(docRecipes.kitchenId, kitchenB.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(kitchenCookLog)
        .where(eq(kitchenCookLog.kitchenId, kitchenB.id)),
    ).toHaveLength(0);
  });

  it("rolls back all earlier writes if a database failure occurs mid-transaction", async () => {
    const { kitchen: kitchenB } = await seedKitchen(db, {
      slug: "beta",
      name: "Beta",
    });

    // Inject a failure during the ideas insert (last write in the transaction)
    // by placing a trigger on kitchen_ideas that throws.
    await client.exec(`
      CREATE OR REPLACE FUNCTION test_fail_ideas_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'simulated mid-transaction failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_ideas_trigger
      BEFORE INSERT ON kitchen_ideas
      FOR EACH ROW EXECUTE FUNCTION test_fail_ideas_insert();
    `);

    try {
      let caught: unknown;
      try {
        await importKitchenData(
          {
            kitchenSlug: "beta",
            data: {
              format: 1,
              about: "Should roll back",
              recipes: [
                {
                  docSlug: "rolled-back",
                  name: "Rolled Back",
                  rawDocText: "Should not persist.",
                },
              ],
              queue: [
                {
                  status: "pending",
                  createdAt: "2026-11-20T10:00:00.000Z",
                  recipeData: { name: "Rolled Back" },
                },
              ],
              cookLog: [
                {
                  docSlug: "rolled-back",
                  recipeTitle: "Rolled Back",
                  timestampText: "2026-11-20 10:00",
                  cookedDay: "2026-11-20",
                  cookedAt: "2026-11-20T15:00:00.000Z",
                },
              ],
              pantry: [{ rawHeading: "Fridge", items: ["rolled back milk"] }],
              shoppingList: ["rolled back lemons"],
              ideas: ["rolled back idea"],
            },
          },
          db,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const causeMsg =
        caught instanceof Error && caught.cause instanceof Error
          ? caught.cause.message
          : String(caught);
      expect(causeMsg).toMatch(/simulated mid-transaction failure/);

      const [betaRow] = await db
        .select()
        .from(kitchens)
        .where(eq(kitchens.id, kitchenB.id));
      expect(betaRow?.about).toBe("");
      expect(
        await db
          .select()
          .from(docRecipes)
          .where(eq(docRecipes.kitchenId, kitchenB.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(kitchenQueue)
          .where(eq(kitchenQueue.kitchenId, kitchenB.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(kitchenCookLog)
          .where(eq(kitchenCookLog.kitchenId, kitchenB.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(kitchenPantrySections)
          .where(eq(kitchenPantrySections.kitchenId, kitchenB.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(kitchenPantryItems)
          .where(eq(kitchenPantryItems.kitchenId, kitchenB.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(kitchenShoppingList)
          .where(eq(kitchenShoppingList.kitchenId, kitchenB.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(kitchenIdeas)
          .where(eq(kitchenIdeas.kitchenId, kitchenB.id)),
      ).toHaveLength(0);
    } finally {
      await client.exec(
        "DROP TRIGGER IF EXISTS test_fail_ideas_trigger ON kitchen_ideas; DROP FUNCTION IF EXISTS test_fail_ideas_insert();",
      );
    }
  });

  it("works in single-kitchen mode for the home kitchen and refuses unknown kitchens", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "off");
    const home = await homeKitchen(db);

    await db
      .update(kitchens)
      .set({ about: "Single kitchen home." })
      .where(eq(kitchens.id, home.id));

    const exported = await exportKitchenData({ kitchenSlug: "home" }, db);
    expect(exported.kitchenSlug).toBe("home");
    expect(exported.data.about).toBe("Single kitchen home.");
    expect(formatExportSummary(exported, "/tmp/home.json")).toContain(
      'Exported kitchen "home"',
    );

    const imported = await importKitchenData(
      {
        kitchenSlug: "home",
        data: {
          format: 1,
          recipes: [
            {
              docSlug: "home-pasta",
              name: "Home Pasta",
              rawDocText: "Boil pasta.",
            },
          ],
        },
      },
      db,
    );
    expect(imported.recipes.inserted).toBe(1);

    await expectKitchenAdminError(
      () => exportKitchenData({ kitchenSlug: "missing" }, db),
      /Kitchen "missing" not found/,
    );
    await expectKitchenAdminError(
      () =>
        importKitchenData(
          { kitchenSlug: "missing", data: { format: 1 } },
          db,
        ),
      /Kitchen "missing" not found/,
    );
    await expectKitchenAdminError(
      () =>
        importKitchenData(
          { kitchenSlug: "missing", data: { format: 1 }, dryRun: true },
          db,
        ),
      /Kitchen "missing" not found/,
    );
  });

  it("parses export and import CLI subcommands cleanly", () => {
    expect(
      parseCommand(["export", "--kitchen", "home", "--out", "backup.json"]),
    ).toEqual({
      kind: "export",
      input: { kitchenSlug: "home", out: "backup.json" },
    });

    expect(
      parseCommand(["import", "--kitchen", "north", "--file", "backup.json"]),
    ).toEqual({
      kind: "import",
      input: { kitchenSlug: "north", file: "backup.json", dryRun: false },
    });

    expect(
      parseCommand([
        "import",
        "--kitchen",
        "north",
        "--file",
        "backup.json",
        "--dry-run",
      ]),
    ).toEqual({
      kind: "import",
      input: { kitchenSlug: "north", file: "backup.json", dryRun: true },
    });

    expect(() => parseCommand(["export", "--kitchen", "home"])).toThrow(
      KitchenAdminError,
    );
    expect(() =>
      parseCommand(["import", "--kitchen", "home", "--file", "a.json", "--bogus"]),
    ).toThrow(KitchenAdminError);
  });
});
