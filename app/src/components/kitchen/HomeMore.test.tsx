// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOME_MORE_COPY, HomeMore } from "./HomeMore";

afterEach(cleanup);

describe("HomeMore", () => {
  it("starts closed and opens on click", () => {
    const onImport = vi.fn();
    const onShoppingList = vi.fn();
    render(<HomeMore onImport={onImport} onShoppingList={onShoppingList} />);

    const button = screen.getByRole("button", { name: HOME_MORE_COPY.more });
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    const shoppingItem = screen.getByRole("menuitem", { name: HOME_MORE_COPY.shoppingList });
    expect(shoppingItem).toBeDefined();

    const importItem = screen.getByRole("menuitem", { name: HOME_MORE_COPY.import });
    expect(importItem).toBeDefined();

    fireEvent.click(shoppingItem);
    expect(onShoppingList).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: HOME_MORE_COPY.import }));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});
