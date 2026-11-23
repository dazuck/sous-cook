/**
 * Loader for `fixtures/kitchen-plans/`: multi-branch cook plan fixtures kept
 * as plan only (task ids, kinds, branches, labels, minutes, needs, leads).
 * Task text is the label and there are no ingredients or steps, so no recipe
 * prose is stored. The timetable model tests are pinned against them.
 *
 * They can't go through `parseCookPlan`, which checks a plan against its
 * recipe's steps, so the shape is checked here instead and a malformed file
 * throws with its name.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { CookPlan } from "../cook-plan";

// Strict: a cue, ingredient indices or any other field is refused, and text must be the label
// (checked below), so no recipe prose can ride in.
const taskSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["ahead", "mise", "cook"]),
  branch: z.string().min(1),
  label: z.string().min(1),
  text: z.string().min(1),
  sourceStep: z.number().int().nullable(),
  implied: z.boolean(),
  needs: z.array(z.string()),
  minutes: z.strictObject({ est: z.number().nonnegative(), handsOff: z.boolean() }).optional(),
  lead: z.string().min(1).optional(),
});

const fileSchema = z.strictObject({
  description: z.string().min(1),
  plan: z.strictObject({ version: z.number().int(), tasks: z.array(taskSchema).min(1) }),
});

export interface KitchenPlanFixture {
  /** File basename without extension. */
  name: string;
  description: string;
  plan: CookPlan;
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "kitchen-plans");

/** Check one kitchen plan file's contents; throws with its name on any fault. */
export function parseKitchenPlan(name: string, raw: unknown): KitchenPlanFixture {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Kitchen plan ${name}: ${parsed.error.message}`);
  const tasks = parsed.data.plan.tasks;
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    if (t.text !== t.label) throw new Error(`Kitchen plan ${name}: ${t.id}'s text is not its label`);
    for (const need of t.needs) {
      if (!ids.has(need)) throw new Error(`Kitchen plan ${name}: ${t.id} needs missing ${need}`);
    }
  }
  const plan: CookPlan = {
    version: parsed.data.plan.version,
    tasks: tasks.map((t) => ({ ...t, ingredientIdx: [] })),
  };
  return { name, description: parsed.data.description, plan };
}

/** Read and check every kitchen plan, sorted by name. */
export function loadKitchenPlans(): KitchenPlanFixture[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => parseKitchenPlan(file.replace(/\.json$/, ""), JSON.parse(readFileSync(join(DIR, file), "utf8"))));
}
