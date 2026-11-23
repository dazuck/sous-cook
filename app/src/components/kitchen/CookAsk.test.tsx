// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CookAsk } from "@/lib/kitchen-cook-log";
import {
  ASK_COPY,
  askPollInterval,
  CookAskLine,
  refusedAnswer,
  type RateAnswer,
  type RetryAnswer,
} from "./CookAsk";

// The kitchen's "How was it?" (T2): today's latest finished cook, five taps,
// a short note and Not now; the Cook Log's trouble said in its own line.

afterEach(cleanup);

type Props = ComponentProps<typeof CookAskLine>;

/** A promise the test settles by hand, to see the line while it waits. */
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function line(over: Partial<Props> = {}) {
  const props: Props = {
    ask: { queueId: "dal", name: "Indian dal tadka", state: "logged" },
    onRate: vi.fn(async (): Promise<RateAnswer> => "rated"),
    onRetry: vi.fn(async (): Promise<RetryAnswer> => "logged"),
    onDismiss: vi.fn(),
    ...over,
  };
  const view = render(<CookAskLine {...props} />);
  return { props, ...view };
}

const rate = (n: number) => screen.getByRole("button", { name: ASK_COPY.rate(n) });
const rates = () => [1, 2, 3, 4, 5].map(rate);

/** Every class a node draws at rest: its tokens without a state variant. */
function atRest(el: Element): string[] {
  return el.className.split(/\s+/).filter((c) => c !== "" && !c.split("[")[0]!.includes(":"));
}

