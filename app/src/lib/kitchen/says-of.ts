/**
 * A layout as text, so two that say the same compare equal whichever object says it. A Map or a
 * Set is read by what it holds (plain JSON writes both as `{}`, which would call any two alike).
 * A function is left out, as JSON leaves it: a layout's functions are made from its numbers.
 */
export function saysOf(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v instanceof Map ? { map: [...v.entries()] } : v instanceof Set ? { set: [...v.values()] } : v,
  );
}
