import { test, expect } from "./fixtures";
import { readQueueRowById, readQueueRowByName } from "./db";
import { RECIPE_NAMES } from "./seed-data";

test.describe("Queue screen", () => {
  test("QUEUE-1: lists the four pending rows newest first, Made recently in order, and no cancelled row", async ({
    page,
  }) => {
    await page.goto("/kitchen");

    // Open queue screen from the home rail (app/src/components/kitchen/HomeRail.tsx:194-195)
    await page.getByRole("button", { name: "Up next · 4" }).click();

    // Queue dialog (app/src/components/kitchen/BorrowedChrome.tsx:244-246; QueueScreen.tsx:13, 55)
    const dialog = page.getByRole("dialog", { name: "Up next" });
    await expect(dialog).toBeVisible();

    // Pending list newest first (app/src/components/kitchen/QueueScreen.tsx:101-109)
    const pendingList = dialog.getByRole("list", { name: "Up next" });
    const pendingTitles = pendingList.locator("[data-row-start]");
    await expect(pendingTitles).toHaveCount(4);
    await expect(pendingTitles).toHaveText([
      RECIPE_NAMES.thinWhiteSauce,
      RECIPE_NAMES.boiledCustard,
      RECIPE_NAMES.pantryTomatoSoup,
      RECIPE_NAMES.sesameGreenBeans,
    ]);

    // Made recently list newest completed first, labelled by its h3 heading
    // (app/src/components/kitchen/QueueScreen.tsx:16, 122-129)
    await expect(
      dialog.getByRole("heading", { level: 3, name: "Made recently" }),
    ).toBeVisible();
    const recentList = dialog.getByRole("list", { name: "Made recently" });
    const recentItems = recentList.getByRole("listitem");
    await expect(recentItems).toHaveCount(2);
    await expect(recentItems.nth(0)).toContainText(RECIPE_NAMES.waffles);
    await expect(recentItems.nth(1)).toContainText(RECIPE_NAMES.herbOmelette);

    // Cancelled Parker House Rolls appears nowhere on the queue screen
    await expect(dialog.getByText(RECIPE_NAMES.parkerHouseRolls)).toHaveCount(0);
  });

  test("QUEUE-2: Edit then Remove on Boiled Custard removes it from the list, drops rail count, and deletes DB row", async ({
    page,
  }) => {
    const boiledBefore = await readQueueRowByName(RECIPE_NAMES.boiledCustard);
    expect(boiledBefore).not.toBeNull();

    await page.goto("/kitchen");
    await page.getByRole("button", { name: "Up next · 4" }).click();

    const dialog = page.getByRole("dialog", { name: "Up next" });
    await expect(dialog).toBeVisible();

    // Edit button reveals row Remove buttons (app/src/components/kitchen/QueueScreen.tsx:14, 17, 60-67, 111)
    await dialog.getByRole("button", { name: "Edit" }).click();

    const boiledRow = dialog
      .getByRole("list", { name: "Up next" })
      .getByRole("listitem")
      .filter({ hasText: RECIPE_NAMES.boiledCustard });
    await boiledRow.getByRole("button", { name: "Remove" }).click();

    // Boiled Custard leaves the pending list
    await expect(
      dialog
        .getByRole("list", { name: "Up next" })
        .getByRole("button", { name: RECIPE_NAMES.boiledCustard }),
    ).toHaveCount(0);

    // Close queue screen via top-left back control
    // (app/src/components/kitchen/BorrowedChrome.tsx:49, 100-103)
    await dialog.getByRole("button", { name: "Back to the kitchen" }).click();
    await expect(dialog).toBeHidden();

    // Home rail count drops from 4 to 3 (app/src/lib/kitchen/home-view.ts:51)
    await expect(
      page.getByRole("button", { name: "Up next · 3" }),
    ).toBeVisible();

    // removeFromQueue deletes the row from kitchen_queue (app/src/lib/kitchen-queue.ts:371-378)
    await expect
      .poll(async () => readQueueRowById(boiledBefore!.id))
      .toBeNull();
  });

  test("QUEUE-3: starting Sesame Green Beans from its queue row opens its cook page and marks it cooking", async ({
    page,
  }) => {
    const p4Before = await readQueueRowByName(RECIPE_NAMES.sesameGreenBeans);
    expect(p4Before).not.toBeNull();

    await page.goto("/kitchen");
    await page.getByRole("button", { name: "Up next · 4" }).click();

    const dialog = page.getByRole("dialog", { name: "Up next" });
    // Queue row start button calls handleStartFromQueue, which sets status to "cooking"
    // and navigates to /kitchen/queue/<id> (QueueScreen.tsx:106; app/src/app/kitchen/page.tsx:209-219)
    await dialog
      .getByRole("list", { name: "Up next" })
      .getByRole("button", { name: RECIPE_NAMES.sesameGreenBeans })
      .click();

    await expect(page).toHaveURL(new RegExp(`/kitchen/queue/${p4Before!.id}$`));

    await expect
      .poll(async () => (await readQueueRowById(p4Before!.id))?.status)
      .toBe("cooking");

    const p4Cooking = await readQueueRowById(p4Before!.id);
    expect(p4Cooking!.startedAt).not.toBeNull();
  });
});
