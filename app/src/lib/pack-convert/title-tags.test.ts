import { describe, expect, it } from "vitest";
import { TITLE_TAG_VOCABULARY, isTitleTag, titleTagWord, titleTags } from "./title-tags";

describe("titleTags", () => {
  it.each(TITLE_TAG_VOCABULARY)("takes (%s) off a title as a tag", (word) => {
    expect(titleTags(`Black bean soup (${word})`)).toEqual({ title: "Black bean soup", tags: [word] });
  });

  it("reads the vocabulary in any case", () => {
    expect(titleTags("Dal and rice (HOLIDAY)")).toEqual({ title: "Dal and rice", tags: ["holiday"] });
    expect(titleTags("Mole (New Year's)")).toEqual({ title: "Mole", tags: ["new year's"] });
    expect(titleTags("Mole (New Year’s)")).toEqual({ title: "Mole", tags: ["new year's"] });
  });

  it("takes two suffixes, keeping their order", () => {
    expect(titleTags("Spaghetti al limone (summer) (holiday)")).toEqual({
      title: "Spaghetti al limone",
      tags: ["summer", "holiday"],
    });
  });

  it("keeps any other parenthetical in the title", () => {
    expect(titleTags("Lentil stew (Indian-spiced)")).toEqual({ title: "Lentil stew (Indian-spiced)", tags: [] });
    expect(titleTags("Lemon cupcakes (pale-ish)")).toEqual({ title: "Lemon cupcakes (pale-ish)", tags: [] });
  });

  it("stops at the first unknown suffix", () => {
    expect(titleTags("Soup (holiday) (old)")).toEqual({ title: "Soup (holiday) (old)", tags: [] });
  });

  it("takes a known suffix after an unknown one, and stops there", () => {
    expect(titleTags("Soup (old) (holiday)")).toEqual({ title: "Soup (old)", tags: ["holiday"] });
  });

  it("never leaves an empty title", () => {
    expect(titleTags("(holiday)")).toEqual({ title: "(holiday)", tags: [] });
    expect(titleTags("(summer) (holiday)")).toEqual({ title: "(summer)", tags: ["holiday"] });
  });

  it("trims and tolerates whitespace inside and around a suffix", () => {
    expect(titleTags("  Egg curry   ( holiday )  ")).toEqual({ title: "Egg curry", tags: ["holiday"] });
    expect(titleTags("Mole (new   year's)")).toEqual({ title: "Mole", tags: ["new year's"] });
  });

  it("leaves a title with no suffix as it is", () => {
    expect(titleTags("Chana masala")).toEqual({ title: "Chana masala", tags: [] });
    expect(titleTags("Crackers (")).toEqual({ title: "Crackers (", tags: [] });
  });
});

describe("isTitleTag", () => {
  it("knows the vocabulary and nothing else", () => {
    expect(isTitleTag("Holiday")).toBe(true);
    expect(isTitleTag("summer")).toBe(true);
    expect(isTitleTag("quick")).toBe(false);
    expect(isTitleTag("vegetarian")).toBe(false);
  });
});

describe("titleTagWord", () => {
  it("says a season as its word and a holiday by its name", () => {
    expect(titleTagWord("summer")).toBe("summer");
    expect(titleTagWord("holiday")).toBe("holiday");
    expect(titleTagWord("christmas")).toBe("Christmas");
    expect(titleTagWord("new year's")).toBe("New Year's");
  });
});
