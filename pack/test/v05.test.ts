import { describe, expect, expectTypeOf, test } from 'vitest';
import { parsePack, parseRecipe } from '../src/index.ts';
import type { Recipe } from '../src/index.ts';

// Pack Format v0.5 (slice B4b, lockstep): every recipe has a serving count.
// P28's null (v0.4) is reverted (2026-10-06), and a count the
// source doesn't state is Sous's estimate, marked serves_estimated: true (P30).

type Json = Record<string, unknown>;

function recipe(over: Json = {}): Json {
  return {
    id: 'test-recipe',
    title: 'Test Recipe',
    serves_base: 4,
    ingredients: [{ id: 'salt', name: 'fine sea salt', qty_canonical: { mass_g: 6 } }],
    steps: [{ id: 'step-1', type: 'action', text: 'Salt the water.', ingredient_refs: ['salt'] }],
    ...over,
  };
}

function pack(r: Json): Json {
  return { id: 'p', title: 'P', version: '1', creator: { name: 'C' }, recipes: [r] };
}

function issuePaths(r: Json): string[] {
  const result = parseRecipe(r);
  if (result.ok) throw new Error('expected the recipe to be refused');
  return result.issues.map((i) => i.path);
}

describe('serves_base is a required positive number again (P28 reverted)', () => {
  test('null, absent, zero, negative and a string are refused', () => {
    expect(issuePaths(recipe({ serves_base: null }))).toContain('serves_base');
    const absent = recipe();
    delete absent['serves_base'];
    expect(issuePaths(absent)).toContain('serves_base');
    for (const value of [0, -2, '4']) expect(issuePaths(recipe({ serves_base: value }))).toContain('serves_base');
  });

  test('the type is a number', () => {
    expectTypeOf<Recipe['serves_base']>().toEqualTypeOf<number>();
  });
});

describe('serves_estimated (P30)', () => {
  test('true marks Sous\'s estimate, and round-trips in a pack', () => {
    const doc = pack(recipe({ serves_base: 3, serves_estimated: true }));
    const result = parsePack(doc);
    expect(result.ok && result.value).toEqual(doc);
  });

  test('absent means the source states the count', () => {
    const result = parseRecipe(recipe());
    expect(result.ok && result.value.serves_estimated).toBeUndefined();
  });

  test('false, a string, a number and null are refused: the marker is only ever true', () => {
    for (const value of [false, 'true', 1, null]) {
      expect(issuePaths(recipe({ serves_estimated: value }))).toContain('serves_estimated');
    }
  });

  test('it never stands without a count', () => {
    expect(issuePaths(recipe({ serves_base: null, serves_estimated: true }))).toContain('serves_base');
  });

  test('the type says only true or absent', () => {
    expectTypeOf<Recipe['serves_estimated']>().toEqualTypeOf<true | undefined>();
  });
});
