import type { CSSProperties } from "react";
import type { Cloth } from "@/lib/shelf/view";

/**
 * The cloth palette (design P9): content, outside the tokens, closed. Only
 * walnut is drawn yet: it is the uncovered pack's default (S-D5), format
 * P13's own absent value, so nothing changes colour when a pack can name
 * its cloth. Paper on walnut is 4.8:1.
 */
export const CLOTH_HEX: Record<Cloth, string> = {
  walnut: "#7E6A55",
  flax: "#D8C9A9",
  sage: "#9DAA93",
  clay: "#B07156",
  olive: "#96895F",
  oxblood: "#7A4A42",
};

/**
 * The cloth's surface (P53): a faint weave, two 1 px repeating lines at 7-8%
 * of a dark warm brown, under a soft sidelight. No shadow: DS §1 has no
 * shadow token, so the edge is a 22% inset hairline (`CLOTH_EDGE`).
 */
export function clothSurface(cloth: Cloth, { sidelight = true }: { sidelight?: boolean } = {}): CSSProperties {
  const weave = [
    "repeating-linear-gradient(0deg, rgb(250 247 242 / 0.035) 0 1px, transparent 1px 3px)",
    "repeating-linear-gradient(90deg, rgb(43 39 36 / 0.045) 0 1px, transparent 1px 3px)",
  ];
  return {
    backgroundColor: CLOTH_HEX[cloth],
    backgroundImage: [
      ...(sidelight ? ["linear-gradient(100deg, rgb(255 236 214 / 0.08), transparent 45%, rgb(20 10 0 / 0.08))"] : []),
      ...weave,
    ].join(", "),
  };
}

/** The cloth's edge: an inset hairline of ink at 22%. */
export const CLOTH_EDGE = "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_22%,transparent)]";
