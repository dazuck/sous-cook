import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../hooks/types");
  return {
    connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, false])),
  };
});
vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

import * as dbModule from "@/lib/db";
import { db, kitchenQueue, kitchenWebhookTokens } from "@/lib/db";
import { callerFor, seedKitchen } from "@/lib/__tests__/kitchens";
import { stubSignInEnv } from "@/lib/__tests__/test-auth";
import { resetDeploymentCheckForTests } from "./deployment";
import { POST as kitchenQueuePost } from "@/app/api/kitchen-queue/route";
import {
  parseCliArgs,
  runCli,
  validateRecipePayload,
  validateSousUrl,
} from "../../../../skills/sous-kitchen/send-recipe.mjs";

const client = (dbModule as unknown as { client: PGlite }).client;
const SCRIPT_PATH = path.resolve(
  __dirname,
  "../../../../skills/sous-kitchen/send-recipe.mjs",
);

const VALID_RECIPE_PAYLOAD = {
  recipeData: {
    name: "Crispy Chickpea Flatbreads",
    serves: 2,
    ingredients: [
      { item: "chickpeas", amount: "1", unit: "15 oz can" },
      { item: "olive oil", amount: "2", unit: "tbsp" },
      { item: "salt" },
    ],
    steps: ["Roast the chickpeas at 425F for 20 minutes.", "Serve on flatbreads."],
  },
};

function runSubprocess(
  args: string[],
  options: { env?: Record<string, string | undefined>; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT_PATH, ...args],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: process.env.NODE_ENV,
          ...options.env,
        } as NodeJS.ProcessEnv,
        timeout: 15_000,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

let tempDir: string | null = null;
let server: http.Server | null = null;

