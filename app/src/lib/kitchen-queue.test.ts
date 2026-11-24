/**
 * Kitchen Queue Tests (F2)
 *
 * TDD tests for kitchen queue management - sending recipes from chat to kitchen.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import {
  addToKitchenQueue,
  getKitchenQueue,
  removeFromQueue,
  getQueueItem,
  updateQueueStatus,
  isValidQueueStatus,
  type QueueStatus,
  type KitchenQueueInput,
} from "./kitchen-queue";

const KITCHEN_ID = "00000000-0000-4000-8000-000000000001";

// =============================================================================
// Mock Setup
// =============================================================================

// Mock the database module
vi.mock("./db", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    query: {
      kitchenQueue: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
    },
  },
  kitchenQueue: {
    id: "id",
    kitchenId: "kitchen_id",
    status: "status",
    createdAt: "created_at",
  },
}));

import { db } from "./db";
import { sourceHash } from "./serves-estimate-plan";

// Helper to reset mocks
function resetMocks() {
  vi.clearAllMocks();
}

// =============================================================================
// Type Guard Tests
// =============================================================================

describe("Type Guards", () => {
  describe("isValidQueueStatus", () => {
    it("returns true for valid statuses", () => {
      expect(isValidQueueStatus("pending")).toBe(true);
      expect(isValidQueueStatus("cooking")).toBe(true);
      expect(isValidQueueStatus("completed")).toBe(true);
      expect(isValidQueueStatus("cancelled")).toBe(true);
    });

    it("returns false for invalid statuses", () => {
      expect(isValidQueueStatus("started")).toBe(false);
      expect(isValidQueueStatus("")).toBe(false);
      expect(isValidQueueStatus("PENDING")).toBe(false);
    });
  });
});

// =============================================================================
// addToKitchenQueue Tests
// =============================================================================

describe("addToKitchenQueue", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("adds a recipe with Notion ID to the queue", async () => {
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "queue-123" }]),
      }),
    });
    (db.insert as Mock).mockImplementation(mockInsert);

    const input: KitchenQueueInput = {
      recipeNotionId: "notion-456",
    };

    const result = await addToKitchenQueue(KITCHEN_ID, input);

    expect(result).toEqual({ id: "queue-123" });
    expect(db.insert).toHaveBeenCalled();
  });

  it("adds a recipe with full data (no Notion ID) to the queue", async () => {
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "queue-789" }]),
      }),
    });
    (db.insert as Mock).mockImplementation(mockInsert);

    const input: KitchenQueueInput = {
      recipeData: {
        name: "Test Recipe",
        ingredients: [{ item: "flour", amount: "2", unit: "cups" }],
        steps: ["Mix ingredients", "Bake"],
      },
    };

    const result = await addToKitchenQueue(KITCHEN_ID, input);

    expect(result).toEqual({ id: "queue-789" });
    expect(db.insert).toHaveBeenCalled();
  });

  it("stores Sous's serving estimate in its own columns, beside the recipe, never in it (B4b)", async () => {
    const values = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "queue-est" }]),
    });
    (db.insert as Mock).mockReturnValue({ values });
    const recipeData = { name: "Stew", steps: ["Simmer."] };

    await addToKitchenQueue(KITCHEN_ID, {
      recipeData,
      servesEstimate: { count: 3, basis: "about 3 bowls" },
    });
    expect(values).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kitchenId: KITCHEN_ID,
        recipeData,
        servesEstimate: 3,
        servesEstimateBasis: "about 3 bowls",
        servesEstimateSourceHash: sourceHash("kitchen_queue", recipeData),
      }),
    );
    expect(values.mock.lastCall![0].recipeData).not.toHaveProperty("serves");

    await addToKitchenQueue(KITCHEN_ID, { recipeData });
    expect(values).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kitchenId: KITCHEN_ID,
        servesEstimate: null,
        servesEstimateBasis: null,
        servesEstimateSourceHash: null,
      }),
    );
  });

  it("throws error when neither recipeNotionId nor recipeData provided", async () => {
    const input: KitchenQueueInput = {};

    await expect(addToKitchenQueue(KITCHEN_ID, input)).rejects.toThrow(
      "Either recipeNotionId or recipeData must be provided",
    );
  });
});

// =============================================================================
// getKitchenQueue Tests
// =============================================================================

describe("getKitchenQueue", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("returns pending recipes for a kitchen", async () => {
    const mockRecipes = [
      {
        id: "q1",
        kitchenId: KITCHEN_ID,
        recipeNotionId: "notion-1",
        recipeData: null,
        status: "pending",
        createdAt: new Date("2025-12-27T10:00:00Z"),
      },
      {
        id: "q2",
        kitchenId: KITCHEN_ID,
        recipeNotionId: null,
        recipeData: { name: "Quick Pasta" },
        status: "pending",
        createdAt: new Date("2025-12-27T09:00:00Z"),
      },
    ];

    (db.query.kitchenQueue.findMany as Mock).mockResolvedValue(mockRecipes);

    const result = await getKitchenQueue(KITCHEN_ID);

    expect(result).toEqual(mockRecipes);
    expect(db.query.kitchenQueue.findMany).toHaveBeenCalled();
  });

  it("returns empty array when no pending recipes", async () => {
    (db.query.kitchenQueue.findMany as Mock).mockResolvedValue([]);

    const result = await getKitchenQueue(KITCHEN_ID);

    expect(result).toEqual([]);
  });

  it("can filter by status", async () => {
    const mockRecipes = [
      {
        id: "q1",
        kitchenId: KITCHEN_ID,
        recipeNotionId: "notion-1",
        status: "cooking",
      },
    ];

    (db.query.kitchenQueue.findMany as Mock).mockResolvedValue(mockRecipes);

    const result = await getKitchenQueue(KITCHEN_ID, "cooking");

    expect(result).toEqual(mockRecipes);
  });
});

// =============================================================================
// getQueueItem Tests
// =============================================================================

describe("getQueueItem", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("returns a queue item by ID", async () => {
    const mockItem = {
      id: "q1",
      kitchenId: KITCHEN_ID,
      recipeNotionId: "notion-1",
      recipeData: null,
      status: "pending",
      createdAt: new Date(),
    };

    (db.query.kitchenQueue.findFirst as Mock).mockResolvedValue(mockItem);

    const result = await getQueueItem(KITCHEN_ID, "q1");

    expect(result).toEqual(mockItem);
  });

  it("returns null for non-existent item", async () => {
    (db.query.kitchenQueue.findFirst as Mock).mockResolvedValue(null);

    const result = await getQueueItem(KITCHEN_ID, "non-existent");

    expect(result).toBeNull();
  });
});

// =============================================================================
// updateQueueStatus Tests
// =============================================================================

describe("updateQueueStatus", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("updates status to cooking, and says it started the cook", async () => {
    const mockUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "q1" }]),
        }),
      }),
    });
    (db.update as Mock).mockImplementation(mockUpdate);

    expect(await updateQueueStatus(KITCHEN_ID, "q1", "cooking")).toEqual({
      completed: false,
      started: true,
    });

    expect(db.update).toHaveBeenCalled();
  });

  // The transitions themselves run against PGlite in
  // kitchen-queue-transitions.test.ts; this checks the returned shape.
  it("reports completed when the update moved the item", async () => {
    const mockUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "q1" }]),
        }),
      }),
    });
    (db.update as Mock).mockImplementation(mockUpdate);

    expect(await updateQueueStatus(KITCHEN_ID, "q1", "completed")).toEqual({
      completed: true,
      started: false,
    });
  });

  it("reports no transition when the update matched no row", async () => {
    const mockUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    (db.update as Mock).mockImplementation(mockUpdate);

    expect(await updateQueueStatus(KITCHEN_ID, "q1", "completed")).toEqual({
      completed: false,
      started: false,
    });
  });

  it("throws error for invalid status", async () => {
    await expect(
      updateQueueStatus(KITCHEN_ID, "q1", "invalid" as QueueStatus),
    ).rejects.toThrow("Invalid queue status: invalid");
  });
});

// =============================================================================
// removeFromQueue Tests
// =============================================================================

describe("removeFromQueue", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("removes an item from the queue", async () => {
    const mockDelete = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    (db.delete as Mock).mockImplementation(mockDelete);

    await removeFromQueue(KITCHEN_ID, "q1");

    expect(db.delete).toHaveBeenCalled();
  });
});
