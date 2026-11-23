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
  isValidUserId,
  DEFAULT_COOK,
  type QueueStatus,
  type KitchenQueueInput,
} from "./kitchen-queue";

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
    targetUser: "target_user",
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
  describe("isValidUserId", () => {
    it("returns true for the default cook", () => {
      expect(isValidUserId(DEFAULT_COOK)).toBe(true);
      expect(DEFAULT_COOK).toBe("cook");
    });

    it("returns true for any slug: lowercase letters, digits, single hyphens", () => {
      expect(isValidUserId("cook-2")).toBe(true);
      expect(isValidUserId("sam")).toBe(true);
      expect(isValidUserId("a".repeat(40))).toBe(true);
    });

    it("returns false for anything that isn't a slug", () => {
      expect(isValidUserId("")).toBe(false);
      expect(isValidUserId("COOK")).toBe(false);
      expect(isValidUserId("the cook")).toBe(false);
      expect(isValidUserId("-cook")).toBe(false);
      expect(isValidUserId("cook-")).toBe(false);
      expect(isValidUserId("cook--2")).toBe(false);
      expect(isValidUserId("cook_2")).toBe(false);
      expect(isValidUserId("a".repeat(41))).toBe(false);
    });
  });

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
        returning: vi.fn().mockResolvedValue([{ id: "queue-123", targetUser: "cook" }]),
      }),
    });
    (db.insert as Mock).mockImplementation(mockInsert);

    const input: KitchenQueueInput = {
      recipeNotionId: "notion-456",
      targetUser: "cook",
    };

    const result = await addToKitchenQueue(input);

    expect(result).toEqual({ id: "queue-123" });
    expect(db.insert).toHaveBeenCalled();
  });

  it("adds a recipe with full data (no Notion ID) to the queue", async () => {
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "queue-789", targetUser: "cook-2" }]),
      }),
    });
    (db.insert as Mock).mockImplementation(mockInsert);

    const input: KitchenQueueInput = {
      recipeData: {
        name: "Test Recipe",
        ingredients: [{ item: "flour", amount: "2", unit: "cups" }],
        steps: ["Mix ingredients", "Bake"],
      },
      targetUser: "cook-2",
    };

    const result = await addToKitchenQueue(input);

    expect(result).toEqual({ id: "queue-789" });
    expect(db.insert).toHaveBeenCalled();
  });

  it("stores Sous's serving estimate in its own columns, beside the recipe, never in it (B4b)", async () => {
    const values = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "queue-est", targetUser: "cook" }]),
    });
    (db.insert as Mock).mockReturnValue({ values });
    const recipeData = { name: "Stew", steps: ["Simmer."] };

    await addToKitchenQueue({
      recipeData,
      targetUser: "cook",
      servesEstimate: { count: 3, basis: "about 3 bowls" },
    });
    expect(values).toHaveBeenLastCalledWith([
      expect.objectContaining({
        recipeData,
        servesEstimate: 3,
        servesEstimateBasis: "about 3 bowls",
        servesEstimateSourceHash: sourceHash("kitchen_queue", recipeData),
      }),
    ]);
    expect(values.mock.lastCall![0][0].recipeData).not.toHaveProperty("serves");

    await addToKitchenQueue({ recipeData, targetUser: "cook" });
    expect(values).toHaveBeenLastCalledWith([
      expect.objectContaining({ servesEstimate: null, servesEstimateBasis: null, servesEstimateSourceHash: null }),
    ]);
  });

  it("throws error for invalid target user", async () => {
    const input: KitchenQueueInput = {
      recipeNotionId: "notion-456",
      targetUser: "Not A Slug",
    };

    await expect(addToKitchenQueue(input)).rejects.toThrow(
      "Invalid target user: Not A Slug",
    );
  });

  it("throws error when neither recipeNotionId nor recipeData provided", async () => {
    const input: KitchenQueueInput = {
      targetUser: "cook",
    };

    await expect(addToKitchenQueue(input)).rejects.toThrow(
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

  it("returns pending recipes for a user", async () => {
    const mockRecipes = [
      {
        id: "q1",
        recipeNotionId: "notion-1",
        recipeData: null,
        targetUser: "cook",
        status: "pending",
        createdAt: new Date("2025-12-27T10:00:00Z"),
      },
      {
        id: "q2",
        recipeNotionId: null,
        recipeData: { name: "Quick Pasta" },
        targetUser: "cook",
        status: "pending",
        createdAt: new Date("2025-12-27T09:00:00Z"),
      },
    ];

    (db.query.kitchenQueue.findMany as Mock).mockResolvedValue(mockRecipes);

    const result = await getKitchenQueue("cook");

    expect(result).toEqual(mockRecipes);
    expect(db.query.kitchenQueue.findMany).toHaveBeenCalled();
  });

  it("returns empty array when no pending recipes", async () => {
    (db.query.kitchenQueue.findMany as Mock).mockResolvedValue([]);

    const result = await getKitchenQueue("cook-2");

    expect(result).toEqual([]);
  });

  it("can filter by status", async () => {
    const mockRecipes = [
      {
        id: "q1",
        recipeNotionId: "notion-1",
        status: "cooking",
        targetUser: "cook",
      },
    ];

    (db.query.kitchenQueue.findMany as Mock).mockResolvedValue(mockRecipes);

    const result = await getKitchenQueue("cook", "cooking");

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
      recipeNotionId: "notion-1",
      recipeData: null,
      targetUser: "cook",
      status: "pending",
      createdAt: new Date(),
    };

    (db.query.kitchenQueue.findFirst as Mock).mockResolvedValue(mockItem);

    const result = await getQueueItem("q1");

    expect(result).toEqual(mockItem);
  });

  it("returns null for non-existent item", async () => {
    (db.query.kitchenQueue.findFirst as Mock).mockResolvedValue(null);

    const result = await getQueueItem("non-existent");

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

    expect(await updateQueueStatus("q1", "cooking")).toEqual({
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

    expect(await updateQueueStatus("q1", "completed")).toEqual({
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

    expect(await updateQueueStatus("q1", "completed")).toEqual({
      completed: false,
      started: false,
    });
  });

  it("throws error for invalid status", async () => {
    await expect(
      updateQueueStatus("q1", "invalid" as QueueStatus),
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

    await removeFromQueue("q1");

    expect(db.delete).toHaveBeenCalled();
  });
});
