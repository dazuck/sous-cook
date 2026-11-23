/**
 * What a stored cook plan was made from and by (slice P).
 *
 * A plan is worked out ahead of time (at Refresh for the family library, at
 * release for a pack) and copied into a queue row only when it still fits:
 * - `planSourceHash`: a hash of the derive input, the recipe fields the model
 *   sees (ingredients, steps, each step's ingredients). Not `raw_doc_text`:
 *   Refresh re-extracts every recipe, and the same Doc text can come back as
 *   different steps, which would orphan a plan's step indexes (P decision 1).
 * - `cookPlanStamp`: the plan version plus a hash of the prompt, the response
 *   schema and the thinking budget, so a prompt edit with no version bump
 *   still re-derives (P decision 2).
 * - `isSettledPlanError`: a failure the next attempt won't fix (the validator
 *   refused, the model declined, the reply never fit) against one it may (a
 *   timeout, a provider error). Settled ones are not retried on open (P
 *   decision 8).
 * - `verifyStoredPlan`: the three checks before a stored plan is trusted (P
 *   decision 5).
 * - `storedPlanToCopy`: what a queue add takes from a stored plan or error.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../serves-estimate-plan";
import type { ResponseSchema } from "../ai";
import {
  COOK_PLAN_VERSION,
  parseCookPlan,
  type CookPlan,
  type CookPlanRule,
  type RecipeForPlan,
} from "./cook-plan";
import {
  COOK_PLAN_BLOCKED,
  COOK_PLAN_TOKEN_LIMIT,
  COOK_PLAN_RESPONSE_SCHEMA,
  COOK_PLAN_SYSTEM_PROMPT,
  COOK_PLAN_THINKING_BUDGET,
} from "./cook-plan-derive";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Object fields that are null or undefined dropped, at every depth. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, withoutNulls(v)]),
    );
  }
  return value;
}

/**
 * sha256 (hex) of the derive input as canonical JSON. A library row stores
 * absent fields as null and an extraction leaves them undefined; both mean
 * the same to the prompt, so both hash the same.
 */
export function planSourceHash(recipe: RecipeForPlan): string {
  const input = withoutNulls({
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    stepIngredients: recipe.stepIngredients,
  });
  return sha256(canonicalJson(input));
}

/** What makes a plan, as the stamp names it. */
export interface CookPlanMaker {
  version: number;
  systemPrompt: string;
  responseSchema: ResponseSchema;
  thinkingBudget: number;
}

/** `"<version>:<16 hex of the prompt, schema and thinking budget>"`. */
export function stampOf(maker: CookPlanMaker): string {
  const hash = sha256(
    canonicalJson({
      systemPrompt: maker.systemPrompt,
      responseSchema: maker.responseSchema,
      thinkingBudget: maker.thinkingBudget,
    }),
  ).slice(0, 16);
  return `${maker.version}:${hash}`;
}

/** The running stamp: a plan or an error is current only at this value. */
export function cookPlanStamp(): string {
  return stampOf({
    version: COOK_PLAN_VERSION,
    systemPrompt: COOK_PLAN_SYSTEM_PROMPT,
    responseSchema: COOK_PLAN_RESPONSE_SCHEMA,
    thinkingBudget: COOK_PLAN_THINKING_BUDGET,
  });
}

/**
 * The prompt alone, 16 hex: the eval snapshots' `promptHash`, which predates
 * the stamp and must not move.
 */
export function cookPlanPromptHash(prompt: string = COOK_PLAN_SYSTEM_PROMPT): string {
  return sha256(prompt).slice(0, 16);
}

/** Every validator rule, so a rejection's text names a real one (exhaustive by type). */
const PLAN_RULES: Record<CookPlanRule, true> = {
  shape: true,
  "bad-character": true,
  "duplicate-id": true,
  "dangling-need": true,
  cycle: true,
  "bad-source-step": true,
  "implied-mismatch": true,
  "invented-cook": true,
  "uncovered-step": true,
  "dropped-number": true,
  "ingredient-outside-step": true,
  "mise-needs-cook": true,
  "ahead-needs-later": true,
  "lead-order": true,
  "no-cook-task": true,
  "unused-task": true,
  "disconnected-task": true,
  "branch-ends-twice": true,
};

