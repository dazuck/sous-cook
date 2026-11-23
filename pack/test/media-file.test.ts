import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { exactCaseProblem, mediaFileProblem } from '../src/media-file.ts';

// The publisher's half of P19: a ref the schema accepted names a regular file
// that really is under packs/media/, symlinks resolved.
const root = mkdtempSync(path.join(tmpdir(), 'pack-media-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

mkdirSync(path.join(root, 'packs/media/sub'), { recursive: true });
mkdirSync(path.join(root, 'app'), { recursive: true });
writeFileSync(path.join(root, 'packs/media/cover.jpg'), 'x');
writeFileSync(path.join(root, 'packs/media/sub/film.mp4'), 'x');
writeFileSync(path.join(root, 'packs/commons.json'), '[]');
writeFileSync(path.join(root, 'app/.env'), 'SECRET=1');
symlinkSync(path.join(root, 'app/.env'), path.join(root, 'packs/media/env.jpg'));
symlinkSync(path.join(root, 'app'), path.join(root, 'packs/media/outside'));
symlinkSync(path.join(root, 'packs/media/cover.jpg'), path.join(root, 'packs/media/alias.jpg'));
symlinkSync('cover.jpg', path.join(root, 'packs/media/near.jpg'));
symlinkSync('../cover.jpg', path.join(root, 'packs/media/sub/up.jpg'));
// macOS's filesystem matches a name through Unicode normalisation and full
// case folding as well as plain case; Linux matches neither (B3 review 3).
writeFileSync(path.join(root, 'packs/media/straße.jpg'), 'x');
writeFileSync(path.join(root, 'packs/media/café.jpg'), 'x');
// Capital sharp s: macOS opens it for "ßx.jpg", and no fold here matches the two.
writeFileSync(path.join(root, 'packs/media/\u1e9ex.jpg'), 'x');
// Links whose target text names a real file in the wrong case: dangling on Linux.
symlinkSync('COVER.jpg', path.join(root, 'packs/media/shout.jpg'));
symlinkSync(path.join(root, 'packs/media/ALIAS.jpg'), path.join(root, 'packs/media/hop.jpg'));
symlinkSync('loop-b.jpg', path.join(root, 'packs/media/loop-a.jpg'));
symlinkSync('loop-a.jpg', path.join(root, 'packs/media/loop-b.jpg'));

describe('mediaFileProblem', () => {
  test.each([
    ['/packs/media/cover.jpg'],
    ['/packs/media/sub/film.mp4'],
    ['/packs/media/alias.jpg'],
    ['/packs/media/near.jpg'],
    ['/packs/media/sub/up.jpg'],
    ['/packs/media/straße.jpg'],
    ['/packs/media/café.jpg'],
  ])('%s names a file under packs/media/', (ref) => {
    expect(mediaFileProblem(root, ref)).toBeNull();
  });

  test.each([
    ['/packs/media/missing.jpg', 'no media file for "/packs/media/missing.jpg"'],
    ['/packs/media/sub', 'not a file'],
    ['/packs/media/', 'not a file'],
    ['/packs/media/../commons.json', 'outside packs/media/'],
    ['/packs/media/sub/../../../app/.env', 'outside packs/media/'],
    ['/packs/media/env.jpg', 'outside packs/media/'],
    ['/packs/media/outside/.env', 'outside packs/media/'],
    ['/packs/commons.json', 'outside packs/media/'],
    ['packs/media/cover.jpg', 'not a platform-root path'],
  ])('%s is refused: %s', (ref, why) => {
    expect(mediaFileProblem(root, ref)).toContain(why);
  });

  // macOS's filesystem ignores case and prod's (Linux) doesn't, so a ref in
  // the wrong case would pass here and 404 there (B3 review 2, item 3). Each
  // segment is compared with its directory's listing, so both answer alike.
  test.each([
    ['/packs/media/COVER.jpg', '"packs/media/COVER.jpg", but on disk it is "packs/media/cover.jpg"'],
    ['/packs/media/Sub/film.mp4', '"packs/media/Sub", but on disk it is "packs/media/sub"'],
    ['/packs/Media/cover.jpg', '"packs/Media", but on disk it is "packs/media"'],
    ['/packs/media/alias.JPG', '"packs/media/alias.JPG", but on disk it is "packs/media/alias.jpg"'],
  ])('%s is refused for its case', (ref, why) => {
    expect(mediaFileProblem(root, ref)).toBe(`"${ref}" names ${why}: names must match exactly, as prod's filesystem reads them`);
  });

  // B3 review 3: a name no plain lowercase comparison matches still resolves
  // on macOS, through full case folding (ß is ss) or Unicode normalisation
  // (NFC é against an NFD file), and so does a link whose target text is in
  // the wrong case. Each is missing on Linux, so each is refused here.
  test.each([
    ['/packs/media/STRASSE.jpg', '"packs/media/STRASSE.jpg", but on disk it is "packs/media/straße.jpg"'],
    ['/packs/media/café.jpg', '"packs/media/café.jpg", but on disk it is "packs/media/café.jpg"'],
    [
      '/packs/media/shout.jpg',
      '"packs/media/COVER.jpg" through the link "packs/media/shout.jpg", but on disk it is "packs/media/cover.jpg"',
    ],
    [
      '/packs/media/hop.jpg',
      '"packs/media/ALIAS.jpg" through the link "packs/media/hop.jpg", but on disk it is "packs/media/alias.jpg"',
    ],
  ])('%s is refused for a name macOS matches and Linux does not', (ref, why) => {
    expect(mediaFileProblem(root, ref)).toBe(`"${ref}" names ${why}: names must match exactly, as prod's filesystem reads them`);
  });

  // A name with no exact match and no folded one either is still missing on
  // Linux, though macOS opens it: any exact-name problem refuses the ref, not
  // only one that names a file on disk (B3 review 4).
  test('a name macOS opens with no on-disk match, even folded, names no file', () => {
    expect(mediaFileProblem(root, '/packs/media/ßx.jpg')).toBe('no media file for "/packs/media/ßx.jpg"');
  });

  test('a link loop names no file', () => {
    expect(mediaFileProblem(root, '/packs/media/loop-a.jpg')).toBe('no media file for "/packs/media/loop-a.jpg"');
  });

  // One validation pass lists each directory once, however many refs it
  // checks (B3 review 3: 1000 refs in a 5000-file folder took 1.9 s).
  test('a shared listing cache reads each directory once', () => {
    const reads: string[] = [];
    const listings = new (class extends Map<string, string[]> {
      override set(dir: string, names: string[]): this {
        reads.push(dir);
        return super.set(dir, names);
      }
    })();
    for (const ref of ['/packs/media/cover.jpg', '/packs/media/near.jpg', '/packs/media/sub/film.mp4', '/packs/media/x.jpg']) {
      mediaFileProblem(root, ref, listings);
    }
    expect(new Set(reads).size).toBe(reads.length);
    expect(reads.map((dir) => path.relative(realpathSync(root), dir))).toEqual(['', 'packs', 'packs/media', 'packs/media/sub']);
  });

  test('with no packs/media/ at all, nothing is a media file', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'pack-media-bare-'));
    try {
      mkdirSync(path.join(bare, 'packs'));
      writeFileSync(path.join(bare, 'packs/commons.json'), '[]');
      expect(mediaFileProblem(bare, '/packs/media/cover.jpg')).toBe('no media file for "/packs/media/cover.jpg"');
      expect(mediaFileProblem(bare, '/packs/media/../commons.json')).toContain('outside packs/media/');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('exactCaseProblem', () => {
  test('null when every segment is named exactly as on disk', () => {
    expect(exactCaseProblem(root, 'packs/media/sub/film.mp4')).toBeNull();
  });

  test('names the first segment whose case differs, as written and as on disk', () => {
    expect(exactCaseProblem(root, 'packs/MEDIA/SUB/film.mp4')).toEqual({
      written: 'packs/MEDIA',
      onDisk: 'packs/media',
    });
  });

  test('names a missing segment with no on-disk name', () => {
    expect(exactCaseProblem(root, 'packs/media/nope/film.mp4')).toEqual({ written: 'packs/media/nope' });
  });

  test('a segment under a file is missing, not an error', () => {
    expect(exactCaseProblem(root, 'packs/media/cover.jpg/x')).toEqual({ written: 'packs/media/cover.jpg/x' });
  });

  test('refuses a path that is not plainly relative', () => {
    expect(() => exactCaseProblem(root, '../x')).toThrow('a relative path with no "." or ".." segment');
    expect(() => exactCaseProblem(root, '/packs/x')).toThrow('a relative path with no "." or ".." segment');
  });
});
