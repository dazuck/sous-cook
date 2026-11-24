import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { liveNowLine } from "./cook-helpers";
import { readQueueRowByName } from "./db";
import { RECIPE_NAMES } from "./seed-data";

/**
 * The pull between the peek and the whole cook (CookSheet.tsx, pull-travel.ts, pull-paint.ts): under the
 * finger the peek's rows turn into the meal's lines. Gestures go through the DevTools protocol as the
 * tablet sends them, so the sheet's pointer events fire. Every recipe in the seed is one dish.
 */

/** Opens a queued recipe on its first cooking step (past the opening, when it has one, and the prep page). */
async function openFirstStep(page: Page, name: string, opening: boolean) {
  const row = await readQueueRowByName(name);
  expect(row).not.toBeNull();
  await page.goto(`/kitchen/queue/${row!.id}`);
  if (opening) await page.locator("[data-opening-start]").click();
  await expect(liveNowLine(page)).toBeVisible();
  await page.getByRole("button", { name: "Next step" }).click();
  await expect(liveNowLine(page).locator("[data-prep-eyebrow]")).toHaveCount(0);
}

const sheet = (page: Page) => page.locator("[data-cook-sheet]");
const depthOf = async (page: Page) => Number(await page.locator("[data-sheet]").getAttribute("data-depth"));

/** Waits until the sheet came to rest on level k (its layout settles 400 ms after landing). */
async function restsAt(page: Page, k: number) {
  await expect(sheet(page)).toHaveAttribute("data-level", String(k));
  await expect(sheet(page)).toHaveAttribute("data-settled", String(k));
  await page.waitForTimeout(450);
}

/** A one-finger touch as the tablet sends it, held between moves. */
async function touch(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  let at = { x: 0, y: 0 };
  return {
    async start(p: { x: number; y: number }) {
      at = p;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
    },
    async moveTo(p: { x: number; y: number }, steps: number, ms: number) {
      const from = at;
      for (let i = 1; i <= steps; i++) {
        await page.waitForTimeout(ms);
        at = { x: from.x + ((p.x - from.x) * i) / steps, y: from.y + ((p.y - from.y) * i) / steps };
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at] });
      }
    },
    async end() {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    },
  };
}

/**
 * Holds a pull from rest at depth d (1 the peek, 2 the whole cook), finger down, by the sheet's own
 * detents (`data-detents`, px from the top), and returns the touch to let go.
 */
async function holdAt(page: Page, d: number) {
  const det = (await sheet(page).getAttribute("data-detents"))!.split(",").map(Number);
  const k = Math.min(det.length - 2, Math.floor(d));
  const y = det[k]! + (det[k + 1]! - det[k]!) * (d - k);
  const band = (await page.locator("[data-cook-band]").boundingBox())!;
  const x = band.x + band.width / 2;
  const y0 = det[0]! + 20;
  const t = await touch(page);
  await t.start({ x, y: y0 });
  await t.moveTo({ x, y: y0 + (y - det[0]!) }, 14, 40);
  await page.waitForTimeout(350);
  return t;
}

/** Opacity as drawn: the element's own times its parents', 0 where it or a parent is hidden. */
async function drawnOpacity(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    let op = 1;
    for (let e: Element | null = node; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.visibility === "hidden" || cs.display === "none") return 0;
      op *= Number(cs.opacity);
    }
    return op;
  });
}

async function placeOf(el: Locator) {
  const b = (await el.boundingBox())!;
  return { x: b.x, y: b.y };
}

/**
 * What the pull left on the page: a part it moves still carrying a style of its own (a transform, an
 * opacity, the point it scales about), or a set still kept from touch and a screen reader.
 */
