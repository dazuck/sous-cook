"use client";

import {
  useCallback,
  useState,
  useRef,
  useEffect,
  useId,
  useImperativeHandle,
  type ReactNode,
  type Ref,
} from "react";
import ReactMarkdown from "react-markdown";
import type { GroundingSource } from "@/lib/ai";
import { trpc } from "@/lib/trpc";
import {
  ChatBubble,
  ChatInput,
  ChatLoadingIndicator,
  ChatQuickReplies,
} from "@/components/ui";
import { isAnswerCutOff } from "@/lib/kitchen/ask-failure";
import { recordAsk } from "@/lib/kitchen/report-events";
import { speak } from "@/lib/kitchen/speak";
import { COOK_COPY, type AskPrep } from "@/lib/kitchen/cook-view";
import type { AskForm } from "@/hooks/useAskForm";
import { ANSWER_PROSE } from "./answer-prose";
import { CameraMark, CAPSULE_COPY } from "./AskCapsule";
import { EDGE_X } from "./cook-edge";
import { actionOf, MicMark, type VoiceProps, voiceLabel } from "./VoiceDot";

export type Message = {
  role: "user" | "assistant";
  content: string;
  image?: {
    base64: string;
    mimeType?: string;
  };
  sources?: GroundingSource[];
  /**
   * What the thread shows for this turn in place of `content`: a photo's
   * turn reads "Check against this step" while the question sent is the one
   * it always was (`DEFAULT_DISH_QUESTION`).
   */
  shown?: string;
};

/**
 * The shape Ask takes: the kitchen home's bottom tray, or on the cook screen
 * the side panel or the full sheet (`useAskForm`; DS §5 Ask, v1.60).
 */
export type AskShape = "tray" | AskForm;

/** The side panel's width: 40% of the tablet's 960 cpx. The step gives up the same (`--ask-room`). */
export const ASK_SIDE_WIDTH = "calc(384 * var(--cpx))";

/** What a dish photo asks, as it always has; the thread shows `ASK_COPY.photoShown`. */
export const DEFAULT_DISH_QUESTION = "How does this look and what should I do with it?";

/** Placeholder copy for Ask, awaiting a rewrite. */
export const ASK_COPY = {
  title: "Ask Sous",
  empty: "Ask anything while you cook.",
  error: "Couldn't reach Sous. Check the connection and ask again.",
  cutOff: "Sous's answer ran long and was cut off. Ask again, or ask for it shorter.",
  help: "Help",
  quick: "Quick questions",
  answering: "Sous is answering",
  /** The panel on the cook screen (v1.60). */
  short: "Ask",
  close: "Close Ask Sous",
  about: "About this step:",
  type: "Type here",
  field: "Your question for Sous",
  photoShown: "Check against this step",
  photoAlt: "Dish photo",
  photoUnread: "Couldn't read that photo. Try again.",
  photoNotPhoto: "That file isn't a photo. Take one with the camera.",
  micBlocked: "The microphone is blocked. Type your question.",
} as const;

// Ask is a sand surface (DS §1's one panel fill), with a 1px ink/[.11] hairline
// and a 320ms rise/fade entrance. Opened, the conversation sits on paper
// between the sand header and the sand input strip, so Sous's words are ink on
// paper and the cook's, like the quick questions, are sand.
const SHELL =
  "fixed bottom-0 left-0 right-0 z-40 border-t border-ink/[.11] bg-sand font-[family-name:var(--font-text)] text-ink starting:opacity-0 starting:translate-y-3 transition-[opacity,transform] duration-320 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none";
// On the cook screen Ask keeps those materials in two other shapes (v1.60):
// beside the step, the screen's whole height, with the hairline on its open
// edge (the step, the progress line and the foot stand in what is left); or
// a full sheet over the step.
const PANEL =
  "fixed z-40 flex flex-col overflow-hidden bg-sand font-[family-name:var(--font-text)] text-ink starting:opacity-0 transition-[opacity,transform] duration-320 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none";
