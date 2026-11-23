/**
 * Recipe grounding: checking an extracted recipe against the text it came
 * from.
 *
 * The import prompt tells the model to take only what the source gives, and
 * it mostly does. It still sometimes writes a method for a tab that lists
 * only ingredients, translates a recipe it should have copied, adds a serving
 * count or pads the notes. This compares each part of the extraction with the
 * source's words and takes out the parts the source doesn't give:
 *
 * - ingredients mostly missing from the source: the whole extraction fails,
 *   since there is nothing faithful left to keep;
 * - a method or notes mostly missing: that part is left out, with a notice
 *   saying so, and the rest is kept;
 * - a serving count the source doesn't state: left out quietly, since the
 *   importer never asks the model to infer one.
 *
 * Words are compared loosely (stemmed, abbreviations spelled out, accents
 * dropped) so a rewording of the source's own method passes. That leniency
 * has limits, pinned in the calibration table in the tests: the check is per
 * part, so a few made-up steps in a mostly faithful method pass; words on a
 * web page around the recipe (comments, related recipes) can ground a
 * made-up method; and a method written in initialisms ("IP, HP 25m") can't be
 * matched to its spelled-out steps, so it is left out. On a terse source
 * the margin is thin: a faithful method of a few words, heavily reworded,
 * can fall under the threshold (on the family's recipes doc, faithful
 * methods scored 0.80 or more and made-up ones 0). Image imports have no
 * source text and aren't checked.
 */

import type { ImportedRecipe } from "./recipe-import";

/** A part of an extraction that was left out, for the cook to see. */
export type ExtractionNotice = {
  kind: "method-dropped" | "notes-dropped";
  message: string;
};

// Words common to any method, which match whatever the source says.
const STOPWORDS = new Set(
  (
    "the and for with into onto until then from this that these those your " +
    "you all are can each over about when while them its per but not out " +
    "off any some more than has have was were will just also very too " +
    "after before again everything together ingredient ingredients well " +
    "degree degrees step steps approximately serve served serves serving " +
    "servings"
  ).split(" "),
);

// Short forms spelled out before words under three letters are dropped, so a
// source's "1 hr" or "25m" still matches an extraction's "1 hour", and a
// tab's "evoo" its extraction's "olive oil".
const ABBREVIATIONS: Record<string, string> = {
  m: "minute",
  min: "minute",
  mins: "minute",
  h: "hour",
  hr: "hour",
  hrs: "hour",
  sec: "second",
  secs: "second",
  tbsp: "tablespoon",
  tbs: "tablespoon",
  tbl: "tablespoon",
  tsp: "teaspoon",
  temp: "temperature",
  med: "medium",
  approx: "approximately",
  f: "fahrenheit",
  c: "cup",
  oz: "ounce",
  lb: "pound",
  lbs: "pound",
  qt: "quart",
  pkg: "package",
  til: "until",
  till: "until",
  g: "gram",
  kg: "kilogram",
  ml: "milliliter",
  evoo: "extra virgin olive oil",
  xvoo: "extra virgin olive oil",
  acv: "apple cider vinegar",
  pb: "peanut butter",
  parm: "parmesan",
};

// "s&p", "s+p" or "s/p": its letters are too short to survive as words.
const SALT_AND_PEPPER = /\bs\s*[&+/]\s*p\b/g;

// Forms the suffix rules can't fold: irregular plurals ("leaves" would stem
// apart from "leaf") and spellings of one word ("chile" and "chili").
const WORD_FORMS: Record<string, string> = {
  leaves: "leaf",
  loaves: "loaf",
  halves: "half",
  chile: "chili",
  chiles: "chili",
};

/**
 * Folds a word's forms together: "chopped" and "chop", "diced" and "dice",
 * "fries" and "fry", "dressings" and "dressing". Crude, and only ever
 * compared with itself, so it needs to be consistent rather than right: the
 * plural comes off first, so a word and its plural take the same path
 * through the rest.
 */
function stem(word: string): string {
  let stemmed = WORD_FORMS[word] ?? word;
  if (/ies$/.test(stemmed) && stemmed.length > 4) {
    stemmed = stemmed.slice(0, -3) + "y";
  } else if (/(ch|sh|ss|x|z|o)es$/.test(stemmed)) {
    stemmed = stemmed.slice(0, -2);
  } else if (/[^s]s$/.test(stemmed) && stemmed.length > 3) {
    stemmed = stemmed.slice(0, -1);
  }
  const bare = stemmed.replace(/(ing|ed)$/, "");
  if (bare !== stemmed && bare.length >= 3) stemmed = bare;
  if (stemmed.endsWith("e") && stemmed.length > 3) {
    stemmed = stemmed.slice(0, -1);
  }
  if (/([b-df-hj-np-tv-z])\1$/.test(stemmed)) stemmed = stemmed.slice(0, -1);
  if (stemmed.endsWith("y") && stemmed.length >= 3) {
    stemmed = stemmed.slice(0, -1) + "i";
  }
  return stemmed.slice(0, 5);
}

