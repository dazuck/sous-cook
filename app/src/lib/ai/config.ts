/**
 * AI Abstraction Layer - Configuration
 *
 * Reads AI provider configuration from environment variables.
 */

import { MissingApiKeyError, type AIConfig, type ProviderName } from "./types";

// =============================================================================
// Default Values
// =============================================================================

// Primary: Gemini 3.5 Flash for fast, capable responses (newest Flash tier,
// better quality + token efficiency than 2.5). Vision stays on 2.5 Flash, which
// is battle-tested for the photo/pantry paths; bump it separately if desired.
const DEFAULT_TEXT_PROVIDER: ProviderName = "google";
const DEFAULT_TEXT_MODEL = "gemini-3.5-flash";
const DEFAULT_VISION_PROVIDER: ProviderName = "google";
const DEFAULT_VISION_MODEL = "gemini-2.5-flash";

// Backup models (can be set via env vars)
// AI_TEXT_PROVIDER=anthropic AI_TEXT_MODEL=claude-sonnet-4-5-20250514

// =============================================================================
// Configuration
// =============================================================================

/**
 * Reads AI configuration from environment variables.
 * Does NOT validate - call validateConfig() separately if needed.
 */
export function getConfig(): AIConfig {
  const textProvider =
    (process.env.AI_TEXT_PROVIDER as ProviderName) || DEFAULT_TEXT_PROVIDER;
  const textModel = process.env.AI_TEXT_MODEL || DEFAULT_TEXT_MODEL;
  const cookChatModel = process.env.AI_COOK_CHAT_MODEL || textModel;
  const visionProvider =
    (process.env.AI_VISION_PROVIDER as ProviderName) || DEFAULT_VISION_PROVIDER;
  const visionModel = process.env.AI_VISION_MODEL || DEFAULT_VISION_MODEL;

  return {
    textProvider,
    textModel,
    cookChatModel,
    visionProvider,
    visionModel,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    googleApiKey: process.env.GOOGLE_AI_API_KEY,
  };
}

/**
 * Validates that required API keys are present for configured providers.
 * Throws an error if validation fails.
 */
export function validateConfig(config: AIConfig): void {
  // Check if anthropic is needed
  if (
    config.textProvider === "anthropic" ||
    config.visionProvider === "anthropic"
  ) {
    if (!config.anthropicApiKey) {
      throw new MissingApiKeyError(
        "ANTHROPIC_API_KEY required when using anthropic provider",
      );
    }
  }

  // Check if google is needed
  if (config.textProvider === "google" || config.visionProvider === "google") {
    if (!config.googleApiKey) {
      throw new MissingApiKeyError("GOOGLE_AI_API_KEY required when using google provider");
    }
  }
}

/**
 * Gets a validated configuration.
 * Throws if required API keys are missing.
 */
export function getValidatedConfig(): AIConfig {
  const config = getConfig();
  validateConfig(config);
  return config;
}
