import { describe, expect, it } from "vitest";
import { twoLines } from "./two-lines";

describe("twoLines: where a foot word breaks when its row is short", () => {
  it("breaks at the space that keeps the longer line shortest", () => {
    expect(twoLines("The whole cook")).toEqual(["The whole", "cook"]);
    expect(twoLines("Done cooking")).toEqual(["Done", "cooking"]);
    expect(twoLines("Close the whole cook")).toEqual(["Close the", "whole cook"]);
    expect(twoLines("Not saved. Try again")).toEqual(["Not saved.", "Try again"]);
  });

  it("takes the earlier space on a tie, so the second line is never the longer by choice", () => {
    // "ab cd ef": "ab" | "cd ef" (5) against "ab cd" | "ef" (5).
    expect(twoLines("ab cd ef")).toEqual(["ab", "cd ef"]);
  });

  it("leaves one word, or no words, on one line", () => {
    expect(twoLines("Finish")).toEqual(["Finish", ""]);
    expect(twoLines("")).toEqual(["", ""]);
  });

  it("splits on the words, not on runs of spaces", () => {
    expect(twoLines("  Done   cooking ")).toEqual(["Done", "cooking"]);
  });
});
