"use client";

import { useRef } from "react";
import type { Cloth } from "@/lib/shelf/view";
import { CLOTH_EDGE, clothSurface } from "./cloth";
import { useWordFit } from "./word-fit";

/** A board's title is already at the floor, so it never steps down; a word too wide for the panel hyphenates. */
const BOARD_TITLE_SIZES = ["var(--type-meta)"] as const;

/**
 * A creator pack with no cover art, on the shelf: a cloth board (P53, P8 as
 * amended). Shelf size, 198 × 248 cpx, on the 8 cpx radius with no drop
 * shadow; the cloth's weave and sidelight, a hinge groove 14 cpx in from
 * the spine edge, and the title set by the system in a stamped panel,
 * optically centred: a 1 px paper hairline at 50% around Caprasimo at the
 * meta's 22 cpx in paper. The face carries only the title; the creator is
 * on the label under the shelf. Decorative to a screen reader: the link
 * around it names the book.
 */
export function ClothCover({ title, cloth }: { title: string; cloth: Cloth }) {
  const titleRef = useRef<HTMLSpanElement>(null);
  const titleStyle = useWordFit(titleRef, BOARD_TITLE_SIZES, title);
  return (
    <span
      aria-hidden
      data-cloth-cover={cloth}
      className={`relative block h-[calc(248*var(--cpx))] w-[calc(198*var(--cpx))] overflow-hidden rounded-[var(--radius-1)] ${CLOTH_EDGE}`}
      style={clothSurface(cloth)}
    >
      {/* The hinge: a groove 14 cpx in from the spine edge. */}
      <span className="absolute inset-y-0 left-[calc(14*var(--cpx))] w-[calc(3*var(--cpx))] bg-[linear-gradient(90deg,rgb(20_10_0/0.25),rgb(255_236_214/0.10))]" />
      <span className="absolute top-1/2 right-[calc(14*var(--cpx))] left-[calc(30*var(--cpx))] -translate-y-[58%] rounded-[calc(3*var(--cpx))] border border-paper/50 px-[calc(8*var(--cpx))] py-[calc(14*var(--cpx))] text-center">
        <span
          ref={titleRef}
          data-cover-title
          style={titleStyle}
          className="block font-[family-name:var(--font-display)] leading-[1.18] font-normal text-paper [font-synthesis:none]"
        >
          {title}
        </span>
      </span>
    </span>
  );
}
