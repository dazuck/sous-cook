/**
 * The serving estimator (slice B4b). The model is the one external boundary,
 * so the provider's `chat` is the only thing replaced: every test runs the
 * real prompt building and the real reply check.
 */

import { describe, expect, it } from "vitest";
import type { ChatOptions, ChatResponse } from "./ai";
import {
  DISH_ALONE,
  FROM_SOURCE_TEXT,
  SERVES_ESTIMATE_SYSTEM_PROMPT,
  SOURCE_TEXT_CAP,
  estimateServes,
  numbersIn,
  queueSourceText,
  servesCorrectionPrompt,
  servesEstimatePrompt,
  type ServesEstimateInput,
} from "./serves-estimate";

const DAL: ServesEstimateInput = {
  name: "Dal",
  ingredients: [
    { item: "red lentils", amount: "1", unit: "cup" },
    { item: "salt, to taste" },
  ],
  steps: ["Rinse the lentils.", "Simmer 20 minutes."],
  sourceText: "Dal\n1 cup red lentils\nsalt\nRinse. Simmer 20 minutes.",
  hasAmounts: true,
};

/** A provider that records each call and answers with `reply`. */
function provider(reply: Partial<ChatResponse> | ((o: ChatOptions) => Promise<ChatResponse>)) {
  const calls: ChatOptions[] = [];
  const chat = async (options: ChatOptions): Promise<ChatResponse> => {
    calls.push(options);
    if (typeof reply === "function") return reply(options);
    return { content: "", finishReason: "stop", ...reply };
  };
  return { chat, calls };
}

const json = (value: unknown) => ({ content: JSON.stringify(value) });

describe("the call", () => {
  it("sends the system prompt, the recipe and its source text, JSON with a schema, temperature 0, thinking off", async () => {
    const { chat, calls } = provider(json({ basis: "1 cup lentils: 3 bowls.", serves: 3 }));
    await estimateServes(DAL, { chat });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.systemPrompt).toBe(SERVES_ESTIMATE_SYSTEM_PROMPT);
    expect(call.responseFormat).toBe("json");
    expect(call.responseSchema).toMatchObject({
      type: "object",
      required: ["basis", "serves"],
      properties: { serves: { type: "integer", nullable: true }, basis: { type: "string" } },
    });
    expect(call.temperature).toBe(0);
    // Thinking on (fix round 2), with room for the reply after it.
    expect(call.thinkingBudget).toBe(1024);
    expect(call.maxTokens).toBe(2048);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    const content = call.messages[0]!.content;
    expect(content).toContain("Recipe: Dal");
    expect(content).toContain("Amounts in the ingredient lines: yes.");
    expect(content).not.toContain("Category:");
    expect(content).toContain("- 1 cup red lentils");
    expect(content).toContain("- salt, to taste");
    expect(content).toContain("2. Simmer 20 minutes.");
    expect(content).toContain("<<<\nDal\n1 cup red lentils");
  });

  it("caps the source text, and leaves it out when there is none", () => {
    const long = servesEstimatePrompt({ ...DAL, sourceText: "x".repeat(SOURCE_TEXT_CAP + 500) });
    expect(long).toContain(`<<<\n${"x".repeat(SOURCE_TEXT_CAP)}\n>>>`);
    expect(long).not.toContain("x".repeat(SOURCE_TEXT_CAP + 1));
    const none = servesEstimatePrompt({ ...DAL, sourceText: null });
    expect(none).not.toContain("<<<");
    expect(none).not.toContain("Source text");
  });

  it("says when the ingredient lines give no amounts, that the source text may, and how the basis opens either way", () => {
    const prompt = servesEstimatePrompt({
      name: "Tuna salad",
      ingredients: [{ item: "tuna" }, { item: "mayo" }],
      steps: [],
      hasAmounts: false,
    });
    expect(prompt).toContain("Amounts in the ingredient lines: none. The source text may still state some");
    expect(prompt).toContain(`start the basis with "${FROM_SOURCE_TEXT}"`);
    expect(prompt).toContain(`start the basis with "${DISH_ALONE}"`);
    expect(prompt).toContain("Steps:\n(none listed)");
  });

  it("gives the category when there is one", () => {
    expect(servesEstimatePrompt({ ...DAL, category: "apps" })).toContain("Recipe: Dal\nCategory: apps\n");
  });

  it("the system prompt puts a stated yield or portioning first, a one-portion recipe at 1, and a basis only from the source", () => {
    expect(SERVES_ESTIMATE_SYSTEM_PROMPT).toContain("The source comes first.");
    expect(SERVES_ESTIMATE_SYSTEM_PROMPT).toContain('"slice into 4-6 wedges, plate 2 slices" serves 2 to 3');
    expect(SERVES_ESTIMATE_SYSTEM_PROMPT).toContain("A recipe written for one portion");
    expect(SERVES_ESTIMATE_SYSTEM_PROMPT).toContain("It may cite only amounts and words the source states, as the source states them");
    expect(SERVES_ESTIMATE_SYSTEM_PROMPT).toContain("never a yield, total weight or volume you worked out");
  });
});