/**
 * The words of a text that can tell one recipe from another: letters in any
 * script and numbers of two digits or more, stemmed, with abbreviations and
 * kitchen shorthand spelled out and common words dropped.
 */
export function groundingWords(text: string): string[] {
  const tokens =
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(SALT_AND_PEPPER, " salt pepper ")
      .match(/\p{L}+|[0-9]+/gu) ?? [];
  const words: string[] = [];
  for (const token of tokens) {
    if (/^[0-9]+$/.test(token)) {
      if (token.length >= 2) words.push(token);
      continue;
    }
    for (const word of (ABBREVIATIONS[token] ?? token).split(" ")) {
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      words.push(stem(word));
    }
  }
  return words;
}

/** How many of a part's words were checked, and how many are in the source. */
export type Grounding = { counted: number; grounded: number };

// An ingredient's name without its preparation: "potatoes, sliced thin".
const ingredientHead = (item: string) => item.split(/[,(]/)[0];

/**
 * Counts the words of the method, ingredients and notes that appear in the
 * source.
 *
 * A method or notes can repeat any ingredient or the recipe's name, so those
 * words say nothing about whether the method came from the source and aren't
 * counted. The name is the model's, though, and can add words the source
 * lacks ("Blended Coffee Slushie" for a tab titled "coffee slushie"), so a
 * name word goes uncounted only where the source has it. Ingredients are counted one per ingredient: grounded if any word
 * of its name is in the source. A word of the recipe's name that is in the
 * source doesn't count for an ingredient either, since the title alone would
 * ground it ("coffee" in a tab titled "coffee slushie"); an ingredient with
 * no other words isn't counted.
 */
export function measureGrounding(
  recipe: ImportedRecipe,
  sourceText: string,
): { method: Grounding; ingredients: Grounding; notes: Grounding } {
  const source = new Set(groundingWords(sourceText));
  const nameWords = new Set(groundingWords(recipe.name));
  const ingredientWords = new Set(
    (recipe.ingredients ?? []).flatMap((ingredient) =>
      groundingWords(
        [ingredient.item, ingredient.amount, ingredient.unit]
          .filter(Boolean)
          .join(" "),
      ),
    ),
  );

  const own = (word: string) =>
    !ingredientWords.has(word) && !(nameWords.has(word) && source.has(word));
  const count = (words: string[]): Grounding => ({
    counted: words.length,
    grounded: words.filter((word) => source.has(word)).length,
  });

  const ingredients: Grounding = { counted: 0, grounded: 0 };
  for (const ingredient of recipe.ingredients ?? []) {
    const words = groundingWords(ingredientHead(ingredient.item)).filter(
      (word) => !(nameWords.has(word) && source.has(word)),
    );
    if (words.length === 0) continue;
    ingredients.counted++;
    if (words.some((word) => source.has(word))) ingredients.grounded++;
  }

  return {
    method: count((recipe.steps ?? []).flatMap(groundingWords).filter(own)),
    ingredients,
    notes: count(groundingWords(recipe.notes ?? "").filter(own)),
  };
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
// A count, or a range holding it ("4-6", "4 to 6"), kept on one line.
const COUNT = String.raw`(\d+)(?:[ \t]*(?:-|–|—|to|or)[ \t]*(\d+))?`;
// A count right after a servings word: "serves 4", "makes about 12",
// "Servings: ~4", "Servings | 4" (a table row), "scaled for 6", "enough
// for 4". Each run of spaces ends at a mark, so a long run can't be split
// between them in many ways and a match stays linear in the text.
const COUNT_AFTER_WORD = new RegExp(
  String.raw`\b(?:serves?|serving|servings|feeds|makes|yields?|portions?|scaled (?:for|to)|enough for)\b[ \t]*(?:[:|\-–—][ \t]*)?(?:~[ \t]*)?(?:(?:about|around|roughly|approximately|approx\.?|up to|at least)[ \t]+)?` +
    COUNT,
  "g",
);
// A count right before a servings word, allowing one word between:
// "2 servings", "6 hungry people".
const COUNT_BEFORE_WORD = new RegExp(
  String.raw`\b` +
    COUNT +
    String.raw`[ \t]+(?:[a-z]+[ \t]+)?(?:servings?|portions?|people|persons)\b`,
  "g",
);

/**
 * Whether the source states this serving count: a number, a number word or
 * a range holding it, next to a word like "serves" or "people". The count
 * has to sit next to the word, so the other numbers on a servings line (a
 * bake time, a pan size) aren't taken for it.
 */
export function servesStated(serves: number, sourceText: string): boolean {
  let text = sourceText.toLowerCase().replace(/\u00a0/g, " ");
  NUMBER_WORDS.forEach((word, n) => {
    text = text.replace(new RegExp(`\\b${word}\\b`, "g"), String(n));
  });
  const counts = [
    ...text.matchAll(COUNT_AFTER_WORD),
    ...text.matchAll(COUNT_BEFORE_WORD),
  ];
  return counts.some((count) => {
    const low = Number(count[1]);
    const high = count[2] ? Number(count[2]) : low;
    return serves >= low && serves <= high;
  });
}

// Share of a method's or notes' words that must be in the source. Set against
// the calibration table in the tests, where faithful rewordings of terse
// methods score 0.42 and up and made-up methods 0.33 and down.
const MIN_GROUNDED = 0.4;
// Share of ingredients that must be in the source. Translations and made-up
// recipes sit near 0; faithful extractions near 1.
const MIN_GROUNDED_INGREDIENTS = 0.5;
// Below this many words a share means little, so a part passes on any
// grounded word and fails on none.
const MIN_COUNTED = 3;

function isGrounded({ counted, grounded }: Grounding): boolean {
  if (counted === 0) return true;
  if (counted < MIN_COUNTED) return grounded > 0;
  return grounded / counted >= MIN_GROUNDED;
}

function ingredientsGrounded({ counted, grounded }: Grounding): boolean {
  return counted === 0 || grounded / counted >= MIN_GROUNDED_INGREDIENTS;
}

// Share of a saved part's words that must be in the source for partsLost to
// call it still given. Keeping a saved part overrides the new extraction, so
// it takes clear evidence, well above MIN_GROUNDED: faithful methods on the
// family's recipes doc score 0.80 and up, while a made-up method that passes
// MIN_GROUNDED on the prep words of its ingredient lines ("browned",
// "chopped") scores around 0.6.
const MIN_STILL_GIVEN = 0.75;

// Whether the source clearly gives a saved part: enough words to judge, and
// most of them in the source. Too few words to judge is not evidence.
function clearlyGiven(
  { counted, grounded }: Grounding,
  minCounted: number,
): boolean {
  return counted >= minCounted && grounded / counted >= MIN_STILL_GIVEN;
}

/**
 * Takes out the parts of an extraction its source doesn't give, returning a
 * new recipe and a notice for each part left out. Throws when what is left
 * isn't a recipe from the source: most ingredients missing from it, or a
 * made-up method and no ingredients.
 */
export function groundRecipe(
  recipe: ImportedRecipe,
  sourceText: string,
): { recipe: ImportedRecipe; notices: ExtractionNotice[] } {
  const { method, ingredients, notes } = measureGrounding(recipe, sourceText);

  if (!ingredientsGrounded(ingredients)) {
    throw new Error(
      "Most of the ingredients the model returned aren't in the source " +
        "(it made them up or translated them), so nothing was imported.",
    );
  }

  const grounded: ImportedRecipe = { ...recipe };
  const notices: ExtractionNotice[] = [];

  if (!isGrounded(method)) {
    if (!recipe.ingredients?.length) {
      throw new Error(
        "The steps the model returned aren't in the source, and it found no " +
          "ingredients, so there is no recipe to keep.",
      );
    }
    const dropped = recipe.steps?.length ?? 0;
    grounded.steps = [];
    grounded.stepIngredients = undefined;
    grounded.estimatedTime = undefined;
    notices.push({
      kind: "method-dropped",
      message:
        dropped === 1
          ? "Left out 1 step that isn't in the source."
          : `Left out ${dropped} steps that aren't in the source.`,
    });
  }

  if (!isGrounded(notes)) {
    grounded.notes = undefined;
    notices.push({
      kind: "notes-dropped",
      message: "Left out notes that aren't in the source.",
    });
  }

  if (recipe.serves !== undefined && !servesStated(recipe.serves, sourceText)) {
    grounded.serves = undefined;
  }

  return { recipe: grounded, notices };
}

/** A part of a recipe an extraction can come back without. */
export type RecipePart = "ingredients" | "steps" | "notes";

const HAS_PART: Record<RecipePart, (recipe: ImportedRecipe) => boolean> = {
  ingredients: (recipe) => (recipe.ingredients?.length ?? 0) > 0,
  steps: (recipe) => (recipe.steps?.length ?? 0) > 0,
  notes: (recipe) => (recipe.notes?.trim() ?? "") !== "",
};

/**
 * The parts a re-extraction would lose: parts the saved recipe has and the
 * new extraction of the same source comes back without, where the source
 * clearly gives the saved part. A model that drops a part the source still
 * has shouldn't wipe it from the library. A saved part the source doesn't
 * clearly give isn't listed, so the new extraction replaces it: an earlier
 * extraction may have made it up, and a wrong replacement costs one sync
 * (the next extraction brings the part back) where a wrong keep would hold
 * the part in the library indefinitely.
 */
export function partsLost(
  saved: ImportedRecipe,
  extracted: ImportedRecipe,
  sourceText: string,
): RecipePart[] {
  const { method, ingredients, notes } = measureGrounding(saved, sourceText);
  const stillGiven: Record<RecipePart, boolean> = {
    ingredients: clearlyGiven(ingredients, 1),
    steps: clearlyGiven(method, MIN_COUNTED),
    notes: clearlyGiven(notes, MIN_COUNTED),
  };
  return (["ingredients", "steps", "notes"] as const).filter(
    (part) =>
      HAS_PART[part](saved) && !HAS_PART[part](extracted) && stillGiven[part],
  );
}
