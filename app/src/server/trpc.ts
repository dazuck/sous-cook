import { initTRPC } from "@trpc/server";
import { db } from "@/lib/db";

export interface TRPCContext {
  db: typeof db;
}

// Context passed to all procedures
export const createTRPCContext = async (): Promise<TRPCContext> => {
  return { db };
};

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
