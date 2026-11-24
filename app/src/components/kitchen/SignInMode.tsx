"use client";

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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

  useEffect(() => {
    if (!signInMode) return;

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
      clearSessionStorage();
      reload();
    };

    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      reload();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [signInMode, reload]);

  return (
    <SignInModeContext.Provider value={signInMode}>
      {children}
    </SignInModeContext.Provider>
  );
}
