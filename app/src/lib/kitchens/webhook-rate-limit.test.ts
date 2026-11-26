import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WEBHOOK_RATE_LIMIT_PER_MIN,
  WEBHOOK_RATE_LIMIT_WINDOW_MS,
  checkWebhookRateLimit,
  readWebhookRateLimitPerMin,
  resetWebhookRateLimitsForTests,
} from "./webhook-rate-limit";

describe("webhook-rate-limit", () => {
  beforeEach(() => {
    resetWebhookRateLimitsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 120 requests per minute when SOUS_WEBHOOK_RATE_LIMIT_PER_MIN is unset", () => {
    vi.stubEnv("SOUS_WEBHOOK_RATE_LIMIT_PER_MIN", "");
    expect(readWebhookRateLimitPerMin()).toBe(DEFAULT_WEBHOOK_RATE_LIMIT_PER_MIN);
    expect(DEFAULT_WEBHOOK_RATE_LIMIT_PER_MIN).toBe(120);
  });

  it("reads a positive integer from SOUS_WEBHOOK_RATE_LIMIT_PER_MIN and rejects invalid values", () => {
    vi.stubEnv("SOUS_WEBHOOK_RATE_LIMIT_PER_MIN", "5");
    expect(readWebhookRateLimitPerMin()).toBe(5);

    vi.stubEnv("SOUS_WEBHOOK_RATE_LIMIT_PER_MIN", "0");
    expect(() => readWebhookRateLimitPerMin()).toThrow(
      /Invalid SOUS_WEBHOOK_RATE_LIMIT_PER_MIN/,
    );

    vi.stubEnv("SOUS_WEBHOOK_RATE_LIMIT_PER_MIN", "abc");
    expect(() => readWebhookRateLimitPerMin()).toThrow(
      /Invalid SOUS_WEBHOOK_RATE_LIMIT_PER_MIN/,
    );
  });

  it("allows up to the limit within the window and refuses the next request with 429 + Retry-After", async () => {
    const start = 1_700_000_000_000;
    const kitchenId = "kitchen-a";

    const first = checkWebhookRateLimit(kitchenId, { limit: 3, nowMs: start });
    const second = checkWebhookRateLimit(kitchenId, { limit: 3, nowMs: start + 1_000 });
    const third = checkWebhookRateLimit(kitchenId, { limit: 3, nowMs: start + 2_000 });

    expect(first).toEqual({ ok: true, remaining: 2 });
    expect(second).toEqual({ ok: true, remaining: 1 });
    expect(third).toEqual({ ok: true, remaining: 0 });

    const fourth = checkWebhookRateLimit(kitchenId, { limit: 3, nowMs: start + 10_000 });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.retryAfterSeconds).toBe(50);
      expect(fourth.response.status).toBe(429);
      expect(fourth.response.headers.get("Retry-After")).toBe("50");
      expect(await fourth.response.json()).toEqual({
        error: "rate_limit_exceeded",
        message: "Too many requests. Try again shortly.",
        retryAfterSeconds: 50,
      });
    }

    // Rejected requests must not consume future slots; once the first timestamp
    // ages out of the 60s window, exactly one slot opens.
    const afterExpiry = checkWebhookRateLimit(kitchenId, {
      limit: 3,
      nowMs: start + WEBHOOK_RATE_LIMIT_WINDOW_MS,
    });
    expect(afterExpiry).toEqual({ ok: true, remaining: 0 });
  });

  it("isolates buckets per kitchen so one kitchen hitting 429 never limits another", () => {
    const now = 1_700_000_000_000;
    expect(checkWebhookRateLimit("kitchen-a", { limit: 1, nowMs: now }).ok).toBe(true);
    expect(checkWebhookRateLimit("kitchen-a", { limit: 1, nowMs: now + 10 }).ok).toBe(false);

    const kitchenB = checkWebhookRateLimit("kitchen-b", { limit: 1, nowMs: now + 10 });
    expect(kitchenB).toEqual({ ok: true, remaining: 0 });
  });
});
