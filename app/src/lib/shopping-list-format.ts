/**
 * Pure, client-safe shopping list types, line format, aisle classification,
 * and grouping helpers: what the app and a shopping-list hook
 * (`lib/hooks/types.ts`, `ShoppingListStore`) share. No server imports, so
 * client components (`ShoppingListModal.tsx`) can use them without pulling
 * `db.ts` into the browser bundle.
 */

export const SHOPPING_AISLES = [
  "Produce",
  "Dairy & eggs",
  "Meat & seafood",
  "Pantry",
  "Spices & sauces",
  "Frozen",
  "Bakery",
  "Other",
] as const;

export type ShoppingAisle = (typeof SHOPPING_AISLES)[number];
export type ShoppingGroupMode = "aisle" | "recipe" | "all";

export interface ShoppingListItem {
  /** Raw bullet line without leading bullet glyph, e.g. "Lemons (2) — Tue beans" */
  raw: string;
  /** Item name/quantity before " — ", e.g. "Lemons (2)" */
  item: string;
  /** Optional recipe/context after " — ", e.g. "Tue beans" */
  forRecipe: string | null;
  /** Normalized deduplication key (`shopItemKey`) */
  key: string;
  /** Deterministic grocery aisle classification */
  aisle: ShoppingAisle;
}

export interface ShoppingGroup {
  label: string | null;
  items: ShoppingListItem[];
}

function stripLeadingBullet(text: string): string {
  return text.replace(/^[•◦▪‣·*-]\s+/, "").trim();
}

/**
 * Normalizes an item string to its deduplication key:
 * `'Lemons (2) — Tue beans'` and `'lemons'` both map to `'lemons'`.
 */
export function shopItemKey(text: string): string {
  const clean = stripLeadingBullet(text);
  const base = (clean.split(" — ")[0] ?? "")
    .replace(/\s*\(.*?\)/g, "")
    .replace(/,.*$/, "")
    .trim()
    .toLowerCase();
  return base;
}

