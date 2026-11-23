// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import type { MeasureRow } from "@/lib/kitchen/ingredient-display";
import { MeasurementPopover, placePanel } from "./MeasurementPopover";

// Slice B5d: low on the stage the panel ran under the band, hiding the second
// stated amount. It lies whole inside the box that would clip it.
describe("placePanel", () => {
  const box = { top: 100, bottom: 600, left: 0, right: 1280 };
  const amount = (top: number) => ({ top, bottom: top + 30, left: 100, right: 160 });
  const panel = { width: 200, height: 285 };
  /** The panel's box on the page, from its placement against the amount. */
  const onPage = (a: ReturnType<typeof amount>, p: ReturnType<typeof placePanel>) => ({
    top: a.top + p.top,
    bottom: a.top + p.top + panel.height,
    left: a.left + p.left,
    right: a.left + p.left + panel.width,
  });

  it("stands under its amount where it fits, its arrow at the amount's middle", () => {
    const a = amount(150);
    const p = placePanel(a, panel, box);
    expect(p).toMatchObject({ side: "below", top: 38 });
    expect(onPage(a, p).left).toBe(30);
    expect(30 + p.arrow! + 8).toBe(130);
  });

  it("goes over its amount when the room below is short", () => {
    const a = amount(450);
    const p = placePanel(a, panel, box);
    expect(p).toMatchObject({ side: "above", top: -293 });
    expect(onPage(a, p).bottom).toBeLessThanOrEqual(a.top);
  });

  it("where neither holds it, stands beside its amount inside the box, never over the amount", () => {
    const a = amount(340);
    const p = placePanel(a, { width: 200, height: 300 }, box);
    expect(p.side).toBe("right");
    const page = { top: a.top + p.top, bottom: a.top + p.top + 300, left: a.left + p.left };
    expect(page.top).toBeGreaterThanOrEqual(108);
    expect(page.bottom).toBeLessThanOrEqual(592);
    expect(page.left).toBeGreaterThanOrEqual(a.right);
  });

  it("keeps inside the box across, too", () => {
    const a = { top: 150, bottom: 180, left: 1240, right: 1270 };
    expect(onPage(a, placePanel(a, panel, box)).right).toBeLessThanOrEqual(1272);
  });
});

afterEach(cleanup);

function popover(stated: MeasureRow[], conversions: MeasureRow[]) {
  render(
    <MeasurementPopover stated={stated} conversions={conversions} className="pair">
      <span>2 tbsp</span> olive oil
    </MeasurementPopover>,
  );
}

/** The open panel's lines, in order: headings and "unit value" rows. */
function panelLines(): string[] {
  const panel = document.querySelector("[data-holds-keys]");
  if (panel === null) throw new Error("the popover isn't open");
  return [...panel.querySelectorAll("[data-heading], [data-row]")].map((el) =>
    [...el.children].length > 0
      ? [...el.children].map((c) => c.textContent).join(" ")
      : (el.textContent ?? ""),
  );
}

describe("MeasurementPopover", () => {
  it("lists what the recipe says first, then the computed conversions", () => {
    popover(
      [
        { unit: "cup", value: "1" },
        { unit: "g", value: "225" },
      ],
      [
        { unit: "ml", value: "237" },
        { unit: "oz", value: "7⅞" },
      ],
    );
    const trigger = screen.getByRole("button", { name: "2 tbsp olive oil" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panelLines()).toEqual([
      COOK_COPY.statedHeading,
      "cup 1",
      "g 225",
      COOK_COPY.conversionsHeading,
      "ml 237",
      "oz 7⅞",
    ]);
  });

  it("one stated amount with conversions: a button, the stated row heading the panel", () => {
    popover([{ unit: "tbsp", value: "2" }], [{ unit: "ml", value: "29.6" }]);
    fireEvent.click(screen.getByRole("button", { name: "2 tbsp olive oil" }));
    expect(panelLines()).toEqual([
      COOK_COPY.statedHeading,
      "tbsp 2",
      COOK_COPY.conversionsHeading,
      "ml 29.6",
    ]);
  });

  it("two stated amounts and nothing computed: still a button, with no conversions heading", () => {
    popover(
      [
        { unit: "lb", value: "2½" },
        { unit: "kg", value: "1.2" },
      ],
      [],
    );
    fireEvent.click(screen.getByRole("button", { name: "2 tbsp olive oil" }));
    expect(panelLines()).toEqual([COOK_COPY.statedHeading, "lb 2½", "kg 1.2"]);
  });

  it("nothing past the chip: plain words in the trigger's box, no button", () => {
    popover([{ unit: "tbsp", value: "2" }], []);
    expect(screen.queryByRole("button")).toBeNull();
    const words = screen.getByText("olive oil", { exact: false });
    expect(words.className).toBe("pair");
    expect(words.textContent).toBe("2 tbsp olive oil");
  });

  it("closes on a tap outside it", () => {
    popover([{ unit: "tbsp", value: "2" }], [{ unit: "ml", value: "29.6" }]);
    const trigger = screen.getByRole("button", { name: "2 tbsp olive oil" });
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-holds-keys]")).toBeNull();
  });

  it("shows 'Recipe says, for N' when servesBase is passed at a scaled count", () => {
    render(
      <MeasurementPopover
        stated={[
          { unit: "cup", value: "1" },
          { unit: "g", value: "200" },
        ]}
        conversions={[{ unit: "g", value: "400" }]}
        servesBase={4}
        className="pair"
      >
        <span>2 cups</span> butter
      </MeasurementPopover>,
    );
    fireEvent.click(screen.getByRole("button", { name: "2 cups butter" }));
    expect(panelLines()).toEqual([
      COOK_COPY.statedHeadingFor(4),
      "cup 1",
      "g 200",
      COOK_COPY.conversionsHeading,
      "g 400",
    ]);
  });

  it("renders a popover with the exact count for a rounded count line ('about 5')", () => {
    render(
      <MeasurementPopover
        stated={[]}
        conversions={[]}
        exact="5⅓"
        className="pair"
      >
        <span>about 5</span> corn tortillas
      </MeasurementPopover>,
    );
    fireEvent.click(screen.getByRole("button", { name: "about 5 corn tortillas" }));
    expect(panelLines()).toEqual([COOK_COPY.exactCount("5⅓")]);
  });
});

