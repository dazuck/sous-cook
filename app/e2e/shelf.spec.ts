import { test, expect } from "./fixtures";
import {
  getHomeKitchenId,
  readAuthCounts,
  readQueueRowById,
} from "./db";
import {
  BUNDLED_PACK_CREATOR,
  BUNDLED_PACK_ID,
  BUNDLED_PACK_RECIPE_TITLES,
  BUNDLED_PACK_TITLE,
  RECIPE_NAMES,
} from "./seed-data";

test.describe("Cookpacks shelf and pack view", () => {
  test("SHELF-1: shows only the bundled 1896 book with its accessible name and no household or saved-for-later entries", async ({
    page,
  }) => {
    await page.goto("/kitchen");

    // Cookpacks link on the home rail (app/src/components/kitchen/HomeRail.tsx:166-174; KitchenHome.tsx:30)
    await page.getByRole("link", { name: "Cookpacks" }).click();
    await expect(page).toHaveURL(/\/kitchen\/cookpacks$/);

    // Exactly one creator book, the bundled 1896 cook book
    // (app/src/components/cookpacks/Shelf.tsx:75-83; app/src/components/cookpacks/copy.ts:17)
    const creatorBooks = page.locator("[data-creator-book]");
    await expect(creatorBooks).toHaveCount(1);

    const expectedAccessibleName = `${BUNDLED_PACK_TITLE}, ${BUNDLED_PACK_CREATOR}, 5 recipes`;
    await expect(
      page.getByRole("link", { name: expectedAccessibleName }),
    ).toBeVisible();

    // No household book and no saved-for-later entry when hooks are unconnected
    // (app/src/components/cookpacks/Shelf.tsx:55, 178, 184)
    await expect(page.locator("[data-household]")).toHaveCount(0);
    await expect(page.locator("[data-saved-for-later]")).toHaveCount(0);
  });

  test("SHELF-2: lists the five recipes in pack order and search narrows to Waffles", async ({
    page,
  }) => {
    await page.goto(`/kitchen/cookpacks/${BUNDLED_PACK_ID}`);

    // Pack rows in pack order (app/src/components/cookpacks/PackView.tsx:236-245)
    const rows = page.locator("[data-pack-row]");
    await expect(rows).toHaveCount(5);
    for (let i = 0; i < BUNDLED_PACK_RECIPE_TITLES.length; i++) {
      await expect(rows.nth(i)).toContainText(BUNDLED_PACK_RECIPE_TITLES[i]!);
    }

    // Search input (app/src/components/cookpacks/PackView.tsx:67-76; copy.ts:41)
    const search = page.getByRole("searchbox", { name: "Search this book" });
    await search.fill("waffles");

    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(RECIPE_NAMES.waffles);
  });

  test("SHELF-3: tapping Doughnuts I queues it with stored plan, skips ensureCookPlan, and puts it on top of home", async ({
    page,
  }) => {
    const trpcProcedures: string[] = [];
    const onRequest = (req: { url: () => string }) => {
      const parsed = new URL(req.url());
      const prefix = "/api/trpc/";
      if (!parsed.pathname.startsWith(prefix)) return;
      const names = parsed.pathname
        .slice(prefix.length)
        .split(",")
        .filter(Boolean);
      trpcProcedures.push(...names);
    };
    page.on("request", onRequest);

    await page.goto(`/kitchen/cookpacks/${BUNDLED_PACK_ID}`);

    // Tapping Doughnuts I calls queueFromPack and opens /kitchen/queue/<new id>
    // (app/src/components/cookpacks/PackView.tsx:236-245; app/src/server/routers/_app.ts:755-836)
    await page
      .locator('[data-pack-row="doughnuts-i"]')
      .click();

    await expect(page).toHaveURL(/\/kitchen\/queue\/([0-9a-f-]+)$/);
    const match = /\/kitchen\/queue\/([0-9a-f-]+)$/.exec(page.url());
    expect(match).not.toBeNull();
    const newQueueId = match![1]!;

    // Wait for the cook opening screen to render (app/src/components/kitchen/CookOpening.tsx:170)
    await expect(page.locator("[data-opening-start]")).toBeVisible();

    // Verify DB row: home kitchen, status left "pending" by queueFromPack,
    // stored cook plan present, no plan error
    const homeKitchenId = await getHomeKitchenId();
    const row = await readQueueRowById(newQueueId);
    expect(row).not.toBeNull();
    expect(row!.kitchenId).toBe(homeKitchenId);
    expect(row!.name).toBe(RECIPE_NAMES.doughnutsI);
    // queueFromPack calls addToKitchenQueue and leaves status at "pending"
    // (app/src/server/routers/_app.ts:755-836; app/src/lib/kitchen-queue.ts:158)
    expect(row!.status).toBe("pending");
    expect(row!.hasCookPlan).toBe(true);
    expect(row!.cookPlanError).toBeNull();

    // Stored plan means the cook page never calls ensureCookPlan
    // (app/src/app/kitchen/queue/[id]/page.tsx:431, 444-453)
    expect(trpcProcedures).toContain("queueFromPack");
    expect(trpcProcedures).not.toContain("ensureCookPlan");

    page.off("request", onRequest);

    // Return to /kitchen via opening's More -> Exit cooking
    // (CookSheet.tsx:1462; HeaderMore.tsx:64, 161, 237-239)
    await page.locator("[data-sheet-more]").getByRole("button", { name: "More" }).click();
    await page.getByRole("link", { name: "Exit cooking" }).click();
    await expect(page).toHaveURL(/\/kitchen$/);

    // Doughnuts I is now the newest pending recipe, so it is the top item to start
    // (app/src/components/kitchen/KitchenHome.tsx:200, 442)
    await expect(
      page.getByRole("heading", { level: 2, name: RECIPE_NAMES.doughnutsI }),
    ).toBeVisible();

    const authCounts = await readAuthCounts();
    expect(authCounts).toEqual({ kitchens: 1, members: 0, invites: 0 });
  });
});
