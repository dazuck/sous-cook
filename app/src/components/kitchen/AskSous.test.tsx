// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowanceError } from "@/lib/kitchen/__tests__/allowance-error";
import { ASK_CUT_OFF_CODE } from "@/lib/kitchen/ask-failure";
import { recentEvents, resetEventLog } from "@/lib/kitchen/report-events";
import { ASK_COPY, AskSous, DEFAULT_DISH_QUESTION } from "./AskSous";

// Ask's part in a flag's lead-up (B2 decision 9): that a question went, and
// whether it was answered, never the words either way.

const speakMock = vi.fn();
vi.mock("@/lib/kitchen/speak", () => ({
  speak: (...args: unknown[]) => speakMock(...args),
}));

let reply: () => Promise<{ content: string; sources?: Array<{ title: string; url: string }> }>;
const mutation = {
  mutateAsync: vi.fn((_input: Record<string, unknown>) => reply()),
  isPending: false,
};

vi.mock("@/lib/trpc", () => ({
  trpc: { chatCooking: { useMutation: () => mutation } },
}));

const QUESTION = "What can I use instead of the shallots?";
const ANSWER = "A small red onion, sliced thin.";

beforeEach(() => {
  resetEventLog();
  mutation.mutateAsync.mockClear();
  speakMock.mockClear();
  reply = () => Promise.resolve({ content: ANSWER });
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

async function ask(question: string) {
  render(
    <AskSous recipeContext="Zucchini wraps" sessionId="cook-queue-1" isExpanded onToggle={() => {}} />,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: question } });
  await act(async () => {
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    await Promise.resolve();
  });
}

describe("AskSous's events (B2)", () => {
  it("logs a question sent and answered, without its words", async () => {
    await ask(QUESTION);
    expect(mutation.mutateAsync).toHaveBeenCalledOnce();
    const asks = recentEvents().filter((e) => e.kind === "ask");
    expect(asks.map((e) => e.detail)).toEqual(["sent", "answered"]);
    const logged = JSON.stringify(recentEvents());
    expect(logged).not.toContain("shallots");
    expect(logged).not.toContain("onion");
  });

  it("logs an answer that never came as an error", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    reply = () => Promise.reject(new Error("offline: shallots"));
    await ask(QUESTION);
    expect(recentEvents().map((e) => [e.kind, e.detail])).toEqual([
      ["ask", "sent"],
      ["ask", "error"],
    ]);
    said.mockRestore();
  });

  it("asks questions sent via the imperative handle", async () => {
    const ref = { current: null as import("./AskSous").AskSousHandle | null };
    render(
      <AskSous
        ref={ref}
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />,
    );
    await act(async () => {
      ref.current?.ask("Can I substitute butter?");
      await Promise.resolve();
    });
    expect(mutation.mutateAsync).toHaveBeenCalledOnce();
    expect(screen.getByText("Can I substitute butter?")).toBeTruthy();
  });

  it("submits dish photos and questions via askWithPhoto, rendering the photo preview", async () => {
    const ref = { current: null as import("./AskSous").AskSousHandle | null };
    render(
      <AskSous
        ref={ref}
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />,
    );
    const photoData = "data:image/jpeg;base64,mockdishbytes";
    await act(async () => {
      ref.current?.askWithPhoto(photoData, "How does this look and what should I do with it?");
      await Promise.resolve();
    });
    expect(mutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        currentRecipe: "Zucchini wraps",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "How does this look and what should I do with it?",
            image: { base64: photoData, mimeType: "image/jpeg" },
          }),
        ]),
      }),
    );
    const img = screen.getByRole("img", { name: "Dish photo" });
    expect(img.getAttribute("src")).toBe(photoData);
    expect(screen.getByText("How does this look and what should I do with it?")).toBeTruthy();
    expect(screen.getByText(ANSWER)).toBeTruthy();
  });

});

describe("AskSous two-stage tablet escalation", () => {
  it("opens in Stage 1 (at rest) with focus on Collapse, starter chips visible, and empty-thread text omitted", () => {
    const { container } = render(
      <AskSous recipeContext="Zucchini wraps" sessionId="cook-queue-1" isExpanded onToggle={() => {}} />,
    );

    const panel = container.querySelector('[data-ask="open"]') as HTMLElement;
    const input = screen.getByRole("textbox");

    // The kitchen home's tray, which has no voice (v1.60).
    expect(panel.getAttribute("data-ask-form")).toBe("tray");
    expect(panel.getAttribute("data-ask-mode")).toBe("rest");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Collapse/ }));
    expect(document.activeElement).not.toBe(input);

    const chips = screen.getByRole("group", { name: "Quick questions" });
    expect(chips.textContent).toBe("SubstituteIs it ready?Help");
    expect(screen.queryByText("Ask anything while you cook.")).toBeNull();
  });

  it("prefill() populates and focuses the input and escalates to typing mode", () => {
    const ref = { current: null as import("./AskSous").AskSousHandle | null };
    const { container, rerender } = render(
      <AskSous
        ref={ref}
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded={false}
        onToggle={() => {}}
      />,
    );

    act(() => {
      ref.current?.prefill("I was meant to marinate the chicken 4 hours ago.");
    });
    rerender(
      <AskSous
        ref={ref}
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />,
    );

    const panel = container.querySelector('[data-ask="open"]') as HTMLElement;
    const input = screen.getByRole("textbox") as HTMLInputElement;

    expect(input.value).toBe("I was meant to marinate the chicken 4 hours ago.");
    expect(document.activeElement).toBe(input);
    expect(panel.getAttribute("data-ask-mode")).toBe("typing");
    expect(screen.queryByRole("group", { name: "Quick questions" })).toBeNull();
  });

  it("askWithPhoto() sends the photo message without focusing the text input", async () => {
    const ref = { current: null as import("./AskSous").AskSousHandle | null };
    const { container } = render(
      <AskSous
        ref={ref}
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />,
    );

    const input = screen.getByRole("textbox");
    expect(document.activeElement).not.toBe(input);

    await act(async () => {
      ref.current?.askWithPhoto("data:image/jpeg;base64,mockdishbytes", "Is this browned enough?");
      await Promise.resolve();
    });

    const panel = container.querySelector('[data-ask="open"]') as HTMLElement;
    expect(document.activeElement).not.toBe(input);
    expect(panel.getAttribute("data-ask-mode")).toBe("rest");
    expect(screen.getByText("Is this browned enough?")).toBeTruthy();
  });

  it("escalates to typing mode on input focus (hiding starter chips) and restores rest mode on empty blur", () => {
    const { container } = render(
      <AskSous
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />,
    );

    const panel = container.querySelector('[data-ask="open"]') as HTMLElement;
    const input = screen.getByRole("textbox");

    expect(panel.getAttribute("data-ask-mode")).toBe("rest");
    expect(screen.getByRole("group", { name: "Quick questions" })).toBeTruthy();

    act(() => {
      input.focus();
      fireEvent.focus(input);
    });

    expect(panel.getAttribute("data-ask-mode")).toBe("typing");
    expect(screen.queryByRole("group", { name: "Quick questions" })).toBeNull();

    act(() => {
      input.blur();
      fireEvent.blur(input);
    });

    expect(panel.getAttribute("data-ask-mode")).toBe("rest");
    expect(screen.getByRole("group", { name: "Quick questions" })).toBeTruthy();
  });

  it("escalates to full visualViewport height when the tablet soft keyboard shrinks visualViewport", () => {
    const listeners = new Map<string, Set<EventListener>>();
    const mockVV = {
      height: 800,
      offsetTop: 0,
      addEventListener: vi.fn((type: string, cb: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: EventListener) => {
        listeners.get(type)?.delete(cb);
      }),
    };
    const origInnerHeight = window.innerHeight;
    const origVV = window.visualViewport;
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true, writable: true });
    Object.defineProperty(window, "visualViewport", {
      value: mockVV,
      configurable: true,
      writable: true,
    });

    try {
      const { container } = render(
        <AskSous
          recipeContext="Zucchini wraps"
          sessionId="cook-queue-1"
          isExpanded
          onToggle={() => {}}
        />,
      );

      const panel = container.querySelector('[data-ask="open"]') as HTMLElement;
      expect(panel.getAttribute("data-ask-mode")).toBe("rest");

      act(() => {
        mockVV.height = 400;
        mockVV.offsetTop = 0;
        for (const cb of listeners.get("resize") ?? []) {
          cb(new Event("resize"));
        }
      });

      expect(panel.getAttribute("data-ask-mode")).toBe("typing");
      expect(panel.style.height).toBe("400px");
      expect(panel.style.top).toBe("0px");
    } finally {
      Object.defineProperty(window, "innerHeight", {
        value: origInnerHeight,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, "visualViewport", {
        value: origVV,
        configurable: true,
        writable: true,
      });
    }
  });

  it("blurs the input and returns to rest mode when submitting a typed question", async () => {
    const { container } = render(
      <AskSous
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />,
    );

    const panel = container.querySelector('[data-ask="open"]') as HTMLElement;
    const input = screen.getByRole("textbox");

    act(() => {
      input.focus();
      fireEvent.focus(input);
    });
    expect(panel.getAttribute("data-ask-mode")).toBe("typing");

    fireEvent.change(input, { target: { value: QUESTION } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
      await Promise.resolve();
    });

    expect(document.activeElement).not.toBe(input);
    expect(panel.getAttribute("data-ask-mode")).toBe("rest");
    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(screen.getByText(ANSWER)).toBeTruthy();
  });

  it("shows 'Cooking for 6; the recipe serves 4.' and includes it in currentRecipe when scaled (B5c-9)", async () => {
    const { container, rerender } = render(
      <AskSous
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
        servings={4}
        servesBase={4}
      />,
    );
    expect(container.querySelector("[data-ask-scale-context]")).toBeNull();

    rerender(
      <AskSous
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
        servings={6}
        servesBase={4}
      />,
    );
    expect(container.querySelector("[data-ask-scale-context]")?.textContent).toBe(
      "Cooking for 6; the recipe serves 4.",
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: QUESTION } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
      await Promise.resolve();
    });
    expect(mutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        currentRecipe: expect.stringContaining("Cooking for 6; the recipe serves 4."),
      }),
    );
  });
});

