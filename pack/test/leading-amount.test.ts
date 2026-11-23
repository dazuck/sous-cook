import { describe, expect, it } from 'vitest';
import { classifyLine, holdsAmount, parseAmount, readLeadingAmount } from '../src/quantity.ts';
import type { LineReading } from '../src/quantity.ts';

// The leading-amount reader (B4 fix round 1, HIGH 1): a line whose amount is
// written inside its text ("1 1/2 cups flour", stored as {item} alone by a
// JSON-LD import whose split failed, or by a model's string entry) reads its
// amount from the start of the text, through the same rules as a stated
// amount and unit. What follows the amount is the name.

describe('readLeadingAmount: an amount at the start of the line', () => {
  it.each<[string, string, string, string, LineReading]>([
    ['1 1/2 cups flour', '1 1/2', 'cups', 'flour', { kind: 'measured', amount: { value: 1.5, unit: 'cup' } }],
    ['½ cup sugar', '½', 'cup', 'sugar', { kind: 'measured', amount: { value: 0.5, unit: 'cup' } }],
    ['1½ cups milk', '1½', 'cups', 'milk', { kind: 'measured', amount: { value: 1.5, unit: 'cup' } }],
    ['1 ½ cups milk', '1 ½', 'cups', 'milk', { kind: 'measured', amount: { value: 1.5, unit: 'cup' } }],
    ['100g flour', '100', 'g', 'flour', { kind: 'measured', amount: { value: 100, unit: 'g' } }],
    ['2 Tbsp. olive oil', '2', 'Tbsp', 'olive oil', { kind: 'measured', amount: { value: 2, unit: 'tbsp' } }],
    ['.5 tsp salt', '.5', 'tsp', 'salt', { kind: 'measured', amount: { value: 0.5, unit: 'tsp' } }],
    [
      '1 cup (225 g) butter, softened',
      '1',
      'cup (225 g)',
      'butter, softened',
      { kind: 'compound', head: { value: 1, unit: 'cup' }, also: { value: 225, unit: 'g' } },
    ],
    ['2 eggs', '2', '', 'eggs', { kind: 'count', value: 2, noun: null }],
    ['10 eggs', '10', '', 'eggs', { kind: 'count', value: 10, noun: null }],
    // A size word is a count noun (B4 step 0, spelling call 2); the converter
    // folds it back into the name, so the cook still reads "large eggs".
    ['2 large eggs', '2', 'large', 'eggs', { kind: 'count', value: 2, noun: 'large' }],
    ['1 bunch cilantro', '1', 'bunch', 'cilantro', { kind: 'count', value: 1, noun: 'bunch' }],
    ['1 unit red onion', '1', 'unit', 'red onion', { kind: 'count', value: 1, noun: null }],
    ['1.5 tbs gram dhal', '1.5', 'tbs', 'gram dhal', { kind: 'measured', amount: { value: 1.5, unit: 'tbsp' } }],
    ['1/2 lemon, juiced', '1/2', '', 'lemon, juiced', { kind: 'count', value: 0.5, noun: null }],
    ['1 (14 oz) can tomatoes', '1', '', '(14 oz) can tomatoes', { kind: 'count', value: 1, noun: null }],
    ['3 cloves garlic, minced', '3', 'cloves', 'garlic, minced', { kind: 'count', value: 3, noun: 'cloves' }],
    [
      '1 can (14 oz) crushed tomatoes',
      '1',
      'can (14 oz)',
      'crushed tomatoes',
      { kind: 'count', value: 1, noun: 'can (14 oz)' },
    ],
    ['  2 eggs  ', '2', '', 'eggs', { kind: 'count', value: 2, noun: null }],
  ])('%j', (text, amount, unit, rest, reading) => {
    expect(readLeadingAmount(text)).toEqual({ reading, amount, unit, rest });
  });

  it.each<[string, string, string, string, LineReading]>([
    ['2-3 tbsp oil', '2-3', 'tbsp', 'oil', { kind: 'measured', amount: { value: 2, max: 3, unit: 'tbsp' } }],
    ['2 - 3 cloves garlic', '2 - 3', 'cloves', 'garlic', { kind: 'count', value: 2, max: 3, noun: 'cloves' }],
    ['1 to 2 cups stock', '1 to 2', 'cups', 'stock', { kind: 'measured', amount: { value: 1, max: 2, unit: 'cup' } }],
    ['2 or 3 eggs', '2 or 3', '', 'eggs', { kind: 'count', value: 2, max: 3, noun: null }],
    ['12 oz bottle beer', '12 oz', 'bottle', 'beer', { kind: 'count', value: 1, noun: 'bottle (12 oz)' }],
    ['1 large bag frozen dumplings', '1', 'large bag', 'frozen dumplings', { kind: 'count', value: 1, noun: 'large bag' }],
  ])('a range or sized container %j reads as measured or count (P26, P29)', (text, amount, unit, rest, reading) => {
    expect(readLeadingAmount(text)).toEqual({
      reading,
      amount,
      unit,
      rest,
    });
  });

  it.each<[string, string, string, string, string, string]>([
    ['3-2 tbsp oil', '3-2', 'tbsp', 'oil', '3-2 tbsp', 'amount-not-a-number'],
    ['1.33-2 cups flour', '1.33-2', 'cups', 'flour', '1.33-2 cups', 'round-trip'],
  ])('an invalid or non-round-tripping range %j stays as written', (text, amount, unit, rest, written, reason) => {
    expect(readLeadingAmount(text)).toEqual({
      reading: { kind: 'as_written', text: written, reason: reason as 'amount-not-a-number' | 'round-trip' },
      amount,
      unit,
      rest,
    });
  });

  // B4 fix round 2 (MED): a parenthetical the reader can't read as an
  // equivalent ("(about 1 lb)") stays in the name when the unit before it
  // reads as a measure, so the line keeps its number and its conversions, as
  // the old split did. One it can read stays with the unit; since call 8 that
  // includes a stick of butter, ½ cup.
  it.each<[string, string, string, string, LineReading]>([
    [
      '1/2 cup (1 stick) butter',
      '1/2',
      'cup (1 stick)',
      'butter',
      { kind: 'measured', amount: { value: 0.5, unit: 'cup' } },
    ],
    [
      '3 cups (about 1 lb) potatoes',
      '3',
      'cups',
      '(about 1 lb) potatoes',
      { kind: 'measured', amount: { value: 3, unit: 'cup' } },
    ],
    [
      '1 cup (a splash) cream',
      '1',
      'cup',
      '(a splash) cream',
      { kind: 'measured', amount: { value: 1, unit: 'cup' } },
    ],
    [
      '1 cup (8 oz) cream cheese',
      '1',
      'cup (8 oz)',
      'cream cheese',
      { kind: 'as_written', text: '1 cup (8 oz)', reason: 'compound-same-system' },
    ],
    [
      '2 (about 1 lb) cans tomatoes',
      '2',
      '',
      '(about 1 lb) cans tomatoes',
      { kind: 'count', value: 2, noun: null },
    ],
    [
      '1 can (about 14 oz) tomatoes',
      '1',
      'can (about 14 oz)',
      'tomatoes',
      { kind: 'count', value: 1, noun: 'can (about 14 oz)' },
    ],
    [
      '2 tbsp (a glug) oil',
      '2',
      'tbsp',
      '(a glug) oil',
      { kind: 'measured', amount: { value: 2, unit: 'tbsp' } },
    ],
    [
      '1.33 cups (a lot) flour',
      '1.33',
      'cups (a lot)',
      'flour',
      { kind: 'as_written', text: '1.33 cups (a lot)', reason: 'compound-unreadable' },
    ],
  ])('a parenthetical after the unit: %j', (text, amount, unit, rest, reading) => {
    expect(readLeadingAmount(text)).toEqual({ reading, amount, unit, rest });
  });

  // B4 fix round 2 (LOW): a line that is only an amount reads as that amount,
  // with nothing after it.
  it.each<[string, string, string, LineReading]>([
    ['3 cloves', '3', 'cloves', { kind: 'count', value: 3, noun: 'cloves' }],
    ['2 g', '2', 'g', { kind: 'measured', amount: { value: 2, unit: 'g' } }],
    ['2 cups', '2', 'cups', { kind: 'measured', amount: { value: 2, unit: 'cup' } }],
    ['1 Tbsp.', '1', 'Tbsp', { kind: 'measured', amount: { value: 1, unit: 'tbsp' } }],
    [
      '1 cup (225 g)',
      '1',
      'cup (225 g)',
      { kind: 'compound', head: { value: 1, unit: 'cup' }, also: { value: 225, unit: 'g' } },
    ],
  ])('%j is only an amount', (text, amount, unit, reading) => {
    expect(readLeadingAmount(text)).toEqual({ reading, amount, unit, rest: '' });
  });

  // A length is no amount (call 10): the line keeps the source's words, so
  // "3 inches water" never reads "6 inches" at 2×.
  it.each<[string, string, string, string]>([
    ['3 inches water', '3', 'inches', 'water'],
    ['1 inch ginger, grated', '1', 'inch', 'ginger, grated'],
    ['1 in. ginger', '1', 'in', 'ginger'],
    ['2 cm ginger', '2', 'cm', 'ginger'],
    ['5 mm slices', '5', 'mm', 'slices'],
  ])('a length %j stays the source words', (text, amount, unit, rest) => {
    expect(readLeadingAmount(text)).toEqual({
      reading: { kind: 'as_written', text: `${amount} ${unit}`, reason: 'length-not-an-amount' },
      amount,
      unit,
      rest,
    });
  });

  it('a stated number the formatter cannot render back stays the source words', () => {
    expect(readLeadingAmount('1.33 cups flour')).toEqual({
      reading: { kind: 'as_written', text: '1.33 cups', reason: 'round-trip' },
      amount: '1.33',
      unit: 'cups',
      rest: 'flour',
    });
  });

  it.each([
    'salt to taste',
    'a pinch of salt',
    'flaky sea salt',
    '00 flour',
    '0 eggs',
    '5-spice powder',
    '2% milk',
    '7up',
    '2eggs',
    '2" ginger',
    '0 cups',
    '2',
    '',
    '   ',
  ])('%j has no amount at its start', (text) => {
    expect(readLeadingAmount(text)).toBeNull();
  });

  it('reads the amount and unit as parseAmount does', () => {
    for (const text of [
      '1 1/2 cups flour',
      '1 cup (225 g) butter',
      '3 cloves garlic',
      '2 large eggs',
      '2-3 tbsp oil',
      '1.33 cups flour',
      '1/2 cup (1 stick) butter',
      '1 cup (8 oz) cream cheese',
      '3 cloves',
    ]) {
      const read = readLeadingAmount(text);
      if (read === null) throw new Error(`expected an amount in ${text}`);
      expect(read.reading).toEqual(parseAmount(read.amount, read.unit));
    }
  });
});

