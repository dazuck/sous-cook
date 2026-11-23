import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/routers/_app";
import { createTRPCContext } from "@/server/trpc";

/**
 * The function's limit, set rather than left to the plan's default (slice P):
 * Refresh plans recipes until `REFRESH_PLAN_BUDGET_MS` (200 s) and needs room
 * for the last derivation and the saves. 300 s is the Hobby plan's maximum
 * with fluid compute, which the project has on (checked 2026-10-11).
 */
export const maxDuration = 300;

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ req }),
  });

export { handler as GET, handler as POST };
