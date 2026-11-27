/**
 * Pure client- and server-shared helpers for authoring, validating, and
 * repairing household recipe collections against Pack Format v0 and the
 * kitchen queue round-trip guard.
 */

import {
  parsePack,
  verifyPackRefs,
  type Libraries,
  type Pack,
} from "@sous/pack";
import { packRecipeToQueueData } from "../pack-convert/to-queue";

export const MAX_COLLECTION_BYTES = 2 * 1024 * 1024; // 2,097,152 bytes
const MAX_REPORTED_ISSUES = 15;
const UNSAFE_COLLECTION_ID = /[/\\\s\p{Cc}\p{Cf}]/u;

export type AuthoringCommonsItem = Pick<
  Libraries["commons"][number],
  "id" | "name" | "description"
>;
export type AuthoringStateItem = Pick<
  Libraries["states"][number],
  "id" | "name" | "sensory_notes"
>;

export interface CollectionAuthoringContext {
  commons: readonly AuthoringCommonsItem[];
  states: readonly AuthoringStateItem[];
  reservedPackIds: readonly string[];
}

export type CollectionValidationResult =
  | {
      ok: true;
      pack: Pack;
      sizeBytes: number;
    }
  | {
      ok: false;
      issues: string[];
      sizeBytes: number;
    };

/**
 * Generates a safe kebab-case collection slug from a title, avoiding reserved
 * route and built-in book identifiers.
 */
export function slugifyCollectionId(
  title: string,
  reservedIds: readonly string[] = ["household-book", "fannie-farmer-1896", "new"],
): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "my-collection";

  const reserved = new Set([...reservedIds, "new"]);
  if (reserved.has(base)) {
    return `${base}-collection`;
  }
  return base;
}

/**
 * Strips optional markdown code fences or surrounding whitespace if a model
 * wrapped its JSON response in ```json ... ```.
 */
export function extractJsonObjectText(rawText: string): string {
  const trimmed = rawText.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace && !trimmed.startsWith("{")) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

/**
 * Validates raw collection JSON against size limits, Pack Format v0 schema,
 * allowed shared library references, reserved IDs, media-ref restrictions,
 * and cook-mode queue conversion. Returns all actionable issues (up to 15).
 */
export function validateCollectionJson(
  rawText: string,
  ctx: CollectionAuthoringContext,
): CollectionValidationResult {
  const trimmed = rawText.trim();
  const sizeBytes = new TextEncoder().encode(trimmed).byteLength;

  if (sizeBytes === 0) {
    return {
      ok: false,
      sizeBytes: 0,
      issues: ["Collection JSON is empty."],
    };
  }
  if (sizeBytes > MAX_COLLECTION_BYTES) {
    return {
      ok: false,
      sizeBytes,
      issues: [
        `Collection JSON is ${sizeBytes} bytes, exceeding the ${MAX_COLLECTION_BYTES}-byte (2 MB) limit.`,
      ],
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      sizeBytes,
      issues: [`Invalid JSON: ${message}`],
    };
  }

  const parsed = parsePack(parsedJson);
  if (!parsed.ok) {
    return {
      ok: false,
      sizeBytes,
      issues: parsed.issues
        .slice(0, MAX_REPORTED_ISSUES)
        .map((issue) => `${issue.path}: ${issue.message}`),
    };
  }

  const pack = parsed.value;
  const issues: string[] = [];

  if (pack.kind === "household") {
    issues.push('kind: Owned collections cannot have kind "household". Use "creator" or omit kind.');
  }

  const reserved = new Set([...ctx.reservedPackIds, "new"]);
  if (reserved.has(pack.id)) {
    issues.push(`id: Collection id "${pack.id}" is reserved; pick another kebab-case id.`);
  }
  if (UNSAFE_COLLECTION_ID.test(pack.id) || pack.id === "." || pack.id === "..") {
    issues.push(`id: Collection id "${pack.id}" contains unsupported characters or whitespace.`);
  }

  if (pack.cover_ref != null) {
    issues.push("cover_ref: Set cover_ref to null (uploaded collections cannot link external media files).");
  }
  pack.recipes.forEach((recipe, rIdx) => {
    recipe.steps.forEach((step, sIdx) => {
      if (step.media_ref != null) {
        issues.push(
          `recipes.${rIdx}.steps.${sIdx}.media_ref: Set step media_ref to null for "${recipe.title}".`,
        );
      }
    });
  });

  const libraries: Libraries = {
    commons: ctx.commons.map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.description !== undefined ? { description: c.description } : {}),
      media_ref: null,
    })),
    states: ctx.states.map((s) => ({
      id: s.id,
      name: s.name,
      visual_ref: null,
      ...(s.sensory_notes !== undefined ? { sensory_notes: s.sensory_notes } : {}),
    })),
  };

  for (const refIssue of verifyPackRefs(pack, libraries)) {
    issues.push(`${refIssue.path}: ${refIssue.message}`);
    if (issues.length >= MAX_REPORTED_ISSUES) break;
  }

  if (issues.length < MAX_REPORTED_ISSUES) {
    for (const recipe of pack.recipes) {
      const projected = packRecipeToQueueData(recipe, pack.id);
      if (!projected.ok) {
        issues.push(
          `Recipe "${recipe.title}" (${recipe.id}) cannot cook as formatted: ${projected.differences.join("; ")}`,
        );
        if (issues.length >= MAX_REPORTED_ISSUES) break;
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, sizeBytes, issues };
  }

  return { ok: true, pack, sizeBytes };
}

