import { and, asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import {
  db,
  kitchenPantryItems,
  kitchenPantrySections,
  kitchens,
} from "@/lib/db";
import { isFoodInventoryHeading } from "./pantry";
import type {
  PantryAddition,
  PantrySection,
  PantryStore,
  PantryUpdateAction,
} from "./types";

export type PantryDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export const DEFAULT_PANTRY_HEADINGS = [
  "Fridge",
  "Freezer",
  "Pantry",
  "Spice Rack",
  "Oils, Vinegars & Sauces",
] as const;

const LEADING_BULLET_RE = /^\s*[•◦▪‣·*-]\s+/;

function cleanPantryLine(raw: string): string {
  return raw.replace(LEADING_BULLET_RE, "");
}

function normalizeForMatch(raw: string): string {
  return cleanPantryLine(raw).trim().toLowerCase();
}

function pickFoodSectionId(
  foodSections: ReadonlyArray<{ id: string; heading: string }>,
  suggestedSection: string | undefined,
): string {
  const first = foodSections[0];
  if (!first) {
    throw new Error("Pantry has no food sections.");
  }
  const suggestion = (suggestedSection ?? "").trim().toLowerCase();
  if (!suggestion) {
    return first.id;
  }

  // 1. Exact heading match (case-insensitive)
  const exact = foodSections.find((s) => s.heading === suggestion);
  if (exact) return exact.id;

  // 2. Substring match in either direction
  const partial = foodSections.find(
    (s) => s.heading.includes(suggestion) || suggestion.includes(s.heading),
  );
  if (partial) return partial.id;

  // 3. Perishable/produce suggestion -> fridge/perishable section
  if (
    suggestion.includes("fridge") ||
    suggestion.includes("perish") ||
    suggestion.includes("produce") ||
    suggestion.includes("veg")
  ) {
    const fridge = foodSections.find(
      (s) => s.heading.includes("fridge") || s.heading.includes("perish"),
    );
    if (fridge) return fridge.id;
  }

  // 4. Freezer suggestion -> freezer section
  if (suggestion.includes("freezer")) {
    const freezer = foodSections.find((s) => s.heading.includes("freezer"));
    if (freezer) return freezer.id;
  }

  // 5. Pantry fallback
  const pantry = foodSections.find((s) => s.heading.includes("pantry"));
  if (pantry) return pantry.id;

  // 6. First food section
  return first.id;
}

/**
 * Per-kitchen Pantry backed by `kitchen_pantry_sections` and
 * `kitchen_pantry_items`.
 */
export function createDbPantryStore(
  kitchenId: string,
  database: PantryDb = db,
): PantryStore {
  return {
    async readSections(): Promise<PantrySection[]> {
      const sections = await database
        .select({
          id: kitchenPantrySections.id,
          rawHeading: kitchenPantrySections.rawHeading,
        })
        .from(kitchenPantrySections)
        .where(eq(kitchenPantrySections.kitchenId, kitchenId))
        .orderBy(asc(kitchenPantrySections.position));

      if (sections.length === 0) {
        return [];
      }

      const items = await database
        .select({
          sectionId: kitchenPantryItems.sectionId,
          text: kitchenPantryItems.text,
        })
        .from(kitchenPantryItems)
        .where(eq(kitchenPantryItems.kitchenId, kitchenId))
        .orderBy(asc(kitchenPantryItems.position));

      const itemsBySection = new Map<string, string[]>();
      for (const item of items) {
        const cleaned = cleanPantryLine(item.text);
        if (cleaned.trim() === "") continue;
        const list = itemsBySection.get(item.sectionId) ?? [];
        list.push(cleaned);
        itemsBySection.set(item.sectionId, list);
      }

      return sections.map((s) => ({
        heading: s.rawHeading.trim().toLowerCase(),
        rawHeading: s.rawHeading,
        items: itemsBySection.get(s.id) ?? [],
      }));
    },

    async addItems(items: PantryAddition[]): Promise<{ added: number }> {
      if (items.length === 0) {
        return { added: 0 };
      }

      const validItems = items
        .map((item) => ({
          text: item.text.trim(),
          section: item.section,
        }))
        .filter((item) => item.text.length > 0);

      if (validItems.length === 0) {
        return { added: 0 };
      }

      return database.transaction(async (tx) => {
        // Serialize initial default-section creation per kitchen.
        await tx
          .select({ id: kitchens.id })
          .from(kitchens)
          .where(eq(kitchens.id, kitchenId))
          .for("update");

        let sections = await tx
          .select({
            id: kitchenPantrySections.id,
            rawHeading: kitchenPantrySections.rawHeading,
          })
          .from(kitchenPantrySections)
          .where(eq(kitchenPantrySections.kitchenId, kitchenId))
          .orderBy(asc(kitchenPantrySections.position));

        if (sections.length === 0) {
          sections = await tx
            .insert(kitchenPantrySections)
            .values(
              DEFAULT_PANTRY_HEADINGS.map((rawHeading) => ({
                kitchenId,
                rawHeading,
              })),
            )
            .returning({
              id: kitchenPantrySections.id,
              rawHeading: kitchenPantrySections.rawHeading,
            });
        }

        const foodSections = sections
          .filter((s) => isFoodInventoryHeading(s.rawHeading))
          .map((s) => ({
            id: s.id,
            heading: s.rawHeading.trim().toLowerCase(),
          }));

        if (foodSections.length === 0) {
          throw new Error("Pantry has no food sections.");
        }

        const rowsToInsert = validItems.map((item) => ({
          kitchenId,
          sectionId: pickFoodSectionId(foodSections, item.section),
          text: item.text,
        }));

        await tx.insert(kitchenPantryItems).values(rowsToInsert);
        return { added: rowsToInsert.length };
      });
    },

    async applyUpdates(
      actions: PantryUpdateAction[],
    ): Promise<{ updated: number }> {
      if (actions.length === 0) {
        return { updated: 0 };
      }

      return database.transaction(async (tx) => {
        const sections = await tx
          .select({
            id: kitchenPantrySections.id,
            rawHeading: kitchenPantrySections.rawHeading,
          })
          .from(kitchenPantrySections)
          .where(eq(kitchenPantrySections.kitchenId, kitchenId))
          .orderBy(asc(kitchenPantrySections.position));

        const foodSectionOrder = new Map<string, { order: number; heading: string }>();
        sections.forEach((s, index) => {
          if (isFoodInventoryHeading(s.rawHeading)) {
            foodSectionOrder.set(s.id, {
              order: index,
              heading: s.rawHeading.trim().toLowerCase(),
            });
          }
        });

        if (foodSectionOrder.size === 0) {
          return { updated: 0 };
        }

        const rawItems = await tx
          .select({
            id: kitchenPantryItems.id,
            sectionId: kitchenPantryItems.sectionId,
            position: kitchenPantryItems.position,
            text: kitchenPantryItems.text,
          })
          .from(kitchenPantryItems)
          .where(eq(kitchenPantryItems.kitchenId, kitchenId))
          .orderBy(asc(kitchenPantryItems.position));

        const candidates = rawItems
          .flatMap((row) => {
            const sec = foodSectionOrder.get(row.sectionId);
            if (!sec) return [];
            const normalized = normalizeForMatch(row.text);
            if (!normalized) return [];
            return [
              {
                id: row.id,
                sectionOrder: sec.order,
                sectionHeading: sec.heading,
                position: row.position,
                normalized,
              },
            ];
          })
          .sort((a, b) => {
            if (a.sectionOrder !== b.sectionOrder) {
              return a.sectionOrder - b.sectionOrder;
            }
            return a.position - b.position;
          });

        const taken = new Set<string>();
        let updated = 0;

        for (const action of actions) {
          const target = action.oldText.trim().toLowerCase();
          if (!target) continue;

          const sectionHint = action.section?.trim().toLowerCase() ?? "";
          let matched =
            sectionHint !== ""
              ? candidates.find(
                  (c) =>
                    !taken.has(c.id) &&
                    c.sectionHeading === sectionHint &&
                    c.normalized === target,
                )
              : undefined;

          if (!matched) {
            matched = candidates.find(
              (c) => !taken.has(c.id) && c.normalized === target,
            );
          }

          if (!matched) continue;
          taken.add(matched.id);

          if (action.action === "delete") {
            await tx
              .delete(kitchenPantryItems)
              .where(
                and(
                  eq(kitchenPantryItems.kitchenId, kitchenId),
                  eq(kitchenPantryItems.id, matched.id),
                ),
              );
          } else {
            const nextText = action.newText?.trim() ?? "";
            if (nextText.length > 0) {
              await tx
                .update(kitchenPantryItems)
                .set({ text: nextText })
                .where(
                  and(
                    eq(kitchenPantryItems.kitchenId, kitchenId),
                    eq(kitchenPantryItems.id, matched.id),
                  ),
                );
            }
          }

          updated += 1;
        }

        return { updated };
      });
    },
  };
}