async function pullStyles(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parts = [
      ...document.querySelectorAll<HTMLElement | SVGElement>(
        "[data-sheet] [data-peek] li, [data-sheet] [data-peek] li *, [data-sheet] [data-peek-rail], [data-sheet] [data-whole-lines] [data-meal-lines] *",
      ),
    ]
      .filter((el) => el.style.transform !== "" || el.style.opacity !== "" || el.style.transformOrigin !== "" || el.style.transformBox !== "")
      .map((el) => `${el.tagName.toLowerCase()} ${el.getAttribute("style")}`);
    const hushed = [...document.querySelectorAll("[data-sheet] [data-peek], [data-sheet] [data-overview]")]
      .filter((el) => el.closest('[aria-hidden="true"], [inert]'))
      .map((el) => `kept from a cook: ${el.hasAttribute("data-peek") ? "the peek" : "the whole cook"}`);
    return [...parts, ...hushed];
  });
}

interface Reading {
  depth: number;
  /** Which of the two sets a cook can reach (touch, a screen reader): the peek's rows, the whole cook. */
  peek: boolean;
  whole: boolean;
  /** How much of the peek's rows is drawn: its most drawn row's words. */
  rows: number;
  /** The whole cook's way back at the top left: how much is drawn, and whether a touch on its place lands on it. */
  back: { op: number; hit: boolean } | null;
  /** The two dish names: the top line's and the whole cook's own. */
  names: [number, number];
  /** The words of the peek's rows and of the meal's stops standing to be read (drawn at 0.75 or more, on the sheet, over the foot). */
  read: string[];
}

async function reading(page: Page, wholeSel: string): Promise<Reading> {
  return page.evaluate((wholeSel) => {
    const drawn = (el: Element | null) => {
      if (!el) return 0;
      let op = 1;
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.visibility === "hidden" || cs.display === "none") return 0;
        op *= Number(cs.opacity);
      }
      return op;
    };
    const said = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el || el.closest('[aria-hidden="true"], [inert]')) return false;
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).visibility === "hidden") return false;
      return true;
    };
    const rows = [...document.querySelectorAll("[data-sheet] [data-peek] li[data-peek-row]")].map((li) =>
      drawn(li.querySelector("[data-peek-label]") ?? li.querySelector("[data-peek-words]") ?? li),
    );
    const backEl = document.querySelector<HTMLElement>("[data-sheet] [data-overview-back]");
    let back: { op: number; hit: boolean } | null = null;
    if (backEl) {
      const r = backEl.getBoundingClientRect();
      back = { op: drawn(backEl), hit: !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("[data-overview-back]") };
    }
    const box = document.querySelector("[data-sheet]")!.getBoundingClientRect();
    const foot = document.querySelector("div[data-foot]")?.getBoundingClientRect().top ?? window.innerHeight;
    const read: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("[data-sheet] [data-peek] [data-peek-label], [data-sheet] [data-whole-lines] [data-line-stop]")) {
      const r = el.getBoundingClientRect();
      if (drawn(el) >= 0.75 && r.top >= box.top && r.top < foot && r.left >= 0 && r.right <= window.innerWidth + 1) read.push((el.textContent ?? "").trim().slice(0, 40));
    }
    return {
      depth: Number(document.querySelector("[data-sheet]")!.getAttribute("data-depth")),
      peek: said("[data-sheet] [data-peek]"),
      whole: said(wholeSel),
      rows: Math.max(0, ...rows),
      back,
      names: [drawn(document.querySelector("[data-cook-header]")), drawn(document.querySelector("[data-sheet] [data-whole-title]"))] as [number, number],
      read,
    };
  }, wholeSel);
}

/** Lets a held pull go: it lands on a level and nothing of the pull is left there; then back to the step. */
async function letGo(page: Page, t: Awaited<ReturnType<typeof touch>>, from: number) {
  await t.end();
  await page.waitForTimeout(900);
  const landed = await depthOf(page);
  expect([0, 1, 2], `let go at ${from}, it rests at a level`).toContain(landed);
  expect(await pullStyles(page), `let go at ${from}, at rest at level ${landed} every part stands as drawn`).toEqual([]);
  await page.keyboard.press("Escape");
  await restsAt(page, 0);
  expect(await pullStyles(page), "back on the step every part stands as drawn").toEqual([]);
}

