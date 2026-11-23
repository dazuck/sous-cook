// @sous/pack: Pack Format v0 (design/pack-format-v0.md) as the one schema the
// app, Player and Studio share (slice B3). The spec and this file describe one
// format: a change to either lands with the matching change to the other.
//
// One module with a single bare `zod` import, so it compiles unchanged under
// the app's bundler resolution, Player's .ts imports and Studio's NodeNext.
// Consumers call the functions below; they never compose these zod schemas
// (Studio is on zod 3).

import { z } from 'zod';

// Pack Format v0.7, built as written. A pack file is the flat pack object
// (the {pack, recipes} envelope is not a pack file). Every object is
// loose: unknown fields parse through verbatim so pack → render → edit → pack
// round-trips (contract rule). No .default() anywhere — a default would inject
// fields the source file never had and break the round-trip.
//
// Null (P3) means "authored, asset or decision pending": cover_ref null = no
// cover yet, price_usd null = unpriced draft (0 = free), a step's media_ref
// null = no creator film, a library media_ref / visual_ref null = not yet
// filmed or shot. Absent and null read the same everywhere.

// A string a reader shows as text. Refined, not trimmed: a transform would
// rewrite the file on round-trip. Invisible format characters (Unicode Cf:
// ZWSP, ZWJ, RLO…) show nothing, so a string of only those and whitespace is
// as empty as a blank one.
function visibleText(field: string) {
  return z.string().refine((s) => s.replace(/[\s\p{Cf}]/gu, '').length > 0, {
    error: `${field} must not be empty or only whitespace and invisible format characters`,
  });
}

// P26 (v0.7): a count noun for count quantities ("3 cloves", "1 can (14 oz)").
// Both forms must carry visible text; valid only when count is present.
const countUnitSchema = z.looseObject({
  one: visibleText('count_unit.one'),
  other: visibleText('count_unit.other'),
});

// qty_canonical: known keys validated strictly when present; the contract's
// open "etc." means unknown keys pass through uninterpreted. A quantity is
// anchored by a canonical amount (mass_g / volume_ml / count), or, when the
// source gives no number (v0.4), by exactly one marker standing alone:
// to_taste (P20), as_written (P25: the source's amount and unit verbatim) or
// unstated (P25). mass_g, volume_ml, count (and range_max, P29) are amounts;
// every other key (salt_type, etc., P6) is a qualifier that never scales.
const qtyCanonicalSchema = z
  .looseObject({
    mass_g: z.number().positive().optional(),
    volume_ml: z.number().positive().optional(),
    count: z.number().positive().optional(),
    count_unit: countUnitSchema.optional(),
    range_max: z.number().positive().optional(),
    salt_type: z.string().min(1).optional(),
    to_taste: z.literal(true).optional(),
    as_written: visibleText('as_written').optional(),
    unstated: z.literal(true).optional(),
  })
  .refine(
    (q) =>
      q.mass_g !== undefined ||
      q.volume_ml !== undefined ||
      q.count !== undefined ||
      q.to_taste !== undefined ||
      q.as_written !== undefined ||
      q.unstated !== undefined,
    {
      error: 'qty_canonical needs at least one of mass_g, volume_ml, count, or one of to_taste, as_written, unstated',
    },
  )
  .refine(
    (q) => {
      const markers = [q.to_taste, q.as_written, q.unstated].filter((m) => m !== undefined).length;
      const measured = q.mass_g !== undefined || q.volume_ml !== undefined || q.count !== undefined;
      return markers === 0 || (markers === 1 && !measured);
    },
    {
      error: 'to_taste, as_written and unstated each stand alone: never two together, never beside mass_g, volume_ml or count',
    },
  )
  .refine((q) => q.count_unit === undefined || q.count !== undefined, {
    path: ['count_unit'],
    error: 'count_unit requires count',
  })
  .refine(
    (q) => {
      if (q.range_max === undefined) return true;
      const amounts = [q.mass_g, q.volume_ml, q.count].filter((n): n is number => n !== undefined);
      return amounts.length === 1 && amounts[0] !== undefined && q.range_max > amounts[0];
    },
    {
      path: ['range_max'],
      error: 'range_max requires exactly one of mass_g, volume_ml, count and must be greater than it',
    },
  );

