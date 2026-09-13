import type { SessionEvent, SessionPreset } from "../shared/index.ts";

export type InboxTarget = "next-turn" | "next-step";

export type MessageSource = "human" | "inject" | "steer" | "system";

export interface MessageAttachment {
  fileName: string;
  storedName: string;
  mimeType: string;
  viewUrl?: string;
}

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
  source: MessageSource;
  attachments?: MessageAttachment[];
  images?: Array<{ mimeType: string; dataUrl: string }>;
  authorUsername?: string;
  authorName?: string;
  referenceKnowledge?: boolean;
  modelName?: string;
  hydrated?: boolean;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCallRequest[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface LlmChunk {
  type: "text" | "reasoning" | "tool_call" | "usage";
  text?: string;
  toolCall?: Partial<ToolCallRequest> & { id?: string; name?: string; argumentsText?: string };
  usage?: LlmUsage;
}

export interface LlmTurn {
  text: string;
  toolCalls: ToolCallRequest[];
  usage?: LlmUsage;
}

export interface LlmTransport {
  stream(input: {
    system: string;
    messages: ChatMessage[];
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    signal: AbortSignal;
  }): AsyncIterable<LlmChunk>;
}

export interface SessionStore {
  readonly id: string;
  readonly preset: SessionPreset;
  readonly events: SessionEvent[];
  append(type: string, data: Record<string, unknown>): SessionEvent | Promise<SessionEvent>;
}

export interface LoopHooks {
  systemPrompt?: string;
  maxContext?: number;
  maxSteps?: number;
  maxDurationMs?: number;
  authorize?(): Promise<void>;
  configureTurn?(options: { modelName?: string; referenceKnowledge: boolean; resume?: boolean }): Promise<Record<string, unknown>>;
  onTransient?(event: SessionEvent): void | Promise<void>;
  requestMetadata?(): Record<string, unknown>;
  prepareMessages?(messages: ChatMessage[], system: string, tools: unknown[], signal: AbortSignal): Promise<ChatMessage[]>;
  protectInput?(content: string): Promise<string>;
  onEvent?(event: SessionEvent): void | Promise<void>;
  assembleExtraPrompt?(options: { referenceKnowledge: boolean; query?: string }): string | Promise<string>;
  afterTurn?(input: { turn: number; text: string; usedTools: boolean; events: SessionEvent[] }): Promise<UserMessage | null>;
}
