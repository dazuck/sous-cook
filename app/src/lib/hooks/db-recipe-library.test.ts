import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);
vi.mock("@/lib/recipe-import", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recipe-import")>()),
  extractRecipeFromText: vi.fn(async () => {
    throw new Error("extractRecipeFromText should not run on saved db rows");
  }),
}));

import * as dbModule from "@/lib/db";
import { db, docRecipes } from "@/lib/db";
import { callerFor, seedKitchen } from "../__tests__/kitchens";
import { extractRecipeFromText } from "../recipe-import";
import { syncRecipesFromDoc } from "../recipe-sync";
import { planSourceHash } from "../kitchen/cook-plan-stamp";
import { cookPlanStamp } from "../kitchen/cook-plan-stamp";
import { COOK_PLAN_VERSION, type CookPlan } from "../kitchen/cook-plan";
import { loadAppShelf } from "../shelf/load";
import { packView, shelfView } from "../shelf/view-build";
import { dbRecipeLibrary } from "./db-recipe-library";

const client = (dbModule as unknown as { client: PGlite }).client;

let kitchenAId: string;
let kitchenBId: string;
let callerA: ReturnType<typeof callerFor>;

beforeEach(async () => {
  await client.exec(
    "delete from kitchen_cook_log; delete from doc_recipes; delete from recipe_ideas_cache; delete from kitchen_queue; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  const seededA = await seedKitchen(db, { slug: "lib-a", name: "Lib A" });
  const seededB = await seedKitchen(db, { slug: "lib-b", name: "Lib B" });
  kitchenAId = seededA.kitchen.id;
  kitchenBId = seededB.kitchen.id;
  callerA = callerFor(seededA.kitchen, { id: seededA.member.id, role: "owner" });
});

describe("dbRecipeLibrary", () => {
  it("returns [] when a kitchen has no doc_recipes and exposes empty household pack state", async () => {
    expect(await dbRecipeLibrary(kitchenAId).readTabs()).toEqual([]);

    const shelf = await loadAppShelf(kitchenAId);
    const view = shelfView(shelf, 0);
    expect(view.household?.state).toBe("empty");
    const pack = packView(shelf, "household-book");
    expect(pack?.state).toBe("empty");
  });

  it("returns only the requested kitchen's recipes in docPosition order with isPrivate defaulting to false and toggleable", async () => {
    await db.insert(docRecipes).values([
      {
        kitchenId: kitchenAId,
        docSlug: "carrot-cake",
        name: "Carrot Cake",
        category: "baking",
        categoryTitle: "Baking",
        docPosition: 2,
        ingredients: [{ item: "carrots", amount: "2", unit: "cups" }],
        steps: ["Grate carrots.", "Bake 40 minutes."],
        serves: 8,
        rawDocText: "Carrot Cake\n2 cups carrots\nGrate carrots.\nBake 40 minutes.",
      },
      {
        kitchenId: kitchenAId,
        docSlug: "red-lentil-dal",
        name: "Red Lentil Dal",
        category: "mains",
        categoryTitle: "Mains",
        docPosition: 1,
        ingredients: [{ item: "red lentils", amount: "1", unit: "cup" }],
        steps: ["Rinse lentils.", "Simmer 20 minutes."],
        serves: 4,
        rawDocText: "Red Lentil Dal\n1 cup red lentils\nRinse lentils.\nSimmer 20 minutes.",
      },
      {
        kitchenId: kitchenBId,
        docSlug: "kitchen-b-chili",
        name: "Kitchen B Chili",
        category: "mains",
        categoryTitle: "Mains",
        docPosition: 0,
        ingredients: [{ item: "beans", amount: "2", unit: "cans" }],
        steps: ["Warm beans."],
        serves: 4,
        rawDocText: "Kitchen B Chili\n2 cans beans\nWarm beans.",
      },
    ]);

    const tabsA = await dbRecipeLibrary(kitchenAId).readTabs();
    expect(tabsA.map((t) => t.title)).toEqual(["Mains", "Baking"]);
    expect(tabsA[0]!.children.map((c) => c.title)).toEqual(["Red Lentil Dal"]);
    expect(tabsA[1]!.children.map((c) => c.title)).toEqual(["Carrot Cake"]);

    const packBefore = await callerA.getPack({ packId: "household-book" });
    expect(packBefore?.chapters.flatMap((c) => c.rows)).toMatchObject([
      { id: "red-lentil-dal", isPrivate: false },
      { id: "carrot-cake", isPrivate: false },
    ]);

    await callerA.setDocRecipePrivate({
      docSlug: "red-lentil-dal",
      isPrivate: true,
    });
    const packAfter = await callerA.getPack({ packId: "household-book" });
    expect(packAfter?.chapters.flatMap((c) => c.rows)).toMatchObject([
      { id: "red-lentil-dal", isPrivate: true },
      { id: "carrot-cake", isPrivate: false },
    ]);
  });

  it("refreshes saved db_recipes without re-running extraction or duplicating custom slugs", async () => {
    vi.mocked(extractRecipeFromText).mockClear();

    const recipeForPlan = {
      ingredients: [{ item: "apples", amount: "4" }],
      steps: ["Bake at 375F for 45 minutes."],
      stepIngredients: [[0]],
    };
    const validPlan: CookPlan = {
      version: COOK_PLAN_VERSION,
      tasks: [
        {
          id: "t1",
          kind: "cook",
          text: "Bake at 375F for 45 minutes.",
          label: "bake pie",
          ingredientIdx: [0],
          sourceStep: 0,
          implied: false,
          needs: [],
          minutes: { est: 45, handsOff: true },
          branch: "Main",
        },
      ],
    };

    await db.insert(docRecipes).values({
      kitchenId: kitchenAId,
      docSlug: "grandmas-pie",
      name: "Apple Pie",
      category: "baking",
      categoryTitle: "Baking",
      docPosition: 0,
      ingredients: recipeForPlan.ingredients,
      steps: recipeForPlan.steps,
      stepIngredients: recipeForPlan.stepIngredients,
      serves: 8,
      rawDocText: "Apple Pie\n4 apples\nBake at 375F for 45 minutes.",
      cookPlan: validPlan,
      cookPlanError: null,
      cookPlanSourceHash: planSourceHash(recipeForPlan),
      cookPlanStamp: cookPlanStamp(),
    });

    const result = await syncRecipesFromDoc(kitchenAId);
    expect(vi.mocked(extractRecipeFromText)).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      total: 1,
      succeeded: 1,
      failed: 0,
      stale: [],
    });
    expect(result.plans.reused).toBe(1);

    const rowsAfter = await db.select().from(docRecipes);
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]?.docSlug).toBe("grandmas-pie");
    expect(rowsAfter[0]?.name).toBe("Apple Pie");
  });
});