test.describe("The pull between the peek and the whole cook", () => {
  const row = (page: Page) => page.locator("[data-sheet] [data-peek] li[data-peek-now] [data-peek-label]");
  const stop = (page: Page) => page.locator('[data-sheet] [data-whole-lines] [data-line-stop][data-stop-state="now"]');
  /** The stop's own words (the list's label, beside its dish and its minutes): where the row's words land. */
  const stopWords = (page: Page) => stop(page).locator("p:not([data-line-dish])").first();

  test("PULL-1: at rest at the peek and at the whole cook every part stands as drawn and both sets can be reached; the step in hand's row and its stop stand apart", async ({
    page,
  }) => {
    await openFirstStep(page, RECIPE_NAMES.thinWhiteSauce, true);
    await page.keyboard.press("ArrowUp");
    await restsAt(page, 1);
    expect(await pullStyles(page), "at the peek").toEqual([]);
    expect(await drawnOpacity(row(page)), "the step in hand's row at the peek").toBeGreaterThan(0.95);
    const from = await placeOf(row(page));
    // The peek's rows can be reached; the whole cook is not drawn here, and nothing is kept from a cook (above).
    const atPeek = await reading(page, "[data-sheet] [data-overview]");
    expect([atPeek.peek, atPeek.whole], "reachable at the peek").toEqual([true, false]);

    await page.keyboard.press("ArrowUp");
    await restsAt(page, 2);
    expect(await pullStyles(page), "at the whole cook").toEqual([]);
    expect(await drawnOpacity(stop(page)), "the step in hand's stop at the whole cook").toBeGreaterThan(0.95);
    const to = await placeOf(stopWords(page));
    // And here the whole cook, its way back taking a touch; the peek is not drawn.
    const atWhole = await reading(page, "[data-sheet] [data-overview]");
    expect([atWhole.peek, atWhole.whole], "reachable at the whole cook").toEqual([false, true]);
    expect(atWhole.back, "the whole cook's way back").toEqual({ op: 1, hit: true });
    expect(Math.hypot(from.x - to.x, from.y - to.y), "the row's place and its stop's are apart").toBeGreaterThan(40);
  });

  const DEPTHS = [1.25, 1.5, 1.7, 1.8, 1.9];

  test("PULL-2: one drag from the peek to the whole cook: the row travels to its stop, the sheet always has words to read, one dish name stands at a time, the drawn set is the one that can be reached, and a let-go rests on a level", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openFirstStep(page, RECIPE_NAMES.thinWhiteSauce, true);
    await page.keyboard.press("ArrowUp");
    await restsAt(page, 1);
    const from = await placeOf(row(page));
    await page.keyboard.press("ArrowUp");
    await restsAt(page, 2);
    const to = await placeOf(stopWords(page));
    await page.keyboard.press("Escape");
    await restsAt(page, 0);

    const seen: Reading[] = [];
    const rowAt: { x: number; y: number; op: number }[] = [];
    const stopAt: { x: number; y: number; op: number }[] = [];
    for (const d of DEPTHS) {
      const t = await holdAt(page, d);
      const got = await reading(page, "[data-sheet] [data-overview]");
      seen.push(got);
      rowAt.push({ ...(await placeOf(row(page))), op: await drawnOpacity(row(page)) });
      stopAt.push({ ...(await placeOf(stopWords(page))), op: await drawnOpacity(stopWords(page)) });
      expect(got.depth, `held at ${d}`).toBeGreaterThan(d - 0.04);
      expect(got.depth, `held at ${d}`).toBeLessThan(d + 0.04);
      // Never an empty sheet, and one dish name in the bar at a time.
      expect(got.read.length, `words to read at ${got.depth}`).toBeGreaterThan(0);
      expect(Math.min(...got.names), `the top line's name and the whole cook's own at ${got.depth}: ${got.names.join(", ")}`).toBeLessThan(0.05);
      // Between the levels one set can be reached, never both or neither: the whole cook once its
      // header (where its way back is) is drawn more than the peek's rows, and until then the peek.
      // (On a one-dish meal the peek's rows stay the reachable set for a while after they have gone:
      // a known limit, docs/browser-tests.md.)
      expect(got.peek !== got.whole, `one set reachable at ${got.depth}`).toBe(true);
      const back = got.back!;
      if (back.op > 0.02 && back.op > got.rows + 0.05) expect(got.whole, `the header drawn ${back.op}, the rows ${got.rows}, at ${got.depth}`).toBe(true);
      if (back.op <= 0.02 || got.rows > back.op + 0.05) expect(got.peek, `the rows drawn ${got.rows}, the header ${back.op}, at ${got.depth}`).toBe(true);
      // The way back takes a touch only where the whole cook can be reached: unseen, a touch on it would drop the sheet to rest.
      expect(back.hit, `the way back, drawn ${back.op}, takes a touch at ${got.depth}`).toBe(got.whole);
      await letGo(page, t, d);
    }
    // The hand-over happens once, from the peek to the whole cook.
    expect(seen.map((g) => (g.whole ? "whole" : "peek"))).toEqual(["peek", "peek", "peek", "peek", "whole"]);

    const between = (v: number, a: number, b: number) => v > Math.min(a, b) + 1 && v < Math.max(a, b) - 1;
    const apart = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
    // A quarter of the way the step in hand's row rides up whole, on its way across and up to its
    // stop's words, and its stop does not stand by itself yet.
    expect(rowAt[0]!.op, "the row at 1.25").toBeGreaterThan(0.95);
    expect(stopAt[0]!.op, "its stop at 1.25").toBeLessThan(0.1);
    expect(between(rowAt[0]!.y, from.y, to.y), `the row at 1.25: y ${rowAt[0]!.y} between ${from.y} and ${to.y}`).toBe(true);
    expect(between(rowAt[0]!.x, from.x, to.x), `the row at 1.25: x ${rowAt[0]!.x} between ${from.x} and ${to.x}`).toBe(true);
    // Half-way it is still rising; its words and its stop's are the same, so they hand over at one place.
    expect(between(rowAt[1]!.y, from.y, to.y), `the row at 1.5: y ${rowAt[1]!.y} between ${from.y} and ${to.y}`).toBe(true);
    expect(apart(rowAt[1]!, stopAt[1]!), "the row's words and its stop's, handing over").toBeLessThan(1.5);
    expect(rowAt[1]!.op + stopAt[1]!.op, "one for the other").toBeCloseTo(1, 1);
    expect(Math.min(rowAt[1]!.op, stopAt[1]!.op), "both part-drawn half-way").toBeGreaterThan(0.15);
    // From seven tenths on the row has landed on its stop's words, and they are the ones drawn.
    for (const i of [2, 3, 4]) {
      expect(apart(rowAt[i]!, to), `the row at ${DEPTHS[i]} on its stop's words`).toBeLessThan(1.5);
      expect(rowAt[i]!.op, `the row at ${DEPTHS[i]}`).toBeLessThan(0.05);
      expect(stopAt[i]!.op, `its stop at ${DEPTHS[i]}`).toBeGreaterThan(0.95);
      expect(apart(stopAt[i]!, to), `its stop at ${DEPTHS[i]} stands in its place`).toBeLessThan(1.5);
    }
  });

  test("PULL-3: as written, between the levels the peek's rows can be reached until the outline is drawn, then the outline", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openFirstStep(page, RECIPE_NAMES.sesameGreenBeans, false);
    for (const [d, want] of [
      [1.3, [true, false]],
      // The outline (the sheet's own rows) comes in over the last part of the pull: until it shows, the peek's rows are the ones there.
      [1.6, [true, false]],
      [1.95, [false, true]],
    ] as const) {
      const t = await holdAt(page, d);
      const got = await reading(page, "[data-sheet] [data-label]");
      expect([got.peek, got.whole], `reachable at ${got.depth}`).toEqual(want);
      await letGo(page, t, d);
    }
  });
});
