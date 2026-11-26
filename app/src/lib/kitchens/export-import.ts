import { asc, eq } from "drizzle-orm";
import * as schema from "../../../drizzle/schema";
import {
  db,
  docRecipes,
  kitchenCookLog,
  kitchenIdeas,
  kitchenPantryItems,
  kitchenPantrySections,
  kitchenQueue,
  kitchenShoppingList,
  kitchens,
  type ChatRecipeIngredient,
  type CookLogRef,
  type FinishedBy,
  type KitchenQueueRecipeData,
  type KitchenQueueStatus,
} from "../db";
import type { CookPlan } from "../kitchen/cook-plan";
import { shopItemKey } from "../shopping-list-format";
import { KitchenAdminError, type AdminDb } from "./admin";

export const KITCHEN_EXPORT_FORMAT = 1 as const;

const TOP_LEVEL_KEYS = new Set([
  "format",
  "about",
  "recipes",
  "queue",
  "cookLog",
  "pantry",
  "shoppingList",
  "ideas",
]);

const PANTRY_SECTION_KEYS = new Set(["rawHeading", "items"]);

const RECIPE_KEYS = new Set([
  "docSlug",
  "name",
  "category",
  "categoryTitle",
  "docPosition",
  "ingredients",
  "steps",
  "estimatedTime",
  "serves",
  "tags",
  "notes",
  "stepIngredients",
  "rawDocText",
  "extractionError",
  "syncedAt",
  "servesEstimate",
  "servesEstimateBasis",
  "servesEstimateSourceHash",
  "cookPlan",
  "cookPlanError",
  "cookPlanSourceHash",
  "cookPlanStamp",
  "isPrivate",
]);

const QUEUE_KEYS = new Set([
  "recipeNotionId",
  "recipeData",
  "status",
  "createdAt",
  "cookPlan",
  "cookPlanError",
  "startedAt",
  "completedAt",
  "cookLog",
  "cookLogError",
  "ratingClosedAt",
  "servesEstimate",
  "servesEstimateBasis",
  "servesEstimateSourceHash",
  "intakeRecipe",
  "intakeError",
  "intakeSourceHash",
  "intakeStamp",
  "intakeAttempts",
  "intakeNudges",
  "finishedBy",
  "lastScreenActiveAt",
  "lastInteractionAt",
  "isPrivate",
]);

const COOK_LOG_KEYS = new Set([
  "docSlug",
  "packSource",
  "recipeSnapshot",
  "recipeTitle",
  "timestampText",
  "cookedDay",
  "cookedAt",
  "rating",
  "notes",
  "noteUpdatedAt",
]);

const RECIPE_DATA_KEYS = new Set([
  "name",
  "ingredients",
  "steps",
  "estimatedTime",
  "serves",
  "tags",
  "notes",
  "stepIngredients",
  "source",
]);

const INGREDIENT_KEYS = new Set(["item", "amount", "unit"]);
const ESTIMATED_TIME_KEYS = new Set(["active", "passive", "total"]);
const COOK_LOG_REF_KEYS = new Set(["row", "timestamp", "recipeName", "adopted"]);

const QUEUE_STATUSES = new Set<KitchenQueueStatus>([
  "pending",
  "cooking",
  "completed",
  "cancelled",
]);

const FINISHED_BY_VALUES = new Set<FinishedBy>(["pressed", "auto"]);

const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

const ABOUT_MAX_CHARS = 2000;
const INSERT_BATCH_SIZE = 100;

export interface ExportedRecipe {
  docSlug: string;
  name: string;
  category: string | null;
  categoryTitle: string | null;
  docPosition: number | null;
  ingredients: ChatRecipeIngredient[] | null;
  steps: string[] | null;
  estimatedTime: { active?: number; passive?: number; total?: number } | null;
  serves: number | null;
  tags: string[] | null;
  notes: string | null;
  stepIngredients: number[][] | null;
  rawDocText: string;
  extractionError: string | null;
  syncedAt: string;
  servesEstimate: number | null;
  servesEstimateBasis: string | null;
  servesEstimateSourceHash: string | null;
  cookPlan: CookPlan | null;
  cookPlanError: string | null;
  cookPlanSourceHash: string | null;
  cookPlanStamp: string | null;
  isPrivate: boolean;
}

export interface ExportedQueueItem {
  recipeNotionId: string | null;
  recipeData: KitchenQueueRecipeData | null;
  status: KitchenQueueStatus;
  createdAt: string;
  cookPlan: CookPlan | null;
  cookPlanError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cookLog: CookLogRef | null;
  cookLogError: string | null;
  ratingClosedAt: string | null;
  servesEstimate: number | null;
  servesEstimateBasis: string | null;
  servesEstimateSourceHash: string | null;
  intakeRecipe: KitchenQueueRecipeData | null;
  intakeError: string | null;
  intakeSourceHash: string | null;
  intakeStamp: string | null;
  intakeAttempts: number | null;
  intakeNudges: string[] | null;
  finishedBy: FinishedBy | null;
  lastScreenActiveAt: string | null;
  lastInteractionAt: string | null;
  isPrivate: boolean;
}

export interface ExportedCookLogEntry {
  docSlug: string | null;
  packSource: string | null;
  recipeSnapshot: KitchenQueueRecipeData | null;
  recipeTitle: string;
  timestampText: string;
  cookedDay: string;
  cookedAt: string;
  rating: number | null;
  notes: string;
  noteUpdatedAt: string | null;
}

export interface ExportedPantrySection {
  rawHeading: string;
  items: string[];
}

export interface KitchenExportV1 {
  format: typeof KITCHEN_EXPORT_FORMAT;
  about?: string;
  recipes?: ExportedRecipe[];
  queue?: ExportedQueueItem[];
  cookLog?: ExportedCookLogEntry[];
  pantry?: ExportedPantrySection[];
  shoppingList?: string[];
  ideas?: string[];
}

export interface CanonicalKitchenExportV1 {
  format: typeof KITCHEN_EXPORT_FORMAT;
  about: string;
  recipes: ExportedRecipe[];
  queue: ExportedQueueItem[];
  cookLog: ExportedCookLogEntry[];
  pantry: ExportedPantrySection[];
  shoppingList: string[];
  ideas: string[];
}

export interface ExportKitchenResult {
  kitchenSlug: string;
  data: CanonicalKitchenExportV1;
  json: string;
  counts: {
    about: boolean;
    recipes: number;
    queue: number;
    cookLog: number;
    pantry: number;
    shoppingList: number;
    ideas: number;
  };
}

export interface ImportKitchenResult {
  kitchenSlug: string;
  dryRun: boolean;
  about: {
    included: boolean;
    updated: boolean;
  };
  recipes: {
    total: number;
    inserted: number;
    skipped: number;
  };
  queue: {
    total: number;
    inserted: number;
    skipped: number;
  };
  cookLog: {
    total: number;
    inserted: number;
    skipped: number;
  };
  pantry: {
    total: number;
    inserted: number;
    skipped: number;
    sectionsInserted: number;
  };
  shoppingList: {
    total: number;
    inserted: number;
    skipped: number;
  };
  ideas: {
    total: number;
    inserted: number;
    skipped: number;
  };
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes a JSON value with deterministic object key order so PostgreSQL
 * `jsonb` key reordering never causes round-trip export diffs.
 */
export function canonicalizeJsonValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "number") {
    return (Object.is(value, -0) ? 0 : value) as T;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : canonicalizeJsonValue(item),
    ) as T;
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort(compareStrings)) {
    const entry = obj[key];
    if (entry !== undefined) {
      sorted[key] = canonicalizeJsonValue(entry);
    }
  }
  return sorted as T;
}

function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

function fail(path: string, message: string): never {
  throw new KitchenAdminError(`${path}: ${message}`);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  label = "unknown field",
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      fail(`${path}.${key}`, `${label} "${key}"`);
    }
  }
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail(path, "expected string");
  }
  if (value.includes("\0")) {
    fail(path, "must not contain null bytes");
  }
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  const s = expectString(value, path);
  if (s.trim().length === 0) {
    fail(path, "expected non-empty string");
  }
  return s;
}

