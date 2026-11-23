/**
 * Tests for recipe-grounding: checking an extracted recipe against the text
 * it came from.
 *
 * Sources are synthetic recipes written for these tests, never imported web text.
 */

import { describe, expect, it } from "vitest";
import type { ImportedRecipe } from "./recipe-import";
import {
  groundingWords,
  groundRecipe,
  measureGrounding,
  partsLost,
  servesStated,
} from "./recipe-grounding";

const items = (...names: string[]) => names.map((item) => ({ item }));

describe("groundingWords", () => {
  it("spells out short abbreviations before dropping short words", () => {
    expect(groundingWords("1 hr")).toEqual(groundingWords("1 hour"));
    expect(groundingWords("25m")).toEqual(groundingWords("25 minutes"));
    expect(groundingWords("2 tbsp")).toEqual(groundingWords("2 tablespoons"));
    expect(groundingWords("med-high")).toEqual(groundingWords("medium high"));
    expect(groundingWords("fry til crispy")).toEqual(
      groundingWords("fry until crispy"),
    );
  });

  it("folds a word's forms to one stem", () => {
    const same = (a: string, b: string) =>
      expect(groundingWords(a)).toEqual(groundingWords(b));
    same("toss", "tossed");
    same("dice", "diced");
    same("chop", "chopped");
    same("sauté", "saute");
    same("sautéed", "saute");
    same("slice", "sliced");
    same("fry", "fries");
    same("stirring", "stir");
  });

  it("folds a word and its plural to the same stem", () => {
    const same = (a: string, b: string) =>
      expect(groundingWords(a)).toEqual(groundingWords(b));
    same("dressing", "dressings");
    same("topping", "toppings");
    same("tomato", "tomatoes");
    same("berry", "berries");
    same("dish", "dishes");
    same("glass", "glasses");
    same("slice", "slices");
    same("bay leaf", "bay leaves");
    same("half", "halves");
  });

  it("folds spellings of one word to the same stem", () => {
    for (const spelling of ["chile", "chiles", "chilies", "chilis"]) {
      expect(groundingWords(spelling)).toEqual(groundingWords("chili"));
    }
  });

  it("spells out kitchen shorthand", () => {
    expect(groundingWords("1/2 c evoo")).toEqual(
      groundingWords("1/2 cup extra virgin olive oil"),
    );
    expect(groundingWords("3 tbsp acv")).toEqual(
      groundingWords("3 tbsp apple cider vinegar"),
    );
    expect(groundingWords("2 tbsp pb")).toEqual(
      groundingWords("2 tbsp peanut butter"),
    );
    expect(groundingWords("1/4 cup parm")).toEqual(
      groundingWords("1/4 cup parmesan"),
    );
    for (const shorthand of ["s&p", "S+P", "s / p", "s & p to taste"]) {
      expect(groundingWords(shorthand)).toEqual(
        expect.arrayContaining(groundingWords("salt pepper")),
      );
    }
  });

  it("keeps numbers of two digits or more and drops single digits", () => {
    expect(groundingWords("Bake 2 trays at 350")).toEqual([
      ...groundingWords("Bake trays"),
      "350",
    ]);
  });

  it("drops words too common to tell one method from another", () => {
    expect(groundingWords("the and with everything together")).toEqual([]);
    expect(groundingWords("serve serves served serving servings")).toEqual([]);
  });

  it("keeps words in other scripts", () => {
    expect(groundingWords("לטגן בצל")).toHaveLength(2);
  });
});

