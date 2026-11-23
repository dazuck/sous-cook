// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identityPlan, type CookPlan } from "@/lib/kitchen/cook-plan";
import { COOK_COPY, cookView, initialCookState, next, type CookState, type CookView } from "@/lib/kitchen/cook-view";
import { storedIngredientLines } from "@/lib/kitchen/ingredient-display";
import { screenStep } from "@/lib/kitchen/step-types";
import { fannieNative } from "@/lib/pack-convert/__tests__/fannie-native";
import { CookFlow, type AnswerShown, type CookTimers, type StepTypeProps } from "./CookFlow";

// A pack recipe's typed steps and "how much" on the cook screen (slice B5d,
// B5.md §B5d D8–D10, D13), over the Fannie Farmer recipes read natively.

const fonts = Object.assign(new EventTarget(), { status: "loaded" as const, ready: Promise.resolve() });
Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** The as-written cook of a Fannie recipe, at the screen of its step `step`. */
function at(recipeId: string, step: number) {
  const r = fannieNative(recipeId);
  const plan: CookPlan = identityPlan(r.recipeData);
  let state: CookState = initialCookState("first");
  let view: CookView = cookView(plan, { kind: "as-written", reason: "failed" }, state);
  const task = plan.tasks.find((t) => t.sourceStep === step)!;
  for (let i = 0; i < 40 && view.stack[0]?.key !== task.id; i++) {
    state = next(plan, state);
    view = cookView(plan, { kind: "as-written", reason: "failed" }, state);
  }
  if (view.stack[0]?.key !== task.id) throw new Error(`no screen for step ${String(step)}`);
  const lines = storedIngredientLines(r.packRecipe, r.recipeData.ingredients!.length);
  const step0 = screenStep(plan, r.packRecipe, r.library, [task], r.recipeData.source!);
  return { view, lines, step: step0 };
}

function draw(
  view: CookView,
  lines: ReturnType<typeof storedIngredientLines>,
  stepType: StepTypeProps,
  answer: AnswerShown | null = null,
  timers?: CookTimers,
) {
  const onNext = vi.fn();
  const utils = render(
    <CookFlow
      view={view}
      mode="first"
      ingredients={lines}
      onNext={onNext}
      onBack={vi.fn()}
      onMode={vi.fn()}
      onTick={vi.fn()}
      onFinish={vi.fn()}
      onAskAhead={vi.fn()}
      finish="ready"
      navEnabled
      ask={{ label: "Ask Sous", onOpen: vi.fn() }}
      stepType={stepType}
      answer={answer}
      timers={timers}
    />,
  );
  return { onNext, ...utils };
}

