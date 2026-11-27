/**
 * MCP HTTP endpoint (`/api/mcp`) and shared webhook rate-limit tests against a
 * real migrated PGlite database.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { FakeProviderController } from "@/lib/__tests__/fake-provider";

const scheduled = vi.hoisted(() => [] as Array<() => unknown>);

vi.mock("@/lib/ai/providers/google", () => ({
  createGoogleProvider: () => fakeProvider.provider("google"),
}));
vi.mock("@/lib/ai/providers/anthropic", () => ({
  createAnthropicProvider: () => fakeProvider.provider("anthropic"),
}));
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
import {
  db,
  kitchenCookLog,
  kitchenQueue,
  kitchens,
  kitchenWebhookTokens,
} from "@/lib/db";
import {
  homeKitchen,
  mintToken,
  seedKitchen,
  snapshotRow,
  type AuthUserRow,
  type KitchenRow,
  type MemberRow,
} from "@/lib/__tests__/kitchens";
import { stubSignInEnv } from "@/lib/__tests__/test-auth";
import { resetDeploymentCheckForTests } from "@/lib/kitchens/deployment";
import { resetWebhookRateLimitsForTests } from "@/lib/kitchens/webhook-rate-limit";
import { addKitchenPack, shareKitchenPack } from "@/lib/kitchens/packs";
import { POST as mcpPost, GET as mcpGet, DELETE as mcpDelete } from "./route";
import { POST as queuePost } from "../kitchen-queue/route";
import { POST as sweepPost } from "../kitchen-queue/sweep/route";
import { GET as packsGet } from "../packs/route";

const client = (dbModule as unknown as { client: PGlite }).client;
const fakeProvider = new FakeProviderController();

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;
let memberA: MemberRow;
let memberB: MemberRow;
let userA: AuthUserRow;
let userB: AuthUserRow;
let tokenA: string;
let tokenB: string;

function makeOwnedPack(id: string, title: string, recipeId: string, recipeTitle: string) {
  return {
    id,
    title,
    version: "1.0.0",
    creator: { name: "Chef Owner" },
    recipes: [
      {
        id: recipeId,
        title: recipeTitle,
        serves_base: 4,
        ingredients: [
          {
            id: "i1",
            name: "Cannellini beans",
            qty_canonical: { mass_g: 400 },
            display_equivalents: { metric: { unit: "g", amount: 400 } },
          },
          {
            id: "i2",
            name: "Garlic",
            qty_canonical: { count: 3, count_unit: { one: "clove", other: "cloves" } },
          },
        ],
        steps: [
          {
            id: "s1",
            type: "action",
            text: "Slice the garlic and warm it gently in oil.",
            ingredient_refs: ["i2"],
          },
          {
            id: "s2",
            type: "checkpoint",
            text: "Add the beans and simmer for 12 minutes until creamy.",
            ingredient_refs: ["i1"],
            timer_sec: 720,
            state_refs: ["state:custard-coats-the-spoon"],
          },
        ],
      },
    ],
  };
}

function mcpReq(
  body: unknown,
  token?: string,
  options: { rawBody?: string; method?: string } = {},
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const method = options.method ?? "POST";
  return new Request("http://localhost:3000/api/mcp", {
    method,
    headers,
    ...(method === "POST"
      ? { body: options.rawBody ?? JSON.stringify(body) }
      : {}),
  });
}

function mcpRpc(
  method: string,
  params: Record<string, unknown> | undefined,
  token: string,
  id: string | number = 1,
): Request {
  return mcpReq(
    {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    },
    token,
  );
}

function parseMcpTextJson<T = unknown>(rpcBody: {
  result?: { isError?: boolean; content: Array<{ type: string; text: string }> };
}): T {
  const text = rpcBody.result?.content?.[0]?.text;
  if (!text) {
    throw new Error("Expected MCP text content");
  }
  return JSON.parse(text) as T;
}

const VALID_RECIPE = {
  name: "Tomato Soup",
  serves: 4,
  ingredients: [{ item: "tomatoes", amount: "2", unit: "lb" }],
  steps: ["Simmer the tomatoes for 20 minutes."],
};

beforeEach(async () => {
  fakeProvider.reset();
  scheduled.length = 0;
  stubSignInEnv();
  resetDeploymentCheckForTests(db);
  resetWebhookRateLimitsForTests();

  await client.exec(
    "delete from kitchen_pack_shares; delete from kitchen_packs; delete from kitchen_cook_log; delete from ai_usage; delete from conversation_logs; delete from kitchen_queue; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  const seededA = await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" });
  const seededB = await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" });
  kitchenA = seededA.kitchen;
  kitchenB = seededB.kitchen;
  memberA = seededA.member;
  memberB = seededB.member;
  userA = seededA.user;
  userB = seededB.user;

  tokenA = await mintToken(db, kitchenA.id, "mcp-a");
  tokenB = await mintToken(db, kitchenB.id, "mcp-b");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetWebhookRateLimitsForTests();
});

describe("MCP protocol and auth", () => {
  it.each(["development", "test", "production"] as const)(
    "refuses missing, wrong, and revoked tokens with 401 across POST/GET/DELETE when NODE_ENV=%s",
    async (env) => {
      vi.stubEnv("NODE_ENV", env);

      const revokedToken = await mintToken(db, kitchenA.id, "revoked");
      const revokedHash = createHash("sha256").update(revokedToken).digest("hex");
      await db
        .update(kitchenWebhookTokens)
        .set({ revokedAt: sql`now()` })
        .where(eq(kitchenWebhookTokens.tokenSha256, revokedHash));

      for (const badToken of [undefined, "sous_wrong_token", revokedToken]) {
        const postRes = await mcpPost(
          mcpReq({ jsonrpc: "2.0", id: 1, method: "initialize" }, badToken),
        );
        expect(postRes.status).toBe(401);
        expect(await postRes.json()).toEqual({ error: "Unauthorized" });

        const getRes = await mcpGet(mcpReq(undefined, badToken, { method: "GET" }));
        expect(getRes.status).toBe(401);
        expect(await getRes.json()).toEqual({ error: "Unauthorized" });

        const delRes = await mcpDelete(
          mcpReq(undefined, badToken, { method: "DELETE" }),
        );
        expect(delRes.status).toBe(401);
        expect(await delRes.json()).toEqual({ error: "Unauthorized" });
      }
    },
  );

  it("returns 405 on GET and DELETE after valid authentication", async () => {
    const getRes = await mcpGet(mcpReq(undefined, tokenA, { method: "GET" }));
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get("Allow")).toBe("POST");
    expect(await getRes.json()).toEqual({ error: "Method not allowed" });

    const delRes = await mcpDelete(mcpReq(undefined, tokenA, { method: "DELETE" }));
    expect(delRes.status).toBe(405);
    expect(delRes.headers.get("Allow")).toBe("POST");
    expect(await delRes.json()).toEqual({ error: "Method not allowed" });
  });

  it("returns 400 JSON-RPC -32700 on invalid JSON and -32600 on invalid JSON-RPC payload", async () => {
    const badJson = await mcpPost(
      mcpReq(undefined, tokenA, { rawBody: "{not-json" }),
    );
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error: invalid JSON" },
    });

    const badRpc = await mcpPost(mcpReq({ id: 9, method: "initialize" }, tokenA));
    expect(badRpc.status).toBe(400);
    expect(await badRpc.json()).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32600, message: "Invalid Request" },
    });

    const arrayRpc = await mcpPost(mcpReq([{ jsonrpc: "2.0", id: 1, method: "tools/list" }], tokenA));
    expect(arrayRpc.status).toBe(400);
    expect((await arrayRpc.json()).error.code).toBe(-32600);
  });

  it("handles initialize, notifications/initialized (202 empty), tools/list, and unknown methods (-32601)", async () => {
    const initDefault = await mcpPost(
      mcpRpc("initialize", { protocolVersion: "2024-11-05" }, tokenA, 1),
    );
    expect(initDefault.status).toBe(200);
    expect(await initDefault.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sous-kitchen", version: "1.0.0" },
      },
    });

    const initFallback = await mcpPost(
      mcpRpc("initialize", { protocolVersion: "1999-01-01" }, tokenA, "init-2"),
    );
    expect(initFallback.status).toBe(200);
    expect((await initFallback.json()).result.protocolVersion).toBe("2025-03-26");

    const notif = await mcpPost(
      mcpReq({ jsonrpc: "2.0", method: "notifications/initialized" }, tokenA),
    );
    expect(notif.status).toBe(202);
    expect(await notif.text()).toBe("");

    const listRes = await mcpPost(mcpRpc("tools/list", {}, tokenA, 2));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    };
    expect(listBody.result.tools.map((t) => t.name)).toEqual([
      "queue_recipe",
      "read_cook_log",
      "get_kitchen_context",
      "list_shelf",
      "get_pack_authoring_guide",
      "save_pack",
    ]);

    const unknownMethod = await mcpPost(mcpRpc("resources/list", {}, tokenA, 3));
    expect(unknownMethod.status).toBe(200);
    expect(await unknownMethod.json()).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found: resources/list" },
    });

    const unknownTool = await mcpPost(
      mcpRpc("tools/call", { name: "delete_kitchen", arguments: {} }, tokenA, 4),
    );
    expect(unknownTool.status).toBe(200);
    expect(await unknownTool.json()).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32602, message: "Unknown tool: delete_kitchen" },
    });
  });
});

describe("Shared per-kitchen rate limit across webhook and MCP routes", () => {
  it("enforces one shared per-kitchen 429 bucket across /api/packs, /api/kitchen-queue/sweep, /api/kitchen-queue, and /api/mcp", async () => {
    vi.stubEnv("SOUS_WEBHOOK_RATE_LIMIT_PER_MIN", "3");

    const r1 = await packsGet(
      new Request("http://localhost:3000/api/packs", {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenA}` },
      }),
    );
    expect(r1.status).toBe(200);

    const r2 = await sweepPost(
      new Request("http://localhost:3000/api/kitchen-queue/sweep", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(r2.status).toBe(200);

    const r3 = await mcpPost(mcpRpc("tools/list", {}, tokenA, 1));
    expect(r3.status).toBe(200);

    // 4th request for Kitchen A on /api/kitchen-queue hits the shared 429 limit.
    const r4Queue = await queuePost(
      new Request("http://localhost:3000/api/kitchen-queue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ recipeData: VALID_RECIPE }),
      }),
    );
    expect(r4Queue.status).toBe(429);
    expect(Number(r4Queue.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(await r4Queue.json()).toMatchObject({
      error: "rate_limit_exceeded",
      message: "Too many requests. Try again shortly.",
    });

    // 5th request for Kitchen A on /api/mcp also returns 429.
    const r5Mcp = await mcpPost(mcpRpc("tools/list", {}, tokenA, 2));
    expect(r5Mcp.status).toBe(429);
    expect(Number(r5Mcp.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);

    // Kitchen B has its own bucket and is unaffected.
    const rB = await mcpPost(mcpRpc("tools/list", {}, tokenB, 1));
    expect(rB.status).toBe(200);
  });
});

describe("MCP tool queue_recipe", () => {
  it("shares webhook validation: refuses targetUser and unreadable recipes without queueing", async () => {
    const targetUserRes = await mcpPost(
      mcpRpc(
        "tools/call",
        {
          name: "queue_recipe",
          arguments: { targetUser: "cook", recipeData: VALID_RECIPE },
        },
        tokenA,
        10,
      ),
    );
    expect(targetUserRes.status).toBe(200);
    const targetUserBody = await targetUserRes.json();
    expect(targetUserBody.result.isError).toBe(true);
    expect(parseMcpTextJson(targetUserBody)).toEqual({
      status: 400,
      error: "targetUser is no longer accepted: the token names the kitchen",
    });

    const emptyRecipeRes = await mcpPost(
      mcpRpc(
        "tools/call",
        {
          name: "queue_recipe",
          arguments: {
            recipeData: { name: "Nothing", steps: [], ingredients: [], serves: 2 },
          },
        },
        tokenA,
        11,
      ),
    );
    expect(emptyRecipeRes.status).toBe(200);
    const emptyBody = await emptyRecipeRes.json();
    expect(emptyBody.result.isError).toBe(true);
    expect(parseMcpTextJson(emptyBody)).toMatchObject({
      status: 422,
      error: "Recipe can't be read as a pack recipe",
    });

    expect(await db.select().from(kitchenQueue)).toEqual([]);
  });

  it("queues Shape 1 pack recipes and Shape 2 recipeData strictly into the token's kitchen", async () => {
    const packRes = await mcpPost(
      mcpRpc(
        "tools/call",
        {
          name: "queue_recipe",
          arguments: { pack: "fannie-farmer-1896/thin-white-sauce" },
        },
        tokenA,
        12,
      ),
    );
    expect(packRes.status).toBe(200);
    const packRpc = await packRes.json();
    expect(packRpc.result.isError).toBeUndefined();
    const packPayload = parseMcpTextJson<{
      success: boolean;
      id: string;
      mode: string;
      source: string;
    }>(packRpc);
    expect(packPayload.success).toBe(true);
    expect(packPayload.mode).toBe("native");
    expect(packPayload.source).toBe("pack:fannie-farmer-1896/thin-white-sauce");

    const row1 = await snapshotRow(db, kitchenQueue, packPayload.id);
    expect(row1?.kitchenId).toBe(kitchenA.id);

    const dataRes = await mcpPost(
      mcpRpc(
        "tools/call",
        {
          name: "queue_recipe",
          arguments: {
            kitchenId: kitchenB.id,
            recipeData: VALID_RECIPE,
          },
        },
        tokenA,
        13,
      ),
    );
    expect(dataRes.status).toBe(200);
    const dataRpc = await dataRes.json();
    expect(dataRpc.result.isError).toBeUndefined();
    const dataPayload = parseMcpTextJson<{ success: boolean; queueIds: string[] }>(
      dataRpc,
    );
    expect(dataPayload.success).toBe(true);
    expect(dataPayload.queueIds).toHaveLength(1);

    const row2 = await snapshotRow(db, kitchenQueue, dataPayload.queueIds[0]!);
    expect(row2?.kitchenId).toBe(kitchenA.id);

    const rowsB = await db
      .select()
      .from(kitchenQueue)
      .where(eq(kitchenQueue.kitchenId, kitchenB.id));
    expect(rowsB).toEqual([]);
  });

  it("surfaces ai_allowance_used as isError without calling the model or queueing", async () => {
    vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
    vi.stubEnv("AI_TEXT_PROVIDER", "google");
    vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");

    await db
      .update(kitchens)
      .set({ aiMonthlyCapMicros: 0 })
      .where(eq(kitchens.id, kitchenA.id));

    const res = await mcpPost(
      mcpRpc(
        "tools/call",
        {
          name: "queue_recipe",
          arguments: {
            recipeData: {
              name: "Garlic Udon",
              ingredients: [{ item: "udon", amount: "2", unit: "packs" }],
              steps: ["Boil the udon."],
            },
          },
        },
        tokenA,
        14,
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(parseMcpTextJson(body)).toMatchObject({
      status: 429,
      error: "ai_allowance_used",
    });
    expect(fakeProvider.chatCalls).toHaveLength(0);
    expect(await db.select().from(kitchenQueue)).toEqual([]);
  });
});

describe("MCP tools read_cook_log, get_kitchen_context, and list_shelf isolation", () => {
  it("read_cook_log returns only the token kitchen's entries ordered newest first and respects limit", async () => {
    await db.insert(kitchenCookLog).values([
      {
        kitchenId: kitchenA.id,
        recipeTitle: "Old A Soup",
        timestampText: "2026-11-20 18:00",
        cookedDay: "2026-11-20",
        cookedAt: new Date("2026-11-20T18:00:00Z"),
        cookedByMemberId: memberA.id,
        rating: 4,
        notes: "Good broth",
      },
      {
        kitchenId: kitchenA.id,
        recipeTitle: "Middle A Pasta",
        timestampText: "2026-11-22 19:00",
        cookedDay: "2026-11-22",
        cookedAt: new Date("2026-11-22T19:00:00Z"),
        cookedByMemberId: memberA.id,
        rating: 5,
        notes: "Keep this",
      },
      {
        kitchenId: kitchenA.id,
        recipeTitle: "Newest A Beans",
        timestampText: "2026-11-24 20:00",
        cookedDay: "2026-11-24",
        cookedAt: new Date("2026-11-24T20:00:00Z"),
        cookedByMemberId: memberA.id,
        rating: null,
        notes: "",
      },
      {
        kitchenId: kitchenB.id,
        recipeTitle: "Secret Kitchen B Curry",
        timestampText: "2026-11-25 12:00",
        cookedDay: "2026-11-25",
        cookedAt: new Date("2026-11-25T12:00:00Z"),
        cookedByMemberId: memberB.id,
        rating: 5,
        notes: "Private to B",
      },
    ]);

    const resA = await mcpPost(
      mcpRpc(
        "tools/call",
        { name: "read_cook_log", arguments: { limit: 2, kitchenId: kitchenB.id } },
        tokenA,
        20,
      ),
    );
    expect(resA.status).toBe(200);
    const bodyA = await resA.json();
    expect(bodyA.result.isError).toBeUndefined();
    const parsedA = parseMcpTextJson<{
      entries: Array<{ recipeTitle: string; cookedByName: string | null; rating: number | null }>;
    }>(bodyA);
    expect(parsedA.entries.map((e) => e.recipeTitle)).toEqual([
      "Newest A Beans",
      "Middle A Pasta",
    ]);
    expect(parsedA.entries[0]?.cookedByName).toBe(userA.name);
    expect(JSON.stringify(parsedA)).not.toContain("Secret Kitchen B Curry");

    const resB = await mcpPost(
      mcpRpc("tools/call", { name: "read_cook_log", arguments: {} }, tokenB, 21),
    );
    const parsedB = parseMcpTextJson<{
      entries: Array<{ recipeTitle: string; cookedByName: string | null }>;
    }>(await resB.json());
    expect(parsedB.entries.map((e) => e.recipeTitle)).toEqual([
      "Secret Kitchen B Curry",
    ]);
    expect(parsedB.entries[0]?.cookedByName).toBe(userB.name);

    const badLimit = await mcpPost(
      mcpRpc("tools/call", { name: "read_cook_log", arguments: { limit: "all" } }, tokenA, 22),
    );
    expect((await badLimit.json()).result.isError).toBe(true);
  });

  it("get_kitchen_context returns only the token kitchen's name and about note", async () => {
    await db
      .update(kitchens)
      .set({ about: "Cast iron only, no tree nuts." })
      .where(eq(kitchens.id, kitchenA.id));
    await db
      .update(kitchens)
      .set({ about: "Secret kitchen B note." })
      .where(eq(kitchens.id, kitchenB.id));

    const resA = await mcpPost(
      mcpRpc(
        "tools/call",
        { name: "get_kitchen_context", arguments: { kitchenId: kitchenB.id } },
        tokenA,
        30,
      ),
    );
    expect(resA.status).toBe(200);
    const bodyA = await resA.json();
    expect(bodyA.result.isError).toBeUndefined();
    expect(parseMcpTextJson(bodyA)).toEqual({
      kitchenName: "Kitchen A",
      about: "Cast iron only, no tree nuts.",
    });

    const resB = await mcpPost(
      mcpRpc("tools/call", { name: "get_kitchen_context", arguments: {} }, tokenB, 31),
    );
    expect(parseMcpTextJson(await resB.json())).toEqual({
      kitchenName: "Kitchen B",
      about: "Secret kitchen B note.",
    });
  });

  it("list_shelf returns registered packs plus only owned and shared packs for the token's kitchen", async () => {
    const packAOnly = makeOwnedPack("alpha-private", "Alpha Private", "a-1", "Alpha Dish");
    const packBOnly = makeOwnedPack("beta-private", "Beta Private", "b-1", "Beta Dish");
    const packBShared = makeOwnedPack("beta-shared", "Beta Shared", "bs-1", "Shared Dish");

    await addKitchenPack(
      { kitchenSlug: "kitchen-a", rawBytes: JSON.stringify(packAOnly) },
      db,
    );
    await addKitchenPack(
      { kitchenSlug: "kitchen-b", rawBytes: JSON.stringify(packBOnly) },
      db,
    );
    await addKitchenPack(
      { kitchenSlug: "kitchen-b", rawBytes: JSON.stringify(packBShared) },
      db,
    );
    await shareKitchenPack(
      { pack: "beta-shared", kitchenSlug: "kitchen-b", withKitchenSlug: "kitchen-a" },
      db,
    );

    const resA = await mcpPost(
      mcpRpc("tools/call", { name: "list_shelf", arguments: {} }, tokenA, 40),
    );
    expect(resA.status).toBe(200);
    const shelfA = parseMcpTextJson<{
      packs: Array<{ id: string; from_kitchen_name?: string }>;
    }>(await resA.json());
    const idsA = shelfA.packs.map((p) => p.id);
    expect(idsA).toContain("fannie-farmer-1896");
    expect(idsA).toContain("alpha-private");
    expect(idsA).toContain("beta-shared");
    expect(idsA).not.toContain("beta-private");
    expect(shelfA.packs.find((p) => p.id === "beta-shared")?.from_kitchen_name).toBe(
      "Kitchen B",
    );

    const resB = await mcpPost(
      mcpRpc("tools/call", { name: "list_shelf", arguments: {} }, tokenB, 41),
    );
    const shelfB = parseMcpTextJson<{ packs: Array<{ id: string }> }>(
      await resB.json(),
    );
    const idsB = shelfB.packs.map((p) => p.id);
    expect(idsB).toContain("beta-private");
    expect(idsB).toContain("beta-shared");
    expect(idsB).not.toContain("alpha-private");
  });

  it("get_pack_authoring_guide returns Pack Format v0.7 rules and save_pack creates, updates, and rejects invalid packs per kitchen", async () => {
    const guideRes = await mcpPost(
      mcpRpc("tools/call", { name: "get_pack_authoring_guide", arguments: {} }, tokenA, 60),
    );
    expect(guideRes.status).toBe(200);
    const guideBody = await guideRes.json();
    expect(guideBody.result.isError).toBeUndefined();
    const guide = parseMcpTextJson<{
      rules: string;
      commons: Array<{ id: string }>;
      states: Array<{ id: string }>;
      reservedPackIds: string[];
    }>(guideBody);
    expect(guide.rules).toContain("PACK FORMAT v0.7 RULES");
    expect(guide.commons.some((c) => c.id.startsWith("commons:"))).toBe(true);
    expect(guide.states.some((s) => s.id.startsWith("state:"))).toBe(true);
    expect(guide.reservedPackIds).toContain("new");

    // Invalid pack returns structured error
    const badRes = await mcpPost(
      mcpRpc(
        "tools/call",
        {
          name: "save_pack",
          arguments: { pack: { id: "new", title: "Bad" } },
        },
        tokenA,
        61,
      ),
    );
    const badBody = await badRes.json();
    expect(badBody.result.isError).toBe(true);
    expect(parseMcpTextJson<{ error: string }>(badBody).error).toBe("invalid_pack");

    // Save valid pack for kitchen A
    const createRes = await mcpPost(
      mcpRpc(
        "tools/call",
        {
          name: "save_pack",
          arguments: { pack: makeOwnedPack("mcp-tacos", "Taco Night", "t1", "Bean Tacos") },
        },
        tokenA,
        62,
      ),
    );
    const created = parseMcpTextJson<{ ok: boolean; updated: boolean; packId: string }>(
      await createRes.json(),
    );
    expect(created).toMatchObject({ ok: true, updated: false, packId: "mcp-tacos" });

    // Share with B, then update via save_pack and ensure share persists while B's own shelf is separate
    await shareKitchenPack(
      { pack: "mcp-tacos", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );
    const updateRes = await mcpPost(
      mcpRpc(
        "tools/call",
        {
          name: "save_pack",
          arguments: { pack: makeOwnedPack("mcp-tacos", "Taco Night Rev 2", "t1", "Bean Tacos") },
        },
        tokenA,
        63,
      ),
    );
    const updated = parseMcpTextJson<{ ok: boolean; updated: boolean; title: string }>(
      await updateRes.json(),
    );
    expect(updated).toMatchObject({
      ok: true,
      updated: true,
      title: "Taco Night Rev 2",
    });

    const shelfBRes = await mcpPost(
      mcpRpc("tools/call", { name: "list_shelf", arguments: {} }, tokenB, 64),
    );
    const shelfB = parseMcpTextJson<{
      packs: Array<{ id: string; title: string }>;
    }>(await shelfBRes.json());
    expect(shelfB.packs.find((p) => p.id === "mcp-tacos")?.title).toBe(
      "Taco Night Rev 2",
    );
  });
});

describe("Single-kitchen mode (SOUS_SIGN_IN=off)", () => {
  it("supports initialize, tools/list, and all 4 tools for the home kitchen token", async () => {
    await client.exec(
      "delete from kitchen_pack_shares; delete from kitchen_packs; delete from kitchen_cook_log; delete from kitchen_queue; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
    );
    await client.exec("delete from kitchens where slug <> 'home'");

    vi.stubEnv("SOUS_SIGN_IN", "off");
    resetDeploymentCheckForTests(db);

    const home = await homeKitchen(db);
    await db
      .update(kitchens)
      .set({ about: "Single kitchen notes." })
      .where(eq(kitchens.id, home.id));
    await db.insert(kitchenCookLog).values({
      kitchenId: home.id,
      recipeTitle: "Home Skillet Beans",
      timestampText: "2026-11-24 19:00",
      cookedDay: "2026-11-24",
      cookedAt: new Date("2026-11-24T19:00:00Z"),
      rating: 5,
      notes: "Crisp edges",
    });
    const homeToken = await mintToken(db, home.id, "home-mcp");

    const ctxRes = await mcpPost(
      mcpRpc("tools/call", { name: "get_kitchen_context", arguments: {} }, homeToken, 50),
    );
    expect(parseMcpTextJson(await ctxRes.json())).toEqual({
      kitchenName: home.name,
      about: "Single kitchen notes.",
    });

    const logRes = await mcpPost(
      mcpRpc("tools/call", { name: "read_cook_log", arguments: {} }, homeToken, 51),
    );
    const logBody = parseMcpTextJson<{
      entries: Array<{ recipeTitle: string; cookedByName: string | null }>;
    }>(await logRes.json());
    expect(logBody.entries).toHaveLength(1);
    expect(logBody.entries[0]).toMatchObject({
      recipeTitle: "Home Skillet Beans",
      cookedByName: null,
    });

    const shelfRes = await mcpPost(
      mcpRpc("tools/call", { name: "list_shelf", arguments: {} }, homeToken, 52),
    );
    const shelfBody = parseMcpTextJson<{ packs: Array<{ id: string }> }>(
      await shelfRes.json(),
    );
    expect(shelfBody.packs.some((p) => p.id === "fannie-farmer-1896")).toBe(true);

    const queueRes = await mcpPost(
      mcpRpc(
        "tools/call",
        { name: "queue_recipe", arguments: { recipeData: VALID_RECIPE } },
        homeToken,
        53,
      ),
    );
    const queueBody = parseMcpTextJson<{ success: boolean; queueIds: string[] }>(
      await queueRes.json(),
    );
    expect(queueBody.success).toBe(true);
    const row = await snapshotRow(db, kitchenQueue, queueBody.queueIds[0]!);
    expect(row?.kitchenId).toBe(home.id);
  });
});
