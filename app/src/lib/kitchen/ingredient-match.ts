/**
 * Which of the recipe's lines a spoken name means (slice B5d, D12; the
 * Player's `ingredient-match.ts`, ported onto the lines the cook page reads).
 * Matching is token containment: every meaningful spoken word must be in the
 * line's name, because speech recognition errs a word at a time ("pecorino"
 * arrives clean or not at all, wrapped in "the" and "of"). The lines on the
 * screen in hand are tried first: "egg" at the whisk step is that step's egg,
 * not every egg in the recipe.
 */

import type { StoredIngredientLines } from "./ingredient-display";

export type IngredientMatch =
  /** Stored indices, in recipe order. One for a match; several sharing one name are one answer (D12). */
  | { kind: "match"; indices: number[] }
  /** Lines with different names the words fit: the cook picks. */
  | { kind: "which"; indices: number[] }
  | { kind: "none" };

const STOPWORDS = new Set(["the", "a", "an", "of", "some", "in", "on", "for", "with", "my", "our", "your", "that", "this"]);

/** "eggs" and "egg" are one word to the matcher. */
function fold(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(fold);
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function resolve(lines: StoredIngredientLines, indices: number[]): IngredientMatch | null {
  if (indices.length === 0) return null;
  const first = lines[indices[0]!]!.name;
  return indices.every((i) => sameName(lines[i]!.name, first))
    ? { kind: "match", indices }
    : { kind: "which", indices };
}

/** The lines `spoken` names, the screen's own (`onScreen`, stored indices) first. */
export function matchIngredient(
  lines: StoredIngredientLines,
  onScreen: readonly number[],
  spoken: string,
): IngredientMatch {
  const said = tokens(spoken);
  if (said.length === 0) return { kind: "none" };
  const fits = (i: number) => {
    const line = lines[i];
    if (line == null || line.name === "") return false;
    const name = new Set(tokens(line.name));
    return said.every((t) => name.has(t));
  };
  const here = [...new Set(onScreen)].filter(fits).sort((a, b) => a - b);
  const all = lines.flatMap((_, i) => (fits(i) ? [i] : []));
  return resolve(lines, here) ?? resolve(lines, all) ?? { kind: "none" };
}
