"use client";

import { useState } from "react";
import { BorrowedPage } from "@/components/kitchen/BorrowedPage";
import { EDGE_X } from "@/components/kitchen/cook-edge";
import {
  ACTION,
  ACTION_AT_REST,
  ACTION_IN_FORCE,
  RING,
} from "@/components/kitchen/control-style";
import { LABEL } from "@/components/kitchen/KitchenHome";
import { useSignInMode } from "@/components/kitchen/SignInMode";
import { trpc } from "@/lib/trpc";

const NOTE_LIMIT = 500;

const RATE_BUTTON = `relative isolate inline-flex size-[var(--target)] cursor-pointer items-center justify-center disabled:cursor-default ${RING} before:inset-[calc(12*var(--cpx))] before:rounded-full`;

interface CookLogEntryItem {
  id: string;
  recipeTitle: string;
  cookedDay: string;
  cookedByName: string | null;
  rating: number | null;
  notes: string;
  notePrivate: boolean;
  heldBack: boolean;
}

function CookLogEntryRow({
  entry,
  pending,
  showCircleControls,
  onUpdate,
}: {
  entry: CookLogEntryItem;
  pending: boolean;
  showCircleControls: boolean;
  onUpdate: (patch: {
    id: string;
    rating?: number | null;
    notes?: string;
    notePrivate?: boolean;
    heldBack?: boolean;
  }) => Promise<boolean>;
}) {
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [localPrivate, setLocalPrivate] = useState<{
    value: boolean;
    baseline: boolean;
  } | null>(null);
  const notePrivate =
    localPrivate && localPrivate.baseline === entry.notePrivate
      ? localPrivate.value
      : entry.notePrivate;
  const currentNote = noteDraft ?? entry.notes;
  const noteDirty = noteDraft !== null && noteDraft.trim() !== entry.notes;

  return (
    <li
      data-cook-log-entry={entry.id}
      className="border-t border-ink/[.11] py-[var(--space-5)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-[var(--space-4)] gap-y-[var(--space-1)]">
        <h2 className="font-[family-name:var(--font-display)] text-[length:var(--type-chip)] leading-tight font-normal text-ink [font-synthesis:none]">
          {entry.recipeTitle}
        </h2>
        <p className={LABEL}>
          {entry.cookedDay}
          {entry.cookedByName ? ` · ${entry.cookedByName}` : ""}
        </p>
      </div>

      <div className="mt-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-3)]">
        <div
          role="group"
          aria-label={`Rating for ${entry.recipeTitle}`}
          className="-ml-[calc(12*var(--cpx))] flex gap-x-[calc(4*var(--cpx))] text-[length:var(--type-chip)] leading-none font-semibold tabular-nums"
        >
          {[1, 2, 3, 4, 5].map((n) => {
            const active = entry.rating === n;
            return (
              <button
                key={n}
                type="button"
                aria-label={`${n} out of 5`}
                aria-pressed={active}
                disabled={pending}
                onClick={() =>
                  onUpdate({
                    id: entry.id,
                    rating: active ? null : n,
                  })
                }
                className={`${RATE_BUTTON} ${
                  active
                    ? "text-ink before:border-ink"
                    : "text-ink-soft before:border-ink/[.2]"
                }`}
              >
                {n}
              </button>
            );
          })}
        </div>

        {showCircleControls && (
          <>
            <button
              type="button"
              data-hold-back={entry.id}
              aria-pressed={entry.heldBack}
              disabled={pending}
              onClick={() =>
                onUpdate({
                  id: entry.id,
                  heldBack: !entry.heldBack,
                })
              }
              className={`${ACTION} ${entry.heldBack ? ACTION_IN_FORCE : ACTION_AT_REST}`}
            >
              {entry.heldBack ? "Show to friends" : "Hold back"}
            </button>

            {entry.heldBack && (
              <span className={LABEL}>Held back from friends</span>
            )}
          </>
        )}
      </div>

      <div className="mt-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-3)]">
        <input
          type="text"
          data-holds-keys
          aria-label={`Note for ${entry.recipeTitle}`}
          placeholder="Add a note"
          maxLength={NOTE_LIMIT}
          value={currentNote}
          onChange={(e) => setNoteDraft(e.target.value)}
          className="h-[var(--target)] min-w-[min(100%,calc(360*var(--cpx)))] flex-1 rounded-[var(--radius-2)] border border-ink/[.14] bg-transparent px-[calc(16*var(--cpx))] text-[length:var(--type-meta)] font-medium text-ink placeholder:text-ink-soft focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ink"
        />

        {noteDirty && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              void onUpdate({ id: entry.id, notes: currentNote }).then((ok) => {
                if (ok) setNoteDraft(null);
              });
            }}
            className={`${ACTION} ${ACTION_IN_FORCE}`}
          >
            Save note
          </button>
        )}

        <label className="inline-flex min-h-[var(--target)] cursor-pointer items-center gap-[calc(10*var(--cpx))] px-[calc(4*var(--cpx))] text-[length:var(--type-meta)] font-medium text-ink-soft select-none">
          <input
            type="checkbox"
            checked={notePrivate}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.checked;
              setLocalPrivate({ value: next, baseline: entry.notePrivate });
              void onUpdate({
                id: entry.id,
                notePrivate: next,
              }).then((ok) => {
                if (!ok) setLocalPrivate(null);
              });
            }}
            className="size-[calc(22*var(--cpx))] accent-ink"
          />
          <span>Private note</span>
        </label>
      </div>
    </li>
  );
}

