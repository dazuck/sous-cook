/**
 * AI Abstraction Layer
 *
 * Unified metered interface for AI operations supporting multiple providers
 * (Claude/Anthropic, Gemini/Google). Every model call goes through `chat()` or
 * `vision()` with an explicit `AiMeter`.
 */

// Main metered API
export { chat, vision } from "./chat";

// Metering helpers
export { kitchenMeter } from "./meter";
export type { AiFeature, AiMeter, KitchenAiMeter, ScriptAiMeter } from "./meter";

// Configuration
export { getConfig, validateConfig, getValidatedConfig } from "./config";

// Types
export type {
  AIMessage,
  AIMessageRole,
  AIMessageImage,
  AllowanceScope,
  ChatOptions,
  ChatResponse,
  GroundingSource,
  PublicChatOptions,
  PublicVisionOptions,
  ResponseSchema,
  VisionOptions,
  VisionResponse,
  AIProvider,
  ProviderName,
  AIConfig,
} from "./types";

// Errors and type guards
export {
  AllowanceUsedError,
  MissingApiKeyError,
  UnpricedModelError,
  findAllowanceUsed,
  formatResetDateUtc,
  isAllowanceUsed,
  isUnpricedModel,
  isValidMessage,
  isValidMessages,
  isValidMessageImage,
} from "./types";
