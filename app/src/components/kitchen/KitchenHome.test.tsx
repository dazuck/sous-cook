// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShelfView } from "@/lib/shelf/view";
import { KITCHEN_COPY, KitchenHome, alsoUnderWay, type KitchenItem } from "./KitchenHome";
import { QUEUE_COPY } from "./QueueScreen";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tacos: KitchenItem = { id: "tacos", name: "Lime shrimp tacos" };
const stirFry: KitchenItem = { id: "stir", name: "Weeknight stir fry" };
const pho: KitchenItem = { id: "pho", name: "Chicken pho" };
const cookies: KitchenItem = {
  id: "cookies",
  name: "Chewy oat cookies",
  times: ["1 h 10 ·", "25 min hands-on", "+ soften butter at least 3 hours ahead"],
};
const dal: KitchenItem = { id: "dal", name: "Indian dal tadka" };
const puree: KitchenItem = { id: "puree", name: "Pea purée" };
const chickpea: KitchenItem = { id: "chickpea", name: "Chickpea stew" };
const soup: KitchenItem = { id: "soup", name: "Lentil soup" };
const rice: KitchenItem = { id: "rice", name: "Fried rice" };

type Props = ComponentProps<typeof KitchenHome>;

function home(over: Partial<Props> = {}) {
  const props: Props = {
    cooking: [],
    queue: [cookies, dal, pho, soup, rice],
    recent: [puree, chickpea],
    onStart: vi.fn(),
    onRemove: vi.fn(),
    onMarkDone: vi.fn(),
    onOpenImport: vi.fn(),
    ...over,
  };
  render(<KitchenHome {...props} />);
  return props;
}

/** Every class a node draws at rest: its tokens without a state variant. */
function atRest(el: Element): string[] {
  return el.className.split(/\s+/).filter((c) => c !== "" && !c.split("[")[0]!.includes(":"));
}

const footQueue = () => screen.getByRole("button", { name: /^Up next · \d+$/ });

describe("the appliance home frame", () => {
  it("is a single non-scrolling frame with the illustration body and the right-edge appliance rail (no four-corner text clutter)", () => {
    home();
    const frame = document.querySelector("[data-kitchen-home]")!;
    expect(frame.className).toContain("h-dvh");
    expect(frame.className).toContain("overflow-hidden");
    expect(document.querySelector("[data-home-body]")).toBeTruthy();
    expect(document.querySelector("[data-home-rail]")).toBeTruthy();
    expect(document.querySelector("[data-home-time]")).toBeNull();
    expect(document.querySelector("[data-home-recent]")).toBeNull();
  });

  it("draws the rail and leaves the body bare until the reads have answered (D18, F15)", () => {
    home({ ready: false, shelf: null });
    expect(document.querySelector("[data-home-rail]")).toBeTruthy();
    expect(document.querySelector("[data-subject]")).toBeNull();
    expect(document.querySelector("[data-idle-subject]")).toBeNull();
  });
});

