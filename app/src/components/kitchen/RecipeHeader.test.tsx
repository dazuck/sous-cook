// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { UNTITLED } from "@/lib/kitchen/dish-name";
import { MORE_COPY } from "./HeaderMore";
import { placeRung, RecipeHeader, type HeaderMenu } from "./RecipeHeader";

vi.mock("@/lib/trpc", () => ({
  trpc: { getRecentCookingItems: { useQuery: () => ({ data: [] }) } },
}));

// The ladder re-measures when the fonts land; happy-dom has no FontFaceSet.
Object.defineProperty(document, "fonts", { value: new EventTarget(), configurable: true });

afterEach(cleanup);

const stretch = {
  long: COOK_COPY.stretchPlace(4, 50),
  short: COOK_COPY.stretchPlaceShort(4, 50),
  count: COOK_COPY.stretchCount(4, 50),
};

type Props = Omit<ComponentProps<typeof RecipeHeader>, "menu" | "onMenu">;

/** The header with More's open state held above it, as the cook view holds it. */
function Header(props: Partial<Props>) {
  const [menu, setMenu] = useState<HeaderMenu>(null);
  return (
    <RecipeHeader
      name="Mole poblano with a long name"
      place={stretch}
      onPlace={() => {}}
      onShowInfo={() => {}}
      {...props}
      menu={menu}
      onMenu={setMenu}
    />
  );
}

const more = () => screen.getByRole("button", { name: MORE_COPY.more });
const place = () => document.querySelector<HTMLButtonElement>("button[data-place]");

describe("RecipeHeader: the top line (V3, N2-6)", () => {
  it("draws the top-left Back to the kitchen link, the name, the place and More on one line; the name truncates, the place never does", () => {
    render(<Header />);
    const header = screen.getByRole("banner");
    const back = screen.getByRole("link", { name: "Back to the kitchen" });
    expect(back.getAttribute("href")).toBe("/kitchen");
    expect(back.hasAttribute("data-header-back")).toBe(true);
    const name = screen.getByRole("heading", { level: 1, name: "Mole poblano with a long name" });
    expect(name.className).toContain("truncate");
    expect(name.className).toContain("min-w-0");
    expect(place()!.className).toContain("shrink-0");
    expect(place()!.className).not.toContain("truncate");
    expect(header.querySelector("[data-more-cell]")!.className).toContain("shrink-0");
    expect(place()!.textContent).toBe("4 steps, then about 50 min free");
  });

  it("opens the whole cook's chart from the place; there is no chapters menu", () => {
    const onPlace = vi.fn();
    render(<Header onPlace={onPlace} />);
    fireEvent.click(place()!);
    expect(onPlace).toHaveBeenCalledTimes(1);
    expect(place()!.hasAttribute("aria-expanded")).toBe(false);
    expect(screen.queryByRole("navigation", { name: "Chapters" })).toBeNull();
    expect(document.querySelectorAll("[data-holds-keys]")).toHaveLength(0);
  });

  it("has no place as written or on the opening", () => {
    render(<Header place={null} />);
    expect(place()).toBeNull();
    expect(screen.getByRole("banner").textContent).not.toContain("·");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Mole poblano with a long name");
  });

  it("says Prep on Prep", () => {
    const prep = { long: COOK_COPY.prepChapter, short: COOK_COPY.prepChapter, count: COOK_COPY.prepChapter };
    render(<Header place={prep} />);
    expect(place()!.textContent).toBe(COOK_COPY.prepChapter);
  });

  it("names a recipe with an empty or blank name Untitled recipe, so the dot has a name before it", () => {
    for (const blank of ["", "   "]) {
      render(<Header name={blank} />);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(UNTITLED);
      expect(screen.getByRole("banner").textContent).toMatch(/^Untitled recipe·4 steps, /);
      cleanup();
    }
  });

  it("opens Recipe info from More", () => {
    const onShowInfo = vi.fn();
    render(<Header onShowInfo={onShowInfo} />);
    fireEvent.click(more());
    fireEvent.click(screen.getByRole("button", { name: MORE_COPY.info }));
    expect(onShowInfo).toHaveBeenCalledTimes(1);
  });

  it("renders scaleNote ('for 6') after the dish name when scaled (B5c-3)", () => {
    const { rerender } = render(<Header scaleNote={null} />);
    expect(document.querySelector("[data-scale-note]")).toBeNull();

    rerender(<Header scaleNote="for 6" />);
    const note = document.querySelector("[data-scale-note]");
    expect(note).not.toBeNull();
    expect(note!.textContent).toBe("for 6");
    expect(screen.getByRole("heading", { level: 1 }).nextElementSibling).toBe(note);
    expect(note!.className).toContain("shrink-0");
  });
});

describe("placeRung: the place steps down before the dish's name is cut (N2-6)", () => {
  const w = { long: 300, short: 260, count: 90 };
  const sep = 20;
  it("keeps the long form while it fits beside the whole name", () => {
    expect(placeRung(600, 280, sep, w)).toBe("long");
    expect(placeRung(900, 280, sep, w)).toBe("long");
  });
  it("drops 'about' next, then says the count alone", () => {
    expect(placeRung(570, 280, sep, w)).toBe("short");
    expect(placeRung(559, 280, sep, w)).toBe("count");
    expect(placeRung(390, 280, sep, w)).toBe("count");
  });
  it("says the count when even that doesn't fit: the name truncates then", () => {
    expect(placeRung(200, 280, sep, w)).toBe("count");
  });
  it("takes a fit to the half pixel, as layout rounds", () => {
    expect(placeRung(599.6, 280, sep, w)).toBe("long");
    expect(placeRung(599.4, 280, sep, w)).toBe("short");
  });
  it("accounts for scaleNoteW before stepping down the place rung (B5c-3)", () => {
    expect(placeRung(600, 280, sep, w, 0)).toBe("long");
    expect(placeRung(600, 280, sep, w, 35)).toBe("short");
    expect(placeRung(600, 280, sep, w, 70)).toBe("count");
  });
});

