import type { Locator, Page } from "@playwright/test";

/**
 * Returns the live current step line in cook mode.
 * For about 320 ms after each step change, CookFlow cross-fades out a cloned
 * ghost of the leaving line. Both carry data-role="now", while ghostOf()
 * removes data-line from the ghost, so requiring [data-line] selects only the
 * live line.
 */
export function liveNowLine(page: Page): Locator {
  return page.locator('[data-role="now"][data-line]');
}
