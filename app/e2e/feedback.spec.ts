import { test, expect } from "./fixtures";
import { getHomeKitchenId, readLatestCookReport } from "./db";

test.describe("Universal feedback from HomeRail and Settings", () => {
  test("FEEDBACK-1: submits a typed feedback note from HomeRail into ReportsPanel and persists it in cook_reports", async ({
    page,
  }) => {
    await page.goto("/kitchen");
    await page.locator("[data-rail-pull]").click();
    await page.getByRole("menuitem", { name: "Send feedback" }).click();

    const dialog = page.locator("dialog[data-feedback-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Note (optional)").fill("Clock felt tucked away on home");
    await dialog.locator("[data-feedback-send]").click();
    await expect(dialog).toHaveCount(0);

    const flaggedEntry = page.getByRole("button", { name: "1 flagged screen" });
    await expect(flaggedEntry).toBeVisible();

    const kitchenId = await getHomeKitchenId();
    await expect
      .poll(async () => (await readLatestCookReport(kitchenId))?.note ?? null)
      .toBe("Clock felt tucked away on home");
    const stored = await readLatestCookReport(kitchenId);
    expect(stored?.screen).toBe("kitchen");
    expect(stored?.path).toBe("/kitchen");

    await flaggedEntry.click();
    await expect(page.locator("[data-reports-list]")).toBeVisible();
    await expect(page.locator("[data-report-subject]")).toContainText("Kitchen");
    await expect(page.locator("[data-report-note]")).toContainText(
      "Clock felt tucked away on home",
    );
  });

  test("FEEDBACK-2: flags Settings for later with a blank note and persists the report", async ({
    page,
  }) => {
    await page.goto("/kitchen/settings");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

    await page.locator("[data-settings-feedback] [data-feedback-trigger]").click();
    const dialog = page.locator("dialog[data-feedback-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-feedback-flag-later]").click();
    await expect(dialog).toHaveCount(0);

    const kitchenId = await getHomeKitchenId();
    await expect
      .poll(async () => (await readLatestCookReport(kitchenId))?.screen ?? null)
      .toBe("settings");
    const stored = await readLatestCookReport(kitchenId);
    expect(stored?.note).toBe("");
    expect(stored?.path).toBe("/kitchen/settings");
  });
});
