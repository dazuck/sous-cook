import { z } from "zod";
import { chat, isAllowanceUsed, vision, type AiMeter } from "./ai";
import { isFoodInventoryHeading } from "./hooks/pantry";
import type { PantrySection } from "./hooks/types";

export interface PantryReconciliationCandidate {
  docItemText: string;
  section: string;
  matchedRecipeItem?: string;
  action: "delete" | "decrement" | "keep";
  updatedText?: string;
  isStaple: boolean;
  preselected: boolean;
  reason?: string;
}

export interface ReconcileOptions {
  docSections: PantrySection[];
  recipeIngredients: Array<{ item: string; amount?: string; unit?: string }>;
  recipeName?: string;
}

const CandidateSchema = z.object({
  docItemText: z.string().min(1),
  section: z.string(),
  matchedRecipeItem: z.string().optional(),
  action: z.enum(["delete", "decrement", "keep"]),
  updatedText: z.string().optional(),
  isStaple: z.boolean(),
  preselected: z.boolean(),
  reason: z.string().optional(),
});

const ReconciliationReplySchema = z.object({
  candidates: z.array(CandidateSchema),
});

export const RECONCILIATION_PROMPT = `You are a culinary inventory assistant. A cook just finished preparing a dish.
Compare the ingredients used in the recipe with the current pantry inventory document and determine which inventory items were used, depleted, or decremented.

RULES:
1. STAPLES RULE:
   - Any items found under "Spice Rack", "Oils, Vinegars & Sauces", or pervasive household seasonings (salt, pepper, olive oil, cooking oil, soy sauce, basic flour/sugar) are STAPLES.
   - For staples, mark "isStaple": true and "preselected": false. Do NOT pre-select them for deletion. Action should be "keep".
2. FULL USE (DELETE):
   - For perishable or distinct items where the recipe uses the entire quantity or the item is a single-use produce/protein (e.g. "2 avocados", "1 bunch cilantro", "1 lb ground beef", "sour cream"):
     mark "action": "delete", "isStaple": false, "preselected": true.
3. PARTIAL USE (DECREMENT):
   - For quantified bulk items where the recipe uses a known fraction of the amount (e.g. doc has "5 lbs Yukon Gold potatoes" and recipe uses "1 lb potatoes", or doc has "12 eggs" and recipe uses "2 eggs"):
     mark "action": "decrement", "updatedText": "<calculated remaining amount and item name>", "isStaple": false, "preselected": true.
     Example: "5 lbs Yukon Gold potatoes" used 1 lb -> updatedText: "4 lbs Yukon Gold potatoes".
4. AMBIGUOUS OR MISMATCHED AMOUNTS:
   - If units cannot be safely converted or the remaining amount is ambiguous (e.g. "1/2 bunch" vs "3 oz"):
     mark "action": "keep", "isStaple": false, "preselected": false, "reason": "Ambiguous amount".
5. ONLY MATCH EXISTING DOC ITEMS:
   - "docItemText" MUST match the exact text of a bullet item in the provided pantry inventory. Do not invent doc items.
6. NO MATCHES:
   - If a recipe ingredient has no matching item in the pantry doc, omit it from the output candidates.

OUTPUT FORMAT:
Return ONLY valid JSON matching this schema:
{
  "candidates": [
    {
      "docItemText": "<exact text from pantry doc>",
      "section": "<section heading from doc>",
      "matchedRecipeItem": "<name of matched recipe ingredient>",
      "action": "delete" | "decrement" | "keep",
      "updatedText": "<only if action is decrement>",
      "isStaple": boolean,
      "preselected": boolean,
      "reason": "<short explanation>"
    }
  ]
}`;

function cleanJsonResponse(response: string): string {
  let cleaned = response.trim();
  const jsonBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlock) {
    cleaned = jsonBlock[1];
  }
  return cleaned;
}

/**
 * Reconciles recipe ingredients against the pantry's current food sections.
 * Asks the model to evaluate full vs partial usage, staple filtering, and safe decrements.
 */
