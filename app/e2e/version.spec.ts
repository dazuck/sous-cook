import { test, expect } from "./fixtures";

const FULL_COMMIT_RE = /^[0-9a-f]{40}$/;

test.describe("Version endpoint", () => {
  test("VERSION-2: GET /api/version answers 200 with only commit and matches SOUS_RELEASE_COMMIT when set", async ({
    page,
  }) => {
    const response = await page.request.get("/api/version");
    expect(response.status()).toBe(200);

    const body: unknown = await response.json();
    expect(body).not.toBeNull();
    expect(typeof body).toBe("object");
    expect(Array.isArray(body)).toBe(false);

    const record = body as Record<string, unknown>;
    expect(Object.keys(record)).toEqual(["commit"]);

    const { commit } = record;
    if (commit !== null) {
      expect(typeof commit).toBe("string");
      expect(commit).toMatch(FULL_COMMIT_RE);
    }

    const expectedCommit = process.env.SOUS_RELEASE_COMMIT;
    if (expectedCommit !== undefined && expectedCommit !== "") {
      expect(commit).toBe(expectedCommit);
    }
  });
});
