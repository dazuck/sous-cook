"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { startSignIn, type StartSignInOutcome } from "@/lib/auth/device";

export const SIGN_IN_NETWORK_ERROR =
  "Couldn't reach Sous. Check the connection and try again.";

export const SIGN_IN_TOO_MANY_TRIES_ERROR =
  "Too many tries. Wait a few seconds, then try again.";

export const SIGN_IN_REFUSED_ERROR = "Sign-in didn't start. Try again.";

function outcomeMessage(outcome: StartSignInOutcome): string {
  switch (outcome) {
    case "network":
      return SIGN_IN_NETWORK_ERROR;
    case "too-many-tries":
      return SIGN_IN_TOO_MANY_TRIES_ERROR;
    case "refused":
      return SIGN_IN_REFUSED_ERROR;
    case "started":
      return "";
  }
}

export function SignInButton() {
  const [inFlight, setInFlight] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        setInFlight(false);
      }
    }

    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  async function handleClick() {
    setInFlight(true);
    setStatusMessage("");
    try {
      const outcome = await startSignIn();
      setStatusMessage(outcomeMessage(outcome));
      if (outcome !== "started") {
        setInFlight(false);
      }
    } catch {
      setStatusMessage(SIGN_IN_REFUSED_ERROR);
      setInFlight(false);
    }
  }

  return (
    <div className="mt-[var(--space-2)] flex flex-col items-start gap-[var(--space-3)]">
      <Button
        type="button"
        variant="primary"
        disabled={inFlight}
        onClick={handleClick}
      >
        Sign in with Google
      </Button>
      <p
        role="status"
        className="min-h-[1.35em] font-[family-name:var(--font-text)] text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft"
      >
        {statusMessage}
      </p>
    </div>
  );
}