/**
 * A failure another attempt at the same text won't fix, matched on the
 * derive's exact texts: the validator refused both replies
 * (`rejectedPlanError`, `rejected (<rule>): …` with a real rule), the model
 * declined (`COOK_PLAN_BLOCKED`), or the reply never fit the token budget
 * (`COOK_PLAN_TOKEN_LIMIT`). Anything else (a timeout, a provider or network
 * error, a key or service restriction whose message says "blocked") is
 * transient. The error text is the classification; nothing else is stored.
 */
export function isSettledPlanError(error: string | null | undefined): boolean {
  if (!error) return false;
  if (error === COOK_PLAN_BLOCKED || error === COOK_PLAN_TOKEN_LIMIT) return true;
  const rule = /^rejected \(([a-z-]+)\): /.exec(error)?.[1];
  return rule !== undefined && Object.hasOwn(PLAN_RULES, rule);
}

export type StoredPlanCheck =
  | { ok: true; plan: CookPlan }
  | { ok: false; reason: string };

/**
 * A stored plan, trusted only if it was made from this recipe's derive input
 * (hash), by the running prompt (stamp), and still validates against the
 * recipe (`parseCookPlan`). The plan returned is the validator's.
 */
export function verifyStoredPlan(
  plan: unknown,
  hash: string | null | undefined,
  stamp: string | null | undefined,
  recipe: RecipeForPlan,
): StoredPlanCheck {
  if (plan === null || plan === undefined) return { ok: false, reason: "no plan" };
  if (hash !== planSourceHash(recipe)) return { ok: false, reason: "hash" };
  if (stamp !== cookPlanStamp()) return { ok: false, reason: "stamp" };
  const parsed = parseCookPlan(plan, recipe);
  if (!parsed.ok) {
    return { ok: false, reason: `invalid (${parsed.rule}): ${parsed.detail}` };
  }
  return { ok: true, plan: parsed.plan };
}

/** A plan or error worked out ahead of time, with what it was made from and by. */
export interface StoredPlan {
  plan: unknown;
  error: string | null;
  sourceHash: string | null;
  stamp: string | null;
}

/** What a new queue row starts with: a plan, or a settled error, never both. */
export type PlanCopy =
  | { cookPlan: CookPlan; cookPlanError: null }
  | { cookPlan: null; cookPlanError: string };

export type StoredPlanCopy = { ok: true; copy: PlanCopy } | { ok: false; reason: string };

/**
 * What a queue add copies from a library row or a pack's plan file (P
 * decision 5): a plan that passes `verifyStoredPlan`, or a settled error made
 * from the same input at the same stamp. A transient error is not copied (the
 * queue row's own attempt may succeed), and anything failing a check counts
 * as nothing stored; the add then derives as it always has.
 */
export function storedPlanToCopy(stored: StoredPlan, recipe: RecipeForPlan): StoredPlanCopy {
  if (stored.plan !== null && stored.plan !== undefined) {
    const checked = verifyStoredPlan(stored.plan, stored.sourceHash, stored.stamp, recipe);
    return checked.ok ? { ok: true, copy: { cookPlan: checked.plan, cookPlanError: null } } : checked;
  }
  if (stored.error === null) return { ok: false, reason: "no plan" };
  if (!isSettledPlanError(stored.error)) return { ok: false, reason: "transient error" };
  if (stored.sourceHash !== planSourceHash(recipe)) return { ok: false, reason: "hash" };
  if (stored.stamp !== cookPlanStamp()) return { ok: false, reason: "stamp" };
  return { ok: true, copy: { cookPlan: null, cookPlanError: stored.error } };
}
