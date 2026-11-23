// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DISH_QUESTION,
  DishPhotoReview,
} from "./DishPhotoReview";

const PHOTO_MOCK = "data:image/jpeg;base64,mockdishpreviewdata";

afterEach(cleanup);

describe("DishPhotoReview", () => {
  it("renders nothing when photo is null", () => {
    const { container } = render(
      <DishPhotoReview
        photo={null}
        recipeTitle="Pan-seared Salmon"
        onSubmit={vi.fn()}
        onRetake={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders as a whole-ground BorrowedScreen with photo, step context, and 80 cpx controls", () => {
    render(
      <DishPhotoReview
        photo={PHOTO_MOCK}
        recipeTitle="Pan-seared Salmon"
        currentStepSummary="Sear skin side down for 4 minutes"
        onSubmit={vi.fn()}
        onRetake={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Check my dish" });
    expect(dialog).toBeTruthy();
    expect(dialog.className).toContain("bg-ground");
    expect(dialog.className).not.toContain("backdrop-blur");

    const img = screen.getByRole("img", { name: "Captured dish" });
    expect(img.getAttribute("src")).toBe(PHOTO_MOCK);

    expect(screen.getByText("Pan-seared Salmon")).toBeTruthy();
    expect(screen.getByText("Sear skin side down for 4 minutes")).toBeTruthy();

    expect(screen.getByRole("button", { name: "Check against this step" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retake photo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to step" })).toBeTruthy();
  });

  it("submits with recipe context when the primary Check against this step action is tapped", () => {
    const onSubmit = vi.fn();
    render(
      <DishPhotoReview
        photo={PHOTO_MOCK}
        recipeTitle="Pan-seared Salmon"
        onSubmit={onSubmit}
        onRetake={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Check against this step" }));
    expect(onSubmit).toHaveBeenCalledWith({
      photo: PHOTO_MOCK,
      question: DEFAULT_DISH_QUESTION,
      includeRecipeContext: true,
    });
  });

  it("triggers onRetake and onClose callbacks from the 80 cpx controls and ledge", () => {
    const onRetake = vi.fn();
    const onClose = vi.fn();
    render(
      <DishPhotoReview
        photo={PHOTO_MOCK}
        onSubmit={vi.fn()}
        onRetake={onRetake}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retake photo" }));
    expect(onRetake).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Back to step" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(
      <DishPhotoReview
        photo={PHOTO_MOCK}
        onSubmit={vi.fn()}
        onRetake={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
