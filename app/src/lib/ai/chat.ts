/**
 * AI Abstraction Layer - Unified Metered Chat Interface
 *
 * The single choke point every model call passes through. Kitchen-metered calls
 * reserve spend under the monthly caps before calling the provider and settle
 * afterwards; script-metered calls bypass the database and caps.
 */

import { getConfig } from "./config";
import type { AiMeter } from "./meter";
import {
  estimateChatUsage,
  estimateVisionUsage,
  failAiCall,
  reserveAiCall,
  settleAiCall,
} from "./spend";
import {
  MissingApiKeyError,
  type AIProvider,
  type ChatResponse,
  type ProviderName,
  type PublicChatOptions,
  type PublicVisionOptions,
  type VisionResponse,
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
// Provider Factory (module-private: every call must go through chat/vision)
// =============================================================================

function createProvider(name: ProviderName, apiKey: string): AIProvider {
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

  setCachedProvider(name, apiKey, provider);
  return provider;
}

function resolveTextProvider(): AIProvider {
  const config = getConfig();
  const providerName = config.textProvider;

  if (providerName === "anthropic") {
    if (!config.anthropicApiKey) {
      throw new MissingApiKeyError(
        "ANTHROPIC_API_KEY required when using anthropic provider",
      );
    }
    return createProvider(providerName, config.anthropicApiKey);
  }
  if (providerName === "google") {
    if (!config.googleApiKey) {
      throw new MissingApiKeyError(
        "GOOGLE_AI_API_KEY required when using google provider",
      );
    }
    return createProvider(providerName, config.googleApiKey);
  }
  throw new Error(`Unsupported AI provider: ${providerName}`);
}

function resolveVisionProvider(): AIProvider {
  const config = getConfig();
  const providerName = config.visionProvider;

  if (providerName === "anthropic") {
    if (!config.anthropicApiKey) {
      throw new MissingApiKeyError(
        "ANTHROPIC_API_KEY required when using anthropic provider",
      );
    }
    return createProvider(providerName, config.anthropicApiKey);
  }
  if (providerName === "google") {
    if (!config.googleApiKey) {
      throw new MissingApiKeyError(
        "GOOGLE_AI_API_KEY required when using google provider",
      );
    }
    return createProvider(providerName, config.googleApiKey);
  }
  throw new Error(`Unsupported AI provider: ${providerName}`);
}

// =============================================================================
// Public Metered API
// =============================================================================

/**
 * Sends a chat request to the configured text provider under the given meter.
 */
export async function chat(
  options: PublicChatOptions,
  meter: AiMeter,
): Promise<ChatResponse> {
  const config = getConfig();
  const provider = resolveTextProvider();
  const model = options.model || config.textModel;

  const optionsWithModel: PublicChatOptions = {
    ...options,
    model,
  };

  if (meter.kind === "script") {
    return provider.chat(optionsWithModel);
  }

  const estimate = estimateChatUsage(provider.name, optionsWithModel);
  const reservation = await reserveAiCall({
    kitchenId: meter.kitchenId,
    memberId: meter.memberId,
    feature: meter.feature,
    provider: provider.name,
    model,
    estimate,
  });

  let response: ChatResponse;
  try {
    response = await provider.chat(optionsWithModel);
  } catch (err) {
    await failAiCall(reservation);
    throw err;
  }

  await settleAiCall(
    reservation,
    response.usage
      ? {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          searchQueries: response.searchQueries,
        }
      : undefined,
  );
  return response;
}

/**
 * Sends a vision request to the configured vision provider under the given meter.
 */
export async function vision(
  options: PublicVisionOptions,
  meter: AiMeter,
): Promise<string> {
  const config = getConfig();
  const provider = resolveVisionProvider();
  const model = options.model || config.visionModel;

  const optionsWithModel: PublicVisionOptions = {
    ...options,
    model,
  };

  if (meter.kind === "script") {
    const response = await provider.vision(optionsWithModel);
    return response.content;
  }

  const estimate = estimateVisionUsage(optionsWithModel);
  const reservation = await reserveAiCall({
    kitchenId: meter.kitchenId,
    memberId: meter.memberId,
    feature: meter.feature,
    provider: provider.name,
    model,
    estimate,
  });

  let response: VisionResponse;
  try {
    response = await provider.vision(optionsWithModel);
  } catch (err) {
    await failAiCall(reservation);
    throw err;
  }

  await settleAiCall(reservation, response.usage);
  return response.content;
}
