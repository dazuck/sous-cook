// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASK_CUT_OFF_CODE } from "@/lib/kitchen/ask-failure";
import { recentEvents, resetEventLog } from "@/lib/kitchen/report-events";
import { ASK_COPY, AskSous } from "./AskSous";

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
      ref.current?.askWithPhoto(photoData, "How does this look and what should I do with it?", {
        includeRecipeContext: true,
      });
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

  it("submits dish photos without recipe context when includeRecipeContext is false", async () => {
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
      ref.current?.askWithPhoto(photoData, "How does this look?", {
        includeRecipeContext: false,
      });
      await Promise.resolve();
    });
    expect(mutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        currentRecipe: undefined,
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: "How does this look?",
            image: { base64: photoData, mimeType: "image/jpeg" },
          }),
        ]),
      }),
    );
  });
});

describe("AskSous two-stage tablet escalation", () => {
  it("opens in Stage 1 (at rest) with focus on the voice dot, starter chips visible, and empty-thread text omitted", () => {
    const { container } = render(
      <AskSous
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
        voice={{ mode: "always", status: "listening", echo: null, onTap: () => {} }}
      />,
    );

    const panel = container.querySelector('[data-ask="open"]') as HTMLElement;
    const input = screen.getByRole("textbox");
    const voiceDot = screen.getByRole("button", { name: "Turn voice off" });

    expect(panel.getAttribute("data-ask-mode")).toBe("rest");
    expect(document.activeElement).toBe(voiceDot);
    expect(document.activeElement).not.toBe(input);

    const chips = screen.getByRole("group", { name: "Quick questions" });
    expect(chips.textContent).toBe("SubstituteIs it ready?Help");
    expect(screen.queryByText("Ask anything while you cook.")).toBeNull();
  });

  it("focuses the Collapse button on open when speech is unsupported", () => {
    render(
      <AskSous
        recipeContext="Zucchini wraps"
        sessionId="cook-queue-1"
        isExpanded
        onToggle={() => {}}
        voice={{ mode: "always", status: "unsupported", echo: null, onTap: () => {} }}
      />,
    );

    const input = screen.getByRole("textbox");
    const collapseBtn = screen.getByRole("button", { name: /Collapse/ });

    expect(document.activeElement).toBe(collapseBtn);
    expect(document.activeElement).not.toBe(input);
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
        voice={{ mode: "always", status: "listening", echo: null, onTap: () => {} }}
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
  it("forwards queueId, servings, servesBase, currentStepIndex, and timers in chatCooking mutation, and omits queueId when includeRecipeContext is false", async () => {
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

    mutation.mutateAsync.mockClear();
    await act(async () => {
      ref.current?.askWithPhoto("data:image/jpeg;base64,mock", "How does this look?", {
        includeRecipeContext: false,
      });
      await Promise.resolve();
    });

    expect(mutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        currentRecipe: undefined,
        includeRecipeContext: false,
      }),
    );
    expect(mutation.mutateAsync.mock.calls[0]![0]).not.toHaveProperty("queueId");
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

describe("AskSous when the answer was cut at the token cap (feedback review 2026-10-27)", () => {
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
