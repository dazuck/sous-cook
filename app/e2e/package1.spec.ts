import { test, expect } from "./fixtures";
import {
  getHomeKitchenId,
  readDocRecipePrivate,
  readLatestUserConversationContext,
  readQueueRecipePrivate,
  readQueueRowByName,
  seedDocRecipeRow,
} from "./db";
import { RECIPE_NAMES } from "./seed-data";

test.describe("Package 1: Cook log, recipe book, and about my kitchen", () => {
  test("PKG1-1: finishing, rating, and noting a cook saves an entry shown on /kitchen/cook-log", async ({
    page,
  }) => {
    const p1 = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    expect(p1).not.toBeNull();

    await page.goto("/kitchen");
    await page.locator("[data-start]").click();
    await expect(page).toHaveURL(new RegExp(`/kitchen/queue/${p1!.id}$`));

    await page.locator("[data-opening-start]").click();
    const doneButton = page.getByRole("button", { name: "Done cooking" });
    for (let step = 0; step < 20; step++) {
      if (await doneButton.isVisible()) break;
      const advance = page.getByRole("button", {
        name: /^(Next step|The rest of this step|Looks right)$/,
      });
      await expect(advance).toBeVisible();
      await advance.click();
    }
    await expect(doneButton).toBeVisible();
    await page.clock.fastForward(600);
    await doneButton.click();
    await expect(page).toHaveURL(/\/kitchen$/);

    await expect(
      page.getByRole("heading", { level: 2, name: "How was it?" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add a note" }).click();
    await page.getByRole("textbox", { name: "Note" }).fill("Silky texture, pinch more salt");
    await page.getByRole("button", { name: "4 out of 5" }).click();

    await expect(
      page.getByRole("heading", { level: 2, name: RECIPE_NAMES.boiledCustard }),
    ).toBeVisible();

    // Open Cook log via the rail's names panel
    await page.locator("[data-rail-pull]").click();
    await page.locator("[data-rail-tab]").getByRole("menuitem", { name: "Cook log" }).click();
    await expect(page).toHaveURL(/\/kitchen\/cook-log$/);

    const entry = page.locator("[data-cook-log-entry]").first();
    await expect(entry).toBeVisible();
    await expect(entry).toContainText(RECIPE_NAMES.thinWhiteSauce);
    await expect(entry.getByRole("button", { name: "4 out of 5" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      entry.getByRole("textbox", { name: `Note for ${RECIPE_NAMES.thinWhiteSauce}` }),
    ).toHaveValue("Silky texture, pinch more salt");

    // Clear rating to unrated ("none"), toggle Private note, and toggle Hold back / Show to friends
    await entry.getByRole("button", { name: "4 out of 5" }).click();
    for (const n of [1, 2, 3, 4, 5]) {
      await expect(entry.getByRole("button", { name: `${n} out of 5` })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }

    const privateCheckbox = entry.getByRole("checkbox", { name: "Private note" });
    await expect(privateCheckbox).not.toBeChecked();
    const savePrivateRes = page.waitForResponse(
      (res) =>
        res.url().includes("updateCookLogEntry") &&
        res.request().method() === "POST",
    );
    await privateCheckbox.check();
    expect((await savePrivateRes).ok()).toBe(true);
    await expect(privateCheckbox).toBeChecked();

    // Hold-back controls belong to sign-in mode circles and must not appear in single-kitchen mode.
    await expect(entry.locator("[data-hold-back]")).toHaveCount(0);
    await expect(entry.getByText("Held back from friends")).toHaveCount(0);

    // Reload and confirm rating clear and Private note persisted
    await page.reload();
    const reloaded = page.locator("[data-cook-log-entry]").first();
    for (const n of [1, 2, 3, 4, 5]) {
      await expect(
        reloaded.getByRole("button", { name: `${n} out of 5` }),
      ).toHaveAttribute("aria-pressed", "false");
    }
    await expect(reloaded.getByRole("checkbox", { name: "Private note" })).toBeChecked();
    await expect(reloaded.locator("[data-hold-back]")).toHaveCount(0);
  });

  test("PKG1-2: recipe book shows empty state when empty, and lists seeded recipes with persistent Private toggle", async ({
    page,
  }) => {
    await page.goto("/kitchen");

    // Empty state via rail names panel
    await page.locator("[data-rail-pull]").click();
    await page.locator("[data-rail-tab]").getByRole("menuitem", { name: "Recipe book" }).click();
    await expect(page).toHaveURL(/\/kitchen\/cookpacks\/household-book$/);
    await expect(
      page.getByText("Nothing has come in from your recipe library yet."),
    ).toBeVisible();

    // Seed a recipe in the home kitchen's doc_recipes
    const homeId = await getHomeKitchenId();
    await seedDocRecipeRow(homeId, {
      docSlug: "house-lentil-soup",
      name: "House Lentil Soup",
      category: "mains",
      categoryTitle: "Mains",
      docPosition: 0,
      ingredients: [{ item: "lentils", amount: "1", unit: "cup" }],
      steps: ["Rinse lentils.", "Simmer for 25 minutes."],
      serves: 4,
      rawDocText: "House Lentil Soup\n1 cup lentils\nRinse lentils.\nSimmer for 25 minutes.",
    });

    await page.reload();
    await expect(
      page.getByRole("button", { name: "House Lentil Soup", exact: true }),
    ).toBeVisible();
    const privateBtn = page.getByRole("button", { name: "Private: House Lentil Soup" });
    await expect(privateBtn).toHaveAttribute("aria-pressed", "false");

    await privateBtn.click();
    await expect(privateBtn).toHaveAttribute("aria-pressed", "true");
    expect(await readDocRecipePrivate(homeId, "house-lentil-soup")).toBe(true);

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Private: House Lentil Soup" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("PKG1-3: About my kitchen persists on /kitchen/settings and reaches Ask Sous conversation context", async ({
    page,
    allowConsoleError,
  }) => {
    allowConsoleError(/Failed to load resource: the server responded with a status of 500/);
    allowConsoleError(/^Chat error:/);

    await page.goto("/kitchen");
    await page.locator("[data-rail-pull]").click();
    await page.locator("[data-rail-tab]").getByRole("menuitem", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/kitchen\/settings$/);

    const textarea = page.getByRole("textbox", { name: "About my kitchen" });
    await textarea.fill("We avoid peanuts.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved.");

    await page.reload();
    await expect(page.getByRole("textbox", { name: "About my kitchen" })).toHaveValue(
      "We avoid peanuts.",
    );

    // Go back to home and trigger Ask Sous without a model key
    await page.getByRole("link", { name: "Back to the kitchen" }).click();
    await expect(page).toHaveURL(/\/kitchen$/);

    await page.locator("[data-rail-pull]").click();
    await page.locator("[data-rail-tab]").getByRole("menuitem", { name: "Ask Sous" }).click();
    const askPanel = page.locator('[data-ask="open"]');
    await expect(askPanel).toBeVisible();

    await askPanel.getByRole("textbox").fill("What oil should I use?");
    await askPanel.getByRole("button", { name: "Send" }).click();
    await expect(askPanel.locator('[data-from="sous"]').last()).toContainText(
      "Couldn't reach Sous.",
    );

    const homeId = await getHomeKitchenId();
    const loggedContext = await readLatestUserConversationContext(homeId);
    expect(loggedContext).not.toBeNull();
    expect(loggedContext).toContain("We avoid peanuts.");
  });

  test("PKG1-4: QueueScreen Private toggle behind Edit persists isPrivate on kitchen_queue", async ({
    page,
  }) => {
    const p1 = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    expect(p1).not.toBeNull();

    await page.goto("/kitchen");
    await page.getByRole("button", { name: "Up next · 4" }).click();
    const queueScreen = page.locator("[data-queue-screen]");
    await expect(queueScreen).toBeVisible();

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const privateBtn = queueScreen.locator(`[data-queue-private="${p1!.id}"]`);
    await expect(privateBtn).toBeVisible();
    await expect(privateBtn).toHaveAttribute("aria-pressed", "false");

    await privateBtn.click();
    await expect(privateBtn).toHaveAttribute("aria-pressed", "true");
    expect(await readQueueRecipePrivate(p1!.id)).toBe(true);

    // Reload and verify Private flag stays persisted on the queue row
    await page.reload();
    await page.getByRole("button", { name: "Up next · 4" }).click();
    await expect(page.locator("[data-queue-screen]")).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const reloadedPrivateBtn = page
      .locator("[data-queue-screen]")
      .locator(`[data-queue-private="${p1!.id}"]`);
    await expect(reloadedPrivateBtn).toHaveAttribute("aria-pressed", "true");

    // Toggle back off and verify DB update
    await reloadedPrivateBtn.click();
    await expect(reloadedPrivateBtn).toHaveAttribute("aria-pressed", "false");
    expect(await readQueueRecipePrivate(p1!.id)).toBe(false);
  });
});