export async function reconcileRecipeIngredients(
  options: ReconcileOptions,
  meter: AiMeter,
): Promise<PantryReconciliationCandidate[]> {
  const foodSections = options.docSections.filter((s) =>
    isFoodInventoryHeading(s.heading),
  );

  const inventorySummary = foodSections
    .map((s) => {
      const items = s.items.map((item) => `  - ${item}`).join("\n");
      return `Section "${s.rawHeading}":\n${items || "  (empty)"}`;
    })
    .join("\n\n");

  const recipeSummary = options.recipeIngredients
    .map((i) => {
      const amt = [i.amount, i.unit].filter(Boolean).join(" ");
      return amt ? `- ${amt} ${i.item}` : `- ${i.item}`;
    })
    .join("\n");

  const prompt = `${RECONCILIATION_PROMPT}

RECIPE: ${options.recipeName ?? "Current Recipe"}
INGREDIENTS USED:
${recipeSummary || "(none listed)"}

CURRENT PANTRY INVENTORY:
${inventorySummary}
`;

  try {
    const aiResponse = await chat(
      {
        messages: [{ role: "user", content: prompt }],
        responseFormat: "json",
        thinkingBudget: 0,
        maxTokens: 4096,
      },
      meter,
    );

    const parsed = JSON.parse(cleanJsonResponse(aiResponse.content));
    const validated = ReconciliationReplySchema.safeParse(parsed);
    if (!validated.success) {
      console.warn(
        "Pantry reconciliation response did not match schema:",
        validated.error,
      );
      return [];
    }

    // Verify each candidate actually corresponds to a food item in the doc
    const validDocItems = new Map<string, string>(); // lowercase text -> section heading
    for (const s of foodSections) {
      for (const item of s.items) {
        validDocItems.set(item.trim().toLowerCase(), s.rawHeading);
      }
    }

    return validated.data.candidates.filter((cand) =>
      validDocItems.has(cand.docItemText.trim().toLowerCase()),
    );
  } catch (error) {
    if (isAllowanceUsed(error)) throw error;
    console.error("Failed to reconcile recipe ingredients against pantry:", error);
    return [];
  }
}

export interface ParsedGroceryItem {
  text: string;
  suggestedSection: string;
}

export interface ParseGroceryInputOptions {
  type: "image" | "text" | "voice";
  content: string;
  availableSections?: string[];
}

const GroceryItemsSchema = z.object({
  items: z.array(
    z.object({
      text: z.string().min(1),
      suggestedSection: z.string().min(1),
    }),
  ),
});

export const GROCERY_PARSING_PROMPT = `You are a grocery intake assistant.
Parse the provided groceries (from a store receipt, grocery haul photo, typed list, or voice transcript) into a list of ingredients to add to the kitchen inventory document.

RULES:
1. Extract individual food ingredients/items.
2. Format each item's "text" as a clean pantry bullet line (e.g. "2 avocados", "cilantro", "1 lb ground beef", "sour cream", "whole milk"). Include quantity and unit inline if present.
3. For "suggestedSection", choose the most appropriate category:
   - "Fridge" for perishables, dairy, fresh meat/fish, fresh vegetables/herbs, sauces needing refrigeration.
   - "Freezer" for frozen food, ice cream, frozen vegetables, frozen meat.
   - "Pantry" for dry goods, grains, canned food, pasta, baking supplies.
   - "Spice Rack" for dried herbs and spices.
   - "Oils, Vinegars & Sauces" for shelf-stable oils, vinegars, soy sauce, hot sauce.
4. Ignore non-food items (e.g. paper towels, dish soap, receipts headers, subtotals, tax).

OUTPUT FORMAT:
Return ONLY valid JSON matching:
{
  "items": [
    {
      "text": "item name and quantity",
      "suggestedSection": "Fridge" | "Freezer" | "Pantry" | "Spice Rack" | "Oils, Vinegars & Sauces"
    }
  ]
}`;

export async function parseGroceryInput(
  options: ParseGroceryInputOptions,
  meter: AiMeter,
): Promise<ParsedGroceryItem[]> {
  const content = options.content.trim();
  if (!content) return [];

  try {
    let rawResponse = "";
    if (options.type === "image") {
      rawResponse = await vision(
        {
          imageBase64: content,
          prompt: GROCERY_PARSING_PROMPT,
          thinkingBudget: 0,
          maxTokens: 4096,
        },
        meter,
      );
    } else {
      const typeLabel = options.type === "voice" ? "voice transcript" : "typed text";
      const prompt = `${GROCERY_PARSING_PROMPT}

INPUT TYPE: ${typeLabel}
INPUT CONTENT:
${content}
`;
      const response = await chat(
        {
          messages: [{ role: "user", content: prompt }],
          responseFormat: "json",
          thinkingBudget: 0,
          maxTokens: 4096,
        },
        meter,
      );
      rawResponse = response.content;
    }

    const parsed = JSON.parse(cleanJsonResponse(rawResponse));
    const validated = GroceryItemsSchema.safeParse(parsed);
    if (!validated.success) {
      console.warn("Grocery parsing response did not match schema:", validated.error);
      return [];
    }
    return validated.data.items;
  } catch (error) {
    if (isAllowanceUsed(error)) throw error;
    console.error("Failed to parse grocery input:", error);
    return [];
  }
}

