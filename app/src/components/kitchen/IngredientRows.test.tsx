// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredIngredientLines } from "@/lib/kitchen/ingredient-display";
import { IngredientRows } from "./IngredientRows";
import { AMOUNT_RULE } from "./MeasurementPopover";

afterEach(cleanup);

const SAMPLE_INGREDIENTS: StoredIngredientLines = [
  {
    kind: "amount",
    amount: "2 lb",
    stated: [{ unit: "lb", value: "2" }],
    conversions: [],
    name: "center-cut salmon fillets",
  },
  {
    kind: "amount",
    amount: "1 tbsp",
    stated: [{ unit: "tbsp", value: "1" }],
    conversions: [
      { unit: "ml", value: "14.8" },
      { unit: "tsp", value: "3" },
      { unit: "cup", value: "0.06" },
    ],
    name: "olive oil",
  },
  {
    kind: "count",
    amount: "2",
    name: "cloves garlic, minced",
  },
  {
    kind: "count",
    amount: "1",
    name: "lemon",
  },
  {
    kind: "to_taste",
    name: "salt and pepper",
  },
  {
    kind: "amount",
    amount: "1 tbsp",
    stated: [{ unit: "tbsp", value: "1" }],
    conversions: [],
    name: "chopped parsley",
  },
];

describe("IngredientRows", () => {
  it("renders each ingredient with its amount, none checked at the start", () => {
    render(<IngredientRows ingredients={SAMPLE_INGREDIENTS} />);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(6);
    checkboxes.forEach((cb) => expect(cb.getAttribute("aria-checked")).toBe("false"));

    expect(screen.getByText("center-cut salmon fillets")).toBeTruthy();
    expect(screen.getByText("olive oil")).toBeTruthy();
    expect(screen.getByText("cloves garlic, minced")).toBeTruthy();
    expect(screen.getByText("lemon")).toBeTruthy();
    expect(screen.getByText("salt and pepper")).toBeTruthy();
    expect(screen.getByText("chopped parsley")).toBeTruthy();

    expect(screen.getByText("—")).toBeTruthy(); // to_taste
  });

  it("checks items in usedIngredientIndices by default", () => {
    render(
      <IngredientRows
        ingredients={SAMPLE_INGREDIENTS}
        usedIngredientIndices={new Set([0, 4])}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("true");
    expect(checkboxes[1].getAttribute("aria-checked")).toBe("false");
    expect(checkboxes[2].getAttribute("aria-checked")).toBe("false");
    expect(checkboxes[3].getAttribute("aria-checked")).toBe("false");
    expect(checkboxes[4].getAttribute("aria-checked")).toBe("true");
    expect(checkboxes[5].getAttribute("aria-checked")).toBe("false");

    // Line 0 name has strike-through
    expect(screen.getByText("center-cut salmon fillets").className).toContain("line-through");
    expect(screen.getByText("olive oil").className).not.toContain("line-through");
  });

  it("a tap on the box overrides either way and outlasts rerenders", () => {
    const { rerender } = render(
      <IngredientRows
        ingredients={SAMPLE_INGREDIENTS}
        usedIngredientIndices={new Set([0])}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    // Initially: 0 checked, 3 unchecked
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("true");
    expect(checkboxes[3].getAttribute("aria-checked")).toBe("false");

    // Toggle 0 (checked -> unchecked override)
    fireEvent.click(checkboxes[0]);
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("false");

    // Toggle 3 (unchecked -> checked override)
    fireEvent.click(checkboxes[3]);
    expect(checkboxes[3].getAttribute("aria-checked")).toBe("true");

    // Rerender with usedIngredientIndices expanded to include 1 and 3
    rerender(
      <IngredientRows
        ingredients={SAMPLE_INGREDIENTS}
        usedIngredientIndices={new Set([0, 1, 3])}
      />,
    );

    const updatedCheckboxes = screen.getAllByRole("checkbox");
    // 0 stays unchecked due to manual override
    expect(updatedCheckboxes[0].getAttribute("aria-checked")).toBe("false");
    // 1 becomes checked via usedIngredientIndices
    expect(updatedCheckboxes[1].getAttribute("aria-checked")).toBe("true");
    // 3 stays checked via manual override
    expect(updatedCheckboxes[3].getAttribute("aria-checked")).toBe("true");
  });

  it("tapping the ingredient name toggles the checkbox for wet-hand reach", () => {
    render(<IngredientRows ingredients={SAMPLE_INGREDIENTS} />);

    const nameEl = screen.getByText("olive oil");
    fireEvent.click(nameEl);

    const checkbox = screen.getByRole("checkbox", { name: "Toggle olive oil" });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
  });

  it("skips blank stored ingredient lines (null in ingredients array)", () => {
    const withGaps: StoredIngredientLines = [
      SAMPLE_INGREDIENTS[0],
      null,
      SAMPLE_INGREDIENTS[1],
    ];
    render(<IngredientRows ingredients={withGaps} />);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(screen.getByText("center-cut salmon fillets")).toBeTruthy();
    expect(screen.getByText("olive oil")).toBeTruthy();
  });

  it("opens measurement conversions popover on amounts with conversions", () => {
    render(<IngredientRows ingredients={SAMPLE_INGREDIENTS} />);

    // olive oil has conversions: [ml, tsp, cup]
    const [amountBtn] = screen.getAllByRole("button", { name: "1 tbsp" });
    fireEvent.click(amountBtn);

    expect(screen.getByText("Conversions")).toBeTruthy();
    expect(screen.getByText("14.8")).toBeTruthy();
    expect(screen.getByText("ml")).toBeTruthy();
  });

  it("invokes onToggle callback when provided", () => {
    const onToggle = vi.fn();
    render(<IngredientRows ingredients={SAMPLE_INGREDIENTS} onToggle={onToggle} />);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    expect(onToggle).toHaveBeenCalledWith(1, true);
  });

  it("renders compact mode without checkboxes while keeping unit conversions on tap", () => {
    const { container } = render(<IngredientRows compact ingredients={SAMPLE_INGREDIENTS} />);

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("center-cut salmon fillets")).toBeTruthy();
    expect(screen.getByText("olive oil")).toBeTruthy();
    // to_taste omits amount/dash in compact mode and renders only the name
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.getByText("salt and pepper")).toBeTruthy();

    const firstRow = container.querySelector("[data-row]");
    const amountEl = firstRow?.querySelector("[data-amount]");
    const nameEl = firstRow?.querySelector("[data-ingredient-name]");
    expect(amountEl?.className).toContain("font-sans");
    expect(amountEl?.className).toContain("font-bold");
    expect(nameEl?.className).toContain("font-serif");

    const [amountBtn] = screen.getAllByRole("button", { name: "1 tbsp" });
    fireEvent.click(amountBtn);
    expect(screen.getByText("Conversions")).toBeTruthy();
  });

  it("strips parenthetical notes and as_written suffixes in compact mode only", () => {
    const withParens: StoredIngredientLines = [
      {
        kind: "amount",
        amount: "1 cup",
        stated: [{ unit: "cup", value: "1" }],
        conversions: [],
        name: "dried chickpeas (about 200 g), rinsed",
      },
      {
        kind: "as_written",
        amount: "a pinch of",
        name: "sumac (optional)",
        servesBase: 4,
      },
    ];

    const { unmount, container } = render(<IngredientRows compact ingredients={withParens} />);
    expect(screen.getByText("dried chickpeas, rinsed")).toBeTruthy();
    expect(screen.getByText("sumac")).toBeTruthy();
    expect(container.querySelector("[data-how-much]")).toBeNull();
    unmount();

    // Non-compact mode preserves parenthetical notes and how-much suffix
    render(<IngredientRows ingredients={withParens} />);
    expect(screen.getByText("dried chickpeas (about 200 g), rinsed")).toBeTruthy();
  });

  it("renders all compact rows inside a vertically scrollable container without pagination", () => {
    const many: StoredIngredientLines = Array.from({ length: 18 }, (_, i) => ({
      kind: "count" as const,
      amount: String(i + 1),
      name: `ingredient ${i + 1}`,
    }));
    const onParentWheel = vi.fn();
    const { container } = render(
      <div onWheel={onParentWheel}>
        <IngredientRows compact maxHeight={120} ingredients={many} />
      </div>,
    );

    const scrollBox = container.querySelector<HTMLElement>("[data-get-out-scroll]");
    expect(scrollBox).not.toBeNull();
    expect(scrollBox!.style.maxHeight).toBe("120px");
    expect(scrollBox!.className).toContain("overflow-y-auto");
    expect(container.querySelectorAll("[data-row]")).toHaveLength(18);
    expect(container.querySelector("[data-get-out-more]")).toBeNull();

    fireEvent.wheel(scrollBox!, { deltaY: 80 });
    expect(onParentWheel).not.toHaveBeenCalled();
  });
});