const AISLE_PATTERNS: ReadonlyArray<{ aisle: ShoppingAisle; pattern: RegExp }> = [
  {
    aisle: "Frozen",
    pattern: /\b(frozen|ice cream|popsicle|edamame|puff pastry)\b/i,
  },
  {
    aisle: "Spices & sauces",
    pattern:
      /\b(salt|peppercorn|black pepper|white pepper|cumin|coriander|paprika|turmeric|cinnamon|cardamom|cloves?|nutmeg|chili|chilli|chile|cayenne|oregano|bay lea(?:f|ves)|spice|seasoning|furikake|za'?atar|sumac|garam masala|curry powder|miso|soy sauce|tamari|fish sauce|oyster sauce|hoisin|sriracha|chili crisp|gochujang|sambal|tahini|mustard|ketchup|mayo|mayonnaise|vinegar|mirin|shaoxing|cooking wine|sesame oil|olive oil|coconut oil|vegetable oil|canola oil|avocado oil|peanut oil|oil|sauce|harissa|worcestershire|ponzu|chutney|pesto|vanilla|extract)\b/i,
  },
  {
    aisle: "Dairy & eggs",
    pattern:
      /\b(milk|cream|half and half|butter|ghee|cheese|cheddar|parmesan|parmigiano|pecorino|mozzarella|burrata|feta|ricotta|mascarpone|gruyere|goat cheese|paneer|yogurt|kefir|sour cream|cr[eè]me fra[iî]che|eggs?)\b/i,
  },
  {
    aisle: "Meat & seafood",
    pattern:
      /\b(chicken|beef|pork|lamb|turkey|duck|sausage|chorizo|bacon|pancetta|guanciale|prosciutto|ham|steak|brisket|ribs?|ground|fish|salmon|tuna|cod|halibut|trout|tilapia|shrimp|prawns?|scallops?|clams?|mussels?|crab|lobster|anchov(?:y|ies)|sardines?)\b/i,
  },
  {
    aisle: "Bakery",
    pattern:
      /\b(bread|sourdough|baguette|ciabatta|brioche|buns?|rolls?|pita|naan|tortillas?|bagels?|croissants?|english muffins?|panko|breadcrumbs?)\b/i,
  },
  {
    aisle: "Produce",
    pattern:
      /\b(lemons?|limes?|oranges?|grapefruits?|apples?|bananas?|berries|strawberries|blueberries|raspberries|grapes?|melon|peaches?|pears?|plums?|mangos?|mangoes|pineapple|avocados?|tomato(?:es)?|potato(?:es)?|sweet potato(?:es)?|yams?|onions?|shallots?|garlic|ginger|scallions?|green onions?|leeks?|carrots?|celery|cabbage|lettuce|spinach|kale|arugula|chard|collards?|bok choy|greens?|broccoli|cauliflower|brussels sprouts?|zucchini|squash|cucumbers?|bell peppers?|jalape[nñ]os?|serranos?|poblano|habanero|peppers?|mushrooms?|corn|asparagus|green beans?|snap peas?|snow peas?|radish(?:es)?|beets?|turnips?|parsnips?|fennel|eggplant|artichokes?|herbs?|cilantro|parsley|basil|mint|dill|thyme|rosemary|sage|chives?|tarragon|scallion)\b/i,
  },
  {
    aisle: "Pantry",
    pattern:
      /\b(beans?|cannellini|chickpeas?|garbanzo|lentils?|dal|peas?|rice|basmati|jasmine|arborio|pasta|spaghetti|penne|rigatoni|orzo|lasagna|udon|soba|ramen|noodles?|flour|sugar|brown sugar|powdered sugar|honey|maple syrup|agave|molasses|broth|stock|bouillon|canned|cans?|coconut milk|tomato paste|crushed tomatoes|diced tomatoes|whole peeled tomatoes|nuts?|almonds?|walnuts?|pecans?|peanuts?|cashews?|pistachios?|pine nuts?|seeds?|sesame|chia|flax|sunflower|pumpkin seeds?|pepitas|oats?|oatmeal|quinoa|farro|barley|bulgur|couscous|polenta|grits|cornmeal|cornstarch|starch|baking powder|baking soda|yeast|chocolate|cocoa|tofu|tempeh|seitan|peanut butter|almond butter|jam|jelly|crackers?|chips?|capers?|olives?|pickles?)\b/i,
  },
];

/**
 * Deterministically assigns an item to one of `SHOPPING_AISLES` using
 * keyword patterns, defaulting to `"Other"` when unmatched.
 */
export function classifyShoppingAisle(item: string): ShoppingAisle {
  const cleaned =
    stripLeadingBullet(item)
      .split(" — ")[0]
      ?.replace(/\s*\(.*?\)/g, " ") ?? "";
  for (const { aisle, pattern } of AISLE_PATTERNS) {
    if (pattern.test(cleaned)) {
      return aisle;
    }
  }
  return "Other";
}

/**
 * Formats an item + optional recipe/context tag into a single list line.
 */
export function formatShoppingLine(
  item: string,
  forRecipe?: string | null,
): string {
  const cleanItem = stripLeadingBullet(item)
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  if (!cleanItem) {
    throw new Error("Shopping list item cannot be empty.");
  }
  const cleanFor = (forRecipe ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (cleanFor && !cleanItem.includes(" — ")) {
    return `${cleanItem} — ${cleanFor}`;
  }
  return cleanItem;
}

/**
 * Parses a raw bullet line (`"<item>"` or `"<item> — <for>"`) into a `ShoppingListItem`.
 */
export function parseShoppingLine(rawLine: string): ShoppingListItem {
  const raw = stripLeadingBullet(rawLine).replace(/[\r\n]+/g, " ").trim();
  const parts = raw.split(" — ");
  const item = (parts[0] ?? "").trim();
  const forRecipe =
    parts.length > 1 ? parts.slice(1).join(" — ").trim() || null : null;
  return {
    raw,
    item,
    forRecipe,
    key: shopItemKey(raw),
    aisle: classifyShoppingAisle(item),
  };
}

/**
 * Groups shopping list items by `"aisle"`, `"recipe"`, or `"all"` (flat).
 */
export function groupShoppingItems(
  items: ShoppingListItem[],
  mode: ShoppingGroupMode,
): ShoppingGroup[] {
  if (items.length === 0) {
    return [];
  }
  if (mode === "all") {
    return [{ label: null, items }];
  }
  if (mode === "aisle") {
    const byAisle = new Map<ShoppingAisle, ShoppingListItem[]>();
    for (const item of items) {
      const list = byAisle.get(item.aisle) ?? [];
      list.push(item);
      byAisle.set(item.aisle, list);
    }
    return SHOPPING_AISLES.filter((aisle) => byAisle.has(aisle)).map(
      (aisle) => ({
        label: aisle,
        items: byAisle.get(aisle)!,
      }),
    );
  }
  // mode === "recipe"
  const byRecipe = new Map<string, ShoppingListItem[]>();
  const general: ShoppingListItem[] = [];
  for (const item of items) {
    if (!item.forRecipe) {
      general.push(item);
    } else {
      const list = byRecipe.get(item.forRecipe) ?? [];
      list.push(item);
      byRecipe.set(item.forRecipe, list);
    }
  }
  const groups: ShoppingGroup[] = Array.from(byRecipe.entries()).map(
    ([label, groupItems]) => ({
      label,
      items: groupItems,
    }),
  );
  if (general.length > 0) {
    groups.push({ label: "General", items: general });
  }
  return groups;
}
