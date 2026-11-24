import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { readQueueRowByName } from "./db";
import { RECIPE_NAMES } from "./seed-data";

// What this spec checks is the repository as it ships, with no clip files.
const CLIP_DIR = join(__dirname, "../public/sounds/sue");
const clipsMadeHere = existsSync(CLIP_DIR) && readdirSync(CLIP_DIR).some((f) => f.endsWith(".mp3"));

test.describe("Voice replies", () => {
  test.skip(clipsMadeHere, "clips have been made in this checkout (app/public/sounds/sue); this spec checks the repository without them");

  test("VOICE-1: as shipped, with no clip files: Sounds fetches none; Sounds and voice fetches each once a page and says each missing one once, the device keeps it, and the cook carries on", async ({
    page,
    allowConsoleError,
  }) => {
    // The clips are not in this repository (docs/voice-replies.md): each answers 404,
    // and the page says so once per clip (app/src/lib/kitchen/ack-audio.ts). Service
    // workers are blocked in these specs; the worker's keeping of the clips, and of
    // none that are missing, is app/src/lib/pwa/sw.test.ts.
    allowConsoleError(/^Failed to load resource: the server responded with a status of 404/);
    const missing: string[] = [];
    page.on("console", (m) => {
      const said = /^Sue's clip "([^"]+)" didn't load/.exec(m.text());
      if (m.type() === "error" && said) missing.push(said[1]!);
    });
    allowConsoleError(/^Sue's clip "[^"]+" didn't load/);
    const clipRequests: { url: string; status: number }[] = [];
    page.on("response", (r) => {
      if (new URL(r.url()).pathname.startsWith("/sounds/")) clipRequests.push({ url: r.url(), status: r.status() });
    });

    const p1 = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    await page.goto(`/kitchen/queue/${p1!.id}`);
    await expect(page.locator("[data-opening-start]")).toBeVisible();

    // Sounds is the default, and fetches no clip (app/src/hooks/useKitchenVoiceCommands.ts: the warm effect).
    const more = page.locator("[data-sheet-more]").getByRole("button", { name: "More" });
    await more.click();
    const replies = page.getByRole("button", { name: /^Sue's replies:/ });
    await expect(replies).toHaveText("Sue's replies: Sounds");
    expect(clipRequests).toEqual([]);

    // A press moves it on to Sounds and voice; the menu stays open to show it.
    await replies.click();
    await expect(replies).toHaveText("Sue's replies: Sounds and voice");
    await expect.poll(() => clipRequests.length).toBe(17);
    expect(clipRequests.every((r) => r.status === 404)).toBe(true);
    expect(new Set(clipRequests.map((r) => r.url)).size).toBe(17);
    await expect.poll(() => missing.length).toBe(17);
    expect(new Set(missing).size).toBe(17);
    expect(await page.evaluate(() => localStorage.getItem("sous-sue-replies"))).toBe("voice");

    // The cook carries on: out of the menu, Start opens the first screen, and nothing is fetched or said again.
    await page.keyboard.press("Escape");
    await page.locator("[data-opening-start]").click();
    await expect(page.getByRole("button", { name: "Next step" })).toBeVisible();
    expect(clipRequests).toHaveLength(17);
    expect(missing).toHaveLength(17);

    // The device keeps the setting: a fresh page reads it back, and tries the clips once more.
    await page.reload();
    await page.locator("[data-sheet-more]").getByRole("button", { name: "More" }).click();
    await expect(replies).toHaveText("Sue's replies: Sounds and voice");
    await expect.poll(() => clipRequests.length).toBe(34);
    await expect.poll(() => missing.length).toBe(34);
    expect(new Set(clipRequests.slice(17).map((r) => r.url)).size).toBe(17);
  });
});
