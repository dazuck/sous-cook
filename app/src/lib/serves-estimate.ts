/**
 * Sous's estimate of how many a recipe serves, for a recipe whose source
 * states no count (slice B4b, plan `.claude/phase-b/B4b.md`). One model call
 * per recipe (thinking on), made where the recipe first lands (the Doc sync, an import, the
 * webhook) or by `scripts/estimate-serves.ts --propose`, and stored beside the
 * source (`serves_estimate`, `serves_estimate_basis`), never in it. The pack
 * recipe carries the count with `serves_estimated: true` (format v0.5), and
 * the cook sees it as Sous's estimate.
 *
 * A reply that isn't a whole number from 1 to 48 with a one-line basis is a
 * failed estimate, returned as a reason: never coerced, never a stand-in
 * number. A recipe that gives no amounts at all (`hasAmounts` false, the
 * converter's reading) is estimated from the dish, and its basis must say so.
 */

import { z } from "zod";
import { parseNumber } from "@sous/pack/quantity";
import { chat as defaultChat, isAllowanceUsed } from "./ai";
import type {
  AiMeter,
  ChatOptions,
  ChatResponse,
  PublicChatOptions,
  ResponseSchema,
} from "./ai";
import type { ChatRecipeIngredient } from "../../drizzle/schema";

export const SERVES_ESTIMATE_MIN = 1;
export const SERVES_ESTIMATE_MAX = 48;
export const SERVES_BASIS_MAX = 240;
/** The source text sent with a recipe, at most. */
export const SOURCE_TEXT_CAP = 12_000;
export const ESTIMATE_TIMEOUT_MS = 20_000;
/**
 * Thinking tokens for the estimate (fix round 2: thinking on, the plan's
 * ladder). Gemini counts them inside the output budget, so the budget leaves
 * room for the reply after them.
 */
export const ESTIMATE_THINKING_BUDGET = 1024;
export const ESTIMATE_MAX_TOKENS = 2048;
/**
 * How a basis opens when the ingredient lines give no amounts: the count rests
 * on the dish alone, or on amounts only the source text states.
 */
export const DISH_ALONE = "From the dish alone:";
export const FROM_SOURCE_TEXT = "From the source text:";

export interface ServesEstimate {
  count: number;
  basis: string;
}

export interface ServesEstimateInput {
  name: string;
  ingredients: readonly ChatRecipeIngredient[];
  steps: readonly string[];
  /** The recipe as its source wrote it (a library row's `raw_doc_text`). */
  sourceText?: string | null;
  /** The library's category for it ("apps", "drinks"), which says how it's eaten. */
  category?: string | null;
  /**
   * Whether any ingredient line gives an amount (the converter's
   * `report.hasAmounts`). False: the estimate rests on the dish alone.
   */
  hasAmounts: boolean;
}

export type ServesEstimateResult = (
  | { ok: true; estimate: ServesEstimate }
  | { ok: false; reason: string }
) & {
  /** Tokens the call used, when the provider reports them. */
  usage?: { inputTokens: number; outputTokens: number };
};

export type ServesEstimateDeps =
  | {
      meter: AiMeter;
      chat?: undefined;
      timeoutMs?: number;
    }
  | {
      chat: (options: PublicChatOptions) => Promise<ChatResponse>;
      timeoutMs?: number;
    };

