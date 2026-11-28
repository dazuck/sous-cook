// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as safeStorage from "@/lib/persist/safe-storage";
import { FIRST_RUN_ABOUT_COPY, FirstRunAboutCard, useAboutPromptDismissed } from "./FirstRunAboutCard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function DismissHarness() {
  const [dismissed, dismiss] = useAboutPromptDismissed();
  if (dismissed) return <p data-testid="dismissed">gone</p>;
  return <FirstRunAboutCard onDismiss={dismiss} />;
}

describe("FirstRunAboutCard", () => {
  it("renders a non-blocking inline link to settings#about and calls onDismiss on Not now", () => {
    const onDismiss = vi.fn();
    render(<FirstRunAboutCard onDismiss={onDismiss} />);

    expect(screen.getByText(FIRST_RUN_ABOUT_COPY.heading)).toBeTruthy();
    const link = screen.getByRole("link", { name: FIRST_RUN_ABOUT_COPY.cta });
    expect(link.getAttribute("href")).toBe("/kitchen/settings#about");

    fireEvent.click(screen.getByRole("button", { name: FIRST_RUN_ABOUT_COPY.dismiss }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses in-session via memory fallback when localStorage is unavailable", () => {
    vi.spyOn(safeStorage, "safeLocalStorage").mockReturnValue(null);
    render(<DismissHarness />);

    fireEvent.click(screen.getByRole("button", { name: FIRST_RUN_ABOUT_COPY.dismiss }));
    expect(screen.getByTestId("dismissed")).toBeTruthy();
  });
});
