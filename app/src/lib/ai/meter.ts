import type { AiFeature } from "../../../drizzle/schema";

export type { AiFeature };

export type KitchenAiMeter = {
  kind: "kitchen";
  kitchenId: string;
  memberId: string | null;
  feature: AiFeature;
};

export type ScriptAiMeter = {
  kind: "script";
  script: string;
};

export type AiMeter = KitchenAiMeter | ScriptAiMeter;

/**
 * Builds a kitchen meter from explicit kitchen and member identifiers.
 */
export function kitchenMeter(
  kitchenId: string,
  memberId: string | null,
  feature: AiFeature,
): KitchenAiMeter {
  return { kind: "kitchen", kitchenId, memberId, feature };
}

/**
 * Builds a meter for operator scripts under `app/scripts/` that run without a
 * database. Never call this from application code under `app/src/`.
 */
export function scriptMeter(script: string): ScriptAiMeter {
  return { kind: "script", script };
}
