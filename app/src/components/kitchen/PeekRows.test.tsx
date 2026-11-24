// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { peekOf } from "@/lib/kitchen/cook-peek";
import { strip } from "@/lib/kitchen/cook-strip";
import { initialCookState, next } from "@/lib/kitchen/cook-view";
import { layoutPeek } from "@/lib/kitchen/peek-layout";
import { advanceMeasure } from "@/lib/kitchen/__tests__/advance-measure";
import { timetableCorpus } from "@/lib/kitchen/__tests__/timetable-corpus";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { PeekRows } from "./PeekRows";

afterEach(cleanup);

const roast = timetableCorpus().find((c) => c.name === "sunday-roast-dinner")!.plan;

/** The peek at the roast's "Coat potatoes", laid out at the tablet's width, as the sheet lays it. */
function peekAtCoat() {
  let state = initialCookState("first");
  for (let i = 0; i < 40; i++) {
    const input = peekOf(roast, state, strip(roast, state, null));
    if (input.screens[input.at]?.key === "coat-potatoes") {
      const c = 800 / 600;
      return layoutPeek(input, { W: 1280, c, E: 44 * c, narrow: false, maxH: 2000 }, advanceMeasure);
    }
    state = next(roast, state);
  }
  throw new Error("the roast never reaches Coat potatoes");
}

/** What a screen reader reads in an element: its text, outside every `aria-hidden` subtree. */
function readable(el: Element): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n instanceof Element && n.getAttribute("aria-hidden") !== null && n.getAttribute("aria-hidden") !== "false") return;
    if (n.nodeType === Node.TEXT_NODE) out.push(n.textContent ?? "");
    n.childNodes.forEach(walk);
  };
  walk(el);
  return out.join("").replace(/\s+/g, " ").trim();
}

describe("PeekRows: what a screen reader hears (review of slice 1)", () => {
  it("each row reads as its own text, not an aria-label on the item; the list is named", () => {
    render(<PeekRows d={peekAtCoat()} c={800 / 600} label={COOK_COPY.lookAhead} />);
    const list = screen.getByRole("list", { name: COOK_COPY.lookAhead });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map(readable)).toEqual([
      "Coat potatoes · Potatoes · 2 min",
      "Roast chicken and potatoes · Chicken",
      "then 50 min free while it roasts",
      "after that: Check chicken",
    ]);
    for (const r of rows) expect(r.getAttribute("aria-label"), "no label for TalkBack to skip").toBeNull();
    // The drawn words stay hidden from it (placed in pieces, they would read twice and out of order).
    for (const r of rows) for (const piece of r.querySelectorAll("[data-peek-label], [data-peek-dish], [data-peek-minutes]")) {
      expect(piece.closest("[aria-hidden]")).not.toBeNull();
    }
  });
});
