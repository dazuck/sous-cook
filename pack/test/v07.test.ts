import { describe, expect, test } from 'vitest';
import { parsePack, type Ingredient } from '../src/index.ts';
import {
  quantityInUnit,
  readScaledCanonical,
  representationsFor,
  scaledCanonical,
} from '../src/quantity.ts';
import { basePack, type Json } from './mutations.ts';

function parseWithIngredient(mutate: (ing: Json) => void) {
  const doc = basePack();
  const recipe = (doc['recipes'] as Json[])[0];
  if (recipe === undefined) throw new Error('missing recipe');
  const ing = (recipe['ingredients'] as Json[])[0];
  if (ing === undefined) throw new Error('missing ingredient');
  delete ing['display_equivalents'];
  mutate(ing);
  return parsePack(doc);
}

describe('Pack Format v0.7: P26 count_unit', () => {
  test('accepts count_unit with visible one and other when count is present', () => {
    const res = parseWithIngredient((ing) => {
      ing['qty_canonical'] = {
        count: 3,
        count_unit: { one: 'clove', other: 'cloves', x_extra: 'keep' },
      };
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const parsed = res.value.recipes[0]?.ingredients[0]?.qty_canonical;
      expect(parsed?.count_unit).toEqual({
        one: 'clove',
        other: 'cloves',
        x_extra: 'keep',
      });
    }
  });

  test('refuses count_unit when count is absent', () => {
    const res = parseWithIngredient((ing) => {
      ing['qty_canonical'] = {
        mass_g: 15,
        count_unit: { one: 'clove', other: 'cloves' },
      };
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.endsWith('qty_canonical.count_unit'))).toBe(true);
    }
  });

  test.each([
    ['empty one', { one: '', other: 'cloves' }],
    ['whitespace one', { one: '   ', other: 'cloves' }],
    ['invisible format char other', { one: 'clove', other: '\u200B\u200D' }],
  ])('refuses count_unit with %s', (_label, count_unit) => {
    const res = parseWithIngredient((ing) => {
      ing['qty_canonical'] = { count: 2, count_unit };
    });
    expect(res.ok).toBe(false);
  });
});

describe('Pack Format v0.7: P29 range_max and display_equivalents amount_max', () => {
  test.each([
    ['mass_g', { mass_g: 100, range_max: 150 }],
    ['volume_ml', { volume_ml: 30, range_max: 45 }],
    ['count', { count: 8, range_max: 10, count_unit: { one: 'clove', other: 'cloves' } }],
  ])('accepts range_max > low with single canonical amount (%s)', (_dim, qty_canonical) => {
    const res = parseWithIngredient((ing) => {
      ing['qty_canonical'] = qty_canonical;
    });
    expect(res.ok).toBe(true);
  });

  test.each([
    ['equal to low', { mass_g: 100, range_max: 100 }],
    ['less than low', { volume_ml: 45, range_max: 30 }],
    ['zero', { count: 1, range_max: 0 }],
    ['negative', { count: 1, range_max: -2 }],
    ['infinite', { mass_g: 10, range_max: Infinity }],
    ['two canonical amounts (mass_g + volume_ml)', { mass_g: 100, volume_ml: 120, range_max: 150 }],
    ['two canonical amounts (count + mass_g)', { count: 2, mass_g: 100, range_max: 150 }],
    ['marker to_taste', { to_taste: true, range_max: 5 }],
    ['marker as_written', { as_written: '2-3 tbsp', range_max: 3 }],
  ])('refuses range_max when %s', (_label, qty_canonical) => {
    const res = parseWithIngredient((ing) => {
      ing['qty_canonical'] = qty_canonical;
    });
    expect(res.ok).toBe(false);
  });

  test('accepts display_equivalents with amount_max > amount when range_max is present', () => {
    const res = parseWithIngredient((ing) => {
      ing['qty_canonical'] = { volume_ml: 29.6, range_max: 44.4 };
      ing['display_equivalents'] = {
        imperial: { unit: 'tbsp', amount: 2, amount_max: 3 },
        metric: { unit: 'ml', amount: 30, amount_max: 45 },
      };
    });
    expect(res.ok).toBe(true);
  });

  test('refuses display_equivalents hint missing amount_max when range_max is present', () => {
    const res = parseWithIngredient((ing) => {
      ing['qty_canonical'] = { volume_ml: 29.6, range_max: 44.4 };
      ing['display_equivalents'] = {
        imperial: { unit: 'tbsp', amount: 2, amount_max: 3 },
        metric: { unit: 'ml', amount: 30 },
      };
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some((i) => i.path.endsWith('display_equivalents.metric.amount_max')),
      ).toBe(true);
    }
  });

  test('refuses display_equivalents hint with amount_max when range_max is absent', () => {
    const res = parseWithIngredient((ing) => {
      ing['qty_canonical'] = { volume_ml: 29.6 };
      ing['display_equivalents'] = {
        imperial: { unit: 'tbsp', amount: 2, amount_max: 3 },
      };
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some((i) => i.path.endsWith('display_equivalents.imperial.amount_max')),
      ).toBe(true);
    }
  });

  test.each([
    ['amount_max === amount', 2],
    ['amount_max < amount', 1.5],
    ['amount_max === 0', 0],
    ['amount_max === Infinity', Infinity],
  ])('refuses display_equivalents when %s', (_label, amount_max) => {
    const res = parseWithIngredient((ing) => {
      ing['qty_canonical'] = { volume_ml: 29.6, range_max: 44.4 };
      ing['display_equivalents'] = {
        imperial: { unit: 'tbsp', amount: 2, amount_max },
      };
    });
    expect(res.ok).toBe(false);
  });
});

describe('Pack Format v0.7: ranged amount readers and refusal on single-amount reader', () => {
  const rangedTbsp: Ingredient = {
    id: 'oil',
    name: 'olive oil',
    qty_canonical: { volume_ml: 29.6, range_max: 44.4 },
    display_equivalents: { imperial: { unit: 'tbsp', amount: 2, amount_max: 3 } },
    scaling: 'linear',
  };

  test('scaledCanonical refuses a ranged ingredient instead of returning the low end', () => {
    expect(() => scaledCanonical(rangedTbsp, 1)).toThrow(/range_max/);
  });

  test('readScaledCanonical, representationsFor, and quantityInUnit scale both ends', () => {
    expect(readScaledCanonical(rangedTbsp, 2)).toEqual({
      volume_ml: { min: 59.2, max: 88.8 },
    });
    expect(representationsFor(rangedTbsp, 1, 'imperial').map((r) => r.text)).toEqual([
      '2–3 tbsp',
      '29.6–44.4 ml',
    ]);
    expect(representationsFor(rangedTbsp, 2, 'imperial').map((r) => r.text)).toEqual([
      '4–6 tbsp',
      '59.1–88.7 ml',
    ]);
    expect(quantityInUnit(rangedTbsp, 1, 'tsp', 'imperial')).toEqual({
      ok: true,
      text: '6–9 tsp',
    });
  });
});
