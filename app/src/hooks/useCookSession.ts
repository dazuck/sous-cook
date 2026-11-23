"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, type Dispatch } from "react";
import { reduceSession, type CookAction, type CookSession } from "@/lib/kitchen/cook-session";
import { recordEvent, recordStep } from "@/lib/kitchen/report-events";

/**
 * The cook session, with its open and each move logged for a flag's lead-up
 * (B2 decision 9). StrictMode runs the reducer twice, so moves are logged
 * here, once per action, with the place each leaves the cook: worked out
 * from the last one sent, as the reducer is pure and React applies them in
 * the order they were sent.
 */
export function useCookSession(
  recipeName: string,
  init: () => CookSession,
  /**
   * Keeps the session on the tablet (slice B5b): called as it opens and after
   * each change, so a reload resumes where the cook was.
   */
  keep?: (session: CookSession) => void,
): [CookSession, Dispatch<CookAction>] {
  const [session, dispatch] = useReducer(reduceSession, null, init);

  const latest = useRef(session);
  useLayoutEffect(() => {
    latest.current = session;
  });

  const keepRef = useRef(keep);
  useLayoutEffect(() => {
    keepRef.current = keep;
  });
  useEffect(() => {
    keepRef.current?.(session);
  }, [session]);

  // StrictMode runs effects twice on mount; refs live through it.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    recordEvent("cook", `open ${recipeName}`);
  }, [recipeName]);

  const recorded = useCallback((action: CookAction) => {
    const next = reduceSession(latest.current, action);
    latest.current = next;
    recordStep(action, next.state.pos);
    dispatch(action);
  }, []);

  return [session, recorded];
}
