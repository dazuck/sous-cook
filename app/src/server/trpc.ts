import { initTRPC, TRPCError } from "@trpc/server";
import { findAllowanceUsed } from "@/lib/ai";
import { getAuth } from "@/lib/auth/auth";
import { db } from "@/lib/db";
import { resolveAccess } from "@/lib/kitchens/access";
import {
  DeploymentConfigError,
  ensureDeploymentReady,
  getBetterAuthOrigin,
  type DeploymentMode,
} from "@/lib/kitchens/deployment";
import { NotInvitedError } from "@/lib/kitchens/invites";

export interface KitchenContext {
  id: string;
  slug: string;
}

export interface MemberContext {
  id: string;
  role: "owner" | "cook";
}

export interface SessionContext {
  user: {
    id: string;
    email: string;
    name: string;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
  };
}

export interface TRPCContext {
  db: typeof db;
  headers: Headers;
  mode: DeploymentMode;
  session: SessionContext | null;
}

interface TestCallerGrant {
  kitchen: KitchenContext;
  member: MemberContext | null;
}

/**
 * Module-private registry for server-side test callers (`callerFor`).
 * `createTRPCContext` never writes to this map, so no HTTP request or plain
 * context object can bypass session resolution or cross-site checks.
 */
const testCallerGrants = new WeakMap<TRPCContext, TestCallerGrant>();

/**
 * Creates a tRPC context authorized only for in-process test callers
 * (`callerFor`). Never call from an HTTP route handler.
 */
export function createTestTRPCContext(
  kitchen: Pick<KitchenContext, "id" | "slug">,
  member: MemberContext | null = null,
  database: typeof db = db,
): TRPCContext {
  const ctx: TRPCContext = {
    db: database,
    headers: new Headers(),
    mode: "sign-in",
    session: null,
  };
  testCallerGrants.set(ctx, {
    kitchen: { id: kitchen.id, slug: kitchen.slug },
    member,
  });
  return ctx;
}

/**
 * Context passed to all procedures. Validates deployment readiness (memoized)
 * and, in sign-in mode, reads the session from the request's cookies and
 * forwards any `Set-Cookie` headers produced by session renewal to
 * `resHeaders`. When a session is due for sliding renewal, `getSession`
 * updates the session row (including on a request that is later refused); it
 * never accepts invites or creates kitchens or members.
 */
export const createTRPCContext = async (opts?: {
  req?: Request;
  resHeaders?: Headers;
}): Promise<TRPCContext> => {
  const headers = opts?.req ? opts.req.headers : new Headers();

  let mode: DeploymentMode;
  try {
    mode = await ensureDeploymentReady(db);
  } catch (err) {
    if (err instanceof DeploymentConfigError) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
        cause: err,
      });
    }
    throw err;
  }

  if (mode === "single-kitchen") {
    return {
      db,
      headers,
      mode,
      session: null,
    };
  }

  const { headers: sessionHeaders, response: sessionResult } =
    await getAuth().api.getSession({ headers, returnHeaders: true });

  if (opts?.resHeaders && sessionHeaders) {
    const cookies =
      typeof sessionHeaders.getSetCookie === "function"
        ? sessionHeaders.getSetCookie()
        : [];
    let forwardedCookie = false;
    if (cookies.length > 0) {
      for (const cookie of cookies) {
        opts.resHeaders.append("set-cookie", cookie);
      }
      forwardedCookie = true;
    } else {
      const single = sessionHeaders.get("set-cookie");
      if (single) {
        opts.resHeaders.append("set-cookie", single);
        forwardedCookie = true;
      }
    }
    if (forwardedCookie) {
      // Prevent shared caches from storing a response carrying a renewed session cookie.
      opts.resHeaders.set("cache-control", "private, no-store");
    }
  }

  const session: SessionContext | null = sessionResult
    ? {
        user: {
          id: sessionResult.user.id,
          email: sessionResult.user.email,
          name: sessionResult.user.name,
        },
        session: {
          id: sessionResult.session.id,
          userId: sessionResult.session.userId,
          expiresAt: sessionResult.session.expiresAt,
        },
      }
    : null;

  return {
    db,
    headers,
    mode,
    session,
  };
};

const t = initTRPC.context<TRPCContext>().create({
  errorFormatter({ shape, error }) {
    const reason =
      error.cause instanceof NotInvitedError
        ? ("not-invited" as const)
        : undefined;
    const allowanceErr = findAllowanceUsed(error.cause);
    const allowance = allowanceErr
      ? {
          scope: allowanceErr.scope,
          resetsAt: allowanceErr.resetsAt.toISOString(),
        }
      : undefined;
    return {
      ...shape,
      data: {
        ...shape.data,
        ...(reason !== undefined ? { reason } : {}),
        ...(allowance !== undefined ? { allowance } : {}),
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

function assertSameOriginRequest(headers: Headers): void {
  const origin = headers.get("origin");
  if (origin !== null) {
    let expectedOrigin: string;
    try {
      expectedOrigin = getBetterAuthOrigin();
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          err instanceof Error
            ? err.message
            : "BETTER_AUTH_URL is not configured",
        cause: err,
      });
    }
    if (origin !== expectedOrigin) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Cross-site request refused",
      });
    }
  }

  const secFetchSite = headers.get("sec-fetch-site");
  if (secFetchSite !== null) {
    const normalized = secFetchSite.trim().toLowerCase();
    if (normalized !== "same-origin" && normalized !== "none") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Cross-site request refused",
      });
    }
  }
}

/**
 * Procedure builder that enforces cross-site checks, authentication, and
 * kitchen/member resolution before input parsing.
 */
export const kitchenProcedure = t.procedure.use(async ({ ctx, next }) => {
  let kitchen: KitchenContext;
  let member: MemberContext | null;

  const testGrant = testCallerGrants.get(ctx);
  if (testGrant) {
    kitchen = testGrant.kitchen;
    member = testGrant.member;
  } else {
    // 1. Cross-site checks (sign-in mode, queries and mutations alike).
    if (ctx.mode === "sign-in") {
      assertSameOriginRequest(ctx.headers);
    }

    // 2. Require a session in sign-in mode.
    if (ctx.mode === "sign-in" && !ctx.session) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Sign in required",
      });
    }

    // 3. Resolve kitchen membership (may accept a pending invite on first request).
    try {
      const access =
        ctx.mode === "single-kitchen"
          ? await resolveAccess({ mode: "single-kitchen" }, ctx.db)
          : await resolveAccess(
              { mode: "sign-in", user: ctx.session!.user },
              ctx.db,
            );
      kitchen = access.kitchen;
      member = access.member;
    } catch (err) {
      // 4. Signed in with no kitchen -> FORBIDDEN with reason "not-invited".
      if (err instanceof NotInvitedError) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not invited",
          cause: err,
        });
      }
      if (err instanceof DeploymentConfigError) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err.message,
          cause: err,
        });
      }
      throw err;
    }
  }

  // 5. Run the procedure with the resolved kitchen and member.
  const result = await next({
    ctx: {
      ...ctx,
      kitchen,
      member,
    },
  });

  // 6. Map any AllowanceUsedError in the error's cause chain to TOO_MANY_REQUESTS.
  if (!result.ok) {
    const allowance = findAllowanceUsed(result.error);
    if (allowance) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: allowance.message,
        cause: allowance,
      });
    }
  }

  return result;
});
