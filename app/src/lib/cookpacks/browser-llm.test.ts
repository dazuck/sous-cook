// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionAuthoringContext } from "./authoring";
import {
  convertCollectionInBrowser,
  forgetBrowserModelKey,
  readBrowserModelKey,
  readBrowserModelPrefs,
  saveBrowserModelKey,
  saveBrowserModelPrefs,
  validateOllamaUrl,
} from "./browser-llm";

const CONTEXT: CollectionAuthoringContext = {
  commons: [{ id: "commons:whisk", name: "Whisk", description: "Whisk briskly." }],
  states: [
    { id: "state:golden", name: "Golden", sensory_notes: { look: "Warm golden edges." } },
  ],
  reservedPackIds: ["household-book", "fannie-farmer-1896", "new"],
};

const VALID_PACK = {
  id: "browser-suppers",
  title: "Browser Suppers",
  version: "1.0.0",
  creator: { name: "Home Cook" },
  cover_ref: null,
  recipes: [
    {
      id: "lentil-soup",
      title: "Lentil Soup",
      story: "",
      serves_base: 4,
      ingredients: [
        {
          id: "i1",
          name: "Red lentils",
          qty_canonical: { mass_g: 200 },
          display_equivalents: { metric: { unit: "g", amount: 200 } },
        },
      ],
      steps: [
        {
          id: "s1",
          type: "action",
          text: "Simmer lentils 20 minutes.",
          ingredient_refs: ["i1"],
          timer_sec: 1200,
          media_ref: null,
        },
      ],
    },
  ],
};

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser-only model storage and conversion", () => {
  it("stores and forgets keys cleanly in browser localStorage and validates local Ollama URLs", () => {
    saveBrowserModelPrefs({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      ollamaUrl: "http://localhost:11434",
    });
    saveBrowserModelKey("anthropic", "test-anthropic-key");

    expect(readBrowserModelPrefs().provider).toBe("anthropic");
    expect(readBrowserModelKey("anthropic")).toBe("test-anthropic-key");

    forgetBrowserModelKey("anthropic");
    expect(readBrowserModelKey("anthropic")).toBe("");

    expect(validateOllamaUrl("http://localhost:11434")).toBe("http://localhost:11434");
    expect(() => validateOllamaUrl("http://example.com:11434")).toThrow(/localhost/);
  });

  it("calls the selected provider directly (never /api/) and runs one automatic repair retry on invalid refs", async () => {
    const badRefPack = structuredClone(VALID_PACK);
    badRefPack.recipes[0]!.steps[0] = {
      ...badRefPack.recipes[0]!.steps[0]!,
      technique_refs: ["commons:missing-technique"],
    } as never;

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (input, init) => {
        calls.push({
          url: String(input),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: JSON.stringify(badRefPack) }] } },
            ],
          }),
          { status: 200 },
        );
      })
      .mockImplementationOnce(async (input, init) => {
        calls.push({
          url: String(input),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: JSON.stringify(VALID_PACK) }] } },
            ],
          }),
          { status: 200 },
        );
      });

    const result = await convertCollectionInBrowser({
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "test-gemini-key",
      prompt: "Convert lentil soup",
      authoringContext: CONTEXT,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.pack?.id).toBe("browser-suppers");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("generativelanguage.googleapis.com");
    expect(calls[0]!.url).not.toContain("/api/trpc");
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("test-gemini-key");
  });

  it("supports Anthropic browser-access header and surfaces 401/429 errors cleanly", async () => {
    const fetchOk = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(VALID_PACK) }],
        }),
        { status: 200 },
      ),
    );

    const okRes = await convertCollectionInBrowser({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: "test-anthropic-key",
      prompt: "Convert",
      authoringContext: CONTEXT,
      fetchImpl: fetchOk,
    });
    expect(okRes.ok).toBe(true);
    const [, init] = fetchOk.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["anthropic-dangerous-direct-browser-access"]).toBe("true");

    const fetch401 = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    );
    await expect(
      convertCollectionInBrowser({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "test-openai-key",
        prompt: "Convert",
        authoringContext: CONTEXT,
        fetchImpl: fetch401,
      }),
    ).rejects.toThrow(/OpenAI rejected your API key \(401\)/);
  });
});
