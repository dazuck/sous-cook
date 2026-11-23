/**
 * Recipe Import Module (F3)
 *
 * Imports recipes from URLs or pasted text using AI extraction.
 * Uses JSON-LD structured data when available, falls back to AI.
 */

import { z } from "zod";
import { readLeadingAmount } from "@sous/pack/quantity";
import {
  chat,
  isAllowanceUsed,
  isUnpricedModel,
  vision,
  type AiMeter,
} from "./ai";
import type { ChatRecipeIngredient } from "../../drizzle/schema";
import { groundRecipe, type ExtractionNotice } from "./recipe-grounding";
import { UNTITLED } from "./kitchen/dish-name";

export type { ExtractionNotice } from "./recipe-grounding";

// =============================================================================
// Types
// =============================================================================

/**
 * Structure for an imported recipe
 */
export interface ImportedRecipe {
  name: string;
  ingredients?: ChatRecipeIngredient[];
  steps?: string[];
  estimatedTime?: {
    active?: number;
    passive?: number;
    total?: number;
  };
  serves?: number;
  tags?: string[];
  notes?: string;
  /**
   * Per-step ingredient assignment, parallel to `steps`: one array of 0-based
   * indices into `ingredients` per step, identifying the ingredients actively
   * used in that step. Absent for JSON-LD imports and legacy recipes, which
   * fall back to fuzzy matching at render time.
   */
  stepIngredients?: number[][];
  /** Source URL if imported from web */
  source?: string;
}

/**
 * An extracted recipe, with a notice for each part of it that was left out
 * because the source doesn't give it (see `recipe-grounding.ts`).
 */
export type RecipeExtraction = {
  recipe: ImportedRecipe;
  notices: ExtractionNotice[];
};

// Max chars of cleaned text to send to AI (roughly ~12K tokens)
const MAX_AI_INPUT_CHARS = 50_000;

// Extraction is mechanical transcription, not reasoning. Disable Gemini's
// thinking (budget 0) so the entire token budget goes to the JSON output —
// thinking tokens were silently consuming the budget and truncating long
// recipes. Pair with generous output headroom and a one-shot retry.
const EXTRACTION_THINKING_BUDGET = 0;
const EXTRACTION_MAX_TOKENS = 8192;
const EXTRACTION_MAX_TOKENS_RETRY = 16_384;

// =============================================================================
// Validation Schema
// =============================================================================

// Coerce numbers to strings — the model occasionally returns numeric amounts
// (e.g. amount: 2 instead of "2"); normalize rather than hard-fail on it.
const coercedString = z.union([z.string(), z.number()]).transform(String);

// Optional fields are null-tolerant: the model sometimes emits `null` for a
// field it has no value for (e.g. "tags": null). Treat null as "absent" rather
// than failing the whole extraction over it.
const optionalCoercedString = coercedString.nullish();

// Validation strategy: the ESSENTIAL fields (name, ingredients, steps) are
// validated strictly — a malformed essential field is a genuine extraction
// failure worth surfacing. The OPTIONAL metadata fields (serves, tags,
// estimatedTime, notes) are best-effort: if the model returns an odd shape
// (e.g. serves "Serves 4-6", tags as a comma-separated string), we coerce what
// we can and drop the rest to undefined rather than failing the whole import
// over a nice-to-have field.

// A string entry like "2 cups flour" is wrapped as { item }, mirroring how
// JSON-LD ingredients are handled.
const ingredientSchema = z.preprocess(
  (v) => (typeof v === "string" ? { item: v } : v),
  z.object({
    item: coercedString,
    amount: optionalCoercedString,
    unit: optionalCoercedString,
  }),
);

// Best-effort serves: accept a number or numeric-ish string; anything
// unparseable (e.g. "Serves 4-6", "about 4") drops to undefined, never throws.
// A fractional number is rounded: the serves columns are integers, and a 2.5
// would fail the whole row's write.
const servesSchema = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "number" ? Math.round(v) : parseInt(v, 10)))
  .transform((v) => (Number.isNaN(v) ? undefined : v))
  .catch(undefined);

// Best-effort tags: accept an array, or split a comma-separated string.
const tagsSchema = z
  .preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(coercedString),
  )
  .optional()
  .catch(undefined);

// A single per-step ingredient index. The model usually emits an integer, but
// sometimes a numeric string ("0") or — the dangerous case — `null`/""/garbage.
// `z.coerce.number()` would silently turn null and "" into 0, which then passes
// the bounds check and falsely attaches ingredient 0 to the step. Instead map
// any non-numeric value to NaN so the integer filter in validateImportedRecipe
// drops it; genuine numeric strings ("2") still coerce to 2.
const stepIngredientIndexSchema = z
  .preprocess((v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
    return NaN;
  }, z.number())
  .catch(NaN);

const importedRecipeSchema = z.object({
  name: z.string().min(1),
  ingredients: z.array(ingredientSchema).nullish(),
  steps: z.array(coercedString).nullish(),
  estimatedTime: z
    .object({
      active: z.number().nullish(),
      passive: z.number().nullish(),
      total: z.number().nullish(),
    })
    .optional()
    .catch(undefined),
  serves: servesSchema,
  tags: tagsSchema,
  notes: optionalCoercedString.catch(undefined),
  // Best-effort per-step ingredient indices. Coerce loosely here; bounds,
  // integer, and length-vs-steps sanitation happens in validateImportedRecipe.
  // An odd shape drops to undefined (→ regex fallback) rather than failing.
  stepIngredients: z
    .array(z.array(stepIngredientIndexSchema))
    .nullish()
    .catch(undefined),
});

