"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
} from "react";
import type { PrepMode } from "@/lib/kitchen/cook-plan";
import {
  getVoiceEnabled,
  setPrepMode,
  setVoiceEnabled,
} from "@/lib/kitchen/cook-prefs";
import {
  effectiveServings,
  type CookAction,
  type CookSession,
} from "@/lib/kitchen/cook-session";
import { strip, type Strip } from "@/lib/kitchen/cook-strip";
import { nudge as startNudge, walkAway } from "@/lib/kitchen/cook-levels";
import { hasOpening, opensOnChart } from "@/lib/kitchen/cook-opening";
import {
  askInHand,
  COOK_COPY,
  cookView,
  hasPrep,
  hasPrepScreen,
  hasUpfrontPrep,
  prepSummary,
  missedAheadQuestion,
  screenForSourceStep,
  sourceStepStates,
  usedIngredients,
  type PrepAheadGroup,
} from "@/lib/kitchen/cook-view";
import { ingredientText, storedIngredientLines } from "@/lib/kitchen/ingredient-display";
import { recipeTimeLine } from "@/lib/kitchen/time-line";
import { shownTimes } from "@/lib/kitchen/recipe-times";
import { offerForScreen, timerOffers } from "@/lib/kitchen/timer-attach";
import { inTimerRange } from "@/lib/kitchen/timers";
import {
  howMuchHeard,
  normalizeUtterance,
  timerRequestSeconds,
  wordsToSous,
  type VoiceCommand,
} from "@/lib/kitchen/wake-word";
import { answerFor, answerHowMuch, type HowMuchAnswer } from "@/lib/kitchen/how-much";
import { hasHowToCheck, screenStep, type ScreenStep } from "@/lib/kitchen/step-types";
import { checkInterludes, isCollapsed, markSeen } from "@/lib/kitchen/interlude-seen";
import { connected } from "@/lib/hooks/connected";
import { useSpeak } from "@/hooks/useSpeak";
import type { UnitId } from "@sous/pack/quantity";
import { cookSnapshot, layerChanges, type CookLayers } from "@/lib/kitchen/cook-snapshot";
import { recordEvent } from "@/lib/kitchen/report-events";
import type { CookSnapshot } from "@/lib/kitchen/report-capture";
import { useCookFlag, useFlagNote } from "@/hooks/useCookFlag";
import { useCookAutoFinish } from "@/hooks/useCookAutoFinish";
import { useKitchenVoiceCommands } from "@/hooks/useKitchenVoiceCommands";
import { useAskForm } from "@/hooks/useAskForm";
import { afterListen, askOnCommand, type CapsuleListen } from "@/lib/kitchen/ask-listen";
import { photoProblem } from "@/lib/kitchen/ask-photo";
import type { Recipe } from "@sous/pack";
import {
  EMPTY_LIBRARY,
  type RecipeLibrary,
  type SourcePackInfo,
} from "@/lib/pack-convert/recipe-library";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import {
  AskSous,
  ASK_COPY,
  ASK_SIDE_WIDTH,
  DEFAULT_DISH_QUESTION,
  type AskSousHandle,
} from "./AskSous";
import { AskCapsule, type AskCapsuleHandle, type AskWay } from "./AskCapsule";
import { AlarmBand } from "./AlarmBand";
import {
  CookFlow,
  type AnswerShown,
  type CookFlowNav,
  type CookTimers,
  type FinishState,
  type StepTypeProps,
} from "./CookFlow";
import { TimerHere, useKitchenTimers, useNow } from "./KitchenTimers";
import type { CookSheetHandle, Level } from "./CookSheet";
import { VOICE_COPY } from "./VoiceDot";
import { KitchenLayout } from "./KitchenLayout";
import { RecipeHeader, type HeaderMenu } from "./RecipeHeader";
import { OpeningControls, openingWords, useOpeningKeys } from "./CookOpening";
import { HeaderMore } from "./HeaderMore";
import type { PotTimer } from "@/lib/kitchen/cook-overview";
import { RecipeInfoModal } from "./RecipeInfoModal";
import { MarkUsedSheet } from "./MarkUsedSheet";
import { VoiceSaid } from "./VoiceDot";

const NO_CHECKS: ReadonlySet<string> = new Set();

/**
 * Whether a derived plan's whole cook keeps the top line (N3-4(f), the
 * alternative considered). Off: the lanes take the screen and the sheet
 * hosts More, as the opening does.
 */
const TOP_LINE_AT_WHOLE_COOK = false;

/**
 * How long a "how much" answer stands (B5d, D13): on its pair, as discussed,
 * or on the foot's lift. Long enough to read across the kitchen; the next
 * command, a tap or a move puts it away sooner.
 */
export const ANSWER_LINGER_MS = 8000;

/** Commands that, said over Ask open, close it instead of moving steps. */
const BACK_OUT: ReadonlySet<VoiceCommand> = new Set(["next", "back", "done", "close"]);

/** What voice says back about timers (B5a, A12). Placeholder copy. */
export const VOICE_TIMER_COPY = {
  noTimer: "No timer on this step",
  running: "That timer's running",
  cantSet: "Couldn't set that timer",
  noneDone: "No timer has finished",
  label: "Timer",
} as const;

interface CookScreenProps {
  /** The recipe as stored: its plan, name, times and info read from it (B4 decision 6). */
  recipe: KitchenQueueRecipeData;
  /**
   * The same recipe read as a pack recipe (slice B4 step 8): every amount the
   * cook sees reads from it, by the plan's stored index (looked up by id: the
   * conversion skips a blank stored line, B4 fix round 2).
   */
  packRecipe: Recipe;
  /**
   * The library entries a natively read pack recipe's refs name (slice B5d):
   * a checkpoint's evidence, an interlude's key. Empty for any other recipe.
   */
  library?: RecipeLibrary;
  /** Whether the cook page may scale the recipe's serving count (slice B5c, B5c-13); default true. */
  scales?: boolean;
  /** Source-pack attribution when the recipe came from or was adapted from an installed pack. */
  sourcePack?: SourcePackInfo;
  /** Queue and open the verbatim source pack recipe when cooking an adapted dish. */
  onCookOriginal?: () => void;
  /** True while queueing the original pack recipe. */
  cookingOriginal?: boolean;
  /** Intake couldn't cut the recipe: the info sheet says it reads as sent (cook-fidelity plan). */
  shownAsSent?: boolean;
  session: CookSession;
  dispatch: Dispatch<CookAction>;
  /** The cook is done with the recipe (the finish button, or "done" said on the last screen). */
  onFinish: () => void;
  /** Saving waits on the finish control; a failure says so on it. */
  finish: FinishState;
  /** The queue item being cooked, left out of the header's recent-items list. */
  queueItemId?: string;
  /**
   * The other recipes in progress, listed in the header's More (default
   * on). Off in the fixture viewer, whose links would open real queue items.
   */
  showRecentItems?: boolean;
  /** When set, Ask Claude answers with this and never calls the model. */
  askOfflineReply?: string;
  resumePart?: number;
  resumeWidth?: number;
  onPart?: (part: number, width: number) => void;
}

