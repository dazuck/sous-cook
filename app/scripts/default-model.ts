/**
 * The model a paid cook-plan script derives with: the default text model,
 * the one the eval was tuned on (P non-goal 8). Refuses an override or a
 * missing key before anything is spent.
 */

import { getConfig } from "../src/lib/ai/config";

/** `"<provider>/<model>"`, or throws why the run can't call it. */
export function defaultModelOrRefuse(flag: string): string {
  for (const name of ["AI_TEXT_MODEL", "AI_TEXT_PROVIDER"]) {
    if (process.env[name]) {
      throw new Error(`${name} is set: cook plans use the default text model (P non-goal 8). Unset it and re-run.`);
    }
  }
  const config = getConfig();
  if (config.textProvider === "google" && !config.googleApiKey) {
    throw new Error(`GOOGLE_AI_API_KEY is not set: ${flag} calls the model.`);
  }
  return `${config.textProvider}/${config.textModel}`;
}
