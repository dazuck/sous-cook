import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  parseCommonsFile,
  parsePack,
  parseStatesFile,
  verifyPackRefs,
  type Libraries,
  type Pack,
  type ParseResult,
  type Recipe,
  type SchemaIssue,
} from "@sous/pack";
import {
  exactCaseProblem,
  type CaseProblem,
  type Listings,
} from "@sous/pack/media-file";
import { legacyToPackRecipe, readLegacyRecipe, storedEstimate } from "../pack-convert/convert";
import type { FamilyLibraryRow } from "../recipe-sync";

/**
 * The shelf's pack sources: config-listed pack files (slice B3a) and the
 * family library as the household pack (`family-doc`, slice B4), each
 * validated whole by `@sous/pack` and each failing on its own. The shelf (S)
 * reads this through `getShelf` and `getPack` (slice S).
 */
export interface PackFileSource {
  type: "pack-file";
  /** Relative to `packs/`, e.g. "drafts/fannie-farmer-1896.pack.json". */
  path: string;
}

/**
 * The family library (`doc_recipes`), converted at read time into the
 * household pack (B4 decision 2). Its rows come from the caller's
 * `readFamilyLibrary`.
 */
export interface FamilyDocSource {
  type: "family-doc";
}

export interface ShelfSource {
  id: string;
  source: PackFileSource | FamilyDocSource;
}

/**
 * The household pack first, then Fannie Farmer (cookpacks-shelf decision 5;
 * PLAN's shelf order puts the household pack first).
 */
export const SHELF_SOURCES: readonly ShelfSource[] = [
  { id: "household-book", source: { type: "family-doc" } },
  {
    id: "fannie-farmer-1896",
    source: { type: "pack-file", path: "drafts/fannie-farmer-1896.pack.json" },
  },
];

/**
 * The shelf with no recipe library connected (`lib/hooks/connected.ts`): the
 * pack files alone, so no household book is read or drawn. One array, so the
 * loaders' per-sources caches hold.
 */
export const PACK_FILE_SOURCES: readonly ShelfSource[] = SHELF_SOURCES.filter(
  (source) => source.source.type === "pack-file",
);

/**
 * The household pack's own fields (B4 "Pack fields"). `creator.name` is
 * required by the format and not rendered; there is no price and no cover.
 */
export const HOUSEHOLD_PACK = {
  id: "household-book",
  title: "Household Book",
  kind: "household",
  creator: { name: "Household Book" },
} as const;

/**
 * Reads the family library: every `doc_recipes` row, failed extractions
 * included, in Doc order (`doc_position`, rows with none last, then by name;
 * `readFamilyLibrary` in recipe-sync). The household pack keeps the
 * reader's order. Injected so the shelf's loading is tested without a
 * database; the shelf's procedures pass the DB query.
 */
export type FamilyLibraryReader = () => Promise<readonly FamilyLibraryRow[]>;

/** The format the shelf validates against, as its errors name it. */
const FORMAT = "Pack Format v0.7";

/**
 * Why a family recipe isn't cooked from (S-D8): the converter refused it
 * (B4b's no-estimate case included), or its extraction failed on the last
 * Refresh.
 */
export type MissingReason = "refused" | "unread";

/** One row of the family book in its chapter: a recipe that cooks, or one that didn't come through. */
export interface HouseholdRow {
  /** The row's `docSlug`, which is its recipe's id in the household pack. */
  id: string;
  /** The `doc_recipes.id` UUID, for share links in sign-in mode. */
  docRecipeId?: string;
  name: string;
  missing: MissingReason | null;
  isPrivate?: boolean;
}

export interface HouseholdChapter {
  /** The chapter as the Doc writes it; null for rows in no chapter. */
  title: string | null;
  rows: HouseholdRow[];
}

/**
 * The family book as the Doc lays it out, every row named, whatever loaded
 * (S-D8): the household pack holds only the recipes that cook, and this is
 * where a recipe that didn't come through keeps its place in its chapter.
 * `state` is "unreadable" when the library couldn't be read (or the pack
 * failed whole), "empty" when it holds no recipe that cooks.
 */