describe("AskSous server context, error recovery, grounding sources, and spoken replies (B2a)", () => {
  it("forwards queueId, servings, servesBase, currentStepIndex, and timers in chatCooking mutation, a photo's turn included", async () => {
    const ref = { current: null as import("./AskSous").AskSousHandle | null };
    const timers = [
      { id: "t-1", label: "Simmer sauce", remainingSec: 180, status: "running" as const },
    ];
    render(
      <AskSous
        ref={ref}
        recipeContext="Crispy Pan Salmon"
        queueId="q-salmon-123"
        servings={4}
        servesBase={2}
        currentStepIndex={2}
        timers={timers}
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: QUESTION } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
      await Promise.resolve();
    });

    expect(mutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "cook-queue-1",
        queueId: "q-salmon-123",
        servings: 4,
        servesBase: 2,
        currentStepIndex: 2,
        timers,
        includeRecipeContext: true,
      }),
    );

    // A photo is checked against the recipe and the step, always: the
    // review page's "send without the recipe" went with the page (call 15).
    mutation.mutateAsync.mockClear();
    await act(async () => {
      ref.current?.askWithPhoto("data:image/jpeg;base64,mock", "How does this look?");
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        currentRecipe: "Crispy Pan Salmon\nCooking for 4; the recipe serves 2.",
        queueId: "q-salmon-123",
        currentStepIndex: 2,
        includeRecipeContext: true,
      }),
    );
  });

  it("from a prep page sends prep and its jobs and no step, typed, spoken and with a photo alike (review round 3)", async () => {
    const ref = { current: null as import("./AskSous").AskSousHandle | null };
    const prep = {
      jobs: [
        { text: "Mince the garlic", amounts: ["3 cloves garlic"], done: true },
        { text: "Chop the onion", amounts: ["1 onion"], done: false },
      ],
    };
    render(
      <AskSous
        ref={ref}
        recipeContext="Weeknight dal"
        queueId="q-dal"
        prep={prep}
        currentStepText="Mince the garlic, and chop the onion."
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />,
    );
    const sentLast = () => mutation.mutateAsync.mock.calls.at(-1)![0];

    // Typed.
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: QUESTION } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mutation.mutateAsync).toHaveBeenCalledTimes(1);
    expect(sentLast()).toMatchObject({ queueId: "q-dal", prep });
    expect(sentLast()).not.toHaveProperty("currentStepIndex");

    // Spoken: voice hands its words to the same `ask`.
    await act(async () => {
      ref.current!.ask("How fine should the garlic be?");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mutation.mutateAsync).toHaveBeenCalledTimes(2);
    expect(sentLast()).toMatchObject({ prep });
    expect(sentLast()).not.toHaveProperty("currentStepIndex");

    // With a photo.
    await act(async () => {
      ref.current!.askWithPhoto("data:image/jpeg;base64,mock", "How does this look?");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mutation.mutateAsync).toHaveBeenCalledTimes(3);
    expect(sentLast()).toMatchObject({ prep });
    expect(sentLast()).not.toHaveProperty("currentStepIndex");
    expect((sentLast().messages as Array<{ image?: unknown }>).at(-1)!.image).toBeDefined();
  });

  it("on a cooking step sends no prep", async () => {
    render(
      <AskSous
        recipeContext="Weeknight dal"
        queueId="q-dal"
        currentStepIndex={2}
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: QUESTION } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
      await Promise.resolve();
    });
    expect(mutation.mutateAsync.mock.calls[0]![0]).toMatchObject({ currentStepIndex: 2 });
    expect(mutation.mutateAsync.mock.calls[0]![0]).not.toHaveProperty("prep");
  });

  it("asks each turn about the step in hand when it is sent, not the step when it was queued (review round 1)", async () => {
    // Asked on step 2; the cook goes on to step 3 and takes a photo while
    // the first answer is on its way. The photo is checked against step 3.
    let release: (v: { content: string }) => void = () => {};
    reply = () => new Promise((resolve) => (release = resolve));
    const ref = { current: null as import("./AskSous").AskSousHandle | null };
    const ask = (step: number, text: string) => (
      <AskSous
        ref={ref}
        recipeContext="Crispy Pan Salmon"
        queueId="q-salmon-123"
        currentStepIndex={step}
        currentStepText={text}
        timers={step === 2 ? [] : [{ id: "t-1", label: "Sear", remainingSec: 90, status: "running" as const }]}
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />
    );
    const view = render(ask(2, "Pat the salmon dry."));
    await act(async () => {
      ref.current!.ask("Is it dry enough?");
      await Promise.resolve();
    });
    expect(mutation.mutateAsync.mock.calls[0]![0]).toMatchObject({ currentStepIndex: 2, timers: [] });
    view.rerender(ask(3, "Sear skin side down."));
    await act(async () => {
      ref.current!.askWithPhoto("data:image/jpeg;base64,mock", "How does this look?");
      await Promise.resolve();
    });
    expect(mutation.mutateAsync).toHaveBeenCalledOnce();
    reply = () => Promise.resolve({ content: ANSWER });
    await act(async () => {
      release({ content: "Yes." });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mutation.mutateAsync).toHaveBeenCalledTimes(2);
    expect(mutation.mutateAsync.mock.calls[1]![0]).toMatchObject({
      currentStepIndex: 3,
      timers: [{ id: "t-1", label: "Sear", remainingSec: 90, status: "running" }],
    });
  });

  it("keeps error message visible in UI thread on failure but excludes failed turns and error text from history sent on subsequent retry", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <AskSous
          recipeContext="Zucchini wraps"
          sessionId="cook-queue-1"
          isExpanded
          onToggle={() => {}}
        />,
      );

      reply = () => Promise.reject(new Error("network timeout"));
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "First question?" } });
      await act(async () => {
        fireEvent.submit(input.closest("form")!);
        await Promise.resolve();
      });

      expect(
        screen.getByText("Couldn't reach Sous. Check the connection and ask again."),
      ).toBeTruthy();

      // Now succeed on retry
      reply = () => Promise.resolve({ content: "Use red onion instead." });
      fireEvent.change(input, { target: { value: "Second question?" } });
      await act(async () => {
        fireEvent.submit(input.closest("form")!);
        await Promise.resolve();
      });

      expect(mutation.mutateAsync).toHaveBeenCalledTimes(2);
      const secondCallPayload = mutation.mutateAsync.mock.calls[1]![0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(secondCallPayload.messages.map((m) => [m.role, m.content])).toEqual([
        ["user", "Second question?"],
      ]);

      // Third question carries the succeeded second turn
      reply = () => Promise.resolve({ content: "Slice it paper-thin." });
      fireEvent.change(input, { target: { value: "How thin?" } });
      await act(async () => {
        fireEvent.submit(input.closest("form")!);
        await Promise.resolve();
      });

      const thirdCallPayload = mutation.mutateAsync.mock.calls[2]![0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(thirdCallPayload.messages.map((m) => [m.role, m.content])).toEqual([
        ["user", "Second question?"],
        ["assistant", "Use red onion instead."],
        ["user", "How thin?"],
      ]);
    } finally {
      said.mockRestore();
    }
  });

  it("renders grounding source chips beneath assistant messages with data-source-chip, target=_blank, and rel=noopener noreferrer", async () => {
    reply = () =>
      Promise.resolve({
        content: "Chicken breast is safe at 74°C (165°F) at the thickest part.",
        sources: [
          {
            title: "USDA Safe Minimum Internal Temperature Chart",
            url: "https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/food-safety-basics/safe-temperature-chart",
          },
          {
            title: "Serious Eats — Guide to Sous Vide Chicken",
            url: "https://www.seriouseats.com/the-food-lab-complete-guide-to-sous-vide-chicken-breast",
          },
        ],
      });

    await ask("What temperature is chicken safe at?");

    const link1 = screen.getByRole("link", {
      name: "USDA Safe Minimum Internal Temperature Chart",
    });
    const link2 = screen.getByRole("link", {
      name: "Serious Eats — Guide to Sous Vide Chicken",
    });

    expect(link1.hasAttribute("data-source-chip")).toBe(true);
    expect(link1.getAttribute("href")).toBe(
      "https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/food-safety-basics/safe-temperature-chart",
    );
    expect(link1.getAttribute("target")).toBe("_blank");
    expect(link1.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link2.hasAttribute("data-source-chip")).toBe(true);
    expect(link2.getAttribute("href")).toBe(
      "https://www.seriouseats.com/the-food-lab-complete-guide-to-sous-vide-chicken-breast",
    );
  });

  it("calls onSpeak (or speak fallback) for voice ask() including queued voice questions, while typed, quick-chip, and photo asks stay silent", async () => {
    const onSpeak = vi.fn();
    const ref = { current: null as import("./AskSous").AskSousHandle | null };
    const { rerender } = render(
      <AskSous
        ref={ref}
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
        onSpeak={onSpeak}
      />,
    );

    // 1. Voice ask while a typed ask is in flight: typed stays silent, queued voice speaks
    let resolveFirst!: (val: { content: string }) => void;
    reply = () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      });

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Typed question first?" } });
    act(() => {
      fireEvent.submit(input.closest("form")!);
    });

    // Queue a voice question while the first is in flight
    reply = () => Promise.resolve({ content: "Spoken answer for queued voice question." });
    act(() => {
      ref.current?.ask("Queued voice question?");
    });

    await act(async () => {
      resolveFirst({ content: "Silent answer for typed question." });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSpeak).toHaveBeenCalledTimes(1);
    expect(onSpeak).toHaveBeenCalledWith("Spoken answer for queued voice question.");

    // 2. Prefilled + submitted question stays silent
    onSpeak.mockClear();
    reply = () => Promise.resolve({ content: ANSWER });
    act(() => {
      ref.current?.prefill("I missed marinating the chicken.");
    });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
      await Promise.resolve();
    });
    expect(onSpeak).not.toHaveBeenCalled();

    // 3. Photo question stays silent
    await act(async () => {
      ref.current?.askWithPhoto("data:image/jpeg;base64,mock", "Does this look browned?");
      await Promise.resolve();
    });
    expect(onSpeak).not.toHaveBeenCalled();

    // 4. Without onSpeak prop, voice ask falls back to speak() from @/lib/kitchen/speak
    rerender(
      <AskSous
        ref={ref}
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
      />,
    );
    await act(async () => {
      ref.current?.ask("Direct voice question with fallback speak?");
      await Promise.resolve();
    });
    expect(speakMock).toHaveBeenCalledTimes(1);
    expect(speakMock).toHaveBeenCalledWith(ANSWER, expect.objectContaining({ onDone: expect.any(Function) }));
  });

});

