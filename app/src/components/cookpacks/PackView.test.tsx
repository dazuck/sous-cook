// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PackPageView, PackRowView } from "@/lib/shelf/view";
import { COOKPACKS_COPY } from "./copy";
import { PackView, type RefreshControl } from "./PackView";

afterEach(cleanup);

const row = (title: string, over: Partial<PackRowView> = {}): PackRowView => ({
  id: title.toLowerCase().replace(/\W+/g, "-"),
  title,
  times: null,
  serves: null,
  tags: [],
  missing: null,
  ...over,
});

const HOUSEHOLD: PackPageView = {
  id: "household-book",
  kind: "household",
  title: "Household Book",
  creator: "Household Book",
  state: "ok",
  syncedAt: "2026-10-04T18:00:00Z",
  cookable: 4,
  missing: 2,
  cloth: null,
  chapters: [
    {
      anchor: "indian",
      title: "indian",
      rows: [
        row("Lentil stew (Indian-spiced)", { times: ["Recipe says 2 h 30"], serves: "serves 6" }),
        row("Lamb biryani", { missing: "refused" }),
        row("Dal and rice", { serves: "serves 2", tags: ["New Year's"] }),
      ],
    },
    {
      anchor: "baking",
      title: "baking",
      rows: [row("Carrot cupcakes", { serves: "serves 4 (Sous's estimate)" }), row("Crackers", { missing: "unread" })],
    },
    { anchor: null, title: null, rows: [row("Chicken salad")] },
  ],
};

const FANNIE: PackPageView = {
  id: "fannie-farmer-1896",
  kind: "creator",
  title: "The Boston Cooking-School Cook Book",
  creator: "Fannie Merritt Farmer",
  state: "ok",
  syncedAt: null,
  cookable: 2,
  missing: 0,
  cloth: "walnut",
  chapters: [{ anchor: null, title: null, rows: [row("Doughnuts I"), row("Thin White Sauce")] }],
};

function pack(
  view: PackPageView = HOUSEHOLD,
  over: { refresh?: Partial<RefreshControl> | null; sendingId?: string | null; sendFailure?: string | null; initialAnchor?: string } = {},
) {
  const onPick = vi.fn();
  const onAnchor = vi.fn();
  const onRefresh = vi.fn();
  const refresh =
    over.refresh === null || view.kind !== "household"
      ? undefined
      : { pending: false, status: null, onRefresh, ...over.refresh };
  render(
    <PackView
      view={view}
      refresh={refresh}
      sendingId={over.sendingId ?? null}
      sendFailure={over.sendFailure ?? null}
      onPick={onPick}
      onAnchor={onAnchor}
      initialAnchor={over.initialAnchor}
    />,
  );
  return { onPick, onAnchor, onRefresh };
}

const chapterWord = () => document.querySelector<HTMLButtonElement>("[data-chapter-word]");
const menu = () => document.querySelector<HTMLElement>("[data-chapters-menu]");
const meta = () => document.querySelector<HTMLElement>("[data-pack-meta]")!;
const rows = () => [...document.querySelectorAll("[data-pack-list] li")].map((li) => li.textContent);

