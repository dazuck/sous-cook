import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reconcileRecipeIngredients,
  parseGroceryInput,
  type ReconcileOptions,
} from "./pantry-reconciliation";
import type { PantrySection } from "./hooks/types";

vi.mock("./ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai")>()),
  chat: vi.fn(),
  vision: vi.fn(),
}));

import { chat, vision } from "./ai";
import { scriptMeter } from "./ai/meter";

const TEST_METER = scriptMeter("pantry-reconciliation-test");

const mockChat = vi.mocked(chat);
const mockVision = vi.mocked(vision);

describe("reconcileRecipeIngredients", () => {
  beforeEach(() => {
    mockChat.mockReset();
  });

  const sampleSections: PantrySection[] = [
    {
      heading: "fridge",
      rawHeading: "Fridge",
      items: ["2 avocados", "cilantro", "sour cream"],
    },
    {
      heading: "pantry",
      rawHeading: "Pantry",
      items: ["5 lbs Yukon Gold potatoes", "jasmine rice"],
    },
    {
      heading: "spice rack",
      rawHeading: "Spice Rack",
      items: ["ground cumin", "kosher salt"],
    },
    {
      heading: "our family:",
      rawHeading: "Our family:",
      items: ["Two adults, one of them vegetarian"],
    },
  ];

  it("identifies full-use matches, partial decrements, and staples", async () => {
    const aiResponsePayload = {
      candidates: [
        {
          docItemText: "2 avocados",
          section: "Fridge",
          matchedRecipeItem: "avocado",
          action: "delete",
          isStaple: false,
          preselected: true,
          reason: "Used 2 avocados",
        },
        {
          docItemText: "5 lbs Yukon Gold potatoes",
          section: "Pantry",
          matchedRecipeItem: "potatoes",
          action: "decrement",
          updatedText: "4 lbs Yukon Gold potatoes",
          isStaple: false,
          preselected: true,
          reason: "Used 1 lb of potatoes",
        },
        {
          docItemText: "ground cumin",
          section: "Spice Rack",
          matchedRecipeItem: "cumin",
          action: "keep",
          isStaple: true,
          preselected: false,
          reason: "Spice rack staple",
        },
      ],
    };

    mockChat.mockResolvedValueOnce({
      content: JSON.stringify(aiResponsePayload),
      finishReason: "stop",
    });

    const options: ReconcileOptions = {
      docSections: sampleSections,
      recipeName: "Potato Salad",
      recipeIngredients: [
        { item: "avocado", amount: "2" },
        { item: "potatoes", amount: "1", unit: "lb" },
        { item: "cumin", amount: "1", unit: "tsp" },
      ],
    };

    const candidates = await reconcileRecipeIngredients(options, TEST_METER);

    expect(candidates).toHaveLength(3);
    expect(candidates[0].action).toBe("delete");
    expect(candidates[0].preselected).toBe(true);

    expect(candidates[1].action).toBe("decrement");
    expect(candidates[1].updatedText).toBe("4 lbs Yukon Gold potatoes");
    expect(candidates[1].preselected).toBe(true);

    expect(candidates[2].isStaple).toBe(true);
    expect(candidates[2].preselected).toBe(false);
  });

  it("filters out candidates that do not exist in the live doc items", async () => {
    const aiResponsePayload = {
      candidates: [
        {
          docItemText: "hallucinated item",
          section: "Fridge",
          matchedRecipeItem: "something",
          action: "delete",
          isStaple: false,
          preselected: true,
        },
        {
          docItemText: "2 avocados",
          section: "Fridge",
          matchedRecipeItem: "avocados",
          action: "delete",
          isStaple: false,
          preselected: true,
        },
      ],
    };

    mockChat.mockResolvedValueOnce({
      content: JSON.stringify(aiResponsePayload),
      finishReason: "stop",
    });

    const candidates = await reconcileRecipeIngredients(
      {
        docSections: sampleSections,
        recipeIngredients: [{ item: "avocado" }],
      },
      TEST_METER,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].docItemText).toBe("2 avocados");
  });

  it("fails safe and returns empty array on invalid JSON or AI error", async () => {
    mockChat.mockRejectedValueOnce(new Error("AI rate limit"));

    const candidates = await reconcileRecipeIngredients(
      {
        docSections: sampleSections,
        recipeIngredients: [{ item: "avocado" }],
      },
      TEST_METER,
    );

    expect(candidates).toEqual([]);
  });

  it("handles markdown json wrapped responses", async () => {
    const aiResponsePayload = {
      candidates: [
        {
          docItemText: "cilantro",
          section: "Fridge",
          matchedRecipeItem: "cilantro",
          action: "delete",
          isStaple: false,
          preselected: true,
        },
      ],
    };

    mockChat.mockResolvedValueOnce({
      content: "```json\n" + JSON.stringify(aiResponsePayload) + "\n```",
      finishReason: "stop",
    });

    const candidates = await reconcileRecipeIngredients(
      {
        docSections: sampleSections,
        recipeIngredients: [{ item: "cilantro" }],
      },
      TEST_METER,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].docItemText).toBe("cilantro");
  });
});

describe("parseGroceryInput", () => {
  beforeEach(() => {
    mockChat.mockReset();
    mockVision.mockReset();
  });

  it("parses text and voice inputs into grocery items with suggested sections", async () => {
    const payload = {
      items: [
        { text: "2 avocados", suggestedSection: "Fridge" },
        { text: "1 bunch cilantro", suggestedSection: "Fridge" },
        { text: "sour cream", suggestedSection: "Fridge" },
        { text: "corn tortillas", suggestedSection: "Pantry" },
      ],
    };

    mockChat.mockResolvedValueOnce({
      content: JSON.stringify(payload),
      finishReason: "stop",
    });

    const items = await parseGroceryInput(
      {
        type: "voice",
        content: "I got two avocados, cilantro, sour cream, and corn tortillas",
      },
      TEST_METER,
    );

    expect(items).toHaveLength(4);
    expect(items[0].text).toBe("2 avocados");
    expect(items[0].suggestedSection).toBe("Fridge");
    expect(items[3].suggestedSection).toBe("Pantry");
  });

  it("parses image inputs using vision model", async () => {
    const payload = {
      items: [
        { text: "1 lb ground beef", suggestedSection: "Fridge" },
        { text: "black beans", suggestedSection: "Pantry" },
      ],
    };

    mockVision.mockResolvedValueOnce(JSON.stringify(payload));

    const items = await parseGroceryInput(
      {
        type: "image",
        content: "data:image/jpeg;base64,...",
      },
      TEST_METER,
    );

    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("1 lb ground beef");
    expect(mockVision).toHaveBeenCalledTimes(1);
  });

  it("returns empty array when content is empty", async () => {
    const items = await parseGroceryInput({ type: "text", content: "" }, TEST_METER);
    expect(items).toEqual([]);
    expect(mockChat).not.toHaveBeenCalled();
  });
});

