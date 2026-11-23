/**
 * The cook's side of the queue-time check (B4 fix round 1, MED 3): the add
 * procedures refuse a recipe the cook page couldn't read with tRPC's
 * `UNPROCESSABLE_CONTENT`, and the screen that asked says so in its own
 * plain line. The server's reason goes to the console, not the cook.
 */

function codeOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("data" in error)) return undefined;
  const { data } = error as { data?: { code?: unknown } | null };
  return data?.code;
}

/** Whether a failed add was the server refusing a recipe it couldn't read. */
export function isUnreadableRecipe(error: unknown): boolean {
  return codeOf(error) === "UNPROCESSABLE_CONTENT";
}

/**
 * Whether a failed add was Sous's serving estimate failing (slice B4b): the
 * recipe states no count and the estimate couldn't be made, so nothing was
 * queued (`PRECONDITION_FAILED`).
 */
export function isServesEstimateFailure(error: unknown): boolean {
  return codeOf(error) === "PRECONDITION_FAILED";
}

export const QUEUE_REFUSAL_COPY = {
  /** The library's line when a tapped recipe was refused. */
  notSent: "Couldn't read that recipe, so it wasn't sent.",
  /** The import modal's line when an add was refused. */
  notAdded: "Couldn't read that recipe, so it wasn't added.",
  /** The import modal's line when Sous couldn't estimate the serving count (B4b). */
  servesNotEstimated: "Couldn't work out how many that serves, so it wasn't added. Try again.",
  /** The import modal's line when an add failed for any other reason. */
  addFailed: "Couldn't add that recipe. Try again.",
} as const;
