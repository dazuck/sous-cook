import { unitFromAlias } from "@sous/pack/quantity";
import { conversionsOfAmount, opensMore, type IngredientLine, type MeasureRow } from "./ingredient-display";

/**
 * What a Get out amount opens when tapped: the conversions popover's contents (`MeasurementPopover`),
 * as the line's pair opens them on a step screen (asked 2026-11-22).
 */
export interface GetOutOpens {
  /** Each amount the recipe states, under "Recipe says"; none for a sum of two lines. */
  stated: MeasureRow[];
  /** The other units, computed. */
  conversions: MeasureRow[];
  /** Set when the line is scaled, so the stated heading reads "Recipe says, for 4". */
  servesBase?: number;
  /** A scaled count that rounding moved: its exact count. */
  exact?: string;
}

export interface GetOutItem {
  index: number;
  key: string;
  bare: string;
  withAmount: string;
  amount: string | null;
  /**
   * What the amount opens; unset where it is plain words. One line's amount opens what that line's
   * pair opens on a step (a measure its conversions, a scaled count that rounding moved its exact
   * count). A sum of lines the recipe names twice opens the conversions of the sum it shows, when
   * every part is a measure in one unit the table knows. Everything else is plain: a count, the
   * source's own words, a measure with nothing to convert, parts that don't add up to one measure
   * (the list says them side by side, "1 cup + 2 tbsp", which no one panel speaks for), and a line
   * of another shape.
   */
  opens?: GetOutOpens;
}

export interface GetOutModel {
  equipment: string[];
  fridge: GetOutItem[];
  pantry: GetOutItem[];
}

export type WholeIngredient =
  | IngredientLine
  | {
      kind?: IngredientLine["kind"];
      name?: string;
      item?: string;
      amount?: string | null;
      unit?: string | null;
    }
  | null
  | undefined;

export interface BuildGetOutInput {
  ingredients: readonly WholeIngredient[];
  steps?: readonly string[];
  notes?: readonly string[];
  taskTexts?: readonly string[];
}

const COUNT_UNIT_PREFIX_RE =
  /^(bunch|bunches|sprig|sprigs|clove|cloves|head|heads|can|cans|jar|jars|stalk|stalks|stem|stems|ear|ears|bulb|bulbs|pinch|pinches|dash|dashes|handful|handfuls|slice|slices|piece|pieces|package|packages|pkg|box|boxes|bag|bags|tin|tins|bottle|bottles)\b(?:\s+of\b)?\s+/i;

const TRAILING_NOTE_RE =
  /\s+\b(?:to taste|for serving|to serve|for garnish|for the table|for drizzling|for dusting|for greasing|for the pan|as needed|if needed|optional|divided)\b.*$/i;

const LEADING_PREP_RE =
  /^(?:(?:freshly|finely|thinly|coarsely|roughly|lightly)\s+)?(?:chopped|minced|diced|peeled|halved|quartered|trimmed|seeded|deveined|softened|melted|beaten|crumbled|shredded|grated|sliced)\s+/i;