describe("a written cook", () => {
  it("asks how it was over the dish's name, with five taps, a note and Not now", () => {
    line();
    expect(screen.getByRole("heading", { level: 2, name: ASK_COPY.ask }).textContent).toBe("How was it?");
    expect(screen.getByText("Indian dal tadka")).toBeTruthy();
    expect(rates().map((b) => b.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    expect(screen.getByRole("group", { name: ASK_COPY.ask })).toBeTruthy();
    expect(screen.getByRole("button", { name: ASK_COPY.addNote })).toBeTruthy();
    expect(screen.getByRole("button", { name: ASK_COPY.notNow })).toBeTruthy();
    expect(screen.queryByText(ASK_COPY.notLogged)).toBeNull();
  });

  it("names a cook with no name as the cook's top line does", () => {
    line({ ask: { queueId: "dal", name: null, state: "logged" } });
    expect(screen.getByText("Untitled recipe")).toBeTruthy();
  });

  it("is ink and ghosts: nothing in it is ember, and nothing is filled at rest", () => {
    const { container } = line();
    for (const el of container.querySelectorAll("*")) {
      expect(atRest(el).filter((c) => c.includes("ember"))).toEqual([]);
      expect(atRest(el)).not.toContain("bg-sand");
    }
  });

  it("rates on one tap, holding every tap while it sends", async () => {
    const sent = deferred<RateAnswer>();
    const { props } = line({ onRate: vi.fn(() => sent.promise) });
    fireEvent.click(rate(4));
    expect(props.onRate).toHaveBeenCalledWith(4, "");
    for (const b of rates()) expect(b.hasAttribute("disabled")).toBe(true);
    expect(rate(4).getAttribute("aria-pressed")).toBe("true");
    // Each numeral sits in a hairline ring; the one rated, in an ink ring (v1.16).
    expect(rate(4).className.split(/\s+/)).toContain("before:border-ink");
    expect(rate(2).className.split(/\s+/)).toContain("before:border-ink/[.2]");
    fireEvent.click(rate(2));
    expect(props.onRate).toHaveBeenCalledTimes(1);
    // Rated, the line keeps its taps held until the kitchen takes it away.
    await act(async () => sent.settle("rated"));
    expect(rate(4).hasAttribute("disabled")).toBe(true);
  });

  it("takes a note first, and sends it with the rating", () => {
    const { props } = line();
    fireEvent.click(screen.getByRole("button", { name: ASK_COPY.addNote }));
    const note = screen.getByRole("textbox", { name: ASK_COPY.note });
    expect(document.activeElement).toBe(note);
    expect(note.getAttribute("maxlength")).toBe("500");
    fireEvent.change(note, { target: { value: "Less salt next time" } });
    fireEvent.click(rate(5));
    expect(props.onRate).toHaveBeenCalledWith(5, "Less salt next time");
  });

  it("keeps Add a note where it was while the note is open, so Not now never moves under a finger", () => {
    line();
    const add = screen.getByRole("button", { name: ASK_COPY.addNote });
    const notNow = screen.getByRole("button", { name: ASK_COPY.notNow });
    expect(add.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(add);
    // The same two buttons, in the same order: nothing slid into Add a
    // note's place (critic round 1, gap 4).
    const words = [...notNow.parentElement!.querySelectorAll("button")];
    expect(words).toEqual([add, notNow]);
    expect(add.getAttribute("aria-expanded")).toBe("true");
    expect(add.getAttribute("aria-controls")).toBe(screen.getByRole("textbox", { name: ASK_COPY.note }).id);
    // Open, it is in force: ink 600 in an ink ring (v1.16).
    expect(add.className.split(/\s+/)).toEqual(expect.arrayContaining(["font-semibold", "text-ink", "before:border-ink"]));
    // Tapped again, it takes the cook back to the field, words kept.
    const note = screen.getByRole("textbox", { name: ASK_COPY.note });
    fireEvent.change(note, { target: { value: "More lemon" } });
    act(() => notNow.focus());
    fireEvent.click(add);
    expect(document.activeElement).toBe(note);
    expect((note as HTMLInputElement).value).toBe("More lemon");
  });

  it("draws the note's ring on the column's edge, not past it (P47)", () => {
    line();
    fireEvent.click(screen.getByRole("button", { name: ASK_COPY.addNote }));
    const tokens = screen.getByRole("textbox", { name: ASK_COPY.note }).className.split(/\s+/);
    // The 1 px ring drawn inside the field's box, so it closes on the edge;
    // the words keep their room from it by the field's own padding.
    expect(tokens).toEqual(
      expect.arrayContaining(["w-full", "focus-visible:outline-1", "focus-visible:-outline-offset-1"]),
    );
    expect(tokens.filter((t) => /(^|:)outline-offset-/.test(t) || t.startsWith("max-w-"))).toEqual([]);
  });

  it("goes with Not now", () => {
    const { props } = line();
    fireEvent.click(screen.getByRole("button", { name: ASK_COPY.notNow }));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["failed", ASK_COPY.rateFailed],
    ["writing", ASK_COPY.stillWriting],
    ["error", ASK_COPY.error],
  ] as const)("says so when a rating answers %s, and offers the taps again", async (answer, words) => {
    line({ onRate: vi.fn(async () => answer) });
    await act(async () => fireEvent.click(rate(3)));
    expect(screen.getByText(words)).toBeTruthy();
    expect(rate(3).hasAttribute("disabled")).toBe(false);
    expect(rate(3).getAttribute("aria-pressed")).toBe("false");
  });

  it("says a refusal under the taps, so the numeral under the finger never moves (critic round 2, gap 6)", async () => {
    line({ onRate: vi.fn(async (): Promise<RateAnswer> => "failed") });
    await act(async () => fireEvent.click(rate(3)));
    const said = screen.getByRole("status");
    expect(said.textContent).toContain(ASK_COPY.rateFailed);
    // After the taps and the words, in the document's order: nothing it
    // says is put between the name and the numerals.
    for (const control of [rate(5), screen.getByRole("button", { name: ASK_COPY.notNow })]) {
      expect(control.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("starts again for the next cook asked of", async () => {
    const { rerender, props } = line({ onRate: vi.fn(async (): Promise<RateAnswer> => "rated") });
    await act(async () => fireEvent.click(rate(3)));
    rerender(<CookAskLine {...props} ask={{ queueId: "salmon", name: "Seared salmon", state: "logged" }} />);
    expect(screen.getByText("Seared salmon")).toBeTruthy();
    expect(rate(3).hasAttribute("disabled")).toBe(false);
  });
});

describe("a cook not in the cook log", () => {
  const failed = { queueId: "dal", name: "Indian dal tadka", state: "failed" } as const;

  it("says it isn't in the cook log yet, with a retry, and can still be rated", async () => {
    const { props } = line({ ask: failed });
    expect(screen.getByText(ASK_COPY.notLogged)).toBeTruthy();
    // Under the taps, as every line it says (critic round 2, gap 6).
    const said = screen.getByRole("status");
    expect(rate(5).compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: ASK_COPY.retry })));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(rate(1).hasAttribute("disabled")).toBe(false);
  });

  it("holds the retry while it runs, and says so if it fails again", async () => {
    const tried = deferred<RetryAnswer>();
    const { props } = line({ ask: failed, onRetry: vi.fn(() => tried.promise) });
    fireEvent.click(screen.getByRole("button", { name: ASK_COPY.retry }));
    expect(screen.getByRole("button", { name: ASK_COPY.retry }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: ASK_COPY.retry }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    await act(async () => tried.settle("failed"));
    expect(screen.getByText(ASK_COPY.stillNotLogged)).toBeTruthy();
    expect(screen.queryByText(ASK_COPY.notLogged)).toBeNull();
    expect(screen.getByRole("button", { name: ASK_COPY.retry }).hasAttribute("disabled")).toBe(false);
  });
});

describe("a cook still being written", () => {
  it("holds the taps until the row is written, and says nothing of it", () => {
    line({ ask: { queueId: "dal", name: "Indian dal tadka", state: "writing" } });
    for (const b of rates()) expect(b.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(ASK_COPY.notLogged)).toBeNull();
    expect(screen.getByRole("button", { name: ASK_COPY.notNow }).hasAttribute("disabled")).toBe(false);
  });
});

describe("refusedAnswer", () => {
  /** An error as the tRPC client raises it: the code in `data`, the reason as message. */
  const refused = (code: string, message: string) =>
    Object.assign(new Error(message), { data: { code } });

  it("reads the server's CONFLICT reasons and NOT_FOUND", () => {
    expect(refusedAnswer(refused("CONFLICT", "writing"))).toBe("writing");
    expect(refusedAnswer(refused("CONFLICT", "row-moved"))).toBe("row-moved");
    expect(refusedAnswer(refused("CONFLICT", "not-completed"))).toBe("gone");
    expect(refusedAnswer(refused("NOT_FOUND", "No kitchen queue item"))).toBe("gone");
  });

  it("calls anything else an error", () => {
    expect(refusedAnswer(refused("INTERNAL_SERVER_ERROR", "boom"))).toBe("error");
    expect(refusedAnswer(new TypeError("Failed to fetch"))).toBe("error");
    expect(refusedAnswer(null)).toBe("error");
  });
});

describe("a cook whose Cook Log can't be read just now (T follow-up, item 2)", () => {
  const unread = { queueId: "dal", name: "Indian dal tadka", state: "unread" } as const;

  it("says so under the taps, offers no retry, and can still be rated", () => {
    line({ ask: unread });
    const said = screen.getByRole("status");
    expect(said.textContent).toBe("Can't reach the cook log just now.");
    expect(said.textContent).toBe(ASK_COPY.unread);
    expect(rate(5).compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: ASK_COPY.retry })).toBeNull();
    for (const b of rates()) expect(b.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: ASK_COPY.addNote })).toBeTruthy();
  });

  it("gives way to what a tap answers", async () => {
    line({ ask: unread, onRate: vi.fn(async (): Promise<RateAnswer> => "error") });
    await act(async () => fireEvent.click(rate(3)));
    expect(screen.getByRole("status").textContent).toBe(ASK_COPY.error);
  });
});

describe("a cook whose row moved", () => {
  it("says the row moved and offers only Not now", () => {
    line({ ask: { queueId: "dal", name: "Indian dal tadka", state: "row-moved" } });
    expect(screen.getByText(ASK_COPY.rowMoved)).toBeTruthy();
    expect(screen.queryByRole("button", { name: ASK_COPY.rate(1) })).toBeNull();
    expect(screen.queryByRole("button", { name: ASK_COPY.addNote })).toBeNull();
    expect(screen.getByRole("button", { name: ASK_COPY.notNow })).toBeTruthy();
  });
});

describe("how often the kitchen reads the ask (T follow-up, item 1)", () => {
  const writing: CookAsk = { queueId: "dal", name: "Indian dal tadka", state: "writing" };
  const logged: CookAsk = { ...writing, state: "logged" };

  it("reads a row being written again in 2 s, and anything else once a minute", () => {
    expect(askPollInterval({ state: { data: writing, status: "success" } })).toBe(2000);
    expect(askPollInterval({ state: { data: logged, status: "success" } })).toBe(60_000);
    expect(askPollInterval({ state: { data: null, status: "success" } })).toBe(60_000);
    expect(askPollInterval({ state: { data: undefined, status: "pending" } })).toBe(60_000);
  });

  it("backs off to the minute when the read failed, though the last answer was writing", () => {
    expect(askPollInterval({ state: { data: writing, status: "error" } })).toBe(60_000);
  });

  it("on a real query: 2 s while writing, a minute after a failed read, 2 s once it reads again", async () => {
    vi.useFakeTimers();
    try {
      // The kitchen's client keeps React Query's defaults but for retries,
      // which only add backoff before the error lands.
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const answers: (() => CookAsk)[] = [
        () => writing,
        () => writing,
        () => {
          throw new Error("getCookAsk 500");
        },
        () => writing,
      ];
      let calls = 0;
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      renderHook(
        () =>
          useQuery({
            queryKey: ["ask"],
            queryFn: async () => answers[Math.min(calls++, answers.length - 1)]!(),
            refetchInterval: askPollInterval,
          }),
        { wrapper },
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(calls).toBe(1);
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(calls).toBe(2);
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(calls).toBe(3); // this read fails; the row it last read was writing
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(calls).toBe(3); // no 2 s hammering while the reads fail
      await act(() => vi.advanceTimersByTimeAsync(50_000));
      expect(calls).toBe(4); // a minute on, it reads again, and writing is back
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(calls).toBe(5);
      client.clear();
    } finally {
      vi.useRealTimers();
    }
  });
});
