"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { footMask, useMoreBelow } from "@/hooks/useMoreBelow";
import {
  groupShoppingItems,
  type ShoppingGroupMode,
  type ShoppingListItem,
} from "@/lib/shopping-list-format";
import { trpc } from "@/lib/trpc";
import {
  ACTION,
  ACTION_AT_REST,
  AT_REST,
  FOCUS,
  FOOT_FILL,
  GHOST,
  IN_FORCE,
} from "./control-style";
import { BACK_TO_KITCHEN, BorrowedScreen } from "./BorrowedScreen";
import { EDGE_X } from "./cook-edge";
import { LABEL, ROW_TAP, Row } from "./KitchenRows";
import { WIDTH } from "./ReportsPanel";

/** How long an armed Clear all stays armed before disarming itself (DS §5/§7). */
export const CLEAR_ARM_MS = 4_000;

export const SHOPPING_LIST_COPY = {
  kind: "Shopping list",
  byAisle: "By aisle",
  byRecipe: "By recipe",
  all: "All",
  itemPlaceholder: "Add an item…",
  forPlaceholder: "For recipe or store (optional)",
  add: "Add",
  adding: "Adding…",
  clearAll: "Clear all",
  confirmClear: "Tap again to clear",
  loading: "Reading the shopping list…",
  empty: "Shopping list is empty.",
  failed: "Couldn't reach the shopping list.",
  retry: "Try again",
} as const;

const GROUP_MODES: ReadonlyArray<{ mode: ShoppingGroupMode; label: string }> = [
  { mode: "aisle", label: SHOPPING_LIST_COPY.byAisle },
  { mode: "recipe", label: SHOPPING_LIST_COPY.byRecipe },
  { mode: "all", label: SHOPPING_LIST_COPY.all },
];

export interface ShoppingListViewProps {
  items: ShoppingListItem[];
  loading: boolean;
  error: string | null;
  mutating: boolean;
  onAdd: (item: string, forRecipe?: string) => Promise<boolean> | boolean | void;
  onRemove: (rawOrKey: string) => void;
  onClear: () => void;
  onRetry: () => void;
  onClose: () => void;
}

