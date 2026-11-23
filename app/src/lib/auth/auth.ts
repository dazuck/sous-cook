import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import {
  authAccount,
  authSession,
  authUser,
  authVerification,
  getDb,
} from "@/lib/db";
import {
  beforeCreateSession,
  beforeCreateUser,
  createBeforeCreateSession,
  createBeforeCreateUser,
} from "@/lib/kitchens/invites";
import { DeploymentConfigError, getBetterAuthOrigin } from "@/lib/kitchens/deployment";

/** Session lifetime: 90 days in seconds. */
export const SESSION_EXPIRES_IN_SECONDS = 90 * 24 * 60 * 60;

/** Sliding refresh cadence: 1 day in seconds. */
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

/** Sign-in-only Google OAuth scopes. */
export const GOOGLE_SCOPES = ["openid", "email", "profile"] as const;

const SOCIAL_SCOPE_GUARD_PATHS = new Set(["/sign-in/social", "/link-social"]);

const rejectCustomSocialScopes = createAuthMiddleware(async (ctx) => {
  if (!SOCIAL_SCOPE_GUARD_PATHS.has(ctx.path)) {
    return;
  }
  const body = ctx.body as Record<string, unknown> | undefined;
  const scopes = body?.scopes;
  const hasCustomScopes = Array.isArray(scopes)
    ? scopes.length > 0
    : scopes !== undefined && scopes !== null;
  if (hasCustomScopes) {
    throw new APIError("BAD_REQUEST", {
      message: "Custom OAuth scopes are not allowed",
    });
  }
  const additionalParams = body?.additionalParams;
  const hasAdditionalParams =
    typeof additionalParams === "object" &&
    additionalParams !== null &&
    !Array.isArray(additionalParams) &&
    Object.keys(additionalParams).length > 0;
  if (hasAdditionalParams) {
    throw new APIError("BAD_REQUEST", {
      message: "Custom OAuth additionalParams are not allowed",
    });
  }
});

export type AuthDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface CreateAuthOptions<P extends BetterAuthPlugin[] = []> {
  db?: AuthDb;
  secret?: string;
  baseURL?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  plugins?: P;
}

function requireSetting(
  explicit: string | undefined,
  envName: string,
): string {
  const value = (explicit ?? process.env[envName])?.trim();
  if (!value) {
    throw new DeploymentConfigError(
      `${envName} environment variable is required to initialize sign-in.`,
    );
  }
  return value;
}

/**
 * Factory for the Better Auth instance. Used lazily by `getAuth()` in
 * production (with no extra plugins) and by test helpers with `testUtils()`.
 */
export function createAuth<P extends BetterAuthPlugin[] = []>(
  options: CreateAuthOptions<P> = {},
) {
  const database = options.db ?? getDb();
  const secret = requireSetting(options.secret, "BETTER_AUTH_SECRET");
  const baseURL = requireSetting(options.baseURL, "BETTER_AUTH_URL");
  const origin = getBetterAuthOrigin({
    ...process.env,
    BETTER_AUTH_URL: baseURL,
  });
  const googleClientId = requireSetting(
    options.googleClientId,
    "GOOGLE_CLIENT_ID",
  );
  const googleClientSecret = requireSetting(
    options.googleClientSecret,
    "GOOGLE_CLIENT_SECRET",
  );

  // Use the top-level hooks directly when using the default app db so wiring
  // assertions (`auth.options.databaseHooks.user.create.before === beforeCreateUser`)
  // hold while custom-db callers still query their provided instance.
  const userBeforeCreate = options.db
    ? createBeforeCreateUser(options.db)
    : beforeCreateUser;
  const sessionBeforeCreate = options.db
    ? createBeforeCreateSession(options.db)
    : beforeCreateSession;

  return betterAuth({
    secret,
    baseURL,
    trustedOrigins: [origin],
    // In better-auth 1.7.18, `@better-auth/drizzle-adapter` resolves tables
    // from `config.schema` using each model's configured `modelName`.
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: {
        auth_user: authUser,
        auth_session: authSession,
        auth_account: authAccount,
        auth_verification: authVerification,
      },
    }),
    emailAndPassword: {
      enabled: false,
    },
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        disableDefaultScope: true,
        scope: [...GOOGLE_SCOPES],
        prompt: "select_account",
        requireEmailVerification: true,
      },
    },
    user: {
      modelName: "auth_user",
    },
    session: {
      modelName: "auth_session",
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: {
        enabled: false,
      },
    },
    account: {
      modelName: "auth_account",
      encryptOAuthTokens: true,
    },
    verification: {
      modelName: "auth_verification",
    },
    onAPIError: {
      errorURL: "/not-invited",
    },
    hooks: {
      before: rejectCustomSocialScopes,
    },
    databaseHooks: {
      user: {
        create: {
          before: userBeforeCreate,
        },
      },
      session: {
        create: {
          before: sessionBeforeCreate,
        },
      },
    },
    plugins: (options.plugins ?? []) as P,
  });
}

export type AppAuth = ReturnType<typeof createAuth>;

let _auth: AppAuth | null = null;
let _authKey: string | null = null;

function authEnvKey(): string {
  return [
    process.env.BETTER_AUTH_SECRET ?? "",
    process.env.BETTER_AUTH_URL ?? "",
    process.env.GOOGLE_CLIENT_ID ?? "",
    process.env.GOOGLE_CLIENT_SECRET ?? "",
  ].join("\0");
}

/**
 * Lazily returns the production Better Auth instance so `next build` and
 * single-kitchen mode never read auth environment variables at module load.
 */
export function getAuth(): AppAuth {
  const key = authEnvKey();
  if (_auth && _authKey === key) {
    return _auth;
  }
  _auth = createAuth();
  _authKey = key;
  return _auth;
}

/** Clears the cached auth instance between tests. */
export function resetAuthForTests(): void {
  _auth = null;
  _authKey = null;
}
