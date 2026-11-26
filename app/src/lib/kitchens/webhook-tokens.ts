import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import { db, kitchens, kitchenWebhookTokens } from "@/lib/db";
import { DeploymentConfigError, ensureDeploymentReady } from "./deployment";

const TOKEN_PREFIX = "sous_";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_LIVE_WEBHOOK_TOKENS_PER_KITCHEN = 10;
export const WEBHOOK_TOKEN_LABEL_MAX_LENGTH = 80;

export type WebhookTokenDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export type WebhookTokenErrorCode =
  | "invalid-label"
  | "limit-reached"
  | "invalid-id"
  | "not-found"
  | "already-revoked";

export class WebhookTokenError extends Error {
  constructor(
    readonly code: WebhookTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebhookTokenError";
  }
}

export interface MintedWebhookToken {
  id: string;
  kitchenSlug: string;
  kitchenName: string;
  label: string;
  createdAt: Date;
  /** Plaintext bearer token, returned once and never stored. */
  token: string;
}

export interface KitchenWebhookTokenSummary {
  id: string;
  kitchenSlug: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface RevokedKitchenWebhookToken {
  id: string;
  kitchenSlug: string;
  label: string;
  revokedAt: Date;
}

/** Computes the lowercase hex SHA-256 digest of a webhook bearer token. */
export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Generates a fresh webhook bearer token (`sous_` + 32 random bytes in
 * base64url) along with the SHA-256 hex digest stored in the database.
 */
export function generateWebhookToken(): { token: string; tokenSha256: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenSha256: hashWebhookToken(token) };
}

function parseTokenLabel(raw: string): string {
  const label = raw.trim();
  if (!label) {
    throw new WebhookTokenError("invalid-label", "Token label is required.");
  }
  if ([...label].length > WEBHOOK_TOKEN_LABEL_MAX_LENGTH) {
    throw new WebhookTokenError(
      "invalid-label",
      `Token label must be ${WEBHOOK_TOKEN_LABEL_MAX_LENGTH} characters or fewer.`,
    );
  }
  return label;
}

/**
 * Mints a new webhook token for a kitchen inside a transaction that locks the
 * kitchen row `FOR UPDATE`, enforcing the 10-live-token cap per kitchen.
 */
export async function mintKitchenWebhookToken(
  input: { kitchenId: string; label: string },
  database: WebhookTokenDb = db,
): Promise<MintedWebhookToken> {
  const label = parseTokenLabel(input.label);

  return database.transaction(async (tx) => {
    const [kitchen] = await tx
      .select({ id: kitchens.id, slug: kitchens.slug, name: kitchens.name })
      .from(kitchens)
      .where(eq(kitchens.id, input.kitchenId))
      .for("update");

    if (!kitchen) {
      throw new WebhookTokenError("not-found", "Kitchen not found.");
    }

    const liveTokens = await tx
      .select({ id: kitchenWebhookTokens.id })
      .from(kitchenWebhookTokens)
      .where(
        and(
          eq(kitchenWebhookTokens.kitchenId, kitchen.id),
          isNull(kitchenWebhookTokens.revokedAt),
        ),
      );

    if (liveTokens.length >= MAX_LIVE_WEBHOOK_TOKENS_PER_KITCHEN) {
      throw new WebhookTokenError(
        "limit-reached",
        `This kitchen already has ${MAX_LIVE_WEBHOOK_TOKENS_PER_KITCHEN} live tokens. Revoke one before making another.`,
      );
    }

    const { token, tokenSha256 } = generateWebhookToken();
    const [inserted] = await tx
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
  });
}

/**
 * Lists webhook tokens (for one kitchen or across all kitchens, optionally
 * filtering to live unrevoked tokens only). Never returns the token or its digest.
 */