export function ShoppingListView({
  items,
  loading,
  error,
  mutating,
  onAdd,
  onRemove,
  onClear,
  onRetry,
  onClose,
}: ShoppingListViewProps) {
  const ids = useId();
  const [mode, setMode] = useState<ShoppingGroupMode>("aisle");
  const [itemText, setItemText] = useState("");
  const [forText, setForText] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);

  const canClear = items.length > 0 && !mutating;
  if (confirmingClear && !canClear) {
    setConfirmingClear(false);
  }

  useEffect(() => {
    if (!confirmingClear) return;
    const t = setTimeout(() => setConfirmingClear(false), CLEAR_ARM_MS);
    return () => clearTimeout(t);
  }, [confirmingClear]);

  const groups = groupShoppingItems(items, mode);
  const scroller = useRef<HTMLDivElement>(null);
  const below = useMoreBelow(
    scroller,
    `${mode}:${items.map((i) => i.raw).join("|")}:${loading}:${error ?? ""}`,
  );
  const mask = footMask(below);

  const canSubmit = itemText.trim().length > 0 && !mutating;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedItem = itemText.trim();
    if (!trimmedItem || mutating) return;
    const trimmedFor = forText.trim();
    const ok = await onAdd(trimmedItem, trimmedFor || undefined);
    if (ok !== false) {
      setItemText("");
      setForText("");
    }
  };

  return (
    <BorrowedScreen
      kind={SHOPPING_LIST_COPY.kind}
      back={BACK_TO_KITCHEN}
      onClose={onClose}
    >
      <div data-shopping-list className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          style={{ maskImage: mask, WebkitMaskImage: mask }}
          className={`min-h-0 flex-1 overflow-y-auto pb-[var(--space-4)] ${EDGE_X}`}
        >
          <div className={WIDTH}>
            {/* Compact add row (item field, optional recipe/store field, action-word Add button) */}
            <form
              onSubmit={(e) => {
                void handleSubmit(e);
              }}
              className="flex flex-wrap items-center gap-[calc(12*var(--cpx))]"
            >
              <input
                type="text"
                aria-label="Item to buy"
                placeholder={SHOPPING_LIST_COPY.itemPlaceholder}
                value={itemText}
                onChange={(e) => setItemText(e.target.value)}
                className={`min-h-[var(--target)] min-w-[calc(220*var(--cpx))] flex-1 rounded-[var(--radius-2)] border border-ink/[.14] bg-sand px-[calc(20*var(--cpx))] text-[length:var(--type-chip)] leading-tight font-medium text-ink placeholder:text-ink-soft/60 ${FOCUS}`}
              />
              <input
                type="text"
                aria-label="For recipe or store"
                placeholder={SHOPPING_LIST_COPY.forPlaceholder}
                value={forText}
                onChange={(e) => setForText(e.target.value)}
                className={`min-h-[var(--target)] w-full sm:w-[calc(280*var(--cpx))] rounded-[var(--radius-2)] border border-ink/[.14] bg-sand px-[calc(20*var(--cpx))] text-[length:var(--type-meta)] leading-tight font-medium text-ink placeholder:text-ink-soft/60 ${FOCUS}`}
              />
              <button
                type="submit"
                disabled={!canSubmit}
                className={`${ACTION} ${
                  canSubmit
                    ? ACTION_AT_REST
                    : "cursor-default text-ink-soft/60 before:border-ink/[.11]"
                }`}
              >
                {mutating ? SHOPPING_LIST_COPY.adding : SHOPPING_LIST_COPY.add}
              </button>
            </form>

            {/* Under the add row: three-way ghost sort toggle (By aisle | By recipe | All) + two-tap armed Clear all */}
            <div className="mt-[calc(12*var(--cpx))] flex flex-wrap items-center justify-between gap-x-[calc(12*var(--cpx))]">
              <div
                role="group"
                aria-label="Sort shopping list"
                className="-ml-[calc(26*var(--cpx))] flex flex-wrap items-center"
              >
                {GROUP_MODES.map(({ mode: m, label }) => {
                  const active = mode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setMode(m)}
                      className={`${GHOST} ${active ? IN_FORCE : AT_REST}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {items.length > 0 && (
                <button
                  type="button"
                  disabled={!canClear}
                  onClick={() => {
                    if (!canClear) return;
                    if (!confirmingClear) {
                      setConfirmingClear(true);
                      return;
                    }
                    setConfirmingClear(false);
                    onClear();
                  }}
                  className={
                    confirmingClear
                      ? `${FOOT_FILL} px-[calc(26*var(--cpx))] bg-ember text-paper active:bg-ember-700`
                      : `${GHOST} -mr-[calc(26*var(--cpx))] font-medium ${
                          canClear ? "text-ink" : "text-ink-soft"
                        }`
                  }
                >
                  {confirmingClear
                    ? SHOPPING_LIST_COPY.confirmClear
                    : SHOPPING_LIST_COPY.clearAll}
                </button>
              )}
            </div>

            {error && (
              <div
                role="status"
                className="mt-[var(--space-4)] flex flex-wrap items-center justify-between gap-[calc(12*var(--cpx))]"
              >
                <p className={LABEL}>{error}</p>
                <button
                  type="button"
                  onClick={onRetry}
                  className={`${ACTION} ${ACTION_AT_REST}`}
                >
                  {SHOPPING_LIST_COPY.retry}
                </button>
              </div>
            )}

            {loading && items.length === 0 && !error && (
              <p role="status" className={`mt-[var(--space-4)] ${LABEL}`}>
                {SHOPPING_LIST_COPY.loading}
              </p>
            )}

            {!loading && !error && items.length === 0 && (
              <p className={`mt-[var(--space-4)] ${LABEL}`}>
                {SHOPPING_LIST_COPY.empty}
              </p>
            )}

            {groups.map((group, groupIndex) => {
              const headingId = group.label ? `${ids}-group-${groupIndex}` : undefined;
              return (
                <section
                  key={group.label ?? "all"}
                  className="mt-[var(--space-4)]"
                >
                  {group.label && (
                    <h3
                      id={headingId}
                      className={`mb-[calc(6*var(--cpx))] ${LABEL}`}
                    >
                      {group.label}
                    </h3>
                  )}
                  <ul aria-labelledby={headingId}>
                    {group.items.map((entry) => {
                      const slotText =
                        mode === "recipe" ? entry.aisle : entry.forRecipe;
                      return (
                        <Row
                          key={entry.raw}
                          title={
                            <button
                              type="button"
                              disabled={mutating}
                              onClick={() => onRemove(entry.raw)}
                              className={ROW_TAP}
                            >
                              <span className="flex items-center gap-x-[calc(14*var(--cpx))]">
                                <span
                                  aria-hidden="true"
                                  className="inline-block size-[calc(22*var(--cpx))] shrink-0 rounded-[var(--radius-1)] border border-ink-soft"
                                />
                                <span className="truncate">{entry.item}</span>
                              </span>
                            </button>
                          }
                          slot={slotText}
                        />
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </BorrowedScreen>
  );
}

export interface ShoppingListModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShoppingListModal({ isOpen, onClose }: ShoppingListModalProps) {
  const [mutationError, setMutationError] = useState<string | null>(null);

  const listQuery = trpc.getShoppingList.useQuery(undefined, {
    enabled: isOpen,
    retry: false,
  });

  const addMutation = trpc.addShoppingListItems.useMutation({
    onSuccess: () => {
      setMutationError(null);
      void listQuery.refetch();
    },
    onError: (err) => {
      setMutationError(err.message || SHOPPING_LIST_COPY.failed);
    },
  });

  const removeMutation = trpc.removeShoppingListItem.useMutation({
    onSuccess: () => {
      setMutationError(null);
      void listQuery.refetch();
    },
    onError: (err) => {
      setMutationError(err.message || SHOPPING_LIST_COPY.failed);
    },
  });

  const clearMutation = trpc.clearShoppingList.useMutation({
    onSuccess: () => {
      setMutationError(null);
      void listQuery.refetch();
    },
    onError: (err) => {
      setMutationError(err.message || SHOPPING_LIST_COPY.failed);
    },
  });

  if (!isOpen) return null;

  const mutating =
    addMutation.isPending ||
    removeMutation.isPending ||
    clearMutation.isPending;

  const error =
    mutationError ??
    (listQuery.error ? SHOPPING_LIST_COPY.failed : null);

  return (
    <ShoppingListView
      items={listQuery.data?.items ?? []}
      loading={listQuery.isLoading}
      error={error}
      mutating={mutating}
      onAdd={async (item, forRecipe) => {
        setMutationError(null);
        try {
          await addMutation.mutateAsync({ items: [{ item, forRecipe }] });
          return true;
        } catch {
          return false;
        }
      }}
      onRemove={(rawOrKey) => {
        setMutationError(null);
        removeMutation.mutate({ rawOrKey });
      }}
      onClear={() => {
        setMutationError(null);
        clearMutation.mutate();
      }}
      onRetry={() => {
        setMutationError(null);
        void listQuery.refetch();
      }}
      onClose={onClose}
    />
  );
}
