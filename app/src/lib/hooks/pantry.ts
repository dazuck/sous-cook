/**
 * What the app itself reads out of the pantry's sections (`PantryStore`,
 * `types.ts`): which sections are food, and where a section's items sit for
 * Ask (fridge, freezer or shelf). Pure; the store does the reading and
 * writing.
 */

import type { PantrySection } from "./types";

/**
 * Headings that aren't food: notes a household may keep beside its
 * inventory. Their sections are never read as inventory, never offered for
 * an addition and never changed when a cook finishes.
 */
export const NON_INVENTORY_HEADINGS = ["our setup", "our family"];

export function isFoodInventoryHeading(heading: string): boolean {
  const norm = heading.trim().toLowerCase();
  return !NON_INVENTORY_HEADINGS.some((x) => norm.startsWith(x));
}

/** The pantry's food, bucketed for Ask's reference information. */
export interface PantryInventory {
  fridge: string[];
  freezer: string[];
  pantry: string[];
}

type InventoryBucket = keyof PantryInventory;

/**
 * Routes a section to a bucket by keywords in its heading (not an exact
 * map), so a household can rename and reorder its sections without one
 * silently dropping out. Anything unrecognised is shelf-stable pantry.
 */
function bucketOf(heading: string): InventoryBucket | null {
  const h = heading.trim().toLowerCase();
  if (!isFoodInventoryHeading(h)) return null;
  if (h.includes("freezer")) return "freezer";
  if (h.includes("perishable") || h === "fridge" || h.includes("aromatic") || h.includes("garden")) {
    return "fridge";
  }
  return "pantry";
}

/** Every food section's items, in section order, by bucket. */
export function pantryInventory(sections: readonly PantrySection[]): PantryInventory {
  const buckets: PantryInventory = { fridge: [], freezer: [], pantry: [] };
  for (const section of sections) {
    const bucket = bucketOf(section.heading);
    if (bucket) buckets[bucket].push(...section.items);
  }
  return buckets;
}
