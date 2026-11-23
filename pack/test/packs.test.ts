import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseCommonsFile, parsePack, parseStatesFile, verifyPackRefs } from '../src/index.ts';
import { unitFromAlias } from '../src/quantity.ts';

// Every JSON file in packs/ is valid under the format: the two libraries
// parse, and each pack parses and resolves its refs against them. Every
// display hint in them is in a unit the reader's table knows, so none is
// silently left out at render (quantity.ts, readHints).

const repo = path.resolve(import.meta.dirname, '../..');

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(repo, rel), 'utf8'));
}

const files = readdirSync(path.join(repo, 'packs'), { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith('.json'))
  .map((e) => path.relative(repo, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
  .sort();

const LIBRARIES = ['packs/commons.json', 'packs/states.json'];

describe('the files in packs/', () => {
  const commons = parseCommonsFile(readJson('packs/commons.json'));
  const states = parseStatesFile(readJson('packs/states.json'));

  test('the commons library parses', () => {
    expect(commons).toMatchObject({ ok: true });
  });

  test('the states library parses', () => {
    expect(states).toMatchObject({ ok: true });
  });

  const packs = files.filter((rel) => !LIBRARIES.includes(rel));

  test('there is at least one pack', () => {
    expect(packs.length).toBeGreaterThan(0);
  });

  test.each(packs)('%s parses and resolves its refs', (rel) => {
    if (!commons.ok || !states.ok) throw new Error('the libraries must parse');
    const parsed = parsePack(readJson(rel));
    if (!parsed.ok) throw new Error(`${rel}: ${JSON.stringify(parsed.issues)}`);
    expect(verifyPackRefs(parsed.value, { commons: commons.value, states: states.value })).toEqual([]);
  });

  test.each(packs)('%s: every display hint is in a unit the reader knows', (rel) => {
    const parsed = parsePack(readJson(rel));
    if (!parsed.ok) throw new Error(`${rel}: ${JSON.stringify(parsed.issues)}`);
    const unknown = parsed.value.recipes.flatMap((recipe) =>
      recipe.ingredients.flatMap((ingredient) =>
        (['imperial', 'metric'] as const).flatMap((system) => {
          const hint = ingredient.display_equivalents?.[system];
          return hint === undefined || unitFromAlias(hint.unit) !== undefined
            ? []
            : [`${recipe.id}/${ingredient.id}: ${system} "${hint.unit}"`];
        }),
      ),
    );
    expect(unknown).toEqual([]);
  });
});
