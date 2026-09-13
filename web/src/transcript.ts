import type { ChatAttachment, SessionEvent } from "./api";
import { isToolFallback } from "./messageNotice";

export type TranscriptItem =
  | { key: string; kind: "user"; content: string; at?: string; elapsedMs?: number; source?: string; author?: string; attachments?: ChatAttachment[]; referenceKnowledge?: boolean }
  | { key: string; kind: "assistant"; content: string; streaming?: boolean; at?: string; elapsedMs?: number; outcome?: string }
  | { key: string; kind: "thinking"; content: string; streaming?: boolean }
  | { key: string; kind: "note"; content: string }
  | { key: string; kind: "tool"; callId: string; name: string; status: "running" | "done" | "error"; summary: string; args?: Record<string, unknown> };

export function eventTime(event: SessionEvent): number | undefined {
  const raw = event.createdAt || event.created_at;
  if (!raw) return undefined;
  const value = new Date(raw).getTime();
  return Number.isNaN(value) ? undefined : value;
}

export function projectEvents(events: SessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  let stream = "";
  let streamKey = "assistant";
  let streamAt: number | undefined;
  let thinking = "";
  let thinkingKey = "thinking";
  let turnStart: number | undefined;
  let failedInTurn = false;
  let hasToolResultInTurn = false;

  const flushAssistant = (streaming = false, at?: number, elapsedMs?: number) => {
    if (!stream) return;
    items.push({
      key: streamKey,
      kind: "assistant",
      content: stream,
      streaming,
      at: at ? new Date(at).toISOString() : undefined,
      elapsedMs,
    });
    stream = "";
    streamAt = undefined;
  };
  const flushThinking = (streaming = false) => {
    if (!thinking) return;
    items.push({ key: thinkingKey, kind: "thinking", content: thinking, streaming });
    thinking = "";
  };
  const flushNote = () => {
    const content = stream.trim();
    stream = "";
    streamAt = undefined;
    if (!content) return;
    items.push({ key: `n-${streamKey}`, kind: "note", content });
  };

  for (const event of events) {
    const data = event.data || {};
    const at = eventTime(event);
    if (event.type === "turn/start") {
      turnStart = at ?? turnStart;
      failedInTurn = false;
      hasToolResultInTurn = false;
    } else if (event.type === "user/message" && (data.source === "human" || data.source === "steer" || !data.source)) {
      flushThinking();
      flushAssistant();
      if (at && !turnStart) turnStart = at;
      items.push({
        key: `u-${event.seq}`,
        kind: "user",
        content: String(data.content || ""),
        at: at ? new Date(at).toISOString() : undefined,
        source: typeof data.source === "string" ? data.source : undefined,
        referenceKnowledge: typeof data.referenceKnowledge === "boolean" ? data.referenceKnowledge : undefined,
        author: String(data.authorName || data.author_name || data.authorUsername || data.author_username || "").trim() || undefined,
        attachments: attachmentsFromEvent(data),
      });
    } else if (event.type === "assistant/reasoning" || event.type === "assistant/reasoning-complete") {
      if (event.type === "assistant/reasoning-complete") thinking = "";
      thinking += String(data.text || "");
      thinkingKey = `th-${event.seq}`;
    } else if (event.type === "assistant/chunk") {
      stream += String(data.text || "");
      streamKey = `a-${event.seq}`;
      streamAt = at ?? streamAt;
    } else if (event.type === "assistant/attempt") {
      flushThinking();
      if (data.reasoning) items.push({ key: `attempt-${event.seq}`, kind: "thinking", content: String(data.reasoning) });
    } else if (event.type === "assistant/message") {
      const toolCalls = data.toolCalls;
      if (Array.isArray(toolCalls) && toolCalls.length) {
        if (!stream.trim() && String(data.content || "").trim()) stream = String(data.content);
        flushNote();
      } else {
        flushThinking();
        const content = String(data.content || stream).trim();
        // Older sessions appended raw tool output after a model failure. The
        // original events remain intact; their tool rows already expose details.
        if (isToolFallback(content) && failedInTurn && hasToolResultInTurn) {
          stream = "";
          streamAt = undefined;
          continue;
        }
        if (content.startsWith("模型请求失败")) failedInTurn = true;
        if (content) {
          stream = content;
          streamKey = `a-${event.seq}`;
          const end = at ?? streamAt;
          const elapsedMs = turnStart && end ? Math.max(0, end - turnStart) : undefined;
          flushAssistant(false, end, elapsedMs);
        } else {
          stream = "";
          streamAt = undefined;
        }
      }
    } else if (event.type === "tool/call") {
      flushNote();
      flushThinking();
      const callId = String(data.callId || data.call_id || event.seq);
      const item: Extract<TranscriptItem, { kind: "tool" }> = {
        key: `t-${callId}`,
        kind: "tool",
        callId,
        name: String(data.name || "tool"),
        status: "running",
        summary: "",
        args: asArgs(data.arguments),
      };
      tools.set(callId, item);
      items.push(item);
    } else if (event.type === "tool/result") {
      hasToolResultInTurn = true;
      const callId = String(data.callId || data.call_id || event.seq);
      const existing = tools.get(callId);
      if (existing) {
        existing.status = data.status === "success" ? "done" : "error";
        existing.summary = String(data.summary || "");
      } else {
        items.push({
          key: `t-${callId}`,
          kind: "tool",
          callId,
          name: String(data.name || "tool"),
          status: data.status === "success" ? "done" : "error",
          summary: String(data.summary || ""),
          args: asArgs(data.arguments),
        });
      }
    } else if (event.type === "turn/end") {
      const last = [...items].reverse().find((item) => item.kind === "assistant");
      if (last?.kind === "assistant") last.outcome = String(data.reason || "");
      if (last && last.kind === "assistant" && last.elapsedMs == null && turnStart && at) {
        last.elapsedMs = Math.max(0, at - turnStart);
        if (!last.at) last.at = new Date(at).toISOString();
      }
      turnStart = undefined;
    }
  }
  if (thinking) items.push({ key: thinkingKey, kind: "thinking", content: thinking, streaming: true });
  if (stream) {
    const elapsedMs = turnStart && streamAt ? Math.max(0, streamAt - turnStart) : undefined;
    flushAssistant(true, streamAt, elapsedMs);
  }
  return items;
}