export interface HouseholdLayout {
  state: "ok" | "empty" | "unreadable";
  /** The newest row's sync; null with no rows. */
  syncedAt: Date | null;
  chapters: HouseholdChapter[];
}

export interface KitchenPackRecord {
  id: string;
  packId?: string;
  packJson: unknown;
  isOwned: boolean;
  fromKitchenName: string | null;
}

export type KitchenPacksReader = () => Promise<readonly KitchenPackRecord[]>;

export interface ShelfPack {
  sourceId: string;
  pack: Pack;
  isOwned?: boolean;
  fromKitchenName?: string | null;
  kitchenPackId?: string;
}

export interface ShelfError {
  sourceId: string;
  /** Present once the file held an object with a string `id`. */
  packId?: string;
  /**
   * A household recipe that failed on its own (its `docSlug`): the rest of
   * the pack still loads.
   */
  recipeId?: string;
  /** That recipe's name, its chapter and why it didn't come through (S-D8). */
  recipeName?: string;
  section?: string | null;
  missing?: MissingReason;
  reason: string;
  issues: SchemaIssue[];
}

export interface Shelf {
  packs: ShelfPack[];
  errors: ShelfError[];
  /** The family book's layout, once a `family-doc` source has been read. */
  household?: HouseholdLayout;
}

type Read = { ok: true; data: unknown } | { ok: false; reason: string };

function fileError(error: unknown, shown: string): string {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
    ? `file not found: ${shown}`
    : `file unreadable: ${shown}: ${(error as Error).message}`;
}

async function readJson(file: string, shown: string): Promise<Read> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return { ok: false, reason: fileError(error, shown) };
  }
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, reason: `not valid JSON: ${(error as Error).message}` };
  }
}

export type LibraryLoad =
  { ok: true; libraries: Libraries } | { ok: false; issues: SchemaIssue[] };

/**
 * Both platform libraries, read once. A missing, non-JSON or invalid library
 * fails the load: refs can't be checked without it, and the shelf never
 * shows a pack whose refs went unchecked.
 */
export async function loadLibraries(packsDir: string): Promise<LibraryLoad> {
  const issues: SchemaIssue[] = [];
  async function one<T>(
    file: string,
    parse: (data: unknown) => ParseResult<T>,
  ): Promise<T | undefined> {
    const read = await readJson(path.join(packsDir, file), `packs/${file}`);
    if (!read.ok) {
      issues.push({ path: file, message: read.reason });
      return undefined;
    }
    const parsed = parse(read.data);
    if (!parsed.ok) {
      issues.push(
        ...parsed.issues.map((issue) => ({
          path: `${file}:${issue.path}`,
          message: issue.message,
        })),
      );
      return undefined;
    }
    return parsed.value;
  }
  const commons = await one("commons.json", parseCommonsFile);
  const states = await one("states.json", parseStatesFile);
  if (commons === undefined || states === undefined)
    return { ok: false, issues };
  return { ok: true, libraries: { commons, states } };
}

function idOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

type SourceLoad = { ok: true; pack: Pack } | { ok: false; error: ShelfError };

/**
 * Whether a path relative to packs/ leaves it. Segment-aware: "..x.json" is
 * a file inside packs/, "../x.json" and ".." are not.
 */
