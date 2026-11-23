/**
 * The providers through their real SDKs, with only `fetch` stubbed: what
 * reaches the wire (the abort signal) and how each provider's stop reasons
 * normalize.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createAnthropicProvider } from "./anthropic";
import { createGoogleProvider } from "./google";

// One stub for the whole file: the Anthropic client keeps the fetch it was
// built with, and clients are cached per key.
const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

const message = { messages: [{ role: "user" as const, content: "Plan this." }] };

function respond(body: unknown) {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

/** A fetch that never answers, and rejects once its request is aborted. */
function hang() {
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      }),
  );
}

function gemini(finishReason: string, text = '{"tasks": []}') {
  return {
    candidates: [
      { content: { role: "model", parts: [{ text }] }, finishReason, index: 0 },
    ],
  };
}

function claude(stopReason: string, text = '{"tasks": []}') {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("Google provider", () => {
  const provider = () => createGoogleProvider("test-key");

  it.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "max_tokens"],
    ["SAFETY", "blocked"],
    ["RECITATION", "blocked"],
    ["PROHIBITED_CONTENT", "blocked"],
    ["OTHER", "other"],
  ])("normalizes finish reason %s to %s", async (reason, expected) => {
    respond(gemini(reason));
    const response = await provider().chat(message);
    expect(response.finishReason).toBe(expected);
  });

  it("reports a blocked prompt, which comes back with no candidates", async () => {
    respond({ promptFeedback: { blockReason: "SAFETY" } });
    const response = await provider().chat(message);
    expect(response).toMatchObject({ content: "", finishReason: "blocked" });
  });

  it("aborts the request when the caller's signal fires", async () => {
    hang();
    const controller = new AbortController();
    const call = provider().chat({ ...message, signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();
    await expect(call).rejects.toThrow(/abort/i);
  });

  it("sends a response schema as written, key order included, in JSON mode", async () => {
    respond(gemini("STOP"));
    const schema = {
      type: "object" as const,
      properties: {
        text: { type: "string" as const },
        kind: { type: "string" as const, enum: ["mise", "cook"] },
        cue: { type: "string" as const, nullable: true },
        needs: { type: "array" as const, items: { type: "string" as const } },
      },
      required: ["text", "kind", "cue", "needs"],
      propertyOrdering: ["text", "kind", "cue", "needs"],
    };
    await provider().chat({
      ...message,
      responseFormat: "json",
      responseSchema: schema,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    // @google/genai normalizes schema types to uppercase Type enum values and marks string enums with format "enum".
    expect(body.generationConfig.responseSchema).toEqual({
      type: "OBJECT",
      properties: {
        text: { type: "STRING" },
        kind: { type: "STRING", format: "enum", enum: ["mise", "cook"] },
        cue: { type: "STRING", nullable: true },
        needs: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["text", "kind", "cue", "needs"],
      propertyOrdering: ["text", "kind", "cue", "needs"],
    });
  });

  it("sends no schema when none is asked for", async () => {
    respond(gemini("STOP"));
    await provider().chat({ ...message, responseFormat: "json" });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.generationConfig).not.toHaveProperty("responseSchema");
  });

  it("sends thinkingBudget in generationConfig.thinkingConfig when specified", async () => {
    respond(gemini("STOP"));
    await provider().chat({ ...message, thinkingBudget: 0 });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("counts thinking tokens as output, as they are billed", async () => {
    respond({ ...gemini("STOP"), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 600 } });
    const response = await provider().chat({ ...message, thinkingBudget: 1024 });
    expect(response.usage).toEqual({ inputTokens: 100, outputTokens: 640 });
  });

  it("sends googleSearch tool when googleSearch is true and responseFormat is not json", async () => {
    respond(gemini("STOP", "Keep the salmon skin-side down."));
    await provider().chat({ ...message, googleSearch: true });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.tools).toEqual([{ googleSearch: {} }]);
  });

  it("omits googleSearch tool when responseFormat is json even if googleSearch is true", async () => {
    respond(gemini("STOP"));
    await provider().chat({
      ...message,
      responseFormat: "json",
      googleSearch: true,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty("tools");
  });

  it("extracts and deduplicates web grounding sources from groundingChunks", async () => {
    respond({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Cook to 165°F." }] },
          finishReason: "STOP",
          index: 0,
          groundingMetadata: {
            groundingChunks: [
              {
                web: {
                  title: "  USDA Safe Temp Chart  ",
                  uri: " https://www.fsis.usda.gov/temp-chart ",
                },
              },
              {
                web: {
                  title: "Duplicate USDA link",
                  uri: "https://www.fsis.usda.gov/temp-chart",
                },
              },
              {
                web: {
                  title: "   ",
                  uri: "https://seriouseats.com/chicken-temp",
                },
              },
              {
                web: {
                  title: "Missing URI",
                  uri: "   ",
                },
              },
              {},
            ],
          },
        },
      ],
    });
    const response = await provider().chat({ ...message, googleSearch: true });
    expect(response.sources).toEqual([
      {
        title: "USDA Safe Temp Chart",
        url: "https://www.fsis.usda.gov/temp-chart",
      },
      {
        title: "https://seriouseats.com/chicken-temp",
        url: "https://seriouseats.com/chicken-temp",
      },
    ]);
  });

  it("omits sources when groundingChunks has no valid web URIs", async () => {
    respond({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Simmer gently." }] },
          finishReason: "STOP",
          index: 0,
          groundingMetadata: {
            groundingChunks: [{ web: { title: "Blank", uri: "" } }],
          },
        },
      ],
    });
    const response = await provider().chat({ ...message, googleSearch: true });
    expect(response.sources).toBeUndefined();
  });

  it("supports vision and throws on max_tokens truncation", async () => {
    respond(gemini("STOP", "Two lemons and a lime."));
    const text = await provider().vision({
      imageBase64: "data:image/png;base64,aGVsbG8=",
      prompt: "What is on the counter?",
      maxTokens: 200,
      thinkingBudget: 0,
    });
    expect(text).toBe("Two lemons and a lime.");

    respond(gemini("MAX_TOKENS", "Truncated..."));
    await expect(
      provider().vision({
        imageBase64: "aGVsbG8=",
        prompt: "What is on the counter?",
      }),
    ).rejects.toThrow(/truncated/i);
  });
});

describe("Anthropic provider", () => {
  const provider = () => createAnthropicProvider("test-key");

  it.each([
    ["end_turn", "stop"],
    ["max_tokens", "max_tokens"],
    ["refusal", "blocked"],
    ["pause_turn", "other"],
  ])("normalizes stop reason %s to %s", async (reason, expected) => {
    respond(claude(reason));
    const response = await provider().chat(message);
    expect(response.finishReason).toBe(expected);
  });

  it("reports a refusal with no text as blocked, not as an error", async () => {
    respond({ ...claude("refusal"), content: [] });
    const response = await provider().chat(message);
    expect(response).toMatchObject({ content: "", finishReason: "blocked" });
  });

  it("still throws on a reply with no text that isn't a refusal", async () => {
    respond({ ...claude("end_turn"), content: [] });
    await expect(provider().chat(message)).rejects.toThrow(/No text content/);
  });

  it("aborts the request when the caller's signal fires", async () => {
    hang();
    const controller = new AbortController();
    const call = provider().chat({ ...message, signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();
    await expect(call).rejects.toThrow(/abort/i);
  });
});
