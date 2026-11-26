import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("./hooks/types");
  return {
    connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, true])),
  };
});
vi.mock("@/lib/db", async () =>
  (await import("./__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import {
  circleMembers,
  db,
  docRecipes,
  kitchenCookLog,
  kitchenQueue,
} from "@/lib/db";
import { seedKitchen, type KitchenRow } from "@/lib/__tests__/kitchens";
import { stubSignInEnv } from "@/lib/__tests__/test-auth";
import {
  addKitchenToCircle,
  createCircle,
  removeKitchenFromCircle,
} from "./kitchens/circles";
import { addKitchenPack, shareKitchenPack } from "./kitchens/packs";
import { removeFromQueue } from "./kitchen-queue";
import {
  CircleNotAvailableError,
  PackCircleShareError,
  getCircleDishesForKitchen,
  getPackCircleSharesForOwner,
  resolveAccessibleCircleDish,
  resolveSharedRecipe,
  setPackCircleShareForOwner,
} from "./circle-dishes";
import {
  logCook,
  rateCook,
  setCookLogHeldBack,
  updateCookLogEntry,
} from "./kitchen-cook-log";
import { PACKS_DIR } from "./shelf/load";

const client = (dbModule as unknown as { client: PGlite }).client;

const SAMPLE_RECIPE = {
  name: "Roasted Carrot Soup",
  ingredients: [
    { item: "carrots", amount: "1", unit: "lb" },
    { item: "olive oil", amount: "2", unit: "tbsp" },
  ],
  steps: ["Roast carrots at 400F.", "Blend with broth until smooth."],
  serves: 4,
};

function validPackJson(id = "circle-suppers") {
  return {
    id,
    title: "Circle Suppers",
    version: "1.0.0",
    creator: { name: "Chef Maple" },
    recipes: [
      {
        id: "herb-beans",
        title: "Herb White Beans",
        serves_base: 4,
        ingredients: [
          {
            id: "i1",
            name: "Cannellini beans",
            qty_canonical: { mass_g: 400 },
            display_equivalents: { metric: { unit: "g", amount: 400 } },
          },
        ],
        steps: [
          {
            id: "s1",
            type: "action",
            text: "Simmer the beans with herbs for 15 minutes.",
            ingredient_refs: ["i1"],
            timer_sec: 900,
          },
        ],
      },
    ],
  };
}

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;
let kitchenC: KitchenRow;
let circleId: string;

beforeEach(async () => {
  stubSignInEnv();
  await client.exec(
    "delete from circle_members; delete from circles; delete from kitchen_pack_shares; delete from kitchen_packs; delete from kitchen_cook_log; delete from doc_recipes; delete from kitchen_queue; delete from ai_usage; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchenA = (await seedKitchen(db, { slug: "maple", name: "Maple Kitchen" })).kitchen;
  kitchenB = (await seedKitchen(db, { slug: "cedar", name: "Cedar Kitchen" })).kitchen;
  kitchenC = (await seedKitchen(db, { slug: "birch", name: "Birch Kitchen" })).kitchen;

  const circle = await createCircle({ name: "Sunday Cooks" }, db);
  circleId = circle.id;
  await addKitchenToCircle({ circleId, kitchenSlug: "maple" }, db);
  await addKitchenToCircle({ circleId, kitchenSlug: "cedar" }, db);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("circle home dishes, showing rule, privacy, before-join, and leaving", () => {
  it("shows each other circle kitchen's latest showing dish, hiding rating<=3 by default and allowing 1-tap toggle", async () => {
    const joinedAfter = new Date(Date.now() + 1_000);
    // Unrated dish shows by itself
    const [unrated] = await db
      .insert(kitchenCookLog)
      .values({
        kitchenId: kitchenA.id,
        recipeTitle: "Unrated Focaccia",
        recipeSnapshot: { ...SAMPLE_RECIPE, name: "Unrated Focaccia" },
        timestampText: "2026-11-24 18:00",
        cookedDay: "2026-11-24",
        cookedAt: joinedAfter,
        rating: null,
        notes: "Crisp crust",
        notePrivate: false,
        heldBack: false,
      })
      .returning();

    const dishesForB = await getCircleDishesForKitchen(kitchenB.id, db);
    expect(dishesForB).toEqual([
      {
        logId: unrated!.id,
        recipeTitle: "Unrated Focaccia",
        kitchenName: "Maple Kitchen",
        cookedDay: "2026-11-24",
        rating: null,
        note: "Crisp crust",
        canOpenRecipe: true,
        packBlocked: false,
      },
    ]);
    // Own dishes never show
    expect(await getCircleDishesForKitchen(kitchenA.id, db)).toEqual([]);
    // Non-circle kitchen sees nothing
    expect(await getCircleDishesForKitchen(kitchenC.id, db)).toEqual([]);

    // Rating 3 via updateCookLogEntry auto-holds back, falling back to nothing when only 1 dish
    await updateCookLogEntry(kitchenA.id, {
      id: unrated!.id,
      rating: 3,
    });
    expect(await getCircleDishesForKitchen(kitchenB.id, db)).toEqual([]);

    // One-tap toggle on log entry shows it despite rating 3
    await updateCookLogEntry(kitchenA.id, {
      id: unrated!.id,
      heldBack: false,
    });
    expect((await getCircleDishesForKitchen(kitchenB.id, db))[0]?.rating).toBe(3);
  });

  it("supports one-tap hold-back from 'How was it?' before rating and preserves choice on subsequent rating", async () => {
    const [qRow] = await db
      .insert(kitchenQueue)
      .values({
        kitchenId: kitchenA.id,
        recipeData: SAMPLE_RECIPE,
        status: "completed",
        completedAt: new Date(Date.now() + 2_000),
        cookLog: {
          row: 2,
          timestamp: "2026-11-24 19:00",
          recipeName: SAMPLE_RECIPE.name,
          adopted: false,
        },
      })
      .returning();
    await db.insert(kitchenCookLog).values({
      kitchenId: kitchenA.id,
      queueId: qRow!.id,
      recipeTitle: SAMPLE_RECIPE.name,
      recipeSnapshot: SAMPLE_RECIPE,
      timestampText: "2026-11-24 19:00",
      cookedDay: "2026-11-24",
      cookedAt: new Date(Date.now() + 2_000),
      heldBack: false,
      visibilityChosen: false,
    });

    // Unrated shows right away
    expect(await getCircleDishesForKitchen(kitchenB.id, db)).toHaveLength(1);

    // One tap on "How was it?" holds it back immediately
    await setCookLogHeldBack(kitchenA.id, qRow!.id, true);
    expect(await getCircleDishesForKitchen(kitchenB.id, db)).toEqual([]);

    // Rating 5 afterward respects visibilityChosen=true and keeps it held back
    await rateCook(kitchenA.id, { queueId: qRow!.id, rating: 5 });
    expect(await getCircleDishesForKitchen(kitchenB.id, db)).toEqual([]);

    // Toggling back to show via cook log exposes it immediately
    const [logRow] = await db
      .select({ id: kitchenCookLog.id })
      .from(kitchenCookLog)
      .where(eq(kitchenCookLog.queueId, qRow!.id));
    await updateCookLogEntry(kitchenA.id, { id: logRow!.id, heldBack: false });
    expect(await getCircleDishesForKitchen(kitchenB.id, db)).toHaveLength(1);
  });

  it("hides private notes when written or toggled later, and never shows cooks or notes from before joining", async () => {
    const [membershipA] = await db
      .select({ joinedAt: circleMembers.joinedAt })
      .from(circleMembers)
      .where(eq(circleMembers.kitchenId, kitchenA.id));

    const beforeJoin = new Date(membershipA!.joinedAt.getTime() - 60_000);
    const afterJoin = new Date(membershipA!.joinedAt.getTime() + 60_000);

    const [preJoinDish] = await db
      .insert(kitchenCookLog)
      .values({
        kitchenId: kitchenA.id,
        recipeTitle: "Old Pie",
        recipeSnapshot: { ...SAMPLE_RECIPE, name: "Old Pie" },
        timestampText: "2026-11-20 18:00",
        cookedDay: "2026-11-20",
        cookedAt: beforeJoin,
        rating: 5,
        notes: "Old secret note",
        heldBack: false,
      })
      .returning();

    // Pre-join dish is never shown on home or openable directly
    expect(await getCircleDishesForKitchen(kitchenB.id, db)).toEqual([]);
    await expect(
      resolveAccessibleCircleDish(kitchenB.id, preJoinDish!.id, db),
    ).rejects.toBeInstanceOf(CircleNotAvailableError);

    // Post-join dish with pre-join noteUpdatedAt suppresses old note
    const [postJoinDish] = await db
      .insert(kitchenCookLog)
      .values({
        kitchenId: kitchenA.id,
        recipeTitle: "New Stew",
        recipeSnapshot: { ...SAMPLE_RECIPE, name: "New Stew" },
        timestampText: "2026-11-25 18:00",
        cookedDay: "2026-11-25",
        cookedAt: afterJoin,
        rating: 4,
        notes: "Carried over note",
        notePrivate: false,
        noteUpdatedAt: beforeJoin,
        heldBack: false,
      })
      .returning();

    expect((await getCircleDishesForKitchen(kitchenB.id, db))[0]?.note).toBeNull();

    // Updating note post-join reveals it; marking notePrivate hides it
    await updateCookLogEntry(kitchenA.id, {
      id: postJoinDish!.id,
      notes: "Great with sourdough",
    });
    expect((await getCircleDishesForKitchen(kitchenB.id, db))[0]?.note).toBe(
      "Great with sourdough",
    );

    await updateCookLogEntry(kitchenA.id, {
      id: postJoinDish!.id,
      notePrivate: true,
    });
    expect((await getCircleDishesForKitchen(kitchenB.id, db))[0]?.note).toBeNull();
  });

  it("blocks opening private recipes and shows only title for unseen packs until shared", async () => {
    const afterJoin = new Date(Date.now() + 5_000);
    const [docA] = await db
      .insert(docRecipes)
      .values({
        kitchenId: kitchenA.id,
        docSlug: "family-dal",
        name: "Family Dal",
        ingredients: SAMPLE_RECIPE.ingredients,
        steps: SAMPLE_RECIPE.steps,
        serves: 4,
        rawDocText: "Family Dal\n1 lb carrots",
        isPrivate: true,
      })
      .returning();

    const [privateDish] = await db
      .insert(kitchenCookLog)
      .values({
        kitchenId: kitchenA.id,
        docRecipeId: docA!.id,
        recipeTitle: "Family Dal",
        recipeSnapshot: { ...SAMPLE_RECIPE, name: "Family Dal" },
        timestampText: "2026-11-25 19:00",
        cookedDay: "2026-11-25",
        cookedAt: afterJoin,
        rating: 5,
        notes: "Rich spice",
        heldBack: false,
      })
      .returning();

    const [homePrivate] = await getCircleDishesForKitchen(kitchenB.id, db);
    expect(homePrivate).toMatchObject({
      recipeTitle: "Family Dal",
      canOpenRecipe: false,
      packBlocked: false,
      rating: 5,
      note: "Rich spice",
    });
    await expect(
      resolveAccessibleCircleDish(kitchenB.id, privateDish!.id, db),
    ).rejects.toBeInstanceOf(CircleNotAvailableError);

    // Owned pack unshared -> packBlocked: only title shows, no rating/note, cannot open
    await addKitchenPack(
      {
        kitchenSlug: "maple",
        rawBytes: JSON.stringify(validPackJson("circle-suppers")),
        packsDir: PACKS_DIR,
      },
      db,
    );
    const [packDish] = await db
      .insert(kitchenCookLog)
      .values({
        kitchenId: kitchenA.id,
        packSource: "pack:circle-suppers/herb-beans",
        recipeTitle: "Herb White Beans",
        recipeSnapshot: {
          name: "Herb White Beans",
          ingredients: [{ item: "Cannellini beans", amount: "400", unit: "g" }],
          steps: ["Simmer the beans with herbs for 15 minutes."],
          serves: 4,
          source: "pack:circle-suppers/herb-beans",
        },
        timestampText: "2026-11-25 20:00",
        cookedDay: "2026-11-25",
        cookedAt: new Date(afterJoin.getTime() + 1_000),
        rating: 5,
        notes: "Secret pack note",
        heldBack: false,
      })
      .returning();

    const [blockedView] = await getCircleDishesForKitchen(kitchenB.id, db);
    expect(blockedView).toMatchObject({
      recipeTitle: "Herb White Beans",
      rating: null,
      note: null,
      canOpenRecipe: false,
      packBlocked: true,
    });
    await expect(
      resolveAccessibleCircleDish(kitchenB.id, packDish!.id, db),
    ).rejects.toBeInstanceOf(CircleNotAvailableError);

    // Sharing pack with Cedar exposes full dish & allows opening
    await shareKitchenPack(
      { pack: "circle-suppers", kitchenSlug: "maple", withKitchenSlug: "cedar" },
      db,
    );
    const [sharedView] = await getCircleDishesForKitchen(kitchenB.id, db);
    expect(sharedView).toMatchObject({
      recipeTitle: "Herb White Beans",
      rating: 5,
      note: "Secret pack note",
      canOpenRecipe: true,
      packBlocked: false,
    });
    const opened = await resolveAccessibleCircleDish(kitchenB.id, packDish!.id, db);
    expect(opened.title).toBe("Herb White Beans");
  });

  it("share links open only for same-circle non-private recipes and give identical error otherwise", async () => {
    const [publicDoc] = await db
      .insert(docRecipes)
      .values({
        kitchenId: kitchenA.id,
        docSlug: "carrot-soup",
        name: SAMPLE_RECIPE.name,
        ingredients: SAMPLE_RECIPE.ingredients,
        steps: SAMPLE_RECIPE.steps,
        serves: 4,
        rawDocText: "Roasted Carrot Soup",
        isPrivate: false,
      })
      .returning();

    const [privateDoc] = await db
      .insert(docRecipes)
      .values({
        kitchenId: kitchenA.id,
        docSlug: "secret-pie",
        name: "Secret Pie",
        ingredients: SAMPLE_RECIPE.ingredients,
        steps: SAMPLE_RECIPE.steps,
        serves: 4,
        rawDocText: "Secret Pie",
        isPrivate: true,
      })
      .returning();

    // Same-circle viewer opens public doc
    const opened = await resolveSharedRecipe(kitchenB.id, publicDoc!.id, db);
    expect(opened.title).toBe(SAMPLE_RECIPE.name);

    // Outside-circle, private, nonexistent, malformed, single-kitchen all produce identical error
    const errOutside = await resolveSharedRecipe(
      kitchenC.id,
      publicDoc!.id,
      db,
    ).catch((e: unknown) => e);
    const errPrivate = await resolveSharedRecipe(
      kitchenB.id,
      privateDoc!.id,
      db,
    ).catch((e: unknown) => e);
    const errMissing = await resolveSharedRecipe(
      kitchenB.id,
      "00000000-0000-4000-8000-000000000999",
      db,
    ).catch((e: unknown) => e);
    const errInvalid = await resolveSharedRecipe(
      kitchenB.id,
      "not-a-uuid",
      db,
    ).catch((e: unknown) => e);
    const errSingle = await resolveSharedRecipe(kitchenB.id, publicDoc!.id, db, {
      SOUS_SIGN_IN: "off",
    }).catch((e: unknown) => e);

    for (const err of [errOutside, errPrivate, errMissing, errInvalid, errSingle]) {
      expect(err).toBeInstanceOf(CircleNotAvailableError);
      expect((err as Error).message).toBe("Not available");
    }

    // Leaving the circle immediately removes dishes and revokes share links
    await removeKitchenFromCircle({ kitchenSlug: "maple" }, db);
    expect(await getCircleDishesForKitchen(kitchenB.id, db)).toEqual([]);
    expect(await getCircleDishesForKitchen(kitchenA.id, db)).toEqual([]);
    await expect(
      resolveSharedRecipe(kitchenB.id, publicDoc!.id, db),
    ).rejects.toBeInstanceOf(CircleNotAvailableError);
  });

  it("manages pack sharing switches for circle kitchens cleanly", async () => {
    await addKitchenPack(
      {
        kitchenSlug: "maple",
        rawBytes: JSON.stringify(validPackJson("maple-pack")),
        packsDir: PACKS_DIR,
      },
      db,
    );

    const initial = await getPackCircleSharesForOwner(
      kitchenA.id,
      "maple-pack",
      db,
    );
    expect(initial).toEqual({
      circleName: "Sunday Cooks",
      kitchens: [
        { kitchenId: kitchenB.id, slug: "cedar", name: "Cedar Kitchen", shared: false },
      ],
    });

    await setPackCircleShareForOwner(
      kitchenA.id,
      kitchenA.slug,
      { packId: "maple-pack", targetKitchenId: kitchenB.id, shared: true },
      db,
    );
    expect(
      (await getPackCircleSharesForOwner(kitchenA.id, "maple-pack", db)).kitchens[0]?.shared,
    ).toBe(true);

    // Cannot toggle sharing for a kitchen outside the circle
    await expect(
      setPackCircleShareForOwner(
        kitchenA.id,
        kitchenA.slug,
        { packId: "maple-pack", targetKitchenId: kitchenC.id, shared: true },
        db,
      ),
    ).rejects.toBeInstanceOf(PackCircleShareError);

    await setPackCircleShareForOwner(
      kitchenA.id,
      kitchenA.slug,
      { packId: "maple-pack", targetKitchenId: kitchenB.id, shared: false },
      db,
    );
    expect(
      (await getPackCircleSharesForOwner(kitchenA.id, "maple-pack", db)).kitchens[0]?.shared,
    ).toBe(false);
  });

  it("keeps private recipes hidden from circle friends after queue item removal or doc toggle", async () => {
    const joinedAfter = new Date(Date.now() + 1_000);
    const [privateQueued] = await db
      .insert(kitchenQueue)
      .values({
        kitchenId: kitchenA.id,
        status: "completed",
        completedAt: joinedAfter,
        isPrivate: true,
        recipeData: SAMPLE_RECIPE,
      })
      .returning();

    const callerA = (await import("@/lib/__tests__/kitchens")).callerFor(kitchenA);
    await logCook(kitchenA.id, privateQueued!.id);
    const rateResult = await rateCook(kitchenA.id, {
      queueId: privateQueued!.id,
      rating: 5,
    });
    expect(rateResult.rated).toBe(true);
    if (rateResult.rated) {
      expect(rateResult.log.row).toBe(2);
    }

    const [logRow] = await db
      .select()
      .from(kitchenCookLog)
      .where(eq(kitchenCookLog.kitchenId, kitchenA.id));

    // Delete the queue item entirely
    await removeFromQueue(kitchenA.id, privateQueued!.id);

    const summary = await getCircleDishesForKitchen(kitchenB.id, db);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.canOpenRecipe).toBe(false);
    await expect(
      resolveAccessibleCircleDish(kitchenB.id, logRow!.id, db),
    ).rejects.toBeInstanceOf(CircleNotAvailableError);

    // Custom-slug doc_recipes toggled private after cooking & queued item still blocks both routes
    const [customDoc] = await db
      .insert(docRecipes)
      .values({
        kitchenId: kitchenA.id,
        docSlug: "grandmas-special",
        name: "Weeknight Polenta",
        ingredients: [{ item: "cornmeal", amount: "1", unit: "cup" }],
        steps: ["Simmer polenta."],
        serves: 4,
        rawDocText: "Weeknight Polenta",
        isPrivate: false,
      })
      .returning();

    const [polentaQueue] = await db
      .insert(kitchenQueue)
      .values({
        kitchenId: kitchenA.id,
        status: "completed",
        completedAt: new Date(joinedAfter.getTime() + 1_000),
        isPrivate: false,
        recipeData: {
          name: "Weeknight Polenta",
          ingredients: [{ item: "cornmeal", amount: "1", unit: "cup" }],
          steps: ["Simmer polenta."],
          serves: 4,
          source: "library",
        },
      })
      .returning();

    await logCook(kitchenA.id, polentaQueue!.id);
    await rateCook(kitchenA.id, { queueId: polentaQueue!.id, rating: 5 });
    await callerA.setDocRecipePrivate({ docSlug: customDoc!.docSlug, isPrivate: true });

    const [polentaLog] = await db
      .select()
      .from(kitchenCookLog)
      .where(eq(kitchenCookLog.queueId, polentaQueue!.id));
    expect(polentaLog?.recipeIsPrivate).toBe(true);
    await expect(
      resolveAccessibleCircleDish(kitchenB.id, polentaLog!.id, db),
    ).rejects.toBeInstanceOf(CircleNotAvailableError);
    await expect(
      resolveSharedRecipe(kitchenB.id, polentaQueue!.id, db),
    ).rejects.toBeInstanceOf(CircleNotAvailableError);
  });

  it("blocks same-name unshared pack recipes across kitchens even when viewer owns a pack with the same slug", async () => {
    const packA = await addKitchenPack(
      {
        kitchenSlug: "maple",
        rawBytes: JSON.stringify(validPackJson("weekend-bakes")),
        packsDir: PACKS_DIR,
      },
      db,
    );
    await addKitchenPack(
      {
        kitchenSlug: "cedar",
        rawBytes: JSON.stringify(validPackJson("weekend-bakes")),
        packsDir: PACKS_DIR,
      },
      db,
    );

    const [qPack] = await db
      .insert(kitchenQueue)
      .values({
        kitchenId: kitchenA.id,
        status: "completed",
        completedAt: new Date(Date.now() + 1_000),
        sourceKitchenPackId: packA.id,
        recipeData: {
          name: "Herb White Beans",
          ingredients: [{ item: "beans", amount: "400", unit: "g" }],
          steps: ["Simmer beans."],
          serves: 4,
          source: "pack:weekend-bakes/herb-beans",
        },
      })
      .returning();
    await logCook(kitchenA.id, qPack!.id);
    await rateCook(kitchenA.id, {
      queueId: qPack!.id,
      rating: 5,
      notes: "Owned by maple only",
    });

    const [logRow] = await db
      .select()
      .from(kitchenCookLog)
      .where(eq(kitchenCookLog.kitchenId, kitchenA.id));

    const blockedDishes = await getCircleDishesForKitchen(kitchenB.id, db);
    expect(blockedDishes).toHaveLength(1);
    expect(blockedDishes[0]).toMatchObject({
      packBlocked: true,
      canOpenRecipe: false,
      rating: null,
      note: null,
    });
    await expect(
      resolveAccessibleCircleDish(kitchenB.id, logRow!.id, db),
    ).rejects.toBeInstanceOf(CircleNotAvailableError);

    // Sharing kitchenA's exact pack grants kitchenB access
    await shareKitchenPack(
      { pack: "weekend-bakes", kitchenSlug: "maple", withKitchenSlug: "cedar" },
      db,
    );
    const unblockedDishes = await getCircleDishesForKitchen(kitchenB.id, db);
    expect(unblockedDishes[0]?.packBlocked).toBe(false);
    expect(unblockedDishes[0]?.canOpenRecipe).toBe(true);
    const opened = await resolveAccessibleCircleDish(kitchenB.id, logRow!.id, db);
    expect(opened.sourceKitchenPackId).toBe(packA.id);
  });

  it("lets an owner view and turn off active pack shares even after the target or owner leaves the circle", async () => {
    await addKitchenPack(
      {
        kitchenSlug: "maple",
        rawBytes: JSON.stringify(validPackJson("maple-share")),
        packsDir: PACKS_DIR,
      },
      db,
    );
    await setPackCircleShareForOwner(
      kitchenA.id,
      kitchenA.slug,
      { packId: "maple-share", targetKitchenId: kitchenB.id, shared: true },
      db,
    );

    // Target leaves the circle
    await removeKitchenFromCircle({ kitchenSlug: "cedar" }, db);
    const afterTargetLeft = await getPackCircleSharesForOwner(
      kitchenA.id,
      "maple-share",
      db,
    );
    expect(afterTargetLeft.kitchens).toEqual([
      { kitchenId: kitchenB.id, slug: "cedar", name: "Cedar Kitchen", shared: true },
    ]);

    await setPackCircleShareForOwner(
      kitchenA.id,
      kitchenA.slug,
      { packId: "maple-share", targetKitchenId: kitchenB.id, shared: false },
      db,
    );
    expect(
      (await getPackCircleSharesForOwner(kitchenA.id, "maple-share", db)).kitchens,
    ).toEqual([]);

    // Re-add, re-share, then owner leaves the circle
    await addKitchenToCircle({ circleId, kitchenSlug: "cedar" }, db);
    await setPackCircleShareForOwner(
      kitchenA.id,
      kitchenA.slug,
      { packId: "maple-share", targetKitchenId: kitchenB.id, shared: true },
      db,
    );
    await removeKitchenFromCircle({ kitchenSlug: "maple" }, db);

    const afterOwnerLeft = await getPackCircleSharesForOwner(
      kitchenA.id,
      "maple-share",
      db,
    );
    expect(afterOwnerLeft.circleName).toBeNull();
    expect(afterOwnerLeft.kitchens).toEqual([
      { kitchenId: kitchenB.id, slug: "cedar", name: "Cedar Kitchen", shared: true },
    ]);

    await setPackCircleShareForOwner(
      kitchenA.id,
      kitchenA.slug,
      { packId: "maple-share", targetKitchenId: kitchenB.id, shared: false },
      db,
    );
    expect(
      (await getPackCircleSharesForOwner(kitchenA.id, "maple-share", db)).kitchens,
    ).toEqual([]);
  });
});