describe("the right-edge appliance icon rail and pull-out tab", () => {
  it("exposes direct 1-tap icons for Cookpacks, Up next, and Import, plus a pull-out tab with Add ingredients and other labels", () => {
    const props = home({ onOpenAddIngredients: vi.fn(), onOpenAsk: vi.fn() });
    const rail = document.querySelector<HTMLElement>("[data-home-rail]")!;

    // Direct 1-tap Import on the rail:
    fireEvent.click(within(rail).getByRole("button", { name: "Import recipe" }));
    expect(props.onOpenImport).toHaveBeenCalledTimes(1);

    // Pulling out the tab via the More handle reveals labeled rows and closes on selection:
    fireEvent.click(within(rail).getByRole("button", { name: "More" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: KITCHEN_COPY.addIngredients }));
    expect(props.onOpenAddIngredients).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(within(rail).getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Import" }));
    expect(props.onOpenImport).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("pulls out the labeled tab on a long-press or a drag left along the rail", () => {
    vi.useFakeTimers();
    home({ onOpenAddIngredients: vi.fn() });
    const rail = document.querySelector<HTMLElement>("[data-home-rail]")!;

    fireEvent.pointerDown(rail, { pointerId: 1, button: 0, clientX: 1200, clientY: 400, isPrimary: true });
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByRole("menu")).toBeTruthy();

    // The finger lifts (the click that ends a long-press is swallowed), then the handle, now the way out, closes it.
    fireEvent.pointerUp(rail, { pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("menu")).toBeNull();

    // Drag left along the rail:
    fireEvent.pointerDown(rail, { pointerId: 2, button: 0, clientX: 1240, clientY: 400, isPrimary: true });
    fireEvent.pointerMove(rail, { pointerId: 2, clientX: 1210, clientY: 402 });
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("opens the names panel with Ask Sous first, a glyph on every row, no header, and the handle as the way out (DS v1.57)", () => {
    home({ onOpenAddIngredients: vi.fn(), onOpenShoppingList: vi.fn(), onOpenAsk: vi.fn() });
    const rail = document.querySelector<HTMLElement>("[data-home-rail]")!;
    const handle = within(rail).getByRole("button", { name: "More" });
    const closedGlyph = handle.querySelector("svg")!.innerHTML;
    expect(handle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(handle);
    const menu = screen.getByRole("menu");
    const rows = Array.from(menu.children).filter((r) => r.getAttribute("role") === "menuitem");
    expect(rows[0]!.textContent).toContain("Ask Sous");
    expect(rows.map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Cookpacks"), expect.stringContaining("Shopping list")]),
    );
    for (const row of rows) expect(row.querySelector("svg")).toBeTruthy();
    // No header row: every child of the menu is a row you can choose, and the panel holds only the way out and the menu.
    expect(Array.from(menu.children).map((r) => r.getAttribute("role"))).toEqual(rows.map(() => "menuitem"));
    const panel = document.querySelector<HTMLElement>("[data-rail-tab]")!;
    expect(Array.from(panel.children).map((el) => (el.hasAttribute("data-rail-close") ? "close" : el.getAttribute("role")))).toEqual([
      "close",
      "menu",
    ]);

    // The handle stays "More", says it is open, and draws the closing chevron where the four tiles were.
    expect(handle.getAttribute("aria-expanded")).toBe("true");
    expect(handle.querySelector("svg")!.innerHTML).not.toBe(closedGlyph);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps Import second on the rail and in the panel, and names each rail icon on hover", () => {
    home({ onOpenAddIngredients: vi.fn(), onOpenAsk: vi.fn() });
    const rail = document.querySelector<HTMLElement>("[data-home-rail]")!;
    const names = Array.from(rail.querySelectorAll("nav > *")).map((el) => el.getAttribute("aria-label"));
    expect(names.slice(0, 2)).toEqual([KITCHEN_COPY.cookpacks, "Import recipe"]);
    for (const el of Array.from(rail.querySelectorAll("nav > *[aria-label]"))) {
      expect(el.querySelector("span[aria-hidden]")?.textContent).toBe(el.getAttribute("aria-label"));
    }
    fireEvent.click(within(rail).getByRole("button", { name: "More" }));
    const items = screen.getAllByRole("menuitem").map((r) => r.textContent);
    expect(items[1]).toContain("Cookpacks");
    expect(items[2]).toContain("Import");
  });

  it("has no Edit on the home rail: that lives on the queue screen", () => {
    home();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("holds the flag's entry in data-kitchen-room on the rail when present", () => {
    home({ flagged: <button type="button">2 flagged screens</button> });
    const room = screen.getByRole("button", { name: "2 flagged screens" }).parentElement!;
    expect(room.hasAttribute("data-kitchen-room")).toBe(true);
  });
});

describe("the queue as the subject (integrated into the meal illustration)", () => {
  it("builds the eyebrow, top dish title, time line, and non-pill hand-inked Start callout into the meal illustration", () => {
    const props = home();
    const illustration = document.querySelector('[data-home-illustration="meal"]')!;
    expect(illustration).toBeTruthy();
    const dish = screen.getByRole("heading", { level: 2, name: cookies.name });
    expect(atRest(dish)).toContain("text-ink");
    expect(dish.className).toContain("font-[family-name:var(--font-display)]");
    const start = screen.getByRole("button", { name: KITCHEN_COPY.start });
    // Non-pill Start callout integrated into the illustration:
    expect(start.className).not.toContain("rounded-full");
    expect(start.className).not.toContain("bg-ember");
    fireEvent.click(start);
    expect(props.onStart).toHaveBeenCalledWith(cookies);
  });

  it("says the time line under the dish, never when it was sent", () => {
    home();
    expect(screen.getByText(/1 h 10/)).toBeTruthy();
  });

  it("names the next two dishes, each a tap that starts it, then how many more opens the queue", () => {
    const props = home();
    const line = document.querySelector("[data-then]")!;
    const starts = [...line.querySelectorAll<HTMLButtonElement>("[data-then-start]")];
    expect(starts.map((b) => b.textContent)).toEqual([dal.name, pho.name]);
    fireEvent.click(starts[1]!);
    expect(props.onStart).toHaveBeenCalledWith(pho);
    fireEvent.click(within(line as HTMLElement).getByRole("button", { name: "2 more" }));
    expect(screen.getByRole("dialog", { name: QUEUE_COPY.kind })).toBeTruthy();
  });

  it("draws no Then line for a queue of one, and no 'more' for three", () => {
    home({ queue: [cookies] });
    expect(document.querySelector("[data-then]")).toBeNull();
    cleanup();
    home({ queue: [cookies, dal, pho] });
    const mores = [...document.querySelectorAll<HTMLElement>("[data-then-more]")];
    expect(mores.map((b) => b.textContent)).toEqual(["1 more"]);
    expect(mores[0]!.className).toContain("landscape:hidden");
  });

  it("is not drawn while a cook is under way", () => {
    home({ cooking: [tacos] });
    expect(document.querySelector("[data-queue-subject]")).toBeNull();
  });
});

describe("a cook under way (the lead)", () => {
  it("names the newest cook in ember display type inside the meal illustration without a 'Pick up where you left off' eyebrow, and goes back into it", () => {
    home({ cooking: [tacos, stirFry] });
    expect(screen.queryByText(KITCHEN_COPY.lead)).toBeNull();
    expect(screen.getByRole("region", { name: KITCHEN_COPY.lead })).toBeTruthy();
    const lead = screen.getByRole("link", { name: tacos.name });
    expect(lead.getAttribute("href")).toBe("/kitchen/queue/tacos");
    const name = lead.parentElement!;
    expect(atRest(name)).toContain("text-ember-700");
    expect(atRest(name)).toContain("font-[family-name:var(--font-display)]");
  });

  it("yields the ember to a running timer: the name is ink", () => {
    home({ cooking: [tacos] });
    expect(atRest(screen.getByRole("link", { name: tacos.name }).parentElement!)).toContain("text-ember-700");
  });

  it("names the others under way, each a link that resumes it, and none for a single cook", () => {
    home({ cooking: [tacos, stirFry, pho] });
    const also = document.querySelector("[data-also]")!;
    expect(within(also as HTMLElement).getAllByRole("link").map((a) => a.textContent)).toEqual([
      stirFry.name,
      pho.name,
    ]);
    cleanup();
    home({ cooking: [tacos] });
    expect(document.querySelector("[data-also]")).toBeNull();
  });
});

describe("the ask (T2)", () => {
  const ask = <section aria-label="the ask">How was it?</section>;

  it("is the subject while nothing is cooking, in place of the queue", () => {
    home({ ask });
    expect(screen.getByRole("region", { name: "the ask" })).toBeTruthy();
    expect(document.querySelector("[data-queue-subject]")).toBeNull();
  });

  it("waits while a cook is under way: that cook is the one subject", () => {
    home({ cooking: [tacos], ask });
    expect(screen.queryByRole("region", { name: "the ask" })).toBeNull();
  });
});

describe("alsoUnderWay", () => {
  it("joins the names as a sentence does", () => {
    expect(alsoUnderWay(["A"])).toEqual(["A"]);
    expect(alsoUnderWay(["A", "B"])).toEqual(["A", " and ", "B"]);
    expect(alsoUnderWay(["A", "B", "C"])).toEqual(["A", ", ", "B", " and ", "C"]);
  });
});

describe("the rail's Cookpacks and queue icons", () => {
  it("holds Cookpacks, a link to the shelf, and Up next with the queue's count", () => {
    home();
    const rail = document.querySelector<HTMLElement>("[data-home-rail]")!;
    expect(within(rail).getByRole("link", { name: KITCHEN_COPY.cookpacks }).getAttribute("href")).toBe(
      "/kitchen/cookpacks",
    );
    expect(within(rail).getByRole("button", { name: "Up next · 5" })).toBeTruthy();
  });

  it("says Under way with only cooks, Made recently when idle with some, and nothing with nothing", () => {
    home({ cooking: [tacos], queue: [] });
    expect(screen.getByRole("button", { name: "Under way · 1" })).toBeTruthy();
    cleanup();
    home({ cooking: [], queue: [] });
    expect(screen.getByRole("button", { name: "Made recently" })).toBeTruthy();
    cleanup();
    home({ cooking: [], queue: [], recent: [] });
    expect(document.querySelector("[data-foot-queue]")).toBeNull();
  });

  it("opens the queue screen", () => {
    home();
    fireEvent.click(footQueue());
    expect(screen.getByRole("dialog", { name: QUEUE_COPY.kind })).toBeTruthy();
  });
});

describe("the queue screen (D10)", () => {
  it("lists the queue as rows, each one button named for the recipe, and starts it", () => {
    const props = home();
    fireEvent.click(footQueue());
    const screenEl = screen.getByRole("dialog", { name: QUEUE_COPY.kind });
    const rows = within(screenEl).getAllByRole("button", { name: /Chewy|Indian|Chicken pho|Lentil|Fried rice/ });
    expect(rows).toHaveLength(5);
    fireEvent.click(rows[1]!);
    expect(props.onStart).toHaveBeenCalledWith(dal);
  });

  it("offers no Remove until Edit is on, then removes without starting", () => {
    const props = home();
    fireEvent.click(footQueue());
    expect(screen.queryByRole("button", { name: QUEUE_COPY.remove })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: QUEUE_COPY.edit }));
    fireEvent.click(screen.getAllByRole("button", { name: QUEUE_COPY.remove })[0]!);
    expect(props.onRemove).toHaveBeenCalledWith("cookies");
    expect(props.onStart).not.toHaveBeenCalled();
  });

  it("lists the cooks under way, with Mark as done under Edit", () => {
    const props = home({ cooking: [tacos] });
    fireEvent.click(footQueue());
    expect(screen.getByRole("heading", { name: QUEUE_COPY.underWay })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: QUEUE_COPY.edit }));
    fireEvent.click(screen.getByRole("button", { name: QUEUE_COPY.markDone }));
    expect(props.onMarkDone).toHaveBeenCalledWith("tacos");
  });

  it("holds Made recently as its last section", () => {
    home();
    fireEvent.click(footQueue());
    const section = document.querySelector<HTMLElement>("[data-queue-screen] [data-made-recently]")!;
    expect(within(section).getAllByRole("link").map((a) => a.textContent)).toEqual([puree.name, chickpea.name]);
  });

  it("goes back to the kitchen on its top-left back button", () => {
    home();
    fireEvent.click(footQueue());
    fireEvent.click(screen.getByRole("button", { name: /Back to the kitchen/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open and says so when the last row leaves, and ends Edit (F8)", () => {
    const view = render(
      <KitchenHome cooking={[]} queue={[cookies]} recent={[]} onStart={vi.fn()} onRemove={vi.fn()} onMarkDone={vi.fn()} onOpenImport={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Up next · 1" }));
    fireEvent.click(screen.getByRole("button", { name: QUEUE_COPY.edit }));
    view.rerender(
      <KitchenHome cooking={[]} queue={[]} recent={[]} onStart={vi.fn()} onRemove={vi.fn()} onMarkDone={vi.fn()} onOpenImport={vi.fn()} />,
    );
    expect(screen.getByRole("dialog", { name: QUEUE_COPY.kind })).toBeTruthy();
    expect(screen.getByText(QUEUE_COPY.empty)).toBeTruthy();
    expect(screen.queryByRole("button", { name: QUEUE_COPY.edit })).toBeNull();
  });
});

const testShelf: ShelfView = {
  household: {
    id: "household-book",
    title: "Household Book",
    state: "ok",
    cookable: 50,
    missing: 2,
    syncedAt: "2026-10-04T12:00:00.000Z",
    contents: [
      { anchor: "indian", title: "Indian", count: 9 },
      { anchor: "baking", title: "Baking", count: 6 },
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
};

describe("the idle kitchen (open cookbooks & ingredients illustration)", () => {
  it("renders the idle cookbooks illustration with an integrated callout to explore Cookpacks & recipes", () => {
    home({ cooking: [], queue: [], shelf: testShelf });
    expect(document.querySelector('[data-home-illustration="idle"]')).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: KITCHEN_COPY.idleHeading })).toBeTruthy();
    const explore = document.querySelector<HTMLAnchorElement>("[data-explore-cookpacks]")!;
    expect(explore.getAttribute("href")).toBe("/kitchen/cookpacks");
    expect(explore.textContent).toContain(KITCHEN_COPY.idleCta);
  });

  it("calls onOpenSaved when the saved for later note is tapped", () => {
    const onOpenSaved = vi.fn();
    home({ cooking: [], queue: [], shelf: testShelf, onOpenSaved });
    fireEvent.click(screen.getByRole("button", { name: /Saved for later/ }));
    expect(onOpenSaved).toHaveBeenCalled();
  });

  it("does not mount the idle illustration when recipes are queued", () => {
    home({ cooking: [], queue: [cookies], shelf: testShelf });
    expect(document.querySelector('[data-home-illustration="idle"]')).toBeNull();
  });
});

describe("reads that haven't answered (item 2)", () => {
  it("says it is still loading, and never claims an empty queue nobody read", () => {
    home({ cooking: [], queue: [], recent: [], shelf: null, loading: "slow" });
    expect(screen.getByText("Still loading the kitchen…")).toBeTruthy();
    expect(document.querySelector('[data-home-illustration="idle"]')).toBeNull();
  });

  it("says it is offline and shows what was last kept", () => {
    home({ loading: "offline" });
    expect(screen.getByText("Offline. Showing what was last kept.")).toBeTruthy();
  });

  it("says nothing once everything has answered", () => {
    home({ loading: null });
    expect(document.querySelector("[data-home-status]")).toBeNull();
  });
});

describe("circle dishes on home", () => {
  it("renders up to three quiet rows when idle or queued, never shows ratings, and links to Friends' kitchens", () => {
    home({ circleDishes: [] });
    expect(document.querySelector("[data-circle-dishes]")).toBeNull();
    cleanup();

    const today = new Date().toISOString().slice(0, 10);
    const dishes = [
      {
        logId: "log-open",
        recipeTitle: "Lemon Pasta",
        kitchenName: "Maple Kitchen",
        cookedDay: today,
        note: "Extra zest",
        canOpenRecipe: true,
        packBlocked: false,
      },
      {
        logId: "log-private",
        recipeTitle: "Family Broth",
        kitchenName: "Cedar Kitchen",
        cookedDay: "2026-11-23",
        note: null,
        canOpenRecipe: false,
        packBlocked: false,
      },
      {
        logId: "log-pack-blocked",
        recipeTitle: "Hidden Pack Stew",
        kitchenName: "Birch Kitchen",
        cookedDay: "2026-11-22",
        note: null,
        canOpenRecipe: false,
        packBlocked: true,
      },
      {
        logId: "log-fourth",
        recipeTitle: "Fourth Dish",
        kitchenName: "Oak Kitchen",
        cookedDay: "2026-11-21",
        note: null,
        canOpenRecipe: true,
        packBlocked: false,
      },
    ];

    home({ circleDishes: dishes, inCircle: true });

    const section = document.querySelector("[data-circle-dishes]")!;
    expect(section).toBeTruthy();
    const headerLink = within(section as HTMLElement).getByRole("link", { name: "Friends' kitchens" });
    expect(headerLink.getAttribute("href")).toBe("/kitchen/circle");
    const seeAllLink = within(section as HTMLElement).getByRole("link", { name: "See all (4)" });
    expect(seeAllLink.getAttribute("href")).toBe("/kitchen/circle");

    const openLink = within(section as HTMLElement).getByRole("link", { name: "Lemon Pasta" });
    expect(openLink.getAttribute("href")).toBe("/kitchen/circle/dish/log-open");
    expect(section.textContent).toContain("Maple Kitchen");
    expect(section.textContent).toContain("today");
    expect(section.textContent).not.toContain("of 5");
    expect(section.textContent).toContain("Extra zest");

    expect(within(section as HTMLElement).queryByRole("link", { name: "Family Broth" })).toBeNull();
    expect(section.textContent).toContain("Family Broth");
    expect(within(section as HTMLElement).queryByRole("link", { name: "Hidden Pack Stew" })).toBeNull();
    expect(section.textContent).toContain("Hidden Pack Stew");
    expect(section.textContent).not.toContain("Fourth Dish");
    cleanup();

    // Hidden when actively cooking or when How was it? is asking
    home({
      circleDishes: dishes,
      cooking: [{ id: "c1", recipeData: { name: "Roast Chicken", steps: ["Roast."] } } as never],
    });
    expect(document.querySelector("[data-circle-dishes]")).toBeNull();
    cleanup();

    home({
      circleDishes: dishes,
      ask: <div data-testid="mock-ask">How was it?</div>,
    });
    expect(document.querySelector("[data-circle-dishes]")).toBeNull();
  });

  it("renders firstRunPrompt only when idle or queued, never while cooking or asking", () => {
    home({ firstRunPrompt: <div data-testid="about-card">About card</div> });
    expect(screen.getByTestId("about-card")).toBeTruthy();
    cleanup();

    home({
      firstRunPrompt: <div data-testid="about-card">About card</div>,
      cooking: [{ id: "c1", recipeData: { name: "Roast Chicken", steps: ["Roast."] } } as never],
    });
    expect(screen.queryByTestId("about-card")).toBeNull();
    cleanup();

    home({
      firstRunPrompt: <div data-testid="about-card">About card</div>,
      ask: <div data-testid="mock-ask">How was it?</div>,
    });
    expect(screen.queryByTestId("about-card")).toBeNull();
  });
});