beforeEach(async () => {
  stubSignInEnv();
  resetDeploymentCheckForTests(db);
  await client.exec(
    "delete from ai_usage; delete from conversation_logs; delete from cook_reports; delete from kitchen_cook_log; delete from doc_recipes; delete from recipe_ideas_cache; delete from kitchen_queue; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home';");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetDeploymentCheckForTests(db);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe("skills/sous-kitchen/send-recipe.mjs validation & CLI rules", () => {
  it("refuses token arguments and unknown flags without echoing secrets", () => {
    expect(() => parseCliArgs(["--token", "sous_secret_123"])).toThrow(
      /Do not pass a token as an argument/,
    );
    expect(() => parseCliArgs(["-t=sous_secret_123"])).toThrow(
      /Do not pass a token as an argument/,
    );
    expect(() => parseCliArgs(["sous_secret_abc"])).toThrow(
      /Do not pass a token as an argument/,
    );
    expect(() => parseCliArgs(["--bogus"])).toThrow(/Unknown option/);
  });

  it("refuses plain http:// except to localhost, 127.0.0.1, or [::1]", () => {
    expect(() => validateSousUrl("http://example.com")).toThrow(
      /Plain http:\/\/ is refused/,
    );
    expect(() => validateSousUrl("http://192.168.1.10:3000")).toThrow(
      /Plain http:\/\/ is refused/,
    );
    expect(() => validateSousUrl("ftp://example.com")).toThrow(/https:\/\//);
    expect(() => validateSousUrl("https://user:pass@example.com")).toThrow(
      /credentials/,
    );

    expect(validateSousUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/api/kitchen-queue",
    );
    expect(validateSousUrl("http://127.0.0.1:4172/")).toBe(
      "http://127.0.0.1:4172/api/kitchen-queue",
    );
    expect(validateSousUrl("http://[::1]:4172")).toBe(
      "http://[::1]:4172/api/kitchen-queue",
    );
    expect(validateSousUrl("https://sous.example.com")).toBe(
      "https://sous.example.com/api/kitchen-queue",
    );
  });

  it("validates Shape 1 and Shape 2 against the webhook contract before sending", () => {
    expect(validateRecipePayload({ pack: "fannie-farmer-1896/waffles" })).toEqual({
      kind: "pack",
      label: "fannie-farmer-1896/waffles",
    });
    expect(
      validateRecipePayload({
        packId: "fannie-farmer-1896",
        recipeId: "waffles",
      }),
    ).toEqual({
      kind: "pack",
      label: "fannie-farmer-1896/waffles",
    });
    expect(validateRecipePayload(VALID_RECIPE_PAYLOAD)).toEqual({
      kind: "recipe",
      label: "Crispy Chickpea Flatbreads",
    });

    expect(() =>
      validateRecipePayload({
        targetUser: "cook",
        ...VALID_RECIPE_PAYLOAD,
      }),
    ).toThrow(/targetUser/);
    expect(() =>
      validateRecipePayload({
        recipeData: { name: "", steps: ["Cook."] },
      }),
    ).toThrow(/name/);
    expect(() =>
      validateRecipePayload({
        recipeData: { name: "Empty", ingredients: [{ item: "  " }], steps: [" "] },
      }),
    ).toThrow(/at least one non-blank ingredient or one non-blank step/);
    expect(() =>
      validateRecipePayload({
        recipeData: { name: "Bad serves", steps: ["Cook."], serves: 0 },
      }),
    ).toThrow(/serves must be a positive number/);
    expect(() =>
      validateRecipePayload({
        recipeData: {
          name: "Bad time",
          steps: ["Cook."],
          estimatedTime: { active: -5 },
        },
      }),
    ).toThrow(/non-negative/);
    expect(() =>
      validateRecipePayload({ recipeNotionId: "notion-123" }),
    ).toThrow(/recipeNotionId/);
    expect(() =>
      validateRecipePayload({ name: "Unwrapped", steps: ["Cook."] }),
    ).toThrow(/wrap the recipe/);
  });

  it("supports --help, --dry-run, and returns non-zero on every documented HTTP error without leaking SOUS_TOKEN", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "sous-send-test-"));
    const recipeFile = path.join(tempDir, "recipe.json");
    writeFileSync(recipeFile, JSON.stringify(VALID_RECIPE_PAYLOAD));

    const helpRes = await runSubprocess(["--help"]);
    expect(helpRes.code).toBe(0);
    expect(helpRes.stdout).toContain("Usage:");

    const dryRunRes = await runSubprocess(["--dry-run", recipeFile], {
      env: {
        SOUS_URL: "https://sous.example.com",
        SOUS_TOKEN: "sous_secret_never_printed",
      },
    });
    expect(dryRunRes.code).toBe(0);
    expect(dryRunRes.stdout.trim().split("\n")).toHaveLength(1);
    expect(dryRunRes.stdout).toContain("Dry run:");
    expect(dryRunRes.stdout).not.toContain("sous_secret_never_printed");
    expect(dryRunRes.stderr).not.toContain("sous_secret_never_printed");

    const statuses: Array<[number, unknown, RegExp]> = [
      [400, { error: "Validation error" }, /Refused \(400\)/],
      [401, { error: "Unauthorized" }, /Unauthorized \(401\)/],
      [404, { error: "Pack or recipe not found" }, /Not found \(404\)/],
      [
        422,
        {
          error: "Recipe can't be read as a pack recipe",
          issues: [{ path: "title", message: "Too small" }],
        },
        /Unreadable recipe \(422\)/,
      ],
      [
        429,
        {
          error: "ai_allowance_used",
          message: "Monthly AI cap reached.",
          resetsAt: "2026-12-01T00:00:00.000Z",
        },
        /Monthly AI allowance used \(429\)/,
      ],
      [
        429,
        {
          error: "rate_limit_exceeded",
          message: "Too many webhook requests; retry shortly.",
        },
        /Rate limit exceeded \(429\): Too many webhook requests; retry shortly\./,
      ],
      [
        503,
        {
          error: "Couldn't work out how many this serves, so nothing was queued",
          reason: "GOOGLE_AI_API_KEY is not set",
        },
        /Service unavailable \(503\)/,
      ],
      [500, { error: "Failed to queue recipe" }, /Server error \(500\)/],
    ];

    for (const [status, body, pattern] of statuses) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(
        [recipeFile],
        {
          NODE_ENV: process.env.NODE_ENV,
          SOUS_URL: "https://sous.example.com",
          SOUS_TOKEN: "sous_secret_never_printed",
        } as NodeJS.ProcessEnv,
        {
          stdout: (l: string) => {
            stdout.push(l);
          },
          stderr: (l: string) => {
            stderr.push(l);
          },
          fetchImpl: async () =>
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            }),
          isStdinTTY: true,
        },
      );
      expect(code).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toMatch(pattern);
      expect(stderr[0]).not.toContain("sous_secret_never_printed");
    }
  });
});

