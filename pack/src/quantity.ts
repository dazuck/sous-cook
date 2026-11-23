// @sous/pack/quantity: the one reader of ingredient amounts, shared by the
// app and the Player (slice B4, decision 9). Four parts, in order:
//
//   1. fractions: exact fractions for counts, kitchen-fraction snapping;
//   2. units: the unit table, conversion and formatting;
//   3. representations: render-time display from qty_canonical and hints;
//   4. the amount parser: reads a legacy recipe line ({item, amount, unit})
//      into a class the converter turns into a pack ingredient.
//
// Parts 1-3 moved verbatim from player/src/lib/{fractions,units,quantity}.ts,
// which now re-export from here. One file with no relative imports, like
// index.ts: the app (bundler), Player (`.ts` imports) and Studio (NodeNext,
// `.js` imports) each resolve relative specifiers differently (B3 decision 2).
// So representations take a structural ingredient type rather than importing
// `Ingredient`; a pack test holds the two compatible.

// ---------------------------------------------------------------------------
// 1. Fractions
// ---------------------------------------------------------------------------

// Exact-fraction rendering for counted ingredients (reading (c): "4½ eggs",
// never a rounded count) plus nearest-fraction snapping for imperial kitchen
// units. Exactness is a promise: exactFraction returns null rather than an
// approximation, and the caller falls back to a decimal.

export interface Fraction {
  whole: number;
  num: number;
  den: number;
}

const EPSILON = 1e-9;

// Every fraction with a dedicated Unicode glyph, keyed "num/den".
const VULGAR: Record<string, string> = {
  '1/2': '½',
  '1/3': '⅓',
  '2/3': '⅔',
  '1/4': '¼',
  '3/4': '¾',
  '1/5': '⅕',
  '2/5': '⅖',
  '3/5': '⅗',
  '4/5': '⅘',
  '1/6': '⅙',
  '5/6': '⅚',
  '1/7': '⅐',
  '1/8': '⅛',
  '3/8': '⅜',
  '5/8': '⅝',
  '7/8': '⅞',
  '1/9': '⅑',
  '1/10': '⅒',
};

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function normalize(whole: number, num: number, den: number): Fraction {
  if (num === den) return { whole: whole + 1, num: 0, den: 1 };
  if (num === 0) return { whole, num: 0, den: 1 };
  const divisor = gcd(num, den);
  return { whole, num: num / divisor, den: den / divisor };
}