describe("the household view", () => {
  it("opens under a running head: the title, the chapter in view and Refresh", () => {
    pack();
    const head = document.querySelector<HTMLElement>("[data-running-head]")!;
    expect(within(head).getByRole("heading", { name: "Household Book" })).toBeTruthy();
    expect(chapterWord()!.textContent).toBe("indian");
    expect(within(head).getByRole("button", { name: COOKPACKS_COPY.refresh })).toBeTruthy();
  });

  it("says the count that cooks, the sync and how many didn't come through", () => {
    pack();
    expect(meta().textContent).toBe("4 recipes · synced Oct 4 · 2 didn't come through");
  });

  it("draws the chapters as the Doc writes them, the headless tail last", () => {
    pack();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Household Book",
      "indian",
      "baking",
    ]);
    expect(rows().at(-1)).toBe("Chicken salad");
  });

  it("gives each row one fact: stated time, count, and the title's tags", () => {
    pack();
    expect(rows()[0]).toBe("Lentil stew (Indian-spiced)Recipe says 2 h 30 · serves 6");
    expect(rows()[2]).toBe("Dal and riceserves 2 · New Year's");
    expect(rows()[3]).toBe("Carrot cupcakesserves 4 (Sous's estimate)");
  });

  it("queues a recipe from its row", () => {
    const { onPick } = pack();
    fireEvent.click(screen.getByRole("button", { name: "Dal and rice" }));
    expect(onPick).toHaveBeenCalledWith("dal-and-rice");
  });

  it("says a tapped row is on its way and steps the others back, taking no second tap", () => {
    const { onPick } = pack(HOUSEHOLD, { sendingId: "dal-and-rice" });
    expect(rows()[2]).toBe(`Dal and rice${COOKPACKS_COPY.sending}`);
    const lamb = screen.getByRole("button", { name: "Lentil stew (Indian-spiced)" }) as HTMLButtonElement;
    expect(lamb.disabled).toBe(true);
    fireEvent.click(lamb);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("names a recipe that didn't come through in its chapter, not as a button", () => {
    pack();
    const biryani = screen.getByText("Lamb biryani");
    expect(biryani.closest("button")).toBeNull();
    const li = biryani.closest("li")!;
    expect(li.textContent).toContain("Sous couldn't read this one");
    expect(li.querySelector("[data-row-go]")).toBeNull();
    expect(biryani.className).toContain("text-ink-soft");
    expect(screen.getByText("Crackers").closest("li")!.textContent).toContain(
      "Didn't come through on the last Refresh",
    );
  });

  it("filters to the recipes that didn't come through, and Show all brings the book back", () => {
    pack();
    fireEvent.click(screen.getByRole("button", { name: "2 didn't come through" }));
    expect(meta().textContent).toBe(COOKPACKS_COPY.missingFilter(2));
    expect(rows()).toEqual([
      "Lamb biryaniindian · Sous couldn't read this one",
      "Crackersbaking · Didn't come through on the last Refresh",
    ]);
    expect(chapterWord()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: COOKPACKS_COPY.showAll }));
    expect(chapterWord()!.textContent).toBe("indian");
    expect(rows()).toHaveLength(6);
  });

  it("flattens the list for a search, each fact leading with its chapter, and drops the chapter word", () => {
    pack();
    fireEvent.change(screen.getByRole("searchbox", { name: COOKPACKS_COPY.search }), { target: { value: "  CHICK" } });
    expect(meta().textContent).toBe(COOKPACKS_COPY.matches(1, "CHICK"));
    expect(rows()).toEqual(["Chicken salad"]);
    expect(chapterWord()).toBeNull();
    expect(screen.queryAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Household Book"]);
  });

  it("finds a recipe that didn't come through, so looking for it finds why", () => {
    pack();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "lamb" } });
    expect(rows()).toEqual(["Lamb biryaniindian · Sous couldn't read this one"]);
  });

  it("says when nothing matches, and the chapter word stays out until the field is cleared", () => {
    pack();
    const field = screen.getByRole("searchbox");
    fireEvent.change(field, { target: { value: "zzz" } });
    expect(meta().textContent).toBe(COOKPACKS_COPY.noMatches("zzz"));
    expect(rows()).toEqual([]);
    expect(chapterWord()).toBeNull();
    fireEvent.change(field, { target: { value: "" } });
    expect(chapterWord()).not.toBeNull();
  });
});