export async function listKitchenWebhookTokens(
  options: { kitchenId?: string; includeRevoked?: boolean } = {},
  database: WebhookTokenDb = db,
): Promise<KitchenWebhookTokenSummary[]> {
  const includeRevoked = options.includeRevoked ?? false;
  const conditions = [];
  if (options.kitchenId !== undefined) {
    conditions.push(eq(kitchenWebhookTokens.kitchenId, options.kitchenId));
  }
  if (!includeRevoked) {
    conditions.push(isNull(kitchenWebhookTokens.revokedAt));
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

  const filtered =
    conditions.length === 0
      ? query
      : conditions.length === 1
        ? query.where(conditions[0])
        : query.where(and(...conditions));

  return options.kitchenId !== undefined
    ? filtered.orderBy(asc(kitchenWebhookTokens.createdAt))
    : filtered.orderBy(asc(kitchens.slug), asc(kitchenWebhookTokens.createdAt));
}

/**
 * Revokes a single webhook token by id. When `kitchenId` is provided, restricts
 * lookup and update to that kitchen so callers cannot probe or revoke another
 * kitchen's tokens.
 */
export async function revokeKitchenWebhookToken(
  input: { id: string; kitchenId?: string },
  database: WebhookTokenDb = db,
): Promise<RevokedKitchenWebhookToken> {
  const id = input.id.trim();
  if (!UUID_PATTERN.test(id)) {
    throw new WebhookTokenError("invalid-id", `Invalid token id "${id}".`);
  }

  const lookupCondition =
    input.kitchenId !== undefined
      ? and(
          eq(kitchenWebhookTokens.id, id),
          eq(kitchenWebhookTokens.kitchenId, input.kitchenId),
        )
      : eq(kitchenWebhookTokens.id, id);

  const [existing] = await database
    .select({
      id: kitchenWebhookTokens.id,
      label: kitchenWebhookTokens.label,
      revokedAt: kitchenWebhookTokens.revokedAt,
      kitchenSlug: kitchens.slug,
    })
    .from(kitchenWebhookTokens)
    .innerJoin(kitchens, eq(kitchenWebhookTokens.kitchenId, kitchens.id))
    .where(lookupCondition)
    .limit(1);

  if (!existing) {
    throw new WebhookTokenError("not-found", `Webhook token "${id}" not found.`);
  }
  if (existing.revokedAt !== null) {
    throw new WebhookTokenError(
      "already-revoked",
      `Webhook token "${id}" (${existing.kitchenSlug}, "${existing.label}") was already revoked at ${existing.revokedAt.toISOString()}.`,
    );
  }

  const updateCondition =
    input.kitchenId !== undefined
      ? and(
          eq(kitchenWebhookTokens.id, id),
          eq(kitchenWebhookTokens.kitchenId, input.kitchenId),
          isNull(kitchenWebhookTokens.revokedAt),
        )
      : and(
          eq(kitchenWebhookTokens.id, id),
          isNull(kitchenWebhookTokens.revokedAt),
        );

  const [updated] = await database
    .update(kitchenWebhookTokens)
    .set({ revokedAt: sql`now()` })
    .where(updateCondition)
    .returning({ revokedAt: kitchenWebhookTokens.revokedAt });

  if (!updated?.revokedAt) {
    throw new WebhookTokenError(
      "already-revoked",
      `Webhook token "${id}" is already revoked.`,
    );
  }

  return {
    id: existing.id,
    kitchenSlug: existing.kitchenSlug,
    label: existing.label,
    revokedAt: updated.revokedAt,
  };
}

/** Extracts a non-empty Bearer token from the Authorization header, or null. */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export type WebhookAuthResult =
  | {
      ok: true;
      kitchen: { id: string; slug: string };
      tokenId: string;
    }
  | {
      ok: false;
      response: Response;
    };

function unauthorized(): WebhookAuthResult {
  return {
    ok: false,
    response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  };
}

/**
 * Authenticates a webhook request by hashing its `Authorization: Bearer` token
 * and matching an unrevoked row in `kitchen_webhook_tokens`. Required in every
 * environment because the token identifies which kitchen the request belongs to.
 * Updates `last_used_at` on each accepted call.
 */
export async function authenticateWebhookRequest(
  request: Request,
): Promise<WebhookAuthResult> {
  try {
    await ensureDeploymentReady(db);
  } catch (err) {
    if (err instanceof DeploymentConfigError) {
      return {
        ok: false,
        response: NextResponse.json({ error: err.message }, { status: 500 }),
      };
    }
    throw err;
  }

  const token = extractBearerToken(request);
  if (!token) return unauthorized();

  const tokenSha256 = hashWebhookToken(token);
  const [matched] = await db
    .update(kitchenWebhookTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(kitchenWebhookTokens.tokenSha256, tokenSha256),
        isNull(kitchenWebhookTokens.revokedAt),
      ),
    )
    .returning({
      id: kitchenWebhookTokens.id,
      kitchenId: kitchenWebhookTokens.kitchenId,
    });

  if (!matched) return unauthorized();

  const [kitchen] = await db
    .select({ id: kitchens.id, slug: kitchens.slug })
    .from(kitchens)
    .where(eq(kitchens.id, matched.kitchenId))
    .limit(1);

  if (!kitchen) return unauthorized();

  return {
    ok: true,
    kitchen: { id: kitchen.id, slug: kitchen.slug },
    tokenId: matched.id,
  };
}
