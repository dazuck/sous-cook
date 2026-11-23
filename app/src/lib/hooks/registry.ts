/**
 * The hooks' implementations, server side. All null as shipped.
 *
 * To connect a hook: write an object that satisfies its interface
 * (`types.ts`; its spec is `docs/hooks/<name>.md`), put it in its slot below,
 * and set its switch in `connected.ts`. Implementations hold credentials and
 * talk to outside services, so this module is only ever imported by server
 * code (routers, route handlers, `lib/` modules that already import the
 * database).
 */

import { connected } from "./connected";
import { hookSpecDoc, type HookImplementations, type HookName, type Hooks } from "./types";

export const implementations: HookImplementations = {
  "recipe-library": null,
  "cook-log": null,
  pantry: null,
  "shopping-list": null,
  ideas: null,
  "household-context": null,
};

/**
 * The implementation of a connected hook. Callers check `connected[name]`
 * first and take their unconnected branch; this is for the other branch.
 *
 * @throws Error if the hook's switch is on but its slot is null (naming the
 *   spec to implement), or if it is called for a hook whose switch is off
 */
export function hook<K extends HookName>(name: K): Hooks[K] {
  if (!connected[name]) {
    throw new Error(
      `The "${name}" hook is not connected (lib/hooks/connected.ts), so there is nothing to call. ` +
        `Check connected["${name}"] before using it.`,
    );
  }
  const implementation = implementations[name];
  if (implementation === null) {
    throw new Error(
      `The "${name}" hook is switched on in lib/hooks/connected.ts but has no implementation in ` +
        `lib/hooks/registry.ts. Its spec is ${hookSpecDoc(name)}.`,
    );
  }
  return implementation as Hooks[K];
}