// B4 step 0, call 7: a line is a scalable amount only if everything after its
// amount scales with it. A second quantity left in the name would stand
// unscaled beside the scaled amount ("2 tbsp + 1 tsp cumin" at 2×), so the
// converter keeps such a line as written. Call 8 (the lead's refinement): only
// a quantity blocks, a number with a measuring unit or a count of a second
// item; a number that measures something else stays in the name.
describe('holdsAmount: a second quantity left in the name', () => {
  it.each([
    // The prod export's lines: a number with a measuring unit.
    '+ 1 tsp cumin',
    '+ 2 tbsp marsala (or dry sherry)',
    'finely grated lemon zest plus 4 teaspoons juice (from 1 lemon)',
    '(1 stick / 113g) unsalted butter, softened',
    'plain yogurt (or ⅓ cup Greek yogurt)',
    'chickpeas, rinsed and drained, or 1 1/2 cups cooked chickpeas',
    'cornstarch OR 1 Tbsp arrowroot',
    'fish sauce (or 1–2 tsp soy sauce)',
    'stock (or use 6 cups water total)',
    'rice (1 cup)',
    'butter, ½ stick',
    'beans, plus 113g more',
    'cream, plus two-thirds cup',
    // A count of a second item.
    'sprig rosemary, 1 bay leaf',
    'rosemary, 1 bay leaf',
    'lemon juice (½ lemon)',
    'garlic (5 big cloves)',
    'sausage (4-6 links)',
    'zest, 3-4 wide strips',
    'lemon juice (from 1 1/2 to 2 lemons)',
    'jalapeños (or 1 regular, seeded)',
    'beans, or 1 (14-ounce) can',
    'butter, plus one more for the pan',
    'juice of half a lemon',
    'eggs (a dozen)',
    // A fraction is a quantity, joined by a slash or not; so is a range.
    'lemon juice (1/2 lemon)',
    'lemon (1/2)',
    'tomatoes (2-3)',
    'oil, plus 2-3 tbsp more',
    'cream, 1/2 cup more',
    // A count or equivalent in a bracket after the name is no exempt shape.
    'chicken thighs (4 pieces)',
    'stock (1 cup)',
    // A length that opens the bracket is the same ingredient measured by
    // length, an equivalent (call 10); one later in it is a cut.
    'ginger (1.5 inches ginger)',
    'ginger (2-inch piece)',
    'ginger ( 1 in. knob)',
    // An exempt number beside a quantity still holds the quantity.
    'beans, 2 cups soaked 8 hr',
    'water, 2 cups at 110F',
    'ginger, 1 tbsp in 1-inch coins',
    // A number the reader can't tell from a count stays one: it never guesses.
    'Chinese five spice powder',
    'tomatoes, about 4',
    // A size before a count noun covers that size only; a number after it counts.
    '(14 oz) can tomatoes, or 2 cups fresh',
    // Call 12 (the judge's false exemptions). "a", "an" or "a couple" before a
    // unit is a quantity, as is a fraction word between them.
    'sugar, plus a tablespoon for sprinkling',
    'oil, plus an ounce more',
    'broth, plus a half-cup to finish',
    'stock, plus a quarter cup',
    'stock, plus a third of a cup',
    'rice, plus a cup of water',
    'flour, plus a couple tablespoons',
    'flour, plus a couple of tablespoons',
    'butter, plus a couple sticks',
    // A qualifier hyphened to the number, or a unit after the hyphened word.
    'oil, plus 2-ish tbsp to finish',
    'flour plus 2-heaping tbsp',
    'sugar plus 2-heaped tsp',
    'flour, plus 1-level cup',
    'sugar, plus 1-scant cup',
    'cocoa, plus 2-generous tbsp',
    'eggs (2-ish)',
    'flour, plus 2-extra cups',
    // Word numbers past twelve: the teens and tens, alone or with a unit digit.
    'shrimp (about twenty)',
    'wings (fifteen to twenty pieces)',
    'shrimp (about twenty-five)',
    'cherry tomatoes, thirteen or so',
    'almonds (ninety nine)',
    // A hyphened word number.
    'water, plus one-and-a-half cups to thin',
    'water, plus 1-and-a-half cups',
    // A slash pair added on is an amount, never a ratio: nothing adds a ratio.
    'oil plus 3/2 for frying',
    'oil + 3/2 more',
    'stock, plus 4/3 to thin',
  ])('%j holds a quantity', (name) => {
    expect(holdsAmount(name)).toBe(true);
  });

  it.each([
    'unsalted butter, softened',
    'good olive oil, plus more to finish; salt',
    'half-and-half',
    'lemon, halved',
    '',
    // A duration.
    'Yellow Eye beans, soaked 8 to 18 hr',
    'chickpeas, soaked 12 hours',
    'dough, rested 30 min',
    'pork shoulder, brined 2-3 days',
    'parmesan, aged 24 months',
    'chicken, 24-hour brine',
    'cumin seeds, toasted 30 s',
    'eggs, boiled 7 mins',
    'beef, braised 3 hrs',
    // A dimension.
    'scallions, cut into 2-inch pieces',
    'butternut squash, 1-inch cubes',
    'brownies, cut 2x2 inches',
    'pasta sheets, 2 x 3 in. squares',
    'ginger, cut into 2 in pieces',
    'carrots, 5 mm dice',
    'bacon (chopped into 1/4" strips)',
    'salt pork, 1/3 inch cubes',
    'cinnamon stick, broken into 1 cm size pieces',
    'rib-eye, ideally 2 inches thick',
    'lemongrass (bottom 5 to 6 inches only)',
    'potatoes, sliced 1/8″',
    'brownie pan (20x20 cm)',
    // A temperature.
    'butter, at 65°F',
    'oil for frying, heated to 350 degrees',
    'water, 110F',
    'milk, warmed to 40 °C',
    // A percentage.
    '2% milk',
    'dark chocolate (70 % cacao)',
    'yogurt, 10 percent fat',
    // A number that names the ingredient or how it is cut, joined to a word.
    'Chinese 5-spice',
    '7-mushroom blend',
    'bay leaf, ripped into 3rds',
    // A ratio, two numbers joined by a slash with the larger first: no fraction
    // is written that way. "(1/2)" and "(2-3)" above still hold.
    'ground beef (80/20)',
    'ground beef 85/15 blend',
    'stock and water, 50/50',
    'rice, 2/1 water ratio',
    'V8 juice',
    '00 flour',
    // A size before a count noun is each unit's size, right at any count.
    '(14 oz) can tomatoes',
    '(14.5 ounce) cans diced tomatoes',
    '(14-ounce) can coconut milk',
    '15 oz can beans',
    '15-ounce can chickpeas',
    // Call 12: an article before anything but a unit, and the new word
    // numbers in an exempt shape, still hold none.
    'salt, a good amount',
    'eggs, a few',
    'duck a l’orange',
    'cheese, a cup-shaped wedge',
    'chicken, thirty-minute marinade',
    'ribs, rubbed twenty hours ahead',
    'one-pot pasta',
    '3-bean chili blend',
    // B5c-6: per-item size with "each" is the size of one, not a second quantity.
    'chicken breasts (6 oz each)',
    'salmon fillets, 150g each',
  ])('%j holds none', (name) => {
    expect(holdsAmount(name)).toBe(false);
  });
});

describe('classifyLine: "to taste" as the amount', () => {
  it.each<[string, string | undefined]>([
    ['to taste', undefined],
    ['To Taste', undefined],
    ['  to taste ', ''],
    ['', 'to taste'],
  ])('amount %j, unit %j reads to taste', (amount, unit) => {
    const line = unit === undefined ? { item: 'salt', amount } : { item: 'salt', amount, unit };
    expect(classifyLine(line)).toEqual({ kind: 'to_taste' });
  });

  it('a phrase that only mentions taste stays the source words', () => {
    expect(classifyLine({ item: 'salt', amount: 'a pinch, or to taste' })).toEqual({
      kind: 'as_written',
      text: 'a pinch, or to taste',
      reason: 'amount-not-a-number',
    });
  });
});
