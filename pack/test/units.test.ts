import { describe, expect, it } from 'vitest';
import {
  convertValue,
  formatQuantity,
  formatUnitValue,
  getUnit,
  unitFromAlias,
} from '../src/quantity.ts';

// The unit table: which words name a unit, conversion within a dimension, and
// how a converted value is written (kitchen fractions for imperial units, one
// decimal of exactness for small metric amounts).

describe('unit table', () => {
  it('classifies dimension and system', () => {
    expect(getUnit('g')).toMatchObject({ dimension: 'mass', system: 'metric' });
    expect(getUnit('oz')).toMatchObject({ dimension: 'mass', system: 'imperial' });
    expect(getUnit('cup')).toMatchObject({ dimension: 'volume', system: 'imperial' });
    expect(getUnit('ml')).toMatchObject({ dimension: 'volume', system: 'metric' });
  });
});

describe('unitFromAlias', () => {
  it('resolves spoken and written names case-insensitively', () => {
    expect(unitFromAlias('Grams')?.id).toBe('g');
    expect(unitFromAlias('tablespoons')?.id).toBe('tbsp');
    expect(unitFromAlias('OZ')?.id).toBe('oz');
    expect(unitFromAlias('cups')?.id).toBe('cup');
    expect(unitFromAlias('millilitres')?.id).toBe('ml');
  });

  it('returns undefined for words that are not units', () => {
    expect(unitFromAlias('butter')).toBeUndefined();
    expect(unitFromAlias('')).toBeUndefined();
  });
});

describe('convertValue', () => {
  it('converts within a dimension through the base unit', () => {
    expect(convertValue(454, 'g', 'lb')).toBeCloseTo(1.0009, 3);
    expect(convertValue(1, 'lb', 'g')).toBeCloseTo(453.592, 3);
    expect(convertValue(15, 'ml', 'tbsp')).toBeCloseTo(1.0144, 3);
    expect(convertValue(2, 'cup', 'ml')).toBeCloseTo(473.176, 3);
    expect(convertValue(1.5, 'kg', 'g')).toBe(1500);
  });

  it('is the identity on same-unit conversion', () => {
    expect(convertValue(42, 'g', 'g')).toBe(42);
  });

  it('throws on a cross-dimension conversion — the caller must check first', () => {
    expect(() => convertValue(150, 'g', 'cup')).toThrow(/mass.*volume|dimension/i);
  });
});

describe('formatting: a canonical amount converted and written at scale 1', () => {
  const cases: {
    canonical: number;
    from: 'g' | 'ml';
    to: Parameters<typeof getUnit>[0];
    shown: string;
  }[] = [
    { canonical: 454, from: 'g', to: 'lb', shown: '1 lb' },
    { canonical: 28, from: 'g', to: 'oz', shown: '1 oz' },
    { canonical: 142, from: 'g', to: 'oz', shown: '5 oz' },
    { canonical: 15, from: 'ml', to: 'tbsp', shown: '1 tbsp' },
    { canonical: 120, from: 'ml', to: 'cup', shown: '½ cup' },
    { canonical: 1420, from: 'ml', to: 'cup', shown: '6 cups' },
    { canonical: 360, from: 'ml', to: 'cup', shown: '1½ cups' },
    { canonical: 5, from: 'ml', to: 'tsp', shown: '1 tsp' },
    { canonical: 4.5, from: 'g', to: 'tsp', shown: '' }, // cross-dimension: never offered
  ];

  it.each(cases.filter((c) => c.shown !== ''))(
    '$canonical $from renders as "$shown"',
    ({ canonical, from, to, shown }) => {
      expect(formatQuantity(convertValue(canonical, from, to), to)).toBe(shown);
    },
  );
});

describe('formatUnitValue precision', () => {
  it('metric: whole numbers at 100+, one decimal below, exactness kept', () => {
    expect(formatUnitValue(236.588, 'ml')).toBe('237');
    expect(formatUnitValue(14.787, 'ml')).toBe('14.8');
    expect(formatUnitValue(4.5, 'g')).toBe('4.5'); // the fine-salt 4.5 g never becomes 5 g
    expect(formatUnitValue(56, 'g')).toBe('56');
    expect(formatUnitValue(454, 'g')).toBe('454');
  });

  it('large metric units carry two decimals', () => {
    expect(formatUnitValue(1.42, 'l')).toBe('1.42');
    expect(formatUnitValue(1.5, 'kg')).toBe('1.5');
  });

  it('imperial units snap to kitchen fractions', () => {
    expect(formatUnitValue(0.9876, 'oz')).toBe('1');
    expect(formatUnitValue(1.5216, 'cup')).toBe('1½');
    expect(formatUnitValue(0.5072, 'cup')).toBe('½');
    expect(formatUnitValue(0.75, 'tsp')).toBe('¾');
  });

  it('imperial amounts too small for any kitchen fraction show an honest decimal', () => {
    // 2 g of pepper in oz — never "0 oz"
    expect(formatUnitValue(0.0706, 'oz')).toBe('0.07');
  });

  it('zero is zero', () => {
    expect(formatUnitValue(0, 'g')).toBe('0');
  });
});

describe('formatQuantity labels', () => {
  it('appends the unit label with a space', () => {
    expect(formatQuantity(454, 'g')).toBe('454 g');
    expect(formatQuantity(1.0144, 'tbsp')).toBe('1 tbsp');
  });

  it('pluralizes cups above one, and only cups', () => {
    expect(formatQuantity(6.002, 'cup')).toBe('6 cups');
    expect(formatQuantity(0.5072, 'cup')).toBe('½ cup');
    expect(formatQuantity(1.0, 'cup')).toBe('1 cup');
    expect(formatQuantity(453.592, 'g')).toBe('454 g');
  });
});