function leaves(relative: string): boolean {
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

/**
 * `packsDir` and `packsReal` name one directory: as the caller gave it, and
 * with every symlink resolved. The path is checked twice: as written, so the
 * registry can't name a file outside packs/, and as resolved, so a symlink
 * inside packs/ can't lead out of it.
 */
async function loadPackFile(
  sourceId: string,
  source: PackFileSource,
  {
    packsDir,
    packsReal,
    listings,
  }: { packsDir: string; packsReal: string; listings: Listings },
  libraries: Libraries,
): Promise<SourceLoad> {
  const outside: SourceLoad = {
    ok: false,
    error: {
      sourceId,
      reason: `path "${source.path}" is outside packs/`,
      issues: [],
    },
  };
  const named = path.resolve(packsDir, source.path);
  const relative = path.relative(packsDir, named);
  if (leaves(relative)) return outside;

  // Each segment found by its exact name in its directory's listing, link
  // targets included, before anything opens the file: macOS's filesystem
  // matches through case, case folding and Unicode normalisation and prod's
  // (Linux) matches none of them, so such a path loads here and is missing
  // there. A segment with no exact name is missing, whatever this machine
  // would open; a folder that can't be listed fails this source alone.
  const shown = `packs/${relative}`;
  if (relative !== "") {
    let wrongCase: CaseProblem | null;
    try {
      wrongCase = exactCaseProblem(packsDir, relative, listings);
    } catch (error) {
      return {
        ok: false,
        error: { sourceId, reason: fileError(error, shown), issues: [] },
      };
    }
    if (wrongCase !== null) {
      const { written, onDisk, via } = wrongCase;
      const link = via === undefined ? "" : ` through the link "${via}"`;
      const reason =
        onDisk === undefined
          ? `file not found: ${shown}`
          : `path "${source.path}": "${written}"${link} is "${onDisk}" on disk; names must match exactly, as prod's filesystem reads them`;
      return { ok: false, error: { sourceId, reason, issues: [] } };
    }
  }

  let file: string;
  try {
    file = await realpath(named);
  } catch (error) {
    return {
      ok: false,
      error: { sourceId, reason: fileError(error, shown), issues: [] },
    };
  }
  if (leaves(path.relative(packsReal, file))) return outside;

  const read = await readJson(file, shown);
  if (!read.ok) {
    return { ok: false, error: { sourceId, reason: read.reason, issues: [] } };
  }
  return validatePack(sourceId, read.data, libraries);
}

/** One pack, whole: the format's schema, then its refs against the libraries. */
export function validatePack(
  sourceId: string,
  data: unknown,
  libraries: Libraries,
): SourceLoad {
  const packId = idOf(data);
  const parsed = parsePack(data);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        sourceId,
        ...(packId === undefined ? {} : { packId }),
        reason: `not a valid pack (${FORMAT})`,
        issues: parsed.issues,
      },
    };
  }

  const refIssues = verifyPackRefs(parsed.value, libraries);
  if (refIssues.length > 0) {
    return {
      ok: false,
      error: {
        sourceId,
        packId: parsed.value.id,
        reason: "refs don't resolve against the platform libraries",
        issues: refIssues,
      },
    };
  }
  return { ok: true, pack: parsed.value };
}

/**
 * The household pack, converted from the family library at read time. Each
 * row is read (`readLegacyRecipe`) and converted on its own: a recipe that
 * fails goes to `recipeErrors` with its slug and name and the rest load (B4
 * failure table; S-D8). A row whose extraction failed on the last Refresh
 * is never converted: it is reported as one that didn't come through. The
 * pack's chapters are the Doc's category tabs in Doc order (`sections`,
 * format P21, S-D9/S-D10), and `recipes[]` follows them. The pack itself
 * then validates whole like any other. An unreadable or empty library, or
 * one where no recipe converts, is a source error; the layout
 * (`HouseholdLayout`) still names every row, so the shelf can say what it
 * holds whatever happened.
 */
