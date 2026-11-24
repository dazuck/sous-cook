import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { liveNowLine } from "./cook-helpers";
import { readQueueRowByName } from "./db";
import { installFakeSpeech } from "./fake-speech";
import { RECIPE_NAMES } from "./seed-data";

/**
 * Ask Sous's mic where voice listens only on a tap (Android, the tablet): the
 * capsule's mic on the top line opens Ask listening, and the panel's own mic
 * stops or starts a listen beside the box. Commands are heard through the
 * recognizer the spec talks to (`fake-speech.ts`). The rules are unit-tested
 * in `src/components/kitchen/AskSous.test.tsx` and
 * `src/hooks/useKitchenVoiceCommands.test.ts`.
 */

const capsule = (page: Page): Locator => page.locator("[data-ask-capsule]");
const capsuleWords = (page: Page): Locator => capsule(page).getByRole("button", { name: "Ask Sous", exact: true });
const capsuleMic = (page: Page): Locator => capsule(page).locator("[data-voice]");
const panel = (page: Page): Locator => page.locator('[data-ask="open"]');
const box = (page: Page): Locator => panel(page).getByRole("textbox", { name: "Your question for Sous", exact: true });
const close = (page: Page): Locator => panel(page).getByRole("button", { name: "Close Ask Sous", exact: true });
const panelMic = (page: Page): Locator => panel(page).locator("[data-ask-input] [data-voice]");
const heard = (page: Page): Locator => panel(page).locator("[data-ask-heard]");
const listening = (page: Page) => page.evaluate(() => window.__speech.listening());

/** Thin White Sauce on its first cooking step, voice ready for a tap. */
async function toFirstStep(page: Page) {
  const row = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
  await page.goto(`/kitchen/queue/${row!.id}`);
  await page.locator("[data-opening-start]").click();
  await page.getByRole("button", { name: "Next step" }).click();
  await expect(liveNowLine(page).locator("[data-prep-eyebrow]")).toHaveCount(0);
  await expect(capsuleMic(page)).toHaveAttribute("data-voice", "ready");
  await expect(capsuleMic(page)).toHaveAttribute("aria-label", "Talk to Sous");
}

test.describe("Ask's mic on Android, where a tap starts each listen", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installFakeSpeech);
  });

  test("ASK-1: closing Ask mid-listen ends the listen, so nothing said afterwards runs", async ({ page }) => {
    await toFirstStep(page);
    const step = await liveNowLine(page).getAttribute("data-line");
    await capsuleWords(page).click();
    await expect(panel(page)).toBeVisible();
    await panelMic(page).click();
    await expect(panelMic(page)).toHaveAttribute("data-voice", "hearing");
    expect(await listening(page)).toBe(1);

    await close(page).click();
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => listening(page), "the listen ended with Ask").toBe(0);
    await expect(capsuleMic(page)).toHaveAttribute("data-voice", "ready");
    // Nothing is left to hear a remark made afterwards: the recognizer refuses one with no listen.
    await expect(page.evaluate(() => window.__speech.say("next"))).rejects.toThrow(/nothing is listening/);
    await expect(liveNowLine(page)).toHaveAttribute("data-line", step!);
    await expect(panel(page)).toHaveCount(0);
  });

  test("ASK-2: beside a draft kept in the box, the capsule's listen still closes Ask by itself; stopped from the panel's mic, the cook is left in the box", async ({
    page,
  }) => {
    await toFirstStep(page);
    await capsuleWords(page).click();
    await box(page).fill("How hot should the pan");
    await close(page).click();
    await expect(panel(page)).toHaveCount(0);

    // Nothing heard: Ask closes once the line clears, draft or no draft, and the capsule's mic keeps the focus.
    await capsuleMic(page).click();
    await expect(heard(page)).toHaveText("Listening…");
    await expect(box(page)).toHaveValue("How hot should the pan");
    await page.evaluate(() => window.__speech.fail("no-speech"));
    await expect(heard(page)).toHaveText("Didn't hear anything");
    await expect(panel(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(capsuleMic(page)).toBeFocused();

    // The cook stops the listen from the panel's mic: the mic gives way to Send, and the focus is in the box.
    await capsuleMic(page).click();
    await expect(panelMic(page)).toHaveAttribute("data-voice", "hearing");
    await panelMic(page).click();
    await expect(box(page)).toBeFocused();
    await expect(panel(page)).toBeVisible();
    await expect(box(page)).toHaveValue("How hot should the pan");
  });
});
