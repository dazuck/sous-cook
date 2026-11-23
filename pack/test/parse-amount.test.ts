import { describe, expect, it } from 'vitest';
import type { Ingredient } from '../src/index.ts';
import { classifyLine, parseAmount, parseNumber } from '../src/quantity.ts';
import type { LineReading, QuantityIngredient } from '../src/quantity.ts';

// The amount parser (slice B4, decision 3 and the failure table): a legacy
// recipe line {item, amount, unit} reads into one class. Only a number the
// source states becomes a number, and only when the formatter renders it back
// as that number; everything else keeps the source's words ("as written").

describe('parseNumber', () => {
  it.each([
    ['2', 2],
    ['12', 12],
    ['1.5', 1.5],
    ['0.25', 0.25],
    ['1/2', 0.5],
    ['3/4', 0.75],
    ['1 1/2', 1.5],
    ['2 1/2', 2.5],
    ['½', 0.5],
    ['⅓', 1 / 3],
    ['⅛', 0.125],
    ['1½', 1.5],
    ['1 ½', 1.5],
    ['2¾', 2.75],
    ['  3  ', 3],
  ])('reads %j as %d', (text, value) => {
    expect(parseNumber(text)).toBeCloseTo(value, 12);
  });

  it.each([
    '',
    '   ',
    '0',
    '0/2',
    '1/0',
    '2-3',
    '2–3',
    '1 to 2',
    'about 1',
    '~2',
    'a pinch of',
    'a handful of',
    '1,5',
    '1 3/2',
    '1-1/2',
    'one',
    '1½½',
    '1/2/3',
  ])('refuses %j', (text) => {
    expect(parseNumber(text)).toBeNull();
  });
});

describe('classifyLine: measured', () => {
  it.each<[string, string, number, string]>([
    ['2', 'tbsp', 2, 'tbsp'],
    ['1', 'tsp', 1, 'tsp'],
    ['1 1/2', 'cups', 1.5, 'cup'],
    ['1/3', 'cup', 1 / 3, 'cup'],
    ['3/4', 'cup', 0.75, 'cup'],
    ['12', 'oz', 12, 'oz'],
    ['1', 'lb', 1, 'lb'],
    ['250', 'g', 250, 'g'],
    ['2.5', 'g', 2.5, 'g'],
    ['1.25', 'kg', 1.25, 'kg'],
    ['500', 'ml', 500, 'ml'],
    ['2', 'TBSP', 2, 'tbsp'],
    ['2', 'Tablespoons', 2, 'tbsp'],
    ['⅛', 'tsp', 0.125, 'tsp'],
    // The prod export's "1.5 tbs gram dhal" (B4 step 0, spelling call 4).
    ['1.5', 'tbs', 1.5, 'tbsp'],
    ['2', 'Tbs', 2, 'tbsp'],
  ])('%s %s', (amount, unit, value, unitId) => {
    const reading = classifyLine({ item: 'x', amount, unit });
    expect(reading.kind).toBe('measured');
    if (reading.kind !== 'measured') return;
    expect(reading.amount.unit).toBe(unitId);
    expect(reading.amount.value).toBeCloseTo(value, 12);
  });
});

