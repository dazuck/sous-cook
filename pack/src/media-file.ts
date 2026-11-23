// The publisher's half of P19 (design/pack-format-v0.md, "Media refs"): a
// media ref the schema accepted names a regular file that really lives under
// packs/media/. The path is resolved against the repo (or deploy) root with
// symlinks followed, so neither a ".." the schema would refuse anyway nor a
// symlink pointing out of packs/media/ passes. Its name must match the file's
// exactly, byte for byte, and so must every link target on the way: macOS's
// filesystem matches names through case, full case folding and Unicode
// normalisation, prod's (Linux) through none of them, so a ref that differs
// in any of those would pass here and 404 there.
//
// Node-only (node:fs), so it is not part of the package's main entry, which
// the app also bundles for the browser. A publisher calls mediaFileProblem
// before a pack ships; the app's shelf registry calls exactCaseProblem (as
// `@sous/pack/media-file`).

import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** A path's first segment not found under exactly its name: as written, and as on disk when only its case differs. */
export interface CaseProblem {
  /** The path up to and including the segment: relative to root when under it, else absolute. */
  written: string;
  /** The same, with that segment as the directory listing spells it; absent when nothing matches. */
  onDisk?: string;
  /** The link whose target text holds the segment; absent when `rel` itself does. */
  via?: string;
}

/**
 * Directory listings read so far, by resolved directory path. One validation
 * pass shares one, so each directory is listed once however many refs it
 * checks; a new pass starts a new one, so nothing goes stale between them.
 */
export type Listings = Map<string, string[]>;

/** As macOS compares names: Unicode normalisation and full case folding (ß is ss). */
const fold = (name: string): string => name.normalize('NFC').toUpperCase().toLowerCase();

/** Links followed before a walk gives up, as the kernel does (ELOOP). */
const MAX_LINKS = 40;

/**
 * Walks `rel` under `root` one segment at a time, finding each in its
 * directory's listing by exact name, and every symlink on the way by its
 * target text the same way, so the answer is the same on a case- or
 * normalisation-insensitive filesystem as on Linux. Null when every segment
 * is there under exactly its name. Anything else means no file is there
 * under exactly that name; `onDisk` says what the caller probably meant.
 * `root` itself is the caller's and isn't checked. `rel` must be plainly
 * relative: no ".", ".." or empty segment, not absolute.
 */
export function exactCaseProblem(root: string, rel: string, listings: Listings = new Map()): CaseProblem | null {
  const segments = rel.split(/[\\/]/);
  if (path.isAbsolute(rel) || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`exactCaseProblem needs a relative path with no "." or ".." segment, got "${rel}"`);
  }
  const base = realpathSync(root);
  const shown = (p: string): string => {
    const r = path.relative(base, p);
    return r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
  };
  // Each segment still to find, with the link whose target text it came from.
  const pending: { name: string; via?: string }[] = segments.map((name) => ({ name }));
  // The directory they are under, with every symlink in it resolved.
  let dir = base;
  let links = 0;
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const { name, via } = next;
    const at = path.join(dir, name);
    const problem = (onDisk?: string): CaseProblem => ({
      written: shown(at),
      ...(onDisk === undefined ? {} : { onDisk }),
      ...(via === undefined ? {} : { via }),
    });
    // From a link target only: "." stays, ".." climbs from the resolved directory, as the kernel reads it.
    if (name === '.' || name === '..') {
      if (name === '..') dir = path.dirname(dir);
      continue;
    }
    let names = listings.get(dir);
    if (names === undefined) {
      try {
        names = readdirSync(dir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // The previous segment is a file (or vanished): nothing is under it.
        if (code === 'ENOTDIR' || code === 'ENOENT') return problem();
        throw error;
      }
      listings.set(dir, names);
    }
    if (!names.includes(name)) {
      const match = names.find((n) => fold(n) === fold(name));
      return problem(match === undefined ? undefined : shown(path.join(dir, match)));
    }
    let link: string | undefined;
    try {
      link = lstatSync(at).isSymbolicLink() ? readlinkSync(at) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return problem();
      throw error;
    }
    if (link === undefined) {
      dir = at;
      continue;
    }
    if (++links > MAX_LINKS) return problem();
    // The target's own segments, read from its start (the filesystem root for
    // an absolute target), then whatever the walk still had to find.
    const from = shown(at);
    if (path.isAbsolute(link)) dir = path.parse(link).root;
    pending.unshift(...link.split('/').filter((s) => s !== '').map((s) => ({ name: s, via: from })));
  }
  return null;
}

/** Why `ref` names no regular file under `<root>/packs/media/`, or null when it does. `listings` as for exactCaseProblem. */
export function mediaFileProblem(root: string, ref: string, listings: Listings = new Map()): string | null {
  if (!ref.startsWith('/')) return `"${ref}" is not a platform-root path`;
  const target = path.resolve(root, `.${ref}`);
  const named = path.relative(root, target);
  // A ref that climbs out of root lexically is left to the containment check.
  if (named !== '' && named !== '..' && !named.startsWith(`..${path.sep}`)) {
    const problem = exactCaseProblem(root, named, listings);
    // Any problem means no file under exactly that name, whatever existsSync
    // below would say on macOS (B3 review 3).
    if (problem !== null) {
      if (problem.onDisk === undefined) return `no media file for "${ref}"`;
      const through = problem.via === undefined ? '' : ` through the link "${problem.via}"`;
      return `"${ref}" names "${problem.written}"${through}, but on disk it is "${problem.onDisk}": names must match exactly, as prod's filesystem reads them`;
    }
  }
  if (!existsSync(target)) return `no media file for "${ref}"`;
  const mediaDir = path.join(root, 'packs', 'media');
  if (!existsSync(mediaDir)) return `"${ref}" resolves outside packs/media/`;
  const mediaRoot = realpathSync(mediaDir);
  const real = realpathSync(target);
  const rel = path.relative(mediaRoot, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return `"${ref}" resolves outside packs/media/`;
  }
  if (!statSync(real).isFile()) return `"${ref}" is not a file`;
  return null;
}