/** Strip meaningless trailing zeros from a toFixed() result. */
export function trimDecimal(fixed: string): string {
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * The smallest-denominator fraction that represents `value` exactly
 * (within float noise), or null if none exists up to maxDenominator.
 */
export function exactFraction(value: number, maxDenominator = 12): Fraction | null {
  const whole = Math.floor(value);
  const frac = value - whole;
  for (let den = 1; den <= maxDenominator; den++) {
    const num = Math.round(frac * den);
    if (Math.abs(frac - num / den) < EPSILON) {
      return normalize(whole, num, den);
    }
  }
  return null;
}

/**
 * The closest fraction to `value` using the given denominators (integers are
 * always candidates). Ties prefer the smaller denominator. Truthful, not
 * kitchen-honest: the caller decides whether the snap is close enough to show.
 */
export function nearestFraction(value: number, denominators: readonly number[]): Fraction {
  const whole = Math.floor(value);
  const frac = value - whole;
  const dens = [...new Set([1, ...denominators])].sort((a, b) => a - b);
  let bestNum = 0;
  let bestDen = 1;
  let bestDiff = Infinity;
  for (const den of dens) {
    const num = Math.round(frac * den);
    const diff = Math.abs(frac - num / den);
    if (diff < bestDiff - EPSILON) {
      bestNum = num;
      bestDen = den;
      bestDiff = diff;
    }
  }
  return normalize(whole, bestNum, bestDen);
}

export function formatFraction(fraction: Fraction): string {
  const { whole, num, den } = fraction;
  if (num === 0) return String(whole);
  const glyph = VULGAR[`${String(num)}/${String(den)}`];
  if (glyph !== undefined) {
    return whole > 0 ? String(whole) + glyph : glyph;
  }
  const slashed = `${String(num)}⁄${String(den)}`;
  return whole > 0 ? `${String(whole)} ${slashed}` : slashed;
}

/**
 * Display form for a (possibly scaled) ingredient count. Exact fraction when
 * one exists; otherwise an honest decimal — never a fraction that lies.
 */
export function formatCount(value: number): string {
  const exact = exactFraction(value);
  if (exact !== null) return formatFraction(exact);
  return trimDecimal(value.toFixed(2));
}

// ---------------------------------------------------------------------------
// 2. Units
// ---------------------------------------------------------------------------

// Unit table and conversion for render-time quantity display (reading (b):
// display_equivalents carry unit preferences, numbers are always recomputed
// from canonical). Conversion factors seeded from the app's earlier toBase
// table. Imperial values snap to kitchen fractions only when the snap is
// honest; metric keeps one decimal of exactness below 100.

export type Dimension = 'mass' | 'volume';
export type UnitSystem = 'metric' | 'imperial';
export type UnitId = 'g' | 'kg' | 'oz' | 'lb' | 'ml' | 'l' | 'tsp' | 'tbsp' | 'cup';

export interface Unit {
  id: UnitId;
  dimension: Dimension;
  system: UnitSystem;
  /** Factor to the dimension's base unit: grams for mass, millilitres for volume. */
  toBase: number;
  label: string;
  labelPlural: string;
  aliases: readonly string[];
}

export const UNITS: Record<UnitId, Unit> = {
  g: {
    id: 'g',
    dimension: 'mass',
    system: 'metric',
    toBase: 1,
    label: 'g',
    labelPlural: 'g',
    aliases: ['g', 'gram', 'grams'],
  },
  kg: {
    id: 'kg',
    dimension: 'mass',
    system: 'metric',
    toBase: 1000,
    label: 'kg',
    labelPlural: 'kg',
    aliases: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  },
  oz: {
    id: 'oz',
    dimension: 'mass',
    system: 'imperial',
    toBase: 28.3495,
    label: 'oz',
    labelPlural: 'oz',
    aliases: ['oz', 'ounce', 'ounces'],
  },
  lb: {
    id: 'lb',
    dimension: 'mass',
    system: 'imperial',
    toBase: 453.592,
    label: 'lb',
    labelPlural: 'lb',
    aliases: ['lb', 'lbs', 'pound', 'pounds'],
  },
  ml: {
    id: 'ml',
    dimension: 'volume',
    system: 'metric',
    toBase: 1,
    label: 'ml',
    labelPlural: 'ml',
    aliases: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'],
  },
  l: {
    id: 'l',
    dimension: 'volume',
    system: 'metric',
    toBase: 1000,
    label: 'l',
    labelPlural: 'l',
    aliases: ['l', 'liter', 'liters', 'litre', 'litres'],
  },
  tsp: {
    id: 'tsp',
    dimension: 'volume',
    system: 'imperial',
    toBase: 4.929,
    label: 'tsp',
    labelPlural: 'tsp',
    aliases: ['tsp', 'teaspoon', 'teaspoons'],
  },
  tbsp: {
    id: 'tbsp',
    dimension: 'volume',
    system: 'imperial',
    toBase: 14.787,
    label: 'tbsp',
    labelPlural: 'tbsp',
    aliases: ['tbsp', 'tbs', 'tablespoon', 'tablespoons'],
  },
  cup: {
    id: 'cup',
    dimension: 'volume',
    system: 'imperial',
    toBase: 236.588,
    label: 'cup',
    labelPlural: 'cups',
    aliases: ['cup', 'cups'],
  },
};

const KITCHEN_DENOMINATORS = [2, 3, 4, 8] as const;

// A kitchen fraction is shown only when it's within 5% of the true value —
// "⅛ oz" for 2 g of pepper would overstate by 77%, so that renders as a
// decimal instead.
const SNAP_TOLERANCE = 0.05;

const ALIAS_INDEX = new Map<string, UnitId>();
for (const unit of Object.values(UNITS)) {
  for (const alias of unit.aliases) {
    ALIAS_INDEX.set(alias, unit.id);
  }
}

export function getUnit(id: UnitId): Unit {
  return UNITS[id];
}

export function unitFromAlias(word: string): Unit | undefined {
  const id = ALIAS_INDEX.get(word.trim().toLowerCase());
  return id === undefined ? undefined : UNITS[id];
}

export function convertValue(value: number, from: UnitId, to: UnitId): number {
  const fromUnit = UNITS[from];
  const toUnit = UNITS[to];
  if (fromUnit.dimension !== toUnit.dimension) {
    throw new Error(
      `cannot convert ${fromUnit.dimension} (${from}) to ${toUnit.dimension} (${to}) — check dimensions before converting`,
    );
  }
  return (value * fromUnit.toBase) / toUnit.toBase;
}

function renderValue(value: number, unit: UnitId): { text: string; magnitude: number } {
  if (value === 0) return { text: '0', magnitude: 0 };
  const def = UNITS[unit];

  if (def.system === 'imperial') {
    const snapped = nearestFraction(value, KITCHEN_DENOMINATORS);
    const snappedValue = snapped.whole + snapped.num / snapped.den;
    if (Math.abs(snappedValue - value) / value <= SNAP_TOLERANCE) {
      return { text: formatFraction(snapped), magnitude: snappedValue };
    }
    return { text: trimDecimal(value.toFixed(2)), magnitude: value };
  }

  if (unit === 'kg' || unit === 'l') {
    return { text: trimDecimal(value.toFixed(2)), magnitude: value };
  }
  if (value >= 100) {
    const rounded = Math.round(value);
    return { text: String(rounded), magnitude: rounded };
  }
  return { text: trimDecimal(value.toFixed(1)), magnitude: value };
}

/** The number alone, formatted for its unit: "237", "4.5", "1½". */
export function formatUnitValue(value: number, unit: UnitId): string {
  return renderValue(value, unit).text;
}

/** Number plus label: "454 g", "1½ cups". Pluralized on the displayed magnitude. */
export function formatQuantity(value: number, unit: UnitId): string {
  const { text, magnitude } = renderValue(value, unit);
  const def = UNITS[unit];
  return `${text} ${magnitude > 1 ? def.labelPlural : def.label}`;
}

/**
 * Range of numbers in one unit: "2–3 tbsp", "1½–2 lb". The unit appears once
 * at the end, pluralized on the high end's displayed magnitude; if the two
 * displayed numbers collide, collapses to a single number.
 */
export function formatQuantityRange(min: number, max: number, unit: UnitId): string {
  const low = renderValue(min, unit);
  const high = renderValue(max, unit);
  const def = UNITS[unit];
  if (low.text === high.text) {
    return `${low.text} ${low.magnitude > 1 ? def.labelPlural : def.label}`;
  }
  return `${low.text}–${high.text} ${high.magnitude > 1 ? def.labelPlural : def.label}`;
}

/** Range of counts: "8–10", collapsing to a single number when the ends match. */
export function formatCountRange(min: number, max: number): string {
  const low = formatCount(min);
  const high = formatCount(max);
  return low === high ? low : `${low}–${high}`;
}

// ---------------------------------------------------------------------------
// 2b. Scaled Display Rounding & Count Agreement (B5c-7, B5c-8)
// ---------------------------------------------------------------------------

// At ×1, authored amounts render through formatQuantity / formatCount as
// written. At scale !== 1, scaled amounts snap to real measuring tools (or
// split into compound kitchen measures like "¾ cup + 4 tsp", "1 lb + 5¼ oz")
// so the cook never sees "0.83 cup", "⅞ cup", or "5⅓ eggs".
const SCALED_SNAP_TOLERANCE = 0.02;

const CUP_BELOW_CANDIDATES: readonly Fraction[] = [
  { whole: 0, num: 0, den: 1 },
  { whole: 0, num: 1, den: 8 },
  { whole: 0, num: 1, den: 4 },
  { whole: 0, num: 1, den: 3 },
  { whole: 0, num: 3, den: 8 },
  { whole: 0, num: 1, den: 2 },
  { whole: 0, num: 5, den: 8 },
  { whole: 0, num: 2, den: 3 },
  { whole: 0, num: 3, den: 4 },
  { whole: 0, num: 7, den: 8 },
];

function fractionValue(f: Fraction): number {
  return f.whole + f.num / f.den;
}

export interface ScaledMeasureText {
  /** Full display string: "¾ cup + 4 tsp", "2 tsp", "a pinch", "454 g". */
  text: string;
  /** Value portion alone when the measure stays in `unit` (or "a pinch"): "1½", "about ¼", "a pinch". */
  value: string;
  /** Unit portion alone (empty when `text` is a compound measure or "a pinch"). */
  unit: string;
  /** Displayed magnitude in `unit` for pluralization. */
  magnitude: number;
  /** True when the measure is a compound split ("¾ cup + 4 tsp", "1 lb + 5¼ oz"). */
  isCompound: boolean;
  /** True when the measure starts with "about " or is "a pinch". */
  isApprox: boolean;
  /** True when the measure collapsed to "a pinch". */
  isPinch: boolean;
}

export interface ScaledCountText {
  /** Display string for the count: "4", "1½", "about 5", "about ½". */
  text: string;
  /** Displayed numeric magnitude for singular/plural agreement (<= 1 is singular). */
  magnitude: number;
  /** True when rounding moved the value ("about …"). */
  isApprox: boolean;
  /** Exact scaled count string ("5⅓", "⅛") when `isApprox` is true; undefined when exact. */
  exact?: string | undefined;
}

function pinchMeasure(magnitude: number): ScaledMeasureText {
  return {
    text: 'a pinch',
    value: 'a pinch',
    unit: '',
    magnitude,
    isCompound: false,
    isApprox: true,
    isPinch: true,
  };
}

function simpleMeasure(
  valueText: string,
  unit: UnitId,
  magnitude: number,
  isApprox = false,
): ScaledMeasureText {
  const def = UNITS[unit];
  const unitLabel = magnitude > 1 + EPSILON ? def.labelPlural : def.label;
  return {
    text: `${valueText} ${unitLabel}`,
    value: valueText,
    unit: unitLabel,
    magnitude,
    isCompound: false,
    isApprox,
    isPinch: false,
  };
}

function compoundMeasure(text: string, magnitude: number): ScaledMeasureText {
  return {
    text,
    value: text,
    unit: '',
    magnitude,
    isCompound: true,
    isApprox: false,
    isPinch: false,
  };
}

function formatScaledCup(value: number): ScaledMeasureText {
  if (value <= 0) return simpleMeasure('0', 'cup', 0);
  if (value * 48 < 0.125 - EPSILON) return pinchMeasure(value);

  const snapped = nearestFraction(value, KITCHEN_DENOMINATORS);
  const snappedVal = fractionValue(snapped);
  if (snappedVal > 0 && Math.abs(snappedVal - value) / value <= SCALED_SNAP_TOLERANCE) {
    return simpleMeasure(formatFraction(snapped), 'cup', snappedVal);
  }

  const whole = Math.floor(value - EPSILON);
  const rem = value - whole;
  let belowSub: Fraction = { whole: 0, num: 0, den: 1 };
  for (const cand of CUP_BELOW_CANDIDATES) {
    const candVal = fractionValue(cand);
    if (candVal < rem - EPSILON) {
      belowSub = cand;
    }
  }
  const belowFrac: Fraction = { whole, num: belowSub.num, den: belowSub.den };
  const belowVal = fractionValue(belowFrac);
  const restCups = value - belowVal;

  const restTbsp = restCups * 16;
  const snappedTbsp = nearestFraction(restTbsp, [2]);
  const snappedTbspVal = fractionValue(snappedTbsp);
  const tbspFits =
    snappedTbspVal >= 0.5 - EPSILON &&
    restTbsp > 0 &&
    Math.abs(snappedTbspVal - restTbsp) / restTbsp <= SCALED_SNAP_TOLERANCE;

  if (tbspFits) {
    const tbspText = formatFraction(snappedTbsp);
    if (belowVal <= EPSILON) {
      return simpleMeasure(tbspText, 'tbsp', snappedTbspVal);
    }
    const cupLabel = belowVal > 1 + EPSILON ? 'cups' : 'cup';
    return compoundMeasure(`${formatFraction(belowFrac)} ${cupLabel} + ${tbspText} tbsp`, value);
  }

  const restTsp = restCups * 48;
  const snappedTsp = nearestFraction(restTsp, [2, 4, 8]);
  const snappedTspVal = fractionValue(snappedTsp);
  if (snappedTspVal <= EPSILON) {
    if (belowVal <= EPSILON) return pinchMeasure(value);
    return simpleMeasure(formatFraction(belowFrac), 'cup', belowVal);
  }
  const tspText = formatFraction(snappedTsp);
  if (belowVal <= EPSILON) {
    return simpleMeasure(tspText, 'tsp', snappedTspVal);
  }
  const cupLabel = belowVal > 1 + EPSILON ? 'cups' : 'cup';
  return compoundMeasure(`${formatFraction(belowFrac)} ${cupLabel} + ${tspText} tsp`, value);
}

function formatScaledTbsp(value: number): ScaledMeasureText {
  if (value <= 0) return simpleMeasure('0', 'tbsp', 0);
  if (value * 3 < 0.125 - EPSILON) return pinchMeasure(value);

  const snapped = nearestFraction(value, [2]);
  const snappedVal = fractionValue(snapped);
  if (
    snappedVal >= 0.5 - EPSILON &&
    Math.abs(snappedVal - value) / value <= SCALED_SNAP_TOLERANCE
  ) {
    return simpleMeasure(formatFraction(snapped), 'tbsp', snappedVal);
  }

  // Prefer whole tbsp + whole tsp when the remainder after whole tbsp is a clean
  // 1 or 2 tsp (e.g. 1 tbsp × ⅔ → "2 tsp", 2 tbsp × ⅔ → "1 tbsp + 1 tsp",
  // 2½ tbsp × ⅔ → "1 tbsp + 2 tsp").
  const wholeTbsp = Math.floor(value - EPSILON);
  const wholeRestTsp = (value - wholeTbsp) * 3;
  const nearestWholeTsp = Math.round(wholeRestTsp);
  if (
    nearestWholeTsp >= 1 &&
    nearestWholeTsp <= 2 &&
    Math.abs(nearestWholeTsp - wholeRestTsp) / wholeRestTsp <= SCALED_SNAP_TOLERANCE
  ) {
    if (wholeTbsp === 0) {
      return simpleMeasure(String(nearestWholeTsp), 'tsp', nearestWholeTsp);
    }
    return compoundMeasure(`${String(wholeTbsp)} tbsp + ${String(nearestWholeTsp)} tsp`, value);
  }

  const belowHalfSteps = Math.floor((value - EPSILON) * 2);
  const belowTbspVal = belowHalfSteps / 2;
  const belowTbspFrac = nearestFraction(belowTbspVal, [2]);
  const restTsp = (value - belowTbspVal) * 3;
  const snappedTsp = nearestFraction(restTsp, [2, 4, 8]);
  const snappedTspVal = fractionValue(snappedTsp);

  if (snappedTspVal <= EPSILON) {
    if (belowTbspVal <= EPSILON) return pinchMeasure(value);
    return simpleMeasure(formatFraction(belowTbspFrac), 'tbsp', belowTbspVal);
  }
  const tspText = formatFraction(snappedTsp);
  if (belowTbspVal <= EPSILON) {
    return simpleMeasure(tspText, 'tsp', snappedTspVal);
  }
  return compoundMeasure(`${formatFraction(belowTbspFrac)} tbsp + ${tspText} tsp`, value);
}

function formatScaledTsp(value: number): ScaledMeasureText {
  if (value <= 0) return simpleMeasure('0', 'tsp', 0);
  if (value < 0.125 - EPSILON) return pinchMeasure(value);
  const snapped = nearestFraction(value, [2, 4, 8]);
  const snappedVal = fractionValue(snapped);
  return simpleMeasure(formatFraction(snapped), 'tsp', snappedVal);
}

function formatScaledOz(value: number): ScaledMeasureText {
  if (value <= 0) return simpleMeasure('0', 'oz', 0);
  const snapped = nearestFraction(value, [2, 4]);
  const snappedVal = fractionValue(snapped);
  if (snappedVal <= EPSILON) {
    return simpleMeasure('about ¼', 'oz', 0.25, true);
  }
  return simpleMeasure(formatFraction(snapped), 'oz', snappedVal);
}

function formatScaledLb(value: number): ScaledMeasureText {
  if (value <= 0) return simpleMeasure('0', 'lb', 0);
  if (value >= 1 - EPSILON) {
    const snapped = nearestFraction(value, [2, 4]);
    const snappedVal = fractionValue(snapped);
    if (Math.abs(snappedVal - value) / value <= SCALED_SNAP_TOLERANCE) {
      return simpleMeasure(formatFraction(snapped), 'lb', snappedVal);
    }
  }
  const wholeLb = Math.floor(value - EPSILON);
  const restOz = (value - wholeLb) * 16;
  const snappedOz = nearestFraction(restOz, [2, 4]);
  const snappedOzVal = fractionValue(snappedOz);
  if (snappedOzVal >= 16 - EPSILON) {
    const carried = wholeLb + 1;
    return simpleMeasure(String(carried), 'lb', carried);
  }
  if (wholeLb === 0) {
    if (snappedOzVal <= EPSILON) {
      return simpleMeasure('about ¼', 'oz', 0.25, true);
    }
    return simpleMeasure(formatFraction(snappedOz), 'oz', snappedOzVal);
  }
  if (snappedOzVal <= EPSILON) {
    return simpleMeasure(String(wholeLb), 'lb', wholeLb);
  }
  return compoundMeasure(`${String(wholeLb)} lb + ${formatFraction(snappedOz)} oz`, value);
}

function formatScaledMetric(value: number, unit: 'g' | 'kg' | 'ml' | 'l'): ScaledMeasureText {
  if (value <= 0) return simpleMeasure('0', unit, 0);
  if (unit === 'kg' || unit === 'l') {
    const rounded = Number(value.toFixed(2));
    if (rounded === 0) {
      return simpleMeasure('about 0.01', unit, 0.01, true);
    }
    return simpleMeasure(trimDecimal(value.toFixed(2)), unit, rounded);
  }
  if (value >= 100) {
    const rounded = Math.round(value);
    return simpleMeasure(String(rounded), unit, rounded);
  }
  const rounded = Number(value.toFixed(1));
  if (rounded === 0) {
    return simpleMeasure('about 0.1', unit, 0.1, true);
  }
  return simpleMeasure(trimDecimal(value.toFixed(1)), unit, rounded);
}

/**
 * Format a measured quantity (`value` already scaled by `scale`) for display.
 * At `scale === 1`, delegates to `renderValue` so ×1 is byte-identical to
 * `formatQuantity`. At `scale !== 1`, applies B5c-7 kitchen rounding and
 * compound splits ("¾ cup + 4 tsp", "1 lb + 5¼ oz", "a pinch").
 */
export function formatScaledMeasure(value: number, unit: UnitId, scale = 1): ScaledMeasureText {
  if (Math.abs(scale - 1) <= EPSILON) {
    const { text: valText, magnitude } = renderValue(value, unit);
    return simpleMeasure(valText, unit, magnitude);
  }
  switch (unit) {
    case 'cup':
      return formatScaledCup(value);
    case 'tbsp':
      return formatScaledTbsp(value);
    case 'tsp':
      return formatScaledTsp(value);
    case 'oz':
      return formatScaledOz(value);
    case 'lb':
      return formatScaledLb(value);
    case 'g':
    case 'kg':
    case 'ml':
    case 'l':
      return formatScaledMetric(value, unit);
  }
}

function snapRangeEndpoint(
  value: number,
  unit: UnitId,
): { text: string; magnitude: number; snappedChanged: boolean } {
  if (value <= 0) return { text: '0', magnitude: 0, snappedChanged: false };
  switch (unit) {
    case 'cup': {
      const s = nearestFraction(value, KITCHEN_DENOMINATORS);
      const v = fractionValue(s);
      if (v <= EPSILON) return { text: '⅛', magnitude: 0.125, snappedChanged: true };
      return { text: formatFraction(s), magnitude: v, snappedChanged: Math.abs(v - value) > EPSILON };
    }
    case 'tbsp': {
      const s = nearestFraction(value, [2]);
      const v = fractionValue(s);
      if (v <= EPSILON) return { text: '½', magnitude: 0.5, snappedChanged: true };
      return { text: formatFraction(s), magnitude: v, snappedChanged: Math.abs(v - value) > EPSILON };
    }
    case 'tsp': {
      const s = nearestFraction(value, [2, 4, 8]);
      const v = fractionValue(s);
      if (v <= EPSILON) return { text: '⅛', magnitude: 0.125, snappedChanged: true };
      return { text: formatFraction(s), magnitude: v, snappedChanged: Math.abs(v - value) > EPSILON };
    }
    case 'oz':
    case 'lb': {
      const s = nearestFraction(value, [2, 4]);
      const v = fractionValue(s);
      if (v <= EPSILON) return { text: '¼', magnitude: 0.25, snappedChanged: true };
      return { text: formatFraction(s), magnitude: v, snappedChanged: Math.abs(v - value) > EPSILON };
    }
    case 'kg':
    case 'l': {
      const rounded = Number(value.toFixed(2));
      if (rounded === 0) return { text: '0.01', magnitude: 0.01, snappedChanged: true };
      return {
        text: trimDecimal(value.toFixed(2)),
        magnitude: rounded,
        snappedChanged: Math.abs(rounded - value) > EPSILON,
      };
    }
    case 'g':
    case 'ml': {
      if (value >= 100) {
        const rounded = Math.round(value);
        return {
          text: String(rounded),
          magnitude: rounded,
          snappedChanged: Math.abs(rounded - value) > EPSILON,
        };
      }
      const rounded = Number(value.toFixed(1));
      if (rounded === 0) return { text: '0.1', magnitude: 0.1, snappedChanged: true };
      return {
        text: trimDecimal(value.toFixed(1)),
        magnitude: rounded,
        snappedChanged: Math.abs(rounded - value) > EPSILON,
      };
    }
  }
}

/**
 * Format a measured range (`min`..`max` already scaled by `scale`) in `unit`.
 * At `scale === 1`, delegates to `renderValue` so ×1 matches `formatQuantityRange`.
 * At `scale !== 1`, snaps both ends to the unit's nearest kitchen fraction and
 * collapses colliding ends to `"about <val> <unit>"`.
 */
export function formatScaledMeasureRange(
  min: number,
  max: number,
  unit: UnitId,
  scale = 1,
): ScaledMeasureText {
  if (Math.abs(scale - 1) <= EPSILON) {
    const low = renderValue(min, unit);
    const high = renderValue(max, unit);
    if (low.text === high.text) {
      return simpleMeasure(low.text, unit, low.magnitude);
    }
    return simpleMeasure(`${low.text}–${high.text}`, unit, high.magnitude);
  }
  const low = snapRangeEndpoint(min, unit);
  const high = snapRangeEndpoint(max, unit);
  if (low.text === high.text) {
    const collapsed = Math.abs(max - min) > EPSILON || low.snappedChanged || high.snappedChanged;
    const prefix = collapsed ? `about ${high.text}` : high.text;
    return simpleMeasure(prefix, unit, high.magnitude, collapsed);
  }
  return simpleMeasure(`${low.text}–${high.text}`, unit, high.magnitude);
}

/**
 * Format a count (`value` already scaled by `scale`). At `scale === 1`, returns
 * `formatCount(value)`. At `scale !== 1`, keeps exact wholes and halves ("2",
 * "1½", "½") and rounds any other value to the nearest whole number prefixed
 * with "about " ("about 5" for 5⅓), with "about ½" as the zero floor when
 * `value < 0.5`.
 */
export function formatScaledCount(value: number, scale = 1): ScaledCountText {
  if (Math.abs(scale - 1) <= EPSILON) {
    return { text: formatCount(value), magnitude: value, isApprox: false };
  }
  if (value <= 0) {
    return { text: '0', magnitude: 0, isApprox: false };
  }
  const halfStep = Math.round(value * 2) / 2;
  if (halfStep > 0 && Math.abs(halfStep - value) <= EPSILON) {
    const exactFrac = nearestFraction(halfStep, [2]);
    return {
      text: formatFraction(exactFrac),
      magnitude: halfStep,
      isApprox: false,
    };
  }
  const wholeRounded = Math.round(value);
  if (wholeRounded === 0) {
    return {
      text: 'about ½',
      magnitude: 0.5,
      isApprox: true,
      exact: formatCount(value),
    };
  }
  return {
    text: `about ${String(wholeRounded)}`,
    magnitude: wholeRounded,
    isApprox: true,
    exact: formatCount(value),
  };
}

/**
 * Format a count range (`min`..`max` already scaled by `scale`).
 */
export function formatScaledCountRange(min: number, max: number, scale = 1): ScaledCountText {
  if (Math.abs(scale - 1) <= EPSILON) {
    return { text: formatCountRange(min, max), magnitude: max, isApprox: false };
  }
  const snapEnd = (v: number): { text: string; magnitude: number; changed: boolean } => {
    if (v <= 0) return { text: '0', magnitude: 0, changed: false };
    const halfStep = Math.round(v * 2) / 2;
    if (halfStep > 0 && Math.abs(halfStep - v) <= EPSILON) {
      const exactFrac = nearestFraction(halfStep, [2]);
      return { text: formatFraction(exactFrac), magnitude: halfStep, changed: false };
    }
    const wholeRounded = Math.round(v);
    if (wholeRounded === 0) {
      return { text: '½', magnitude: 0.5, changed: true };
    }
    return { text: String(wholeRounded), magnitude: wholeRounded, changed: true };
  };
  const low = snapEnd(min);
  const high = snapEnd(max);
  if (low.text === high.text) {
    const collapsed = Math.abs(max - min) > EPSILON || low.changed || high.changed;
    if (collapsed) {
      return {
        text: `about ${high.text}`,
        magnitude: high.magnitude,
        isApprox: true,
        exact: formatCountRange(min, max),
      };
    }
    return { text: high.text, magnitude: high.magnitude, isApprox: false };
  }
  return {
    text: `${low.text}–${high.text}`,
    magnitude: high.magnitude,
    isApprox: false,
  };
}

/**
 * Conversion row floor (B5c-7): drops popover conversion rows below `⅛ cup`,
 * `½ tbsp`, or `⅛ tsp` so tiny volume equivalents (e.g. `0.06 cup`) are hidden
 * while `tbsp` / `tsp` / `g` stand.
 */
export function isBelowConversionFloor(value: number, unit: UnitId): boolean {
  if (unit === 'cup') return value < 0.125 - EPSILON;
  if (unit === 'tbsp') return value < 0.5 - EPSILON;
  if (unit === 'tsp') return value < 0.125 - EPSILON;
  return false;
}

const INVARIANT_COUNT_WORDS = new Set([
  'garlic',
  'zucchini',
  'squash',
  'bread',
  'cheese',
  'butter',
  'rice',
  'corn',
  'kale',
  'chard',
  'spinach',
  'arugula',
  'lettuce',
  'cilantro',
  'parsley',
  'rosemary',
  'thyme',
  'basil',
  'mint',
  'ginger',
  'dough',
  'paste',
  'frosting',
  'wine',
  'fish',
  'salmon',
  'meat',
  'pork',
  'beef',
  'lamb',
  'tofu',
  'bacon',
  'pasta',
  'celery',
  'broccoli',
  'cauliflower',
  'asparagus',
  'fennel',
  'lemongrass',
  'watercress',
  'endive',
  'radicchio',
  'choy',
  'nori',
  'kimchi',
  'polenta',
  'couscous',
  'quinoa',
  'farro',
  'barley',
]);

const IRREGULAR_SINGULAR_TO_PLURAL: Readonly<Record<string, string>> = {
  leaf: 'leaves',
  half: 'halves',
  loaf: 'loaves',
  knife: 'knives',
  calf: 'calves',
  shelf: 'shelves',
  potato: 'potatoes',
  tomato: 'tomatoes',
  hero: 'heroes',
  chili: 'chilies',
  chile: 'chiles',
};

const IRREGULAR_PLURAL_TO_SINGULAR: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(IRREGULAR_SINGULAR_TO_PLURAL).map(([one, other]) => [other, one]),
);

