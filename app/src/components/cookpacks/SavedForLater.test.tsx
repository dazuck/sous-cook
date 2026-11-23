// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COOKPACKS_COPY } from "./copy";
import { SavedForLater } from "./SavedForLater";

afterEach(cleanup);

describe("SavedForLater", () => {
  it("is a borrowed screen over the shelf that goes back to Cookpacks", () => {
    const onClose = vi.fn();
    render(<SavedForLater data={{ ideas: ["Pasta e ceci"], stale: false }} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: COOKPACKS_COPY.saved })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: COOKPACKS_COPY.backToCookpacks }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists the ideas as lines to read, with their count and source", () => {
    render(
      <SavedForLater data={{ ideas: ["Pasta e ceci", "Birria tacos for the next long weekend"], stale: false }} onClose={vi.fn()} />,
    );
    expect(screen.getByText(COOKPACKS_COPY.ideasFrom(2))).toBeTruthy();
    const list = screen.getByRole("list", { name: COOKPACKS_COPY.saved });
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Pasta e ceci",
      "Birria tacos for the next long weekend",
    ]);
    expect(list.querySelectorAll("button, a")).toHaveLength(0);
  });

  it("says when the list is the cached copy", () => {
    render(<SavedForLater data={{ ideas: ["Pasta e ceci"], stale: true }} onClose={vi.fn()} />);
    expect(screen.getByText(COOKPACKS_COPY.ideasStale)).toBeTruthy();
  });

  it("says when there are none, and while they load", () => {
    render(<SavedForLater data={{ ideas: [], stale: false }} onClose={vi.fn()} />);
    expect(screen.getByText(COOKPACKS_COPY.ideasNone)).toBeTruthy();
    cleanup();
    render(<SavedForLater data={undefined} onClose={vi.fn()} />);
    expect(screen.getByText(COOKPACKS_COPY.ideasLoading)).toBeTruthy();
  });
});
