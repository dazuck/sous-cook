import type { ContentsEntry } from "@/lib/shelf/view";

/**
 * One line of a book's contents: the chapter's name as the pack writes it,
 * a dotted leader (the amount pair's dotted rule, ink at 30%) and the count
 * of its recipes that cook, in ink-soft. Read, not tapped, on the shelf; in
 * the chapters menu the same three parts sit in a target-tall button.
 */
export function ContentsLine({ entry, here = false }: { entry: ContentsEntry; here?: boolean }) {
  return (
    <>
      <span className="min-w-0 truncate">{entry.title}</span>
      <span
        aria-hidden
        className="min-w-[calc(14*var(--cpx))] flex-1 translate-y-[calc(-6*var(--cpx))] border-b-[length:calc(2*var(--cpx))] border-dotted border-ink/[.3]"
      />
      <span className={`shrink-0 tabular-nums ${here ? "text-ink" : "text-ink-soft"}`}>
        <span className="sr-only">, </span>
        {entry.count}
      </span>
    </>
  );
}
