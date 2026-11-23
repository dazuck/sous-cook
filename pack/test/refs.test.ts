import { describe, expect, test } from 'vitest';
import { verifyPackRefs, type Commons, type Pack, type States } from '../src/index.ts';

function fixturePack(): Pack {
  return {
    id: 'p',
    title: 'P',
    version: '1.0',
    creator: { name: 'C' },
    cover_ref: '/packs/media/cover.jpg',
    recipes: [
      {
        id: 'r1',
        title: 'R1',
        serves_base: 4,
        ingredients: [
          { id: 'salt', name: 'salt', qty_canonical: { mass_g: 6 }, scaling: 'linear' },
        ],
        steps: [
          {
            id: 's1',
            type: 'action',
            text: 'Do the thing.',
            ingredient_refs: ['salt'],
            technique_refs: ['commons:temper-eggs'],
            state_refs: ['state:creamy'],
            media_ref: '/packs/media/s1.jpg',
          },
        ],
      },
    ],
  };
}

const commons: Commons = [{ id: 'commons:temper-eggs', name: 'Tempering eggs' }];
const states: States = [{ id: 'state:creamy', name: 'Creamy' }];

describe('verifyPackRefs', () => {
  test('a fully-wired pack has no issues', () => {
    expect(verifyPackRefs(fixturePack(), { commons, states })).toEqual([]);
  });

  test('flags an ingredient_ref not defined in the recipe', () => {
    const pack = fixturePack();
    pack.recipes[0]!.steps[0]!.ingredient_refs = ['ghost'];
    const issues = verifyPackRefs(pack, { commons, states });
    expect(issues.some((i) => i.message.includes('ghost'))).toBe(true);
  });

  test('flags a technique_ref without the commons: namespace', () => {
    const pack = fixturePack();
    pack.recipes[0]!.steps[0]!.technique_refs = ['temper-eggs'];
    const issues = verifyPackRefs(pack, { commons, states });
    expect(issues.some((i) => i.message.includes('commons:'))).toBe(true);
  });

  test('flags a technique_ref missing from the commons library', () => {
    const pack = fixturePack();
    pack.recipes[0]!.steps[0]!.technique_refs = ['commons:unknown-move'];
    const issues = verifyPackRefs(pack, { commons, states });
    expect(issues.some((i) => i.message.includes('unknown-move'))).toBe(true);
  });

  test('flags a state_ref missing from the states library', () => {
    const pack = fixturePack();
    pack.recipes[0]!.steps[0]!.state_refs = ['state:phantom'];
    const issues = verifyPackRefs(pack, { commons, states });
    expect(issues.some((i) => i.message.includes('phantom'))).toBe(true);
  });

  test('flags media refs outside /packs/media/', () => {
    const pack = fixturePack();
    pack.recipes[0]!.steps[0]!.media_ref = 'https://cdn.example.com/x.jpg';
    const issues = verifyPackRefs(pack, { commons, states });
    expect(issues.some((i) => i.path.includes('media_ref'))).toBe(true);
  });

  test('flags a commons media_ref outside /packs/media/', () => {
    const wandering: Commons = [
      { id: 'commons:temper-eggs', name: 'Tempering eggs', media_ref: 'https://cdn.example.com/t.jpg' },
    ];
    const issues = verifyPackRefs(fixturePack(), { commons: wandering, states });
    expect(issues.some((i) => i.path === 'commons.0.media_ref')).toBe(true);
  });

  test('flags a states visual_ref outside /packs/media/', () => {
    const wandering: States = [{ id: 'state:creamy', name: 'Creamy', visual_ref: 'media/creamy.jpg' }];
    const issues = verifyPackRefs(fixturePack(), { commons, states: wandering });
    expect(issues.some((i) => i.path === 'states.0.visual_ref')).toBe(true);
  });

  test('library media under /packs/media/ raises nothing', () => {
    const housed: Commons = [
      { id: 'commons:temper-eggs', name: 'Tempering eggs', media_ref: '/packs/media/temper.jpg' },
    ];
    const looked: States = [
      { id: 'state:creamy', name: 'Creamy', visual_ref: '/packs/media/creamy.jpg' },
    ];
    expect(verifyPackRefs(fixturePack(), { commons: housed, states: looked })).toEqual([]);
  });

  test('flags duplicate ingredient ids within a recipe', () => {
    const pack = fixturePack();
    pack.recipes[0]!.ingredients.push({
      id: 'salt',
      name: 'salt again',
      qty_canonical: { mass_g: 1 },
      scaling: 'linear',
    });
    const issues = verifyPackRefs(pack, { commons, states });
    expect(issues.some((i) => i.message.includes('duplicate'))).toBe(true);
  });

  test('flags duplicate step ids within a recipe', () => {
    const pack = fixturePack();
    pack.recipes[0]!.steps.push({ ...fixturePack().recipes[0]!.steps[0]! });
    const issues = verifyPackRefs(pack, { commons, states });
    expect(issues.some((i) => i.message.includes('duplicate'))).toBe(true);
  });

  // v0.3: library ids are the namespaced id, compared whole.
  test('a ref resolves only against the whole namespaced library id', () => {
    const bare: Commons = [{ id: 'temper-eggs', name: 'Tempering eggs' }];
    const issues = verifyPackRefs(fixturePack(), { commons: bare, states });
    expect(issues.map((i) => i.message)).toContain(
      'technique_ref "commons:temper-eggs" not found in the commons library',
    );
  });

  test('a state_ref never resolves against a commons entry of the same name', () => {
    const pack = fixturePack();
    pack.recipes[0]!.steps[0]!.state_refs = ['state:temper-eggs'];
    const issues = verifyPackRefs(pack, { commons, states });
    expect(issues.map((i) => i.message)).toContain(
      'state_ref "state:temper-eggs" not found in the states library',
    );
  });

  // P19: null is "not yet produced" (P3), so only a present ref is held to the prefix.
  test('null media refs raise nothing', () => {
    const pack = fixturePack();
    pack.cover_ref = null;
    pack.recipes[0]!.steps[0]!.media_ref = null;
    const unfilmed: Commons = [{ id: 'commons:temper-eggs', name: 'Tempering eggs', media_ref: null }];
    const unshot: States = [{ id: 'state:creamy', name: 'Creamy', visual_ref: null }];
    expect(verifyPackRefs(pack, { commons: unfilmed, states: unshot })).toEqual([]);
  });

  test('flags a cover_ref outside /packs/media/', () => {
    const pack = fixturePack();
    pack.cover_ref = 'https://cdn.example.com/c.jpg';
    const issues = verifyPackRefs(pack, { commons, states });
    expect(issues.map((i) => i.path)).toContain('cover_ref');
  });

  // Contract v0.2 as written: "one of THIS step's technique_refs".
  test("flags a recommended_technique_ref that is not one of the step's technique_refs", () => {
    const pack = fixturePack();
    pack.recipes[0]!.steps[0]!.recommended_technique_ref = 'commons:fold';
    const issues = verifyPackRefs(pack, { commons, states });
    expect(issues).toContainEqual({
      path: 'recipes.0.steps.0.recommended_technique_ref',
      message: `recommended_technique_ref "commons:fold" is not one of the step's technique_refs`,
    });
  });

  test("a recommended_technique_ref among the step's technique_refs raises nothing", () => {
    const pack = fixturePack();
    pack.recipes[0]!.steps[0]!.recommended_technique_ref = 'commons:temper-eggs';
    expect(verifyPackRefs(pack, { commons, states })).toEqual([]);
  });
});
