/**
 * Per-kitchen webhook authentication and isolation tests (WH-1 to WH-6)
 * against a real migrated PGlite database.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { FakeProviderController } from "@/lib/__tests__/fake-provider";

const scheduled = vi.hoisted(() => [] as Array<() => unknown>);

vi.mock("@/lib/ai/providers/google", () => ({
  createGoogleProvider: () => provider.provider("google"),
}));
vi.mock("@/lib/ai/providers/anthropic", () => ({
  createAnthropicProvider: () => provider.provider("anthropic"),
}));
vi.mock("@/lib/pack-cook-plans", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/pack-cook-plans")>();
  return {
    ...original,
    readPackPlanFile: vi.fn(original.readPackPlanFile),
  };
});
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((task: () => unknown) => scheduled.push(task)),
}));
vi.mock("@/lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../../../lib/hooks/types");
  return {
    connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, false])),
  };
});
vi.mock("@/lib/db", async () =>
  (await import("../../../lib/__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db, kitchenQueue, kitchenWebhookTokens } from "@/lib/db";
import { packPlanFor, readPackPlanFile } from "@/lib/pack-cook-plans";
import { PACK_PLANS_DIR } from "@/lib/shelf/load";
import {
  mintToken,
  seedKitchen,
  seedQueueRow,
  snapshotRow,
  type KitchenRow,
} from "@/lib/__tests__/kitchens";
import { stubSignInEnv } from "@/lib/__tests__/test-auth";
import { resetDeploymentCheckForTests } from "@/lib/kitchens/deployment";
import { POST as queuePost } from "./route";
import { POST as sweepPost } from "./sweep/route";
import { GET as packsGet } from "../packs/route";

const client = (dbModule as unknown as { client: PGlite }).client;
const provider = new FakeProviderController();

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;
let tokenA: string;
let tokenB: string;

const RECIPE = {
  name: "Tomato Soup",
  serves: 4,
  ingredients: [{ item: "tomatoes", amount: "2", unit: "lb" }],
  steps: ["Simmer the tomatoes for 20 minutes."],
};

function queueReq(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost:3000/api/kitchen-queue", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function sweepReq(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost:3000/api/kitchen-queue/sweep", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function packsReq(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost:3000/api/packs", {
    method: "GET",
    headers,
  });
}

beforeEach(async () => {
  provider.reset();
  scheduled.length = 0;
  stubSignInEnv();
  resetDeploymentCheckForTests(db);
  await client.exec(
    "delete from ai_usage; delete from conversation_logs; delete from kitchen_queue; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchenA = (await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" }))
    .kitchen;
  kitchenB = (await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" }))
    .kitchen;
  tokenA = await mintToken(db, kitchenA.id, "agent-a");
  tokenB = await mintToken(db, kitchenB.id, "agent-b");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("WH-1: webhook bearer token required in every environment", () => {
  it.each(["development", "test", "production"] as const)(
    "answers 401 for missing, wrong, or revoked tokens when NODE_ENV=%s",
    async (env) => {
      vi.stubEnv("NODE_ENV", env);

      const revokedToken = await mintToken(db, kitchenA.id, "revoked");
      const revokedHash = createHash("sha256")
        .update(revokedToken)
        .digest("hex");
      await db
        .update(kitchenWebhookTokens)
        .set({ revokedAt: sql`now()` })
        .where(eq(kitchenWebhookTokens.tokenSha256, revokedHash));

      for (const badToken of [undefined, "sous_wrong_token", revokedToken]) {
        const qRes = await queuePost(queueReq({ recipeData: RECIPE }, badToken));
        expect(qRes.status).toBe(401);
        expect(await qRes.json()).toEqual({ error: "Unauthorized" });

        const sRes = await sweepPost(sweepReq({}, badToken));
        expect(sRes.status).toBe(401);
        expect(await sRes.json()).toEqual({ error: "Unauthorized" });

        const pRes = await packsGet(packsReq(badToken));
        expect(pRes.status).toBe(401);
        expect(await pRes.json()).toEqual({ error: "Unauthorized" });
      }
    },
  );
});

describe("WH-2: token scopes queued recipes to its kitchen", () => {
  it("queues a recipe into kitchen A only, leaving kitchen B unchanged", async () => {
    const res = await queuePost(queueReq({ recipeData: RECIPE }, tokenA));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; queueIds: string[] };
    expect(body.success).toBe(true);
    expect(body.queueIds).toHaveLength(1);

    const rowsA = await db
      .select()
      .from(kitchenQueue)
      .where(eq(kitchenQueue.kitchenId, kitchenA.id));
    const rowsB = await db
      .select()
      .from(kitchenQueue)
      .where(eq(kitchenQueue.kitchenId, kitchenB.id));
    expect(rowsA.map((r) => r.id)).toEqual(body.queueIds);
    expect(rowsA[0]?.targetUser).toBeNull();
    expect(rowsB).toEqual([]);
  });

  it("queues a direct pack recipe into kitchen A and omits targetUser from the 201 answer", async () => {
    const res = await queuePost(
      queueReq(
        { packId: "fannie-farmer-1896", recipeId: "thin-white-sauce" },
        tokenA,
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("targetUser");
    expect(body.success).toBe(true);

    const row = await snapshotRow(db, kitchenQueue, body.id as string);
    expect(row?.kitchenId).toBe(kitchenA.id);
    expect(row?.targetUser).toBeNull();

    const rowsB = await db
      .select()
      .from(kitchenQueue)
      .where(eq(kitchenQueue.kitchenId, kitchenB.id));
    expect(rowsB).toEqual([]);
  });

  it("prepares a direct pack recipe without a stored plan on kitchen A's row in the scheduled background task", async () => {
    vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
    vi.stubEnv("AI_TEXT_PROVIDER", "google");
    vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");

    // Read a valid plan fixture from the bundled pack plans, then simulate no
    // stored plan file so the pack path schedules background preparation.
    const realPlanFile = await readPackPlanFile(
      PACK_PLANS_DIR,
      "fannie-farmer-1896",
    );
    expect(realPlanFile.ok).toBe(true);
    const fixturePlan = realPlanFile.ok
      ? packPlanFor(realPlanFile.file, "thin-white-sauce")?.plan
      : null;
    expect(fixturePlan).not.toBeNull();

    vi.mocked(readPackPlanFile).mockResolvedValueOnce({ ok: true, file: null });
    provider.onNextChat(() => ({
      content: JSON.stringify({
        tasks: (fixturePlan as { tasks: unknown[] }).tasks,
      }),
      finishReason: "stop",
    }));

    const res = await queuePost(
      queueReq(
        { packId: "fannie-farmer-1896", recipeId: "thin-white-sauce" },
        tokenA,
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; success: boolean };
    expect(body.success).toBe(true);
    expect(scheduled).toHaveLength(1);

    const beforeTask = await snapshotRow(db, kitchenQueue, body.id);
    expect(beforeTask?.kitchenId).toBe(kitchenA.id);
    expect(beforeTask?.cookPlan).toBeNull();
    expect(beforeTask?.cookPlanError).toBeNull();

    await Promise.all(scheduled.map((task) => task()));

    const afterTask = await snapshotRow(db, kitchenQueue, body.id);
    expect(afterTask?.kitchenId).toBe(kitchenA.id);
    expect(afterTask?.cookPlan).not.toBeNull();
    expect(afterTask?.cookPlanError).toBeNull();
    expect(provider.chatCalls).toHaveLength(1);

    const rowsB = await db
      .select()
      .from(kitchenQueue)
      .where(eq(kitchenQueue.kitchenId, kitchenB.id));
    expect(rowsB).toEqual([]);
  });
});

describe("WH-3: targetUser refusal and ignored kitchenId override", () => {
  it.each(["cook", "", null])(
    "answers 400 when targetUser is %s",
    async (value) => {
      const res = await queuePost(
        queueReq({ recipeData: RECIPE, targetUser: value }, tokenA),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "targetUser is no longer accepted: the token names the kitchen",
      });

      const rows = await db.select().from(kitchenQueue);
      expect(rows).toEqual([]);
    },
  );

  it("queues into kitchen A even when the body carries kitchenId for kitchen B", async () => {
    const res = await queuePost(
      queueReq({ recipeData: RECIPE, kitchenId: kitchenB.id }, tokenA),
    );
    expect(res.status).toBe(200);
    const { queueIds } = (await res.json()) as { queueIds: string[] };

    const row = await snapshotRow(db, kitchenQueue, queueIds[0]!);
    expect(row?.kitchenId).toBe(kitchenA.id);
  });

  it("rejects targetUser on POST /api/kitchen-queue/sweep with its existing 400 Invalid sweep", async () => {
    const res = await sweepPost(sweepReq({ targetUser: "cook" }, tokenA));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid sweep" });
  });
});

describe("WH-4: sweep is scoped to the token's kitchen", () => {
  it("finishes kitchen A's idle cook while leaving kitchen B's idle cook cooking", async () => {
    const idleAt = new Date(Date.now() - 60 * 60_000);
    const rowA = await seedQueueRow(db, kitchenA.id, {
      status: "cooking",
      startedAt: new Date(Date.now() - 120 * 60_000),
      lastScreenActiveAt: idleAt,
      recipeData: { name: "Kitchen A Stew", steps: ["Simmer."], serves: 2 },
    });
    const rowB = await seedQueueRow(db, kitchenB.id, {
      status: "cooking",
      startedAt: new Date(Date.now() - 120 * 60_000),
      lastScreenActiveAt: idleAt,
      recipeData: { name: "Kitchen B Soup", steps: ["Simmer."], serves: 2 },
    });
    const beforeB = await snapshotRow(db, kitchenQueue, rowB.id);

    const res = await sweepPost(sweepReq({}, tokenA));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      finished: [
        { queueId: rowA.id, name: "Kitchen A Stew", cookLog: "none" },
      ],
      relogged: [],
    });

    const afterA = await snapshotRow(db, kitchenQueue, rowA.id);
    expect(afterA?.status).toBe("completed");
    expect(afterA?.finishedBy).toBe("auto");
    expect(await snapshotRow(db, kitchenQueue, rowB.id)).toEqual(beforeB);
  });
});

describe("WH-5: GET /api/packs accepts any valid token and rejects revoked ones", () => {
  it("returns 200 for valid tokens from different kitchens and 401 after revocation", async () => {
    const resA = await packsGet(packsReq(tokenA));
    expect(resA.status).toBe(200);
    const resB = await packsGet(packsReq(tokenB));
    expect(resB.status).toBe(200);

    const hashA = createHash("sha256").update(tokenA).digest("hex");
    await db
      .update(kitchenWebhookTokens)
      .set({ revokedAt: sql`now()` })
      .where(eq(kitchenWebhookTokens.tokenSha256, hashA));

    const revokedRes = await packsGet(packsReq(tokenA));
    expect(revokedRes.status).toBe(401);
  });
});

describe("WH-6: tokens are stored hashed and last_used_at updates on use", () => {
  it("stores only the SHA-256 digest and stamps last_used_at after an accepted request", async () => {
    const expectedHash = createHash("sha256").update(tokenA).digest("hex");
    const [before] = await db
      .select()
      .from(kitchenWebhookTokens)
      .where(eq(kitchenWebhookTokens.kitchenId, kitchenA.id));

    expect(before?.tokenSha256).toBe(expectedHash);
    expect(before?.tokenSha256).not.toBe(tokenA);
    expect(before?.lastUsedAt).toBeNull();

    // Verify no row in the table contains the plaintext token.
    const allRows = await db.select().from(kitchenWebhookTokens);
    expect(JSON.stringify(allRows)).not.toContain(tokenA);

    const res = await packsGet(packsReq(tokenA));
    expect(res.status).toBe(200);

    const [after] = await db
      .select()
      .from(kitchenWebhookTokens)
      .where(eq(kitchenWebhookTokens.id, before!.id));
    expect(after?.lastUsedAt).toBeInstanceOf(Date);
  });
});