describe("the chapters menu", () => {
  it("is the book's contents: entries a target tall, each with its count, the chapter in view at 600", () => {
    pack();
    fireEvent.click(chapterWord()!);
    expect(chapterWord()!.getAttribute("aria-expanded")).toBe("true");
    const entries = [...menu()!.querySelectorAll<HTMLButtonElement>("[data-chapter-entry]")];
    expect(entries.map((e) => e.textContent)).toEqual(["indian, 2", "baking, 1"]);
    for (const e of entries) expect(e.className).toContain("min-h-[var(--target)]");
    expect(entries[0]!.getAttribute("aria-current")).toBe("location");
    expect(entries[0]!.className).toContain("font-semibold");
    expect(entries[1]!.className).toContain("font-medium");
  });

  it("goes to a chapter on a choice, says it in the URL, and closes", () => {
    const { onAnchor } = pack();
    fireEvent.click(chapterWord()!);
    fireEvent.click(menu()!.querySelector("[data-chapter-entry='baking']")!);
    expect(onAnchor).toHaveBeenCalledWith("baking");
    expect(menu()).toBeNull();
    expect(chapterWord()!.textContent).toBe("baking");
    expect(document.activeElement).toBe(chapterWord());
  });

  it("closes on Escape, which goes no further, and on a tap outside", () => {
    pack();
    fireEvent.click(chapterWord()!);
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
    expect(menu()).toBeNull();
    fireEvent.click(chapterWord()!);
    fireEvent.mouseDown(document.body);
    expect(menu()).toBeNull();
  });

  it("opens at the chapter the URL names, and at the first when the book has no such chapter", () => {
    pack(HOUSEHOLD, { initialAnchor: "baking" });
    expect(chapterWord()!.textContent).toBe("baking");
    cleanup();
    pack(HOUSEHOLD, { initialAnchor: "gone" });
    expect(chapterWord()!.textContent).toBe("indian");
  });

  it("holds the keys while open, so the page's Escape waits for it", () => {
    pack();
    fireEvent.click(chapterWord()!);
    expect(menu()!.hasAttribute("data-holds-keys")).toBe(true);
  });
});