function stripParens(text: string): string {
  return text.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

function capFirst(text: string): string {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  if (!text) return "";
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Clean pull-list display name for an ingredient line:
 * strips parentheticals, prep notes after commas/semicolons/dashes, leading
 * count/container words ("bunch spinach" -> "Spinach"), and capitalizes the first letter.
 */
export function getOutName(rawName: string): string {
  let clean = stripParens(rawName);
  clean = clean.split(/[,;—–]/)[0]?.trim() ?? "";
  clean = clean.replace(TRAILING_NOTE_RE, "").trim();

  const unitMatch = clean.match(COUNT_UNIT_PREFIX_RE);
  if (unitMatch && clean.slice(unitMatch[0].length).trim().length > 0) {
    clean = clean.slice(unitMatch[0].length).trim();
  }

  const prepMatch = clean.match(LEADING_PREP_RE);
  if (prepMatch && clean.slice(prepMatch[0].length).trim().length > 0) {
    clean = clean.slice(prepMatch[0].length).trim();
  }

  return capFirst(clean);
}

const PANTRY_EXACT = new Set([
  // Oils
  "oil",
  "olive oil",
  "extra-virgin olive oil",
  "extra virgin olive oil",
  "vegetable oil",
  "neutral oil",
  "sesame oil",
  "toasted sesame oil",
  "cooking oil",
  "canola oil",
  "avocado oil",
  "peanut oil",
  "coconut oil",
  "grapeseed oil",
  "sunflower oil",
  "chili oil",
  "chile oil",
  // Vinegars
  "vinegar",
  "rice vinegar",
  "white vinegar",
  "wine vinegar",
  "red wine vinegar",
  "white wine vinegar",
  "sherry vinegar",
  "champagne vinegar",
  "apple cider vinegar",
  "cider vinegar",
  "balsamic",
  "balsamic vinegar",
  // Salt & pepper
  "salt",
  "flaky salt",
  "kosher salt",
  "sea salt",
  "fine salt",
  "table salt",
  "black pepper",
  "white pepper",
  "pepper",
  "freshly ground black pepper",
  "cracked black pepper",
  "ground black pepper",
  "peppercorns",
  "black peppercorns",
  "salt and pepper",
  "salt & pepper",
  "salt and black pepper",
  "salt & black pepper",
  "kosher salt and black pepper",
  // Dried / ground spices & seasonings
  "cumin",
  "ground cumin",
  "cumin seeds",
  "paprika",
  "sweet paprika",
  "smoked paprika",
  "hot paprika",
  "turmeric",
  "ground turmeric",
  "coriander",
  "ground coriander",
  "coriander seeds",
  "garlic powder",
  "onion powder",
  "cinnamon",
  "ground cinnamon",
  "cinnamon stick",
  "cinnamon sticks",
  "cardamom",
  "ground cardamom",
  "cardamom pods",
  "cayenne",
  "cayenne pepper",
  "sumac",
  "chili crisp",
  "chile crisp",
  "chili flakes",
  "chile flakes",
  "red pepper flakes",
  "crushed red pepper",
  "crushed red pepper flakes",
  "chili powder",
  "chile powder",
  "curry powder",
  "garam masala",
  "za'atar",
  "zaatar",
  "allspice",
  "nutmeg",
  "ground ginger",
  "dried oregano",
  "oregano",
  "dried thyme",
  "dried rosemary",
  "dried basil",
  "bay leaf",
  "bay leaves",
  // Dry baking & pantry staples
  "sugar",
  "white sugar",
  "granulated sugar",
  "caster sugar",
  "brown sugar",
  "light brown sugar",
  "dark brown sugar",
  "powdered sugar",
  "confectioners' sugar",
  "icing sugar",
  "flour",
  "plain flour",
  "all-purpose flour",
  "bread flour",
  "whole wheat flour",
  "self-rising flour",
  "cornstarch",
  "cornflour",
  "baking soda",
  "bicarbonate of soda",
  "baking powder",
  "vanilla extract",
  "vanilla",
  "soy sauce",
  "tamari",
  "fish sauce",
  "oyster sauce",
  "hoisin sauce",
  "worcestershire sauce",
  "honey",
  "maple syrup",
  "mustard",
  "dijon mustard",
  "whole-grain mustard",
  "yellow mustard",
  "stock",
  "chicken stock",
  "vegetable stock",
  "beef stock",
  "broth",
  "chicken broth",
  "vegetable broth",
  "beef broth",
  "water",
  "ice water",
  "warm water",
  "hot water",
  "boiling water",
]);

const PANTRY_PATTERN_RE =
  /^(?:(?:extra[- ]virgin\s+|toasted\s+|light\s+|dark\s+)?(?:olive|vegetable|neutral|sesame|cooking|canola|avocado|peanut|coconut|grapeseed|sunflower|chili|chile)\s+oil|(?:rice|white|red\s+wine|white\s+wine|wine|apple\s+cider|cider|balsamic|sherry|champagne)\s+vinegar|(?:kosher\s+|flaky\s+|sea\s+|fine\s+)?salt(?:\s*(?:and|&)\s*(?:(?:freshly\s+ground\s+|cracked\s+)?black\s+)?pepper)?|(?:freshly\s+ground\s+|cracked\s+|ground\s+)?(?:black|white)\s+pepper|(?:ground\s+|whole\s+|toasted\s+)?(?:cumin|paprika|turmeric|coriander|cinnamon|cardamom|cayenne|sumac|oregano)|(?:sweet|smoked|hot)\s+paprika|(?:chili|chile|red\s+pepper)\s+(?:flakes|crisp|powder)|(?:garlic|onion|chili|chile|curry|baking)\s+powder|bay\s+lea(?:f|ves)|(?:white|brown|light\s+brown|dark\s+brown|granulated|caster|powdered)\s+sugar|(?:plain|all[- ]purpose|bread|whole\s+wheat|self[- ]rising)\s+flour|(?:chicken|vegetable|beef)\s+(?:stock|broth)|(?:dijon|whole[- ]grain|yellow)\s+mustard|(?:ice|warm|hot|boiling)\s+water)$/i;

const UNSTATED_OIL_SALT_PEPPER_RE =
  /\b(?:salt|pepper|olive\s+oil|vegetable\s+oil|neutral\s+oil|cooking\s+oil|sesame\s+oil|oil)\b/i;

function isPantryItem(
  key: string,
  kind: IngredientLine["kind"] | undefined,
  rawText: string,
): boolean {
  if (PANTRY_EXACT.has(key) || PANTRY_PATTERN_RE.test(key)) {
    return true;
  }
  if (
    (kind === "to_taste" || kind === "unstated") &&
    UNSTATED_OIL_SALT_PEPPER_RE.test(rawText)
  ) {
    return true;
  }
  return false;
}

/** Every vulgar-fraction glyph (U+00BC–BE, U+2150–215E). */
const FRACTION_VALUES: Record<string, number> = {
  "¼": 1 / 4,
  "½": 1 / 2,
  "¾": 3 / 4,
  "⅐": 1 / 7,
  "⅑": 1 / 9,
  "⅒": 1 / 10,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅕": 1 / 5,
  "⅖": 2 / 5,
  "⅗": 3 / 5,
  "⅘": 4 / 5,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 1 / 8,
  "⅜": 3 / 8,
  "⅝": 5 / 8,
  "⅞": 7 / 8,
};
const GLYPHS = Object.keys(FRACTION_VALUES).join("");
/**
 * An amount's number, longest reading first: a whole number with a fraction glyph ("1½", "1 ½"), a
 * glyph alone, a whole number with a typed fraction ("1 1/2"), a typed fraction, a decimal or whole
 * number. Then the rest, its unit.
 */
const AMOUNT_NUMBER_RE = new RegExp(
  `^(?:(\\d+)\\s*([${GLYPHS}])|([${GLYPHS}])|(\\d+)\\s+(\\d+)\\/(\\d+)|(\\d+)\\/(\\d+)|(\\d+(?:\\.\\d+)?))\\s*(.*)$`,
);
/**
 * What follows the number is no unit when it goes on with the amount: a range ("1-2 cups", "1 to 2"),
 * another fraction, or a second amount ("¾ cup + 4 tsp").
 */
const NOT_A_UNIT_RE = new RegExp(`^(?:[-–—/]|[${GLYPHS}]|(?:to|or)\\b)|\\+`);

/**
 * An amount that is one number and one unit ("1½ tbsp", "⅜ cup", "1 1/2 cups", "3"), read as that
 * number; null for anything more (a range, a compound amount, words), which can't be added up.
 */
export function parseSimpleAmount(amount: string): { value: number; unit: string } | null {
  const m = amount.trim().match(AMOUNT_NUMBER_RE);
  if (!m) return null;
  const unit = m[10].trim().toLowerCase();
  if (NOT_A_UNIT_RE.test(unit)) return null;

  let value: number;
  if (m[1] !== undefined) value = Number(m[1]) + FRACTION_VALUES[m[2]];
  else if (m[3] !== undefined) value = FRACTION_VALUES[m[3]];
  else if (m[4] !== undefined) value = Number(m[4]) + Number(m[5]) / Number(m[6]);
  else if (m[7] !== undefined) value = Number(m[7]) / Number(m[8]);
  else value = Number(m[9]);

  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, unit };
}

function normalizeUnitFamily(unit: string): string {
  const u = unit.toLowerCase().replace(/\.$/, "");
  if (u === "tbsp" || u === "tbsps" || u === "tablespoon" || u === "tablespoons") return "tbsp";
  if (u === "tsp" || u === "tsps" || u === "teaspoon" || u === "teaspoons") return "tsp";
  if (u === "cup" || u === "cups") return "cup";
  if (u === "clove" || u === "cloves") return "cloves";
  if (u === "sprig" || u === "sprigs") return "sprigs";
  if (u === "bunch" || u === "bunches") return "bunch";
  if (u === "can" || u === "cans") return "can";
  if (u === "lb" || u === "lbs" || u === "pound" || u === "pounds") return "lb";
  return u;
}

function formatNumberClean(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

/**
 * The amounts of one ingredient's lines as one, and whether they added up to a single measure.
 * Amounts in one unit family add up (in the first one's unit words); an amount in another unit, or
 * one that is no simple number (a range, a compound "¾ cup + 4 tsp", words), is said beside the
 * others as written, joined by " + ", so the item never shows less than the recipe asks for
 * (review round 1: the first amount used to stand for all of them). One amount is itself, as written.
 */
function mergeAmounts(amounts: readonly string[]): { amount: string; summed: boolean } {
  if (amounts.length === 1) return { amount: amounts[0], summed: true };
  type Term =
    | { added: true; family: string; unit: string; value: number; lines: number; text: string }
    | { added: false; text: string };
  const terms: Term[] = [];
  for (const text of amounts) {
    const read = parseSimpleAmount(text);
    if (!read) {
      terms.push({ added: false, text });
      continue;
    }
    const family = normalizeUnitFamily(read.unit);
    const same = terms.find((t) => t.added && t.family === family);
    if (same?.added) {
      same.value += read.value;
      same.lines += 1;
    } else {
      terms.push({ added: true, family, unit: read.unit, value: read.value, lines: 1, text });
    }
  }
  const said = terms.map((t) => {
    if (!t.added || t.lines === 1) return t.text;
    return t.unit ? `${formatNumberClean(t.value)} ${t.unit}` : formatNumberClean(t.value);
  });
  return { amount: said.join(" + "), summed: terms.length === 1 && terms[0].added };
}

/** What one line's amount opens, as its pair does on a step (`CookFlow`'s `Pair`); null where it is plain. */
function opensOfLine(line: IngredientLine | null): GetOutOpens | null {
  if (line === null) return null;
  if (line.kind === "amount") {
    const opens: GetOutOpens = {
      stated: line.stated,
      conversions: line.conversions,
      ...(line.servesBase !== undefined ? { servesBase: line.servesBase } : {}),
    };
    return opensMore(opens) ? opens : null;
  }
  if (line.kind === "count" && line.exact !== undefined) return { stated: [], conversions: [], exact: line.exact };
  return null;
}

/**
 * What a sum of several lines' amounts opens: the conversions of the sum as shown, when every part
 * is a measured line and the sum reads as a number in one unit the table knows. No "Recipe says":
 * the recipe says each part, not the sum.
 */
function opensOfSum(amount: string, parts: readonly (IngredientLine | null)[]): GetOutOpens | null {
  if (!parts.every((line) => line !== null && line.kind === "amount")) return null;
  const read = parseSimpleAmount(amount);
  const unit = read ? unitFromAlias(read.unit) : undefined;
  if (!read || !unit) return null;
  const opens: GetOutOpens = { stated: [], conversions: conversionsOfAmount(read.value, unit.id) };
  return opensMore(opens) ? opens : null;
}

/** An entry that is a cook's line (`ingredientLine`), not a stored `{ item, amount, unit }` row. */
function isIngredientLine(ing: NonNullable<WholeIngredient>): ing is IngredientLine {
  if (!("kind" in ing) || typeof ing.name !== "string") return false;
  switch (ing.kind) {
    case "amount":
      return "stated" in ing && Array.isArray(ing.stated) && "conversions" in ing && Array.isArray(ing.conversions);
    case "count":
    case "as_written":
      return typeof ing.amount === "string";
    case "to_taste":
    case "unstated":
      return true;
    default:
      return false;
  }
}

function normalizeIngredientEntry(
  ing: WholeIngredient,
  index: number,
): {
  index: number;
  key: string;
  bare: string;
  amount: string | null;
  kind: IngredientLine["kind"] | undefined;
  rawText: string;
  /** The entry as the cook's pairs read it, when it is such a line (`StoredIngredientLines`); else null. */
  line: IngredientLine | null;
} | null {
  if (!ing) return null;

  const rawName = ("name" in ing && typeof ing.name === "string"
    ? ing.name
    : "item" in ing && typeof ing.item === "string"
      ? ing.item
      : ""
  ).trim();
  if (!rawName) return null;

  const kind = "kind" in ing ? ing.kind : undefined;
  const isUnstated =
    kind === "to_taste" ||
    kind === "unstated" ||
    /\bto taste\b/i.test(rawName);

  const strippedParensName = stripParens(rawName);
  const beforeComma = strippedParensName.split(/[,;—–]/)[0]?.trim() ?? "";
  const unitPrefixMatch = beforeComma.match(COUNT_UNIT_PREFIX_RE);
  const extractedCountUnit =
    unitPrefixMatch && beforeComma.slice(unitPrefixMatch[0].length).trim().length > 0
      ? unitPrefixMatch[1].toLowerCase()
      : null;

  const bare = getOutName(rawName);
  if (!bare) return null;

  let amount: string | null = null;
  if (!isUnstated) {
    const rawAmt =
      "amount" in ing && typeof ing.amount === "string" ? stripParens(ing.amount) : "";
    const rawUnit =
      "unit" in ing && typeof ing.unit === "string" ? stripParens(ing.unit) : "";

    if (rawAmt && rawUnit) {
      amount = `${rawAmt} ${rawUnit}`.trim();
    } else if (rawAmt) {
      if (
        extractedCountUnit &&
        !new RegExp(`\\b${extractedCountUnit}\\b`, "i").test(rawAmt)
      ) {
        amount = `${rawAmt} ${extractedCountUnit}`.trim();
      } else {
        amount = rawAmt;
      }
    } else if (rawUnit) {
      amount = rawUnit;
    }
  }

  if (amount === "" || amount === "—") {
    amount = null;
  }

  return {
    index,
    key: bare.toLowerCase(),
    bare,
    amount,
    kind,
    rawText: rawName,
    line: isIngredientLine(ing) ? ing : null,
  };
}

interface EquipmentRule {
  label: string;
  family: string;
  generic?: boolean;
  pattern: string;
}

const EQUIPMENT_RULES: readonly EquipmentRule[] = [
  // Baking / roasting (specific before generic)
  {
    label: "2 sheet pans",
    family: "sheet-pan",
    pattern: String.raw`\b(?:2|two)\s+(?:rimmed\s+|large\s+)?(?:sheet\s+pans?|baking\s+sheets?)\b|\bsheet\s+pans\b|\bbaking\s+sheets\b`,
  },
  {
    label: "Sheet pan",
    family: "sheet-pan",
    generic: true,
    pattern: String.raw`\b(?:rimmed\s+|large\s+)?sheet\s+pan\b`,
  },
  {
    label: "Baking sheet",
    family: "sheet-pan",
    generic: true,
    pattern: String.raw`\b(?:rimmed\s+|large\s+)?baking\s+sheet\b`,
  },
  {
    label: "Second roasting tin",
    family: "roasting-tin-2",
    pattern: String.raw`\bsecond\s+roasting\s+tins?\b`,
  },
  {
    label: "Roasting tin",
    family: "roasting-tin",
    pattern: String.raw`\broasting\s+tins?\b`,
  },
  {
    label: "Roasting pan",
    family: "roasting-pan",
    pattern: String.raw`\broasting\s+pans?\b`,
  },
  {
    label: "Baking dish",
    family: "baking-dish",
    pattern: String.raw`\bbaking\s+dish(?:es)?\b`,
  },

  // Skillets / pans (specific before generic)
  {
    label: "Carbon steel pan",
    family: "skillet",
    pattern: String.raw`\bcarbon[- ]steel\s+(?:skillets?|pans?)\b`,
  },
  {
    label: "Cast-iron skillet",
    family: "skillet",
    pattern: String.raw`\bcast[- ]iron\s+(?:skillets?|pans?)\b`,
  },
  {
    label: "Nonstick skillet",
    family: "skillet",
    pattern: String.raw`\bnon[- ]?stick\s+(?:skillets?|pans?)\b`,
  },
  {
    label: "12-inch skillet",
    family: "skillet",
    pattern: String.raw`\b12[- ]inch\s+(?:skillets?|pans?)\b`,
  },
  {
    label: "Large skillet",
    family: "skillet",
    pattern: String.raw`\blarge\s+(?:heavy\s+)?skillets?\b`,
  },
  {
    label: "Sauté pan",
    family: "skillet",
    pattern: String.raw`\bsaut[eé]\s+pans?\b`,
  },
  {
    label: "Frying pan",
    family: "skillet",
    pattern: String.raw`\bfrying\s+pans?\b`,
  },
  {
    label: "Grill pan",
    family: "grill-pan",
    pattern: String.raw`\bgrill\s+pans?\b`,
  },
  {
    label: "Wok",
    family: "wok",
    pattern: String.raw`\bwoks?\b`,
  },
  {
    label: "Skillet",
    family: "skillet",
    generic: true,
    pattern: String.raw`\bskillets?\b`,
  },

  // Pots / Dutch ovens (specific before generic)
  {
    label: "Dutch oven",
    family: "pot",
    pattern: String.raw`\bdutch\s+ovens?\b`,
  },
  {
    label: "Stockpot",
    family: "pot",
    pattern: String.raw`\bstock\s*pots?\b`,
  },
  {
    label: "Large pot",
    family: "pot",
    pattern: String.raw`\blarge\s+(?:heavy\s+)?pots?\b`,
  },
  {
    label: "Medium pot",
    family: "pot",
    pattern: String.raw`\bmedium\s+(?:heavy\s+)?pots?\b`,
  },
  {
    label: "Medium saucepan",
    family: "saucepan",
    pattern: String.raw`\bmedium\s+(?:heavy[- ]bottomed\s+|heavy\s+)?saucepans?\b`,
  },
  {
    label: "Small saucepan",
    family: "saucepan",
    pattern: String.raw`\bsmall\s+(?:heavy[- ]bottomed\s+|heavy\s+)?saucepans?\b`,
  },
  {
    label: "Saucepan",
    family: "saucepan",
    generic: true,
    pattern: String.raw`\bsaucepans?\b`,
  },
  {
    label: "Pot",
    family: "pot",
    generic: true,
    pattern: String.raw`\bpots?\b`,
  },

  // Appliances & prep hardware
  {
    label: "Food processor",
    family: "food-processor",
    pattern: String.raw`\bfood\s+processors?\b`,
  },
  {
    label: "Immersion blender",
    family: "blender",
    pattern: String.raw`\b(?:immersion|stick|hand)\s+blenders?\b`,
  },
  {
    label: "Blender",
    family: "blender",
    generic: true,
    pattern: String.raw`\bblenders?\b`,
  },
  {
    label: "Stand mixer",
    family: "stand-mixer",
    pattern: String.raw`\bstand\s+mixers?\b`,
  },
  {
    label: "Fine-mesh strainer",
    family: "strainer",
    pattern: String.raw`\bfine[- ]mesh\s+(?:strainers?|sieves?)\b`,
  },
  {
    label: "Strainer",
    family: "strainer",
    generic: true,
    pattern: String.raw`\b(?:strainers?|sieves?)\b`,
  },
  {
    label: "Colander",
    family: "colander",
    pattern: String.raw`\bcolanders?\b`,
  },
  {
    label: "Salad spinner",
    family: "salad-spinner",
    pattern: String.raw`\bsalad\s+spinners?\b`,
  },
  {
    label: "Box grater",
    family: "box-grater",
    pattern: String.raw`\bbox\s+graters?\b`,
  },
  {
    label: "Microplane",
    family: "microplane",
    pattern: String.raw`\bmicroplanes?\b`,
  },
  {
    label: "Mortar and pestle",
    family: "mortar-pestle",
    pattern: String.raw`\bmortar\s+and\s+pestle\b`,
  },
  {
    label: "Meat thermometer",
    family: "thermometer",
    pattern: String.raw`\b(?:meat|instant[- ]read|probe)\s+thermometers?\b`,
  },
  {
    label: "Thermometer",
    family: "thermometer",
    generic: true,
    pattern: String.raw`\bthermometers?\b`,
  },
  {
    label: "Kitchen twine",
    family: "twine",
    pattern: String.raw`\b(?:kitchen|butcher'?s)\s+twine\b`,
  },
  {
    label: "Large bowl",
    family: "large-bowl",
    pattern: String.raw`\blarge\s+(?:mixing\s+|heatproof\s+)?bowls?\b`,
  },
  {
    label: "Medium bowl",
    family: "medium-bowl",
    pattern: String.raw`\bmedium\s+(?:mixing\s+|heatproof\s+)?bowls?\b`,
  },
  {
    label: "Zip-top bags",
    family: "zip-top",
    pattern: String.raw`\bzip[- ]top\s+(?:plastic\s+)?bags?\b|\bresealable\s+plastic\s+bags?\b`,
  },
  {
    label: "Lid",
    family: "lid",
    pattern: String.raw`\blids?\b`,
  },
  {
    label: "Foil",
    family: "foil",
    pattern: String.raw`\b(?:aluminum\s+|aluminium\s+|tin\s+)?foil\b`,
  },
  {
    label: "Parchment paper",
    family: "parchment",
    pattern: String.raw`\bparchment(?:\s+paper)?\b`,
  },
];

const COMBINED_EQUIPMENT_RE = new RegExp(
  EQUIPMENT_RULES.map((r, i) => `(?<r${i}>${r.pattern})`).join("|"),
  "gi",
);

function extractEquipment(texts: readonly string[]): string[] {
  const matchedRules: EquipmentRule[] = [];
  const seenLabels = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    COMBINED_EQUIPMENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMBINED_EQUIPMENT_RE.exec(text)) !== null) {
      const groups = m.groups;
      if (!groups) continue;
      for (let i = 0; i < EQUIPMENT_RULES.length; i++) {
        if (groups[`r${i}`] !== undefined) {
          const rule = EQUIPMENT_RULES[i];
          if (!seenLabels.has(rule.label)) {
            seenLabels.add(rule.label);
            matchedRules.push(rule);
          }
          break;
        }
      }
    }
  }

  // Upgrade "Sheet pan" to "2 sheet pans" if a "second sheet pan" or "another sheet pan" was mentioned
  const fullText = texts.join(" ");
  if (
    /\b(?:second|another|other|both)\s+(?:rimmed\s+)?(?:sheet\s+pan|baking\s+sheet)\b/i.test(
      fullText,
    )
  ) {
    const idx = matchedRules.findIndex((r) => r.family === "sheet-pan");
    const twoSheetRule = EQUIPMENT_RULES[0];
    if (idx !== -1 && matchedRules[idx].label !== "2 sheet pans") {
      matchedRules[idx] = twoSheetRule;
      seenLabels.add("2 sheet pans");
    }
  }

  const specificFamilies = new Set<string>();
  for (const rule of matchedRules) {
    if (!rule.generic) {
      specificFamilies.add(rule.family);
      // A qualified saucepan ("Medium saucepan", "Small saucepan") also suppresses bare "Pot"
      if (rule.family === "saucepan") {
        specificFamilies.add("pot");
      }
    }
  }

  const result: string[] = [];
  const emitted = new Set<string>();
  for (const rule of matchedRules) {
    if (rule.generic && specificFamilies.has(rule.family)) {
      continue;
    }
    if (!emitted.has(rule.label)) {
      emitted.add(rule.label);
      result.push(rule.label);
    }
  }

  return result;
}

