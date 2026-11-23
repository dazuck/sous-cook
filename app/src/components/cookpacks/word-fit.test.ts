import { describe, expect, it } from "vitest";
import { chooseWordFit } from "./word-fit";

describe("chooseWordFit", () => {
  it("keeps the largest size when every word fits at it", () => {
    expect(chooseWordFit(2, () => true)).toEqual({ size: 0, hyphenate: false });
  });

  it("steps down to the first size at which every word fits", () => {
    // The longest word is wider than the panel at the chip, whole at the floor.
    const asked: number[] = [];
    const fit = chooseWordFit(2, (i) => {
      asked.push(i);
      return i === 1;
    });
    expect(fit).toEqual({ size: 1, hyphenate: false });
    expect(asked).toEqual([0, 1]);
  });

  it("stays at the floor and hyphenates when no size keeps the words whole", () => {
    expect(chooseWordFit(2, () => false)).toEqual({ size: 1, hyphenate: true });
  });

  it("with one size (a board already at the floor), hyphenates only when its words don't fit", () => {
    expect(chooseWordFit(1, () => true)).toEqual({ size: 0, hyphenate: false });
    expect(chooseWordFit(1, () => false)).toEqual({ size: 0, hyphenate: true });
  });

  it("refuses an empty scale rather than guessing a size", () => {
    expect(() => chooseWordFit(0, () => true)).toThrow();
  });
});