export const SERVES_ESTIMATE_SYSTEM_PROMPT = `You are Sous, a home kitchen assistant. You estimate how many people a recipe serves when the recipe doesn't say. The cook sees your number marked as Sous's estimate, so make it the number a careful home cook would give.

Rules:
- The source comes first. If it states a yield or how the dish is portioned anywhere (servings, "makes N", a number of pieces, wedges or slices and how many go on a plate, a portion size), count from that, not from your own reckoning: "slice into 4-6 wedges, plate 2 slices" serves 2 to 3. Give a whole number inside the range it states.
- A recipe written for one portion (one drink, one mug, one bowl, one sandwich) serves 1. A note about scaling it up or making a dry mix ("multiply by 8") doesn't change what the recipe as written makes.
- Otherwise count people served as the dish is meant to be eaten at a home meal, as its category says when one is given: a main as a main, an appetizer as an appetizer, a side as a side, a cake, pie or cheesecake by the slice, cookies or dumplings by a usual helping of pieces, a dip, sauce, chutney or other condiment as the accompaniment to meals it usually is.
- Work from the amounts given: weights, volumes and counts of the main ingredients. Liquid the dish cooks in (water, stock) counts only as far as it stays in the dish.
- "serves" is a whole number from ${SERVES_ESTIMATE_MIN} to ${SERVES_ESTIMATE_MAX}.
- "basis" is one sentence of at most 200 characters naming what the count rests on. It may cite only amounts and words the source states, as the source states them: never a yield, total weight or volume you worked out ("makes about 2 cups", "about 1.5 kg"), never a pan size, a number of cans or eggs, or a describing word ("standard", "canned", "single") the source doesn't give. Every number in it must be one the recipe states, written as the recipe writes it, or your count. An item the source lists without a number ("eggs") gets none from you. Word your count as yours ("about 9 portions"), never as the source's ("serves 8 to 10") unless the source states servings. For example "2.5 lbs goat meat with dal and onions: about 6 dinner portions."
- When you are told the ingredient lines give no amounts: if the source text states amounts, use them and start the basis with exactly "${FROM_SOURCE_TEXT}"; if it states none either (or there is no source text), estimate from what the dish is, what the source says it is for ("batch", "lunches") and how it is usually made at home, and start the basis with exactly "${DISH_ALONE}".
- Return null for "serves" only when the text is not a recipe at all.`;

const RESPONSE_SCHEMA: ResponseSchema = {
  type: "object",
  properties: {
    basis: { type: "string" },
    serves: { type: "integer", nullable: true },
  },
  required: ["basis", "serves"],
  propertyOrdering: ["basis", "serves"],
};

const replySchema = z.object({
  basis: z.string(),
  serves: z.number().nullable(),
});

function ingredientLine(line: ChatRecipeIngredient): string {
  return [line.amount, line.unit, line.item]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(" ");
}

/** The user message: the recipe as stored, then its source text when there is one. */
export function servesEstimatePrompt(input: ServesEstimateInput): string {
  const lines = input.ingredients.map(ingredientLine).filter((line) => line !== "");
  const steps = input.steps.map((step) => step.trim()).filter((step) => step !== "");
  const category = input.category?.trim() ?? "";
  const parts = [
    `Recipe: ${input.name}`,
    ...(category !== "" ? [`Category: ${category}`] : []),
    input.hasAmounts
      ? "Amounts in the ingredient lines: yes."
      : `Amounts in the ingredient lines: none. The source text may still state some: if it does, use them and start the basis with "${FROM_SOURCE_TEXT}"; if it doesn't, estimate from the dish and start the basis with "${DISH_ALONE}".`,
    "",
    "Ingredients:",
    ...(lines.length > 0 ? lines.map((line) => `- ${line}`) : ["(none listed)"]),
    "",
    "Steps:",
    ...(steps.length > 0 ? steps.map((step, i) => `${i + 1}. ${step}`) : ["(none listed)"]),
  ];
  const source = input.sourceText?.trim() ?? "";
  if (source !== "") {
    parts.push(
      "",
      "Source text (the recipe as its source wrote it; it may repeat the above):",
      "<<<",
      source.slice(0, SOURCE_TEXT_CAP),
      ">>>",
    );
  }
  return parts.join("\n");
}

/**
 * A queue row's own text of the recipe, when its `source` holds one: the
 * webhook's `source` is a URL, "pasted" or "library" for most rows, but an
 * agent sometimes sends the recipe's words there. A URL or a one-word marker
 * is not source text.
 */
