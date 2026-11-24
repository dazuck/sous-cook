import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, dynamic } from "./route";

const TRACKED_ENV_KEYS = [
  "SOUS_RELEASE_COMMIT",
  "SOUS_SIGN_IN",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SOUS_AI_KITCHEN_CAP_USD",
  "SOUS_AI_TOTAL_CAP_USD",
] as const;

const VALID_COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("GET /api/version", () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    savedEnv.clear();
    for (const key of TRACKED_ENV_KEYS) {
      savedEnv.set(
        key,
        Object.prototype.hasOwnProperty.call(process.env, key)
          ? process.env[key]
          : undefined,
      );
    }
  });

  afterEach(() => {
    for (const key of TRACKED_ENV_KEYS) {
      const prev = savedEnv.get(key);
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  });

  it("VERSION-1: returns only the validated 40-char lowercase hex commit and skips deployment checks", async () => {
    expect(dynamic).toBe("force-static");

    // Valid 40-character lowercase hex commit.
    process.env.SOUS_RELEASE_COMMIT = VALID_COMMIT;
    const validRes = await GET();
    expect(validRes.status).toBe(200);
    const validBody: unknown = await validRes.json();
    expect(validBody).toEqual({ commit: VALID_COMMIT });
    expect(Object.keys(validBody as Record<string, unknown>)).toEqual([
      "commit",
    ]);

    // Unset environment variable returns null.
    delete process.env.SOUS_RELEASE_COMMIT;
    const unsetRes = await GET();
    expect(unsetRes.status).toBe(200);
    const unsetBody: unknown = await unsetRes.json();
    expect(unsetBody).toEqual({ commit: null });
    expect(Object.keys(unsetBody as Record<string, unknown>)).toEqual([
      "commit",
    ]);

    // Malformed values all return null.
    const invalidValues = [
      "",
      "a".repeat(39),
      "a".repeat(41),
      "A".repeat(40),
      "0123456789ABCDEF0123456789abcdef01234567",
      `${"a".repeat(20)} ${"a".repeat(19)}`,
      ` ${"a".repeat(40)}`,
      `${"a".repeat(40)} `,
      "g".repeat(40),
    ];

    for (const value of invalidValues) {
      process.env.SOUS_RELEASE_COMMIT = value;
      const res = await GET();
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toEqual({ commit: null });
      expect(Object.keys(body as Record<string, unknown>)).toEqual(["commit"]);
    }

    // Sign-in mode with no sign-in or database variables still returns 200.
    process.env.SOUS_SIGN_IN = "on";
    delete process.env.DATABASE_URL;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_URL;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.SOUS_AI_KITCHEN_CAP_USD;
    delete process.env.SOUS_AI_TOTAL_CAP_USD;
    process.env.SOUS_RELEASE_COMMIT = VALID_COMMIT;

    const signInRes = await GET();
    expect(signInRes.status).toBe(200);
    const signInBody: unknown = await signInRes.json();
    expect(signInBody).toEqual({ commit: VALID_COMMIT });
    expect(Object.keys(signInBody as Record<string, unknown>)).toEqual([
      "commit",
    ]);
  });
});
