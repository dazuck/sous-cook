import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contrast tests for tokens.css (Direction 2 Natural Stoneware & Evening light P67).
 * Verifies WCAG contrast across daytime base tokens, midway sunset interpolation,
 * and night stop stops.
 */
const CSS = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

function hex(name: string): string {
  const match = CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\s*;`, "i"));
  if (!match) throw new Error(`tokens.css has no hex value for --${name}`);
  return match[1];
}

type Rgb = [number, number, number];

function parse(value: string): Rgb {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) as Rgb;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

function rgbToOklab(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, A, B];
}

function oklabToRgb([L, A, B]: [number, number, number]): Rgb {
  const l2 = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m2 = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s2 = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2,
    -1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2,
    -0.0041960863 * l2 - 0.7034186147 * m2 + 1.707614701 * s2,
  ].map((c) => clamp(toGamma(c))) as Rgb;
}

/**
 * color-mix(in oklab, night t, day) as the browser computes it: L, a and b
 * linearly, then back to sRGB (clipped). tokens.css mixes in Oklab, so the
 * contrast of the in-between stops is measured the same way.
 */
function mixOklab(day: Rgb, night: Rgb, t: number): Rgb {
  const a = rgbToOklab(day);
  const b = rgbToOklab(night);
  return oklabToRgb([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const color = (name: string) => parse(hex(name));

describe("tokens.css contrast (Direction 2 Natural Stoneware & P67, DS §1)", () => {
  it("defines the Natural Stoneware base tokens", () => {
    expect(hex("stoneware").toLowerCase()).toBe("#f6f4ee");
    expect(hex("ground-day").toLowerCase()).toBe("#f6f4ee");
    expect(hex("ink-day").toLowerCase()).toBe("#23201d");
    expect(hex("ink-soft-day").toLowerCase()).toBe("#56504a");
    expect(hex("ember-day").toLowerCase()).toBe("#bf5a27");
    expect(hex("ember-700-day").toLowerCase()).toBe("#9c4316");
    expect(hex("paper-day").toLowerCase()).toBe("#fdfcfb");
    expect(hex("sand-day").toLowerCase()).toBe("#eae3d5");
  });

  it("defines the evening night stops", () => {
    expect(hex("ground-night").toLowerCase()).toBe("#eee9df");
    expect(hex("ink-night").toLowerCase()).toBe("#1e1b19");
    expect(hex("ink-soft-night").toLowerCase()).toBe("#5e5750");
  });

  describe("Daytime stop (t = 0)", () => {
    const ground = color("ground-day");
    const ink = color("ink-day");
    const inkSoft = color("ink-soft-day");
    const ember = color("ember-day");
    const ember700 = color("ember-700-day");
    const paper = color("paper-day");
    const sand = color("sand-day");

    it("ink on ground: passes AAA (>= 7.0:1)", () => {
      expect(ratio(ink, ground)).toBeGreaterThanOrEqual(7.0);
      expect(ratio(ink, ground)).toBeCloseTo(14.7, 1);
    });

    it("ink-soft on ground: passes AAA (>= 7.0:1)", () => {
      expect(ratio(inkSoft, ground)).toBeGreaterThanOrEqual(7.0);
      expect(ratio(inkSoft, ground)).toBeCloseTo(7.2, 1);
    });

    it("ember-700 on ground: passes AA (>= 4.5:1)", () => {
      expect(ratio(ember700, ground)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(ember700, ground)).toBeCloseTo(5.9, 1);
    });

    it("paper on ember: passes large-text AA (>= 3.0:1)", () => {
      expect(ratio(paper, ember)).toBeGreaterThanOrEqual(3.0);
      expect(ratio(paper, ember)).toBeCloseTo(4.4, 1);
    });

    it("ink-soft on sand: passes AA (>= 4.5:1)", () => {
      expect(ratio(inkSoft, sand)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(inkSoft, sand)).toBeCloseTo(6.2, 1);
    });
  });

  describe("every stop of the ramp, t = 0 to 1 in steps of 0.05, mixed in Oklab like the CSS", () => {
    const steps = Array.from({ length: 21 }, (_, i) => i * 0.05);
    const ember700 = color("ember-700-day");
    const ember = color("ember-day");

    it("the mix reproduces the day and night stops at the ends", () => {
      const close = (x: Rgb, y: Rgb) => x.every((c, i) => Math.abs(c - y[i]) < 0.002);
      expect(close(mixOklab(color("ground-day"), color("ground-night"), 0), color("ground-day"))).toBe(true);
      expect(close(mixOklab(color("ground-day"), color("ground-night"), 1), color("ground-night"))).toBe(true);
      expect(close(mixOklab(color("paper-day"), color("paper-night"), 1), color("paper-night"))).toBe(true);
      expect(close(mixOklab(color("sand-day"), color("sand-night"), 1), color("sand-night"))).toBe(true);
      expect(close(mixOklab(color("ink-day"), color("ink-night"), 1), color("ink-night"))).toBe(true);
    });

    for (const t of steps) {
      it(`t = ${t.toFixed(2)}: ink AAA, ink-soft AA, ember-700 AA, ink-soft on sand AA, paper on ember large-AA`, () => {
        const ground = mixOklab(color("ground-day"), color("ground-night"), t);
        const paper = mixOklab(color("paper-day"), color("paper-night"), t);
        const sand = mixOklab(color("sand-day"), color("sand-night"), t);
        const ink = mixOklab(color("ink-day"), color("ink-night"), t);
        const inkSoft = mixOklab(color("ink-soft-day"), color("ink-soft-night"), t);
        expect(ratio(ink, ground), "ink on ground").toBeGreaterThanOrEqual(7.0);
        expect(ratio(inkSoft, ground), "ink-soft on ground").toBeGreaterThanOrEqual(4.5);
        expect(ratio(ember700, ground), "ember-700 on ground").toBeGreaterThanOrEqual(4.5);
        expect(ratio(inkSoft, sand), "ink-soft on sand").toBeGreaterThanOrEqual(4.5);
        expect(ratio(paper, ember), "paper on ember").toBeGreaterThanOrEqual(3.0);
      });
    }
  });

  describe("Night stop (t = 1.0)", () => {
    const ground = color("ground-night");
    const ink = color("ink-night");
    const inkSoft = color("ink-soft-night");
    const ember = color("ember-day");
    const ember700 = color("ember-700-day");
    const paper = color("paper-night");
    const sand = color("sand-night");

    it("evening ink on evening ground: passes AAA (>= 7.0:1)", () => {
      expect(ratio(ink, ground)).toBeGreaterThanOrEqual(7.0);
      expect(ratio(ink, ground)).toBeCloseTo(14.2, 1);
    });

    it("evening ink-soft on evening ground: passes AA (>= 4.5:1)", () => {
      expect(ratio(inkSoft, ground)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(inkSoft, ground)).toBeCloseTo(5.9, 1);
    });

    it("ember-700 on evening ground: passes AA (>= 4.5:1)", () => {
      expect(ratio(ember700, ground)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(ember700, ground)).toBeCloseTo(5.4, 1);
    });

    it("paper on ember: passes large-text AA (>= 3.0:1)", () => {
      expect(ratio(paper, ember)).toBeGreaterThanOrEqual(3.0);
    });

    it("evening ink-soft on sand: passes AA (>= 4.5:1)", () => {
      expect(ratio(inkSoft, sand)).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe("the static fallback (no color-mix in oklab)", () => {
    const at = CSS.indexOf("@supports not (color: color-mix(in oklab, red, blue))");

    it("tokens.css carries an @supports not (color-mix in oklab) block", () => {
      expect(at).toBeGreaterThan(-1);
    });

    /** The text between the braces opened at or after `from`, by walking them. */
    function block(from: number): string {
      const open = CSS.indexOf("{", from);
      let depth = 0;
      for (let i = open; i < CSS.length; i++) {
        if (CSS[i] === "{") depth++;
        if (CSS[i] === "}" && --depth === 0) return CSS.slice(open + 1, i);
      }
      throw new Error("unbalanced braces in tokens.css");
    }

    it("is balanced and pins every mixed token to its static day value", () => {
      const rule = block(at).match(/:root\s*\{([^}]*)\}/);
      expect(rule, "the block restyles :root").not.toBeNull();
      const decls = Object.fromEntries(
        [...rule![1].matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
      );
      const mixed = [...CSS.matchAll(/^\s*(--[a-z-]+):\s*color-mix\(\s*in oklab/gm)].map((m) => m[1]);
      expect(mixed.sort()).toEqual(["--ground", "--ink", "--ink-soft", "--paper", "--sand"]);
      for (const token of mixed) expect(decls[token]).toBe(`var(${token}-day)`);
    });

    it("comes after the :root that defines the mix, so it wins the cascade", () => {
      expect(at).toBeGreaterThan(CSS.indexOf("--ground: color-mix("));
    });
  });
});

describe("no mix goes through a hue (Chromium drops a near-neutral colour's hue in oklch and paints it pink)", () => {
  it("every color-mix in tokens.css is in oklab, with its two stops as plain tokens", () => {
    const mixes = [...CSS.matchAll(/--[a-z-]+:\s*color-mix\(\s*in ([a-z]+),([^;]*?)\);/g)];
    expect(mixes.length).toBe(5);
    for (const [, space, stops] of mixes) {
      expect(space).toBe("oklab");
      expect([...stops.matchAll(/var\(--[a-z-]+-(day|night)\)/g)]).toHaveLength(2);
      expect(stops, "a stop converted to a polar space can lose its hue").not.toMatch(/(oklch|lch|hsl|hwb)\(/);
    }
  });

  it("no source file mixes colours in a polar space", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const polar = /color-mix\(\s*in[ _](oklch|lch|hsl|hwb)\b/;
    const found = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(tsx?|css)$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => polar.test(readFileSync(`${root}/${file}`, "utf8")));
    expect(found).toEqual([]);
  });

  it("no declaration in tokens.css mixes or converts in a polar space", () => {
    const code = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/in\s+(oklch|lch|hsl|hwb)\b/);
    expect(code).not.toMatch(/(oklch|lch)\(from\b/);
  });
});
