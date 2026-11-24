// @vitest-environment happy-dom
import { act, cleanup, render, within } from "@testing-library/react";
import { Window } from "happy-dom";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KitchenTimersProvider, TimerNotices } from "@/components/kitchen/KitchenTimers";
import { allowanceError } from "@/lib/kitchen/__tests__/allowance-error";
import { ZUCCHINI_RECIPE } from "@/lib/kitchen/__tests__/zucchini-wraps";
import { markSignedOut, resetSignedOutForTests, SIGNED_OUT_COOK_NOTICE } from "@/lib/kitchen/signed-out";
import { createTimerStore } from "@/lib/kitchen/timer-store";
import { legacyToPackRecipe } from "@/lib/pack-convert/convert";
import type { StringStore } from "@/lib/persist/safe-storage";
import type { KitchenQueueRecipeData } from "../../../../../drizzle/schema";
import KitchenQueuePage from "./page";

// The cook page as a whole, with only its boundaries replaced: the server
// (`@/lib/trpc`) and the router. What it checks is the page's own part in
// the cook-screen notices: the signed-out line, and the plan's cap sentence.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const RECIPE: KitchenQueueRecipeData = {
  name: "Sweet Zucchini Wraps",
  ...ZUCCHINI_RECIPE,
  serves: 4,
};
const converted = legacyToPackRecipe(RECIPE, { id: "zucchini-wraps" });
if (!converted.ok) throw new Error(JSON.stringify(converted.issues));

// A queued recipe with no plan stored, so the page asks the server for one.
const ITEM = {
  id: "q-1",
  status: "pending",
  recipeData: RECIPE,
  packRecipe: converted.recipe,
  cookPlan: null,
};

// How the server answers the page's ask for a cook plan, set per test.
let planAnswer: (handlers: { onSuccess: (outcome: unknown) => void; onError: (err: unknown) => void }) => void;
const planAsks = vi.fn();

vi.mock("@/lib/trpc", () => ({
  trpc: {
    getKitchenQueueItem: {
      useQuery: () => ({ data: ITEM, isLoading: false, error: null, fetchStatus: "idle", failureCount: 0 }),
    },
    ensureCookPlan: {
      useMutation: () => ({
        mutate: (input: unknown, handlers: Parameters<typeof planAnswer>[0]) => {
          planAsks(input);
          planAnswer(handlers);
        },
      }),
    },
    ensureIntake: { useMutation: () => ({ mutate: vi.fn() }) },
    queueFromPack: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    updateKitchenQueueStatus: {
      useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, reset: vi.fn() }),
    },
    chatCooking: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
    getRecentCookingItems: { useQuery: () => ({ data: [] }) },
    // The finish sheet, mounted closed.
    getRecipePantryReconciliation: { useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null }) },
    applyPantryReconciliation: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }) },
  },
}));

// happy-dom has no font loading; CookFlow listens for document.fonts.
Object.defineProperty(document, "fonts", {
  value: Object.assign(new EventTarget(), { status: "loaded", ready: Promise.resolve() }),
  configurable: true,
});

function memoryStore(): StringStore {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** The lines in the cook screen's notices, in order. */
function cookNotices(container: HTMLElement): string[] {
  const block = container.querySelector("[data-cook-root] [data-notices]");
  return block ? [...block.querySelectorAll("p")].map((p) => p.textContent ?? "") : [];
}

async function openCookPage() {
  // The page reads its id with `use(params)`, so it suspends once before it draws.
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <KitchenTimersProvider store={createTimerStore(memoryStore())} claims={memoryStore()} session={memoryStore()}>
        <div data-home-notices="">
          <TimerNotices />
        </div>
        <Suspense fallback={null}>
          <KitchenQueuePage params={Promise.resolve({ id: ITEM.id })} />
        </Suspense>
      </KitchenTimersProvider>,
    );
  });
  if (!view.container.querySelector("[data-cook-root]")) throw new Error("the cook screen did not open");
  return view;
}

beforeEach(() => {
  // A real browser storage for the page's kept session (Node's own global has no methods).
  const storageWindow = new Window({ url: "https://app.example.com/kitchen/queue/q-1" });
  vi.stubGlobal("localStorage", storageWindow.localStorage);
  vi.stubGlobal("sessionStorage", storageWindow.sessionStorage);
  Element.prototype.scrollIntoView = () => {};
  // happy-dom has no 2D canvas context; the cook sheet measures its strip labels.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        font: "",
        measureText: (text: string) => ({ width: text.length * 8 }),
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetSignedOutForTests();
  planAsks.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetSignedOutForTests();
});

describe("CAPUI-4: the cook page shows the plan's cap sentence in the cook screen's notices", () => {
  it("shows the server's sentence when the plan is refused at the cap, never on the home notices, and saves no sentence on the device", async () => {
    const refusal = allowanceError("kitchen", new Date("2026-12-01T00:00:00.000Z"));
    planAnswer = ({ onError }) => onError(refusal);

    const { container } = await openCookPage();

    expect(planAsks).toHaveBeenCalledWith({ queueId: ITEM.id });
    expect(cookNotices(container)).toEqual([refusal.message]);
    const home = container.querySelector("[data-home-notices]") as HTMLElement;
    expect(within(home).queryByText(refusal.message)).toBeNull();
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.getItem(localStorage.key(i)!)).not.toContain(refusal.message);
    }
  });

  it("shows no line when the plan fails for any other reason", async () => {
    planAnswer = ({ onError }) => onError(new Error("timed out"));

    const { container } = await openCookPage();

    expect(planAsks).toHaveBeenCalledTimes(1);
    expect(cookNotices(container)).toEqual([]);
  });
});

describe("NOTICE-1: the cook page shows the signed-out line while the session is lost", () => {
  it("shows nothing before, then the line once signed out, ahead of a cap sentence, never on the home notices", async () => {
    const refusal = allowanceError("kitchen", new Date("2026-12-01T00:00:00.000Z"));
    planAnswer = ({ onError }) => onError(refusal);

    const { container } = await openCookPage();
    expect(cookNotices(container)).toEqual([refusal.message]);

    act(() => {
      markSignedOut();
    });

    expect(cookNotices(container)).toEqual([SIGNED_OUT_COOK_NOTICE, refusal.message]);
    const home = container.querySelector("[data-home-notices]") as HTMLElement;
    expect(within(home).queryByText(SIGNED_OUT_COOK_NOTICE)).toBeNull();
  });
});
