// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShelfView } from "@/lib/shelf/view";
import { COOKPACKS_COPY } from "./copy";
import { HOUSEHOLD_COVER_SRC, Shelf, householdLabel } from "./Shelf";

afterEach(cleanup);

const VIEW = {
  household: {
    id: "household-book",
    title: "Household Book",
    state: "ok",
    cookable: 50,
    missing: 2,
    syncedAt: "2026-10-04T18:00:00Z",
    contents: [
      { anchor: "indian", title: "indian", count: 9 },
      { anchor: "quick-easy", title: "quick & easy", count: 5 },
    ],
  },
  creators: [
    {
      id: "fannie-farmer-1896",
      title: "The Boston Cooking-School Cook Book",
      creator: "Fannie Merritt Farmer",
      recipes: 5,
      cloth: "walnut",
      coverRef: null,
    },
  ],
  ideas: 14,
} satisfies ShelfView;

function shelf(view: ShelfView = VIEW) {
  const onOpenSaved = vi.fn();
  render(<Shelf view={view} onOpenSaved={onOpenSaved} />);
  return { onOpenSaved };
}

const household = () => document.querySelector<HTMLElement>("[data-household]")!;
const slip = () => screen.getByRole("button", { name: /^Saved for later/ });

describe("Shelf", () => {
  it("puts the household pack first, then the creator packs", () => {
    shelf();
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/kitchen/cookpacks/household-book",
      "/kitchen/cookpacks/fannie-farmer-1896",
    ]);
  });

  it("draws the household pack as a standing flax cloth volume carrying the Household Book cover art", () => {
    shelf();
    const ours = household();
    expect(ours.tagName).toBe("A");
    expect(ours.getAttribute("aria-label")).toBe("Household Book, 50 recipes");
    const cover = ours.querySelector<HTMLElement>("[data-household-cover]")!;
    expect(cover).toBeTruthy();
    expect(cover.textContent).toBe("Household Book");
    expect(cover.style.backgroundColor).toBe("#D8C9A9");
    const art = cover.querySelector<HTMLImageElement>("[data-household-cover-art]");
    expect(art).toBeTruthy();
    expect(art!.getAttribute("src")).toBe(HOUSEHOLD_COVER_SRC);
    expect(cover.querySelector("[data-cover-title]")).toBeNull();
    expect(within(ours).queryAllByRole("button")).toEqual([]);
  });

  it("labels each pack under the shelf: the household's count (its sync is the pack view's), a book's creator and count", () => {
    shelf();
    expect(document.querySelector("[data-household-label]")!.textContent).toBe("50 recipes");
    expect(screen.getByText("Fannie Merritt Farmer")).toBeTruthy();
    expect(screen.getByText("5 recipes")).toBeTruthy();
  });

  it("sets a creator pack with no cover as a cloth board carrying its title", () => {
    shelf();
    const book = document.querySelector<HTMLElement>("[data-creator-book]")!;
    const cover = book.querySelector<HTMLElement>("[data-cloth-cover='walnut']")!;
    expect(cover.textContent).toBe("The Boston Cooking-School Cook Book");
    expect(cover.getAttribute("aria-hidden")).toBe("true");
    expect(book.getAttribute("aria-label")).toBe(
      "The Boston Cooking-School Cook Book, Fannie Merritt Farmer, 5 recipes",
    );
    expect(cover.className).not.toMatch(/shadow-(?!\[inset)/);
  });

  it("tucks Saved for later into the family book as a slip, its own target, reading its count", () => {
    const { onOpenSaved } = shelf();
    const button = slip();
    // Its own target beside the book's, never inside it (a button in a link
    // is two targets in one).
    expect(household().contains(button)).toBe(false);
    // "Saved for later 14" on the slip; the count said as ideas to a screen reader.
    expect([...button.querySelector("[data-slip]")!.childNodes].map((n) => n.textContent)).toEqual([
      "Saved for later",
      "14",
    ]);
    expect(screen.getByRole("button", { name: "Saved for later, 14 ideas" })).toBe(button);
    expect(button.getAttribute("data-return-focus")).toBe("saved-for-later");
    expect(button.className).toContain("h-[var(--target)]");
    fireEvent.click(button);
    expect(onOpenSaved).toHaveBeenCalledTimes(1);
  });

  it("keeps the slip with no count when there are no ideas or none are cached", () => {
    shelf({ ...VIEW, ideas: 0 });
    expect(slip().textContent).toBe(COOKPACKS_COPY.saved);
    cleanup();
    shelf({ ...VIEW, ideas: null });
    expect(slip().textContent).toBe(COOKPACKS_COPY.saved);
  });

  it("keeps the household first while nothing has been synced, pointing at Refresh, cover art intact", () => {
    shelf({
      ...VIEW,
      household: { ...VIEW.household, state: "empty", cookable: 0, missing: 0, syncedAt: null, contents: [] },
    });
    expect(household().tagName).toBe("A");
    expect(document.querySelector("[data-household-label]")!.textContent).toBe(COOKPACKS_COPY.emptyLabel);
    expect(household().querySelector("[data-household-cover]")!.textContent).toBe("Household Book");
    expect(household().querySelector("[data-household-cover-art]")).toBeTruthy();
  });

  it("says when the family book has recipes but none came through, rather than nothing synced", () => {
    shelf({
      ...VIEW,
      household: { ...VIEW.household, state: "empty", cookable: 0, missing: 3, contents: [] },
    });
    expect(document.querySelector("[data-household-label]")!.textContent).toBe(
      "None of its 3 recipes came through · open the book to see why",
    );
  });

  it("says a family book it can't read, and opens nothing, while the creator packs still show", () => {
    shelf({ ...VIEW, household: { ...VIEW.household, state: "unreadable", contents: [] } });
    expect(household().tagName).toBe("DIV");
    expect(household().querySelector("[data-household-cover]")!.textContent).toBe(
      `Household Book${COOKPACKS_COPY.unreadable}`,
    );
    expect(household().querySelector("[data-household-cover-art]")).toBeNull();
    expect(household().querySelector("[data-cover-title]")).toBeTruthy();
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "/kitchen/cookpacks/fannie-farmer-1896",
    ]);
    // The ideas come from their own cache, so the slip still opens them.
    expect(slip()).toBeTruthy();
  });
});

