/**
 * AI Abstraction Layer - Shared Types
 *
 * This module defines the common types used across AI providers.
 */

// =============================================================================
// Errors
// =============================================================================

/**
 * The configured provider's API key isn't set: a fault of the deploy's
 * config, which fixing the config clears, never of what was asked. A caller
 * that retries (the queue's intake) tells it apart by its name.
 */
export class MissingApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingApiKeyError";
  }
}

export type AllowanceScope = "kitchen" | "overall";

const UTC_MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Formats a reset instant as "<day> <Month>" in UTC (for example, "1 December")
 * so the server's local time zone never shifts the date into the previous month.
 */
export function formatResetDateUtc(resetsAt: Date): string {
  return `${resetsAt.getUTCDate()} ${UTC_MONTH_NAMES[resetsAt.getUTCMonth()]!}`;
}

/**
 * Raised when a kitchen or the deployment as a whole has used up its monthly
 * AI allowance. Never stored as a recipe, plan, or intake error.
 */
export class AllowanceUsedError extends Error {
  readonly scope: AllowanceScope;
  readonly resetsAt: Date;

  constructor(scope: AllowanceScope, resetsAt: Date) {
    const resetDate = formatResetDateUtc(resetsAt);
    const message =
      scope === "kitchen"
        ? `This kitchen's AI allowance for this month is used up. It resets on ${resetDate}. Cooking from saved plans still works.`
        : `Sous's AI allowance for this month is used up for everyone. It resets on ${resetDate}. Cooking from saved plans still works.`;
    super(message);
    this.name = "AllowanceUsedError";
    this.scope = scope;
    this.resetsAt = resetsAt;
  }
}

/**
 * Walks an error and its `cause` chain looking for an `AllowanceUsedError`.
 */
export function findAllowanceUsed(err: unknown): AllowanceUsedError | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof AllowanceUsedError) {
      return cur;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Returns true when `err` or any error in its `cause` chain is an
 * `AllowanceUsedError`.
 */
export function isAllowanceUsed(err: unknown): boolean {
  return findAllowanceUsed(err) !== null;
}

/**
 * Raised when a kitchen-metered call targets a model with no price row while
 * a monthly cap is in force.
 */
export class UnpricedModelError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(`no price for model ${model}; add it to app/src/lib/ai/prices.ts`);
    this.name = "UnpricedModelError";
    this.model = model;
  }
}

/**
 * Returns true when `err` or any error in its `cause` chain is an
 * `UnpricedModelError`.
 */
export function isUnpricedModel(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof UnpricedModelError) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// =============================================================================
// Message Types
// =============================================================================

export type AIMessageRole = "user" | "assistant" | "system";

/**
 * Image data for vision-capable messages
 */
export interface AIMessageImage {
  /** Base64-encoded image data (with or without data URL prefix) */
  base64: string;
  /** MIME type (e.g., "image/jpeg", "image/png"). Auto-detected if not provided. */
  mimeType?: string;
}

export interface AIMessage {
  role: AIMessageRole;
  content: string;
  /** Optional image attachment for vision-capable models */
  image?: AIMessageImage;
}

// =============================================================================
// Chat Types
// =============================================================================

export interface ChatOptions {
  messages: AIMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  /** Force JSON output from the model. Supported by Gemini (responseMimeType). */
  responseFormat?: "text" | "json";
  /**
   * The JSON shape the answer must take, with responseFormat "json". Gemini
   * constrains its output to it (responseSchema), so a required field can't
   * be left out. The Anthropic provider doesn't send it, so callers still
   * validate what comes back.
   */
  responseSchema?: ResponseSchema;
  /**
   * Gemini thinking-token budget. Set to 0 to disable thinking entirely, which
   * frees the whole maxTokens budget for visible output — important for long
   * structured extractions where thinking tokens would otherwise truncate the
   * response. Undefined uses the model default. No-op for non-thinking providers.
   */
  thinkingBudget?: number;
  /** Enable Google Search grounding when supported by the provider (omitted in JSON mode). */
  googleSearch?: boolean;
  /** Aborts the request: the call rejects once the signal fires. */
  signal?: AbortSignal;
}

