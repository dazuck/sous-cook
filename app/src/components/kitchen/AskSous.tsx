"use client";

import {
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
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
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { ANSWER_PROSE } from "./answer-prose";
import { EDGE_X } from "./cook-edge";
import { VoiceDotButton, type VoiceProps, voiceLabel } from "./VoiceDot";

export type Message = {
  role: "user" | "assistant";
  content: string;
  image?: {
    base64: string;
    mimeType?: string;
  };
  sources?: GroundingSource[];
};

/** Placeholder copy for Ask, awaiting a rewrite. */
export const ASK_COPY = {
  title: "Ask Sous",
  empty: "Ask anything while you cook.",
  error: "Couldn't reach Sous. Check the connection and ask again.",
  cutOff: "Sous's answer ran long and was cut off. Ask again, or ask for it shorter.",
  help: "Help",
  quick: "Quick questions",
  answering: "Sous is answering",
} as const;

// Ask is a sand surface (DS §1's one panel fill), with a 1px ink/[.11] hairline
// and a 320ms rise/fade entrance. Opened, the conversation sits on paper
// between the sand header and the sand input strip, so Sous's words are ink on
// paper and the cook's, like the quick questions, are sand.
const SHELL =
  "fixed bottom-0 left-0 right-0 z-40 border-t border-ink/[.11] bg-sand font-[family-name:var(--font-text)] text-ink starting:opacity-0 starting:translate-y-3 transition-[opacity,transform] duration-320 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none";
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
   * Ask with a dish photo immediately: sends the photo and question to the model,
   * optionally conditioned on the recipe context.
   */
  askWithPhoto: (
    photo: string,
    question: string,
    options?: { includeRecipeContext?: boolean },
  ) => void;
}

export type AskClaudeHandle = AskSousHandle;

