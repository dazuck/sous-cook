"use client";

import type { ReactNode } from "react";
import { KitchenTimersProvider } from "@/components/kitchen/KitchenTimers";

/**
 * Every kitchen page runs under the kitchen's timers (slice B5a, A11), so a
 * timer started on the cook page counts, chimes and holds its alarm on the
 * kitchen and the shelf too.
 */
export default function KitchenSectionLayout({ children }: { children: ReactNode }) {
  return (
    <KitchenTimersProvider>
      {children}
    </KitchenTimersProvider>
  );
}
