// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowanceError } from "@/lib/kitchen/__tests__/allowance-error";
import { AddIngredientsModal } from "./AddIngredientsModal";

const mockParseMutateAsync = vi.fn();
const mockAddMutateAsync = vi.fn();
const mockPantryRefetch = vi.fn();
let mockPantryState: {
  data: { sections: Array<{ heading: string; rawHeading: string; items: string[] }> } | undefined;
  isLoading: boolean;
  error: Error | null;
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    getPantry: {
      useQuery: () => ({
        ...mockPantryState,
        refetch: mockPantryRefetch,
      }),
    },
    parseGroceryInput: {
      useMutation: () => ({
        mutateAsync: mockParseMutateAsync,
        isPending: false,
      }),
    },
    addIngredientsToPantry: {
      useMutation: () => ({
        mutateAsync: mockAddMutateAsync,
        isPending: false,
      }),
    },
  },
}));

const mockResetTranscript = vi.fn();
const mockStartListening = vi.fn();
const mockStopListening = vi.fn();

vi.mock("@/hooks/useSpeechRecognition", () => ({
  useSpeechRecognition: () => ({
    isListening: false,
    isSupported: true,
    transcript: "",
    startListening: mockStartListening,
    stopListening: mockStopListening,
    resetTranscript: mockResetTranscript,
  }),
}));

afterEach(cleanup);

describe("AddIngredientsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPantryState = {
      data: { sections: [] },
      isLoading: false,
      error: null,
    };
    mockParseMutateAsync.mockResolvedValue({
      items: [
        { text: "honeycrisp apples", suggestedSection: "Produce" },
        { text: "oat milk", suggestedSection: "Fridge" },
      ],
    });
    mockAddMutateAsync.mockResolvedValue({
      success: true,
      count: 2,
    });
  });

  it("does not render when isOpen is false", () => {
    render(
      <AddIngredientsModal
        isOpen={false}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders with 3 tabs and defaults to voice tab", () => {
    render(
      <AddIngredientsModal
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Voice/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Photo/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Text/ })).toBeTruthy();
  });

  it("switches to Text tab, parses text input, and transitions to review step", async () => {
    render(
      <AddIngredientsModal
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    // Switch to Text tab
    fireEvent.click(screen.getByRole("tab", { name: /Text/ }));

    const textarea = screen.getByLabelText(/Type or paste items/);
    fireEvent.change(textarea, {
      target: { value: "honeycrisp apples\noat milk" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Review items" }));

    await waitFor(() => {
      expect(mockParseMutateAsync).toHaveBeenCalledWith({
        type: "text",
        content: "honeycrisp apples\noat milk",
      });
      // Review screen is now shown
      expect(screen.getByText("Review ingredients")).toBeTruthy();
      expect(screen.getByDisplayValue("honeycrisp apples")).toBeTruthy();
      expect(screen.getByDisplayValue("oat milk")).toBeTruthy();
    });
  });

  it("allows editing items in review and commits to pantry doc", async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();

    render(
      <AddIngredientsModal
        isOpen={true}
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    // Go to text tab and parse
    fireEvent.click(screen.getByRole("tab", { name: /Text/ }));
    const textarea = screen.getByLabelText(/Type or paste items/);
    fireEvent.change(textarea, { target: { value: "honeycrisp apples\noat milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Review items" }));

    await screen.findByText("Review ingredients");

    // Modify the first item's text
    const firstInput = screen.getByDisplayValue("honeycrisp apples");
    fireEvent.change(firstInput, { target: { value: "3 honeycrisp apples" } });

    // Commit to pantry
    const addBtn = screen.getByRole("button", { name: /Add 2 items to pantry/ });
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(mockAddMutateAsync).toHaveBeenCalledWith({
        items: [
          { text: "3 honeycrisp apples", section: "Produce" },
          { text: "oat milk", section: "Fridge" },
        ],
      });
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("allows removing an item in review", async () => {
    render(
      <AddIngredientsModal
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Text/ }));
    const textarea = screen.getByLabelText(/Type or paste items/);
    fireEvent.change(textarea, { target: { value: "apples\nmilk" } });
    fireEvent.click(screen.getByRole("button", { name: "Review items" }));

    await screen.findByText("Review ingredients");

    const deleteButtons = screen.getAllByRole("button", { name: "Remove item" });
    expect(deleteButtons).toHaveLength(2);
    fireEvent.click(deleteButtons[0]!);

    expect(screen.queryByDisplayValue("honeycrisp apples")).toBeNull();
    expect(screen.getByRole("button", { name: /Add 1 item to pantry/ })).toBeTruthy();
  });

  it("shows the server's allowance sentence when parsing hits the monthly AI cap", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const capError = allowanceError("kitchen", new Date("2026-12-01T00:00:00.000Z"));
    mockParseMutateAsync.mockRejectedValueOnce(capError);

    render(
      <AddIngredientsModal
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Text/ }));
    fireEvent.change(screen.getByLabelText(/Type or paste items/), {
      target: { value: "apples\nmilk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review items" }));

    await screen.findByText(capError.message);
    expect(
      screen.queryByText("Extraction failed. Check your network connection or enter text."),
    ).toBeNull();
    logged.mockRestore();
  });

  it("shows the generic extraction failure message for ordinary parse errors", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockParseMutateAsync.mockRejectedValueOnce(new Error("Network down"));

    render(
      <AddIngredientsModal
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Text/ }));
    fireEvent.change(screen.getByLabelText(/Type or paste items/), {
      target: { value: "apples\nmilk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review items" }));

    await screen.findByText("Extraction failed. Check your network connection or enter text.");
    logged.mockRestore();
  });

  it("shows the pantry empty state when all sections are empty and lists items when present", () => {
    mockPantryState = {
      data: {
        sections: [{ heading: "fridge", rawHeading: "Fridge", items: [] }],
      },
      isLoading: false,
      error: null,
    };
    const { rerender } = render(
      <AddIngredientsModal isOpen={true} onClose={vi.fn()} />,
    );
    expect(screen.getByText("Nothing in the pantry yet.")).toBeTruthy();

    mockPantryState = {
      data: {
        sections: [
          { heading: "fridge", rawHeading: "Fridge", items: ["2 avocados"] },
          { heading: "freezer", rawHeading: "Freezer", items: ["frozen peas"] },
        ],
      },
      isLoading: false,
      error: null,
    };
    rerender(<AddIngredientsModal isOpen={true} onClose={vi.fn()} />);
    expect(screen.queryByText("Nothing in the pantry yet.")).toBeNull();
    expect(screen.getByText("Fridge")).toBeTruthy();
    expect(screen.getByText("2 avocados")).toBeTruthy();
    expect(screen.getByText("Freezer")).toBeTruthy();
    expect(screen.getByText("frozen peas")).toBeTruthy();
  });

  it("allows adding items by hand without calling parseGroceryInput", async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(
      <AddIngredientsModal isOpen={true} onClose={onClose} onSuccess={onSuccess} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add items by hand" }));
    expect(screen.getByText("Review ingredients")).toBeTruthy();

    const input = screen.getByPlaceholderText("Ingredient name and quantity");
    fireEvent.change(input, { target: { value: "2 avocados" } });
    fireEvent.click(screen.getByRole("button", { name: /Add 1 item to pantry/ }));

    await waitFor(() => {
      expect(mockParseMutateAsync).not.toHaveBeenCalled();
      expect(mockAddMutateAsync).toHaveBeenCalledWith({
        items: [{ text: "2 avocados", section: "Fridge" }],
      });
      expect(mockPantryRefetch).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