// =============================================================================
// Prompt
// =============================================================================

// Shared by the text and image prompts. Without it, "be lenient" let the model
// fill in a recipe from what it knows about the dish: a tab holding only a
// dish's name and rating came back with seven ingredients and five steps.
const NEVER_INVENT_RULES = `NEVER INVENT THE RECIPE ITSELF:
- Leniency is about shape, not content. Every ingredient and every step must come from the source; never add ones from what you know about the dish
- If the source gives ingredients but no steps, return the ingredients with "steps": [] (and "stepIngredients": []), and leave out "estimatedTime", since there is no method to time. Do not write steps it doesn't give. Likewise, steps with no ingredient list: extract the steps, and only the ingredients they name
- Write in the source's language and keep its wording: never translate, and keep its terms, shorthand, amounts, times and temperatures as it writes them. Tidying a fragment into a step is fine ("scramble eggs, out" can be "Scramble the eggs and take them out"); adding an action, time or temperature it doesn't give is not. Keeping its wording is about words, not step boundaries: a source step holding two stretches of work still becomes a step per stretch (the step rules below)
- "notes" are the source's own notes, tips, variations and credits (who the recipe is from or inspired by), in its words. Never write a description, summary or method of your own there, nor remarks about the recipe (what its list includes or leaves out). With none of these in the source, leave "notes" out
- The output format shows every field; it does not ask you to fill every one. Only "name" (when the source has none), "tags" and "estimatedTime" (only with steps) are yours to judge. Every other field comes from the source or stays out
- If the source only names a dish, rates it, or links to it, without giving its ingredients or its steps, return: {"error": "no recipe found"}`;

/**
 * How a source's steps are cut (standing agent call, DECISIONS 2026-10-26,
 * "a step is one stretch of work"): a step runs up to a natural pause, a
 * source step is split only where it holds two pauses, and never inside a
 * sentence into fragments. Shared by the text, URL and image prompts and by
 * the queue's intake pass, which runs the text prompt.
 */
const STEP_RULES = `CRITICAL STEP REQUIREMENTS (FOLLOW EXACTLY):
3. A step is one stretch of work: everything the cook does up to a natural pause. A pause is a stated time ("cook 5 min"), a doneness cue ("until soft", "until wilted", "to a boil") or a move to another vessel. Times and cues about the same cooking are one pause ("simmer 1 hr; start tasting at 45 min; done when creamy"; "cook 2 min, flip, cook 1 min more"). Heating a pan, a pot or oil is not a pause unless a time or a cue is stated. Work before a pause belongs to it ("Heat a heavy pan over medium-high." is not a step of its own when the searing follows), and so do sentences that carry no pause (a tip, a reason, "Set aside.")
4. Count the pauses in each source step. With one pause or none, the source step stays ONE step, however many sentences it has. With two or more, split right after each pause but the last, so each step ends at its pause; whatever follows the last pause ("salt, then set half aside") stays in the last step
5. Every step is one or more whole sentences in the source's words, opening with a capital letter and readable on its own. Never cut a sentence into fragments: "season", "then the stock" and "cook 8 min until golden." are not steps. Where a split falls inside a sentence, drop the joining word ("then", "and") and capitalise the next word; if the part after the split has no verb of its own, carry over the verb it shares with the rest of the sentence. Add no other words
6. Never merge source steps: each numbered source step, line or paragraph becomes one step or more
7. Preserve the EXACT order of steps from the source
8. Number steps sequentially in output even if source is unnumbered
9. Assembly and plating instructions are valid steps - include them`;

const STEP_EXAMPLE = `EXAMPLE OF CORRECT STEP EXTRACTION:
Source step: "Bring a large pot of salted water to a boil. Add the pasta and cook 9 min until al dente; drain, saving a cup of the water."
Two pauses ("to a boil", "9 min until al dente"), split after the first:
["Bring a large pot of salted water to a boil.", "Add the pasta and cook 9 min until al dente; drain, saving a cup of the water."]

Source step: "Add the sausage and brown 6 min, then the onion and a splash of wine. Cook 10 min until soft; season."
Two pauses ("brown 6 min", "10 min until soft"). The split falls inside the first sentence, right after "6 min", and the second step carries over its verb, "Add":
["Add the sausage and brown 6 min.", "Add the onion and a splash of wine. Cook 10 min until soft; season."]
WRONG (split at the end of the sentence, so the onion rides with the sausage's step instead of starting the next):
["Add the sausage and brown 6 min, then the onion and a splash of wine.", "Cook 10 min until soft; season."]

Source step: "Heat a heavy pan over medium-high. Lay the fish in skin-side down and cook 6 min until the skin is crisp; flip and baste. Don't move it while it cooks."
One pause ("6 min until the skin is crisp"), so one step:
["Heat a heavy pan over medium-high. Lay the fish in skin-side down and cook 6 min until the skin is crisp; flip and baste. Don't move it while it cooks."]
WRONG (the heating split off with no pause of its own):
["Heat a heavy pan over medium-high.", "Lay the fish in skin-side down and cook 6 min until the skin is crisp; flip and baste. Don't move it while it cooks."]
WRONG (cut into fragments):
["Heat a heavy pan over medium-high", "Lay the fish in skin-side down", "cook 6 min until the skin is crisp", "flip and baste.", "Don't move it while it cooks."]`;

