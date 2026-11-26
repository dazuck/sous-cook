// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUEUE_COPY, QueueScreen } from "./QueueScreen";
import type { KitchenItem } from "./KitchenRows";

afterEach(() => cleanup());

function item(id: string, name: string): KitchenItem {
  return {
    id,
    name,
    times: null,
    isPrivate: false,
    isPack: false,
  };
}

describe("QueueScreen share link feedback", () => {
  it("shows Copied only when onCopyShareLink succeeds and keeps Copy share link when clipboard copy fails", async () => {
    const onCopyFail = vi.fn(async () => false);
    const { rerender } = render(
      <QueueScreen
        cooking={[]}
        queue={[item("q-1", "Roasted Cauliflower")]}
        recent={[]}
        onStart={vi.fn()}
        onRemove={vi.fn()}
        onMarkDone={vi.fn()}
        onCopyShareLink={onCopyFail}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: QUEUE_COPY.edit }));
    const copyBtn = screen.getByRole("button", { name: QUEUE_COPY.copyShareLink });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(onCopyFail).toHaveBeenCalledWith("q-1"));
    expect(copyBtn.textContent).toBe(QUEUE_COPY.copyShareLink);

    const onCopyOk = vi.fn(async () => true);
    rerender(
      <QueueScreen
        cooking={[]}
        queue={[item("q-1", "Roasted Cauliflower")]}
        recent={[]}
        onStart={vi.fn()}
        onRemove={vi.fn()}
        onMarkDone={vi.fn()}
        onCopyShareLink={onCopyOk}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(copyBtn);
    await waitFor(() => expect(copyBtn.textContent).toBe(QUEUE_COPY.copiedShareLink));
  });
});
