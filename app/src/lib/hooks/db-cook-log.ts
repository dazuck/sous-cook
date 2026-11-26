import { and, asc, eq, sql } from "drizzle-orm";
import type { CookLogRef, KitchenQueueRecipeData } from "../../../drizzle/schema";
import { db, kitchenCookLog } from "@/lib/db";
import {
  adoptableRow,
  cookLogTimestamp,
  cookRow,
  normalizeRecipeName,
} from "./cook-log";
import { COOK_LOG_COLUMNS, type CookLogGrid } from "./types";

function parseRatingCell(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new Error(`Invalid Cook Log rating: ${raw}`);
  }
  return n;
}

export interface DbCookEntryInput {
  name: string;
  at: Date;
  queueId: string;
  docRecipeId: string | null;
  packSource: string | null;
  sourceKitchenPackId: string | null;
  recipeIsPrivate: boolean;
  recipeSnapshot: KitchenQueueRecipeData | null;
  cookedByMemberId: string | null;
}

export interface DbRateCookEntryInput {
  rating: number;
  notes?: string;
  notePrivate?: boolean;
  heldBack?: boolean;
  queueId: string;
  docRecipeId: string | null;
  packSource: string | null;
  sourceKitchenPackId: string | null;
  recipeIsPrivate: boolean;
  recipeSnapshot: KitchenQueueRecipeData | null;
  cookedByMemberId: string | null;
  cookedAt: Date;
}

export interface DbCookLogGrid extends CookLogGrid {
  readonly isDbCookLog: true;
  appendCookEntry(input: DbCookEntryInput): Promise<CookLogRef>;
  rateCookEntry(log: CookLogRef, input: DbRateCookEntryInput): Promise<CookLogRef>;
}

export function isDbCookLogGrid(grid: CookLogGrid): grid is DbCookLogGrid {
  return (grid as Partial<DbCookLogGrid>).isDbCookLog === true;
}

function cookLogLockKey(kitchenId: string): string {
  return `cook_log:${kitchenId}`;
}

/**
 * Per-kitchen Cook Log backed by `kitchen_cook_log`.
 *
 * Row 1 is always `COOK_LOG_COLUMNS`; cooks start at row 2 in `position`
 * order for this kitchen alone, so another kitchen's rows never shift this
 * kitchen's row numbers.
 */