describe("AskSous when the answer was cut at the token cap", () => {
  /** What the tRPC client rejects with: the server's error code under `data`. */
  function rejection(message: string, code: string) {
    return Object.assign(new Error(message), { data: { code } });
  }

  async function voiceAsk(onSpeak: () => void) {
    const ref = { current: null as import("./AskSous").AskSousHandle | null };
    render(
      <AskSous
        ref={ref}
        recipeContext="Noodle soup"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
        onSpeak={onSpeak}
      />,
    );
    await act(async () => {
      ref.current?.ask("Can the noodles go in now?");
      await Promise.resolve();
    });
  }

  it("says the answer ran long and was cut off, records why, and speaks nothing", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSpeak = vi.fn();
    reply = () =>
      Promise.reject(
        rejection("The model's reply was cut off at the token limit after 12 output tokens", ASK_CUT_OFF_CODE),
      );

    await voiceAsk(onSpeak);

    expect(screen.getByText(ASK_COPY.cutOff)).toBeTruthy();
    expect(screen.queryByText(ASK_COPY.error)).toBeNull();
    expect(recentEvents().map((e) => [e.kind, e.detail])).toEqual([
      ["ask", "sent"],
      ["ask", "error: cut at the token cap"],
    ]);
    expect(onSpeak).not.toHaveBeenCalled();
    expect(speakMock).not.toHaveBeenCalled();
    said.mockRestore();
  });

  it("keeps saying it couldn't reach Sous for any other failure", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    reply = () => Promise.reject(rejection("The model declined to answer (blocked)", "INTERNAL_SERVER_ERROR"));

    await voiceAsk(vi.fn());

    expect(screen.getByText(ASK_COPY.error)).toBeTruthy();
    expect(screen.queryByText(ASK_COPY.cutOff)).toBeNull();
    expect(recentEvents().map((e) => [e.kind, e.detail])).toEqual([
      ["ask", "sent"],
      ["ask", "error"],
    ]);
    said.mockRestore();
  });
});

