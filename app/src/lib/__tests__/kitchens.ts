import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  AnyPgColumn,
  PgDatabase,
  PgQueryResultHKT,
  PgTable,
} from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import {
  kitchenQueue,
  kitchens,
  kitchenWebhookTokens,
} from "../../../drizzle/schema";
import { db as defaultDb } from "../db";
import { appRouter } from "../../server/routers/_app";
import type { KitchenContext, MemberContext } from "../../server/trpc";

export type KitchenRow = typeof kitchens.$inferSelect;
export type KitchenQueueRow = typeof kitchenQueue.$inferSelect;
export type TestDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface SeedKitchenInput {
  slug: string;
  name: string;
  aiMonthlyCapMicros?: number | null;
}

/**
 * Inserts a kitchen row for tests.
 */
export async function seedKitchen(
  db: TestDb,
  input: SeedKitchenInput,
): Promise<{ kitchen: KitchenRow }> {
  const [kitchen] = await db
    .insert(kitchens)
    .values({
      slug: input.slug,
      name: input.name,
      aiMonthlyCapMicros: input.aiMonthlyCapMicros ?? null,
    })
    .returning();

  if (!kitchen) {
    throw new Error(`Failed to insert kitchen "${input.slug}"`);
  }

  return { kitchen };
}

/**
 * Returns the default `home` kitchen created by migration 0001.
 */
export async function homeKitchen(db: TestDb): Promise<KitchenRow> {
  const [home] = await db
    .select()
    .from(kitchens)
    .where(eq(kitchens.slug, "home"))
    .limit(1);

  if (!home) {
    throw new Error(
      'Default "home" kitchen not found; ensure migrations through 0001 have been applied',
    );
  }

  return home;
}

/**
 * Builds an `appRouter` caller scoped to the given kitchen and optional member,
 * matching the context `kitchenProcedure` provides.
 */
export function callerFor(
  kitchen: Pick<KitchenContext, "id" | "slug">,
  member: MemberContext | null = null,
) {
  return appRouter.createCaller({
    db: defaultDb,
    headers: new Headers(),
    kitchen: { id: kitchen.id, slug: kitchen.slug },
    member,
  });
}

/**
 * Inserts a queue row owned by the given kitchen.
 */
export async function seedQueueRow(
  db: TestDb,
  kitchenId: string,
  overrides: Partial<typeof kitchenQueue.$inferInsert> = {},
): Promise<KitchenQueueRow> {
  const [row] = await db
    .insert(kitchenQueue)
    .values({
      kitchenId,
      recipeData: { name: "Test Recipe" },
      status: "pending",
      ...overrides,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to insert kitchen_queue row");
  }

  return row;
}

/**
 * Mints a webhook bearer token for a kitchen, stores only its SHA-256 hex
 * digest, and returns the plaintext token.
 */
export async function mintToken(
  db: TestDb,
  kitchenId: string,
  label = "test",
): Promise<string> {
  const token = `sous_${randomBytes(32).toString("base64url")}`;
  const tokenSha256 = createHash("sha256").update(token).digest("hex");

  await db.insert(kitchenWebhookTokens).values({
    kitchenId,
    tokenSha256,
    label,
  });

  return token;
}

type TableWithId = PgTable & { id: AnyPgColumn };

/**
 * Reads a full row by id so tests can assert that another kitchen's data is
 * byte-for-byte unchanged.
 */
export async function snapshotRow<T extends TableWithId>(
  db: TestDb,
  table: T,
  id: string,
): Promise<T["$inferSelect"] | null> {
  const rows = await db
    .select()
    .from(table as PgTable)
    .where(eq(table.id, id))
    .limit(1);

  return (rows[0] as T["$inferSelect"] | undefined) ?? null;
}
