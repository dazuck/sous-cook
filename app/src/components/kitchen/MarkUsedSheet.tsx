"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui";
import { allowanceSentence } from "@/lib/kitchen/allowance";
import { bindNumbers } from "@/lib/kitchen/cook-view";
import { BorrowedScreen } from "./BorrowedScreen";
import { EDGE_X } from "./cook-edge";
import { FOCUS } from "./KitchenHome";
import type { PantryReconciliationCandidate } from "@/lib/pantry-reconciliation";

interface MarkUsedSheetProps {
  queueId: string;
  recipeName?: string;
  isOpen: boolean;
  onFinish: () => void;
  onCancel: () => void;
}

export function MarkUsedSheet({
  queueId,
  recipeName,
  isOpen,
  onFinish,
  onCancel,
}: MarkUsedSheetProps) {
  const { data, isLoading, isError, error } = trpc.getRecipePantryReconciliation.useQuery(
    { queueId },
    { enabled: isOpen, retry: false },
  );
  const allowanceMessage = allowanceSentence(error);

  const applyMutation = trpc.applyPantryReconciliation.useMutation();
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [hasInitialized, setHasInitialized] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  const candidates: PantryReconciliationCandidate[] = useMemo(
    () => data?.candidates ?? [],
    [data?.candidates],
  );

  // The bypasses below finish once per opening. The cook view passes a fresh
  // onFinish on every render, so an effect keyed on it would finish again on
  // each re-render: a refused save would send itself again and again.
  const bypassed = useRef(false);
  useEffect(() => {
    if (!isOpen) bypassed.current = false;
  }, [isOpen]);
  const bypass = useCallback(() => {
    if (bypassed.current) return;
    bypassed.current = true;
    onFinish();
  }, [onFinish]);

  // Initialize selected indices when data loads
  /* eslint-disable react-hooks/set-state-in-effect -- kept in the effect: a reset made while rendering can be lost when React replays updates it queued without rendering (KitchenTimers lost one that way) */
  useEffect(() => {
    if (!isOpen || !data || hasInitialized) return;
    if (data.candidates.length === 0) {
      // Zero matches auto-bypass: finish immediately without showing sheet
      bypass();
      return;
    }
    const initial = new Set<number>();
    data.candidates.forEach((c, idx) => {
      if (c.preselected) initial.add(idx);
    });
    setSelectedIndices(initial);
    setHasInitialized(true);
  }, [isOpen, data, hasInitialized, bypass]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // If query fails, fail safe and allow user to finish without blocking
  useEffect(() => {
    if (isError && isOpen && allowanceMessage === null) bypass();
  }, [isError, isOpen, allowanceMessage, bypass]);

  const toggleIndex = (index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleConfirm = async () => {
    setIsApplying(true);
    try {
      const actions = Array.from(selectedIndices).map((idx) => {
        const c = candidates[idx];
        if (c.action === "decrement" && c.updatedText) {
          return {
            action: "decrement" as const,
            oldText: c.docItemText,
            newText: c.updatedText,
            section: c.section,
          };
        }
        return {
          action: "delete" as const,
          oldText: c.docItemText,
          section: c.section,
        };
      });

      if (actions.length > 0) {
        await applyMutation.mutateAsync({ queueId, actions });
      }

      onFinish();
    } catch (err) {
      console.error("Could not apply pantry reconciliation:", err);
      // Fail safe: proceed with finish even if doc write failed
      onFinish();
    } finally {
      setIsApplying(false);
    }
  };

  if (!isOpen) return null;

  if (allowanceMessage !== null) {
    return (
      <BorrowedScreen kind="Mark ingredients as used" onClose={onCancel}>
        <div
          className={`flex min-h-0 flex-1 flex-col items-center justify-center text-center ${EDGE_X}`}
        >
          <p className="text-[length:var(--type-chip)] leading-tight font-semibold text-ink">
            {allowanceMessage}
          </p>
          <Button
            variant="primary"
            onClick={bypass}
            className="mt-[var(--space-5)]"
          >
            Finish
          </Button>
        </div>
      </BorrowedScreen>
    );
  }

  if (isLoading) {
    return (
      <BorrowedScreen kind="Mark ingredients as used" onClose={onCancel}>
        <div
          className={`flex min-h-0 flex-1 flex-col items-center justify-center text-center ${EDGE_X}`}
        >
          <p className="text-[length:var(--type-chip)] leading-tight font-semibold text-ink">
            Checking used ingredients...
          </p>
          <p className="mt-[var(--space-2)] text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
            Reconciling with the pantry
          </p>
        </div>
      </BorrowedScreen>
    );
  }

  // If 0 candidates, the useEffect above triggers onFinish, but render nothing while closing
  if (candidates.length === 0) return null;

  return (
    <BorrowedScreen kind="Mark ingredients as used" onClose={onCancel}>
      <div className={`flex min-h-0 flex-1 flex-col ${EDGE_X}`}>
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
          <p className="mb-[var(--space-4)] shrink-0 text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
            {recipeName ? `Used in ${recipeName}. ` : ""}
            Checked items will be removed or updated in your pantry.
          </p>

          {/* Candidate list */}
          <div className="min-h-0 flex-1 space-y-[var(--space-3)] overflow-y-auto py-1">
            {candidates.map((c, index) => {
              const isSelected = selectedIndices.has(index);
              const isDecrement = c.action === "decrement" && c.updatedText;

              return (
                <label
                  key={`${c.docItemText}-${index}`}
                  className={`flex min-h-[var(--target)] cursor-pointer items-center gap-[var(--space-4)] rounded-[var(--radius-2)] border px-[var(--space-4)] py-[var(--space-3)] transition-colors duration-[320ms] ease-[var(--ease)] ${
                    isSelected
                      ? "border-ink/[.14] bg-sand text-ink"
                      : "border-ink/[.11] bg-transparent text-ink-soft"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleIndex(index)}
                    className="size-[calc(28*var(--cpx))] shrink-0 cursor-pointer rounded-[var(--radius-1)] border-ink/30 accent-ink"
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-[var(--space-2)]">
                      <span className="break-words text-[length:var(--type-chip)] leading-tight font-semibold text-ink">
                        {isDecrement && c.updatedText ? (
                          <>
                            <span className="mr-2 line-through text-ink-soft">
                              {bindNumbers(c.docItemText)}
                            </span>
                            <span>{bindNumbers(c.updatedText)}</span>
                          </>
                        ) : (
                          bindNumbers(c.docItemText)
                        )}
                      </span>

                      {/* Action status words at the 22 cpx floor */}
                      {isDecrement && (
                        <span className="rounded-full border border-ink/[.11] bg-paper px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft">
                          decrements
                        </span>
                      )}
                      {c.action === "delete" && !c.isStaple && (
                        <span className="rounded-full border border-ink/[.11] bg-paper px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft">
                          will remove
                        </span>
                      )}
                      {c.isStaple && (
                        <span className="rounded-full border border-ink/[.11] bg-paper px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft">
                          staple (unchecked)
                        </span>
                      )}
                    </div>

                    <p className="mt-1 text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft">
                      Section: {c.section}
                      {c.reason ? ` · ${bindNumbers(c.reason)}` : ""}
                    </p>
                  </div>
                </label>
              );
            })}
          </div>

          {/* Footer controls */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-[var(--space-3)] border-t border-ink/[.11] py-[var(--space-4)]">
            <button
              type="button"
              onClick={onFinish}
              disabled={isApplying}
              className={`min-h-[var(--target)] cursor-pointer rounded-full bg-sand px-[calc(28*var(--cpx))] text-[length:var(--type-meta)] leading-tight font-semibold text-ink transition-colors duration-[320ms] ease-[var(--ease)] active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)] disabled:cursor-not-allowed disabled:bg-sand disabled:text-ink-soft ${FOCUS}`}
            >
              Skip (keep pantry unchanged)
            </button>

            <Button
              variant="primary"
              size="lg"
              onClick={handleConfirm}
              disabled={isApplying}
            >
              {isApplying
                ? "Updating pantry..."
                : selectedIndices.size > 0
                  ? `Update ${selectedIndices.size} item${selectedIndices.size === 1 ? "" : "s"} & Finish`
                  : "Finish without updates"}
            </Button>
          </div>
        </div>
      </div>
    </BorrowedScreen>
  );
}
