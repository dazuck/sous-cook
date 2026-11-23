import type {
  AIProvider,
  ChatOptions,
  ChatResponse,
  VisionOptions,
  VisionResponse,
} from "../ai/types";

export interface RecordedChatCall {
  provider: "google" | "anthropic";
  options: ChatOptions;
}

export interface RecordedVisionCall {
  provider: "google" | "anthropic";
  options: VisionOptions;
}

export type ChatHandler = (
  options: ChatOptions,
) => Promise<ChatResponse> | ChatResponse;

export type VisionHandler = (
  options: VisionOptions,
) => Promise<VisionResponse | string> | VisionResponse | string;

/**
 * Scripted AI provider for tests that exercise the real `chat()` and `vision()`
 * code paths without making network calls.
 */
export class FakeProviderController {
  readonly chatCalls: RecordedChatCall[] = [];
  readonly visionCalls: RecordedVisionCall[] = [];
  private chatQueue: ChatHandler[] = [];
  private defaultChatHandler: ChatHandler = () => ({
    content: "OK",
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 20 },
  });
  private visionQueue: VisionHandler[] = [];
  private defaultVisionHandler: VisionHandler = () => ({
    content: "{}",
    usage: { inputTokens: 100, outputTokens: 20 },
  });

  reset(): void {
    this.chatCalls.length = 0;
    this.visionCalls.length = 0;
    this.chatQueue.length = 0;
    this.visionQueue.length = 0;
    this.defaultChatHandler = () => ({
      content: "OK",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    this.defaultVisionHandler = () => ({
      content: "{}",
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  }

  onNextChat(handler: ChatHandler): void {
    this.chatQueue.push(handler);
  }

  setDefaultChat(handler: ChatHandler): void {
    this.defaultChatHandler = handler;
  }

  onNextVision(handler: VisionHandler): void {
    this.visionQueue.push(handler);
  }

  setDefaultVision(handler: VisionHandler): void {
    this.defaultVisionHandler = handler;
  }

  provider(name: "google" | "anthropic"): AIProvider {
    return {
      name,
      chat: async (options: ChatOptions): Promise<ChatResponse> => {
        this.chatCalls.push({ provider: name, options });
        const next = this.chatQueue.shift() ?? this.defaultChatHandler;
        const response = await next(options);
        return {
          usage: { inputTokens: 100, outputTokens: 20 },
          ...response,
        };
      },
      vision: async (options: VisionOptions): Promise<VisionResponse> => {
        this.visionCalls.push({ provider: name, options });
        const next = this.visionQueue.shift() ?? this.defaultVisionHandler;
        const raw = await next(options);
        if (typeof raw === "string") {
          return {
            content: raw,
            usage: { inputTokens: 100, outputTokens: 20 },
          };
        }
        return {
          usage: { inputTokens: 100, outputTokens: 20 },
          ...raw,
        };
      },
    };
  }
}
