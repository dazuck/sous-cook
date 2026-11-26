// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInModeProvider } from "@/components/kitchen/SignInMode";
import { SIGN_IN_MODE_COOKIE } from "@/lib/kitchens/mode";
import CookLogPage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const mockInvalidate = vi.fn(() => Promise.resolve());
const mockSetData = vi.fn();
const mockGetData = vi.fn();
const mockMutateAsync = vi.fn();

let entriesData = [
  {
    id: "entry-1",
    queueId: "queue-1",
    docRecipeId: null,
    packSource: null,
    recipeTitle: "Lemon Pasta",
    timestampText: "2026-03-10 18:00",
    cookedDay: "2026-03-10",
    cookedAt: new Date("2026-03-10T18:00:00Z"),
    cookedByMemberId: null,
    cookedByName: null,
    rating: 4,
    notes: "Original note",
    notePrivate: false,
    noteUpdatedAt: null,
    heldBack: true,
    visibilityChosen: false,
  },
];

type MutationOpts = {
  onMutate?: (patch: unknown) => unknown;
  onSuccess?: (updated: unknown) => void;
  onError?: (err: Error, patch: unknown, ctx: unknown) => void;
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      getCookLog: {
        cancel: vi.fn(),
        getData: mockGetData,
        setData: mockSetData,
        invalidate: mockInvalidate,
      },
      getCookAsk: { invalidate: mockInvalidate },
      getCircleDishes: { invalidate: mockInvalidate },
    }),
    getCookLog: {
      useQuery: () => ({ data: entriesData, error: null }),
    },
    updateCookLogEntry: {
      useMutation: (opts: MutationOpts = {}) => {
        return {
          isPending: false,
          mutateAsync: async (patch: unknown) => {
            const ctx = opts.onMutate?.(patch);
            try {
              const res = await mockMutateAsync(patch);
              opts.onSuccess?.(res);
              return res;
            } catch (err) {
              opts.onError?.(err as Error, patch, ctx);
              throw err;
            }
          },
        };
      },
    },
  },
}));

beforeEach(() => {
  document.cookie = `${SIGN_IN_MODE_COOKIE}=; Max-Age=0; path=/`;
  mockMutateAsync.mockReset();
  mockInvalidate.mockClear();
  mockSetData.mockClear();
  mockGetData.mockReset();
  entriesData = [
    {
      ...entriesData[0]!,
      heldBack: true,
      notes: "Original note",
    },
  ];
});

afterEach(() => {
  cleanup();
});

describe("CookLogPage", () => {
  it("hides hold-back controls and badge in single-kitchen mode and shows them in sign-in mode", () => {
    render(
      <SignInModeProvider>
        <CookLogPage />
      </SignInModeProvider>,
    );

    expect(document.querySelector("[data-hold-back]")).toBeNull();
    expect(screen.queryByText("Held back from friends")).toBeNull();
    cleanup();

    document.cookie = `${SIGN_IN_MODE_COOKIE}=1; path=/`;
    render(
      <SignInModeProvider>
        <CookLogPage />
      </SignInModeProvider>,
    );

    expect(document.querySelector("[data-hold-back='entry-1']")?.textContent).toBe(
      "Show to friends",
    );
    expect(screen.getByText("Held back from friends")).not.toBeNull();
  });

  it("preserves the typed note draft when Save note fails and clears it when Save note succeeds", async () => {
    render(
      <SignInModeProvider>
        <CookLogPage />
      </SignInModeProvider>,
    );

    const input = screen.getByRole("textbox", {
      name: "Note for Lemon Pasta",
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Need more zest next time" } });

    mockMutateAsync.mockRejectedValueOnce(new Error("Network offline"));
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Network offline"));
    expect(input.value).toBe("Need more zest next time");
    expect(screen.getByRole("button", { name: "Save note" })).not.toBeNull();

    mockMutateAsync.mockResolvedValueOnce({
      ...entriesData[0]!,
      notes: "Need more zest next time",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save note" })).toBeNull(),
    );
  });
});
