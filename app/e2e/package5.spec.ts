import { test, expect } from "./fixtures";
import { RECIPE_NAMES } from "./seed-data";

test.describe("Package 5: Pantry, shopping list, and saved ideas", () => {
  test("PKG5-1: Add ingredients shows empty state and persists manual pantry items across reload", async ({
    page,
  }) => {
    await page.goto("/kitchen");

    await page.locator("[data-rail-pull]").click();
    await page
      .locator("[data-rail-tab]")
      .getByRole("menuitem", { name: "Add ingredients" })
      .click();

    const dialog = page.getByRole("dialog", { name: "Add ingredients" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Nothing in the pantry yet.")).toBeVisible();

    await dialog.getByRole("button", { name: "Add items by hand" }).click();
    await expect(dialog.getByText("Review ingredients")).toBeVisible();

    const inputs = dialog.getByPlaceholder("Ingredient name and quantity");
    await inputs.first().fill("2 avocados");

    await dialog.getByRole("button", { name: "+ Add another item" }).click();
    await inputs.nth(1).fill("frozen peas");
    const selects = dialog.locator("select");
    await selects.nth(1).selectOption("Freezer");

    await dialog.getByRole("button", { name: "Add 2 items to pantry" }).click();
    await expect(dialog).toBeHidden();

    // Reopen and verify stored pantry sections and items, then reload and check again.
    await page.locator("[data-rail-pull]").click();
    await page
      .locator("[data-rail-tab]")
      .getByRole("menuitem", { name: "Add ingredients" })
      .click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Nothing in the pantry yet.")).toHaveCount(0);
    await expect(dialog.getByRole("heading", { name: "Fridge" })).toBeVisible();
    await expect(dialog.getByText("2 avocados")).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Freezer" })).toBeVisible();
    await expect(dialog.getByText("frozen peas")).toBeVisible();

    await page.reload();
    await page.locator("[data-rail-pull]").click();
    await page
      .locator("[data-rail-tab]")
      .getByRole("menuitem", { name: "Add ingredients" })
      .click();
    await expect(dialog.getByText("2 avocados")).toBeVisible();
    await expect(dialog.getByText("frozen peas")).toBeVisible();
  });

  test("PKG5-2: Shopping list shows empty state, groups by aisle and recipe, persists, removes, and clears", async ({
    page,
  }) => {
    await page.goto("/kitchen");

    await page.locator("[data-rail-pull]").click();
    await page
      .locator("[data-rail-tab]")
      .getByRole("menuitem", { name: "Shopping list" })
      .click();

    const dialog = page.getByRole("dialog", { name: "Shopping list" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Shopping list is empty.")).toBeVisible();

    const itemInput = dialog.getByLabel("Item to buy");
    const forInput = dialog.getByLabel("For recipe or store");
    const addButton = dialog.getByRole("button", { name: "Add", exact: true });

    await itemInput.fill("Lemons (2)");
    await forInput.fill("Tuesday beans");
    await addButton.click();

    await expect(dialog.getByRole("heading", { name: "Produce" })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /Lemons \(2\)/ }),
    ).toBeVisible();

    await itemInput.fill("Paper towels");
    await addButton.click();

    await expect(dialog.getByRole("heading", { name: "Other" })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /Paper towels/ }),
    ).toBeVisible();

    // Switch to By recipe grouping.
    await dialog.getByRole("button", { name: "By recipe" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Tuesday beans" }),
    ).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible();

    // Reload via ?shopping=true and confirm persistence.
    await page.goto("/kitchen?shopping=true");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /Lemons \(2\)/ }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /Paper towels/ }),
    ).toBeVisible();

    // Remove Lemons (2), leaving Paper towels.
    await dialog.getByRole("button", { name: /Lemons \(2\)/ }).click();
    await expect(
      dialog.getByRole("button", { name: /Lemons \(2\)/ }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: /Paper towels/ }),
    ).toBeVisible();

    // Two-tap Clear all empties the list.
    await dialog.getByRole("button", { name: "Clear all" }).click();
    await dialog.getByRole("button", { name: "Tap again to clear" }).click();
    await expect(dialog.getByText("Shopping list is empty.")).toBeVisible();
  });

  test("PKG5-3: Saved for later shows empty state and saves an imported recipe as inspiration across reload", async ({
    page,
    recipeSite,
  }) => {
    await page.goto("/kitchen");

    await page.locator("[data-rail-pull]").click();
    await page
      .locator("[data-rail-tab]")
      .getByRole("menuitem", { name: "Saved for later" })
      .click();

    const savedDialog = page.getByRole("dialog", { name: "Saved for later" });
    await expect(savedDialog).toBeVisible();
    await expect(
      savedDialog.getByText(
        "No recipe ideas yet. Save a recipe as inspiration to add it here.",
      ),
    ).toBeVisible();

    await savedDialog
      .getByRole("button", { name: "Back to the kitchen" })
      .click();
    await expect(savedDialog).toBeHidden();

    // Import a local JSON-LD recipe and save it as inspiration.
    await page.getByRole("button", { name: "Import recipe" }).click();
    const importDialog = page.getByRole("dialog", { name: "Import recipe" });
    await expect(importDialog).toBeVisible();

    await importDialog.getByRole("textbox").fill(recipeSite.peaSoupUrl);
    await importDialog.getByRole("button", { name: "Import recipe" }).click();
    await expect(
      importDialog.getByRole("heading", {
        level: 3,
        name: RECIPE_NAMES.weeknightPeaSoup,
      }),
    ).toBeVisible();

    await importDialog
      .getByRole("button", { name: "Save as inspiration" })
      .click();
    await expect(importDialog).toBeHidden();

    // Reopen Saved for later and verify persistence across reload.
    await page.locator("[data-rail-pull]").click();
    await page
      .locator("[data-rail-tab]")
      .getByRole("menuitem", { name: "Saved for later" })
      .click();
    await expect(savedDialog).toBeVisible();
    await expect(
      savedDialog.getByText("1 idea in your saved ideas"),
    ).toBeVisible();
    await expect(
      savedDialog.getByText(
        `${RECIPE_NAMES.weeknightPeaSoup} — ${recipeSite.peaSoupUrl}`,
      ),
    ).toBeVisible();

    await page.reload();
    await page.locator("[data-rail-pull]").click();
    await page
      .locator("[data-rail-tab]")
      .getByRole("menuitem", { name: "Saved for later" })
      .click();
    await expect(
      savedDialog.getByText(
        `${RECIPE_NAMES.weeknightPeaSoup} — ${recipeSite.peaSoupUrl}`,
      ),
    ).toBeVisible();
  });
});
