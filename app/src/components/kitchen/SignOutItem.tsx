"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { reportOutbox, useReportOutbox } from "@/hooks/useReportOutbox";
import type { ReportOutbox } from "@/lib/kitchen/report-outbox";
import { CLEAR_ARM_MS } from "./ShoppingListModal";
import { useLetGo, useSignInMode } from "./SignInMode";

export const SIGN_OUT_COPY = {
  item: "Sign out",
  armed: (count: number): string =>
    count === 1
      ? "1 report not sent yet. Tap again to sign out and remove it."
      : `${count} reports not sent yet. Tap again to sign out and remove them.`,
  network: "Couldn't sign out. Check the connection and try again.",
  refused: "Couldn't sign out. Try again in a moment.",
} as const;

interface SignOutState {
  /** The row's words: Sign out, or while armed what a second tap would remove. */
  label: string;
  inFlight: boolean;
  /** Why the last sign-out failed, until the next tap. */
  message: string | null;
  onClick: () => void;
}

const SignOutContext = createContext<SignOutState | null>(null);

/**
 * Sign out for one open menu: armed, in flight, or saying why it failed. It lives only in sign-in
 * mode, where it reads the report outbox; elsewhere its row and its status draw nothing and the
 * outbox is never read. Mounted with the menu, so a menu closed and opened again starts disarmed.
 */
export function SignOutScope({
  outbox = reportOutbox,
  children,
}: {
  outbox?: () => ReportOutbox;
  children: ReactNode;
}) {
  const signInMode = useSignInMode();
  if (!signInMode) return <>{children}</>;
  return <SignOutLive outbox={outbox}>{children}</SignOutLive>;
}

function SignOutLive({
  outbox,
  children,
}: {
  outbox: () => ReportOutbox;
  children: ReactNode;
}) {
  const state = useSignOutState(outbox);
  return (
    <SignOutContext.Provider value={state}>{children}</SignOutContext.Provider>
  );
}

function useSignOutState(outbox: () => ReportOutbox): SignOutState {
  const letGo = useLetGo();
  const entries = useReportOutbox(outbox);
  const unsent = entries.filter(
    (entry) =>
      entry.status === "waiting" ||
      (entry.status === "sent" && entry.note !== entry.sentNote),
  ).length;

  const [armed, setArmed] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CLEAR_ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  const runSignOut = async () => {
    let outcome: "signed-out" | "network" | "refused";
    try {
      const { signOutOfDevice } = await import("@/lib/auth/device");
      outcome = await signOutOfDevice(
        undefined,
        undefined,
        letGo ?? undefined,
      );
    } catch {
      setMessage(SIGN_OUT_COPY.network);
      setInFlight(false);
      return;
    }

    if (outcome === "signed-out") {
      return;
    }
    setMessage(
      outcome === "refused" ? SIGN_OUT_COPY.refused : SIGN_OUT_COPY.network,
    );
    setInFlight(false);
  };

  const onClick = () => {
    if (inFlight) return;
    if (unsent > 0 && !armed) {
      setArmed(true);
      setMessage(null);
      return;
    }
    setArmed(false);
    setMessage(null);
    setInFlight(true);
    void runSignOut();
  };

  return {
    label: armed && unsent > 0 ? SIGN_OUT_COPY.armed(unsent) : SIGN_OUT_COPY.item,
    inFlight,
    message,
    onClick,
  };
}

/**
 * The menu's Sign out row: its words, then `icon` in the menu's glyph cell. While armed, the words
 * are the reports a second tap would remove, three lines in the panel's row.
 */
export function SignOutRow({
  rowClassName,
  icon,
}: {
  rowClassName: string;
  icon?: ReactNode;
}) {
  const s = useContext(SignOutContext);
  if (s === null) return null;
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={s.inFlight ? "true" : undefined}
      onClick={s.onClick}
      className={rowClassName}
    >
      {/*
        The room a one-line row has above and below its words (the row's height less one line of
        them, halved), kept when the armed count runs to three lines.
      */}
      <span className="flex-1 py-[calc((var(--target)-1.25*var(--type-meta))/2)]">{s.label}</span>
      {icon}
    </button>
  );
}

/**
 * Why the last Sign out failed, as a line outside the menu (a menu holds only rows). The live
 * region is there from the moment the menu opens, empty until a try fails, so the reason is
 * announced when it arrives; the line itself is drawn only with a reason in it.
 */
export function SignOutStatus({ className }: { className: string }) {
  const s = useContext(SignOutContext);
  if (s === null) return null;
  return (
    <div role="status">
      {s.message !== null && <p className={className}>{s.message}</p>}
    </div>
  );
}