// display_equivalents (P18, v0.3; P29 & stated-hint reading, v0.7): the stated
// amount and unit for each system, keyed imperial | metric, each
// {unit, amount, amount_max?}. Hints are the stated amount: readers show a
// hint's amount (and amount_max) times the serving multiplier, in the hint's
// unit, and convert from it. amount_max is required on a hint whose line has
// range_max and refused otherwise. A system with no hint is absent (never null).
// Unknown keys pass through at both levels.
const displayHintSchema = z
  .looseObject({
    unit: visibleText('unit'),
    amount: z.number().positive(),
    amount_max: z.number().positive().optional(),
  })
  .refine((h) => h.amount_max === undefined || h.amount_max > h.amount, {
    path: ['amount_max'],
    error: 'amount_max must be greater than amount',
  });

const displayEquivalentsSchema = z.looseObject({
  imperial: displayHintSchema.optional(),
  metric: displayHintSchema.optional(),
});

const ingredientSchema = z
  .looseObject({
    id: z.string().min(1),
    name: z.string().min(1),
    qty_canonical: qtyCanonicalSchema,
    display_equivalents: displayEquivalentsSchema.optional(),
    scaling: z.enum(['linear', 'fixed']).optional(),
    prep: z.string().optional(),
    optional: z.boolean().optional(),
  })
  .superRefine((ing, ctx) => {
    const hasRange = ing.qty_canonical.range_max !== undefined;
    const eq = ing.display_equivalents;
    if (eq === undefined) return;
    for (const system of ['imperial', 'metric'] as const) {
      const hint = eq[system];
      if (hint === undefined) continue;
      if (hasRange && hint.amount_max === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['display_equivalents', system, 'amount_max'],
          message: 'display_equivalents hint requires amount_max when qty_canonical has range_max',
        });
      } else if (!hasRange && hint.amount_max !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['display_equivalents', system, 'amount_max'],
          message: 'display_equivalents hint cannot have amount_max without qty_canonical.range_max',
        });
      }
    }
  });

const stepSchema = z.looseObject({
  id: z.string().min(1),
  type: z.enum(['action', 'checkpoint', 'interlude', 'wait']),
  title: z.string().optional(),
  text: z.string().min(1),
  ingredient_refs: z.array(z.string().min(1)).optional(),
  timer_sec: z.number().int().positive().nullable().optional(),
  parallel_ok: z.boolean().optional(),
  media_ref: z.string().min(1).nullable().optional(),
  technique_refs: z.array(z.string().min(1)).optional(),
  // Format v0.2: the creator's pick among technique_refs; not rendered here (the app carries help, DS-P39).
  recommended_technique_ref: z.string().min(1).optional(),
  state_refs: z.array(z.string().min(1)).optional(),
  coach_hints: z.array(z.string()).optional(),
});

// variations[].patch is opaque: applied semantics are a later feature; v0 only
// guarantees it survives the round trip.
const variationSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  patch: z.unknown().optional(),
});

// v0.5 (slice B4b): every recipe has a serving count. P28's null (v0.4) is
// reverted (2026-10-06): a source that states no count gets
// Sous's estimate, marked by serves_estimated (P30).
const servesBaseSchema = z.number().positive();

const recipeSchema = z
  .looseObject({
    id: z.string().min(1),
    title: z.string().min(1),
    story: z.string().optional(),
    serves_base: servesBaseSchema,
    // P30 (v0.5): the source states no count, and serves_base is Sous's
    // estimate. Only ever true; absent means the source states the count. A
    // count scaled from an estimated base is still an estimate.
    serves_estimated: z.literal(true).optional(),
    time_active_min: z.number().nonnegative().optional(),
    time_total_min: z.number().nonnegative().optional(),
    tags: z.array(z.string()).optional(),
    // P27 (v0.4): either list may be empty (an ingredients-only source, a
    // method with no list), never both.
    ingredients: z.array(ingredientSchema),
    steps: z.array(stepSchema),
    variations: z.array(variationSchema).optional(),
    creator_notes: z.array(z.string()).optional(),
  })
  .refine((r) => r.ingredients.length > 0 || r.steps.length > 0, {
    error: 'a recipe needs at least one ingredient or one step',
  });

// P21 (v0.6, slice S): a chapter inside a pack, in display order. Its ids
// resolving, and none twice, is verifyPackRefs's (a cross-reference).
const sectionSchema = z.looseObject({
  title: visibleText('a section title'),
  recipe_ids: z.array(z.string().min(1)).min(1),
});

const packSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  // P11 (v0.4): absent reads as "creator".
  kind: z.enum(['creator', 'household']).optional(),
  version: z.union([z.string().min(1), z.number()]),
  creator: z.looseObject({
    name: z.string().min(1),
    bio: z.string().optional(),
    voice_notes: z.string().optional(),
  }),
  cover_ref: z.string().min(1).nullable().optional(),
  description: z.string().optional(),
  price_usd: z.number().nonnegative().nullable().optional(),
  recipes: z.array(recipeSchema).min(1),
  // P21 (v0.6): absent = one flat list in recipes[] order; a recipe in no
  // section shows after the last one.
  sections: z.array(sectionSchema).optional(),
});

