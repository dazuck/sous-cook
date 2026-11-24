/**
 * The kitchen rail's glyphs (the kitchen home), hand-drawn as inline SVG on a 24 grid in one
 * line style: 1.65 stroke, round caps and joins, no fill. No icon library is used anywhere in the app. The rail
 * and the pull-out panel draw the same glyph for the same destination, so each is defined once here, and each
 * is an object that says what the control opens.
 */

/** A path's `d`, or a rounded rect `[x, y, w, h, rx]`. */
type Shape = string | { r: [number, number, number, number, number] };

export type GlyphName = "cookpacks" | "queue" | "ingredients" | "import" | "pull" | "pullOpen" | "shopping" | "ask" | "signOut";

const GLYPHS: Record<GlyphName, Shape[]> = {
  // Cookpacks: three books on a shelf, the last leaning
  cookpacks: [
    "M3 20h14.5",
    { r: [4, 7, 4, 13, 0.8] },
    { r: [9.4, 4, 4, 16, 0.8] },
    "M15.2 19.3 19.2 20.2 21.9 7.6 17.9 6.7Z",
  ],
  // Up next: a list with a play mark at its foot, the queue and what comes next
  queue: ["M4 6.5h16", "M4 11.5h9", "M4 16.5h5", "M14.6 13.4v6.4l5.2-3.2Z"],
  // Add ingredients: a shopping basket with a plus
  ingredients: ["M8.2 10 10.6 4.8M15.8 10 13.4 4.8", "M3.5 10h17l-1.6 8.1a2 2 0 0 1-2 1.6H7.1a2 2 0 0 1-2-1.6Z", "M12 12.6v4.2M9.9 14.7h4.2"],
  // Import recipe: a page with an arrow coming down into it
  import: ["M6.5 3.5h7l4.5 4.5v12.5H6.5Z", "M13.5 3.5V8H18", "M12.2 10.8v6m0 0-2.4-2.4m2.4 2.4 2.4-2.4"],
  // More: four tiles, every place the kitchen goes; while the panel is open, the chevron that closes it
  pull: [{ r: [4.5, 4.5, 6, 6, 1.6] }, { r: [13.5, 4.5, 6, 6, 1.6] }, { r: [4.5, 13.5, 6, 6, 1.6] }, { r: [13.5, 13.5, 6, 6, 1.6] }],
  pullOpen: ["M9 6l6 6-6 6"],
  // Shopping list (panel only): a list with ticks
  shopping: ["M4.5 7.4l1.5 1.5 2.7-3", "M11 7.5h8.5", "M4.5 12.4l1.5 1.5 2.7-3", "M11 12.5h8.5", "M4.5 17.4l1.5 1.5 2.7-3", "M11 17.5h8.5"],
  // Ask Sous (panel only): a speech bubble
  ask: ["M12 4.5c4.7 0 8.5 3.1 8.5 7 0 2.1-1.1 4-2.9 5.3l.7 3.2-3.6-1.6c-.9.2-1.8.3-2.7.3-4.7 0-8.5-3.1-8.5-7.2S7.3 4.5 12 4.5Z"],
  // Sign out (panel only, in sign-in mode): a door with an arrow leaving it
  signOut: ["M10 4.5H7a2.5 2.5 0 0 0-2.5 2.5v10A2.5 2.5 0 0 0 7 19.5h3", "M14.5 8.5 18 12l-3.5 3.5M18 12H9.5"],
};

/** One glyph: a line drawing in the current colour, `size` counter-pixels square. */
export function Glyph({ name, size }: { name: GlyphName; size: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      style={{ width: `calc(${size} * var(--cpx))`, height: `calc(${size} * var(--cpx))` }}
    >
      {GLYPHS[name].map((s, i) =>
        typeof s === "string" ? <path key={i} d={s} /> : <rect key={i} x={s.r[0]} y={s.r[1]} width={s.r[2]} height={s.r[3]} rx={s.r[4]} />,
      )}
    </svg>
  );
}