/**
 * Static specification block reusable across browser prompts and MCP instructions.
 */
export function formatAuthoringRulesText(
  ctx: Pick<CollectionAuthoringContext, "commons" | "states">,
): string {
  const commonsList =
    ctx.commons.map((c) => `- ${c.id}: ${c.name}`).join("\n") || "- (none)";
  const statesList =
    ctx.states.map((s) => `- ${s.id}: ${s.name}`).join("\n") || "- (none)";

  return `PACK FORMAT v0.7 RULES (return ONE flat JSON object, no markdown commentary):

TOP-LEVEL SHAPE:
{
  "id": "kebab-case-slug",
  "title": "Collection Title",
  "version": "1.0.0",
  "creator": { "name": "Author or Kitchen Name" },
  "description": "Optional short description",
  "cover_ref": null,
  "sections": [{ "title": "Optional Chapter", "recipe_ids": ["recipe-slug"] }],
  "recipes": [ ... ]
}
- Never wrap inside { "pack": ... } and never set "kind": "household".
- Set "cover_ref": null and every step "media_ref": null (uploaded collections cannot reference external media paths).
- "id" must be kebab-case without spaces or slashes and must not be "new", "household-book", or "fannie-farmer-1896".
- Omit "sections" unless recipes belong in named chapters. Each section's "recipe_ids" must be non-empty, reference valid recipe ids, and place each recipe at most once.

RECIPES ARRAY (at least 1 recipe):
Each recipe object:
{
  "id": "unique-kebab-case-slug",
  "title": "Recipe Name",
  "story": "Short headnote or empty string",
  "serves_base": 4,
  "serves_estimated": true, // include ONLY if servings were not stated in the source; omit when stated
  "time_active_min": 15,   // non-negative number or null
  "time_total_min": 40,    // non-negative number or null
  "tags": ["weeknight"],
  "ingredients": [ ... ],
  "steps": [ ... ],
  "variations": [],
  "creator_notes": []
}
- Either "ingredients" or "steps" may be empty, never both.
- "serves_base" must be a positive number on every recipe.

INGREDIENT RULES (critical — keep amounts exact and cook-mode compatible):
Each ingredient:
{
  "id": "ing-1",
  "name": "Ingredient name (without amount)",
  "qty_canonical": { ... },
  "display_equivalents": { ... }, // required when qty_canonical uses mass_g or volume_ml
  "scaling": "linear",            // "linear" or "fixed"
  "prep": "optional prep note",
  "optional": false
}
Pick ONE quantity pattern for qty_canonical:
1) Measured weight or volume:
   - "qty_canonical": { "mass_g": 240 } or { "volume_ml": 236.59 } (add positive "range_max" only for ranges like "1 to 2 cups").
   - MUST include "display_equivalents" with at least one stated system matching the source:
     - "imperial": { "unit": "tsp"|"tbsp"|"cup"|"oz"|"lb", "amount": <positive number>, "amount_max"?: <positive number> }
     - "metric": { "unit": "g"|"kg"|"ml"|"l", "amount": <positive number>, "amount_max"?: <positive number> }
     - "amount" must be a plain positive number (0.5, not "1/2"). Set "amount_max" if and only if "range_max" is set.
2) Countable items ("3 cloves garlic", "2 cans chickpeas"):
   - "qty_canonical": { "count": 3, "count_unit": { "one": "clove", "other": "cloves" } } (or { "count": 2 } when the noun is in name).
   - Do NOT include "display_equivalents" for counts.
3) Units outside the list above (e.g. "1 pinch", "2 bunches", "1 quart"):
   - "qty_canonical": { "as_written": "1 bunch" } — omit "display_equivalents".
4) To taste ("salt to taste"):
   - "qty_canonical": { "to_taste": true }, "scaling": "fixed" — omit "display_equivalents".
5) No quantity given:
   - "qty_canonical": { "unstated": true } — omit "display_equivalents".
Never combine "to_taste", "as_written", or "unstated" with "mass_g", "volume_ml", or "count". Never invent missing quantities.

STEP RULES:
Each step:
{
  "id": "s1",
  "type": "action", // one of "action", "checkpoint", "wait", "interlude"
  "title": "Short step label",
  "text": "Clear instruction text.",
  "ingredient_refs": ["ing-1"], // ids of ingredients actually handled in this step
  "timer_sec": 300,             // positive integer in seconds, or null (never 0)
  "parallel_ok": false,
  "media_ref": null,
  "technique_refs": [],         // ONLY ids from ALLOWED COMMONS below
  "state_refs": [],             // ONLY ids from ALLOWED STATES below
  "coach_hints": []
}
NEVER invent new commons:* or state:* ids. Only use ids from the exact lists below, or use [].

ALLOWED COMMONS (technique_refs):
${commonsList}

ALLOWED STATES (state_refs):
${statesList}`;
}

