"use client";

import Link from "next/link";
import { FOCUS } from "./control-style";
import { EDGE_X } from "./cook-edge";
import type { FootWord } from "@/lib/kitchen/home-view";

/**
 * A foot word (P64, F1): ink-soft at the meta's 22 cpx on a target-tall ghost,
 * its sand only while pressed. The words wrap, balanced, before anything gives
 * (a flex item that may take two lines), so no word shrinks below the floor,
 * drops or runs past the edge; the band's 96 cpx holds two lines of 22 cpx.
 */
const FOOT_WORD = `inline-flex min-h-[var(--target)] min-w-0 max-w-[48%] cursor-pointer items-center justify-center rounded-full px-[calc(26*var(--cpx))] text-center text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft [text-wrap:balance] transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand ${FOCUS}`;

/**
 * The idle foot's "Made recently" word hides only where the home's line already
 * names every made recipe (it would say it twice, D11); where the line is cut
 * (portrait names the newest only) the word stays, so the queue screen's
 * section is always reachable (verifier round 1, item 1).
 */
function hideWhenLineSaysAll({ landscape, portrait, total }: { landscape: number; portrait: number; total: number }): string {
  const hide = "group-not-data-[give-recent]/home:hidden";
  if (landscape >= total && portrait >= total) return hide;
  if (landscape >= total) return `landscape:${hide}`;
  if (portrait >= total) return `portrait:${hide}`;
  return "";
}

/** The Cookpacks shelf's route. */
export const COOKPACKS_HREF = "/kitchen/cookpacks";

/**
 * The kitchen home's foot: Cookpacks where back sits, the queue screen's word
 * where forward sits (P64, P65). Ask Sous joins it with B2a.
 */
export function HomeFoot({
  word,
  recentShown,
  cookpacks,
  onOpenQueue,
}: {
  word: FootWord;
  /** How many Made recently names the home's line draws in landscape and in portrait, of how many there are. */
  recentShown: { landscape: number; portrait: number; total: number };
  cookpacks: string;
  onOpenQueue: () => void;
}) {
  return (
    <footer
      data-home-foot
      className={`flex h-[var(--band-foot)] shrink-0 items-center justify-between gap-x-[var(--space-4)] ${EDGE_X}`}
    >
      <Link href={COOKPACKS_HREF} data-return-focus="cookpacks" className={`${FOOT_WORD} -ml-[calc(26*var(--cpx))]`}>
        {cookpacks}
      </Link>
      {word && (
        <button
          type="button"
          data-foot-queue
          data-return-focus="queue"
          onClick={onOpenQueue}
          // In the idle kitchen the word is the way to Made recently once the home's own line has
          // given way for room; while the line is drawn, the word would say it twice (D11).
          className={`${FOOT_WORD} -mr-[calc(26*var(--cpx))] ${word.kind === "made-recently" ? hideWhenLineSaysAll(recentShown) : ""}`}
        >
          {word.label}
        </button>
      )}
    </footer>
  );
}
