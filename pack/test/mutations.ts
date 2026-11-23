// A valid base pack with its libraries, and a mutation table: one edit on the
// base per rule in either pre-B3 schema (Player's loose v0.2 and Studio's
// strict v0.2). The table was written for a differential test against those
// two schemas, which are not part of this repository; the tests here use the
// base pack.
//
// Each case names the document it edits (the pack, or one of the two library
// files) and edits a fresh copy of the base in place.

export type Json = Record<string, unknown>;
export type Target = 'pack' | 'commons' | 'states';

export interface Mutation {
  id: string;
  /** The rule being probed, and which old suite enforced it. */
  rule: string;
  target: Target;
  /** Edits the fresh base in place, or returns a whole replacement document. */
  edit: (doc: Json | Json[]) => unknown;
}

/**
 * A valid pack with every optional field present. Its libraries (below) use
 * v0.3's namespaced ids.
 */
export function basePack(): Json {
  return {
    id: 'mut-pack',
    title: 'Mutation base',
    version: '1.0',
    creator: { name: 'Creator', bio: 'Bio.', voice_notes: 'Warm.' },
    cover_ref: '/packs/media/cover.jpg',
    description: 'A pack for mutation.',
    price_usd: 12,
    recipes: [
      {
        id: 'r1',
        title: 'Recipe one',
        story: 'A story.',
        serves_base: 4,
        time_active_min: 10,
        time_total_min: 20,
        tags: ['weeknight'],
        ingredients: [
          {
            id: 'salt',
            name: 'fine sea salt',
            qty_canonical: { mass_g: 6 },
            scaling: 'linear',
            prep: 'finely ground',
            optional: false,
          },
          {
            id: 'egg',
            name: 'egg',
            qty_canonical: { count: 2 },
            scaling: 'linear',
            optional: false,
          },
        ],
        steps: [
          {
            id: 's1',
            type: 'action',
            title: 'Salt',
            text: 'Salt the water.',
            ingredient_refs: ['salt'],
            timer_sec: null,
            parallel_ok: false,
            media_ref: '/packs/media/s1.jpg',
            technique_refs: ['commons:temper-eggs'],
            recommended_technique_ref: 'commons:temper-eggs',
            state_refs: ['state:creamy'],
            coach_hints: ['Taste it.'],
          },
          {
            id: 's2',
            type: 'wait',
            title: 'Rest',
            text: 'Let it rest.',
            ingredient_refs: ['egg'],
            timer_sec: 60,
            parallel_ok: true,
            technique_refs: [],
            state_refs: [],
            coach_hints: [],
          },
        ],
        variations: [{ name: 'Spicy', description: 'Add chilli.', patch: {} }],
        creator_notes: ['Note.'],
      },
    ],
  };
}

/**
 * The same pack in the shape Studio v0.2 required of a flat pack: every field
 * present, display_equivalents in its array shape (P2), step media_ref null
 * where there is no film.
 */
export function studioBasePack(): Json {
  const d = basePack();
  const [salt, egg] = arr(recipe(d)['ingredients']).map(obj);
  salt!['display_equivalents'] = [
    { system: 'us', kind: 'volume', text: '1 tsp' },
    { system: 'metric', kind: 'weight', text: '6 g' },
  ];
  egg!['display_equivalents'] = [{ system: 'us', kind: 'count', text: '2' }];
  step(d, 1)['media_ref'] = null;
  return d;
}

export function baseCommons(): Json[] {
  return [
    {
      id: 'commons:temper-eggs',
      name: 'Tempering eggs',
      description: 'Warm eggs gently.',
      media_ref: '/packs/media/temper.jpg',
    },
  ];
}

export function baseStates(): Json[] {
  return [
    {
      id: 'state:creamy',
      name: 'Creamy',
      visual_ref: '/packs/media/creamy.jpg',
      sensory_notes: { look: 'Glossy.' },
    },
  ];
}

