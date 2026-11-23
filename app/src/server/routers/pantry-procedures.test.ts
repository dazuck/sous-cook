import { describe, it, expect, vi, beforeEach } from "vitest";

// The pantry and shopping-list hooks, connected to stores these tests script.
const stores = vi.hoisted(() => ({
  pantry: { readSections: vi.fn(), addItems: vi.fn(), applyUpdates: vi.fn() },
  "shopping-list": { list: vi.fn(), add: vi.fn(), remove: vi.fn(), clear: vi.fn() },
}));

vi.mock("../../lib/hooks/registry", () => ({
  hook: (name: keyof typeof stores) => stores[name],
}));

vi.mock("../../lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../../lib/hooks/types");
  return { connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, true])) };
});

vi.mock("../../lib/kitchen-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/kitchen-queue")>()),
  getQueueItem: vi.fn(),
}));

vi.mock("../../lib/pantry-reconciliation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/pantry-reconciliation")>()),
  parseGroceryInput: vi.fn(),
  reconcileRecipeIngredients: vi.fn(),
}));

import { connected } from "../../lib/hooks/connected";
import { getQueueItem } from "../../lib/kitchen-queue";
import {
  parseGroceryInput,
  reconcileRecipeIngredients,
} from "../../lib/pantry-reconciliation";
import { callerFor } from "../../lib/__tests__/kitchens";

const HOME = { id: "00000000-0000-4000-8000-000000000001", slug: "home" };
const caller = callerFor(HOME);
const { readSections, addItems: addPantryItems, applyUpdates: updatePantryItems } = stores.pantry;
const {
  list: getShoppingList,
  add: addShoppingListItems,
  remove: removeShoppingListItem,
  clear: clearShoppingList,
} = stores["shopping-list"];
const QUEUE_ID = "3f1c2a9e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

