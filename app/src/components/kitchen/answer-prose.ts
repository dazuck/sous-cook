/**
 * Sous's answer in the Ask panel, written in markdown and set in the
 * panel's type. Every colour prose gives what plain markdown can write is a
 * DS token: a code block is a sand block of ink, inline code a sand chip,
 * quotes ink beside a sand rule, and a rule sand.
 * Its own module so the e2e can set an answer's markup under it
 * (ask.spec.ts).
 */
export const ANSWER_PROSE =
  "prose max-w-none break-words text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink [--tw-prose-body:var(--ink)] [--tw-prose-headings:var(--ink)] [--tw-prose-bold:var(--ink)] [--tw-prose-links:var(--ink)] [--tw-prose-code:var(--ink)] [--tw-prose-bullets:var(--ink-soft)] [--tw-prose-counters:var(--ink-soft)] [--tw-prose-pre-bg:var(--sand)] [--tw-prose-pre-code:var(--ink)] [--tw-prose-hr:var(--sand)] [--tw-prose-quotes:var(--ink)] [--tw-prose-quote-borders:var(--sand)] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose-p:my-2 prose-p:text-[length:var(--type-meta)] prose-p:leading-[1.35] prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-li:text-[length:var(--type-meta)] prose-li:leading-[1.35] prose-headings:font-semibold prose-headings:text-[length:var(--type-chip)] prose-headings:leading-[1.2] prose-lead:text-[length:var(--type-chip)] prose-h1:text-[length:var(--type-chip)] prose-h2:text-[length:var(--type-chip)] prose-h3:text-[length:var(--type-chip)] prose-strong:font-semibold prose-pre:rounded-[var(--radius-2)] prose-pre:text-[length:var(--type-meta)] [&_:not(pre)>code]:rounded-[var(--radius-1)] [&_:not(pre)>code]:bg-sand [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 prose-code:text-[length:var(--type-meta)] prose-code:font-medium prose-code:before:content-none prose-code:after:content-none";
