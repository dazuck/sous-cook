/**
 * Why a queued recipe couldn't open, as a code for the log and the error
 * screen's `data-error-code`; null when there is a recipe to cook. The
 * screen itself says one plain line whatever the code, and for UNREADABLE
 * the recipe's name and why.
 *
 * A recipe on hand wins over an error: a failed background refetch keeps
 * the last good data, and the cook stays up through it. Since slice B4 a
 * recipe to cook is one read as a pack recipe; a stored recipe that can't be
 * read is UNREADABLE, never cooked from the legacy shape.
 */
export function openFailure(
  item: { recipeData: unknown; packRecipe: unknown } | null | undefined,
  error: { data?: { code?: string } | null } | null,
): string | null {
  if (item?.packRecipe) return null;
  if (item?.recipeData) return "UNREADABLE";
  if (error) return error.data?.code ?? "FETCH_FAILED";
  return item ? "NO_RECIPE" : "NOT_FOUND";
}
