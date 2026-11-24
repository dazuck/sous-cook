// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrepRow } from "@/lib/kitchen/cook-view";
import type { IngredientLine } from "@/lib/kitchen/ingredient-display";
import { PrepRows } from "./PrepRows";

// Review round 1 of prep pages (2026-11-23): what a tap on a tick row does beside an open
// conversions panel and under the lifted look-ahead, and where the dot between a row's amounts is
// drawn.

const ROWS: PrepRow[] = [
  { id: "sauce", text: "Mix the sauce", ingredientIdx: [0, 1], minutes: "3 min", implied: false, done: false },
  { id: "scallions", text: "Cut the scallions", ingredientIdx: [2], minutes: "1 min", implied: false, done: false },
];
const INGREDIENTS: IngredientLine[] = [
  {
    kind: "amount",
    amount: "5 tbsp",
    name: "dark soy sauce",
    stated: [{ unit: "tbsp", value: "5" }],
    conversions: [{ unit: "ml", value: "75" }],
  },
  {
    kind: "amount",
    amount: "2 tbsp",
    name: "mirin",
    stated: [{ unit: "tbsp", value: "2" }],
    conversions: [{ unit: "ml", value: "30" }],
  },
  { kind: "count", amount: "2", name: "stalks scallions" },
];

afterEach(cleanup);

const row = (id: string) => document.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
const panel = () => document.querySelector("[data-measure-panel]");
/** A tap as the browser sends it: the press goes down (pointer, then mouse), then the click. */
function tap(el: Element) {
  fireEvent.pointerDown(el);
  fireEvent.mouseDown(el);
  fireEvent.pointerUp(el);
  fireEvent.mouseUp(el);
  fireEvent.click(el);
}

describe("PrepRows", () => {
  it("a tap on a row ticks it", () => {
    const onTick = vi.fn();
    render(<PrepRows rows={ROWS} ingredients={INGREDIENTS} onTick={onTick} />);
    tap(row("scallions"));
    expect(onTick.mock.calls).toEqual([["scallions"]]);
  });

  it("with an amount's panel open, a tap on another row only puts the panel away; the next tap ticks", () => {
    const onTick = vi.fn();
    render(<PrepRows rows={ROWS} ingredients={INGREDIENTS} onTick={onTick} />);
    tap(screen.getByRole("button", { name: /dark soy sauce/ }));
    expect(panel()).not.toBeNull();
    tap(row("scallions"));
    expect(panel()).toBeNull();
    expect(onTick).not.toHaveBeenCalled();
    tap(row("scallions"));
    expect(onTick.mock.calls).toEqual([["scallions"]]);
  });

  it("with an amount's panel open, a tap on a tile only puts the panel away too", () => {
    const onTick = vi.fn();
    render(<PrepRows rows={ROWS} ingredients={INGREDIENTS} onTick={onTick} />);
    tap(screen.getByRole("button", { name: /mirin/ }));
    expect(panel()).not.toBeNull();
    const tile = screen.getByRole("checkbox", { name: "Cut the scallions" });
    tap(tile);
    expect(panel()).toBeNull();
    expect(onTick).not.toHaveBeenCalled();
    // From the keys the tile ticks whatever the last press was.
    tap(screen.getByRole("button", { name: /mirin/ }));
    fireEvent.pointerDown(row("sauce"));
    fireEvent.keyDown(tile, { key: " " });
    fireEvent.click(tile);
    expect(onTick.mock.calls).toEqual([["scallions"]]);
  });

  it("under the lifted look-ahead its rows and amounts take no taps, and a tap is the stage's again", () => {
    const onTick = vi.fn();
    const { rerender } = render(<PrepRows rows={ROWS} ingredients={INGREDIENTS} onTick={onTick} lifted />);
    tap(row("scallions"));
    tap(screen.getByRole("checkbox", { name: "Cut the scallions" }));
    expect(onTick).not.toHaveBeenCalled();
    // The amounts, faded out there, are out of reach of a finger and of the keys.
    for (const amounts of document.querySelectorAll("[data-row-pairs]")) {
      expect(amounts.hasAttribute("inert")).toBe(true);
    }
    // The stage reads a tap on the rows as its own (back to Now), not fenced off as the rows' job.
    const list = document.querySelector("[data-prep-rows]")!;
    expect(list.hasAttribute("data-no-tap")).toBe(false);
    // A tile is no tick there either (review round 2): inert, it takes no focus and no press, and
    // a tap on it lands on its row, which is the stage's.
    const tiles = [...document.querySelectorAll('[role="checkbox"]')];
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) expect(tile.hasAttribute("inert")).toBe(true);

    rerender(<PrepRows rows={ROWS} ingredients={INGREDIENTS} onTick={onTick} />);
    expect(list.hasAttribute("data-no-tap")).toBe(true);
    for (const tile of tiles) expect(tile.hasAttribute("inert")).toBe(false);
    expect(document.querySelector("[data-row-pairs]")!.hasAttribute("inert")).toBe(false);
    tap(row("scallions"));
    expect(onTick.mock.calls).toEqual([["scallions"]]);
  });

  it("each amount but a row's last carries its own dot after its words, kept out of the amount's name", () => {
    render(<PrepRows rows={ROWS} ingredients={INGREDIENTS} onTick={vi.fn()} />);
    const amounts = row("sauce").querySelector("[data-row-pairs]")!;
    // No dot of the list's own between its items (it stood alone on a line when a pair wrapped).
    expect(amounts.className).not.toContain(":has(~li");
    const pairs = [...amounts.querySelectorAll(":scope > li")].map((li) => li.querySelector("button")!);
    expect(pairs).toHaveLength(2);
    // The dot is the pair's last word, so it wraps with it; hidden from a screen reader, it is no
    // part of the button's name (review round 2: drawn as the button's `::after`, it was).
    const dot = pairs[0]!.lastElementChild!;
    expect(dot.hasAttribute("data-pair-dot")).toBe(true);
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.textContent).toBe("·");
    expect(pairs[1]!.querySelector("[data-pair-dot]")).toBeNull();
    for (const pair of pairs) expect(pair.className).not.toContain("after:content-");
    expect(screen.getByRole("button", { name: "5 tbsp dark soy sauce" })).toBe(pairs[0]);
    expect(screen.getByRole("button", { name: "2 tbsp mirin" })).toBe(pairs[1]);
    // A row with one amount has none.
    expect(row("scallions").querySelector("[data-pair-dot]")).toBeNull();
  });

  it("a tile's hit area is held to its row: 12 px past the tile where the row has the room, never past the row", () => {
    render(<PrepRows rows={ROWS} ingredients={INGREDIENTS} onTick={vi.fn()} />);
    const tile = screen.getByRole("checkbox", { name: "Cut the scallions" });
    expect(tile.style.getPropertyValue("--tick-hit-y")).toBe(
      "clamp(-12px, calc((48 * var(--cpx) - min(1.25em, var(--target))) / 2 + 2px), 0px)",
    );
    expect(tile.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["before:inset-x-[-12px]", "before:inset-y-[var(--tick-hit-y,-12px)]"]),
    );
  });
});
