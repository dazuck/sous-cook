import { expect, type Page } from "@playwright/test";

/**
 * Waits until a page is visually still before taking a screenshot:
 * 1. Every font face declared in document.fonts has loaded and document.fonts.ready has settled.
 * 2. No cross-fading ghost copy of a leaving cook step line remains in the DOM
 *    (CookFlow.tsx ghostOf removes data-line from the cloned [data-role="now"] node).
 * 3. Two animation frames have painted after the conditions above.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((face) => face.load()));
    await document.fonts.ready;
  });

  await expect(page.locator('[data-role="now"]:not([data-line])')).toHaveCount(0);

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}