async function loadFamilyDoc(
  sourceId: string,
  readFamilyLibrary: FamilyLibraryReader,
  libraries: Libraries,
): Promise<{ load: SourceLoad; recipeErrors: ShelfError[]; layout: HouseholdLayout }> {
  const packId = HOUSEHOLD_PACK.id;
  const sourceError = (reason: string): SourceLoad => ({
    ok: false,
    error: { sourceId, packId, reason, issues: [] },
  });

  let rows: readonly FamilyLibraryRow[];
  try {
    rows = await readFamilyLibrary();
  } catch (error) {
    return {
      load: sourceError(
        `family library unreadable: ${(error as Error).message}`,
      ),
      recipeErrors: [],
      layout: { state: "unreadable", syncedAt: null, chapters: [] },
    };
  }
  const syncedAt =
    rows.length === 0 ? null : new Date(Math.max(...rows.map((row) => row.syncedAt.getTime())));
  if (rows.length === 0) {
    return {
      load: sourceError("family library is empty"),
      recipeErrors: [],
      layout: { state: "empty", syncedAt, chapters: [] },
    };
  }

  const converted = new Map<string, Recipe>();
  const recipeErrors: ShelfError[] = [];
  const missing = new Map<string, MissingReason>();
  for (const row of rows) {
    const recipeId = row.docSlug;
    const named = {
      sourceId,
      packId,
      recipeId,
      recipeName: row.name,
      section: chapterTitle(row),
    };
    if (row.extractionError !== null) {
      missing.set(recipeId, "unread");
      recipeErrors.push({
        ...named,
        missing: "unread",
        reason: `extraction failed on the last Refresh: ${row.extractionError}`,
        issues: [],
      });
      continue;
    }
    const legacy = readLegacyRecipe(row);
    if (!legacy.ok) {
      missing.set(recipeId, "refused");
      recipeErrors.push({
        ...named,
        missing: "refused",
        reason: "recipe row unreadable (not the stored recipe shape)",
        issues: legacy.issues,
      });
      continue;
    }
    // Sous's estimate rides beside the stored source (slice B4b): a recipe
    // that states no count and has none is refused here with its reason.
    const result = legacyToPackRecipe(legacy.value, {
      id: recipeId,
      servesEstimate: storedEstimate(row),
    });
    if (!result.ok) {
      missing.set(recipeId, "refused");
      recipeErrors.push({
        ...named,
        missing: "refused",
        reason: `not a valid recipe (${FORMAT})`,
        issues: result.issues,
      });
      continue;
    }
    converted.set(recipeId, result.recipe);
  }

  const chapters = householdChapters(rows, missing);
  const layout: HouseholdLayout = {
    state: converted.size === 0 ? "empty" : "ok",
    syncedAt,
    chapters,
  };
  if (converted.size === 0) {
    return {
      load: sourceError(
        `no recipe in the family library converted (${rows.length} failed)`,
      ),
      recipeErrors,
      layout,
    };
  }

  // The chapters that hold a recipe that cooks, as sections; recipes[] in
  // the same order, a recipe in no chapter after the last.
  const cooks = (chapter: HouseholdChapter) =>
    chapter.rows.filter((r) => r.missing === null).map((r) => r.id);
  const sections = chapters
    .filter((chapter) => chapter.title !== null && cooks(chapter).length > 0)
    .map((chapter) => ({ title: chapter.title as string, recipe_ids: cooks(chapter) }));
  const recipes = chapters.flatMap((chapter) => cooks(chapter).map((id) => converted.get(id)!));

  const pack = {
    ...HOUSEHOLD_PACK,
    creator: { ...HOUSEHOLD_PACK.creator },
    version: (syncedAt as Date).toISOString(),
    recipes,
    ...(sections.length > 0 && { sections }),
  };
  const load = validatePack(sourceId, pack, libraries);
  return {
    load,
    recipeErrors,
    layout: load.ok ? layout : { state: "unreadable", syncedAt, chapters: [] },
  };
}

/**
 * A family recipe's chapter: its nearest category tab's title as the Doc
 * writes it, else the lowercase key a row synced before the title was kept
 * carries, else none.
 */
function chapterTitle(row: FamilyLibraryRow): string | null {
  const title = visible(row.categoryTitle) || visible(row.category);
  return title === "" ? null : title;
}

/**
 * A title as written, trimmed, if it shows anything: at least one character
 * that is neither whitespace nor an invisible format character (Unicode Cf:
 * ZWSP, ZWJ…). A title of nothing else is no title, so its rows are in no
 * chapter (P21's absent rule) rather than a section the format refuses,
 * which would take the whole family book down with it. Nothing is stripped
 * from a title that shows: an emoji's ZWJ sequence ("👨‍🍳") stays whole.
 */
