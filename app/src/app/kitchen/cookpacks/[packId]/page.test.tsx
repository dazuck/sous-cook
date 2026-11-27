// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOKPACKS_COPY } from "@/components/cookpacks/copy";
import { SignInModeProvider } from "@/components/kitchen/SignInMode";
import { allowanceError } from "@/lib/kitchen/__tests__/allowance-error";
import { SIGN_IN_MODE_COOKIE } from "@/lib/kitchens/mode";
import { refreshFailedLine } from "@/lib/recipe-sync-summary";
import type { PackPageView } from "@/lib/shelf/view";
import PackPage from "./page";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockInvalidatePack = vi.fn(() => Promise.resolve());
const mockInvalidateShelf = vi.fn(() => Promise.resolve());
const mockInvalidatePlanReport = vi.fn(() => Promise.resolve());
const mockInvalidatePackCircleShares = vi.fn(() => Promise.resolve());
const mockInvalidateCircleDishes = vi.fn(() => Promise.resolve());
const mockQueueMutate = vi.fn();
const mockSyncMutate = vi.fn();
const mockSetCircleShareMutate = vi.fn();

let currentView: PackPageView | null = null;
let currentMemberRole: "owner" | "cook" | null = null;
let currentCircleShares: {
  circleName: string | null;
  kitchens: Array<{
    kitchenId: string;
    slug: string;
    name: string;
    shared: boolean;
  }>;
} = { circleName: null, kitchens: [] };
let queueMutationOptions: {
  onSuccess?: (item: { id: string }) => void;
  onError?: (err: unknown) => void;
} = {};
let syncMutationOptions: {
  onSuccess?: (result: unknown) => void;
  onError?: (err: { message: string }) => void;
} = {};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      getPack: { invalidate: mockInvalidatePack },
      getShelf: { invalidate: mockInvalidateShelf },
      libraryPlanReport: { invalidate: mockInvalidatePlanReport },
      getPackCircleShares: { invalidate: mockInvalidatePackCircleShares },
      getCircleDishes: { invalidate: mockInvalidateCircleDishes },
      getCollectionAuthoringInfo: { invalidate: vi.fn(() => Promise.resolve()) },
    }),
    getPack: {
      useQuery: () => ({ data: currentView, error: null }),
    },
    getKitchenSettings: {
      useQuery: (_input?: unknown, opts?: { enabled?: boolean }) => ({
        data:
          opts?.enabled === false
            ? undefined
            : {
                about: "",
                slug: "maple",
                name: "Maple Kitchen",
                memberRole: currentMemberRole,
              },
        error: null,
      }),
    },
    getPackCircleShares: {
      useQuery: (_input?: unknown, opts?: { enabled?: boolean }) => ({
        data: opts?.enabled ? currentCircleShares : undefined,
        error: null,
      }),
    },
    setPackCircleShare: {
      useMutation: () => ({
        isPending: false,
        mutate: (input: unknown) => mockSetCircleShareMutate(input),
      }),
    },
    removeOwnedCollection: {
      useMutation: () => ({
        isPending: false,
        mutate: vi.fn(),
      }),
    },
    libraryPlanReport: {
      useQuery: () => ({ data: { needFixes: [], pending: 0, total: 0 } }),
    },
    queueFromPack: {
      useMutation: (opts: typeof queueMutationOptions = {}) => {
        queueMutationOptions = opts;
        return {
          mutate: (input: unknown) => mockQueueMutate(input),
        };
      },
    },
    syncRecipes: {
      useMutation: (opts: typeof syncMutationOptions = {}) => {
        syncMutationOptions = opts;
        return {
          isPending: false,
          mutate: () => mockSyncMutate(),
        };
      },
    },
    setDocRecipePrivate: {
      useMutation: () => ({
        mutate: vi.fn(),
      }),
    },
  },
}));

