import { describe, expect, it } from "vitest";
import { UNTITLED, dishName } from "./dish-name";

describe("dishName: the name a recipe goes by on screen", () => {
  it("keeps a recipe's own name and its own case (DS §4)", () => {
    expect(dishName("Chewy Oat Cookies")).toBe("Chewy Oat Cookies");
    expect(dishName("indian dal tadka")).toBe("indian dal tadka");
  });

  it("trims the name's ends", () => {
    expect(dishName("  Mole poblano \n")).toBe("Mole poblano");
  });

  it("falls through an empty or blank name to the next one given", () => {
    expect(dishName("", "notion-123")).toBe("notion-123");
    expect(dishName("   ", null, "Third")).toBe("Third");
    expect(dishName(undefined, " ", "Third")).toBe("Third");
  });

  it("says Untitled recipe, in sentence case, when no name is there", () => {
    expect(UNTITLED).toBe("Untitled recipe");
    expect(dishName("")).toBe(UNTITLED);
    expect(dishName("  \t")).toBe(UNTITLED);
    expect(dishName(null, undefined)).toBe(UNTITLED);
    expect(dishName()).toBe(UNTITLED);
  });
});