describe("Refresh", () => {
  it("is disabled and says so while it runs", () => {
    pack(HOUSEHOLD, { refresh: { pending: true, status: { text: COOKPACKS_COPY.refreshRunning, trouble: false } } });
    const word = screen.getByRole("button", { name: COOKPACKS_COPY.refreshing }) as HTMLButtonElement;
    expect(word.disabled).toBe(true);
    const status = document.querySelector<HTMLElement>("[data-pack-status]")!;
    expect(status.textContent).toBe(COOKPACKS_COPY.refreshRunning);
    expect(status.className).toContain("text-ink-soft");
  });

  it("says a failure in ink, never ember", () => {
    pack(HOUSEHOLD, { refresh: { status: { text: "Couldn't reach your recipe library", trouble: true } } });
    const status = document.querySelector<HTMLElement>("[data-pack-status]")!;
    expect(status.className).toContain("text-ink");
    expect(status.className).not.toContain("ember");
  });

  it("runs on a tap", () => {
    const { onRefresh } = pack();
    fireEvent.click(screen.getByRole("button", { name: COOKPACKS_COPY.refresh }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("a failed send", () => {
  it("is said in the status line, in ink", () => {
    pack(HOUSEHOLD, { sendFailure: "Couldn't read that recipe, so it wasn't sent." });
    expect(document.querySelector("[data-pack-status]")!.textContent).toBe(
      "Couldn't read that recipe, so it wasn't sent.",
    );
  });
});

describe("the household view's empty and unreadable states", () => {
  it("says nothing has come in yet, with Refresh under the sentence", () => {
    const { onRefresh } = pack({ ...HOUSEHOLD, state: "empty", chapters: [], cookable: 0, missing: 0, syncedAt: null });
    expect(screen.getByText(COOKPACKS_COPY.empty)).toBeTruthy();
    expect(chapterWord()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: COOKPACKS_COPY.refresh }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("says when every recipe failed, and lists them, rather than nothing having come in", () => {
    pack({ ...HOUSEHOLD, state: "empty", cookable: 0, missing: 2 });
    expect(screen.queryByText(COOKPACKS_COPY.empty)).toBeNull();
    expect(screen.getByText(COOKPACKS_COPY.noneCook(2))).toBeTruthy();
    expect(rows()).toEqual([
      "Lamb biryaniindian\u00a0· Sous couldn't read this one",
      "Crackersbaking\u00a0· Didn't come through on the last Refresh",
    ]);
  });

  it("says the book can't be read just now", () => {
    pack({ ...HOUSEHOLD, state: "unreadable", chapters: [] });
    expect(screen.getByText(COOKPACKS_COPY.unreadableView)).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});

describe("a creator's view", () => {
  it("opens under its running head, then a compact title page in type only, then its rows", () => {
    pack(FANNIE);
    const head = document.querySelector<HTMLElement>("[data-running-head]")!;
    expect(within(head).getByRole("heading", { name: FANNIE.title })).toBeTruthy();
    // No chapters, so no chapter word; no Refresh, which is the household's.
    expect(chapterWord()).toBeNull();
    expect(screen.queryByRole("button", { name: COOKPACKS_COPY.refresh })).toBeNull();
    const page = document.querySelector<HTMLElement>("[data-title-page]")!;
    expect(page.textContent).toBe("Fannie Merritt Farmer2 recipes");
    expect(page.querySelector("img, h2")).toBeNull();
    expect(rows()).toEqual(["Doughnuts I", "Thin White Sauce"]);
  });

  it("can be searched too, the field in its head in landscape, with no Refresh", () => {
    pack(FANNIE);
    const field = screen.getByRole("searchbox", { name: COOKPACKS_COPY.search });
    expect(document.querySelector("[data-running-head]")!.contains(field)).toBe(true);
    fireEvent.change(field, { target: { value: "sauce" } });
    expect(meta().textContent).toBe(COOKPACKS_COPY.matches(1, "sauce"));
    expect(rows()).toEqual(["Thin White Sauce"]);
    expect(document.querySelector("[data-title-page]")).toBeNull();
  });

  it("keeps its cloth down the binding", () => {
    pack(FANNIE);
    expect(document.querySelector("[data-binding='walnut']")).not.toBeNull();
  });

  it("toggles per-recipe privacy without picking the row when onTogglePrivate is provided", () => {
    const onPick = vi.fn();
    const onTogglePrivate = vi.fn();
    render(
      <PackView
        view={{
          ...HOUSEHOLD,
          chapters: [
            {
              anchor: "indian",
              title: "indian",
              rows: [row("Dal and rice", { isPrivate: false }), row("Lentil stew", { isPrivate: true })],
            },
          ],
        }}
        sendingId={null}
        sendFailure={null}
        onPick={onPick}
        onTogglePrivate={onTogglePrivate}
      />,
    );
    const dalToggle = screen.getByRole("button", { name: "Private: Dal and rice" });
    const stewToggle = screen.getByRole("button", { name: "Private: Lentil stew" });
    expect(dalToggle.getAttribute("aria-pressed")).toBe("false");
    expect(stewToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(dalToggle);
    expect(onTogglePrivate).toHaveBeenCalledWith("dal-and-rice", true);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("shows From <kitchen name> on a shared pack's title page and omits it on owned packs", () => {
    pack({
      ...FANNIE,
      id: "shared-pack",
      isOwned: false,
      fromKitchenName: "North Kitchen",
    });
    const sharedPage = document.querySelector<HTMLElement>("[data-title-page]")!;
    expect(sharedPage.querySelector("[data-from-kitchen]")?.textContent).toBe("From North Kitchen");
    cleanup();

    pack({
      ...FANNIE,
      id: "owned-pack",
      isOwned: true,
    });
    const ownedPage = document.querySelector<HTMLElement>("[data-title-page]")!;
    expect(ownedPage.querySelector("[data-from-kitchen]")).toBeNull();
  });

  it("shows Copy share link only on non-private cookable household rows and shows Share with circle switches for owners", () => {
    const onPick = vi.fn();
    const onCopyShareLink = vi.fn(() => true);
    render(
      <PackView
        view={{
          ...HOUSEHOLD,
          chapters: [
            {
              anchor: "indian",
              title: "indian",
              rows: [
                row("Dal and rice", { isPrivate: false, docRecipeId: "doc-1" }),
                row("Lentil stew", { isPrivate: true, docRecipeId: "doc-2" }),
                row("Lamb biryani", { missing: "refused", isPrivate: false, docRecipeId: "doc-3" }),
              ],
            },
          ],
        }}
        sendingId={null}
        sendFailure={null}
        onPick={onPick}
        onCopyShareLink={onCopyShareLink}
      />,
    );

    const copyBtn = screen.getByRole("button", { name: "Copy share link: Dal and rice" });
    fireEvent.click(copyBtn);
    expect(onCopyShareLink).toHaveBeenCalledWith("doc-1");
    expect(copyBtn.textContent).toBe("Copied");
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Copy share link: Lentil stew" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy share link: Lamb biryani" })).toBeNull();

    cleanup();
    const onCopyFail = vi.fn(async () => false);
    render(
      <PackView
        view={{
          ...HOUSEHOLD,
          chapters: [
            {
              anchor: "indian",
              title: "indian",
              rows: [row("Dal and rice", { isPrivate: false, docRecipeId: "doc-1" })],
            },
          ],
        }}
        sendingId={null}
        sendFailure={null}
        onPick={onPick}
        onCopyShareLink={onCopyFail}
      />,
    );
    const failedCopyBtn = screen.getByRole("button", { name: "Copy share link: Dal and rice" });
    fireEvent.click(failedCopyBtn);
    expect(onCopyFail).toHaveBeenCalledWith("doc-1");
    expect(failedCopyBtn.textContent).toBe("Copy share link");

    cleanup();
    const onToggle = vi.fn();
    render(
      <PackView
        view={{ ...FANNIE, id: "owned-pack", isOwned: true }}
        sendingId={null}
        sendFailure={null}
        onPick={onPick}
        circleSharing={{
          kitchens: [
            { kitchenId: "k-b", slug: "cedar", name: "Cedar Kitchen", shared: false },
            { kitchenId: "k-c", slug: "birch", name: "Birch Kitchen", shared: true },
          ],
          pending: false,
          onToggle,
        }}
      />,
    );

    const cedarSwitch = screen.getByRole("switch", { name: "Share with Cedar Kitchen" });
    const birchSwitch = screen.getByRole("switch", { name: "Share with Birch Kitchen" });
    expect(cedarSwitch.getAttribute("aria-checked")).toBe("false");
    expect(birchSwitch.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(cedarSwitch);
    expect(onToggle).toHaveBeenCalledWith("k-b", true);
  });

  it("renders Update collection and requires two taps for Remove from shelf", () => {
    const onPick = vi.fn();
    const onRemove = vi.fn();
    render(
      <PackView
        view={{ ...FANNIE, id: "owned-pack", isOwned: true }}
        sendingId={null}
        sendFailure={null}
        onPick={onPick}
        ownerActions={{
          editHref: "/kitchen/cookpacks/new?edit=owned-pack",
          removing: false,
          onRemove,
        }}
      />,
    );

    const updateLink = screen.getByRole("link", { name: "Update collection" });
    expect(updateLink.getAttribute("href")).toBe("/kitchen/cookpacks/new?edit=owned-pack");

    const removeBtn = screen.getByRole("button", { name: "Remove from shelf" });
    fireEvent.click(removeBtn);
    expect(onRemove).not.toHaveBeenCalled();
    expect(removeBtn.textContent).toBe("Tap again to remove");

    fireEvent.click(removeBtn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
