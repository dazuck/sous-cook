// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInModeProvider } from "@/components/kitchen/SignInMode";
import { SIGN_IN_MODE_COOKIE } from "@/lib/kitchens/mode";
import KitchenSettingsPage from "./page";

interface TokenItem {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const state: {
  memberRole: "owner" | "cook" | null;
  tokens: TokenItem[];
  listCalls: number;
  nextTokenNum: number;
} = {
  memberRole: "owner",
  tokens: [],
  listCalls: 0,
  nextTokenNum: 1,
};

let rerenderTrigger: (() => void) | null = null;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      getKitchenSettings: { invalidate: vi.fn() },
      getCollectionAuthoringInfo: { invalidate: vi.fn() },
      listKitchenWebhookTokens: {
        invalidate: () => {
          rerenderTrigger?.();
          return Promise.resolve();
        },
      },
    }),
    getCollectionAuthoringInfo: {
      useQuery: () => ({
        data: {
          commons: [],
          states: [],
          reservedPackIds: ["household-book", "fannie-farmer-1896", "new"],
          ownedCollections: [],
          maxCollections: 20,
        },
        error: null,
      }),
    },
    getKitchenSettings: {
      useQuery: () => ({
        data: {
          about: "",
          slug: state.memberRole === null ? "home" : "maple",
          name: state.memberRole === null ? "Home" : "Maple Kitchen",
          memberRole: state.memberRole,
        },
        error: null,
      }),
    },
    updateKitchenAbout: {
      useMutation: () => ({ mutate: vi.fn(), isPending: false }),
    },
    listKitchenWebhookTokens: {
      useQuery: () => {
        state.listCalls += 1;
        return {
          data: state.tokens,
          error: null,
        };
      },
    },
    createKitchenWebhookToken: {
      useMutation: (opts: {
        onSuccess?: (res: {
          id: string;
          label: string;
          createdAt: string;
          token: string;
        }) => void;
        onError?: (err: Error) => void;
      }) => ({
        isPending: false,
        mutate: ({ label }: { label: string }) => {
          if (state.tokens.length >= 10) {
            opts.onError?.(
              new Error(
                "This kitchen already has 10 live tokens. Revoke one before making another.",
              ),
            );
            return;
          }
          const num = state.nextTokenNum++;
          const id = `00000000-0000-4000-8000-${String(num).padStart(12, "0")}`;
          const createdAt = "2026-11-24T12:00:00.000Z";
          const token = `sous_test_token_${num}`;
          state.tokens = [
            ...state.tokens,
            { id, label, createdAt, lastUsedAt: null },
          ];
          opts.onSuccess?.({ id, label, createdAt, token });
        },
      }),
    },
    revokeKitchenWebhookToken: {
      useMutation: (opts: {
        onSuccess?: (res: {
          id: string;
          label: string;
          revokedAt: string;
        }) => void;
        onError?: (err: Error) => void;
      }) => ({
        isPending: false,
        mutate: ({ id }: { id: string }) => {
          const found = state.tokens.find((t) => t.id === id);
          if (!found) {
            opts.onError?.(new Error("Webhook token not found."));
            return;
          }
          state.tokens = state.tokens.filter((t) => t.id !== id);
          opts.onSuccess?.({
            id,
            label: found.label,
            revokedAt: "2026-11-24T13:00:00.000Z",
          });
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

function renderSettings() {
  return render(
    <SignInModeProvider>
      <KitchenSettingsPage />
    </SignInModeProvider>,
  );
}

beforeEach(() => {
  state.memberRole = "owner";
  state.tokens = [];
  state.listCalls = 0;
  state.nextTokenNum = 1;
  rerenderTrigger = null;
  setSignInCookie(false);
});

afterEach(() => {
  cleanup();
  setSignInCookie(false);
  rerenderTrigger = null;
  vi.restoreAllMocks();
});

describe("KitchenSettingsPage owner webhook token UI", () => {
  it("hides sending tokens and does not query tokens in single-kitchen mode", () => {
    state.memberRole = null;
    setSignInCookie(false);
    renderSettings();

    expect(screen.getByLabelText("About my kitchen")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sending tokens" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Collections" })).toBeTruthy();
    expect(state.listCalls).toBe(0);
  });

  it("hides sending tokens and collections and does not query tokens for a cook in sign-in mode", () => {
    state.memberRole = "cook";
    setSignInCookie(true);
    renderSettings();

    expect(screen.getByLabelText("About my kitchen")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sending tokens" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Collections" })).toBeNull();
    expect(state.listCalls).toBe(0);
  });

  it("lets an owner create a labelled token, see it once, hit the 10-token cap, and revoke tokens", () => {
    state.memberRole = "owner";
    setSignInCookie(true);
    const view = renderSettings();
    rerenderTrigger = () =>
      view.rerender(
        <SignInModeProvider>
          <KitchenSettingsPage />
        </SignInModeProvider>,
      );

    expect(screen.getByRole("heading", { name: "Sending tokens" })).toBeTruthy();
    expect(screen.getByText("Live tokens (0 of 10)")).toBeTruthy();
    expect(screen.getByText("No live tokens yet.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Token label"), {
      target: { value: "Kitchen assistant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Make token" }));

    expect(
      document.querySelector("[data-webhook-token-value]")?.textContent,
    ).toBe("sous_test_token_1");
    expect(
      screen.getByText(
        "Save this token now. You will not be able to see it again.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Live tokens (1 of 10)")).toBeTruthy();
    expect(screen.getByText("Kitchen assistant")).toBeTruthy();
    expect(screen.getByText(/Last used never/)).toBeTruthy();

    // Unmount + remount simulates reload: plaintext token is gone forever
    view.unmount();
    const secondView = renderSettings();
    rerenderTrigger = () =>
      secondView.rerender(
        <SignInModeProvider>
          <KitchenSettingsPage />
        </SignInModeProvider>,
      );
    expect(document.querySelector("[data-webhook-token-value]")).toBeNull();
    expect(document.body.textContent).not.toContain("sous_test_token_1");

    // Fill remaining 9 slots up to 10
    for (let i = 2; i <= 10; i++) {
      fireEvent.change(screen.getByLabelText("Token label"), {
        target: { value: `Token ${i}` },
      });
      fireEvent.click(screen.getByRole("button", { name: "Make token" }));
    }

    expect(screen.getByText("Live tokens (10 of 10)")).toBeTruthy();
    expect(
      screen.getByText(
        "You have 10 live tokens. Revoke one before making another.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Make token" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Revoke the first token -> count drops to 9 and creation unlocks once a label is typed
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke Kitchen assistant" }),
    );
    expect(screen.getByText("Live tokens (9 of 10)")).toBeTruthy();
    expect(screen.queryByText("Kitchen assistant")).toBeNull();
    expect(
      screen.queryByText(
        "You have 10 live tokens. Revoke one before making another.",
      ),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText("Token label"), {
      target: { value: "Replacement" },
    });
    expect(
      (screen.getByRole("button", { name: "Make token" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Make token" }));
    expect(screen.getByText("Live tokens (10 of 10)")).toBeTruthy();
    expect(
      document.querySelector("[data-webhook-token-value]")?.textContent,
    ).toBe("sous_test_token_11");

    // Revoking the currently revealed token hides the reveal banner
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke Replacement" }),
    );
    expect(document.querySelector("[data-webhook-token-value]")).toBeNull();
  });
});
