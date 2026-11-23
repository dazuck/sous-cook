import { describe, expect, test } from 'vitest';
import { parsePack, verifyPackRefs } from '../src/index.ts';
import type { Libraries, Pack } from '../src/index.ts';

// Pack Format v0.6 (slice S, lockstep): P21's optional pack.sections, the
// chapters inside a pack, in display order. Absent means one flat list in
// recipes[] order; a recipe in no section shows after the last one.

type Json = Record<string, unknown>;

const NO_LIBRARIES: Libraries = { commons: [], states: [] };

function recipe(id: string): Json {
  return {
    id,
    title: id,
    serves_base: 4,
    ingredients: [{ id: 'salt', name: 'salt', qty_canonical: { mass_g: 6 } }],
    steps: [{ id: 's1', type: 'action', text: 'Salt it.', ingredient_refs: ['salt'] }],
  };
}

function pack(sections?: unknown): Json {
  return {
    id: 'p',
    title: 'P',
    version: '1',
    creator: { name: 'C' },
    recipes: [recipe('dal'), recipe('chana'), recipe('mole')],
    ...(sections === undefined ? {} : { sections }),
  };
}

function parsed(data: Json): Pack {
  const result = parsePack(data);
  if (!result.ok) throw new Error(`expected a valid pack: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function schemaPaths(data: Json): string[] {
  const result = parsePack(data);
  if (result.ok) throw new Error('expected the pack to be refused');
  return result.issues.map((i) => i.path);
}

const refMessages = (data: Json) => verifyPackRefs(parsed(data), NO_LIBRARIES).map((i) => `${i.path}: ${i.message}`);

describe('pack.sections (P21)', () => {
  test('parses, in display order, and round-trips unknown keys', () => {
    const value = parsed(
      pack([
        { title: 'Indian', recipe_ids: ['dal', 'chana'], note: 'kept' },
        { title: 'weeknights', recipe_ids: ['mole'] },
      ]),
    );
    expect(value.sections).toEqual([
      { title: 'Indian', recipe_ids: ['dal', 'chana'], note: 'kept' },
      { title: 'weeknights', recipe_ids: ['mole'] },
    ]);
    expect(refMessages(pack(value.sections))).toEqual([]);
  });

  test('absent stays valid, and reads as no sections', () => {
    const value = parsed(pack());
    expect(value.sections).toBeUndefined();
    expect(refMessages(pack())).toEqual([]);
  });

  test('a recipe in no section is allowed', () => {
    expect(refMessages(pack([{ title: 'Indian', recipe_ids: ['dal'] }]))).toEqual([]);
  });

  test('refuses an id that is not a recipe of the pack', () => {
    expect(refMessages(pack([{ title: 'Indian', recipe_ids: ['dal', 'paneer'] }]))).toEqual([
      'sections.0.recipe_ids: recipe_id "paneer" is not a recipe of pack "p"',
    ]);
  });

  test('refuses an id in two sections', () => {
    expect(
      refMessages(
        pack([
          { title: 'Indian', recipe_ids: ['dal'] },
          { title: 'Weeknight', recipe_ids: ['chana', 'dal'] },
        ]),
      ),
    ).toEqual(['sections.1.recipe_ids: recipe "dal" is already in section 0 ("Indian")']);
  });

  test('refuses an id twice in one section', () => {
    expect(refMessages(pack([{ title: 'Indian', recipe_ids: ['dal', 'dal'] }]))).toEqual([
      'sections.0.recipe_ids: recipe "dal" is already in section 0 ("Indian")',
    ]);
  });

  test('refuses a section with an empty title, blank or invisible included', () => {
    for (const title of ['', '   ', '​']) {
      expect(schemaPaths(pack([{ title, recipe_ids: ['dal'] }]))).toContain('sections.0.title');
    }
    expect(schemaPaths(pack([{ recipe_ids: ['dal'] }]))).toContain('sections.0.title');
  });

  test('refuses a section with no ids', () => {
    expect(schemaPaths(pack([{ title: 'Indian', recipe_ids: [] }]))).toContain('sections.0.recipe_ids');
    expect(schemaPaths(pack([{ title: 'Indian' }]))).toContain('sections.0.recipe_ids');
  });

  test('refuses sections that are not a list of sections', () => {
    expect(schemaPaths(pack({ title: 'Indian', recipe_ids: ['dal'] }))).toContain('sections');
    expect(schemaPaths(pack(null))).toContain('sections');
    expect(schemaPaths(pack([{ title: 'Indian', recipe_ids: [3] }]))).toContain('sections.0.recipe_ids.0');
  });
});
