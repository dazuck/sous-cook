import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { readQueueRowByName } from "./db";
import { RECIPE_NAMES } from "./seed-data";

// What this spec checks is the repository as it ships, built without the clip files.
const CLIP_DIR = join(__dirname, "../public/sounds/sue");
const clipsMadeHere = existsSync(CLIP_DIR) && readdirSync(CLIP_DIR).some((f) => f.endsWith(".mp3"));

test.describe("Voice replies", () => {
  test.skip(clipsMadeHere, "clips have been made in this checkout (app/public/sounds/sue); this spec checks the repository without them");

  test("VOICE-1: as shipped, with no clip files: Sounds and voice isn't offered, a stored choice of it reads as Sounds, and no clip is asked for", async ({
    page,
  }) => {
    // The fixtures fail the test on any console error, so none may be said here either.
    const clipRequests: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/sounds/")) clipRequests.push(r.url());
    });

    const p1 = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    await page.goto(`/kitchen/queue/${p1!.id}`);
    await expect(page.locator("[data-opening-start]")).toBeVisible();

    // The build decided it has no clips (next.config.ts): the row goes Sounds, Off, Sounds.
    const more = page.locator("[data-sheet-more]").getByRole("button", { name: "More" });
    await more.click();
    const replies = page.getByRole("button", { name: /^Sue's replies:/ });
    await expect(replies).toHaveText("Sue's replies: Sounds");
    await replies.click();
    await expect(replies).toHaveText("Sue's replies: Off");
    expect(await page.evaluate(() => localStorage.getItem("sous-sue-replies"))).toBe("off");
    await replies.click();
    await expect(replies).toHaveText("Sue's replies: Sounds");

    // A device that chose Sounds and voice under a build that had the clips: it reads as Sounds.
    await page.evaluate(() => localStorage.setItem("sous-sue-replies", "voice"));
    await page.reload();
    await expect(page.locator("[data-opening-start]")).toBeVisible();
    await more.click();
    await expect(replies).toHaveText("Sue's replies: Sounds");
    expect(await page.evaluate(() => localStorage.getItem("sous-sue-replies"))).toBe("voice");

    // The cook carries on: out of the menu, Start opens the first screen.
    await page.keyboard.press("Escape");
    await page.locator("[data-opening-start]").click();
    await expect(page.getByRole("button", { name: "Next step" })).toBeVisible();
    expect(clipRequests).toEqual([]);
  });
});