/**
 * Where a step's ingredients are listed: at first use, and again where a
 * single ingredient readied earlier goes into the dish (standing agent call,
 * DECISIONS 2026-10-26). Shared by every extraction prompt.
 */
const FIRST_USE_RULES = `16. Attribute each ingredient to the step where it is first added or measured. A grouped reference ("the dry ingredients", "the wet ingredients", "the spice blend") means its specific listed ingredients - resolve it to their indices at the step where they are combined. A single ingredient readied in an earlier step (stock put on to heat, mushrooms set aside for the top, a leek washed) is listed again on the step where it goes into the dish, and one added in parts (the stems in one step, the leaves in a later one) on each step that adds a part. A step naming such an ingredient as "the reserved", "the rest of" or "the remaining" lists it: "Top with the reserved mushrooms and chives" lists the mushrooms and the chives.
17. Do NOT re-list ingredients already combined into a component (a mixture of several ingredients). When a later step uses a previously-made component ("pour in the sauce", "add the tempering", "fold in the batter"), list ONLY the ingredients newly introduced at that step - the component's ingredients were already counted at their earlier step.`;

export const RECIPE_IMPORT_PROMPT = `You are a recipe extraction expert. Given recipe content (either from a webpage or pasted text), extract the structured recipe data.

OUTPUT FORMAT:
Return ONLY a JSON object with this structure:
{
  "name": "Recipe Name",
  "ingredients": [
    { "item": "ingredient name", "amount": "quantity", "unit": "unit of measure" }
  ],
  "steps": [
    "Step 1 description",
    "Step 2 description"
  ],
  "estimatedTime": {
    "active": 15,
    "passive": 30,
    "total": 45
  },
  "serves": 4,
  "tags": ["quick", "vegetarian"],
  "notes": "Any additional notes or tips",
  "stepIngredients": [[0, 2], [1], []]
}

BE LENIENT - ALWAYS TRY TO EXTRACT:
- If the recipe name is not explicit, infer it from the main dish/ingredients (e.g., "Chicken Thigh with Almond Mole", "Bean and Kale Bowl")
- If ingredient amounts are not specified, omit the amount/unit and just include the item name
- Assembly/plating instructions ARE valid recipe steps - include them
- Partial recipes, serving suggestions, and meal kit instructions count as recipes
- When in doubt about the shape, extract what the source gives rather than returning nothing

${NEVER_INVENT_RULES}

EXTRACTION RULES:
1. Extract or infer the recipe name from context
2. Parse all ingredients - include amount and unit ONLY when specified in the source. One ingredient per line: a source line naming several ingredients ("chives, olive oil, salt, pepper", "1 sprig rosemary, 1 bay leaf", "Olive oil, salt, chili crisp") becomes one line per ingredient, each keeping its own amount and words. A line naming one ingredient with its alternatives or what it is made of ("lemon or white balsamic", "stock (or water + 1 tsp dashi)") stays one line

${STEP_RULES}

OTHER RULES:
10. If the source gives steps but no times, estimate the times in minutes from those steps (use reasonable defaults). With no steps, leave out "estimatedTime"
11. "serves" only when the source states it (serves, makes, yield, servings); otherwise leave it out
12. Extract tags from context (vegetarian, vegan, quick, healthy, cuisine type)
13. Include the chef tips, notes and garnish suggestions the source gives, in its words

PER-STEP INGREDIENTS (stepIngredients) - FILL THIS IN LAST:
14. Add "stepIngredients": an array PARALLEL to "steps" - one entry per step, in the same order. Its length MUST equal the number of steps.
15. Each entry is the list of 0-based indices into "ingredients" for the ingredients ACTIVELY USED in that step.
${FIRST_USE_RULES}
18. List a pervasive seasoning (salt, pepper, oil) only on its FIRST real use - not on every step that mentions heat or fat.
19. List garnishes and finishing ingredients only on the plating/finishing step.
20. Use an empty array [] for technique or timing steps that use no ingredient (e.g. "Preheat the oven", "Let rest 10 minutes", "Pour the wet mixture into the dry and stir").
21. Use ONLY indices that exist in "ingredients". Never invent an index.

${STEP_EXAMPLE}

RESPONSE:
Before returning, check every step against the source: if you can't point to the text it came from, remove it.
Return ONLY the JSON object. No additional text.
If the text holds no recipe (no food-related content at all, or only a dish's name, rating or link), return: {"error": "no recipe found"}`;

// =============================================================================
// JSON-LD Extraction (structured data — no AI needed)
// =============================================================================

interface JsonLdRecipeData {
  name?: string;
  recipeIngredient?: string[];
  recipeInstructions?: Array<string | { text?: string; "@type"?: string }>;
  totalTime?: string;
  prepTime?: string;
  cookTime?: string;
  recipeYield?: string | string[] | number;
  recipeCategory?: string | string[];
  recipeCuisine?: string | string[];
  description?: string;
  keywords?: string | string[];
}

/**
 * Parse ISO 8601 duration (e.g., "PT1H30M") to minutes
 */
function parseIsoDuration(duration: string | undefined): number | undefined {
  if (!duration) return undefined;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return undefined;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  return hours * 60 + minutes;
}

/**
 * Find and parse a schema.org Recipe object from JSON-LD blocks in HTML.
 * Most recipe websites embed structured data this way.
 */
export function extractJsonLdRecipe(html: string): ImportedRecipe | null {
  const regex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const recipe = findRecipeInJsonLd(data);
      if (recipe) {
        return convertJsonLdToImportedRecipe(recipe);
      }
    } catch {
      // Skip malformed JSON-LD blocks
    }
  }

  return null;
}

