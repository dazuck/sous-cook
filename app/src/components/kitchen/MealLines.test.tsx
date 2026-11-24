// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialCookState, next } from "@/lib/kitchen/cook-view";
import { parseCookPlan, type CookPlan } from "@/lib/kitchen/cook-plan";
import { strip } from "@/lib/kitchen/cook-strip";
import { mealLines } from "@/lib/kitchen/meal-lines";
import { layoutMealLines, type ColumnsDrawing } from "@/lib/kitchen/meal-lines-layout";
import { advanceMeasure as measure } from "@/lib/kitchen/__tests__/advance-measure";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "@/lib/kitchen/__tests__/load-cook-plan-fixtures";
import { MealLines } from "./MealLines";

afterEach(cleanup);

function corpusPlan(name: string): CookPlan {
  const fixture = loadCookPlanFixtures().find((f) => f.name === name)!;
  const parsed = parseCookPlan(loadCookPlanSnapshots().get(name)!.raw, fixture.recipe);
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return parsed.plan;
}

describe("the whole meal's lines, drawn", () => {
  it("a step two dishes share, in hand, is Ember on both its lines (review: bug 7a; the roast's chicken and potatoes)", () => {
    const roast = corpusPlan("sunday-roast-dinner");
    const c = Math.min(1280 / 960, 800 / 600);
    const room = { W: 1280 - 2 * 44 * c, H: 560, c, narrow: false };
    // Next through the cook to the shared step in hand.
    let s = initialCookState("first");
    let L = mealLines(roast, strip(roast, s));
    for (let i = 0; i < 40 && !L.stops.some((q) => q.state === "now" && q.also.length); i++) {
      s = next(roast, s);
      L = mealLines(roast, strip(roast, s));
    }
    const shared = L.stops.find((q) => q.state === "now" && q.also.length)!;
    expect(shared.label).toBe("Roast chicken and potatoes");
    const d = layoutMealLines(L, room, measure) as ColumnsDrawing;
    const { container } = render(<MealLines drawing={d} c={c} onRead={() => {}} readMark={null} tab={0} />);
    const dots = [...container.querySelectorAll(`[data-line-share="${shared.key}"] circle`)];
    expect(dots.length).toBe(shared.also.length);
    for (const dot of dots) expect(dot.getAttribute("fill")).toBe("var(--ember)");
    // Its own line's dot is Ember too, at the same size.
    const own = d.stops.find((x) => x.key === shared.key)!;
    expect(Number(dots[0].getAttribute("r"))).toBeCloseTo(own.dotR);
  });

  it("to a screen reader at the whole cook each stop is said once, by its button, and the step in hand is the current one; on the opening the words are read", () => {
    const roast = corpusPlan("sunday-roast-dinner");
    const c = Math.min(1280 / 960, 800 / 600);
    let s = initialCookState("first");
    for (let i = 0; i < 6; i++) s = next(roast, s);
    const L = mealLines(roast, strip(roast, s));
    for (const room of [
      { W: 1280 - 2 * 44 * c, H: 560, c, narrow: false },
      { W: 800 - 2 * 35 * c, H: 861, c, narrow: true },
    ]) {
      const d = layoutMealLines(L, room, measure);
      const { container, unmount } = render(<MealLines drawing={d} c={c} onRead={() => {}} readMark={null} tab={0} />);
      const buttons = [...container.querySelectorAll("button[data-card]")];
      expect(buttons.length, d.form).toBeGreaterThan(2);
      // Exactly one current step, the one in hand.
      const current = buttons.filter((b) => b.getAttribute("aria-current") === "step");
      expect(current.map((b) => b.getAttribute("data-card-state")), d.form).toEqual(["now"]);
      // Every word drawn for a stop with a button is hidden from the reader; the button says it.
      for (const b of buttons) {
        const stop = container.querySelector(`[data-line-stop="${b.getAttribute("data-stop")}"]`)!;
        const spoken = [...stop.querySelectorAll("*"), stop].filter((el) => el.textContent?.trim() && !el.closest("[aria-hidden]") && !el.closest("[data-line-dish]"));
        expect(spoken.filter((el) => el.children.length === 0).map((el) => el.textContent), `${d.form}: ${b.getAttribute("data-stop")}`).toEqual([]);
      }
      unmount();
      // On the opening (no reads) the stops are words, read as drawn.
      const opening = render(<MealLines drawing={d} c={c} onRead={null} readMark={null} tab={-1} ground />);
      expect(opening.container.querySelectorAll("[data-line-stop] [aria-hidden], [data-line-stop][aria-hidden]").length, d.form).toBe(0);
      opening.unmount();
    }
  });
});
