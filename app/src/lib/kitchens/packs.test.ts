import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db, kitchenPackShares, kitchenPacks } from "@/lib/db";
import { seedKitchen, type KitchenRow } from "@/lib/__tests__/kitchens";
import { stubSignInEnv } from "@/lib/__tests__/test-auth";
import {
  KitchenPackError,
  MAX_KITCHEN_PACKS_PER_KITCHEN,
  MAX_KITCHEN_PACK_BYTES,
  addKitchenPack,
  getOwnedKitchenPackRaw,
  listKitchenPacks,
  listOwnedKitchenPacksForKitchen,
  readVisibleKitchenPacks,
  removeKitchenPack,
  removeOwnedKitchenPack,
  shareKitchenPack,
  unshareKitchenPack,
  upsertKitchenPackByKitchenId,
} from "./packs";

const client = (dbModule as unknown as { client: PGlite }).client;

function validPackJson(id = "sunday-braises", overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Pack ${id}`,
    version: "1.0.0",
    creator: { name: "Chef Tester" },
    recipes: [
      {
        id: "r1",
        title: "Simple Broth",
        serves_base: 4,
        ingredients: [
          {
            id: "i1",
            name: "Water",
            qty_canonical: { volume_ml: 1000 },
            display_equivalents: { imperial: { unit: "cup", amount: 4 } },
          },
        ],
        steps: [
          {
            id: "s1",
            type: "action",
            text: "Simmer the water for 10 minutes.",
            ingredient_refs: ["i1"],
            timer_sec: 600,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function padPackToExactBytes(targetBytes: number, id = "sized-pack"): Buffer {
  const base = validPackJson(id, { description: "" });
  const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
  const paddingNeeded = targetBytes - baseBytes;
  if (paddingNeeded < 0) {
    throw new Error(`Base pack (${baseBytes} bytes) already exceeds ${targetBytes}`);
  }
  const padded = { ...base, description: "x".repeat(paddingNeeded) };
  const buf = Buffer.from(JSON.stringify(padded), "utf8");
  if (buf.byteLength !== targetBytes) {
    throw new Error(`Expected ${targetBytes} bytes, got ${buf.byteLength}`);
  }
  return buf;
}

async function expectPackError(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(KitchenPackError);
  expect((caught as Error).message).toMatch(pattern);
}

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;

beforeEach(async () => {
  stubSignInEnv();
  await client.exec(
    "delete from kitchen_pack_shares; delete from kitchen_packs; delete from ai_usage; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchenA = (await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" })).kitchen;
  kitchenB = (await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" })).kitchen;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("kitchen packs management", () => {
  it("adds a valid pack from file, lists it, and removes it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sous-pack-test-"));
    try {
      const filePath = path.join(dir, "braises.json");
      await writeFile(filePath, JSON.stringify(validPackJson("braises")));

      const added = await addKitchenPack(
        { kitchenSlug: "kitchen-a", filePath },
        db,
      );
      expect(added.packId).toBe("braises");
      expect(added.kitchenSlug).toBe("kitchen-a");
      expect(added.title).toBe("Pack braises");
      expect(added.sizeBytes).toBeGreaterThan(0);

      const listed = await listKitchenPacks({}, db);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.packId).toBe("braises");
      expect(listed[0]!.shares).toEqual([]);

      const filteredB = await listKitchenPacks({ kitchenSlug: "kitchen-b" }, db);
      expect(filteredB).toEqual([]);

      const removed = await removeKitchenPack(
        { pack: "braises", kitchenSlug: "kitchen-a" },
        db,
      );
      expect(removed.id).toBe(added.id);
      expect(await listKitchenPacks({}, db)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses bad JSON, parsePack faults, and verifyPackRefs faults naming the first fault", async () => {
    await expectPackError(
      addKitchenPack({ kitchenSlug: "kitchen-a", rawBytes: "{not json" }, db),
      /Invalid JSON/,
    );

    await expectPackError(
      addKitchenPack(
        {
          kitchenSlug: "kitchen-a",
          rawBytes: JSON.stringify(validPackJson("bad-schema", { recipes: [] })),
        },
        db,
      ),
      /Invalid pack at recipes:/,
    );

    const badRef = validPackJson("bad-ref");
    badRef.recipes[0]!.steps[0] = {
      id: "s1",
      type: "action",
      text: "Cook.",
      technique_refs: ["commons:no-such-technique"],
    } as never;
    await expectPackError(
      addKitchenPack(
        { kitchenSlug: "kitchen-a", rawBytes: JSON.stringify(badRef) },
        db,
      ),
      /Invalid pack reference at recipes\.0\.steps\.0\.technique_refs:.*no-such-technique/,
    );
  });

  it("refuses reserved pack ids, household kind, and unsafe pack ids", async () => {
    await expectPackError(
      addKitchenPack(
        {
          kitchenSlug: "kitchen-a",
          rawBytes: JSON.stringify(validPackJson("household-book")),
        },
        db,
      ),
      /reserved/,
    );

    await expectPackError(
      addKitchenPack(
        {
          kitchenSlug: "kitchen-a",
          rawBytes: JSON.stringify(validPackJson("fannie-farmer-1896")),
        },
        db,
      ),
      /reserved/,
    );

    await expectPackError(
      addKitchenPack(
        {
          kitchenSlug: "kitchen-a",
          rawBytes: JSON.stringify(
            validPackJson("my-household", { kind: "household" }),
          ),
        },
        db,
      ),
      /kind "household"/,
    );

    await expectPackError(
      addKitchenPack(
        {
          kitchenSlug: "kitchen-a",
          rawBytes: JSON.stringify(validPackJson("bad/id")),
        },
        db,
      ),
      /unsupported characters/,
    );
  });

  it("accepts a pack at exactly 2,097,152 bytes and refuses 2,097,153 bytes or empty", async () => {
    await expectPackError(
      addKitchenPack({ kitchenSlug: "kitchen-a", rawBytes: Buffer.alloc(0) }, db),
      /empty/,
    );

    const overBytes = padPackToExactBytes(MAX_KITCHEN_PACK_BYTES + 1, "over-2mb");
    await expectPackError(
      addKitchenPack({ kitchenSlug: "kitchen-a", rawBytes: overBytes }, db),
      /2097153 bytes.*2097152-byte/,
    );

    const exactBytes = padPackToExactBytes(MAX_KITCHEN_PACK_BYTES, "exact-2mb");
    const added = await addKitchenPack(
      { kitchenSlug: "kitchen-a", rawBytes: exactBytes },
      db,
    );
    expect(added.sizeBytes).toBe(MAX_KITCHEN_PACK_BYTES);
  });

  it("enforces at most 20 owned packs per kitchen and unique packId per kitchen", async () => {
    for (let i = 1; i <= MAX_KITCHEN_PACKS_PER_KITCHEN; i++) {
      await addKitchenPack(
        {
          kitchenSlug: "kitchen-a",
          rawBytes: JSON.stringify(validPackJson(`pack-${i}`)),
        },
        db,
      );
    }

    await expectPackError(
      addKitchenPack(
        {
          kitchenSlug: "kitchen-a",
          rawBytes: JSON.stringify(validPackJson("pack-21")),
        },
        db,
      ),
      /already owns 20 packs/,
    );

    // Duplicate packId in kitchen-a is refused even under the 20 check
    await removeKitchenPack({ pack: "pack-20", kitchenSlug: "kitchen-a" }, db);
    await expectPackError(
      addKitchenPack(
        {
          kitchenSlug: "kitchen-a",
          rawBytes: JSON.stringify(validPackJson("pack-1")),
        },
        db,
      ),
      /already owns a pack with id "pack-1"/,
    );

    // Kitchen B can still own a pack with the same packId ("pack-1")
    const bPack = await addKitchenPack(
      {
        kitchenSlug: "kitchen-b",
        rawBytes: JSON.stringify(validPackJson("pack-1")),
      },
      db,
    );
    expect(bPack.kitchenSlug).toBe("kitchen-b");

    // Removing by ambiguous packId without --kitchen refuses; UUID succeeds
    await expectPackError(
      removeKitchenPack({ pack: "pack-1" }, db),
      /multiple kitchens.*--kitchen/,
    );
    const removedB = await removeKitchenPack({ pack: bPack.id }, db);
    expect(removedB.kitchenSlug).toBe("kitchen-b");
  });

  it("shares and unshares packs across kitchens, cascades on remove, and refuses in single-kitchen mode", async () => {
    const added = await addKitchenPack(
      {
        kitchenSlug: "kitchen-a",
        rawBytes: JSON.stringify(validPackJson("shared-suppers")),
      },
      db,
    );

    // Cannot share with self
    await expectPackError(
      shareKitchenPack(
        { pack: "shared-suppers", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-a" },
        db,
      ),
      /own kitchen/,
    );

    // Share A -> B
    const shared = await shareKitchenPack(
      { pack: "shared-suppers", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );
    expect(shared.alreadyShared).toBe(false);

    // Idempotent re-share
    const reShared = await shareKitchenPack(
      { pack: added.id, withKitchenSlug: "kitchen-b" },
      db,
    );
    expect(reShared.alreadyShared).toBe(true);

    // Listed shares on owner side
    const listed = await listKitchenPacks({ kitchenSlug: "kitchen-a" }, db);
    expect(listed[0]!.shares).toEqual([
      { kitchenId: kitchenB.id, slug: "kitchen-b", name: "Kitchen B" },
    ]);

    // Visible packs for A and B
    const visibleA = await readVisibleKitchenPacks(kitchenA.id, db);
    expect(visibleA).toHaveLength(1);
    expect(visibleA[0]).toMatchObject({ isOwned: true, fromKitchenName: null });

    const visibleB = await readVisibleKitchenPacks(kitchenB.id, db);
    expect(visibleB).toHaveLength(1);
    expect(visibleB[0]).toMatchObject({ isOwned: false, fromKitchenName: "Kitchen A" });

    // Unshare
    const unshared = await unshareKitchenPack(
      { pack: "shared-suppers", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );
    expect(unshared.removed).toBe(true);
    expect(await readVisibleKitchenPacks(kitchenB.id, db)).toEqual([]);

    const unsharedAgain = await unshareKitchenPack(
      { pack: "shared-suppers", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );
    expect(unsharedAgain.removed).toBe(false);

    // Re-share then remove pack -> share row cascades away
    await shareKitchenPack(
      { pack: "shared-suppers", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );
    await removeKitchenPack({ pack: added.id }, db);
    expect(await db.select().from(kitchenPacks)).toEqual([]);
    expect(await db.select().from(kitchenPackShares)).toEqual([]);

    // Single-kitchen mode refuses share and unshare and omits shares from readVisibleKitchenPacks
    const homeAdded = await addKitchenPack(
      {
        kitchenSlug: "home",
        rawBytes: JSON.stringify(validPackJson("home-pack")),
      },
      db,
    );
    const singleEnv = { SOUS_SIGN_IN: "off" };
    await expectPackError(
      shareKitchenPack(
        { pack: homeAdded.id, withKitchenSlug: "kitchen-b" },
        db,
        singleEnv,
      ),
      /single-kitchen mode/,
    );
    await expectPackError(
      unshareKitchenPack(
        { pack: homeAdded.id, withKitchenSlug: "kitchen-b" },
        db,
        singleEnv,
      ),
      /single-kitchen mode/,
    );

    await shareKitchenPack(
      { pack: homeAdded.id, withKitchenSlug: "kitchen-b" },
      db,
    );
    expect(await readVisibleKitchenPacks(kitchenB.id, db)).toHaveLength(1);
    stubSignInEnv({ SOUS_SIGN_IN: "off" });
    expect(await readVisibleKitchenPacks(kitchenB.id, db)).toEqual([]);
  });

  it("upserts in place preserving row UUID and circle shares, blocks reserved 'new' and media refs, and enforces queue round-trip", async () => {
    await expectPackError(
      upsertKitchenPackByKitchenId(
        kitchenA.id,
        { rawBytes: JSON.stringify(validPackJson("new")) },
        db,
      ),
      /reserved/,
    );

    await expectPackError(
      upsertKitchenPackByKitchenId(
        kitchenA.id,
        {
          rawBytes: JSON.stringify(
            validPackJson("with-cover", { cover_ref: "/packs/media/x.jpg" }),
          ),
        },
        db,
      ),
      /cover_ref or step media_ref/,
    );

    const blankStepPack = validPackJson("uncookable");
    blankStepPack.recipes[0]!.steps[0]!.text = "   ";
    await expectPackError(
      upsertKitchenPackByKitchenId(
        kitchenA.id,
        { rawBytes: JSON.stringify(blankStepPack) },
        db,
      ),
      /Invalid recipe/,
    );

    const created = await upsertKitchenPackByKitchenId(
      kitchenA.id,
      { rawBytes: JSON.stringify(validPackJson("weeknight-pot", { title: "First Edition" })) },
      db,
    );
    expect(created.updated).toBe(false);
    expect(created.title).toBe("First Edition");

    await shareKitchenPack(
      { pack: "weeknight-pot", kitchenSlug: "kitchen-a", withKitchenSlug: "kitchen-b" },
      db,
    );

    const updated = await upsertKitchenPackByKitchenId(
      kitchenA.id,
      { rawBytes: JSON.stringify(validPackJson("weeknight-pot", { title: "Second Edition" })) },
      db,
    );
    expect(updated.updated).toBe(true);
    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe("Second Edition");

    const listed = await listOwnedKitchenPacksForKitchen(kitchenA.id, db);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("Second Edition");

    const raw = await getOwnedKitchenPackRaw(kitchenA.id, "weeknight-pot", db);
    expect(raw?.packJson.title).toBe("Second Edition");
    expect(await getOwnedKitchenPackRaw(kitchenB.id, "weeknight-pot", db)).toBeNull();

    // Share survived the in-place update
    const visibleB = await readVisibleKitchenPacks(kitchenB.id, db);
    expect(visibleB).toHaveLength(1);
    expect((visibleB[0]?.packJson as { title: string } | undefined)?.title).toBe(
      "Second Edition",
    );

    // Cross-kitchen remove fails cleanly, owner remove succeeds
    expect(await removeOwnedKitchenPack(kitchenB.id, "weeknight-pot", db)).toEqual({
      removed: false,
      packId: "weeknight-pot",
    });
    expect(await removeOwnedKitchenPack(kitchenA.id, "weeknight-pot", db)).toEqual({
      removed: true,
      packId: "weeknight-pot",
    });
  });
});
