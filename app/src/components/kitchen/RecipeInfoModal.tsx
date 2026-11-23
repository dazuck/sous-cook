"use client";

import Link from "next/link";
import type { VoiceEcho, VoiceStatus } from "@/hooks/useKitchenVoiceCommands";
import { INTAKE_COPY } from "@/lib/kitchen/cook-open";
import type { SourcePackInfo } from "@/lib/pack-convert/recipe-library";
import { parsePackSource } from "@/lib/pack-convert/to-queue";
import { BorrowedScreen } from "./BorrowedScreen";
import { MORE_COPY } from "./HeaderMore";
import { EDGE_X } from "./cook-edge";
import { TimeLineWords } from "./TimeLineWords";

interface RecipeInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  name: string;
  source?: string;
  sourcePack?: SourcePackInfo;
  onCookOriginal?: (pack: { packId: string; recipeId: string }) => void;
  cookingOriginal?: boolean;
  notes?: string;
  /**
   * The time line (`recipeTimeLine`, slice T2): how long it takes, and the
   * ahead work it opens with. Null when there is nothing to say.
   */
  times?: string[] | null;
  tags?: string[];
  lastMade?: Date;
  rating?: number;
  /** The voice dot's state, for the borrowed screen's kind line. */
  voice: { status: VoiceStatus; echo: VoiceEcho | null };
  /** Intake couldn't cut the recipe, so the cook reads it as it came (cook-fidelity plan). */
  shownAsSent?: boolean;
}

const KIND = MORE_COPY.info;

export function RecipeInfoModal({
  isOpen,
  onClose,
  name,
  source,
  sourcePack,
  onCookOriginal,
  cookingOriginal = false,
  notes,
  times,
  tags,
  lastMade,
  rating,
  voice,
  shownAsSent = false,
}: RecipeInfoModalProps) {
  if (!isOpen) return null;

  const parsedPack = parsePackSource(source);
  const packId = sourcePack?.packId ?? parsedPack?.packId ?? null;
  const recipeId = sourcePack?.recipeId ?? parsedPack?.recipeId ?? null;
  const packAttribution = sourcePack
    ? sourcePack.isAdapted
      ? `Adapted from ${sourcePack.creatorName}: ${sourcePack.recipeTitle} (${sourcePack.packTitle})`
      : `From ${sourcePack.creatorName}: ${sourcePack.recipeTitle} (${sourcePack.packTitle})`
    : parsedPack
      ? `From ${parsedPack.packId}: ${parsedPack.recipeId}`
      : null;

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  };

  return (
    <BorrowedScreen kind={KIND} voice={voice} onClose={onClose}>
      <div className={`min-h-0 flex-1 overflow-y-auto pb-6 ${EDGE_X}`}>
        <div className="max-w-3xl">
          {/* Recipe name: the borrowed screen covers the cook header, so
              this is the only place it shows. A title, so Caprasimo. */}
          <h3 className="mb-[var(--space-5)] font-[family-name:var(--font-display)] text-[length:var(--type-title)] leading-tight font-normal text-ink [font-synthesis:none]">
            {name}
          </h3>

          {/* How long it takes, as the kitchen's row and Prep say it: the
              meta's quiet words under the name, no pill, no label (slice T2:
              the recipe's "Prep" and "Cook" were its active and passive
              minutes, not the cook's prep and cook). */}
          {times && (
            <p
              data-times
              className="-mt-[calc(8*var(--cpx))] mb-[var(--space-5)] text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft"
            >
              <TimeLineWords parts={times} />
            </p>
          )}

          {/* The rating: a sand pill, ink stars (DS §1, sand is the only fill). */}
          <div className="mb-[var(--space-5)] flex flex-wrap gap-3 empty:hidden">
            {rating && (
              <div className="flex items-center gap-[var(--space-1)] rounded-full bg-sand px-[var(--space-4)] py-[var(--space-2)] text-ink">
                {[...Array(5)].map((_, i) => (
                  <svg
                    key={i}
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill={i < rating ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="2"
                    className={`size-[calc(20*var(--cpx))] ${i < rating ? "text-ink" : "text-ink-soft"}`}
                  >
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                ))}
              </div>
            )}
          </div>

          {/* Notes/Description */}
          {notes && (
            <div className="mb-[var(--space-5)]">
              <h4 className="mb-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold text-ink-soft">
                Notes
              </h4>
              <p className="whitespace-pre-wrap text-[length:var(--type-chip)] leading-[1.35] text-ink">
                {notes}
              </p>
            </div>
          )}

          {/* Tags */}
          {tags && tags.length > 0 && (
            <div className="mb-[var(--space-5)]">
              <h4 className="mb-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold text-ink-soft">
                Tags
              </h4>
              <div className="flex flex-wrap gap-[var(--space-2)]">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-sand px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-medium text-ink"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Quiet Counter-scale provenance line (no decorative bookplate box or mono badge) */}
          {lastMade && (
            <p
              data-canon-bookplate
              className="mb-[var(--space-5)] text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft"
            >
              Last cooked {formatDate(lastMade)}
            </p>
          )}

          {/* Intake couldn't cut it: the same quiet provenance line */}
          {shownAsSent && (
            <p
              data-shown-as-sent
              className="mb-[var(--space-5)] text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft"
            >
              {INTAKE_COPY.shownAsSent}
            </p>
          )}

          {/* Source attribution / link */}
          {packAttribution && packId ? (
            <div>
              <h4 className="mb-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold text-ink-soft">
                Source
              </h4>
              <p
                data-pack-attribution
                className="mb-[var(--space-3)] text-[length:var(--type-chip)] leading-[1.35] font-medium text-ink"
              >
                {packAttribution}
              </p>
              <div className="flex flex-wrap items-center gap-[var(--space-4)]">
                <Link
                  href={`/kitchen/cookpacks/${encodeURIComponent(packId)}`}
                  className="inline-flex min-h-[var(--target)] items-center gap-[var(--space-2)] rounded-[var(--radius-1)] text-[length:var(--type-meta)] leading-tight font-medium text-ink underline decoration-ink/[.3] decoration-1 underline-offset-[calc(6*var(--cpx))] transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  Open pack on shelf
                </Link>
                {sourcePack?.isAdapted && recipeId && (
                  <button
                    type="button"
                    disabled={cookingOriginal}
                    onClick={() => onCookOriginal?.({ packId, recipeId })}
                    className="inline-flex min-h-[var(--target)] items-center rounded-full bg-sand px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold text-ink transition-colors duration-[320ms] ease-[var(--ease)] active:opacity-80 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    Cook original from pack
                  </button>
                )}
              </div>
            </div>
          ) : (
            source && (
              <div>
                <h4 className="mb-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold text-ink-soft">
                  Source
                </h4>
                <a
                  href={source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[var(--target)] items-center gap-[var(--space-2)] rounded-[var(--radius-1)] text-[length:var(--type-meta)] leading-tight font-medium text-ink underline decoration-ink/[.3] decoration-1 underline-offset-[calc(6*var(--cpx))] transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  View original recipe
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-[calc(20*var(--cpx))] shrink-0"
                  >
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" x2="21" y1="14" y2="3" />
                  </svg>
                </a>
              </div>
            )
          )}
        </div>
      </div>
    </BorrowedScreen>
  );
}