// Platform libraries — separate files, each a bare array (the contract's
// "commons[] (platform-level, separate file)"). A library id is the namespaced
// id, the same string a step's ref carries ("commons:x", "state:x"), so refs
// resolve by whole-id equality (v0.3).
const COMMONS_NS = 'commons:';
const STATE_NS = 'state:';

function namespacedId(namespace: string) {
  return z
    .string()
    .refine((id) => id.startsWith(namespace) && id.length > namespace.length, {
      error: `library id must be "${namespace}<name>"`,
    });
}

const commonsFileSchema = z.array(
  z.looseObject({
    id: namespacedId(COMMONS_NS),
    name: z.string().min(1),
    description: z.string().optional(),
    media_ref: z.string().min(1).nullable().optional(),
  }),
);

const statesFileSchema = z.array(
  z.looseObject({
    id: namespacedId(STATE_NS),
    name: z.string().min(1),
    visual_ref: z.string().min(1).nullable().optional(),
    sensory_notes: z
      .looseObject({
        look: z.string().optional(),
        sound: z.string().optional(),
        smell: z.string().optional(),
      })
      .optional(),
  }),
);

export type Pack = z.infer<typeof packSchema>;
export type Recipe = Pack['recipes'][number];
export type Ingredient = Recipe['ingredients'][number];
export type QtyCanonical = Ingredient['qty_canonical'];
export type Step = Recipe['steps'][number];
export type Variation = NonNullable<Recipe['variations']>[number];
export type Commons = z.infer<typeof commonsFileSchema>;
export type States = z.infer<typeof statesFileSchema>;

export interface SchemaIssue {
  path: string;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

function toIssues(error: z.ZodError): SchemaIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join('.') || '(root)',
    message: issue.message,
  }));
}

function parseWith<S extends z.ZodType>(schema: S, data: unknown): ParseResult<z.infer<S>> {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: toIssues(result.error) };
}

export function parsePack(data: unknown): ParseResult<Pack> {
  return parseWith(packSchema, data);
}

/**
 * One recipe on its own, by the schema a pack's recipes use; issue paths start
 * at the recipe. For a reader that builds recipes one at a time and validates
 * each before any pack holds it (the app's legacy converter, slice B4).
 */
export function parseRecipe(data: unknown): ParseResult<Recipe> {
  return parseWith(recipeSchema, data);
}

export function parseCommonsFile(data: unknown): ParseResult<Commons> {
  return parseWith(commonsFileSchema, data);
}

export function parseStatesFile(data: unknown): ParseResult<States> {
  return parseWith(statesFileSchema, data);
}

// ---- Referential integrity ----

// Referential integrity across a parsed pack and the platform libraries.
// A dangling ref is a validation error (failure mode: full-screen pack error,
// no partial render) — never a silently skipped feature.

// P19 (v0.3): every non-null media ref, pack or library, is a platform-root
// file path under this prefix: segments that are names (never empty, "." or
// ".."), nothing a URL or an encoding would read differently. Whether the file
// exists, symlinks resolved, is the publisher's check (media-file.ts), not the
// parser's.
export const MEDIA_PREFIX = '/packs/media/';

export interface Libraries {
  commons: Commons;
  states: States;
}

// A character a plain file path never carries: whitespace, control
// characters, invisible format characters (Unicode Cf: an RLO reverses how a
// name displays, a ZWSP or ZWJ makes two names look alike), percent-encoding,
// a backslash, a query or a fragment.
const UNSAFE_PATH_CHAR = /[\s\p{Cc}\p{Cf}%\\?#]/u;

/** Why a media ref is not a file path under MEDIA_PREFIX, or undefined when it is. */
function mediaRefProblem(ref: string): string | undefined {
  if (!ref.startsWith(MEDIA_PREFIX)) return `must live under ${MEDIA_PREFIX}`;
  if (UNSAFE_PATH_CHAR.test(ref)) {
    return 'must not carry whitespace, a control or invisible format character, %, \\, ? or #';
  }
  const segments = ref.slice(MEDIA_PREFIX.length).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return `must name a file under ${MEDIA_PREFIX}: no empty, "." or ".." segment, no trailing /`;
  }
  return undefined;
}

function checkMediaRef(path: string, ref: string | null | undefined, issues: SchemaIssue[]): void {
  if (ref == null) return;
  const problem = mediaRefProblem(ref);
  if (problem !== undefined) issues.push({ path, message: `media ref ${problem}, got "${ref}"` });
}

