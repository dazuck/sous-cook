// @vitest-environment happy-dom
import { act, cleanup, render, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCookNotices } from "@/app/kitchen/queue/[id]/cook-notices";
import { allowanceError } from "@/lib/kitchen/__tests__/allowance-error";
import { ZUCCHINI_RECIPE } from "@/lib/kitchen/__tests__/zucchini-wraps";
import { identityPlan } from "@/lib/kitchen/cook-plan";
import type { CookSession } from "@/lib/kitchen/cook-session";
import { initialCookState } from "@/lib/kitchen/cook-view";
import {
  markSignedOut,
  resetSignedOutForTests,
  SIGNED_OUT_COOK_NOTICE,
} from "@/lib/kitchen/signed-out";
import { createTimerStore } from "@/lib/kitchen/timer-store";
import { legacyToPackRecipe } from "@/lib/pack-convert/convert";
import { consumeCorruptionNotices, type StringStore } from "@/lib/persist/safe-storage";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { CookScreen } from "./CookScreen";
import {
  KitchenTimersProvider,
  TimerNotices,
  useKitchenTimers,
  type KitchenTimers,
} from "./KitchenTimers";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    chatCooking: {
      useMutation: () => ({
        mutateAsync: vi.fn(),
        isPending: false,
      }),
    },
    getRecentCookingItems: {
      useQuery: () => ({ data: [] }),
    },
  },
}));

// happy-dom has no font loading; CookFlow listens for document.fonts.
const fonts = Object.assign(new EventTarget(), {
  status: "loaded" as "loading" | "loaded",
  ready: Promise.resolve(),
});
Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

const RECIPE: KitchenQueueRecipeData = {
  name: "Sweet Zucchini Wraps",
  ...ZUCCHINI_RECIPE,
  serves: 4,
};

const converted = legacyToPackRecipe(RECIPE, { id: "zucchini-wraps" });
if (!converted.ok) throw new Error(JSON.stringify(converted.issues));
const PACK_RECIPE = converted.recipe;

const SESSION: CookSession = {
  plan: identityPlan(ZUCCHINI_RECIPE),
  source: { kind: "as-written", reason: "failed" },
  state: initialCookState("first"),
  settled: true,
};

function memoryStore(): StringStore {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

let kitchenRef: KitchenTimers;
function KitchenProbe() {
  const value = useKitchenTimers();
  useLayoutEffect(() => {
    kitchenRef = value;
  });
  return null;
}

function noticeTexts(container: HTMLElement): string[] {
  const block = container.querySelector("[data-cook-root] [data-notices]");
  if (!block) return [];
  return [...block.querySelectorAll("p")].map((p) => p.textContent ?? "");
}

beforeEach(() => {
  resetSignedOutForTests();
  consumeCorruptionNotices();
  Element.prototype.scrollIntoView = () => {};
  // happy-dom has no 2D canvas context; CookSheet uses measureText for strip labels.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        font: "",
        measureText: (text: string) => ({ width: text.length * 8 }),
      }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSignedOutForTests();
  consumeCorruptionNotices();
});

describe("NOTICE-1: CookScreen extraNotices and cook page signed-out and cap notices", () => {
  it("shows extraNotices after kitchen notices and never puts them in the kitchen timers store or home notices", () => {
    const store = createTimerStore(memoryStore());
    const session = memoryStore();
    const extra = ["Signed out. Sign in again after this cook.", "Monthly AI allowance reached."];

    const { container } = render(
      <KitchenTimersProvider store={store} claims={memoryStore()} session={session}>
        <KitchenProbe />
        <div data-home-notices="">
          <TimerNotices />
        </div>
        <CookScreen
          recipe={RECIPE}
          packRecipe={PACK_RECIPE}
          session={SESSION}
          dispatch={() => {}}
          onFinish={() => {}}
          finish="ready"
          showRecentItems={false}
          extraNotices={extra}
        />
      </KitchenTimersProvider>,
    );

    // Before any kitchen notice, CookScreen shows the extra notices and the timers store has none.
    expect(noticeTexts(container)).toEqual(extra);
    expect(kitchenRef.notices).toEqual([]);
    expect(container.querySelector("[data-home-notices] [data-notices]")).toBeNull();

    // When a kitchen notice is added, it appears before extraNotices, and only it appears in the timers store.
    act(() => {
      kitchenRef.say("Saved timers couldn't be read and were reset.");
    });

    expect(noticeTexts(container)).toEqual([
      "Saved timers couldn't be read and were reset.",
      ...extra,
    ]);
    expect(kitchenRef.notices).toEqual(["Saved timers couldn't be read and were reset."]);

    const home = container.querySelector("[data-home-notices]") as HTMLElement;
    expect(within(home).getByText("Saved timers couldn't be read and were reset.")).toBeTruthy();
    for (const line of extra) {
      expect(within(home).queryByText(line)).toBeNull();
    }
  });

  it("shows the signed-out line on the cook screen only while signed out, ahead of any plan cap notice", () => {
    let recordError!: (err: unknown) => void;
    function CookPageNoticesHarness() {
      const { extraNotices, recordPlanError } = useCookNotices();
      useLayoutEffect(() => {
        recordError = recordPlanError;
      });
      return (
        <CookScreen
          recipe={RECIPE}
          packRecipe={PACK_RECIPE}
          session={SESSION}
          dispatch={() => {}}
          onFinish={() => {}}
          finish="ready"
          showRecentItems={false}
          extraNotices={extraNotices}
        />
      );
    }

    const { container } = render(
      <KitchenTimersProvider store={createTimerStore(memoryStore())} claims={memoryStore()} session={memoryStore()}>
        <KitchenProbe />
        <div data-home-notices="">
          <TimerNotices />
        </div>
        <CookPageNoticesHarness />
      </KitchenTimersProvider>,
    );

    // Signed in and no cap error: no notices on the cook screen.
    expect(noticeTexts(container)).toEqual([]);

    // Cook plan fails with a real allowance refusal: notice shows on CookScreen only.
    const refusal = allowanceError("kitchen", new Date("2026-12-01T00:00:00.000Z"));
    act(() => {
      recordError(refusal);
    });
    expect(noticeTexts(container)).toEqual([refusal.message]);

    // Session is then lost: the signed-out line appears first, ahead of the cap sentence.
    act(() => {
      markSignedOut();
    });
    expect(noticeTexts(container)).toEqual([SIGNED_OUT_COOK_NOTICE, refusal.message]);

    // Neither line ever leaks into the kitchen timers store or the home screen notice strip.
    expect(kitchenRef.notices).toEqual([]);
    expect(container.querySelector("[data-home-notices] [data-notices]")).toBeNull();
  });
});
