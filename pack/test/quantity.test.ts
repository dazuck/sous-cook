import { describe, expect, it } from 'vitest';
import type { Ingredient } from '../src/index.ts';
import { quantityInUnit, representationsFor, scaledCanonical } from '../src/quantity.ts';

// Pack Format v0.7 stated-hint reading and exact counts (reading (c)).
// Hints in display_equivalents are the stated amount: a reader shows a hint's
// amount times the serving multiplier, in the hint's unit, and converts from
// it — never recomputing from qty_canonical, which carries the dimension, what
// scales, and the amount for a line with no hint.

const egg: Ingredient = {
  id: 'egg',
  name: 'egg',
  qty_canonical: { count: 1, mass_g: 50 },
  scaling: 'linear',
};

const yolks: Ingredient = {
  id: 'egg-yolks',
  name: 'egg yolks',
  qty_canonical: { count: 3, mass_g: 54 },
  scaling: 'linear',
};

const pecorino: Ingredient = {
  id: 'pecorino',
  name: 'pecorino romano',
  qty_canonical: { mass_g: 28 },
  display_equivalents: { imperial: { unit: 'oz', amount: 1 } },
  scaling: 'linear',
};

const fineSalt: Ingredient = {
  id: 'salt',
  name: 'salt',
  qty_canonical: { mass_g: 4.5, salt_type: 'fine' },
  display_equivalents: { imperial: { unit: 'tsp', amount: 0.75 } },
  scaling: 'linear',
};

const pastaWaterSalt: Ingredient = {
  id: 'pasta-water-salt',
  name: 'salt for the pasta water',
  qty_canonical: { mass_g: 15, salt_type: 'coarse' },
  display_equivalents: { imperial: { unit: 'tbsp', amount: 1 } },
  scaling: 'fixed',
};

const stock: Ingredient = {
  id: 'stock',
  name: 'stock',
  qty_canonical: { volume_ml: 1420 },
  display_equivalents: { imperial: { unit: 'cup', amount: 6 } },
  scaling: 'linear',
};

const rice: Ingredient = {
  id: 'rice',
  name: 'risotto rice',
  qty_canonical: { mass_g: 300, volume_ml: 360 },
  display_equivalents: { imperial: { unit: 'cup', amount: 1.5 } },
  scaling: 'linear',
};

const blackPepper: Ingredient = {
  id: 'black-pepper',
  name: 'black pepper',
  qty_canonical: { mass_g: 2 },
  scaling: 'linear',
};

const rawSugar: Ingredient = {
  id: 'raw-sugar',
  name: 'raw sugar',
  qty_canonical: { mass_g: 150 },
  display_equivalents: { imperial: { unit: 'cup', amount: 0.75 } },
  scaling: 'linear',
};

const garlic: Ingredient = {
  id: 'garlic',
  name: 'garlic cloves',
  qty_canonical: { count: 4 },
  scaling: 'linear',
};

const halfOnion: Ingredient = {
  id: 'onion',
  name: 'large onion',
  qty_canonical: { count: 0.5, mass_g: 110 },
  scaling: 'linear',
};

const dualHintFlour: Ingredient = {
  id: 'flour',
  name: 'all-purpose flour',
  qty_canonical: { volume_ml: 394.3, mass_g: 213 },
  display_equivalents: {
    imperial: { unit: 'cup', amount: 1 + 2 / 3 },
    metric: { unit: 'g', amount: 213 },
  },
  scaling: 'linear',
};

describe('scaledCanonical', () => {
  it('scales every anchor linearly', () => {
    expect(scaledCanonical(yolks, 1.5)).toEqual({ count: 4.5, mass_g: 81 });
    expect(scaledCanonical(stock, 0.5)).toEqual({ volume_ml: 710 });
  });

  it('never scales a fixed ingredient', () => {
    expect(scaledCanonical(pastaWaterSalt, 1.5)).toEqual({ mass_g: 15 });
  });

  it('treats absent scaling as linear (never injected into the data)', () => {
    const bare: Ingredient = { id: 'x', name: 'x', qty_canonical: { mass_g: 10 } };
    expect(scaledCanonical(bare, 2)).toEqual({ mass_g: 20 });
  });
});