export interface AskSousProps {
  recipeContext: string; // Current recipe name/details for context
  sessionId: string;
  isExpanded: boolean;
  onToggle: () => void;
  queueId?: string;
  currentStepIndex?: number;
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
  ref?: Ref<AskSousHandle>;
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
  timers,
  currentStepText,
  ingredients,
  servings,
  servesBase,
  scaleContext,
  offlineReply,
  voice,
  onSpeak,
  ref,
}: AskSousProps) {
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
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dotRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const focusInputOnOpen = useRef(false);

  // Offline, React Query would hold the question until the connection came
  // back, with "Sous is answering" up the whole time. Sent regardless, it
  // fails at once and Ask says it couldn't reach Sous (B5.md B5).
  const cookingMutation = trpc.chatCooking.useMutation({ networkMode: "always" });

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (isExpanded) {
      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      messagesEndRef.current?.scrollIntoView({ behavior: reduced ? "instant" : "smooth" });
    }
  }, [messages, isExpanded]);

  // Focus: at rest, keep the soft keyboard down by focusing the voice dot (or
  // Collapse when speech is unsupported). Focus the text input on open only
  // when explicitly prefilled ("Missed it? Ask Sous").
  useEffect(() => {
    if (!isExpanded) {
      focusInputOnOpen.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- kept in the effect: a reset made while rendering can be lost when React replays updates it queued without rendering (KitchenTimers lost one that way)
      setIsInputFocused(false);
      return;
    }
    if (focusInputOnOpen.current) {
      inputRef.current?.focus();
      setIsInputFocused(true);
    } else {
      (dotRef.current ?? collapseRef.current)?.focus();
    }
  }, [isExpanded]);

  // Track visualViewport when expanded so Stage 2 escalates to the available
  // visual viewport when the tablet soft keyboard opens.
  useEffect(() => {
    if (!isExpanded || typeof window === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- kept in the effect: a reset made while rendering can be lost when React replays updates it queued without rendering (KitchenTimers lost one that way)
      setVv(null);
      return;
    }
    const viewport = window.visualViewport;
    const syncViewport = () => {
      const innerHeight = window.innerHeight;
      if (viewport) {
        setVv({
          height: viewport.height,
          offsetTop: viewport.offsetTop,
          innerHeight,
        });
      } else {
        setVv({
          height: innerHeight,
          offsetTop: 0,
          innerHeight,
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
  // Questions asked while an answer is on its way, sent in order after it.
  const queued = useRef<Array<{ question: string; spoken: boolean }>>([]);
  // The question whose answer is on its way; null when none is.
  const asking = useRef<string | null>(null);

  const answer = async (
    question: string,
    spoken: boolean = false,
    image?: { base64: string; mimeType?: string },
    includeRecipeContext: boolean = true,
  ) => {
    const userMessage: Message = {
      role: "user",
      content: question,
      ...(image ? { image } : {}),
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
        currentRecipe: includeRecipeContext ? fullRecipeContext : undefined,
        ...(includeRecipeContext && queueId !== undefined ? { queueId } : {}),
        ...(includeRecipeContext && servings !== undefined ? { servings } : {}),
        ...(includeRecipeContext && servesBase !== undefined ? { servesBase } : {}),
        ...(includeRecipeContext && currentStepIndex !== undefined
          ? { currentStepIndex }
          : {}),
        ...(includeRecipeContext && timers !== undefined ? { timers } : {}),
        includeRecipeContext,
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

  // One question at a time: one asked over an answer on its way waits for
  // it, rather than racing it and leaving it out of the history. A question
  // already asked or waiting (a second tap) is not asked again.
  const sendMessage = async (content: string, spoken: boolean = false) => {
    const question = content.trim();
    if (!question) return;
    if (asking.current !== null) {
      if (
        asking.current !== question &&
        !queued.current.some((item) => item.question === question)
      ) {
        queued.current.push({ question, spoken });
      }
      return;
    }
    try {
      for (
        let next: { question: string; spoken: boolean } | undefined = {
          question,
          spoken,
        };
        next;
        next = queued.current.shift()
      ) {
        asking.current = next.question;
        await answer(next.question, next.spoken);
      }
    } finally {
      asking.current = null;
    }
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
    askWithPhoto: (
      photo: string,
      question: string,
      options?: { includeRecipeContext?: boolean },
    ) => {
      focusInputOnOpen.current = false;
      const q = question.trim();
      if (!q) return;
      const match = photo.match(/^data:([^;]+);base64,(.+)$/);
      const mimeType = match ? match[1] : undefined;
      void answer(
        q,
        false,
        { base64: photo, ...(mimeType ? { mimeType } : {}) },
        options?.includeRecipeContext ?? true,
      );
    },
  }));

  const handleQuickQuestion = async (question: string) => {
    await sendMessage(question, false);
  };

  const isLoading = cookingMutation.isPending;

  // Closed, Ask is only its word in the cook's foot (V5): nothing here.
  if (!isExpanded) return null;

  const innerHeight =
    vv?.innerHeight ?? (typeof window !== "undefined" ? window.innerHeight : 800);
  const vvHeight = vv?.height ?? innerHeight;
  const isKeyboardOpen = vvHeight < innerHeight * 0.85;
  const askMode: "rest" | "typing" =
    isInputFocused || isKeyboardOpen ? "typing" : "rest";
  const isTypingFull = isKeyboardOpen || (isInputFocused && innerHeight <= 560);
  const showQuickQuestions =
    messages.length === 0 && !isInputFocused && !isKeyboardOpen;
  const showThread = messages.length > 0 || isLoading || askMode === "typing";

  // Where the browser can listen, the voice shares the bar. Until the page
  // knows how this device listens, the bar keeps that shape.
  const speaks = voice && (voice.mode === null || voice.status !== "unsupported");

  // In the open field the dot comes first, and what it hears is the hint
  // until it has been asked.
  const heard =
    voice &&
    (voice.status === "hearing" || (voice.echo !== null && voice.echo.kind !== "asked"));
  const hint = heard && voice ? voiceLabel(voice.status, voice.echo) : "Type your reply...";

  // Expanded state - two-stage escalation (Stage 1 at rest, Stage 2 typing/keyboard)
  return (
    <div
      data-ask="open"
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
              messages.map((message, index) => (
                <div
                  key={index}
                  data-from={message.role === "user" ? "cook" : "sous"}
                  className={`flex ${message.role === "user" ? "justify-end" : ""}`}
                >
                  <ChatBubble variant={message.role}>
                    {message.role === "user" ? (
                      <div className="space-y-2">
                        {message.image && (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={message.image.base64}
                            alt="Dish photo"
                            className="max-h-48 max-w-full rounded-[var(--radius-2)] object-cover"
                          />
                        )}
                        <p className="whitespace-pre-wrap break-words text-[length:var(--type-meta)] leading-[1.35] font-medium text-ink">
                          {message.content}
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
              ))
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
          placeholder={hint}
          disabled={isLoading}
          leading={speaks ? <VoiceDotButton ref={dotRef} {...voice} /> : undefined}
        />
      </div>
    </div>
  );
}

export const AskClaudePanel = AskSous;

