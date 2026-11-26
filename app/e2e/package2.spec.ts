import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { test, expect } from "./fixtures";
import { getHomeKitchenId } from "./db";
import { E2E_BASE_URL, E2E_DATABASE_URL, assertLocalDatabase } from "./env";

const SCRIPT_PATH = path.resolve(
  __dirname,
  "../../skills/sous-kitchen/send-recipe.mjs",
);

function runSendRecipe(
  args: string[],
  env: Record<string, string>,
  stdinJson?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT_PATH, ...args],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: process.env.NODE_ENV,
          ...env,
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
    if (stdinJson !== undefined && child.stdin) {
      child.stdin.write(stdinJson);
      child.stdin.end();
    }
  });
}

async function withTestSql<T>(
  fn: (sql: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
  assertLocalDatabase(E2E_DATABASE_URL);
  const sql = postgres(E2E_DATABASE_URL, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.describe("Package 2: Sending recipes to a kitchen", () => {
  test("PKG2-1: single-kitchen /kitchen/settings hides owner sending-token UI and refuses token tRPC calls", async ({
    page,
  }) => {
    const tokenRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("KitchenWebhookToken")) {
        tokenRequests.push(req.url());
      }
    });

    await page.goto("/kitchen/settings");
    await expect(
      page.getByRole("textbox", { name: "About my kitchen" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Sending tokens" }),
    ).toHaveCount(0);
    expect(tokenRequests).toEqual([]);

    const forbiddenRes = await page.request.get(
      "/api/trpc/listKitchenWebhookTokens",
    );
    expect(forbiddenRes.status()).toBe(403);
  });

  test("PKG2-2: send-recipe.mjs queues a recipe into the live server and is refused after token revocation", async ({
    page,
  }) => {
    const homeId = await getHomeKitchenId();
    const token = `sous_${randomBytes(32).toString("base64url")}`;
    const tokenSha256 = createHash("sha256").update(token).digest("hex");

    const tokenId = await withTestSql(async (sql) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO public.kitchen_webhook_tokens (kitchen_id, token_sha256, label)
        VALUES (${homeId}::uuid, ${tokenSha256}, 'E2E script')
        RETURNING id
      `;
      return row!.id;
    });

    const payload = JSON.stringify({
      recipeData: {
        name: "E2E Skillet Polenta",
        serves: 4,
        ingredients: [
          { item: "cornmeal", amount: "1", unit: "cup" },
          { item: "water", amount: "4", unit: "cups" },
          { item: "salt" },
        ],
        steps: ["Whisk cornmeal into simmering salted water for 15 minutes."],
      },
    });

    const sendRes = await runSendRecipe(
      [],
      { SOUS_URL: E2E_BASE_URL, SOUS_TOKEN: token },
      payload,
    );
    expect(sendRes.code).toBe(0);
    expect(sendRes.stderr).toBe("");
    expect(sendRes.stdout).toContain('Queued "E2E Skillet Polenta" as ');
    expect(sendRes.stdout).not.toContain(token);

    // Verify queued recipe is visible in the app's queue screen
    await page.goto("/kitchen");
    await page.getByRole("button", { name: "Up next · 5" }).click();
    await expect(page.locator("[data-queue-screen]")).toContainText(
      "E2E Skillet Polenta",
    );

    // Revoke token and verify send-recipe.mjs is refused with 401
    await withTestSql(async (sql) => {
      await sql`
        UPDATE public.kitchen_webhook_tokens
        SET revoked_at = now()
        WHERE id = ${tokenId}::uuid
      `;
    });

    const revokedRes = await runSendRecipe(
      [],
      { SOUS_URL: E2E_BASE_URL, SOUS_TOKEN: token },
      payload,
    );
    expect(revokedRes.code).toBe(1);
    expect(revokedRes.stdout).toBe("");
    expect(revokedRes.stderr).toContain("Unauthorized (401)");
    expect(revokedRes.stderr).not.toContain(token);
  });
});
