// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAG_ACK_MS, useCookFlag, useFlagNote } from "@/hooks/useCookFlag";
import type { CookReport, CookSnapshot } from "@/lib/kitchen/report-capture";
import type { FlagResult } from "@/lib/kitchen/report-outbox";
import { HeaderMore, MORE_COPY } from "./HeaderMore";

// The query is the network edge: what the server holds in progress, and
// whether the menu asked for it at all.
type Item = { id: string; recipeData?: { name: string } | null; recipeNotionId?: string | null };
let inProgress: Item[] = [];
const useQuery = vi.fn((_input: unknown, _opts: { enabled: boolean }) => ({ data: inProgress }));

vi.mock("@/lib/trpc", () => ({
  trpc: { getRecentCookingItems: { useQuery: (i: unknown, o: { enabled: boolean }) => useQuery(i, o) } },
}));

beforeEach(() => {
  inProgress = [
    { id: "a", recipeData: { name: "Dal" } },
    { id: "b", recipeData: { name: "Tacos" } },
    { id: "c", recipeData: null, recipeNotionId: "notion-c" },
  ];
  useQuery.mockClear();
});
afterEach(() => {
  cleanup();
});

/**
 * HeaderMore with its open state held above it, as the cook view holds it;
 * `shut` stands for the view shutting it from outside (voice's "close").
 */
function More(props: Omit<ComponentProps<typeof HeaderMore>, "open" | "onOpenChange">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HeaderMore {...props} open={open} onOpenChange={setOpen} />
      <button type="button" onClick={() => setOpen(false)}>
        shut
      </button>
    </>
  );
}

function button() {
  return screen.getByRole("button", { name: MORE_COPY.more });
}

function menu() {
  return document.querySelector<HTMLElement>("[data-holds-keys]");
}

