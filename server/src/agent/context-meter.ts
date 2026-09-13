import type { SessionEvent } from "../shared/index.ts";

import type { ChatMessage } from "./types.ts";

export interface ContextBreakdown {
  systemTokens: number;
  toolsTokens: number;
  messageTokens: number;
  usedTokens: number;
}

/** Same heuristic as the workbench meter: CJK ≈ 1 token, else ≈ 0.25. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) tokens += /[\u4e00-\u9fff]/.test(ch) ? 1 : 0.25;
  return Math.max(1, Math.ceil(tokens));
}

export function measureContextBreakdown(input: {
  system: string;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  messages: ChatMessage[];
}): ContextBreakdown {
  const systemTokens = estimateTokens(input.system);
  const toolsTokens = input.tools.length
    ? estimateTokens(JSON.stringify(input.tools))
    : 0;
  let messageTokens = 0;
  for (const message of input.messages) {
    messageTokens += estimateMessageTokens(message);
  }
  return {
    systemTokens,
    toolsTokens,
    messageTokens,
    usedTokens: systemTokens + toolsTokens + messageTokens,
  };
}

export function estimateMessageTokens(message: ChatMessage): number {
  return estimateTokens(message.content || "") + (message.role === "assistant" && message.toolCalls?.length ? estimateTokens(JSON.stringify(message.toolCalls)) : 0)
    + (message.role === "user" ? (message.images?.length ?? 0) * 4096 : 0) + 4;
}

export function foldCacheUsage(events: SessionEvent[]): {
  promptTokens: number;
  cachedTokens: number;
  cacheHitPercent: number | null;
} {
  let promptTokens = 0;
  let cachedTokens = 0;
  for (const event of events) {
    if (event.type !== "llm/usage") continue;
    const data = event.data || {};
    promptTokens += Number(data.promptTokens ?? data.prompt_tokens ?? 0) || 0;
    cachedTokens += Number(data.cachedTokens ?? data.cached_tokens ?? 0) || 0;
  }
  return {
    promptTokens,
    cachedTokens,
    cacheHitPercent: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 1000) / 10 : null,
  };
}
