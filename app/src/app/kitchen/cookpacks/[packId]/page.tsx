"use client";

import { useRouter } from "next/navigation";
import { use, useRef, useState } from "react";
import { COOKPACKS_COPY } from "@/components/cookpacks/copy";
import { PackView } from "@/components/cookpacks/PackView";
import { packReturnKey } from "@/components/cookpacks/Shelf";
import { BorrowedPage } from "@/components/kitchen/BorrowedPage";
import { EDGE_X } from "@/components/kitchen/cook-edge";
import { LABEL } from "@/components/kitchen/KitchenHome";
import { useSignInMode } from "@/components/kitchen/SignInMode";
import { allowanceSentence } from "@/lib/kitchen/allowance";
import { isUnreadableRecipe, QUEUE_REFUSAL_COPY } from "@/lib/kitchen/queue-refusal";
import {
  householdStatus,
  refreshFailedLine,
  refreshFailureCause,
  syncSummary,
  type PackStatus,
} from "@/lib/recipe-sync-summary";
import { kitchenDate } from "@/lib/shelf/view";
import { trpc } from "@/lib/trpc";

/** A URL part read as text; a malformed escape ("%E0") is read as written, never thrown. */
function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

interface PageProps {
  params: Promise<{ packId: string }>;
}

/**
 * A pack, opened (slice S, S-D1 and S-D6): "Cookpacks" over it, "Back to
 * Cookpacks" on the ledge, which focuses the book again. A row queues its
 * recipe for whoever is here and opens the cook page; the household book's
 * Refresh re-reads the recipe library and says how it went in words.
 * A chapter has a URL (`#baking`), which the view opens at.
 */
export default function PackPage({ params }: PageProps) {
  const { packId: raw } = use(params);
  const packId = decoded(raw);
  const router = useRouter();
  const utils = trpc.useUtils();
  const signInMode = useSignInMode();
  const { data: view, error } = trpc.getPack.useQuery({ packId });
  const settings = trpc.getKitchenSettings.useQuery(undefined, {
    enabled: signInMode,
  });
  const canManageCircleSharing =
    signInMode &&
    Boolean(view?.isOwned) &&
    settings.data?.memberRole === "owner";
  const circleShares = trpc.getPackCircleShares.useQuery(
    { packId },
    { enabled: canManageCircleSharing },
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const setCircleShare = trpc.setPackCircleShare.useMutation({
    onSuccess: () => {
      setActionError(null);
      void utils.getPackCircleShares.invalidate({ packId });
      void utils.getCircleDishes.invalidate();
    },
    onError: (err) => {
      setActionError(err.message || "Could not update circle sharing.");
    },
  });
  const [initialAnchor] = useState(() =>
    typeof window === "undefined" ? null : decoded(window.location.hash.slice(1)) || null,
  );

  // One start at a time: a double tap queues once and pushes once. Held
  // through the push, as the page is on its way out; a failure lets go.
  const starting = useRef(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  const queue = trpc.queueFromPack.useMutation({
    onSuccess: (item) => router.push(`/kitchen/queue/${item.id}`),
    onError: (err) => {
      // The cook gets one plain line; the server's own words go here.
      console.error("Queue from pack error:", err);
      setSendFailure(
        allowanceSentence(err) ??
          (isUnreadableRecipe(err) ? QUEUE_REFUSAL_COPY.notSent : COOKPACKS_COPY.sendFailed),
      );
      setSendingId(null);
      starting.current = false;
    },
  });

  // The household's plans that failed for good (slice P): the status line
  // names how many while no Refresh has spoken. A report that can't be read
  // says nothing; the book still opens.
  const plans = trpc.libraryPlanReport.useQuery(undefined, { enabled: view?.kind === "household" });

  const [refreshStatus, setRefreshStatus] = useState<PackStatus | null>(null);
  const sync = trpc.syncRecipes.useMutation({
    onSuccess: (result) => {
      setRefreshStatus({
        text: syncSummary(result),
        trouble:
          result.failures.length > 0 || result.stale.length > 0 || result.plans.failed.some((f) => f.settled),
      });
      void utils.getPack.invalidate();
      void utils.getShelf.invalidate();
      void utils.libraryPlanReport.invalidate();
    },
    onError: (err) => {
      console.error("Refresh failed:", err.message);
      // A Refresh that stopped partway may have written: read the book again.
      void utils.getPack.invalidate();
      void utils.getShelf.invalidate();
      void utils.libraryPlanReport.invalidate();
      const synced = view?.syncedAt ? kitchenDate(view.syncedAt) : null;
      setRefreshStatus({
        text: allowanceSentence(err) ?? refreshFailedLine(refreshFailureCause(err.message), synced),
        trouble: true,
      });
    },
  });

  const setPrivate = trpc.setDocRecipePrivate.useMutation({
    onSuccess: () => {
      setActionError(null);
      void utils.getPack.invalidate();
    },
    onError: (err) => {
      setActionError(err.message || "Could not update recipe privacy.");
    },
  });

  const onPick = (recipeId: string) => {
    if (starting.current) return;
    starting.current = true;
    setSendFailure(null);
    setSendingId(recipeId);
    queue.mutate({ packId, recipeId });
  };

  return (
    <div className="cook-edge">
      <BorrowedPage
        kind={COOKPACKS_COPY.kind}
        back={{ label: COOKPACKS_COPY.backToCookpacks, href: "/kitchen/cookpacks" }}
        returnKey={packReturnKey(packId)}
      >
        {view ? (
          <PackView
            view={view}
            refresh={
              view.kind === "household"
                ? {
                    pending: sync.isPending,
                    status: householdStatus({
                      running: sync.isPending,
                      refreshed: refreshStatus,
                      needFixes: plans.data?.needFixes.length ?? null,
                      runningText: COOKPACKS_COPY.refreshRunning,
                    }),
                    onRefresh: () => {
                      setRefreshStatus(null);
                      sync.mutate();
                    },
                  }
                : undefined
            }
            sendingId={sendingId}
            sendFailure={sendFailure ?? actionError}
            onPick={onPick}
            onTogglePrivate={
              view.kind === "household"
                ? (docSlug, isPrivate) => setPrivate.mutate({ docSlug, isPrivate })
                : undefined
            }
            onCopyShareLink={
              signInMode && view.kind === "household"
                ? async (docRecipeId) => {
                    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
                      return false;
                    }
                    try {
                      await navigator.clipboard.writeText(
                        `${window.location.origin}/kitchen/shared/${docRecipeId}`,
                      );
                      return true;
                    } catch {
                      return false;
                    }
                  }
                : undefined
            }
            circleSharing={
              canManageCircleSharing &&
              circleShares.data &&
              circleShares.data.kitchens.length > 0
                ? {
                    kitchens: circleShares.data.kitchens,
                    pending: setCircleShare.isPending,
                    onToggle: (targetKitchenId, shared) =>
                      setCircleShare.mutate({ packId, targetKitchenId, shared }),
                  }
                : undefined
            }
            initialAnchor={initialAnchor}
            onAnchor={(anchor) => window.history.replaceState(null, "", `#${anchor}`)}
          />
        ) : (
          <p role="status" data-pack-absent={view === null || undefined} className={`pt-[calc(16*var(--cpx))] ${EDGE_X} ${LABEL}`}>
            {view === null ? COOKPACKS_COPY.notOnShelf : error ? COOKPACKS_COPY.shelfFailed : COOKPACKS_COPY.loading}
          </p>
        )}
      </BorrowedPage>
    </div>
  );
}
