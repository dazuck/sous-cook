/** What the app calls a recipe that came with no name: words it sets itself, so sentence case (DS §4). */
export const UNTITLED = "Untitled recipe";

/**
 * The name a recipe goes by on screen: the first of `names` with words in
 * it, trimmed and in its own case, else `UNTITLED`. An empty name can arrive
 * (the queue webhook takes any string), and drawn as is it leaves an empty
 * heading and a stray " · " before the cook's place (V fix round 1).
 */
export function dishName(...names: (string | null | undefined)[]): string {
  for (const name of names) {
    const trimmed = name?.trim();
    if (trimmed) return trimmed;
  }
  return UNTITLED;
}