describe('classifyLine: compound', () => {
  it('reads a stated equivalent in the other system', () => {
    expect(classifyLine({ item: 'butter', amount: '1', unit: 'cup (225 g)' })).toEqual({
      kind: 'compound',
      head: { value: 1, unit: 'cup' },
      also: { value: 225, unit: 'g' },
    });
    expect(classifyLine({ item: 'pasta', amount: '300', unit: 'g (10 oz)' })).toEqual({
      kind: 'compound',
      head: { value: 300, unit: 'g' },
      also: { value: 10, unit: 'oz' },
    });
  });

  it('keeps both stated numbers, never one recomputed from the other', () => {
    expect(classifyLine({ item: 'beef', amount: '1.2', unit: 'kg (2 1/2 lb)' })).toEqual({
      kind: 'compound',
      head: { value: 1.2, unit: 'kg' },
      also: { value: 2.5, unit: 'lb' },
    });
  });

  // The prod export writes the equivalent with no space ("½ cup (113g)", 13
  // lines; B4 step 0, call 7): the same stated pair, so the same compound.
  it.each<[string, string, number, string, number, string]>([
    ['½', 'cup (113g)', 0.5, 'cup', 113, 'g'],
    ['8', 'oz (226g)', 8, 'oz', 226, 'g'],
    ['1', 'tbsp (15mL)', 1, 'tbsp', 15, 'ml'],
    ['2', 'lbs (900g)', 2, 'lb', 900, 'g'],
  ])('%s %s reads its unspaced equivalent', (amount, unit, value, unitId, alsoValue, alsoId) => {
    expect(classifyLine({ item: 'x', amount, unit })).toEqual({
      kind: 'compound',
      head: { value, unit: unitId },
      also: { value: alsoValue, unit: alsoId },
    });
  });

  // A stick of butter is ½ cup, 4 oz, but no table unit: sticks that agree
  // with the head restate it, so they are dropped and the table measure beside
  // them, if any, is the equivalent (B4 step 0, call 8).
  it('reads the table measure beside a stick count that agrees with the head', () => {
    expect(classifyLine({ item: 'butter', amount: '½', unit: 'cup (1 stick / 113g)' })).toEqual({
      kind: 'compound',
      head: { value: 0.5, unit: 'cup' },
      also: { value: 113, unit: 'g' },
    });
  });

  it.each<[string, string, number, string]>([
    ['1/2', 'cup (1 stick)', 0.5, 'cup'],
    ['1', 'cup (2 sticks)', 1, 'cup'],
    ['8', 'tbsp (1 stick)', 8, 'tbsp'],
    ['4', 'oz (1 stick)', 4, 'oz'],
    ['113', 'g (1 stick)', 113, 'g'],
  ])('%s %s states only sticks that agree: the head alone', (amount, unit, value, unitId) => {
    expect(classifyLine({ item: 'butter', amount, unit })).toEqual({
      kind: 'measured',
      amount: { value, unit: unitId },
    });
  });

  it.each<[string, string, string]>([
    ['1', 'cup (8 oz)', 'compound-same-system'],
    ['1', 'cup (1 stick)', 'compound-unreadable'],
    ['½', 'cup (2 sticks / 113g)', 'compound-unreadable'],
    ['½', 'cup (4 oz / 113g)', 'compound-unreadable'],
    ['½', 'cup (113g / about 2 lemons)', 'compound-unreadable'],
    ['1', 'cup (about 2 lemons)', 'compound-unreadable'],
    ['200', 'g (0.2 kg)', 'compound-same-system'],
    ['1', 'cup (about 2 large)', 'compound-unreadable'],
    ['1', 'cup (225 qt)', 'compound-unreadable'],
    ['1', 'cup (0.33 cup)', 'compound-same-system'],
    ['1', 'cup (150.5 g)', 'round-trip'],
  ])('%s %s is as written (%s)', (amount, unit, reason) => {
    expect(classifyLine({ item: 'x', amount, unit })).toEqual({
      kind: 'as_written',
      text: `${amount} ${unit}`,
      reason,
    });
  });
});

