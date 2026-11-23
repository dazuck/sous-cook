// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkUsedSheet } from "./MarkUsedSheet";

const mockApplyMutateAsync = vi.fn();
let queryResult: {
  data?: {
    candidates: Array<{
      recipeIngredient: string;
      docItemText: string;
      section: string;
      action: "delete" | "decrement" | "keep";
      updatedText?: string;
      isStaple: boolean;
      preselected: boolean;
      reason?: string;
    }>;
  };
  isLoading: boolean;
  isError: boolean;
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    getRecipePantryReconciliation: {
      useQuery: () => queryResult,
    },
    applyPantryReconciliation: {
      useMutation: () => ({
        mutateAsync: mockApplyMutateAsync,
      }),
    },
  },
}));

afterEach(cleanup);

describe("MarkUsedSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyMutateAsync.mockResolvedValue({ success: true, removedCount: 1, decrementedCount: 1 });
    queryResult = {
      data: {
        candidates: [
          {
            recipeIngredient: "2 yellow onions, diced",
            docItemText: "yellow onions (3)",
            section: "Produce",
            action: "decrement",
            updatedText: "yellow onions (1)",
            isStaple: false,
            preselected: true,
            reason: "2 of 3 used",
          },
          {
            recipeIngredient: "1 can crushed tomatoes",
            docItemText: "1 can crushed tomatoes",
            section: "Pantry",
            action: "delete",
            isStaple: false,
            preselected: true,
            reason: "All used",
          },
          {
            recipeIngredient: "1 tsp cumin",
            docItemText: "ground cumin",
            section: "Spice Rack",
            action: "delete",
            isStaple: true,
            preselected: false,
            reason: "Staple spice",
          },
        ],
      },
      isLoading: false,
      isError: false,
    };
  });

  it("does not render when isOpen is false", () => {
    render(
      <MarkUsedSheet
        queueId="q-1"
        recipeName="Tomato Soup"
        isOpen={false}
        onFinish={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("auto-bypasses and finishes immediately when there are 0 candidates", () => {
    queryResult.data = { candidates: [] };
    const onFinish = vi.fn();
    render(
      <MarkUsedSheet
        queueId="q-1"
        recipeName="Tomato Soup"
        isOpen={true}
        onFinish={onFinish}
        onCancel={vi.fn()}
      />,
    );
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("with 0 candidates finishes once per opening, however often the cook view re-renders it", () => {
    // The cook view passes a fresh onFinish on every render; a refused save
    // re-renders it, and the bypass must not send the save again (main-green-2).
    queryResult.data = { candidates: [] };
    const onFinish = vi.fn();
    const sheet = (open: boolean) => (
      <MarkUsedSheet
        queueId="q-1"
        isOpen={open}
        onFinish={() => onFinish()}
        onCancel={vi.fn()}
      />
    );
    const { rerender } = render(sheet(true));
    expect(onFinish).toHaveBeenCalledTimes(1);
    // The cook view closes it as it finishes, then re-renders (the save
    // refused, the retry offered) with the answer still cached.
    rerender(sheet(false));
    rerender(sheet(false));
    expect(onFinish).toHaveBeenCalledTimes(1);
    // The cook's retry opens it again: one more finish, and only one.
    rerender(sheet(true));
    rerender(sheet(true));
    expect(onFinish).toHaveBeenCalledTimes(2);
  });

  it("a failed check finishes once per opening, not on every re-render", () => {
    queryResult = { data: undefined, isLoading: false, isError: true };
    const onFinish = vi.fn();
    const sheet = (open: boolean) => (
      <MarkUsedSheet queueId="q-1" isOpen={open} onFinish={() => onFinish()} onCancel={vi.fn()} />
    );
    const { rerender } = render(sheet(true));
    rerender(sheet(true));
    rerender(sheet(true));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("fails safe and finishes immediately if the query errors", () => {
    queryResult = {
      data: undefined,
      isLoading: false,
      isError: true,
    };
    const onFinish = vi.fn();
    render(
      <MarkUsedSheet
        queueId="q-1"
        recipeName="Tomato Soup"
        isOpen={true}
        onFinish={onFinish}
        onCancel={vi.fn()}
      />,
    );
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("shows loading state while fetching reconciliation", () => {
    queryResult = {
      data: undefined,
      isLoading: true,
      isError: false,
    };
    render(
      <MarkUsedSheet
        queueId="q-1"
        recipeName="Tomato Soup"
        isOpen={true}
        onFinish={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Checking used ingredients...")).toBeTruthy();
  });

  it("renders candidates with preselected items checked and staples unchecked", () => {
    render(
      <MarkUsedSheet
        queueId="q-1"
        recipeName="Tomato Soup"
        isOpen={true}
        onFinish={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Mark ingredients as used")).toBeTruthy();
    expect(screen.getByText(/Used in Tomato Soup\./)).toBeTruthy();

    // Checkboxes
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]?.checked).toBe(true); // onions (preselected decrement)
    expect(checkboxes[1]?.checked).toBe(true); // tomatoes (preselected delete)
    expect(checkboxes[2]?.checked).toBe(false); // cumin (staple, unchecked)

    // Badges & non-breaking number-unit binding
    expect(screen.getByText("decrements")).toBeTruthy();
    expect(screen.getByText("will remove")).toBeTruthy();
    expect(screen.getByText("staple (unchecked)")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("1\u00a0can crushed tomatoes");
  });

  it("allows toggling items and updates the submit button count", () => {
    render(
      <MarkUsedSheet
        queueId="q-1"
        recipeName="Tomato Soup"
        isOpen={true}
        onFinish={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const submitBtn = screen.getByRole("button", { name: /Update 2 items & Finish/ });
    expect(submitBtn).toBeTruthy();

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // Uncheck first item
    fireEvent.click(checkboxes[0]!);
    expect(screen.getByRole("button", { name: /Update 1 item & Finish/ })).toBeTruthy();

    // Check third item (staple) by clicking its label text
    const cuminLabel = screen.getByText("ground cumin").closest("label")!;
    fireEvent.click(cuminLabel);
    expect(checkboxes[2]?.checked).toBe(true);
    expect(screen.getByRole("button", { name: /Update 2 items & Finish/ })).toBeTruthy();
  });

  it("clicking Skip finishes without applying reconciliation", () => {
    const onFinish = vi.fn();
    render(
      <MarkUsedSheet
        queueId="q-1"
        recipeName="Tomato Soup"
        isOpen={true}
        onFinish={onFinish}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Skip (keep pantry unchanged)" }));
    expect(mockApplyMutateAsync).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("clicking Update & Finish calls apply mutation with selected actions and calls onFinish", async () => {
    const onFinish = vi.fn();
    render(
      <MarkUsedSheet
        queueId="q-1"
        recipeName="Tomato Soup"
        isOpen={true}
        onFinish={onFinish}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Update 2 items & Finish/ }));

    await waitFor(() => {
      expect(mockApplyMutateAsync).toHaveBeenCalledWith({
        queueId: "q-1",
        actions: [
          {
            action: "decrement",
            oldText: "yellow onions (3)",
            newText: "yellow onions (1)",
            section: "Produce",
          },
          {
            action: "delete",
            oldText: "1 can crushed tomatoes",
            section: "Pantry",
          },
        ],
      });
      expect(onFinish).toHaveBeenCalledTimes(1);
    });
  });
});
