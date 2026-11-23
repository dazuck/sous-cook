import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import { db, invites, kitchens, members } from "@/lib/db";
import { getConfig } from "@/lib/ai/config";
import {
  MODEL_PRICES,
  getModelPrice,
  parseUsdToMicrosResult,
  type ModelPrice,
} from "@/lib/ai/prices";
import { connected } from "@/lib/hooks/connected";
import { HOOK_NAMES } from "@/lib/hooks/types";

export type DeploymentMode = "sign-in" | "single-kitchen";

export type DeploymentDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export const REQUIRED_SIGN_IN_ENV_VARS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SOUS_AI_KITCHEN_CAP_USD",
  "SOUS_AI_TOTAL_CAP_USD",
] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MIN_BETTER_AUTH_SECRET_LENGTH = 32;

/**
 * Raised when deployment mode, required environment variables, hook switches,
 * or database state fail start-up validation.
 */
export class DeploymentConfigError extends Error {
  /** Full message for server logs when details are omitted from caller responses. */
  readonly logMessage: string;

  constructor(message: string, logMessage?: string) {
    super(message);
    this.name = "DeploymentConfigError";
    this.logMessage = logMessage ?? message;
  }
}

/**
 * Reads `SOUS_SIGN_IN` and resolves the deployment mode.
 * Unset (or empty) and `"on"` mean sign-in mode; `"off"` means single-kitchen
 * mode; any other value refuses to start.
 */
export function getDeploymentMode(
  env: Record<string, string | undefined> = process.env,
): DeploymentMode {
  const raw = env.SOUS_SIGN_IN;
  if (raw === undefined || raw === "" || raw === "on") {
    return "sign-in";
  }
  if (raw === "off") {
    return "single-kitchen";
  }
  throw new DeploymentConfigError(
    `Invalid SOUS_SIGN_IN value "${raw}". Expected "on", "off", or unset.`,
  );
}

/**
 * Parses `BETTER_AUTH_URL` and returns its exact origin (scheme + host + port).
 */
export function getBetterAuthOrigin(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.BETTER_AUTH_URL?.trim();
  if (!raw) {
    throw new DeploymentConfigError(
      "BETTER_AUTH_URL is required in sign-in mode.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DeploymentConfigError(
      `BETTER_AUTH_URL must be a valid http(s) URL (got "${raw}").`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DeploymentConfigError(
      `BETTER_AUTH_URL must use http or https (got "${raw}").`,
    );
  }
  if (parsed.protocol !== "https:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new DeploymentConfigError(
      `BETTER_AUTH_URL must use https unless its host is localhost, 127.0.0.1, or [::1] (got "${raw}").`,
    );
  }
  return parsed.origin;
}

const CAP_ENV_VARS = [
  "SOUS_AI_KITCHEN_CAP_USD",
  "SOUS_AI_TOTAL_CAP_USD",
] as const;

function validateCapEnvVars(
  mode: DeploymentMode,
  env: Record<string, string | undefined>,
): void {
  for (const varName of CAP_ENV_VARS) {
    const raw = env[varName];
    if (raw === undefined) {
      // Required in sign-in mode (already checked above); optional in single-kitchen mode.
      if (mode === "sign-in") {
        throw new DeploymentConfigError(
          `Invalid ${varName}: expected a plain non-negative dollar amount with at most two decimals (for example, 2 or 0.25).`,
          `Invalid ${varName}: value is unset in sign-in mode; expected a plain non-negative dollar amount matching ^\\d+(\\.\\d{1,2})?$.`,
        );
      }
      continue;
    }
    const parsed = parseUsdToMicrosResult(raw);
    if (!parsed.ok) {
      if (parsed.reason === "too-large") {
        throw new DeploymentConfigError(
          `Invalid ${varName}: dollar amount is too large to store.`,
          `Invalid ${varName} value "${raw}": dollar amount is too large to store.`,
        );
      }
      throw new DeploymentConfigError(
        `Invalid ${varName}: expected a plain non-negative dollar amount with at most two decimals (for example, 2 or 0.25).`,
        `Invalid ${varName} value "${raw}": expected a plain non-negative dollar amount matching ^\\d+(\\.\\d{1,2})?$.`,
      );
    }
  }
}

