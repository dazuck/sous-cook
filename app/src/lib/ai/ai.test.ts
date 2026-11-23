import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =============================================================================
// Config Tests
// =============================================================================

describe("AI Config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules to allow fresh config reads
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getConfig", () => {
    it("returns default values when no env vars set", async () => {
      // Set required API keys to prevent errors
      process.env.GOOGLE_AI_API_KEY = "test-google-key";

      const { getConfig } = await import("./config");
      const config = getConfig();

      // Defaults: Gemini 3.5 Flash for text, 2.5 Flash for vision
      expect(config.textProvider).toBe("google");
      expect(config.textModel).toBe("gemini-3.5-flash");
      expect(config.cookChatModel).toBe("gemini-3.5-flash");
      expect(config.visionProvider).toBe("google");
      expect(config.visionModel).toBe("gemini-2.5-flash");
    });

    it("falls back cookChatModel to AI_TEXT_MODEL when AI_COOK_CHAT_MODEL is unset", async () => {
      process.env.AI_TEXT_MODEL = "gemini-2.5-pro";
      delete process.env.AI_COOK_CHAT_MODEL;

      const { getConfig } = await import("./config");
      const config = getConfig();

      expect(config.cookChatModel).toBe("gemini-2.5-pro");
    });

    it("reads cookChatModel from AI_COOK_CHAT_MODEL when set", async () => {
      process.env.AI_TEXT_MODEL = "gemini-3.5-flash";
      process.env.AI_COOK_CHAT_MODEL = "gemini-2.5-flash";

      const { getConfig } = await import("./config");
      const config = getConfig();

      expect(config.textModel).toBe("gemini-3.5-flash");
      expect(config.cookChatModel).toBe("gemini-2.5-flash");
    });

    it("reads text provider from AI_TEXT_PROVIDER env var", async () => {
      process.env.AI_TEXT_PROVIDER = "google";
      process.env.GOOGLE_AI_API_KEY = "test-google-key";

      const { getConfig } = await import("./config");
      const config = getConfig();

      expect(config.textProvider).toBe("google");
    });

    it("reads text model from AI_TEXT_MODEL env var", async () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.AI_TEXT_MODEL = "claude-opus-4-20250514";

      const { getConfig } = await import("./config");
      const config = getConfig();

      expect(config.textModel).toBe("claude-opus-4-20250514");
    });

    it("reads vision provider from AI_VISION_PROVIDER env var", async () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.AI_VISION_PROVIDER = "anthropic";

      const { getConfig } = await import("./config");
      const config = getConfig();

      expect(config.visionProvider).toBe("anthropic");
    });

    it("reads vision model from AI_VISION_MODEL env var", async () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.AI_VISION_MODEL = "gemini-pro-vision";

      const { getConfig } = await import("./config");
      const config = getConfig();

      expect(config.visionModel).toBe("gemini-pro-vision");
    });

    it("includes API keys in config", async () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
      process.env.GOOGLE_AI_API_KEY = "test-google-key";

      const { getConfig } = await import("./config");
      const config = getConfig();

      expect(config.anthropicApiKey).toBe("test-anthropic-key");
      expect(config.googleApiKey).toBe("test-google-key");
    });
  });

  describe("validateConfig", () => {
    it("throws error when anthropic is text provider but no API key", async () => {
      process.env.AI_TEXT_PROVIDER = "anthropic";
      delete process.env.ANTHROPIC_API_KEY;

      const { validateConfig, getConfig } = await import("./config");
      const config = getConfig();

      expect(() => validateConfig(config)).toThrow(
        "ANTHROPIC_API_KEY required when using anthropic provider",
      );
    });

    it("throws error when google is text provider but no API key", async () => {
      process.env.AI_TEXT_PROVIDER = "google";
      delete process.env.GOOGLE_AI_API_KEY;

      const { validateConfig, getConfig } = await import("./config");
      const config = getConfig();

      expect(() => validateConfig(config)).toThrow(
        "GOOGLE_AI_API_KEY required when using google provider",
      );
    });

    it("throws error when google is vision provider but no API key", async () => {
      process.env.AI_TEXT_PROVIDER = "anthropic";
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.AI_VISION_PROVIDER = "google";
      delete process.env.GOOGLE_AI_API_KEY;

      const { validateConfig, getConfig } = await import("./config");
      const config = getConfig();

      expect(() => validateConfig(config)).toThrow(
        "GOOGLE_AI_API_KEY required when using google provider",
      );
    });

    it("does not throw when all required keys are present", async () => {
      process.env.AI_TEXT_PROVIDER = "anthropic";
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
      process.env.AI_VISION_PROVIDER = "google";
      process.env.GOOGLE_AI_API_KEY = "test-google-key";

      const { validateConfig, getConfig } = await import("./config");
      const config = getConfig();

      expect(() => validateConfig(config)).not.toThrow();
    });
  });
});