describe('representationsFor: default display and flip cycle', () => {
  const texts = (ing: Ingredient, scale: number, pref: 'metric' | 'imperial') =>
    representationsFor(ing, scale, pref).map((r) => r.text);

  it('counted ingredients lead with the count; the cycle spans both systems', () => {
    expect(texts(egg, 1, 'metric')).toEqual(['1', '50 g', '1¾ oz']);
    expect(texts(egg, 1, 'imperial')).toEqual(['1', '1¾ oz', '50 g']);
  });

  it('scaled counts render as exact fractions', () => {
    expect(texts(yolks, 1.5, 'metric')).toEqual(['4½', '81 g', '2⅞ oz']);
    expect(texts(halfOnion, 1.5, 'metric')[0]).toBe('¾');
  });

  it('preference orders the systems; the stated hint converts to the other system', () => {
    expect(texts(pecorino, 1, 'metric')).toEqual(['28.3 g', '1 oz']);
    expect(texts(pecorino, 1, 'imperial')).toEqual(['1 oz', '28.3 g']);
  });

  it('a volume hint converts to metric volume (never reading canonical mass_g)', () => {
    expect(texts(fineSalt, 1, 'metric')).toEqual(['3.7 ml', '¾ tsp']);
    expect(texts(fineSalt, 1, 'imperial')).toEqual(['¾ tsp', '3.7 ml']);
  });

  it('large metric volumes read in litres; the stated hint scales by the multiplier', () => {
    expect(texts(stock, 1, 'metric')).toEqual(['1.42 l', '6 cups']);
    expect(texts(stock, 1.5, 'imperial')).toEqual(['9 cups', '2.13 l']);
  });

  it('with a hint present, representations come from the hint rather than qty_canonical', () => {
    expect(texts(rice, 1, 'metric')).toEqual(['355 ml', '1½ cups']);
    expect(texts(rice, 1, 'imperial')).toEqual(['1½ cups', '355 ml']);
  });

  it('with both imperial and metric hints stated, each system shows its stated hint × scale', () => {
    expect(texts(dualHintFlour, 1, 'imperial')).toEqual(['1⅔ cups', '213 g']);
    expect(texts(dualHintFlour, 2, 'imperial')).toEqual(['3⅓ cups', '426 g']);
    expect(texts(dualHintFlour, 1, 'metric')).toEqual(['213 g', '1⅔ cups']);
  });

  it('without any hint, imperial falls back to converting the primary anchor', () => {
    expect(texts(blackPepper, 1, 'metric')).toEqual(['2 g', '0.07 oz']);
    expect(texts(blackPepper, 1, 'imperial')).toEqual(['0.07 oz', '2 g']);
  });

  it('fixed ingredients show base quantities at any scale', () => {
    expect(texts(pastaWaterSalt, 1.5, 'imperial')).toEqual(['1 tbsp', '14.8 ml']);
  });

  it('a malformed hint is ignored, not an error', () => {
    const odd: Ingredient = {
      id: 'odd',
      name: 'odd',
      qty_canonical: { mass_g: 100 },
      display_equivalents: { imperial: { unit: 'handfuls', amount: 2 } },
    };
    expect(texts(odd, 1, 'imperial')).toEqual(['3½ oz', '100 g']);
  });

  it('carries kind and unit metadata for downstream consumers', () => {
    expect(representationsFor(egg, 1, 'metric')[0]).toMatchObject({ kind: 'count' });
    expect(representationsFor(pecorino, 1, 'metric')[1]).toMatchObject({
      kind: 'mass',
      unit: 'oz',
    });
    expect(representationsFor(fineSalt, 1, 'metric')[1]).toMatchObject({
      kind: 'volume',
      unit: 'tsp',
    });
  });
});

describe('quantityInUnit: the how-much answer', () => {
  it('answers in the requested unit from the stated hint', () => {
    expect(quantityInUnit(pecorino, 1.5, 'g', 'metric')).toEqual({ ok: true, text: '42.5 g' });
    expect(quantityInUnit(pecorino, 1, 'oz', 'metric')).toEqual({ ok: true, text: '1 oz' });
    expect(quantityInUnit(stock, 1, 'l', 'metric')).toEqual({ ok: true, text: '1.42 l' });
  });

  it('reaches volume through a stated volume hint', () => {
    expect(quantityInUnit(fineSalt, 1, 'tsp', 'metric')).toEqual({ ok: true, text: '¾ tsp' });
    expect(quantityInUnit(fineSalt, 1, 'ml', 'metric')).toEqual({ ok: true, text: '3.7 ml' });
    expect(quantityInUnit(rawSugar, 1, 'cup', 'metric')).toEqual({ ok: true, text: '¾ cup' });
  });

  it('scales the stated hint with the ingredient (and respects fixed)', () => {
    expect(quantityInUnit(fineSalt, 2, 'tsp', 'metric')).toEqual({ ok: true, text: '1½ tsp' });
    expect(quantityInUnit(pastaWaterSalt, 1.5, 'tbsp', 'metric')).toEqual({
      ok: true,
      text: '1 tbsp',
    });
  });

  it('failure mode 14: no anchor in the requested dimension → honest alternatives', () => {
    const pepperInCups = quantityInUnit(blackPepper, 1, 'cup', 'metric');
    expect(pepperInCups.ok).toBe(false);
    if (!pepperInCups.ok) {
      expect(pepperInCups.alternatives.map((r) => r.text)).toEqual(['2 g', '0.07 oz']);
    }

    const garlicInGrams = quantityInUnit(garlic, 1, 'g', 'metric');
    expect(garlicInGrams.ok).toBe(false);
    if (!garlicInGrams.ok) {
      expect(garlicInGrams.alternatives.map((r) => r.text)).toEqual(['4']);
    }
  });
});