describe('classifyLine: counts', () => {
  it('reads a bare count', () => {
    expect(classifyLine({ item: 'eggs', amount: '2' })).toEqual({ kind: 'count', value: 2, noun: null });
    expect(classifyLine({ item: 'lemon', amount: '1/2' })).toEqual({ kind: 'count', value: 0.5, noun: null });
    expect(classifyLine({ item: 'eggs', amount: '2', unit: '  ' })).toEqual({
      kind: 'count',
      value: 2,
      noun: null,
    });
  });

  it('keeps a count noun verbatim, parenthetical included', () => {
    expect(classifyLine({ item: 'garlic', amount: '3', unit: 'cloves' })).toEqual({
      kind: 'count',
      value: 3,
      noun: 'cloves',
    });
    expect(classifyLine({ item: 'crushed tomatoes', amount: '1', unit: 'can (14 oz)' })).toEqual({
      kind: 'count',
      value: 1,
      noun: 'can (14 oz)',
    });
    for (const noun of ['clove', 'head', 'heads', 'sprig', 'sprigs', 'can', 'cans', 'Cloves']) {
      expect(classifyLine({ item: 'x', amount: '1', unit: noun })).toEqual({ kind: 'count', value: 1, noun });
    }
  });

  // A length is no amount of an ingredient (B4 step 0, call 10): "3 inches"
  // of water is a depth, so at 2× it would read "6 inches", a wrong number.
  // A length in the unit slot goes as written, the ginger by the inch with it.
  it.each([
    ['3', 'inches', '3 inches'],
    ['1', 'inch', '1 inch'],
    ['1/2', 'Inch', '1/2 Inch'],
    ['1', 'in', '1 in'],
    ['1', 'in.', '1 in.'],
    ['1', '"', '1 "'],
    ['2', 'cm', '2 cm'],
    ['5', 'mm', '5 mm'],
    ['2', 'centimeters', '2 centimeters'],
  ])('reads %j %j, a length, as written', (amount, unit, text) => {
    expect(classifyLine({ item: 'water', amount, unit })).toEqual({
      kind: 'as_written',
      text,
      reason: 'length-not-an-amount',
    });
  });

  // The prod export's common unit-slot words (B4 step 0, spelling calls 1–2):
  // "1 | bunch | cilantro", "1 | large | Red Onion", "1/2 | whole | onion". The
  // Doc writes each the same way ("1 bunch cilantro"), so the word goes into
  // the name and the cook reads the line the Doc wrote.
  it.each([
    'bunch',
    'bunches',
    'Bunch',
    'stalk',
    'stalks',
    'ear',
    'ears',
    'large',
    'Large',
    'medium',
    'whole',
  ])('keeps the export word %j as a count noun', (noun) => {
    expect(classifyLine({ item: 'x', amount: '1', unit: noun })).toEqual({ kind: 'count', value: 1, noun });
  });

  it('keeps a fractional count with its noun', () => {
    expect(classifyLine({ item: 'cilantro', amount: '½', unit: 'bunch' })).toEqual({
      kind: 'count',
      value: 0.5,
      noun: 'bunch',
    });
    expect(classifyLine({ item: 'red onion', amount: '1/4', unit: 'whole' })).toEqual({
      kind: 'count',
      value: 0.25,
      noun: 'whole',
    });
  });

  it('keeps a size word with a parenthetical verbatim', () => {
    expect(classifyLine({ item: 'onion', amount: '1', unit: 'large (about 8 oz)' })).toEqual({
      kind: 'count',
      value: 1,
      noun: 'large (about 8 oz)',
    });
  });

  // "unit" and "item" are the extraction's words, never the Doc's: every one
  // of the export's 8 ("1 | unit | red onion", "1 | item | lime") is a bare
  // count in the Doc ("1 red onion", "1 lime"). The word says nothing about
  // how much, so it reads as a bare count (B4 step 0, spelling call 3). Only
  // these spellings, and only alone in the unit slot.
  it.each(['unit', 'units', 'Unit', 'item', 'items'])('reads the placeholder %j as a bare count', (unit) => {
    expect(classifyLine({ item: 'red onion', amount: '5', unit })).toEqual({ kind: 'count', value: 5, noun: null });
  });

  it('a placeholder with a parenthetical stays as written: its words are kept', () => {
    expect(classifyLine({ item: 'tomatoes', amount: '1', unit: 'unit (14 oz)' })).toEqual({
      kind: 'as_written',
      text: '1 unit (14 oz)',
      reason: 'unit-not-in-table',
    });
  });
});

describe('classifyLine: no amount', () => {
  it.each(['salt to taste', 'salt and pepper to taste', 'Black pepper, To Taste'])('%j is to taste', (item) => {
    expect(classifyLine({ item })).toEqual({ kind: 'to_taste' });
    expect(classifyLine({ item, amount: '', unit: '' })).toEqual({ kind: 'to_taste' });
  });

  it.each(['flaky sea salt', 'salt and pepper', 'crusty bread, to serve', 'frozen parathas', 'tastes of home'])(
    '%j is unstated',
    (item) => {
      expect(classifyLine({ item })).toEqual({ kind: 'unstated' });
      expect(classifyLine({ item, amount: '  ' })).toEqual({ kind: 'unstated' });
    },
  );

  it('a unit with no amount is as written', () => {
    expect(classifyLine({ item: 'salt', unit: 'pinch' })).toEqual({
      kind: 'as_written',
      text: 'pinch',
      reason: 'unit-without-amount',
    });
  });
});

