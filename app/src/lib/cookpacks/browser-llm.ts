/**
 * Browser-only BYOK (Gemini, Anthropic, OpenAI) and local Ollama conversion
 * client for building collections without hitting Sous's server or AI budget.
 * Keys stay in browser localStorage and are never sent to Sous endpoints.
 */

import {
  buildCollectionRepairPrompt,
  extractJsonObjectText,
  validateCollectionJson,
  type CollectionAuthoringContext,
} from "./authoring";
import type { Pack } from "@sous/pack";

export type BrowserModelProvider = "gemini" | "anthropic" | "openai" | "ollama";

export interface BrowserModelPrefs {
  provider: BrowserModelProvider;
  model: string;
  ollamaUrl: string;
}

export interface BrowserRecipeImage {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  base64: string;
  name?: string;
}

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export const DEFAULT_BROWSER_MODELS: Record<BrowserModelProvider, string> = {
  gemini: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
  ollama: "qwen2.5:14b",
};

export const BROWSER_PROVIDER_LABELS: Record<BrowserModelProvider, string> = {
  gemini: "Google Gemini",
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
  ollama: "Local Ollama",
};

const PREFS_STORAGE_KEY = "sous-collection-model-prefs";
const API_KEY_STORAGE_PREFIX = "sous-collection-api-key:";

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readBrowserModelPrefs(): BrowserModelPrefs {
  const fallback: BrowserModelPrefs = {
    provider: "gemini",
    model: DEFAULT_BROWSER_MODELS.gemini,
    ollamaUrl: DEFAULT_OLLAMA_URL,
  };
  const storage = safeLocalStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<BrowserModelPrefs>;
    const provider: BrowserModelProvider =
      parsed.provider === "gemini" ||
      parsed.provider === "anthropic" ||
      parsed.provider === "openai" ||
      parsed.provider === "ollama"
        ? parsed.provider
        : "gemini";
    return {
      provider,
      model:
        typeof parsed.model === "string" && parsed.model.trim()
          ? parsed.model.trim()
          : DEFAULT_BROWSER_MODELS[provider],
      ollamaUrl:
        typeof parsed.ollamaUrl === "string" && parsed.ollamaUrl.trim()
          ? parsed.ollamaUrl.trim()
          : DEFAULT_OLLAMA_URL,
    };
  } catch {
    return fallback;
  }
}

export function saveBrowserModelPrefs(prefs: BrowserModelPrefs): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota errors in private browsing.
  }
}

export function readBrowserModelKey(provider: BrowserModelProvider): string {
  if (provider === "ollama") return "";
  const storage = safeLocalStorage();
  if (!storage) return "";
  try {
    return storage.getItem(`${API_KEY_STORAGE_PREFIX}${provider}`) ?? "";
  } catch {
    return "";
  }
}

export function saveBrowserModelKey(
  provider: BrowserModelProvider,
  apiKey: string,
): void {
  if (provider === "ollama") return;
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    const trimmed = apiKey.trim();
    if (trimmed) {
      storage.setItem(`${API_KEY_STORAGE_PREFIX}${provider}`, trimmed);
    } else {
      storage.removeItem(`${API_KEY_STORAGE_PREFIX}${provider}`);
    }
  } catch {
    // Ignore storage quota errors.
  }
}

export function forgetBrowserModelKey(provider: BrowserModelProvider): void {
  if (provider === "ollama") return;
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(`${API_KEY_STORAGE_PREFIX}${provider}`);
  } catch {
    // Ignore storage errors.
  }
}

export function validateOllamaUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim() || DEFAULT_OLLAMA_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid Ollama URL (for example http://localhost:11434).");
  }
  const isLocalHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw new Error(
      "Local Ollama URL must use http://localhost, http://127.0.0.1, or https://.",
    );
  }
  return parsed.origin;
}

function readErrorMessage(status: number, bodyText: string, provider: BrowserModelProvider): string {
  let parsedMessage: string | null = null;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: unknown } | unknown;
      message?: unknown;
    };
    if (typeof parsed.error === "string") {
      parsedMessage = parsed.error;
    } else if (
      parsed.error &&
      typeof parsed.error === "object" &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
    ) {
      parsedMessage = parsed.error.message;
    } else if (typeof parsed.message === "string") {
      parsedMessage = parsed.message;
    }
  } catch {
    // Fall back to trimmed body text.
  }

  const label = BROWSER_PROVIDER_LABELS[provider];
  if (status === 401 || status === 403) {
    return `${label} rejected your API key (${status}). Check the key or switch providers.`;
  }
  if (status === 429) {
    return `${label} rate-limited or ran out of quota (429). Try again shortly or use another model.`;
  }
  const detail = parsedMessage || bodyText.trim().slice(0, 200) || `HTTP ${status}`;
  return `${label} request failed (${status}): ${detail}`;
}