function visible(title: string | null): string {
  const trimmed = (title ?? "").trim();
  return /[^\s\p{Cf}]/u.test(trimmed) ? trimmed : "";
}

/**
 * The family rows grouped into chapters, in the reader's order (Doc order,
 * rows with no place last): a chapter appears where its first row does,
 * keyed by its title in any case, so two category tabs of one name under
 * different parents are one chapter (the key `category` already is). Rows in
 * no chapter come after the last one.
 */
function householdChapters(
  rows: readonly FamilyLibraryRow[],
  missing: ReadonlyMap<string, MissingReason>,
): HouseholdChapter[] {
  const titled = new Map<string, HouseholdChapter>();
  const none: HouseholdChapter = { title: null, rows: [] };
  for (const row of rows) {
    const title = chapterTitle(row);
    const entry: HouseholdRow = {
      id: row.docSlug,
      docRecipeId: row.id,
      name: row.name,
      missing: missing.get(row.docSlug) ?? null,
      isPrivate: row.isPrivate,
    };
    if (title === null) {
      none.rows.push(entry);
      continue;
    }
    const key = title.toLowerCase();
    let chapter = titled.get(key);
    if (chapter === undefined) {
      chapter = { title, rows: [] };
      titled.set(key, chapter);
    }
    chapter.rows.push(entry);
  }
  return [...titled.values(), ...(none.rows.length > 0 ? [none] : [])];
}

function notRead(source: ShelfSource["source"]): string {
  return source.type === "pack-file"
    ? `path "${source.path}" not read`
    : "family library not read";
}

/**
 * Loads every source, in registry order. A source that fails is reported in
 * `errors` (and logged with its pack id) and contributes nothing; the others
 * still load. A pack file is all or nothing: never partly loaded. The
 * household pack is the one exception: a family recipe that fails is
 * reported with its slug (`recipeId`) and the pack loads without it. Of two
 * sources with one id, or two packs with one pack id, the first loads and
 * the later is refused.
 *
 * `packsDir` is the directory `packs/` resolves to; the caller owns it (the
 * shelf route resolves it and traces `../packs/**` into its function).
 * `readFamilyLibrary` is called once per `family-doc` source, and only once
 * the libraries have loaded.
 */
