/**
 * Pure seed data for the browser test suite.
 * Contains no runtime imports from the application so specs can import it safely.
 */

import type { KitchenQueueRecipeData } from "../drizzle/schema";

/** Fixed clock instant for all seeded data and browser tests (11:00 in Europe/London). */
export const SEED_NOW = new Date("2026-03-10T11:00:00Z");

export const BUNDLED_PACK_ID = "fannie-farmer-1896";
export const BUNDLED_PACK_TITLE = "The Boston Cooking-School Cook Book";
export const BUNDLED_PACK_CREATOR = "Fannie Merritt Farmer";

export const PACK_RECIPE_IDS = {
  thinWhiteSauce: "thin-white-sauce",
  boiledCustard: "boiled-custard",
  waffles: "waffles",
  parkerHouseRolls: "parker-house-rolls",
  doughnutsI: "doughnuts-i",
} as const;

/** Pack recipe titles in the order they appear in packs/drafts/fannie-farmer-1896.pack.json. */
export const BUNDLED_PACK_RECIPE_TITLES = [
  "Doughnuts I",
  "Parker House Rolls",
  "Boiled Custard",
  "Waffles",
  "Thin White Sauce",
] as const;

export const RECIPE_NAMES = {
  thinWhiteSauce: "Thin White Sauce",
  boiledCustard: "Boiled Custard",
  pantryTomatoSoup: "Pantry Tomato Soup",
  sesameGreenBeans: "Sesame Green Beans",
  waffles: "Waffles",
  herbOmelette: "Herb Omelette",
  parkerHouseRolls: "Parker House Rolls",
  doughnutsI: "Doughnuts I",
  weeknightPeaSoup: "Weeknight Pea Soup",
  quickCucumberSalad: "Quick Cucumber Salad",
} as const;

/**
 * Invented pending recipe (P3). Step 3 states a 12 minute simmer so cook mode
 * derives a timer offer on that screen (neither P1 nor P2 in the bundled pack
 * carries a step timer).
 */
export const PANTRY_TOMATO_SOUP_RECIPE: KitchenQueueRecipeData = {
  name: RECIPE_NAMES.pantryTomatoSoup,
  serves: 4,
  ingredients: [
    { amount: "1", unit: "tbsp", item: "olive oil" },
    { amount: "1", item: "yellow onion, diced" },
    { amount: "2", unit: "cloves", item: "garlic, minced" },
    { amount: "28", unit: "oz", item: "crushed tomatoes" },
    { amount: "2", unit: "cups", item: "vegetable broth" },
    { amount: "0.5", unit: "tsp", item: "salt" },
  ],
  steps: [
    "Warm the olive oil in a medium saucepan over medium heat.",
    "Add the diced onion and minced garlic and cook until softened.",
    "Stir in the crushed tomatoes, vegetable broth, and salt, then simmer uncovered for 12 minutes until thickened.",
    "Blend the soup until smooth, or leave it slightly chunky.",
    "Taste, adjust the salt if needed, and ladle into warm bowls.",
  ],
};

/** Invented pending recipe (P4), seeded with a settled cook-plan error. */
export const SESAME_GREEN_BEANS_RECIPE: KitchenQueueRecipeData = {
  name: RECIPE_NAMES.sesameGreenBeans,
  serves: 2,
  ingredients: [
    { amount: "12", unit: "oz", item: "green beans, trimmed" },
    { amount: "1", unit: "tbsp", item: "neutral cooking oil" },
    { amount: "1", unit: "tbsp", item: "soy sauce" },
    { amount: "1", unit: "tsp", item: "toasted sesame oil" },
    { amount: "1", unit: "tbsp", item: "sesame seeds" },
  ],
  steps: [
    "Pat the trimmed green beans dry with a clean towel.",
    "Heat the neutral oil in a wide skillet over medium-high heat.",
    "Cook the green beans, tossing occasionally, until blistered and crisp-tender.",
    "Remove from the heat, toss with soy sauce, toasted sesame oil, and sesame seeds, and serve.",
  ],
};

/** Invented completed recipe (F2). */
export const HERB_OMELETTE_RECIPE: KitchenQueueRecipeData = {
  name: RECIPE_NAMES.herbOmelette,
  serves: 1,
  ingredients: [
    { amount: "2", item: "large eggs" },
    { amount: "1", unit: "tbsp", item: "chopped fresh chives" },
    { amount: "1", unit: "tbsp", item: "chopped flat-leaf parsley" },
    { amount: "1", unit: "tsp", item: "unsalted butter" },
    { amount: "1", unit: "pinch", item: "salt" },
  ],
  steps: [
    "Beat the eggs with the salt, chives, and parsley until combined.",
    "Melt the butter in a small nonstick skillet over medium-low heat.",
    "Pour in the eggs and stir gently with a spatula as soft curds form.",
    "Fold the omelette in half once the center is just set and slide onto a plate.",
  ],
};

/** Invented JSON-LD recipe served by the local URL-import fixture. */
export const WEEKNIGHT_PEA_SOUP_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: RECIPE_NAMES.weeknightPeaSoup,
  recipeYield: "4",
  recipeIngredient: [
    "1 tbsp butter",
    "1 small onion, chopped",
    "3 cups vegetable stock",
    "16 oz frozen green peas",
    "0.5 tsp salt",
    "1 tbsp lemon juice",
  ],
  recipeInstructions: [
    {
      "@type": "HowToStep",
      text: "Melt the butter in a pot over medium heat and cook the chopped onion until translucent.",
    },
    {
      "@type": "HowToStep",
      text: "Pour in the vegetable stock and bring to a gentle boil.",
    },
    {
      "@type": "HowToStep",
      text: "Add the frozen peas and salt and cook until the peas are bright green and tender.",
    },
    {
      "@type": "HowToStep",
      text: "Blend until smooth, stir in the lemon juice, and serve warm.",
    },
  ],
} as const;

/** Plain-text recipe typed into the paste-import modal when no model key is configured. */
export const QUICK_CUCUMBER_SALAD_TEXT = [
  RECIPE_NAMES.quickCucumberSalad,
  "Serves 2",
  "",
  "Ingredients:",
  "- 1 large cucumber, thinly sliced",
  "- 1 tbsp rice vinegar",
  "- 1 tsp toasted sesame oil",
  "- 0.5 tsp kosher salt",
  "- 1 tsp sesame seeds",
  "",
  "Steps:",
  "1. Toss the sliced cucumber with the salt in a bowl and let stand briefly.",
  "2. Pour off any excess liquid from the bowl.",
  "3. Drizzle with rice vinegar and toasted sesame oil and toss to coat.",
  "4. Scatter with sesame seeds and serve chilled.",
].join("\n");