// =============================================================================
// Types Tests
// =============================================================================

describe("AI Types", () => {
  it("AIMessage type allows user, assistant, and system roles", async () => {
    const { isValidMessage } = await import("./types");

    expect(isValidMessage({ role: "user", content: "Hello" })).toBe(true);
    expect(isValidMessage({ role: "assistant", content: "Hi" })).toBe(true);
    expect(isValidMessage({ role: "system", content: "Context" })).toBe(true);
  });

  it("AIMessage type rejects invalid roles", async () => {
    const { isValidMessage } = await import("./types");

    expect(isValidMessage({ role: "admin", content: "Hello" })).toBe(false);
    expect(isValidMessage({ role: "", content: "Hello" })).toBe(false);
  });

  it("AIMessage requires content", async () => {
    const { isValidMessage } = await import("./types");

    expect(isValidMessage({ role: "user" })).toBe(false);
    expect(isValidMessage({ role: "user", content: "" })).toBe(true); // Empty string is valid
  });

  it("AIMessage accepts optional image data", async () => {
    const { isValidMessage } = await import("./types");

    // Message with image
    expect(
      isValidMessage({
        role: "user",
        content: "What's in this image?",
        image: { base64: "base64data" },
      }),
    ).toBe(true);

    // Message with image and mimeType
    expect(
      isValidMessage({
        role: "user",
        content: "Describe this",
        image: { base64: "base64data", mimeType: "image/jpeg" },
      }),
    ).toBe(true);

    // Message without image (backward compatible)
    expect(isValidMessage({ role: "user", content: "Hello" })).toBe(true);
  });

  it("AIMessage rejects invalid image data", async () => {
    const { isValidMessage } = await import("./types");

    // Invalid image: missing base64
    expect(
      isValidMessage({
        role: "user",
        content: "Test",
        image: { mimeType: "image/jpeg" },
      }),
    ).toBe(false);

    // Invalid image: wrong type for base64
    expect(
      isValidMessage({
        role: "user",
        content: "Test",
        image: { base64: 123 },
      }),
    ).toBe(false);

    // Invalid image: wrong type for mimeType
    expect(
      isValidMessage({
        role: "user",
        content: "Test",
        image: { base64: "data", mimeType: 123 },
      }),
    ).toBe(false);
  });

  it("isValidMessageImage validates image objects correctly", async () => {
    const { isValidMessageImage } = await import("./types");

    // Valid image with base64 only
    expect(isValidMessageImage({ base64: "data" })).toBe(true);

    // Valid image with base64 and mimeType
    expect(isValidMessageImage({ base64: "data", mimeType: "image/png" })).toBe(
      true,
    );

    // Invalid: missing base64
    expect(isValidMessageImage({ mimeType: "image/png" })).toBe(false);

    // Invalid: null
    expect(isValidMessageImage(null)).toBe(false);

    // Invalid: not an object
    expect(isValidMessageImage("string")).toBe(false);
  });
});

// =============================================================================
// Provider Selection Tests (via metered chat/vision)
// =============================================================================

describe("Provider Selection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("a missing key throws MissingApiKeyError before any reservation", async () => {
    process.env.AI_TEXT_PROVIDER = "google";
    delete process.env.GOOGLE_AI_API_KEY;

    const { chat } = await import("./chat");
    const { scriptMeter } = await import("./meter");

    await expect(
      chat(
        { messages: [{ role: "user", content: "Hi" }], maxTokens: 100 },
        scriptMeter("ai-test"),
      ),
    ).rejects.toMatchObject({
      name: "MissingApiKeyError",
      message: "GOOGLE_AI_API_KEY required when using google provider",
    });
  });

  it("throws error for unsupported text provider", async () => {
    process.env.AI_TEXT_PROVIDER = "openai";

    const { chat } = await import("./chat");
    const { scriptMeter } = await import("./meter");

    await expect(
      chat(
        { messages: [{ role: "user", content: "Hi" }], maxTokens: 100 },
        scriptMeter("ai-test"),
      ),
    ).rejects.toThrow("Unsupported AI provider: openai");
  });

  it("throws MissingApiKeyError for missing anthropic vision key when configured", async () => {
    process.env.AI_VISION_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;

    const { vision } = await import("./chat");
    const { scriptMeter } = await import("./meter");

    await expect(
      vision(
        { imageBase64: "aGVsbG8=", prompt: "Read", maxTokens: 100 },
        scriptMeter("ai-test"),
      ),
    ).rejects.toMatchObject({
      name: "MissingApiKeyError",
      message: "ANTHROPIC_API_KEY required when using anthropic provider",
    });
  });
});