describe("skills/sous-kitchen/send-recipe.mjs live HTTP integration", () => {
  it("queues a recipe using an owner-created token, updates lastUsedAt, and fails with 401 after revocation", async () => {
    const { kitchen, member } = await seedKitchen(db, {
      slug: "cedar",
      name: "Cedar Kitchen",
      email: "owner@example.com",
    });
    const ownerCaller = callerFor(kitchen, {
      id: member.id,
      role: member.role,
    });
    const created = await ownerCaller.createKitchenWebhookToken({
      label: "Local script",
    });

    server = http.createServer(async (req, res) => {
      if (req.url === "/api/kitchen-queue" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const headers = new Headers();
        for (const [key, val] of Object.entries(req.headers)) {
          if (typeof val === "string") headers.set(key, val);
        }
        const webReq = new Request("http://127.0.0.1/api/kitchen-queue", {
          method: "POST",
          headers,
          body: Buffer.concat(chunks),
        });
        const webRes = await kitchenQueuePost(webReq);
        res.statusCode = webRes.status;
        webRes.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(await webRes.text());
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    });

    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Expected TCP server address");
    }
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Send Shape 2 recipe via stdin
    const sendRes = await runSubprocess([], {
      env: { SOUS_URL: baseUrl, SOUS_TOKEN: created.token },
      stdin: JSON.stringify(VALID_RECIPE_PAYLOAD),
    });
    expect(sendRes.code).toBe(0);
    expect(sendRes.stderr).toBe("");
    expect(sendRes.stdout.trim().split("\n")).toHaveLength(1);
    expect(sendRes.stdout).toContain('Queued "Crispy Chickpea Flatbreads" as ');
    expect(sendRes.stdout).not.toContain(created.token);

    // Send Shape 1 pack recipe via file
    tempDir = mkdtempSync(path.join(os.tmpdir(), "sous-send-live-"));
    const packFile = path.join(tempDir, "pack.json");
    writeFileSync(packFile, JSON.stringify({ pack: "fannie-farmer-1896/waffles" }));
    const packRes = await runSubprocess([packFile], {
      env: { SOUS_URL: baseUrl, SOUS_TOKEN: created.token },
    });
    expect(packRes.code).toBe(0);
    expect(packRes.stdout).toContain('Queued pack recipe "Waffles"');

    const queuedRows = await db
      .select()
      .from(kitchenQueue)
      .where(eq(kitchenQueue.kitchenId, kitchen.id));
    expect(queuedRows).toHaveLength(2);
    expect(queuedRows.map((r) => r.recipeData?.name)).toEqual([
      "Crispy Chickpea Flatbreads",
      "Waffles",
    ]);

    const [tokenRow] = await db
      .select({ lastUsedAt: kitchenWebhookTokens.lastUsedAt })
      .from(kitchenWebhookTokens)
      .where(eq(kitchenWebhookTokens.id, created.id));
    expect(tokenRow?.lastUsedAt).toBeInstanceOf(Date);

    // Revoke token and confirm send-recipe.mjs exits non-zero with 401
    await ownerCaller.revokeKitchenWebhookToken({ id: created.id });
    const revokedRes = await runSubprocess([packFile], {
      env: { SOUS_URL: baseUrl, SOUS_TOKEN: created.token },
    });
    expect(revokedRes.code).toBe(1);
    expect(revokedRes.stdout).toBe("");
    expect(revokedRes.stderr).toContain("Unauthorized (401)");
    expect(revokedRes.stderr).not.toContain(created.token);
  });
});
