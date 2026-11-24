import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { assertLocalDatabase } from "./env";
import { FORBIDDEN_ENV_FILES, findForbiddenEnvFiles } from "./serve";

describe("ENV-1: assertLocalDatabase", () => {
  it("accepts 127.0.0.1 and localhost database URLs", () => {
    expect(
      assertLocalDatabase(
        "postgres://postgres@127.0.0.1:55731/sous_e2e",
      ).hostname,
    ).toBe("127.0.0.1");
    expect(
      assertLocalDatabase(
        "postgres://postgres@localhost:5432/sous_test",
      ).hostname,
    ).toBe("localhost");
  });

  it("rejects non-local hosts, including hosts containing 127.0.0.1 as a substring", () => {
    expect(() =>
      assertLocalDatabase("postgres://db.example.com:5432/sous"),
    ).toThrow(/non-local database host/);
    expect(() =>
      assertLocalDatabase("postgres://127.0.0.1.example.com:5432/sous"),
    ).toThrow(/non-local database host/);
    expect(() =>
      assertLocalDatabase("postgres://localhost.example.com:5432/sous"),
    ).toThrow(/non-local database host/);
  });

  it("does not echo credentials in the error message for a rejected non-local host", () => {
    const secretPassword = "refused-host-secret";
    const remoteUrl = new URL("postgres://db.example.com:5432/sous");
    remoteUrl.username = "postgres";
    remoteUrl.password = secretPassword;

    let caught: Error | null = null;
    try {
      assertLocalDatabase(remoteUrl.toString());
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toMatch(/non-local database host/);
    expect(caught!.message).not.toContain(secretPassword);
  });

  it("rejects unparseable URLs without echoing the input string", () => {
    const secretBadUrl = "not a url with secret-token-value";
    let caught: Error | null = null;
    try {
      assertLocalDatabase(secretBadUrl);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).not.toContain("secret-token-value");
    expect(caught!.message).not.toContain(secretBadUrl);
  });
});

describe("ENV-2: findForbiddenEnvFiles", () => {
  const expectedFiles = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ] as const;

  it("returns an empty list for an empty temporary directory", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sous-e2e-env-"));
    try {
      expect(findForbiddenEnvFiles(tmpDir)).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects each of the four forbidden Next.js env file names when present", () => {
    for (const fileName of expectedFiles) {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sous-e2e-env-"));
      try {
        writeFileSync(path.join(tmpDir, fileName), "TEST_KEY=1\n", "utf8");
        expect(findForbiddenEnvFiles(tmpDir)).toEqual([fileName]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
    expect(FORBIDDEN_ENV_FILES).toHaveLength(4);
  });
});

describe("ENV-3: environment overrides for ports and container name", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadFreshEnv() {
    vi.resetModules();
    return import("./env");
  }

  it("uses the defaults when all three variables are unset or empty", async () => {
    vi.stubEnv("E2E_APP_PORT", undefined);
    vi.stubEnv("E2E_PG_PORT", undefined);
    vi.stubEnv("E2E_PG_CONTAINER", undefined);

    const unsetEnv = await loadFreshEnv();
    expect(unsetEnv.E2E_APP_PORT).toBe(4131);
    expect(unsetEnv.E2E_PG_PORT).toBe(55731);
    expect(unsetEnv.E2E_PG_CONTAINER).toBe("rails-pg");
    expect(unsetEnv.E2E_BASE_URL).toBe("http://127.0.0.1:4131");
    expect(unsetEnv.E2E_DATABASE_URL).toBe(
      "postgres://postgres@127.0.0.1:55731/sous_e2e",
    );

    vi.stubEnv("E2E_APP_PORT", "");
    vi.stubEnv("E2E_PG_PORT", "");
    vi.stubEnv("E2E_PG_CONTAINER", "");

    const emptyEnv = await loadFreshEnv();
    expect(emptyEnv.E2E_APP_PORT).toBe(4131);
    expect(emptyEnv.E2E_PG_PORT).toBe(55731);
    expect(emptyEnv.E2E_PG_CONTAINER).toBe("rails-pg");
    expect(emptyEnv.E2E_BASE_URL).toBe("http://127.0.0.1:4131");
    expect(emptyEnv.E2E_DATABASE_URL).toBe(
      "postgres://postgres@127.0.0.1:55731/sous_e2e",
    );
  });

  it("applies overrides to constants, E2E_BASE_URL, and E2E_DATABASE_URL", async () => {
    vi.stubEnv("E2E_APP_PORT", "4141");
    vi.stubEnv("E2E_PG_PORT", undefined);
    vi.stubEnv("E2E_PG_CONTAINER", undefined);
    const appOnly = await loadFreshEnv();
    expect(appOnly.E2E_APP_PORT).toBe(4141);
    expect(appOnly.E2E_BASE_URL).toBe("http://127.0.0.1:4141");
    expect(appOnly.E2E_PG_PORT).toBe(55731);
    expect(appOnly.E2E_PG_CONTAINER).toBe("rails-pg");

    vi.stubEnv("E2E_APP_PORT", undefined);
    vi.stubEnv("E2E_PG_PORT", "55741");
    vi.stubEnv("E2E_PG_CONTAINER", undefined);
    const pgPortOnly = await loadFreshEnv();
    expect(pgPortOnly.E2E_PG_PORT).toBe(55741);
    expect(pgPortOnly.E2E_DATABASE_URL).toBe(
      "postgres://postgres@127.0.0.1:55741/sous_e2e",
    );
    expect(pgPortOnly.E2E_APP_PORT).toBe(4131);

    vi.stubEnv("E2E_APP_PORT", undefined);
    vi.stubEnv("E2E_PG_PORT", undefined);
    vi.stubEnv("E2E_PG_CONTAINER", "port_pg.2-test");
    const containerOnly = await loadFreshEnv();
    expect(containerOnly.E2E_PG_CONTAINER).toBe("port_pg.2-test");

    vi.stubEnv("E2E_APP_PORT", "1024");
    vi.stubEnv("E2E_PG_PORT", "65535");
    vi.stubEnv("E2E_PG_CONTAINER", "port-pg");
    const allBoundaries = await loadFreshEnv();
    expect(allBoundaries.E2E_APP_PORT).toBe(1024);
    expect(allBoundaries.E2E_BASE_URL).toBe("http://127.0.0.1:1024");
    expect(allBoundaries.E2E_PG_PORT).toBe(65535);
    expect(allBoundaries.E2E_DATABASE_URL).toBe(
      "postgres://postgres@127.0.0.1:65535/sous_e2e",
    );
    expect(allBoundaries.E2E_PG_CONTAINER).toBe("port-pg");
  });

  it("throws naming E2E_APP_PORT for invalid app ports", async () => {
    const invalidPorts = [
      "abc",
      "0",
      "1023",
      "65536",
      "-4131",
      "4131.5",
      "04131",
      " 4131",
      "   ",
    ];
    for (const bad of invalidPorts) {
      vi.stubEnv("E2E_APP_PORT", bad);
      vi.stubEnv("E2E_PG_PORT", undefined);
      vi.stubEnv("E2E_PG_CONTAINER", undefined);
      await expect(loadFreshEnv()).rejects.toThrow(/E2E_APP_PORT/);
    }
  });

  it("throws naming E2E_PG_PORT for invalid database ports", async () => {
    const invalidPorts = [
      "abc",
      "0",
      "1023",
      "65536",
      "-55731",
      "55731.5",
      "055731",
      "55731 ",
      "   ",
    ];
    for (const bad of invalidPorts) {
      vi.stubEnv("E2E_APP_PORT", undefined);
      vi.stubEnv("E2E_PG_PORT", bad);
      vi.stubEnv("E2E_PG_CONTAINER", undefined);
      await expect(loadFreshEnv()).rejects.toThrow(/E2E_PG_PORT/);
    }
  });

  it("throws naming E2E_PG_CONTAINER for invalid container names", async () => {
    const invalidContainers = [
      "bad name",
      "-leading-dash",
      ".leading-dot",
      "_leading-underscore",
      "bad/slash",
      "bad:colon",
      "   ",
    ];
    for (const bad of invalidContainers) {
      vi.stubEnv("E2E_APP_PORT", undefined);
      vi.stubEnv("E2E_PG_PORT", undefined);
      vi.stubEnv("E2E_PG_CONTAINER", bad);
      await expect(loadFreshEnv()).rejects.toThrow(/E2E_PG_CONTAINER/);
    }
  });
});
