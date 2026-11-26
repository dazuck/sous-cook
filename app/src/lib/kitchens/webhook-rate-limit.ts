import { NextResponse } from "next/server";

export const DEFAULT_WEBHOOK_RATE_LIMIT_PER_MIN = 120;
export const WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;

const requestTimestampsByKitchen = new Map<string, number[]>();

export type WebhookRateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number; response: Response };

/**
 * Reads the per-minute webhook/MCP rate limit from
 * `SOUS_WEBHOOK_RATE_LIMIT_PER_MIN`, defaulting to 120 when unset.
 */
export function readWebhookRateLimitPerMin(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SOUS_WEBHOOK_RATE_LIMIT_PER_MIN?.trim();
  if (!raw) return DEFAULT_WEBHOOK_RATE_LIMIT_PER_MIN;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      `Invalid SOUS_WEBHOOK_RATE_LIMIT_PER_MIN "${raw}": expected a positive integer.`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `Invalid SOUS_WEBHOOK_RATE_LIMIT_PER_MIN "${raw}": expected a positive integer.`,
    );
  }
  return parsed;
}

/**
 * Enforces an in-memory per-kitchen sliding-window rate limit across all
 * bearer-authenticated webhook and MCP routes.
 */
export function checkWebhookRateLimit(
  kitchenId: string,
  options: {
    limit?: number;
    nowMs?: number;
    windowMs?: number;
  } = {},
): WebhookRateLimitResult {
  const limit = options.limit ?? readWebhookRateLimitPerMin();
  const windowMs = options.windowMs ?? WEBHOOK_RATE_LIMIT_WINDOW_MS;
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = nowMs - windowMs;

  const existing = requestTimestampsByKitchen.get(kitchenId);
  const active = existing ? existing.filter((ts) => ts > cutoff) : [];

  if (active.length >= limit) {
    if (active.length > 0) {
      requestTimestampsByKitchen.set(kitchenId, active);
    } else {
      requestTimestampsByKitchen.delete(kitchenId);
    }
    const oldest = active[0] ?? nowMs;
    const retryAfterMs = Math.max(1, oldest + windowMs - nowMs);
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return {
      ok: false,
      retryAfterSeconds,
      response: NextResponse.json(
        {
          error: "rate_limit_exceeded",
          message: "Too many requests. Try again shortly.",
          retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSeconds),
          },
        },
      ),
    };
  }

  active.push(nowMs);
  requestTimestampsByKitchen.set(kitchenId, active);
  return {
    ok: true,
    remaining: limit - active.length,
  };
}

/** Clears all per-kitchen rate-limit buckets (tests). */
export function resetWebhookRateLimitsForTests(): void {
  requestTimestampsByKitchen.clear();
}
