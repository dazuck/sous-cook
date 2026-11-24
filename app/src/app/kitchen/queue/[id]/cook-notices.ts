"use client";

import { useCallback, useMemo, useState } from "react";
import { allowanceSentence } from "@/lib/kitchen/allowance";
import { SIGNED_OUT_COOK_NOTICE, useSignedOut } from "@/lib/kitchen/signed-out";

/**
 * Extra notices shown on the cook screen after the kitchen's own notices:
 * the signed-out line while the session store reports signed out, and the
 * server's allowance sentence when asking for a cook plan hits the monthly AI
 * cap. Neither is persisted to the saved cook session.
 */
export function useCookNotices(): {
  extraNotices: readonly string[];
  recordPlanError: (err: unknown) => void;
} {
  const signedOut = useSignedOut();
  const [planCapNotice, setPlanCapNotice] = useState<string | null>(null);

  const recordPlanError = useCallback((err: unknown) => {
    const sentence = allowanceSentence(err);
    if (sentence !== null) {
      setPlanCapNotice(sentence);
    }
  }, []);

  const extraNotices = useMemo<readonly string[]>(() => {
    const lines: string[] = [];
    if (signedOut) lines.push(SIGNED_OUT_COOK_NOTICE);
    if (planCapNotice !== null) lines.push(planCapNotice);
    return lines;
  }, [signedOut, planCapNotice]);

  return { extraNotices, recordPlanError };
}