describe("householdLabel", () => {
  it("counts only the recipes that cook", () => {
    expect(householdLabel({ ...VIEW.household, cookable: 1 })).toBe("1 recipe");
  });
});

describe("one row on the idle home (F14)", () => {
  it("shows as many creator books as the width holds beside the household book, never wrapping", () => {
    const creators = Array.from({ length: 5 }, (_, i) => ({
      ...VIEW.creators[0]!,
      id: `pack-${i}`,
      title: `Pack ${i}`,
      creator: `Creator ${i}`,
    }));
    // A host 700 wide, books 198 wide, a 35 gap: floor((700 + 35) / 233) = 3 books, the household's and two more.
    const host = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(700);
    const book = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(198);
    const gap = vi.spyOn(window, "getComputedStyle").mockReturnValue({ columnGap: "35px" } as CSSStyleDeclaration);
    try {
      render(<Shelf view={{ ...VIEW, creators }} onOpenSaved={vi.fn()} oneRow />);
      expect(document.querySelectorAll("[data-creator-book]")).toHaveLength(2);
      expect(document.querySelector("[data-household]")).toBeTruthy();
    } finally {
      host.mockRestore();
      book.mockRestore();
      gap.mockRestore();
    }
  });

  it("shows every book when it isn't asked to be one row", () => {
    const creators = Array.from({ length: 5 }, (_, i) => ({ ...VIEW.creators[0]!, id: `pack-${i}` }));
    render(<Shelf view={{ ...VIEW, creators }} onOpenSaved={vi.fn()} />);
    expect(document.querySelectorAll("[data-creator-book]")).toHaveLength(5);
  });
});

describe("with no household book (no recipe library connected)", () => {
  it("stands the creator packs alone: no household book, no slip tucked in it", () => {
    shelf({ ...VIEW, household: null, ideas: 0 });
    expect(document.querySelector("[data-household]")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Saved for later/ })).toBeNull();
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "/kitchen/cookpacks/fannie-farmer-1896",
    ]);
  });
});

describe("owned and shared packs on the shelf", () => {
  it("shows From <kitchen name> on shared packs and omits it on owned packs", () => {
    shelf({
      household: null,
      ideas: 0,
      creators: [
        {
          id: "owned-suppers",
          title: "Weeknight Suppers",
          creator: "Kitchen Owner",
          recipes: 3,
          cloth: "walnut",
          coverRef: null,
          isOwned: true,
        },
        {
          id: "shared-braises",
          title: "Sunday Braises",
          creator: "Chef Friend",
          recipes: 4,
          cloth: "walnut",
          coverRef: null,
          isOwned: false,
          fromKitchenName: "North Kitchen",
        },
      ],
    });
    expect(screen.getByText("From North Kitchen")).toBeTruthy();
    expect(document.querySelectorAll("[data-from-kitchen]")).toHaveLength(1);
    const sharedLink = document.querySelector<HTMLElement>("[data-creator-book='shared-braises']")!;
    expect(sharedLink.getAttribute("aria-label")).toBe(
      "Sunday Braises, Chef Friend, From North Kitchen, 4 recipes",
    );
    const ownedLink = document.querySelector<HTMLElement>("[data-creator-book='owned-suppers']")!;
    expect(ownedLink.getAttribute("aria-label")).toBe(
      "Weeknight Suppers, Kitchen Owner, 3 recipes",
    );
  });

  it("shows Add a collection at the end of the shelf when provided and never on oneRow Home", () => {
    render(
      <Shelf
        view={VIEW}
        onOpenSaved={vi.fn()}
        addCollectionHref="/kitchen/cookpacks/new"
      />,
    );
    const addLink = document.querySelector<HTMLAnchorElement>("[data-add-collection]");
    expect(addLink).toBeTruthy();
    expect(addLink?.getAttribute("href")).toBe("/kitchen/cookpacks/new");
    expect(addLink?.textContent).toContain("Add a collection");
    expect(document.querySelectorAll("[data-creator-book]")).toHaveLength(1);

    cleanup();
    render(
      <Shelf
        view={VIEW}
        onOpenSaved={vi.fn()}
        oneRow
        addCollectionHref="/kitchen/cookpacks/new"
      />,
    );
    expect(document.querySelector("[data-add-collection]")).toBeNull();
  });
});
