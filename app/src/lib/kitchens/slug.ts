/** Valid kitchen slug: lowercase ASCII alphanumerics separated by single hyphens. */
export const KITCHEN_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Maximum allowed length of a kitchen slug (matches `kitchens_slug_shape`). */
export const KITCHEN_SLUG_MAX_LENGTH = 40;

/** Returns true when `slug` satisfies the `kitchens.slug` check constraint. */
export function isValidKitchenSlug(slug: string): boolean {
  return (
    slug.length >= 1 &&
    slug.length <= KITCHEN_SLUG_MAX_LENGTH &&
    KITCHEN_SLUG_PATTERN.test(slug)
  );
}

/**
 * Derives a kitchen slug from a human-readable kitchen name: Unicode NFKD,
 * drop combining marks, lowercase, collapse runs outside `[a-z0-9]` to `-`,
 * trim leading/trailing `-`, cut to 40 characters, and trim a trailing `-`
 * again. Returns `""` when no ASCII alphanumeric characters remain.
 */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KITCHEN_SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
}
