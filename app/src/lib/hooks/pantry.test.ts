import { describe, expect, it } from "vitest";
import { isFoodInventoryHeading, pantryInventory } from "./pantry";
import type { PantrySection } from "./types";

const section = (rawHeading: string, items: string[]): PantrySection => ({
  heading: rawHeading.trim().toLowerCase(),
  rawHeading,
  items,
});

describe("isFoodInventoryHeading", () => {
  it("reads every heading as food but the household's own notes", () => {
    expect(isFoodInventoryHeading("fridge")).toBe(true);
    expect(isFoodInventoryHeading("Spice Rack")).toBe(true);
    expect(isFoodInventoryHeading("our setup")).toBe(false);
    expect(isFoodInventoryHeading("  Our family: ")).toBe(false);
  });
});

describe("pantryInventory", () => {
  it("sorts sections by keywords in their headings, in section order", () => {
    expect(
      pantryInventory([
        section("Perishables", ["milk"]),
        section("Chest freezer", ["peas"]),
        section("Fridge", ["eggs"]),
        section("Aromatics", ["garlic"]),
        section("From the garden", ["chard"]),
        section("Pantry", ["rice"]),
      ]),
    ).toEqual({ fridge: ["milk", "eggs", "garlic", "chard"], freezer: ["peas"], pantry: ["rice"] });
  });

  it("puts a heading it doesn't know on the shelf rather than dropping it", () => {
    expect(pantryInventory([section("Grains & beans", ["farro"]), section("Fridge door", ["mustard"])])).toEqual({
      fridge: [],
      freezer: [],
      pantry: ["farro", "mustard"],
    });
  });

  it("leaves out the sections that aren't food", () => {
    expect(
      pantryInventory([section("Our setup", ["12-inch skillet"]), section("Our family:", ["Two adults"])]),
    ).toEqual({ fridge: [], freezer: [], pantry: [] });
  });

  it("is empty for an empty pantry", () => {
    expect(pantryInventory([])).toEqual({ fridge: [], freezer: [], pantry: [] });
  });
});
