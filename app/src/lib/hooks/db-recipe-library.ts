import { asc, eq, sql } from "drizzle-orm";
import { db, docRecipes } from "@/lib/db";
import type { LibraryTab, RecipeLibrarySource } from "./types";

function linesFromDocRecipe(row: {
  name: string;
  rawDocText: string;
  ingredients: Array<{ item: string; amount?: string; unit?: string }> | null;
  steps: string[] | null;
  notes: string | null;
}): string[] {
  const rawLines = row.rawDocText
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s+/, "").trim())
    .filter((line) => line.length > 0);

  const cleanName = row.name.replace(/\s*\*+\s*$/, "").trim().toLowerCase();
  const bodyLines =
    rawLines.length > 0 &&
    rawLines[0]!.replace(/\s*\*+\s*$/, "").trim().toLowerCase() === cleanName
      ? rawLines.slice(1)
      : rawLines;

  if (bodyLines.length >= 2) {
    return bodyLines;
  }

  const constructed: string[] = [];
  for (const ing of row.ingredients ?? []) {
    const qty = [ing.amount, ing.unit].filter(Boolean).join(" ").trim();
    constructed.push(qty ? `${qty} ${ing.item}` : ing.item);
  }
  for (const step of row.steps ?? []) {
    const trimmed = step.trim();
    if (trimmed) constructed.push(trimmed);
  }
  if (row.notes?.trim()) {
    constructed.push(row.notes.trim());
  }
  return constructed.length >= 2 ? constructed : bodyLines;
}

export interface DbRecipeLibrarySource extends RecipeLibrarySource {
  readonly isDatabaseBackedLibrary: true;
}

export function isDbRecipeLibrarySource(
  source: RecipeLibrarySource,
): source is DbRecipeLibrarySource {
  return (source as Partial<DbRecipeLibrarySource>).isDatabaseBackedLibrary === true;
}

/**
 * Per-kitchen Recipe Library backed by `doc_recipes`.
 *
 * Returns `[]` when the kitchen has no saved library recipes yet, or groups
 * them by category in `doc_position`, `doc_slug` order.
 */
export function dbRecipeLibrary(kitchenId: string): DbRecipeLibrarySource {
  return {
    isDatabaseBackedLibrary: true,
    async readTabs(): Promise<LibraryTab[]> {
      const rows = await db
        .select({
          docSlug: docRecipes.docSlug,
          name: docRecipes.name,
          category: docRecipes.category,
          categoryTitle: docRecipes.categoryTitle,
          rawDocText: docRecipes.rawDocText,
          ingredients: docRecipes.ingredients,
          steps: docRecipes.steps,
          notes: docRecipes.notes,
        })
        .from(docRecipes)
        .where(eq(docRecipes.kitchenId, kitchenId))
        .orderBy(sql`${docRecipes.docPosition} asc nulls last`, asc(docRecipes.docSlug));

      if (rows.length === 0) return [];

      const categories = new Map<string, { title: string; children: LibraryTab[] }>();

      for (const row of rows) {
        const catTitle =
          row.categoryTitle?.trim() || row.category?.trim() || "Recipes";
        const catKey = catTitle.toLowerCase();
        let category = categories.get(catKey);
        if (!category) {
          category = { title: catTitle, children: [] };
          categories.set(catKey, category);
        }
        category.children.push({
          title: row.name,
          lines: linesFromDocRecipe(row),
          nonText: false,
          children: [],
        });
      }

      return [...categories.values()].map((cat) => ({
        title: cat.title,
        lines: [],
        nonText: false,
        children: cat.children,
      }));
    },
  };
}
