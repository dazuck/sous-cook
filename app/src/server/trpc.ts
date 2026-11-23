import { initTRPC, TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { db, kitchens } from "@/lib/db";

export interface KitchenContext {
  id: string;
  slug: string;
}

export interface MemberContext {
  id: string;
  role: "owner" | "cook";
}

export interface TRPCContext {
  db: typeof db;
  headers?: Headers;
  /**
   * Pre-resolved kitchen for server-side callers (such as `callerFor` in tests).
   * `createTRPCContext` never sets this; HTTP requests always resolve access in
   * `kitchenProcedure`.
   */
  kitchen?: KitchenContext;
  member?: MemberContext | null;
}

/**
 * Context passed to all procedures. Reads only; writes nothing so public
 * procedures such as `health` never mutate state.
 */
export const createTRPCContext = async (opts?: {
  req?: Request;
}): Promise<TRPCContext> => {
  return {
    db,
    headers: opts?.req ? opts.req.headers : new Headers(),
  };
};

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Procedure builder that resolves the caller's kitchen before input parsing.
 *
 * FIXME(WP4): Replace this single-kitchen-only gate with sign-in mode session
 * resolution, cross-site request checks, and invite acceptance. Until WP4
 * lands, requests without a pre-resolved context are refused unless
 * `SOUS_SIGN_IN=off`.
 */
export const kitchenProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.kitchen) {
    return next({
      ctx: {
        ...ctx,
        kitchen: ctx.kitchen,
        member: ctx.member ?? null,
      },
    });
  }

  if (process.env.SOUS_SIGN_IN !== "off") {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Sign-in mode is not yet available; set SOUS_SIGN_IN=off to run in single-kitchen mode.",
    });
  }

  const [home] = await ctx.db
    .select({ id: kitchens.id, slug: kitchens.slug })
    .from(kitchens)
    .where(eq(kitchens.slug, "home"))
    .limit(1);

  if (!home) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        'Default "home" kitchen not found; run `pnpm --dir app db:migrate`.',
    });
  }

  return next({
    ctx: {
      ...ctx,
      kitchen: { id: home.id, slug: home.slug },
      member: null as MemberContext | null,
    },
  });
});