export function dbCookLog(kitchenId: string): DbCookLogGrid {
  return {
    isDbCookLog: true,

    async read(): Promise<string[][]> {
      const rows = await db
        .select({
          timestampText: kitchenCookLog.timestampText,
          recipeTitle: kitchenCookLog.recipeTitle,
          rating: kitchenCookLog.rating,
          notes: kitchenCookLog.notes,
        })
        .from(kitchenCookLog)
        .where(eq(kitchenCookLog.kitchenId, kitchenId))
        .orderBy(asc(kitchenCookLog.position));

      return [
        [...COOK_LOG_COLUMNS],
        ...rows.map((r) => [
          r.timestampText,
          r.recipeTitle,
          r.recipeTitle,
          r.rating === null ? "" : String(r.rating),
          r.notes,
        ]),
      ];
    },

    async append(row: string[]): Promise<number> {
      const timestampText = row[0] ?? "";
      const recipeTitle = (row[1] ?? "").trim();
      if (!recipeTitle) {
        throw new Error("Cook Log row requires a recipe name");
      }
      const cookedDay = timestampText.slice(0, 10);
      const rating = parseRatingCell(row[3]);
      const notes = row[4] ?? "";
      const heldBack = rating !== null ? rating <= 3 : false;

      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${cookLogLockKey(kitchenId)}))`,
        );
        const existing = await tx
          .select({ id: kitchenCookLog.id })
          .from(kitchenCookLog)
          .where(eq(kitchenCookLog.kitchenId, kitchenId));

        await tx.insert(kitchenCookLog).values({
          kitchenId,
          recipeTitle,
          timestampText,
          cookedDay,
          rating,
          notes,
          notePrivate: false,
          heldBack,
          visibilityChosen: false,
        });

        return existing.length + 2;
      });
    },

    async write(row: number, col: number, values: string[]): Promise<void> {
      if (!Number.isInteger(row) || row < 2) {
        throw new Error(`Cook Log row ${row} does not exist`);
      }

      const [target] = await db
        .select({
          id: kitchenCookLog.id,
          visibilityChosen: kitchenCookLog.visibilityChosen,
        })
        .from(kitchenCookLog)
        .where(eq(kitchenCookLog.kitchenId, kitchenId))
        .orderBy(asc(kitchenCookLog.position))
        .offset(row - 2)
        .limit(1);

      if (!target) {
        throw new Error(`Cook Log row ${row} does not exist`);
      }

      const updates: Partial<typeof kitchenCookLog.$inferInsert> = {};
      for (let i = 0; i < values.length; i++) {
        const targetCol = col + i;
        const val = values[i] ?? "";
        if (targetCol === 1) {
          updates.timestampText = val;
          updates.cookedDay = val.slice(0, 10);
        } else if (targetCol === 2) {
          const trimmed = val.trim();
          if (trimmed) updates.recipeTitle = trimmed;
        } else if (targetCol === 4) {
          const parsed = parseRatingCell(val);
          updates.rating = parsed;
          if (!target.visibilityChosen) {
            updates.heldBack = parsed !== null ? parsed <= 3 : false;
          }
        } else if (targetCol === 5) {
          updates.notes = val;
          updates.noteUpdatedAt = new Date();
        }
      }

      if (Object.keys(updates).length === 0) return;

      await db
        .update(kitchenCookLog)
        .set(updates)
        .where(
          and(
            eq(kitchenCookLog.kitchenId, kitchenId),
            eq(kitchenCookLog.id, target.id),
          ),
        );
    },

    async appendCookEntry(input: DbCookEntryInput): Promise<CookLogRef> {
      const recipeName = input.name.trim();
      if (!recipeName) throw new Error("no recipe name");
      const timestamp = cookLogTimestamp(input.at);
      const cookedDay = timestamp.slice(0, 10);

      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${cookLogLockKey(kitchenId)}))`,
        );
        const rows = await tx
          .select({
            id: kitchenCookLog.id,
            timestampText: kitchenCookLog.timestampText,
            recipeTitle: kitchenCookLog.recipeTitle,
            recipeIsPrivate: kitchenCookLog.recipeIsPrivate,
          })
          .from(kitchenCookLog)
          .where(eq(kitchenCookLog.kitchenId, kitchenId))
          .orderBy(asc(kitchenCookLog.position));

        const gridRows = [
          [...COOK_LOG_COLUMNS],
          ...rows.map((r) => [r.timestampText, r.recipeTitle, r.recipeTitle, "", ""]),
        ];
        const adopted = adoptableRow(gridRows, recipeName, timestamp);
        if (adopted) {
          const target = rows[adopted.row - 2];
          if (target) {
            await tx
              .update(kitchenCookLog)
              .set({
                queueId: input.queueId,
                docRecipeId: input.docRecipeId,
                packSource: input.packSource,
                sourceKitchenPackId: input.sourceKitchenPackId,
                recipeIsPrivate: Boolean(target.recipeIsPrivate || input.recipeIsPrivate),
                recipeSnapshot: input.recipeSnapshot,
                cookedByMemberId: input.cookedByMemberId,
                cookedAt: input.at,
              })
              .where(
                and(
                  eq(kitchenCookLog.kitchenId, kitchenId),
                  eq(kitchenCookLog.id, target.id),
                ),
              );
          }
          return adopted;
        }

        await tx.insert(kitchenCookLog).values({
          kitchenId,
          queueId: input.queueId,
          docRecipeId: input.docRecipeId,
          packSource: input.packSource,
          sourceKitchenPackId: input.sourceKitchenPackId,
          recipeIsPrivate: input.recipeIsPrivate,
          recipeSnapshot: input.recipeSnapshot,
          recipeTitle: recipeName,
          timestampText: timestamp,
          cookedDay,
          cookedAt: input.at,
          cookedByMemberId: input.cookedByMemberId,
          rating: null,
          notes: "",
          notePrivate: false,
          heldBack: false,
          visibilityChosen: false,
        });

        return {
          row: rows.length + 2,
          timestamp,
          recipeName,
          adopted: false,
        };
      });
    },

    async rateCookEntry(
      log: CookLogRef,
      input: DbRateCookEntryInput,
    ): Promise<CookLogRef> {
      if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
        throw new Error(`Invalid rating: ${input.rating}`);
      }

      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${cookLogLockKey(kitchenId)}))`,
        );
        const rows = await tx
          .select({
            id: kitchenCookLog.id,
            timestampText: kitchenCookLog.timestampText,
            recipeTitle: kitchenCookLog.recipeTitle,
            visibilityChosen: kitchenCookLog.visibilityChosen,
          })
          .from(kitchenCookLog)
          .where(eq(kitchenCookLog.kitchenId, kitchenId))
          .orderBy(asc(kitchenCookLog.position));

        const gridRows = [
          [...COOK_LOG_COLUMNS],
          ...rows.map((r) => [
            r.timestampText,
            r.recipeTitle,
            r.recipeTitle,
            "",
            "",
          ]),
        ];
        const rowNum = cookRow(gridRows, log);
        const target = rows[rowNum - 2];
        if (
          !target ||
          target.timestampText !== log.timestamp ||
          normalizeRecipeName(target.recipeTitle) !==
            normalizeRecipeName(log.recipeName)
        ) {
          throw new Error(`Cook Log row ${rowNum} no longer holds ${log.recipeName}`);
        }

        const trimmedNote = input.notes?.trim();
        const updates: Partial<typeof kitchenCookLog.$inferInsert> = {
          queueId: input.queueId,
          docRecipeId: input.docRecipeId,
          packSource: input.packSource,
          sourceKitchenPackId: input.sourceKitchenPackId,
          recipeIsPrivate: input.recipeIsPrivate,
          recipeSnapshot: input.recipeSnapshot,
          cookedByMemberId: input.cookedByMemberId,
          cookedAt: input.cookedAt,
          rating: input.rating,
        };
        if (trimmedNote !== undefined && trimmedNote.length > 0) {
          updates.notes = trimmedNote;
          updates.noteUpdatedAt = new Date();
        }
        if (input.notePrivate !== undefined) {
          updates.notePrivate = input.notePrivate;
        }
        if (input.heldBack !== undefined) {
          updates.heldBack = input.heldBack;
          updates.visibilityChosen = true;
        } else if (!target.visibilityChosen) {
          updates.heldBack = input.rating <= 3;
        }

        await tx
          .update(kitchenCookLog)
          .set(updates)
          .where(
            and(
              eq(kitchenCookLog.kitchenId, kitchenId),
              eq(kitchenCookLog.id, target.id),
            ),
          );

        return { ...log, row: rowNum };
      });
    },
  };
}
