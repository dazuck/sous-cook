"use client";

import { useEffect, useRef, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { StoredSession } from "@/lib/kitchen/cook-session";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers/_app";

/** The queue item as the server answers an intake ask: as `getKitchenQueueItem` reads it. */
export type IntakeAnswer = inferRouterOutputs<AppRouter>["ensureIntake"];

/**
 * The cook page's ask for an item still waiting for intake (cook-fidelity
 * plan), once per page load, after the tablet's storage is read:
 *
 * - nothing kept for the item: `opening`, and the page waits on the answer;
 * - a session kept: `started`, the cook under way on the recipe as sent,
 *   which settles the row so (round-3 review, B1); the page doesn't wait.
 *
 * `answer` is the item the server answered with, which the page opens on;
 * never a read after it, which may have failed (C2). `asked` is true once the
 * ask has answered or failed; a failed ask leaves `answer` null and the cook
 * opens the recipe as sent.
 */
export function useIntakeAsk(
  id: string,
  pending: boolean,
  stored: StoredSession | null | undefined,
): { asked: boolean; answer: IntakeAnswer | null } {
  const { mutate } = trpc.ensureIntake.useMutation();
  const askedFor = useRef<string | null>(null);
  const [state, setState] = useState<{ asked: boolean; answer: IntakeAnswer | null }>({
    asked: false,
    answer: null,
  });
  useEffect(() => {
    if (!pending || stored === undefined || askedFor.current === id) return;
    askedFor.current = id;
    mutate(
      { queueId: id, ask: stored === null ? "opening" : "started" },
      {
        onSuccess: (answer) => setState({ asked: true, answer }),
        onError: (err) => {
          console.error(`Intake for queue item ${id} failed; cooking the recipe as sent:`, err);
          setState({ asked: true, answer: null });
        },
      },
    );
  }, [pending, stored, id, mutate]);
  return state;
}