function validateConfiguredModelPrices(
  mode: DeploymentMode,
  env: Record<string, string | undefined>,
  prices: Readonly<Record<string, ModelPrice>>,
): void {
  const config = getConfig(env);
  const configured: Array<{ envVar: string; model: string }> = [
    { envVar: "AI_TEXT_MODEL", model: config.textModel },
    { envVar: "AI_COOK_CHAT_MODEL", model: config.cookChatModel },
    { envVar: "AI_VISION_MODEL", model: config.visionModel },
  ];

  const missingModels: string[] = [];
  const missingDetails: string[] = [];
  const seenMissing = new Set<string>();

  for (const { envVar, model } of configured) {
    if (getModelPrice(model, prices) !== null) continue;
    missingDetails.push(`${envVar}="${model}"`);
    if (!seenMissing.has(model)) {
      seenMissing.add(model);
      missingModels.push(model);
    }
  }

  if (missingModels.length > 0) {
    const context =
      mode === "sign-in"
        ? "Sign-in mode"
        : "Single-kitchen mode with an AI cap set";
    throw new DeploymentConfigError(
      `${context} cannot start: configured AI model(s) have no price row: ${missingModels.join(", ")}.`,
      `${context} cannot start: configured AI model(s) have no price row in app/src/lib/ai/prices.ts (${missingDetails.join(", ")}). Add a price entry before starting.`,
    );
  }
}

/**
 * Validates deployment environment variables, cap formats, model price rows,
 * and hook configuration without touching the database. Safe to call in
 * `instrumentation.ts` `register()`.
 */
export function checkDeploymentEnv(
  env: Record<string, string | undefined> = process.env,
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): DeploymentMode {
  const mode = getDeploymentMode(env);

  if (mode === "sign-in") {
    const missing = REQUIRED_SIGN_IN_ENV_VARS.filter((name) => {
      const value = env[name];
      return value === undefined || value.trim() === "";
    });
    if (missing.length > 0) {
      throw new DeploymentConfigError(
        `Sign-in mode requires environment variable(s): ${missing.join(", ")}. ` +
          `Set them to enable Google sign-in, or set SOUS_SIGN_IN=off for one household on a private network.`,
      );
    }

    const secret = env.BETTER_AUTH_SECRET!.trim();
    if (secret.length < MIN_BETTER_AUTH_SECRET_LENGTH) {
      throw new DeploymentConfigError(
        `BETTER_AUTH_SECRET must be at least ${MIN_BETTER_AUTH_SECRET_LENGTH} characters after trimming.`,
      );
    }

    // Validate BETTER_AUTH_URL syntax and scheme early.
    getBetterAuthOrigin(env);

    // Validate cap variable syntax before checking hooks and model prices.
    validateCapEnvVars(mode, env);

    const enabledHooks = HOOK_NAMES.filter((name) => connected[name]);
    if (enabledHooks.length > 0) {
      throw new DeploymentConfigError(
        `Sign-in mode cannot start with instance-wide hook(s) connected: ${enabledHooks.join(", ")}. ` +
          `Disconnect them in app/src/lib/hooks/connected.ts, or set SOUS_SIGN_IN=off for one household.`,
      );
    }

    validateConfiguredModelPrices(mode, env, prices);
  } else {
    validateCapEnvVars(mode, env);
    if (
      env.SOUS_AI_KITCHEN_CAP_USD !== undefined ||
      env.SOUS_AI_TOTAL_CAP_USD !== undefined
    ) {
      validateConfiguredModelPrices(mode, env, prices);
    }
  }

  return mode;
}

/**
 * Validates database invariants for the resolved deployment mode.
 * Single-kitchen mode refuses unless the database holds only the `home`
 * kitchen and zero members or invites.
 */