function applyCasePattern(source: string, targetLower: string): string {
  if (source.length === 0) return targetLower;
  if (source === source.toUpperCase() && source !== source.toLowerCase()) {
    return targetLower.toUpperCase();
  }
  const first = source[0];
  if (first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return targetLower.charAt(0).toUpperCase() + targetLower.slice(1);
  }
  return targetLower;
}

function looksPluralLower(lower: string): boolean {
  if (IRREGULAR_PLURAL_TO_SINGULAR[lower] !== undefined) return true;
  if (IRREGULAR_SINGULAR_TO_PLURAL[lower] !== undefined) return false;
  if (/^[a-z\u00C0-\u024F]*[bcdfghjklmnpqrstvwxz]ies$/.test(lower)) return true;
  if (/^[a-z\u00C0-\u024F]*(ch|sh|x|z|ss)es$/.test(lower)) return true;
  if (/(ss|us|is)$/.test(lower)) return false;
  return lower.endsWith('s') && lower.length > 2;
}

function toPluralLower(lower: string): string | null {
  if (INVARIANT_COUNT_WORDS.has(lower)) return null;
  const irreg = IRREGULAR_SINGULAR_TO_PLURAL[lower];
  if (irreg !== undefined) return irreg;
  if (looksPluralLower(lower)) return null;
  if (/^[a-z\u00C0-\u024F]*[bcdfghjklmnpqrstvwxz]y$/.test(lower)) {
    return `${lower.slice(0, -1)}ies`;
  }
  if (/(ch|sh|x|z|ss)$/.test(lower)) {
    return `${lower}es`;
  }
  return `${lower}s`;
}

