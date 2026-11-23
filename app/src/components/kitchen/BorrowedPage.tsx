"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { markReturn, takeReturn } from "@/lib/kitchen/return-focus";
import { KindLine } from "./BorrowedScreen";
import { topLayer } from "./layers";

interface BorrowedPageProps {
  /** The kind line: what the page is ("Cookpacks"). */
  kind: string;
  /** The top-left back link: where it goes back to, in words and as a route. */
  back: { label: string; href: string };
  /**
   * The mark the page it goes back to focuses (`data-return-focus`), so
   * focus lands on what opened this page.
   */
  returnKey?: string;
  /**
   * Whether what a returning focus lands on is drawn yet (data loaded). The
   * page takes the returning focus once, when this turns true.
   */
  ready?: boolean;
  children: ReactNode;
}

/**
 * A route drawn in the borrowed-screen grammar: the top-left back link and
 * kind line at the top, and the content filling the body. It shares
 * `BorrowedScreen`'s kind line, but it is a page, not a dialog: no
 * `role="dialog"`, no focus trap, and the back control is a route link.
 * Escape does what the back link does, unless a layer over the page (a
 * borrowed screen, an open menu) takes it.
 */
export function BorrowedPage({ kind, back, returnKey, ready = true, children }: BorrowedPageProps) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const leave = useRef(() => {});
  useEffect(() => {
    leave.current = () => {
      if (returnKey !== undefined) markReturn(returnKey);
      router.push(back.href);
    };
  });

  useEffect(() => {
    rootRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (topLayer() !== null) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("[data-holds-keys]")) return;
      if (document.querySelector("[data-holds-keys]:not(input, textarea)") !== null) return;
      e.preventDefault();
      leave.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const took = useRef(false);
  useEffect(() => {
    if (!ready || took.current) return;
    took.current = true;
    takeReturn(rootRef.current ?? document);
  }, [ready]);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="fixed inset-0 flex flex-col bg-ground font-[family-name:var(--font-text)] text-ink outline-none"
    >
      <KindLine
        kind={kind}
        as="h1"
        back={{
          label: back.label,
          href: back.href,
          onClick: () => {
            if (returnKey !== undefined) markReturn(returnKey);
          },
        }}
      />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
