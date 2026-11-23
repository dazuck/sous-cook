/**
 * Ask Sous never answers with a reply that didn't finish (feedback review
 * 2026-10-27). A voice answer stopped after a few words ("…in a bowl of cold
 * water for") and was shown, spoken and stored. No record kept the real stop
 * reason or token counts; the most likely cause, inferred from the code, is
 * Gemini's thinking spending most of the 350-token cap before the answer.
 *
 * The real chatCookingAssistant, the real AI layer and the real Google
 * provider and SDK run: only fetch (the Gemini HTTP response), the database
 * log and the queue are faked, and no hook is connected, so the household
 * context is empty. No request leaves the process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const inserts: Array<{ role: string; content: string }> = [];
vi.mock("./db", () => ({
  db: {
    insert: () => ({
      values: async (v: { role: string; content: string }) => {
        inserts.push(v);
      },
    }),
  },
  conversationLogs: {},
}));
// Never reached (no queueId); mocked so the database modules behind them
// aren't loaded.
vi.mock("./kitchen-queue", () => ({ getQueueItemForKitchen: vi.fn() }));
vi.mock("./shelf/load", () => ({ loadAppPackFiles: vi.fn() }));

const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

import { chatCookingAssistant, COOKING_MAX_TOKENS } from "./claude";
import { AnswerCutOff } from "./kitchen/ask-failure";

const QUESTION = "The stock is still cold. Can the noodles go in now?";
const WHOLE = "Bring it back to a simmer first, then add the noodles.";
const CUT = "Let the stock come back to a simmer before you add the";

/**
 * A Gemini generateContent response. The token counts are invented: a cut
 * reply's are shaped like the inferred cause (thinking spending most of the
 * cap), not taken from any record of the reported one.
 */
function geminiReply(
  text: string,
  finishReason: string,
  extra: { groundingMetadata?: unknown } = {},
) {
  const cut = finishReason === "MAX_TOKENS";
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          finishReason,
          index: 0,
          ...extra,
        },
      ],
      usageMetadata: {
        promptTokenCount: 2400,
        candidatesTokenCount: cut ? 12 : 14,
        ...(cut ? { thoughtsTokenCount: 338 } : {}),
        totalTokenCount: 2750,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function ask() {
  return chatCookingAssistant(
    "00000000-0000-4000-8000-000000000001",
    "ask-session",
    [{ role: "user", content: QUESTION }],
    "Noodle soup",
  );
}

beforeEach(() => {
  inserts.length = 0;
  fetchMock.mockReset();
  // The default provider and model (google, gemini-3.5-flash), whatever the
  // shell has set; the key is a placeholder, since fetch never leaves.
  vi.stubEnv("GOOGLE_AI_API_KEY", "fake");
  vi.stubEnv("AI_TEXT_PROVIDER", "");
  vi.stubEnv("AI_TEXT_MODEL", "");
  vi.stubEnv("AI_COOK_CHAT_MODEL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Ask Sous on Gemini: no thinking, and a cut reply is an error", () => {
  it("asks for the answer with thinking off, so the 350-token cap is all answer", async () => {
    fetchMock.mockImplementation(async () => geminiReply(WHOLE, "STOP"));

    const result = await ask();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(String(url)).toContain("gemini-3.5-flash");
    expect(body.generationConfig.maxOutputTokens).toBe(COOKING_MAX_TOKENS);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(body.tools).toEqual([{ googleSearch: {} }]);

    expect(result.content).toBe(WHOLE);
    expect(inserts.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: QUESTION },
      { role: "assistant", content: WHOLE },
    ]);
  });

  it("takes a Search-grounded reply that stopped normally as whole, with its sources", async () => {
    fetchMock.mockImplementation(async () =>
      geminiReply(WHOLE, "STOP", {
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://example.com/noodles", title: "Noodles" } }],
        },
      }),
    );

    const result = await ask();

    expect(result.content).toBe(WHOLE);
    expect(result.sources).toEqual([{ title: "Noodles", url: "https://example.com/noodles" }]);
  });

  it("fails a reply cut at the token cap as AnswerCutOff, logs why on the server, and stores nothing as the answer", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => geminiReply(CUT, "MAX_TOKENS"));

    const failure = await ask().then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(AnswerCutOff);
    // Output tokens count thinking beside the answer (the intake pass's
    // billing rule, `providers/google.ts`): 338 + 12, all of the cap.
    expect((failure as AnswerCutOff).outputTokens).toBe(COOKING_MAX_TOKENS);
    expect(inserts.map((i) => i.role)).toEqual(["user"]);
    expect(JSON.stringify(inserts)).not.toContain(CUT);
    expect(said).toHaveBeenCalledOnce();
    const logged = String(said.mock.calls[0][0]);
    expect(logged).toContain("[AskSous]");
    expect(logged).toContain("ask-session");
    expect(logged).toContain("finish max_tokens");
    expect(logged).toContain(`${COOKING_MAX_TOKENS} output tokens`);
    expect(logged).not.toContain(CUT);
    said.mockRestore();
  });

  it.each(["OTHER", "MALFORMED_FUNCTION_CALL", "FINISH_REASON_UNSPECIFIED"])(
    "fails a reply that ended for another reason (%s), and stores nothing as the answer",
    async (reason) => {
      const said = vi.spyOn(console, "error").mockImplementation(() => {});
      fetchMock.mockImplementation(async () => geminiReply(CUT, reason));

      await expect(ask()).rejects.toThrow(/ended without finishing \(other\)/);

      expect(inserts.map((i) => i.role)).toEqual(["user"]);
      expect(String(said.mock.calls[0][0])).toContain("finish other");
      said.mockRestore();
    },
  );
});