export interface BrowserModelCallInput {
  provider: BrowserModelProvider;
  model: string;
  apiKey?: string;
  ollamaUrl?: string;
  prompt: string;
  images?: readonly BrowserRecipeImage[];
  fetchImpl?: typeof fetch;
}

async function callBrowserProvider(input: BrowserModelCallInput): Promise<string> {
  const fetchFn = input.fetchImpl ?? fetch;
  const model = input.model.trim() || DEFAULT_BROWSER_MODELS[input.provider];
  const images = input.images ?? [];

  if (input.provider !== "ollama" && !(input.apiKey ?? "").trim()) {
    throw new Error(
      `Enter your ${BROWSER_PROVIDER_LABELS[input.provider]} API key (kept only in this browser).`,
    );
  }

  if (input.provider === "gemini") {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const parts: Array<Record<string, unknown>> = [{ text: input.prompt }];
    for (const img of images) {
      parts.push({
        inlineData: { mimeType: img.mimeType, data: img.base64 },
      });
    }
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": input.apiKey!.trim(),
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(readErrorMessage(res.status, text, "gemini"));
    const data = JSON.parse(text) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const out =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("") ?? "";
    if (!out.trim()) throw new Error("Google Gemini returned an empty response.");
    return extractJsonObjectText(out);
  }

  if (input.provider === "anthropic") {
    const content: Array<Record<string, unknown>> = images.map((img) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mimeType,
        data: img.base64,
      },
    }));
    content.push({ type: "text", text: input.prompt });

    const res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": input.apiKey!.trim(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        temperature: 0.2,
        messages: [{ role: "user", content }],
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(readErrorMessage(res.status, text, "anthropic"));
    const data = JSON.parse(text) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const out =
      data.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("") ?? "";
    if (!out.trim()) throw new Error("Anthropic returned an empty response.");
    return extractJsonObjectText(out);
  }

  if (input.provider === "openai") {
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: input.prompt },
      ...images.map((img) => ({
        type: "image_url",
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      })),
    ];

    const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey!.trim()}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content }],
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(readErrorMessage(res.status, text, "openai"));
    const data = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = data.choices?.[0]?.message?.content ?? "";
    if (!out.trim()) throw new Error("OpenAI returned an empty response.");
    return extractJsonObjectText(out);
  }

  // Local Ollama
  const baseOrigin = validateOllamaUrl(input.ollamaUrl ?? DEFAULT_OLLAMA_URL);
  let res: Response;
  try {
    res = await fetchFn(`${baseOrigin}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        messages: [
          {
            role: "user",
            content: input.prompt,
            ...(images.length > 0
              ? { images: images.map((img) => img.base64) }
              : {}),
          },
        ],
      }),
    });
  } catch {
    throw new Error(
      `Could not reach local Ollama at ${baseOrigin}. Make sure Ollama is running and allows browser origins (OLLAMA_ORIGINS).`,
    );
  }
  const text = await res.text();
  if (!res.ok) throw new Error(readErrorMessage(res.status, text, "ollama"));
  const data = JSON.parse(text) as {
    message?: { content?: string };
  };
  const out = data.message?.content ?? "";
  if (!out.trim()) throw new Error("Local Ollama returned an empty response.");
  return extractJsonObjectText(out);
}

export interface ConvertCollectionInBrowserResult {
  ok: boolean;
  jsonText: string;
  pack?: Pack;
  issues: string[];
  attempts: number;
}

/**
 * Converts pasted recipes or photos into Pack Format v0 JSON using the user's
 * browser-held model key or local Ollama, running one automatic repair pass if
 * schema, library ref, or cook-mode validation reports an issue.
 */
export async function convertCollectionInBrowser(
  input: BrowserModelCallInput & { authoringContext: CollectionAuthoringContext },
): Promise<ConvertCollectionInBrowserResult> {
  const firstText = await callBrowserProvider(input);
  const firstCheck = validateCollectionJson(firstText, input.authoringContext);
  if (firstCheck.ok) {
    return {
      ok: true,
      jsonText: JSON.stringify(firstCheck.pack, null, 2),
      pack: firstCheck.pack,
      issues: [],
      attempts: 1,
    };
  }

  const repairPrompt = buildCollectionRepairPrompt(firstText, firstCheck.issues);
  const repairedText = await callBrowserProvider({
    ...input,
    prompt: repairPrompt,
    images: [],
  });
  const secondCheck = validateCollectionJson(repairedText, input.authoringContext);
  if (secondCheck.ok) {
    return {
      ok: true,
      jsonText: JSON.stringify(secondCheck.pack, null, 2),
      pack: secondCheck.pack,
      issues: [],
      attempts: 2,
    };
  }

  return {
    ok: false,
    jsonText: repairedText,
    issues: secondCheck.issues,
    attempts: 2,
  };
}
