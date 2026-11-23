import { describe, expect, test } from 'vitest';
import { parseCommonsFile, parsePack, parseStatesFile } from '../src/index.ts';

/** Smallest pack that satisfies Pack Format v0 as written. */
function minimalPack(): Record<string, unknown> {
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
        ingredients: [
          {
            id: 'salt',
            name: 'fine sea salt',
            qty_canonical: { mass_g: 6 },
            scaling: 'linear',
          },
        ],
        steps: [
          {
            id: 'step-1',
            type: 'action',
            text: 'Salt the water.',
            ingredient_refs: ['salt'],
          },
        ],
      },
    ],
  };
}

describe('parsePack', () => {
  test('accepts a minimal valid pack', () => {
    const result = parsePack(minimalPack());
    expect(result.ok).toBe(true);
  });

  test('preserves unknown fields verbatim at every level (round-trip rule)', () => {
    const raw = minimalPack();
    raw['x_future_field'] = { nested: true };
    (raw['creator'] as Record<string, unknown>)['x_creator_extra'] = 'keep me';
    const recipe = (raw['recipes'] as Record<string, unknown>[])[0]!;
    recipe['x_recipe_extra'] = [1, 2, 3];
    const ingredient = (recipe['ingredients'] as Record<string, unknown>[])[0]!;
    (ingredient['qty_canonical'] as Record<string, unknown>)['pinch'] = 2;
    const step = (recipe['steps'] as Record<string, unknown>[])[0]!;
    step['x_step_extra'] = 'keep';

    const result = parsePack(raw);
    if (!result.ok) throw new Error('expected parse to succeed');
    expect(result.value).toEqual(raw);
  });

  test('rejects non-object input with a readable issue', () => {
    const result = parsePack('not a pack');
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toHaveProperty('path');
    expect(result.issues[0]).toHaveProperty('message');
  });

  test('requires at least one of mass_g / volume_ml / count in qty_canonical', () => {
    const raw = minimalPack();
    const recipe = (raw['recipes'] as Record<string, unknown>[])[0]!;
    const ingredient = (recipe['ingredients'] as Record<string, unknown>[])[0]!;
    ingredient['qty_canonical'] = { salt_type: 'coarse' };
    const result = parsePack(raw);
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.some((i) => i.path.includes('qty_canonical'))).toBe(true);
  });

  test('accepts count-only and volume-only quantities', () => {
    const raw = minimalPack();
    const recipe = (raw['recipes'] as Record<string, unknown>[])[0]!;
    recipe['ingredients'] = [
      { id: 'egg', name: 'egg', qty_canonical: { count: 1 }, scaling: 'linear' },
      { id: 'milk', name: 'milk', qty_canonical: { volume_ml: 250 }, scaling: 'linear' },
    ];
    const result = parsePack(raw);
    expect(result.ok).toBe(true);
  });

  test('rejects an unknown step type with the failing path', () => {
    const raw = minimalPack();
    const recipe = (raw['recipes'] as Record<string, unknown>[])[0]!;
    const step = (recipe['steps'] as Record<string, unknown>[])[0]!;
    step['type'] = 'dance';
    const result = parsePack(raw);
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.some((i) => i.path.includes('steps') && i.path.includes('type'))).toBe(
      true,
    );
  });

  test('timer_sec may be null (contract: nullable) but not negative', () => {
    const raw = minimalPack();
    const recipe = (raw['recipes'] as Record<string, unknown>[])[0]!;
    const step = (recipe['steps'] as Record<string, unknown>[])[0]!;
    step['timer_sec'] = null;
    expect(parsePack(raw).ok).toBe(true);
    step['timer_sec'] = -30;
    expect(parsePack(raw).ok).toBe(false);
  });

  test('rejects invalid scaling values', () => {
    const raw = minimalPack();
    const recipe = (raw['recipes'] as Record<string, unknown>[])[0]!;
    const ingredient = (recipe['ingredients'] as Record<string, unknown>[])[0]!;
    ingredient['scaling'] = 'exponential';
    expect(parsePack(raw).ok).toBe(false);
  });
});

