// @vitest-environment happy-dom
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();

const state = {
  circleDish: {
    data: null as null | {
      logId: string;
      title: string;
      kitchenName: string;
      cookedDay: string;
      note: string | null;
      recipe: {
        name: string;
        serves?: number;
        estimatedTime?: { total?: number };
        ingredients?: Array<{ item: string; amount?: string; unit?: string }>;
        steps?: string[];
        notes?: string;
      };
      isPackRecipe: boolean;
    },
    error: null as Error | null,
    isPending: false,
  },
  sharedRecipe: {
    data: null as null | {
      recipeId: string;
      title: string;
      kitchenName: string;
      recipe: {
        name: string;
        serves?: number;
        estimatedTime?: { total?: number };
        ingredients?: Array<{ item: string; amount?: string; unit?: string }>;
        steps?: string[];
        notes?: string;
      };
    },
    error: null as Error | null,
    isPending: false,
  },
  queuedId: "00000000-0000-4000-8000-000000000099",
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    getCircleDish: {
      useQuery: () => state.circleDish,
    },
    queueCircleDish: {
      useMutation: (opts: { onSuccess?: (item: { id: string }) => void }) => ({
        isPending: false,
        mutate: () => opts.onSuccess?.({ id: state.queuedId }),
      }),
    },
    getSharedRecipe: {
      useQuery: () => state.sharedRecipe,
    },
    queueSharedRecipe: {
      useMutation: (opts: { onSuccess?: (item: { id: string }) => void }) => ({
        isPending: false,
        mutate: () => opts.onSuccess?.({ id: state.queuedId }),
      }),
    },
  },
}));

import CircleDishPage from "@/app/kitchen/circle/dish/[logId]/page";
import SharedRecipePage from "@/app/kitchen/shared/[recipeId]/page";

function resolvedParams<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), {
    status: "fulfilled",
    value,
  });
}

beforeEach(() => {
  pushMock.mockReset();
  state.circleDish = { data: null, error: null, isPending: false };
  state.sharedRecipe = { data: null, error: null, isPending: false };
});

afterEach(() => {
  cleanup();
});

describe("CircleDishPage and SharedRecipePage", () => {
  it("renders a friend's dish read-only and queues an independent copy", async () => {
    state.circleDish = {
      data: {
        logId: "log-1",
        title: "Ginger Sesame Noodles",
        kitchenName: "Maple Kitchen",
        cookedDay: "2026-11-24",
        note: "Used extra scallions",
        recipe: {
          name: "Ginger Sesame Noodles",
          serves: 4,
          estimatedTime: { total: 20 },
          ingredients: [{ item: "noodles", amount: "8", unit: "oz" }],
          steps: ["Boil noodles.", "Toss with sauce."],
        },
        isPackRecipe: false,
      },
      error: null,
      isPending: false,
    };

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <CircleDishPage params={resolvedParams({ logId: "log-1" })} />
        </Suspense>,
      );
    });

    expect(screen.getByRole("heading", { name: "Ginger Sesame Noodles" })).toBeTruthy();
    expect(screen.getByText(/From Maple Kitchen · /)).toBeTruthy();
    expect(document.body.textContent).not.toContain("of 5");
    expect(screen.getByText("Used extra scallions")).toBeTruthy();
    expect(screen.getByText("8 oz noodles")).toBeTruthy();
    expect(screen.getByText("Boil noodles.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add to Up next" }));
    expect(pushMock).toHaveBeenCalledWith(`/kitchen/queue/${state.queuedId}`);
  });

  it("renders plain Not available when a circle dish or share link is denied", async () => {
    state.circleDish = {
      data: null,
      error: new Error("Not available"),
      isPending: false,
    };

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <CircleDishPage params={resolvedParams({ logId: "missing" })} />
        </Suspense>,
      );
    });

    expect(screen.getByText("Not available")).toBeTruthy();
    cleanup();

    state.sharedRecipe = {
      data: null,
      error: new Error("Not available"),
      isPending: false,
    };

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <SharedRecipePage params={resolvedParams({ recipeId: "missing" })} />
        </Suspense>,
      );
    });

    expect(screen.getByText("Not available")).toBeTruthy();
  });

  it("renders a shared recipe and queues an independent copy", async () => {
    state.sharedRecipe = {
      data: {
        recipeId: "rec-1",
        title: "Skillet Cornbread",
        kitchenName: "Cedar Kitchen",
        recipe: {
          name: "Skillet Cornbread",
          serves: 6,
          ingredients: [{ item: "cornmeal", amount: "1", unit: "cup" }],
          steps: ["Bake at 425F for 20 minutes."],
        },
      },
      error: null,
      isPending: false,
    };

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <SharedRecipePage params={resolvedParams({ recipeId: "rec-1" })} />
        </Suspense>,
      );
    });

    expect(screen.getByRole("heading", { name: "Skillet Cornbread" })).toBeTruthy();
    expect(screen.getByText("From Cedar Kitchen")).toBeTruthy();
    expect(screen.getByText("1 cup cornmeal")).toBeTruthy();
    expect(screen.getByText("Bake at 425F for 20 minutes.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add to Up next" }));
    expect(pushMock).toHaveBeenCalledWith(`/kitchen/queue/${state.queuedId}`);
  });
});