export type ProcessGroup = {
  key: string;
  kind: "process";
  items: Extract<TranscriptItem, { kind: "tool" | "thinking" | "note" }>[];
  elapsedMs?: number;
};

export type DisplayItem = TranscriptItem | ProcessGroup;

export function groupProcess(items: TranscriptItem[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  let buf: Extract<TranscriptItem, { kind: "tool" | "thinking" | "note" }>[] = [];
  const flush = (elapsedMs?: number) => {
    if (!buf.length) return;
    out.push({ key: `proc-${buf[0].key}`, kind: "process", items: buf, elapsedMs });
    buf = [];
  };
  for (const item of items) {
    if (item.kind === "tool" || item.kind === "thinking" || item.kind === "note") buf.push(item);
    else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

function asArgs(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function attachmentsFromEvent(data: Record<string, unknown>): ChatAttachment[] | undefined {
  if (!Array.isArray(data.attachments) || !data.attachments.length) return undefined;
  const items = data.attachments.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const rec = item as Record<string, unknown>;
    const stored = String(rec.storedName || rec.stored_name || "").trim();
    const view = String(rec.viewUrl || rec.view_url || (stored ? `/api/v1/files/${stored}` : ""));
    const fileName = String(rec.fileName || rec.file_name || stored);
    if (!view && !fileName) return [];
    const mime = String(rec.mimeType || rec.mime_type || "");
    return [{
      file_name: fileName,
      stored_name: stored,
      view_url: view,
      mime_type: mime,
      is_image: mime.startsWith("image/") || Boolean(rec.isImage || rec.is_image),
    }];
  });
  return items.length ? items : undefined;
}
