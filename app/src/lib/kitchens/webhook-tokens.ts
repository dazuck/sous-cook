import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, kitchens, kitchenWebhookTokens } from "@/lib/db";
import { DeploymentConfigError, ensureDeploymentReady } from "./deployment";

const TOKEN_PREFIX = "sous_";

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
