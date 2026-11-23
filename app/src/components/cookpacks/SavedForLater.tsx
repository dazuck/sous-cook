"use client";

import { BorrowedScreen } from "@/components/kitchen/BorrowedScreen";
import { EDGE_X } from "@/components/kitchen/cook-edge";
import { LABEL } from "@/components/kitchen/KitchenHome";
import { WIDTH } from "@/components/kitchen/ReportsPanel";
import { COOKPACKS_COPY } from "./copy";

export interface SavedIdeas {
  ideas: string[];
  /** The ideas doc couldn't be reached, so these are the cached copy. */
  stale: boolean;
}

/**
 * "Saved for later" (S-D1): the household's ideas list, the recipe backlog
 * doc, as the library's Ideas tab drew it, now a borrowed screen over the
 * shelf. A glance list, not a place: an idea is a line to read, not a way
 * in, so it has a row's hairline and height, its words at the meta's size
 * in ink so a pasted link wraps rather than runs off.
 */
export function SavedForLater({
  data,
  failed = false,
  back = COOKPACKS_COPY.backToCookpacks,
  onClose,
}: {
  data: SavedIdeas | undefined;
  /** The ideas couldn't be read, from the doc or the cache. */
  failed?: boolean;
  back?: string;
  onClose: () => void;
}) {
  return (
    <BorrowedScreen kind={COOKPACKS_COPY.saved} back={back} onClose={onClose}>
      <div className={`min-h-0 flex-1 overflow-y-auto pb-6 ${EDGE_X}`}>
        <div className={WIDTH}>
          {data === undefined ? (
            <p role="status" className={failed ? `${LABEL} text-ink` : LABEL}>
              {failed ? COOKPACKS_COPY.ideasFailed : COOKPACKS_COPY.ideasLoading}
            </p>
          ) : data.ideas.length === 0 ? (
            <p role="status" className={LABEL}>
              {COOKPACKS_COPY.ideasNone}
            </p>
          ) : (
            <>
              <p role="status" className={LABEL}>
                {COOKPACKS_COPY.ideasFrom(data.ideas.length)}
              </p>
              {data.stale && <p className={`mt-[calc(8*var(--cpx))] ${LABEL}`}>{COOKPACKS_COPY.ideasStale}</p>}
              <ul aria-label={COOKPACKS_COPY.saved} className="mt-[calc(20*var(--cpx))]">
                {data.ideas.map((idea, i) => (
                  <li
                    key={`${i}-${idea}`}
                    className="flex min-h-[var(--target)] items-center border-t border-ink/[.11] py-[calc(18*var(--cpx))] text-[length:var(--type-meta)] leading-snug font-medium text-ink [overflow-wrap:anywhere]"
                  >
                    {idea}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </BorrowedScreen>
  );
}
