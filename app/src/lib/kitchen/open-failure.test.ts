import { describe, it, expect } from "vitest";
import type { Recipe } from "@sous/pack";
import { openFailure } from "./open-failure";

const PACK = { id: "q-1", title: "Dal" } as unknown as Recipe;
const READ = { recipeData: { name: "Dal" }, packRecipe: PACK };

describe("openFailure", () => {
  it("is nothing when there's a recipe to cook, even beside a failed refetch", () => {
    expect(openFailure(READ, null)).toBeNull();
    expect(openFailure(READ, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBeNull();
  });

  it("is unreadable when the stored recipe can't be read as a pack recipe (B4)", () => {
    const unreadable = { recipeData: { name: "Nothing" }, packRecipe: null };
    expect(openFailure(unreadable, null)).toBe("UNREADABLE");
    // A recipe on hand, unreadable, still says why over a failed refetch.
    expect(openFailure(unreadable, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(
      "UNREADABLE",
    );
  });

  it("names the server's code when the query failed", () => {
    expect(openFailure(undefined, { data: { code: "BAD_REQUEST" } })).toBe("BAD_REQUEST");
  });

  it("is a fetch failure when the query failed without a server code", () => {
    expect(openFailure(undefined, { data: null })).toBe("FETCH_FAILED");
    expect(openFailure(undefined, {})).toBe("FETCH_FAILED");
  });

  it("is not found when the query answered with no item", () => {
    expect(openFailure(null, null)).toBe("NOT_FOUND");
    expect(openFailure(undefined, null)).toBe("NOT_FOUND");
  });

  it("is no recipe when the item has none", () => {
    expect(openFailure({ recipeData: null, packRecipe: null }, null)).toBe("NO_RECIPE");
  });
});