/**
 * Kitchen cook log page (`/kitchen/cook-log`), reached from the home rail's
 * names panel. Lists the kitchen's own finished cooks newest first.
 */
export default function CookLogPage() {
  const utils = trpc.useUtils();
  const signInMode = useSignInMode();
  const cookLog = trpc.getCookLog.useQuery();
  const [errorText, setErrorText] = useState<string | null>(null);

  const update = trpc.updateCookLogEntry.useMutation({
    onMutate: (patch) => {
      void utils.getCookLog.cancel();
      const previous = utils.getCookLog.getData();
      utils.getCookLog.setData(undefined, (prev) =>
        prev?.map((item) =>
          item.id === patch.id
            ? {
                ...item,
                ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
                ...(patch.notes !== undefined ? { notes: patch.notes.trim() } : {}),
                ...(patch.notePrivate !== undefined
                  ? { notePrivate: patch.notePrivate }
                  : {}),
                ...(patch.heldBack !== undefined
                  ? { heldBack: patch.heldBack }
                  : {}),
              }
            : item,
        ),
      );
      return { previous };
    },
    onSuccess: (updated) => {
      setErrorText(null);
      utils.getCookLog.setData(undefined, (prev) =>
        prev?.map((item) => (item.id === updated.id ? updated : item)),
      );
      void utils.getCookLog.invalidate();
      void utils.getCookAsk.invalidate();
      void utils.getCircleDishes.invalidate();
    },
    onError: (err, _patch, context) => {
      if (context?.previous !== undefined) {
        utils.getCookLog.setData(undefined, context.previous);
      }
      setErrorText(err.message || "Could not update cook log entry.");
    },
  });

  const entries = cookLog.data ?? [];

  return (
    <div className="cook-edge">
      <BorrowedPage
        kind="Cook log"
        back={{ label: "Back to the kitchen", href: "/kitchen" }}
        ready={cookLog.data !== undefined}
      >
        <div className={`min-h-0 flex-1 overflow-y-auto pb-[calc(48*var(--cpx))] ${EDGE_X}`}>
          <div className="max-w-[calc(820*var(--cpx))] pt-[var(--space-4)]">
            {errorText && (
              <p role="status" className="mb-[var(--space-3)] text-[length:var(--type-meta)] font-medium text-ink">
                {errorText}
              </p>
            )}
            {cookLog.error ? (
              <p role="status" className={LABEL}>
                Could not load the cook log just now.
              </p>
            ) : !cookLog.data ? (
              <p role="status" className={LABEL}>
                Loading cook log…
              </p>
            ) : entries.length === 0 ? (
              <p className={LABEL}>
                Nothing cooked yet. Finish a recipe to see it here.
              </p>
            ) : (
              <ul aria-label="Cook log entries">
                {entries.map((entry) => (
                  <CookLogEntryRow
                    key={entry.id}
                    entry={entry}
                    pending={update.isPending}
                    showCircleControls={signInMode}
                    onUpdate={(patch) =>
                      update.mutateAsync(patch).then(
                        () => true,
                        () => false,
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </BorrowedPage>
    </div>
  );
}