export function CookScreen({
  recipe,
  packRecipe,
  library = EMPTY_LIBRARY,
  scales = true,
  sourcePack,
  onCookOriginal,
  cookingOriginal = false,
  shownAsSent = false,
  session,
  dispatch,
  onFinish,
  finish,
  queueItemId,
  showRecentItems = true,
  askOfflineReply,
  resumePart,
  resumeWidth,
  onPart,
}: CookScreenProps) {
  const { plan, source, state } = session;
  const view = useMemo(() => cookView(plan, source, state), [plan, source, state]);
  const servings = effectiveServings(packRecipe, session, scales);
  const scaleNote =
    scales && servings !== packRecipe.serves_base ? COOK_COPY.scaleNote(servings) : null;
  const onServingsChange = useCallback(
    (next: number) => dispatch({ type: "servings", servings: next }),
    [dispatch],
  );

  const [isClaudeExpanded, setIsClaudeExpanded] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showMarkUsedSheet, setShowMarkUsedSheet] = useState(false);
  // The kitchen's timers (slice B5a): the step in hand's offer or clock in
  // its meta, every other timer in the ledge, one ember among them.
  const kitchen = useKitchenTimers();
  // The opening (N2-10): the whole cook's chart before Prep, decided once at
  // the first render, so a plan arriving later never summons it. Never kept:
  // a reload before any progress shows it again (N2 decision 6).
  const [opening, setOpening] = useState(() => opensOnChart(session));
  // The look-ahead's level (N2): 0 Now, 1 until you can step away, 2 the
  // whole cook, 3 Whole recipe. Never kept: a reload opens at Now (N12), or
  // on the opening, which is the chart's level.
  const [sheetLevel, setSheetLevel] = useState<Level>(opening ? 2 : 0);
  const sheetHandle = useRef<CookSheetHandle | null>(null);
  // A step read in place (N8): a row on the chart, a step as written at Whole recipe.
  const [readMark, setReadMark] = useState<string | null>(null);
  const [readStep, setReadStep] = useState<number | null>(null);
  // Whole recipe's ingredient checks a tap overrode: kept while the cook is open.
  const [ingredientOverrides, setIngredientOverrides] = useState<Map<number, boolean>>(() => new Map());
  const [prevPos, setPrevPos] = useState(state.pos);
  if (state.pos !== prevPos) {
    setPrevPos(state.pos);
    setReadMark(null);
    setReadStep(null);
  }
  // Leaving the chart puts its read away; leaving Whole recipe puts its away.
  if (readMark !== null && sheetLevel !== 2) setReadMark(null);
  if (readStep !== null && sheetLevel !== 3) setReadStep(null);

  // Pull-to-refresh is off on the cook route (N3, N7)
  useEffect(() => {
    document.documentElement.classList.add("cook-route");
    return () => {
      document.documentElement.classList.remove("cook-route");
    };
  }, []);

  const askRef = useRef<AskSousHandle>(null);
  // Ask Sous is the capsule at the top line's right end, and on the cook
  // screen its panel is beside the step or a full sheet (DS §5 Ask, v1.60).
  // How it was opened says where focus lands in it (`enter`) and which part
  // of the capsule focus comes back to (`way`).
  const capsuleRef = useRef<AskCapsuleHandle>(null);
  const openingMicRef = useRef<HTMLButtonElement>(null);
  const [askEntry, setAskEntry] = useState<{ way: AskWay; enter: "field" | "controls" }>({
    way: "words",
    enter: "field",
  });
  // The capsule's mic opened the panel to listen: "armed" until the listen
  // starts, "heard" while and after it. Null once the cook puts a hand to
  // the panel, or the listen has been dealt with (call 13).
  const capsuleListen = useRef<CapsuleListen>(null);
  const openAsk = useCallback(
    (way: AskWay, enter: "field" | "controls") => {
      setAskEntry({ way, enter });
      setIsClaudeExpanded(true);
      // Ask and a raised look-ahead never share the screen (call 21): a
      // pinned level goes away, and so does Whole recipe, which is modal
      // (a question asked aloud over it would otherwise open Ask's sheet
      // under it, with nothing left to touch). The opening's chart is no
      // pinned level.
      if (!opening) setSheetLevel(0);
    },
    [opening],
  );
  const closeAsk = useCallback(() => setIsClaudeExpanded(false), []);
  const openAskToType = useCallback(() => openAsk("words", "field"), [openAsk]);
  const engageAsk = useCallback(() => {
    capsuleListen.current = null;
  }, []);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const handlePhotoTrigger = useCallback(() => {
    photoInputRef.current?.click();
  }, []);

  // A photo is the cook's turn in the conversation, asked at once (call 15):
  // no review page. A cancelled camera opens nothing; a file that cannot be
  // read opens the panel to say so.
  const askOpenNow = useRef(isClaudeExpanded);
  useLayoutEffect(() => {
    askOpenNow.current = isClaudeExpanded;
  });
  const handlePhotoFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const show = (turn: (ask: AskSousHandle) => void) => {
        capsuleListen.current = null;
        if (!askOpenNow.current) openAsk("camera", "controls");
        if (askRef.current) turn(askRef.current);
      };
      const refuse = (problem: "unread" | "not-a-photo") =>
        show((ask) => ask.notice(problem === "unread" ? ASK_COPY.photoUnread : ASK_COPY.photoNotPhoto));
      const unread = () => refuse("unread");
      // Known before reading: an empty file, or one that says it is no picture.
      const early = photoProblem(file, "data:image/");
      if (early !== null) {
        refuse(early);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : null;
        const problem = photoProblem(file, dataUrl);
        if (problem !== null || dataUrl === null) {
          refuse(problem ?? "unread");
          return;
        }
        show((ask) => ask.askWithPhoto(dataUrl, DEFAULT_DISH_QUESTION, { shown: ASK_COPY.photoShown }));
      };
      reader.onerror = unread;
      reader.readAsDataURL(file);
    },
    [openAsk],
  );

  const [clockInWell, setClockInWell] = useState(false);
  // "Now" moves with the step's own running timer, a minute at a time (N6):
  // the clock ticks while a timer runs, and the strip is read to the minute.
  const anyRunning = kitchen.timers.length > 0;
  const tick = useNow(anyRunning);
  const offers = useMemo(
    () => timerOffers(plan, packRecipe, { queueId: queueItemId ?? "cook", recipeName: recipe.name }),
    [plan, packRecipe, queueItemId, recipe.name],
  );
  const screenKey = view.onPrep ? null : (view.stack[0]?.key ?? null);
  const offer = screenKey === null ? null : offerForScreen(offers, screenKey);
  // Timers that rang and were stopped, here or anywhere in the kitchen
  // (`stopped`): their steps say so and offer them again, rather than
  // offering them as new (design round 2; B5a verify round 2).
  const { dismiss } = kitchen;
  const timers = useMemo<CookTimers>(() => {
    const byEnd = [...kitchen.timers].sort((a, b) => a.endsAtEpochMs - b.endsAtEpochMs);
    const running = byEnd.filter((t) => !kitchen.expired.has(t.id));
    // At the chart, where the step fades out, or Whole recipe, the
    // clock walks into the well (N10).
    const stepTimer = offer && !clockInWell ? (running.find((t) => t.id === offer.id) ?? null) : null;
    return {
      offer,
      stepTimer,
      done: offer !== null && stepTimer === null && kitchen.stopped.has(offer.id),
      ringing: offer !== null && kitchen.expired.has(offer.id),
      ledge: running.filter((t) => t.id !== stepTimer?.id),
      expired: byEnd.filter((t) => kitchen.expired.has(t.id)),
      soonestRunning: running[0]?.id ?? null,
      soundLocked: kitchen.soundLocked,
      onStart: () => {
        if (offer) kitchen.start(offer);
      },
      onDismiss: dismiss,
      onAllowSound: kitchen.allowSound,
      prepOffer: (taskId) => {
        const rowOffer = offers.get(taskId);
        return rowOffer && !kitchen.timers.some((t) => t.id === rowOffer.id) ? rowOffer : null;
      },
      onStartOffer: (rowOffer) => kitchen.start(rowOffer),
    };
  }, [offer, offers, kitchen, dismiss, clockInWell]);

  // The pots' started timers by task, for the whole cook's lanes (N3-1): a
  // card reads its minutes left from its own clock, and a pot whose timer
  // rang or was stopped is done.
  const potTimers = useMemo(() => {
    const out = new Map<string, PotTimer>();
    for (const [taskId, o] of offers) {
      const t = kitchen.timers.find((k) => k.id === o.id);
      if (t) out.set(taskId, { endsAtEpochMs: t.endsAtEpochMs, done: kitchen.expired.has(t.id) });
      else if (kitchen.stopped.has(o.id)) out.set(taskId, { endsAtEpochMs: 0, done: true });
    }
    return out;
  }, [offers, kitchen.timers, kitchen.expired, kitchen.stopped]);

  // Auto-finish (cook-fidelity decision 7): a cook left on its last screen,
  // nothing moving and no timer of its own running, counts as finished 45
  // minutes on, dated to its last activity. This cook's timers are those its
  // offers carry and the ones said aloud ("set a timer"), which name no recipe.
  const cookTimerId = queueItemId ?? "cook";
  const ownTimers = useMemo(
    () => kitchen.timers.filter((t) => t.queueId === cookTimerId || t.queueId === null),
    [kitchen.timers, cookTimerId],
  );
  const timerEnds = useMemo(() => ownTimers.map((t) => t.endsAtEpochMs), [ownTimers]);
  const { autoFinished, touch, inOrder } = useCookAutoFinish({
    queueId: queueItemId,
    onLastScreen: view.isLast,
    timerEnds,
    // The cook acting on the cook: what reopens one the app finished, with a
    // timer of its own started.
    timerIds: ownTimers.map((t) => t.id),
    cookKey: `${state.pos}|${[...state.ticked].join(",")}|${session.servings ?? ""}`,
  });
  const { say, unsay } = kitchen;
  useEffect(() => {
    if (!autoFinished) return;
    say(COOK_COPY.finishedNotPressed, { persistent: true });
    return () => unsay(COOK_COPY.finishedNotPressed);
  }, [autoFinished, say, unsay]);

  // The strip, read to the cook's minute: the step's running timer moves now on.
  const stepRunning = offer
    ? (kitchen.timers.find((t) => t.id === offer.id && !kitchen.expired.has(t.id)) ?? null)
    : null;
  const elapsedMin =
    stepRunning && tick > 0
      ? Math.max(0, Math.floor((stepRunning.durationMs - (stepRunning.endsAtEpochMs - tick)) / 60_000))
      : 0;
  const stripData = useMemo<Strip | null>(
    () =>
      plan.tasks.length > 0
        ? strip(
            plan,
            state,
            stepRunning,
            stepRunning ? stepRunning.endsAtEpochMs - stepRunning.durationMs + elapsedMin * 60_000 + 1 : 0,
          )
        : null,
    [plan, state, stepRunning, elapsedMin],
  );
  // The nudge's slot holds the start nudge; the walk-away line moved onto the step's meta (look-ahead
  // slice 1, DS v1.62), shown where the start nudge doesn't apply (its free time is then shorter, N2-8).
  const nudgeData = useMemo(() => (stripData ? startNudge(stripData, stripData.now) : null), [stripData]);
  const awayLine = useMemo(() => {
    const w = stripData && !nudgeData ? walkAway(stripData) : null;
    return w ? COOK_COPY.stepAwayMeta(w.minutes) : null;
  }, [stripData, nudgeData]);

  // Quiet lines (a reset, B5b's) are drawn here, so a reset line need not
  // wait in the tab for a later page; they are read once the cook moves on.
  const { clearNotices, noticesShown } = kitchen;
  // Keyed by the lines, so a line added while others stand is marked too.
  const noticeLines = kitchen.notices.join("\n");
  useEffect(() => {
    if (noticeLines) noticesShown();
  }, [noticeLines, noticesShown]);
  const posWas = useRef(state.pos);
  useEffect(() => {
    if (posWas.current === state.pos) return;
    posWas.current = state.pos;
    clearNotices();
  }, [state.pos, clearNotices]);

  const canOpen = useMemo(
    () => hasOpening(plan, source, state.mode, state.ticked),
    [plan, source, state.mode, state.ticked],
  );
  const firstActivePos = useMemo(
    () => (hasPrepScreen(plan, state.mode) && !hasUpfrontPrep(plan, state.mode) ? 1 : 0),
    [plan, state.mode],
  );
  const onNext = useCallback(() => dispatch({ type: "next" }), [dispatch]);
  const onBack = useCallback(() => {
    if (canOpen && state.pos <= firstActivePos) {
      if (state.pos > 0) dispatch({ type: "jump", pos: 0 });
      // The opening has no step for Ask to stand beside: a panel left open
      // would turn into a sheet over it. It closes; the conversation is kept.
      setIsClaudeExpanded(false);
      setOpening(true);
      setSheetLevel(2);
      return;
    }
    dispatch({ type: "back" });
  }, [canOpen, state.pos, firstActivePos, dispatch]);
  // A flag's lead-up says the opening showed, and when the cook started
  // (N2-11): once each, so StrictMode's second effect run logs nothing new.
  const openingLogged = useRef(false);
  useEffect(() => {
    if (!opening || openingLogged.current) return;
    openingLogged.current = true;
    recordEvent("cook", "opening");
  }, [opening]);
  // Start (N2-10): the chart folds into the strip under Prep, the sheet's own 2 → 0 glide.
  // When Prep has nothing to do before Step 1 (e.g. "As I go" with all mise inline and
  // no make-ahead), Start skips the empty Prep screen and lands directly on Step 1.
  const startCook = useCallback(() => {
    setOpening(false);
    setSheetLevel(0);
    if (view.onPrep && !hasUpfrontPrep(plan, state.mode)) {
      dispatch({ type: "next" });
    }
    recordEvent("cook", "start");
  }, [view.onPrep, plan, state.mode, dispatch]);
  const onJump = useCallback(
    (pos: number) => dispatch({ type: "jump", pos }),
    [dispatch],
  );
  // The chart's Go (N2): its marks count screens as the strip does (`goToMark`).
  const onGoMark = useCallback(
    (pos: number) => dispatch({ type: "goMark", pos }),
    [dispatch],
  );
  const onTick = useCallback(
    (task: string) => dispatch({ type: "tick", id: task }),
    [dispatch],
  );
  const onMode = useCallback(
    (mode: PrepMode) => {
      dispatch({ type: "mode", mode });
      setPrepMode(mode);
    },
    [dispatch],
  );

  // Missed ahead work opens Claude with the question ready to edit or send.
  const onAskAhead = useCallback(
    (group: PrepAheadGroup) => {
      openAsk("words", "field");
      askRef.current?.prefill(missedAheadQuestion(group));
    },
    [openAsk],
  );

  // Generate a session ID for the cooking session
  const [sessionId] = useState(() => `cook-queue-${Date.now()}`);

  // The ingredients as the cook reads them, by the stored index the plan
  // holds, and as one line each for the Ask.
  const storedCount = recipe.ingredients?.length ?? 0;
  const ingredientLines = useMemo(
    () => storedIngredientLines(packRecipe, storedCount, servings),
    [packRecipe, storedCount, servings],
  );
  // By stored index (null for a blank line), for a prep job's amounts.
  const ingredientTextAt = useMemo(
    () => ingredientLines.map((line) => (line === null ? null : ingredientText(line))),
    [ingredientLines],
  );
  const ingredientTexts = useMemo(
    () => ingredientTextAt.flatMap((text) => (text === null ? [] : [text])),
    [ingredientTextAt],
  );

  // The step in hand's kind (slice B5d, D7–D10): from the pack step its task
  // cites, for a pack recipe read natively; an action for any other.
  const screenTasks = useMemo(
    () =>
      screenKey === null
        ? []
        : screenKey.split("+").flatMap((id) => plan.tasks.filter((t) => t.id === id)),
    [screenKey, plan],
  );
  const askCurrentStepIndex = useMemo(() => {
    for (const task of screenTasks) {
      if (task.sourceStep !== null) return task.sourceStep;
    }
    return undefined;
  }, [screenTasks]);
  // No step in hand on the opening (review round 2), and none on prep,
  // where Sous is told the prep jobs instead (review round 3).
  const askHand = useMemo(
    () => askInHand(opening, view, askCurrentStepIndex, ingredientTextAt),
    [opening, view, askCurrentStepIndex, ingredientTextAt],
  );
  const askTimers = useMemo(() => {
    return kitchen.timers.map((t) => {
      const nowMs = tick > 0 ? tick : t.endsAtEpochMs - t.durationMs;
      const remainingSec = Math.round((t.endsAtEpochMs - nowMs) / 1000);
      const isExpired = kitchen.expired.has(t.id) || remainingSec <= 0;
      return {
        id: t.id,
        label: t.label,
        remainingSec,
        status: (isExpired ? "expired" : "running") as "running" | "expired",
      };
    });
  }, [kitchen.timers, kitchen.expired, tick]);
  const recipeKey = recipe.source ?? recipe.name;
  const typed = useMemo(
    () => screenStep(plan, packRecipe, library, screenTasks, recipeKey),
    [plan, packRecipe, library, screenTasks, recipeKey],
  );
  // "Not yet" open, per checkpoint screen, while the page is open (never kept:
  // a reload shows the gate, D8); checkpoints the cook has confirmed, for
  // "Checked" on a return; interludes opened again after collapsing.
  const [howToCheckOpen, setHowToCheckOpen] = useState<ReadonlySet<string>>(() => new Set());
  // Confirmed checkpoints live in the session (B5b), so "Checked" survives a
  // reload (b5d-followup).
  const confirmed = session.checked ?? NO_CHECKS;
  const [reopened, setReopened] = useState<ReadonlySet<string>>(() => new Set());
  // Whether an interlude shows collapsed is read once per landing, so moving
  // past it (which counts it) doesn't fold it under the cook's eyes.
  const [interludeFolded, setInterludeFolded] = useState<{ key: string | null; folded: boolean }>({ key: null, folded: false });
  if (interludeFolded.key !== screenKey) {
    setInterludeFolded({ key: screenKey, folded: typed.kind === "interlude" && isCollapsed(typed.keys) });
  }
  // A corrupt count is cleared, and its line said, as the cook opens (D9).
  useEffect(() => {
    if (packRecipe.steps.some((s) => s.type === "interlude")) checkInterludes();
  }, [packRecipe]);
  const toggleHowToCheck = useCallback(() => {
    if (screenKey === null) return;
    setHowToCheckOpen((was) => {
      const next = new Set(was);
      if (next.has(screenKey)) next.delete(screenKey);
      else next.add(screenKey);
      return next;
    });
  }, [screenKey]);
  // Moving forward past a screen confirms its checkpoint and counts its
  // interlude as seen, whichever way the move came (a tap, a swipe, a key,
  // voice): one path (D8, D9).
  const leaving = useRef<{ pos: number; key: string | null; step: ScreenStep }>({ pos: state.pos, key: screenKey, step: typed });
  useEffect(() => {
    const was = leaving.current;
    // Only a step forward confirms or counts: a jump from the chapters menu
    // passes a screen without reading it (D8, B5d verify round 1).
    if (state.pos === was.pos + 1 && was.key !== null) {
      const key = was.key;
      if (was.step.kind === "checkpoint") {
        dispatch({ type: "check", id: key });
        // Confirmed, the check is answered: how to check closes with it, so a
        // return shows the one "Checked" state (UI verify round 3).
        setHowToCheckOpen((open) => {
          if (!open.has(key)) return open;
          const next = new Set(open);
          next.delete(key);
          return next;
        });
      }
      if (was.step.kind === "interlude") markSeen(was.step.keys);
    }
    leaving.current = { pos: state.pos, key: screenKey, step: typed };
  }, [state.pos, screenKey, typed, dispatch]);
  const stepType: StepTypeProps = {
    step: typed,
    howToCheck: screenKey !== null && howToCheckOpen.has(screenKey),
    onNotYet: toggleHowToCheck,
    checked: screenKey !== null && confirmed.has(screenKey),
    collapsed:
      typed.kind === "interlude" &&
      interludeFolded.key === screenKey &&
      interludeFolded.folded &&
      !(screenKey !== null && reopened.has(screenKey)),
    onOpen: () => {
      if (screenKey !== null) setReopened((r) => new Set(r).add(screenKey));
    },
  };

  // "How much" (slice B5d, D11–D13): the answer, shown for its linger and
  // said aloud, with the mic held while it is said.
  const { speaking, say: speakAnswer } = useSpeak();
  const [answer, setAnswer] = useState<{ key: number; result: HowMuchAnswer; unit: UnitId | null } | null>(null);
  const answerKey = useRef(0);
  const showAnswer = useCallback(
    (result: HowMuchAnswer, unit: UnitId | null) => {
      answerKey.current += 1;
      setAnswer({ key: answerKey.current, result, unit });
      speakAnswer(result.speech);
    },
    [speakAnswer],
  );
  useEffect(() => {
    if (answer === null) return;
    const timer = setTimeout(() => setAnswer(null), ANSWER_LINGER_MS);
    return () => clearTimeout(timer);
  }, [answer]);
  // A move puts the answer away: it was about the screen the cook left.
  const [answerPos, setAnswerPos] = useState(state.pos);
  if (answerPos !== state.pos) {
    setAnswerPos(state.pos);
    if (answer !== null) setAnswer(null);
  }
  // So does a tap anywhere but on the answer itself.
  useEffect(() => {
    if (answer === null) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-answer]")) return;
      setAnswer(null);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [answer]);
  const answerShown: AnswerShown | null =
    answer === null
      ? null
      : {
          key: answer.key,
          indices: answer.result.kind === "amount" ? answer.result.indices : [],
          shown: answer.result.shown,
          ...(answer.result.kind === "which" && {
            choices: answer.result.choices,
            onChoose: (index: number) => showAnswer(answerFor(ingredientLines, [index], answer.unit), answer.unit),
          }),
        };

  // Ingredients already in the dish, for the ingredients list.
  const usedIngredientIndices = useMemo(
    () => usedIngredients(plan, state),
    [plan, state],
  );
  const stepStates = useMemo(() => sourceStepStates(plan, state), [plan, state]);

  // The steps move only while they're in view: a modal or Ask's sheet over
  // them holds the keys and swipes. Ask beside the step is not modal (call
  // 5): the step stays in view, so it moves, and Ask's context follows.
  const anyModal = showInfoModal || showMarkUsedSheet;
  // Whole recipe is modal (N9): the rest is inert and the steps don't move under it.
  const wholeOpen = sheetLevel === 3;
  // Ask's shape (call 1): beside the step on the tablet in landscape, a full
  // sheet elsewhere, and over the opening, which has no step to keep in view.
  const screenForm = useAskForm(isClaudeExpanded);
  const askForm = opening ? "sheet" : screenForm;
  const askSheetOpen = isClaudeExpanded && askForm === "sheet";
  const askSideOpen = isClaudeExpanded && askForm === "side";
  // On the opening the steps don't move: Start is its one act (N2-10).
  const navEnabled = !anyModal && !askSheetOpen && !wholeOpen && !opening;

  // The top line's one open menu, More. A borrowed screen shuts it as it
  // opens, however it was opened (voice, a key), so nothing is left open
  // under the screen to take its Escape. Shut in the render that finds both,
  // rather than an effect a render later.
  const [menu, setMenu] = useState<HeaderMenu>(null);
  if (menu !== null && (anyModal || sheetLevel === 3)) setMenu(null);
  // Where the top line gives way (the opening, a derived plan's whole cook;
  // N3-4(d), (f)) the sheet hosts More. One More holds the menu at a time: it
  // shuts when More changes hands.
  const lanesHostMore = stripData !== null && !stripData.asWritten && !TOP_LINE_AT_WHOLE_COOK;
  const moreInSheet = opening || (lanesHostMore && sheetLevel === 2);
  const [moreWasInSheet, setMoreWasInSheet] = useState(moreInSheet);
  if (moreWasInSheet !== moreInSheet) {
    setMoreWasInSheet(moreInSheet);
    if (menu !== null) setMenu(null);
  }
  useOpeningKeys(startCook, opening && !anyModal && !isClaudeExpanded && menu === null);

  // Voice, said to Sous (lib/kitchen/wake-word.ts): on unless this tablet
  // turned it off, and held while Ask has the mic. The dot in the header shows
  // it and turns it on and off; on Android, where voice listens only on a tap
  // (lib/kitchen/voice-mode.ts), tapping it listens once instead.
  const [voiceOn, setVoiceOn] = useState(getVoiceEnabled);

  const closeModals = useCallback(() => {
    setShowInfoModal(false);
    setShowMarkUsedSheet(false);
  }, []);

  // Voice finishes only where the finish button is, the last screen's last
  // part, once it has been up a moment, as the button does (the flow holds
  // that, `finishable`). Anywhere else "done" means done
  // with this step. "Next" never finishes, as keys and swipe don't. Next, back
  // and done said over a modal close it rather than move the steps behind it.
  // The handler reads the screen through a ref, as the recognizer's callbacks
  // fire between renders.
  // The flow's own forward and back, so a step that pages turns its parts
  // for a voice command too.
  const flowNav = useRef<CookFlowNav>(null);

  // The flag (B2): the screen as it stands, by voice (below) and by touch in
  // More. The snapshot reads this render's layers through a ref, set below
  // once the voice state it carries is known.
  const snapshot = useRef<() => CookSnapshot>(null);
  const cookFlag = useCookFlag(
    useCallback(() => {
      if (snapshot.current === null) throw new Error("The cook screen has not drawn yet");
      return snapshot.current();
    }, []),
  );
  const { ack: flagAck, flag } = cookFlag;
  // By touch, a flag the outbox kept opens its note where More's menu hung
  // (decision 8); a flag said stays hands-free (the voice command below).
  const { flagByTouch, note: flagNote } = useFlagNote(cookFlag, menu, setMenu);

  // After a tap, words that name nothing in the recipe were a question for
  // Ask ("how many does this serve"), as before B5d; said after "Sue", they
  // get "Nothing called …" (B5d verify round 1). Set once voice's mode and
  // Ask's handler exist, below; true when it handed the words to Ask.
  const askAfterTap = useRef<(heard: string) => boolean>(() => false);
  const voiceRef = useRef({
    isLast: view.isLast,
    finish,
    onFinish,
    anyModal,
    menuOpen: menu !== null,
    readActive: false,
    putReadAway: () => {},
    offer,
    kitchen,
    dismiss,
    askOpen: isClaudeExpanded,
    askModal: false,
    sheetLevel: 0 as 0 | 1 | 2 | 3,
    opening: false,
    startCook: () => {},
    onBack: () => {},
    alarmRinging: false,
    howMuch: (_heard: string): void => {},
    notYet: (): boolean => false,
    touch: (): void => {},
  });
  // Done goes after every call the page has on its way (auto-finish's
  // reports, finish and reopen): a reopen on its way lands first, so Done
  // completes the cook it reopened rather than racing it. While it waits its
  // turn the finish shows as saving, as it does once sent.
  const [finishQueued, setFinishQueued] = useState(false);
  const finishInOrder = useCallback(() => {
    setFinishQueued(true);
    void inOrder(async () => {
      onFinish();
      setFinishQueued(false);
    });
  }, [inOrder, onFinish]);
  const handleFinishTrigger = useCallback(() => {
    // The mark-used sheet reads and edits the pantry: with none connected,
    // Finish finishes.
    if (queueItemId && connected.pantry) {
      setShowMarkUsedSheet(true);
    } else {
      finishInOrder();
    }
  }, [queueItemId, finishInOrder]);
  // Asking the pantry what the cook used is part of finishing: while it
  // runs (offline, until the connection comes back) the finish waits as it
  // does while it saves, so a tap shows it was taken and a second is not.
  const shownFinish: FinishState = showMarkUsedSheet || finishQueued ? "saving" : finish;

  useLayoutEffect(() => {
    voiceRef.current = {
      isLast: view.isLast,
      finish: shownFinish,
      onFinish: handleFinishTrigger,
      anyModal,
      menuOpen: menu !== null,
      readActive: readStep !== null || readMark !== null,
      putReadAway: () => {
        setReadStep(null);
        setReadMark(null);
      },
      offer,
      kitchen,
      dismiss,
      askOpen: isClaudeExpanded,
      askModal: askSheetOpen,
      sheetLevel,
      opening,
      startCook,
      onBack,
      alarmRinging: (kitchen.expired.size ?? 0) > 0,
      // "How much" (B5d, D11-D13): the screen in hand's lines first.
      howMuch: (heard: string) => {
        const request = howMuchHeard(heard);
        if (request === null) return;
        const onScreen = view.onPrep ? [] : (view.stack[0]?.ingredientIdx ?? []);
        const answered = answerHowMuch(ingredientLines, onScreen, request);
        // After a tap, words that name nothing in the recipe were a question
        // for Ask ("how many does this serve"), as before B5d; said after
        // "Sue", they get "Nothing called …" (B5d verify round 1).
        if (answered.kind === "none" && askAfterTap.current(heard)) return;
        showAnswer(answered, request.unit);
      },
      notYet: () => {
        if (typed.kind !== "checkpoint" || !hasHowToCheck(typed)) return false;
        // A check already confirmed asks nothing again (critic round 2).
        if (screenKey !== null && confirmed.has(screenKey)) return false;
        toggleHowToCheck();
        return true;
      },
      touch,
    };
  });
  // The top layer, in N11's order: a read step, a modal or Whole recipe, the
  // top line's open menu, then a pinned level. The opening's chart is no
  // pinned level: only Start folds it (N2-10).
  const putAwayTop = useCallback(
    (v: (typeof voiceRef)["current"]) => {
      if (v.readActive) v.putReadAway();
      else if (v.anyModal) closeModals();
      else if (v.sheetLevel === 3) setSheetLevel(0);
      else if (v.menuOpen) setMenu(null);
      else if (v.sheetLevel > 0 && !v.opening) setSheetLevel(0);
    },
    [closeModals],
  );
  const onVoiceCommand = useCallback(
    (command: VoiceCommand, heard: string): string | void | false => {
      const v = voiceRef.current;
      // Anything said to Sous is the cook at the counter (auto-finish).
      v.touch();
      // A new command puts the last answer away; a new question replaces it.
      if (command !== "how-much") setAnswer(null);
      // What the command does to Ask (`askOnCommand`). The capsule's mic
      // opened the panel only to listen and it heard a command: the panel
      // goes and the command acts as it would have from the foot's dot,
      // whatever the conversation holds (call 13). "Close" closes Ask in
      // either shape; next, back and done said over the sheet close it
      // rather than move the steps under it, and beside the step they move
      // the step while the panel stays (call 5). With a modal or More over
      // the cook the command is theirs: the topmost thing closes first.
      const onAsk = askOnCommand({
        open: v.askOpen,
        modal: v.askModal,
        listen: capsuleListen.current,
        over: v.anyModal || v.menuOpen,
        close: command === "close",
        backsOut: BACK_OUT.has(command),
      });
      if (onAsk !== "stays") {
        capsuleListen.current = null;
        // Closed as of now for what follows in this same turn: words that
        // turn out to be a question (`askAfterTap`) open Ask again.
        askOpenNow.current = false;
        setIsClaudeExpanded(false);
        if (onAsk === "closes") return;
      }
      // While the alarm rings, level commands do nothing; the echo shows what
      // was heard (N11). On the opening they are disarmed too (N2-10).
      if ((v.alarmRinging || v.opening) && (command === "next-few" || command === "how-much-more" || command === "whole-recipe")) {
        return;
      }
      // A new command puts the last answer away; a new question replaces it.
      switch (command) {
        case "how-much":
          v.howMuch(heard);
          return;
        case "not-yet":
          // Off a checkpoint "not yet" is no command: heard as before B5d (b5d-followup).
          if (!v.notYet()) return false;
          return;
        // Timers (B5a, A12): none of these closes or moves anything.
        case "start-timer": {
          if (!v.offer) return VOICE_TIMER_COPY.noTimer;
          // Idempotent: a misheard phrase never resets a running timer.
          if (v.kitchen.start(v.offer, { restart: false }) === "running") return VOICE_TIMER_COPY.running;
          return;
        }
        case "set-timer": {
          const seconds = timerRequestSeconds(heard);
          if (seconds === null || !inTimerRange(seconds)) return VOICE_TIMER_COPY.cantSet;
          v.kitchen.start({
            id: `adhoc:${String(Date.now())}`,
            queueId: null,
            recipeName: null,
            stepId: null,
            label: VOICE_TIMER_COPY.label,
            durationMs: seconds * 1000,
          });
          return;
        }
        case "dismiss-timer": {
          const done = v.kitchen.timers
            .filter((t) => v.kitchen.expired.has(t.id))
            .sort((a, b) => a.endsAtEpochMs - b.endsAtEpochMs)[0];
          if (!done) return VOICE_TIMER_COPY.noneDone;
          v.dismiss(done.id);
          return;
        }
        case "next-few":
          setIsClaudeExpanded(false);
          closeModals();
          setSheetLevel(1);
          return;
        case "how-much-more":
          setIsClaudeExpanded(false);
          closeModals();
          setSheetLevel(2);
          return;
        case "whole-recipe":
          setIsClaudeExpanded(false);
          closeModals();
          setMenu(null);
          setSheetLevel(3);
          return;
        case "close":
          putAwayTop(v);
          return;
        case "flag":
          // The screen as it is, borrowed or not: nothing closes, and no note
          // opens, so a flag said stays hands-free (decision 8). The echo
          // stays the words heard, and the pill says whether it was kept: a
          // line saying it was saved couldn't wait for the outbox's answer.
          // A note can go on it later, from the kitchen.
          flag();
          return;
      }
      // Next, back and done said over a modal, Whole recipe or a read put it
      // away rather than move the steps behind it; "back" also puts away a
      // pinned level. With nothing open, "back" goes back a step (N11).
      if (v.anyModal || v.readActive || v.sheetLevel === 3 || v.menuOpen) {
        putAwayTop(v);
        return;
      }
      // On the opening "next" and "done" are Start; "back" does nothing, as
      // the kitchen is the top line's ← (N2-10).
      if (v.opening) {
        if (command !== "back") v.startCook();
        return;
      }
      if (command === "back") {
        if (v.sheetLevel > 0) {
          setSheetLevel(0);
          return;
        }
        if (!flowNav.current?.back()) v.onBack();
        return;
      }
      // A step that pages turns its parts first, as the forward and back
      // controls do; "done" on a part with more to come reveals it too.
      if (flowNav.current?.forward()) return;
      else if (!v.isLast) dispatch({ type: "next" });
      else if (command === "done" && v.finish !== "saving" && flowNav.current?.finishable())
        v.onFinish();
    },
    [closeModals, dispatch, flag, putAwayTop],
  );

  const onVoiceQuestion = useCallback(
    (text: string) => {
      capsuleListen.current = null;
      if (!askOpenNow.current) openAsk("mic", "controls");
      askRef.current?.ask(text);
    },
    [openAsk],
  );

  const {
    mode: voiceMode,
    status: voiceStatus,
    echo: voiceEcho,
    reset: resetVoice,
    talk,
    end: endListen,
  } = useKitchenVoiceCommands({
    enabled: voiceOn,
    // Held while an answer is said, so it isn't heard as a command (D13).
    paused: speaking,
    onCommand: onVoiceCommand,
    onQuestion: onVoiceQuestion,
  });

  // Listening all the time, the dot is an on/off switch. Stopped on a denied
  // mic or a run of failures, it turns voice off, so a kitchen without a mic
  // or a network can silence it; turned on again, voice starts afresh.
  const onVoiceTap = useCallback(() => {
    if (voiceMode === "tap") {
      talk();
      return;
    }
    const on = voiceStatus === "off";
    resetVoice();
    setVoiceOn(on);
    setVoiceEnabled(on);
  }, [voiceMode, voiceStatus, resetVoice, talk]);

  // The capsule's mic (call 13). Where voice listens on a tap it opens the
  // panel already listening, one listen per tap. Where it listens all the
  // time there are no spoken questions, so the mic stays what the foot's dot
  // was: voice's switch.
  const onCapsuleMic = useCallback(() => {
    if (voiceMode !== "tap") {
      onVoiceTap();
      return;
    }
    // Sous is speaking: a tap listens to nothing (the mic says so).
    if (voiceStatus === "paused") return;
    capsuleListen.current = "armed";
    openAsk("mic", "controls");
    if (voiceStatus !== "hearing") talk();
  }, [voiceMode, voiceStatus, onVoiceTap, openAsk, talk]);
  // A tap on the panel's own mic is the cook's hand on the panel: it stays.
  const onPanelMic = useCallback(() => {
    capsuleListen.current = null;
    onVoiceTap();
  }, [onVoiceTap]);
  // A listen the capsule started that ended in nothing asked (silence, or
  // words that were no question) closes the panel once the heard line has
  // cleared, whatever the conversation holds: the cook opened it to say one
  // thing, and a question asked would have ended the listen
  // (`onVoiceQuestion`). A refused or stalled mic keeps it open, where it
  // says so (call 14), whether or not it ever heard; a mic that failed to
  // start is a listen that is over, and closes it the same way (`afterListen`).
  useEffect(() => {
    const next = afterListen(capsuleListen.current, {
      open: isClaudeExpanded,
      status: voiceStatus,
      echo: voiceEcho !== null,
    });
    capsuleListen.current = next.listen;
    if (next.close) setIsClaudeExpanded(false);
  }, [isClaudeExpanded, voiceStatus, voiceEcho]);

  // As Ask closes, focus comes back to the part of the capsule that opened
  // it (call 7), unless the cook's focus is already somewhere on the screen:
  // beside the step, a close by voice leaves it where it is.
  const askWasOpen = useRef(isClaudeExpanded);
  useEffect(() => {
    const was = askWasOpen.current;
    askWasOpen.current = isClaudeExpanded;
    if (!was || isClaudeExpanded) return;
    // Every listen on a tap is Ask's: closed by the cook (Close, Esc, the
    // look-ahead, back to the opening) while it still listens, the listen
    // ends with it, so nothing said afterwards runs a command or asks again.
    // A listen already over (one that closed Ask itself) is left as it is.
    endListen();
    const at = document.activeElement;
    if (at !== null && at !== document.body) return;
    // On the opening there is no capsule: its own mic opened Ask.
    if (opening) openingMicRef.current?.focus();
    else capsuleRef.current?.focus(askEntry.way);
  }, [isClaudeExpanded, askEntry.way, opening, endListen]);

  useLayoutEffect(() => {
    askAfterTap.current = (heard: string) => {
      if (voiceMode !== "tap") return false;
      const words = wordsToSous(normalizeUtterance(heard)).join(" ");
      onVoiceQuestion(`${words.charAt(0).toUpperCase()}${words.slice(1)}?`);
      return true;
    };
  });

  const voice = {
    mode: voiceMode,
    status: voiceStatus,
    echo: voiceEcho,
    onTap: onVoiceTap,
    // While a timer rings, what to say is "Sue, stop" (B5a); while a level is
    // pinned, "Sue, back" (P58 (c)).
    hint: timers.expired.length > 0 ? VOICE_COPY.stop : sheetLevel > 0 && !opening ? COOK_COPY.saySueBack : undefined,
  };

  const layers: CookLayers = {
    allSteps: false,
    ingredients: false,
    info: showInfoModal,
    wholeCook: sheetLevel === 3,
    pane: false,
    card: null,
    // B2's report schema has More alone; the opening is level 2 (N2-11).
    more: menu === "more",
    level: sheetLevel,
    read: readStep !== null || readMark !== null,
  };
  // What opened and closed, for a flag's lead-up (B2 decision 9). Compared
  // with the last render's, so StrictMode's second run finds nothing new.
  const layersWere = useRef(layers);
  useEffect(() => {
    for (const change of layerChanges(layersWere.current, layers)) recordEvent("layer", change);
    layersWere.current = layers;
  });
  useLayoutEffect(() => {
    snapshot.current = () =>
      cookSnapshot({
        queueId: queueItemId ?? null,
        recipeName: recipe.name,
        session,
        layers,
        part: flowNav.current?.part() ?? null,
        voice: { mode: voiceMode, status: voiceStatus },
        ask: { sessionId, open: isClaudeExpanded },
      });
  });

  const steps = recipe.steps ?? [];
  // Go to this step (N8): the cook goes there; steps jumped over stay to come.
  const goToScreen = useCallback(
    (pos: number) => {
      onJump(pos);
      setSheetLevel(0);
      setReadMark(null);
      setReadStep(null);
    },
    [onJump],
  );
  const goToMark = useCallback(
    (pos: number) => {
      onGoMark(pos);
      setSheetLevel(0);
      setReadMark(null);
      setReadStep(null);
    },
    [onGoMark],
  );
  // The plan's minutes only when the plan is the derived one: the recipe as
  // written (`identityPlan`) is all nominal guesses (`shownTimes`). The line
  // reads the session's plan, not the stored one the kitchen's row reads, so
  // its minutes always describe the Prep and steps on screen; the two differ
  // only until the row's refetch sees a plan derived on open, or, for a cook
  // already under way as written, until the next open (DECISIONS 2026-10-05,
  // T follow-up, call 5).
  const timesPlan = source.kind === "derived" ? plan : null;
  const times = useMemo(
    () => recipeTimeLine(timesPlan, recipe.estimatedTime),
    [timesPlan, recipe.estimatedTime],
  );
  const prepTimes = useMemo(
    () => recipeTimeLine(timesPlan, recipe.estimatedTime, { ahead: false }),
    [timesPlan, recipe.estimatedTime],
  );
  // The opening's words: the dish (its minutes are the timetable's own, DECISIONS
  // 2026-10-20). Held, as the sheet lays out again whenever they change.
  const openingShown = useMemo(
    () => (opening ? openingWords(recipe.name, shownTimes(timesPlan, recipe.estimatedTime)) : null),
    [opening, recipe.name, timesPlan, recipe.estimatedTime],
  );
  // More where the sheet hosts it (N3-4(d), (f)): passed whenever the lanes
  // may host it, so the sheet has measured it before it shows.
  // With it on the pinned whole-cook chart, Ask Sous in its short form
  // (call 26): the top line and its capsule give way there, and a cook
  // reading the chart can still ask by hand. Opening Ask lowers the chart
  // (call 21). Not on the opening, whose row has its own mic.
  const sheetMore =
    opening || lanesHostMore ? (
      <div className="flex items-center">
        <HeaderMore
          open={moreInSheet && menu === "more"}
          onOpenChange={(o) => setMenu(o ? "more" : null)}
          onShowInfo={() => setShowInfoModal(true)}
          currentItemId={queueItemId}
          showRecentItems={showRecentItems}
          onFlag={flagByTouch}
          flagAck={flagAck}
          flagNote={{ ...flagNote, open: moreInSheet && flagNote.open }}
        />
        {!opening && (
          <AskCapsule
            place="chart"
            label={ASK_COPY.title}
            short={ASK_COPY.short}
            onWords={openAskToType}
            voice={voice}
            onMic={onCapsuleMic}
          />
        )}
      </div>
    ) : null;
  // The opening's controls (N3-4(d)): the voice dot, the well and Start.
  const openingControls = opening ? (
    <OpeningControls
      onStart={startCook}
      well={{ expired: timers.expired, running: timers.ledge, onDismiss: timers.onDismiss }}
      voice={voice}
      micRef={openingMicRef}
    />
  ) : null;

  // Ask Sous in the top line: not drawn while its panel is open (the panel
  // has its own mic, camera and close).
  const capsule = isClaudeExpanded ? null : (
    <AskCapsule
      ref={capsuleRef}
      label={ASK_COPY.title}
      short={ASK_COPY.short}
      onWords={openAskToType}
      voice={voice}
      onMic={onCapsuleMic}
      onPhoto={handlePhotoTrigger}
    />
  );
  // Raising the look-ahead closes Ask (call 21).
  const onLevel = (level: Level) => {
    if (level > 0) setIsClaudeExpanded(false);
    setSheetLevel(level);
  };

  // One edge for the cook and everything it borrows the screen for, with a
  // map or without one: the foot has its own band (V4), so no gutters are
  // kept for it. A flag captures this root, so the screens borrowed inside
  // it come with it.
  return (
    // The timers shown here are this cook's unless they say their recipe
    // (`TimerHere`), with the id its offers carry.
    <TimerHere queueId={queueItemId ?? "cook"}>
    <div
      data-cook-root=""
      className="cook-edge contents"
      // Beside Ask's side panel the top line and the stage give up its width.
      style={askSideOpen ? ({ "--ask-room": ASK_SIDE_WIDTH } as CSSProperties) : undefined}
    >
      {/* While a borrowed screen has the screen, what it covers can't take focus. */}
      <div inert={anyModal} className="contents">
        {/* Ask's sheet is modal: the cook under it can't take focus either. */}
        <div inert={askSheetOpen} className="contents">
        <KitchenLayout
          header={
            <div data-cook-header inert={wholeOpen || opening} className={`relative z-40 mr-[var(--ask-room,0px)]${opening ? " invisible" : ""}`}>
            <RecipeHeader
              name={recipe.name}
              scaleNote={scaleNote}
              onShowInfo={() => setShowInfoModal(true)}
              currentQueueItemId={queueItemId}
              showRecentItems={showRecentItems}
              menu={moreInSheet ? null : menu}
              onMenu={setMenu}
              onFlag={flagByTouch}
              flagAck={flagAck}
              flagNote={{ ...flagNote, open: !moreInSheet && flagNote.open }}
              ask={capsule}
            />
            </div>
          }
          main={
            <CookFlow
              away={awayLine}
              view={view}
              mode={state.mode}
              times={prepTimes}
              ingredients={ingredientLines}
              recipe={packRecipe}
              servings={servings}
              scales={scales}
              onServingsChange={onServingsChange}
              onNext={onNext}
              onBack={onBack}
              onMode={onMode}
              onTick={onTick}
              onFinish={handleFinishTrigger}
              onAskAhead={onAskAhead}
              finish={shownFinish}
              navEnabled={navEnabled}
              voice={voice}
              askOpen={isClaudeExpanded}
              navRef={flowNav}
              timers={timers}
              notices={kitchen.notices}
              restInert={wholeOpen}
              stepType={stepType}
              answer={answerShown}
              opening={opening ? { onStart: startCook } : null}
              canBackAtStart={canOpen}
              look={
                stripData
                  ? {
                      strip: stripData,
                      level: sheetLevel,
                      onLevel,
                      // At the chart and Whole recipe the step is gone, so its clock walks to the well (N10, N2-4).
                      onSettled: (_k, folded) => setClockInWell(folded),
                      handleRef: sheetHandle,
                      nudge: nudgeData,
                      keysLive: navEnabled && menu === null,
                      readMark,
                      onReadMark: setReadMark,
                      onGoToMark: goToMark,
                      voice: { status: voiceStatus, echo: voiceEcho },
                      sayBack: voiceStatus === "listening" && voiceEcho === null && !opening,
                      opening: openingShown,
                      title: openingWords(recipe.name, null).title,
                      pots: { timers: potTimers, nowEpochMs: tick },
                      topLine: TOP_LINE_AT_WHOLE_COOK,
                      more: sheetMore,
                      openingControls,
                      whole: {
                        steps,
                        plan,
                        state,
                        chapters: view.chapters,
                        current: stepStates.current,
                        done: stepStates.done,
                        prepLine: hasPrep(plan) ? prepSummary(plan, state).text : null,
                        ingredients: ingredientLines,
                        recipe: packRecipe,
                        servings,
                        scales,
                        onServingsChange,
                        usedIngredientIndices,
                        ingredientOverrides,
                        onToggleIngredient: (index, checked) =>
                          setIngredientOverrides((prev) => new Map(prev).set(index, checked)),
                        read: readStep,
                        onRead: (index) => {
                          setReadStep(index);
                          if (index !== null && screenForSourceStep(plan, state, index) === null) {
                            // No screen of this cook cites the step: it has no Go (no fallback to another screen).
                            recordEvent("step", `step ${index + 1} as written has no screen to go to`);
                          }
                        },
                        screenFor: (index) => screenForSourceStep(plan, state, index),
                        onGo: goToScreen,
                      },
                    }
                  : null
              }
              resumePart={resumePart}
              resumeWidth={resumeWidth}
              onPart={onPart}
            />
          }
        />
        </div>

        {/* Ask Sous: beside the step, or a sheet over it. Never open with
            Whole recipe: each puts the other away (`openAsk`, `onLevel`). */}
        <AskSous
          ref={askRef}
          recipeContext={recipe.name}
          queueId={queueItemId}
          currentStepIndex={askHand.index}
          prep={askHand.prep}
          timers={askTimers}
          sessionId={sessionId}
          isExpanded={isClaudeExpanded}
          onToggle={closeAsk}
          currentStepText={askHand.text}
          ingredients={ingredientTexts}
          servings={servings}
          servesBase={packRecipe.serves_base}
          offlineReply={askOfflineReply}
          voice={{ ...voice, onTap: onPanelMic }}
          onSpeak={speakAnswer}
          form={askForm}
          enter={askEntry.enter}
          onPhoto={handlePhotoTrigger}
          escapeLive={!anyModal && !wholeOpen && menu === null}
          onEngage={engageAsk}
          alarm={
            timers.expired.length > 0 ? (
              <AlarmBand expired={timers.expired} now={tick} onDismiss={timers.onDismiss} />
            ) : undefined
          }
        />
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handlePhotoFileChange}
          className="hidden"
          aria-hidden="true"
        />
        <VoiceSaid mode={voiceMode} status={voiceStatus} echo={voiceEcho} hint={voice.hint} />
      </div>

      <RecipeInfoModal
        isOpen={showInfoModal}
        onClose={() => setShowInfoModal(false)}
        name={recipe.name}
        source={recipe.source ?? undefined}
        sourcePack={sourcePack}
        onCookOriginal={onCookOriginal}
        cookingOriginal={cookingOriginal}
        notes={recipe.notes ?? undefined}
        times={times}
        tags={recipe.tags ?? []}
        voice={{ status: voiceStatus, echo: voiceEcho }}
        shownAsSent={shownAsSent}
      />

      {queueItemId && (
        <MarkUsedSheet
          queueId={queueItemId}
          recipeName={recipe.name}
          isOpen={showMarkUsedSheet}
          onFinish={() => {
            setShowMarkUsedSheet(false);
            finishInOrder();
          }}
          onCancel={() => setShowMarkUsedSheet(false)}
        />
      )}
    </div>
    </TimerHere>
  );
}