describe("Pantry & Grocery tRPC procedures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connected.pantry = true;
    connected["shopping-list"] = true;
  });

  describe("parseGroceryInput", () => {
    it("calls parseGroceryInput and returns the parsed items", async () => {
      vi.mocked(parseGroceryInput).mockResolvedValueOnce([
        { text: "2 avocados", suggestedSection: "Fridge" },
        { text: "sour cream", suggestedSection: "Fridge" },
      ]);

      const res = await caller.parseGroceryInput({
        type: "voice",
        content: "two avocados and sour cream",
      });

      expect(res.items).toHaveLength(2);
      expect(res.items[0].text).toBe("2 avocados");
      expect(parseGroceryInput).toHaveBeenCalledWith({
        type: "voice",
        content: "two avocados and sour cream",
      });
    });
  });

  describe("addIngredientsToPantry", () => {
    it("calls addPantryItems and returns success count", async () => {
      addPantryItems.mockResolvedValueOnce({ added: 2 });

      const res = await caller.addIngredientsToPantry({
        items: [
          { text: "2 avocados", section: "fridge" },
          { text: "sour cream", section: "fridge" },
        ],
      });

      expect(res.success).toBe(true);
      expect(res.count).toBe(2);
      expect(addPantryItems).toHaveBeenCalledWith([
        { text: "2 avocados", section: "fridge" },
        { text: "sour cream", section: "fridge" },
      ]);
    });
  });

  describe("getRecipePantryReconciliation", () => {
    it("throws NOT_FOUND if queue item does not exist", async () => {
      vi.mocked(getQueueItem).mockResolvedValueOnce(null);

      await expect(
        caller.getRecipePantryReconciliation({ queueId: QUEUE_ID }),
      ).rejects.toThrow(/not found/i);
    });

    it("reads the pantry's sections and reconciles ingredients", async () => {
      vi.mocked(getQueueItem).mockResolvedValueOnce({
        id: QUEUE_ID,
        recipeData: {
          name: "Guacamole",
          ingredients: [{ item: "avocado", amount: "2" }],
        },
      } as never);

      const sections = [{ heading: "fridge", rawHeading: "Fridge", items: ["2 avocados"] }];
      readSections.mockResolvedValueOnce(sections);
      vi.mocked(reconcileRecipeIngredients).mockResolvedValueOnce([
        {
          docItemText: "2 avocados",
          section: "Fridge",
          matchedRecipeItem: "avocado",
          action: "delete",
          isStaple: false,
          preselected: true,
        },
      ]);

      const res = await caller.getRecipePantryReconciliation({ queueId: QUEUE_ID });

      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0].docItemText).toBe("2 avocados");
      expect(reconcileRecipeIngredients).toHaveBeenCalledTimes(1);
      expect(reconcileRecipeIngredients).toHaveBeenCalledWith({
        docSections: sections,
        recipeIngredients: [{ item: "avocado", amount: "2" }],
        recipeName: "Guacamole",
      });
    });
  });

  describe("applyPantryReconciliation", () => {
    it("calls updatePantryItems and returns updated count", async () => {
      vi.mocked(getQueueItem).mockResolvedValueOnce({ id: QUEUE_ID } as never);
      updatePantryItems.mockResolvedValueOnce({ updated: 2 });

      const res = await caller.applyPantryReconciliation({
        queueId: QUEUE_ID,
        actions: [
          { action: "delete", oldText: "2 avocados" },
          { action: "decrement", oldText: "5 lbs potatoes", newText: "4 lbs potatoes" },
        ],
      });

      expect(res.success).toBe(true);
      expect(res.updated).toBe(2);
      expect(getQueueItem).toHaveBeenCalledWith(HOME.id, QUEUE_ID);
      expect(updatePantryItems).toHaveBeenCalledWith([
        { action: "delete", oldText: "2 avocados" },
        { action: "decrement", oldText: "5 lbs potatoes", newText: "4 lbs potatoes" },
      ]);
    });
  });

  describe("shopping list procedures", () => {
    it("fetches, adds, removes, and clears shopping list items", async () => {
      const syncedAt = new Date("2026-10-14T22:00:00Z");
      getShoppingList.mockResolvedValueOnce({
        items: [
          {
            raw: "Hoisin sauce",
            item: "Hoisin sauce",
            forRecipe: null,
            key: "hoisin sauce",
            aisle: "Spices & sauces",
          },
        ],
        syncedAt,
      });

      const list = await caller.getShoppingList();
      expect(list.items).toHaveLength(1);
      expect(list.items[0].item).toBe("Hoisin sauce");

      addShoppingListItems.mockResolvedValueOnce({
        added: ["Salt from Trader Joe's"],
      });
      const added = await caller.addShoppingListItems({
        items: [{ item: "Salt from Trader Joe's" }],
      });
      expect(added.added).toEqual(["Salt from Trader Joe's"]);
      expect(addShoppingListItems).toHaveBeenCalledWith([
        { item: "Salt from Trader Joe's" },
      ]);

      removeShoppingListItem.mockResolvedValueOnce({ removed: true });
      const removed = await caller.removeShoppingListItem({
        rawOrKey: "Hoisin sauce",
      });
      expect(removed.removed).toBe(true);
      expect(removeShoppingListItem).toHaveBeenCalledWith("Hoisin sauce");

      clearShoppingList.mockResolvedValueOnce({ cleared: 1 });
      const cleared = await caller.clearShoppingList();
      expect(cleared.cleared).toBe(1);
    });

    it("rejects whitespace-only or bullet-only shopping list items at input validation", async () => {
      await expect(
        caller.addShoppingListItems({ items: [{ item: "   " }] }),
      ).rejects.toThrow();
      await expect(
        caller.addShoppingListItems({ items: [{ item: "•   " }] }),
      ).rejects.toThrow();
      await expect(
        caller.removeShoppingListItem({ rawOrKey: "-  " }),
      ).rejects.toThrow();
      expect(addShoppingListItems).not.toHaveBeenCalled();
      expect(removeShoppingListItem).not.toHaveBeenCalled();
    });
  });

  describe("with the hooks not connected", () => {
    it("answers the pantry's procedures empty and calls no store", async () => {
      connected.pantry = false;
      vi.mocked(getQueueItem).mockResolvedValueOnce({ id: QUEUE_ID } as never);

      expect(await caller.parseGroceryInput({ type: "text", content: "2 avocados" })).toEqual({ items: [] });
      expect(await caller.addIngredientsToPantry({ items: [{ text: "2 avocados" }] })).toEqual({
        success: true,
        count: 0,
      });
      expect(await caller.getRecipePantryReconciliation({ queueId: QUEUE_ID })).toEqual({ candidates: [] });
      expect(
        await caller.applyPantryReconciliation({ actions: [{ action: "delete", oldText: "2 avocados" }] }),
      ).toEqual({ success: true, updated: 0 });

      expect(parseGroceryInput).not.toHaveBeenCalled();
      expect(getQueueItem).toHaveBeenCalledWith(HOME.id, QUEUE_ID);
      expect(readSections).not.toHaveBeenCalled();
      expect(addPantryItems).not.toHaveBeenCalled();
      expect(updatePantryItems).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND for a missing queueId even when the pantry hook is not connected", async () => {
      connected.pantry = false;
      vi.mocked(getQueueItem).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await expect(
        caller.getRecipePantryReconciliation({ queueId: QUEUE_ID }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        caller.applyPantryReconciliation({
          queueId: QUEUE_ID,
          actions: [{ action: "delete", oldText: "2 avocados" }],
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("answers the shopping list's procedures empty and calls no store", async () => {
      connected["shopping-list"] = false;

      expect(await caller.getShoppingList()).toEqual({ items: [], syncedAt: new Date(0) });
      expect(await caller.addShoppingListItems({ items: [{ item: "Hoisin sauce" }] })).toEqual({ added: [] });
      expect(await caller.removeShoppingListItem({ rawOrKey: "Hoisin sauce" })).toEqual({ removed: false });
      expect(await caller.clearShoppingList()).toEqual({ cleared: 0 });

      expect(getShoppingList).not.toHaveBeenCalled();
      expect(addShoppingListItems).not.toHaveBeenCalled();
      expect(removeShoppingListItem).not.toHaveBeenCalled();
      expect(clearShoppingList).not.toHaveBeenCalled();
    });
  });
});


