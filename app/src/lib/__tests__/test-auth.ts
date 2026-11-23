import { testUtils } from "better-auth/plugins";
import { vi } from "vitest";
import { createAuth, type AuthDb } from "@/lib/auth/auth";
import { getDb } from "@/lib/db";

/**
 * Made-up test configuration for sign-in mode. Uses example.com and a fake
 * secret/client credentials so tests never hold real credentials.
 */
export const TEST_AUTH_ENV = {
  SOUS_SIGN_IN: "on",
  BETTER_AUTH_SECRET: "test-secret-for-unit-tests-at-least-32-chars",
  BETTER_AUTH_URL: "https://app.example.com",
  GOOGLE_CLIENT_ID: "test-google-client-id.apps.example.com",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  SOUS_AI_KITCHEN_CAP_USD: "2",
  SOUS_AI_TOTAL_CAP_USD: "10",
} as const;

/** Stubs all required sign-in environment variables for a test. */
export function stubSignInEnv(
  overrides: Partial<Record<keyof typeof TEST_AUTH_ENV, string>> = {},
): void {
  const merged = { ...TEST_AUTH_ENV, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    vi.stubEnv(key, value);
  }
}

/**
 * Builds a Better Auth instance from the production factory with Better Auth's
 * `testUtils()` plugin attached. Never used in production code.
 */
export function createTestAuth(database: AuthDb = getDb()) {
  return createAuth({
    db: database,
    secret: process.env.BETTER_AUTH_SECRET || TEST_AUTH_ENV.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL || TEST_AUTH_ENV.BETTER_AUTH_URL,
    googleClientId:
      process.env.GOOGLE_CLIENT_ID || TEST_AUTH_ENV.GOOGLE_CLIENT_ID,
    googleClientSecret:
      process.env.GOOGLE_CLIENT_SECRET || TEST_AUTH_ENV.GOOGLE_CLIENT_SECRET,
    plugins: [testUtils()],
  });
}

/**
 * Creates a real database session through Better Auth's `testUtils()` and
 * returns `Headers` carrying the signed session cookie for `userId`.
 */
export async function signedInHeaders(
  userId: string,
  database: AuthDb = getDb(),
): Promise<Headers> {
  const auth = createTestAuth(database);
  const ctx = await auth.$context;
  return ctx.test.getAuthHeaders({ userId });
}