describe("a checkpoint (D8)", () => {
  it("is the step's words in ember; forward is named and captioned “Looks right” and moves on", () => {
    const { view, lines, step } = at("boiled-custard", 5);
    const { onNext } = draw(view, lines, { step });
    const words = document.querySelector("[data-face]")!;
    expect(words.hasAttribute("data-ember")).toBe(true);
    const forward = screen.getByRole("button", { name: COOK_COPY.looksRight });
    expect(forward.hasAttribute("data-caption")).toBe(true);
    expect(forward.textContent).toContain(COOK_COPY.looksRight);
    expect(forward.className).not.toMatch(/bg-ember/);
    fireEvent.click(forward);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("“Not yet” shows how to check in the step's place, and “Back to the check” puts it away", () => {
    const { view, lines, step } = at("boiled-custard", 5);
    const onNotYet = vi.fn();
    const { rerender } = draw(view, lines, { step, onNotYet });
    const notYet = screen.getByRole("button", { name: COOK_COPY.notYet });
    expect(notYet.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(notYet);
    expect(onNotYet).toHaveBeenCalled();
    rerender(
      <CookFlow
        view={view}
        mode="first"
        ingredients={lines}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onMode={vi.fn()}
        onTick={vi.fn()}
        onFinish={vi.fn()}
        onAskAhead={vi.fn()}
        finish="ready"
        navEnabled
        ask={{ label: "Ask Sous", onOpen: vi.fn() }}
        stepType={{ step, howToCheck: true, onNotYet }}
      />,
    );
    const shown = document.querySelector("[data-how-to-check]")!;
    expect(shown.textContent).toMatch(/^Custard coats the spoon. An even opaque film/);
    expect(screen.getByRole("button", { name: COOK_COPY.backToCheck }).getAttribute("aria-expanded")).toBe("true");
  });

  it("has no “Not yet” with nothing to show", () => {
    const { view, lines } = at("boiled-custard", 5);
    draw(view, lines, { step: { kind: "checkpoint", evidence: [], hints: [] } });
    expect(screen.queryByRole("button", { name: COOK_COPY.notYet })).toBeNull();
    expect(screen.getByRole("button", { name: COOK_COPY.looksRight })).toBeTruthy();
  });

  it("says “Checked” in herb on a return, as a status and never a button", () => {
    const { view, lines, step } = at("boiled-custard", 5);
    draw(view, lines, { step, checked: true });
    const checked = document.querySelector("[data-checked]")!;
    expect(checked.textContent).toBe(COOK_COPY.checked);
    expect(checked.closest("button")).toBeNull();
    expect(screen.queryByRole("button", { name: COOK_COPY.checked })).toBeNull();
    // One state on a return (critic round 2): no question asked again, a plain forward.
    expect(screen.queryByRole("button", { name: COOK_COPY.notYet })).toBeNull();
    expect(screen.queryByRole("button", { name: COOK_COPY.looksRight })).toBeNull();
    expect(screen.getByRole("button", { name: COOK_COPY.forward })).toBeTruthy();
  });

  it("a confirmed check's return never shows how to check, even if it was left open (UI verify round 3)", () => {
    const { view, lines, step } = at("boiled-custard", 5);
    draw(view, lines, { step, checked: true, howToCheck: true });
    expect(document.querySelector("[data-how-to-check]")).toBeNull();
    expect(document.querySelector("[data-checked]")!.textContent).toBe(COOK_COPY.checked);
  });

  it("how to check is set in ink, never ember", () => {
    const { view, lines, step } = at("boiled-custard", 5);
    draw(view, lines, { step, howToCheck: true });
    const words = document.querySelector("[data-how-to-check]")!;
    expect(words.hasAttribute("data-ember")).toBe(false);
    expect(words.className).not.toMatch(/ember/);
  });

  it("on the last screen, Finish is the act: no “Looks right”", () => {
    const { view, lines, step } = at("parker-house-rolls", 18);
    expect(view.isLast).toBe(true);
    draw(view, lines, { step });
    expect(screen.queryByRole("button", { name: COOK_COPY.looksRight })).toBeNull();
    expect(screen.getByRole("button", { name: COOK_COPY.finish })).toBeTruthy();
  });
});

describe("an interlude (D9)", () => {
  it("is an aside: its title, its words in ink one size down, never ember", () => {
    const { view, lines, step } = at("doughnuts-i", 10);
    draw(view, lines, { step });
    expect(document.querySelector("[data-interlude=title]")!.textContent).toBe(`${COOK_COPY.aside}: About the fat`);
    const words = document.querySelector("[data-face]")!;
    expect(words.hasAttribute("data-ember")).toBe(false);
    expect(words.className).toMatch(/0\.6875em/);
    expect(words.className).not.toMatch(/ember/);
    expect(screen.getByRole("button", { name: COOK_COPY.forward })).toBeTruthy();
  });

  it("collapsed, shows its title and opens again on a tap", () => {
    const { view, lines, step } = at("doughnuts-i", 10);
    const onOpen = vi.fn();
    draw(view, lines, { step, collapsed: true, onOpen });
    expect(document.querySelector("[data-interlude=collapsed] [data-face]")!.textContent).toBe(`${COOK_COPY.aside}: About the fat`);
    fireEvent.click(screen.getByRole("button", { name: COOK_COPY.readAgain }));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe("a wait (D10)", () => {
  it("reads as an action", () => {
    const { view, lines, step } = at("parker-house-rolls", 6);
    expect(step).toEqual({ kind: "wait" });
    draw(view, lines, { step });
    expect(document.querySelector("[data-face]")!.hasAttribute("data-ember")).toBe(true);
    expect(screen.getByRole("button", { name: COOK_COPY.forward })).toBeTruthy();
  });
});

describe("how much (D13)", () => {
  it("on its pair while drawn: the pair is discussed, holding the ember; the step goes ink", () => {
    const { view, lines, step } = at("thin-white-sauce", 4);
    const milk = view.stack[0]!.ingredientIdx.find((i) => lines[i]?.name === "Milk")!;
    draw(view, lines, step.kind === "action" ? { step } : { step }, { key: 1, indices: [milk], shown: "1 cup milk" });
    const pair = document.querySelector("[data-discussed]")!;
    expect(pair.textContent).toContain("1 cup");
    expect(document.querySelector("[data-face]")!.hasAttribute("data-ember")).toBe(false);
    expect(document.querySelector("[data-answer]")).toBeNull();
  });

  it("off the screen: on the foot's lift, the step keeping its ember", () => {
    const { view, lines, step } = at("thin-white-sauce", 0);
    draw(view, lines, { step }, { key: 1, indices: [4], shown: "Pepper: the recipe doesn't say" });
    expect(document.querySelector("[data-answer]")!.textContent).toBe("Pepper: the recipe doesn't say");
    expect(document.querySelector("[data-discussed]")).toBeNull();
    expect(document.querySelector("[data-face]")!.hasAttribute("data-ember")).toBe(true);
  });

  it("which: each line a target, which answers", () => {
    const { view, lines, step } = at("parker-house-rolls", 0);
    const onChoose = vi.fn();
    draw(view, lines, { step }, {
      key: 2,
      indices: [],
      shown: "Which butter?",
      choices: [
        { index: 1, name: "Butter" },
        { index: 9, name: "Melted butter" },
      ],
      onChoose,
    });
    act(() => fireEvent.click(screen.getByRole("button", { name: "Melted butter" })));
    expect(onChoose).toHaveBeenCalledWith(9);
  });
});

/** The kitchen's timers with the step offering a timer, and `expired` ringing. */
function timersWith(expired: CookTimers["expired"] = []): CookTimers {
  return {
    offer: { id: "q:step-5", queueId: "q", recipeName: "Boiled Custard", stepId: "step-5", label: "Test", durationMs: 60_000, durationSec: 60 },
    stepTimer: null,
    ledge: [],
    expired,
    soonestRunning: null,
    soundLocked: false,
    onStart: vi.fn(),
    onDismiss: vi.fn(),
    onAllowSound: vi.fn(),
  };
}

describe("with the kitchen's timers (D8, D13)", () => {
  it("a checkpoint with a timer: the offer, then Not yet, in its time line", () => {
    const { view, lines, step } = at("boiled-custard", 5);
    draw(view, lines, { step }, null, timersWith());
    const time = document.querySelector("[data-time]")!;
    const buttons = [...time.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons[0]).toMatch(/1 min timer/);
    expect(buttons.at(-1)).toBe(COOK_COPY.notYet);
  });

  it("an answer asked while a timer rings goes on the lift: the meta steps aside, so no pair is drawn", () => {
    const { view, lines, step } = at("thin-white-sauce", 4);
    const milk = view.stack[0]!.ingredientIdx.find((i) => lines[i]?.name === "Milk")!;
    const ringing = [{ id: "t", queueId: null, recipeName: null, stepId: null, label: "Timer", durationMs: 1000, endsAtEpochMs: 0 }];
    draw(view, lines, { step }, { key: 1, indices: [milk], shown: "1 cup milk" }, timersWith(ringing));
    expect(document.querySelector("[data-discussed]")).toBeNull();
    expect(document.querySelector("[data-answer]")!.textContent).toBe("1 cup milk");
  });

  it("says the answer in a live region that is always there", () => {
    const { view, lines, step } = at("thin-white-sauce", 0);
    const { rerender } = draw(view, lines, { step });
    const said = document.querySelector("[data-answer-said]")!;
    expect(said.getAttribute("role")).toBe("status");
    expect(said.textContent).toBe("");
    rerender(
      <CookFlow
        view={view}
        mode="first"
        ingredients={lines}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onMode={vi.fn()}
        onTick={vi.fn()}
        onFinish={vi.fn()}
        onAskAhead={vi.fn()}
        finish="ready"
        navEnabled
        ask={{ label: "Ask Sous", onOpen: vi.fn() }}
        stepType={{ step }}
        answer={{ key: 1, indices: [4], shown: "Pepper: the recipe doesn't say" }}
      />,
    );
    expect(document.querySelector("[data-answer-said]")).toBe(said);
    expect(said.textContent).toBe("Pepper: the recipe doesn't say");
  });
});
