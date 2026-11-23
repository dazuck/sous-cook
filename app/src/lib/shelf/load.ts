import path from "node:path";
import { readFamilyLibrary } from "../recipe-sync";
import {
  SHELF_SOURCES,
  loadPackFiles,
  loadShelf,
  type PackFiles,
  type Shelf,
  type ShelfSource,
} from "./registry";

/**
 * The repo's `packs/`, beside `app/`: the app runs from `app/` (dev, e2e and
 * the deployed function, whose Root Directory is `app`), and
 * `next.config.ts` traces `../packs/**` into the tRPC function so the files
 * are there when it runs.
 */
export const PACKS_DIR = path.resolve(process.cwd(), "..", "packs");

/**
 * The registered packs' reviewed cook plans (slice P), `app/pack-plans/`:
 * the app's own layer, kept out of `packs/` (the format's corpus).
 * `next.config.ts` traces it into the tRPC function, like `../packs`.
 */
export const PACK_PLANS_DIR = path.resolve(process.cwd(), "pack-plans");

/** The shelf as the app reads it: the registry's sources, the repo's packs, the kitchen's family library from the DB. */
export function loadAppShelf(
  kitchenId: string,
  {
    sources = SHELF_SOURCES,
    packsDir = PACKS_DIR,
  }: { sources?: readonly ShelfSource[]; packsDir?: string } = {},
): Promise<Shelf> {
  return loadShelf(sources, {
    packsDir,
    readFamilyLibrary: () => readFamilyLibrary(kitchenId),
  });
}

const packFilesBySources = new Map<readonly ShelfSource[], Promise<PackFiles>>();

/**
 * The registry's pack files as the app reads them for a `pack:` queue row
 * (slice B5d, D1), loaded once per server instance: they change only with a
 * deploy. It never throws: a load that fails (packs/ missing, an I/O error)
 * comes back with no packs and `loadError`, so a pack row reads its
 * projection, as before B5d (verify round 1). Only a load whose libraries
 * read is kept; any other is tried again on the next call.
 */
export function loadAppPackFiles({
  sources = SHELF_SOURCES,
  packsDir = PACKS_DIR,
}: { sources?: readonly ShelfSource[]; packsDir?: string } = {}): Promise<PackFiles> {
  const existing = packFilesBySources.get(sources);
  if (existing !== undefined) return existing;
  const loading = loadPackFiles(sources, { packsDir }).catch(
    (error: unknown): PackFiles => ({
      packs: [],
      errors: [],
      libraries: null,
      loadError: `the pack files didn't load: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );
  packFilesBySources.set(sources, loading);
  void loading.then((files) => {
    if (files.libraries === null && packFilesBySources.get(sources) === loading) {
      packFilesBySources.delete(sources);
    }
  });
  return loading;
}

/** Forget the kept pack files (tests). */
export function forgetPackFiles(): void {
  packFilesBySources.clear();
}