function toSingularLower(lower: string): string | null {
  if (INVARIANT_COUNT_WORDS.has(lower)) return null;
  const irreg = IRREGULAR_PLURAL_TO_SINGULAR[lower];
  if (irreg !== undefined) return irreg;
  if (IRREGULAR_SINGULAR_TO_PLURAL[lower] !== undefined) return null;
  if (/^[a-z\u00C0-\u024F]*[bcdfghjklmnpqrstvwxz]ies$/.test(lower)) {
    return `${lower.slice(0, -3)}y`;
  }
  if (/^[a-z\u00C0-\u024F]*(ch|sh|x|z|ss)es$/.test(lower)) {
    return lower.slice(0, -2);
  }
  if (/(ss|us|is)$/.test(lower)) return null;
  if (lower.endsWith('s') && lower.length > 2) {
    return lower.slice(0, -1);
  }
  return null;
}

/**
 * Inflect a single count word to singular (`targetPlural === false`) or plural
 * (`targetPlural === true`), returning `null` if the word is invariant or does
 * not match the expected source number.
 */
export function inflectCountWord(word: string, targetPlural: boolean): string | null {
  const lower = word.toLowerCase();
  const converted = targetPlural ? toPluralLower(lower) : toSingularLower(lower);
  if (converted === null) return null;
  return applyCasePattern(word, converted);
}

/**
 * Inflect the head noun of an ingredient `name` when scaling crosses `1`
 * (B5c-8). At `scale === 1`, or when `baseRef` and `shownMagnitude` are on the
 * same side of `1`, returns `name` untouched. If the head word's form does not
 * match the source count's number (e.g. "3 garlic", "15 red chili",
 * "2 summer squash"), leaves `name` as written.
 */