// The amount column follows the cook step's pairs (DECISIONS 2026-10-26, DS
// §5): the dotted rule is drawn by the button the popover makes, so only an
// amount that opens (its conversions, or a moved count's "Exactly") wears it.
describe("IngredientRows: the dotted rule marks only an amount that opens", () => {
  const LINES: StoredIngredientLines = [
    ...SAMPLE_INGREDIENTS,
    { kind: "count", amount: "about 2", exact: "2¼", name: "eggs" },
    { kind: "as_written", amount: "5 cups", name: "stock (or water + 1 tsp bouillon)" },
  ];

  it("rules the measure with conversions and the moved count; leaves the rest plain", () => {
    render(<IngredientRows ingredients={LINES} />);
    const amounts = [...document.querySelectorAll("[data-amount-words]")].map((amount) => ({
      amount: amount.textContent,
      opens: amount.closest("button") !== null,
    }));
    // 2 lb and the parsley's 1 tbsp state one amount and convert to nothing.
    expect(amounts).toEqual([
      { amount: "2 lb", opens: false },
      { amount: "1 tbsp", opens: true },
      { amount: "2", opens: false },
      { amount: "1", opens: false },
      { amount: "1 tbsp", opens: false },
      { amount: "about 2", opens: true },
      { amount: "5 cups", opens: false },
    ]);
    const buttons = [...document.querySelectorAll("button")].filter((b) => b.getAttribute("role") !== "checkbox");
    expect(buttons.length).toBe(2);
    for (const button of buttons) {
      expect(button.querySelector("[data-amount-words]")).not.toBeNull();
      expect(button.className).toContain(AMOUNT_RULE);
    }
    const ruled = [...document.querySelectorAll("*")]
      .filter((el) => el.closest("button") === null)
      .filter((el) => /(^|\s)(underline|decoration-dotted)(\s|$)/.test(el.getAttribute("class") ?? ""));
    expect(ruled).toEqual([]);
  });
});

