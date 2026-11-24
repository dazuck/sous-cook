"use client";

import { useEffect, useState } from "react";
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

export function SignOutItem({
  rowClassName,
  outbox = reportOutbox,
}: {
  rowClassName: string;
  outbox?: () => ReportOutbox;
}) {
  const signInMode = useSignInMode();
  if (!signInMode) return null;
  return <SignOutRow rowClassName={rowClassName} outbox={outbox} />;
}

function SignOutRow({
  rowClassName,
  outbox,
}: {
  rowClassName: string;
  outbox: () => ReportOutbox;
}) {
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

  const handleClick = () => {
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

  return (
    <>
      <button
        type="button"
        role="menuitem"
        aria-disabled={inFlight ? "true" : undefined}
        onClick={handleClick}
        className={rowClassName}
      >
        <SignOutGlyph />
        <span>
          {armed && unsent > 0
            ? SIGN_OUT_COPY.armed(unsent)
            : SIGN_OUT_COPY.item}
        </span>
      </button>
      {message !== null && (
        <p
          role="status"
          className="px-[calc(22*var(--cpx))] text-[length:var(--type-meta)] leading-tight text-ink-soft"
        >
          {message}
        </p>
      )}
    </>
  );
}

function SignOutGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[calc(26*var(--cpx))] shrink-0"
    >
      <path d="M10 4.5H7a2.5 2.5 0 0 0-2.5 2.5v10A2.5 2.5 0 0 0 7 19.5h3" />
      <path d="M14.5 8.5 18 12l-3.5 3.5M18 12H9.5" />
    </svg>
  );
}