function obj(v: unknown): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
  return v as Json;
}
function arr(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error('not an array');
  return v;
}
const recipe = (d: Json | Json[]): Json => obj(arr(obj(d)['recipes'])[0]);
const ingredient = (d: Json | Json[], i = 0): Json => obj(arr(recipe(d)['ingredients'])[i]);
const step = (d: Json | Json[], i = 0): Json => obj(arr(recipe(d)['steps'])[i]);
const entry = (d: Json | Json[], i = 0): Json => obj(arr(d)[i]);

const pack = (id: string, rule: string, edit: (d: Json | Json[]) => unknown): Mutation => ({
  id,
  rule,
  target: 'pack',
  edit,
});
const commons = (id: string, rule: string, edit: (d: Json | Json[]) => unknown): Mutation => ({
  id,
  rule,
  target: 'commons',
  edit,
});
const states = (id: string, rule: string, edit: (d: Json | Json[]) => unknown): Mutation => ({
  id,
  rule,
  target: 'states',
  edit,
});

export const MUTATIONS: readonly Mutation[] = [
  // ---- pack metadata ----
  pack('pack-no-id', 'pack id required (both)', (d) => { delete obj(d)['id']; }),
  pack('pack-bad-slug-id', 'pack id is a slug (Studio)', (d) => { obj(d)['id'] = 'Not A Slug'; }),
  pack('pack-no-title', 'title required (both)', (d) => { delete obj(d)['title']; }),
  pack('version-number', 'version may be a number (Player)', (d) => { obj(d)['version'] = 2; }),
  pack('version-bool', 'version is a string or number (Player)', (d) => { obj(d)['version'] = true; }),
  pack('creator-no-name', 'creator.name required (both)', (d) => { delete obj(obj(d)['creator'])['name']; }),
  pack('creator-no-bio', 'creator.bio required (Studio)', (d) => { delete obj(obj(d)['creator'])['bio']; }),
  pack('cover-empty', 'cover_ref non-empty (both)', (d) => { obj(d)['cover_ref'] = ''; }),
  pack('cover-null', 'cover_ref null = not yet produced (Studio; P3)', (d) => { obj(d)['cover_ref'] = null; }),
  pack('cover-absent', 'cover_ref optional (Player)', (d) => { delete obj(d)['cover_ref']; }),
  pack('cover-outside-media', 'cover_ref under /packs/media/ (Player refs)', (d) => { obj(d)['cover_ref'] = 'https://cdn.example.com/c.jpg'; }),
  pack('price-negative', 'price_usd non-negative (both)', (d) => { obj(d)['price_usd'] = -1; }),
  pack('price-null', 'price_usd null = unpriced draft (Studio; P3)', (d) => { obj(d)['price_usd'] = null; }),
  pack('recipes-empty', 'at least one recipe (both)', (d) => { obj(d)['recipes'] = []; }),
  pack('unknown-root-key', 'unknown keys pass through (Player) / are refused (Studio)', (d) => { obj(d)['x_future'] = { a: 1 }; }),
  pack('format-version', 'P1 format_version stays parked: unknown key', (d) => { obj(d)['format_version'] = '0.2'; }),
  // ---- recipe ----
  pack('recipe-no-serves', 'serves_base required (both)', (d) => { delete recipe(d)['serves_base']; }),
  pack('recipe-serves-zero', 'serves_base positive (both)', (d) => { recipe(d)['serves_base'] = 0; }),
  pack('recipe-time-negative', 'time_active_min non-negative (both)', (d) => { recipe(d)['time_active_min'] = -5; }),
  pack('recipe-time-fraction', 'time_active_min integer (Studio)', (d) => { recipe(d)['time_active_min'] = 2.5; }),
  pack('recipe-tags-string', 'tags is an array (both)', (d) => { recipe(d)['tags'] = 'weeknight'; }),
  pack('recipe-no-story', 'story required (Studio)', (d) => { delete recipe(d)['story']; }),
  pack('recipe-unknown-key', 'unknown recipe key', (d) => { recipe(d)['x_recipe'] = [1]; }),
  // The steps' ingredient_refs go with the list, so the row probes the list rule, not ref resolution.
  pack('ingredients-empty', 'at least one ingredient (both; v0.4 P27 allows it beside steps)', (d) => {
    recipe(d)['ingredients'] = [];
    for (const s of arr(recipe(d)['steps'])) delete obj(s)['ingredient_refs'];
  }),
  pack('steps-empty', 'at least one step (both; v0.4 P27 allows it beside ingredients)', (d) => { recipe(d)['steps'] = []; }),
  pack('recipe-serves-null', 'serves_base required (both; v0.4 P28 allowed null, reverted in v0.5)', (d) => { recipe(d)['serves_base'] = null; }),
  pack('recipe-serves-estimated', 'P30: serves_estimated true = the count is Sous\'s estimate', (d) => { recipe(d)['serves_estimated'] = true; }),
  pack('recipe-serves-estimated-false', 'P30: serves_estimated is only ever true', (d) => { recipe(d)['serves_estimated'] = false; }),
  pack('pack-kind-household', 'P11: kind household', (d) => { obj(d)['kind'] = 'household'; }),
  pack('pack-kind-unknown', 'P11: kind is creator|household', (d) => { obj(d)['kind'] = 'family'; }),
  pack('variation-no-name', 'variation name required (both)', (d) => { delete obj(arr(recipe(d)['variations'])[0])['name']; }),
  pack('variation-patch-array', 'patch is a record (Studio) / opaque (Player)', (d) => { obj(arr(recipe(d)['variations'])[0])['patch'] = [1]; }),
  // ---- ingredient ----
  pack('ing-no-name', 'ingredient name required (both)', (d) => { delete ingredient(d)['name']; }),
  pack('ing-bad-slug', 'ingredient id is a slug (Studio)', (d) => { ingredient(d)['id'] = 'Sea Salt'; }),
  pack('qty-no-anchor', 'qty_canonical needs mass_g/volume_ml/count (both)', (d) => { ingredient(d)['qty_canonical'] = { salt_type: 'coarse' }; }),
  pack('qty-negative', 'mass_g positive (both)', (d) => { ingredient(d)['qty_canonical'] = { mass_g: -6 }; }),
  pack('qty-unknown-key', 'qty_canonical open keys pass through', (d) => { ingredient(d)['qty_canonical'] = { mass_g: 6, pinch: 2 }; }),
  pack('qty-unknown-key-object', 'qty_canonical open key of object type (Studio refuses)', (d) => { ingredient(d)['qty_canonical'] = { mass_g: 6, extra: { a: 1 } }; }),
  pack('qty-to-taste', 'P20: to_taste: true anchors a quantity', (d) => { ingredient(d)['qty_canonical'] = { to_taste: true, salt_type: 'fine' }; }),
  pack('qty-to-taste-false', 'P20: to_taste is only ever true', (d) => { ingredient(d)['qty_canonical'] = { mass_g: 6, to_taste: false }; }),
  pack('qty-to-taste-with-mass', 'P20/P25: a marker stands alone', (d) => { ingredient(d)['qty_canonical'] = { mass_g: 6, to_taste: true }; }),
  pack('qty-as-written', 'P25: as_written anchors a quantity', (d) => { ingredient(d)['qty_canonical'] = { as_written: 'a pinch of' }; }),
  pack('qty-as-written-with-count', 'P25: as_written excludes the measurable keys', (d) => { ingredient(d)['qty_canonical'] = { count: 2, as_written: '2 large' }; }),
  pack('qty-unstated', 'P25: unstated: true anchors a quantity', (d) => { ingredient(d)['qty_canonical'] = { unstated: true }; }),
  pack('qty-unstated-and-as-written', 'P25: unstated and as_written exclude each other', (d) => { ingredient(d)['qty_canonical'] = { unstated: true, as_written: 'some' }; }),
  pack('ing-scaling-bad', 'scaling is linear|fixed (both)', (d) => { ingredient(d)['scaling'] = 'exponential'; }),
  pack('ing-optional-string', 'optional is a boolean (both)', (d) => { ingredient(d)['optional'] = 'no'; }),
  pack('ing-prep-empty', 'prep non-empty (Studio)', (d) => { ingredient(d)['prep'] = ''; }),
  pack('display-studio-array', 'display_equivalents: Studio v0.2 array shape (P18)', (d) => { ingredient(d)['display_equivalents'] = [{ system: 'us', kind: 'weight', text: '1 tsp' }]; }),
  pack('display-p18-object', 'display_equivalents: P18 object shape', (d) => { ingredient(d)['display_equivalents'] = { imperial: { unit: 'tsp', amount: 1 } }; }),
  pack('display-string', 'display_equivalents: a bare string (opaque in Player)', (d) => { ingredient(d)['display_equivalents'] = '1 tsp'; }),
  pack('display-number', 'display_equivalents: a number (opaque in Player; P18)', (d) => { ingredient(d)['display_equivalents'] = 42; }),
  pack('display-empty-object', 'display_equivalents: an object with no system (P18 keys are optional)', (d) => { ingredient(d)['display_equivalents'] = {}; }),
  pack('display-unknown-system', 'display_equivalents: an unknown system key passes through (P18)', (d) => { ingredient(d)['display_equivalents'] = { imperial: { unit: 'tsp', amount: 1 }, x_system: 'keep' }; }),
  pack('display-hint-unknown-key', 'display_equivalents: an unknown key inside a hint passes through (P18)', (d) => { ingredient(d)['display_equivalents'] = { imperial: { unit: 'tsp', amount: 1, x_note: 'keep' } }; }),
  pack('display-hint-no-amount', 'display_equivalents: a hint needs an amount (P18)', (d) => { ingredient(d)['display_equivalents'] = { imperial: { unit: 'tsp' } }; }),
  pack('display-hint-amount-string', 'display_equivalents: amount is a number (P18)', (d) => { ingredient(d)['display_equivalents'] = { imperial: { unit: 'tsp', amount: '1' } }; }),
  pack('display-hint-amount-zero', 'display_equivalents: amount is positive (P18)', (d) => { ingredient(d)['display_equivalents'] = { metric: { unit: 'g', amount: 0 } }; }),
  pack('display-hint-unit-empty', 'display_equivalents: unit is non-empty (P18)', (d) => { ingredient(d)['display_equivalents'] = { metric: { unit: '', amount: 6 } }; }),
  pack('display-hint-null', 'display_equivalents: a system is absent, not null (P18)', (d) => { ingredient(d)['display_equivalents'] = { imperial: null }; }),
  pack('qty-count-unit', 'P26: count_unit {one, other} valid with count', (d) => {
    ingredient(d, 1)['qty_canonical'] = { count: 3, count_unit: { one: 'clove', other: 'cloves' } };
  }),
  pack('qty-count-unit-without-count', 'P26: count_unit requires count', (d) => {
    ingredient(d)['qty_canonical'] = { mass_g: 6, count_unit: { one: 'clove', other: 'cloves' } };
  }),
  pack('qty-count-unit-empty-one', 'P26: count_unit.one must be visible text', (d) => {
    ingredient(d, 1)['qty_canonical'] = { count: 3, count_unit: { one: ' ', other: 'cloves' } };
  }),
  pack('qty-range-max', 'P29: range_max > low with single canonical amount', (d) => {
    ingredient(d, 1)['qty_canonical'] = { count: 2, range_max: 4 };
  }),
  pack('qty-range-max-not-greater', 'P29: range_max must be greater than low end', (d) => {
    ingredient(d, 1)['qty_canonical'] = { count: 2, range_max: 2 };
  }),
  pack('qty-range-max-two-amounts', 'P29: range_max valid only with a single canonical amount', (d) => {
    ingredient(d, 1)['qty_canonical'] = { count: 3, mass_g: 54, range_max: 60 };
  }),
  pack('display-hint-amount-max', 'P29: hint with amount_max > amount when qty_canonical has range_max', (d) => {
    ingredient(d)['qty_canonical'] = { mass_g: 6, range_max: 9 };
    ingredient(d)['display_equivalents'] = { imperial: { unit: 'tsp', amount: 1, amount_max: 1.5 } };
  }),
  pack('display-hint-amount-max-missing', 'P29: hint requires amount_max when qty_canonical has range_max', (d) => {
    ingredient(d)['qty_canonical'] = { mass_g: 6, range_max: 9 };
    ingredient(d)['display_equivalents'] = { imperial: { unit: 'tsp', amount: 1 } };
  }),
  pack('display-hint-amount-max-without-range', 'P29: hint cannot have amount_max without qty_canonical.range_max', (d) => {
    ingredient(d)['display_equivalents'] = { imperial: { unit: 'tsp', amount: 1, amount_max: 2 } };
  }),
  pack('display-hint-amount-max-not-greater', 'P29: hint amount_max must be greater than amount', (d) => {
    ingredient(d)['qty_canonical'] = { mass_g: 6, range_max: 9 };
    ingredient(d)['display_equivalents'] = { imperial: { unit: 'tsp', amount: 1, amount_max: 1 } };
  }),
  // ---- step ----
  pack('step-type-bad', 'step type enum (both)', (d) => { step(d)['type'] = 'dance'; }),
  pack('step-text-empty', 'step text non-empty (both)', (d) => { step(d)['text'] = ''; }),
  pack('step-timer-negative', 'timer_sec positive (both)', (d) => { step(d)['timer_sec'] = -30; }),
  pack('step-timer-fraction', 'timer_sec integer (both)', (d) => { step(d)['timer_sec'] = 1.5; }),
  pack('step-media-null', 'step media_ref null = no creator film (Studio; P3)', (d) => { step(d)['media_ref'] = null; }),
  pack('step-media-empty', 'step media_ref non-empty (both)', (d) => { step(d)['media_ref'] = ''; }),
  pack('step-media-outside', 'step media_ref under /packs/media/ (Player refs; P19)', (d) => { step(d)['media_ref'] = 'https://cdn.example.com/x.jpg'; }),
  pack('step-technique-number', 'technique_refs are strings (both)', (d) => { step(d)['technique_refs'] = [7]; }),
  pack('step-coach-empty', 'coach hints non-empty (Studio)', (d) => { step(d)['coach_hints'] = ['']; }),
  pack('step-recommended-set', 'recommended_technique_ref names one of technique_refs (both, v0.2)', (d) => { step(d)['recommended_technique_ref'] = 'commons:temper-eggs'; }),
  pack('step-recommended-empty', 'recommended_technique_ref non-empty (both, v0.2)', (d) => { step(d)['recommended_technique_ref'] = ''; }),
  pack('step-recommended-number', 'recommended_technique_ref is a string (both, v0.2)', (d) => { step(d)['recommended_technique_ref'] = 7; }),
  pack('step-recommended-stray', 'recommended_technique_ref is one of technique_refs (Studio)', (d) => { step(d)['recommended_technique_ref'] = 'commons:something-else'; }),
  pack('step-no-title', 'step title required (Studio)', (d) => { delete step(d)['title']; }),
  pack('step-unknown-key', 'unknown step key', (d) => { step(d)['x_step'] = 'keep'; }),
  // ---- refs (Player's verifyPackRefs) ----
  pack('ref-ingredient-dangling', 'ingredient_ref names an ingredient (Player refs)', (d) => { step(d)['ingredient_refs'] = ['ghost']; }),
  pack('ref-technique-no-namespace', 'technique_ref carries commons: (both)', (d) => {
    step(d)['technique_refs'] = ['temper-eggs'];
    delete step(d)['recommended_technique_ref'];
  }),
  pack('ref-technique-unknown', 'technique_ref resolves in commons (Player refs)', (d) => {
    step(d)['technique_refs'] = ['commons:unknown-move'];
    delete step(d)['recommended_technique_ref'];
  }),
  pack('ref-state-no-namespace', 'state_ref carries state: (both)', (d) => { step(d)['state_refs'] = ['creamy']; }),
  pack('ref-state-unknown', 'state_ref resolves in states (Player refs)', (d) => { step(d)['state_refs'] = ['state:phantom']; }),
  pack('ref-duplicate-ingredient', 'ingredient ids unique in a recipe (Player refs)', (d) => {
    arr(recipe(d)['ingredients']).push({ id: 'salt', name: 'salt again', qty_canonical: { mass_g: 1 }, scaling: 'linear', optional: false });
  }),
  pack('ref-duplicate-step', 'step ids unique in a recipe (Player refs)', (d) => {
    arr(recipe(d)['steps']).push({ ...step(d, 1) });
  }),
  // ---- P19 strict: a media ref is a file path under /packs/media/ (fix round 1, M1) ----
  pack('media-bare-prefix', 'P19: a ref names a file, not the media root', (d) => { obj(d)['cover_ref'] = '/packs/media/'; }),
  pack('media-trailing-slash', 'P19: a ref names a file, not a directory', (d) => { obj(d)['cover_ref'] = '/packs/media/sub/'; }),
  pack('media-dotdot', 'P19: no ".." segment', (d) => { obj(d)['cover_ref'] = '/packs/media/../commons.json'; }),
  pack('media-dotdot-deep', 'P19: no ".." segment, however deep', (d) => { step(d)['media_ref'] = '/packs/media/sub/../../../app/.env'; }),
  pack('media-dot-segment', 'P19: no "." segment', (d) => { step(d)['media_ref'] = '/packs/media/./s1.jpg'; }),
  pack('media-empty-segment', 'P19: no empty segment', (d) => { step(d)['media_ref'] = '/packs/media//x.jpg'; }),
  pack('media-percent', 'P19: no percent-encoding', (d) => { step(d)['media_ref'] = '/packs/media/%2e%2e/x.jpg'; }),
  pack('media-backslash', 'P19: no backslash', (d) => { step(d)['media_ref'] = '/packs/media/..\\x.jpg'; }),
  pack('media-query', 'P19: no query', (d) => { step(d)['media_ref'] = '/packs/media/x.jpg?y'; }),
  pack('media-fragment', 'P19: no fragment', (d) => { step(d)['media_ref'] = '/packs/media/x.jpg#t=3'; }),
  pack('media-trailing-space', 'P19: no whitespace', (d) => { obj(d)['cover_ref'] = '/packs/media/cover.jpg '; }),
  pack('media-inner-space', 'P19: no whitespace', (d) => { obj(d)['cover_ref'] = '/packs/media/my cover.jpg'; }),
  pack('media-control-char', 'P19: no control character', (d) => { obj(d)['cover_ref'] = '/packs/media/cover\u0000.jpg'; }),
  // Invisible format characters (Unicode Cf), B3 review 2 item 2: an RLO makes
  // "cover‮gpj.jpg" display reversed; a ZWSP or ZWJ makes two refs look alike.
  pack('media-format-rlo', 'P19: no format character (RLO)', (d) => { obj(d)['cover_ref'] = '/packs/media/cover‮gpj.jpg'; }),
  pack('media-format-zwsp', 'P19: no format character (ZWSP)', (d) => { step(d)['media_ref'] = '/packs/media/s1​.mp4'; }),
  pack('media-format-zwj', 'P19: no format character (ZWJ)', (d) => { step(d)['media_ref'] = '/packs/media/a‍b.mp4'; }),
  pack('media-protocol-relative', 'P19: a protocol-relative URL is not a ref', (d) => { obj(d)['cover_ref'] = '//x'; }),
  pack('media-relative-query', 'P19: a relative path is not a ref', (d) => { obj(d)['cover_ref'] = 'x?y'; }),
  pack('media-relative-backslash', 'P19: a relative path is not a ref', (d) => { obj(d)['cover_ref'] = '..\\x'; }),
  pack('media-subdirectory', 'P19: a file in a subdirectory of /packs/media/ is a ref', (d) => { obj(d)['cover_ref'] = '/packs/media/demo-book/cover.v2.jpg'; }),
  commons('commons-media-dotdot', 'P19: library media obey the same path rule', (d) => { entry(d)['media_ref'] = '/packs/media/../states.json'; }),
  states('states-visual-dotdot', 'P19: library media obey the same path rule', (d) => { entry(d)['visual_ref'] = '/packs/media/x/../../commons.json'; }),
  // ---- rules a suite once missed (fix round 1, items 2, 8, 9) ----
  pack('creator-name-empty', 'creator.name non-empty (both)', (d) => { obj(obj(d)['creator'])['name'] = ''; }),
  pack('qty-salt-type-empty', 'qty_canonical.salt_type non-empty (both)', (d) => { ingredient(d)['qty_canonical'] = { mass_g: 6, salt_type: '' }; }),
  pack('display-hint-unit-blank', 'display_equivalents: a unit of only whitespace is empty (P18)', (d) => { ingredient(d)['display_equivalents'] = { metric: { unit: ' ', amount: 6 } }; }),
  pack('display-hint-unit-format-only', 'display_equivalents: a unit of only format characters is empty (P18)', (d) => { ingredient(d)['display_equivalents'] = { metric: { unit: '​', amount: 6 } }; }),
  pack('display-hint-unit-format-and-space', 'display_equivalents: a unit of only format characters and whitespace is empty (P18)', (d) => { ingredient(d)['display_equivalents'] = { metric: { unit: ' ‍⁠ ', amount: 6 } }; }),
  // JSON.parse('1e400') is Infinity; JSON.stringify writes it back as null.
  pack('qty-mass-infinite', 'mass_g is finite', (d) => { ingredient(d)['qty_canonical'] = { mass_g: Infinity }; }),
  pack('qty-volume-infinite', 'volume_ml is finite', (d) => { ingredient(d)['qty_canonical'] = { volume_ml: Infinity }; }),
  pack('qty-count-infinite', 'count is finite', (d) => { ingredient(d, 1)['qty_canonical'] = { count: Infinity }; }),
  pack('qty-nan', 'mass_g is a number, not NaN', (d) => { ingredient(d)['qty_canonical'] = { mass_g: Number.NaN }; }),
  pack('display-hint-amount-infinite', 'display_equivalents: amount is finite (P18)', (d) => { ingredient(d)['display_equivalents'] = { metric: { unit: 'g', amount: Infinity } }; }),
  pack('recipe-serves-infinite', 'serves_base is finite', (d) => { recipe(d)['serves_base'] = Infinity; }),
  pack('recipe-time-infinite', 'time_total_min is finite', (d) => { recipe(d)['time_total_min'] = Infinity; }),
  pack('price-infinite', 'price_usd is finite', (d) => { obj(d)['price_usd'] = Infinity; }),
  pack('step-timer-infinite', 'timer_sec is finite', (d) => { step(d, 1)['timer_sec'] = Infinity; }),
  // ---- commons library ----
  commons('commons-not-array', 'commons file is a bare array (both)', (d) => ({ commons: d })),
  commons('commons-no-id', 'commons entry id required (both)', (d) => { delete entry(d)['id']; }),
  commons('commons-bare-id', 'commons id carries commons: (Studio; v0.3) / bare (Player v0.2)', (d) => { entry(d)['id'] = 'temper-eggs'; }),
  commons('commons-media-null', 'commons media_ref null = not yet produced (both)', (d) => { entry(d)['media_ref'] = null; }),
  commons('commons-media-outside', 'commons media_ref under /packs/media/ (Player refs)', (d) => { entry(d)['media_ref'] = 'https://cdn.example.com/t.jpg'; }),
  commons('commons-no-description', 'commons description required (Studio)', (d) => { delete entry(d)['description']; }),
  commons('commons-unknown-key', 'unknown commons key', (d) => { entry(d)['x'] = 1; }),
  // ---- states library ----
  states('states-not-array', 'states file is a bare array (both)', (d) => ({ states: d })),
  states('states-no-name', 'state name required (both)', (d) => { delete entry(d)['name']; }),
  states('states-bare-id', 'state id carries state: (Studio; v0.3) / bare (Player v0.2)', (d) => { entry(d)['id'] = 'creamy'; }),
  states('states-visual-outside', 'visual_ref under /packs/media/ (Player refs)', (d) => { entry(d)['visual_ref'] = 'media/creamy.jpg'; }),
  states('states-notes-empty', 'sensory_notes needs one sense (Studio)', (d) => { entry(d)['sensory_notes'] = {}; }),
  states('states-notes-number', 'sensory_notes.look is a string (both)', (d) => { obj(entry(d)['sensory_notes'])['look'] = 3; }),
];