// The cook screen's Ask (DS §5 Ask, v1.60; DECISIONS 2026-11-22 "Ask Sous is
// a side panel"): beside the step on the tablet in landscape, a full sheet
// elsewhere. Call numbers are that entry's.
describe("Ask on the cook screen: the side panel and the sheet", () => {
  type Props = Partial<Parameters<typeof AskSous>[0]>;
  const tapVoice = (
    status: NonNullable<Props["voice"]>["status"],
    echo: NonNullable<Props["voice"]>["echo"] = null,
    onTap = () => {},
  ) => ({ mode: "tap" as const, status, echo, onTap });

  function panel(over: Props = {}) {
    const ref = { current: null as import("./AskSous").AskSousHandle | null };
    const props = {
      recipeContext: "Zucchini wraps",
      sessionId: "cook-queue-1",
      isExpanded: true,
      onToggle: vi.fn(),
      form: "side" as const,
      ...over,
    };
    const view = render(<AskSous ref={ref} {...props} />);
    const root = () => view.container.querySelector('[data-ask="open"]') as HTMLElement;
    return { ...view, props, ref, root };
  }
  const tokens = (el: Element) => el.className.split(/\s+/);

  it("is a region beside the step in the side form, and a modal dialog as the sheet (calls 1, 2, 5)", () => {
    const side = panel({ form: "side" });
    expect(side.root().getAttribute("data-ask-form")).toBe("side");
    expect(side.root().getAttribute("role")).toBe("complementary");
    expect(side.root().hasAttribute("aria-modal")).toBe(false);
    expect(screen.getByRole("complementary", { name: ASK_COPY.title })).toBe(side.root());
    expect(tokens(side.root())).toEqual(
      expect.arrayContaining(["fixed", "inset-y-0", "right-0", "w-[calc(384*var(--cpx))]", "border-l", "bg-sand"]),
    );
    // The screen's whole height (call 2): nothing of its own sets where it ends.
    expect(side.root().style.bottom).toBe("");
    cleanup();

    const sheet = panel({ form: "sheet" });
    expect(sheet.root().getAttribute("data-ask-form")).toBe("sheet");
    expect(screen.getByRole("dialog", { name: ASK_COPY.title })).toBe(sheet.root());
    expect(sheet.root().getAttribute("aria-modal")).toBe("true");
    expect(tokens(sheet.root())).toEqual(expect.arrayContaining(["fixed", "inset-0", "bg-sand"]));
    expect(sheet.root().style.bottom).toBe("");
  });

  it("respects reduced motion, and nothing in it is ember", () => {
    const { root } = panel();
    expect(tokens(root())).toContain("motion-reduce:transition-none");
    for (const el of [root(), ...root().querySelectorAll("*")]) {
      expect(String(el.getAttribute("class") ?? "")).not.toContain("ember");
    }
  });

  it("closes by its X and by Escape, and by nothing else (call 7)", () => {
    const { props, root } = panel();
    fireEvent.click(screen.getByRole("button", { name: ASK_COPY.close }));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onToggle).toHaveBeenCalledTimes(2);
    // No tap-outside, and a tap inside is not a close.
    fireEvent.click(document.body);
    fireEvent.click(root());
    fireEvent.keyDown(window, { key: "Enter" });
    expect(props.onToggle).toHaveBeenCalledTimes(2);
  });

  it("leaves Escape to what is over the cook: a modal or menu, or an open popover", () => {
    const held = panel({ escapeLive: false });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(held.props.onToggle).not.toHaveBeenCalled();
    cleanup();

    const { props } = panel();
    const popover = document.createElement("div");
    popover.setAttribute("data-holds-keys", "");
    document.body.append(popover);
    try {
      fireEvent.keyDown(window, { key: "Escape" });
      expect(props.onToggle).not.toHaveBeenCalled();
    } finally {
      popover.remove();
    }
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it("does not answer Escape while closed, nor as the home's tray", () => {
    const closed = panel({ isExpanded: false });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed.props.onToggle).not.toHaveBeenCalled();
    cleanup();
    const tray = panel({ form: "tray" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(tray.props.onToggle).not.toHaveBeenCalled();
  });

  it("puts focus by the way in: the field to type, else the mic, else the close (call 8)", () => {
    panel({ enter: "field", voice: tapVoice("ready") });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: ASK_COPY.field }));
    cleanup();

    panel({ enter: "controls", voice: tapVoice("hearing") });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop listening" }));
    cleanup();

    panel({ enter: "controls", voice: tapVoice("unsupported") });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: ASK_COPY.close }));
    cleanup();

    panel({ enter: "controls" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: ASK_COPY.close }));
  });

  it("says which step it is about, in the step's own words, and nothing where there is no step (call 4)", () => {
    const side = panel({ currentStepText: "  Sear the chicken skin side down, 6 minutes. " });
    const about = side.container.querySelector("[data-ask-about]")!;
    expect(about.textContent).toBe("About this step: Sear the chicken skin side down, 6 minutes.");
    // Beside the step, which is whole on screen, one quiet line that ends in an ellipsis.
    expect(tokens(about)).toEqual(expect.arrayContaining(["truncate", "text-ink-soft"]));
    expect(tokens(about)).not.toContain("line-clamp-2");
    cleanup();

    // Over the step, up to three lines of it.
    const sheet = panel({ form: "sheet", currentStepText: "Sear the chicken." });
    expect(tokens(sheet.container.querySelector("[data-ask-about]")!)).toContain("line-clamp-3");
    cleanup();

    for (const currentStepText of [undefined, "", "   "]) {
      const none = panel({ currentStepText });
      expect(none.container.querySelector("[data-ask-about]")).toBeNull();
      cleanup();
    }
  });

  it("ends the conversation's scroll at a drawn edge: a hairline under what is pinned above it", () => {
    const tall = "Sear the chicken skin side down, 6 minutes.";
    for (const form of ["side", "sheet"] as const) {
      // The step's line and the scaled line are pinned together, the hairline under the last.
      const both = panel({ form, currentStepText: tall, servings: 8, servesBase: 4 });
      const pinned = both.container.querySelector("[data-ask-context]")!;
      expect(pinned.querySelector("[data-ask-about]")).not.toBeNull();
      expect(tokens(pinned)).toEqual(expect.arrayContaining(["shrink-0", "border-b", "border-ink/[.11]"]));
      // The conversation is the next thing down, and scrolls under that line only.
      expect(pinned.nextElementSibling).toBe(both.container.querySelector("[data-ask-thread]"));
      cleanup();
      // Nothing pinned, nothing drawn: the head's own hairline is the edge.
      const none = panel({ form });
      expect(none.container.querySelector("[data-ask-context]")).toBeNull();
      cleanup();
    }
  });

  it("keeps the newest turn's photo whole: the thread stops at that turn's top, not at its end", async () => {
    const { ref, container } = panel();
    const thread = container.querySelector<HTMLElement>("[data-ask-thread]")!;
    // A thread taller than its window: 900 of conversation in 400.
    Object.defineProperty(thread, "scrollHeight", { value: 900, configurable: true });
    Object.defineProperty(thread, "clientHeight", { value: 400, configurable: true });
    // jsdom's scrollTo moves nothing: here it lands where it was sent.
    thread.scrollTo = ((to: ScrollToOptions) => {
      thread.scrollTop = to.top ?? 0;
    }) as typeof thread.scrollTo;
    const tops = new Map<string, number>([["0", 0], ["1", 80], ["2", 320], ["3", 620]]);
    const top = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return tops.get(this.getAttribute("data-turn") ?? "") ?? 0;
    });
    try {
      // Words alone: the thread goes to its end.
      await act(async () => {
        ref.current!.ask(QUESTION);
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(container.querySelectorAll("[data-turn]")).toHaveLength(2);
      expect(thread.scrollTop).toBe(500);
      // A photo, then its answer: the photo's turn (the third) stays at the top.
      await act(async () => {
        ref.current!.askWithPhoto("data:image/jpeg;base64,mock", DEFAULT_DISH_QUESTION, { shown: ASK_COPY.photoShown });
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(container.querySelectorAll("[data-turn]")).toHaveLength(4);
      expect(thread.scrollTop).toBe(320);
      // The photo drawn late moves nothing it should not: the same place again.
      thread.scrollTop = 0;
      fireEvent.load(container.querySelector("[data-ask-photo]")!);
      expect(thread.scrollTop).toBe(320);
      // A turn that would end above the window's foot goes to the end as ever.
      tops.set("2", 700);
      fireEvent.load(container.querySelector("[data-ask-photo]")!);
      expect(thread.scrollTop).toBe(500);
    } finally {
      top.mockRestore();
    }
  });

  it("opens on its one line and the quick questions, and they give way to the conversation", async () => {
    const { container } = panel();
    expect(screen.getByText(ASK_COPY.empty)).toBeTruthy();
    expect(screen.getByRole("group", { name: ASK_COPY.quick }).textContent).toBe("SubstituteIs it ready?Help");
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: QUESTION } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
      await Promise.resolve();
    });
    expect(screen.queryByText(ASK_COPY.empty)).toBeNull();
    expect(screen.queryByRole("group", { name: ASK_COPY.quick })).toBeNull();
    expect([...container.querySelectorAll("[data-from]")].map((t) => t.getAttribute("data-from"))).toEqual([
      "cook",
      "sous",
    ]);
  });

  it("scrolls a long answer inside its own thread (call 17)", () => {
    const { container } = panel();
    const thread = container.querySelector("[data-ask-thread]")!;
    expect(tokens(thread)).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto", "overscroll-contain"]));
    expect(tokens(container.querySelector('[data-ask="open"]')!)).toContain("overflow-hidden");
  });

  it("has a field, the camera and the mic at rest; with words to send they give way to Send (call 18)", () => {
    const onPhoto = vi.fn();
    const onEngage = vi.fn();
    const { container } = panel({ voice: tapVoice("ready"), onPhoto, onEngage });
    const row = container.querySelector("[data-ask-input]")!;
    // The row is the foot's own band beside it (96 cpx: the 80 cpx targets, 6 over and 10 under),
    // so the field, the camera and the mic stand on Back and Forward's line.
    expect(tokens(row)).toEqual(expect.arrayContaining(["pt-[calc(6*var(--cpx))]", "pb-[calc(10*var(--cpx))]"]));
    const input = screen.getByRole("textbox", { name: ASK_COPY.field }) as HTMLInputElement;
    expect(input.placeholder).toBe(ASK_COPY.type);
    expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "Take a photo for Sous",
      "Talk to Sous",
    ]);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Take a photo for Sous" }));
    expect(onPhoto).toHaveBeenCalledOnce();
    expect(onEngage).toHaveBeenCalledOnce();

    fireEvent.change(input, { target: { value: "How hot" } });
    expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Send"]);
    // Spaces are not words to send.
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Talk to Sous" })).toBeTruthy();
  });

  it("keeps the mic beside Send while it listens or is refused, so a kept draft never strands a listen", () => {
    const onTap = vi.fn();
    const { container, rerender, props } = panel({ voice: tapVoice("ready", null, onTap) });
    const row = container.querySelector("[data-ask-input]")!;
    fireEvent.change(screen.getByRole("textbox", { name: ASK_COPY.field }), { target: { value: "How hot" } });
    expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Send"]);
    // Opened by the capsule's mic with that draft still in the field: the mic stays, to stop the listen.
    rerender(<AskSous {...props} voice={tapVoice("hearing", null, onTap)} />);
    expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "Send",
      "Stop listening",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(onTap).toHaveBeenCalledOnce();
    // A refused mic keeps its button too, to be tapped again.
    rerender(<AskSous {...props} voice={tapVoice("blocked", null, onTap)} />);
    expect(row.querySelector("[data-voice]")!.getAttribute("data-voice")).toBe("blocked");
  });

  it("a listen the cook stops from the panel's mic beside a draft leaves the cook in the box, not on the page", () => {
    const { rerender, props } = panel({ voice: tapVoice("ready") });
    const box = screen.getByRole("textbox", { name: ASK_COPY.field });
    fireEvent.change(box, { target: { value: "How hot" } });
    rerender(<AskSous {...props} voice={tapVoice("hearing")} />);
    const mic = screen.getByRole("button", { name: "Stop listening" });
    mic.focus();
    fireEvent.click(mic);
    // The listen is over: the mic gives its place back to Send, and the focus it held goes to the box.
    rerender(<AskSous {...props} voice={tapVoice("ready")} />);
    expect(screen.queryByRole("button", { name: "Stop listening" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: ASK_COPY.field }));
  });

  it.each([
    ["ends in silence", tapVoice("ready", { kind: "silence" })],
    ["hears a question", tapVoice("ready", { kind: "asked", text: "How hot" })],
    ["can no longer listen", tapVoice("unsupported")],
  ])("a listen that %s beside a draft, the mic not pressed, moves no focus into the box (review round 2: the capsule's listen closes by itself)", (_, after) => {
    const onEngage = vi.fn();
    const { rerender, props } = panel({ voice: tapVoice("ready"), onEngage });
    fireEvent.change(screen.getByRole("textbox", { name: ASK_COPY.field }), { target: { value: "How hot" } });
    onEngage.mockClear();
    rerender(<AskSous {...props} voice={tapVoice("hearing")} />);
    screen.getByRole("button", { name: "Stop listening" }).focus();
    rerender(<AskSous {...props} voice={after} />);
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: ASK_COPY.field }));
    expect(onEngage).not.toHaveBeenCalled();
  });

  it("a listen the cook started from the panel's mic, ending by itself beside a draft, moves no focus into the box: only the press that stops a listen does", () => {
    const { rerender, props } = panel({ voice: tapVoice("ready") });
    const talk = screen.getByRole("button", { name: "Talk to Sous" });
    talk.focus();
    // This press starts the listen. It is not a stop, though it is a press of the same button.
    fireEvent.click(talk);
    rerender(<AskSous {...props} voice={tapVoice("hearing")} />);
    fireEvent.change(screen.getByRole("textbox", { name: ASK_COPY.field }), { target: { value: "How hot" } });
    screen.getByRole("button", { name: "Stop listening" }).focus();
    rerender(<AskSous {...props} voice={tapVoice("ready", { kind: "silence" })} />);
    expect(screen.queryByRole("button", { name: "Stop listening" })).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: ASK_COPY.field }));
  });

  it("a stop pressed once is not remembered: the next listen, ending by itself beside the draft, moves no focus into the box", () => {
    const { rerender, props } = panel({ voice: tapVoice("ready") });
    const box = screen.getByRole("textbox", { name: ASK_COPY.field });
    fireEvent.change(box, { target: { value: "How hot" } });
    rerender(<AskSous {...props} voice={tapVoice("hearing")} />);
    const mic = screen.getByRole("button", { name: "Stop listening" });
    mic.focus();
    fireEvent.click(mic);
    rerender(<AskSous {...props} voice={tapVoice("ready")} />);
    expect(document.activeElement).toBe(box);
    // A second listen, the capsule's this time, ends in silence while its mic holds the focus.
    rerender(<AskSous {...props} voice={tapVoice("hearing")} />);
    screen.getByRole("button", { name: "Stop listening" }).focus();
    rerender(<AskSous {...props} voice={tapVoice("ready", { kind: "silence" })} />);
    expect(screen.queryByRole("button", { name: "Stop listening" })).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: ASK_COPY.field }));
  });

  it("a listen stopped from the panel's mic while Sous answers (the box shut) leaves focus on the close button, not the page", () => {
    mutation.isPending = true;
    try {
      const { rerender, props } = panel({ voice: tapVoice("ready") });
      fireEvent.change(screen.getByRole("textbox", { name: ASK_COPY.field }), { target: { value: "How hot" } });
      rerender(<AskSous {...props} voice={tapVoice("hearing")} />);
      const mic = screen.getByRole("button", { name: "Stop listening" });
      mic.focus();
      fireEvent.click(mic);
      rerender(<AskSous {...props} voice={tapVoice("ready")} />);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: ASK_COPY.close }));
    } finally {
      mutation.isPending = false;
    }
  });

  it("has no camera where there is none, and no mic where the browser cannot listen", () => {
    const { container } = panel({ voice: tapVoice("unsupported") });
    expect(container.querySelector("[data-ask-input]")!.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelector("[data-ask-camera]")).toBeNull();
  });

  it("makes the mic a control: it toggles the voice, fills while it listens, and waits while Sous speaks", () => {
    const onTap = vi.fn();
    const view = panel({ voice: tapVoice("hearing", null, onTap) });
    const mic = screen.getByRole("button", { name: "Stop listening" });
    expect(mic.getAttribute("data-voice")).toBe("hearing");
    expect(mic.querySelector("[data-voice-mic]")!.hasAttribute("data-live")).toBe(true);
    expect(view.container.querySelector("[data-voice-dot]")).toBeNull();
    fireEvent.click(mic);
    expect(onTap).toHaveBeenCalledOnce();
    cleanup();

    panel({ voice: tapVoice("paused") });
    expect(screen.getByRole("button", { name: "Talk to Sous" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("shows what it hears on a line of its own that can wrap, not in the field (call 18)", () => {
    const view = panel({ voice: tapVoice("hearing") });
    const heard = view.container.querySelector("[data-ask-heard]")!;
    expect(heard.textContent).toBe("Listening…");
    expect(heard.getAttribute("aria-hidden")).toBe("true");
    expect(tokens(heard)).toContain("[overflow-wrap:anywhere]");
    expect((screen.getByRole("textbox") as HTMLInputElement).placeholder).toBe(ASK_COPY.type);
    // While the line speaks the invitation steps aside, so the quick
    // questions and the line both fit beside the step; the questions stay.
    expect(screen.queryByText(ASK_COPY.empty)).toBeNull();
    expect(screen.getByRole("group", { name: ASK_COPY.quick })).toBeTruthy();
    cleanup();

    // A question handed over is in the thread, not echoed under it.
    const asked = panel({ voice: tapVoice("ready", { kind: "asked", text: "how hot" }) });
    expect(asked.container.querySelector("[data-ask-heard]")).toBeNull();
    cleanup();

    const rest = panel({ voice: tapVoice("ready") });
    expect(rest.container.querySelector("[data-ask-heard]")).toBeNull();
    expect(screen.getByText(ASK_COPY.empty)).toBeTruthy();
  });

  it("says a refused microphone and how to go on, keeps the mic, and does not move focus (call 14)", () => {
    const view = panel({ voice: tapVoice("ready") });
    const mic = screen.getByRole("button", { name: "Talk to Sous" });
    expect(document.activeElement).toBe(mic);
    view.rerender(<AskSous ref={view.ref} {...view.props} voice={tapVoice("blocked")} />);
    const line = view.container.querySelector("[data-ask-heard]")!;
    expect(line.textContent).toBe(ASK_COPY.micBlocked);
    // It is the one thing that tells the cook to type, so it is announced;
    // what the mic is hearing is said by the voice's own line (`VoiceSaid`).
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.hasAttribute("aria-hidden")).toBe(false);
    expect(view.root()).toBeTruthy();
    const still = view.container.querySelector("[data-ask-input] [data-voice]")!;
    expect(still.getAttribute("data-voice")).toBe("blocked");
    expect(document.activeElement).toBe(still);
    expect(view.props.onToggle).not.toHaveBeenCalled();
  });

  it("shows a photo as the cook's turn, labelled, while the question sent is the one it always was (call 15)", async () => {
    const { ref, container } = panel();
    const photo = "data:image/jpeg;base64,mockdishbytes";
    await act(async () => {
      ref.current!.askWithPhoto(photo, DEFAULT_DISH_QUESTION, { shown: ASK_COPY.photoShown });
      await Promise.resolve();
    });
    const turn = container.querySelector('[data-from="cook"]')!;
    expect(turn.querySelector("[data-ask-photo]")!.getAttribute("src")).toBe(photo);
    expect(turn.textContent).toBe(ASK_COPY.photoShown);
    expect(screen.queryByText(DEFAULT_DISH_QUESTION)).toBeNull();
    expect(mutation.mutateAsync).toHaveBeenCalledOnce();
    const sent = mutation.mutateAsync.mock.calls[0]![0] as { messages: Array<Record<string, unknown>> };
    expect(sent.messages).toEqual([
      { role: "user", content: DEFAULT_DISH_QUESTION, image: { base64: photo, mimeType: "image/jpeg" } },
    ]);
    expect(screen.getByText(ANSWER)).toBeTruthy();
  });

  it("takes a follow-up after a photo, with the photo's turn in what is sent and its label never sent", async () => {
    const { ref } = panel();
    const photo = "data:image/jpeg;base64,mockdishbytes";
    await act(async () => {
      ref.current!.askWithPhoto(photo, DEFAULT_DISH_QUESTION, { shown: ASK_COPY.photoShown });
      await Promise.resolve();
    });
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Longer, then?" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
      await Promise.resolve();
    });
    expect(mutation.mutateAsync).toHaveBeenCalledTimes(2);
    const sent = mutation.mutateAsync.mock.calls[1]![0] as { messages: Array<Record<string, unknown>> };
    expect(sent.messages).toEqual([
      { role: "user", content: DEFAULT_DISH_QUESTION, image: { base64: photo, mimeType: "image/jpeg" } },
      { role: "assistant", content: ANSWER },
      { role: "user", content: "Longer, then?" },
    ]);
    expect(JSON.stringify(sent)).not.toContain(ASK_COPY.photoShown);
  });

  it("holds a photo taken while an answer is on its way, and a second photo is its own turn", async () => {
    let release: (v: { content: string }) => void = () => {};
    reply = () => new Promise((resolve) => (release = resolve));
    const { ref, container } = panel();
    const one = "data:image/jpeg;base64,one";
    const two = "data:image/jpeg;base64,two";
    await act(async () => {
      ref.current!.ask("Is it done?");
      await Promise.resolve();
    });
    await act(async () => {
      ref.current!.askWithPhoto(one, DEFAULT_DISH_QUESTION, { shown: ASK_COPY.photoShown });
      ref.current!.askWithPhoto(two, DEFAULT_DISH_QUESTION, { shown: ASK_COPY.photoShown });
      await Promise.resolve();
    });
    expect(mutation.mutateAsync).toHaveBeenCalledOnce();
    reply = () => Promise.resolve({ content: ANSWER });
    await act(async () => {
      release({ content: "Nearly." });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mutation.mutateAsync).toHaveBeenCalledTimes(3);
    expect([...container.querySelectorAll("[data-ask-photo]")].map((i) => i.getAttribute("src"))).toEqual([one, two]);
  });

  it("says a photo could not be read, as a line of the app's that is never sent on (call 15)", async () => {
    const { ref, container } = panel();
    act(() => ref.current!.notice(ASK_COPY.photoUnread));
    expect(container.querySelector('[data-from="sous"]')!.textContent).toBe(ASK_COPY.photoUnread);
    expect(mutation.mutateAsync).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: QUESTION } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
      await Promise.resolve();
    });
    const sent = mutation.mutateAsync.mock.calls[0]![0] as { messages: unknown[] };
    expect(sent.messages).toEqual([{ role: "user", content: QUESTION }]);
  });

  it("tells the cook screen when a hand is put anywhere on it: the conversation, the head (call 13)", () => {
    for (const form of ["side", "sheet"] as const) {
      const onEngage = vi.fn();
      const { container } = panel({ form, onEngage, currentStepText: "Sear the chicken." });
      fireEvent.pointerDown(container.querySelector("[data-ask-thread]")!);
      expect(onEngage).toHaveBeenCalledTimes(1);
      fireEvent.pointerDown(container.querySelector("[data-ask-about]")!);
      fireEvent.pointerDown(screen.getByRole("heading", { name: ASK_COPY.title }));
      expect(onEngage).toHaveBeenCalledTimes(3);
      cleanup();
    }
  });

  it("puts focus into the sheet when the screen turns under it: what was focused beside the panel is now covered (review round 1)", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      // Beside the step focus may be on the cook's own controls.
      const view = panel({ form: "side", voice: tapVoice("ready"), enter: "controls" });
      act(() => outside.focus());
      expect(document.activeElement).toBe(outside);
      view.rerender(<AskSous ref={view.ref} {...view.props} voice={tapVoice("ready")} enter="controls" form="sheet" />);
      // Onto the mic, which keeps the keyboard down.
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Talk to Sous" }));
      // Turned back, focus stays where it is; and focus already in the panel is never moved.
      view.rerender(<AskSous ref={view.ref} {...view.props} voice={tapVoice("ready")} enter="controls" form="side" />);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Talk to Sous" }));
      const field = screen.getByRole("textbox", { name: ASK_COPY.field });
      act(() => field.focus());
      view.rerender(<AskSous ref={view.ref} {...view.props} voice={tapVoice("ready")} enter="controls" form="sheet" />);
      expect(document.activeElement).toBe(field);
    } finally {
      outside.remove();
    }
  });

  it("tells the cook screen when a hand is put to it: the field or a quick question", async () => {
    const onEngage = vi.fn();
    panel({ onEngage });
    const input = screen.getByRole("textbox");
    act(() => input.focus());
    expect(onEngage).toHaveBeenCalledTimes(1);
    act(() => input.blur());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Substitute" }));
      await Promise.resolve();
    });
    expect(onEngage).toHaveBeenCalledTimes(2);
  });

  it("draws a ringing timer at the sheet's top, and never in the side panel (call 6)", () => {
    const alarm = <button type="button">Stop the pasta timer</button>;
    const sheet = panel({ form: "sheet", alarm });
    const slot = sheet.container.querySelector("[data-ask-alarm]")!;
    expect(slot.textContent).toBe("Stop the pasta timer");
    // Under the head, over the conversation.
    expect(slot.previousElementSibling!.contains(screen.getByRole("button", { name: ASK_COPY.close }))).toBe(true);
    cleanup();
    const side = panel({ form: "side", alarm });
    expect(side.container.querySelector("[data-ask-alarm]")).toBeNull();
    cleanup();
    const quiet = panel({ form: "sheet" });
    expect(quiet.container.querySelector("[data-ask-alarm]")).toBeNull();
  });

  it("follows the tablet's keyboard, which shrinks the page (`interactiveWidget: resizes-content`): the step line and quick questions step aside (call 9)", () => {
    // Chrome on Android resizes the layout viewport: `innerHeight` and the
    // visual viewport shrink together, and nothing is offset.
    const vvListeners = new Set<EventListener>();
    const mockVV = {
      height: 800,
      offsetTop: 0,
      addEventListener: (_: string, cb: EventListener) => vvListeners.add(cb),
      removeEventListener: (_: string, cb: EventListener) => vvListeners.delete(cb),
    };
    const origInnerHeight = window.innerHeight;
    const origVV = window.visualViewport;
    const layout = (height: number) => {
      Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
      mockVV.height = height;
      for (const cb of vvListeners) cb(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    };
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true, writable: true });
    Object.defineProperty(window, "visualViewport", { value: mockVV, configurable: true, writable: true });
    try {
      for (const form of ["side", "sheet"] as const) {
        const { root, container } = panel({ form, currentStepText: "Sear the chicken." });
        expect(container.querySelector("[data-ask-about]")).not.toBeNull();
        expect(screen.getByRole("group", { name: ASK_COPY.quick })).toBeTruthy();
        act(() => layout(380));
        // The panel is the page's height, which is what the keyboard left.
        expect(root().getAttribute("data-ask-mode")).toBe("typing");
        expect(root().style.top).toBe("0px");
        expect(root().style.height).toBe("380px");
        expect(container.querySelector("[data-ask-about]")).toBeNull();
        expect(screen.queryByRole("group", { name: ASK_COPY.quick })).toBeNull();
        if (form === "side") expect(tokens(root())).toContain("w-[calc(384*var(--cpx))]");
        // The keyboard down again, they are back.
        act(() => layout(800));
        expect(root().style.height).toBe("");
        expect(container.querySelector("[data-ask-about]")).not.toBeNull();
        expect(screen.getByRole("group", { name: ASK_COPY.quick })).toBeTruthy();
        cleanup();
      }
    } finally {
      Object.defineProperty(window, "innerHeight", { value: origInnerHeight, configurable: true, writable: true });
      Object.defineProperty(window, "visualViewport", { value: origVV, configurable: true, writable: true });
    }
  });

  it("follows a keyboard that lies over the page (iOS): the box takes what the keyboard leaves (call 9)", () => {
    const listeners = new Map<string, Set<EventListener>>();
    const mockVV = {
      height: 800,
      offsetTop: 0,
      addEventListener: (type: string, cb: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(cb);
      },
      removeEventListener: (type: string, cb: EventListener) => {
        listeners.get(type)?.delete(cb);
      },
    };
    const origInnerHeight = window.innerHeight;
    const origVV = window.visualViewport;
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true, writable: true });
    Object.defineProperty(window, "visualViewport", { value: mockVV, configurable: true, writable: true });
    try {
      for (const form of ["side", "sheet"] as const) {
        const { root, container } = panel({ form, currentStepText: "Sear the chicken." });
        expect(container.querySelector("[data-ask-about]")).not.toBeNull();
        act(() => {
          mockVV.height = 380;
          mockVV.offsetTop = 12;
          for (const cb of listeners.get("resize") ?? []) cb(new Event("resize"));
        });
        expect(root().getAttribute("data-ask-mode")).toBe("typing");
        expect(root().style.top).toBe("12px");
        expect(root().style.height).toBe("380px");
        expect(root().style.bottom).toBe("auto");
        expect(container.querySelector("[data-ask-about]")).toBeNull();
        expect(screen.queryByRole("group", { name: ASK_COPY.quick })).toBeNull();
        // The side panel keeps its width beside the step.
        if (form === "side") expect(tokens(root())).toContain("w-[calc(384*var(--cpx))]");
        cleanup();
        mockVV.height = 800;
        mockVV.offsetTop = 0;
      }
    } finally {
      Object.defineProperty(window, "innerHeight", { value: origInnerHeight, configurable: true, writable: true });
      Object.defineProperty(window, "visualViewport", { value: origVV, configurable: true, writable: true });
    }
  });

  it("keeps every control a full target, with a ring where the keyboard is (DS §0.3)", () => {
    const { container } = panel({ voice: tapVoice("ready"), onPhoto: () => {} });
    const controls = [
      screen.getByRole("button", { name: ASK_COPY.close }),
      container.querySelector("[data-ask-camera]")!,
      screen.getByRole("button", { name: "Talk to Sous" }),
    ];
    for (const control of controls) {
      expect(tokens(control)).toEqual(
        expect.arrayContaining(["size-[var(--target)]", "focus-visible:outline-3", "focus-visible:outline-ink"]),
      );
    }
  });
});