const SIDE = `${PANEL} inset-y-0 right-0 w-[calc(384*var(--cpx))] border-l border-ink/[.11] starting:translate-x-3`;
const SHEET = `${PANEL} inset-0 starting:translate-y-3`;
/** The side panel's own edge: it is narrow, so it keeps less than the cook's 44 cpx. */
const SIDE_X = "px-[calc(24*var(--cpx))]";
/** A round ghost on the sand strip: the camera, the mic, the close. */
const ROUND_GHOST =
  "flex size-[var(--target)] shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-soft";
// A press is a tone step on the sand.
const PRESS =
  "transition-colors duration-[320ms] ease-[var(--ease)] active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)] focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ink";

export interface AskSousHandle {
  /**
   * Put a question in the box, replacing whatever is there, for the cook to
   * edit or send. Open the panel alongside, or the box isn't on screen.
   */
  prefill: (question: string) => void;
  /**
   * Ask a question immediately: appends to chat, sends to model, and keeps
   * focusInputOnOpen false so focus stays on the voice dot instead of opening
   * the on-screen keyboard.
   */
  ask: (question: string) => void;
  /**
   * Ask with a dish photo immediately: sends the photo and question to the
   * model with the recipe and the step. `shown` stands in the conversation
   * in the question's place.
   */
  askWithPhoto: (photo: string, question: string, options?: { shown?: string }) => void;
  /** A line from the app, not from Sous, in the thread and never sent on: a photo that could not be read. */
  notice: (text: string) => void;
}

export type AskClaudeHandle = AskSousHandle;

export interface AskSousProps {
  recipeContext: string; // Current recipe name/details for context
  sessionId: string;
  isExpanded: boolean;
  onToggle: () => void;
  queueId?: string;
  currentStepIndex?: number;
  /**
   * Set where the screen is prep (a prep page, or As I go's Prep screen):
   * Sous is told the cook is in prep, on these jobs, and no step of the
   * recipe (`askInHand`).
   */
  prep?: AskPrep;
  timers?: Array<{
    id: string;
    label: string;
    remainingSec: number;
    status: "running" | "expired";
  }>;
  currentStepText?: string; // Current step instructions
  ingredients?: string[]; // All recipe ingredients
  /** Active serving count and recipe base count, for the scale context line (B5c-10). */
  servings?: number;
  servesBase?: number;
  scaleContext?: string | null;
  /** When set, every question gets this reply and none reaches the model. */
  offlineReply?: string;
  voice?: VoiceProps;
  onSpeak?: (text: string) => void;
  /** The shape (default the tray, the kitchen home's). */
  form?: AskShape;
  /**
   * Where focus lands as the panel opens: the field, for a cook who opened it
   * to type (the keyboard comes up), or its controls (the mic, else the
   * close), which leave the keyboard down.
   */
  enter?: "field" | "controls";
  /** Opens the camera, from the panel's own camera; none where there is no camera. */
  onPhoto?: () => void;
  /** A ringing timer, drawn at the sheet's top: the sheet covers the stage it rings on. */
  alarm?: ReactNode;
  /** Escape closes the panel; off while something over the cook has the key (a modal, More). */
  escapeLive?: boolean;
  /** The cook put a hand to the panel: a touch anywhere on it, the field, a quick question, the camera. */
  onEngage?: () => void;
  ref?: Ref<AskSousHandle>;
}

/** One turn of the cook's, as it waits its place and is sent. */
interface Turn {
  question: string;
  /** Asked aloud: its answer is said aloud too. */
  spoken: boolean;
  image?: { base64: string; mimeType?: string };
  shown?: string;
}

// Helper to find which ingredients are mentioned in the current step
function findStepIngredientMatch(
  stepText: string,
  ingredients: string[],
): string | null {
  if (!stepText || !ingredients.length) return null;

  const stepLower = stepText.toLowerCase();
  for (const ing of ingredients) {
    // Extract the main ingredient word (e.g., "2 cups flour" -> "flour")
    const words = ing.toLowerCase().split(" ");
    const mainWord = words[words.length - 1];
    if (mainWord.length > 2 && stepLower.includes(mainWord)) {
      return ing;
    }
  }
  return null;
}

