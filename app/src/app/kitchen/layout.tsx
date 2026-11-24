"use client";

import { useEffect, type ReactNode } from "react";
import { KitchenTimersProvider } from "@/components/kitchen/KitchenTimers";
import { SignInModeProvider } from "@/components/kitchen/SignInMode";
import { reportOutbox } from "@/hooks/useReportOutbox";

/**
 * Every kitchen page runs under sign-in mode awareness, the kitchen's timers
 * (slice B5a, A11), and the report outbox, so a timer started on the cook page
 * counts, chimes and holds its alarm on the kitchen and the shelf too, and
 * reports left waiting flush on load and when the connection returns.
 */
export default function KitchenSectionLayout({ children }: { children: ReactNode }) {
  useEffect(() => reportOutbox().start(), []);

  return (
    <SignInModeProvider>
      <KitchenTimersProvider>{children}</KitchenTimersProvider>
    </SignInModeProvider>
  );
}
