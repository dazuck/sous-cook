// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredSession } from "@/lib/kitchen/cook-session";
import { useIntakeAsk } from "./useIntakeAsk";

type Callbacks = { onSuccess: (item: unknown) => void; onError: (err: Error) => void };

// The mutation is the network edge: each send's callbacks are kept so a test
// can answer it as the server would, or fail it as the network would.
const mutation = { mutate: vi.fn<(input: unknown, callbacks: Callbacks) => void>() };

vi.mock("@/lib/trpc", () => ({
  trpc: { ensureIntake: { useMutation: () => mutation } },
}));

const KEPT = { fingerprint: "f" } as unknown as StoredSession;
const CUT_ITEM = { id: "42", intake: { state: "normalized", error: null } };

beforeEach(() => {
  mutation.mutate.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function answer(outcome: "onSuccess" | "onError", item: unknown = CUT_ITEM) {
  const [, callbacks] = mutation.mutate.mock.lastCall!;
  act(() => {
    if (outcome === "onSuccess") callbacks.onSuccess(item);
    else callbacks.onError(new Error("offline"));
  });
}

describe("useIntakeAsk", () => {
  it("nothing kept: asks once as the cook opens, and opens on the item the answer carries, with no re-read", () => {
    const { result, rerender } = renderHook(({ pending }) => useIntakeAsk("42", pending, null), {
      initialProps: { pending: true },
    });
    expect(mutation.mutate).toHaveBeenCalledWith({ queueId: "42", ask: "opening" }, expect.anything());
    expect(result.current).toEqual({ asked: false, answer: null });

    answer("onSuccess");
    expect(result.current).toEqual({ asked: true, answer: CUT_ITEM });

    // A later read still saying pending (a failed re-read) asks nothing more.
    rerender({ pending: true });
    expect(mutation.mutate).toHaveBeenCalledTimes(1);
  });

  it("a session kept: says the cook is under way on the recipe as sent (no model call server-side)", () => {
    renderHook(() => useIntakeAsk("42", true, KEPT));
    expect(mutation.mutate).toHaveBeenCalledWith({ queueId: "42", ask: "started" }, expect.anything());
  });

  it("a failed ask: asked, no answer, logged, so the cook opens as sent", () => {
    const { result } = renderHook(() => useIntakeAsk("42", true, null));
    answer("onError");
    expect(result.current).toEqual({ asked: true, answer: null });
    expect(console.error).toHaveBeenCalledWith(
      "Intake for queue item 42 failed; cooking the recipe as sent:",
      expect.any(Error),
    );
  });

  it("asks nothing for an item not waiting, or before the tablet's storage is read", () => {
    renderHook(() => useIntakeAsk("42", false, null));
    renderHook(() => useIntakeAsk("42", true, undefined));
    expect(mutation.mutate).not.toHaveBeenCalled();
  });
});