function findRecipeInJsonLd(
  data: Record<string, unknown>,
): JsonLdRecipeData | null {
  // Direct Recipe object
  if (data["@type"] === "Recipe") {
    return data as unknown as JsonLdRecipeData;
  }

  // Array of typed objects
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        const result = findRecipeInJsonLd(item as Record<string, unknown>);
        if (result) return result;
      }
    }
  }

  // @graph array (common in WordPress/Yoast)
  if (Array.isArray(data["@graph"])) {
    for (const item of data["@graph"] as Record<string, unknown>[]) {
      if (item["@type"] === "Recipe") {
        return item as unknown as JsonLdRecipeData;
      }
    }
  }

  return null;
}

function convertJsonLdToImportedRecipe(data: JsonLdRecipeData): ImportedRecipe {
  // Each line split at the amount it starts with, read by the pack's reader
  // (the one the cook page's converter uses): "1 1/2 cups flour" stores
  // amount "1 1/2", unit "cups", item "flour"; a unit outside the reader's
  // table stays in the item. A line with no amount at its start is the item
  // whole, and so is a line that is only an amount ("3 cloves"), which has no
  // item to split off (B4 fix round 2; the cook page reads it as its amount).
  // A blank line is dropped (B4 fix round 1): the source said nothing there.
  const ingredients: ChatRecipeIngredient[] | undefined = data.recipeIngredient
    ?.filter((line) => line.trim() !== "")
    .map((line) => {
      const lead = readLeadingAmount(line);
      if (lead === null || lead.rest === "") return { item: line.trim() };
      return {
        item: lead.rest,
        amount: lead.amount,
        ...(lead.unit !== "" && { unit: lead.unit }),
      };
    });

  // Parse instructions from various formats; a blank step is dropped, as a
  // blank line is.
  const steps: string[] | undefined = data.recipeInstructions
    ?.map((instruction) => {
      if (typeof instruction === "string") return instruction;
      if (typeof instruction === "object" && instruction.text)
        return instruction.text;
      return null;
    })
    .filter((s): s is string => s !== null && s.trim() !== "");

  // Parse times
  const totalMinutes = parseIsoDuration(data.totalTime);
  const prepMinutes = parseIsoDuration(data.prepTime);
  const cookMinutes = parseIsoDuration(data.cookTime);

  // A total only as the page states it, or prep plus cook when it states
  // both: one part alone is not the whole (DECISIONS 2026-10-05, T follow-up
  // call 3; the same rule as `statedTotal` in kitchen/recipe-times.ts).
  const total =
    totalMinutes ??
    (prepMinutes !== undefined && cookMinutes !== undefined
      ? prepMinutes + cookMinutes
      : undefined);
  const estimatedTime =
    totalMinutes || prepMinutes || cookMinutes
      ? {
          active: prepMinutes,
          passive: cookMinutes,
          ...(total !== undefined && { total }),
        }
      : undefined;

  // Parse yield
  let serves: number | undefined;
  if (typeof data.recipeYield === "number") {
    serves = data.recipeYield;
  } else if (typeof data.recipeYield === "string") {
    const num = parseInt(data.recipeYield, 10);
    if (!isNaN(num)) serves = num;
  } else if (Array.isArray(data.recipeYield) && data.recipeYield.length > 0) {
    const num = parseInt(data.recipeYield[0], 10);
    if (!isNaN(num)) serves = num;
  }

  // Build tags from category, cuisine, and keywords
  const tags: string[] = [];
  if (data.recipeCategory) {
    const cats = Array.isArray(data.recipeCategory)
      ? data.recipeCategory
      : [data.recipeCategory];
    tags.push(...cats);
  }
  if (data.recipeCuisine) {
    const cuisines = Array.isArray(data.recipeCuisine)
      ? data.recipeCuisine
      : [data.recipeCuisine];
    tags.push(...cuisines);
  }
  if (data.keywords) {
    const kw = Array.isArray(data.keywords)
      ? data.keywords
      : data.keywords.split(",").map((s) => s.trim());
    tags.push(...kw.filter((k) => k.length > 0));
  }

  return {
    name: data.name ?? UNTITLED,
    ingredients: ingredients?.length ? ingredients : undefined,
    steps: steps?.length ? steps : undefined,
    estimatedTime,
    serves,
    tags: tags.length > 0 ? tags.slice(0, 10) : undefined,
    notes: data.description || undefined,
  };
}

// =============================================================================
// HTML Stripping (fallback when no JSON-LD)
// =============================================================================

/**
 * Strip HTML to just visible text content for AI extraction.
 * Removes scripts, styles, nav, headers, footers, ads, and other noise.
 */
export function stripHtmlForExtraction(html: string): string {
  let text = html;

  // Remove entire blocks that are pure noise
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "");

  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Truncate to max size
  if (text.length > MAX_AI_INPUT_CHARS) {
    text = text.slice(0, MAX_AI_INPUT_CHARS);
  }

  return text;
}

// =============================================================================
// URL Validation
// =============================================================================

/**
 * Validates that a string is a valid HTTP/HTTPS URL
 */
export function isValidRecipeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// =============================================================================
// Response Parsing
// =============================================================================

/**
 * A reply from the model that isn't a recipe in the shape asked for: not
 * JSON, JSON with text after it, not an object, or a recipe the schema
 * rejects. These are glitches of the model's output rather than of the
 * source, so the extraction asks again once.
 */
