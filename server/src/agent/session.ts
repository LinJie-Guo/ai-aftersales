import type { SessionEvent, SessionPreset } from "../shared/index.ts";

import { attachmentsFromRequest } from "./attachments.ts";
import type { ChatMessage, SessionStore, ToolCallRequest, UserMessage } from "./types.ts";

export class MemorySession implements SessionStore {
  events: SessionEvent[] = [];
  private seq = 0;

  constructor(
    public readonly id: string,
    public readonly preset: SessionPreset = "investigate",
  ) {}

  append(type: string, data: Record<string, unknown>): SessionEvent {
    const event: SessionEvent = { seq: ++this.seq, type, data };
    this.events.push(event);
    return event;
  }
}

export function deriveMessages(events: SessionEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const heldUsers: ChatMessage[] = [];
  const pendingToolIds = new Set<string>();

  const flushHeldUsers = () => {
    if (!heldUsers.length) return;
    messages.push(...heldUsers);
    heldUsers.length = 0;
  };

  for (const event of events) {
    if (event.type === "context/checkpoint" && Array.isArray(event.data.messages)) {
      messages.splice(0, messages.length, ...event.data.messages as ChatMessage[]);
      heldUsers.length = 0;
      pendingToolIds.clear();
    } else if (event.type === "user/message") {
      const attachments = attachmentsFromRequest(event.data.attachments);
      const images = Array.isArray(event.data.images)
        ? (event.data.images as Array<{ mimeType?: string; dataUrl?: string }>)
          .filter((image) => image?.dataUrl)
          .map((image) => ({ mimeType: String(image.mimeType || "image/png"), dataUrl: String(image.dataUrl) }))
        : undefined;
      const user: ChatMessage = {
        id: String(event.data.id ?? `u-${event.seq}`),
        role: "user",
        content: String(event.data.content ?? ""),
        source: (event.data.source as UserMessage["source"]) || "human",
        referenceKnowledge: event.data.referenceKnowledge === true,
        modelName: typeof event.data.modelName === "string" ? event.data.modelName : undefined,
        ...(attachments.length ? { attachments } : {}),
        ...(images?.length ? { images } : {}),
      };
      // Steer/followup may be persisted while tools are still running. OpenAI-compatible
      // providers reject a user turn between assistant.tool_calls and their tool results.
      if (pendingToolIds.size) heldUsers.push(user);
      else messages.push(user);
    } else if (event.type === "assistant/message" || event.type === "assistant/draft") {
      closeOpenTools();
      const toolCalls = (event.data.toolCalls as ToolCallRequest[] | undefined) ?? [];
      messages.push({
        role: "assistant",
        content: String(event.data.content ?? ""),
        toolCalls,
      });
      pendingToolIds.clear();
      for (const call of toolCalls) {
        if (call.id) pendingToolIds.add(call.id);
      }
    } else if (event.type === "tool/result") {
      const toolCallId = String(event.data.callId ?? "");
      if (!toolCallId || !pendingToolIds.has(toolCallId)) continue;
      messages.push({
        role: "tool",
        toolCallId,
        name: String(event.data.name ?? ""),
        content: String(event.data.summary ?? event.data.content ?? ""),
      });
      pendingToolIds.delete(toolCallId);
      if (!pendingToolIds.size) flushHeldUsers();
    }
  }
  closeOpenTools();
  flushHeldUsers();
  return messages;

  function closeOpenTools() {
    if (!pendingToolIds.size) return;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && message.toolCalls?.length);
    const names = new Map((lastAssistant?.role === "assistant" ? lastAssistant.toolCalls ?? [] : []).map((call) => [call.id, call.name]));
    for (const id of pendingToolIds) {
      messages.push({
        role: "tool",
        toolCallId: id,
        name: names.get(id) ?? "tool",
        content: "（工具结果未写入，可能因上次中断丢失）",
      });
    }
    pendingToolIds.clear();
  }
}

export function foldPlanMode(events: SessionEvent[]): boolean {
  let active = false;
  for (const event of events) {
    if (event.type === "plan/mode") active = Boolean(event.data.active);
  }
  return active;
}

/** A turn/start without turn/end — process restart left the model mid-step. */
export function openTurn(events: SessionEvent[]): { turn: number; step: number; afterStep: boolean } | null {
  let turn = 0;
  let step = 0;
  let open = false;
  let afterStep = false;
  for (const event of events) {
    if (event.type === "turn/start") {
      turn = Number(event.data.turn || 0);
      step = 0;
      open = true;
      afterStep = false;
    } else if (event.type === "turn/end") {
      open = false;
      afterStep = false;
    } else if (event.type === "step/start") {
      step = Number(event.data.step || 0);
      afterStep = false;
    } else if (event.type === "step/end") {
      afterStep = true;
    }
  }
  if (!open || !turn) return null;
  return { turn, step: Math.max(1, step), afterStep };
}

export function conclusionFromTools(events: SessionEvent[], turn: number): string {
  const count = events.filter((event) => event.type === "tool/result" && Number(event.data.turn) === turn).length;
  return `本轮执行记录已保留，但尚未生成最终结论。已收到 ${count} 项工具结果，可展开思考过程查看，或发送「继续」完成分析。`;
}