export async function checkDeploymentDatabase(
  mode: DeploymentMode,
  database: DeploymentDb = db,
): Promise<void> {
  if (mode !== "single-kitchen") {
    return;
  }

  const allKitchens = await database
    .select({ id: kitchens.id, slug: kitchens.slug })
    .from(kitchens);

  const hasHome = allKitchens.some((k) => k.slug === "home");
  if (!hasHome) {
    throw new DeploymentConfigError(
      'Single-kitchen mode requires the "home" kitchen, which is missing. Run `pnpm --dir app db:migrate`.',
    );
  }

  const otherKitchens = allKitchens.filter((k) => k.slug !== "home");
  if (otherKitchens.length > 0) {
    const slugs = otherKitchens
      .map((k) => k.slug)
      .sort()
      .join(", ");
    throw new DeploymentConfigError(
      'Single-kitchen mode refuses a database with kitchens other than "home".',
      `Single-kitchen mode refuses a database with kitchens other than "home" (found: ${slugs}).`,
    );
  }

  const [existingMember] = await database
    .select({ id: members.id })
    .from(members)
    .limit(1);
  if (existingMember) {
    throw new DeploymentConfigError(
      "Single-kitchen mode refuses a database that contains members.",
    );
  }

  const [existingInvite] = await database
    .select({ id: invites.id })
    .from(invites)
    .limit(1);
  if (existingInvite) {
    throw new DeploymentConfigError(
      "Single-kitchen mode refuses a database that contains invites.",
    );
  }
}

function encodeEnvValue(value: string | undefined): string {
  return value === undefined ? "\x01" : value;
}

function deploymentEnvKey(env: Record<string, string | undefined>): string {
  const envParts = [
    encodeEnvValue(env.SOUS_SIGN_IN),
    ...REQUIRED_SIGN_IN_ENV_VARS.map((k) => encodeEnvValue(env[k])),
    ...CAP_ENV_VARS.map((k) => encodeEnvValue(env[k])),
    encodeEnvValue(env.AI_TEXT_PROVIDER),
    encodeEnvValue(env.AI_TEXT_MODEL),
    encodeEnvValue(env.AI_COOK_CHAT_MODEL),
    encodeEnvValue(env.AI_VISION_PROVIDER),
    encodeEnvValue(env.AI_VISION_MODEL),
  ];
  const hookParts = HOOK_NAMES.map((name) => (connected[name] ? "1" : "0"));
  return `${envParts.join("\0")}|${hookParts.join("")}`;
}

const verifiedByDb = new WeakMap<object, Map<string, DeploymentMode>>();
const loggedErrors = new Set<string>();

function logDeploymentErrorOnce(message: string): void {
  if (loggedErrors.has(message)) return;
  loggedErrors.add(message);
  console.error(`[deployment] ${message}`);
}

/**
 * Runs environment and database start-up checks, memoized after the first
 * passing check for the current environment + database pair. Logs each
 * distinct refusal message once before rethrowing `DeploymentConfigError`.
 */
export async function ensureDeploymentReady(
  database: DeploymentDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<DeploymentMode> {
  const key = deploymentEnvKey(env);
  const dbCache = verifiedByDb.get(database);
  const cached = dbCache?.get(key);
  if (cached) {
    return cached;
  }

  try {
    const mode = checkDeploymentEnv(env);
    await checkDeploymentDatabase(mode, database);
    let nextCache = dbCache;
    if (!nextCache) {
      nextCache = new Map();
      verifiedByDb.set(database, nextCache);
    }
    nextCache.set(key, mode);
    return mode;
  } catch (err) {
    if (err instanceof DeploymentConfigError) {
      logDeploymentErrorOnce(err.logMessage);
    }
    throw err;
  }
}

/** Clears memoized start-up check state between tests. */
export function resetDeploymentCheckForTests(
  database: DeploymentDb = db,
): void {
  verifiedByDb.delete(database);
  loggedErrors.clear();
}

/**
 * Reads the `home` kitchen row by slug (used by single-kitchen access).
 */
export async function findHomeKitchen(
  database: DeploymentDb = db,
): Promise<{ id: string; slug: string } | null> {
  const [home] = await database
    .select({ id: kitchens.id, slug: kitchens.slug })
    .from(kitchens)
    .where(eq(kitchens.slug, "home"))
    .limit(1);
  return home ?? null;
}
