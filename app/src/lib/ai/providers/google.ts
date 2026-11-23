/**
 * AI Abstraction Layer - Google (Gemini) Provider
 *
 * Wraps the Google Gen AI SDK (@google/genai) for use with the unified AI interface.
 */

import {
  GoogleGenAI,
  Type,
  type GenerateContentConfig,
  type GroundingChunk,
  type Part,
  type Schema,
} from "@google/genai";
import type {
  AIProvider,
  AIMessage,
  ChatOptions,
  ChatResponse,
  FinishReason,
  GroundingSource,
  ResponseSchema,
  VisionOptions,
  VisionResponse,
} from "../types";

/** Our schema in the SDK's types; the wire format is the same. */
function toGeminiSchema(schema: ResponseSchema): Schema {
  const base = {
    ...(schema.nullable !== undefined ? { nullable: schema.nullable } : {}),
    ...(schema.description ? { description: schema.description } : {}),
  };
  switch (schema.type) {
    case "string":
      return schema.enum
        ? { ...base, type: Type.STRING, format: "enum", enum: schema.enum }
        : { ...base, type: Type.STRING };
    case "number":
      return { ...base, type: Type.NUMBER };
    case "integer":
      return { ...base, type: Type.INTEGER };
    case "boolean":
      return { ...base, type: Type.BOOLEAN };
    case "array":
      return {
        ...base,
        type: Type.ARRAY,
        items: toGeminiSchema(schema.items),
        ...(schema.minItems !== undefined
          ? { minItems: String(schema.minItems) }
          : {}),
      };
    case "object":
      return {
        ...base,
        type: Type.OBJECT,
        properties: Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]) => [
            key,
            toGeminiSchema(value),
          ]),
        ),
        ...(schema.required ? { required: schema.required } : {}),
        ...(schema.propertyOrdering
          ? { propertyOrdering: schema.propertyOrdering }
          : {}),
      };
  }
}

/** Gemini finish reasons that mean the answer was withheld. */
const BLOCKED_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
]);

/** Map Gemini's finishReason enum to our normalized FinishReason. */
function mapGeminiFinishReason(reason: string | undefined): FinishReason {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "max_tokens";
  if (reason && BLOCKED_FINISH_REASONS.has(reason)) return "blocked";
  return "other";
}

/** Extract deduplicated web grounding sources from Gemini's groundingChunks. */
function extractGroundingSources(
  chunks: GroundingChunk[] | undefined,
): GroundingSource[] | undefined {
  if (!chunks || chunks.length === 0) return undefined;
  const seen = new Set<string>();
  const sources: GroundingSource[] = [];
  for (const chunk of chunks) {
    const url = chunk.web?.uri?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = chunk.web?.title?.trim() || url;
    sources.push({ title, url });
  }
  return sources.length > 0 ? sources : undefined;
}

// =============================================================================
// Client Management
// =============================================================================

let _client: GoogleGenAI | null = null;
let _cachedApiKey: string | null = null;

function getClient(apiKey: string): GoogleGenAI {
  // Return cached client if API key hasn't changed
  if (_client && _cachedApiKey === apiKey) {
    return _client;
  }

  _client = new GoogleGenAI({ apiKey });
  _cachedApiKey = apiKey;
  return _client;
}

// =============================================================================
// Provider Implementation
// =============================================================================

const DEFAULT_TEXT_MODEL = "gemini-2.0-flash-exp";
const DEFAULT_VISION_MODEL = "gemini-2.0-flash-exp";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;

/**
 * Parse image data from base64 string, extracting MIME type if present
 */
function parseImageData(
  imageBase64: string,
  providedMimeType?: string,
): { mimeType: string; data: string } {
  let mimeType = "image/jpeg";
  let imageData = imageBase64;

  // Check for data URL prefix
  if (imageBase64.startsWith("data:")) {
    const match = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      imageData = match[2];
    }
  } else if (providedMimeType) {
    mimeType = providedMimeType;
  }

  return { mimeType, data: imageData };
}

/**
 * Build Parts array for a message that may include an image
 */
function buildMessageParts(message: AIMessage): Part[] {
  const parts: Part[] = [];

  // If there's an image, add it first (Gemini typically expects image before text)
  if (message.image) {
    const { mimeType, data } = parseImageData(
      message.image.base64,
      message.image.mimeType,
    );
    parts.push({
      inlineData: {
        mimeType,
        data,
      },
    });
  }

  // Add text part
  if (message.content) {
    parts.push({ text: message.content });
  }

  return parts;
}