export function queueSourceText(recipeData: { source?: unknown } | null | undefined): string | null {
  const source = recipeData?.source;
  if (typeof source !== "string") return null;
  const text = source.trim();
  if (text === "" || /^https?:\/\//i.test(text) || !/\s/.test(text)) return null;
  return text;
}

/** Whether a basis says something a reader can see (not only whitespace or format characters). */
function visibleLength(text: string): number {
  return text.replace(/[\s\p{Cf}]/gu, "").length;
}

/** A number a text writes, and its value: "2½", "2 1/2" and "2.5" are one value. */
export interface StatedNumber {
  text: string;
  value: number;
}

const GLYPHS = "½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒";
// Longest first: a mixed number, a whole number with its glyph, a glyph, a
// fraction, a decimal. A mixed number's parts are joined by spaces or tabs
// only, never a line break: "Step 2\n½ cup sugar" is 2 and ½, not 2½.
const NUMBER_RE = new RegExp(
  `\\d+[ \\t]+\\d+/\\d+|\\d+[ \\t]?[${GLYPHS}]|[${GLYPHS}]|\\d+/\\d+|\\d+(?:\\.\\d+)?|\\.\\d+`,
  "gu",
);

/**
 * The numbers a text writes, each with its value, read by the pack's own
 * number reader (`parseNumber`): integers, decimals, fractions, mixed
 * numbers and the fraction glyphs. Spellings of one value read as one:
 * "2½" and "2.5", "½" and "0.5", "1⁄2" (the fraction slash) and "1/2", and
 * "1,5" (a decimal comma) and "1.5"; "1,000" is a thousand. Words for
 * numbers are not read.
 */
export function numbersIn(text: string): StatedNumber[] {
  const normal = text
    .replace(/\u2044/g, "/")
    .replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2")
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
  const out: StatedNumber[] = [];
  for (const match of normal.matchAll(NUMBER_RE)) {
    const value = parseNumber(match[0]);
    if (value !== null) {
      out.push({ text: match[0], value });
      continue;
    }
    // A pair the reader refuses as one number ("8 3/2"): each part alone.
    for (const part of match[0].split(/\s+/)) {
      const partValue = parseNumber(part);
      if (partValue !== null) out.push({ text: part, value: partValue });
    }
  }
  return out;
}

/** Whether two values are one number (floating point aside). */
function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Everything the model was given about the recipe, as one text. */
function givenText(input: ServesEstimateInput): string {
  return [
    input.name,
    input.category ?? "",
    ...input.ingredients.map(ingredientLine),
    ...input.steps,
    input.sourceText ?? "",
  ].join("\n");
}

/**
 * Judges a model reply: the estimate, or why it isn't one. The basis rules
 * are checked, not only asked for: with no amounts in the lines it says what
 * it rests on, "From the source text:" only when there was source text, and
 * every number in it is one the recipe states (or the count itself).
 */
export function readServesReply(
  content: string,
  input: ServesEstimateInput,
): { ok: true; estimate: ServesEstimate } | { ok: false; reason: string; basisRule?: true } {
  const { hasAmounts } = input;
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, reason: `the model's reply isn't JSON: ${content.slice(0, 120)}` };
  }
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `the model's reply isn't {serves, basis}: ${content.slice(0, 120)}` };
  }
  const { serves } = parsed.data;
  const basis = parsed.data.basis.trim();
  if (serves === null) {
    return { ok: false, reason: `the model gave no count${basis ? `: ${basis}` : ""}` };
  }
  if (!Number.isInteger(serves) || serves < SERVES_ESTIMATE_MIN || serves > SERVES_ESTIMATE_MAX) {
    return {
      ok: false,
      reason: `the model's count ${serves} isn't a whole number from ${SERVES_ESTIMATE_MIN} to ${SERVES_ESTIMATE_MAX}`,
    };
  }
  if (visibleLength(basis) === 0) return { ok: false, reason: "the model gave no basis" };
  if (basis.length > SERVES_BASIS_MAX) {
    return { ok: false, reason: `the model's basis runs ${basis.length} characters, over ${SERVES_BASIS_MAX}` };
  }
  const opens = (prefix: string) => basis.toLowerCase().startsWith(prefix.toLowerCase());
  if (!hasAmounts && !opens(DISH_ALONE) && !opens(FROM_SOURCE_TEXT)) {
    return {
      ok: false,
      basisRule: true,
      reason: `the ingredient lines give no amounts, but the basis doesn't say whether it rests on the source text or the dish alone: ${basis}`,
    };
  }
  const hasSource = (input.sourceText?.trim() ?? "") !== "";
  if (opens(FROM_SOURCE_TEXT) && !hasSource) {
    return {
      ok: false,
      basisRule: true,
      reason: `the basis says it rests on the source text, but none was sent: ${basis}`,
    };
  }
  // By value, not spelling: "2.5 lbs" cites the source's "2½ lbs".
  const stated = numbersIn(givenText(input)).map((n) => n.value);
  const invented = numbersIn(basis).filter(
    (n) => !sameValue(n.value, serves) && !stated.some((value) => sameValue(value, n.value)),
  );
  if (invented.length > 0) {
    return {
      ok: false,
      basisRule: true,
      reason: `the basis cites ${invented.map((n) => n.text).join(", ")}, which the recipe doesn't state: ${basis}`,
    };
  }
  return { ok: true, estimate: { count: serves, basis } };
}

