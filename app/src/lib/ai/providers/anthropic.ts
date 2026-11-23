/**
 * AI Abstraction Layer - Anthropic (Claude) Provider
 *
 * Wraps the Anthropic SDK for use with the unified AI interface.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  AIProvider,
  AIMessage,
  ChatOptions,
  ChatResponse,
  FinishReason,
  VisionOptions,
  VisionResponse,
} from "../types";

/** Map Anthropic's stop_reason to our normalized FinishReason. */
function mapAnthropicStopReason(reason: string | null): FinishReason {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "refusal") return "blocked";
  return "other";
}

// =============================================================================
// Client Management
// =============================================================================

let _client: Anthropic | null = null;
let _cachedApiKey: string | null = null;

function getClient(apiKey: string): Anthropic {
  // Return cached client if API key hasn't changed
  if (_client && _cachedApiKey === apiKey) {
    return _client;
  }

  _client = new Anthropic({ apiKey });
  _cachedApiKey = apiKey;
  return _client;
}

// =============================================================================
// Provider Implementation
// =============================================================================

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;

type SupportedMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

/**
 * Parse image data from base64 string, extracting media type if present
 */
function parseImageData(
  imageBase64: string,
  providedMimeType?: string,
): { mediaType: SupportedMediaType; data: string } {
  let mediaType: SupportedMediaType = "image/jpeg";
  let imageData = imageBase64;

  // Check for data URL prefix
  if (imageBase64.startsWith("data:")) {
    const match = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      mediaType = match[1] as SupportedMediaType;
      imageData = match[2];
    }
  } else if (providedMimeType) {
    mediaType = providedMimeType as SupportedMediaType;
  }

  return { mediaType, data: imageData };
}

/**
 * Build content array for a message that may include an image
 */
function buildMessageContent(message: AIMessage): string | ContentBlockParam[] {
  // If no image, return simple string content
  if (!message.image) {
    return message.content;
  }

  // Build content array with image and text
  const { mediaType, data } = parseImageData(
    message.image.base64,
    message.image.mimeType,
  );

  const content: ContentBlockParam[] = [];

  // Add image block first (Claude expects image before text when analyzing)
  const imageBlock: ImageBlockParam = {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data,
    },
  };
  content.push(imageBlock);

  // Add text block
  if (message.content) {
    const textBlock: TextBlockParam = {
      type: "text",
      text: message.content,
    };
    content.push(textBlock);
  }

  return content;
}

/**
 * Creates an Anthropic provider instance
 */
export function createAnthropicProvider(apiKey: string): AIProvider {
  const client = getClient(apiKey);

  return {
    name: "anthropic",

    async chat(options: ChatOptions): Promise<ChatResponse> {
      const model = options.model || DEFAULT_MODEL;
      const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
      const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

      // Build messages array for Anthropic API
      // Filter out system messages since they go in the system param
      const messages = options.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: buildMessageContent(m),
        }));

      // Build system prompt from explicit systemPrompt + any system messages
      const systemMessages = options.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content);

      let systemPrompt = options.systemPrompt || "";
      if (systemMessages.length > 0) {
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n${systemMessages.join("\n\n")}`
          : systemMessages.join("\n\n");
      }

      const response = await client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt || undefined,
          messages,
        },
        { signal: options.signal },
      );

      // Extract text content. A refusal can come back with none.
      const textContent = response.content.find((c) => c.type === "text");
      if (!textContent || textContent.type !== "text") {
        if (response.stop_reason !== "refusal") {
          throw new Error("No text content in Anthropic response");
        }
      }

      return {
        content: textContent?.type === "text" ? textContent.text : "",
        finishReason: mapAnthropicStopReason(response.stop_reason),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },

    async vision(options: VisionOptions): Promise<VisionResponse> {
      const model = options.model || DEFAULT_MODEL;
      const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

      // Detect media type from base64 header or default to JPEG
      let mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" =
        "image/jpeg";
      let imageData = options.imageBase64;

      // Check for data URL prefix
      if (options.imageBase64.startsWith("data:")) {
        const match = options.imageBase64.match(
          /^data:(image\/\w+);base64,(.+)$/,
        );
        if (match) {
          mediaType = match[1] as typeof mediaType;
          imageData = match[2];
        }
      }

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: imageData,
                },
              },
              {
                type: "text",
                text: options.prompt,
              },
            ],
          },
        ],
      });

      // Truncated vision output yields partial/garbage text; fail loudly.
      if (mapAnthropicStopReason(response.stop_reason) === "max_tokens") {
        throw new Error(
          "Vision response was truncated (hit the output token limit). Try a clearer or smaller image.",
        );
      }

      // Extract text content
      const textContent = response.content.find((c) => c.type === "text");
      if (!textContent || textContent.type !== "text") {
        throw new Error("No text content in Anthropic vision response");
      }

      return {
        content: textContent.text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}
