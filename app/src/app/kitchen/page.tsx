"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useOnline } from "@/hooks/useOnline";
import { useRouter, useSearchParams } from "next/navigation";
import { LoadingScreen } from "@/components/kitchen/LoadingScreen";
import { FlaggedEntry } from "@/components/kitchen/ReportsPanel";
import { KitchenHome, type KitchenItem } from "@/components/kitchen/KitchenHome";
import {
  askPollInterval,
  CookAskLine,
  refusedAnswer,
  type RateAnswer,
  type RetryAnswer,
} from "@/components/kitchen/CookAsk";
import { AskSous } from "@/components/kitchen/AskSous";
import {
  AddIngredientsModal,
  RecipeImportModal,
  ShoppingListModal,
  type SerializedKitchenQueueItem,
} from "@/components/kitchen";
import { SavedForLater } from "@/components/cookpacks/SavedForLater";
import { trpc } from "@/lib/trpc";
import { DEFAULT_COOK } from "@/lib/cook-id";
import { connected } from "@/lib/hooks/connected";
import type { ImportedRecipe } from "@/lib/recipe-import";
import { dishName } from "@/lib/kitchen/dish-name";
import { recipeTimeLine } from "@/lib/kitchen/time-line";
import { pruneSessions } from "@/lib/kitchen/cook-session";

/** How long the home waits for its reads before it draws what it has (item 2). */
const READ_WAIT_MS = 3000;

/** The name a queue item goes by, whatever it holds. */
function nameOf(item: SerializedKitchenQueueItem): string {
  return dishName(item.recipeData?.name, item.recipeNotionId);
}

/**
 * A queue item as the kitchen draws it: its name, and its time line (how
 * long it takes, and any ahead work, a soak or a brine, that has to start
 * before the cook does).
 */
function kitchenItem(item: SerializedKitchenQueueItem): KitchenItem {
  return { id: item.id, name: nameOf(item), times: recipeTimeLine(item.cookPlan, item.recipeData?.estimatedTime) };
}

// =============================================================================
// Main Kitchen Page
// =============================================================================

function KitchenPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Modal state. The home page deep-links here with ?import=true or ?shopping=true;
  // that nav always mounts this page fresh, so reading the param once is enough.
  // The old ?browse=true goes to the Cookpacks shelf (next.config.ts redirect).
  const [isImportModalOpen, setIsImportModalOpen] = useState(
    () => searchParams.get("import") === "true",
  );
  const [isShoppingListOpen, setIsShoppingListOpen] = useState(
    () => searchParams.get("shopping") === "true",
  );
  const [isAddIngredientsModalOpen, setIsAddIngredientsModalOpen] = useState(false);
  const [isAskOpen, setIsAskOpen] = useState(false);
  // Cookpacks shelf data, for rendering directly on the home screen when idle
  const shelfQuery = trpc.getShelf.useQuery();
  const shelf = shelfQuery.data;
  const [isSavedOpen, setIsSavedOpen] = useState(false);
  const ideas = trpc.getRecipeIdeas.useQuery(undefined, { enabled: isSavedOpen });

  // Fetch kitchen queue for current user, poll every 10 seconds
  const { data: queueItems, refetch: refetchQueue, status: queueStatus } =
    trpc.getKitchenQueue.useQuery(
      { userId: DEFAULT_COOK },
      {
        refetchInterval: 10000, // Poll every 10s
      },
    );

  // Fetch items currently being cooked (for resume functionality)
  const { data: cookingItems, refetch: refetchCooking, status: cookingStatus } =
    trpc.getRecentCookingItems.useQuery(
      { userId: DEFAULT_COOK, limit: 3 },
      {
        refetchInterval: 10000, // Poll every 10s
      },
    );

  // Recently completed queue items (Made recently, for re-cooking)
  const { data: completedItems, status: completedStatus } = trpc.getKitchenQueue.useQuery({
    userId: DEFAULT_COOK,
    status: "completed",
  });

  // The tablet's kept cook sessions (B5b): a cook finished elsewhere drops
  // its session, and at most ten are kept.
  useEffect(() => {
    if (completedItems) pruneSessions(completedItems.map((item) => item.id));
  }, [completedItems]);

  // "How was it?" (T2): today's latest finished cook, until it's answered,
  // put off or the day ends. How often it is read: `askPollInterval`.
  const { data: cookAsk, refetch: refetchAsk, status: askStatus } = trpc.getCookAsk.useQuery(
    { userId: DEFAULT_COOK },
    { refetchInterval: askPollInterval },
  );
  // Not now hides the line at once; a dismiss the server refused brings it back.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const rateCook = trpc.rateCook.useMutation();
  const retryCookLog = trpc.retryCookLog.useMutation();
  const dismissCookAsk = trpc.dismissCookAsk.useMutation();

  // Helper to refetch both queues, and the ask a finish may have opened
  const refetchAll = () => {
    refetchQueue();
    refetchCooking();
    refetchAsk();
  };

  const handleRate = async (
    queueId: string,
    rating: number,
    note: string,
  ): Promise<RateAnswer> => {
    try {
      const result = await rateCook.mutateAsync({
        queueId,
        rating,
        ...(note ? { notes: note } : {}),
      });
      return result.rated ? "rated" : "failed";
    } catch (err) {
      return refusedAnswer(err);
    } finally {
      void refetchAsk();
    }
  };

  const handleRetry = async (queueId: string): Promise<RetryAnswer> => {
    try {
      return (await retryCookLog.mutateAsync({ queueId })).status;
    } catch (err) {
      const answer = refusedAnswer(err);
      return answer === "row-moved" ? "gone" : answer;
    } finally {
      void refetchAsk();
    }
  };

  const handleDismiss = (queueId: string) => {
    setDismissed(queueId);
    dismissCookAsk.mutate(
      { queueId },
      {
        onError: () => setDismissed(null),
        onSettled: () => void refetchAsk(),
      },
    );
  };

  // Mutations
  const addToQueue = trpc.addToKitchenQueue.useMutation({
    onSuccess: () => refetchAll(),
  });
  const updateQueueStatus = trpc.updateKitchenQueueStatus.useMutation({
    onSuccess: () => refetchAll(),
  });
  const removeFromQueue = trpc.removeFromKitchenQueue.useMutation({
    onSuccess: () => refetchAll(),
  });
  const importFromUrl = trpc.importRecipeFromUrl.useMutation();
  const importFromText = trpc.importRecipeFromText.useMutation();
  const importFromImage = trpc.importRecipeFromImage.useMutation();
  const saveRecipeIdea = trpc.saveRecipeIdea.useMutation();

  const handleImportRecipe = async (recipe: ImportedRecipe) => {
    // Add to kitchen queue
    await addToQueue.mutateAsync({
      recipeData: recipe,
      targetUser: DEFAULT_COOK,
    });
  };

  // Queues the imported recipe, starts it as a start from the queue does
  // (its start time, and any cook left on its last screen finished:
  // cook-fidelity decision 7), and opens it. A refusal or failure rejects,
  // and the import modal says so (B4 fix round 1, MED 3). A start that fails
  // after the recipe was queued keeps its row: Start cooking again starts
  // that row rather than queue the recipe twice.
  const queuedImport = useRef<{ recipe: ImportedRecipe; id: string } | null>(null);
  const handleStartCooking = async (recipe: ImportedRecipe) => {
    const id =
      queuedImport.current?.recipe === recipe
        ? queuedImport.current.id
        : (await addToQueue.mutateAsync({ recipeData: recipe, targetUser: DEFAULT_COOK })).id;
    queuedImport.current = { recipe, id };
    await updateQueueStatus.mutateAsync({ queueId: id, status: "cooking" });
    queuedImport.current = null;
    router.push(`/kitchen/queue/${id}`);
  };

  // One start at a time: a double tap on a card sends one status write and
  // one push. Held through the push, as the page is on its way out; a failed
  // write lets go so the card can be tapped again.
  const starting = useRef(false);
  const handleStartFromQueue = (item: KitchenItem) => {
    if (starting.current) return;
    starting.current = true;
    updateQueueStatus.mutate(
      { queueId: item.id, status: "cooking" },
      {
        onSuccess: () => router.push(`/kitchen/queue/${item.id}`),
        onError: () => {
          starting.current = false;
        },
      },
    );
  };

  const handleRemoveFromQueue = (queueId: string) => {
    removeFromQueue.mutate({ queueId });
  };

  const handleSaveAsInspiration = (recipe: ImportedRecipe) => {
    // The ideas doc is a backlog of recipe leads; the name (plus its source
    // link when imported from the web) is the useful idea to jot down.
    const idea = recipe.source
      ? `${recipe.name} — ${recipe.source}`
      : recipe.name;
    saveRecipeIdea.mutate({ text: idea });
  };

  const handleImportFromUrl = async (url: string) => {
    const result = await importFromUrl.mutateAsync({ url });
    return result.recipe && { recipe: result.recipe, notices: result.notices };
  };

  const handleImportFromText = async (text: string) => {
    const result = await importFromText.mutateAsync({ text });
    return result.recipe && { recipe: result.recipe, notices: result.notices };
  };

  const handleImportFromImage = async (imageBase64: string) => {
    const result = await importFromImage.mutateAsync({ imageBase64 });
    return result.recipe && { recipe: result.recipe, notices: result.notices };
  };

  // The home draws its subject once the reads have answered (an errored read
  // counts, and draws as empty, as it always has), so the idle shelf never
  // flashes before the queue arrives (FP1 D18).
  const answered = (status: string) => status !== "pending";
  const answeredAll =
    answered(shelfQuery.status) &&
    answered(queueStatus) &&
    answered(cookingStatus) &&
    answered(completedStatus) &&
    answered(askStatus);
  // A read that never answers (a hung server, a tablet that's offline: its queries pause)
  // must not leave the body blank for good (verifier round 1, item 2). Offline, the body
  // draws at once with what was last kept (the cached answers, else none); online, it waits
  // 3 s for the reads. Either way a word in the body says it hasn't been read, so an empty
  // queue is never claimed for a kitchen that wasn't asked.
  const online = useOnline();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), READ_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const ready = answeredAll || waited || !online;
  const loading = answeredAll ? null : online ? "slow" : "offline";

  return (
    <div className="cook-edge min-h-screen bg-ground">
      <KitchenHome
        ready={ready}
        loading={loading}
        cooking={(cookingItems ?? []).map(kitchenItem)}
        queue={(queueItems ?? []).map(kitchenItem)}
        // The cook being rated is the ask's subject, so it isn't also offered to cook again.
        recent={(completedItems ?? [])
          .filter((item) => item.id !== cookAsk?.queueId || cookAsk.queueId === dismissed)
          .slice(0, 3)
          .map(kitchenItem)}
        shelf={shelf}
        onOpenSaved={() => setIsSavedOpen(true)}
        flagged={<FlaggedEntry />}
        ask={
          cookAsk &&
          cookAsk.queueId !== dismissed && (
            <CookAskLine
              ask={cookAsk}
              onRate={(rating, note) => handleRate(cookAsk.queueId, rating, note)}
              onRetry={() => handleRetry(cookAsk.queueId)}
              onDismiss={() => handleDismiss(cookAsk.queueId)}
            />
          )
        }
        onStart={handleStartFromQueue}
        onRemove={handleRemoveFromQueue}
        onMarkDone={(queueId) =>
          updateQueueStatus.mutate({ queueId, status: "completed" })
        }
        onOpenImport={() => setIsImportModalOpen(true)}
        // A hook left unconnected takes its tile and its modal with it.
        onOpenAddIngredients={connected.pantry ? () => setIsAddIngredientsModalOpen(true) : undefined}
        onOpenShoppingList={connected["shopping-list"] ? () => setIsShoppingListOpen(true) : undefined}
        onOpenAsk={() => setIsAskOpen(true)}
      />

      <AskSous
        recipeContext={
          (cookingItems?.[0] ? nameOf(cookingItems[0]) : undefined) ??
          (queueItems?.[0] ? nameOf(queueItems[0]) : undefined) ??
          "Kitchen"
        }
        queueId={cookingItems?.[0]?.id ?? queueItems?.[0]?.id}
        sessionId="kitchen-home"
        isExpanded={isAskOpen}
        onToggle={() => setIsAskOpen(false)}
      />

      {/* Shopping List Modal */}
      {connected["shopping-list"] && (
        <ShoppingListModal
          isOpen={isShoppingListOpen}
          onClose={() => {
            setIsShoppingListOpen(false);
            if (typeof window !== "undefined") {
              const params = new URLSearchParams(window.location.search);
              if (params.get("shopping") === "true") {
                router.replace("/kitchen", { scroll: false });
              }
            }
          }}
        />
      )}

      {/* Add Ingredients Modal */}
      {connected.pantry && (
        <AddIngredientsModal
          isOpen={isAddIngredientsModalOpen}
          onClose={() => setIsAddIngredientsModalOpen(false)}
          onSuccess={() => refetchAll()}
        />
      )}

      {/* Import Modal */}
      <RecipeImportModal
        isOpen={isImportModalOpen}
        onClose={() => {
          setIsImportModalOpen(false);
          // Clear the import param from URL if it was set
          if (typeof window !== "undefined") {
            const params = new URLSearchParams(window.location.search);
            if (params.get("import") === "true") {
              router.replace("/kitchen", { scroll: false });
            }
          }
        }}
        onImport={handleImportRecipe}
        onStartCooking={handleStartCooking}
        onSaveAsInspiration={connected.ideas ? handleSaveAsInspiration : undefined}
        onImportFromUrl={handleImportFromUrl}
        onImportFromText={handleImportFromText}
        onImportFromImage={handleImportFromImage}
        isLoading={addToQueue.isPending}
      />

      {/* Saved for Later (ideas drawer) */}
      {isSavedOpen && connected.ideas && (
        <SavedForLater
          data={ideas.data && { ideas: ideas.data.ideas, stale: ideas.data.stale }}
          failed={ideas.error !== null}
          back="Back to the kitchen"
          onClose={() => setIsSavedOpen(false)}
        />
      )}
    </div>
  );
}

// Wrap in Suspense for useSearchParams (required in Next.js 16)
export default function KitchenPage() {
  return (
    <Suspense
      fallback={<LoadingScreen />}
    >
      <KitchenPageContent />
    </Suspense>
  );
}