describe("HeaderMore", () => {
  it("starts closed", () => {
    render(<More onShowInfo={() => {}} currentItemId="a" />);
    expect(button().getAttribute("aria-expanded")).toBe("false");
    // Nothing to point at while closed.
    expect(button().hasAttribute("aria-controls")).toBe(false);
    expect(menu()).toBeNull();
  });

  it("is a ghost: the dots alone, no fill, on a target-sized cell (V11)", () => {
    render(<More />);
    expect(button().className).not.toMatch(/(^| )bg-/);
    expect(button().className).toContain("active:bg-sand");
    expect(button().className).toContain("min-w-[var(--target)]");
    expect(button().className).toContain("h-[var(--target)]");
    // "More" is its name, not a word on the screen.
    expect(button().querySelector(".sr-only")?.textContent).toBe(MORE_COPY.more);
  });

  it("opens on Paper with a hairline, sand only as a row's press (V11)", () => {
    render(<More onShowInfo={() => {}} />);
    fireEvent.click(button());
    expect(menu()!.className).toContain("bg-paper");
    expect(menu()!.className).toContain("border-ink/[.11]");
    expect(menu()!.className).not.toContain("bg-sand");
    expect(screen.getByRole("button", { name: MORE_COPY.info }).className).toContain("active:bg-sand");
  });

  it("opens to info, the other recipes in progress and the way out", () => {
    render(
      <More onShowInfo={() => {}} currentItemId="a" />,
    );
    fireEvent.click(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    const open = menu()!;
    expect(button().getAttribute("aria-controls")).toBe(open.id);

    const m = within(open);
    expect(m.getAllByRole("button").map((b) => b.textContent)).toEqual([
      MORE_COPY.info,
    ]);
    expect(m.getByRole("button", { name: MORE_COPY.info })).toBeTruthy();
    expect(m.getByRole("heading", { name: MORE_COPY.inProgress(2) })).toBeTruthy();
    // The recipe on screen is left out; one with no name falls back to its id.
    expect(m.queryByRole("link", { name: "Dal" })).toBeNull();
    expect(m.getByRole("link", { name: "Tacos" }).getAttribute("href")).toBe("/kitchen/queue/b");
    expect(m.getByRole("link", { name: "notion-c" }).getAttribute("href")).toBe("/kitchen/queue/c");
    expect(m.getByRole("link", { name: MORE_COPY.exit }).getAttribute("href")).toBe("/kitchen");
  });

  it("a choice closes it, then does what it says", () => {
    const onShowInfo = vi.fn();
    render(<More onShowInfo={onShowInfo} />);

    fireEvent.click(button());
    fireEvent.click(screen.getByRole("button", { name: MORE_COPY.info }));
    expect(onShowInfo).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("leaves out what it isn't given", () => {
    render(<More />);
    fireEvent.click(button());
    const m = within(menu()!);
    expect(m.queryByRole("button", { name: MORE_COPY.info })).toBeNull();
    expect(m.getByRole("link", { name: MORE_COPY.exit })).toBeTruthy();
  });

  it("with the recipes in progress off, neither asks for them nor lists them", () => {
    render(<More showRecentItems={false} />);
    expect(useQuery.mock.lastCall?.[1]).toEqual({ enabled: false });
    fireEvent.click(button());
    expect(within(menu()!).queryByRole("heading")).toBeNull();
  });

  it("asks for the default cook's recipes in progress", () => {
    render(<More />);
    expect(useQuery.mock.lastCall).toEqual([{ userId: "cook", limit: 5 }, { enabled: true }]);
  });

  it("lists no heading when nothing else is in progress", () => {
    inProgress = [{ id: "a", recipeData: { name: "Dal" } }];
    render(<More currentItemId="a" />);
    fireEvent.click(button());
    expect(within(menu()!).queryByRole("heading")).toBeNull();
  });

  it("Escape closes it and puts focus back on the button", () => {
    render(<More />);
    fireEvent.click(button());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("takes the Escape it closes on, so nothing under it closes too", () => {
    render(<More />);
    fireEvent.click(button());
    expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(false);
  });

  it("stays open on an Escape a layer above it already took", () => {
    render(<More />);
    fireEvent.click(button());
    const above = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener("keydown", above, true);
    try {
      fireEvent.keyDown(document, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", above, true);
    }
    expect(menu()).not.toBeNull();
  });

  it("a press outside closes it; a press inside doesn't", () => {
    render(
      <>
        <p>outside</p>
        <More onShowInfo={() => {}} />
      </>,
    );
    fireEvent.click(button());
    fireEvent.mouseDown(screen.getByRole("button", { name: MORE_COPY.info }));
    expect(menu()).not.toBeNull();
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(menu()).toBeNull();
  });

  it("shut from outside, it closes, and focus on a row comes back to More", () => {
    render(<More onShowInfo={() => {}} />);
    fireEvent.click(button());
    screen.getByRole("button", { name: MORE_COPY.info }).focus();
    fireEvent.click(screen.getByRole("button", { name: "shut" }));
    expect(menu()).toBeNull();
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button());
  });

  it("shut from outside with focus elsewhere, it leaves focus be", () => {
    render(<More onShowInfo={() => {}} />);
    fireEvent.click(button());
    const shut = screen.getByRole("button", { name: "shut" });
    shut.focus();
    fireEvent.click(shut);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(shut);
  });

  it("a second press on the button closes it", () => {
    render(<More />);
    fireEvent.click(button());
    fireEvent.click(button());
    expect(menu()).toBeNull();
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  describe("the flag (B2)", () => {
    const SNAPSHOT: CookSnapshot = {
      queueId: null,
      recipeName: "Dal",
      plan: null,
      planVersion: null,
      state: { mode: "first", pos: 0, ticked: [], passed: [], kept: [] },
      screen: "prep",
      stepKey: "prep",
      chapterId: "prep",
      step: null,
      part: null,
      layers: { pane: false, card: null, more: true },
      voice: { mode: null, status: "off" },
      ask: { sessionId: "cook-queue-1", open: false },
    };

    /** More on a cook root, flagging through the real hook into a fake outbox. */
    function Flagging({ add }: { add: (report: CookReport) => Promise<FlagResult> }) {
      const { ack, flag } = useCookFlag(() => SNAPSHOT, {
        add,
        now: () => 1_770_000_000_000,
        id: () => "00000000-0000-4000-8000-000000000001",
        build: () => "test",
        miss: () => {},
        annotate: () => {},
        noteOf: () => "",
      });
      return (
        <div data-cook-root="">
          <p>Soak the dal</p>
          <More onShowInfo={() => {}} onFlag={flag} flagAck={ack} />
        </div>
      );
    }

    /** The ghost's labels, in the one cell they share. */
    function labels() {
      return [...document.querySelectorAll<HTMLElement>("button[aria-expanded] [data-pill-label]")];
    }

    function shown() {
      return labels().filter((l) => l.getAttribute("aria-hidden") !== "true");
    }

    it("is the menu's first row", () => {
      render(<More onShowInfo={() => {}} onFlag={() => {}} />);
      fireEvent.click(button());
      const first = within(menu()!).getAllByRole("button")[0];
      expect(first?.textContent).toBe(MORE_COPY.flag);
    });

    it("isn't there without a flag to call", () => {
      render(<More onShowInfo={() => {}} />);
      fireEvent.click(button());
      expect(within(menu()!).queryByRole("button", { name: MORE_COPY.flag })).toBeNull();
    });

    it("closes the menu and flags once, the screen taken before the menu goes", () => {
      let menuAtFlag: Element | null = null;
      const onFlag = vi.fn(() => {
        menuAtFlag = menu();
      });
      render(<More onFlag={onFlag} />);
      fireEvent.click(button());
      fireEvent.click(screen.getByRole("button", { name: MORE_COPY.flag }));
      expect(onFlag).toHaveBeenCalledTimes(1);
      expect(menu()).toBeNull();
      // The capture runs in the tap, while the menu is still drawn; the menu
      // is marked to be left out of it, so the report shows what was under.
      expect(menuAtFlag).not.toBeNull();
      expect(menuAtFlag!.hasAttribute("data-capture-omit")).toBe(true);
    });

    it("captures what is under the menu, not the menu", async () => {
      const add = vi.fn((_report: CookReport) => Promise.resolve("flagged" as const));
      render(<Flagging add={add} />);
      fireEvent.click(button());
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: MORE_COPY.flag }));
        await Promise.resolve();
      });
      const dom = add.mock.lastCall?.[0].dom ?? "";
      expect(dom).toContain("Soak the dal");
      expect(dom).not.toContain(MORE_COPY.info);
    });

    it("reads Noted on the pill for 1.6 s, then More", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        render(<Flagging add={() => Promise.resolve("flagged")} />);
        fireEvent.click(button());
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: MORE_COPY.flag }));
          await Promise.resolve();
        });
        const cell = screen.getByRole("button", { name: MORE_COPY.flagged });
        // In ink at 600 in the ghost's cell, no fill (V11; B2 fix round 1b,
        // C2: never lighter than the resting dots).
        expect(cell.className).not.toMatch(/(^| )bg-/);
        expect(cell.className).not.toContain("ember");
        expect(shown()[0]?.className).toContain("text-ink");
        expect(shown()[0]?.className).not.toContain("ink-soft");
        expect(shown()[0]?.className).toContain("font-semibold");
        act(() => vi.advanceTimersByTime(FLAG_ACK_MS - 1));
        expect(screen.getByRole("button", { name: MORE_COPY.flagged })).toBeTruthy();
        act(() => vi.advanceTimersByTime(1));
        expect(button()).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ["failed", "neither stored nor sent (F2)"],
      ["full", "refused, the tablet holding as many still to send as it keeps (F11)"],
    ] as const)("reads Not kept in ink for 1.6 s on a flag %s: %s", async (outcome, _why) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        render(<Flagging add={() => Promise.resolve(outcome)} />);
        fireEvent.click(button());
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: MORE_COPY.flag }));
          await Promise.resolve();
        });
        // Not ember (panel round 4): a flag not kept is the tablet's
        // trouble, not dinner's, and it waits in the hub's label.
        const cell = screen.getByRole("button", { name: MORE_COPY.notKept });
        expect(cell.className).not.toMatch(/(^| )bg-/);
        expect(shown()[0]?.className).toContain("text-ink");
        expect(shown()[0]?.className).not.toContain("ink-soft");
        expect(cell.className).not.toContain("ember");
        expect(cell.className).not.toContain("animate-");
        act(() => vi.advanceTimersByTime(FLAG_ACK_MS));
        expect(button()).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("holds its box: every label sits in the one cell, and only one shows", () => {
      const { rerender } = render(<HeaderMore open={false} onOpenChange={() => {}} />);
      for (const [ack, label] of [
        ["idle", MORE_COPY.more],
        ["flagged", MORE_COPY.flagged],
        ["failed", MORE_COPY.notKept],
        ["full", MORE_COPY.notKept],
      ] as const) {
        rerender(<HeaderMore open={false} onOpenChange={() => {}} flagAck={ack} />);
        // All three are always drawn, so the cell is as wide as the widest
        // whichever shows; the hidden ones are invisible, not gone.
        expect(labels()).toHaveLength(3);
        for (const l of labels()) expect(l.className).toContain("[grid-area:1/1]");
        expect(shown()).toHaveLength(1);
        expect(shown()[0]?.textContent).toBe(label);
        for (const l of labels()) {
          expect(l.className.includes("invisible")).toBe(l !== shown()[0]);
        }
      }
    });

    it("carries the flag on Noted and none on Not kept; More is the dots alone (panel round 4)", () => {
      render(<HeaderMore open={false} onOpenChange={() => {}} />);
      const [more, noted, notKept] = labels();
      expect(more?.querySelector("[data-flag-glyph]")).toBeNull();
      expect(more?.querySelector("svg")).not.toBeNull();
      expect(noted?.firstElementChild?.hasAttribute("data-flag-glyph")).toBe(true);
      expect(notKept?.querySelector("svg")).toBeNull();
      // The resting dots are ink-soft, a ghost's; what a flag says is ink.
      expect(more?.className).toContain("text-ink-soft");
    });
  });
});

