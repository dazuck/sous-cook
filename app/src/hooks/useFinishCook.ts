import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FinishState } from "@/components/kitchen/CookFlow";
import { recordEvent } from "@/lib/kitchen/report-events";
import { trpc } from "@/lib/trpc";

/**
 * Finishing marks the item cooked and goes back to the kitchen. Once saved
 * it stays "saving" while the page leaves; a failure says so on the finish
 * control, which tries again. One save is sent at a time: a tap and a spoken
 * "done" can both land before "saving" renders, so the second is dropped
 * here rather than left to the control. The finish reads "saving" from the
 * tap itself, in the same render as whatever the tap's caller changed, not
 * from the mutation's state a render later.
 */
export function useFinishCook(
  queueId: string,
  /** The save landed, before the page leaves: the kept cook session ends (B5b). */
  onSaved?: () => void,
): {
  finish: FinishState;
  finishCook: () => void;
} {
  const router = useRouter();
  const {
    mutate: updateStatus,
    isPending,
    isSuccess,
    isError,
  } = trpc.updateKitchenQueueStatus.useMutation();
  const [sent, setSent] = useState(false);
  const finish: FinishState =
    sent || isPending || isSuccess ? "saving" : isError ? "failed" : "ready";

  const onSavedRef = useRef(onSaved);
  useLayoutEffect(() => {
    onSavedRef.current = onSaved;
  });

  const sending = useRef(false);
  const finishCook = useCallback(() => {
    if (sending.current) return;
    sending.current = true;
    setSent(true);
    recordEvent("cook", "finish");
    updateStatus(
      { queueId, status: "completed" },
      {
        onSuccess: () => {
          onSavedRef.current?.();
          router.push("/kitchen");
        },
        onError: (err) => {
          sending.current = false;
          setSent(false);
          recordEvent("cook", "finish failed");
          console.error("Could not mark the recipe cooked:", err);
        },
      },
    );
  }, [updateStatus, queueId, router]);

  return { finish, finishCook };
}
