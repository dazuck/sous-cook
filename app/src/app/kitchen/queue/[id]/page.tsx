"use client";

import { use, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CookScreen } from "@/components/kitchen/CookScreen";
import { useKitchenTimers } from "@/components/kitchen/KitchenTimers";
import { LoadingScreen } from "@/components/kitchen/LoadingScreen";
import { Button } from "@/components/ui";
import { useWakeLock } from "@/hooks";
import { useCookSession } from "@/hooks/useCookSession";
import { useIntakeAsk } from "@/hooks/useIntakeAsk";
import { useFinishCook } from "@/hooks/useFinishCook";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { hasStepsToPlan, isCurrentCookPlan } from "@/lib/kitchen/cook-plan";
import { getPrepMode } from "@/lib/kitchen/cook-prefs";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { openCook, OPEN_COPY } from "@/lib/kitchen/cook-open";
import {
  initialSessionFor,
  loadSession,
  removeSession,
  removeTabServings,
  resolvePlan,
  saveSession,
  saveTabServings,
  type CookSession,
  type Resume,
  type StoredSession,
} from "@/lib/kitchen/cook-session";
import { keepCookOffline } from "@/lib/pwa/offline-cook";
import { holdUpdates } from "@/lib/pwa/update-when-idle";
import type { Recipe } from "@sous/pack";
import {
  EMPTY_LIBRARY,
  type RecipeLibrary,
  type SourcePackInfo,
} from "@/lib/pack-convert/recipe-library";
import type { KitchenQueueRecipeData } from "../../../../../drizzle/schema";
import { useCookNotices } from "./cook-notices";

interface PageProps {
  params: Promise<{ id: string }>;
}

const noSubscription = () => () => {};

/**
 * The session the tablet kept for this item (slice B5b): undefined while the
 * page hydrates, since the server can't see the tablet's storage and the
 * first render must match its HTML; then the session, or null. Read once per
 * page load.
 */
function useStoredSession(id: string): StoredSession | null | undefined {
  const read = useRef<{ id: string; value: StoredSession | null } | null>(null);
  return useSyncExternalStore(
    noSubscription,
    () => {
      if (read.current?.id !== id) read.current = { id, value: loadSession(id) };
      return read.current.value;
    },
    () => undefined,
  );
}

