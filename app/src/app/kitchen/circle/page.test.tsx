// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CirclePage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const state = {
  signInMode: true,
  overview: {
    data: undefined as
      | undefined
      | {
          inCircle: boolean;
          circleName: string | null;
          members: Array<{ kitchenId: string; name: string; isSelf: boolean }>;
        },
    isPending: false,
    error: null as Error | null,
  },
  dishes: {
    data: undefined as
      | undefined
      | Array<{
          logId: string;
          recipeTitle: string;
          kitchenName: string;
          cookedDay: string;
          note: string | null;
          canOpenRecipe: boolean;
          packBlocked: boolean;
        }>,
    isPending: false,
    error: null as Error | null,
  },
  overviewEnabled: undefined as boolean | undefined,
  dishesEnabled: undefined as boolean | undefined,
};

vi.mock("@/components/kitchen/SignInMode", () => ({
  useSignInMode: () => state.signInMode,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    getCircleOverview: {
      useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
        state.overviewEnabled = opts?.enabled;
        return state.overview;
      },
    },
    getCircleDishes: {
      useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
        state.dishesEnabled = opts?.enabled;
        return state.dishes;
      },
    },
  },
}));

beforeEach(() => {
  state.signInMode = true;
  state.overview = { data: undefined, isPending: false, error: null };
  state.dishes = { data: undefined, isPending: false, error: null };
  state.overviewEnabled = undefined;
  state.dishesEnabled = undefined;
});

afterEach(cleanup);

describe("Friends' kitchens (/kitchen/circle)", () => {
  it("shows Not available and disables circle queries in single-kitchen mode", () => {
    state.signInMode = false;
    render(<CirclePage />);
    expect(state.overviewEnabled).toBe(false);
    expect(state.dishesEnabled).toBe(false);
    expect(screen.getByText("Not available")).toBeTruthy();
  });

  it("shows circle members and all shared dishes without ratings", () => {
    const today = new Date().toISOString().slice(0, 10);
    state.overview = {
      data: {
        inCircle: true,
        circleName: "Sunday Suppers",
        members: [
          { kitchenId: "k-1", name: "Cedar Kitchen", isSelf: true },
          { kitchenId: "k-2", name: "Maple Kitchen", isSelf: false },
        ],
      },
      isPending: false,
      error: null,
    };
    state.dishes = {
      data: [
        {
          logId: "log-1",
          recipeTitle: "Lemon Pasta",
          kitchenName: "Maple Kitchen",
          cookedDay: today,
          note: "Extra zest",
          canOpenRecipe: true,
          packBlocked: false,
        },
        {
          logId: "log-2",
          recipeTitle: "Secret Soup",
          kitchenName: "Maple Kitchen",
          cookedDay: "2026-11-20",
          note: null,
          canOpenRecipe: false,
          packBlocked: false,
        },
      ],
      isPending: false,
      error: null,
    };

    render(<CirclePage />);
    expect(screen.getByRole("heading", { name: "Sunday Suppers" })).toBeTruthy();
    expect(screen.getByText(/Cedar Kitchen \(this kitchen\) · Maple Kitchen/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Lemon Pasta" }).getAttribute("href")).toBe(
      "/kitchen/circle/dish/log-1",
    );
    expect(screen.getByText("Extra zest")).toBeTruthy();
    expect(screen.getByText("today")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Secret Soup" })).toBeNull();
    expect(screen.getByText("Secret Soup")).toBeTruthy();
    expect(document.body.textContent).not.toContain("of 5");
  });

  it("shows a calm empty state when not in a circle", () => {
    state.overview = {
      data: { inCircle: false, circleName: null, members: [] },
      isPending: false,
      error: null,
    };
    state.dishes = { data: [], isPending: false, error: null };
    render(<CirclePage />);
    expect(screen.getByText("You're not in a circle yet.")).toBeTruthy();
  });
});
