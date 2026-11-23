import { describe, expect, it } from 'vitest';
import {
  formatQuantity,
  formatQuantityRange,
  formatCount,
  formatCountRange,
  formatScaledMeasure,
  formatScaledMeasureRange,
  formatScaledCount,
  formatScaledCountRange,
  isBelowConversionFloor,
  type UnitId,
} from '../src/quantity.js';

describe('formatScaledMeasure (B5c-7)', () => {
  it('stands unchanged at scale === 1 across every unit', () => {
    const cases: [number, UnitId][] = [
      [1, 'cup'],
      [1.25, 'cup'],
      [0.3333333, 'cup'],
      [2, 'tbsp'],
      [0.5, 'tsp'],
      [8, 'oz'],
      [1.5, 'lb'],
      [120, 'g'],
      [45.5, 'g'],
      [1.25, 'kg'],
      [250, 'ml'],
      [0.75, 'l'],
    ];
    for (const [val, unit] of cases) {
      expect(formatScaledMeasure(val, unit, 1).text).toBe(formatQuantity(val, unit));
    }
  });

  it('splits cup misses into largest cup fraction below + tbsp/tsp remainder', () => {
    // 1¼ cups × ⅔ = 5/6 cup → "¾ cup + 4 tsp", never "⅞ cup"
    const fiveSixths = (1.25 * 2) / 3;
    const res = formatScaledMeasure(fiveSixths, 'cup', 2 / 3);
    expect(res.text).toBe('¾ cup + 4 tsp');
    expect(res.isCompound).toBe(true);
    expect(res.text).not.toContain('⅞');

    // Clean cup fraction within 2% snaps cleanly
    const cleanThreeQuarters = formatScaledMeasure(0.75, 'cup', 0.75);
    expect(cleanThreeQuarters.text).toBe('¾ cup');
    expect(cleanThreeQuarters.isCompound).toBe(false);

    // ½ cup × ⅓ = 1/6 cup = ⅛ cup + 2 tsp
    const oneSixth = 0.5 / 3;
    const sixthRes = formatScaledMeasure(oneSixth, 'cup', 1 / 3);
    expect(sixthRes.text).toBe('⅛ cup + 2 tsp');
    expect(sixthRes.isCompound).toBe(true);

    // ¼ cup × ½ = ⅛ cup (snaps cleanly to ⅛ cup)
    expect(formatScaledMeasure(0.125, 'cup', 0.5).text).toBe('⅛ cup');

    // ⅓ cup × ¼ = 1/12 cup = 4 tsp → "4 tsp"
    expect(formatScaledMeasure(1 / 12, 'cup', 0.25).text).toBe('4 tsp');
  });

  it('formats tbsp at scale !== 1 with half-tbsp snap or tbsp + tsp split', () => {
    // 1 tbsp × ⅔ = 2/3 tbsp → "2 tsp"
    expect(formatScaledMeasure(2 / 3, 'tbsp', 2 / 3).text).toBe('2 tsp');

    // 2 tbsp × ⅔ = 4/3 tbsp → "1 tbsp + 1 tsp"
    expect(formatScaledMeasure(4 / 3, 'tbsp', 2 / 3).text).toBe('1 tbsp + 1 tsp');

    // 2½ tbsp × ⅔ = 5/3 tbsp → "1 tbsp + 2 tsp"
    expect(formatScaledMeasure(5 / 3, 'tbsp', 2 / 3).text).toBe('1 tbsp + 2 tsp');

    // 3 tbsp × ½ = 1½ tbsp
    expect(formatScaledMeasure(1.5, 'tbsp', 0.5).text).toBe('1½ tbsp');

    // 1 tbsp × ¼ = 0.25 tbsp = ¾ tsp
    expect(formatScaledMeasure(0.25, 'tbsp', 0.25).text).toBe('¾ tsp');
  });

  it('snaps tsp to nearest ⅛ tsp and collapses < ⅛ tsp to "a pinch"', () => {
    // ¼ tsp × ⅓ = 1/12 tsp (< ⅛ tsp) → "a pinch"
    const pinch = formatScaledMeasure(0.25 / 3, 'tsp', 1 / 3);
    expect(pinch.text).toBe('a pinch');
    expect(pinch.isPinch).toBe(true);
    expect(pinch.isApprox).toBe(true);

    // ½ tsp × ½ = ¼ tsp
    expect(formatScaledMeasure(0.25, 'tsp', 0.5).text).toBe('¼ tsp');

    // 1 tsp × ⅔ = ⅔ tsp → nearest ⅛ is ⅝ tsp (0.625)
    expect(formatScaledMeasure(2 / 3, 'tsp', 2 / 3).text).toBe('⅝ tsp');
  });

  it('snaps oz to nearest ¼ oz with "about ¼ oz" zero floor', () => {
    // 1 oz × ⅛ = 0.125 oz (ties to 0 at ¼ step) → "about ¼ oz"
    const floorOz = formatScaledMeasure(0.125, 'oz', 0.125);
    expect(floorOz.text).toBe('about ¼ oz');
    expect(floorOz.isApprox).toBe(true);

    // 4 oz × ⅔ = 2.666... oz → "2¾ oz"
    expect(formatScaledMeasure(8 / 3, 'oz', 2 / 3).text).toBe('2¾ oz');
  });

  it('splits lb misses or < 1 lb into whole lb + oz to nearest ¼ oz', () => {
    // 1 lb × ⅔ → "10¾ oz"
    expect(formatScaledMeasure(2 / 3, 'lb', 2 / 3).text).toBe('10¾ oz');

    // 2 lb × ⅔ → "1 lb + 5¼ oz"
    expect(formatScaledMeasure(4 / 3, 'lb', 2 / 3).text).toBe('1 lb + 5¼ oz');

    // 1 lb × ½ = 0.5 lb → "8 oz"
    expect(formatScaledMeasure(0.5, 'lb', 0.5).text).toBe('8 oz');

    // 1½ lb × 1.5 = 2¼ lb → "2¼ lb"
    expect(formatScaledMeasure(2.25, 'lb', 1.5).text).toBe('2¼ lb');
  });

  it('formats metric g/ml/kg/l with zero floor', () => {
    expect(formatScaledMeasure(133.333, 'g', 2 / 3).text).toBe('133 g');
    expect(formatScaledMeasure(12.34, 'g', 2 / 3).text).toBe('12.3 g');
    expect(formatScaledMeasure(0.02, 'g', 0.1).text).toBe('about 0.1 g');
    expect(formatScaledMeasure(0.002, 'kg', 0.1).text).toBe('about 0.01 kg');
    expect(formatScaledMeasure(0.002, 'l', 0.1).text).toBe('about 0.01 l');
  });
});