describe('parseCommonsFile / parseStatesFile', () => {
  test('accepts a bare array of commons entries and preserves unknowns', () => {
    const raw = [
      {
        id: 'commons:temper-eggs',
        name: 'Tempering eggs',
        description: 'd',
        media_ref: '/packs/media/temper.jpg',
        x: 1,
      },
    ];
    const result = parseCommonsFile(raw);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual(raw);
  });

  test('rejects a commons entry without an id', () => {
    const result = parseCommonsFile([{ name: 'No id' }]);
    expect(result.ok).toBe(false);
  });

  test('accepts states with sensory_notes as look/sound/smell', () => {
    const raw = [
      {
        id: 'state:creamy-not-scrambled',
        name: 'Creamy, not scrambled',
        visual_ref: '/packs/media/creamy.jpg',
        sensory_notes: { look: 'glossy sauce', sound: 'quiet pan', smell: 'cheese, pepper' },
      },
    ];
    const result = parseStatesFile(raw);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual(raw);
  });

  test('rejects a states file that is not an array', () => {
    expect(parseStatesFile({ states: [] }).ok).toBe(false);
  });

  // v0.3: a library id is the namespaced id, the same string a step's ref carries.
  test('a commons id carries the commons: namespace and a name after it', () => {
    for (const id of ['temper-eggs', 'state:temper-eggs', 'commons:']) {
      const result = parseCommonsFile([{ id, name: 'Tempering eggs' }]);
      if (result.ok) throw new Error(`expected "${id}" to be refused`);
      expect(result.issues.map((i) => i.path)).toContain('0.id');
    }
  });

  test('a state id carries the state: namespace and a name after it', () => {
    for (const id of ['creamy', 'commons:creamy', 'state:']) {
      const result = parseStatesFile([{ id, name: 'Creamy' }]);
      if (result.ok) throw new Error(`expected "${id}" to be refused`);
      expect(result.issues.map((i) => i.path)).toContain('0.id');
    }
  });

  test('library media may be null: not yet filmed or shot (P3)', () => {
    expect(parseCommonsFile([{ id: 'commons:fold', name: 'Fold', media_ref: null }]).ok).toBe(true);
    expect(parseStatesFile([{ id: 'state:set', name: 'Set', visual_ref: null }]).ok).toBe(true);
  });
});

describe('v0.3: null semantics (P3) and the flat file', () => {
  test('cover_ref null is a pack with no cover yet', () => {
    const raw = minimalPack();
    raw['cover_ref'] = null;
    const result = parsePack(raw);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.cover_ref).toBeNull();
  });

  test('price_usd null is an unpriced draft, distinct from 0 = free', () => {
    const raw = minimalPack();
    raw['price_usd'] = null;
    expect(parsePack(raw).ok).toBe(true);
    raw['price_usd'] = 0;
    expect(parsePack(raw).ok).toBe(true);
    raw['price_usd'] = -1;
    expect(parsePack(raw).ok).toBe(false);
  });

  test('a step media_ref null means no creator film for that step', () => {
    const raw = minimalPack();
    const recipe = (raw['recipes'] as Record<string, unknown>[])[0]!;
    const step = (recipe['steps'] as Record<string, unknown>[])[0]!;
    step['media_ref'] = null;
    expect(parsePack(raw).ok).toBe(true);
    step['media_ref'] = '';
    expect(parsePack(raw).ok).toBe(false);
  });

  test('the {pack, recipes} envelope is not a pack file: the file is the pack object', () => {
    const { recipes, ...meta } = minimalPack();
    const result = parsePack({ pack: meta, recipes });
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['id', 'title']));
  });
});

describe('v0.3: display_equivalents is an object keyed by system, each {unit, amount} (P18)', () => {
  const HINTS = 'recipes.0.ingredients.0.display_equivalents';

  function withHints(hints: unknown): Record<string, unknown> {
    const raw = minimalPack();
    const recipe = (raw['recipes'] as Record<string, unknown>[])[0]!;
    (recipe['ingredients'] as Record<string, unknown>[])[0]!['display_equivalents'] = hints;
    return raw;
  }

  test('accepts one or both systems, and round-trips them verbatim', () => {
    for (const hints of [
      { imperial: { unit: 'tsp', amount: 1 } },
      { metric: { unit: 'g', amount: 6 } },
      { imperial: { unit: 'cup', amount: 0.75 }, metric: { unit: 'ml', amount: 180 } },
    ]) {
      const raw = withHints(hints);
      const result = parsePack(raw);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.value).toEqual(raw);
    }
  });

  test('unknown keys pass through, at the object and inside a hint (round-trip rule)', () => {
    const raw = withHints({ imperial: { unit: 'tsp', amount: 1, x_note: 'keep' }, x_system: { a: 1 } });
    const result = parsePack(raw);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value).toEqual(raw);
  });

  test.each([
    ['the P2 array', [{ system: 'us', kind: 'volume', text: '1 tsp' }]],
    ['a bare string', '1 tsp'],
    ['a number', 42],
    ['null', null],
  ])('refuses %s in place of the object', (_name, hints) => {
    const result = parsePack(withHints(hints));
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.map((i) => i.path)).toContain(HINTS);
  });

  test.each([
    ['a hint with no amount', { unit: 'tsp' }, 'amount'],
    ['an amount written as text', { unit: 'tsp', amount: '1' }, 'amount'],
    ['a zero amount', { unit: 'tsp', amount: 0 }, 'amount'],
    ['a negative amount', { unit: 'tsp', amount: -1 }, 'amount'],
    ['a hint with no unit', { amount: 1 }, 'unit'],
    ['an empty unit', { unit: '', amount: 1 }, 'unit'],
  ])('refuses %s, naming the field', (_name, hint, field) => {
    const result = parsePack(withHints({ imperial: hint }));
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.map((i) => i.path)).toContain(`${HINTS}.imperial.${field}`);
  });

  test('refuses a null hint for a system: absent is how a system has no hint', () => {
    const result = parsePack(withHints({ imperial: null, metric: { unit: 'g', amount: 6 } }));
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.map((i) => i.path)).toContain(`${HINTS}.imperial`);
  });
});
