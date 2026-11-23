import { describe, expect, it } from 'vitest';
import { exactFraction, formatCount, formatFraction, nearestFraction } from '../src/quantity.ts';

// Reading (c): scaled counts show the exact vulgar fraction ("4½ eggs"),
// never a rounded number. Exactness is a promise — when a value has no small
// exact fraction, we show a decimal rather than claim a fraction that isn't.

describe('exactFraction', () => {
  it('recovers halves and quarters exactly', () => {
    expect(exactFraction(1.5)).toEqual({ whole: 1, num: 1, den: 2 });
    expect(exactFraction(0.75)).toEqual({ whole: 0, num: 3, den: 4 });
    expect(exactFraction(3.75)).toEqual({ whole: 3, num: 3, den: 4 });
  });

  it('recovers thirds despite float representation', () => {
    expect(exactFraction(4 / 3)).toEqual({ whole: 1, num: 1, den: 3 });
    expect(exactFraction(11 / 3)).toEqual({ whole: 3, num: 2, den: 3 });
  });

  it('recovers twelfths (the ceiling for serving math)', () => {
    expect(exactFraction(7 / 12)).toEqual({ whole: 0, num: 7, den: 12 });
  });

  it('prefers the smallest denominator', () => {
    // 0.5 is 2/4 and 6/12 too; the answer is ½
    expect(exactFraction(0.5)).toEqual({ whole: 0, num: 1, den: 2 });
  });

  it('treats integers as exact with no fractional part', () => {
    expect(exactFraction(7)).toEqual({ whole: 7, num: 0, den: 1 });
    expect(exactFraction(0)).toEqual({ whole: 0, num: 0, den: 1 });
  });

  it('absorbs float noise on near-integers', () => {
    expect(exactFraction(2.9999999999)).toEqual({ whole: 3, num: 0, den: 1 });
  });

  it('returns null when no exact small fraction exists', () => {
    expect(exactFraction(3.14159)).toBeNull();
    expect(exactFraction(0.1234)).toBeNull();
  });
});

describe('nearestFraction', () => {
  const kitchen = [2, 3, 4, 8] as const;

  it('rounds to the closest kitchen fraction', () => {
    // 120 ml in cups = 0.5072 → ½
    expect(nearestFraction(0.5072, kitchen)).toEqual({ whole: 0, num: 1, den: 2 });
    // 360 ml in cups = 1.5216 → 1½
    expect(nearestFraction(1.5216, kitchen)).toEqual({ whole: 1, num: 1, den: 2 });
  });

  it('rounds up to a whole when that is closest', () => {
    // 28 g in oz = 0.9876 → 1
    expect(nearestFraction(0.9876, kitchen)).toEqual({ whole: 1, num: 0, den: 1 });
  });

  it('reduces the chosen fraction', () => {
    // only eighths offered, but 0.5 must still come back as ½
    expect(nearestFraction(0.501, [8])).toEqual({ whole: 0, num: 1, den: 2 });
  });

  it('prefers the smaller denominator on a tie', () => {
    // 0.625 is exactly ⅝; 0.5625 sits exactly between ½ and ⅝ → ½ wins
    expect(nearestFraction(0.625, kitchen)).toEqual({ whole: 0, num: 5, den: 8 });
    expect(nearestFraction(0.5625, kitchen)).toEqual({ whole: 0, num: 1, den: 2 });
  });

  it('answers with the truly nearest fraction even when it overstates badly', () => {
    // 2 g in oz = 0.0706 → ⅛ is nearest; whether ⅛ is honest to SHOW is the
    // formatter's call (units.ts snap tolerance), not this function's
    expect(nearestFraction(0.0706, kitchen)).toEqual({ whole: 0, num: 1, den: 8 });
  });

  it('can round to zero when the value is below half the smallest fraction', () => {
    expect(nearestFraction(0.03, kitchen)).toEqual({ whole: 0, num: 0, den: 1 });
  });
});

describe('formatFraction', () => {
  it('renders unicode vulgar glyphs tight against the whole', () => {
    expect(formatFraction({ whole: 4, num: 1, den: 2 })).toBe('4½');
    expect(formatFraction({ whole: 0, num: 3, den: 4 })).toBe('¾');
    expect(formatFraction({ whole: 1, num: 1, den: 3 })).toBe('1⅓');
    expect(formatFraction({ whole: 0, num: 7, den: 8 })).toBe('⅞');
  });

  it('falls back to a fraction-slash form when no glyph exists', () => {
    expect(formatFraction({ whole: 0, num: 7, den: 12 })).toBe('7⁄12');
    expect(formatFraction({ whole: 1, num: 7, den: 12 })).toBe('1 7⁄12');
  });

  it('renders whole numbers and zero plainly', () => {
    expect(formatFraction({ whole: 2, num: 0, den: 1 })).toBe('2');
    expect(formatFraction({ whole: 0, num: 0, den: 1 })).toBe('0');
  });
});

describe('formatCount', () => {
  it('shows exact fractions for scaled counts', () => {
    // 3 yolks scaled 4→6 servings
    expect(formatCount(4.5)).toBe('4½');
    // half an onion scaled 4→6
    expect(formatCount(0.75)).toBe('¾');
    // 1 egg scaled 4→5
    expect(formatCount(1.25)).toBe('1¼');
    // 4 cloves scaled 3→4
    expect(formatCount(4 * (4 / 3))).toBe('5⅓');
  });

  it('shows whole counts without decoration', () => {
    expect(formatCount(4)).toBe('4');
  });

  it('shows a decimal rather than a wrong fraction', () => {
    expect(formatCount(3.14159)).toBe('3.14');
  });
});
