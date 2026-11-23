// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { BACK_TO_KITCHEN, BorrowedScreen } from "./BorrowedScreen";

afterEach(cleanup);

function borrowed() {
  const onClose = vi.fn();
  const on = (children: ReactNode) => (
    <BorrowedScreen kind={COOK_COPY.wholeRecipe} voice={{ status: "unsupported", echo: null }} onClose={onClose}>
      {children}
    </BorrowedScreen>
  );
  const { rerender } = render(on(<button type="button">a bar</button>));
  return {
    onClose,
    dialog: screen.getByRole("dialog", { name: COOK_COPY.wholeRecipe }),
    show: (children: ReactNode) => rerender(on(children)),
  };
}

describe("BorrowedScreen", () => {
  it("gives the screen back on Escape", () => {
    const { onClose, dialog } = borrowed();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the screen when a card on it put itself away with that Escape", () => {
    const onDismiss = vi.fn();
    // The screen is up first; a card touched on it handles Escape.
    const { onClose, show } = borrowed();
    show(
      <div
        role="region"
        aria-label="A step"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onDismiss();
          }
        }}
      />,
    );
    const card = screen.getByRole("region", { name: "A step" });
    expect(document.activeElement).toBe(card);
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("takes the Escape it gives the screen back on", () => {
    const { dialog } = borrowed();
    // fireEvent answers false when the event's default was prevented.
    expect(fireEvent.keyDown(dialog, { key: "Escape" })).toBe(false);
  });

  // The hub can hold two at once (?browse=true&import=true): the later one
  // is drawn over the other and holds focus.
  function twoUp() {
    const under = vi.fn();
    const over = vi.fn();
    render(
      <>
        <BorrowedScreen kind="Recipe Library" back={BACK_TO_KITCHEN} onClose={under}>
          <button type="button">a recipe</button>
        </BorrowedScreen>
        <BorrowedScreen kind="Import Recipe" back={BACK_TO_KITCHEN} onClose={over}>
          <button type="button">a tab</button>
        </BorrowedScreen>
      </>,
    );
    return { under, over };
  }

  it("gives back only the screen on top when two are up", () => {
    const { under, over } = twoUp();
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Import Recipe" }));
    expect(fireEvent.keyDown(document.activeElement!, { key: "Escape" })).toBe(false);
    expect(over).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
  });

  it("gives back only the screen on top when focus has fallen out of both", () => {
    const { under, over } = twoUp();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(over).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
  });

  it("gives the screen back from the ledge", () => {
    const { onClose } = borrowed();
    fireEvent.click(screen.getByRole("button", { name: COOK_COPY.backToCooking }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