function expectOptionalNullableString(
  value: unknown,
  path: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return expectString(value, path);
}

function expectOptionalBoolean(
  value: unknown,
  path: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    fail(path, "expected boolean");
  }
  return value;
}

function expectOptionalNullableInt(
  value: unknown,
  path: string,
  min?: number,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(path, "expected integer");
  }
  if (min !== undefined && value < min) {
    fail(path, min === 1 ? "expected positive integer" : `expected integer >= ${min}`);
  }
  return value;
}

function expectOptionalNullableStringArray(
  value: unknown,
  path: string,
): string[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    fail(path, "expected array of strings");
  }
  return value.map((item, idx) => expectString(item, `${path}[${idx}]`));
}

function parseIsoTimestamp(value: unknown, path: string): string {
  const raw = expectString(value, path);
  const match = ISO_TIMESTAMP_RE.exec(raw);
  if (!match) {
    fail(path, "expected valid ISO-8601 date string");
  }
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const hour = Number.parseInt(match[4]!, 10);
  const minute = Number.parseInt(match[5]!, 10);
  const second = Number.parseInt(match[6]!, 10);
  const offset = match[8]!;

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    fail(path, "expected valid ISO-8601 date string");
  }
  const utcCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    utcCheck.getUTCFullYear() !== year ||
    utcCheck.getUTCMonth() !== month - 1 ||
    utcCheck.getUTCDate() !== day
  ) {
    fail(path, "expected valid ISO-8601 date string");
  }
  if (hour > 23 || minute > 59 || second > 59) {
    fail(path, "expected valid ISO-8601 date string");
  }
  if (offset !== "Z") {
    const offHour = Number.parseInt(offset.slice(1, 3), 10);
    const offMin = Number.parseInt(offset.slice(4, 6), 10);
    if (offHour > 23 || offMin > 59) {
      fail(path, "expected valid ISO-8601 date string");
    }
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    fail(path, "expected valid ISO-8601 date string");
  }
  return new Date(ms).toISOString();
}

function parseOptionalNullableIsoTimestamp(
  value: unknown,
  path: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return parseIsoTimestamp(value, path);
}

function validateIngredients(
  value: unknown,
  path: string,
): ChatRecipeIngredient[] {
  if (!Array.isArray(value)) {
    fail(path, "expected array");
  }
  return value.map((entry, idx) => {
    const itemPath = `${path}[${idx}]`;
    if (!isPlainObject(entry)) {
      fail(itemPath, "expected object");
    }
    rejectUnknownKeys(entry, INGREDIENT_KEYS, itemPath);
    const item = expectString(entry.item, `${itemPath}.item`);
    const result: ChatRecipeIngredient = { item };
    if (entry.amount !== undefined) {
      result.amount = expectString(entry.amount, `${itemPath}.amount`);
    }
    if (entry.unit !== undefined) {
      result.unit = expectString(entry.unit, `${itemPath}.unit`);
    }
    return result;
  });
}

function validateEstimatedTime(
  value: unknown,
  path: string,
): { active?: number; passive?: number; total?: number } {
  if (!isPlainObject(value)) {
    fail(path, "expected object");
  }
  rejectUnknownKeys(value, ESTIMATED_TIME_KEYS, path);
  const result: { active?: number; passive?: number; total?: number } = {};
  for (const key of ["active", "passive", "total"] as const) {
    const raw = value[key];
    if (raw !== undefined) {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
        fail(`${path}.${key}`, "expected non-negative number");
      }
      result[key] = raw;
    }
  }
  return result;
}

function validateStepIngredients(value: unknown, path: string): number[][] {
  if (!Array.isArray(value)) {
    fail(path, "expected array");
  }
  return value.map((row, i) => {
    const rowPath = `${path}[${i}]`;
    if (!Array.isArray(row)) {
      fail(rowPath, "expected array of integers");
    }
    return row.map((idx, j) => {
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
        fail(`${rowPath}[${j}]`, "expected non-negative integer");
      }
      return idx;
    });
  });
}

function validateRecipeData(
  value: unknown,
  path: string,
): KitchenQueueRecipeData {
  if (!isPlainObject(value)) {
    fail(path, "expected object");
  }
  rejectUnknownKeys(value, RECIPE_DATA_KEYS, path);
  const name = expectString(value.name, `${path}.name`);
  const result: KitchenQueueRecipeData = { name };
  if (value.ingredients !== undefined) {
    result.ingredients = validateIngredients(
      value.ingredients,
      `${path}.ingredients`,
    );
  }
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps)) {
      fail(`${path}.steps`, "expected array of strings");
    }
    result.steps = value.steps.map((s, idx) =>
      expectString(s, `${path}.steps[${idx}]`),
    );
  }
  if (value.estimatedTime !== undefined) {
    result.estimatedTime = validateEstimatedTime(
      value.estimatedTime,
      `${path}.estimatedTime`,
    );
  }
  if (value.serves !== undefined) {
    if (
      typeof value.serves !== "number" ||
      !Number.isFinite(value.serves) ||
      value.serves <= 0
    ) {
      fail(`${path}.serves`, "expected positive number");
    }
    result.serves = value.serves;
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) {
      fail(`${path}.tags`, "expected array of strings");
    }
    result.tags = value.tags.map((t, idx) =>
      expectString(t, `${path}.tags[${idx}]`),
    );
  }
  if (value.notes !== undefined) {
    result.notes = expectString(value.notes, `${path}.notes`);
  }
  if (value.stepIngredients !== undefined) {
    result.stepIngredients = validateStepIngredients(
      value.stepIngredients,
      `${path}.stepIngredients`,
    );
  }
  if (value.source !== undefined) {
    result.source = expectString(value.source, `${path}.source`);
  }
  return canonicalizeJsonValue(result);
}

function validateOptionalNullableRecipeData(
  value: unknown,
  path: string,
): KitchenQueueRecipeData | null {
  if (value === undefined || value === null) {
    return null;
  }
  return validateRecipeData(value, path);
}

function validateOptionalNullableCookPlan(
  value: unknown,
  path: string,
): CookPlan | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    fail(path, "expected object");
  }
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) {
    fail(`${path}.version`, "expected integer");
  }
  if (!Array.isArray(value.tasks)) {
    fail(`${path}.tasks`, "expected array");
  }
  for (let i = 0; i < value.tasks.length; i++) {
    const task = value.tasks[i];
    const taskPath = `${path}.tasks[${i}]`;
    if (!isPlainObject(task)) {
      fail(taskPath, "expected object");
    }
    expectString(task.id, `${taskPath}.id`);
    expectString(task.text, `${taskPath}.text`);
  }
  return canonicalizeJsonValue(value) as unknown as CookPlan;
}

function validateOptionalNullableCookLogRef(
  value: unknown,
  path: string,
): CookLogRef | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    fail(path, "expected object");
  }
  rejectUnknownKeys(value, COOK_LOG_REF_KEYS, path);
  if (typeof value.row !== "number" || !Number.isInteger(value.row)) {
    fail(`${path}.row`, "expected integer");
  }
  const timestamp = expectString(value.timestamp, `${path}.timestamp`);
  const recipeName = expectString(value.recipeName, `${path}.recipeName`);
  if (typeof value.adopted !== "boolean") {
    fail(`${path}.adopted`, "expected boolean");
  }
  return canonicalizeJsonValue({
    row: value.row,
    timestamp,
    recipeName,
    adopted: value.adopted,
  });
}

function validateServesEstimateTuple(
  servesEstimate: number | null,
  basis: string | null,
  sourceHash: string | null,
  path: string,
): void {
  if (servesEstimate !== null) {
    if (basis === null) {
      fail(
        `${path}.servesEstimateBasis`,
        "must be a string when servesEstimate is set",
      );
    }
    if (sourceHash === null) {
      fail(
        `${path}.servesEstimateSourceHash`,
        "must be a string when servesEstimate is set",
      );
    }
  } else {
    if (basis !== null) {
      fail(
        `${path}.servesEstimateBasis`,
        "must be null when servesEstimate is null",
      );
    }
    if (sourceHash !== null) {
      fail(
        `${path}.servesEstimateSourceHash`,
        "must be null when servesEstimate is null",
      );
    }
  }
}

