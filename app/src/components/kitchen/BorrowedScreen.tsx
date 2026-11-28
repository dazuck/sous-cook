"use client";

import type { ReactNode } from "react";
import type { VoiceEcho, VoiceStatus } from "@/hooks/useKitchenVoiceCommands";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import type { ReportScreen } from "@/lib/kitchen/report-capture";
import {
  BACK_TO_KITCHEN,
  BorrowedChrome,
  KindLine,
  LEDGE,
  LEDGE_BAR,
  LedgeBar,
  LedgeChevron,
} from "./BorrowedChrome";
import { FeedbackTrigger } from "./FeedbackDialog";
import { useSignInMode } from "./SignInMode";

function screenForBorrowedKind(kind: string): ReportScreen | undefined {
  const normalized = kind.trim().toLowerCase();
  if (normalized === "up next" || normalized === "queue") return "queue";
  if (normalized === "shopping list") return "shopping-list";
  if (normalized === "saved for later") return "saved";
  if (normalized.includes("import")) return "import";
  if (normalized.includes("ingredient") || normalized.includes("pantry")) return "pantry";
  return undefined;
}

export { BACK_TO_KITCHEN, KindLine, LEDGE, LEDGE_BAR, LedgeBar, LedgeChevron };

interface BorrowedScreenProps {
  /** The kind line: what borrowed the screen ("The whole cook"). */
  kind: string;
  /**
   * The voice dot's state: the screen covers the header, so the dot moves
   * here. Absent where the screen it covers has no dot (the hub).
   */
  voice?: { status: VoiceStatus; echo: VoiceEcho | null };
  /** The ledge's words: where it goes back to. "Back to cooking" by default. */
  back?: string;
  onClose: () => void;
  /** A control at the kind line's right end (the queue screen's Edit). */
  kindTrailing?: ReactNode;
  children: ReactNode;
}

/**
 * Something that takes the whole screen from the steps and gives it back, in
 * the borrowed-screen grammar (design/interaction-language.md §5): the kind
 * line top-left names the borrower beside the voice dot (the header's dot,
 * which the screen covers, in the same state; what it just heard shows after
 * the name), and the ledge, a sand capsule centred in the bottom 96 cpx
 * (`LEDGE_BAR`, R22), is the way back; the capsule alone is the target.
 *
 * Built on `BorrowedChrome`.
 */
export function BorrowedScreen({
  kind,
  voice,
  back = COOK_COPY.backToCooking,
  onClose,
  kindTrailing,
  children,
}: BorrowedScreenProps) {
  const signInMode = useSignInMode();
  const showHubFeedback =
    signInMode && back === BACK_TO_KITCHEN && kind !== "Flagged";
  const feedbackScreen = screenForBorrowedKind(kind);
  const trailing = showHubFeedback ? (
    kindTrailing ? (
      <div className="flex items-center gap-[var(--space-3)]">
        {kindTrailing}
        <FeedbackTrigger screen={feedbackScreen} />
      </div>
    ) : (
      <FeedbackTrigger screen={feedbackScreen} />
    )
  ) : (
    kindTrailing
  );

  return (
    <BorrowedChrome
      kind={kind}
      voice={voice}
      back={back}
      onClose={onClose}
      kindTrailing={trailing}
    >
      {children}
    </BorrowedChrome>
  );
}