describe('classifyLine: ranges and containers (P26, P29, B5c-6)', () => {
  it.each<[string, string | undefined, LineReading]>([
    ['2-3', 'tbsp', { kind: 'measured', amount: { value: 2, max: 3, unit: 'tbsp' } }],
    ['1.5 to 2', 'lb', { kind: 'measured', amount: { value: 1.5, max: 2, unit: 'lb' } }],
    ['2½–3', 'tsp', { kind: 'measured', amount: { value: 2.5, max: 3, unit: 'tsp' } }],
    ['8-10', '', { kind: 'count', value: 8, max: 10, noun: null }],
    ['2 to 3', undefined, { kind: 'count', value: 2, max: 3, noun: null }],
    ['2 or 3', 'eggs', { kind: 'as_written', text: '2 or 3 eggs', reason: 'unit-not-in-table' }],
    ['4-5', 'cloves', { kind: 'count', value: 4, max: 5, noun: 'cloves' }],
    ['1', 'large bag', { kind: 'count', value: 1, noun: 'large bag' }],
    ['1', 'package', { kind: 'count', value: 1, noun: 'package' }],
    ['2 (14-ounce)', 'cans', { kind: 'count', value: 2, noun: 'cans (14-ounce)' }],
    ['12 oz', 'bottle', { kind: 'count', value: 1, noun: 'bottle (12 oz)' }],
  ])('%j %j', (amount, unit, expected) => {
    const line = unit === undefined ? { item: 'x', amount } : { item: 'x', amount, unit };
    expect(classifyLine(line)).toEqual(expected);
  });
});

describe('classifyLine: as written', () => {
  it.each<[string, string | undefined, string, string]>([
    ['a pinch of', undefined, 'a pinch of', 'amount-not-a-number'],
    ['a handful of', undefined, 'a handful of', 'amount-not-a-number'],
    ['3-2', 'tbsp', '3-2 tbsp', 'amount-not-a-number'],
    ['0.33-1', 'cup', '0.33-1 cup', 'round-trip'],
    ['1-1.33', 'cup', '1-1.33 cup', 'round-trip'],
    ['about 1', 'cup', 'about 1 cup', 'amount-not-a-number'],
    ['0', 'cup', '0 cup', 'amount-not-a-number'],
    ['2', 'qt', '2 qt', 'unit-not-in-table'],
    ['1', 'stick', '1 stick', 'unit-not-in-table'],
    ['1', 'fl oz', '1 fl oz', 'unit-not-in-table'],
    ['2', 'packets', '2 packets', 'unit-not-in-table'],
    // "pinch" is not a count noun: the export's "1 | pinch" lines are 4 of 5
    // a Doc "pinch red chili flakes" or "a pinch of", with the "1" added in
    // extraction, so a count would scale a number the Doc never states. "Pinch"
    // with no number stays as written too (B4 step 0, spelling call 4).
    ['1', 'pinch', '1 pinch', 'unit-not-in-table'],
    ['Pinch', undefined, 'Pinch', 'amount-not-a-number'],
    ['pinch', '', 'pinch', 'amount-not-a-number'],
    ['0.33', 'cup', '0.33 cup', 'round-trip'],
    ['150.5', 'g', '150.5 g', 'round-trip'],
    ['1/16', 'tsp', '1/16 tsp', 'round-trip'],
    [' 2 ', ' qt ', '2 qt', 'unit-not-in-table'],
  ])('%j %j', (amount, unit, text, reason) => {
    const line = unit === undefined ? { item: 'x', amount } : { item: 'x', amount, unit };
    expect(classifyLine(line)).toEqual({ kind: 'as_written', text, reason });
  });

  it('never reads "to taste" when an amount is given', () => {
    expect(classifyLine({ item: 'salt, to taste', amount: '1', unit: 'tsp' }).kind).toBe('measured');
    expect(classifyLine({ item: 'salt to taste', amount: 'a pinch of' }).kind).toBe('as_written');
  });
});

describe('parseAmount', () => {
  it('is classifyLine for a line with an amount', () => {
    const cases: [string, string | undefined][] = [
      ['2', 'tbsp'],
      ['2-3', 'tbsp'],
      ['300', 'g (10 oz)'],
      ['3', 'cloves'],
      ['2 (14-ounce)', 'cans'],
      ['12 oz', 'bottle'],
      ['2', undefined],
      ['a pinch of', undefined],
    ];
    for (const [amount, unit] of cases) {
      const line = unit === undefined ? { item: 'x', amount } : { item: 'x', amount, unit };
      const expected: LineReading = classifyLine(line);
      expect(parseAmount(amount, unit)).toEqual(expected);
    }
  });
});

describe('structural ingredient type', () => {
  it("accepts pack's Ingredient", () => {
    // Compile-time: a pack Ingredient is a QuantityIngredient, so the reader
    // needs no import of index.ts. A schema change that broke this would
    // fail pack's typecheck here.
    const toReader = (ingredient: Ingredient): QuantityIngredient => ingredient;
    const garlic: Ingredient = { id: 'garlic', name: 'garlic', qty_canonical: { count: 2 } };
    expect(toReader(garlic).qty_canonical.count).toBe(2);
  });
});