function validateRecipeItem(
  value: unknown,
  path: string,
  seenSlugs: Set<string>,
): ExportedRecipe {
  if (!isPlainObject(value)) {
    fail(path, "expected object");
  }
  rejectUnknownKeys(value, RECIPE_KEYS, path);

  const docSlug = expectNonEmptyString(value.docSlug, `${path}.docSlug`);
  if (seenSlugs.has(docSlug)) {
    fail(`${path}.docSlug`, `duplicate docSlug "${docSlug}"`);
  }
  seenSlugs.add(docSlug);

  const name = expectString(value.name, `${path}.name`);
  const category = expectOptionalNullableString(
    value.category,
    `${path}.category`,
  );
  const categoryTitle = expectOptionalNullableString(
    value.categoryTitle,
    `${path}.categoryTitle`,
  );
  const docPosition = expectOptionalNullableInt(
    value.docPosition,
    `${path}.docPosition`,
  );

  let ingredients: ChatRecipeIngredient[] | null = null;
  if (value.ingredients !== undefined && value.ingredients !== null) {
    ingredients = canonicalizeJsonValue(
      validateIngredients(value.ingredients, `${path}.ingredients`),
    );
  }

  const steps = expectOptionalNullableStringArray(value.steps, `${path}.steps`);

  let estimatedTime: {
    active?: number;
    passive?: number;
    total?: number;
  } | null = null;
  if (value.estimatedTime !== undefined && value.estimatedTime !== null) {
    estimatedTime = canonicalizeJsonValue(
      validateEstimatedTime(value.estimatedTime, `${path}.estimatedTime`),
    );
  }

  const serves = expectOptionalNullableInt(value.serves, `${path}.serves`);
  const tags = expectOptionalNullableStringArray(value.tags, `${path}.tags`);
  const notes = expectOptionalNullableString(value.notes, `${path}.notes`);

  let stepIngredients: number[][] | null = null;
  if (value.stepIngredients !== undefined && value.stepIngredients !== null) {
    stepIngredients = validateStepIngredients(
      value.stepIngredients,
      `${path}.stepIngredients`,
    );
  }

  const rawDocText = expectString(value.rawDocText, `${path}.rawDocText`);
  const extractionError = expectOptionalNullableString(
    value.extractionError,
    `${path}.extractionError`,
  );
  const syncedAt =
    value.syncedAt === undefined
      ? new Date().toISOString()
      : parseIsoTimestamp(value.syncedAt, `${path}.syncedAt`);

  const servesEstimate = expectOptionalNullableInt(
    value.servesEstimate,
    `${path}.servesEstimate`,
    1,
  );
  const servesEstimateBasis = expectOptionalNullableString(
    value.servesEstimateBasis,
    `${path}.servesEstimateBasis`,
  );
  const servesEstimateSourceHash = expectOptionalNullableString(
    value.servesEstimateSourceHash,
    `${path}.servesEstimateSourceHash`,
  );
  validateServesEstimateTuple(
    servesEstimate,
    servesEstimateBasis,
    servesEstimateSourceHash,
    path,
  );

  const cookPlan = validateOptionalNullableCookPlan(
    value.cookPlan,
    `${path}.cookPlan`,
  );
  const cookPlanError = expectOptionalNullableString(
    value.cookPlanError,
    `${path}.cookPlanError`,
  );
  if (cookPlan !== null && cookPlanError !== null) {
    fail(`${path}.cookPlanError`, "must be null when cookPlan is set");
  }
  const cookPlanSourceHash = expectOptionalNullableString(
    value.cookPlanSourceHash,
    `${path}.cookPlanSourceHash`,
  );
  const cookPlanStamp = expectOptionalNullableString(
    value.cookPlanStamp,
    `${path}.cookPlanStamp`,
  );
  const isPrivate = expectOptionalBoolean(
    value.isPrivate,
    `${path}.isPrivate`,
    false,
  );

  return {
    docSlug,
    name,
    category,
    categoryTitle,
    docPosition,
    ingredients,
    steps,
    estimatedTime,
    serves,
    tags,
    notes,
    stepIngredients,
    rawDocText,
    extractionError,
    syncedAt,
    servesEstimate,
    servesEstimateBasis,
    servesEstimateSourceHash,
    cookPlan,
    cookPlanError,
    cookPlanSourceHash,
    cookPlanStamp,
    isPrivate,
  };
}

function validateQueueItem(value: unknown, path: string): ExportedQueueItem {
  if (!isPlainObject(value)) {
    fail(path, "expected object");
  }
  rejectUnknownKeys(value, QUEUE_KEYS, path);

  const recipeNotionId = expectOptionalNullableString(
    value.recipeNotionId,
    `${path}.recipeNotionId`,
  );
  const recipeData = validateOptionalNullableRecipeData(
    value.recipeData,
    `${path}.recipeData`,
  );

  const rawStatus = expectString(value.status, `${path}.status`);
  if (!QUEUE_STATUSES.has(rawStatus as KitchenQueueStatus)) {
    fail(
      `${path}.status`,
      "expected one of pending, cooking, completed, cancelled",
    );
  }
  const status = rawStatus as KitchenQueueStatus;

  const createdAt = parseIsoTimestamp(value.createdAt, `${path}.createdAt`);
  const cookPlan = validateOptionalNullableCookPlan(
    value.cookPlan,
    `${path}.cookPlan`,
  );
  const cookPlanError = expectOptionalNullableString(
    value.cookPlanError,
    `${path}.cookPlanError`,
  );
  const startedAt = parseOptionalNullableIsoTimestamp(
    value.startedAt,
    `${path}.startedAt`,
  );
  const completedAt = parseOptionalNullableIsoTimestamp(
    value.completedAt,
    `${path}.completedAt`,
  );
  const cookLog = validateOptionalNullableCookLogRef(
    value.cookLog,
    `${path}.cookLog`,
  );
  const cookLogError = expectOptionalNullableString(
    value.cookLogError,
    `${path}.cookLogError`,
  );
  const ratingClosedAt = parseOptionalNullableIsoTimestamp(
    value.ratingClosedAt,
    `${path}.ratingClosedAt`,
  );

  const servesEstimate = expectOptionalNullableInt(
    value.servesEstimate,
    `${path}.servesEstimate`,
    1,
  );
  const servesEstimateBasis = expectOptionalNullableString(
    value.servesEstimateBasis,
    `${path}.servesEstimateBasis`,
  );
  const servesEstimateSourceHash = expectOptionalNullableString(
    value.servesEstimateSourceHash,
    `${path}.servesEstimateSourceHash`,
  );
  validateServesEstimateTuple(
    servesEstimate,
    servesEstimateBasis,
    servesEstimateSourceHash,
    path,
  );

  const intakeRecipe = validateOptionalNullableRecipeData(
    value.intakeRecipe,
    `${path}.intakeRecipe`,
  );
  const intakeError = expectOptionalNullableString(
    value.intakeError,
    `${path}.intakeError`,
  );
  if (intakeRecipe !== null && intakeError !== null) {
    fail(`${path}.intakeError`, "must be null when intakeRecipe is set");
  }
  const intakeSourceHash = expectOptionalNullableString(
    value.intakeSourceHash,
    `${path}.intakeSourceHash`,
  );
  const intakeStamp = expectOptionalNullableString(
    value.intakeStamp,
    `${path}.intakeStamp`,
  );
  const intakeAttempts = expectOptionalNullableInt(
    value.intakeAttempts,
    `${path}.intakeAttempts`,
    0,
  );
  const intakeNudges = expectOptionalNullableStringArray(
    value.intakeNudges,
    `${path}.intakeNudges`,
  );

  let finishedBy: FinishedBy | null = null;
  if (value.finishedBy !== undefined && value.finishedBy !== null) {
    const rawFinishedBy = expectString(value.finishedBy, `${path}.finishedBy`);
    if (!FINISHED_BY_VALUES.has(rawFinishedBy as FinishedBy)) {
      fail(`${path}.finishedBy`, "expected pressed, auto, or null");
    }
    finishedBy = rawFinishedBy as FinishedBy;
  }

  const lastScreenActiveAt = parseOptionalNullableIsoTimestamp(
    value.lastScreenActiveAt,
    `${path}.lastScreenActiveAt`,
  );
  const lastInteractionAt = parseOptionalNullableIsoTimestamp(
    value.lastInteractionAt,
    `${path}.lastInteractionAt`,
  );
  const isPrivate = expectOptionalBoolean(
    value.isPrivate,
    `${path}.isPrivate`,
    false,
  );

  return {
    recipeNotionId,
    recipeData,
    status,
    createdAt,
    cookPlan,
    cookPlanError,
    startedAt,
    completedAt,
    cookLog,
    cookLogError,
    ratingClosedAt,
    servesEstimate,
    servesEstimateBasis,
    servesEstimateSourceHash,
    intakeRecipe,
    intakeError,
    intakeSourceHash,
    intakeStamp,
    intakeAttempts,
    intakeNudges,
    finishedBy,
    lastScreenActiveAt,
    lastInteractionAt,
    isPrivate,
  };
}