export default function KitchenQueuePage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();

  // Wake lock to keep screen on while cooking
  const { requestWakeLock, releaseWakeLock } = useWakeLock();

  // Request wake lock on mount
  useEffect(() => {
    requestWakeLock();
    return () => {
      releaseWakeLock();
    };
  }, [requestWakeLock, releaseWakeLock]);

  // Fetch queue item data. Offline, React Query pauses the fetch rather than
  // failing it, and the page draws from the kept session instead (B5b, E6).
  const query = trpc.getKitchenQueueItem.useQuery({ queueId: id });
  const { data: queueItem, isLoading, error, fetchStatus, failureCount } = query;
  const { dropCookNotices } = useKitchenTimers();
  const stored = useStoredSession(id);

  // An item still waiting for intake (cook-fidelity plan) is cut before the
  // cook meets it: the page asks once per load and opens on the item the
  // answer carries. With nothing kept it waits meanwhile (`openCook`), and a
  // failed ask cooks the recipe as sent; a cook already under way goes on
  // as sent and never waits (`useIntakeAsk`).
  const { asked: intakeAsked, answer: intakeAnswer } = useIntakeAsk(
    id,
    queueItem?.intake?.state === "pending",
    stored,
  );

  // Cooking an item intake may still cut (the ask failed): the page keeps the
  // item it opened on, so a later read can't swap the recipe under the cook.
  const [held, setHeld] = useState<NonNullable<typeof queueItem> | null>(null);

  // Once a page load draws the cook from the kept snapshot, it stays on it:
  // nothing swaps under the cook when the connection comes back. Set during
  // render, React's pattern for a value derived from earlier renders.
  const [latched, setLatched] = useState<"live" | "snapshot" | null>(null);
  const open = openCook(
    { isLoading, paused: fetchStatus === "paused", failures: failureCount, item: held ?? queueItem, error },
    stored,
    latched,
    { intakeAsked, intakeAnswer: held === null ? intakeAnswer : null },
  );
  if (open.kind === "cook" && latched === null) setLatched(open.from);
  const openedOn = intakeAnswer ?? queueItem;
  if (open.kind === "cook" && open.from === "live" && !open.plans && held === null && openedOn) {
    setHeld(openedOn);
  }

  // Nothing to cook: the first load failed, the item has no recipe, or its
  // recipe can't be read as a pack recipe (slice B4). A failed background
  // refetch keeps the last good data, and the cook stays mounted through it;
  // unmounting would throw away position and ticks.
  const failure = open.kind === "fail" ? open.code : null;
  const unreadable = failure === "UNREADABLE" ? queueItem : null;
  useEffect(() => {
    if (!failure) return;
    // The cook never opened: a reset line read for it has no screen to draw
    // it, and waits for no other cook.
    dropCookNotices();
    // An item that is gone takes its kept session with it (B5.md B4).
    if (failure === "NOT_FOUND") {
      removeSession(id);
      removeTabServings(id);
    }
    const why = `Couldn't open queue item ${id} (${failure})`;
    if (unreadable) console.error(`${why}: ${unreadable.conversionError ?? ""}`);
    else if (error) console.error(why, error);
    else if (failure === "OFFLINE") console.warn(why);
    else console.error(why);
  }, [failure, id, error, unreadable, dropCookNotices]);

  if (open.kind === "wait") return <LoadingScreen />;

  if (open.kind === "fail") {
    // One plain line, announced; the raw error stays off the screen, in the
    // log and, as its code, on the page for an inspector on the tablet. A
    // recipe that can't be read names itself and says why (B4).
    return (
      <main
        data-error-code={open.code}
        className="flex min-h-screen flex-col items-center justify-center gap-[var(--space-4)] bg-ground p-[var(--space-4)] text-center font-[family-name:var(--font-text)]"
      >
        <div role="alert" className="flex max-w-2xl flex-col gap-[var(--space-2)]">
          {unreadable ? (
            <>
              <p data-recipe-name className="text-lg font-medium text-ink-soft">
                {unreadable.recipeData?.name}
              </p>
              <h1 className="text-2xl font-semibold text-ink">{COOK_COPY.unreadable}</h1>
              <p data-reason className="text-lg font-medium text-ink-soft">
                {unreadable.conversionError}
              </p>
            </>
          ) : (
            <h1 className="text-2xl font-semibold text-ink">
              {open.code === "OFFLINE" ? OPEN_COPY.offlineNothingKept : "Couldn't open this recipe."}
            </h1>
          )}
        </div>
        <Button variant="secondary" size="lg" onClick={() => router.push("/kitchen")}>
          Back to the kitchen
        </Button>
      </main>
    );
  }

  if (open.from === "snapshot") {
    const { snapshot, fingerprint } = open.stored;
    return (
      <CookSessionView
        key={id}
        id={id}
        recipe={snapshot.recipeData}
        packRecipe={snapshot.packRecipe}
        library={snapshot.library ?? EMPTY_LIBRARY}
        scales={snapshot.scales ?? false}
        sourcePack={snapshot.sourcePack}
        storedPlan={snapshot.cookPlan}
        fingerprint={fingerprint}
        start={{ kind: "resume", stored: open.stored }}
        fromSnapshot={true}
        shownAsSent={snapshot.shownAsSent ?? false}
        plans={!(snapshot.shownAsSent ?? false)}
      />
    );
  }

  return (
    <CookSessionView
      key={id}
      id={id}
      recipe={open.recipe}
      packRecipe={open.packRecipe}
      library={open.library}
      scales={open.scales}
      sourcePack={open.sourcePack}
      storedPlan={open.storedPlan}
      fingerprint={open.fingerprint}
      start={open.start}
      fromSnapshot={false}
      shownAsSent={open.shownAsSent}
      plans={open.plans}
    />
  );
}

