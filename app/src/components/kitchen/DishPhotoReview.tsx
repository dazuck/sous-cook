"use client";

import { Button } from "@/components/ui";
import { BorrowedScreen } from "./BorrowedScreen";
import { EDGE_X } from "./cook-edge";

export interface DishPhotoReviewProps {
  /** The captured image Data URL (base64). When null, nothing is rendered. */
  photo: string | null;
  /** Name of the recipe currently being cooked, if any. */
  recipeTitle?: string;
  /** Summary or instructions of the current step, if any. */
  currentStepSummary?: string;
  /** Fired when the cook submits the photo dish check. */
  onSubmit: (data: {
    photo: string;
    question: string;
    includeRecipeContext: boolean;
  }) => void;
  /** Fired when the cook asks to retake the shot. */
  onRetake: () => void;
  /** Fired when the review card is closed without submitting. */
  onClose: () => void;
}

export const DEFAULT_DISH_QUESTION =
  "How does this look and what should I do with it?";

/**
 * Zero-prompt borrowed screen for checking a captured dish photo against the
 * current cooking step (DESIGN_SYSTEM.md §6). Sits on the full Counter ground
 * with a KindLine ("Check my dish") and a 96 cpx bottom ledge ("Back to step").
 */
export function DishPhotoReview({
  photo,
  recipeTitle,
  currentStepSummary,
  onSubmit,
  onRetake,
  onClose,
}: DishPhotoReviewProps) {
  if (!photo) return null;

  return (
    <BorrowedScreen kind="Check my dish" back="Back to step" onClose={onClose}>
      <div className={`min-h-0 flex-1 overflow-y-auto py-[var(--space-3)] ${EDGE_X}`}>
        <div className="grid w-full max-w-6xl grid-cols-1 items-start gap-[var(--space-5)] md:grid-cols-[minmax(240px,360px)_minmax(0,1fr)]">
          {/* Captured dish photo in a clean framed card */}
          <div className="overflow-hidden rounded-[var(--r-md,var(--radius-2))] border border-ink/[.11] bg-sand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo}
              alt="Captured dish"
              className="max-h-[34vh] w-full object-contain"
            />
          </div>

          {/* Step context and 80 cpx actions */}
          <div className="flex min-w-0 flex-col gap-[var(--space-4)] font-[family-name:var(--font-text)] text-ink">
            <h3 className="line-clamp-1 font-[family-name:var(--font-display)] text-[length:var(--type-title)] leading-tight font-normal text-ink [font-synthesis:none]">
              {recipeTitle || "Check my dish"}
            </h3>

            <p className="line-clamp-2 text-[length:var(--type-chip)] leading-[1.3] font-medium text-ink">
              {currentStepSummary ||
                "Sous will check browning, texture, and doneness from your photo."}
            </p>

            {/* Primary check & retake controls */}
            <div className="flex flex-wrap items-center gap-[var(--space-3)] pt-[var(--space-1)]">
              <Button
                variant="primary"
                size="lg"
                onClick={() =>
                  onSubmit({
                    photo,
                    question: DEFAULT_DISH_QUESTION,
                    includeRecipeContext: true,
                  })
                }
              >
                Check against this step
              </Button>
              <Button variant="secondary" size="lg" onClick={onRetake}>
                Retake photo
              </Button>
            </div>
          </div>
        </div>
      </div>
    </BorrowedScreen>
  );
}
