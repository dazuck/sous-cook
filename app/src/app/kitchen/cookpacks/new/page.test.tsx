// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInModeProvider } from "@/components/kitchen/SignInMode";
import { SIGN_IN_MODE_COOKIE } from "@/lib/kitchens/mode";
import AddCollectionPage from "./page";

const pushMock = vi.fn();
const saveCalls: string[] = [];

const testState: {
  memberRole: "owner" | "cook" | null;
} = {
  memberRole: "owner",
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      getShelf: { invalidate: vi.fn() },
      getPack: { invalidate: vi.fn() },
      getCollectionAuthoringInfo: { invalidate: vi.fn() },
    }),
    getKitchenSettings: {
      useQuery: () => ({
        data: {
          about: "",
          slug: testState.memberRole === null ? "home" : "maple",
          name: testState.memberRole === null ? "Home" : "Maple Kitchen",
          memberRole: testState.memberRole,
        },
        error: null,
      }),
    },
    getCollectionAuthoringInfo: {
      useQuery: () => ({
        data: {
          commons: [
            {
              id: "commons:chiffonade",
              name: "Chiffonade",
              description: "Thin ribbons.",
            },
          ],
          states: [
            {
              id: "state:golden",
              name: "Golden",
              sensory_notes: { look: "Warm golden brown." },
            },
          ],
          reservedPackIds: ["household-book", "fannie-farmer-1896", "new"],
          ownedCollections: [],
          maxCollections: 20,
        },
        error: null,
      }),
    },
    getOwnedCollectionRaw: {
      useQuery: () => ({ data: undefined, error: null, isLoading: false }),
    },
    saveOwnedCollection: {
      useMutation: (opts: { onSuccess?: (res: { packId: string }) => void }) => ({
        isPending: false,
        mutate: ({ packJsonText }: { packJsonText: string }) => {
          saveCalls.push(packJsonText);
          const parsed = JSON.parse(packJsonText) as { id: string };
          opts.onSuccess?.({ packId: parsed.id });
        },
      }),
    },
  },
}));

function setSignInCookie(enabled: boolean): void {
  if (enabled) {
    document.cookie = `${SIGN_IN_MODE_COOKIE}=1; path=/`;
  } else {
    document.cookie = `${SIGN_IN_MODE_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

beforeEach(() => {
  testState.memberRole = "owner";
  pushMock.mockReset();
  saveCalls.length = 0;
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
  setSignInCookie(false);
});

afterEach(() => {
  cleanup();
  setSignInCookie(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AddCollectionPage", () => {
  it("keeps aria-invalid='false' before interaction, exposes errors on blur/submit, and supports keyboard tab switching", () => {
    render(
      <SignInModeProvider>
        <AddCollectionPage />
      </SignInModeProvider>,
    );

    const titleInput = screen.getByLabelText(/Collection title/);
    expect(titleInput.getAttribute("aria-invalid")).toBe("false");
    expect(titleInput.getAttribute("aria-describedby")).toBeNull();

    // Blur without entering title reveals validation and links aria-describedby
    fireEvent.blur(titleInput);
    expect(titleInput.getAttribute("aria-invalid")).toBe("true");
    expect(titleInput.getAttribute("aria-describedby")).toBeTruthy();

    fireEvent.change(titleInput, { target: { value: "Winter Soups" } });
    expect(titleInput.getAttribute("aria-invalid")).toBe("false");
    expect(titleInput.getAttribute("aria-describedby")).toBeNull();

    // Keyboard ArrowRight switches tabs
    const inAppTab = screen.getByRole("tab", { name: "Convert here (your own model)" });
    const chatAppTab = screen.getByRole("tab", { name: "Use your chat app" });
    expect(inAppTab.getAttribute("aria-selected")).toBe("true");
    expect(chatAppTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.keyDown(inAppTab, { key: "ArrowRight" });
    expect(chatAppTab.getAttribute("aria-selected")).toBe("true");
    expect(inAppTab.getAttribute("aria-selected")).toBe("false");
  });

  it("validates pasted JSON from a chat app, saves it, and navigates to the new collection", () => {
    render(
      <SignInModeProvider>
        <AddCollectionPage />
      </SignInModeProvider>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Use your chat app" }));
    const samplePack = {
      id: "quick-salads",
      title: "Quick Salads",
      version: "1.0.0",
      creator: { name: "Maple Kitchen" },
      cover_ref: null,
      recipes: [
        {
          id: "citrus-greens",
          title: "Citrus Greens",
          story: "",
          serves_base: 2,
          ingredients: [
            {
              id: "i1",
              name: "Mixed greens",
              qty_canonical: { mass_g: 150 },
              display_equivalents: { metric: { unit: "g", amount: 150 } },
            },
          ],
          steps: [
            {
              id: "s1",
              type: "action",
              text: "Toss greens with dressing.",
              ingredient_refs: ["i1"],
              timer_sec: null,
              media_ref: null,
            },
          ],
        },
      ],
    };

    fireEvent.change(screen.getByLabelText("Collection JSON"), {
      target: { value: JSON.stringify(samplePack) },
    });

    expect(screen.getByText("Ready for the shelf")).toBeTruthy();
    expect(screen.getByText("Citrus Greens")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Put on shelf" }));
    expect(saveCalls).toHaveLength(1);
    expect(pushMock).toHaveBeenCalledWith("/kitchen/cookpacks/quick-salads");
  });

  it("blocks non-owner cook accounts in sign-in mode", () => {
    testState.memberRole = "cook";
    setSignInCookie(true);
    render(
      <SignInModeProvider>
        <AddCollectionPage />
      </SignInModeProvider>,
    );

    expect(
      screen.getByText("Only kitchen owners can add or update collections."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Put on shelf" })).toBeNull();
  });
});
