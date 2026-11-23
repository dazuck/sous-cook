// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recipe } from "@sous/pack";
import { ZUCCHINI_PLAN } from "@/lib/kitchen/__tests__/zucchini-wraps";
import { identityPlan } from "@/lib/kitchen/cook-plan";
import {
  cookView,
  initialCookState,
  sourceStepStates,
} from "@/lib/kitchen/cook-view";
import { CookFlow } from "./CookFlow";
import { ServingStepper, servingSteps, stepServings } from "./ServingStepper";
import { WholeRecipe } from "./WholeRecipe";

const fonts = Object.assign(new EventTarget(), {
  status: "loaded" as const,
  ready: Promise.resolve(),
});
Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function makePackRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "test-recipe",
    title: "Test Recipe",
    serves_base: 4,
    time_active_min: 15,
    time_total_min: 30,
    ingredients: [
      {
        id: "ing-0",
        name: "flour",
        qty_canonical: { volume_ml: 473.18 },
        display_equivalents: { imperial: { unit: "cup", amount: 2 } },
      },
    ],
    steps: [],
    tags: [],
    ...overrides,
  };
}

describe("ServingStepper", () => {
  it("steps whole numbers from 1 to 4 × serves_base and marks ends aria-disabled", () => {
    const onChange = vi.fn();
    const recipe = { serves_base: 4 };
    const { rerender } = render(
      <ServingStepper recipe={recipe} servings={1} onChange={onChange} />,
    );

    const dec = screen.getByRole("button", { name: "Decrease servings" });
    const inc = screen.getByRole("button", { name: "Increase servings" });
    expect(dec.getAttribute("aria-disabled")).toBe("true");
    expect(inc.getAttribute("aria-disabled")).toBeNull();
    expect(document.querySelector("[data-servings-text]")?.textContent).toBe(
      "serves 1",
    );

    fireEvent.click(dec);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(inc);
    expect(onChange).toHaveBeenLastCalledWith(2);

    rerender(
      <ServingStepper recipe={recipe} servings={16} onChange={onChange} />,
    );
    expect(dec.getAttribute("aria-disabled")).toBeNull();
    expect(inc.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector("[data-servings-text]")?.textContent).toBe(
      "serves 16",
    );

    onChange.mockClear();
    fireEvent.click(inc);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(dec);
    expect(onChange).toHaveBeenLastCalledWith(15);
  });

  it("includes a non-whole serves_base (2.5) in order between 2 and 3 with cap 10 (B5c-11)", () => {
    expect(servingSteps(2.5)).toEqual([1, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(stepServings(2.5, 2.5, -1)).toBe(2);
    expect(stepServings(2.5, 2.5, 1)).toBe(3);
    expect(stepServings(2.5, 2, 1)).toBe(2.5);
    expect(stepServings(2.5, 3, -1)).toBe(2.5);

    const onChange = vi.fn();
    const recipe = { serves_base: 2.5 };
    const { rerender } = render(
      <ServingStepper recipe={recipe} servings={2.5} onChange={onChange} />,
    );
    expect(document.querySelector("[data-servings-text]")?.textContent).toBe(
      "serves 2.5",
    );

    fireEvent.click(screen.getByRole("button", { name: "Decrease servings" }));
    expect(onChange).toHaveBeenLastCalledWith(2);

    rerender(
      <ServingStepper recipe={recipe} servings={2} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    expect(onChange).toHaveBeenLastCalledWith(2.5);

    rerender(
      <ServingStepper recipe={recipe} servings={2.5} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    expect(onChange).toHaveBeenLastCalledWith(3);

    rerender(
      <ServingStepper recipe={recipe} servings={3} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Decrease servings" }));
    expect(onChange).toHaveBeenLastCalledWith(2.5);

    rerender(
      <ServingStepper recipe={recipe} servings={10} onChange={onChange} />,
    );
    expect(
      screen
        .getByRole("button", { name: "Increase servings" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("renders the locked form when scales={false} with 'serves 4' and no − or + buttons", () => {
    render(
      <ServingStepper
        recipe={{ serves_base: 4 }}
        servings={4}
        scales={false}
        onChange={vi.fn()}
      />,
    );
    const stepper = document.querySelector("[data-serving-stepper]");
    expect(stepper?.textContent).toBe("serves 4");
    expect(screen.queryByRole("button", { name: "Decrease servings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Increase servings" })).toBeNull();
  });

  it("shows '(Sous's estimate)' on an estimated count at base and when scaled (B5c-3, B4b)", () => {
    const recipe = { serves_base: 8, serves_estimated: true as const };
    const { rerender } = render(
      <ServingStepper recipe={recipe} servings={8} onChange={vi.fn()} />,
    );
    expect(document.querySelector("[data-servings-text]")?.textContent).toBe(
      "serves 8 (Sous's estimate)",
    );

    rerender(
      <ServingStepper recipe={recipe} servings={9} onChange={vi.fn()} />,
    );
    expect(document.querySelector("[data-servings-text]")?.textContent).toBe(
      "serves 9 (Sous's estimate)",
    );
  });

  it("asserts the locked form (scales={false}) at each mount: PrepScreen, WholeRecipe, and CookFlow's no-steps list", () => {
    const recipe = makePackRecipe({ serves_base: 4 });
    const lines = [
      {
        kind: "amount" as const,
        amount: "2 cups",
        name: "flour",
        stated: [{ unit: "cup" as const, value: "2" }],
        conversions: [],
      },
    ];

    // 1. PrepScreen mount (via CookFlow on Prep)
    const prepState = initialCookState("first");
    const prepView = cookView(
      ZUCCHINI_PLAN,
      { kind: "derived" },
      prepState,
    );
    const { unmount: unmountPrep } = render(
      <CookFlow
        view={prepView}
        mode="first"
        times={["30 min"]}
        ingredients={lines}
        recipe={recipe}
        servings={4}
        scales={false}
        onServingsChange={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onMode={vi.fn()}
        onTick={vi.fn()}
        onFinish={vi.fn()}
        onAskAhead={vi.fn()}
        finish="ready"
        navEnabled
        ask={{ label: "Ask Sous", onOpen: vi.fn() }}
      />,
    );
    expect(
      document.querySelector("[data-prep-servings] [data-servings-text]")?.textContent,
    ).toBe("serves 4");
    expect(screen.queryByRole("button", { name: "Decrease servings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Increase servings" })).toBeNull();
    unmountPrep();

    // 2. WholeRecipe mount
    const st = sourceStepStates(ZUCCHINI_PLAN, prepState);
    const { unmount: unmountWhole } = render(
      <WholeRecipe
        steps={["Mix the flour."]}
        plan={ZUCCHINI_PLAN}
        state={prepState}
        chapters={null}
        current={st.current}
        done={st.done}
        prepLine={null}
        ingredients={lines}
        recipe={recipe}
        servings={4}
        scales={false}
        onServingsChange={vi.fn()}
        usedIngredientIndices={new Set()}
        ingredientOverrides={new Map()}
        onToggleIngredient={vi.fn()}
        read={null}
        onRead={vi.fn()}
        screenFor={() => 0}
        onGo={vi.fn()}
        asWritten={true}
      />,
    );
    expect(
      document.querySelector('[data-section="ingredients"] [data-servings-text]')?.textContent,
    ).toBe("serves 4");
    expect(screen.queryByRole("button", { name: "Decrease servings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Increase servings" })).toBeNull();
    unmountWhole();

    // 3. CookFlow's no-steps list mount
    const noStepsPlan = identityPlan({
      ingredients: [{ amount: "2", unit: "cups", item: "flour" }],
      steps: [],
    });
    const noStepsView = cookView(
      noStepsPlan,
      { kind: "as-written", reason: "failed" },
      initialCookState("first"),
    );
    render(
      <CookFlow
        view={noStepsView}
        mode="first"
        ingredients={lines}
        recipe={recipe}
        servings={4}
        scales={false}
        onServingsChange={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onMode={vi.fn()}
        onTick={vi.fn()}
        onFinish={vi.fn()}
        onAskAhead={vi.fn()}
        finish="ready"
        navEnabled
        ask={{ label: "Ask Sous", onOpen: vi.fn() }}
      />,
    );
    expect(
      document.querySelector("[data-no-steps] [data-servings-text]")?.textContent,
    ).toBe("serves 4");
    expect(screen.queryByRole("button", { name: "Decrease servings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Increase servings" })).toBeNull();
  });
});

