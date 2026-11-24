import { TRPCClientError } from "@trpc/client";
import { AllowanceUsedError, type AllowanceScope } from "@/lib/ai/types";
import type { AppRouter } from "@/server/routers/_app";

/**
 * Builds the `TRPCClientError` a client receives when the server refuses a
 * request because the monthly AI allowance has been used up.
 */
export function allowanceError(
  scope: AllowanceScope,
  resetsAt: Date,
): TRPCClientError<AppRouter> {
  return TRPCClientError.from<AppRouter>({
    error: {
      code: -32029,
      message: new AllowanceUsedError(scope, resetsAt).message,
      data: {
        code: "TOO_MANY_REQUESTS",
        httpStatus: 429,
        allowance: {
          scope,
          resetsAt: resetsAt.toISOString(),
        },
      },
    },
  });
}
