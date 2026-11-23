/**
 * Recipe Import Tests (F3)
 *
 * TDD tests for importing recipes from URLs or pasted text.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  extractRecipeFromUrl as rawExtractRecipeFromUrl,
  extractRecipeFromText as rawExtractRecipeFromText,
  extractRecipeFromImage as rawExtractRecipeFromImage,
  parseImportedRecipe,
  validateImportedRecipe,
  isValidRecipeUrl,
  extractJsonLdRecipe,
  stripHtmlForExtraction,
  MalformedReplyError,
  TransientModelError,
  isTransientModelError,
  type ExtractOptions,
} from "./recipe-import";
import { scriptMeter } from "./ai/meter";
import { MissingApiKeyError } from "./ai/types";
import { recipeTimeLine, timeLineText } from "./kitchen/time-line";

// =============================================================================
// Mock Setup
// =============================================================================

// Mock the AI module
vi.mock("./ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai")>()),
  chat: vi.fn(),
  vision: vi.fn(),
}));

const TEST_METER = scriptMeter("recipe-import-test");
const extractRecipeFromUrl = (url: string) =>
  rawExtractRecipeFromUrl(url, TEST_METER);
const extractRecipeFromText = (
  text: string,
  options: Omit<ExtractOptions, "meter"> = {},
) => rawExtractRecipeFromText(text, { ...options, meter: TEST_METER });
const extractRecipeFromImage = (imageBase64: string) =>
  rawExtractRecipeFromImage(imageBase64, TEST_METER);

// Mock fetch for URL fetching
const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = originalFetch;
});

// =============================================================================
// URL Validation Tests
// =============================================================================

describe("isValidRecipeUrl", () => {
  it("returns true for valid HTTP URLs", () => {
    expect(isValidRecipeUrl("http://example.com/recipe")).toBe(true);
  });

  it("returns true for valid HTTPS URLs", () => {
    expect(
      isValidRecipeUrl("https://nytimes.com/recipes/mushroom-risotto"),
    ).toBe(true);
  });

  it("returns false for non-URL strings", () => {
    expect(isValidRecipeUrl("not a url")).toBe(false);
    expect(isValidRecipeUrl("")).toBe(false);
    expect(isValidRecipeUrl("ftp://files.com")).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(isValidRecipeUrl("http://")).toBe(false);
    expect(isValidRecipeUrl("https://")).toBe(false);
  });
});

// =============================================================================
// parseImportedRecipe Tests
// =============================================================================

describe("parseImportedRecipe", () => {
  it("parses valid JSON recipe response", () => {
    const json = JSON.stringify({
      name: "Pasta Carbonara",
      ingredients: [
        { item: "spaghetti", amount: "400", unit: "g" },
        { item: "pancetta", amount: "200", unit: "g" },
      ],
      steps: ["Boil pasta", "Fry pancetta", "Combine"],
      estimatedTime: { active: 20, passive: 10, total: 30 },
      serves: 4,
      tags: ["italian", "pasta"],
      notes: "Use guanciale for authentic flavor",
    });

    const result = parseImportedRecipe(json);

    expect(result).toEqual({
      name: "Pasta Carbonara",
      ingredients: [
        { item: "spaghetti", amount: "400", unit: "g" },
        { item: "pancetta", amount: "200", unit: "g" },
      ],
      steps: ["Boil pasta", "Fry pancetta", "Combine"],
      estimatedTime: { active: 20, passive: 10, total: 30 },
      serves: 4,
      tags: ["italian", "pasta"],
      notes: "Use guanciale for authentic flavor",
    });
  });

  it("handles JSON wrapped in markdown code blocks", () => {
    const response =
      '```json\n{"name": "Test Recipe", "ingredients": [], "steps": []}\n```';

    const result = parseImportedRecipe(response);

    expect(result?.name).toBe("Test Recipe");
  });

  it("throws a malformed-reply error for a reply that isn't JSON", () => {
    expect(() => parseImportedRecipe("not json")).toThrow(MalformedReplyError);
    expect(() => parseImportedRecipe("{broken:")).toThrow(MalformedReplyError);
  });

  it("drops closing brackets the model doubled after a complete recipe", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Gemini's slip on long recipes: the object closes, then one more `}`.
    expect(
      parseImportedRecipe('{"name": "Dal", "steps": ["Simmer"]}\n}'),
    ).toMatchObject({ name: "Dal", steps: ["Simmer"] });
    expect(
      parseImportedRecipe('{"name": "Dal", "steps": ["Simmer"]}\n]\n}'),
    ).toMatchObject({ name: "Dal", steps: ["Simmer"] });
    expect(
      parseImportedRecipe('```json\n{"name": "Dal"}\n}\n```'),
    ).toMatchObject({ name: "Dal" });
    expect(parseImportedRecipe('[{"name": "Dal"}]\n]')).toMatchObject({
      name: "Dal",
    });
    // The repair is logged, with what it dropped, so the slip stays visible.
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[1][0]).toContain('"\\n]\\n}"');
    warn.mockRestore();
  });

  it("isn't fooled by brackets and quotes inside strings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reply =
      '{"name": "Dal } ]", "notes": "a \\"}\\" rich \\\\", "steps": ["Stir ]"]}\n}';
    expect(parseImportedRecipe(reply)).toMatchObject({
      name: "Dal } ]",
      notes: 'a "}" rich \\',
      steps: ["Stir ]"],
    });
    warn.mockRestore();
  });

  it("throws a malformed-reply error when the JSON before the closers is broken", () => {
    expect(() => parseImportedRecipe('{"name": "Dal",}\n}')).toThrow(
      MalformedReplyError,
    );
  });

  it("throws a malformed-reply error for anything else after a recipe", () => {
    for (const reply of [
      '{"name": "Dal"}\nEnjoy!',
      '{"name": "Dal"}\n{"name": "Soup"}',
      '{"name": "Dal"}\n}\n,',
      'Here it is: {"name": "Dal"}\n}',
      '{"name": "Dal", "steps": ["Simmer"\n}',
    ]) {
      expect(() => parseImportedRecipe(reply)).toThrow(MalformedReplyError);
    }
  });

  it("reports the reply's own parse error when it can't be repaired", () => {
    expect(() => parseImportedRecipe('{"name": "Dal"}\nEnjoy!')).toThrow(
      /^not JSON \(.*position 16/,
    );
  });

  it("throws a malformed-reply error for a recipe without a name", () => {
    const json = JSON.stringify({
      ingredients: [{ item: "flour" }],
      steps: ["Mix"],
    });

    expect(() => parseImportedRecipe(json)).toThrow(MalformedReplyError);
    expect(() => parseImportedRecipe('{"name": "  "}')).toThrow(
      MalformedReplyError,
    );
  });

  it("throws a malformed-reply error for a reply that isn't an object", () => {
    expect(() => parseImportedRecipe("null")).toThrow(MalformedReplyError);
    expect(() => parseImportedRecipe('"Dal"')).toThrow(MalformedReplyError);
    expect(() => parseImportedRecipe("[]")).toThrow(MalformedReplyError);
    expect(() => parseImportedRecipe('[{"name": "Dal"}, 3]')).toThrow(
      MalformedReplyError,
    );
  });

  it("returns null when the model found no recipe", () => {
    expect(parseImportedRecipe('{"error": "no recipe found"}')).toBeNull();
  });

  it("takes the recipe out of a one-item array", () => {
    const reply = JSON.stringify([{ name: "Dal", steps: ["Simmer"] }]);
    expect(parseImportedRecipe(reply)).toMatchObject({
      name: "Dal",
      steps: ["Simmer"],
    });
  });

  it("fails, without a retry, when the source holds several recipes", () => {
    const reply = JSON.stringify([
      { name: "Mole chili", steps: ["Simmer"] },
      { name: "White chili", steps: ["Simmer"] },
    ]);

    let thrown: unknown;
    try {
      parseImportedRecipe(reply);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(MalformedReplyError);
    expect((thrown as Error).message).toBe(
      "The source holds 2 recipes (Mole chili, White chili); an import " +
        "takes one at a time, so split them up.",
    );
  });

  it("handles partial recipe data with defaults", () => {
    const json = JSON.stringify({
      name: "Simple Recipe",
    });

    const result = parseImportedRecipe(json);

    expect(result).toEqual({
      name: "Simple Recipe",
      ingredients: undefined,
      steps: undefined,
      estimatedTime: undefined,
      serves: undefined,
      tags: undefined,
      notes: undefined,
    });
  });

  it("passes through stepIngredients verbatim (no sanitation at this layer)", () => {
    // parseImportedRecipe is a pure passthrough; bounds/length checks happen
    // later in validateImportedRecipe. So even a malformed mapping survives here.
    const json = JSON.stringify({
      name: "Mapped Recipe",
      ingredients: [{ item: "flour" }, { item: "sugar" }],
      steps: ["Combine flour and sugar"],
      stepIngredients: [[0, 1]],
    });

    const result = parseImportedRecipe(json);

    expect(result?.stepIngredients).toEqual([[0, 1]]);
  });

  it("leaves stepIngredients undefined when the response omits it", () => {
    const json = JSON.stringify({
      name: "Unmapped Recipe",
      ingredients: [{ item: "flour" }],
      steps: ["Use the flour"],
    });

    expect(parseImportedRecipe(json)?.stepIngredients).toBeUndefined();
  });
});

// =============================================================================
// extractJsonLdRecipe Tests
// =============================================================================

describe("extractJsonLdRecipe", () => {
  it("extracts recipe from top-level JSON-LD", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {
        "@type": "Recipe",
        "name": "Chocolate Chip Cookies",
        "recipeIngredient": ["2 cups flour", "1 cup butter", "1 cup chocolate chips"],
        "recipeInstructions": [
          {"@type": "HowToStep", "text": "Preheat oven to 350F"},
          {"@type": "HowToStep", "text": "Mix dry ingredients"},
          {"@type": "HowToStep", "text": "Bake for 12 minutes"}
        ],
        "totalTime": "PT45M",
        "prepTime": "PT15M",
        "cookTime": "PT12M",
        "recipeYield": "24 cookies",
        "recipeCategory": "Dessert",
        "recipeCuisine": "American",
        "description": "Classic chocolate chip cookies"
      }
      </script>
      </head><body></body></html>
    `;

    const result = extractJsonLdRecipe(html);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Chocolate Chip Cookies");
    expect(result!.ingredients).toHaveLength(3);
    expect(result!.ingredients![0]).toEqual({
      item: "flour",
      amount: "2",
      unit: "cups",
    });
    expect(result!.steps).toEqual([
      "Preheat oven to 350F",
      "Mix dry ingredients",
      "Bake for 12 minutes",
    ]);
    expect(result!.estimatedTime).toEqual({
      active: 15,
      passive: 12,
      total: 45,
    });
    expect(result!.serves).toBe(24);
    expect(result!.tags).toContain("Dessert");
    expect(result!.tags).toContain("American");
    expect(result!.notes).toBe("Classic chocolate chip cookies");
  });

  it("extracts recipe from @graph array (WordPress/Yoast)", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {
        "@graph": [
          {"@type": "WebPage", "name": "Some Page"},
          {
            "@type": "Recipe",
            "name": "Bolognese Sauce",
            "recipeIngredient": ["ground beef", "tomatoes"],
            "recipeInstructions": ["Brown the beef", "Add tomatoes", "Simmer 2 hours"]
          }
        ]
      }
      </script>
      </head><body></body></html>
    `;

    const result = extractJsonLdRecipe(html);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Bolognese Sauce");
    expect(result!.ingredients).toHaveLength(2);
    expect(result!.steps).toEqual([
      "Brown the beef",
      "Add tomatoes",
      "Simmer 2 hours",
    ]);
  });

  it("returns null when no JSON-LD present", () => {
    const html = "<html><body><h1>No structured data</h1></body></html>";
    expect(extractJsonLdRecipe(html)).toBeNull();
  });

  it("returns null when JSON-LD has no Recipe type", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {"@type": "Article", "name": "Food Blog Post"}
      </script>
      </head><body></body></html>
    `;
    expect(extractJsonLdRecipe(html)).toBeNull();
  });

  it("handles string-only recipe instructions", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {
        "@type": "Recipe",
        "name": "Quick Pasta",
        "recipeInstructions": ["Boil water", "Cook pasta", "Add sauce"]
      }
      </script>
      </head><body></body></html>
    `;

    const result = extractJsonLdRecipe(html);
    expect(result!.steps).toEqual(["Boil water", "Cook pasta", "Add sauce"]);
  });

  it("handles numeric recipeYield", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {"@type": "Recipe", "name": "Test", "recipeYield": 6}
      </script>
      </head><body></body></html>
    `;
    const result = extractJsonLdRecipe(html);
    expect(result!.serves).toBe(6);
  });

  it("handles array recipeYield", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {"@type": "Recipe", "name": "Test", "recipeYield": ["4 servings", "4"]}
      </script>
      </head><body></body></html>
    `;
    const result = extractJsonLdRecipe(html);
    expect(result!.serves).toBe(4);
  });

  it("extracts keywords as tags", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {"@type": "Recipe", "name": "Test", "keywords": "healthy, quick, vegan"}
      </script>
      </head><body></body></html>
    `;
    const result = extractJsonLdRecipe(html);
    expect(result!.tags).toContain("healthy");
    expect(result!.tags).toContain("quick");
    expect(result!.tags).toContain("vegan");
  });

  it("handles malformed JSON-LD gracefully", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">{broken json here</script>
      <script type="application/ld+json">
      {"@type": "Recipe", "name": "Good Recipe"}
      </script>
      </head><body></body></html>
    `;
    const result = extractJsonLdRecipe(html);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Good Recipe");
  });

  it("parses ISO durations correctly", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {"@type": "Recipe", "name": "Test", "totalTime": "PT1H30M", "prepTime": "PT20M", "cookTime": "PT1H10M"}
      </script>
      </head><body></body></html>
    `;
    const result = extractJsonLdRecipe(html);
    expect(result!.estimatedTime).toEqual({
      active: 20,
      passive: 70,
      total: 90,
    });
  });

  // T follow-up, verifier MED on DECISIONS call 3: one part of the time is
  // not the total, so the import makes none from it, and the line then says
  // only what the page said.
  it("stores a total only when the page states one, or both prep and cook", () => {
    const page = (times: string) => `
      <html><head>
      <script type="application/ld+json">
      {"@type": "Recipe", "name": "Test", ${times}}
      </script>
      </head><body></body></html>
    `;
    const prepOnly = extractJsonLdRecipe(page(`"prepTime": "PT30M"`))!.estimatedTime;
    expect(prepOnly?.active).toBe(30);
    expect(prepOnly?.total).toBeUndefined();
    // The line binds a number to its unit with a no-break space.
    expect(timeLineText(recipeTimeLine(null, prepOnly)!).replace(/ /g, " ")).toBe(
      "Recipe says 30 min hands-on",
    );

    const cookOnly = extractJsonLdRecipe(page(`"cookTime": "PT40M"`))!.estimatedTime;
    expect(cookOnly?.passive).toBe(40);
    expect(cookOnly?.total).toBeUndefined();
    expect(recipeTimeLine(null, cookOnly)).toBeNull();

    expect(extractJsonLdRecipe(page(`"prepTime": "PT10M", "cookTime": "PT25M"`))!.estimatedTime).toEqual({
      active: 10,
      passive: 25,
      total: 35,
    });
    expect(extractJsonLdRecipe(page(`"totalTime": "PT1H"`))!.estimatedTime?.total).toBe(60);
  });

  it("parses ingredients without amounts", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {"@type": "Recipe", "name": "Test", "recipeIngredient": ["salt to taste", "fresh herbs"]}
      </script>
      </head><body></body></html>
    `;
    const result = extractJsonLdRecipe(html);
    expect(result!.ingredients).toEqual([
      { item: "salt to taste" },
      { item: "fresh herbs" },
    ]);
  });

  // B4 fix round 1, HIGH 1: the split reads a line's leading amount with the
  // pack's reader, the one the converter uses. The old regex backtracked into
  // the number ("10 eggs" stored as amount "1", unit "0") and gave up on
  // "1 1/2 cups flour" (stored whole as the item).
  const ldPage = (ingredients: string[], steps: string[] = ["Cook."]) => `
      <html><head>
      <script type="application/ld+json">
      ${JSON.stringify({ "@type": "Recipe", name: "Test", recipeIngredient: ingredients, recipeInstructions: steps })}
      </script>
      </head><body></body></html>
    `;

  it.each([
    ["10 eggs", { item: "eggs", amount: "10" }],
    ["10 eggs, beaten", { item: "eggs, beaten", amount: "10" }],
    ["1/2 lemon", { item: "lemon", amount: "1/2" }],
    ["12 (14 oz) cans tomatoes", { item: "(14 oz) cans tomatoes", amount: "12" }],
    ["1 1/2 cups flour", { item: "flour", amount: "1 1/2", unit: "cups" }],
    ["1 cup (225 g) butter", { item: "butter", amount: "1", unit: "cup (225 g)" }],
    ["3 cloves garlic, minced", { item: "garlic, minced", amount: "3", unit: "cloves" }],
    // A size word is a count noun (B4 step 0, spelling call 2): stored as the
    // unit, and the cook page folds it back into "large eggs".
    ["2 large eggs", { item: "eggs", amount: "2", unit: "large" }],
    ["2-3 tbsp oil", { item: "oil", amount: "2-3", unit: "tbsp" }],
    ["1 15 oz can beans", { item: "15 oz can beans", amount: "1" }],
    ["00 flour", { item: "00 flour" }],
    ["salt to taste", { item: "salt to taste" }],
    // B4 fix round 2: a parenthetical the reader can't read stays in the item,
    // so the unit before it keeps its number; one it can read stays with it,
    // a stick of butter included (call 8).
    ["1/2 cup (1 stick) butter", { item: "butter", amount: "1/2", unit: "cup (1 stick)" }],
    [
      "3 cups (about 1 lb) potatoes",
      { item: "(about 1 lb) potatoes", amount: "3", unit: "cups" },
    ],
    ["1 cup (8 oz) cream cheese", { item: "cream cheese", amount: "1", unit: "cup (8 oz)" }],
    ["1 can (14 oz) tomatoes", { item: "tomatoes", amount: "1", unit: "can (14 oz)" }],
    ["1 (14 oz) can tomatoes", { item: "(14 oz) can tomatoes", amount: "1" }],
    // A line that is only an amount has no item to split off: stored whole.
    ["3 cloves", { item: "3 cloves" }],
    ["2 g", { item: "2 g" }],
  ])("splits %j at the amount the source wrote", (line, stored) => {
    expect(extractJsonLdRecipe(ldPage([line]))!.ingredients).toEqual([stored]);
  });

  it("drops a blank ingredient line or step, keeping the order of the rest", () => {
    const result = extractJsonLdRecipe(
      ldPage(["2 eggs", "", "   ", "salt"], ["Whisk.", "", "  ", "Cook."]),
    )!;
    expect(result.ingredients).toEqual([{ item: "eggs", amount: "2" }, { item: "salt" }]);
    expect(result.steps).toEqual(["Whisk.", "Cook."]);
  });
});

// =============================================================================
// stripHtmlForExtraction Tests
// =============================================================================

describe("stripHtmlForExtraction", () => {
  it("removes script and style tags", () => {
    const html =
      '<p>Recipe</p><script>alert("hi")</script><style>.red{color:red}</style><p>Ingredients</p>';
    const result = stripHtmlForExtraction(html);
    expect(result).toContain("Recipe");
    expect(result).toContain("Ingredients");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("color:red");
  });

  it("removes nav, footer, header elements", () => {
    const html =
      "<nav>Home About</nav><main><p>Recipe Content</p></main><footer>Copyright 2024</footer>";
    const result = stripHtmlForExtraction(html);
    expect(result).toContain("Recipe Content");
    expect(result).not.toContain("Home About");
    expect(result).not.toContain("Copyright");
  });

  it("decodes HTML entities", () => {
    const html = "<p>Mac &amp; Cheese &mdash; a classic</p>";
    const result = stripHtmlForExtraction(html);
    expect(result).toContain("Mac & Cheese");
  });

  it("collapses whitespace", () => {
    const html = "<p>Step  1</p>   <p>Step   2</p>";
    const result = stripHtmlForExtraction(html);
    expect(result).not.toContain("  ");
  });

  it("truncates overly long content", () => {
    const html = "<p>" + "a".repeat(100_000) + "</p>";
    const result = stripHtmlForExtraction(html);
    expect(result.length).toBeLessThanOrEqual(50_000);
  });

  it("returns empty string for empty HTML", () => {
    expect(stripHtmlForExtraction("")).toBe("");
  });
});

// =============================================================================
// extractRecipeFromText Tests
// =============================================================================

describe("isTransientModelError", () => {
  const status = (n: number) => Object.assign(new Error(`status ${n}`), { status: n });

  it("calls a timeout, a rate limit, a provider failure or a dropped connection transient", () => {
    for (const error of [
      status(408),
      status(429),
      status(500),
      status(503),
      new DOMException("The operation was aborted.", "AbortError"),
      new TypeError("fetch failed"),
      Object.assign(new Error("socket"), { cause: { code: "ECONNRESET" } }),
      Object.assign(new Error("Connection error."), { name: "APIConnectionError" }),
    ]) {
      expect(isTransientModelError(error), error.message).toBe(true);
    }
  });

  it("calls a missing or refused key transient: a config fault, which config fixes, not the recipe's", () => {
    for (const error of [
      new MissingApiKeyError("GOOGLE_AI_API_KEY required when using google provider"),
      status(401),
      status(403),
    ]) {
      expect(isTransientModelError(error), error.message).toBe(true);
    }
  });

  it("calls a refused request or an unexplained error settled", () => {
    for (const error of [
      new Error("GOOGLE_AI_API_KEY required when using google provider"),
      status(400),
      status(404),
      new Error("something odd"),
    ]) {
      expect(isTransientModelError(error), error.message).toBe(false);
    }
    expect(isTransientModelError("a string")).toBe(false);
  });

  it("is what the text extraction throws for a transient failure, and only then", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(status(503));
    await expect(extractRecipeFromText("Toast\n1 slice bread\nToast it.")).rejects.toBeInstanceOf(TransientModelError);
    (chat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(status(400));
    await expect(extractRecipeFromText("Toast\n1 slice bread\nToast it.")).rejects.not.toBeInstanceOf(TransientModelError);
  });
});

describe("extractRecipeFromText", () => {
  it("extracts recipe from pasted text using AI", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({
        name: "Extracted Recipe",
        ingredients: [{ item: "flour", amount: "2", unit: "cups" }],
        steps: ["Mix ingredients", "Bake at 350F"],
        serves: 4,
      }),
    });

    const result = await extractRecipeFromText(
      "Cookies\nServes 4\n2 cups flour\nMix ingredients, then bake at 350F.",
    );

    expect(result).toEqual({
      recipe: {
        name: "Extracted Recipe",
        ingredients: [{ item: "flour", amount: "2", unit: "cups" }],
        steps: ["Mix ingredients", "Bake at 350F"],
        serves: 4,
        estimatedTime: undefined,
        tags: undefined,
        notes: undefined,
      },
      notices: [],
    });
    expect(chat).toHaveBeenCalled();
  });

  it("passes responseFormat json and disables thinking to free the token budget", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({ name: "Test", steps: ["Do the thing"] }),
    });

    await extractRecipeFromText("Test\nDo the thing");

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: "json",
        thinkingBudget: 0,
        maxTokens: expect.any(Number),
      }),
      TEST_METER,
    );
  });

  it("asks again when the reply isn't recipe JSON", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        content: '{"name": "Dal", "steps": ["Simmer the dal"]}\nEnjoy!',
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content: '{"name": "Dal", "steps": ["Simmer the dal"]}',
        finishReason: "stop",
      });

    const result = await extractRecipeFromText("Dal\nSimmer the dal");

    expect(result?.recipe.steps).toEqual(["Simmer the dal"]);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("takes a reply with a doubled closing brace without asking again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: '{"name": "Dal", "steps": ["Simmer the dal"]}\n}',
      finishReason: "stop",
    });

    const result = await extractRecipeFromText("Dal\nSimmer the dal");

    expect(result?.recipe.steps).toEqual(["Simmer the dal"]);
    expect(chat).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("fails when the reply isn't recipe JSON twice", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: "I couldn't find a recipe in that text.",
      finishReason: "stop",
    });

    await expect(
      extractRecipeFromText("Random text without recipe"),
    ).rejects.toThrow(
      "The model's reply wasn't valid recipe JSON, even after a retry",
    );
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("asks again when the reply's recipe fails validation", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        content: JSON.stringify({ name: "Dal", steps: "Simmer the dal" }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ name: "Dal", steps: ["Simmer the dal"] }),
      });

    const result = await extractRecipeFromText("Dal\nSimmer the dal");

    expect(result?.recipe.steps).toEqual(["Simmer the dal"]);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("fails at once, without asking again, when the source holds two recipes", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify([
        { name: "Mole chili", steps: ["Simmer"] },
        { name: "White chili", steps: ["Simmer"] },
      ]),
    });

    await expect(
      extractRecipeFromText("Mole chili\nSimmer\nWhite chili\nSimmer"),
    ).rejects.toThrow("The source holds 2 recipes");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("returns null when AI returns error JSON", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({ error: "no recipe found" }),
    });

    const result = await extractRecipeFromText("Random text without recipe");

    expect(result).toBeNull();
  });

  it("throws error when AI call fails", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("API error"),
    );

    await expect(extractRecipeFromText("Some recipe text")).rejects.toThrow(
      "API error",
    );
  });

  it("handles empty input", async () => {
    const { chat } = await import("./ai");

    const result = await extractRecipeFromText("");

    expect(result).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it("handles whitespace-only input", async () => {
    const { chat } = await import("./ai");

    const result = await extractRecipeFromText("   \n\t  ");

    expect(result).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it("reports each call's tokens with its bound, a thrown call as none", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ content: "not json", finishReason: "stop", usage: { inputTokens: 900, outputTokens: 40 } })
      .mockRejectedValueOnce(new Error("503 overloaded"));
    const usage: { inputTokens: number; outputTokens: number; bound: { outputTokens: number } }[] = [];

    await expect(
      extractRecipeFromText("Dal\nSimmer the dal", { onUsage: (u) => usage.push(u) }),
    ).rejects.toThrow("503 overloaded");

    expect(usage.map(({ inputTokens, outputTokens, bound }) => [inputTokens, outputTokens, bound.outputTokens])).toEqual([
      [900, 40, 8192],
      [0, 0, 16_384],
    ]);
  });

  it("sends a correction after the text, and the signal with the call", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({ name: "Dal", steps: ["Simmer the dal"] }),
      finishReason: "stop",
    });
    const signal = new AbortController().signal;

    await extractRecipeFromText("Dal\nSimmer the dal", { correction: "step 2 dropped the 5 min", signal });

    const sent = (chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const prompt: string = sent.messages[0].content;
    expect(prompt.indexOf("Simmer the dal")).toBeLessThan(prompt.indexOf("step 2 dropped the 5 min"));
    expect(prompt).toMatch(/turned down: step 2 dropped the 5 min\nExtract it again/);
    expect(sent.signal).toBe(signal);
  });

  it("makes no call once its signal has fired", async () => {
    const { chat } = await import("./ai");
    const deadline = new AbortController();
    deadline.abort();

    await expect(
      extractRecipeFromText("Dal\nSimmer the dal", { signal: deadline.signal }),
    ).rejects.toThrow();
    expect(chat).not.toHaveBeenCalled();
  });
});

// The checks themselves are tested in recipe-grounding.test.ts; these show the
// text path runs them on the text it was given.
describe("extractRecipeFromText — parts the source doesn't give", () => {
  // Synthetic fixture: ingredients and serving count only, no method.
  const INGREDIENTS_ONLY = [
    "spiced iced tea",
    "2 servings",
    "⅓  cup warm water",
    "3.5 tsp of black tea",
    "10 mint leaves (1 handful)",
    "1 tbsp of lemon juice",
    "2.5 tbsp of honey",
    "⅜  tsp ground ginger",
  ].join("\n");
  const INGREDIENTS = [
    { item: "warm water", amount: "1/3", unit: "cup" },
    { item: "black tea", amount: "3.5", unit: "tsp" },
    { item: "mint leaves", amount: "10" },
    { item: "lemon juice", amount: "1", unit: "tbsp" },
    { item: "honey", amount: "2.5", unit: "tbsp" },
    { item: "ground ginger", amount: "3/8", unit: "tsp" },
  ];

  async function mockExtraction(recipe: object) {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify(recipe),
    });
  }

  it("keeps the ingredients, drops steps the model wrote itself and says so", async () => {
    // What the model returned despite the prompt's rules.
    await mockExtraction({
      name: "Spiced Iced Tea",
      ingredients: INGREDIENTS,
      steps: [
        "Steep the black tea in the warm water.",
        "Place the steeped tea, mint leaves, lemon juice, honey, and ground ginger into a pitcher.",
        "Shake with ice until chilled and frothy.",
        "Pour into glasses and serve.",
      ],
      stepIngredients: [[0, 1], [2, 3, 4, 5], [], []],
      estimatedTime: { active: 5, passive: 0, total: 5 },
      serves: 2,
    });

    const result = await extractRecipeFromText(INGREDIENTS_ONLY);

    expect(result?.recipe.ingredients).toHaveLength(6);
    expect(result?.recipe.steps).toEqual([]);
    expect(result?.recipe.stepIngredients).toBeUndefined();
    expect(result?.recipe.estimatedTime).toBeUndefined();
    expect(result?.recipe.serves).toBe(2);
    expect(result?.notices).toEqual([
      {
        kind: "method-dropped",
        message: "Left out 4 steps that aren't in the source.",
      },
    ]);
  });

  it("keeps a method reworded from the source", async () => {
    // Abbreviations spelled out, accents added, verbs in other forms.
    await mockExtraction({
      name: "Spiced Butter",
      ingredients: [
        { item: "cumin seeds", amount: "1/2", unit: "tsp" },
        { item: "coriander seeds", amount: "1", unit: "tsp" },
        { item: "thyme sprigs" },
      ],
      steps: [
        "Sauté the cumin seeds in butter",
        "When the butter foams, add the coriander seeds",
        "When the coriander changes color, after 10-20 seconds, add the thyme sprigs",
        "Sauté until fragrant, then spoon over the soup",
      ],
    });

    const result = await extractRecipeFromText(
      [
        "½ tsp cumin seeds",
        "1 tsp coriander seeds",
        "Thyme sprigs",
        "Saute cumin seeds in butter. When butter foams, add in coriander seeds.",
        "When coriander color changes (10-20 sec), add in thyme sprigs, and saute til fragrant, then spoon over the soup",
      ].join("\n"),
    );

    expect(result?.recipe.steps).toHaveLength(4);
    expect(result?.notices).toEqual([]);
  });

  it("drops a serving count the text doesn't state", async () => {
    await mockExtraction({
      name: "Chili",
      ingredients: [{ item: "beef" }, { item: "beans" }],
      steps: ["Brown the beef", "Add the beans and simmer"],
      serves: 6,
    });

    const result = await extractRecipeFromText(
      "Chili\n1 lb beef\n1 can beans\nBrown beef, add beans, simmer.",
    );

    expect(result?.recipe.serves).toBeUndefined();
  });

  it("fails when a made-up method is all it found", async () => {
    await mockExtraction({
      name: "Spiced Iced Tea",
      steps: [
        "Steep the black tea in the warm water.",
        "Shake with ice until chilled and frothy.",
        "Pour into glasses and serve.",
      ],
    });

    await expect(
      extractRecipeFromText("spiced iced tea\n5 stars"),
    ).rejects.toThrow("The steps the model returned aren't in the source");
  });

  it("fails when the model translated the recipe", async () => {
    await mockExtraction({
      name: "Shakshuka",
      ingredients: [{ item: "eggs" }, { item: "tomatoes" }],
      steps: ["Fry the onion", "Add the tomatoes", "Crack in the eggs"],
    });

    await expect(
      extractRecipeFromText(
        "שקשוקה\n4 ביצים\nעגבניות\nלטגן בצל, להוסיף עגבניות, לשבור ביצים",
      ),
    ).rejects.toThrow(
      "Most of the ingredients the model returned aren't in the source",
    );
  });
});

// =============================================================================
// Verification / Hardening Tests
// =============================================================================

describe("validateImportedRecipe", () => {
  it("returns null when input is null (no recipe found)", () => {
    expect(validateImportedRecipe(null)).toBeNull();
  });

  it("throws when a recipe has a title but no ingredients or steps", () => {
    expect(() => validateImportedRecipe({ name: "Just a Title" })).toThrow(
      /no ingredients or steps/i,
    );
  });

  it("throws a malformed-reply error for a recipe the schema rejects", () => {
    const recipe = { name: "Dal", steps: "Simmer" as unknown as string[] };
    expect(() => validateImportedRecipe(recipe)).toThrow(MalformedReplyError);
    expect(() => validateImportedRecipe(recipe)).toThrow(
      "Extracted recipe failed validation: steps",
    );
  });

  it("accepts a recipe with steps but no ingredients", () => {
    const recipe = { name: "Toast", steps: ["Toast the bread"] };
    expect(validateImportedRecipe(recipe)).toMatchObject({ name: "Toast" });
  });

  it("tolerates null-valued optional fields (model emits null, not absent)", () => {
    const recipe = {
      name: "Null-ish Recipe",
      ingredients: [{ item: "egg", amount: null as unknown as string }],
      steps: ["Crack the egg"],
      tags: null as unknown as string[],
      serves: null as unknown as number,
      notes: null as unknown as string,
    };
    const result = validateImportedRecipe(recipe);
    expect(result).toMatchObject({ name: "Null-ish Recipe" });
    expect(result?.ingredients?.[0]).toEqual({
      item: "egg",
      amount: undefined,
      unit: undefined,
    });
    expect(result?.tags).toBeUndefined();
    expect(result?.serves).toBeUndefined();
  });

  it("normalizes numeric amounts to strings", () => {
    const recipe = {
      name: "Test",
      // amount as a number is a common model variation
      ingredients: [{ item: "flour", amount: 2 as unknown as string }],
      steps: ["Mix"],
    };
    const result = validateImportedRecipe(recipe);
    expect(result?.ingredients?.[0]).toEqual({ item: "flour", amount: "2" });
  });

  it("drops an unparseable serves string instead of failing the import", () => {
    // The model commonly returns "Serves 4-6" / "about 4" rather than a number.
    // A nice-to-have field must never sink the whole extraction.
    const recipe = {
      name: "Family Stew",
      ingredients: [{ item: "beans" }],
      steps: ["Simmer"],
      serves: "Serves 4-6" as unknown as number,
    };
    const result = validateImportedRecipe(recipe);
    expect(result?.name).toBe("Family Stew");
    expect(result?.serves).toBeUndefined();
  });

  it("parses a numeric-ish serves string to a number", () => {
    const recipe = {
      name: "Soup",
      ingredients: [{ item: "broth" }],
      steps: ["Heat"],
      serves: "4" as unknown as number,
    };
    expect(validateImportedRecipe(recipe)?.serves).toBe(4);
  });

  it("rounds a fractional serves, which the integer serves columns can't hold", () => {
    const recipe = {
      name: "Half Batch Stew",
      ingredients: [{ item: "beans" }],
      steps: ["Simmer"],
      serves: 2.5,
    };
    expect(validateImportedRecipe(recipe)?.serves).toBe(3);
  });

  it("splits a comma-separated tags string into an array", () => {
    const recipe = {
      name: "Quick Salad",
      ingredients: [{ item: "greens" }],
      steps: ["Toss"],
      tags: "healthy, quick" as unknown as string[],
    };
    expect(validateImportedRecipe(recipe)?.tags).toEqual(["healthy", "quick"]);
  });

  it("keeps a valid per-step ingredient mapping aligned to steps", () => {
    const recipe = {
      name: "Mapped Recipe",
      ingredients: [{ item: "flour" }, { item: "sugar" }, { item: "eggs" }],
      steps: ["Whisk the eggs", "Fold in flour and sugar", "Let rest"],
      stepIngredients: [[2], [0, 1], []],
    };
    expect(validateImportedRecipe(recipe)?.stepIngredients).toEqual([
      [2],
      [0, 1],
      [],
    ]);
  });

  it("leaves stepIngredients undefined when the model omits it (legacy/JSON-LD path)", () => {
    const recipe = {
      name: "Unmapped Recipe",
      ingredients: [{ item: "flour" }],
      steps: ["Use the flour"],
    };
    expect(validateImportedRecipe(recipe)?.stepIngredients).toBeUndefined();
  });

  it("discards a wrong-length stepIngredients mapping (truncation guard → regex fallback)", () => {
    // A truncated response can return fewer entries than there are steps. A
    // misaligned mapping is worse than none, so the whole thing is dropped and
    // the client falls back to fuzzy matching.
    const recipe = {
      name: "Truncated Mapping",
      ingredients: [{ item: "flour" }, { item: "sugar" }],
      steps: ["Mix flour", "Add sugar", "Bake"],
      stepIngredients: [[0], [1]] as number[][], // 2 entries, 3 steps
    };
    expect(validateImportedRecipe(recipe)?.stepIngredients).toBeUndefined();
  });

  it("filters out-of-bounds, negative, non-integer, and duplicate indices", () => {
    const recipe = {
      name: "Dirty Indices",
      ingredients: [{ item: "flour" }, { item: "sugar" }],
      // index 5 is out of bounds, -1 negative, 0.5 non-integer, 0 duplicated
      steps: ["Combine everything"],
      stepIngredients: [[0, 0, 1, 5, -1, 0.5]] as number[][],
    };
    expect(validateImportedRecipe(recipe)?.stepIngredients).toEqual([[0, 1]]);
  });

  it("keeps the mapping as the model gave it when the caller checks it itself (intake), bad indices and a wrong length included", () => {
    const recipe = {
      name: "Dirty Indices",
      ingredients: [{ item: "flour" }, { item: "sugar" }],
      steps: ["Combine everything", "Bake"],
      stepIngredients: [[0, 5, "1"], [-1]] as unknown as number[][],
    };
    expect(validateImportedRecipe(recipe, { keepStepIngredients: true })?.stepIngredients).toEqual([[0, 5, 1], [-1]]);
    const short = { ...recipe, stepIngredients: [[0]] };
    expect(validateImportedRecipe(short, { keepStepIngredients: true })?.stepIngredients).toEqual([[0]]);
  });

  it("coerces numeric-string indices then sanitizes them", () => {
    // The model sometimes emits indices as strings ("0", "1"); the index schema
    // normalizes them before bounds-checking.
    const recipe = {
      name: "Stringy Indices",
      ingredients: [{ item: "flour" }, { item: "sugar" }],
      steps: ["Combine"],
      stepIngredients: [["0", "1"]] as unknown as number[][],
    };
    expect(validateImportedRecipe(recipe)?.stepIngredients).toEqual([[0, 1]]);
  });

  it("drops a null index instead of coercing it to ingredient 0", () => {
    // Regression: z.coerce.number() silently turns null into 0, which then
    // passes the bounds check and falsely attaches the FIRST ingredient to the
    // step. The preprocess maps null → NaN so the integer filter drops it. The
    // surviving index 2 (not 0) proves no spurious ingredient was introduced.
    const recipe = {
      name: "Null Index",
      ingredients: [{ item: "flour" }, { item: "sugar" }, { item: "butter" }],
      steps: ["Cream the butter"],
      stepIngredients: [[null, 2]] as unknown as number[][],
    };
    const sanitized = validateImportedRecipe(recipe)?.stepIngredients;
    expect(sanitized).toEqual([[2]]);
    expect(sanitized?.[0]).not.toContain(0);
  });

  it("drops empty-string and non-numeric indices instead of coercing them to 0", () => {
    // Same hazard class as null: "" and garbage strings coerce to 0 under
    // z.coerce.number(). The preprocess routes them to NaN → filtered out.
    const recipe = {
      name: "Garbage Indices",
      ingredients: [{ item: "flour" }, { item: "sugar" }, { item: "butter" }],
      steps: ["Cream the butter"],
      stepIngredients: [["", "abc", 2]] as unknown as number[][],
    };
    expect(validateImportedRecipe(recipe)?.stepIngredients).toEqual([[2]]);
  });
});

describe("extractRecipeFromText — per-step ingredient mapping", () => {
  it("passes a valid stepIngredients mapping through the full extraction path", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({
        name: "Mapped via AI",
        ingredients: [{ item: "flour" }, { item: "sugar" }],
        steps: ["Mix flour and sugar", "Bake"],
        stepIngredients: [[0, 1], []],
      }),
      finishReason: "stop",
    });

    const result = await extractRecipeFromText(
      "Shortbread\nflour\nsugar\nMix flour and sugar. Bake.",
    );

    expect(result?.recipe.stepIngredients).toEqual([[0, 1], []]);
  });

  it("drops a wrong-length mapping from the AI to undefined", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({
        name: "Misaligned via AI",
        ingredients: [{ item: "flour" }],
        steps: ["Mix", "Bake"],
        stepIngredients: [[0]], // 1 entry, 2 steps
      }),
      finishReason: "stop",
    });

    const result = await extractRecipeFromText("flour\nMix. Bake.");

    expect(result?.recipe.name).toBe("Misaligned via AI");
    expect(result?.recipe.steps).toEqual(["Mix", "Bake"]);
    expect(result?.recipe.stepIngredients).toBeUndefined();
  });
});

describe("extractRecipeFromText — truncation handling", () => {
  it("retries with a larger budget when the first call truncates", async () => {
    const { chat } = await import("./ai");
    const mock = chat as ReturnType<typeof vi.fn>;
    // First call truncates (thinking ate the budget), retry succeeds
    mock.mockResolvedValueOnce({
      content: '{ "name": "Tru',
      finishReason: "max_tokens",
    });
    mock.mockResolvedValueOnce({
      content: JSON.stringify({
        name: "Truncated Then Fixed",
        ingredients: [{ item: "salmon" }],
        steps: ["Sear it"],
      }),
      finishReason: "stop",
    });

    const result = await extractRecipeFromText("Salmon\nsalmon\nSear it");

    expect(mock).toHaveBeenCalledTimes(2);
    // retry used a larger token budget than the first attempt
    const firstBudget = mock.mock.calls[0][0].maxTokens;
    const retryBudget = mock.mock.calls[1][0].maxTokens;
    expect(retryBudget).toBeGreaterThan(firstBudget);
    expect(result?.recipe.name).toBe("Truncated Then Fixed");
  });

  it("throws a clear error when extraction truncates even after retry", async () => {
    const { chat } = await import("./ai");
    const mock = chat as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      content: "{ partial",
      finishReason: "max_tokens",
    });

    await expect(extractRecipeFromText("an enormous recipe")).rejects.toThrow(
      /too long to extract/i,
    );
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("asks again when the model declines, since its filters vary run to run", async () => {
    const { chat } = await import("./ai");
    const mock = chat as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ content: "", finishReason: "blocked" });
    mock.mockResolvedValueOnce({
      content: JSON.stringify({
        name: "Declined Then Read",
        ingredients: [{ item: "salmon" }],
        steps: ["Sear it"],
      }),
      finishReason: "stop",
    });

    const result = await extractRecipeFromText("Salmon\nsalmon\nSear it");

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result?.recipe.name).toBe("Declined Then Read");
  });

  it("throws when the model declines twice, rather than finding no recipe", async () => {
    const { chat } = await import("./ai");
    const mock = chat as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({ content: "", finishReason: "blocked" });

    await expect(extractRecipeFromText("a recipe")).rejects.toThrow(
      /declined to read this recipe \(blocked\), even after a retry/,
    );
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("throws when extraction yields only a title (degenerate result)", async () => {
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({ name: "Mystery Dish" }),
      finishReason: "stop",
    });

    await expect(extractRecipeFromText("ambiguous text")).rejects.toThrow(
      /no ingredients or steps/i,
    );
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// extractRecipeFromUrl Tests
// =============================================================================

describe("extractRecipeFromUrl", () => {
  it("extracts recipe from JSON-LD without AI call", async () => {
    const jsonLdHtml = `
      <html><head>
      <script type="application/ld+json">
      {
        "@type": "Recipe",
        "name": "JSON-LD Cookie Recipe",
        "recipeIngredient": ["2 cups flour", "1 cup sugar"],
        "recipeInstructions": [
          {"@type": "HowToStep", "text": "Mix ingredients"},
          {"@type": "HowToStep", "text": "Bake at 350F"}
        ],
        "totalTime": "PT30M",
        "recipeYield": "24"
      }
      </script>
      </head><body><p>Lots of ads and junk HTML</p></body></html>
    `;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(jsonLdHtml),
    });

    const { chat } = await import("./ai");

    const result = await extractRecipeFromUrl("https://example.com/recipe");

    // Should NOT call AI when JSON-LD is available
    expect(chat).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.recipe.name).toBe("JSON-LD Cookie Recipe");
    expect(result!.recipe.source).toBe("https://example.com/recipe");
    expect(result!.recipe.ingredients).toHaveLength(2);
    expect(result!.recipe.steps).toEqual(["Mix ingredients", "Bake at 350F"]);
    expect(result!.notices).toEqual([]);
  });

  it("falls back to AI with stripped HTML when no JSON-LD", async () => {
    // HTML without JSON-LD but with lots of noise
    const noisyHtml = `
      <html><head>
      <script>var tracking = true;</script>
      <style>.ad { display: block; }</style>
      </head><body>
      <nav>Home About Contact</nav>
      <main>
        <h1>Chocolate Cake Recipe</h1>
        <p>Ingredients: 200g chocolate, 100g butter</p>
        <p>Steps: Melt chocolate. Mix batter. Bake.</p>
      </main>
      <footer>Copyright 2024</footer>
      </body></html>
    `;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(noisyHtml),
    });

    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({
        name: "Chocolate Cake",
        ingredients: [{ item: "chocolate", amount: "200", unit: "g" }],
        steps: ["Melt chocolate", "Mix batter", "Bake"],
      }),
    });

    const result = await extractRecipeFromUrl("https://example.com/recipe");

    // Should call AI but with stripped content (no scripts, nav, footer)
    expect(chat).toHaveBeenCalled();
    const aiInput = (chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .messages[0].content;
    expect(aiInput).not.toContain("tracking");
    expect(aiInput).not.toContain("Home About Contact");
    expect(aiInput).not.toContain("Copyright");
    expect(aiInput).toContain("Chocolate Cake Recipe");

    expect(result!.recipe.name).toBe("Chocolate Cake");
    expect(result!.recipe.source).toBe("https://example.com/recipe");
    expect(result!.recipe.steps).toEqual([
      "Melt chocolate",
      "Mix batter",
      "Bake",
    ]);
    expect(result!.notices).toEqual([]);
  });

  it("drops steps the page doesn't give, and says so", async () => {
    // A recipe page with the ingredients and a pointer to the method, amid the
    // usual page text: a byline, comments and related recipes.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          "<html><body><nav>Home Recipes Shop</nav><main>" +
            "<h1>Flourless Chocolate Cake</h1>" +
            "<p>By the Test Kitchen · Updated March 2024</p>" +
            "<p>My grandmother made this every winter and it never lasted " +
            "the night.</p>" +
            "<h2>Ingredients</h2><ul><li>200g dark chocolate</li>" +
            "<li>100g butter</li><li>3 eggs</li><li>150g sugar</li></ul>" +
            "<p>The full method is in our book, page 212.</p>" +
            "<h2>Comments</h2><p>Made this for a birthday, so good!</p>" +
            "<p>Can I use milk chocolate instead?</p>" +
            "<h2>You might also like</h2><p>Lemon drizzle loaf</p>" +
            "<p>Banana bread</p></main><footer>Copyright</footer>" +
            "</body></html>",
        ),
    });
    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({
        name: "Flourless Chocolate Cake",
        ingredients: [
          { item: "dark chocolate", amount: "200", unit: "g" },
          { item: "butter", amount: "100", unit: "g" },
          { item: "eggs", amount: "3" },
          { item: "sugar", amount: "150", unit: "g" },
        ],
        steps: [
          "Preheat the oven to 180C and grease a round tin",
          "Melt the chocolate and butter together over a bain-marie",
          "Whisk the eggs with the sugar until pale and thick",
          "Fold the chocolate into the eggs and pour the batter into the tin",
          "Bake for 25 minutes until just set, then cool in the tin",
        ],
        stepIngredients: [[], [0, 1], [2, 3], [], []],
        estimatedTime: { active: 20, passive: 25, total: 45 },
      }),
    });

    const result = await extractRecipeFromUrl("https://example.com/recipe");

    expect(result!.recipe.ingredients).toHaveLength(4);
    expect(result!.recipe.steps).toEqual([]);
    expect(result!.recipe.stepIngredients).toBeUndefined();
    expect(result!.recipe.estimatedTime).toBeUndefined();
    expect(result!.recipe.source).toBe("https://example.com/recipe");
    expect(result!.notices).toEqual([
      {
        kind: "method-dropped",
        message: "Left out 5 steps that aren't in the source.",
      },
    ]);
  });

  it("sends fetch with proper headers", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          '<html><head><script type="application/ld+json">{"@type":"Recipe","name":"Test"}</script></head></html>',
        ),
    });

    await extractRecipeFromUrl("https://example.com/recipe");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/recipe",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("Mozilla"),
        }),
      }),
    );
  });

  it("throws error for invalid URL", async () => {
    await expect(extractRecipeFromUrl("not-a-url")).rejects.toThrow(
      "Invalid URL",
    );
  });

  it("throws error when fetch fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(
      extractRecipeFromUrl("https://example.com/missing"),
    ).rejects.toThrow("Failed to fetch URL: 404 Not Found");
  });

  it("throws error on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    await expect(
      extractRecipeFromUrl("https://example.com/recipe"),
    ).rejects.toThrow("Network error");
  });

  it("returns null when no recipe found in page", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("<html><body>No recipe here</body></html>"),
    });

    const { chat } = await import("./ai");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({ error: "no recipe found" }),
    });

    const result = await extractRecipeFromUrl("https://example.com/not-recipe");

    expect(result).toBeNull();
  });

  it("returns null for SPA pages with no content", async () => {
    // Simulate a JS-rendered SPA that returns an empty shell
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          '<html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
        ),
    });

    const { chat } = await import("./ai");

    const result = await extractRecipeFromUrl(
      "https://spa-recipe-site.com/recipe",
    );

    // Should not call AI for near-empty content
    expect(chat).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

// =============================================================================
// extractRecipeFromImage Tests
// =============================================================================

describe("extractRecipeFromImage", () => {
  it("returns the recipe unchecked, since an image has no text to check it against", async () => {
    const { vision } = await import("./ai");
    (vision as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        name: "Pancakes",
        ingredients: [{ item: "flour" }, { item: "milk" }],
        steps: ["Whisk the flour and milk", "Fry in butter"],
        serves: 4,
      }),
    );

    const result = await extractRecipeFromImage("base64data");

    expect(result).toEqual({
      recipe: expect.objectContaining({
        name: "Pancakes",
        steps: ["Whisk the flour and milk", "Fry in butter"],
        serves: 4,
      }),
      notices: [],
    });
  });

  it("asks again, with more room, when the reply isn't recipe JSON", async () => {
    const { vision } = await import("./ai");
    const mock = vision as ReturnType<typeof vi.fn>;
    // vision doesn't report truncation: a cut-off reply is just bad JSON.
    mock.mockResolvedValueOnce('{"name": "Pancakes", "steps": ["Whisk');
    mock.mockResolvedValueOnce(
      JSON.stringify({ name: "Pancakes", steps: ["Whisk the batter"] }),
    );

    const result = await extractRecipeFromImage("base64data");

    expect(result?.recipe.steps).toEqual(["Whisk the batter"]);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0].maxTokens).toBeGreaterThan(
      mock.mock.calls[0][0].maxTokens,
    );
  });

  it("returns null when the image holds no recipe", async () => {
    const { vision } = await import("./ai");
    (vision as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ error: "no recipe found" }),
    );

    expect(await extractRecipeFromImage("base64data")).toBeNull();
  });
});