/**
 * The subset of the OpenAPI 3.0 schema object Gemini's responseSchema takes.
 * propertyOrdering sets the order Gemini writes an object's keys in; without
 * it, Gemini writes them alphabetically.
 */
export type ResponseSchema = { nullable?: boolean; description?: string } & (
  | { type: "string"; enum?: string[] }
  | { type: "number" | "integer" | "boolean" }
  | { type: "array"; items: ResponseSchema; minItems?: number }
  | {
      type: "object";
      properties: Record<string, ResponseSchema>;
      required?: string[];
      propertyOrdering?: string[];
    }
);

/**
 * Why the model stopped generating, normalized across providers. "blocked"
 * means the provider withheld the answer (a safety or recitation block, or a
 * refusal), so the content is empty or partial.
 */
export type FinishReason = "stop" | "max_tokens" | "blocked" | "other";

export interface GroundingSource {
  title: string;
  url: string;
}

export interface ChatResponse {
  content: string;
  /** Normalized stop reason. "max_tokens" means the output was truncated. */
  finishReason?: FinishReason;
  /** Web grounding sources returned by the provider, deduplicated by URL. */
  sources?: GroundingSource[];
  /** Number of web search queries reported by the provider's grounding metadata. */
  searchQueries?: number;
  usage?: {
    inputTokens: number;
    /** Every token billed as output, thinking included. */
    outputTokens: number;
  };
}

/** Public `chat()` options: callers must specify `maxTokens` for metering. */
export type PublicChatOptions = Omit<ChatOptions, "maxTokens"> & {
  maxTokens: number;
};

// =============================================================================
// Vision Types
// =============================================================================

export interface VisionOptions {
  imageBase64: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  /** See ChatOptions.thinkingBudget. 0 disables Gemini thinking for this call. */
  thinkingBudget?: number;
}

/** Public `vision()` options: callers must specify `maxTokens` for metering. */
export type PublicVisionOptions = Omit<VisionOptions, "maxTokens"> & {
  maxTokens: number;
};

export interface VisionResponse {
  content: string;
  usage?: {
    inputTokens: number;
    /** Every token billed as output, thinking included. */
    outputTokens: number;
  };
}

// =============================================================================
// Provider Types
// =============================================================================

export type ProviderName = "anthropic" | "google";

export interface AIProvider {
  name: ProviderName;
  chat: (options: ChatOptions) => Promise<ChatResponse>;
  vision: (options: VisionOptions) => Promise<VisionResponse>;
}

// =============================================================================
// Configuration Types
// =============================================================================

export interface AIConfig {
  textProvider: ProviderName;
  textModel: string;
  cookChatModel: string;
  visionProvider: ProviderName;
  visionModel: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
}

// =============================================================================
// Type Guards & Validators
// =============================================================================

const VALID_ROLES: AIMessageRole[] = ["user", "assistant", "system"];

/**
 * Validates that an object is a valid AIMessageImage
 */
export function isValidMessageImage(obj: unknown): obj is AIMessageImage {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const image = obj as Record<string, unknown>;

  if (typeof image.base64 !== "string") {
    return false;
  }

  // mimeType is optional but must be a string if present
  if (image.mimeType !== undefined && typeof image.mimeType !== "string") {
    return false;
  }

  return true;
}

/**
 * Validates that an object is a valid AIMessage
 */
export function isValidMessage(obj: unknown): obj is AIMessage {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const message = obj as Record<string, unknown>;

  if (typeof message.role !== "string") {
    return false;
  }

  if (!VALID_ROLES.includes(message.role as AIMessageRole)) {
    return false;
  }

  if (typeof message.content !== "string") {
    return false;
  }

  // image is optional but must be valid if present
  if (message.image !== undefined && !isValidMessageImage(message.image)) {
    return false;
  }

  return true;
}

/**
 * Validates an array of messages
 */
export function isValidMessages(arr: unknown): arr is AIMessage[] {
  if (!Array.isArray(arr)) {
    return false;
  }

  return arr.every(isValidMessage);
}
