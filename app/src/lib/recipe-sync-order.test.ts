/**
 * The Doc's order on the library (slice S, S-D9) against a real Postgres
 * (PGlite, in memory): the order pass is one hand-written UPDATE, and the
 * shelf's read sorts on it, so both run as SQL rather than against a mocked
 * query builder.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("./__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "./db";
import { db, docRecipes } from "./db";
import { readFamilyLibrary, writeDocOrder, type RecipeChunk } from "./recipe-sync";

const client = (dbModule as unknown as { client: PGlite }).client;

beforeEach(async () => {
  await client.exec("delete from doc_recipes");
});

async function row(docSlug: string, over: Partial<typeof docRecipes.$inferInsert> = {}) {
  await db.insert(docRecipes).values({ docSlug, name: docSlug, rawDocText: docSlug, ...over });
}

const chunk = (docSlug: string, position: number, categoryTitle: string | null): RecipeChunk => ({
  docSlug,
  name: docSlug,
  category: categoryTitle?.toLowerCase() ?? null,
  categoryTitle,
  position,
  rawText: docSlug,
  nonText: false,
});

async function order() {
  const rows = await db
    .select({ slug: docRecipes.docSlug, pos: docRecipes.docPosition, title: docRecipes.categoryTitle })
    .from(docRecipes)
    .orderBy(docRecipes.docSlug);
  return Object.fromEntries(rows.map((r) => [r.slug, [r.pos, r.title]]));
}

describe("writeDocOrder", () => {
  it("gives every row the walk produces its place and its chapter as the Doc writes it", async () => {
    await row("dal");
    await row("mole", { docPosition: 9, categoryTitle: "old" });
    await writeDocOrder([chunk("mole", 0, "Seasonal Specials"), chunk("dal", 1, "Indian")]);
    expect(await order()).toEqual({ dal: [1, "Indian"], mole: [0, "Seasonal Specials"] });
  });

  it("takes the place from a row the walk no longer produces, keeping its last chapter", async () => {
    await row("minced-lamb", { docPosition: 4, categoryTitle: "Indian" });
    await row("dal", { docPosition: 0, categoryTitle: "Indian" });
    await writeDocOrder([chunk("dal", 0, "Indian")]);
    expect(await order()).toEqual({ dal: [0, "Indian"], "minced-lamb": [null, "Indian"] });
  });

  it("follows a tab moved to another chapter, and a renamed chapter", async () => {
    await row("dal", { docPosition: 0, categoryTitle: "Indian" });
    await row("fritters", { docPosition: 1, categoryTitle: "quick & easy" });
    await writeDocOrder([chunk("fritters", 0, "Sides"), chunk("dal", 1, "Indian food")]);
    expect(await order()).toEqual({ dal: [1, "Indian food"], fritters: [0, "Sides"] });
  });

  it("clears every place when the walk produces none of the rows", async () => {
    await row("dal", { docPosition: 0, categoryTitle: "Indian" });
    await writeDocOrder([]);
    expect(await order()).toEqual({ dal: [null, "Indian"] });
  });

  it("writes a failed extraction's place too", async () => {
    await row("crackers", { extractionError: "no recipe" });
    await writeDocOrder([chunk("crackers", 3, "Baking")]);
    expect(await order()).toEqual({ crackers: [3, "Baking"] });
  });
});

describe("readFamilyLibrary", () => {
  it("reads every row, failed ones included, in Doc order, rows with no place last by name", async () => {
    await row("zucchini", { docPosition: null });
    await row("apple-pie", { docPosition: null });
    await row("dal", { docPosition: 1 });
    await row("crackers", { docPosition: 0, extractionError: "no recipe" });
    expect((await readFamilyLibrary()).map((r) => r.docSlug)).toEqual(["crackers", "dal", "apple-pie", "zucchini"]);
  });
});
