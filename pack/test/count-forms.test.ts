import { describe, expect, it } from 'vitest';
import {
  countUnitForms,
  inflectCountName,
  inflectCountWord,
} from '../src/quantity.js';

describe('inflectCountWord & inflectCountName (B5c-8)', () => {
  it('never inflects at scale === 1 or when baseRef and shownMagnitude stay on the same side of 1', () => {
    expect(inflectCountName('large eggs', 3, 1, 1)).toBe('large eggs');
    expect(inflectCountName('large eggs', 3, 2, 2 / 3)).toBe('large eggs');
    expect(inflectCountName('yellow onion, diced', 1, 0.5, 0.5)).toBe('yellow onion, diced');
    expect(inflectCountName('yellow onion, diced', 1, 1, 0.5)).toBe('yellow onion, diced');
  });

  it('inflects singular ↔ plural across 1 for regular, -ies, -ves, and -es nouns', () => {
    // 2 → 1 (plural to singular)
    expect(inflectCountName('large eggs', 2, 1, 0.5)).toBe('large egg');
    expect(inflectCountName('large eggs', 2, 0.5, 0.25)).toBe('large egg');
    expect(inflectCountName('bay leaves, dried', 2, 1, 0.5)).toBe('bay leaf, dried');
    expect(inflectCountName('russet potatoes (peeled)', 2, 1, 0.5)).toBe(
      'russet potato (peeled)',
    );
    expect(inflectCountName('plum tomatoes, halved', 4, 1, 0.25)).toBe('plum tomato, halved');
    expect(inflectCountName('red radishes, thinly sliced', 4, 1, 0.25)).toBe(
      'red radish, thinly sliced',
    );
    expect(inflectCountName('fresh cherries, pitted', 4, 1, 0.25)).toBe(
      'fresh cherry, pitted',
    );
    expect(inflectCountName('lemon halves', 2, 1, 0.5)).toBe('lemon half');

    // 1 → 2 or 1½ (singular to plural)
    expect(inflectCountName('yellow onion, diced', 1, 2, 2)).toBe('yellow onions, diced');
    expect(inflectCountName('yellow onion, diced', 1, 1.5, 1.5)).toBe('yellow onions, diced');
    expect(inflectCountName('bay leaf', 1, 2, 2)).toBe('bay leaves');
    expect(inflectCountName('russet potato', 1, 2, 2)).toBe('russet potatoes');
    expect(inflectCountName('fresh peach, sliced', 1, 2, 2)).toBe('fresh peaches, sliced');
    expect(inflectCountName('strawberry', 1, 2, 2)).toBe('strawberries');
  });

  it('leaves invariant / uncountable words and mismatched source number untouched', () => {
    // Invariant / uncountable
    expect(inflectCountName('medium zucchini, sliced', 2, 1, 0.5)).toBe(
      'medium zucchini, sliced',
    );
    expect(inflectCountName('medium zucchini, sliced', 1, 2, 2)).toBe(
      'medium zucchini, sliced',
    );
    expect(inflectCountName('summer squash', 2, 1, 0.5)).toBe('summer squash');
    expect(inflectCountName('thick-cut bread', 2, 1, 0.5)).toBe('thick-cut bread');
    expect(inflectCountName('garlic', 3, 1, 1 / 3)).toBe('garlic');

    // Source number does not match head word form ("15 red chili" has singular head word with base 15)
    expect(inflectCountName('red chili', 15, 1, 1 / 15)).toBe('red chili');
    expect(inflectCountName('eggs', 1, 2, 2)).toBe('eggs');
  });

  it('preserves capitalization on the inflected head word', () => {
    expect(inflectCountWord('Eggs', false)).toBe('Egg');
    expect(inflectCountWord('Egg', true)).toBe('Eggs');
    expect(inflectCountName('Large Eggs, beaten', 2, 1, 0.5)).toBe('Large Egg, beaten');
  });
});

describe('countUnitForms (P26 / B5c-8)', () => {
  it('returns { one, other } for known and regular count-unit words', () => {
    expect(countUnitForms('cloves')).toEqual({ one: 'clove', other: 'cloves' });
    expect(countUnitForms('clove')).toEqual({ one: 'clove', other: 'cloves' });
    expect(countUnitForms('slices')).toEqual({ one: 'slice', other: 'slices' });
    expect(countUnitForms('sprigs')).toEqual({ one: 'sprig', other: 'sprigs' });
    expect(countUnitForms('leaves')).toEqual({ one: 'leaf', other: 'leaves' });
    expect(countUnitForms('bunches')).toEqual({ one: 'bunch', other: 'bunches' });
    expect(countUnitForms('cans')).toEqual({ one: 'can', other: 'cans' });
  });
});
