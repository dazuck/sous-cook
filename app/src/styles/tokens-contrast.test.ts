import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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

/** A stylesheet without its comments (tokens.css names the polar spaces to say why it avoids them). */
const cssCode = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * A TS or TSX source without its comments, by parsing it and printing it back,
 * so a `//` in a URL or a `/*` in a glob string is not taken for one.
 */
function tsCode(source: string): string {
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ts.createPrinter({ removeComments: true }).printFile(file);
}

/**
 * Where code mixes, blends or converts a colour in a polar space, or null.
 * CSS is case-insensitive and takes any whitespace between its words, and a
 * Tailwind arbitrary value writes each space as an underscore, so every
 * pattern ignores case and reads a run of whitespace or underscores as one gap.
 */
const POLAR_SPACE = "(oklch|lch|hsl|hwb)(?![a-z0-9-])";
const POLAR_USES: Array<[what: string, pattern: RegExp]> = [
  ["color-mix in a polar space", new RegExp(`color-mix\\([\\s_]*in[\\s_]+${POLAR_SPACE}`, "i")],
  // The blend is named in the gradient's first argument, after a direction or an
  // angle that may itself hold brackets (calc(), var()), two deep at most.
  [
    "gradient blended in a polar space",
    new RegExp(`gradient\\((?:[^,()]|\\((?:[^()]|\\([^()]*\\))*\\))*?(?<![a-z0-9-])in[\\s_]+${POLAR_SPACE}`, "i"),
  ],
  // Tailwind's gradient modifier: bg-linear-… then a slash and a space. Not spelled
  // out, since Tailwind would build the class from this comment.
  [
    "Tailwind gradient in a polar space",
    /\bbg-(linear|radial|conic)[^\s"'`]*\/(oklch|lch|hsl|hwb|shorter|longer|increasing|decreasing)\b/i,
  ],
  ["relative colour in a polar space", /(?<![a-z0-9-])(oklch|lch|hsl|hwb)\([\s_]*from(?![a-z0-9-])/i],
];
const polarUse = (code: string): string | null => POLAR_USES.find(([, pattern]) => pattern.test(code))?.[0] ?? null;

describe("no mix goes through a hue (Chromium drops a near-neutral colour's hue in oklch and paints it pink)", () => {
  it("every color-mix in tokens.css is in oklab, with its two stops as plain tokens", () => {
    const code = cssCode(CSS);
    // Every color-mix( in the stylesheet, whatever follows it: its interpolation
    // method as written (a hyphenated space, a hue modifier, none at all).
    const methods = [...code.matchAll(/color-mix\(\s*(?:in\s+([^,]*?)\s*,)?/gi)].map((m) => m[1]);
    const declared = [...code.matchAll(/(--[a-z-]+)\s*:\s*color-mix\(\s*in\s+[^,]*,([^;]*)\)\s*;/gi)];
    expect(declared.map((m) => m[1]).sort()).toEqual(["--ground", "--ink", "--ink-soft", "--paper", "--sand"]);
    // The five tokens and the @supports test: no other mix, and none in another space.
    expect(methods).toEqual(Array.from({ length: declared.length + 1 }, () => "oklab"));
    for (const [, , stops] of declared) {
      expect([...stops.matchAll(/var\(--[a-z-]+-(day|night)\)/g)]).toHaveLength(2);
      expect(stops, "a stop converted to a polar space can lose its hue").not.toMatch(/(oklch|lch|hsl|hwb)\(/i);
    }
  });

  it("no source file under src mixes, blends a gradient or converts a colour in a polar space", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const found = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(tsx?|css)$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => {
        const source = readFileSync(`${root}/${file}`, "utf8");
        // Only a file that names a polar use anywhere is worth stripping of its comments.
        if (polarUse(source) === null) return false;
        return polarUse(file.endsWith(".css") ? cssCode(source) : tsCode(source)) !== null;
      });
    expect(found.sort()).toEqual([]);
  });

  /**
   * A Tailwind arbitrary value as a class name, put together here rather than
   * written out: Tailwind scans this file too, and would build any class it
   * finds in it into the app's stylesheet.
   */
  const arbitrary = (utility: string, css: string) => [utility, `[${css.replace(/ /g, "_")}]`].join("-");

  describe("the guard reads CSS as a browser does", () => {
    const caught: Array<[string, string]> = [
      ["as the app wrote it", "color-mix(in oklch, var(--sand), var(--ink) 8%)"],
      ["as Tailwind writes it", `active:${arbitrary("bg", "color-mix(in oklch,var(--sand),var(--ink) 8%)")}`],
      ["upper case", "color-mix(IN OKLCH, red, blue)"],
      ["mixed case", "Color-Mix(in Oklch, red, blue)"],
      ["two spaces", "color-mix(in  oklch, red, blue)"],
      ["a tab", "color-mix(in\toklch, red, blue)"],
      ["across lines, as tokens.css had it", "color-mix(\n    in\n    oklch,\n    red,\n    blue\n  )"],
      ["two underscores", arbitrary("bg", "color-mix(in  hsl,red,blue)")],
      ["a hue modifier in Tailwind", arbitrary("bg", "color-mix(in hsl shorter hue,red,blue)")],
      ["a gradient", "linear-gradient(to right in oklch, red, blue)"],
      ["a gradient after calc()", "linear-gradient(calc(90deg + 1deg) in oklch, red, blue)"],
      ["a gradient after calc(var())", "conic-gradient(from calc(var(--turn) * 2) at 50% 50% in hsl, red, blue)"],
      ["a gradient in Tailwind", arbitrary("bg", "linear-gradient(to right in oklch,red,blue)")],
      ["an upper-case gradient", "LINEAR-GRADIENT(in  HWB, red, blue)"],
      ["a relative colour", "oklch(from var(--ink) l c h)"],
      ["an upper-case relative colour", "OKLCH(FROM red l c h)"],
      ["a relative colour after spaces", "hsl(  from red h s l)"],
      ["a relative colour in Tailwind", arbitrary("text", "oklch(from var(--ink) l c h)")],
      ["Tailwind's gradient modifier, upper case", ["bg", "linear", "to", "r/OKLCH"].join("-")],
    ];
    for (const [what, code] of caught) {
      it(`catches ${what}`, () => {
        expect(polarUse(code), code).not.toBeNull();
      });
    }

    const allowed: Array<[string, string]> = [
      ["an Oklab mix", "color-mix(in oklab, red, blue)"],
      ["an Oklab mix in Tailwind", `active:${arbitrary("bg", "color-mix(in oklab,var(--sand),var(--ink) 8%)")}`],
      ["a linear-light mix", "color-mix(in srgb-linear, red, blue)"],
      ["a plain gradient", "linear-gradient(to right, red, blue)"],
      ["an Oklab gradient after calc()", "linear-gradient(calc(90deg) in oklab, red, blue)"],
      ["an Oklab mix inside a gradient", "linear-gradient(red, color-mix(in oklab, red, blue))"],
      ["an Oklab relative colour", "oklab(from red l a b)"],
      ["a polar colour written out", "oklch(0.5 0.1 30) hsl(20 30% 40%)"],
      ["words that only look like it", "const within = hsl; margin(from); begin oklch-from"],
    ];
    for (const [what, code] of allowed) {
      it(`allows ${what}`, () => {
        expect(polarUse(code), code).toBeNull();
      });
    }
  });

  describe("the guard reads a source without its comments", () => {
    const mix = "color-mix(in oklch, red, blue)";

    it("a comment naming the old syntax does not trip it", () => {
      expect(polarUse(tsCode(`// was ${mix}\nconst x = 1;`))).toBeNull();
      expect(polarUse(tsCode(`/** ${mix} */\nconst x = 1; /* ${mix} */`))).toBeNull();
      expect(polarUse(tsCode(`const a = <div>{/* ${arbitrary("bg", mix)} */}</div>;`))).toBeNull();
      expect(polarUse(cssCode(`/* ${mix} */ :root { --a: red; }`))).toBeNull();
    });

    it("code beside a comment, a URL or a glob is still read", () => {
      expect(polarUse(tsCode(`const u = "https://sous.test"; const c = "${mix}"; // a note`))).not.toBeNull();
      expect(polarUse(tsCode('const g = "src/**/*.ts"; const c = `color-mix(in oklch, red ${1}%, blue)`; /* x */'))).not.toBeNull();
      expect(polarUse(tsCode(`const r = /"\\/\\//; const c = '${mix}';`))).not.toBeNull();
      expect(polarUse(tsCode(`const a = <div className="${arbitrary("bg", mix)}">// text</div>;`))).not.toBeNull();
      expect(polarUse(cssCode(`/* why */ :root { --a: ${mix}; } /* end */`))).not.toBeNull();
    });
  });

  it("no declaration in tokens.css mixes or converts in a polar space", () => {
    const code = cssCode(CSS);
    expect(polarUse(code)).toBeNull();
    // Stricter here than under src: no "in <polar space>" anywhere, the @supports test included.
    expect(code).not.toMatch(/(?<![a-z0-9-])in\s+(oklch|lch|hsl|hwb)(?![a-z0-9-])/i);
  });
});