/**
 * Creates a Google (Gemini) provider instance
 */
export function createGoogleProvider(apiKey: string): AIProvider {
  const client = getClient(apiKey);

  return {
    name: "google",

    async chat(options: ChatOptions): Promise<ChatResponse> {
      const modelName = options.model || DEFAULT_TEXT_MODEL;
      const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
      const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

      // Build system instruction from systemPrompt + system messages
      const systemMessages = options.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content);

      let systemInstructionText = options.systemPrompt || "";
      if (systemMessages.length > 0) {
        systemInstructionText = systemInstructionText
          ? `${systemInstructionText}\n\n${systemMessages.join("\n\n")}`
          : systemMessages.join("\n\n");
      }

      // Convert messages to Gemini format
      // Gemini expects alternating user/model roles
      const contents = options.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: buildMessageParts(m),
        }));

      if (contents.length === 0) {
        throw new Error("No messages provided for chat");
      }

      const config: GenerateContentConfig = {
        maxOutputTokens: maxTokens,
        temperature,
        ...(options.signal ? { abortSignal: options.signal } : {}),
        ...(systemInstructionText
          ? {
              systemInstruction: {
                role: "user",
                parts: [{ text: systemInstructionText }],
              },
            }
          : {}),
        ...(options.responseFormat === "json"
          ? { responseMimeType: "application/json" }
          : {}),
        ...(options.responseSchema
          ? { responseSchema: toGeminiSchema(options.responseSchema) }
          : {}),
        ...(typeof options.thinkingBudget === "number"
          ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } }
          : {}),
        ...(options.googleSearch === true && options.responseFormat !== "json"
          ? { tools: [{ googleSearch: {} }] }
          : {}),
      };

      const response = await client.models.generateContent({
        model: modelName,
        contents,
        config,
      });

      // A blocked prompt comes back with feedback and no candidates.
      const finishReason = response.promptFeedback?.blockReason
        ? "blocked"
        : mapGeminiFinishReason(response.candidates?.[0]?.finishReason);

      let text = "";
      try {
        text = response.text ?? "";
      } catch {
        text = "";
      }

      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      const sources = extractGroundingSources(groundingMetadata?.groundingChunks);
      const searchQueries = Array.isArray(groundingMetadata?.webSearchQueries)
        ? groundingMetadata.webSearchQueries.length
        : undefined;
      const usageMetadata = response.usageMetadata;

      return {
        content: text,
        finishReason,
        ...(sources ? { sources } : {}),
        ...(searchQueries !== undefined ? { searchQueries } : {}),
        usage: usageMetadata
          ? {
              inputTokens: usageMetadata.promptTokenCount || 0,
              // Thinking is billed as output, beside the answer.
              outputTokens: (usageMetadata.candidatesTokenCount || 0) + (usageMetadata.thoughtsTokenCount || 0),
            }
          : undefined,
      };
    },

    async vision(options: VisionOptions): Promise<VisionResponse> {
      const modelName = options.model || DEFAULT_VISION_MODEL;

      const config: GenerateContentConfig = {
        ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
        ...(typeof options.thinkingBudget === "number"
          ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } }
          : {}),
      };

      const { mimeType, data: imageData } = parseImageData(options.imageBase64);

      const response = await client.models.generateContent({
        model: modelName,
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: imageData,
                },
              },
              { text: options.prompt },
            ],
          },
        ],
        config,
      });

      // Truncated vision output yields partial/garbage text; fail loudly instead
      // of returning broken content for the caller to mis-parse.
      if (
        mapGeminiFinishReason(response.candidates?.[0]?.finishReason) ===
        "max_tokens"
      ) {
        throw new Error(
          "Vision response was truncated (hit the output token limit). Try a clearer or smaller image.",
        );
      }

      const usageMetadata = response.usageMetadata;
      return {
        content: response.text ?? "",
        usage: usageMetadata
          ? {
              inputTokens: usageMetadata.promptTokenCount || 0,
              // Thinking is billed as output, beside the answer.
              outputTokens:
                (usageMetadata.candidatesTokenCount || 0) +
                (usageMetadata.thoughtsTokenCount || 0),
            }
          : undefined,
      };
    },
  };
}
