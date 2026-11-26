/**
 * Which hooks are connected. All off as shipped: the app runs whole without
 * any of them, and each surface that depends on one draws its unconnected
 * state (hidden, empty or skipped).
 *
 * To connect a hook, give it an implementation in `registry.ts` and set its
 * switch here to `true`. A switch on with no implementation fails loudly the
 * first time the hook is used, naming its spec (`docs/hooks/<name>.md`).
 *
 * Plain data, no imports with side effects: the client's pages read it to
 * decide what to draw, the server to decide what to call.
 */

import type { HookName } from "./types";

export const connected: Record<HookName, boolean> = {
  "recipe-library": true,
  "cook-log": true,
  pantry: true,
  "shopping-list": true,
  ideas: true,
  "household-context": true,
};