describe("servesStated", () => {
  it("finds a count beside a word for servings", () => {
    expect(servesStated(4, "Chili\nServes 4\n1 lb beef")).toBe(true);
    expect(servesStated(2, "spiced iced tea\n2 servings\nblack tea")).toBe(true);
    expect(servesStated(12, "Makes 12 cupcakes")).toBe(true);
    expect(servesStated(6, "scaled for 6 people")).toBe(true);
  });

  it("reads number words and ranges", () => {
    expect(servesStated(4, "Feeds four hungry people")).toBe(true);
    expect(servesStated(5, "Serves 4-6")).toBe(true);
    expect(servesStated(6, "serves 4 to 6")).toBe(true);
    expect(servesStated(7, "Serves 4-6")).toBe(false);
  });

  it("is false when the source gives no count, or a different one", () => {
    expect(servesStated(4, "Chili\n1 lb beef\nsimmer 40 min")).toBe(false);
    expect(servesStated(6, "Serves 4")).toBe(false);
  });

  it("reads a count after a colon or a hedge", () => {
    expect(servesStated(4, "Servings: 4")).toBe(true);
    expect(servesStated(4, "Serves: ~4 (about 4 wings per person)")).toBe(true);
    expect(servesStated(12, "makes about 12")).toBe(true);
    expect(servesStated(4, "Yield: 4 servings")).toBe(true);
  });

  it("doesn't take a number from the next line", () => {
    expect(servesStated(2, "Serves 4\n2 cups flour")).toBe(false);
  });

  it("takes only the count beside the servings word, not the line's other numbers", () => {
    expect(servesStated(25, "bake 20-30 min, serves 4")).toBe(false);
    expect(servesStated(9, "makes 2 9-inch pies")).toBe(false);
    expect(servesStated(30, "serves 4. bake 350 for 30 min")).toBe(false);
    expect(servesStated(4, "bake 20-30 min, serves 4")).toBe(true);
  });

  it("reads a count in the next table cell, or after a non-breaking space", () => {
    // The doc's table rows reach the sync as cells joined with " | ".
    expect(servesStated(4, "Servings | 4")).toBe(true);
    expect(servesStated(4, "Serves\u00a04")).toBe(true);
    expect(servesStated(6, "4\u00a0to\u00a06 people")).toBe(true);
  });

  it("stays quick on a long run of spaces after a servings word", () => {
    // Sized so a pattern that backtracks through the run takes seconds
    // rather than hanging the suite; a linear one takes well under 1 ms.
    const text = "serves" + " ".repeat(3000) + "x";
    const start = performance.now();
    expect(servesStated(4, text)).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("groundRecipe", () => {
  // Ingredients and a serving count only, no method.
  const ICED_TEA_TAB = [
    "spiced iced tea",
    "2 servings",
    "⅓  cup warm water",
    "3.5 tsp of black tea",
    "10 mint leaves (1 handful)",
    "1 tbsp of lemon juice",
    "2.5 tbsp of honey",
    "⅜  tsp ground ginger",
  ].join("\n");
  const ICED_TEA_INGREDIENTS = [
    { item: "warm water", amount: "1/3", unit: "cup" },
    { item: "black tea", amount: "3.5", unit: "tsp" },
    { item: "mint leaves", amount: "10" },
    { item: "lemon juice", amount: "1", unit: "tbsp" },
    { item: "honey", amount: "2.5", unit: "tbsp" },
    { item: "ground ginger", amount: "3/8", unit: "tsp" },
  ];
  // What the model returned despite the prompt's rules.
  const ICED_TEA_WITH_METHOD: ImportedRecipe = {
    name: "spiced iced tea",
    ingredients: ICED_TEA_INGREDIENTS,
    steps: [
      "Steep the black tea in the warm water.",
      "Place the steeped tea, mint leaves, lemon juice, honey, and ground ginger into a pitcher.",
      "Shake with ice until chilled and frothy.",
      "Pour into glasses and serve.",
    ],
    stepIngredients: [[0, 1], [2, 3, 4, 5], [], []],
    estimatedTime: { active: 5, passive: 0, total: 5 },
    serves: 2,
  };

  it("returns a faithful recipe unchanged, with no notices", () => {
    const recipe: ImportedRecipe = {
      name: "Tomato sauce",
      ingredients: items("onion", "garlic", "tomatoes"),
      steps: [
        "Sauté the onion and garlic",
        "Add the tomatoes and simmer for 20 minutes",
      ],
      stepIngredients: [[0, 1], [2]],
      estimatedTime: { active: 10, passive: 20, total: 30 },
      serves: 4,
      notes: "Better the next day",
    };
    const source =
      "Tomato sauce\nServes 4\n1 onion\n2 cloves garlic\n1 can tomatoes\n" +
      "Sauté onion and garlic. Add tomatoes, simmer 20 min.\n" +
      "Better the next day.";

    expect(groundRecipe(recipe, source)).toEqual({ recipe, notices: [] });
  });

  it("drops a method the source doesn't give, keeping the ingredients", () => {
    const { recipe, notices } = groundRecipe(ICED_TEA_WITH_METHOD, ICED_TEA_TAB);

    expect(recipe.ingredients).toEqual(ICED_TEA_INGREDIENTS);
    expect(recipe.steps).toEqual([]);
    expect(recipe.stepIngredients).toBeUndefined();
    expect(recipe.estimatedTime).toBeUndefined();
    expect(recipe.serves).toBe(2);
    expect(notices).toEqual([
      {
        kind: "method-dropped",
        message: "Left out 4 steps that aren't in the source.",
      },
    ]);
  });

  it("leaves the recipe it was given as it was", () => {
    const before = structuredClone(ICED_TEA_WITH_METHOD);
    groundRecipe(ICED_TEA_WITH_METHOD, ICED_TEA_TAB);
    expect(ICED_TEA_WITH_METHOD).toEqual(before);
  });

  it("drops a one-word made-up method", () => {
    const { recipe, notices } = groundRecipe(
      {
        name: "Spiced iced tea",
        ingredients: items("black tea", "mint leaves", "honey"),
        steps: ["Blend everything."],
      },
      "spiced iced tea\n1 cup black tea\n10 mint leaves\n2 tbsp honey",
    );

    expect(recipe.steps).toEqual([]);
    expect(notices).toEqual([
      {
        kind: "method-dropped",
        message: "Left out 1 step that isn't in the source.",
      },
    ]);
  });

  it("counts a word of the model's name that the source doesn't have", () => {
    const { recipe } = groundRecipe(
      {
        name: "Blended Iced Tea",
        ingredients: items("black tea", "mint leaves"),
        steps: ["Blend everything."],
      },
      "spiced iced tea\n1 cup black tea\n10 mint leaves",
    );

    expect(recipe.steps).toEqual([]);
  });

  it("keeps a method whose words all come from its ingredients and name", () => {
    const recipe: ImportedRecipe = {
      name: "Toast",
      ingredients: items("bread"),
      steps: ["Toast the bread"],
    };

    expect(groundRecipe(recipe, "toast\nbread")).toEqual({
      recipe,
      notices: [],
    });
  });

  it("fails when most ingredients aren't in the source", () => {
    const source =
      "Tortilla española\n4 huevos\n3 patatas\n1 cebolla\naceite de oliva\n" +
      "Pelar y cortar las patatas. Freír en aceite a fuego lento 20 minutos.";

    expect(() =>
      groundRecipe(
        {
          name: "Spanish Tortilla",
          ingredients: items("eggs", "potatoes", "onion", "olive oil"),
          steps: ["Peel and cut the potatoes", "Fry in oil for 20 minutes"],
        },
        source,
      ),
    ).toThrow(
      "Most of the ingredients the model returned aren't in the source",
    );
  });

  it("fails without asking for a paste when a made-up method is all there is", () => {
    const attempt = () =>
      groundRecipe(
        {
          name: "Spiced Iced Tea",
          steps: [
            "Steep the black tea in the warm water.",
            "Shake with ice until chilled and frothy.",
            "Pour into glasses and serve.",
          ],
        },
        "spiced iced tea\n5 stars",
      );

    expect(attempt).toThrow(
      "The steps the model returned aren't in the source, and it found no " +
        "ingredients, so there is no recipe to keep.",
    );
  });

  it("drops a short made-up method that only echoes the serving count", () => {
    for (const step of [
      "Toss everything together and serve.",
      "Mix well and serve.",
    ]) {
      const { recipe } = groundRecipe(
        {
          name: "Green salad",
          ingredients: items("lettuce", "cucumber", "vinaigrette"),
          steps: [step],
        },
        "green salad\nserves 4\n1 head lettuce\n1 cucumber\nvinaigrette",
      );
      expect(recipe.steps, step).toEqual([]);
    }
  });

  it("keeps a faithful recipe whose tab is written in kitchen shorthand", () => {
    const recipe: ImportedRecipe = {
      name: "House vinaigrette",
      ingredients: [
        { item: "extra virgin olive oil", amount: "1/2", unit: "cup" },
        { item: "apple cider vinegar", amount: "3", unit: "tbsp" },
        { item: "dijon mustard", amount: "1", unit: "tsp" },
        { item: "salt" },
        { item: "pepper" },
        { item: "honey", amount: "1", unit: "tsp" },
      ],
      steps: ["Shake everything in a jar"],
    };
    const source =
      "house vinaigrette\n1/2 c evoo, 3 tbsp acv, 1 tsp dijon, s&p, " +
      "1 tsp honey\nshake in a jar";

    expect(groundRecipe(recipe, source)).toEqual({ recipe, notices: [] });
  });

  it("drops a serving count the source doesn't state", () => {
    const { recipe, notices } = groundRecipe(
      {
        name: "Chili",
        ingredients: items("beef", "beans"),
        steps: ["Brown the beef", "Add the beans and simmer"],
        serves: 6,
      },
      "Chili\n1 lb beef\n1 can beans\nBrown beef, add beans, simmer.",
    );

    expect(recipe.serves).toBeUndefined();
    expect(notices).toEqual([]);
  });

  it("drops notes the source doesn't give, with a notice", () => {
    const { recipe, notices } = groundRecipe(
      {
        name: "spiced iced tea",
        ingredients: ICED_TEA_INGREDIENTS,
        steps: [],
        notes:
          "A refreshing iced tea drink, perfect for warm summer afternoons.",
      },
      ICED_TEA_TAB,
    );

    expect(recipe.notes).toBeUndefined();
    expect(recipe.ingredients).toEqual(ICED_TEA_INGREDIENTS);
    expect(notices).toEqual([
      {
        kind: "notes-dropped",
        message: "Left out notes that aren't in the source.",
      },
    ]);
  });

  it("keeps notes in the source's words", () => {
    const recipe: ImportedRecipe = {
      name: "spiced hot cocoa mix",
      ingredients: items("cocoa powder", "brown sugar", "whole milk"),
      steps: [],
      notes: "For a large mug, use 9.5 tsp, just over 3 tbsp",
    };
    const source =
      "spiced hot cocoa mix\n4.5 tsp cocoa powder\n2.5 tsp brown sugar\n" +
      "¾ cup whole milk\nfor a large mug use 9.5 tsp, just over 3 tbsp";

    expect(groundRecipe(recipe, source)).toEqual({ recipe, notices: [] });
  });
});

describe("partsLost", () => {
  const SOURCE =
    "Tomato sauce\n1 onion\n2 cloves garlic\n1 can tomatoes\n" +
    "Sauté onion and garlic. Add tomatoes, simmer 20 min.\n" +
    "Better the next day.";
  const SAVED: ImportedRecipe = {
    name: "Tomato sauce",
    ingredients: items("onion", "garlic", "tomatoes"),
    steps: [
      "Sauté the onion and garlic",
      "Add the tomatoes and simmer for 20 minutes",
    ],
    notes: "Better the next day",
  };

  it("is empty when the new extraction has every part the saved one has", () => {
    expect(partsLost(SAVED, SAVED, SOURCE)).toEqual([]);
    expect(
      partsLost(SAVED, { ...SAVED, steps: ["Simmer it all"] }, SOURCE),
    ).toEqual([]);
  });

  it("names each part the new extraction lacks that the source still gives", () => {
    expect(
      partsLost(SAVED, { name: "Tomato sauce", steps: [] }, SOURCE),
    ).toEqual(["ingredients", "steps", "notes"]);
    expect(
      partsLost(SAVED, { ...SAVED, steps: [], notes: "  " }, SOURCE),
    ).toEqual(["steps", "notes"]);
  });

  it("counts a saved method in the source's words, reworded a little, as still given", () => {
    const reworded = {
      ...SAVED,
      steps: [
        "Sauté the onion and garlic until soft",
        "Add the tomatoes and simmer for 20 minutes",
      ],
    };
    expect(partsLost(reworded, { ...reworded, steps: [] }, SOURCE)).toEqual([
      "steps",
    ]);
  });

  it("lets a part the saved recipe lacks too go unmentioned", () => {
    const savedWithoutNotes = { ...SAVED, notes: undefined };
    expect(
      partsLost(savedWithoutNotes, { ...SAVED, notes: undefined }, SOURCE),
    ).toEqual([]);
  });

  it("lets a new extraction replace a saved method the source doesn't give", () => {
    // Saved by an earlier, laxer extraction of an ingredients-only tab.
    const tab = "Tomato sauce\n1 onion\n2 cloves garlic\n1 can tomatoes";
    const madeUp: ImportedRecipe = {
      ...SAVED,
      steps: [
        "Heat olive oil in a heavy pot over medium heat",
        "Crush the tomatoes by hand and season generously with basil",
      ],
      notes: undefined,
    };
    expect(partsLost(madeUp, { ...madeUp, steps: [] }, tab)).toEqual([]);
  });

  it("lets a new extraction replace a saved part it can't clearly find in the source", () => {
    // A made-up method echoing the prep words of the ingredient lines passes
    // groundRecipe's check at 3 of 5 words, but is no reason to keep it.
    const chili =
      "Chili\n1 lb ground beef, browned\n1 onion, chopped\n" +
      "1 can beans, drained\nchili powder";
    const madeUp: ImportedRecipe = {
      name: "Chili",
      ingredients: items("ground beef", "onion", "beans", "chili powder"),
      steps: [
        "Brown the beef",
        "Chop the onion",
        "Drain the beans",
        "Simmer everything 1 hour",
      ],
    };
    expect(partsLost(madeUp, { ...madeUp, steps: [] }, chili)).toEqual([]);
    // Half the saved ingredients in the source: enough to extract, not to
    // override the new extraction with.
    const halfThere = {
      ...SAVED,
      ingredients: items("onion", "garlic", "basil", "olive oil"),
    };
    expect(
      partsLost(halfThere, { ...halfThere, ingredients: [] }, SOURCE),
    ).toEqual([]);
    // Too few words to tell whether the source gives them.
    const terse = { ...SAVED, steps: ["Simmer"], notes: "Serves 8." };
    expect(
      partsLost(terse, { ...terse, steps: [], notes: undefined }, SOURCE),
    ).toEqual([]);
  });

  it("lets a new extraction drop a part since taken out of the doc", () => {
    const withoutNotes = SOURCE.replace("\nBetter the next day.", "");
    expect(
      partsLost(SAVED, { ...SAVED, notes: undefined }, withoutNotes),
    ).toEqual([]);
  });
});

// =============================================================================
// Calibration
// =============================================================================

// The cases the thresholds were set against, labeled by hand. A "limit" is a
// case the check gets wrong by design, pinned at what it does so a change to
// it is seen: a few made-up steps in a mostly faithful method pass (the check
// is per recipe), page text around a recipe can ground a made-up method, and
// a method written in initialisms (IP, HP, NR) can't be matched to its
// spelled-out steps.
type Verdict = "keep" | "drop" | "throw";
type CalibrationCase = {
  label: string;
  expected: Verdict;
  limit?: true;
  source: string;
  recipe: ImportedRecipe;
};

const COCOA_TAB = [
  "spiced hot cocoa mix",
  "4.5 tsp cocoa powder (dutch-process)",
  "2.5 tsp brown sugar",
  "2.5 tsp malted milk powder",
  "¾ cup hot water",
  "¾ cup whole milk",
  "for a large mug use 9.5 tsp, just over 3 tbsp",
].join("\n");
const COCOA_INGREDIENTS = [
  { item: "cocoa powder", amount: "4.5", unit: "tsp" },
  { item: "brown sugar", amount: "2.5", unit: "tsp" },
  { item: "malted milk powder", amount: "2.5", unit: "tsp" },
  { item: "hot water", amount: "3/4", unit: "cup" },
  { item: "whole milk", amount: "3/4", unit: "cup" },
];
const SPANISH =
  "Tortilla española\n4 huevos\n3 patatas\n1 cebolla\naceite de oliva\n" +
  "Pelar y cortar las patatas. Freír en aceite a fuego lento 20 minutos. " +
  "Batir los huevos, mezclar, cuajar la tortilla por ambos lados.";
const HEBREW =
  "שקשוקה\n4 ביצים\nעגבניות\nלטגן בצל, להוסיף עגבניות, לשבור ביצים";

const CALIBRATION: CalibrationCase[] = [
  {
    label: "a paraphrase of 'blend everything'",
    expected: "keep",
    source: "spiced iced tea\n1 cup black tea\n10 mint leaves\nblend everything",
    recipe: {
      name: "Spiced Iced Tea",
      ingredients: [
        { item: "black tea", amount: "1", unit: "cup" },
        { item: "mint leaves", amount: "10" },
      ],
      steps: ["Add all ingredients to a blender", "Blend until smooth"],
    },
  },
  {
    label: "abbreviations spelled out",
    expected: "keep",
    source:
      "Banana bread\n3 bananas\n2 c flour\n1 tsp soda\n1/2 c sugar\n1 egg\n" +
      "4 tbsp butter\nMash bananas w/ melted butter. Stir in sugar, egg, " +
      "soda, flour. 350F ~1hr.",
    recipe: {
      name: "Banana bread",
      ingredients: [
        { item: "bananas", amount: "3" },
        { item: "flour", amount: "2", unit: "c" },
        { item: "baking soda", amount: "1", unit: "tsp" },
        { item: "sugar", amount: "1/2", unit: "c" },
        { item: "egg", amount: "1" },
        { item: "butter", amount: "4", unit: "tbsp" },
      ],
      steps: [
        "Mash the bananas with the melted butter",
        "Stir in the sugar, egg, baking soda and flour",
        "Bake at 350 degrees Fahrenheit for approximately 1 hour",
      ],
    },
  },
  {
    label: "'25-30m till temp 145'",
    expected: "keep",
    source:
      "Pork chops\n4 chops\nsalt\npepper\n" +
      "Preheat 400°. Season, roast 25-30m till temp 145.",
    recipe: {
      name: "Pork chops",
      ingredients: items("pork chops", "salt", "pepper"),
      steps: [
        "Preheat the oven to 400 degrees",
        "Season the pork chops",
        "Roast for 25 to 30 minutes until the internal temperature reaches 145",
      ],
    },
  },
  {
    label: "verbs ending in e, in other forms",
    expected: "keep",
    source:
      "Potato gratin\n2 lb potatoes, sliced thin\n1 onion, diced\n" +
      "2 cups cream\nLayer the sliced potatoes and diced onion. Pour cream " +
      "over. Baked 1 hour at 375, served hot.",
    recipe: {
      name: "Potato gratin",
      ingredients: [
        { item: "potatoes, sliced thin", amount: "2", unit: "lb" },
        { item: "onion, diced", amount: "1" },
        { item: "cream", amount: "2", unit: "cups" },
      ],
      steps: [
        "Slice the potatoes thin",
        "Dice the onion",
        "Layer the potatoes and onion",
        "Pour the cream over",
        "Bake at 375 for 1 hour",
        "Serve hot",
      ],
    },
  },
  {
    label: "Spanish, kept in Spanish",
    expected: "keep",
    source: SPANISH,
    recipe: {
      name: "Tortilla española",
      ingredients: items("huevos", "patatas", "cebolla", "aceite de oliva"),
      steps: [
        "Pelar y cortar las patatas",
        "Freír en aceite a fuego lento 20 minutos",
        "Batir los huevos",
        "Mezclar",
        "Cuajar la tortilla por ambos lados",
      ],
    },
  },
  {
    label: "Spanish, translated",
    expected: "throw",
    source: SPANISH,
    recipe: {
      name: "Spanish Tortilla",
      ingredients: items("eggs", "potatoes", "onion", "olive oil"),
      steps: [
        "Peel and cut the potatoes",
        "Fry in oil over low heat for 20 minutes",
        "Beat the eggs",
        "Mix",
        "Set the tortilla on both sides",
      ],
    },
  },
  {
    label: "Hebrew, kept in Hebrew",
    expected: "keep",
    source: HEBREW,
    recipe: {
      name: "שקשוקה",
      ingredients: items("ביצים", "עגבניות"),
      steps: ["לטגן בצל", "להוסיף עגבניות", "לשבור ביצים"],
    },
  },
  {
    label: "Hebrew, translated",
    expected: "throw",
    source: HEBREW,
    recipe: {
      name: "Shakshuka",
      ingredients: items("eggs", "tomatoes"),
      steps: ["Fry the onion", "Add the tomatoes", "Crack in the eggs"],
    },
  },
  {
    label: "a made-up 'Blend everything.'",
    expected: "drop",
    source: "spiced iced tea\n1 cup black tea\n10 mint leaves\n2 tbsp honey",
    recipe: {
      name: "Spiced Iced Tea",
      ingredients: items("black tea", "mint leaves", "honey"),
      steps: ["Blend everything."],
    },
  },
  {
    label: "a made-up two-step cocoa",
    expected: "drop",
    source: "spiced hot cocoa\ncocoa powder\nbrown sugar\nmilk\nwater",
    recipe: {
      name: "Spiced hot cocoa",
      ingredients: items("cocoa powder", "brown sugar", "milk", "water"),
      steps: [
        "Stir the cocoa powder and brown sugar into the water",
        "Top with milk",
      ],
    },
  },
  {
    label: "two real steps and four made up",
    expected: "drop",
    source:
      "Pancakes\n1 cup flour\n1 egg\n1 cup milk\n1 tbsp sugar\n" +
      "Whisk flour, sugar, egg and milk into a smooth batter. Rest the batter.",
    recipe: {
      name: "Pancakes",
      ingredients: items("flour", "egg", "milk", "sugar"),
      steps: [
        "Whisk the flour, sugar, egg and milk into a smooth batter",
        "Rest the batter",
        "Heat a nonstick pan over medium heat and grease lightly with butter",
        "Pour a ladle of batter into the pan",
        "Cook until bubbles form then flip",
        "Serve warm with maple syrup",
      ],
    },
  },
  {
    label: "page comments ground a made-up method",
    expected: "keep",
    limit: true,
    source:
      "Grandma's Chili | Ingredients: 1 lb beef, 1 onion, 1 can beans, " +
      "chili powder. Method in the video! Comments: I browned the meat, " +
      "then sauteed onions in the same pot and simmered everything for an " +
      "hour. Delicious! Another reader: Add cumin and stir well, cook on " +
      "low heat until thick. Related: Slow cooker stew — combine " +
      "everything in the pot and cook 8 hours.",
    recipe: {
      name: "Grandma's Chili",
      ingredients: items("beef", "onion", "beans", "chili powder"),
      steps: [
        "Brown the beef in a pot",
        "Add the onion and saute until soft",
        "Stir in the beans and chili powder",
        "Simmer for an hour until thick",
      ],
    },
  },
  {
    label: "'stirring occasionally'",
    expected: "keep",
    source:
      "Rice\n1 cup rice\n2 cups water\nstirring occasionally, cook covered",
    recipe: {
      name: "Rice",
      ingredients: items("rice", "water"),
      steps: ["Stir occasionally", "Cook covered"],
    },
  },
  {
    label: "a terse method written out",
    expected: "keep",
    source:
      "Fried rice\nday-old rice\n2 eggs\nsoy\nscallions\n" +
      "hot wok, oil, scramble eggs, out. rice in, fry til crispy, soy, " +
      "eggs back, scallions.",
    recipe: {
      name: "Fried rice",
      ingredients: items(
        "day-old rice",
        "eggs",
        "soy sauce",
        "scallions",
        "oil",
      ),
      steps: [
        "Heat the wok until hot and add oil",
        "Scramble the eggs and remove them",
        "Add the rice and fry until crispy",
        "Add the soy sauce",
        "Return the eggs to the wok",
        "Add the scallions",
      ],
    },
  },
  {
    label: "'1 hr'",
    expected: "keep",
    source: "Pulled pork\npork shoulder\nRoast 1 hr, rest, shred",
    recipe: {
      name: "Pulled pork",
      ingredients: items("pork shoulder"),
      steps: ["Roast for 1 hour", "Rest", "Shred"],
    },
  },
  {
    label: "prep in the ingredient list made steps",
    expected: "keep",
    source:
      "Tomato sauce\n1 onion, diced\n2 cloves garlic, minced\n1 can tomatoes\n" +
      "Sauté onion and garlic. Add tomatoes, simmer 20 min.",
    recipe: {
      name: "Tomato sauce",
      ingredients: items("onion", "garlic", "tomatoes"),
      steps: [
        "Dice the onion",
        "Mince the garlic",
        "Sauté the onion and garlic",
        "Add the tomatoes and simmer for 20 minutes",
      ],
    },
  },
  {
    label: "'Step N:' prefixes",
    expected: "keep",
    source:
      "Pancakes\nflour\negg\nmilk\nWhisk flour, egg, milk. Rest 10 min. Fry in butter.",
    recipe: {
      name: "Pancakes",
      ingredients: items("flour", "egg", "milk"),
      steps: [
        "Step 1: Whisk the flour, egg and milk",
        "Step 2: Rest for 10 minutes",
        "Step 3: Fry in butter",
      ],
    },
  },
  {
    label: "four real steps and two made up",
    expected: "keep",
    limit: true,
    source:
      "Roast chicken\n1 whole chicken\nlemon\nthyme\nsalt\nPat chicken dry. " +
      "Stuff cavity with lemon and thyme. Salt generously. Roast at 425 for " +
      "75 minutes.",
    recipe: {
      name: "Roast chicken",
      ingredients: items("whole chicken", "lemon", "thyme", "salt"),
      steps: [
        "Pat the chicken dry",
        "Stuff the cavity with lemon and thyme",
        "Salt generously",
        "Roast at 425 for 75 minutes",
        "Let rest 15 minutes before carving",
        "Spoon pan juices over the top to serve",
      ],
    },
  },
  ...[
    [
      "Combine cocoa powder, brown sugar, and malted milk powder",
      "Add hot water and whole milk to the mixture",
    ],
    [
      "Mix cocoa powder, brown sugar, and malted milk powder",
      "Add hot water and whole milk",
    ],
    ["Whisk the cocoa powder, brown sugar and malted milk into the water", "Top with milk"],
    ["Stir everything together"],
    [
      "Heat the water and milk",
      "Whisk in the cocoa powder, brown sugar and malted milk powder",
    ],
  ].map((steps): CalibrationCase => ({
    label: `a made-up cocoa method: ${steps[0]}`,
    expected: "drop",
    source: COCOA_TAB,
    recipe: {
      name: "spiced hot cocoa mix",
      ingredients: COCOA_INGREDIENTS,
      steps,
    },
  })),
  {
    label: "'marinate overnight, grill med-high ~6 min/side'",
    expected: "keep",
    source:
      "Chicken tikka\n2 lb chicken thighs\n1 cup yogurt\n2 tbsp tikka masala\n" +
      "marinate overnight, grill med-high ~6 min/side",
    recipe: {
      name: "Chicken tikka",
      ingredients: items("chicken thighs", "yogurt", "tikka masala"),
      steps: [
        "Marinate the chicken thighs in the yogurt and tikka masala overnight",
        "Grill over medium-high heat for about 6 minutes per side",
      ],
    },
  },
  {
    label: "initialisms spelled out",
    expected: "drop",
    limit: true,
    source:
      "Dal\n1 cup toor dal\n3 cups water\nturmeric\nsalt\neverything in IP, HP 25m, NR 10",
    recipe: {
      name: "Dal",
      ingredients: items("toor dal", "water", "turmeric", "salt"),
      steps: [
        "Add everything to the Instant Pot",
        "Pressure cook on high for 25 minutes",
        "Let the pressure release naturally for 10 minutes",
      ],
    },
  },
  {
    label: "'cream butter+sugar, eggs, flour'",
    expected: "keep",
    source:
      "Cookies\n2 c flour\n1 c butter\n1 c sugar\n2 eggs\n" +
      "cream butter+sugar, eggs, flour. bake 375 / 12-15 min until golden; " +
      "cool on rack",
    recipe: {
      name: "Cookies",
      ingredients: items("flour", "butter", "sugar", "eggs"),
      steps: [
        "Cream the butter and sugar",
        "Beat in the eggs",
        "Mix in the flour",
        "Bake at 375°F for 12 to 15 minutes until golden",
        "Cool on a wire rack",
      ],
    },
  },
  {
    label: "an aromatic spice butter, reworded",
    expected: "keep",
    source: [
      "½ tsp cumin seeds",
      "1 tsp coriander seeds",
      "Thyme sprigs",
      "Saute cumin seeds in butter. When butter foams, add in coriander seeds.",
      "When coriander color changes (10-20 sec), add in thyme sprigs, and " +
        "saute til fragrant, then spoon over the soup",
    ].join("\n"),
    recipe: {
      name: "Spiced Butter",
      ingredients: [
        { item: "cumin seeds", amount: "1/2", unit: "tsp" },
        { item: "coriander seeds", amount: "1", unit: "tsp" },
        { item: "thyme sprigs" },
      ],
      steps: [
        "Sauté the cumin seeds in butter",
        "When the butter foams, add the coriander seeds",
        "When the coriander changes color, after 10-20 seconds, add the thyme sprigs",
        "Sauté until fragrant, then spoon over the soup",
      ],
    },
  },
  {
    label: "an ingredients-only iced tea fixture, with a short made-up method",
    expected: "drop",
    source: [
      "spiced iced tea",
      "2 servings",
      "⅓  cup warm water",
      "3.5 tsp of black tea",
      "10 mint leaves (1 handful)",
      "1 tbsp of lemon juice",
      "2.5 tbsp of honey",
      "⅜  tsp ground ginger",
    ].join("\n"),
    recipe: {
      name: "spiced iced tea",
      ingredients: items(
        "warm water",
        "black tea",
        "mint leaves",
        "lemon juice",
        "honey",
        "ground ginger",
      ),
      steps: [
        "Steep the black tea in the warm water",
        "Shake with the mint leaves, lemon juice, honey and ground ginger",
      ],
    },
  },
  {
    label: "a tab that only names a dish and links to it",
    expected: "throw",
    source:
      "herb pasta\n★★★★★ so good\nhttps://www.example.com/recipes/herb-pasta",
    recipe: {
      name: "Herb Pasta",
      ingredients: items(
        "spaghetti",
        "garlic cloves",
        "parsley",
        "lemon zest",
        "parmesan",
        "red pepper flakes",
        "olive oil",
      ),
      steps: [
        "Boil the spaghetti in salted water until al dente",
        "Warm the garlic and red pepper flakes in olive oil",
        "Toss the pasta with the garlic oil and pasta water",
        "Stir in the parsley, lemon zest, and parmesan",
        "Serve immediately",
      ],
    },
  },
];

function verdict(recipe: ImportedRecipe, source: string): Verdict {
  try {
    const grounded = groundRecipe(recipe, source).recipe;
    return grounded.steps?.length === recipe.steps?.length ? "keep" : "drop";
  } catch {
    return "throw";
  }
}

describe("calibration", () => {
  it.each(CALIBRATION)("$expected: $label", ({ recipe, source, expected }) => {
    const { method, ingredients } = measureGrounding(recipe, source);
    expect(
      verdict(recipe, source),
      `method ${method.grounded}/${method.counted}, ` +
        `ingredients ${ingredients.grounded}/${ingredients.counted}`,
    ).toBe(expected);
  });

  it("holds limits apart from the cases it gets right", () => {
    expect(CALIBRATION.filter((c) => c.limit).map((c) => c.expected)).toEqual([
      "keep",
      "keep",
      "drop",
    ]);
  });
});