// The cook page's half of CAPUI-4 (the plan's cap sentence) is in app/src/app/kitchen/queue/[id]/page.test.tsx.
describe("CAPUI-4: Ask at the monthly AI allowance cap", () => {
  it("shows the server allowance sentence, logs the error, and omits the refused turn from later history", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSpeak = vi.fn();
    const refusal = allowanceError("kitchen", new Date("2026-12-01T00:00:00.000Z"));
    try {
      render(
        <AskSous
          recipeContext="Zucchini wraps"
          sessionId="cook-queue-1"
          isExpanded
          onToggle={() => {}}
          onSpeak={onSpeak}
        />,
      );

      reply = () => Promise.reject(refusal);
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "Can I use lemon instead of lime?" } });
      await act(async () => {
        fireEvent.submit(input.closest("form")!);
        await Promise.resolve();
      });

      expect(screen.getByText(refusal.message)).toBeTruthy();
      expect(screen.queryByText(ASK_COPY.error)).toBeNull();
      expect(screen.queryByText(ASK_COPY.cutOff)).toBeNull();
      expect(recentEvents().map((e) => [e.kind, e.detail])).toEqual([
        ["ask", "sent"],
        ["ask", "error: allowance used"],
      ]);
      expect(onSpeak).not.toHaveBeenCalled();
      expect(speakMock).not.toHaveBeenCalled();

      // The next question must not send the refused question or the allowance sentence.
      reply = () => Promise.resolve({ content: ANSWER });
      fireEvent.change(input, { target: { value: QUESTION } });
      await act(async () => {
        fireEvent.submit(input.closest("form")!);
        await Promise.resolve();
      });

      expect(mutation.mutateAsync).toHaveBeenCalledTimes(2);
      const secondCallPayload = mutation.mutateAsync.mock.calls[1]![0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(secondCallPayload.messages.map((m) => [m.role, m.content])).toEqual([
        ["user", QUESTION],
      ]);
    } finally {
      said.mockRestore();
    }
  });

  it("keeps showing the connection error line for a non-cap error", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reply = () => Promise.reject(new Error("connection dropped"));
      await ask(QUESTION);
      expect(screen.getByText(ASK_COPY.error)).toBeTruthy();
      expect(screen.queryByText(ASK_COPY.cutOff)).toBeNull();
      expect(recentEvents().map((e) => [e.kind, e.detail])).toEqual([
        ["ask", "sent"],
        ["ask", "error"],
      ]);
    } finally {
      said.mockRestore();
    }
  });
});
