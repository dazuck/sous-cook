// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CookReport } from "@/lib/kitchen/report-capture";
import { SIGN_IN_MODE_COOKIE } from "@/lib/kitchens/mode";
import { BACK_TO_KITCHEN, BorrowedScreen } from "./BorrowedScreen";
import { FEEDBACK_COPY, FeedbackDialog, FeedbackTrigger } from "./FeedbackDialog";
import { SignInModeProvider } from "./SignInMode";

afterEach(() => {
  cleanup();
  document.cookie = `${SIGN_IN_MODE_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
});

describe("FeedbackDialog", () => {
  it("renders a native dialog with h1, label, and actions without redundant ARIA", () => {
    const { container } = render(
      <FeedbackDialog
        open={true}
        screen="kitchen"
        onClose={vi.fn()}
        submitReport={vi.fn(async () => "flagged" as const)}
      />,
    );
    const dialog = container.querySelector("dialog")!;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("closedby")).toBe("any");
    expect(dialog.hasAttribute("role")).toBe(false);
    expect(dialog.hasAttribute("aria-modal")).toBe(false);
    expect(screen.getByRole("heading", { level: 1, name: FEEDBACK_COPY.title })).toBeTruthy();
    expect(screen.getByLabelText(FEEDBACK_COPY.noteLabel)).toBeTruthy();
  });

  it("submits a typed note and closes cleanly", async () => {
    const sent: CookReport[] = [];
    const onClose = vi.fn();
    render(
      <FeedbackDialog
        open={true}
        screen="settings"
        onClose={onClose}
        submitReport={async (report) => {
          sent.push(report);
          return "flagged";
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText(FEEDBACK_COPY.noteLabel), {
      target: { value: "Circle button wrapped oddly" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: FEEDBACK_COPY.send }));
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.screen).toBe("settings");
    expect(sent[0]?.note).toBe("Circle button wrapped oddly");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submits blank note via Flag for later", async () => {
    const sent: CookReport[] = [];
    const onClose = vi.fn();
    render(
      <FeedbackDialog
        open={true}
        screen="cookpacks"
        onClose={onClose}
        submitReport={async (report) => {
          sent.push(report);
          return "flagged";
        }}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: FEEDBACK_COPY.flagForLater }));
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.screen).toBe("cookpacks");
    expect(sent[0]?.note).toBe("");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports failure in the live status region without closing", async () => {
    const onClose = vi.fn();
    render(
      <FeedbackDialog
        open={true}
        screen="kitchen"
        onClose={onClose}
        submitReport={async () => "failed" as const}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: FEEDBACK_COPY.flagForLater }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(FEEDBACK_COPY.failed);
  });

  it("opens from FeedbackTrigger and closes on Cancel with dialog still mounted cleanly", () => {
    render(<FeedbackTrigger screen="settings" />);
    expect(document.querySelector("dialog[data-feedback-dialog]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: FEEDBACK_COPY.button }));
    expect(document.querySelector("dialog[data-feedback-dialog]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: FEEDBACK_COPY.cancel }));
    expect(document.querySelector("dialog[data-feedback-dialog]")).toBeNull();
  });

  it("keeps a BorrowedScreen open when Escape is pressed inside an open FeedbackDialog", () => {
    document.cookie = `${SIGN_IN_MODE_COOKIE}=1; path=/`;
    const closeBorrowed = vi.fn();
    render(
      <SignInModeProvider>
        <BorrowedScreen kind="Up next" back={BACK_TO_KITCHEN} onClose={closeBorrowed}>
          <p>Queue contents</p>
        </BorrowedScreen>
      </SignInModeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: FEEDBACK_COPY.button }));
    const dialog = document.querySelector<HTMLDialogElement>("dialog[data-feedback-dialog]")!;
    expect(dialog).toBeTruthy();
    dialog.setAttribute("open", "");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(closeBorrowed).not.toHaveBeenCalled();
  });
});
