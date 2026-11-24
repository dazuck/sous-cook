/**
 * A photo for Ask Sous, as the camera's file input hands it over (DS §5 Ask,
 * v1.60; DECISIONS 2026-11-22 "Ask Sous is a side panel", call 15): what is
 * wrong with it, if anything, before it is sent as the cook's turn.
 *
 * - `unread`: nothing to send: an empty file, or one the browser could not
 *   read into a `data:` address.
 * - `not-a-photo`: a file that is no picture (the input asks for pictures,
 *   and a file chooser may still hand over anything).
 */
export function photoProblem(
  file: { size: number; type: string },
  dataUrl: string | null,
): "unread" | "not-a-photo" | null {
  if (file.size === 0 || dataUrl === null || !dataUrl.startsWith("data:")) return "unread";
  if (file.type !== "" && !file.type.startsWith("image/")) return "not-a-photo";
  if (!dataUrl.startsWith("data:image/")) return "not-a-photo";
  return null;
}
