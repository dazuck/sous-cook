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

  it("Escape puts the panel away, takes the key from whatever is under it, and leaves the focus on the amount", () => {
    popover([{ unit: "tbsp", value: "2" }], [{ unit: "ml", value: "29.6" }]);
    const trigger = screen.getByRole("button", { name: "2 tbsp olive oil" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.querySelector("[data-holds-keys]")).not.toBeNull();

    // `fireEvent` answers false when the key was taken (preventDefault).
    expect(fireEvent.keyDown(trigger, { key: "Escape" })).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-holds-keys]")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Closed, Escape is not its key; and open, no other key is.
    expect(fireEvent.keyDown(trigger, { key: "Escape" })).toBe(true);
    fireEvent.click(trigger);
    expect(fireEvent.keyDown(trigger, { key: "ArrowRight" })).toBe(true);
    expect(document.querySelector("[data-holds-keys]")).not.toBeNull();
  });

  it("Escape from inside the panel's layer closes it too, and a key another handler took is left alone", () => {
    popover([{ unit: "tbsp", value: "2" }], [{ unit: "ml", value: "29.6" }]);
    const trigger = screen.getByRole("button", { name: "2 tbsp olive oil" });
    fireEvent.click(trigger);
    // A handler ahead of it (the sheet's, on the window in capture) took this Escape.
    const take = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", take, true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", take, true);
    expect(document.querySelector("[data-holds-keys]")).not.toBeNull();
    // Its own Escape, pressed with the focus anywhere.
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
    expect(document.querySelector("[data-holds-keys]")).toBeNull();
  });

  it("Tab to another amount, then Enter: the first panel is put away, so one panel stands", () => {
    render(
      <div>
        <MeasurementPopover stated={[{ unit: "tbsp", value: "2" }]} conversions={[{ unit: "ml", value: "29.6" }]} className="pair">
          <span>2 tbsp</span> olive oil
        </MeasurementPopover>
        <MeasurementPopover stated={[{ unit: "cup", value: "1" }]} conversions={[{ unit: "ml", value: "237" }]} className="pair">
          <span>1 cup</span> stock
        </MeasurementPopover>
      </div>,
    );
    const oil = screen.getByRole("button", { name: "2 tbsp olive oil" });
    const stock = screen.getByRole("button", { name: "1 cup stock" });
    oil.focus();
    fireEvent.click(oil);
    expect(document.querySelectorAll("[data-measure-panel]")).toHaveLength(1);

    // Tab: the focus lands on the next amount, and the panel it left is put away.
    stock.focus();
    fireEvent.focusIn(stock);
    expect(oil.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll("[data-measure-panel]")).toHaveLength(0);
    // Enter on a button is its click.
    fireEvent.click(stock);
    expect(document.querySelectorAll("[data-measure-panel]")).toHaveLength(1);
    expect(panelLines()).toEqual([COOK_COPY.statedHeading, "cup 1", COOK_COPY.conversionsHeading, "ml 237"]);

    // The focus coming back to an open panel's own amount keeps it.
    fireEvent.focusIn(stock);
    expect(stock.getAttribute("aria-expanded")).toBe("true");
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

  it("conversions alone (Get out's sum of two lines): the heading opens the panel with no gap above", () => {
    popover([], [{ unit: "ml", value: "44.4" }]);
    fireEvent.click(screen.getByRole("button", { name: "2 tbsp olive oil" }));
    expect(panelLines()).toEqual([COOK_COPY.conversionsHeading, "ml 44.4"]);
    expect(document.querySelector("[data-holds-keys] [data-heading]")!.className).not.toContain("mt-4");
  });
});

// Asked 2026-11-22: Get out's amounts open in a column that scrolls and is too small to hold
// the panel, so the panel is drawn in the layer the column names, outside what clips.
describe("MeasurementPopover in a layer", () => {
  // As on the sheet: the layer stands in a box that takes the focus itself (`[data-cook-sheet]`,
  // tabIndex -1), with other things to focus beside the list.
  function inLayer() {
    return render(
      <div data-testid="sheet" tabIndex={-1}>
        <button type="button">Start</button>
        <div data-popover-layer data-testid="layer">
          <div data-testid="scroller" style={{ overflowY: "auto", height: 40 }}>
            <MeasurementPopover stated={[{ unit: "tbsp", value: "2" }]} conversions={[{ unit: "ml", value: "29.6" }]} className="pair">
              <span>2 tbsp</span> olive oil
            </MeasurementPopover>
          </div>
        </div>
      </div>,
    );
  }
  /** A press on words that take no focus: the browser hands the focus to the nearest box that does. */
  function pressOn(target: Element) {
    fireEvent.mouseDown(target);
    const takes = target.closest<HTMLElement>("button, [tabindex]");
    if (takes) {
      takes.focus();
      fireEvent.focusIn(takes);
    }
  }

  it("draws the panel in the layer, outside the scroller that would clip it, and still says the same lines", () => {
    inLayer();
    const trigger = screen.getByRole("button", { name: "2 tbsp olive oil" });
    fireEvent.click(trigger);
    const panel = document.querySelector<HTMLElement>("[data-holds-keys]")!;
    expect(panel.parentElement).toBe(screen.getByTestId("layer"));
    expect(screen.getByTestId("scroller").contains(panel)).toBe(false);
    expect(panelLines()).toEqual([COOK_COPY.statedHeading, "tbsp 2", COOK_COPY.conversionsHeading, "ml 29.6"]);
    // A tap inside the panel keeps it: the press, and the focus it hands to the sheet's box, which
    // holds the panel (review round 2: that focus counted as the focus leaving, and closed it).
    pressOn(panel.querySelector("[data-row]")!);
    expect(document.activeElement).toBe(screen.getByTestId("sheet"));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[data-holds-keys]")).not.toBeNull();
    // A second tap on the amount closes it.
    fireEvent.click(trigger);
    expect(document.querySelector("[data-holds-keys]")).toBeNull();
  });

  it("the focus moving to something else on the sheet still puts it away", () => {
    inLayer();
    const trigger = screen.getByRole("button", { name: "2 tbsp olive oil" });
    fireEvent.click(trigger);
    const start = screen.getByRole("button", { name: "Start" });
    start.focus();
    fireEvent.focusIn(start);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-holds-keys]")).toBeNull();
  });

  it("is put away when what is under it scrolls, and by a tap outside it", () => {
    inLayer();
    const trigger = screen.getByRole("button", { name: "2 tbsp olive oil" });
    fireEvent.click(trigger);
    expect(document.querySelector("[data-holds-keys]")).not.toBeNull();
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-holds-keys]")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(document.querySelector("[data-holds-keys]")).toBeNull();
  });

  it("with no layer named, the panel stays beside its amount (every step's pairs)", () => {
    popover([{ unit: "tbsp", value: "2" }], [{ unit: "ml", value: "29.6" }]);
    const trigger = screen.getByRole("button", { name: "2 tbsp olive oil" });
    fireEvent.click(trigger);
    expect(document.querySelector("[data-holds-keys]")!.parentElement).toBe(trigger.parentElement);
  });
});

