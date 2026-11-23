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

afterEach(() => {
  for (const name of HOOK_NAMES) {
    connected[name] = false;
    implementations[name] = null;
  }
});

describe("as shipped", () => {
  it("has a switch and a slot for each of the six hooks, every one off and empty", () => {
    expect(Object.keys(shipped).sort()).toEqual([...HOOK_NAMES].sort());
    expect(Object.values(shipped)).toEqual(HOOK_NAMES.map(() => false));
    expect(Object.keys(implementations).sort()).toEqual([...HOOK_NAMES].sort());
    expect(Object.values(implementations)).toEqual(HOOK_NAMES.map(() => null));
  });

  it("refuses a hook that isn't connected, saying to check the switch first", () => {
    for (const name of HOOK_NAMES) {
      expect(() => hook(name)).toThrow(`The "${name}" hook is not connected`);
    }
  });
});

describe("a hook switched on", () => {
  it.each(HOOK_NAMES)("%s with no implementation throws, naming its spec", (name) => {
    connected[name] = true;
    expect(() => hook(name)).toThrow(
      `The "${name}" hook is switched on in lib/hooks/connected.ts but has no implementation in ` +
        `lib/hooks/registry.ts. Its spec is docs/hooks/${name}.md.`,
    );
    expect(hookSpecDoc(name)).toBe(`docs/hooks/${name}.md`);
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
