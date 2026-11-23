/**
 * Every plan the app's tests cook from, for the timetable's corpus tests (the
 * model's and the layout's): the cook-plan eval snapshots that parse, the
 * kitchen plans, the zucchini wraps and the Fannie Farmer pack's plans.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCookPlan, type CookPlan } from "../cook-plan";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "./load-cook-plan-fixtures";
import { loadKitchenPlans } from "./load-kitchen-plans";
import { ZUCCHINI_PLAN } from "./zucchini-wraps";

export function timetableCorpus(): { name: string; plan: CookPlan }[] {
  const snapshots = loadCookPlanSnapshots();
  const evalPlans = loadCookPlanFixtures().flatMap((f) => {
    const raw = snapshots.get(f.name)?.raw;
    if (!raw) return [];
    const parsed = parseCookPlan(raw, f.recipe);
    return parsed.ok ? [{ name: f.name, plan: parsed.plan }] : [];
  });
  const pack = JSON.parse(
    // A path, not a URL: under a DOM environment the global URL is the DOM's, which node:fs refuses.
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../pack-plans/fannie-farmer-1896.cook-plans.json"), "utf8"),
  ) as { recipes: Record<string, { plan: CookPlan }> };
  return [
    ...evalPlans,
    ...loadKitchenPlans().map((k) => ({ name: k.name, plan: k.plan })),
    { name: "zucchini-wraps", plan: ZUCCHINI_PLAN },
    ...Object.entries(pack.recipes).map(([name, r]) => ({ name: `pack:${name}`, plan: r.plan })),
  ];
}
