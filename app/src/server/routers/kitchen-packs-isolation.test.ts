/**
 * Two-kitchen isolation, sharing/unsharing/remove resilience, HTTP webhook, and
 * AI metering tests for kitchen-owned and shared packs against migrated PGlite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
  const { HOOK_NAMES } = await import("@/lib/hooks/types");
  return {
    connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, false])),
  };
});
vi.mock("@/lib/db", async () =>
  (await import("@/lib/__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { aiUsage, db, kitchenQueue } from "@/lib/db";
import {
  callerFor,
  mintToken,
  seedKitchen,
  snapshotRow,
  type KitchenRow,
  type MemberRow,
} from "@/lib/__tests__/kitchens";
import { stubSignInEnv } from "@/lib/__tests__/test-auth";
import {
  addKitchenPack,
  removeKitchenPack,
  shareKitchenPack,
  unshareKitchenPack,
} from "@/lib/kitchens/packs";
import { resetDeploymentCheckForTests } from "@/lib/kitchens/deployment";
import { appRouter } from "@/server/routers/_app";
import { createTRPCContext } from "@/server/trpc";
import { GET as packsGet } from "@/app/api/packs/route";
import { POST as queuePost } from "@/app/api/kitchen-queue/route";

const client = (dbModule as unknown as { client: PGlite }).client;
const fakeProvider = new FakeProviderController();

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;
let memberA: MemberRow;
let memberB: MemberRow;
let callerA: ReturnType<typeof callerFor>;
let callerB: ReturnType<typeof callerFor>;
let tokenA: string;
let tokenB: string;

function makeOwnedPack(id = "supper-club", title = "Supper Club") {
  return {
    id,
    title,
    version: "1.0.0",
    creator: { name: "Chef Owner" },
    recipes: [
      {
        id: "garlic-beans",
        title: "Garlic Beans",
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

function validTwoStepPlanJson() {
  return JSON.stringify({
    tasks: [
      {
        id: "t1",
        kind: "cook",
        text: "Slice the garlic and warm it gently in oil.",
        label: "warm garlic",
        ingredientIdx: [1],
        sourceStep: 0,
        implied: false,
        needs: [],
        branch: "Main",
        minutes: { est: 3, handsOff: false },
        cue: null,
        lead: null,
      },
      {
        id: "t2",
        kind: "cook",
        text: "Add the beans and simmer for 12 minutes until creamy.",
        label: "simmer beans",
        ingredientIdx: [0],
        sourceStep: 1,
        implied: false,
        needs: ["t1"],
        branch: "Main",
        minutes: { est: 12, handsOff: true },
        cue: "until creamy",
        lead: null,
      },
    ],
  });
}

async function unauthenticatedCaller() {
  const ctx = await createTRPCContext();
  return appRouter.createCaller(ctx);
}

function packsReq(urlPath: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://localhost:3000${urlPath}`, {
    method: "GET",
    headers,
  });
}

function queueReq(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost:3000/api/kitchen-queue", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  fakeProvider.reset();
  scheduled.length = 0;
  stubSignInEnv();
  vi.stubEnv("GOOGLE_AI_API_KEY", "test-google-key");
  vi.stubEnv("AI_TEXT_PROVIDER", "google");
  vi.stubEnv("AI_TEXT_MODEL", "gemini-3.5-flash");
  resetDeploymentCheckForTests(db);
  await client.exec(
    "delete from kitchen_pack_shares; delete from kitchen_packs; delete from ai_usage; delete from conversation_logs; delete from cook_reports; delete from kitchen_cook_log; delete from doc_recipes; delete from recipe_ideas_cache; delete from kitchen_queue; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  const seededA = await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" });
  const seededB = await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" });
  kitchenA = seededA.kitchen;
  kitchenB = seededB.kitchen;
  memberA = seededA.member;
  memberB = seededB.member;
  callerA = callerFor(kitchenA, { id: memberA.id, role: memberA.role });
  callerB = callerFor(kitchenB, { id: memberB.id, role: memberB.role });
  tokenA = await mintToken(db, kitchenA.id, "agent-a");
  tokenB = await mintToken(db, kitchenB.id, "agent-b");
});

afterEach(() => {
  resetDeploymentCheckForTests(db);
  vi.unstubAllEnvs();
});

describe("ISO-PACK-1: two-kitchen isolation for owned packs", () => {
  it("keeps kitchen A's unshared owned pack invisible and unqueueable to kitchen B and unauthenticated callers", async () => {
    await addKitchenPack(
      {
        kitchenSlug: "kitchen-a",
        rawBytes: JSON.stringify(makeOwnedPack("supper-club", "Supper Club")),
      },
      db,
    );

    // Kitchen A sees it on shelf, pack view, and GET /api/packs
    const shelfA = await callerA.getShelf();
    expect(shelfA.creators.map((c) => c.id)).toContain("supper-club");
    const ownedCard = shelfA.creators.find((c) => c.id === "supper-club")!;
    expect(ownedCard.isOwned).toBe(true);
    expect(ownedCard.fromKitchenName).toBeUndefined();

    const packA = await callerA.getPack({ packId: "supper-club" });
    expect(packA).toMatchObject({
      id: "supper-club",
      title: "Supper Club",
      isOwned: true,
    });
    expect(packA?.fromKitchenName).toBeUndefined();

    const apiPacksA = await packsGet(packsReq("/api/packs", tokenA));
    expect(apiPacksA.status).toBe(200);
    const bodyA = (await apiPacksA.json()) as { packs: Array<{ id: string }> };
    expect(bodyA.packs.map((p) => p.id)).toContain("supper-club");

    // Kitchen B cannot see, open, or queue from Kitchen A's unshared pack
    const shelfB = await callerB.getShelf();
    expect(shelfB.creators.map((c) => c.id)).not.toContain("supper-club");
    expect(await callerB.getPack({ packId: "supper-club" })).toBeNull();
    await expect(
      callerB.queueFromPack({ packId: "supper-club", recipeId: "garlic-beans" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const apiPacksB = await packsGet(packsReq("/api/packs", tokenB));
    expect(apiPacksB.status).toBe(200);
    const bodyB = (await apiPacksB.json()) as { packs: Array<{ id: string }> };
    expect(bodyB.packs.map((p) => p.id)).not.toContain("supper-club");

    const apiDetailB = await packsGet(
      packsReq("/api/packs?pack=supper-club&recipe=garlic-beans", tokenB),
    );
    expect(apiDetailB.status).toBe(404);

    const apiQueueB = await queuePost(
      queueReq({ packId: "supper-club", recipeId: "garlic-beans" }, tokenB),
    );
    expect(apiQueueB.status).toBe(404);

    // Attribution gate strips forged source naming Kitchen A's unshared pack
    const forgedB = await queuePost(
      queueReq(
        {
          recipeData: {
            name: "Garlic Beans",
            serves: 4,
            ingredients: [{ item: "beans", amount: "400", unit: "g" }],
            steps: ["Simmer beans."],
            source: "pack:supper-club/garlic-beans",
          },
        },
        tokenB,
      ),
    );
    expect(forgedB.status).toBe(200);
    const forgedJson = (await forgedB.json()) as { queueIds: string[] };
    const storedForged = await snapshotRow(db, kitchenQueue, forgedJson.queueIds[0]!);
    expect(storedForged?.recipeData?.source).toBeUndefined();

    // Unauthenticated callers get nothing
    const anon = await unauthenticatedCaller();
    await expect(anon.getShelf()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.getPack({ packId: "supper-club" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect((await packsGet(packsReq("/api/packs"))).status).toBe(401);
    expect(
      (await queuePost(queueReq({ packId: "supper-club", recipeId: "garlic-beans" }))).status,
    ).toBe(401);
  });
});

describe("ISO-PACK-2: sharing, unsharing, and removing without breaking queued/in-progress cooks", () => {
  it("marks shared packs From <kitchen name>, and unsharing or removing leaves queued/cooking rows working", async () => {
    await addKitchenPack(
      {
        kitchenSlug: "kitchen-a",
        rawBytes: JSON.stringify(makeOwnedPack("supper-club", "Supper Club")),
      },
      db,
    );
    await shareKitchenPack(
      { pack: "supper-club", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );

    // Kitchen B sees the shared pack marked "From Kitchen A"
    const shelfB = await callerB.getShelf();
    const sharedOnShelf = shelfB.creators.find((c) => c.id === "supper-club");
    expect(sharedOnShelf).toMatchObject({
      id: "supper-club",
      isOwned: false,
      fromKitchenName: "Kitchen A",
    });

    const packViewB = await callerB.getPack({ packId: "supper-club" });
    expect(packViewB).toMatchObject({
      id: "supper-club",
      isOwned: false,
      fromKitchenName: "Kitchen A",
    });

    const apiPacksB = await packsGet(packsReq("/api/packs", tokenB));
    const apiBodyB = (await apiPacksB.json()) as {
      packs: Array<{ id: string; from_kitchen_name?: string }>;
    };
    expect(apiBodyB.packs.find((p) => p.id === "supper-club")?.from_kitchen_name).toBe(
      "Kitchen A",
    );

    // Kitchen B queues via tRPC and via webhook while shared
    const queued1 = await callerB.queueFromPack({
      packId: "supper-club",
      recipeId: "garlic-beans",
    });
    const queued2Res = await queuePost(
      queueReq({ packId: "supper-club", recipeId: "garlic-beans" }, tokenB),
    );
    expect(queued2Res.status).toBe(201);
    const queued2Id = ((await queued2Res.json()) as { id: string }).id;

    // While shared, getKitchenQueueItem reads natively with sourcePack metadata
    const nativeItem = await callerB.getKitchenQueueItem({ queueId: queued1.id });
    expect(nativeItem?.reading).toBe("native");
    expect(nativeItem?.sourcePack?.packId).toBe("supper-club");
    expect(nativeItem?.packRecipe?.steps[1]?.type).toBe("checkpoint");

    // Start cooking queued1 before unsharing
    await callerB.updateKitchenQueueStatus({
      queueId: queued1.id,
      status: "cooking",
    });

    // Unshare from Kitchen B -> disappears immediately from B's shelf/APIs
    await unshareKitchenPack(
      { pack: "supper-club", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );
    expect((await callerB.getShelf()).creators.map((c) => c.id)).not.toContain(
      "supper-club",
    );
    expect(await callerB.getPack({ packId: "supper-club" })).toBeNull();
    await expect(
      callerB.queueFromPack({ packId: "supper-club", recipeId: "garlic-beans" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await packsGet(packsReq("/api/packs?pack=supper-club&recipe=garlic-beans", tokenB)))
        .status,
    ).toBe(404);
    expect(
      (await queuePost(queueReq({ packId: "supper-club", recipeId: "garlic-beans" }, tokenB)))
        .status,
    ).toBe(404);

    // Kitchen B's in-progress and queued rows STILL open and cook cleanly from their stored snapshot
    const afterUnshare1 = await callerB.getKitchenQueueItem({ queueId: queued1.id });
    expect(afterUnshare1?.conversionError).toBeNull();
    expect(afterUnshare1?.packRecipe?.title).toBe("Garlic Beans");
    expect(afterUnshare1?.packRecipe?.steps).toHaveLength(2);
    await callerB.updateKitchenQueueStatus({
      queueId: queued1.id,
      status: "completed",
    });

    const afterUnshare2 = await callerB.getKitchenQueueItem({ queueId: queued2Id });
    expect(afterUnshare2?.conversionError).toBeNull();
    expect(afterUnshare2?.packRecipe?.title).toBe("Garlic Beans");

    // Re-share, queue a third row, then owner removes the pack entirely
    await shareKitchenPack(
      { pack: "supper-club", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );
    const queued3 = await callerB.queueFromPack({
      packId: "supper-club",
      recipeId: "garlic-beans",
    });
    await removeKitchenPack({ pack: "supper-club", kitchenSlug: "kitchen-a" }, db);

    expect((await callerA.getShelf()).creators.map((c) => c.id)).not.toContain("supper-club");
    expect((await callerB.getShelf()).creators.map((c) => c.id)).not.toContain("supper-club");

    const afterRemove = await callerB.getKitchenQueueItem({ queueId: queued3.id });
    expect(afterRemove?.conversionError).toBeNull();
    expect(afterRemove?.packRecipe?.title).toBe("Garlic Beans");
  });
});

describe("ISO-PACK-3: AI cook-plan metering is charged to the cooking kitchen", () => {
  it("records ai_usage under kitchen B (the cooking kitchen), never kitchen A (the pack owner)", async () => {
    await addKitchenPack(
      {
        kitchenSlug: "kitchen-a",
        rawBytes: JSON.stringify(makeOwnedPack("supper-club", "Supper Club")),
      },
      db,
    );
    await shareKitchenPack(
      { pack: "supper-club", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );

    // 1. Background derivation scheduled by queueFromPack charges kitchen B
    const queued = await callerB.queueFromPack({
      packId: "supper-club",
      recipeId: "garlic-beans",
    });
    expect(scheduled).toHaveLength(1);
    fakeProvider.onNextChat(() => ({
      content: validTwoStepPlanJson(),
      finishReason: "stop",
      usage: { inputTokens: 800, outputTokens: 200 },
    }));
    await scheduled[0]!();

    const usageAfterBg = await db.select().from(aiUsage);
    expect(usageAfterBg).toHaveLength(1);
    expect(usageAfterBg[0]!.kitchenId).toBe(kitchenB.id);
    expect(usageAfterBg[0]!.feature).toBe("cook-plan");
    expect(usageAfterBg[0]!.status).toBe("settled");

    const usageForA = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.kitchenId, kitchenA.id));
    expect(usageForA).toHaveLength(0);

    // 2. Even if unshared before ensureCookPlan runs, ensureCookPlan succeeds and charges kitchen B
    const queuedAfter = await callerB.queueFromPack({
      packId: "supper-club",
      recipeId: "garlic-beans",
    });
    await unshareKitchenPack(
      { pack: "supper-club", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );
    fakeProvider.onNextChat(() => ({
      content: validTwoStepPlanJson(),
      finishReason: "stop",
      usage: { inputTokens: 900, outputTokens: 250 },
    }));
    const planOutcome = await callerB.ensureCookPlan({ queueId: queuedAfter.id });
    expect(planOutcome.error).toBeNull();
    expect(planOutcome.plan).not.toBeNull();

    const usageForB = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.kitchenId, kitchenB.id));
    expect(usageForB).toHaveLength(2);
    expect(
      await db.select().from(aiUsage).where(eq(aiUsage.kitchenId, kitchenA.id)),
    ).toHaveLength(0);
    expect(queued.id).not.toBe(queuedAfter.id);
  });
});

describe("ISO-PACK-4: collision precedence and single-kitchen mode", () => {
  it("keeps kitchen B's own pack ahead of a shared pack with the same packId", async () => {
    await addKitchenPack(
      {
        kitchenSlug: "kitchen-a",
        rawBytes: JSON.stringify(makeOwnedPack("same-id", "Kitchen A Edition")),
      },
      db,
    );
    await addKitchenPack(
      {
        kitchenSlug: "kitchen-b",
        rawBytes: JSON.stringify(makeOwnedPack("same-id", "Kitchen B Edition")),
      },
      db,
    );
    await shareKitchenPack(
      { pack: "same-id", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );

    const shelfB = await callerB.getShelf();
    const matching = shelfB.creators.filter((c) => c.id === "same-id");
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      title: "Kitchen B Edition",
      isOwned: true,
    });
    expect(matching[0]!.fromKitchenName).toBeUndefined();
  });

  it("supports owned packs and cooking in single-kitchen mode", async () => {
    await client.exec(
      "delete from kitchen_pack_shares; delete from kitchen_packs; delete from ai_usage; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user; delete from kitchens where slug <> 'home';",
    );
    stubSignInEnv({ SOUS_SIGN_IN: "off" });
    resetDeploymentCheckForTests(db);

    await addKitchenPack(
      {
        kitchenSlug: "home",
        rawBytes: JSON.stringify(makeOwnedPack("home-book", "Home Extras")),
      },
      db,
    );
    const homeCtx = await createTRPCContext();
    const homeCaller = appRouter.createCaller(homeCtx);
    const homeShelf = await homeCaller.getShelf();
    expect(homeShelf.creators.map((c) => c.id)).toContain("home-book");
    const homePack = await homeCaller.getPack({ packId: "home-book" });
    expect(homePack).toMatchObject({ id: "home-book", isOwned: true });
    const homeQueued = await homeCaller.queueFromPack({
      packId: "home-book",
      recipeId: "garlic-beans",
    });
    const homeItem = await homeCaller.getKitchenQueueItem({ queueId: homeQueued.id });
    expect(homeItem?.reading).toBe("native");
  });
});