interface CookSessionViewProps {
  id: string;
  recipe: KitchenQueueRecipeData;
  /** The recipe read as a pack recipe, which every amount on screen reads from. */
  packRecipe: Recipe;
  /** The library entries a natively read recipe's refs name (slice B5d); empty otherwise. */
  library: RecipeLibrary;
  /** Whether the cook page may scale the recipe's serving count (slice B5c, B5c-13). */
  scales: boolean;
  /** Source-pack attribution when the recipe came from or was adapted from an installed pack. */
  sourcePack?: SourcePackInfo;
  /** The plan stored on the queue item, if any; it may be stale or absent. */
  storedPlan: unknown;
  /** The stored recipe's fingerprint, kept with the session (B5b, B3). */
  fingerprint: string;
  /**
   * Where the cook starts: the session the tablet kept, a fresh cook, or a
   * fresh cook because the recipe changed since that session (B5b).
   */
  start: Resume;
  fromSnapshot?: boolean;
  /** The recipe reads as it came, intake having failed (cook-fidelity plan). */
  shownAsSent: boolean;
  /**
   * Whether the cook asks for and takes a plan: not for an item intake may
   * still cut, whose plan could be the cut's (`openCook`).
   */
  plans: boolean;
}

/**
 * One cook of one queued recipe. It resumes the session the tablet kept for
 * it when the stored recipe is unchanged, keeping the plan that session was
 * cooking (B5b, B2). Otherwise it starts from the stored plan, or the recipe
 * as written while the plan is still being worked out, and asks for a plan
 * once per open when there is no current one. A plan that arrives is offered
 * to the session, which takes it only while the cook hasn't started. Every
 * change is kept on the tablet, so a reload resumes where the cook was.
 */