function validateCookLogItem(
  value: unknown,
  path: string,
): ExportedCookLogEntry {
  if (!isPlainObject(value)) {
    fail(path, "expected object");
  }
  rejectUnknownKeys(value, COOK_LOG_KEYS, path);

  const docSlug = expectOptionalNullableString(value.docSlug, `${path}.docSlug`);
  const packSource = expectOptionalNullableString(
    value.packSource,
    `${path}.packSource`,
  );
  const recipeSnapshot = validateOptionalNullableRecipeData(
    value.recipeSnapshot,
    `${path}.recipeSnapshot`,
  );
  const recipeTitle = expectString(value.recipeTitle, `${path}.recipeTitle`);
  const timestampText = expectString(
    value.timestampText,
    `${path}.timestampText`,
  );
  const cookedDay = expectString(value.cookedDay, `${path}.cookedDay`);
  const cookedAt = parseIsoTimestamp(value.cookedAt, `${path}.cookedAt`);

  let rating: number | null = null;
  if (value.rating !== undefined && value.rating !== null) {
    if (
      typeof value.rating !== "number" ||
      !Number.isInteger(value.rating) ||
      value.rating < 1 ||
      value.rating > 5
    ) {
      fail(`${path}.rating`, "expected integer between 1 and 5");
    }
    rating = value.rating;
  }

  const notes =
    value.notes === undefined
      ? ""
      : expectString(value.notes, `${path}.notes`);
  const noteUpdatedAt = parseOptionalNullableIsoTimestamp(
    value.noteUpdatedAt,
    `${path}.noteUpdatedAt`,
  );

  return {
    docSlug,
    packSource,
    recipeSnapshot,
    recipeTitle,
    timestampText,
    cookedDay,
    cookedAt,
    rating,
    notes,
    noteUpdatedAt,
  };
}

function validatePantrySection(
  value: unknown,
  path: string,
  seenHeadings: Set<string>,
): ExportedPantrySection {
  if (!isPlainObject(value)) {
    fail(path, "expected object");
  }
  rejectUnknownKeys(value, PANTRY_SECTION_KEYS, path);

  const rawHeading = expectNonEmptyString(
    value.rawHeading,
    `${path}.rawHeading`,
  );
  const normHeading = rawHeading.trim().toLowerCase();
  if (seenHeadings.has(normHeading)) {
    fail(`${path}.rawHeading`, `duplicate pantry section "${rawHeading}"`);
  }
  seenHeadings.add(normHeading);

  if (!Array.isArray(value.items)) {
    fail(`${path}.items`, "expected array");
  }
  const items = value.items.map((item, idx) =>
    expectNonEmptyString(item, `${path}.items[${idx}]`),
  );

  return { rawHeading, items };
}

/**
 * Validates a parsed kitchen export payload upfront, throwing `KitchenAdminError`
 * naming the first fault with its exact JSON path before any database work runs.
 */
export function validateKitchenExport(input: unknown): KitchenExportV1 {
  if (!isPlainObject(input)) {
    fail("root", "expected a JSON object");
  }

  if (input.format === undefined) {
    fail("format", "expected integer 1");
  }
  if (
    typeof input.format !== "number" ||
    !Number.isInteger(input.format) ||
    input.format !== KITCHEN_EXPORT_FORMAT
  ) {
    fail(
      "format",
      `unsupported export format ${JSON.stringify(input.format)} (expected 1)`,
    );
  }

  rejectUnknownKeys(input, TOP_LEVEL_KEYS, "root", "unknown section");

  const result: KitchenExportV1 = {
    format: KITCHEN_EXPORT_FORMAT,
  };

  if (input.about !== undefined) {
    const about = expectString(input.about, "about");
    const length = [...about].length;
    if (length > ABOUT_MAX_CHARS) {
      fail(
        "about",
        `must be at most ${ABOUT_MAX_CHARS} characters (got ${length})`,
      );
    }
    result.about = about;
  }

  if (input.recipes !== undefined) {
    if (!Array.isArray(input.recipes)) {
      fail("recipes", "expected array");
    }
    const seenSlugs = new Set<string>();
    result.recipes = input.recipes.map((entry, idx) =>
      validateRecipeItem(entry, `recipes[${idx}]`, seenSlugs),
    );
  }

  if (input.queue !== undefined) {
    if (!Array.isArray(input.queue)) {
      fail("queue", "expected array");
    }
    result.queue = input.queue.map((entry, idx) =>
      validateQueueItem(entry, `queue[${idx}]`),
    );
  }

  if (input.cookLog !== undefined) {
    if (!Array.isArray(input.cookLog)) {
      fail("cookLog", "expected array");
    }
    result.cookLog = input.cookLog.map((entry, idx) =>
      validateCookLogItem(entry, `cookLog[${idx}]`),
    );
  }

  if (input.pantry !== undefined) {
    if (!Array.isArray(input.pantry)) {
      fail("pantry", "expected array");
    }
    const seenHeadings = new Set<string>();
    result.pantry = input.pantry.map((entry, idx) =>
      validatePantrySection(entry, `pantry[${idx}]`, seenHeadings),
    );
  }

  if (input.shoppingList !== undefined) {
    if (!Array.isArray(input.shoppingList)) {
      fail("shoppingList", "expected array");
    }
    result.shoppingList = input.shoppingList.map((entry, idx) =>
      expectNonEmptyString(entry, `shoppingList[${idx}]`),
    );
  }

  if (input.ideas !== undefined) {
    if (!Array.isArray(input.ideas)) {
      fail("ideas", "expected array");
    }
    result.ideas = input.ideas.map((entry, idx) =>
      expectNonEmptyString(entry, `ideas[${idx}]`),
    );
  }

  return result;
}

/**
 * Parses and validates a raw JSON string as a kitchen export payload.
 */
export function parseKitchenExportJson(rawText: string): KitchenExportV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new KitchenAdminError(`Invalid JSON: ${detail}`);
  }
  return validateKitchenExport(parsed);
}

/**
 * Serializes a canonical export object with deterministic whitespace and trailing newline.
 */
export function serializeKitchenExport(data: CanonicalKitchenExportV1): string {
  return JSON.stringify(data, null, 2) + "\n";
}

function queueDedupeKey(item: {
  createdAt: Date | string;
  recipeNotionId: string | null;
  recipeData: KitchenQueueRecipeData | null;
}): string {
  const createdIso =
    item.createdAt instanceof Date
      ? item.createdAt.toISOString()
      : item.createdAt;
  return JSON.stringify([
    createdIso,
    item.recipeNotionId ?? null,
    item.recipeData === null ? null : canonicalizeJsonValue(item.recipeData),
  ]);
}