export function verifyPackRefs(pack: Pack, libraries: Libraries): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  checkMediaRef('cover_ref', pack.cover_ref, issues);
  // The libraries' media live under the same root as the pack's — one rule
  // for every path the Player might load (schema reading, minor refs).
  libraries.commons.forEach((technique, i) => {
    checkMediaRef(`commons.${String(i)}.media_ref`, technique.media_ref, issues);
  });
  libraries.states.forEach((state, i) => {
    checkMediaRef(`states.${String(i)}.visual_ref`, state.visual_ref, issues);
  });

  // P21 (v0.6): every section id is a recipe of this pack, and a recipe is
  // in at most one section, once.
  const recipeIds = new Set(pack.recipes.map((r) => r.id));
  const placed = new Map<string, number>();
  (pack.sections ?? []).forEach((section, sectionIndex) => {
    const path = `sections.${String(sectionIndex)}.recipe_ids`;
    for (const id of section.recipe_ids) {
      const earlier = placed.get(id);
      if (!recipeIds.has(id)) {
        issues.push({ path, message: `recipe_id "${id}" is not a recipe of pack "${pack.id}"` });
      } else if (earlier !== undefined) {
        const title = pack.sections?.[earlier]?.title ?? '';
        issues.push({ path, message: `recipe "${id}" is already in section ${String(earlier)} ("${title}")` });
      } else {
        placed.set(id, sectionIndex);
      }
    }
  });

  pack.recipes.forEach((recipe, recipeIndex) => {
    const base = `recipes.${String(recipeIndex)}`;
    for (const issue of verifyRecipeRefs(recipe, libraries)) {
      issues.push({ path: `${base}.${issue.path}`, message: issue.message });
    }
  });

  return issues;
}

/**
 * The checks verifyPackRefs makes on each recipe, for one recipe read on its
 * own (`parseRecipe`); issue paths start at the recipe.
 */
export function verifyRecipeRefs(recipe: Recipe, libraries: Libraries): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const commonsIds = new Set(libraries.commons.map((c) => c.id));
  const stateIds = new Set(libraries.states.map((s) => s.id));

  const ingredientIds = new Set<string>();
  recipe.ingredients.forEach((ingredient, i) => {
    if (ingredientIds.has(ingredient.id)) {
      issues.push({
        path: `ingredients.${String(i)}.id`,
        message: `duplicate ingredient id "${ingredient.id}" in recipe "${recipe.id}"`,
      });
    }
    ingredientIds.add(ingredient.id);
  });

  const stepIds = new Set<string>();
  recipe.steps.forEach((step, stepIndex) => {
    const stepPath = `steps.${String(stepIndex)}`;
    if (stepIds.has(step.id)) {
      issues.push({
        path: `${stepPath}.id`,
        message: `duplicate step id "${step.id}" in recipe "${recipe.id}"`,
      });
    }
    stepIds.add(step.id);

    for (const ref of step.ingredient_refs ?? []) {
      if (!ingredientIds.has(ref)) {
        issues.push({
          path: `${stepPath}.ingredient_refs`,
          message: `ingredient_ref "${ref}" is not an ingredient of recipe "${recipe.id}"`,
        });
      }
    }

    for (const ref of step.technique_refs ?? []) {
      if (!ref.startsWith(COMMONS_NS)) {
        issues.push({
          path: `${stepPath}.technique_refs`,
          message: `technique_ref "${ref}" must use the commons: namespace`,
        });
      } else if (!commonsIds.has(ref)) {
        issues.push({
          path: `${stepPath}.technique_refs`,
          message: `technique_ref "${ref}" not found in the commons library`,
        });
      }
    }

    for (const ref of step.state_refs ?? []) {
      if (!ref.startsWith(STATE_NS)) {
        issues.push({
          path: `${stepPath}.state_refs`,
          message: `state_ref "${ref}" must use the state: namespace`,
        });
      } else if (!stateIds.has(ref)) {
        issues.push({
          path: `${stepPath}.state_refs`,
          message: `state_ref "${ref}" not found in the states library`,
        });
      }
    }

    const recommended = step.recommended_technique_ref;
    if (recommended !== undefined && !(step.technique_refs ?? []).includes(recommended)) {
      issues.push({
        path: `${stepPath}.recommended_technique_ref`,
        message: `recommended_technique_ref "${recommended}" is not one of the step's technique_refs`,
      });
    }

    checkMediaRef(`${stepPath}.media_ref`, step.media_ref, issues);
  });

  return issues;
}
