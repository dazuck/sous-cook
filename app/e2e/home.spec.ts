import { test, expect } from "./fixtures";
import { readQueueRowById, readQueueRowByName, setQueueRowStatus } from "./db";
import { RECIPE_NAMES } from "./seed-data";

test.describe("Kitchen home", () => {
  test("HOME-1: shows Thin White Sauce to start, remaining pending recipes, queue count, no cancelled row, and fits viewport", async ({
    page,
  }, testInfo) => {
    await page.goto("/kitchen");

    // Top pending recipe title (app/src/components/kitchen/KitchenHome.tsx:200, 442)
    await expect(
      page.getByRole("heading", { level: 2, name: RECIPE_NAMES.thinWhiteSauce }),
    ).toBeVisible();

    // Primary Start button for the top recipe (app/src/components/kitchen/KitchenHome.tsx:33, 451)
    await expect(page.locator("[data-start]")).toHaveText("Start");

    // "Then" line lists the remaining pending recipes according to viewport orientation
    // (app/src/lib/kitchen/home-view.ts:26-29; app/src/components/kitchen/KitchenHome.tsx:460-488)
    const thenRow = page.locator("[data-then]");
    await expect(
      thenRow.getByRole("button", { name: RECIPE_NAMES.boiledCustard }),
    ).toBeVisible();

    if (testInfo.project.name === "landscape") {
      // Landscape shows two follow-up titles and "1 more" (KitchenHome.tsx:467-487)
      await expect(
        thenRow.getByRole("button", { name: RECIPE_NAMES.pantryTomatoSoup }),
      ).toBeVisible();
      await expect(thenRow.getByRole("button", { name: "1 more" })).toBeVisible();
    } else {
      // Portrait hides the second follow-up title and shows "2 more" (KitchenHome.tsx:473, 478-481)
      await expect(
        thenRow.getByRole("button", { name: RECIPE_NAMES.pantryTomatoSoup }),
      ).toBeHidden();
      await expect(thenRow.getByRole("button", { name: "2 more" })).toBeVisible();
    }

    // Rail queue button carries pending count wording "Up next · 4"
    // (app/src/components/kitchen/HomeRail.tsx:158-161; app/src/lib/kitchen/home-view.ts:51)
    await expect(
      page.getByRole("button", { name: "Up next · 4" }),
    ).toBeVisible();

    // Cancelled recipe Parker House Rolls appears nowhere on the home screen
    await expect(page.getByText(RECIPE_NAMES.parkerHouseRolls)).toHaveCount(0);

    // Home screen does not scroll vertically in either tablet orientation
    const fitsWithoutScroll = await page.evaluate(
      () => document.documentElement.scrollHeight <= window.innerHeight,
    );
    expect(fitsWithoutScroll).toBe(true);
  });

  test("HOME-2: pressing Start opens P1 cook page, marks it cooking, and returning shows cook under way", async ({
    page,
  }) => {
    const p1Before = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    expect(p1Before).not.toBeNull();

    await page.goto("/kitchen");

    // Start button on the top recipe (app/src/components/kitchen/KitchenHome.tsx:33, 451)
    await page.locator("[data-start]").click();

    await expect(page).toHaveURL(new RegExp(`/kitchen/queue/${p1Before!.id}$`));

    // Cook opening screen Start control confirms the cook page loaded
    // (app/src/components/kitchen/CookOpening.tsx:170; app/src/lib/kitchen/cook-view.ts:194)
    await expect(page.locator("[data-opening-start]")).toBeVisible();

    const p1Cooking = await readQueueRowById(p1Before!.id);
    expect(p1Cooking).not.toBeNull();
    expect(p1Cooking!.status).toBe("cooking");
    expect(p1Cooking!.startedAt).not.toBeNull();

    // On the opening screen RecipeHeader is inert/invisible (CookScreen.tsx:1086);
    // the cook screen's exit control is More -> Exit cooking
    // (app/src/components/kitchen/CookSheet.tsx:1462; app/src/components/kitchen/HeaderMore.tsx:13, 40, 136, 205-207)
    await page.locator("[data-sheet-more]").getByRole("button", { name: "More" }).click();
    await page.getByRole("link", { name: "Exit cooking" }).click();

    await expect(page).toHaveURL(/\/kitchen$/);

    // Cooking subject card shows "Pick up where you left off" with Thin White Sauce
    // (app/src/components/kitchen/KitchenHome.tsx:31, 375-376, 392)
    const cookingSubject = page.locator("[data-cooking-subject]");
    await expect(cookingSubject).toBeVisible();
    await expect(cookingSubject).toHaveAttribute(
      "aria-label",
      "Pick up where you left off",
    );
    await expect(
      cookingSubject.getByRole("link", { name: RECIPE_NAMES.thinWhiteSauce }),
    ).toBeVisible();

    // With 3 pending recipes still queued alongside 1 cooking, queueFoot chooses
    // "Up next · 3" over "Under way · 1" (app/src/lib/kitchen/home-view.ts:50-55)
    await expect(
      page.getByRole("button", { name: "Up next · 3" }),
    ).toBeVisible();
  });

  test("HOME-3: with all pending rows cancelled, home shows its idle state and links to Cookpacks", async ({
    page,
  }) => {
    await setQueueRowStatus(RECIPE_NAMES.thinWhiteSauce, "cancelled");
    await setQueueRowStatus(RECIPE_NAMES.boiledCustard, "cancelled");
    await setQueueRowStatus(RECIPE_NAMES.pantryTomatoSoup, "cancelled");
    await setQueueRowStatus(RECIPE_NAMES.sesameGreenBeans, "cancelled");

    await page.goto("/kitchen");

    // Idle home state copy and link (app/src/components/kitchen/KitchenHome.tsx:37-39, 495-496, 512-523)
    const idleSubject = page.locator("[data-idle-subject]");
    await expect(idleSubject).toBeVisible();
    await expect(idleSubject).toContainText("Nothing on the stove yet");
    await expect(
      idleSubject.getByRole("heading", { level: 2, name: "Find something for dinner" }),
    ).toBeVisible();

    const exploreLink = page.getByRole("link", {
      name: "Explore Cookpacks & recipes",
    });
    await expect(exploreLink).toBeVisible();
    await exploreLink.click();

    await expect(page).toHaveURL(/\/kitchen\/cookpacks$/);
  });
});