// =============================================================================
// Chat Interface Tests
// =============================================================================

describe("Chat Interface", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("chat function exists and is callable", async () => {
    const { chat } = await import("./chat");

    expect(typeof chat).toBe("function");
  });

  it("vision function exists and is callable", async () => {
    const { vision } = await import("./chat");

    expect(typeof vision).toBe("function");
  });

  it("chat passes googleSearch through and returns sources from the provider", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-google-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "Use 74°C." }] },
              finishReason: "STOP",
              index: 0,
              groundingMetadata: {
                groundingChunks: [
                  {
                    web: {
                      title: "USDA",
                      uri: "https://www.fsis.usda.gov/food-safety",
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    try {
      const { chat } = await import("./chat");
      const { scriptMeter } = await import("./meter");
      const res = await chat(
        {
          messages: [{ role: "user", content: "Safe chicken temp?" }],
          googleSearch: true,
          maxTokens: 256,
        },
        scriptMeter("ai-test"),
      );

      expect(res.content).toBe("Use 74°C.");
      expect(res.sources).toEqual([
        { title: "USDA", url: "https://www.fsis.usda.gov/food-safety" },
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// =============================================================================
// Anthropic Provider Tests
// =============================================================================

describe("Anthropic Provider", () => {
  it("creates provider with correct name", async () => {
    const { createAnthropicProvider } = await import("./providers/anthropic");

    const provider = createAnthropicProvider("test-api-key");

    expect(provider.name).toBe("anthropic");
  });

  it("provider has chat method", async () => {
    const { createAnthropicProvider } = await import("./providers/anthropic");

    const provider = createAnthropicProvider("test-api-key");

    expect(typeof provider.chat).toBe("function");
  });

  it("provider has vision method", async () => {
    const { createAnthropicProvider } = await import("./providers/anthropic");

    const provider = createAnthropicProvider("test-api-key");

    expect(typeof provider.vision).toBe("function");
  });
});

// =============================================================================
// Google Provider Tests
// =============================================================================

describe("Google Provider", () => {
  it("creates provider with correct name", async () => {
    const { createGoogleProvider } = await import("./providers/google");

    const provider = createGoogleProvider("test-api-key");

    expect(provider.name).toBe("google");
  });

  it("provider has chat method", async () => {
    const { createGoogleProvider } = await import("./providers/google");

    const provider = createGoogleProvider("test-api-key");

    expect(typeof provider.chat).toBe("function");
  });

  it("provider has vision method", async () => {
    const { createGoogleProvider } = await import("./providers/google");

    const provider = createGoogleProvider("test-api-key");

    expect(typeof provider.vision).toBe("function");
  });
});

// =============================================================================
// Index Exports Tests
// =============================================================================

describe("Index Exports", () => {
  it("exports chat function", async () => {
    const aiModule = await import("./index");

    expect(typeof aiModule.chat).toBe("function");
  });

  it("exports vision function", async () => {
    const aiModule = await import("./index");

    expect(typeof aiModule.vision).toBe("function");
  });

  it("does not export bypass provider factories or getters", async () => {
    const aiModule = (await import("./index")) as Record<string, unknown>;
    const chatModule = (await import("./chat")) as Record<string, unknown>;

    expect(aiModule.getTextProvider).toBeUndefined();
    expect(aiModule.getVisionProvider).toBeUndefined();
    expect(aiModule.createAnthropicProvider).toBeUndefined();
    expect(aiModule.createGoogleProvider).toBeUndefined();
    expect(chatModule.getTextProvider).toBeUndefined();
    expect(chatModule.getVisionProvider).toBeUndefined();
  });

  it("exports type definitions", async () => {
    // Type exports can't be checked at runtime, but we can check
    // for the type guards/validators
    const typesModule = await import("./types");

    expect(typeof typesModule.isValidMessage).toBe("function");
  });
});
