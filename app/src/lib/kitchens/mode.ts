export type DeploymentMode = "sign-in" | "single-kitchen";

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

export const SIGN_IN_MODE_COOKIE = "sous-sign-in";

const SIGN_IN_MODE_COOKIE_PAIR = `${SIGN_IN_MODE_COOKIE}=1`;

/**
 * Reads an HTTP Cookie header value and returns true only when one of its
 * semicolon-separated pairs, after trimming spaces around the pair, is
 * `sous-sign-in=1`.
 */
export function readSignInModeCookie(cookies: string): boolean {
  if (!cookies) {
    return false;
  }
  for (const pair of cookies.split(";")) {
    if (pair.trim() === SIGN_IN_MODE_COOKIE_PAIR) {
      return true;
    }
  }
  return false;
}
