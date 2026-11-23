import { describe, expect, expectTypeOf, test } from 'vitest';
import { parsePack } from '../src/index.ts';
import type { Pack } from '../src/index.ts';

// Pack Format v0.4 (slice B4, lockstep): amounts a source doesn't give as a
// number (P20 to_taste, P25 as_written / unstated), a recipe with no steps or
// no ingredients but not neither (P27) and pack.kind (P11). P28's null
// serving count was reverted in v0.5 (test/v05.test.ts).

type Json = Record<string, unknown>;

function pack(): Json {
  return {
    id: 'test-pack',
    title: 'Test Pack',
    version: '1.0',
    creator: { name: 'Test Creator' },
    recipes: [
      {
        id: 'test-recipe',
        title: 'Test Recipe',
        serves_base: 4,
        ingredients: [{ id: 'salt', name: 'fine sea salt', qty_canonical: { mass_g: 6 } }],
        steps: [{ id: 'step-1', type: 'action', text: 'Salt the water.', ingredient_refs: ['salt'] }],
      },
    ],
  };
}

function recipeOf(doc: Json): Json {
  return (doc['recipes'] as Json[])[0]!;
}

function withQty(qty: unknown): Json {
  const doc = pack();
  ((recipeOf(doc)['ingredients'] as Json[])[0]!)['qty_canonical'] = qty;
  return doc;
}

function issuePaths(doc: Json): string[] {
  const result = parsePack(doc);
  if (result.ok) throw new Error('expected the pack to be refused');
  return result.issues.map((i) => i.path);
}

function roundTrips(doc: Json): void {
  const result = parsePack(doc);
  if (!result.ok) throw new Error(`expected the pack to parse: ${JSON.stringify(result.issues)}`);
  expect(result.value).toEqual(doc);
}

describe('qty_canonical: to_taste (P20)', () => {
  test('to_taste: true alone is a quantity, and round-trips', () => {
    roundTrips(withQty({ to_taste: true }));
  });

  test('salt_type may ride along: it names the salt, not an amount', () => {
    roundTrips(withQty({ to_taste: true, salt_type: 'diamond_kosher' }));
  });

  test.each([false, 'yes', 1, null])('to_taste: %j is refused (only true says it)', (value) => {
    expect(issuePaths(withQty({ to_taste: value })).some((p) => p.includes('qty_canonical'))).toBe(true);
  });

  test('to_taste never sits beside a measured amount', () => {
    expect(parsePack(withQty({ to_taste: true, mass_g: 6 })).ok).toBe(false);
    expect(parsePack(withQty({ to_taste: true, count: 1 })).ok).toBe(false);
  });
});

describe('qty_canonical: as_written (P25)', () => {
  test.each(['a pinch of', '2–3 tbsp', 'about 1 cup', '1 stick'])('%j round-trips verbatim', (text) => {
    roundTrips(withQty({ as_written: text }));
  });

  test.each(['', ' ', '\t\n', '​', ' ‍⁠ '])(
    'refuses %j: as empty as a blank (whitespace and invisible format characters)',
    (text) => {
      expect(issuePaths(withQty({ as_written: text })).some((p) => p.includes('qty_canonical'))).toBe(true);
    },
  );

  test.each([1, true, null, ['a pinch']])('refuses a non-string %j', (value) => {
    expect(parsePack(withQty({ as_written: value })).ok).toBe(false);
  });

  test('excludes the measurable keys and the other markers', () => {
    expect(parsePack(withQty({ as_written: 'a pinch of', mass_g: 1 })).ok).toBe(false);
    expect(parsePack(withQty({ as_written: 'a pinch of', volume_ml: 1 })).ok).toBe(false);
    expect(parsePack(withQty({ as_written: 'a pinch of', count: 1 })).ok).toBe(false);
    expect(parsePack(withQty({ as_written: 'a pinch of', unstated: true })).ok).toBe(false);
    expect(parsePack(withQty({ as_written: 'a pinch of', to_taste: true })).ok).toBe(false);
  });

  test('salt_type may ride along', () => {
    roundTrips(withQty({ as_written: 'a pinch of', salt_type: 'flaky' }));
  });
});

describe('qty_canonical: unstated (P25)', () => {
  test('unstated: true alone round-trips', () => {
    roundTrips(withQty({ unstated: true }));
    roundTrips(withQty({ unstated: true, salt_type: 'flaky' }));
  });

  test.each([false, 'true', 0])('unstated: %j is refused', (value) => {
    expect(parsePack(withQty({ unstated: value })).ok).toBe(false);
  });

  test('excludes the measurable keys and to_taste', () => {
    expect(parsePack(withQty({ unstated: true, count: 2 })).ok).toBe(false);
    expect(parsePack(withQty({ unstated: true, mass_g: 2 })).ok).toBe(false);
    expect(parsePack(withQty({ unstated: true, to_taste: true })).ok).toBe(false);
  });
});

describe('qty_canonical: the anchor rule still holds', () => {
  test.each([{}, { salt_type: 'coarse' }, { pinch: 2 }])('%j anchors nothing and is refused', (qty) => {
    expect(issuePaths(withQty(qty)).some((p) => p.includes('qty_canonical'))).toBe(true);
  });

  test('a measured quantity is unchanged', () => {
    roundTrips(withQty({ mass_g: 6, volume_ml: 5, salt_type: 'fine' }));
  });
});

describe('recipes: no steps or no ingredients, but not neither (P27)', () => {
  test('an ingredients-only recipe (no method given) is valid', () => {
    const doc = pack();
    recipeOf(doc)['steps'] = [];
    roundTrips(doc);
  });

  test('a steps-only recipe (no list given) is valid', () => {
    const doc = pack();
    recipeOf(doc)['ingredients'] = [];
    recipeOf(doc)['steps'] = [{ id: 'step-1', type: 'action', text: 'Boil water.' }];
    roundTrips(doc);
  });

  test('both empty is refused at the recipe', () => {
    const doc = pack();
    recipeOf(doc)['ingredients'] = [];
    recipeOf(doc)['steps'] = [];
    expect(issuePaths(doc)).toContain('recipes.0');
  });

  test('both arrays stay required', () => {
    const noSteps = pack();
    delete recipeOf(noSteps)['steps'];
    expect(parsePack(noSteps).ok).toBe(false);
    const noIngredients = pack();
    delete recipeOf(noIngredients)['ingredients'];
    expect(parsePack(noIngredients).ok).toBe(false);
  });
});

describe('pack.kind (P11)', () => {
  test.each(['creator', 'household'])('%j round-trips', (kind) => {
    const doc = pack();
    doc['kind'] = kind;
    roundTrips(doc);
  });

  test('absent stays valid (reads as creator)', () => {
    roundTrips(pack());
  });

  test.each(['family', '', null, 1])('%j is refused', (kind) => {
    const doc = pack();
    doc['kind'] = kind;
    expect(issuePaths(doc)).toContain('kind');
  });

  test('the type names both kinds', () => {
    expectTypeOf<Pack['kind']>().toEqualTypeOf<'creator' | 'household' | undefined>();
  });
});
