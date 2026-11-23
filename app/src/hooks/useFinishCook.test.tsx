// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recentEvents, resetEventLog } from "@/lib/kitchen/report-events";
import { useFinishCook } from "./useFinishCook";

type Callbacks = { onSuccess: () => void; onError: (err: Error) => void };

// The mutation is the network edge: its state is what the server said, and
// each send's callbacks are kept so a test can answer it.
const mutation = {
  mutate: vi.fn<(input: unknown, callbacks: Callbacks) => void>(),
  isPending: false,
  isSuccess: false,
  isError: false,
};
const push = vi.fn();

vi.mock("@/lib/trpc", () => ({
  trpc: { updateKitchenQueueStatus: { useMutation: () => mutation } },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => {
  mutation.mutate.mockReset();
  mutation.isPending = mutation.isSuccess = mutation.isError = false;
  push.mockReset();
  resetEventLog();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** Answers the latest send. */
function answer(outcome: keyof Callbacks) {
  const [, callbacks] = mutation.mutate.mock.lastCall!;
  act(() => {
    if (outcome === "onSuccess") callbacks.onSuccess();
    else callbacks.onError(new Error("offline"));
  });
}

describe("useFinishCook", () => {
  it("marks the item cooked, then goes back to the kitchen", () => {
    const { result } = renderHook(() => useFinishCook("42"));
    act(() => result.current.finishCook());
    expect(mutation.mutate).toHaveBeenCalledWith(
      { queueId: "42", status: "completed" },
      expect.anything(),
    );
    answer("onSuccess");
    expect(push).toHaveBeenCalledWith("/kitchen");
  });

  it("says when the save landed, before leaving, and not when it failed (B5b: Finish ends the kept session)", () => {
    const saved = vi.fn(() => expect(push).not.toHaveBeenCalled());
    const { result } = renderHook(() => useFinishCook("42", saved));
    act(() => result.current.finishCook());
    answer("onError");
    expect(saved).not.toHaveBeenCalled();
    act(() => result.current.finishCook());
    answer("onSuccess");
    expect(saved).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/kitchen");
  });

  it("sends once when a tap and a spoken 'done' land before saving shows", () => {
    const { result } = renderHook(() => useFinishCook("42"));
    act(() => {
      result.current.finishCook();
      result.current.finishCook();
    });
    expect(mutation.mutate).toHaveBeenCalledTimes(1);
  });

  it("sends again after a failed save, and never after a saved one", () => {
    const { result } = renderHook(() => useFinishCook("42"));
    act(() => result.current.finishCook());
    answer("onError");
    act(() => result.current.finishCook());
    expect(mutation.mutate).toHaveBeenCalledTimes(2);

    answer("onSuccess");
    act(() => result.current.finishCook());
    expect(mutation.mutate).toHaveBeenCalledTimes(2);
  });

  it("logs each save it sends, and a failed one, for a flag's lead-up (B2)", () => {
    const { result } = renderHook(() => useFinishCook("42"));
    act(() => {
      result.current.finishCook();
      result.current.finishCook();
    });
    answer("onError");
    expect(recentEvents().map((e) => [e.kind, e.detail])).toEqual([
      ["cook", "finish"],
      ["cook", "finish failed"],
    ]);
  });

  it("reads saving from the tap itself, before the mutation says so, and failed once it fails", () => {
    const { result } = renderHook(() => useFinishCook("42"));
    act(() => result.current.finishCook());
    // The mutation's own state hasn't moved yet (it is still "ready" here).
    expect(result.current.finish).toBe("saving");
    mutation.isError = true;
    answer("onError");
    expect(result.current.finish).toBe("failed");
    // A retry reads saving at once, though the last answer was a failure.
    act(() => result.current.finishCook());
    expect(result.current.finish).toBe("saving");
  });

  it.each([
    [{}, "ready"],
    [{ isPending: true }, "saving"],
    // Saved stays saving while the page leaves.
    [{ isSuccess: true }, "saving"],
    [{ isError: true }, "failed"],
  ] as const)("reads %o as %s", (state, finish) => {
    Object.assign(mutation, state);
    const { result } = renderHook(() => useFinishCook("42"));
    expect(result.current.finish).toBe(finish);
  });
});