export class MalformedReplyError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "MalformedReplyError";
  }
}

/**
 * Index just past the object or array that `text` opens with, or -1 when it
 * doesn't open with one or never closes it. Brackets inside strings don't
 * count; the caller's JSON.parse checks that the value is well formed.
 */
function endOfLeadingValue(text: string): number {
  if (text[0] !== "{" && text[0] !== "[") return -1;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * JSON.parse, except that closing brackets after a complete value are
 * dropped. Gemini in JSON mode sometimes closes a long recipe and then writes
 * one more `}` (see .claude/known-issues.md), and asking again repeats the
 * slip. Closers carry no content, so the value before them is the whole
 * reply; anything else after the value is still an error. The repair is
 * logged so the slip's frequency stays visible.
 */
function parseReplyJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const end = endOfLeadingValue(text);
    const leftover = text.slice(end);
    if (end > 0 && /^[\s}\]]+$/.test(leftover)) {
      try {
        const value: unknown = JSON.parse(text.slice(0, end));
        console.warn(
          `Recipe reply had closing brackets after its JSON; dropped ${JSON.stringify(leftover)}`,
        );
        return value;
      } catch {
        // Not well formed before the closers either: report the reply's own
        // error below.
      }
    }
    throw error;
  }
}

const isNamedObject = (value: unknown): value is { name: string } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { name?: unknown }).name === "string" &&
  (value as { name: string }).name.trim() !== "";

/**
 * Parses the model's reply into an ImportedRecipe. Handles JSON wrapped in a
 * markdown code block, stray closing brackets after it, and a recipe wrapped
 * in a one-item array.
 *
 * @param response - Raw AI response string
 * @returns the recipe, or null when the model reported that there is none
 * @throws MalformedReplyError when the reply isn't a named recipe object
 * @throws Error when the reply holds several recipes, which an import can't
 *   take at once; asking again wouldn't change the source
 */
