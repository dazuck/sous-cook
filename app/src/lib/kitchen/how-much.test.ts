import { describe, expect, it } from "vitest";
import { FANNIE_RECIPES, fannieNative } from "../pack-convert/__tests__/fannie-native";
import { answerFor, answerHowMuch, howMuchRequest, speakableQuantity } from "./how-much";
import { matchIngredient } from "./ingredient-match";
import { storedIngredientLines, type StoredIngredientLines } from "./ingredient-display";

// "How much X" (slice B5d, B5.md §B5d D11–D12), over the Fannie Farmer
// recipes as the cook page reads them natively.

function lines(recipeId: string): StoredIngredientLines {
  const r = fannieNative(recipeId);
  return storedIngredientLines(r.packRecipe, r.recipeData.ingredients!.length);
}

function ask(recipeId: string, said: string, onScreen: number[] = []) {
  const request = howMuchRequest(said);
  if (request === null) throw new Error(`not an amount question: ${said}`);
  return answerHowMuch(lines(recipeId), onScreen, request);
}

describe("the answer is the amount the pair shows (B5c's seam, DECISIONS 2026-10-10)", () => {
  it.each(FANNIE_RECIPES)(
    "%s: every line's answer reads the pair's own amount at ×1, ×2, and ×⅔",
    (recipeId) => {
      const r = fannieNative(recipeId);
      const base = r.packRecipe.serves_base;
      const counts = [base, base * 2, Math.max(1, Math.round((base * 2) / 3))];
      for (const servings of counts) {
        const all = storedIngredientLines(
          r.packRecipe,
          r.recipeData.ingredients!.length,
          servings,
        );
        all.forEach((line, i) => {
          if (line === null) return;
          const answer = answerFor(all, [i], null);
          expect(answer.kind).toBe("amount");
          if ("amount" in line) expect(answer.shown.startsWith(line.amount)).toBe(true);
        });
      }
    },
  );
});

