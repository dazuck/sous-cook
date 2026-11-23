// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markReturn, takeReturn } from "@/lib/kitchen/return-focus";
import { BorrowedPage } from "./BorrowedPage";
import { BorrowedScreen } from "./BorrowedScreen";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => push.mockReset());
afterEach(cleanup);

const BACK = { label: "Back to the kitchen", href: "/kitchen" };

function page(children = <button type="button">a book</button>, returnKey?: string) {
  return render(
    <BorrowedPage kind="Cookpacks" back={BACK} returnKey={returnKey}>
      {children}
    </BorrowedPage>,
  );
}

describe("BorrowedPage", () => {
  it("draws the kind line as the page's heading and the ledge as a link back", () => {
    page();
    expect(screen.getByRole("heading", { level: 1, name: "Cookpacks" })).toBeTruthy();
    const ledge = screen.getByRole("link", { name: BACK.label });
    expect(ledge.getAttribute("href")).toBe("/kitchen");
    // A page, not a dialog: nothing traps focus or claims to be modal.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("goes back on Escape, as the ledge does, and takes the Escape", () => {
    page();
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
    expect(push).toHaveBeenCalledWith("/kitchen");
  });

  it("leaves an Escape to a borrowed screen over it", () => {
    page();
    const onClose = vi.fn();
    render(
      <BorrowedScreen kind="Saved for later" back="Back to Cookpacks" onClose={onClose}>
        <p>ideas</p>
      </BorrowedScreen>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("leaves an Escape to an open menu on it", () => {
    page(<div data-holds-keys>a menu</div>);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(push).not.toHaveBeenCalled();
  });

  it("leaves an Escape typed into a field that holds keys, and still goes back from elsewhere", () => {
    page(<input aria-label="search" data-holds-keys />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "search" }), { key: "Escape" });
    expect(push).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(push).toHaveBeenCalledWith("/kitchen");
  });

  it("ignores an Escape something else already took", () => {
    page(
      <input
        aria-label="field"
        onKeyDown={(e) => {
          if (e.key === "Escape") e.preventDefault();
        }}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "field" }), { key: "Escape" });
    expect(push).not.toHaveBeenCalled();
  });

  it("takes focus itself when nothing was marked to come back to", () => {
    const { container } = page();
    expect(document.activeElement).toBe(container.firstElementChild);
  });

  it("focuses what opened the page it came back from", () => {
    markReturn("pack:fannie");
    page(
      <>
        <button type="button" data-return-focus="pack:household-book">
          ours
        </button>
        <button type="button" data-return-focus="pack:fannie">
          theirs
        </button>
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "theirs" }));
  });

  it.each([
    ["Escape", () => fireEvent.keyDown(document.body, { key: "Escape" })],
    ["the ledge", () => fireEvent.click(screen.getByRole("link", { name: BACK.label }))],
  ])("marks itself on the way back by %s, for the page it lands on", (_, leave) => {
    page(undefined, "cookpacks");
    leave();
    cleanup();
    render(
      <>
        <button type="button" data-return-focus="cookpacks">
          Cookpacks
        </button>
        <button type="button">Import</button>
      </>,
    );
    expect(takeReturn()).toBe(true);
    expect(document.activeElement?.textContent).toBe("Cookpacks");
    // The mark lasts one hop.
    expect(takeReturn()).toBe(false);
  });
});
