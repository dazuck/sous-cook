"use client";

import { forwardRef, type ReactNode } from "react";

// Chat primitives to the design system: Sous speaks as ink
// text straight on paper; only the cook's words sit in a sand bubble. No
// avatars, shadows, tails or bounces.

// ============================================================================
// CHAT BUBBLE
// ============================================================================

interface ChatBubbleProps {
  variant: "assistant" | "user";
  children: ReactNode;
  /**
   * How much of the thread's width a turn may take (default: 85%, and 70%
   * on a wide screen). A narrow thread (Ask's side panel) gives its own.
   */
  width?: string;
  className?: string;
}

export function ChatBubble({
  variant,
  children,
  width = "max-w-[85%] lg:max-w-[70%]",
  className = "",
}: ChatBubbleProps) {
  const variantClasses =
    variant === "assistant"
      ? "py-1"
      : "rounded-[var(--radius-3)] bg-sand px-5 py-3";

  return (
    <div
      className={`${width} text-ink ${variantClasses} ${className}`}
    >
      {children}
    </div>
  );
}

// ============================================================================
// CHAT LOADING INDICATOR
// ============================================================================
// Sous speaking (§5): the ember dot breathing, in the place the answer will
// take.

interface ChatLoadingIndicatorProps {
  /** Read to a screen reader while the answer is on its way. */
  label: string;
  className?: string;
}

export function ChatLoadingIndicator({
  label,
  className = "",
}: ChatLoadingIndicatorProps) {
  return (
    <div role="status" className={`py-2 ${className}`}>
      <span className="sr-only">{label}</span>
      <span
        aria-hidden
        className="block size-[calc(14*var(--cpx))] animate-dot-breathe rounded-full bg-ember motion-reduce:animate-none"
      />
    </div>
  );
}

// ============================================================================
// CHAT INPUT
// ============================================================================
// A paper field on the sand strip. Send is the panel's one ember, waiting in
// sand with an ink-soft arrow until there is something to send; the mic is
// ink, filled while it listens.

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Whether Send is drawn (default: always). Ask's panel on the cook screen
   * draws it only once there are words to send, when it takes the room the
   * camera and the mic stood in.
   */
  send?: boolean;
  /** The text box's name for a screen reader, where the hint alone does not say it. */
  label?: string;
  className?: string;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
}

const ROUND =
  "flex size-[var(--target)] min-h-[var(--target)] min-w-[var(--target)] shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors duration-[320ms] ease-[var(--ease)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

export const ChatInput = forwardRef<HTMLInputElement, ChatInputProps>(
  function ChatInput(
    {
      value,
      onChange,
      onSubmit,
      placeholder = "Type your reply...",
      disabled = false,
      send = true,
      label,
      className = "",
      onFocus,
      onBlur,
    },
    ref,
  ) {
    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if (value.trim() && !disabled) {
        onSubmit();
      }
    };

    return (
      <form onSubmit={handleSubmit} className={className}>
        {/* The field rings with its text box, not with a tapped mic or send:
            those carry their own rings. A text box matches :focus-visible
            however it was focused, since it takes typing. */}
        <div className="flex min-h-[var(--target)] items-center gap-2 rounded-full border border-ink/[.11] bg-paper px-2 py-1 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ink">
          <input
            ref={ref}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={onFocus}
            onBlur={onBlur}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={label}
            className="min-h-[calc(64*var(--cpx))] min-w-0 flex-1 border-none bg-transparent px-4 py-2 text-[length:var(--type-meta)] leading-tight font-medium text-ink outline-none placeholder:text-ink-soft focus:ring-0 disabled:text-ink-soft"
          />

          {send && (
          <button
            type="submit"
            aria-label="Send"
            disabled={disabled || !value.trim()}
            className={`${ROUND} bg-ember text-paper active:bg-ember-700 disabled:cursor-not-allowed disabled:bg-sand disabled:text-ink-soft`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="size-[calc(22*var(--cpx))]"
            >
              <path
                fillRule="evenodd"
                d="M11.47 2.47a.75.75 0 011.06 0l7.5 7.5a.75.75 0 11-1.06 1.06l-6.22-6.22V21a.75.75 0 01-1.5 0V4.81l-6.22 6.22a.75.75 0 11-1.06-1.06l7.5-7.5z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          )}
        </div>
      </form>
    );
  },
);

// ============================================================================
// CHAT QUICK REPLIES
// ============================================================================
// Sand pills, named for a screen reader rather than labelled on screen.

interface QuickReply {
  label: string;
  text: string;
}

interface ChatQuickRepliesProps {
  replies: QuickReply[];
  onSelect: (text: string) => void;
  /** The group's accessible name. */
  label: string;
  className?: string;
}

export function ChatQuickReplies({
  replies,
  onSelect,
  label,
  className = "",
}: ChatQuickRepliesProps) {
  if (replies.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={label}
      className={`flex gap-2 overflow-x-auto scrollbar-hide ${className}`}
    >
      {replies.map((reply) => (
        <button
          key={reply.text}
          onClick={() => onSelect(reply.text)}
          className="min-h-[var(--target)] shrink-0 cursor-pointer rounded-full bg-sand px-[calc(24*var(--cpx))] py-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold text-ink transition-colors duration-[320ms] ease-[var(--ease)] active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
        >
          {reply.label}
        </button>
      ))}
    </div>
  );
}
