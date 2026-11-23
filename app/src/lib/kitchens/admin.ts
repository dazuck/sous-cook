import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import { db, kitchens, kitchenWebhookTokens } from "../db";
import { generateWebhookToken } from "./webhook-tokens";

export type AdminDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Raised when an operator command cannot proceed (unknown kitchen, missing
 * token, already revoked, invalid input) so the CLI exits 1 with a clear line.
 */
export class KitchenAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitchenAdminError";
  }
}

export interface CreatedWebhookToken {
  id: string;
  kitchenSlug: string;
  kitchenName: string;
  label: string;
  createdAt: Date;
  /** Plaintext bearer token, returned once and never stored. */
  token: string;
}

export interface RevokedWebhookToken {
  id: string;
  kitchenSlug: string;
  label: string;
  revokedAt: Date;
}

export interface ListedWebhookToken {
  id: string;
  kitchenSlug: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

async function requireKitchenBySlug(slug: string, database: AdminDb) {
  const normalized = slug.trim();
  if (!normalized) {
    throw new KitchenAdminError("Kitchen slug is required.");
  }
  const [kitchen] = await database
    .select({ id: kitchens.id, slug: kitchens.slug, name: kitchens.name })
    .from(kitchens)
    .where(eq(kitchens.slug, normalized))
    .limit(1);
  if (!kitchen) {
    throw new KitchenAdminError(`Kitchen "${normalized}" not found.`);
  }
  return kitchen;
}

/**
 * Mints a new webhook bearer token for a kitchen, stores only its SHA-256 hex
 * digest, and returns the plaintext token once.
 */
export async function createWebhookToken(
  input: { kitchenSlug: string; label: string },
  database: AdminDb = db,
): Promise<CreatedWebhookToken> {
  const kitchen = await requireKitchenBySlug(input.kitchenSlug, database);
  const label = input.label.trim();
  if (!label) {
    throw new KitchenAdminError("Token label is required.");
  }

  const { token, tokenSha256 } = generateWebhookToken();
  const [inserted] = await database
    .insert(kitchenWebhookTokens)
    .values({
      kitchenId: kitchen.id,
      tokenSha256,
      label,
    })
    .returning({
      id: kitchenWebhookTokens.id,
      label: kitchenWebhookTokens.label,
      createdAt: kitchenWebhookTokens.createdAt,
    });

  if (!inserted) {
    throw new Error("Failed to insert webhook token.");
  }

  return {
    id: inserted.id,
    kitchenSlug: kitchen.slug,
    kitchenName: kitchen.name,
    label: inserted.label,
    createdAt: inserted.createdAt,
    token,
  };
}

/**
 * Revokes a single webhook token by its id. Refuses if the id is not a UUID,
 * does not exist, or is already revoked.
 */
export async function revokeWebhookToken(
  input: { id: string },
  database: AdminDb = db,
): Promise<RevokedWebhookToken> {
  const id = input.id.trim();
  if (!UUID_PATTERN.test(id)) {
    throw new KitchenAdminError(`Invalid token id "${id}".`);
  }

  const [existing] = await database
    .select({
      id: kitchenWebhookTokens.id,
      label: kitchenWebhookTokens.label,
      revokedAt: kitchenWebhookTokens.revokedAt,
      kitchenSlug: kitchens.slug,
    })
    .from(kitchenWebhookTokens)
    .innerJoin(kitchens, eq(kitchenWebhookTokens.kitchenId, kitchens.id))
    .where(eq(kitchenWebhookTokens.id, id))
    .limit(1);

  if (!existing) {
    throw new KitchenAdminError(`Webhook token "${id}" not found.`);
  }
  if (existing.revokedAt !== null) {
    throw new KitchenAdminError(
      `Webhook token "${id}" (${existing.kitchenSlug}, "${existing.label}") was already revoked at ${existing.revokedAt.toISOString()}.`,
    );
  }

  const [updated] = await database
    .update(kitchenWebhookTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(kitchenWebhookTokens.id, id),
        isNull(kitchenWebhookTokens.revokedAt),
      ),
    )
    .returning({ revokedAt: kitchenWebhookTokens.revokedAt });

  if (!updated?.revokedAt) {
    throw new KitchenAdminError(`Webhook token "${id}" is already revoked.`);
  }

  return {
    id: existing.id,
    kitchenSlug: existing.kitchenSlug,
    label: existing.label,
    revokedAt: updated.revokedAt,
  };
}

/**
 * Lists webhook tokens (all kitchens, or one kitchen when `kitchenSlug` is
 * given). Never returns the token or its digest.
 */
export async function listWebhookTokens(
  input: { kitchenSlug?: string } = {},
  database: AdminDb = db,
): Promise<ListedWebhookToken[]> {
  let kitchenIdFilter: string | null = null;
  if (input.kitchenSlug !== undefined) {
    const kitchen = await requireKitchenBySlug(input.kitchenSlug, database);
    kitchenIdFilter = kitchen.id;
  }

  const query = database
    .select({
      id: kitchenWebhookTokens.id,
      kitchenSlug: kitchens.slug,
      label: kitchenWebhookTokens.label,
      createdAt: kitchenWebhookTokens.createdAt,
      lastUsedAt: kitchenWebhookTokens.lastUsedAt,
      revokedAt: kitchenWebhookTokens.revokedAt,
    })
    .from(kitchenWebhookTokens)
    .innerJoin(kitchens, eq(kitchenWebhookTokens.kitchenId, kitchens.id));

  const rows =
    kitchenIdFilter !== null
      ? await query
          .where(eq(kitchenWebhookTokens.kitchenId, kitchenIdFilter))
          .orderBy(asc(kitchenWebhookTokens.createdAt))
      : await query.orderBy(
          asc(kitchens.slug),
          asc(kitchenWebhookTokens.createdAt),
        );

  return rows;
}
