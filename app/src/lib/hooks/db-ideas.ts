import { asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import { db, kitchenIdeas } from "@/lib/db";
import type { IdeasStore } from "./types";

export type IdeasDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Per-kitchen Ideas backlog backed by `kitchen_ideas`.
 * Does not touch `recipe_ideas_cache`; `getRecipeIdeas` owns the cache.
 */
export function createDbIdeasStore(
  kitchenId: string,
  database: IdeasDb = db,
): IdeasStore {
  return {
    async readText(): Promise<string> {
      const rows = await database
        .select({ line: kitchenIdeas.line })
        .from(kitchenIdeas)
        .where(eq(kitchenIdeas.kitchenId, kitchenId))
        .orderBy(asc(kitchenIdeas.position));

      if (rows.length === 0) {
        return "";
      }
      return rows.map((row) => row.line).join("\n");
    },

    async append(line: string): Promise<void> {
      const trimmed = line.trim();
      if (!trimmed) {
        throw new Error("Cannot save an empty recipe idea.");
      }
      await database.insert(kitchenIdeas).values({
        kitchenId,
        line: trimmed,
      });
    },
  };
}