export interface BuildCollectionPromptInput {
  id: string;
  title: string;
  creatorName: string;
  description?: string;
  sourceText?: string;
  hasImages?: boolean;
  existingPackJson?: string;
  commons: readonly AuthoringCommonsItem[];
  states: readonly AuthoringStateItem[];
}

/**
 * Builds the complete prompt either for a user's external chat assistant
 * ("Copy instructions") or for direct browser model calls.
 */
export function buildCollectionAuthoringPrompt(
  input: BuildCollectionPromptInput,
): string {
  const title = input.title.trim() || "My Kitchen Collection";
  const creator = input.creatorName.trim() || "Home Cook";
  const id = input.id.trim() || slugifyCollectionId(title);
  const descriptionLine = input.description?.trim()
    ? `Description: ${input.description.trim()}\n`
    : "";

  const rules = formatAuthoringRulesText({
    commons: input.commons,
    states: input.states,
  });

  const existingSection = input.existingPackJson?.trim()
    ? `\nEXISTING COLLECTION JSON TO UPDATE OR EXTEND:\n---\n${input.existingPackJson.trim()}\n---\n`
    : "";

  let recipesBlock: string;
  if (input.sourceText?.trim()) {
    recipesBlock = `\nRECIPES TO CONVERT INTO THIS COLLECTION:\n---\n${input.sourceText.trim()}\n---`;
  } else if (input.hasImages) {
    recipesBlock = `\nRECIPES TO CONVERT: Transcribe every recipe shown in the attached photo(s) faithfully without inventing missing ingredients or steps.`;
  } else {
    recipesBlock = `\nRECIPES TO CONVERT:\n[Paste your recipes, links, or notes here before sending.]`;
  }

  return `Create a valid Sous recipe collection JSON file using the metadata and rules below.
Return ONLY a single raw JSON object (no surrounding prose).

TARGET METADATA:
- id: "${id}"
- title: "${title}"
- creator.name: "${creator}"
${descriptionLine}${existingSection}
${rules}
${recipesBlock}`;
}

/**
 * Builds a concise repair prompt naming validation errors so either an
 * automatic retry or the user's external chat app can fix the JSON.
 */
export function buildCollectionRepairPrompt(
  previousJsonText: string,
  issues: readonly string[],
): string {
  return `The collection JSON below failed Sous validation. Fix every listed issue and return ONLY the complete corrected JSON object (no prose):

ISSUES TO FIX:
${issues.map((issue, idx) => `${idx + 1}. ${issue}`).join("\n")}

JSON TO FIX:
---
${previousJsonText.trim()}
---`;
}