// Generate context-aware quick questions based on current step
function getKitchenQuickQuestions(
  currentStepText?: string,
  ingredients?: string[],
): Array<{ label: string; text: string }> {
  // Find ingredient mentioned in current step
  const stepIngredient =
    currentStepText && ingredients
      ? findStepIngredientMatch(currentStepText, ingredients)
      : null;

  // Base prompts that adapt to context
  return [
    {
      label: "Substitute",
      text: stepIngredient
        ? `What can I use instead of ${stepIngredient}?`
        : "What can I substitute for an ingredient I don't have?",
    },
    {
      label: "Is it ready?",
      text: currentStepText
        ? `How do I know when this step is done? "${currentStepText.slice(0, 50)}..."`
        : "What should this look and smell like when it's done?",
    },
    {
      label: ASK_COPY.help,
      text: currentStepText
        ? `I'm stuck on: "${currentStepText.slice(0, 60)}..." - can you explain?`
        : "How do I fix it if it's too salty or spicy?",
    },
  ];
}

export function AskSous({
  recipeContext,
  sessionId,
  isExpanded,
  onToggle,
  queueId,
  currentStepIndex,
  prep,
  timers,
  currentStepText,
  ingredients,
  servings,
  servesBase,
  scaleContext,
  offlineReply,
  voice,
  onSpeak,
  form = "tray",
  enter = "controls",
  onPhoto,
  alarm,
  escapeLive = true,
  onEngage,
  ref,
}: AskSousProps) {
  const panel = form !== "tray";
  const titleId = useId();
  const scaleLine =
    scaleContext ??
    (servings !== undefined && servesBase !== undefined && servings !== servesBase
      ? COOK_COPY.askScaleContext(servings, servesBase)
      : null);
  const fullRecipeContext = scaleLine ? `${recipeContext}\n${scaleLine}` : recipeContext;
  // Generate context-aware quick questions
  const quickQuestions = getKitchenQuickQuestions(currentStepText, ingredients);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [vv, setVv] = useState<{
    height: number;
    offsetTop: number;
    innerHeight: number;
    /** The tallest the page has been at this width since Ask opened: its height with no keyboard. */
    fullHeight: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const focusInputOnOpen = useRef(false);

  // Offline, React Query would hold the question until the connection came
  // back, with "Sous is answering" up the whole time. Sent regardless, it
  // fails at once and Ask says it couldn't reach Sous (B5.md B5).
  const cookingMutation = trpc.chatCooking.useMutation({ networkMode: "always" });

  // Auto-scroll to the newest turn when messages change. The panel scrolls
  // its own thread, so a long answer never moves the page under it. It goes
  // to the thread's end, except that a photo in the newest of the cook's
  // turns stays whole: the thread then stops with that turn's top in view,
  // and its answer runs on below it.
  const settleThread = useCallback(() => {
    if (!isExpanded) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const thread = threadRef.current;
    if (panel && thread) {
      let top = Math.max(0, thread.scrollHeight - thread.clientHeight);
      const last = messages.length - 1;
      const photoAt =
        messages[last]?.image !== undefined
          ? last
          : messages[last]?.role === "assistant" && messages[last - 1]?.image !== undefined
            ? last - 1
            : -1;
      const turn = photoAt < 0 ? null : thread.querySelector<HTMLElement>(`[data-turn="${photoAt}"]`);
      // The thread is its turns' offset parent, so a turn's `offsetTop` is
      // where it starts in the scroll; the thread's own padding stays above it.
      if (turn) top = Math.min(top, Math.max(0, turn.offsetTop - (parseFloat(getComputedStyle(thread).paddingTop) || 0)));
      if (reduced || typeof thread.scrollTo !== "function") thread.scrollTop = top;
      else thread.scrollTo({ top, behavior: "smooth" });
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: reduced ? "instant" : "smooth" });
  }, [messages, isExpanded, panel]);
  const answering = cookingMutation.isPending;
  useEffect(() => {
    settleThread();
    // `answering`: the line that says Sous is answering is drawn under the
    // newest turn, and is brought into view like one.
  }, [settleThread, answering]);

  // Focus as it opens: the field for a cook who opened it to type or was
  // handed a question to send ("Missed it? Ask Sous"), else the mic (the
  // close where there is none), which keeps the soft keyboard down.
  const enterRef = useRef(enter);
  useEffect(() => {
    enterRef.current = enter;
  });
  useEffect(() => {
    if (!isExpanded) {
      focusInputOnOpen.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- kept in the effect: a reset made while rendering can be lost when React replays updates it queued without rendering (KitchenTimers lost one that way)
      setIsInputFocused(false);
      return;
    }
    if (focusInputOnOpen.current || enterRef.current === "field") {
      inputRef.current?.focus();
      setIsInputFocused(true);
    } else {
      (micRef.current ?? collapseRef.current)?.focus();
    }
  }, [isExpanded]);

  // The screen turned and the panel became the sheet, which covers the cook:
  // focus that was on the cook's own controls beside the panel has nowhere
  // to be, so it comes into the sheet, on the mic (the close where there is
  // none), which keeps the keyboard down. Focus already in the panel stays.
  const formWas = useRef(form);
  useEffect(() => {
    const was = formWas.current;
    formWas.current = form;
    if (!isExpanded || form !== "sheet" || was === "sheet") return;
    if (rootRef.current?.contains(document.activeElement)) return;
    (micRef.current ?? collapseRef.current)?.focus();
  }, [form, isExpanded]);

  // Escape closes the panel, unless something over the cook holds the key:
  // a modal or the top line's menu (`escapeLive`), or an open popover.
  const onClose = useRef(onToggle);
  useEffect(() => {
    onClose.current = onToggle;
  });
  useEffect(() => {
    if (!isExpanded || !panel || !escapeLive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[data-holds-keys]") !== null) return;
      e.preventDefault();
      onClose.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isExpanded, panel, escapeLive]);

  // Track the viewport while expanded, so Ask takes what the soft keyboard
  // leaves. The keyboard shows in one of two ways: where the page resizes
  // under it (Chrome on Android, the tablet; `interactiveWidget:
  // "resizes-content"` in app/layout.tsx) `innerHeight` and the visual
  // viewport shrink together; where it lies over the page (iOS) only the
  // visual viewport does. Either way what is left is less than the page's
  // full height, the tallest it has been at this width since Ask opened.
  useEffect(() => {
    if (!isExpanded || typeof window === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- kept in the effect: a reset made while rendering can be lost when React replays updates it queued without rendering (KitchenTimers lost one that way)
      setVv(null);
      return;
    }
    const viewport = window.visualViewport;
    let full: { width: number; height: number } | null = null;
    const syncViewport = () => {
      const innerHeight = window.innerHeight;
      const width = window.innerWidth;
      full = { width, height: full !== null && full.width === width ? Math.max(full.height, innerHeight) : innerHeight };
      if (viewport) {
        setVv({
          height: viewport.height,
          offsetTop: viewport.offsetTop,
          innerHeight,
          fullHeight: full.height,
        });
      } else {
        setVv({
          height: innerHeight,
          offsetTop: 0,
          innerHeight,
          fullHeight: full.height,
        });
      }
    };
    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
    };
  }, [isExpanded]);

  // Committed successful turns sent to the model (`B2a-6`): updated only after
  // `cookingMutation.mutateAsync` resolves (or when `offlineReply` is set),
  // so failed turns and `ASK_COPY.error` are never sent back on retry.
  const history = useRef<Message[]>([]);
  // Turns asked while an answer is on its way, sent in order after it.
  const queued = useRef<Turn[]>([]);
  // The turn whose answer is on its way; null when none is.
  const asking = useRef<Turn | null>(null);

  // What a turn is asked with, as it stands when the turn is sent: a turn
  // that waited behind another's answer is about the step the cook is on by
  // then, not the step when the first was asked.
  const now = {
    sessionId,
    fullRecipeContext,
    queueId,
    servings,
    servesBase,
    currentStepIndex,
    prep,
    timers,
    offlineReply,
    onSpeak,
  };
  const live = useRef(now);
  useEffect(() => {
    live.current = now;
  });

  const answer = async ({ question, spoken, image, shown }: Turn) => {
    const { sessionId, fullRecipeContext, queueId, servings, servesBase, currentStepIndex, prep, timers, offlineReply, onSpeak } =
      live.current;
    const userMessage: Message = {
      role: "user",
      content: question,
      ...(image ? { image } : {}),
      ...(shown !== undefined ? { shown } : {}),
    };
    setMessages((prev) => [...prev, userMessage]);
    // For a flag's lead-up: that it went and how, never the words (B2).
    recordAsk("sent");
    if (offlineReply !== undefined) {
      const assistantMessage: Message = {
        role: "assistant",
        content: offlineReply,
      };
      history.current = [...history.current, userMessage, assistantMessage];
      setMessages((prev) => [...prev, assistantMessage]);
      recordAsk("answered");
      return;
    }

    // Call cooking assistant with committed history + current user message
    const sentMessages = [...history.current, userMessage].map(
      ({ role, content, image: msgImage }) => ({
        role,
        content,
        ...(msgImage ? { image: msgImage } : {}),
      }),
    );

    try {
      const result = await cookingMutation.mutateAsync({
        sessionId,
        messages: sentMessages,
        currentRecipe: fullRecipeContext,
        ...(queueId !== undefined ? { queueId } : {}),
        ...(servings !== undefined ? { servings } : {}),
        ...(servesBase !== undefined ? { servesBase } : {}),
        ...(currentStepIndex !== undefined ? { currentStepIndex } : {}),
        ...(prep !== undefined ? { prep } : {}),
        ...(timers !== undefined ? { timers } : {}),
        includeRecipeContext: true,
      });
      const assistantMessage: Message = {
        role: "assistant",
        content: result.content,
        ...(result.sources && result.sources.length > 0
          ? { sources: result.sources }
          : {}),
      };
      history.current = [...history.current, userMessage, assistantMessage];
      setMessages((prev) => [...prev, assistantMessage]);
      recordAsk("answered");
      if (spoken) {
        if (onSpeak) {
          onSpeak(result.content);
        } else {
          speak(result.content, { onDone: () => {} });
        }
      }
    } catch (error) {
      // A reply cut at the token cap says so, in the line and in a flag's
      // lead-up; anything else is the connection line (feedback review
      // 2026-10-27).
      const cutOff = isAnswerCutOff(error);
      recordAsk(cutOff ? "error: cut at the token cap" : "error");
      // Append error reply only to UI state without mutating history.current (B2a-6)
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: cutOff ? ASK_COPY.cutOff : ASK_COPY.error,
        },
      ]);
      console.error("Chat error:", error);
    }
  };

  // One turn at a time: one asked over an answer on its way waits for it,
  // rather than racing it and leaving it out of the history. A question
  // already asked or waiting (a second tap) is not asked again; a photo is
  // always its own turn.
  const sendTurn = async (turn: Turn) => {
    if (asking.current !== null) {
      const same = (other: Turn) =>
        turn.image === undefined && other.image === undefined && other.question === turn.question;
      if (!same(asking.current) && !queued.current.some(same)) queued.current.push(turn);
      return;
    }
    try {
      for (let next: Turn | undefined = turn; next; next = queued.current.shift()) {
        asking.current = next;
        await answer(next);
      }
    } finally {
      asking.current = null;
    }
  };

  const sendMessage = async (content: string, spoken: boolean = false) => {
    const question = content.trim();
    if (!question) return;
    await sendTurn({ question, spoken });
  };

  // The field's own question goes, leaves the field empty, and blurs the input
  // so the tablet soft keyboard dismisses and the answer shows in Stage 1.
  const sendField = () => {
    const question = input;
    setInput("");
    void sendMessage(question, false);
    inputRef.current?.blur();
    setIsInputFocused(false);
  };

  // A question from elsewhere on the page, left for the cook to send.
  useImperativeHandle(ref, () => ({
    prefill: (question: string) => {
      focusInputOnOpen.current = true;
      setInput(question);
      if (isExpanded) {
        inputRef.current?.focus();
        setIsInputFocused(true);
      }
    },
    // A question heard by the voice, asked as it was heard.
    ask: (question: string) => {
      focusInputOnOpen.current = false;
      void sendMessage(question, true);
    },
    // A question asked with a dish photo.
    askWithPhoto: (photo: string, question: string, options?: { shown?: string }) => {
      focusInputOnOpen.current = false;
      const q = question.trim();
      if (!q) return;
      const match = photo.match(/^data:([^;]+);base64,(.+)$/);
      const mimeType = match ? match[1] : undefined;
      void sendTurn({
        question: q,
        spoken: false,
        image: { base64: photo, ...(mimeType ? { mimeType } : {}) },
        ...(options?.shown !== undefined ? { shown: options.shown } : {}),
      });
    },
    // Said by the app in the thread, and never part of what is sent on.
    notice: (text: string) => {
      setMessages((prev) => [...prev, { role: "assistant", content: text }]);
    },
  }));

  const handleQuickQuestion = async (question: string) => {
    onEngage?.();
    await sendMessage(question, false);
  };

  const isLoading = cookingMutation.isPending;

  // Closed, Ask is only its capsule in the cook's top line: nothing here.
  if (!isExpanded) return null;

  const innerHeight =
    vv?.innerHeight ?? (typeof window !== "undefined" ? window.innerHeight : 800);
  const vvHeight = vv?.height ?? innerHeight;
  const isKeyboardOpen = vvHeight < (vv?.fullHeight ?? innerHeight) * 0.85;
  const askMode: "rest" | "typing" =
    isInputFocused || isKeyboardOpen ? "typing" : "rest";

  /** The conversation, each turn marked with who said it. */
  const turns = (width?: { cook: string; sous: string }) =>
    messages.map((message, index) => (
      <div
        key={index}
        data-turn={index}
        data-from={message.role === "user" ? "cook" : "sous"}
        className={`flex ${message.role === "user" ? "justify-end" : ""}`}
      >
        <ChatBubble
          variant={message.role}
          {...(width ? { width: message.role === "user" ? width.cook : width.sous } : {})}
        >
          {message.role === "user" ? (
            <div className="space-y-2">
              {message.image && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={message.image.base64}
                  alt={ASK_COPY.photoAlt}
                  data-ask-photo=""
                  // Drawn after its turn was placed, it has just made the
                  // thread taller: the thread settles again.
                  onLoad={settleThread}
                  className="max-h-48 max-w-full rounded-[var(--radius-2)] object-cover"
                />
              )}
              <p className="whitespace-pre-wrap break-words text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink">
                {message.shown ?? message.content}
              </p>
            </div>
          ) : (
            <div className="space-y-[var(--space-2)]">
              <div className={ANSWER_PROSE}>
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
              {message.sources && message.sources.length > 0 && (
                <div
                  data-ask-sources=""
                  className="flex flex-wrap gap-[var(--space-2)] pt-[var(--space-1)]"
                >
                  {message.sources.map((source) => (
                    <a
                      key={source.url}
                      data-source-chip=""
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`inline-flex min-h-[var(--target)] items-center rounded-[var(--radius-2)] border border-ink/[.20] bg-sand px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft ${PRESS}`}
                    >
                      {source.title}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </ChatBubble>
      </div>
    ));

  if (panel) {
    const side = form === "side";
    const edge = side ? SIDE_X : EDGE_X;
    // Where the browser can listen, the panel has the mic. Until the page
    // knows how this device listens, it keeps that shape.
    const speaks = voice !== undefined && (voice.mode === null || voice.status !== "unsupported");
    // What the voice is hearing or just heard, on a line of its own where it
    // can wrap; a question it handed over is in the thread already. A
    // refused mic says so here, and stays to be tapped again (call 14).
    const hearing =
      voice !== undefined &&
      (voice.status === "hearing" || (voice.echo !== null && voice.echo.kind !== "asked"));
    const heard =
      voice === undefined
        ? null
        : hearing
          ? voiceLabel(voice.status, voice.echo)
          : voice.status === "blocked"
            ? ASK_COPY.micBlocked
            : null;
    const hasText = input.trim() !== "";
    const about = currentStepText?.trim() ? currentStepText.trim() : null;
    const empty = messages.length === 0 && !isLoading;

    return (
      <div
        ref={rootRef}
        role={side ? "complementary" : "dialog"}
        aria-modal={side ? undefined : true}
        aria-labelledby={titleId}
        // A touch anywhere on the panel is the cook's hand on it (call 13).
        onPointerDown={onEngage}
        data-ask="open"
        data-ask-form={form}
        data-ask-mode={askMode}
        // The keyboard up, the panel takes the height that is left, so the
        // field sits on the keyboard's top edge; else both shapes run the
        // screen's height.
        style={
          isKeyboardOpen && vv
            ? { top: `${vv.offsetTop}px`, height: `${vv.height}px`, bottom: "auto" }
            : undefined
        }
        className={side ? SIDE : SHEET}
      >
        <div
          className={`flex min-h-[var(--target)] shrink-0 items-center justify-between gap-[var(--space-3)] border-b border-ink/[.11] py-[calc(6*var(--cpx))] pr-[calc(8*var(--cpx))] ${side ? "pl-[calc(24*var(--cpx))]" : "pl-[var(--edge)]"}`}
        >
          <h2 id={titleId} className="text-[length:var(--type-chip)] leading-tight font-semibold text-ink">
            {ASK_COPY.title}
          </h2>
          <button
            ref={collapseRef}
            type="button"
            data-ask-close=""
            onClick={onToggle}
            aria-label={ASK_COPY.close}
            className={`${ROUND_GHOST} ${PRESS}`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              aria-hidden="true"
              className="size-[calc(26*var(--cpx))]"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {!side && alarm && (
          <div data-ask-alarm="" className={`shrink-0 border-b border-ink/[.11] bg-ground py-[var(--space-3)] ${edge}`}>
            {alarm}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col bg-paper">
          {/* What Sous takes the question to be about, pinned over the
              conversation, with a hairline under it so the scroll ends at a
              drawn edge. Beside the step, which is whole on screen, the
              step's line is one line that ends in an ellipsis; over the step
              it has up to three. */}
          {(about !== null || scaleLine) && !isKeyboardOpen && (
            <div
              data-ask-context=""
              className={`shrink-0 space-y-[var(--space-1)] border-b border-ink/[.11] py-[var(--space-1)] ${edge}`}
            >
              {about !== null && (
                <p
                  data-ask-about=""
                  className={`text-[length:var(--type-meta)] leading-[1.3] font-medium text-ink-soft ${side ? "truncate" : "line-clamp-3"}`}
                >
                  {ASK_COPY.about} {about}
                </p>
              )}
              {scaleLine && (
                <p
                  data-ask-scale-context=""
                  className="text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft"
                >
                  {scaleLine}
                </p>
              )}
            </div>
          )}

          <div
            ref={threadRef}
            data-ask-thread=""
            className={`relative min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain py-3 ${edge}`}
          >
            {empty ? (
              <>
                {/* While the heard line speaks (listening, heard, a refused
                    mic) the invitation steps aside: beside the step the quick
                    questions and that line then both fit without a scroll. */}
                {heard === null && (
                  <p className="py-2 text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
                    {ASK_COPY.empty}
                  </p>
                )}
                {!isKeyboardOpen && (
                  <ChatQuickReplies
                    label={ASK_COPY.quick}
                    replies={quickQuestions}
                    onSelect={handleQuickQuestion}
                    className="flex-wrap"
                  />
                )}
              </>
            ) : (
              // Sous's words take the thread's width; the cook's stop short of it.
              turns({ cook: "max-w-[88%]", sous: "max-w-full" })
            )}

            {isLoading && <ChatLoadingIndicator label={ASK_COPY.answering} />}
          </div>

          {heard !== null && (
            <p
              key={heard}
              data-ask-heard=""
              // What the mic is hearing is said by the voice's own line
              // (`VoiceSaid`); that the mic is refused, and to type instead,
              // is said only here, so it is announced.
              {...(hearing ? { "aria-hidden": true } : { role: "alert" })}
              className={`shrink-0 animate-dot-in py-[var(--space-2)] text-[length:var(--type-meta)] leading-[1.3] font-medium [overflow-wrap:anywhere] text-ink-soft motion-reduce:animate-none ${edge}`}
            >
              {heard}
            </p>
          )}
        </div>

        {/* The input strip: a paper field on the sand, then the camera and
            the mic; once there are words to send they give their room to
            the field and its Send (call 18). It is the height of the cook's
            foot (96 cpx: the targets, 6 over and 10 under), so beside the
            step its controls stand on Back and Forward's line. */}
        <div
          data-ask-input=""
          className={`flex shrink-0 items-center gap-[var(--space-2)] border-t border-ink/[.11] pt-[calc(6*var(--cpx))] pb-[calc(10*var(--cpx))] ${edge}`}
        >
          <ChatInput
            ref={inputRef}
            value={input}
            onChange={setInput}
            onSubmit={sendField}
            onFocus={() => {
              setIsInputFocused(true);
              onEngage?.();
            }}
            onBlur={() => setIsInputFocused(false)}
            placeholder={ASK_COPY.type}
            label={ASK_COPY.field}
            disabled={isLoading}
            send={hasText}
            className="min-w-0 flex-1"
          />
          {!hasText && onPhoto && (
            <button
              type="button"
              data-ask-camera=""
              onClick={() => {
                onEngage?.();
                onPhoto();
              }}
              aria-label={CAPSULE_COPY.photo}
              className={`${ROUND_GHOST} ${PRESS}`}
            >
              <CameraMark />
            </button>
          )}
          {!hasText && speaks && (
            <button
              ref={micRef}
              type="button"
              onClick={voice.onTap}
              aria-label={actionOf(voice.mode, voice.status)}
              // Listening on a tap, a tap does nothing while Sous speaks.
              aria-disabled={(voice.mode === "tap" && voice.status === "paused") || undefined}
              data-voice={voice.status}
              className={`${ROUND_GHOST} ${PRESS}`}
            >
              <MicMark status={voice.status} />
            </button>
          )}
        </div>
      </div>
    );
  }

  // The kitchen home's tray: two-stage escalation (Stage 1 at rest, Stage 2
  // typing or the keyboard up). It has no voice.
  const isTypingFull = isKeyboardOpen || (isInputFocused && innerHeight <= 560);
  const showQuickQuestions =
    messages.length === 0 && !isInputFocused && !isKeyboardOpen;
  const showThread = messages.length > 0 || isLoading || askMode === "typing";

  return (
    <div
      data-ask="open"
      data-ask-form="tray"
      data-ask-mode={askMode}
      style={
        isTypingFull && vv
          ? { top: `${vv.offsetTop}px`, height: `${vv.height}px`, bottom: "auto" }
          : undefined
      }
      className={`${SHELL} flex flex-col overflow-hidden ${
        isTypingFull
          ? "h-[100dvh] max-h-none rounded-none"
          : messages.length > 0
            ? "max-h-[68dvh] rounded-t-[var(--radius-3)]"
            : "max-h-[56dvh] rounded-t-[var(--radius-3)]"
      }`}
    >
      {/* Header */}
      <div className="shrink-0 border-b border-ink/[.11]">
        <button
          ref={collapseRef}
          type="button"
          onClick={onToggle}
          className={`flex min-h-[var(--target)] w-full cursor-pointer items-center justify-between py-1 ${
            isTypingFull ? "rounded-none" : "rounded-t-[var(--radius-3)]"
          } ${EDGE_X} ${PRESS}`}
        >
          <span className="text-[length:var(--type-chip)] leading-tight font-semibold text-ink">
            {ASK_COPY.title}
          </span>
          <span className="flex items-center gap-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-semibold text-ink-soft">
            <span>Collapse</span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="size-[calc(20*var(--cpx))] text-ink-soft"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col bg-paper">
        {scaleLine && (
          <p
            data-ask-scale-context=""
            className={`pt-[var(--space-2)] text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft ${EDGE_X}`}
          >
            {scaleLine}
          </p>
        )}
        {showQuickQuestions && (
          <ChatQuickReplies
            label={ASK_COPY.quick}
            replies={quickQuestions}
            onSelect={handleQuickQuestion}
            className={`py-[var(--space-2)] ${EDGE_X}`}
          />
        )}

        {showThread && (
          <div className={`min-h-[160px] flex-1 space-y-4 overflow-y-auto py-3 ${EDGE_X}`}>
            {messages.length === 0 ? (
              <p className="py-2 text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink-soft">
                {ASK_COPY.empty}
              </p>
            ) : (
              turns()
            )}

            {isLoading && <ChatLoadingIndicator label={ASK_COPY.answering} />}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* The input strip: a paper field on the sand. */}
      <div className={`shrink-0 border-t border-ink/[.11] py-[var(--space-2)] ${EDGE_X}`}>
        <ChatInput
          ref={inputRef}
          value={input}
          onChange={setInput}
          onSubmit={sendField}
          onFocus={() => setIsInputFocused(true)}
          onBlur={() => setIsInputFocused(false)}
          placeholder="Type your reply..."
          disabled={isLoading}
        />
      </div>
    </div>
  );
}

export const AskClaudePanel = AskSous;

