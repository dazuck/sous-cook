/**
 * AI Abstraction Layer
 *
 * Unified interface for AI operations supporting multiple providers
 * (Claude/Anthropic, Gemini/Google).
 *
 * @example
 * ```typescript
 * import { chat, vision } from '@/lib/ai';
 *
 * // Text chat (uses configured text provider, default: Gemini 3.5 Flash)
 * const response = await chat({
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   systemPrompt: 'You are a helpful assistant.',
 * });
 *
 * // Vision (uses configured vision provider, default: Gemini 2.5 Flash)
 * const items = await vision({
 *   imageBase64: 'base64-data',
 *   prompt: 'What items do you see?',
 * });
 * ```
 *
 * ## Configuration
 *
 * Set these environment variables to configure providers:
 * - AI_TEXT_PROVIDER: 'anthropic' | 'google' (default: 'google')
 * - AI_TEXT_MODEL: Model name for text (default: 'gemini-3.5-flash')
 * - AI_VISION_PROVIDER: 'anthropic' | 'google' (default: 'google')
 * - AI_VISION_MODEL: Model name for vision (default: 'gemini-2.5-flash')
 * - GOOGLE_AI_API_KEY: Required if using Google (default)
 * - ANTHROPIC_API_KEY: Required if using Anthropic
 *
 * ## Switching to Claude
 *
 * To use Claude Sonnet 4.5 instead:
 * AI_TEXT_PROVIDER=anthropic AI_TEXT_MODEL=claude-sonnet-4-5-20250514
 */

// Main API
export { chat, vision, getTextProvider, getVisionProvider } from "./chat";

// Configuration
export { getConfig, validateConfig, getValidatedConfig } from "./config";

// Types
export type {
  AIMessage,
  AIMessageRole,
  AIMessageImage,
  ChatOptions,
  ChatResponse,
  GroundingSource,
  ResponseSchema,
  VisionOptions,
  AIProvider,
  ProviderName,
  AIConfig,
} from "./types";

// Type guards
export { MissingApiKeyError, isValidMessage, isValidMessages, isValidMessageImage } from "./types";

// Provider factories (for advanced use cases)
export { createAnthropicProvider } from "./providers/anthropic";
export { createGoogleProvider } from "./providers/google";
