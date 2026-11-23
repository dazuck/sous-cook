import { describe, expect, test } from 'vitest';
import {
  parsePack,
  parseRecipe,
  verifyPackRefs,
  verifyRecipeRefs,
  type Libraries,
  type Recipe,
} from '../src/index.ts';

// One recipe read on its own, by the same schema a pack's recipes use. The app
// converts a legacy recipe one row at a time (slice B4) and validates each
// before any pack holds it, so a bad row is refused with its own issues.

const NO_LIBRARIES: Libraries = { commons: [], states: [] };

function recipe(): Record<string, unknown> {
  return {
    id: 'r1',
    title: 'Dal',
    serves_base: 4,
    ingredients: [
      { id: 'ing-0', name: 'lentils', qty_canonical: { mass_g: 200 } },
      { id: 'ing-1', name: 'salt', qty_canonical: { to_taste: true } },
    ],
    steps: [
      {
        id: 'step-0',
        type: 'action',
        text: 'Simmer.',
        ingredient_refs: ['ing-0'],
      },
    ],
  };
}

function inPack(r: unknown): unknown {
  return {
    id: 'p',
    title: 'P',
    version: 1,
    creator: { name: 'C' },
    recipes: [r],
  };
}

describe('parseRecipe', () => {
  test('accepts a recipe a pack would accept, unchanged', () => {
    const result = parseRecipe(recipe());
    expect(result).toEqual({ ok: true, value: recipe() });
  });

  test.each<[string, (r: Record<string, unknown>) => void, string]>([
    ['no title', (r) => delete r['title'], 'title'],
    ['an empty title', (r) => (r['title'] = ''), 'title'],
    ['no serves_base key', (r) => delete r['serves_base'], 'serves_base'],
    ['no ingredients and no steps', (r) => ((r['ingredients'] = []), (r['steps'] = [])), '(root)'],
    [
      'an empty step',
      (r) => (r['steps'] = [{ id: 'step-0', type: 'action', text: '' }]),
      'steps.0.text',
    ],
    [
      'an ingredient with no quantity',
      (r) => (r['ingredients'] = [{ id: 'ing-0', name: 'x', qty_canonical: {} }]),
      'ingredients.0.qty_canonical',
    ],
  ])('refuses %s, with paths from the recipe', (_name, mutate, path) => {
    const r = recipe();
    mutate(r);
    const result = parseRecipe(r);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toContain(path);
  });

  test('agrees with parsePack on every case above', () => {
    const cases: unknown[] = [
      recipe(),
      { ...recipe(), title: '' },
      { ...recipe(), ingredients: [], steps: [] },
    ];
    for (const r of cases) {
      expect(parseRecipe(r).ok).toBe(parsePack(inPack(r)).ok);
    }
  });
});

describe('verifyRecipeRefs', () => {
  function parsed(r: Record<string, unknown>): Recipe {
    const result = parseRecipe(r);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.value;
  }

  test('a recipe whose refs resolve has no issues', () => {
    expect(verifyRecipeRefs(parsed(recipe()), NO_LIBRARIES)).toEqual([]);
  });

  test('a dangling ingredient_ref and a duplicate id are issues, with paths from the recipe', () => {
    const r = recipe();
    r['ingredients'] = [
      { id: 'ing-0', name: 'a', qty_canonical: { count: 1 } },
      { id: 'ing-0', name: 'b', qty_canonical: { count: 1 } },
    ];
    r['steps'] = [{ id: 'step-0', type: 'action', text: 'Go.', ingredient_refs: ['ing-9'] }];
    expect(verifyRecipeRefs(parsed(r), NO_LIBRARIES)).toEqual([
      {
        path: 'ingredients.1.id',
        message: 'duplicate ingredient id "ing-0" in recipe "r1"',
      },
      {
        path: 'steps.0.ingredient_refs',
        message: 'ingredient_ref "ing-9" is not an ingredient of recipe "r1"',
      },
    ]);
  });

  test("verifyPackRefs reports the same issues under the recipe's pack path", () => {
    const r = recipe();
    r['steps'] = [{ id: 'step-0', type: 'action', text: 'Go.', ingredient_refs: ['ing-9'] }];
    const pack = parsePack(inPack(r));
    if (!pack.ok) throw new Error(JSON.stringify(pack.issues));
    expect(verifyPackRefs(pack.value, NO_LIBRARIES)).toEqual([
      {
        path: 'recipes.0.steps.0.ingredient_refs',
        message: 'ingredient_ref "ing-9" is not an ingredient of recipe "r1"',
      },
    ]);
  });
});
