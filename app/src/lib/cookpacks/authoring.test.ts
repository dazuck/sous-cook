import { describe, expect, it } from "vitest";
import {
  buildCollectionAuthoringPrompt,
  buildCollectionRepairPrompt,
  extractJsonObjectText,
  slugifyCollectionId,
  validateCollectionJson,
  type CollectionAuthoringContext,
} from "./authoring";

const CONTEXT: CollectionAuthoringContext = {
  commons: [
    { id: "commons:chiffonade", name: "Chiffonade", description: "Thin ribbons." },
  ],
  states: [
    {
      id: "state:golden-brown",
      name: "Golden brown",
      sensory_notes: { look: "Deep amber edges", smell: "Nutty aroma" },
    },
  ],
  reservedPackIds: ["household-book", "fannie-farmer-1896", "new"],
};

function validPackObject(overrides: Record<string, unknown> = {}) {
  return {
    id: "weeknight-suppers",
    title: "Weeknight Suppers",
    version: "1.0.0",
    creator: { name: "Home Cook" },
    cover_ref: null,
    recipes: [
      {
        id: "garlic-beans",
        title: "Garlic White Beans",
        story: "Quick pantry supper.",
        serves_base: 4,
        time_active_min: 10,
        time_total_min: 20,
        tags: ["weeknight"],
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
            text: "Simmer beans for 12 minutes.",
            ingredient_refs: ["i1"],
            timer_sec: 720,
            media_ref: null,
            technique_refs: ["commons:chiffonade"],
            state_refs: ["state:golden-brown"],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("collection authoring helpers", () => {
  it("slugifies titles and avoids reserved pack ids including 'new'", () => {
    expect(slugifyCollectionId("Sunday Suppers & Soups")).toBe(
      "sunday-suppers-soups",
    );
    expect(slugifyCollectionId("New")).toBe("new-collection");
    expect(slugifyCollectionId("Household Book")).toBe(
      "household-book-collection",
    );
    expect(slugifyCollectionId("   ")).toBe("my-collection");
  });

  it("extracts JSON from fenced markdown blocks or surrounding prose", () => {
    expect(extractJsonObjectText('```json\n{"id":"a"}\n```')).toBe('{"id":"a"}');
    expect(extractJsonObjectText('Here it is:\n{"id":"b"}\nDone!')).toBe(
      '{"id":"b"}',
    );
  });

  it("validates Pack Format v0, allowed refs, null media refs, and cook-mode compatibility", () => {
    const ok = validateCollectionJson(JSON.stringify(validPackObject()), CONTEXT);
    expect(ok.ok).toBe(true);

    const badNew = validateCollectionJson(
      JSON.stringify(validPackObject({ id: "new" })),
      CONTEXT,
    );
    expect(badNew.ok).toBe(false);
    if (!badNew.ok) expect(badNew.issues[0]).toMatch(/reserved/);

    const badMedia = validateCollectionJson(
      JSON.stringify(validPackObject({ cover_ref: "/packs/media/cover.jpg" })),
      CONTEXT,
    );
    expect(badMedia.ok).toBe(false);
    if (!badMedia.ok) expect(badMedia.issues[0]).toMatch(/cover_ref/);

    const unknownRefPack = validPackObject();
    unknownRefPack.recipes[0]!.steps[0]!.technique_refs = [
      "commons:made-up-technique",
    ];
    const badRef = validateCollectionJson(
      JSON.stringify(unknownRefPack),
      CONTEXT,
    );
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) expect(badRef.issues[0]).toMatch(/made-up-technique/);

    const blankStepPack = validPackObject();
    blankStepPack.recipes[0]!.steps[0]!.text = "   ";
    const uncookable = validateCollectionJson(
      JSON.stringify(blankStepPack),
      CONTEXT,
    );
    expect(uncookable.ok).toBe(false);
    if (!uncookable.ok) expect(uncookable.issues[0]).toMatch(/cannot cook/);
  });

  it("includes metadata, rules, allowed library ids, and recipes in authoring & repair prompts", () => {
    const prompt = buildCollectionAuthoringPrompt({
      id: "sunday-suppers",
      title: "Sunday Suppers",
      creatorName: "Chef Owner",
      sourceText: "Garlic Beans: 1 can beans, simmer 10 min.",
      commons: CONTEXT.commons,
      states: CONTEXT.states,
    });
    expect(prompt).toContain("sunday-suppers");
    expect(prompt).toContain("commons:chiffonade");
    expect(prompt).toContain("state:golden-brown");
    expect(prompt).toContain("Garlic Beans: 1 can beans, simmer 10 min.");

    const repair = buildCollectionRepairPrompt('{"id":"bad"}', [
      "recipes: Array must contain at least 1 element(s)",
    ]);
    expect(repair).toContain("ISSUES TO FIX:");
    expect(repair).toContain('{"id":"bad"}');
  });
});
