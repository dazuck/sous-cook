import { TRPCClientError } from "@trpc/client";

/**
 * Returns the server's allowance sentence when `err` is a tRPC client error
 * carrying an `allowance` payload (`scope` and `resetsAt` strings), or null
 * for any other error.
 */
export function allowanceSentence(err: unknown): string | null {
  if (!(err instanceof TRPCClientError)) return null;
  const data = err.data as { allowance?: unknown } | null | undefined;
  const allowance = data?.allowance;
  if (typeof allowance !== "object" || allowance === null) return null;
  const { scope, resetsAt } = allowance as {
    scope?: unknown;
    resetsAt?: unknown;
  };
  if (typeof scope !== "string" || typeof resetsAt !== "string") return null;
  return err.message;
}