export function inflectCountName(
  name: string,
  baseRef: number,
  shownMagnitude: number,
  scale = 1,
): string {
  if (Math.abs(scale - 1) <= EPSILON) return name;
  const sourceIsPlural = baseRef > 1 + EPSILON;
  const targetIsPlural = shownMagnitude > 1 + EPSILON;
  if (sourceIsPlural === targetIsPlural) return name;

  const stopMatch = /[,([]/.exec(name);
  const stopIdx = stopMatch ? stopMatch.index : name.length;
  const prefix = name.slice(0, stopIdx);
  const suffix = name.slice(stopIdx);

  const wordMatch = /([A-Za-z\u00C0-\u024F]+)(\s*)$/.exec(prefix);
  if (!wordMatch) return name;
  const headWord = wordMatch[1];
  const trailingSpace = wordMatch[2] ?? '';
  if (headWord === undefined) return name;

  const inflected = inflectCountWord(headWord, targetIsPlural);
  if (inflected === null) return name;

  const headStart = wordMatch.index;
  return `${prefix.slice(0, headStart)}${inflected}${trailingSpace}${suffix}`;
}

const COUNT_UNIT_PAIRS: Readonly<Record<string, CountUnit>> = {
  clove: { one: 'clove', other: 'cloves' },
  cloves: { one: 'clove', other: 'cloves' },
  slice: { one: 'slice', other: 'slices' },
  slices: { one: 'slice', other: 'slices' },
  sprig: { one: 'sprig', other: 'sprigs' },
  sprigs: { one: 'sprig', other: 'sprigs' },
  stalk: { one: 'stalk', other: 'stalks' },
  stalks: { one: 'stalk', other: 'stalks' },
  head: { one: 'head', other: 'heads' },
  heads: { one: 'head', other: 'heads' },
  bunch: { one: 'bunch', other: 'bunches' },
  bunches: { one: 'bunch', other: 'bunches' },
  leaf: { one: 'leaf', other: 'leaves' },
  leaves: { one: 'leaf', other: 'leaves' },
  piece: { one: 'piece', other: 'pieces' },
  pieces: { one: 'piece', other: 'pieces' },
  strip: { one: 'strip', other: 'strips' },
  strips: { one: 'strip', other: 'strips' },
  ear: { one: 'ear', other: 'ears' },
  ears: { one: 'ear', other: 'ears' },
  bulb: { one: 'bulb', other: 'bulbs' },
  bulbs: { one: 'bulb', other: 'bulbs' },
  fillet: { one: 'fillet', other: 'fillets' },
  fillets: { one: 'fillet', other: 'fillets' },
  rib: { one: 'rib', other: 'ribs' },
  ribs: { one: 'rib', other: 'ribs' },
  link: { one: 'link', other: 'links' },
  links: { one: 'link', other: 'links' },
  patty: { one: 'patty', other: 'patties' },
  patties: { one: 'patty', other: 'patties' },
  sheet: { one: 'sheet', other: 'sheets' },
  sheets: { one: 'sheet', other: 'sheets' },
  wedge: { one: 'wedge', other: 'wedges' },
  wedges: { one: 'wedge', other: 'wedges' },
  cube: { one: 'cube', other: 'cubes' },
  cubes: { one: 'cube', other: 'cubes' },
  ring: { one: 'ring', other: 'rings' },
  rings: { one: 'ring', other: 'rings' },
  spear: { one: 'spear', other: 'spears' },
  spears: { one: 'spear', other: 'spears' },
  floret: { one: 'floret', other: 'florets' },
  florets: { one: 'floret', other: 'florets' },
  stem: { one: 'stem', other: 'stems' },
  stems: { one: 'stem', other: 'stems' },
  pod: { one: 'pod', other: 'pods' },
  pods: { one: 'pod', other: 'pods' },
  stick: { one: 'stick', other: 'sticks' },
  sticks: { one: 'stick', other: 'sticks' },
  rasher: { one: 'rasher', other: 'rashers' },
  rashers: { one: 'rasher', other: 'rashers' },
  handful: { one: 'handful', other: 'handfuls' },
  handfuls: { one: 'handful', other: 'handfuls' },
  pinch: { one: 'pinch', other: 'pinches' },
  pinches: { one: 'pinch', other: 'pinches' },
  dash: { one: 'dash', other: 'dashes' },
  dashes: { one: 'dash', other: 'dashes' },
  drop: { one: 'drop', other: 'drops' },
  drops: { one: 'drop', other: 'drops' },
  can: { one: 'can', other: 'cans' },
  cans: { one: 'can', other: 'cans' },
  jar: { one: 'jar', other: 'jars' },
  jars: { one: 'jar', other: 'jars' },
  bottle: { one: 'bottle', other: 'bottles' },
  bottles: { one: 'bottle', other: 'bottles' },
  package: { one: 'package', other: 'packages' },
  packages: { one: 'package', other: 'packages' },
  pkg: { one: 'pkg', other: 'pkgs' },
  pkgs: { one: 'pkg', other: 'pkgs' },
  box: { one: 'box', other: 'boxes' },
  boxes: { one: 'box', other: 'boxes' },
  bag: { one: 'bag', other: 'bags' },
  bags: { one: 'bag', other: 'bags' },
  container: { one: 'container', other: 'containers' },
  containers: { one: 'container', other: 'containers' },
  carton: { one: 'carton', other: 'cartons' },
  cartons: { one: 'carton', other: 'cartons' },
  tin: { one: 'tin', other: 'tins' },
  tins: { one: 'tin', other: 'tins' },
  packet: { one: 'packet', other: 'packets' },
  packets: { one: 'packet', other: 'packets' },
};

/**
 * Look up or derive singular/plural `{ one, other }` forms for a count-unit
 * word (P26).
 */
export function countUnitForms(unitWord: string): CountUnit | undefined {
  const trimmed = unitWord.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const known = COUNT_UNIT_PAIRS[lower];
  if (known !== undefined) return known;
  if (looksPluralLower(lower)) {
    const sing = toSingularLower(lower);
    if (sing !== null) return { one: sing, other: lower };
  } else {
    const plur = toPluralLower(lower);
    if (plur !== null) return { one: lower, other: plur };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 3. Representations
// ---------------------------------------------------------------------------

// The render-time quantity pipeline (Pack Format v0.7). Hints in
// display_equivalents are the stated amount: a reader shows a hint's amount
// (and amount_max) times the serving multiplier, in the hint's unit, and
// converts from it. It never recomputes the shown number from qty_canonical,
// which carries the dimension, what scales, and the amount for a line with no
// hint.

/** A count noun pair as Pack Format v0.7 states it (P26). */
export interface CountUnit {
  one: string;
  other: string;
}

/** A display hint as Pack Format v0.7 states it (P18, P29). */
export interface QuantityHint {
  unit: string;
  amount: number;
  amount_max?: number | undefined;
}

/**
 * The fields of a pack `Ingredient` this reader uses. Structural, so this
 * module needs no import of index.ts; `Ingredient` is assignable to it.
 */
export interface QuantityIngredient {
  qty_canonical: {
    mass_g?: number | undefined;
    volume_ml?: number | undefined;
    count?: number | undefined;
    count_unit?: CountUnit | undefined;
    range_max?: number | undefined;
    to_taste?: true | undefined;
    as_written?: string | undefined;
    unstated?: true | undefined;
  };
  display_equivalents?:
    | { imperial?: QuantityHint | undefined; metric?: QuantityHint | undefined }
    | undefined;
  scaling?: 'linear' | 'fixed' | undefined;
}

export interface Representation {
  kind: 'count' | Dimension;
  unit?: UnitId;
  text: string;
}

export type UnitAnswer = { ok: true; text: string } | { ok: false; alternatives: Representation[] };

export interface ResolvedHint {
  system: UnitSystem;
  unit: UnitId;
  amount: number;
  amount_max?: number | undefined;
}

export interface CanonicalAmountSpan {
  min: number;
  max?: number | undefined;
}

export interface ScaledCanonicalAmounts {
  mass_g?: CanonicalAmountSpan | undefined;
  volume_ml?: CanonicalAmountSpan | undefined;
  count?: CanonicalAmountSpan | undefined;
  count_unit?: CountUnit | undefined;
  to_taste?: true | undefined;
  as_written?: string | undefined;
  unstated?: true | undefined;
}

export function scaleMultiplier(ingredient: QuantityIngredient, scale: number): number {
  // Absent scaling reads as linear at render time — never injected into the data.
  return ingredient.scaling === 'fixed' ? 1 : scale;
}

/**
 * Single-value canonical reader. Refuses a ranged line (`range_max`) so a
 * caller that only understands single numbers never silently renders the low
 * end alone (Pack Format v0.7 P29).
 */
export function scaledCanonical(
  ingredient: QuantityIngredient,
  scale: number,
): { mass_g?: number; volume_ml?: number; count?: number } {
  const qty = ingredient.qty_canonical;
  if (qty.range_max !== undefined) {
    throw new Error('range_max cannot be read as a single canonical amount');
  }
  const multiplier = scaleMultiplier(ingredient, scale);
  const out: { mass_g?: number; volume_ml?: number; count?: number } = {};
  if (qty.mass_g !== undefined) out.mass_g = qty.mass_g * multiplier;
  if (qty.volume_ml !== undefined) out.volume_ml = qty.volume_ml * multiplier;
  if (qty.count !== undefined) out.count = qty.count * multiplier;
  return out;
}

/**
 * Range-aware v0.7 canonical amount reader. Scales the low end and, when
 * `range_max` is present, the high end in the same canonical unit.
 */
export function readScaledCanonical(
  ingredient: QuantityIngredient,
  scale = 1,
): ScaledCanonicalAmounts {
  const multiplier = scaleMultiplier(ingredient, scale);
  const qty = ingredient.qty_canonical;
  const max = qty.range_max !== undefined ? qty.range_max * multiplier : undefined;
  const out: ScaledCanonicalAmounts = {};
  if (qty.mass_g !== undefined) {
    out.mass_g = max !== undefined ? { min: qty.mass_g * multiplier, max } : { min: qty.mass_g * multiplier };
  }
  if (qty.volume_ml !== undefined) {
    out.volume_ml = max !== undefined ? { min: qty.volume_ml * multiplier, max } : { min: qty.volume_ml * multiplier };
  }
  if (qty.count !== undefined) {
    out.count = max !== undefined ? { min: qty.count * multiplier, max } : { min: qty.count * multiplier };
  }
  if (qty.count_unit !== undefined) {
    out.count_unit = qty.count_unit;
  }
  if (qty.to_taste === true) out.to_taste = true;
  if (qty.as_written !== undefined) out.as_written = qty.as_written;
  if (qty.unstated === true) out.unstated = true;
  return out;
}

// Hints carry the stated amount in each system (v0.7). A unit word this table
// can't read contributes nothing (it stays preserved in the pack data
// regardless); test/packs.test.ts holds every hint in packs/ to a unit
// unitFromAlias resolves.
export function readHints(ingredient: QuantityIngredient): ResolvedHint[] {
  const equivalents = ingredient.display_equivalents;
  if (equivalents === undefined) return [];
  return (['imperial', 'metric'] as const).flatMap((system) => {
    const hint = equivalents[system];
    const resolved = hint === undefined ? undefined : unitFromAlias(hint.unit);
    if (hint === undefined || resolved === undefined) return [];
    const entry: ResolvedHint = { system, unit: resolved.id, amount: hint.amount };
    if (hint.amount_max !== undefined) entry.amount_max = hint.amount_max;
    return [entry];
  });
}

export function scaledHints(ingredient: QuantityIngredient, scale: number): ResolvedHint[] {
  const multiplier = scaleMultiplier(ingredient, scale);
  return readHints(ingredient).map((h) =>
    h.amount_max !== undefined
      ? { ...h, amount: h.amount * multiplier, amount_max: h.amount_max * multiplier }
      : { ...h, amount: h.amount * multiplier },
  );
}

function formatSpanInUnit(min: number, max: number | undefined, unit: UnitId): string {
  return max !== undefined ? formatQuantityRange(min, max, unit) : formatQuantity(min, unit);
}

function formatHintRep(hint: ResolvedHint): Representation {
  const dimension = getUnit(hint.unit).dimension;
  return {
    kind: dimension,
    unit: hint.unit,
    text: formatSpanInUnit(hint.amount, hint.amount_max, hint.unit),
  };
}

function defaultMetricUnit(dimension: Dimension, baseMagnitude: number): UnitId {
  if (dimension === 'mass') return baseMagnitude >= 1000 ? 'kg' : 'g';
  return baseMagnitude >= 1000 ? 'l' : 'ml';
}

function defaultImperialUnit(dimension: Dimension, baseMagnitude: number): UnitId {
  if (dimension === 'mass') return baseMagnitude >= getUnit('lb').toBase ? 'lb' : 'oz';
  const cupMin = getUnit('cup').toBase / 4;
  return baseMagnitude >= cupMin
    ? 'cup'
    : baseMagnitude >= getUnit('tbsp').toBase
      ? 'tbsp'
      : 'tsp';
}

function convertHintToSystem(hint: ResolvedHint, targetSystem: UnitSystem): Representation {
  const fromDef = getUnit(hint.unit);
  const dimension = fromDef.dimension;
  const baseMin = hint.amount * fromDef.toBase;
  const baseMax = hint.amount_max !== undefined ? hint.amount_max * fromDef.toBase : undefined;
  const refBase = baseMax ?? baseMin;
  const targetUnit =
    targetSystem === 'metric'
      ? defaultMetricUnit(dimension, refBase)
      : defaultImperialUnit(dimension, refBase);
  const targetDef = getUnit(targetUnit);
  const minVal = baseMin / targetDef.toBase;
  const maxVal = baseMax !== undefined ? baseMax / targetDef.toBase : undefined;
  return {
    kind: dimension,
    unit: targetUnit,
    text: formatSpanInUnit(minVal, maxVal, targetUnit),
  };
}

export function representationsFor(
  ingredient: QuantityIngredient,
  scale: number,
  preference: UnitSystem,
): Representation[] {
  const scaled = readScaledCanonical(ingredient, scale);
  const hints = scaledHints(ingredient, scale);

  const metricForms: Representation[] = [];
  const imperialForms: Representation[] = [];

  if (hints.length > 0) {
    // v0.7: hints are the stated amount. Show each stated hint (× m) in its
    // unit, and when only one system is stated, convert from that stated hint
    // to the other system — never recomputing from qty_canonical.
    const impHint = hints.find((h) => h.system === 'imperial');
    const metHint = hints.find((h) => h.system === 'metric');
    if (impHint !== undefined) imperialForms.push(formatHintRep(impHint));
    if (metHint !== undefined) metricForms.push(formatHintRep(metHint));
    if (impHint !== undefined && metHint === undefined) {
      metricForms.push(convertHintToSystem(impHint, 'metric'));
    } else if (metHint !== undefined && impHint === undefined) {
      imperialForms.push(convertHintToSystem(metHint, 'imperial'));
    }
  } else {
    // Line with no hint: qty_canonical carries the amount.
    if (scaled.mass_g !== undefined) {
      const ref = scaled.mass_g.max ?? scaled.mass_g.min;
      const unit = defaultMetricUnit('mass', ref);
      metricForms.push({
        kind: 'mass',
        unit,
        text: formatSpanInUnit(
          convertValue(scaled.mass_g.min, 'g', unit),
          scaled.mass_g.max !== undefined ? convertValue(scaled.mass_g.max, 'g', unit) : undefined,
          unit,
        ),
      });
    }
    if (scaled.volume_ml !== undefined) {
      const ref = scaled.volume_ml.max ?? scaled.volume_ml.min;
      const unit = defaultMetricUnit('volume', ref);
      metricForms.push({
        kind: 'volume',
        unit,
        text: formatSpanInUnit(
          convertValue(scaled.volume_ml.min, 'ml', unit),
          scaled.volume_ml.max !== undefined
            ? convertValue(scaled.volume_ml.max, 'ml', unit)
            : undefined,
          unit,
        ),
      });
    }
    if (scaled.mass_g !== undefined) {
      const ref = scaled.mass_g.max ?? scaled.mass_g.min;
      const unit = defaultImperialUnit('mass', ref);
      imperialForms.push({
        kind: 'mass',
        unit,
        text: formatSpanInUnit(
          convertValue(scaled.mass_g.min, 'g', unit),
          scaled.mass_g.max !== undefined ? convertValue(scaled.mass_g.max, 'g', unit) : undefined,
          unit,
        ),
      });
    } else if (scaled.volume_ml !== undefined) {
      const ref = scaled.volume_ml.max ?? scaled.volume_ml.min;
      const unit = defaultImperialUnit('volume', ref);
      imperialForms.push({
        kind: 'volume',
        unit,
        text: formatSpanInUnit(
          convertValue(scaled.volume_ml.min, 'ml', unit),
          scaled.volume_ml.max !== undefined
            ? convertValue(scaled.volume_ml.max, 'ml', unit)
            : undefined,
          unit,
        ),
      });
    }
  }

  const representations: Representation[] = [];
  const push = (rep: Representation): void => {
    if (!representations.some((r) => r.text === rep.text)) representations.push(rep);
  };

  if (scaled.count !== undefined) {
    const countText =
      scaled.count.max !== undefined
        ? formatCountRange(scaled.count.min, scaled.count.max)
        : formatCount(scaled.count.min);
    push({ kind: 'count', text: countText });
  }
  const ordered =
    preference === 'metric'
      ? [...metricForms, ...imperialForms]
      : [...imperialForms, ...metricForms];
  for (const rep of ordered) push(rep);
  return representations;
}

/**
 * The scaled quantity in one requested unit — the voice "how much X in Y"
 * path. Under v0.7, converts from the stated hint when hints are present, and
 * falls back to qty_canonical only when the line has no hint.
 * Failure mode 14: no anchor in the requested dimension → alternatives.
 */
export function quantityInUnit(
  ingredient: QuantityIngredient,
  scale: number,
  unit: UnitId,
  preference: UnitSystem,
): UnitAnswer {
  const targetDef = getUnit(unit);
  const dimension = targetDef.dimension;
  const hints = scaledHints(ingredient, scale);

  if (hints.length > 0) {
    const matching = hints.filter((h) => getUnit(h.unit).dimension === dimension);
    const chosen = matching.find((h) => h.system === targetDef.system) ?? matching[0];
    if (chosen === undefined) {
      return { ok: false, alternatives: representationsFor(ingredient, scale, preference) };
    }
    const minVal = convertValue(chosen.amount, chosen.unit, unit);
    const maxVal =
      chosen.amount_max !== undefined ? convertValue(chosen.amount_max, chosen.unit, unit) : undefined;
    return { ok: true, text: formatSpanInUnit(minVal, maxVal, unit) };
  }

  const scaled = readScaledCanonical(ingredient, scale);
  const span = dimension === 'mass' ? scaled.mass_g : scaled.volume_ml;
  if (span === undefined) {
    return { ok: false, alternatives: representationsFor(ingredient, scale, preference) };
  }
  const baseUnit: UnitId = dimension === 'mass' ? 'g' : 'ml';
  const minVal = convertValue(span.min, baseUnit, unit);
  const maxVal = span.max !== undefined ? convertValue(span.max, baseUnit, unit) : undefined;
  return { ok: true, text: formatSpanInUnit(minVal, maxVal, unit) };
}

// ---------------------------------------------------------------------------
// 4. The amount parser
// ---------------------------------------------------------------------------

// Reads a legacy recipe line, the app's {item, amount?, unit?} (slice B4,
// decision 3 and its failure table), into one class. A number the cook will
// see is one the source states: an amount becomes a number only when it is a
// plain number in a unit this table knows, and only when the formatter
// renders it back as that same number (the round-trip guard: "0.33 cup"
// would show as ⅓). Anything else keeps the source's words, as written.
// Never a guess: no ranges, no "about", no unit the table lacks.

/** Unicode vulgar fractions a source may write as an amount. */
const GLYPH_VALUES: Record<string, number> = {
  '½': 1 / 2,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 1 / 4,
  '¾': 3 / 4,
  '⅕': 1 / 5,
  '⅖': 2 / 5,
  '⅗': 3 / 5,
  '⅘': 4 / 5,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅐': 1 / 7,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
  '⅑': 1 / 9,
  '⅒': 1 / 10,
};

const DECIMAL_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const FRACTION_RE = /^(\d+)\/(\d+)$/;
const MIXED_RE = /^(\d+)\s+(\d+)\/(\d+)$/;
const GLYPH_RE = new RegExp(`^(\\d+)?\\s?([${Object.keys(GLYPH_VALUES).join('')}])$`, 'u');

/**
 * A plain positive number as a recipe writes it: "2", "1.5", "1/2",
 * "1 1/2", "½", "1½", "1 ½". Null for anything else: a range ("2-3",
 * "1 to 2"), a word ("about 1", "a pinch of"), zero, or a malformed fraction.
 */
export function parseNumber(text: string): number | null {
  const t = text.trim();
  let value: number | null = null;
  const fraction = FRACTION_RE.exec(t);
  const mixed = MIXED_RE.exec(t);
  const glyph = GLYPH_RE.exec(t);
  if (DECIMAL_RE.test(t)) {
    value = Number(t);
  } else if (fraction) {
    const den = Number(fraction[2]);
    value = den === 0 ? null : Number(fraction[1]) / den;
  } else if (mixed) {
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    value = den === 0 || num >= den ? null : Number(mixed[1]) + num / den;
  } else if (glyph) {
    const part = glyph[2] === undefined ? undefined : GLYPH_VALUES[glyph[2]];
    value = part === undefined ? null : Number(glyph[1] ?? '0') + part;
  }
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

/** A stated number (or range) in a unit the table knows. */
export interface Measure {
  value: number;
  unit: UnitId;
  max?: number | undefined;
}

/** Why a line keeps the source's words instead of a number. */
export type AsWrittenReason =
  | 'amount-not-a-number'
  | 'unit-not-in-table'
  | 'unit-without-amount'
  | 'round-trip'
  | 'compound-unreadable'
  | 'compound-same-system'
  /** A number is left in the name, which wouldn't scale with the amount (`holdsAmount`). */
  | 'number-after-amount'
  /** The unit is a length ("3 inches" of water, "1 inch" of ginger), which no scale multiplies. */
  | 'length-not-an-amount';

export type LineReading =
  /** A number (or range) and a unit: "2 tbsp", "2–3 tbsp". */
  | { kind: 'measured'; amount: Measure }
  /** A unit with a stated equivalent in the other system: "1 cup (225 g)". */
  | { kind: 'compound'; head: Measure; also: Measure }
  /** A count, bare ("2" eggs) or with a count noun ("3 cloves", "2–3 cloves"). */
  | { kind: 'count'; value: number; max?: number | undefined; noun: string | null }
  /** No amount, and the line says "to taste" (P20). */
  | { kind: 'to_taste' }
  /** No amount and no "to taste" (P25). */
  | { kind: 'unstated' }
  /** The source's amount and unit, verbatim (P25). */
  | { kind: 'as_written'; text: string; reason: AsWrittenReason };

/** The reading of a line that states an amount. */
export type AmountReading = Exclude<LineReading, { kind: 'to_taste' } | { kind: 'unstated' }>;

/** A legacy recipe line, as the app stores it (`ChatRecipeIngredient`). */
export interface LegacyLine {
  item: string;
  amount?: string | undefined;
  unit?: string | undefined;
}

// Container nouns (B5c-6, C6 reworked through P26) and unit-slot count nouns
// (B4 decision 5, P26). True count nouns unfold to `qty_canonical.count_unit`
// `{ one, other }`; the size words (`large`, `medium`, `whole`; DECISIONS
// 2026-10-06 call 2) stay in `name`.
const CONTAINER_NOUNS = new Set([
  'bottle',
  'bottles',
  'can',
  'cans',
  'jar',
  'jars',
  'tin',
  'tins',
  'package',
  'packages',
  'box',
  'boxes',
  'carton',
  'cartons',
  'bag',
  'bags',
]);

const SINGULAR_CONTAINER_NOUNS = new Set([
  'bottle',
  'can',
  'jar',
  'tin',
  'package',
  'box',
  'carton',
  'bag',
]);

const OTHER_COUNT_NOUNS = new Set([
  'clove',
  'cloves',
  'head',
  'heads',
  'sprig',
  'sprigs',
  'bunch',
  'bunches',
  'stalk',
  'stalks',
  'ear',
  'ears',
]);

const COUNT_SIZE_WORDS = new Set(['large', 'medium', 'whole']);

const TRUE_COUNT_NOUNS = new Set([...CONTAINER_NOUNS, ...OTHER_COUNT_NOUNS]);

const COUNT_NOUNS = new Set([...TRUE_COUNT_NOUNS, ...COUNT_SIZE_WORDS]);

function isCountNounPhrase(headWord: string): boolean {
  const lower = headWord.trim().toLowerCase();
  if (COUNT_NOUNS.has(lower)) return true;
  const parts = lower.split(/\s+/);
  return (
    parts.length === 2 &&
    COUNT_SIZE_WORDS.has(parts[0] ?? '') &&
    TRUE_COUNT_NOUNS.has(parts[1] ?? '')
  );
}

/**
 * Unfolds a unit-slot count noun into `qty_canonical.count_unit` `{ one, other }`
 * (P26, B5c-6). Returns `null` when `noun` is `null` or is a size word alone
 * (`large`, `medium`, `whole`), which stays in `name`.
 */
export function countUnitFromNoun(noun: string | null): CountUnit | null {
  if (noun === null) return null;
  const parts = UNIT_WITH_PAREN_RE.exec(noun.trim());
  const headWord = parts?.[1]?.trim();
  if (parts === null || headWord === undefined || headWord === '') return null;
  const lowerHead = headWord.toLowerCase();
  if (COUNT_SIZE_WORDS.has(lowerHead)) return null;
  const words = headWord.split(/\s+/);
  let sizePrefix = '';
  let nounWord = headWord;
  const firstWord = words[0];
  const secondWord = words[1];
  if (words.length === 2 && firstWord !== undefined && secondWord !== undefined && COUNT_SIZE_WORDS.has(firstWord.toLowerCase())) {
    sizePrefix = `${firstWord} `;
    nounWord = secondWord;
  }
  const forms = countUnitForms(nounWord);
  if (forms === undefined) return null;
  const paren = parts[2] === undefined ? '' : ` (${parts[2].trim()})`;
  return {
    one: `${sizePrefix}${forms.one}${paren}`,
    other: `${sizePrefix}${forms.other}${paren}`,
  };
}

// Words the extraction writes in the unit field where the Doc has none: each
// of the export's 8 is a Doc bare count ("1 unit | red onion" is the Doc's "1
// red onion"; B4 step 0, spelling call 3). Alone, the line is a bare count;
// with a parenthetical, it keeps its words (as written).
const COUNT_PLACEHOLDERS = new Set(['unit', 'units', 'item', 'items']);

// A length in the unit slot is how far, not how much (B4 step 0, call 10):
// "3 inches" of water to cover a pot stays 3 inches at any scale, so a scaled
// 6 would be a wrong number. "1 inch" of ginger would scale, but the reader
// can't tell the two apart, so every length keeps the source's words.
const LENGTH_UNIT_RE = /^(?:inch(?:es)?|in\.?|["”″]|cm|mm|centimet(?:er|re)s?|millimet(?:er|re)s?)$/i;

const UNIT_WITH_PAREN_RE = /^([^()]+?)\s*(?:\(([^()]*)\))?$/;
// The number and unit of a stated equivalent, spaced or not ("225 g", "113g";
// B4 step 0, call 7).
const PAREN_MEASURE_RE = /^(.+?)\s*([A-Za-z]+)$/;
/** A slash between equivalents ("1 stick / 113g"), not a fraction's ("2 1/2 lb"). */
const EQUIVALENTS_SPLIT_RE = /(?<!\d)\/|\/(?!\d)/;
const TO_TASTE_RE = /\bto taste\b/i;

const GLYPH_CLASS = `[${Object.keys(GLYPH_VALUES).join('')}]`;
/** One number as `parseNumber` reads it, longest form first. */
const NUMBER_SRC = `\\d+\\s+\\d+\\/\\d+|\\d+\\s?${GLYPH_CLASS}|\\d+\\/\\d+|\\d+(?:\\.\\d+)?|\\.\\d+|${GLYPH_CLASS}`;
/** A range: two numbers joined by a dash, "to" or "or". */
const RANGE_SRC = `(?:${NUMBER_SRC})(?:\\s*[-–—]\\s*|\\s+(?:to|or)\\s+)(?:${NUMBER_SRC})`;
const RANGE_MATCH_RE = new RegExp(
  `^(${NUMBER_SRC})(?:\\s*[-–—]\\s*|\\s+(?:to|or)\\s+)(${NUMBER_SRC})$`,
  'iu',
);
const AMOUNT_WITH_SIZE_RE = new RegExp(
  `^(${RANGE_SRC}|${NUMBER_SRC})\\s*\\(\\s*((?:${NUMBER_SRC})[\\s-]*([A-Za-z]+)\\.?)\\s*\\)$`,
  'iu',
);
const SIZE_AMOUNT_RE = new RegExp(`^(${NUMBER_SRC})[\\s-]*([A-Za-z]+)\\.?$`, 'iu');

function parseRange(text: string): { min: number; max: number } | null {
  const m = RANGE_MATCH_RE.exec(text.trim());
  const lowText = m?.[1];
  const highText = m?.[2];
  if (lowText === undefined || highText === undefined) return null;
  const min = parseNumber(lowText);
  const max = parseNumber(highText);
  if (min === null || max === null || max <= min + EPSILON) return null;
  return { min, max };
}

function roundTripsValue(value: number, unit: UnitId): boolean {
  const shown = parseNumber(formatUnitValue(value, unit));
  return shown !== null && Math.abs(shown - value) < EPSILON;
}

/** The formatter renders `measure` (and `measure.max` when present) back as the stated number. */
function roundTrips(measure: Measure): boolean {
  if (!roundTripsValue(measure.value, measure.unit)) return false;
  if (measure.max !== undefined && !roundTripsValue(measure.max, measure.unit)) return false;
  return true;
}

/**
 * Reads a stated amount and its unit field. `unit` may carry a parenthetical:
 * a stated equivalent ("g (10 oz)"; "cup (1 stick / 113g)", parts split on a
 * slash) or, after a count noun, a size kept verbatim ("can (14 oz)").
 */
export function parseAmount(amount: string, unit: string | undefined): AmountReading {
  const amountText = amount.trim();
  const unitText = unit === undefined ? '' : unit.trim();
  const asWritten = (reason: AsWrittenReason): AmountReading => ({
    kind: 'as_written',
    text: unitText === '' ? amountText : `${amountText} ${unitText}`,
    reason,
  });

  // Container size inside the amount slot: "2 (14-ounce)" + "cans" → count 2, noun "cans (14-ounce)".
  const amountWithSize = AMOUNT_WITH_SIZE_RE.exec(amountText);
  const awsNum = amountWithSize?.[1];
  const awsSize = amountWithSize?.[2];
  const awsUnit = amountWithSize?.[3];
  if (
    awsNum !== undefined &&
    awsSize !== undefined &&
    awsUnit !== undefined &&
    unitFromAlias(awsUnit) !== undefined &&
    CONTAINER_NOUNS.has(unitText.toLowerCase())
  ) {
    const numPart = awsNum;
    const sizePart = awsSize.trim();
    const singleCount = parseNumber(numPart);
    const rangeCount = singleCount === null ? parseRange(numPart) : null;
    if (singleCount !== null || rangeCount !== null) {
      const value = singleCount ?? rangeCount?.min ?? 1;
      const max = rangeCount?.max;
      return {
        kind: 'count',
        value,
        ...(max !== undefined ? { max } : {}),
        noun: `${unitText} (${sizePart})`,
      };
    }
  }

  // Size before a singular container noun: "12 oz" + "bottle" → count 1, noun "bottle (12 oz)".
  const sizeAmount = SIZE_AMOUNT_RE.exec(amountText);
  const saNum = sizeAmount?.[1];
  const saUnit = sizeAmount?.[2];
  if (
    saNum !== undefined &&
    saUnit !== undefined &&
    parseNumber(saNum) !== null &&
    unitFromAlias(saUnit) !== undefined &&
    SINGULAR_CONTAINER_NOUNS.has(unitText.toLowerCase())
  ) {
    return {
      kind: 'count',
      value: 1,
      noun: `${unitText} (${amountText})`,
    };
  }

  const single = parseNumber(amountText);
  const range = single === null ? parseRange(amountText) : null;
  if (single === null && range === null) return asWritten('amount-not-a-number');
  const value = single ?? range?.min ?? 1;
  const max = range?.max;
  if (unitText === '' || COUNT_PLACEHOLDERS.has(unitText.toLowerCase())) {
    return { kind: 'count', value, ...(max !== undefined ? { max } : {}), noun: null };
  }

  const parts = UNIT_WITH_PAREN_RE.exec(unitText);
  const headWord = parts?.[1];
  if (parts === null || headWord === undefined) return asWritten('unit-not-in-table');
  if (LENGTH_UNIT_RE.test(headWord)) return asWritten('length-not-an-amount');
  if (isCountNounPhrase(headWord)) {
    return { kind: 'count', value, ...(max !== undefined ? { max } : {}), noun: unitText };
  }

  const headUnit = unitFromAlias(headWord);
  if (headUnit === undefined) return asWritten('unit-not-in-table');
  const head: Measure = { value, unit: headUnit.id, ...(max !== undefined ? { max } : {}) };

  const paren = parts[2];
  if (paren === undefined) {
    return roundTrips(head) ? { kind: 'measured', amount: head } : asWritten('round-trip');
  }

  const equivalents = paren.split(EQUIVALENTS_SPLIT_RE).map((part) => statedEquivalent(part, head));
  if (equivalents.some((equivalent) => equivalent === null)) return asWritten('compound-unreadable');
  if (max !== undefined) return asWritten('compound-unreadable');
  const measures = equivalents.filter((equivalent): equivalent is Measure => equivalent !== 'sticks');
  const also = measures[0];
  if (also === undefined) {
    return roundTrips(head) ? { kind: 'measured', amount: head } : asWritten('round-trip');
  }
  if (measures.length > 1) return asWritten('compound-unreadable');
  if (getUnit(also.unit).system === headUnit.system) return asWritten('compound-same-system');
  return roundTrips(head) && roundTrips(also)
    ? { kind: 'compound', head, also }
    : asWritten('round-trip');
}

// A stick of butter is ½ cup, 4 oz (B4 step 0, call 8). It is no table unit,
// so the format has no hint to hold it: a stated stick count that agrees with
// the head restates the amount and is dropped. One that disagrees is no
// equivalent of it.
const STICK_RE = /^(.+?)\s*sticks?$/i;
const STICK_BASE: Record<Dimension, number> = {
  volume: UNITS.cup.toBase / 2,
  mass: UNITS.oz.toBase * 4,
};
/** How far apart two statements of one amount may be: rounding only. */
const SAME_AMOUNT = 0.01;

/**
 * One part of a parenthetical after the unit, read as an equivalent of
 * `head`: a measure in the table, "sticks" for a stick count that agrees with
 * the head, or null for anything else ("about 2 lemons").
 */
function statedEquivalent(part: string, head: Measure): Measure | 'sticks' | null {
  if (head.max !== undefined) return null;
  const text = part.trim();
  const sticks = STICK_RE.exec(text);
  if (sticks !== null) {
    const count = sticks[1] === undefined ? null : parseNumber(sticks[1]);
    const unit = getUnit(head.unit);
    const headBase = head.value * unit.toBase;
    const stickBase = count === null ? 0 : count * STICK_BASE[unit.dimension];
    return count !== null && Math.abs(stickBase - headBase) <= SAME_AMOUNT * headBase ? 'sticks' : null;
  }
  const stated = PAREN_MEASURE_RE.exec(text);
  const value = stated?.[1] === undefined ? null : parseNumber(stated[1]);
  const unit = stated?.[2] === undefined ? undefined : unitFromAlias(stated[2]);
  return value === null || unit === undefined ? null : { value, unit: unit.id };
}

/** An amount (and unit) that says only "to taste". */
const TO_TASTE_ONLY_RE = /^to taste$/i;

/**
 * Reads one legacy line's stated fields into its class (B4 decision 3 and
 * failure table). The fields alone: a line whose amount is written in its
 * item reads through `readLeadingAmount`, which the converter calls.
 */
export function classifyLine(line: LegacyLine): LineReading {
  const amount = line.amount?.trim() ?? '';
  const unit = line.unit?.trim() ?? '';
  if (TO_TASTE_ONLY_RE.test(`${amount} ${unit}`.trim())) return { kind: 'to_taste' };
  if (amount !== '') return parseAmount(amount, unit);
  if (unit !== '') return { kind: 'as_written', text: unit, reason: 'unit-without-amount' };
  return TO_TASTE_RE.test(line.item) ? { kind: 'to_taste' } : { kind: 'unstated' };
}

// ---------------------------------------------------------------------------
// 5. An amount written inside the line
// ---------------------------------------------------------------------------

// A line can carry its amount in its text ("1 1/2 cups flour"): a JSON-LD
// import whose split failed stores the whole line as the item, and so does a
// model's string entry (B4 fix round 1). The amount at the start of the text
// reads through the same rules as stated fields (`parseAmount`), so a number
// the cook sees is still one the source states; what follows is the name.

/** The amount at the start: a range or a number, then a space, a letter or "(". */
const LEADING_AMOUNT_RE = new RegExp(`^(${RANGE_SRC}|${NUMBER_SRC})(?=[\\s(A-Za-z])`, 'iu');
/** A unit word after the amount (a trailing period dropped), and any parenthetical. */
const LEADING_UNIT_RE = /^([A-Za-z]+)\.?(?:\s*(\([^()]*\)))?(?=\s|$)/;
/** A size word + true count noun after the amount ("large bag"), and any parenthetical. */
const LEADING_SIZED_NOUN_RE = /^([A-Za-z]+)\s+([A-Za-z]+)\.?(?:\s*(\([^()]*\)))?(?=\s|$)/;
/** A size + singular container noun at the start of a line ("12 oz bottle beer"). */
const LEADING_SIZE_CONTAINER_RE = new RegExp(
  `^((?:${NUMBER_SRC})[\\s-]*([A-Za-z]+)\\.?)\\s+([A-Za-z]+)(?=\\s|$)`,
  'iu',
);

/** An amount read from the start of a line, and the words after it. */
export interface LeadingAmount {
  /** How the amount reads: `parseAmount(amount, unit)`. */
  reading: AmountReading;
  /** The amount as the line writes it: "1 1/2", "2-3". */
  amount: string;
  /** A unit or count noun the reader knows, with any parenthetical; "" when none. */
  unit: string;
  /**
   * The words after the amount: the ingredient's name. Empty when the line is
   * only an amount and its unit ("3 cloves", "2 g"; B4 fix round 2).
   */
  rest: string;
}

function isUnitWord(word: string): boolean {
  const lower = word.toLowerCase();
  return (
    unitFromAlias(word) !== undefined ||
    isCountNounPhrase(lower) ||
    COUNT_PLACEHOLDERS.has(lower) ||
    LENGTH_UNIT_RE.test(word)
  );
}

/**
 * The unit after the amount, and where the name starts. A parenthetical after
 * the unit word goes with it ("1 cup (225 g)", "1 can (14 oz)"), unless the
 * pair reads as written only because the reader can't read the parenthetical
 * while the word alone reads as a measure: then the parenthetical is the
 * name's ("1 cup (about 2 lemons) juice" is 1 cup of "(about 2 lemons) juice"), so the
 * line keeps its number (B4 fix round 2). A parenthetical that reads but
 * restates the same system ("1 cup (8 oz)") stays with the unit.
 */
function leadingUnit(
  amount: string,
  word: string,
  paren: string | undefined,
): { unit: string; parenToName: string | undefined } {
  if (paren === undefined) return { unit: word, parenToName: undefined };
  const withParen = `${word} ${paren}`;
  const together = parseAmount(amount, withParen);
  const unreadable = together.kind === 'as_written' && together.reason === 'compound-unreadable';
  if (unreadable && parseAmount(amount, word).kind === 'measured') {
    return { unit: word, parenToName: paren };
  }
  return { unit: withParen, parenToName: undefined };
}

/**
 * The amount at the start of a line, read as a stated amount and unit would
 * be. A word after the number is the unit only when the table or the count
 * nouns know it ("2 large eggs" is a count of "large eggs"). Null when the
 * line doesn't start with a number, or nothing but a number follows it: a
 * lone zero, "00 flour", "5-spice powder" and "2% milk" have none. A line
 * that is only an amount and its unit reads with an empty name.
 */
export function readLeadingAmount(text: string): LeadingAmount | null {
  const line = text.trim();

  const sizeContainer = LEADING_SIZE_CONTAINER_RE.exec(line);
  const scFull = sizeContainer?.[0];
  const scAmount = sizeContainer?.[1];
  const scUnit = sizeContainer?.[2];
  const scContainer = sizeContainer?.[3];
  if (
    scFull !== undefined &&
    scAmount !== undefined &&
    scUnit !== undefined &&
    scContainer !== undefined &&
    unitFromAlias(scUnit) !== undefined &&
    SINGULAR_CONTAINER_NOUNS.has(scContainer.toLowerCase())
  ) {
    const amount = scAmount.trim();
    const unit = scContainer;
    const rest = line.slice(scFull.length).trim();
    const reading = parseAmount(amount, unit);
    if (reading.kind === 'count') {
      return { reading, amount, unit, rest };
    }
  }

  const head = LEADING_AMOUNT_RE.exec(line);
  const amount = head?.[1];
  if (amount === undefined) return null;
  const after = line.slice(amount.length);
  const spaced = /^\s/.test(after);
  const words = after.trimStart();

  const sizedMatch = LEADING_SIZED_NOUN_RE.exec(words);
  const smSize = sizedMatch?.[1];
  const smNoun = sizedMatch?.[2];
  const sizedWord =
    smSize !== undefined &&
    smNoun !== undefined &&
    COUNT_SIZE_WORDS.has(smSize.toLowerCase()) &&
    TRUE_COUNT_NOUNS.has(smNoun.toLowerCase())
      ? `${smSize} ${smNoun}`
      : undefined;

  const unitMatch = sizedWord !== undefined ? sizedMatch : LEADING_UNIT_RE.exec(words);
  const word = sizedWord ?? unitMatch?.[1];
  const paren = sizedWord !== undefined ? sizedMatch?.[3] : unitMatch?.[2];
  let unit = '';
  let rest: string;
  if (unitMatch !== null && word !== undefined && isUnitWord(word)) {
    const read = leadingUnit(amount, word, paren);
    unit = read.unit;
    const tail = words.slice(unitMatch[0].length).trim();
    rest = read.parenToName === undefined ? tail : `${read.parenToName} ${tail}`.trim();
  } else {
    if (!spaced) return null;
    rest = words.trim();
  }
  if (rest === '' && unit === '') return null;

  const reading = parseAmount(amount, unit);
  // A single number that isn't one ("0", "00") is no amount; a range stays
  // the source's words.
  const isRange = new RegExp(`^(?:${RANGE_SRC})$`, 'iu').test(amount);
  if (reading.kind === 'as_written' && reading.reason === 'amount-not-a-number' && !isRange) {
    return null;
  }
  return { reading, amount, unit, rest };
}

// ---------------------------------------------------------------------------
// 6. A second quantity left in the name
// ---------------------------------------------------------------------------

// A line is a scalable amount only if everything after its amount scales with
// it (B4 step 0, call 7). A second quantity in the name stands unscaled beside
// the scaled one: "1 tbsp" named "+ 1 tsp cumin" shows "2 tbsp + 1 tsp cumin"
// at 2×, so the converter keeps the line as written. A quantity is a number
// with a measuring unit ("1 tsp", "113g", "½ stick") or a count of a second
// item ("1 bay leaf"). A number that measures something else is no amount of
// an ingredient and stays in the name (call 8): a duration ("soaked 8 to 18
// hr"), a dimension ("2-inch pieces", "2x2 inches", 1/4"), a temperature, a
// percentage, a number joined to the word it names ("5-spice", "3rds"), a
// ratio ("80/20": a slash fraction of at least 1, which no ingredient fraction
// is; "1/2", a range like "(2-3)" and one added on, "plus 3/2", still count),
// a per-item size with "each" ("(6 oz each)"), and a size before a count
// noun ("(14 oz) can tomatoes" is each can's size). Any other number reads as
// a count: the reader can't tell "five spice" from "five lemons", and never
// guesses.

const UNITS_WORD_SRC = 'one|two|three|four|five|six|seven|eight|nine';
const TENS_WORD_SRC = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
/** A number in words: one to ninety-nine ("twenty-five" is one), a dozen, "half a". */
const WORD_NUMBER_SRC =
  `\\b(?:(?:${TENS_WORD_SRC})(?:[\\s-]+(?:${UNITS_WORD_SRC})\\b)?|${UNITS_WORD_SRC}|ten|eleven|twelve|` +
  'thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|dozen)\\b|\\bhalf\\s+(?:a|an|of)\\b';
/**
 * "a", "an", "a couple (of)" or "a few", any fraction word, then a word that
 * may be a unit: "a tablespoon", "a half-cup", "a third of a cup", "a couple
 * tablespoons" (call 12). The word must end there ("a l’orange" is no litre).
 */
const ARTICLE_MEASURE_RE =
  /\b(?:an?\s+(?:couple|few)(?:\s+of)?|an?)\s+(?:(?:half|quarter|third)s?(?:\s*-\s*|\s+)(?:of\s+an?\s+)?)?(\p{L}+)(?![\p{L}'’-])/giu;
/** A number in the name, not part of a word ("V8") or of a longer number. */
const NUMBER_IN_NAME_RE = new RegExp(
  `(?<![\\p{L}\\d.,/])(?:${RANGE_SRC}|${NUMBER_SRC})|${WORD_NUMBER_SRC}`,
  'giu',
);
/** The word right after a number, past a space or hyphen ("1 tsp", "113g", "2-inch"). */
const WORD_AFTER_RE = /^\s*-?\s*(\p{L}+)/u;
/** A measure word followed directly by "each" ("6 oz each", "150g each"; B5c-6). */
const MEASURE_EACH_AFTER_RE = /^\s*-?\s*(\p{L}+)\.?\s+each\b/iu;
/** A length unit after a number ("2-inch", "1 in.", "5 mm", 1/4"). */
const LENGTH_AFTER: readonly RegExp[] = [
  /^\s*-?\s*(?:inch(?:es)?\b|in\b\.?|cm\b|mm\b|centimet(?:er|re)s?\b|millimet(?:er|re)s?\b)/i,
  /^["”″]/,
];
/** What follows a number that measures something other than an amount. */
const NOT_A_QUANTITY_AFTER: readonly RegExp[] = [
  // A duration.
  /^\s*-?\s*(?:s|sec(?:ond)?s?|min(?:ute)?s?|h(?:ou)?rs?|days?|weeks?|months?|years?)\b/i,
  // A dimension.
  ...LENGTH_AFTER,
  /^\s*[x×]\s*\d/i,
  // A temperature; a capital F alone is Fahrenheit ("110F").
  /^\s*(?:[°º˚℉℃]|[Dd]eg(?:ree)?s?\b|F\b)/,
  // A percentage.
  /^\s*(?:%|per\s?cent\b)/i,
  // An ordinal ("into 3rds").
  /^(?:st|nd|rd|th)s?\b/i,
  // A word it names, hyphened ("5-spice", "one-pot"), but not a fraction
  // ("two-thirds cup") nor "and" ("one-and-a-half cups").
  /^-(?!(?:halves|half|thirds?|quarters?|fourths?|eighths?|and)\b)\p{L}/iu,
];
const SINGLE_NUMBER_RE = new RegExp(`^(?:${NUMBER_SRC})$`, 'iu');
const RATIO_RE = /^(\d+)\/(\d+)$/;
/** A word hyphened to the number, and the word after it ("2-ish tbsp"). */
const HYPHENED_RE = /^-(\p{L}+)(?:\s+(\p{L}+))?/u;
/** A word that only qualifies the number: "2-ish", "2-heaping tbsp". */
const QUALIFIER_RE = /^(?:ish|heaping|heaped|level|scant|generous)$/i;

/** A unit the table knows, or a stick. */
function isMeasureWord(word: string): boolean {
  return unitFromAlias(word) !== undefined || /^sticks?$/i.test(word);
}

/** "plus" or "+" right before a number: what follows is added on. */
const ADDED_ON_RE = /(?:\bplus|\+)\s*$/i;

/**
 * A number in the name, and the text after it, is a quantity of something.
 * `opensBracket`: the number is the first thing in a bracket. `addedOn`:
 * "plus" or "+" stands right before it.
 */
function isQuantity(number: string, after: string, opensBracket: boolean, addedOn: boolean): boolean {
  // A single number that isn't one ("00 flour") is no amount.
  if (SINGLE_NUMBER_RE.test(number) && parseNumber(number) === null) return false;
  // A per-item size ("4 chicken breasts (6 oz each)") is the size of one, not a second quantity (B5c-6).
  const eachMatch = MEASURE_EACH_AFTER_RE.exec(after);
  if (!addedOn && eachMatch?.[1] !== undefined && isMeasureWord(eachMatch[1])) return false;
  const word = WORD_AFTER_RE.exec(after)?.[1];
  if (word !== undefined && isMeasureWord(word)) return true;
  // A hyphened word is exempt only if it names something: not a qualifier
  // ("2-ish"), and not one a unit follows ("2-heaping tbsp"; call 12).
  const hyphened = HYPHENED_RE.exec(after);
  if (hyphened !== null) {
    const next = hyphened[2];
    if (QUALIFIER_RE.test(hyphened[1] ?? '') || (next !== undefined && isMeasureWord(next))) return true;
  }
  // A length that opens a bracket is the ingredient again, by length: an
  // equivalent ("ginger (1.5 inches ginger)", "(2-inch piece)"; call 10).
  if (opensBracket && LENGTH_AFTER.some((pattern) => pattern.test(after))) return true;
  // A ratio ("80/20", "50/50"): a slash fraction that is no part of one.
  // Nothing adds a ratio, so one added on is an amount ("plus 3/2"; call 12).
  const ratio = RATIO_RE.exec(number);
  if (ratio !== null && !addedOn && Number(ratio[1]) >= Number(ratio[2])) return false;
  return !NOT_A_QUANTITY_AFTER.some((pattern) => pattern.test(after));
}

const SIZE_BEFORE_NOUN_RE = new RegExp(
  `^(?:\\(\\s*(${NUMBER_SRC})[\\s-]*([A-Za-z]+)\\.?\\s*\\)|(${NUMBER_SRC})[\\s-]*([A-Za-z]+)\\.?)\\s+([A-Za-z]+)\\b`,
  'u',
);

/** The name with a leading size-before-count-noun ("(14 oz) can") taken off. */
function withoutUnitSize(name: string): string {
  const size = SIZE_BEFORE_NOUN_RE.exec(name);
  if (size === null) return name;
  const value = size[1] ?? size[3] ?? '';
  const unit = size[2] ?? size[4] ?? '';
  const noun = size[5] ?? '';
  const isSize =
    parseNumber(value) !== null && unitFromAlias(unit) !== undefined && COUNT_NOUNS.has(noun.toLowerCase());
  return isSize ? name.slice(size[0].length) : name;
}

/**
 * The name holds a second quantity: a number, in figures or words ("one",
 * "twenty-five", "dozen", "half a"), that is a measure or a count, past any
 * size before a count noun at its start; or an article before a unit ("a
 * tablespoon", "a couple tablespoons").
 */
export function holdsAmount(name: string): boolean {
  const rest = withoutUnitSize(name.trim());
  for (const match of rest.matchAll(ARTICLE_MEASURE_RE)) {
    if (isMeasureWord(match[1] ?? '')) return true;
  }
  for (const match of rest.matchAll(NUMBER_IN_NAME_RE)) {
    const before = rest.slice(0, match.index);
    const after = rest.slice(match.index + match[0].length);
    if (isQuantity(match[0], after, /\(\s*$/.test(before), ADDED_ON_RE.test(before))) return true;
  }
  return false;
}

const RATE_SHARE_WORDS = new Set([
  'person',
  'people',
  'serving',
  'servings',
  'guest',
  'guests',
  'head',
]);

const EXTRA_RATE_UNIT_WORDS = new Set([
  'quart',
  'quarts',
  'qt',
  'pint',
  'pints',
  'pt',
  'gallon',
  'gallons',
  'gal',
]);

const PER_WORD_RE = /\bper\s+([A-Za-z]+)\b/gi;

/**
 * True when `text` contains a rate phrase: `"per"` followed directly by a unit
 * word or a share word (`person`, `serving`, `guest`, `head`), with no number
 * between (B5c-6, C5).
 */
export function isRateText(text: string): boolean {
  for (const match of text.matchAll(PER_WORD_RE)) {
    const word = (match[1] ?? '').toLowerCase();
    if (
      unitFromAlias(word) !== undefined ||
      EXTRA_RATE_UNIT_WORDS.has(word) ||
      RATE_SHARE_WORDS.has(word)
    ) {
      return true;
    }
  }
  return false;
}