const HOUSEHOLD: PackPageView = {
  id: "household-book",
  kind: "household",
  title: "Household Book",
  creator: "Household Book",
  state: "ok",
  syncedAt: "2026-10-04T18:00:00Z",
  cookable: 1,
  missing: 0,
  cloth: null,
  chapters: [
    {
      anchor: "indian",
      title: "indian",
      rows: [
        {
          id: "dal-and-rice",
          title: "Dal and rice",
          times: null,
          serves: "serves 2",
          tags: [],
          missing: null,
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  currentView = HOUSEHOLD;
  currentMemberRole = null;
  currentCircleShares = { circleName: null, kitchens: [] };
  document.cookie = `${SIGN_IN_MODE_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  queueMutationOptions = {};
  syncMutationOptions = {};
});

afterEach(() => {
  cleanup();
  document.cookie = `${SIGN_IN_MODE_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
});

async function renderPage() {
  const params = Promise.resolve({ packId: HOUSEHOLD.id });
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <PackPage params={params} />
      </Suspense>,
    );
  });
  await screen.findByRole("button", { name: "Dal and rice" });
}

describe("PackPage", () => {
  it("shows the server's allowance sentence when sending a recipe hits the monthly AI cap", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const capError = allowanceError("kitchen", new Date("2026-12-01T00:00:00.000Z"));
    mockQueueMutate.mockImplementationOnce(() => {
      queueMutationOptions.onError?.(capError);
    });

    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Dal and rice" }));

    expect(mockQueueMutate).toHaveBeenCalledWith({
      packId: HOUSEHOLD.id,
      recipeId: "dal-and-rice",
    });
    const status = document.querySelector<HTMLElement>("[data-pack-status]");
    expect(status?.textContent).toBe(capError.message);
    expect(screen.queryByText(COOKPACKS_COPY.sendFailed)).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("shows the generic send failure line for ordinary queueFromPack errors", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockQueueMutate.mockImplementationOnce(() => {
      queueMutationOptions.onError?.(new Error("Unexpected server error"));
    });

    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Dal and rice" }));

    const status = document.querySelector<HTMLElement>("[data-pack-status]");
    expect(status?.textContent).toBe(COOKPACKS_COPY.sendFailed);
    expect(mockPush).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("shows the server's allowance sentence when Refresh hits the monthly AI cap and still invalidates queries", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const capError = allowanceError("kitchen", new Date("2026-12-01T00:00:00.000Z"));
    mockSyncMutate.mockImplementationOnce(() => {
      syncMutationOptions.onError?.(capError);
    });

    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: COOKPACKS_COPY.refresh }));

    const status = document.querySelector<HTMLElement>("[data-pack-status]");
    expect(status?.textContent).toBe(capError.message);
    expect(status?.classList.contains("text-ink")).toBe(true);
    expect(status?.classList.contains("text-ink-soft")).toBe(false);
    expect(screen.queryByText(refreshFailedLine("stopped", "Oct 4"))).toBeNull();
    expect(mockInvalidatePack).toHaveBeenCalledTimes(1);
    expect(mockInvalidateShelf).toHaveBeenCalledTimes(1);
    expect(mockInvalidatePlanReport).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("shows the refresh-failed line for ordinary syncRecipes errors and still invalidates queries", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSyncMutate.mockImplementationOnce(() => {
      syncMutationOptions.onError?.(new Error("Timed out"));
    });

    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: COOKPACKS_COPY.refresh }));

    const status = document.querySelector<HTMLElement>("[data-pack-status]");
    expect(status?.textContent).toBe(refreshFailedLine("stopped", "Oct 4"));
    expect(mockInvalidatePack).toHaveBeenCalledTimes(1);
    expect(mockInvalidateShelf).toHaveBeenCalledTimes(1);
    expect(mockInvalidatePlanReport).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("shows Share with circle switches only for an owner of an owned pack in sign-in mode", async () => {
    currentView = {
      ...HOUSEHOLD,
      id: "owned-pack",
      kind: "creator",
      title: "Owned Pack",
      creator: "Chef Maple",
      cloth: "walnut",
      isOwned: true,
    };
    currentCircleShares = {
      circleName: "Sunday Cooks",
      kitchens: [
        { kitchenId: "k-b", slug: "cedar", name: "Cedar Kitchen", shared: false },
      ],
    };

    // Cook in sign-in mode does not see Share with circle
    document.cookie = `${SIGN_IN_MODE_COOKIE}=1; path=/`;
    currentMemberRole = "cook";
    const params = Promise.resolve({ packId: "owned-pack" });
    await act(async () => {
      render(
        <SignInModeProvider>
          <Suspense fallback={null}>
            <PackPage params={params} />
          </Suspense>
        </SignInModeProvider>,
      );
    });
    expect(screen.queryByText("Share with circle")).toBeNull();
    cleanup();

    // Owner in sign-in mode sees Share with circle and can toggle
    currentMemberRole = "owner";
    await act(async () => {
      render(
        <SignInModeProvider>
          <Suspense fallback={null}>
            <PackPage params={params} />
          </Suspense>
        </SignInModeProvider>,
      );
    });
    expect(screen.getByText("Share with circle")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Share with Cedar Kitchen" });
    fireEvent.click(toggle);
    expect(mockSetCircleShareMutate).toHaveBeenCalledWith({
      packId: "owned-pack",
      targetKitchenId: "k-b",
      shared: true,
    });
  });
});