function CookSessionView({
  id,
  recipe,
  packRecipe,
  library,
  scales,
  sourcePack,
  storedPlan,
  fingerprint,
  start,
  fromSnapshot = false,
  shownAsSent,
  plans,
}: CookSessionViewProps) {
  const router = useRouter();
  const { say, unsay } = useKitchenTimers();
  const { extraNotices, recordPlanError } = useCookNotices();

  const queueOriginal = trpc.queueFromPack.useMutation({
    onSuccess: (item) => router.push(`/kitchen/queue/${item.id}`),
    onError: (err) => {
      console.error("Queue original pack recipe error:", err);
    },
  });

  const onCookOriginal = useCallback(() => {
    if (!sourcePack || queueOriginal.isPending) return;
    queueOriginal.mutate({
      packId: sourcePack.packId,
      recipeId: sourcePack.recipeId,
    });
  }, [sourcePack, queueOriginal]);

  useEffect(() => {
    if (start.kind !== "changed") return;
    say(OPEN_COPY.changed);
    // The provider lives in the kitchen layout, above every cook: the line
    // belongs to this cook only, so it goes when the cook does.
    return () => unsay(OPEN_COPY.changed);
  }, [start.kind, say, unsay]);

  const [online, setOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (fromSnapshot && !online) {
      say(OPEN_COPY.offline, { persistent: true });
    } else {
      unsay(OPEN_COPY.offline);
    }
    return () => {
      unsay(OPEN_COPY.offline);
    };
  }, [fromSnapshot, online, say, unsay]);

  // The part of a paged step the cook is on, and the stage width it was
  // paged at: kept with the session, so a reload resumes on that part at that
  // width (CookFlow starts the step over at any other).
  const partRef = useRef(start.kind === "resume" ? (start.stored.part ?? 0) : 0);
  const partWidthRef = useRef<number | undefined>(
    start.kind === "resume" ? start.stored.partWidth : undefined,
  );
  const posRef = useRef(
    start.kind === "resume" ? start.stored.session.state.pos : 0,
  );
  const prevServingsRef = useRef<number | undefined>(undefined);
  const syncedInitialServings = useRef(false);

  // Kept after each move, with what the page needs to draw the cook again
  // with no connection. Finish removes it once the save lands.
  const keep = useCallback(
    (s: CookSession) => {
      if (!syncedInitialServings.current) {
        syncedInitialServings.current = true;
        prevServingsRef.current = s.servings;
      } else if (s.servings !== prevServingsRef.current) {
        prevServingsRef.current = s.servings;
        saveTabServings(
          id,
          fingerprint,
          s.servings ?? packRecipe.serves_base,
          packRecipe.serves_base,
        );
      }
      if (s.state.pos !== posRef.current) {
        posRef.current = s.state.pos;
        partRef.current = 0;
        partWidthRef.current = undefined;
      }
      saveSession(
        id,
        fingerprint,
        s,
        {
          recipeData: recipe,
          packRecipe,
          cookPlan: storedPlan,
          library,
          scales,
          sourcePack,
          ...(shownAsSent && { shownAsSent: true }),
        },
        Date.now(),
        undefined,
        partRef.current,
        partWidthRef.current,
      );
    },
    [id, fingerprint, recipe, packRecipe, storedPlan, library, scales, sourcePack, shownAsSent],
  );
  const [session, dispatch] = useCookSession(
    recipe.name,
    () =>
      initialSessionFor({
        id,
        recipe,
        packRecipe,
        storedPlan,
        fingerprint,
        start,
        fromSnapshot,
        mode: getPrepMode(),
      }),
    keep,
  );

  const onPart = useCallback(
    (newPart: number, width: number) => {
      partRef.current = newPart;
      partWidthRef.current = width;
      saveSession(
        id,
        fingerprint,
        session,
        {
          recipeData: recipe,
          packRecipe,
          cookPlan: storedPlan,
          library,
          scales,
          sourcePack,
          ...(shownAsSent && { shownAsSent: true }),
        },
        Date.now(),
        undefined,
        newPart,
        width,
      );
    },
    [id, fingerprint, session, recipe, packRecipe, storedPlan, library, scales, sourcePack, shownAsSent],
  );

  // Read once, when the cook screen mounts, at the step the session was kept on.
  const resumePart = start.kind === "resume" ? start.stored.part : undefined;
  const resumeWidth = start.kind === "resume" ? start.stored.partWidth : undefined;

  // A plan stored since the page loaded (the queue-time derivation finishing,
  // seen on a refetch) is offered like one derived here.
  useEffect(() => {
    if (plans && isCurrentCookPlan(storedPlan)) {
      dispatch({ type: "offer", ...resolvePlan(recipe, storedPlan, "waiting") });
    }
  }, [plans, recipe, storedPlan, dispatch]);

  // Ask for a plan once per open when none is stored. Every open retries a
  // failed derivation; the cook runs as written meanwhile and never waits.
  // A recipe with no steps has nothing to plan, so it never asks.
  const ensure = trpc.ensureCookPlan.useMutation();
  const { mutate: ensurePlan } = ensure;
  const askedForPlan = useRef(false);
  const hasStoredPlan = isCurrentCookPlan(storedPlan);
  const needsPlan = plans && !hasStoredPlan && hasStepsToPlan(recipe);
  useEffect(() => {
    if (askedForPlan.current || !needsPlan) return;
    askedForPlan.current = true;
    ensurePlan(
      { queueId: id },
      {
        onSuccess: (outcome) =>
          dispatch({
            type: "offer",
            ...resolvePlan(recipe, null, { plan: outcome.plan }),
          }),
        onError: (err) => {
          console.error("Could not work out the prep plan:", err);
          recordPlanError(err);
          dispatch({ type: "offer", ...resolvePlan(recipe, null, "failed") });
        },
      },
    );
  }, [ensurePlan, needsPlan, id, recipe, dispatch, recordPlanError]);

  // While the cook is on screen a new build waits (B5b, B6), and the worker
  // keeps this page and its files for a reload with no connection (E4).
  useEffect(() => {
    keepCookOffline();
    return holdUpdates();
  }, []);

  const ended = useCallback(() => {
    removeSession(id);
    removeTabServings(id);
  }, [id]);
  const { finish, finishCook } = useFinishCook(id, ended);

  return (
    <CookScreen
      recipe={recipe}
      packRecipe={packRecipe}
      library={library}
      scales={scales}
      sourcePack={sourcePack}
      onCookOriginal={sourcePack?.isAdapted ? onCookOriginal : undefined}
      cookingOriginal={queueOriginal.isPending}
      shownAsSent={shownAsSent}
      session={session}
      dispatch={dispatch}
      onFinish={finishCook}
      finish={finish}
      queueItemId={id}
      resumePart={resumePart}
      resumeWidth={resumeWidth}
      onPart={onPart}
      extraNotices={extraNotices}
    />
  );
}
