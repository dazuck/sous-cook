"use client";

import { ReactNode } from "react";

interface KitchenLayoutProps {
  header: ReactNode;
  main: ReactNode;
  /** Beside `main`, under the header: the whole cook, when it has a pane. */
  side?: ReactNode;
}

export function KitchenLayout({ header, main, side }: KitchenLayoutProps) {
  return (
    <div className="h-[100dvh] flex flex-col bg-ground font-[family-name:var(--font-text)] text-ink overflow-hidden">
      {header}
      <div className="flex-1 min-h-0 flex">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{main}</div>
        {side}
      </div>
    </div>
  );
}
