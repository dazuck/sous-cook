import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import { db, kitchenShoppingList, kitchens } from "@/lib/db";
import {
  formatShoppingLine,
  parseShoppingLine,
  shopItemKey,
  type ShoppingListItem,
} from "../shopping-list-format";
import type { ShoppingListAddition, ShoppingListStore } from "./types";

export type ShoppingListDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Per-kitchen Shopping List backed by `kitchen_shopping_list`.
 */
export function createDbShoppingListStore(
  kitchenId: string,
  database: ShoppingListDb = db,
): ShoppingListStore {
  return {
    async list(): Promise<{ items: ShoppingListItem[]; syncedAt: Date }> {
      const rows = await database
        .select({ line: kitchenShoppingList.line })
        .from(kitchenShoppingList)
        .where(eq(kitchenShoppingList.kitchenId, kitchenId))
        .orderBy(asc(kitchenShoppingList.position));

      const syncedAt = new Date();
      const items = rows
        .filter((row) => row.line.trim() !== "")
        .map((row) => parseShoppingLine(row.line))
        .filter((parsed) => parsed.raw !== "");

      return { items, syncedAt };
    },

    async add(
      inputs: ReadonlyArray<ShoppingListAddition>,
    ): Promise<{ added: string[] }> {
      if (inputs.length === 0) {
        return { added: [] };
      }

      return database.transaction(async (tx) => {
        await tx
          .select({ id: kitchens.id })
          .from(kitchens)
          .where(eq(kitchens.id, kitchenId))
          .for("update");

        const existingRows = await tx
          .select({ line: kitchenShoppingList.line })
          .from(kitchenShoppingList)
          .where(eq(kitchenShoppingList.kitchenId, kitchenId))
          .orderBy(asc(kitchenShoppingList.position));

        const presentKeys = new Set<string>();
        for (const row of existingRows) {
          if (row.line.trim() === "") continue;
          const key = shopItemKey(row.line);
          if (key) presentKeys.add(key);
        }

        const toInsert: string[] = [];
        for (const input of inputs) {
          const line = formatShoppingLine(input.item, input.forRecipe);
          const key = shopItemKey(line);
          if (!key || presentKeys.has(key)) {
            continue;
          }
          presentKeys.add(key);
          toInsert.push(line);
        }

        if (toInsert.length > 0) {
          await tx.insert(kitchenShoppingList).values(
            toInsert.map((line) => ({
              kitchenId,
              line,
            })),
          );
        }

        return { added: toInsert };
      });
    },

    async remove(rawOrKey: string): Promise<{ removed: boolean }> {
      const trimmed = rawOrKey.trim();
      if (!trimmed) {
        return { removed: false };
      }

      const targetLower = trimmed.toLowerCase();
      const targetKey = shopItemKey(trimmed);

      return database.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: kitchenShoppingList.id,
            line: kitchenShoppingList.line,
          })
          .from(kitchenShoppingList)
          .where(eq(kitchenShoppingList.kitchenId, kitchenId));

        const matchingIds: string[] = [];
        for (const row of rows) {
          const parsed = parseShoppingLine(row.line);
          const matchesRaw =
            parsed.raw.toLowerCase() === targetLower ||
            row.line.trim().toLowerCase() === targetLower;
          const matchesKey = targetKey !== "" && parsed.key === targetKey;
          if (matchesRaw || matchesKey) {
            matchingIds.push(row.id);
          }
        }

        if (matchingIds.length === 0) {
          return { removed: false };
        }

        await tx
          .delete(kitchenShoppingList)
          .where(
            and(
              eq(kitchenShoppingList.kitchenId, kitchenId),
              inArray(kitchenShoppingList.id, matchingIds),
            ),
          );

        return { removed: true };
      });
    },

    async clear(): Promise<{ cleared: number }> {
      return database.transaction(async (tx) => {
        const deleted = await tx
          .delete(kitchenShoppingList)
          .where(eq(kitchenShoppingList.kitchenId, kitchenId))
          .returning({ id: kitchenShoppingList.id });

        return { cleared: deleted.length };
      });
    },
  };
}
