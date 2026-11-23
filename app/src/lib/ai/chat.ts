/**
 * AI Abstraction Layer - Unified Chat Interface
 *
 * Provides a unified interface for AI chat and vision operations
 * that abstracts away the underlying provider (Claude, Gemini).
 */

import { getConfig } from "./config";
import {
  MissingApiKeyError,
  type AIProvider,
  type ChatOptions,
  type ChatResponse,
  type ProviderName,
  type VisionOptions,
} from "./types";
import { createAnthropicProvider } from "./providers/anthropic";
import { createGoogleProvider } from "./providers/google";

// =============================================================================
// Provider Cache
// =============================================================================

const providerCache: Map<string, AIProvider> = new Map();

function getCachedProvider(
  name: ProviderName,
  apiKey: string,
): AIProvider | undefined {
  const cacheKey = `${name}:${apiKey}`;
  return providerCache.get(cacheKey);
}

function setCachedProvider(
  name: ProviderName,
  apiKey: string,
  provider: AIProvider,
): void {
  const cacheKey = `${name}:${apiKey}`;
  providerCache.set(cacheKey, provider);
}

// =============================================================================
// Provider Factory
// =============================================================================

function createProvider(name: ProviderName, apiKey: string): AIProvider {
  // Check cache first
  const cached = getCachedProvider(name, apiKey);
  if (cached) {
    return cached;
  }

  let provider: AIProvider;

  switch (name) {
    case "anthropic":
      provider = createAnthropicProvider(apiKey);
      break;
    case "google":
      provider = createGoogleProvider(apiKey);
      break;
    default:
      throw new Error(`Unsupported AI provider: ${name}`);
  }

  // Cache and return
  setCachedProvider(name, apiKey, provider);
  return provider;
}

// =============================================================================
// Provider Getters
// =============================================================================

/**
 * Gets the provider configured for text operations.
 * Reads from AI_TEXT_PROVIDER env var, defaults to 'anthropic'.
 */
export function getTextProvider(): AIProvider {
  const config = getConfig();
  const providerName = config.textProvider;

  let apiKey: string | undefined;
  if (providerName === "anthropic") {
    apiKey = config.anthropicApiKey;
    if (!apiKey) {
      throw new MissingApiKeyError(
        "ANTHROPIC_API_KEY required when using anthropic provider",
      );
    }
  } else if (providerName === "google") {
    apiKey = config.googleApiKey;
    if (!apiKey) {
      throw new MissingApiKeyError("GOOGLE_AI_API_KEY required when using google provider");
    }
  } else {
    throw new Error(`Unsupported AI provider: ${providerName}`);
  }

  return createProvider(providerName, apiKey);
}

/**
 * Gets the provider configured for vision operations.
 * Reads from AI_VISION_PROVIDER env var, defaults to 'google'.
 */
export function getVisionProvider(): AIProvider {
  const config = getConfig();
  const providerName = config.visionProvider;

  let apiKey: string | undefined;
  if (providerName === "anthropic") {
    apiKey = config.anthropicApiKey;
    if (!apiKey) {
      throw new MissingApiKeyError(
        "ANTHROPIC_API_KEY required when using anthropic provider",
      );
    }
  } else if (providerName === "google") {
    apiKey = config.googleApiKey;
    if (!apiKey) {
      throw new MissingApiKeyError("GOOGLE_AI_API_KEY required when using google provider");
    }
  } else {
    throw new Error(`Unsupported AI provider: ${providerName}`);
  }

  return createProvider(providerName, apiKey);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Send a chat request to the configured text provider.
 *
 * @example
 * ```typescript
 * import { chat } from '@/lib/ai';
 *
 * const response = await chat({
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   systemPrompt: 'You are a helpful assistant.',
 * });
 *
 * console.log(response.content);
 * ```
 */
export async function chat(options: ChatOptions): Promise<ChatResponse> {
  const config = getConfig();
  const provider = getTextProvider();

  // Apply default model from config if not specified
  const optionsWithModel: ChatOptions = {
    ...options,
    model: options.model || config.textModel,
  };

  return provider.chat(optionsWithModel);
}

/**
 * Send a vision request to the configured vision provider.
 *
 * @example
 * ```typescript
 * import { vision } from '@/lib/ai';
 *
 * const result = await vision({
 *   imageBase64: 'base64-encoded-image-data',
 *   prompt: 'What items do you see in this image?',
 * });
 *
 * console.log(result);
 * ```
 */
export async function vision(options: VisionOptions): Promise<string> {
  const config = getConfig();
  const provider = getVisionProvider();

  // Apply default model from config if not specified
  const optionsWithModel: VisionOptions = {
    ...options,
    model: options.model || config.visionModel,
  };

  return provider.vision(optionsWithModel);
}
