// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseShoppingLine } from "@/lib/shopping-list-format";
import {
  CLEAR_ARM_MS,
  SHOPPING_LIST_COPY,
  ShoppingListView,
} from "./ShoppingListModal";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SAMPLE_ITEMS = [
  parseShoppingLine("Hoisin sauce — Sat udon"),
  parseShoppingLine("Salt from Trader Joe's"),
  parseShoppingLine("Lemons (2) — Tue beans"),
];

describe("ShoppingListView", () => {
  it("groups items by aisle by default and switches between By aisle, By recipe, and All", () => {
    render(
      <ShoppingListView
        items={SAMPLE_ITEMS}
        loading={false}
        error={null}
        mutating={false}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
        onRetry={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Default mode is "By aisle": headings for "Produce" and "Spices & sauces"
    expect(screen.getByRole("heading", { name: "Produce" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Spices & sauces" })).toBeDefined();
    expect(screen.getByRole("button", { name: /Hoisin sauce/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Salt from Trader Joe's/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Lemons \(2\)/i })).toBeDefined();

    // Switch to "By recipe"
    fireEvent.click(screen.getByRole("button", { name: SHOPPING_LIST_COPY.byRecipe }));
    expect(screen.getByRole("heading", { name: "Sat udon" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Tue beans" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "General" })).toBeDefined();

    // Switch to "All"
    fireEvent.click(screen.getByRole("button", { name: SHOPPING_LIST_COPY.all }));
    expect(screen.queryByRole("heading", { name: "Sat udon" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Produce" })).toBeNull();
    expect(screen.getByRole("button", { name: /Hoisin sauce/i })).toBeDefined();
  });

  it("submits a new item with optional recipe/store note and resets inputs on success, or keeps inputs when onAdd returns false", async () => {
    const onAdd = vi
      .fn<(item: string, forRecipe?: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    render(
      <ShoppingListView
        items={SAMPLE_ITEMS}
        loading={false}
        error={null}
        mutating={false}
        onAdd={onAdd}
        onRemove={vi.fn()}
        onClear={vi.fn()}
        onRetry={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const itemInput = screen.getByPlaceholderText(
      SHOPPING_LIST_COPY.itemPlaceholder,
    ) as HTMLInputElement;
    const forInput = screen.getByPlaceholderText(
      SHOPPING_LIST_COPY.forPlaceholder,
    ) as HTMLInputElement;

    fireEvent.change(itemInput, { target: { value: "Heavy cream" } });
    fireEvent.change(forInput, { target: { value: "Tue beans" } });
    fireEvent.click(screen.getByRole("button", { name: SHOPPING_LIST_COPY.add }));

    // First attempt returns false -> inputs preserved
    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledTimes(1);
    });
    expect(itemInput.value).toBe("Heavy cream");
    expect(forInput.value).toBe("Tue beans");

    // Second attempt returns true -> inputs cleared
    fireEvent.click(screen.getByRole("button", { name: SHOPPING_LIST_COPY.add }));
    await waitFor(() => {
      expect(itemInput.value).toBe("");
      expect(forInput.value).toBe("");
    });
  });

  it("checks off an item on row tap, arms Clear all for 4s, and disarms after timeout or clears on second tap", () => {
    vi.useFakeTimers();
    const onRemove = vi.fn();
    const onClear = vi.fn();
    render(
      <ShoppingListView
        items={SAMPLE_ITEMS}
        loading={false}
        error={null}
        mutating={false}
        onAdd={vi.fn()}
        onRemove={onRemove}
        onClear={onClear}
        onRetry={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Hoisin sauce/i }));
    expect(onRemove).toHaveBeenCalledWith("Hoisin sauce — Sat udon");

    // First tap arms Clear all
    fireEvent.click(screen.getByRole("button", { name: SHOPPING_LIST_COPY.clearAll }));
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: SHOPPING_LIST_COPY.confirmClear })).toBeDefined();

    // After 4s without second tap, it disarms back to "Clear all"
    act(() => {
      vi.advanceTimersByTime(CLEAR_ARM_MS);
    });
    expect(screen.getByRole("button", { name: SHOPPING_LIST_COPY.clearAll })).toBeDefined();

    // Arm again and tap a second time within 4s -> clears
    fireEvent.click(screen.getByRole("button", { name: SHOPPING_LIST_COPY.clearAll }));
    fireEvent.click(screen.getByRole("button", { name: SHOPPING_LIST_COPY.confirmClear }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("renders empty and error states cleanly", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ShoppingListView
        items={[]}
        loading={false}
        error={null}
        mutating={false}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
        onRetry={onRetry}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(SHOPPING_LIST_COPY.empty)).toBeDefined();

    rerender(
      <ShoppingListView
        items={[]}
        loading={false}
        error="Could not reach the shopping list"
        mutating={false}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
        onRetry={onRetry}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Could not reach the shopping list")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: SHOPPING_LIST_COPY.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