describe("a reply that is an estimate", () => {
  it("is a whole number from 1 to 48 with a basis, trimmed", async () => {
    for (const serves of [1, 6, 48]) {
      const { chat } = provider({
        ...json({ basis: `  1 cup red lentils: about ${serves} bowls. `, serves }),
        usage: { inputTokens: 900, outputTokens: 30 },
      });
      expect(await estimateServes(DAL, { chat })).toEqual({
        ok: true,
        estimate: { count: serves, basis: `1 cup red lentils: about ${serves} bowls.` },
        usage: { inputTokens: 900, outputTokens: 30 },
      });
    }
  });

  it("with no amounts in the lines, only when the basis says what it rests on: the source text or the dish alone", async () => {
    const input = { ...DAL, hasAmounts: false, sourceText: "Udon, greens, eggs, 3 tbsp soy sauce." };
    for (const basis of [
      `${DISH_ALONE} a tuna salad for two sandwiches.`,
      `${FROM_SOURCE_TEXT} 3 tbsp soy sauce with udon and eggs: about 2 bowls.`,
    ]) {
      const { chat } = provider(json({ basis, serves: 2 }));
      expect(await estimateServes(input, { chat })).toMatchObject({ ok: true, estimate: { count: 2 } });
    }
    const other = provider(json({ basis: "About 2 sandwiches.", serves: 2 }));
    const refused = await estimateServes(input, { chat: other.chat });
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.reason).toMatch(/doesn't say whether it rests on the source text or the dish alone/);
  });
});