function cookLogDedupeKey(item: {
  cookedDay: string;
  timestampText: string;
  recipeTitle: string;
  cookedAt: Date | string;
}): string {
  const cookedIso =
    item.cookedAt instanceof Date ? item.cookedAt.toISOString() : item.cookedAt;
  return JSON.stringify([
    item.cookedDay,
    item.timestampText,
    item.recipeTitle,
    cookedIso,
  ]);
}

function shoppingDedupeKey(line: string): string {
  const key = shopItemKey(line);
  return key || line.trim().toLowerCase();
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function consumeCount(map: Map<string, number>, key: string): boolean {
  const current = map.get(key) ?? 0;
  if (current <= 0) {
    return false;
  }
  map.set(key, current - 1);
  return true;
}

/**
 * Exports one kitchen's portable data (`about`, `recipes`, `queue`, `cookLog`)
 * in a deterministic, versioned JSON format.
 */
export async function exportKitchenData(
  input: { kitchenSlug: string },
  database: AdminDb = db,
): Promise<ExportKitchenResult> {
  const slug = input.kitchenSlug.trim();
  if (!slug) {
    throw new KitchenAdminError("Kitchen slug is required.");
  }

  const [kitchen] = await database
    .select({
      id: kitchens.id,
      slug: kitchens.slug,
      about: kitchens.about,
    })
    .from(kitchens)
    .where(eq(kitchens.slug, slug))
    .limit(1);

  if (!kitchen) {
    throw new KitchenAdminError(`Kitchen "${slug}" not found.`);
  }

  const recipeRows = await database
    .select({
      id: docRecipes.id,
      docSlug: docRecipes.docSlug,
      name: docRecipes.name,
      category: docRecipes.category,
      categoryTitle: docRecipes.categoryTitle,
      docPosition: docRecipes.docPosition,
      ingredients: docRecipes.ingredients,
      steps: docRecipes.steps,
      estimatedTime: docRecipes.estimatedTime,
      serves: docRecipes.serves,
      tags: docRecipes.tags,
      notes: docRecipes.notes,
      stepIngredients: docRecipes.stepIngredients,
      rawDocText: docRecipes.rawDocText,
      extractionError: docRecipes.extractionError,
      syncedAt: docRecipes.syncedAt,
      servesEstimate: docRecipes.servesEstimate,
      servesEstimateBasis: docRecipes.servesEstimateBasis,
      servesEstimateSourceHash: docRecipes.servesEstimateSourceHash,
      cookPlan: docRecipes.cookPlan,
      cookPlanError: docRecipes.cookPlanError,
      cookPlanSourceHash: docRecipes.cookPlanSourceHash,
      cookPlanStamp: docRecipes.cookPlanStamp,
      isPrivate: docRecipes.isPrivate,
    })
    .from(docRecipes)
    .where(eq(docRecipes.kitchenId, kitchen.id))
    .orderBy(asc(docRecipes.docSlug));

  const docSlugById = new Map<string, string>();
  for (const row of recipeRows) {
    docSlugById.set(row.id, row.docSlug);
  }

  const recipes: ExportedRecipe[] = recipeRows
    .map((row) => ({
      docSlug: row.docSlug,
      name: row.name,
      category: row.category,
      categoryTitle: row.categoryTitle,
      docPosition: row.docPosition,
      ingredients: canonicalizeJsonValue(row.ingredients),
      steps: row.steps,
      estimatedTime: canonicalizeJsonValue(row.estimatedTime),
      serves: row.serves,
      tags: row.tags,
      notes: row.notes,
      stepIngredients: row.stepIngredients,
      rawDocText: row.rawDocText,
      extractionError: row.extractionError,
      syncedAt: row.syncedAt.toISOString(),
      servesEstimate: row.servesEstimate,
      servesEstimateBasis: row.servesEstimateBasis,
      servesEstimateSourceHash: row.servesEstimateSourceHash,
      cookPlan: canonicalizeJsonValue(row.cookPlan),
      cookPlanError: row.cookPlanError,
      cookPlanSourceHash: row.cookPlanSourceHash,
      cookPlanStamp: row.cookPlanStamp,
      isPrivate: row.isPrivate,
    }))
    .sort((a, b) => {
      const posA = a.docPosition ?? Number.POSITIVE_INFINITY;
      const posB = b.docPosition ?? Number.POSITIVE_INFINITY;
      if (posA !== posB) return posA - posB;
      return compareStrings(a.docSlug, b.docSlug);
    });

  const queueRows = await database
    .select({
      recipeNotionId: kitchenQueue.recipeNotionId,
      recipeData: kitchenQueue.recipeData,
      status: kitchenQueue.status,
      createdAt: kitchenQueue.createdAt,
      cookPlan: kitchenQueue.cookPlan,
      cookPlanError: kitchenQueue.cookPlanError,
      startedAt: kitchenQueue.startedAt,
      completedAt: kitchenQueue.completedAt,
      cookLog: kitchenQueue.cookLog,
      cookLogError: kitchenQueue.cookLogError,
      ratingClosedAt: kitchenQueue.ratingClosedAt,
      servesEstimate: kitchenQueue.servesEstimate,
      servesEstimateBasis: kitchenQueue.servesEstimateBasis,
      servesEstimateSourceHash: kitchenQueue.servesEstimateSourceHash,
      intakeRecipe: kitchenQueue.intakeRecipe,
      intakeError: kitchenQueue.intakeError,
      intakeSourceHash: kitchenQueue.intakeSourceHash,
      intakeStamp: kitchenQueue.intakeStamp,
      intakeAttempts: kitchenQueue.intakeAttempts,
      intakeNudges: kitchenQueue.intakeNudges,
      finishedBy: kitchenQueue.finishedBy,
      lastScreenActiveAt: kitchenQueue.lastScreenActiveAt,
      lastInteractionAt: kitchenQueue.lastInteractionAt,
      isPrivate: kitchenQueue.isPrivate,
    })
    .from(kitchenQueue)
    .where(eq(kitchenQueue.kitchenId, kitchen.id))
    .orderBy(asc(kitchenQueue.createdAt));

  const queue: ExportedQueueItem[] = queueRows
    .map((row) => ({
      recipeNotionId: row.recipeNotionId,
      recipeData: canonicalizeJsonValue(row.recipeData),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      cookPlan: canonicalizeJsonValue(row.cookPlan),
      cookPlanError: row.cookPlanError,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      cookLog: canonicalizeJsonValue(row.cookLog),
      cookLogError: row.cookLogError,
      ratingClosedAt: row.ratingClosedAt
        ? row.ratingClosedAt.toISOString()
        : null,
      servesEstimate: row.servesEstimate,
      servesEstimateBasis: row.servesEstimateBasis,
      servesEstimateSourceHash: row.servesEstimateSourceHash,
      intakeRecipe: canonicalizeJsonValue(row.intakeRecipe),
      intakeError: row.intakeError,
      intakeSourceHash: row.intakeSourceHash,
      intakeStamp: row.intakeStamp,
      intakeAttempts: row.intakeAttempts,
      intakeNudges: row.intakeNudges,
      finishedBy: row.finishedBy,
      lastScreenActiveAt: row.lastScreenActiveAt
        ? row.lastScreenActiveAt.toISOString()
        : null,
      lastInteractionAt: row.lastInteractionAt
        ? row.lastInteractionAt.toISOString()
        : null,
      isPrivate: row.isPrivate,
    }))
    .sort((a, b) => {
      const timeDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      if (timeDiff !== 0) return timeDiff;
      const statusDiff = compareStrings(a.status, b.status);
      if (statusDiff !== 0) return statusDiff;
      const nameA = a.recipeData?.name ?? a.recipeNotionId ?? "";
      const nameB = b.recipeData?.name ?? b.recipeNotionId ?? "";
      const nameDiff = compareStrings(nameA, nameB);
      if (nameDiff !== 0) return nameDiff;
      return compareStrings(canonicalJsonString(a), canonicalJsonString(b));
    });

  const cookLogRows = await database
    .select({
      position: kitchenCookLog.position,
      docRecipeId: kitchenCookLog.docRecipeId,
      packSource: kitchenCookLog.packSource,
      recipeSnapshot: kitchenCookLog.recipeSnapshot,
      recipeTitle: kitchenCookLog.recipeTitle,
      timestampText: kitchenCookLog.timestampText,
      cookedDay: kitchenCookLog.cookedDay,
      cookedAt: kitchenCookLog.cookedAt,
      rating: kitchenCookLog.rating,
      notes: kitchenCookLog.notes,
      noteUpdatedAt: kitchenCookLog.noteUpdatedAt,
    })
    .from(kitchenCookLog)
    .where(eq(kitchenCookLog.kitchenId, kitchen.id))
    .orderBy(asc(kitchenCookLog.cookedAt), asc(kitchenCookLog.position));

  const cookLog: ExportedCookLogEntry[] = cookLogRows
    .map((row) => ({
      position: row.position,
      entry: {
        docSlug: row.docRecipeId
          ? (docSlugById.get(row.docRecipeId) ?? null)
          : null,
        packSource: row.packSource,
        recipeSnapshot: canonicalizeJsonValue(row.recipeSnapshot),
        recipeTitle: row.recipeTitle,
        timestampText: row.timestampText,
        cookedDay: row.cookedDay,
        cookedAt: row.cookedAt.toISOString(),
        rating: row.rating,
        notes: row.notes,
        noteUpdatedAt: row.noteUpdatedAt
          ? row.noteUpdatedAt.toISOString()
          : null,
      } satisfies ExportedCookLogEntry,
    }))
    .sort((a, b) => {
      const timeDiff =
        Date.parse(a.entry.cookedAt) - Date.parse(b.entry.cookedAt);
      if (timeDiff !== 0) return timeDiff;
      const tsDiff = compareStrings(
        a.entry.timestampText,
        b.entry.timestampText,
      );
      if (tsDiff !== 0) return tsDiff;
      const titleDiff = compareStrings(
        a.entry.recipeTitle,
        b.entry.recipeTitle,
      );
      if (titleDiff !== 0) return titleDiff;
      return a.position - b.position;
    })
    .map((item) => item.entry);

  const pantrySectionRows = await database
    .select({
      id: kitchenPantrySections.id,
      rawHeading: kitchenPantrySections.rawHeading,
    })
    .from(kitchenPantrySections)
    .where(eq(kitchenPantrySections.kitchenId, kitchen.id))
    .orderBy(asc(kitchenPantrySections.position));

  const pantryItemRows = await database
    .select({
      sectionId: kitchenPantryItems.sectionId,
      text: kitchenPantryItems.text,
    })
    .from(kitchenPantryItems)
    .where(eq(kitchenPantryItems.kitchenId, kitchen.id))
    .orderBy(asc(kitchenPantryItems.position));

  const pantryItemsBySection = new Map<string, string[]>();
  for (const row of pantryItemRows) {
    const list = pantryItemsBySection.get(row.sectionId) ?? [];
    list.push(row.text);
    pantryItemsBySection.set(row.sectionId, list);
  }

  const pantry: ExportedPantrySection[] = pantrySectionRows.map((section) => ({
    rawHeading: section.rawHeading,
    items: pantryItemsBySection.get(section.id) ?? [],
  }));

  const shoppingRows = await database
    .select({ line: kitchenShoppingList.line })
    .from(kitchenShoppingList)
    .where(eq(kitchenShoppingList.kitchenId, kitchen.id))
    .orderBy(asc(kitchenShoppingList.position));
  const shoppingList = shoppingRows.map((row) => row.line);

  const ideaRows = await database
    .select({ line: kitchenIdeas.line })
    .from(kitchenIdeas)
    .where(eq(kitchenIdeas.kitchenId, kitchen.id))
    .orderBy(asc(kitchenIdeas.position));
  const ideas = ideaRows.map((row) => row.line);

  const data: CanonicalKitchenExportV1 = {
    format: KITCHEN_EXPORT_FORMAT,
    about: kitchen.about,
    recipes,
    queue,
    cookLog,
    pantry,
    shoppingList,
    ideas,
  };

  const pantryItemCount = pantry.reduce((sum, sec) => sum + sec.items.length, 0);

  return {
    kitchenSlug: kitchen.slug,
    data,
    json: serializeKitchenExport(data),
    counts: {
      about: kitchen.about.length > 0,
      recipes: recipes.length,
      queue: queue.length,
      cookLog: cookLog.length,
      pantry: pantryItemCount,
      shoppingList: shoppingList.length,
      ideas: ideas.length,
    },
  };
}

interface ImportPlan {
  aboutIncluded: boolean;
  aboutUpdated: boolean;
  aboutValue: string | null;
  docRecipeIdBySlug: Map<string, string>;
  recipesTotal: number;
  recipesToInsert: ExportedRecipe[];
  recipesSkipped: number;
  queueTotal: number;
  queueToInsert: ExportedQueueItem[];
  queueSkipped: number;
  cookLogTotal: number;
  cookLogToInsert: ExportedCookLogEntry[];
  cookLogSkipped: number;
  pantryTotal: number;
  pantrySectionsToInsert: Array<{ rawHeading: string; items: string[] }>;
  pantryItemsToInsertExisting: Array<{ sectionId: string; text: string }>;
  pantryInserted: number;
  pantrySkipped: number;
  shoppingListTotal: number;
  shoppingListToInsert: string[];
  shoppingListSkipped: number;
  ideasTotal: number;
  ideasToInsert: string[];
  ideasSkipped: number;
}

type DbOrTx = AdminDb | Parameters<Parameters<AdminDb["transaction"]>[0]>[0];

async function buildImportPlan(
  database: DbOrTx,
  kitchen: { id: string; about: string },
  parsed: KitchenExportV1,
): Promise<ImportPlan> {
  const aboutIncluded = parsed.about !== undefined;
  const aboutUpdated = aboutIncluded && parsed.about !== kitchen.about;

  const docRecipeIdBySlug = new Map<string, string>();
  if (parsed.recipes !== undefined || parsed.cookLog !== undefined) {
    const existingRecipes = await database
      .select({ id: docRecipes.id, docSlug: docRecipes.docSlug })
      .from(docRecipes)
      .where(eq(docRecipes.kitchenId, kitchen.id));
    for (const row of existingRecipes) {
      docRecipeIdBySlug.set(row.docSlug, row.id);
    }
  }

  const recipesToInsert: ExportedRecipe[] = [];
  let recipesSkipped = 0;
  if (parsed.recipes !== undefined) {
    for (const recipe of parsed.recipes) {
      if (docRecipeIdBySlug.has(recipe.docSlug)) {
        recipesSkipped += 1;
      } else {
        recipesToInsert.push(recipe);
      }
    }
  }

  const queueToInsert: ExportedQueueItem[] = [];
  let queueSkipped = 0;
  if (parsed.queue !== undefined) {
    const existingQueue = await database
      .select({
        createdAt: kitchenQueue.createdAt,
        recipeNotionId: kitchenQueue.recipeNotionId,
        recipeData: kitchenQueue.recipeData,
      })
      .from(kitchenQueue)
      .where(eq(kitchenQueue.kitchenId, kitchen.id));
    const existingCounts = new Map<string, number>();
    for (const row of existingQueue) {
      incrementCount(existingCounts, queueDedupeKey(row));
    }
    for (const item of parsed.queue) {
      if (consumeCount(existingCounts, queueDedupeKey(item))) {
        queueSkipped += 1;
      } else {
        queueToInsert.push(item);
      }
    }
  }

  const cookLogToInsert: ExportedCookLogEntry[] = [];
  let cookLogSkipped = 0;
  if (parsed.cookLog !== undefined) {
    const existingLog = await database
      .select({
        cookedDay: kitchenCookLog.cookedDay,
        timestampText: kitchenCookLog.timestampText,
        recipeTitle: kitchenCookLog.recipeTitle,
        cookedAt: kitchenCookLog.cookedAt,
      })
      .from(kitchenCookLog)
      .where(eq(kitchenCookLog.kitchenId, kitchen.id));
    const existingCounts = new Map<string, number>();
    for (const row of existingLog) {
      incrementCount(existingCounts, cookLogDedupeKey(row));
    }
    for (const entry of parsed.cookLog) {
      if (consumeCount(existingCounts, cookLogDedupeKey(entry))) {
        cookLogSkipped += 1;
      } else {
        cookLogToInsert.push(entry);
      }
    }
  }

  const pantrySectionsToInsert: Array<{ rawHeading: string; items: string[] }> = [];
  const pantryItemsToInsertExisting: Array<{ sectionId: string; text: string }> = [];
  let pantryTotal = 0;
  let pantryInserted = 0;
  let pantrySkipped = 0;
  if (parsed.pantry !== undefined) {
    const existingSections = await database
      .select({
        id: kitchenPantrySections.id,
        rawHeading: kitchenPantrySections.rawHeading,
      })
      .from(kitchenPantrySections)
      .where(eq(kitchenPantrySections.kitchenId, kitchen.id))
      .orderBy(asc(kitchenPantrySections.position));

    const existingSectionByKey = new Map<string, string>();
    for (const sec of existingSections) {
      const key = sec.rawHeading.trim().toLowerCase();
      if (!existingSectionByKey.has(key)) {
        existingSectionByKey.set(key, sec.id);
      }
    }

    const existingPantryItems = await database
      .select({
        sectionId: kitchenPantryItems.sectionId,
        text: kitchenPantryItems.text,
      })
      .from(kitchenPantryItems)
      .where(eq(kitchenPantryItems.kitchenId, kitchen.id));

    const existingCountsBySection = new Map<string, Map<string, number>>();
    for (const item of existingPantryItems) {
      let counts = existingCountsBySection.get(item.sectionId);
      if (!counts) {
        counts = new Map<string, number>();
        existingCountsBySection.set(item.sectionId, counts);
      }
      incrementCount(counts, item.text.trim());
    }

    for (const section of parsed.pantry) {
      pantryTotal += section.items.length;
      const key = section.rawHeading.trim().toLowerCase();
      const existingSectionId = existingSectionByKey.get(key);
      if (!existingSectionId) {
        const items = section.items.map((item) => item.trim());
        pantrySectionsToInsert.push({
          rawHeading: section.rawHeading.trim(),
          items,
        });
        pantryInserted += items.length;
      } else {
        let counts = existingCountsBySection.get(existingSectionId);
        if (!counts) {
          counts = new Map<string, number>();
          existingCountsBySection.set(existingSectionId, counts);
        }
        for (const rawItem of section.items) {
          const text = rawItem.trim();
          if (consumeCount(counts, text)) {
            pantrySkipped += 1;
          } else {
            pantryItemsToInsertExisting.push({
              sectionId: existingSectionId,
              text,
            });
            pantryInserted += 1;
          }
        }
      }
    }
  }

  const shoppingListToInsert: string[] = [];
  let shoppingListSkipped = 0;
  if (parsed.shoppingList !== undefined) {
    const existingShopping = await database
      .select({ line: kitchenShoppingList.line })
      .from(kitchenShoppingList)
      .where(eq(kitchenShoppingList.kitchenId, kitchen.id));
    const existingCounts = new Map<string, number>();
    for (const row of existingShopping) {
      incrementCount(existingCounts, shoppingDedupeKey(row.line));
    }
    for (const rawLine of parsed.shoppingList) {
      const line = rawLine.trim();
      if (consumeCount(existingCounts, shoppingDedupeKey(line))) {
        shoppingListSkipped += 1;
      } else {
        shoppingListToInsert.push(line);
      }
    }
  }

  const ideasToInsert: string[] = [];
  let ideasSkipped = 0;
  if (parsed.ideas !== undefined) {
    const existingIdeas = await database
      .select({ line: kitchenIdeas.line })
      .from(kitchenIdeas)
      .where(eq(kitchenIdeas.kitchenId, kitchen.id));
    const existingCounts = new Map<string, number>();
    for (const row of existingIdeas) {
      incrementCount(existingCounts, row.line.trim());
    }
    for (const rawLine of parsed.ideas) {
      const line = rawLine.trim();
      if (consumeCount(existingCounts, line)) {
        ideasSkipped += 1;
      } else {
        ideasToInsert.push(line);
      }
    }
  }

  return {
    aboutIncluded,
    aboutUpdated,
    aboutValue: parsed.about ?? null,
    docRecipeIdBySlug,
    recipesTotal: parsed.recipes?.length ?? 0,
    recipesToInsert,
    recipesSkipped,
    queueTotal: parsed.queue?.length ?? 0,
    queueToInsert,
    queueSkipped,
    cookLogTotal: parsed.cookLog?.length ?? 0,
    cookLogToInsert,
    cookLogSkipped,
    pantryTotal,
    pantrySectionsToInsert,
    pantryItemsToInsertExisting,
    pantryInserted,
    pantrySkipped,
    shoppingListTotal: parsed.shoppingList?.length ?? 0,
    shoppingListToInsert,
    shoppingListSkipped,
    ideasTotal: parsed.ideas?.length ?? 0,
    ideasToInsert,
    ideasSkipped,
  };
}

function toImportResult(
  kitchenSlug: string,
  dryRun: boolean,
  plan: ImportPlan,
): ImportKitchenResult {
  return {
    kitchenSlug,
    dryRun,
    about: {
      included: plan.aboutIncluded,
      updated: plan.aboutUpdated,
    },
    recipes: {
      total: plan.recipesTotal,
      inserted: plan.recipesToInsert.length,
      skipped: plan.recipesSkipped,
    },
    queue: {
      total: plan.queueTotal,
      inserted: plan.queueToInsert.length,
      skipped: plan.queueSkipped,
    },
    cookLog: {
      total: plan.cookLogTotal,
      inserted: plan.cookLogToInsert.length,
      skipped: plan.cookLogSkipped,
    },
    pantry: {
      total: plan.pantryTotal,
      inserted: plan.pantryInserted,
      skipped: plan.pantrySkipped,
      sectionsInserted: plan.pantrySectionsToInsert.length,
    },
    shoppingList: {
      total: plan.shoppingListTotal,
      inserted: plan.shoppingListToInsert.length,
      skipped: plan.shoppingListSkipped,
    },
    ideas: {
      total: plan.ideasTotal,
      inserted: plan.ideasToInsert.length,
      skipped: plan.ideasSkipped,
    },
  };
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Validates and imports a kitchen export JSON (or raw JSON string) into the
 * target kitchen inside one transaction, or computes dry-run counts without
 * writing anything.
 *
 * Imported cook-log notes always arrive with `notePrivate: true`, and imported
 * dishes always arrive with `heldBack: true` and `visibilityChosen: true`.
 */
export async function importKitchenData(
  input: {
    kitchenSlug: string;
    data: string | unknown;
    dryRun?: boolean;
  },
  database: AdminDb = db,
): Promise<ImportKitchenResult> {
  const slug = input.kitchenSlug.trim();
  if (!slug) {
    throw new KitchenAdminError("Kitchen slug is required.");
  }

  const parsed =
    typeof input.data === "string"
      ? parseKitchenExportJson(input.data)
      : validateKitchenExport(input.data);

  const dryRun = Boolean(input.dryRun);

  if (dryRun) {
    const [kitchen] = await database
      .select({
        id: kitchens.id,
        slug: kitchens.slug,
        about: kitchens.about,
      })
      .from(kitchens)
      .where(eq(kitchens.slug, slug))
      .limit(1);

    if (!kitchen) {
      throw new KitchenAdminError(`Kitchen "${slug}" not found.`);
    }

    const plan = await buildImportPlan(database, kitchen, parsed);
    return toImportResult(kitchen.slug, true, plan);
  }

  return database.transaction(async (tx) => {
    const [kitchen] = await tx
      .select({
        id: kitchens.id,
        slug: kitchens.slug,
        about: kitchens.about,
      })
      .from(kitchens)
      .where(eq(kitchens.slug, slug))
      .for("update");

    if (!kitchen) {
      throw new KitchenAdminError(`Kitchen "${slug}" not found.`);
    }

    const plan = await buildImportPlan(tx, kitchen, parsed);

    if (plan.aboutUpdated && plan.aboutValue !== null) {
      await tx
        .update(kitchens)
        .set({ about: plan.aboutValue })
        .where(eq(kitchens.id, kitchen.id));
    }

    for (const batch of chunkArray(plan.recipesToInsert, INSERT_BATCH_SIZE)) {
      const insertedRecipes = await tx
        .insert(docRecipes)
        .values(
          batch.map((r) => ({
            kitchenId: kitchen.id,
            docSlug: r.docSlug,
            name: r.name,
            category: r.category,
            categoryTitle: r.categoryTitle,
            docPosition: r.docPosition,
            ingredients: r.ingredients,
            steps: r.steps,
            estimatedTime: r.estimatedTime,
            serves: r.serves,
            tags: r.tags,
            notes: r.notes,
            stepIngredients: r.stepIngredients,
            rawDocText: r.rawDocText,
            extractionError: r.extractionError,
            syncedAt: new Date(r.syncedAt),
            servesEstimate: r.servesEstimate,
            servesEstimateBasis: r.servesEstimateBasis,
            servesEstimateSourceHash: r.servesEstimateSourceHash,
            cookPlan: r.cookPlan,
            cookPlanError: r.cookPlanError,
            cookPlanSourceHash: r.cookPlanSourceHash,
            cookPlanStamp: r.cookPlanStamp,
            isPrivate: r.isPrivate,
          })),
        )
        .returning({ id: docRecipes.id, docSlug: docRecipes.docSlug });

      for (const inserted of insertedRecipes) {
        plan.docRecipeIdBySlug.set(inserted.docSlug, inserted.id);
      }
    }

    for (const batch of chunkArray(plan.queueToInsert, INSERT_BATCH_SIZE)) {
      await tx.insert(kitchenQueue).values(
        batch.map((q) => ({
          kitchenId: kitchen.id,
          recipeNotionId: q.recipeNotionId,
          recipeData: q.recipeData,
          targetUser: null,
          status: q.status,
          createdAt: new Date(q.createdAt),
          cookPlan: q.cookPlan,
          cookPlanError: q.cookPlanError,
          startedAt: q.startedAt ? new Date(q.startedAt) : null,
          completedAt: q.completedAt ? new Date(q.completedAt) : null,
          cookLog: q.cookLog,
          cookLogError: q.cookLogError,
          cookLogClaimedAt: null,
          ratingClosedAt: q.ratingClosedAt ? new Date(q.ratingClosedAt) : null,
          servesEstimate: q.servesEstimate,
          servesEstimateBasis: q.servesEstimateBasis,
          servesEstimateSourceHash: q.servesEstimateSourceHash,
          intakeRecipe: q.intakeRecipe,
          intakeError: q.intakeError,
          intakeSourceHash: q.intakeSourceHash,
          intakeStamp: q.intakeStamp,
          intakeAttempts: q.intakeAttempts,
          intakeNudges: q.intakeNudges,
          finishedBy: q.finishedBy,
          lastScreenActiveAt: q.lastScreenActiveAt
            ? new Date(q.lastScreenActiveAt)
            : null,
          lastInteractionAt: q.lastInteractionAt
            ? new Date(q.lastInteractionAt)
            : null,
          isPrivate: q.isPrivate,
          completedByMemberId: null,
        })),
      );
    }

    for (const batch of chunkArray(plan.cookLogToInsert, INSERT_BATCH_SIZE)) {
      await tx.insert(kitchenCookLog).values(
        batch.map((c) => ({
          kitchenId: kitchen.id,
          queueId: null,
          docRecipeId:
            c.docSlug !== null
              ? (plan.docRecipeIdBySlug.get(c.docSlug) ?? null)
              : null,
          packSource: c.packSource,
          recipeSnapshot: c.recipeSnapshot,
          recipeTitle: c.recipeTitle,
          timestampText: c.timestampText,
          cookedDay: c.cookedDay,
          cookedAt: new Date(c.cookedAt),
          cookedByMemberId: null,
          rating: c.rating,
          notes: c.notes,
          notePrivate: true,
          noteUpdatedAt: c.noteUpdatedAt ? new Date(c.noteUpdatedAt) : null,
          heldBack: true,
          visibilityChosen: true,
        })),
      );
    }

    for (const sec of plan.pantrySectionsToInsert) {
      const [insertedSection] = await tx
        .insert(kitchenPantrySections)
        .values({
          kitchenId: kitchen.id,
          rawHeading: sec.rawHeading,
        })
        .returning({ id: kitchenPantrySections.id });
      if (insertedSection && sec.items.length > 0) {
        for (const batch of chunkArray(sec.items, INSERT_BATCH_SIZE)) {
          await tx.insert(kitchenPantryItems).values(
            batch.map((text) => ({
              kitchenId: kitchen.id,
              sectionId: insertedSection.id,
              text,
            })),
          );
        }
      }
    }

    for (const batch of chunkArray(
      plan.pantryItemsToInsertExisting,
      INSERT_BATCH_SIZE,
    )) {
      await tx.insert(kitchenPantryItems).values(
        batch.map((item) => ({
          kitchenId: kitchen.id,
          sectionId: item.sectionId,
          text: item.text,
        })),
      );
    }

    for (const batch of chunkArray(
      plan.shoppingListToInsert,
      INSERT_BATCH_SIZE,
    )) {
      await tx.insert(kitchenShoppingList).values(
        batch.map((line) => ({
          kitchenId: kitchen.id,
          line,
        })),
      );
    }

    for (const batch of chunkArray(plan.ideasToInsert, INSERT_BATCH_SIZE)) {
      await tx.insert(kitchenIdeas).values(
        batch.map((line) => ({
          kitchenId: kitchen.id,
          line,
        })),
      );
    }

    return toImportResult(kitchen.slug, false, plan);
  });
}

/**
 * Formats the operator CLI summary line for `kitchens import`.
 */
export function formatImportSummary(result: ImportKitchenResult): string {
  const prefix = result.dryRun
    ? `Dry run for kitchen "${result.kitchenSlug}" (no changes written):`
    : `Imported into kitchen "${result.kitchenSlug}":`;

  const aboutPart = !result.about.included
    ? "about: omitted"
    : result.about.updated
      ? result.dryRun
        ? "about: would update"
        : "about: updated"
      : "about: unchanged";

  const verb = result.dryRun ? "new" : "added";
  return [
    prefix,
    aboutPart + ",",
    `recipes: ${result.recipes.inserted} ${verb} (${result.recipes.skipped} skipped),`,
    `queue: ${result.queue.inserted} ${verb} (${result.queue.skipped} skipped),`,
    `cook log: ${result.cookLog.inserted} ${verb} (${result.cookLog.skipped} skipped),`,
    `pantry: ${result.pantry.inserted} ${verb} (${result.pantry.skipped} skipped, ${result.pantry.sectionsInserted} sections),`,
    `shopping list: ${result.shoppingList.inserted} ${verb} (${result.shoppingList.skipped} skipped),`,
    `ideas: ${result.ideas.inserted} ${verb} (${result.ideas.skipped} skipped).`,
  ].join(" ");
}

/**
 * Formats the operator CLI summary line for `kitchens export`.
 */
export function formatExportSummary(
  result: ExportKitchenResult,
  outPath: string,
): string {
  return `Exported kitchen "${result.kitchenSlug}" to ${outPath} (about: ${result.counts.about ? "yes" : "empty"}, recipes: ${result.counts.recipes}, queue: ${result.counts.queue}, cook log: ${result.counts.cookLog}, pantry: ${result.counts.pantry}, shopping list: ${result.counts.shoppingList}, ideas: ${result.counts.ideas}).`;
}

// Re-export schema types referenced by callers if needed.
export type { schema };