describe('formatScaledMeasureRange (B5c-7)', () => {
  it('matches formatQuantityRange at scale === 1', () => {
    expect(formatScaledMeasureRange(2, 3, 'tbsp', 1).text).toBe(formatQuantityRange(2, 3, 'tbsp'));
    expect(formatScaledMeasureRange(1, 2, 'cup', 1).text).toBe(formatQuantityRange(1, 2, 'cup'));
  });

  it('snaps both endpoints in the stated unit and collapses colliding ends to "about <val>"', () => {
    // "2–3 tbsp" × ⅔ → "1½–2 tbsp"
    expect(formatScaledMeasureRange(4 / 3, 2, 'tbsp', 2 / 3).text).toBe('1½–2 tbsp');

    // "1–1¼ tbsp" × ½ = 0.5–0.625 tbsp → both snap to ½ tbsp → "about ½ tbsp"
    const collapsed = formatScaledMeasureRange(0.5, 0.625, 'tbsp', 0.5);
    expect(collapsed.text).toBe('about ½ tbsp');
    expect(collapsed.isApprox).toBe(true);
  });
});

describe('formatScaledCount & formatScaledCountRange (B5c-7)', () => {
  it('matches formatCount / formatCountRange at scale === 1', () => {
    expect(formatScaledCount(4, 1).text).toBe(formatCount(4));
    expect(formatScaledCount(4.5, 1).text).toBe('4½');
    expect(formatScaledCountRange(8, 10, 1).text).toBe(formatCountRange(8, 10));
  });

  it('snaps scaled counts to whole or ½, using "about" when rounded and "about ½" as zero floor', () => {
    // 4 × ½ = 2 (exact)
    const two = formatScaledCount(2, 0.5);
    expect(two.text).toBe('2');
    expect(two.isApprox).toBe(false);
    expect(two.exact).toBeUndefined();

    // 3 × ½ = 1½ (exact)
    const oneAndHalf = formatScaledCount(1.5, 0.5);
    expect(oneAndHalf.text).toBe('1½');
    expect(oneAndHalf.isApprox).toBe(false);

    // 8 × ⅔ = 5⅓ → "about 5", exact: "5⅓"
    const fiveThirds = formatScaledCount(16 / 3, 2 / 3);
    expect(fiveThirds.text).toBe('about 5');
    expect(fiveThirds.magnitude).toBe(5);
    expect(fiveThirds.isApprox).toBe(true);
    expect(fiveThirds.exact).toBe('5⅓');

    // 1 × ⅛ = 0.125 → "about ½", exact: "⅛"
    const eighth = formatScaledCount(0.125, 0.125);
    expect(eighth.text).toBe('about ½');
    expect(eighth.magnitude).toBe(0.5);
    expect(eighth.isApprox).toBe(true);
    expect(eighth.exact).toBe('⅛');
  });

  it('formats scaled count ranges and collapses colliding endpoints', () => {
    // 8–10 × ½ = 4–5
    expect(formatScaledCountRange(4, 5, 0.5).text).toBe('4–5');

    // 1–2 × ¼ = 0.25–0.5 → 0.25 floors to ½, 0.5 is ½ → "about ½"
    const collapsed = formatScaledCountRange(0.25, 0.5, 0.25);
    expect(collapsed.text).toBe('about ½');
    expect(collapsed.isApprox).toBe(true);
  });
});

describe('isBelowConversionFloor (B5c-7)', () => {
  it('drops conversion rows below ⅛ cup, ½ tbsp, or ⅛ tsp', () => {
    expect(isBelowConversionFloor(0.06, 'cup')).toBe(true);
    expect(isBelowConversionFloor(0.125, 'cup')).toBe(false);
    expect(isBelowConversionFloor(0.3, 'tbsp')).toBe(true);
    expect(isBelowConversionFloor(0.5, 'tbsp')).toBe(false);
    expect(isBelowConversionFloor(0.08, 'tsp')).toBe(true);
    expect(isBelowConversionFloor(0.125, 'tsp')).toBe(false);
    expect(isBelowConversionFloor(0.05, 'oz')).toBe(false);
    expect(isBelowConversionFloor(0.05, 'g')).toBe(false);
  });
});