export async function loadShelf(
  sources: readonly ShelfSource[],
  {
    packsDir,
    readFamilyLibrary,
    readKitchenPacks,
  }: {
    packsDir: string;
    readFamilyLibrary: FamilyLibraryReader;
    readKitchenPacks?: KitchenPacksReader;
  },
): Promise<Shelf> {
  const packs: ShelfPack[] = [];
  const errors: ShelfError[] = [];
  let household: HouseholdLayout | undefined;
  const fail = (error: ShelfError) => {
    errors.push(error);
    const pack = error.packId === undefined ? "" : ` (pack ${error.packId})`;
    const recipe =
      error.recipeId === undefined ? "" : ` recipe ${error.recipeId}`;
    console.error(
      `[shelf] source ${error.sourceId}${pack}${recipe}: ${error.reason}`,
      error.issues,
    );
  };

  const libraries = await loadLibraries(packsDir);
  // Resolved on first use, once the libraries have been read from packsDir.
  let packsReal: string | undefined;
  // One listing per directory for the whole load, not one per source.
  const listings: Listings = new Map();

  const sourceIds = new Set<string>();
  const loadedFrom = new Map<string, string>();
  for (const source of sources) {
    // A second source with one id is refused before it is read: a source id
    // names one source, and two can't share it.
    if (sourceIds.has(source.id)) {
      fail({
        sourceId: source.id,
        reason: `duplicate source id "${source.id}": an earlier source already has it (${notRead(source.source)})`,
        issues: [],
      });
      continue;
    }
    sourceIds.add(source.id);
    if (!libraries.ok) {
      fail({
        sourceId: source.id,
        reason: "libraries unreadable",
        issues: libraries.issues,
      });
      continue;
    }

    let load: SourceLoad;
    if (source.source.type === "family-doc") {
      const family = await loadFamilyDoc(
        source.id,
        readFamilyLibrary,
        libraries.libraries,
      );
      family.recipeErrors.forEach(fail);
      household = family.layout;
      load = family.load;
    } else {
      packsReal ??= await realpath(packsDir);
      load = await loadPackFile(
        source.id,
        source.source,
        { packsDir, packsReal, listings },
        libraries.libraries,
      );
    }
    if (!load.ok) {
      fail(load.error);
      continue;
    }
    const earlier = loadedFrom.get(load.pack.id);
    if (earlier !== undefined) {
      fail({
        sourceId: source.id,
        packId: load.pack.id,
        reason: `duplicate pack id "${load.pack.id}": source "${earlier}" already loaded it`,
        issues: [],
      });
      continue;
    }
    loadedFrom.set(load.pack.id, source.id);
    packs.push({ sourceId: source.id, pack: load.pack });
  }

  if (readKitchenPacks && libraries.ok) {
    let records: readonly KitchenPackRecord[];
    try {
      records = await readKitchenPacks();
    } catch (error) {
      fail({
        sourceId: "kitchen-packs",
        reason: `kitchen packs unreadable: ${error instanceof Error ? error.message : String(error)}`,
        issues: [],
      });
      return { packs, errors, ...(household && { household }) };
    }
    for (const record of records) {
      const sourceId = `${record.isOwned ? "owned" : "shared"}:${record.id}`;
      const load = validatePack(sourceId, record.packJson, libraries.libraries);
      if (!load.ok) {
        fail(load.error);
        continue;
      }
      if (load.pack.kind === "household") {
        fail({
          sourceId,
          packId: load.pack.id,
          reason: "kitchen pack cannot have kind \"household\"",
          issues: [],
        });
        continue;
      }
      const earlier = loadedFrom.get(load.pack.id);
      if (earlier !== undefined) {
        fail({
          sourceId,
          packId: load.pack.id,
          reason: `duplicate pack id "${load.pack.id}": source "${earlier}" already loaded it`,
          issues: [],
        });
        continue;
      }
      loadedFrom.set(load.pack.id, sourceId);
      packs.push({
        sourceId,
        pack: load.pack,
        isOwned: record.isOwned,
        fromKitchenName: record.fromKitchenName,
        kitchenPackId: record.id,
      });
    }
  }

  return { packs, errors, ...(household && { household }) };
}

export interface PackMeta {
  isOwned: boolean;
  fromKitchenName: string | null;
  kitchenPackId: string;
}

/** The pack files the registry lists, loaded and checked, with the libraries their refs resolve in. */
export interface PackFiles {
  packs: Pack[];
  errors: ShelfError[];
  /** Null when the libraries couldn't be read: then no pack loaded either. */
  libraries: Libraries | null;
  /** Why nothing loaded, when the load itself failed (`loadAppPackFiles`). */
  loadError?: string;
  /** Ownership/sharing metadata keyed by `pack.id`, present when loaded for a kitchen. */
  packMeta?: ReadonlyMap<string, PackMeta>;
}

/**
 * Only the registry's pack files (slice B5d, B5.md §B5d D1): what a `pack:`
 * queue row reads natively. The family library is never read, so opening a
 * cook costs no DB query for the household pack. Each pack is validated whole
 * and its refs checked, exactly as the shelf loads it.
 */
export async function loadPackFiles(
  sources: readonly ShelfSource[],
  { packsDir }: { packsDir: string },
): Promise<PackFiles> {
  const shelf = await loadShelf(
    sources.filter((source) => source.source.type === "pack-file"),
    {
      packsDir,
      readFamilyLibrary: () => {
        throw new Error("loadPackFiles never reads the family library");
      },
    },
  );
  const libraries = await loadLibraries(packsDir);
  return {
    packs: shelf.packs.map((entry) => entry.pack),
    errors: shelf.errors,
    libraries: libraries.ok ? libraries.libraries : null,
  };
}