/**
 * The re-ask after a reply that broke a basis rule. As the cook-plan
 * derivation does, the model sees its reply and the rule it broke; asked the
 * same prompt again at temperature 0 it gives the same reply.
 */
export function servesCorrectionPrompt(reason: string): string {
  return `The app rejected that reply: ${reason}. Correct the basis, following every rule above, and return the JSON object {"basis", "serves"} again.`;
}

/**
 * Sous's estimate of the count, or why there is none. One call; a reply
 * that breaks a basis rule is asked again once with the rule named, then
 * fails. Both calls share the one abort deadline. Throws only `AllowanceUsedError`.
 */
export async function estimateServes(
  input: ServesEstimateInput,
  deps: ServesEstimateDeps,
): Promise<ServesEstimateResult> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? ESTIMATE_TIMEOUT_MS);
  const messages: ChatOptions["messages"] = [{ role: "user", content: servesEstimatePrompt(input) }];
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  for (let call = 1; ; call += 1) {
    let response: ChatResponse;
    const callOptions: PublicChatOptions = {
      systemPrompt: SERVES_ESTIMATE_SYSTEM_PROMPT,
      messages: [...messages],
      responseFormat: "json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
      thinkingBudget: ESTIMATE_THINKING_BUDGET,
      maxTokens: ESTIMATE_MAX_TOKENS,
      signal,
    };
    try {
      response = deps.chat
        ? await deps.chat(callOptions)
        : await defaultChat(callOptions, deps.meter);
    } catch (error) {
      if (isAllowanceUsed(error)) throw error;
      return {
        ok: false,
        reason: `the estimate call failed: ${error instanceof Error ? error.message : String(error)}`,
        ...(usage && { usage }),
      };
    }
    if (response.usage) {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + response.usage.inputTokens,
        outputTokens: (usage?.outputTokens ?? 0) + response.usage.outputTokens,
      };
    }
    if (response.finishReason === "max_tokens" || response.finishReason === "blocked") {
      return {
        ok: false,
        reason: `the model's reply was ${response.finishReason === "blocked" ? "blocked" : "cut off"}`,
        ...(usage && { usage }),
      };
    }
    const read = readServesReply(response.content, input);
    if (read.ok) return { ok: true, estimate: read.estimate, ...(usage && { usage }) };
    if (!read.basisRule || call === 2) {
      return {
        ok: false,
        reason: call === 2 ? `after a re-ask, ${read.reason}` : read.reason,
        ...(usage && { usage }),
      };
    }
    messages.push(
      { role: "assistant", content: response.content },
      { role: "user", content: servesCorrectionPrompt(read.reason) },
    );
  }
}
