"use client";

import { TRPCClientError } from "@trpc/client";
import { loadSession } from "@/lib/kitchen/cook-session";
import { markSignedOut } from "@/lib/kitchen/signed-out";
import { isCookRoute } from "@/lib/pwa/update-when-idle";

export type AuthErrorKind = "sign-in" | "not-invited";

export interface AuthErrorDeps {
  navigation?: {
    replace(url: string): void;
  };
}

const COOK_ROUTE_PREFIX = "/kitchen/queue/";

let navigated = false;

/**
 * Classifies a tRPC error that means the caller cannot stay on a kitchen page:
 * no active session ("sign-in") or a signed-in user without a kitchen
 * ("not-invited"). Cross-site refusals and AI cap refusals return null.
 */
export function authErrorKind(err: unknown): AuthErrorKind | null {
  if (!(err instanceof TRPCClientError)) return null;
  const data = err.data as { code?: unknown; reason?: unknown } | null | undefined;
  if (data?.code === "UNAUTHORIZED") return "sign-in";
  if (data?.code === "FORBIDDEN" && data.reason === "not-invited") {
    return "not-invited";
  }
  return null;
}

function cookQueueIdFromPathname(pathname: string): string | null {
  if (!isCookRoute(pathname)) return null;
  const rest = pathname.slice(COOK_ROUTE_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  const segment = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  if (segment.length === 0) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Reacts to an auth refusal from the server without consulting deployment mode
 * or cookies. A cook page with a saved local session stays open and records
 * that the session ended; every other page performs one full-page replacement
 * to /sign-in or /not-invited.
 */
export function handleAuthError(err: unknown, deps?: AuthErrorDeps): void {
  if (typeof window === "undefined") return;
  const kind = authErrorKind(err);
  if (kind === null) return;

  const queueId = cookQueueIdFromPathname(window.location.pathname);
  if (queueId !== null && loadSession(queueId) !== null) {
    markSignedOut();
    return;
  }

  if (navigated) return;
  navigated = true;

  const navigation = deps?.navigation ?? window.location;
  navigation.replace(kind === "sign-in" ? "/sign-in" : "/not-invited");
}

export function resetAuthErrorsForTests(): void {
  navigated = false;
}
