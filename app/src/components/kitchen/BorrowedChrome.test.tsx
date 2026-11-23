// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { BorrowedChrome } from "./BorrowedChrome";

afterEach(cleanup);

describe("BorrowedChrome", () => {
  it("renders kind line and ledge with default back copy", () => {
    const onClose = vi.fn();
    render(
      <BorrowedChrome kind="Test Screen" onClose={onClose}>
        <p>content</p>
      </BorrowedChrome>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Test Screen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: COOK_COPY.backToCooking })).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("calls onClose when the ledge button is clicked", () => {
    const onClose = vi.fn();
    render(
      <BorrowedChrome kind="Test Screen" back="Go Back" onClose={onClose}>
        <p>content</p>
      </BorrowedChrome>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("handles Escape when active and topLayer", () => {
    const onClose = vi.fn();
    render(
      <BorrowedChrome kind="Test Screen" onClose={onClose}>
        <p>content</p>
      </BorrowedChrome>,
    );
    const dialog = screen.getByRole("dialog", { name: "Test Screen" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape when active={false}", () => {
    const onClose = vi.fn();
    render(
      <BorrowedChrome kind="Test Screen" active={false} onClose={onClose}>
        <p>content</p>
      </BorrowedChrome>,
    );
    const dialog = screen.getByRole("dialog", { name: "Test Screen" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the ledge band (P64, P60 a)", () => {
  it("is 96 cpx, the token the home's foot shares, with an 80 cpx capsule centred in it (D3, D4)", async () => {
    const { LEDGE, LEDGE_BAR, LEDGE_BAR_CPX } = await import("./BorrowedChrome");
    const tokens = (await import("node:fs")).readFileSync(
      (await import("node:path")).join(process.cwd(), "src/styles/tokens.css"),
      "utf8",
    );
    // The JS twin and the token say the same number.
    expect(tokens).toMatch(new RegExp(`--band-foot:\\s*calc\\(${LEDGE_BAR_CPX} \\* var\\(--cpx\\)\\)`));
    expect(LEDGE_BAR_CPX).toBe(96);
    expect(LEDGE_BAR).toContain("h-[var(--band-foot)]");
    // The capsule is a target tall (§0.3), not the 56 cpx R22 shipped.
    expect(LEDGE).toContain("h-[var(--target)]");
    expect(LEDGE).not.toContain("56*var(--cpx)");
  });
});
