/**
 * The registry as shipped, and what it says when a hook is switched on with
 * nothing behind it. `connected.ts` is read for real in the first block and
 * mocked (a mutable copy) in the rest.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./connected", async (importOriginal) => {
  const { connected } = await importOriginal<typeof import("./connected")>();
  return { connected: { ...connected }, shipped: { ...connected } };
});

import * as connectedModule from "./connected";
import { hook, implementations } from "./registry";
import { HOOK_NAMES, hookSpecDoc, type IdeasStore } from "./types";

const { connected } = connectedModule;
const shipped = (connectedModule as unknown as { shipped: Record<string, boolean> }).shipped;
const PER_KITCHEN_HOOKS = new Set<string>(HOOK_NAMES);

afterEach(() => {
  for (const name of HOOK_NAMES) {
    connected[name] = false;
    implementations[name] = null;
  }
});

describe("as shipped", () => {
  it("connects all six per-kitchen DB hooks", () => {
    expect(Object.keys(shipped).sort()).toEqual([...HOOK_NAMES].sort());
    for (const name of HOOK_NAMES) {
      expect(shipped[name]).toBe(PER_KITCHEN_HOOKS.has(name));
    }
    expect(Object.keys(implementations).sort()).toEqual([...HOOK_NAMES].sort());
    for (const name of HOOK_NAMES) {
      expect(typeof implementations[name]).toBe("function");
    }
  });

  it("refuses a hook that isn't connected, saying to check the switch first", () => {
    for (const name of HOOK_NAMES) {
      connected[name] = false;
      expect(() => hook(name)).toThrow(`The "${name}" hook is not connected`);
    }
  });
});

describe("a hook switched on", () => {
  it.each(HOOK_NAMES)("%s with no implementation throws, naming its spec", (name) => {
    implementations[name] = null;
    connected[name] = true;
    expect(() => hook(name)).toThrow(
      `The "${name}" hook is switched on in lib/hooks/connected.ts but has no implementation in ` +
        `lib/hooks/registry.ts. Its spec is docs/hooks/${name}.md.`,
    );
    expect(hookSpecDoc(name)).toBe(`docs/hooks/${name}.md`);
  });

  it("with a per-kitchen factory in its slot requires kitchenId and passes it to the factory", async () => {
    const factory = vi.fn((kitchenId: string) => ({
      read: async () => `context for ${kitchenId}`,
    }));
    implementations["household-context"] = factory;
    connected["household-context"] = true;

    expect(() => hook("household-context")).toThrow(/requires a kitchenId/);
    const impl = hook("household-context", "kitchen-42");
    expect(factory).toHaveBeenCalledWith("kitchen-42");
    expect(await impl.read()).toBe("context for kitchen-42");
  });

  it("with an implementation in its slot hands that implementation back", async () => {
    const lines: string[] = ["Miso cod"];
    const ideas: IdeasStore = {
      readText: async () => lines.join("\n"),
      append: async (line) => void lines.push(line),
    };
    implementations.ideas = ideas;
    connected.ideas = true;

    expect(hook("ideas")).toBe(ideas);
    await hook("ideas").append("Pan con tomate");
    expect(await hook("ideas").readText()).toBe("Miso cod\nPan con tomate");
  });

  it("an implementation whose switch is off is still not connected", () => {
    implementations.ideas = { readText: async () => "", append: async () => undefined };
    expect(() => hook("ideas")).toThrow('The "ideas" hook is not connected');
  });
});
