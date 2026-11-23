import type { IngredientLine } from "./ingredient-display";

export interface GetOutItem {
  index: number;
  key: string;
  bare: string;
  withAmount: string;
  amount: string | null;
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

const FRACTION_VALUES: Record<string, number> = {
  "¼": 0.25,
  "½": 0.5,
  "¾": 0.75,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅛": 0.125,
};

function parseSimpleAmount(amount: string): { value: number; unit: string } | null {
  const trimmed = amount.trim();
  const m = trimmed.match(
    /^(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+|\d*[¼½¾⅓⅔⅛])\s*(.*)$/,
  );
  if (!m) return null;
  const numPart = m[1].trim();
  const unit = m[2].trim().toLowerCase();

  let value = 0;
  const mixedMatch = numPart.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  const fracMatch = numPart.match(/^(\d+)\/(\d+)$/);
  const unicodeMatch = numPart.match(/^(\d*)([¼½¾⅓⅔⅛])$/);

  if (mixedMatch) {
    value = Number(mixedMatch[1]) + Number(mixedMatch[2]) / Number(mixedMatch[3]);
  } else if (fracMatch) {
    value = Number(fracMatch[1]) / Number(fracMatch[2]);
  } else if (unicodeMatch) {
    const whole = unicodeMatch[1] ? Number(unicodeMatch[1]) : 0;
    value = whole + (FRACTION_VALUES[unicodeMatch[2]] ?? 0);
  } else {
    value = Number(numPart);
  }

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

function combineAmounts(first: string | null, second: string | null): string | null {
  if (!first) return second;
  if (!second) return first;
  const p1 = parseSimpleAmount(first);
  const p2 = parseSimpleAmount(second);
  if (p1 && p2 && normalizeUnitFamily(p1.unit) === normalizeUnitFamily(p2.unit)) {
    const sum = p1.value + p2.value;
    const unitText = p1.unit || p2.unit;
    return unitText ? `${formatNumberClean(sum)} ${unitText}` : formatNumberClean(sum);
  }
  return first;
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
    }
  >();

  input.ingredients.forEach((ing, index) => {
    const entry = normalizeIngredientEntry(ing, index);
    if (!entry) return;
    const pantry = isPantryItem(entry.key, entry.kind, entry.rawText);
    const existing = deduped.get(entry.key);
    if (existing) {
      existing.amount = combineAmounts(existing.amount, entry.amount);
      existing.pantry = existing.pantry || pantry;
    } else {
      deduped.set(entry.key, {
        index: entry.index,
        key: entry.key,
        bare: entry.bare,
        amount: entry.amount,
        pantry,
      });
    }
  });

  const fridge: GetOutItem[] = [];
  const pantry: GetOutItem[] = [];

  for (const item of deduped.values()) {
    const withAmount = item.amount
      ? `${item.amount} ${lowerFirst(item.bare)}`
      : item.bare;
    const outItem: GetOutItem = {
      index: item.index,
      key: item.key,
      bare: item.bare,
      withAmount,
      amount: item.amount,
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
