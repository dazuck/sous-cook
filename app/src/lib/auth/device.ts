import { authClient } from "./client";

export interface DeviceNavigation {
  assign(url: string): void;
  replace(url: string): void;
}

export interface DeviceAuthClient {
  signOut(): Promise<{
    data: unknown;
    error: { status?: number } | null;
  }>;
  signIn: {
    social(params: {
      provider: "google";
      callbackURL: string;
      disableRedirect: boolean;
    }): Promise<{
      data: { url?: string } | null;
      error: { status?: number } | null;
    }>;
  };
}

export type StartSignInOutcome =
  | "started"
  | "network"
  | "too-many-tries"
  | "refused";

export type SignOutOutcome = "signed-out" | "network" | "refused";

const GOOGLE_OAUTH_URL_PREFIX = "https://accounts.google.com/";

function isConfirmedSignOut(
  result: Awaited<ReturnType<DeviceAuthClient["signOut"]>>,
): boolean {
  if (result.error !== null) {
    return false;
  }
  if (typeof result.data !== "object" || result.data === null) {
    return false;
  }
  return (result.data as { success?: unknown }).success === true;
}

function isSecurityError(err: unknown): boolean {
  const isDomException =
    err instanceof DOMException ||
    (typeof window !== "undefined" &&
      typeof window.DOMException === "function" &&
      err instanceof window.DOMException);
  return isDomException && err.name === "SecurityError";
}

function clearStorage(getStorage: () => Storage): void {
  try {
    getStorage().clear();
  } catch (err) {
    if (isSecurityError(err)) {
      return;
    }
    throw err;
  }
}

/**
 * Empties all browser storage for this origin (localStorage and this tab's
 * sessionStorage). Skips a store if the browser blocks access with a
 * SecurityError; rethrows any other error.
 */
export function forgetDevice(): void {
  clearStorage(() => window.localStorage);
  clearStorage(() => window.sessionStorage);
}

/**
 * Ends any existing session, empties browser storage, and starts a Google
 * sign-in redirect. Storage is emptied only after sign-out succeeds with
 * error === null and { success: true }.
 */
export async function startSignIn(
  client: DeviceAuthClient = authClient,
  navigation: DeviceNavigation = window.location,
): Promise<StartSignInOutcome> {
  let signOutResult: Awaited<ReturnType<DeviceAuthClient["signOut"]>>;
  try {
    signOutResult = await client.signOut();
  } catch {
    return "network";
  }

  if (!isConfirmedSignOut(signOutResult)) {
    return signOutResult.error?.status === 429 ? "too-many-tries" : "refused";
  }

  forgetDevice();

  let signInResult: Awaited<ReturnType<DeviceAuthClient["signIn"]["social"]>>;
  try {
    signInResult = await client.signIn.social({
      provider: "google",
      callbackURL: "/sign-in/done",
      disableRedirect: true,
    });
  } catch {
    return "network";
  }

  if (signInResult.error !== null) {
    return signInResult.error?.status === 429 ? "too-many-tries" : "refused";
  }

  const url = signInResult.data?.url;
  if (typeof url !== "string" || !url.startsWith(GOOGLE_OAUTH_URL_PREFIX)) {
    return "refused";
  }

  navigation.assign(url);
  return "started";
}

/**
 * Ends the current session, empties browser storage, and navigates to /sign-in.
 * Storage is emptied and navigation occurs only after sign-out succeeds with
 * error === null and { success: true }.
 */
export async function signOutOfDevice(
  client: DeviceAuthClient = authClient,
  navigation: DeviceNavigation = window.location,
): Promise<SignOutOutcome> {
  let signOutResult: Awaited<ReturnType<DeviceAuthClient["signOut"]>>;
  try {
    signOutResult = await client.signOut();
  } catch {
    return "network";
  }

  if (!isConfirmedSignOut(signOutResult)) {
    return "refused";
  }

  forgetDevice();
  navigation.replace("/sign-in");
  return "signed-out";
}