export function parseImportedRecipe(response: string): ImportedRecipe | null {
  let cleanedResponse = response.trim();

  // Check for markdown code block wrapper
  const jsonBlockMatch = cleanedResponse.match(
    /```(?:json)?\s*([\s\S]*?)\s*```/,
  );
  if (jsonBlockMatch) {
    cleanedResponse = jsonBlockMatch[1];
  }

  let parsed: unknown;
  try {
    parsed = parseReplyJson(cleanedResponse);
  } catch (error) {
    throw new MalformedReplyError(
      `not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0 || !parsed.every(isNamedObject)) {
      throw new MalformedReplyError("an array that isn't recipes");
    }
    if (parsed.length > 1) {
      throw new Error(
        `The source holds ${parsed.length} recipes (${parsed.map((r) => r.name).join(", ")}); ` +
          "an import takes one at a time, so split them up.",
      );
    }
    parsed = parsed[0];
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new MalformedReplyError("not an object");
  }

  const reply = parsed as Record<string, unknown> & { name?: unknown };

  // Check for explicit "no recipe" response
  if (reply.error) {
    return null;
  }

  if (typeof reply.name !== "string" || reply.name.trim() === "") {
    throw new MalformedReplyError("a recipe without a name");
  }

  // Return normalized recipe structure; validateImportedRecipe checks the
  // shape of each field.
  return {
    name: reply.name,
    ingredients: reply.ingredients as ImportedRecipe["ingredients"],
    steps: reply.steps as ImportedRecipe["steps"],
    estimatedTime: reply.estimatedTime as ImportedRecipe["estimatedTime"],
    serves: reply.serves as ImportedRecipe["serves"],
    tags: reply.tags as ImportedRecipe["tags"],
    notes: reply.notes as ImportedRecipe["notes"],
    stepIngredients: reply.stepIngredients as ImportedRecipe["stepIngredients"],
  };
}

// =============================================================================
// Validation & AI Extraction (with truncation-aware retry)
// =============================================================================

/**
 * Validates a parsed recipe beyond the basic name check:
 * - enforces the expected shape with Zod (catches malformed AI output)
 * - rejects degenerate extractions (a title but no ingredients AND no steps),
 *   which mean the model failed rather than found a real recipe
 *
 * @param recipe - parsed recipe, or null when no recipe was found
 * @returns the validated/normalized recipe, or null when input was null
 * @throws MalformedReplyError if the recipe doesn't fit the schema
 * @throws Error if the recipe is empty of content
 */
export function validateImportedRecipe(
  recipe: ImportedRecipe | null,
  { keepStepIngredients = false }: { keepStepIngredients?: boolean } = {},
): ImportedRecipe | null {
  if (recipe === null) return null;

  const result = importedRecipeSchema.safeParse(recipe);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new MalformedReplyError(
      `Extracted recipe failed validation: ${issues}`,
    );
  }

  const validated = result.data;
  const hasContent =
    (validated.ingredients?.length ?? 0) > 0 ||
    (validated.steps?.length ?? 0) > 0;
  if (!hasContent) {
    throw new Error(
      "Recognized a recipe title but no ingredients or steps could be extracted. Make sure the full recipe was provided.",
    );
  }

  // Sanitize the per-step ingredient mapping. The model can truncate it
  // (length ≠ steps), hallucinate out-of-bounds indices, emit duplicates, or
  // return non-integers. A length mismatch means the mapping is unreliable, so
  // we discard the whole thing (→ regex fallback) rather than render a partial,
  // misaligned mapping. Otherwise we keep it, scrubbing each step's indices.
  // A caller that checks the mapping itself (the queue's intake, which
  // refuses a bad one and asks again) gets it as the model gave it, indices
  // coerced to numbers (NaN for one that isn't), never scrubbed.
  const stepCount = validated.steps?.length ?? 0;
  const ingredientCount = validated.ingredients?.length ?? 0;
  let stepIngredients: number[][] | undefined;
  if (keepStepIngredients) {
    stepIngredients = validated.stepIngredients ?? undefined;
  } else if (
    validated.stepIngredients != null &&
    stepCount > 0 &&
    validated.stepIngredients.length === stepCount
  ) {
    stepIngredients = validated.stepIngredients.map((indices) => {
      const seen = new Set<number>();
      const cleaned: number[] = [];
      for (const i of indices) {
        if (
          Number.isInteger(i) &&
          i >= 0 &&
          i < ingredientCount &&
          !seen.has(i)
        ) {
          seen.add(i);
          cleaned.push(i);
        }
      }
      return cleaned;
    });
  }

  // Normalize the null-tolerant schema output back to ImportedRecipe's
  // `T | undefined` shape (null → undefined).
  return {
    name: validated.name,
    ingredients:
      validated.ingredients?.map((i) => ({
        item: i.item,
        amount: i.amount ?? undefined,
        unit: i.unit ?? undefined,
      })) ?? undefined,
    steps: validated.steps ?? undefined,
    estimatedTime: validated.estimatedTime
      ? {
          active: validated.estimatedTime.active ?? undefined,
          passive: validated.estimatedTime.passive ?? undefined,
          total: validated.estimatedTime.total ?? undefined,
        }
      : undefined,
    serves: validated.serves ?? undefined,
    tags: validated.tags ?? undefined,
    notes: validated.notes ?? undefined,
    stepIngredients,
  };
}

/** One reply from the model, and why it has no whole answer, if it hasn't. */
type ModelReply = { content: string; cut?: "truncated" | "blocked" };

/**
 * Asks the model for a recipe, parses and validates the reply, and asks
 * again once, with more room, when the reply was cut off at the token limit,
 * was blocked (safety and recitation filters vary run to run) or wasn't
 * recipe JSON. Other failures (no ingredients or steps, several recipes, an
 * API error) would repeat, so they aren't retried. A blocked reply is never
 * read as "no recipe here": it is empty or partial.
 *
 * @param send - makes one call with the given output-token limit
 * @returns the validated recipe, or null if the model found no recipe
 */
async function extractWithRetry(
  send: (maxTokens: number) => Promise<ModelReply>,
  { keepStepIngredients = false }: { keepStepIngredients?: boolean } = {},
): Promise<ImportedRecipe | null> {
  let lastFailure: "truncated" | "blocked" | MalformedReplyError | undefined;
  for (const maxTokens of [
    EXTRACTION_MAX_TOKENS,
    EXTRACTION_MAX_TOKENS_RETRY,
  ]) {
    const reply = await send(maxTokens);
    if (reply.cut) {
      lastFailure = reply.cut;
      continue;
    }
    try {
      return validateImportedRecipe(parseImportedRecipe(reply.content), { keepStepIngredients });
    } catch (error) {
      if (!(error instanceof MalformedReplyError)) throw error;
      lastFailure = error;
    }
  }
  if (lastFailure === "truncated") {
    throw new Error(
      "Recipe is too long to extract — the response exceeded the token limit even after retrying. Try importing it in smaller sections.",
    );
  }
  if (lastFailure === "blocked") {
    throw new Error(
      "The model declined to read this recipe (blocked), even after a retry",
    );
  }
  throw new Error(
    `The model's reply wasn't valid recipe JSON, even after a retry: ${lastFailure?.message}`,
  );
}

/**
 * One extraction call's tokens as the provider reported them (0 and 0 when
 * it reported none, or the call threw), with the most it could be billed:
 * its input's UTF-8 bytes plus a fixed overhead, and its output limit. The
 * same bound the cook-plan ledger uses (`CallBound`, cook-plan-derive.ts).
 */
export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
  bound: { inputTokens: number; outputTokens: number };
  /** False when the call was refused before reaching the provider (allowance or unpriced model). */
  sent?: false;
}

/** Options for a text extraction a caller meters, bounds or corrects (the queue's intake pass). */
export interface ExtractOptions {
  /** Metering context for each model call made by this extraction. */
  meter: AiMeter;
  /**
   * Why an earlier extraction of this text was turned down, sent after the
   * text so the model can avoid it. The prompt itself is unchanged.
   */
  correction?: string;
  /** Hears every model call made, answered or thrown. */
  onUsage?: (usage: ExtractionUsage) => void;
  /** Aborts the extraction: the call in flight rejects once it fires. */
  signal?: AbortSignal;
  /**
   * Gemini thinking tokens for each call, added on top of the output budget
   * so they never eat into the JSON. Default `EXTRACTION_THINKING_BUDGET`
   * (0: an import is transcription); intake asks for some, since deciding
   * where a step's stretches end takes reasoning (`INTAKE_THINKING_BUDGET`).
   */
  thinkingBudget?: number;
  /**
   * The per-step mapping as the model gave it, never scrubbed of bad
   * indices nor dropped for a wrong length (`validateImportedRecipe`): the
   * caller checks it and refuses a bad one (intake).
   */
  keepStepIngredients?: boolean;
}

/**
 * HTTP statuses another try may pass: a timeout, a rate limit, the
 * provider's own failure, and a key refused (401, 403), which is the
 * deploy's config to fix, not the recipe's.
 */
function transientStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

/** Network failures under a fetch, by Node's error code. */
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * Whether a failed model call may pass on another try: an abort or a
 * timeout, a provider's 408, 429 or 5xx (the SDKs' errors carry `status`),
 * the network dropping (`fetch failed`, a connection error), or a key
 * missing (`MissingApiKeyError`) or refused (401, 403): a config fault, which
 * the config's fix clears, so a recipe queued meanwhile isn't settled for
 * it. Anything else, a refused request (another 4xx), an error the call
 * doesn't explain, would fail the same way again. A caller bounds its tries
 * (`INTAKE_MAX_TRIES`).
 */
export function isTransientModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isAllowanceUsed(error)) return false;
  if (error.name === "MissingApiKeyError") return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (error.name === "APIConnectionError" || error.name === "APIConnectionTimeoutError") return true;
  const { status } = error as { status?: unknown };
  if (typeof status === "number") return transientStatus(status);
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  const code = (error.cause as { code?: unknown } | undefined)?.code ?? (error as { code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

/**
 * A model call that failed in a way another try may pass
 * (`isTransientModelError`), as against a reply that came back and wasn't a
 * recipe, or a call that can't succeed as configured. Its message is the
 * provider's own; the queue's intake stores it as an error for now. Thrown
 * by the text extraction.
 */
export class TransientModelError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "TransientModelError";
  }
}

/** Role markers and framing around a call's text, as `CALL_OVERHEAD_TOKENS` in cook-plan-derive.ts. */
const EXTRACTION_CALL_OVERHEAD_TOKENS = 1_024;

/**
 * One text extraction call. Truncation and blocking are read from the
 * provider's finishReason, not guessed from a JSON parse failure.
 */
async function askChat(
  prompt: string,
  maxTokens: number,
  {
    meter,
    onUsage,
    signal,
    thinkingBudget = EXTRACTION_THINKING_BUDGET,
  }: Pick<ExtractOptions, "meter" | "onUsage" | "signal" | "thinkingBudget">,
): Promise<ModelReply> {
  const bound = {
    inputTokens: new TextEncoder().encode(prompt).length + EXTRACTION_CALL_OVERHEAD_TOKENS,
    outputTokens: maxTokens + thinkingBudget,
  };
  // A provider may not honour a signal that aborted before its call.
  signal?.throwIfAborted();
  let response: Awaited<ReturnType<typeof chat>>;
  try {
    response = await chat(
      {
        messages: [{ role: "user", content: prompt }],
        responseFormat: "json",
        thinkingBudget,
        maxTokens: maxTokens + thinkingBudget,
        ...(signal !== undefined && { signal }),
      },
      meter,
    );
  } catch (error) {
    const notSent = isAllowanceUsed(error) || isUnpricedModel(error);
    onUsage?.({
      inputTokens: 0,
      outputTokens: 0,
      bound,
      ...(notSent ? { sent: false as const } : {}),
    });
    throw error instanceof Error && isTransientModelError(error) ? new TransientModelError(error) : error;
  }
  onUsage?.({
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
    bound,
  });
  const cut =
    response.finishReason === "max_tokens"
      ? "truncated"
      : response.finishReason === "blocked"
        ? "blocked"
        : undefined;
  return { content: response.content, cut };
}

// =============================================================================
// Extraction Functions
// =============================================================================

/**
 * Extracts recipe from pasted text using AI, leaving out the parts the text
 * doesn't give (see `groundRecipe`).
 *
 * @param text - Recipe text to parse
 * @returns the recipe and its notices, or null if none found
 * @throws Error if the AI call fails, or the extraction isn't a recipe from
 *   the text
 */
export async function extractRecipeFromText(
  text: string,
  { meter, correction, onUsage, signal, thinkingBudget, keepStepIngredients }: ExtractOptions,
): Promise<RecipeExtraction | null> {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  const corrected = correction
    ? `\n\nAn earlier extraction of this text was turned down: ${correction}\nExtract it again, following every rule above.`
    : "";
  const prompt = `${RECIPE_IMPORT_PROMPT}\n\n<recipe_content>\n${trimmed}\n</recipe_content>${corrected}`;
  const recipe = await extractWithRetry(
    (maxTokens) =>
      askChat(prompt, maxTokens, {
        meter,
        onUsage,
        signal,
        ...(thinkingBudget !== undefined && { thinkingBudget }),
      }),
    { keepStepIngredients },
  );
  return recipe && groundRecipe(recipe, trimmed);
}

/**
 * Fetches a URL and extracts the recipe from the page content.
 *
 * Strategy:
 * 1. Try JSON-LD structured data (instant, no AI, covers most recipe sites)
 * 2. Fall back to AI extraction on stripped HTML text, leaving out the parts
 *    the page doesn't give (see `groundRecipe`)
 *
 * @param url - URL to fetch and parse
 * @returns the recipe, with its source URL, and its notices; or null if none
 *   found
 * @throws Error if URL is invalid, fetch fails, or AI call fails
 */
export async function extractRecipeFromUrl(
  url: string,
  meter: AiMeter,
): Promise<RecipeExtraction | null> {
  if (!isValidRecipeUrl(url)) {
    throw new Error("Invalid URL: must be a valid HTTP or HTTPS URL");
  }

  // Fetch the page content with proper headers and timeout
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        "This site blocks automated access. Try pasting the recipe text instead.",
      );
    }
    throw new Error(
      `Failed to fetch URL: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();

  // Strategy 1: Try JSON-LD structured data (fast, no AI call). The site
  // wrote it, so there is nothing to check it against.
  const jsonLdRecipe = extractJsonLdRecipe(html);
  if (jsonLdRecipe) {
    return { recipe: { ...jsonLdRecipe, source: url }, notices: [] };
  }

  // Strategy 2: Strip HTML and use AI
  const strippedText = stripHtmlForExtraction(html);

  if (strippedText.length < 50) {
    // Near-empty page (e.g. JS-rendered SPA shell) — nothing to extract.
    return null;
  }

  const prompt = `${RECIPE_IMPORT_PROMPT}\n\n<webpage_content>\n${strippedText}\n</webpage_content>`;
  const recipe = await extractWithRetry((maxTokens) =>
    askChat(prompt, maxTokens, { meter }),
  );
  if (!recipe) return null;

  const { recipe: grounded, notices } = groundRecipe(recipe, strippedText);
  return { recipe: { ...grounded, source: url }, notices };
}

// =============================================================================
// Image Import Prompt
// =============================================================================

const RECIPE_IMAGE_IMPORT_PROMPT = `You are a recipe extraction expert. Analyze this image of a recipe (could be a printed recipe, handwritten notes, a recipe card, or a screenshot) and extract the structured recipe data.

OUTPUT FORMAT:
Return ONLY a JSON object with this structure:
{
  "name": "Recipe Name",
  "ingredients": [
    { "item": "ingredient name", "amount": "quantity", "unit": "unit of measure" }
  ],
  "steps": [
    "Step 1 description",
    "Step 2 description"
  ],
  "estimatedTime": {
    "active": 15,
    "passive": 30,
    "total": 45
  },
  "serves": 4,
  "tags": ["quick", "vegetarian"],
  "notes": "Any additional notes or tips visible",
  "stepIngredients": [[0, 2], [1], []]
}

BE LENIENT - ALWAYS TRY TO EXTRACT:
- If the recipe name is not visible, infer it from the main dish/ingredients shown
- If ingredient amounts are not visible, omit the amount/unit and just include the item name
- Assembly/plating instructions ARE valid recipe steps - include them
- Partial recipes, serving suggestions, and meal kit cards count as recipes
- When in doubt about the shape, extract what the image gives rather than returning nothing

${NEVER_INVENT_RULES}

EXTRACTION RULES:
1. Extract or infer the recipe name from visible content
2. Parse all visible ingredients - include amount and unit ONLY when readable in the image. One ingredient per line: a line naming several ingredients ("chives, olive oil, salt, pepper", "1 sprig rosemary, 1 bay leaf") becomes one line per ingredient, each keeping its own amount and words. A line naming one ingredient with its alternatives or what it is made of ("lemon or white balsamic") stays one line

${STEP_RULES}

OTHER RULES:
10. If the image gives steps but no times, estimate the times in minutes from those steps (or reasonable estimates). With no steps, leave out "estimatedTime"
11. "serves" only when the image states it (serves, makes, yield, servings); otherwise leave it out
12. Extract tags from visible labels or infer from content (vegetarian, vegan, quick, healthy, cuisine type)
13. Include the chef tips, notes and garnish suggestions the image shows, in its words

PER-STEP INGREDIENTS (stepIngredients) - FILL THIS IN LAST:
14. Add "stepIngredients": an array PARALLEL to "steps" - one entry per step, in the same order. Its length MUST equal the number of steps.
15. Each entry is the list of 0-based indices into "ingredients" for the ingredients ACTIVELY USED in that step.
${FIRST_USE_RULES}
18. List a pervasive seasoning (salt, pepper, oil) only on its FIRST real use - not on every step that mentions heat or fat.
19. List garnishes and finishing ingredients only on the plating/finishing step.
20. Use an empty array [] for technique or timing steps that use no ingredient (e.g. "Preheat the oven", "Let rest 10 minutes", "Pour the wet mixture into the dry and stir").
21. Use ONLY indices that exist in "ingredients". Never invent an index.

${STEP_EXAMPLE}

RESPONSE:
Before returning, check every step against the image: if you can't point to where it is shown, remove it.
Return ONLY the JSON object. No additional text.
If the image holds no recipe (no food-related content at all, or only a dish's name, rating or link), return: {"error": "no recipe found"}`;

// =============================================================================
// Image Extraction Function
// =============================================================================

/**
 * Extracts recipe from an image using AI vision. An image has no text to
 * check the extraction against, so nothing is left out and there are no
 * notices.
 *
 * @param imageBase64 - Base64 encoded image (with or without data URL prefix)
 * @returns the recipe, or null if none found
 * @throws Error if vision API call fails
 */
export async function extractRecipeFromImage(
  imageBase64: string,
  meter: AiMeter,
): Promise<RecipeExtraction | null> {
  if (!imageBase64) {
    return null;
  }

  // vision() doesn't report a finish reason, so a reply cut off at the
  // token limit shows up as malformed JSON, which is retried the same way.
  const recipe = await extractWithRetry(async (maxTokens) => ({
    content: await vision(
      {
        imageBase64,
        prompt: RECIPE_IMAGE_IMPORT_PROMPT,
        thinkingBudget: EXTRACTION_THINKING_BUDGET,
        maxTokens,
      },
      meter,
    ),
  }));
  return recipe && { recipe, notices: [] };
}
