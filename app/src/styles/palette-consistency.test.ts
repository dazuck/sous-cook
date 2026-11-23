import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLOTH_EDGE } from "@/components/cookpacks/cloth";

/**
 * Places outside tokens.css that restate the palette (Direction 2, DS v1.24):
 * they follow the tokens rather than a colour of their own.
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the palette outside tokens.css", () => {
  const ground = read("./tokens.css").match(/--ground-day:\s*(#[0-9a-f]{6})/i)![1].toLowerCase();

  it("the web manifest's theme and background are the ground, not the old Paper", () => {
    const manifest = JSON.parse(read("../../public/manifest.json")) as Record<string, string>;
    expect(manifest.theme_color.toLowerCase()).toBe(ground);
    expect(manifest.background_color.toLowerCase()).toBe(ground);
  });

  it("the viewport's themeColor is the ground", () => {
    expect(read("../app/layout.tsx").match(/themeColor:\s*"(#[0-9a-f]{6})"/i)![1].toLowerCase()).toBe(ground);
  });

  it("the cloth's edge and the binding's edge are the ink token at 22%, not the old ink's rgb", () => {
    const binding = read("../components/cookpacks/PackView.tsx");
    expect(CLOTH_EDGE).toContain("var(--ink)");
    expect(binding).toContain("color-mix(in_oklab,var(--ink)_22%,transparent)");
    for (const source of [CLOTH_EDGE, binding]) expect(source).not.toMatch(/rgb\(43[_ ]39[_ ]36/);
  });
});
