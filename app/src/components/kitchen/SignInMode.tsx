"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { reportOutbox } from "@/hooks/useReportOutbox";
import { timerStore } from "@/lib/kitchen/timer-store";
import { readSignInModeCookie } from "@/lib/kitchens/mode";

const SignInModeContext = createContext<boolean>(false);

/**
 * Reports whether the current kitchen page is running in sign-in mode, based
 * on the mode cookie read by `SignInModeProvider`. Outside the provider this
 * defaults to false (single-kitchen mode).
 */
export function useSignInMode(): boolean {
  return useContext(SignInModeContext);
}

function subscribeNoop(): () => void {
  return () => {};
}

function readModeSnapshot(): boolean {
  return readSignInModeCookie(document.cookie);
}

function readModeServerSnapshot(): boolean {
  return false;
}

function defaultReload(): void {
  window.location.reload();
}

function isSecurityError(err: unknown): boolean {
  const isDomException =
    err instanceof DOMException ||
    (typeof window !== "undefined" &&
      typeof window.DOMException === "function" &&
      err instanceof window.DOMException);
  return isDomException && err.name === "SecurityError";
}

function clearSessionStorage(): void {
  try {
    window.sessionStorage.clear();
  } catch (err) {
    if (isSecurityError(err)) {
      return;
    }
    throw err;
  }
}

export function SignInModeProvider({
  children,
  reload = defaultReload,
}: {
  children: ReactNode;
  reload?: () => void;
}) {
  const signInMode = useSyncExternalStore(
    subscribeNoop,
    readModeSnapshot,
    readModeServerSnapshot,
  );
  const queryClient = useContext(QueryClientContext);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!signInMode) return;

    const prepareForReload = (clearSession: boolean) => {
      reportOutbox().forget();
      timerStore.reload();
      if (queryClient) {
        void queryClient.cancelQueries();
        queryClient.clear();
      }
      setReloading(true);
      if (clearSession) {
        clearSessionStorage();
      }
      reload();
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== null) return;
      let local: Storage;
      try {
        local = window.localStorage;
      } catch (err) {
        if (isSecurityError(err)) return;
        throw err;
      }
      if (event.storageArea !== local) return;
      prepareForReload(true);
    };

    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      prepareForReload(false);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [signInMode, queryClient, reload]);

  return (
    <SignInModeContext.Provider value={signInMode}>
      {reloading ? null : children}
    </SignInModeContext.Provider>
  );
}
