/**
 * Who a queue row is for: a slug (lowercase letters, digits and "-"). The
 * app runs as one cook, `DEFAULT_COOK`; the webhook may name another, whose
 * rows this kitchen's screens don't show.
 *
 * No imports, so the client's pages and the server's queue share it.
 */
export type UserId = string;

/** The one cook the app's own screens queue for and read. */
export const DEFAULT_COOK: UserId = "cook";

const USER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const USER_ID_MAX_LENGTH = 40;

/** Whether a string is a UserId: a slug of at most 40 characters. */
export function isValidUserId(userId: string): userId is UserId {
  return userId.length <= USER_ID_MAX_LENGTH && USER_ID_PATTERN.test(userId);
}
