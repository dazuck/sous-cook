import { eq } from "drizzle-orm";
import { db, kitchens } from "@/lib/db";
import type { HouseholdContext } from "./types";

/**
 * Per-kitchen Household Context backed by `kitchens.about`.
 */
export function dbHouseholdContext(kitchenId: string): HouseholdContext {
  return {
    async read(): Promise<string> {
      const [row] = await db
        .select({ about: kitchens.about })
        .from(kitchens)
        .where(eq(kitchens.id, kitchenId))
        .limit(1);
      return row?.about ?? "";
    },
  };
}