describe("answers (D12)", () => {
  it("one measured line: its stated amount, said in words", () => {
    expect(ask("thin-white-sauce", "how much milk")).toEqual({
      kind: "amount",
      indices: [2],
      shown: "1 cup milk",
      speech: "1 cup of milk",
    });
    expect(ask("parker-house-rolls", "how much flour", [6])).toMatchObject({
      indices: [6],
      shown: "3 cups flour",
      speech: "3 cups of flour",
    });
    expect(ask("waffles", "how much flour")).toMatchObject({ shown: "1¾ cups flour", speech: "1 and three quarters cups of flour" });
  });

  it("in a unit the recipe states: that amount", () => {
    expect(ask("thin-white-sauce", "how much butter in grams")).toMatchObject({ shown: "28 g butter", speech: "28 grams of butter" });
  });

  it("in a unit it only converts to: about, then what the recipe says", () => {
    const answer = ask("thin-white-sauce", "how much milk in tablespoons");
    expect(answer).toMatchObject({ kind: "amount", shown: "about 16 tbsp · recipe says 1 cup" });
    expect(answer.speech).toBe("About 16 tablespoons. The recipe says 1 cup.");
  });

  it("in a dimension it gives no amount in: what it does give", () => {
    // Milk is stated as 1 cup and 240 ml: its numbers are read from the cup
    // (a volume), so no weight is ever computed for it (verify round 1).
    expect(ask("thin-white-sauce", "how much milk in ounces")).toEqual({
      kind: "amount",
      indices: [2],
      shown: "1 cup milk",
      speech: "The recipe gives milk in cups: 1 cup.",
    });
  });

  it("a count: its number and name", () => {
    expect(ask("doughnuts-i", "how many eggs")).toEqual({ kind: "amount", indices: [3], shown: "3 eggs", speech: "3 eggs" });
  });

  it("a rounded count line speaks its 'about N' without 'of'", () => {
    const own: StoredIngredientLines = [
      { kind: "count", amount: "about 5", name: "tortillas", exact: "5⅓" },
      { kind: "count", amount: "about 5 cloves", name: "garlic", exact: "5⅓" },
    ];
    expect(answerFor(own, [0], null)).toEqual({
      kind: "amount",
      indices: [0],
      shown: "about 5 tortillas",
      speech: "About 5 tortillas",
    });
    expect(answerFor(own, [1], null)).toEqual({
      kind: "amount",
      indices: [1],
      shown: "about 5 cloves garlic",
      speech: "About 5 cloves garlic",
    });
  });

  it("a line with no amount says so, and never a number (the pepper)", () => {
    expect(ask("thin-white-sauce", "how much pepper")).toEqual({
      kind: "amount",
      indices: [4],
      shown: "Pepper: the recipe doesn't say",
      speech: "The recipe doesn't say.",
    });
  });

  it("several lines with one name: each amount in recipe order, not a question", () => {
    expect(ask("doughnuts-i", "how much flour")).toEqual({
      kind: "amount",
      indices: [9, 10, 11],
      shown: "Flour: 3½ cups · ½ cup · 30 g",
      speech: "Flour: 3 and a half cups, then a half cup, then 30 grams.",
    });
  });

  it("the screen's own lines first: at the step that sifts, the flour is that flour", () => {
    expect(ask("doughnuts-i", "how much flour", [9, 5, 6, 7, 8])).toMatchObject({ indices: [9], shown: "3½ cups flour" });
  });

  it("several names: which, with each as a choice", () => {
    expect(ask("parker-house-rolls", "how much butter")).toEqual({
      kind: "which",
      asked: "butter",
      unit: null,
      choices: [
        { index: 1, name: "Butter" },
        { index: 9, name: "Melted butter" },
        { index: 10, name: "Butter for the pan" },
      ],
      shown: "Which butter?",
      speech: "Which butter: butter, melted butter, or butter for the pan?",
    });
  });

  it("a choice answers with the unit first asked", () => {
    expect(answerFor(lines("parker-house-rolls"), [9], "g")).toMatchObject({ shown: "28 g melted butter" });
  });

  it("nothing by that name", () => {
    expect(ask("waffles", "how much saffron")).toEqual({
      kind: "none",
      asked: "saffron",
      shown: "Nothing called saffron in this recipe.",
      speech: "Nothing called saffron in this recipe.",
    });
  });

  it("as written and to taste lines say their words", () => {
    const own: StoredIngredientLines = [
      { kind: "as_written", amount: "a handful", name: "parsley" },
      { kind: "to_taste", name: "Salt" },
    ];
    expect(answerFor(own, [0], null)).toMatchObject({ shown: "a handful parsley (as written)", speech: "A handful parsley" });
    expect(answerFor(own, [1], null)).toMatchObject({ shown: "Salt: to taste", speech: "To taste." });
  });
});

describe("matchIngredient", () => {
  it("folds plurals and ignores filler words", () => {
    expect(matchIngredient(lines("waffles"), [], "the egg yolks")).toEqual({ kind: "match", indices: [4] });
    expect(matchIngredient(lines("waffles"), [], "of the")).toEqual({ kind: "none" });
  });
});

describe("speakableQuantity (the Player's)", () => {
  it.each([
    ["1½ cups", "1 and a half cups"],
    ["¾ cup", "three quarters cup"],
    ["¾ cup + 4 tsp", "three quarters of a cup and 4 teaspoons"],
    ["1 lb + 5¼ oz", "1 pound and 5 and a quarter ounces"],
    ["1½–2 tbsp", "1 and a half to 2 tablespoons"],
    ["½–1 cup", "a half to 1 cup"],
    ["about 5", "about 5"],
    ["a pinch", "a pinch"],
    ["1 tbsp", "1 tablespoon"],
    ["2 tbsp", "2 tablespoons"],
    ["28 g", "28 grams"],
    ["1.9 l", "1.9 liters"],
    ["3", "3"],
  ])("%s → %s", (shown, said) => {
    expect(speakableQuantity(shown)).toBe(said);
  });
});