describe("a reply that is not an estimate: a reason, never a number", () => {
  const cases: [string, Partial<ChatResponse>, RegExp][] = [
    ["null", json({ basis: "Not a recipe.", serves: null }), /gave no count: Not a recipe\./],
    ["a fraction", json({ basis: "b", serves: 4.5 }), /4\.5 isn't a whole number from 1 to 48/],
    ["zero", json({ basis: "b", serves: 0 }), /0 isn't a whole number/],
    ["over 48", json({ basis: "b", serves: 49 }), /49 isn't a whole number/],
    ["a string count", json({ basis: "b", serves: "4" }), /isn't \{serves, basis\}/],
    ["no basis", json({ basis: " ​ ", serves: 4 }), /gave no basis/],
    ["a long basis", json({ basis: "x".repeat(241), serves: 4 }), /241 characters, over 240/],
    ["not JSON", { content: "four" }, /isn't JSON/],
    ["cut off", { content: '{"basis": "2 lb', finishReason: "max_tokens" }, /cut off/],
    ["blocked", { content: "", finishReason: "blocked" }, /blocked/],
  ];
  for (const [name, reply, reason] of cases) {
    it(name, async () => {
      const { chat } = provider(reply);
      const result = await estimateServes(DAL, { chat });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(reason);
      expect("estimate" in result).toBe(false);
    });
  }

  it("\"From the source text:\" when no source text was sent", async () => {
    const { chat } = provider(json({ basis: `${FROM_SOURCE_TEXT} udon and greens: 1 bowl.`, serves: 1 }));
    const result = await estimateServes({ ...DAL, hasAmounts: false, sourceText: null }, { chat });
    expect(!result.ok && result.reason).toMatch(/rests on the source text, but none was sent/);
  });

  it("a number in the basis the recipe doesn't state (a worked-out yield, a pan size)", async () => {
    for (const [basis, cited] of [
      ["1 cup red lentils makes about 2.5 cups of dal: 3 bowls.", "2.5"],
      ["1 cup lentils in a 9-inch pot: 3 bowls.", "9"],
      ["1/2 cup lentils: 3 bowls.", "1/2"],
    ] as const) {
      // The same reply twice: asked again once, then a failed estimate.
      const { chat, calls } = provider(json({ basis, serves: 3 }));
      const result = await estimateServes(DAL, { chat });
      expect(!result.ok && result.reason).toBe(
        `after a re-ask, the basis cites ${cited}, which the recipe doesn't state: ${basis}`,
      );
      expect(calls).toHaveLength(2);
    }
  });

  it("a provider that throws", async () => {
    const { chat } = provider(async () => {
      throw new Error("GOOGLE_AI_API_KEY is not set");
    });
    expect(await estimateServes(DAL, { chat })).toEqual({
      ok: false,
      reason: "the estimate call failed: GOOGLE_AI_API_KEY is not set",
    });
  });

  it("a provider that hangs: the call is aborted at the timeout", async () => {
    const { chat } = provider(
      (options) =>
        new Promise((_, reject) => {
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason));
        }),
    );
    const result = await estimateServes(DAL, { chat, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/^the estimate call failed: .*(timed out|timeout|aborted)/i);
  });
});

describe("numbersIn: the numbers a basis may cite, by value", () => {
  it("reads integers, decimals, fractions, mixed numbers and the glyphs, each with its value", () => {
    expect(numbersIn("1⅓ cups lemon juice, 8–10 thighs, 2.5 lbs, ¾ cup, a 9-inch pan, 1/2 tsp, 1 1/2 cups")).toEqual([
      { text: "1⅓", value: 1 + 1 / 3 },
      { text: "8", value: 8 },
      { text: "10", value: 10 },
      { text: "2.5", value: 2.5 },
      { text: "¾", value: 0.75 },
      { text: "9", value: 9 },
      { text: "1/2", value: 0.5 },
      { text: "1 1/2", value: 1.5 },
    ]);
    expect(numbersIn("two eggs and a handful")).toEqual([]);
  });

  it("never joins a number across a line break (the given text is joined by newlines)", () => {
    expect(numbersIn("Step 2\n½ cup sugar").map((n) => n.value)).toEqual([2, 0.5]);
    expect(numbersIn("Serves 4\n1/2 cup oil").map((n) => n.value)).toEqual([4, 0.5]);
    expect(numbersIn("1 ½ cups\t2\t1/2 tsp").map((n) => n.value)).toEqual([1.5, 2.5]);
  });

  it("a basis citing ½ after a line ending in a number reads ½, not a merged value", async () => {
    const { chat, calls } = provider(json({ basis: "½ cup sugar and 2 eggs: about 4 portions.", serves: 4 }));
    const result = await estimateServes(
      { name: "Cake", ingredients: [], steps: ["Step 2", "½ cup sugar, 2 eggs."], hasAmounts: true },
      { chat },
    );
    expect(result).toMatchObject({ ok: true, estimate: { count: 4 } });
    expect(calls).toHaveLength(1);
  });

  it("reads a fraction slash, a decimal comma and a thousands comma as their values", () => {
    expect(numbersIn("1⁄2 cup").map((n) => n.value)).toEqual([0.5]);
    expect(numbersIn("1,5 kg").map((n) => n.value)).toEqual([1.5]);
    expect(numbersIn("1,000 g").map((n) => n.value)).toEqual([1000]);
  });

  // The verifier's probes (round 3): spellings of one value are one number,
  // both ways round.
  it.each([
    ["2½ lbs goat", "2.5 lbs goat: about 6 portions."],
    ["2.5 lbs goat", "2½ lbs goat: about 6 portions."],
    ["2 1/2 lbs goat", "2.5 lbs goat: about 6 portions."],
    ["½ cup dal", "0.5 cup dal: about 6 portions."],
    ["0.5 cup dal", "½ cup dal: about 6 portions."],
    ["1,5 kg goat", "1.5 kg goat: about 6 portions."],
    ["1.5 kg goat", "1,5 kg goat: about 6 portions."],
    ["1⁄2 cup dal", "1/2 cup dal: about 6 portions."],
    ["1/2 cup dal", "1⁄2 cup dal: about 6 portions."],
  ])("source %j, basis %j: accepted, no re-ask", async (source, basis) => {
    const { chat, calls } = provider(json({ basis, serves: 6 }));
    const result = await estimateServes(
      { name: "Curry", ingredients: [], steps: ["Cook."], sourceText: source, hasAmounts: true },
      { chat },
    );
    expect(result).toMatchObject({ ok: true, estimate: { count: 6, basis } });
    expect(calls).toHaveLength(1);
  });

  it("a basis may cite the recipe's numbers as written, and its own count", async () => {
    const torta = {
      name: "onion torta",
      ingredients: [{ item: "flour", amount: "⅔", unit: "cup" }],
      steps: ["Slice into 4-6 wedges, plate 2 slices as first course."],
      hasAmounts: true,
    };
    const { chat } = provider(json({ basis: "Slice into 4-6 wedges, plate 2 slices: 3 first courses; ¾ is not cited.", serves: 3 }));
    const refused = await estimateServes(torta, { chat });
    expect(!refused.ok && refused.reason).toMatch(/cites ¾/);
    const ok = provider(json({ basis: "Slice into 4-6 wedges, plate 2 slices as first course: about 3 servings.", serves: 3 }));
    expect(await estimateServes(torta, { chat: ok.chat })).toMatchObject({ ok: true, estimate: { count: 3 } });
  });
});

describe("the re-ask after a basis rule is broken", () => {
  it("asks once more with the reply and the rule named, and takes a corrected reply", async () => {
    const replies = [
      json({ basis: "1 cup red lentils makes about 2.5 cups of dal: 3 bowls.", serves: 3 }),
      { ...json({ basis: "1 cup red lentils: about 3 bowls.", serves: 3 }), usage: { inputTokens: 5, outputTokens: 1 } },
    ];
    const { chat, calls } = provider(async () => ({ finishReason: "stop" as const, ...replies.shift()!, usage: { inputTokens: 10, outputTokens: 2 } }));
    const result = await estimateServes(DAL, { chat });
    expect(result).toEqual({
      ok: true,
      estimate: { count: 3, basis: "1 cup red lentils: about 3 bowls." },
      usage: { inputTokens: 20, outputTokens: 4 },
    });
    expect(calls).toHaveLength(2);
    const second = calls[1]!.messages;
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({ role: "assistant", content: JSON.stringify({ basis: "1 cup red lentils makes about 2.5 cups of dal: 3 bowls.", serves: 3 }) });
    expect(second[2]!.content).toBe(
      servesCorrectionPrompt("the basis cites 2.5, which the recipe doesn't state: 1 cup red lentils makes about 2.5 cups of dal: 3 bowls."),
    );
    expect(second[2]!.content).toMatch(/^The app rejected that reply: the basis cites 2\.5/);
    // Both calls share the one deadline.
    expect(calls[1]!.signal).toBe(calls[0]!.signal);
  });

  it("asks once for each basis rule: the prefix, a source text that wasn't sent", async () => {
    for (const [input, basis] of [
      [{ ...DAL, hasAmounts: false }, "About 2 sandwiches."],
      [{ ...DAL, hasAmounts: false, sourceText: null }, `${FROM_SOURCE_TEXT} udon: 1 bowl.`],
    ] as const) {
      const { chat, calls } = provider(json({ basis, serves: 2 }));
      const result = await estimateServes(input, { chat });
      expect(!result.ok && result.reason).toMatch(/^after a re-ask, /);
      expect(calls).toHaveLength(2);
    }
  });

  it("never re-asks for a reply that isn't a basis-rule break (a count out of range, no count)", async () => {
    for (const reply of [json({ basis: "b", serves: 49 }), json({ basis: "Not a recipe.", serves: null })]) {
      const { chat, calls } = provider(reply);
      const result = await estimateServes(DAL, { chat });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).not.toMatch(/re-ask/);
      expect(calls).toHaveLength(1);
    }
  });
});

describe("queueSourceText", () => {
  it("is the source field only when it holds words, not a URL or a marker", () => {
    expect(queueSourceText({ source: "Ingredients: udon, 3 tbsp soy sauce. Steps: cook." })).toBe(
      "Ingredients: udon, 3 tbsp soy sauce. Steps: cook.",
    );
    for (const source of ["https://example.com/udon", "pasted", "library", "  ", undefined, 4]) {
      expect(queueSourceText({ source })).toBeNull();
    }
    expect(queueSourceText(null)).toBeNull();
  });
});