export function buildGetOut(input: BuildGetOutInput): GetOutModel {
  const deduped = new Map<
    string,
    {
      index: number;
      key: string;
      bare: string;
      amount: string | null;
      pantry: boolean;
      /** Each line's amount, in order (`mergeAmounts` makes `amount` of them). */
      amounts: string[];
      /** The lines whose amounts make `amount`, in order. */
      parts: (IngredientLine | null)[];
      /** The amounts add up to one measure, which `amount` is; false when it says several side by side. */
      whole: boolean;
    }
  >();

  input.ingredients.forEach((ing, index) => {
    const entry = normalizeIngredientEntry(ing, index);
    if (!entry) return;
    const pantry = isPantryItem(entry.key, entry.kind, entry.rawText);
    const existing = deduped.get(entry.key);
    if (existing) {
      existing.pantry = existing.pantry || pantry;
      if (entry.amount === null) return;
      existing.amounts.push(entry.amount);
      existing.parts.push(entry.line);
      const merged = mergeAmounts(existing.amounts);
      existing.amount = merged.amount;
      existing.whole = merged.summed;
    } else {
      deduped.set(entry.key, {
        index: entry.index,
        key: entry.key,
        bare: entry.bare,
        amount: entry.amount,
        pantry,
        amounts: entry.amount === null ? [] : [entry.amount],
        parts: entry.amount === null ? [] : [entry.line],
        whole: true,
      });
    }
  });

  const fridge: GetOutItem[] = [];
  const pantry: GetOutItem[] = [];

  for (const item of deduped.values()) {
    const withAmount = item.amount
      ? `${item.amount} ${lowerFirst(item.bare)}`
      : item.bare;
    const opens =
      item.amount === null || !item.whole
        ? null
        : item.parts.length === 1
          ? opensOfLine(item.parts[0])
          : opensOfSum(item.amount, item.parts);
    const outItem: GetOutItem = {
      index: item.index,
      key: item.key,
      bare: item.bare,
      withAmount,
      amount: item.amount,
      ...(opens ? { opens } : {}),
    };
    if (item.pantry) {
      pantry.push(outItem);
    } else {
      fridge.push(outItem);
    }
  }

  const allTexts = [
    ...(input.steps ?? []),
    ...(input.notes ?? []),
    ...(input.taskTexts ?? []),
  ];
  const equipment = extractEquipment(allTexts);

  return {
    equipment,
    fridge,
    pantry,
  };
}