// Cook-fidelity decision 8: a flag by touch opens a note on it where the menu
// hung, saying what a flag does; the note is optional and saved as it goes.
describe("the flag's note", () => {
  const SNAPSHOT: CookSnapshot = {
    queueId: null,
    recipeName: "Farro risotto",
    plan: null,
    planVersion: null,
    state: { mode: "first", pos: 1, ticked: [], passed: [], kept: [] },
    screen: "step",
    stepKey: "stock",
    chapterId: "stock",
    step: { n: 1, of: 6, name: "Heat the stock" },
    part: null,
    layers: { pane: false, card: null, more: true },
    voice: { mode: null, status: "off" },
    ask: { sessionId: "cook-queue-1", open: false },
  };
  const ID = "00000000-0000-4000-8000-000000000047";

  let notes: [string, string][] = [];
  /** The outbox's notes, by flag id, as `annotate` leaves them. */
  let stored: Record<string, string> = {};
  beforeEach(() => {
    notes = [];
    stored = {};
  });

  /** More as the cook view holds it: one open menu, "more" or the flag's "flag". */
  function Cook({
    outcome = "flagged",
    answer,
    place = "header",
  }: {
    outcome?: FlagResult;
    answer?: Promise<FlagResult>;
    /** Where More is drawn: a change mounts it afresh, as the sheet's More does. */
    place?: string;
  }) {
    const [held, setHeld] = useState<"more" | "flag" | null>(null);
    const cookFlag = useCookFlag(() => SNAPSHOT, {
      add: () => answer ?? Promise.resolve(outcome),
      now: () => 1_770_000_000_000,
      id: () => ID,
      build: () => "test",
      miss: () => {},
      annotate: (id, note) => {
        notes.push([id, note]);
        stored[id] = note;
      },
      noteOf: (id) => stored[id] ?? "",
    });
    const { flagByTouch, note: flagNote } = useFlagNote(cookFlag, held, setHeld);
    return (
      <div data-cook-root="">
        <p>Put the stock on to heat</p>
        <HeaderMore
          key={place}
          open={held === "more"}
          onOpenChange={(o) => setHeld(o ? "more" : null)}
          onFlag={flagByTouch}
          flagAck={cookFlag.ack}
          flagNote={flagNote}
        />
        <button type="button">elsewhere</button>
      </div>
    );
  }

  const note = () => document.querySelector<HTMLElement>("[data-flag-note]");
  const field = () => screen.getByRole("textbox", { name: MORE_COPY.flagNoteLabel });

  async function flagIt() {
    fireEvent.click(button());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MORE_COPY.flag }));
      await Promise.resolve();
    });
  }

  it("opens where the menu hung, saying what a flag does, the flag already kept", async () => {
    render(<Cook />);
    await flagIt();
    const panel = note();
    expect(panel).not.toBeNull();
    expect(within(panel!).getByText(MORE_COPY.flagSaved)).toBeTruthy();
    expect(field().getAttribute("placeholder")).toBe(MORE_COPY.flagNoteAsk);
    // Lifted Paper with a hairline, as the menu (DS §1); out of a capture,
    // holding the cook view's keys while it is open.
    expect(panel!.className).toContain("bg-paper");
    expect(panel!.className).toContain("border-ink/[.11]");
    expect(panel!.hasAttribute("data-capture-omit")).toBe(true);
    expect(panel!.hasAttribute("data-holds-keys")).toBe(true);
    expect(screen.queryByRole("button", { name: MORE_COPY.info })).toBeNull();
    // The pill still says how the flag went.
    expect(screen.getByRole("button", { name: MORE_COPY.flagged })).toBeTruthy();
  });

  it("drawn afresh while open (the sheet's More), it starts from the note saved, so typing adds to it", async () => {
    const { rerender } = render(<Cook />);
    await flagIt();
    fireEvent.change(field(), { target: { value: "the stock never got hot" } });

    rerender(<Cook place="sheet" />);
    expect(notes).toEqual([[ID, "the stock never got hot"]]);
    expect((field() as HTMLTextAreaElement).value).toBe("the stock never got hot");

    fireEvent.change(field(), { target: { value: "the stock never got hot; 10 min, not 5" } });
    fireEvent.click(screen.getByRole("button", { name: MORE_COPY.saveNote }));
    expect(stored[ID]).toBe("the stock never got hot; 10 min, not 5");
  });

  it("closed with nothing typed, keeps the flag as taken and writes no note", async () => {
    render(<Cook />);
    await flagIt();
    fireEvent.click(within(note()!).getByRole("button", { name: MORE_COPY.closeNote }));
    expect(note()).toBeNull();
    expect(notes).toEqual([]);
  });

  it("a note saved and then cleared, closed with the field empty, is removed", async () => {
    const { rerender } = render(<Cook />);
    await flagIt();
    fireEvent.change(field(), { target: { value: "too salty" } });
    // Drawn afresh (the sheet's More): the note is saved as the panel goes.
    rerender(<Cook place="sheet" />);
    expect(stored[ID]).toBe("too salty");

    fireEvent.change(field(), { target: { value: "  " } });
    fireEvent.click(within(note()!).getByRole("button", { name: MORE_COPY.closeNote }));
    expect(note()).toBeNull();
    expect(stored[ID]).toBe("");
    expect(notes).toEqual([
      [ID, "too salty"],
      [ID, ""],
    ]);
  });

  it("says Save note once something is typed, and saves it on the flag", async () => {
    render(<Cook />);
    await flagIt();
    fireEvent.change(field(), { target: { value: "  the stock should go on first  " } });
    fireEvent.click(within(note()!).getByRole("button", { name: MORE_COPY.saveNote }));
    expect(note()).toBeNull();
    expect(notes).toEqual([[ID, "the stock should go on first"]]);
  });

  it.each([
    ["a press outside", () => fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }))],
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
    ["More again", () => fireEvent.click(document.querySelector("[data-more-cell] > button")!)],
  ])("saves what was typed when %s puts it away", async (_how, putAway) => {
    render(<Cook />);
    await flagIt();
    fireEvent.change(field(), { target: { value: "too many leeks" } });
    act(() => {
      putAway();
    });
    expect(note()).toBeNull();
    expect(notes).toEqual([[ID, "too many leeks"]]);
    // More again closes the note; it doesn't open the menu over it.
    expect(menu()).toBeNull();
  });

  it("opens once the outbox keeps the flag, and not if More was opened meanwhile", async () => {
    let keep: (r: FlagResult) => void = () => {};
    const answer = new Promise<FlagResult>((resolve) => (keep = resolve));
    render(<Cook answer={answer} />);
    await flagIt();
    expect(note()).toBeNull();
    // The cook opens More again before the outbox answers: the note keeps out.
    fireEvent.click(button());
    expect(menu()).not.toBeNull();
    await act(async () => {
      keep("flagged");
      await answer;
    });
    expect(note()).toBeNull();
    expect(menu()).not.toBeNull();
  });

  it.each(["failed", "full"] as const)("doesn't open on a flag the outbox answers %s", async (outcome) => {
    render(<Cook outcome={outcome} />);
    await flagIt();
    expect(note()).toBeNull();
    expect(screen.getByRole("button", { name: MORE_COPY.notKept })).toBeTruthy();
  });
});
