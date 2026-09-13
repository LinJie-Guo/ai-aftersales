import type { ChatMessage, LlmChunk, LlmTransport, LlmUsage, ToolCallRequest } from "./types.ts";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  retry?: number;
  imageInput?: boolean;
  idleTimeoutMs?: number;
}

export class OpenAICompatibleTransport implements LlmTransport {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  async *stream(input: {
    system: string;
    messages: ChatMessage[];
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    signal: AbortSignal;
  }): AsyncIterable<LlmChunk> {
    const attempts = 1 + Math.max(0, this.config.retry ?? 2);
    if (this.config.imageInput === false && chatHasImages(input.messages)) throw new Error("当前配置的模型不支持图片，请选择支持图片的模型后继续；图片未被丢弃。");
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (input.signal.aborted) return;
      const state: StreamParseState = { tools: new Map(), reasoningAcc: "", contentAcc: "" };
      let useful = false;
      const t0 = Date.now();
      try {
        for await (const chunk of this.iterateResponse(input, state)) {
          if (!useful) console.info("[llm] first chunk", { ms: Date.now() - t0, type: chunk.type });
          if (chunk.type !== "usage") useful = true;
          yield chunk;
        }
      } catch (error) {
        if (input.signal.aborted) throw error;
        if (useful || isImageUnsupportedError(error) || isExhaustedQuota(error) || /LLM 请求失败 4\d\d/.test(String(error)) && !/请求失败 (408|429)/.test(String(error)) || attempt >= attempts) throw error;
        console.warn("[llm] retry after error", { attempt, error: error instanceof Error ? error.message : String(error) });
        await delay(400 * attempt, input.signal);
        continue;
      }
      if (useful && !state.networkError) return;
      if (useful && state.networkError) throw new Error("模型响应中断，已停止本次生成；请继续重试。");
      // Empty 200 stream is a finished turn, not a transport failure. Retrying
      // it waits another 1–2 minutes for ox-alpha and still gets nothing.
      if (state.networkError && attempt < attempts) {
        console.warn("[llm] retry after network_error", { attempt });
        await delay(400 * attempt, input.signal);
        continue;
      }
      if (!useful) {
        console.warn("[llm] empty stream", { attempt, attempts, networkError: state.networkError });
        yield { type: "text", text: "模型本轮没有输出。请再试一次。" };
      }
      return;
    }
  }

  private async *iterateResponse(
    input: {
      system: string;
      messages: ChatMessage[];
      tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
      signal: AbortSignal;
    },
    state: StreamParseState,
  ): AsyncGenerator<LlmChunk> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const openrouter = url.includes("openrouter.ai");
    const body = buildChatCompletionBody({
      model: this.config.model,
      temperature: this.config.temperature,
      system: input.system,
      messages: input.messages,
      tools: input.tools,
    });
    const firstByte = new AbortController();
    const firstByteMs = this.config.timeoutMs ?? 120_000;
    let timeoutStage = "等待首个输出";
    const timer = setTimeout(() => firstByte.abort(), firstByteMs);
    const totalTimer = setTimeout(() => { timeoutStage = "生成总时长"; firstByte.abort(); }, Math.max(firstByteMs * 3, 30_000));
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const onCancel = () => {
      firstByte.abort();
    };
    if (input.signal.aborted) {
      clearTimeout(timer);
      clearTimeout(totalTimer);
      throw new Error("LLM 请求已取消");
    }
    input.signal.addEventListener("abort", onCancel, { once: true });
    const t0 = Date.now();
    console.info("[llm] fetch start", { messages: input.messages.length });
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          ...(openrouter ? { "HTTP-Referer": "http://localhost:8080", "X-Title": "AI Aftersale" } : {}),
        },
        body: JSON.stringify(body),
        signal: firstByte.signal,
      });
    console.info("[llm] fetch headers", { ms: Date.now() - t0, status: response.status });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`LLM 请求失败 ${response.status}: ${text.slice(0, 800)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = function* (chunk: string, flush: boolean) {
      buffer += chunk;
      const lines = buffer.split("\n");
      if (!flush) buffer = lines.pop() ?? "";
      else buffer = "";
      for (const line of lines) yield* parseOpenAISseLine(line, state);
    };
    const stopRead = () => { reader.cancel().catch(() => {}); };
    firstByte.signal.addEventListener("abort", stopRead, { once: true });
    if (firstByte.signal.aborted) stopRead();
    try {
      while (!firstByte.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          yield* consume(decoder.decode(), true);
          break;
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { timeoutStage = "输出停滞"; firstByte.abort(); }, this.config.idleTimeoutMs ?? Math.min(firstByteMs, 45_000));
        const parsed = [...consume(decoder.decode(value, { stream: true }), false)];
        if (parsed.some((chunk) => chunk.type !== "usage")) clearTimeout(timer);
        yield* parsed;
      }
      if (firstByte.signal.aborted) throw new Error(input.signal.aborted ? "LLM 请求已取消" : `模型${timeoutStage}超时`);
      if (state.networkError || !state.finished) throw new Error("模型响应中断，未收到完整结束标记");
    } finally {
      firstByte.signal.removeEventListener("abort", stopRead);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    } catch (error) {
      if (firstByte.signal.aborted && !input.signal.aborted) throw new Error(`模型${timeoutStage}超时`);
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      input.signal.removeEventListener("abort", onCancel);
    }
  }
}

export interface StreamParseState {
  tools: Map<number, { id: string; name: string; argumentsText: string }>;
  reasoningAcc: string;
  contentAcc: string;
  networkError?: boolean;
  finished?: boolean;
}

export function consumeOpenAISseText(text: string): LlmChunk[] {
  const state: StreamParseState = { tools: new Map(), reasoningAcc: "", contentAcc: "" };
  const chunks: LlmChunk[] = [];
  for (const line of text.split("\n")) {
    for (const chunk of parseOpenAISseLine(line, state)) chunks.push(chunk);
  }
  return chunks;
}

export function* parseOpenAISseLine(line: string, state: StreamParseState): Generator<LlmChunk> {
  const payload = line.replace(/^data:\s?/, "").trim();
  if (payload === "[DONE]") { state.finished = true; return; }
  if (!payload || payload.startsWith(":")) return;
  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    return;
  }
  const usage = parseUsage(json);
  if (usage) yield { type: "usage", usage };
  const choice = json.choices?.[0] ?? {};
  if (choice.finish_reason) state.finished = true;
  if (choice.native_finish_reason === "network_error" || json.error) state.networkError = true;
  const delta = choice.delta ?? {};
  const message = choice.message ?? {};
  const reasoningDelta = extractReasoning(delta);
  const reasoning = reasoningDelta ? { delta: reasoningDelta, acc: state.reasoningAcc + reasoningDelta } : takeDelta(extractReasoning(message), state.reasoningAcc);
  state.reasoningAcc = reasoning.acc;
  if (reasoning.delta) yield { type: "reasoning", text: reasoning.delta };
  const rawText = typeof delta.content === "string" ? delta.content : typeof message.content === "string" ? message.content : "";
  const content = typeof delta.content === "string" ? { delta: rawText, acc: state.contentAcc + rawText } : takeDelta(rawText, state.contentAcc);
  state.contentAcc = content.acc;
  if (content.delta) yield { type: "text", text: content.delta };
  const toolParts = Array.isArray(delta.tool_calls) && delta.tool_calls.length
    ? delta.tool_calls
    : Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const part of toolParts) {
    const index = Number(part.index ?? 0);
    const current = state.tools.get(index) ?? { id: "", name: "", argumentsText: "" };
    if (part.id) current.id = part.id;
    if (part.function?.name) current.name = cleanToolName(part.function.name);
    if (part.function?.arguments) current.argumentsText = Array.isArray(delta.tool_calls) ? current.argumentsText + part.function.arguments : part.function.arguments;
    state.tools.set(index, current);
    yield { type: "tool_call", toolCall: { ...current } };
  }
}

export function buildChatCompletionBody(input: {
  model: string;
  temperature?: number;
  system: string;
  messages: ChatMessage[];
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    temperature: input.temperature ?? 0.2,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: input.system },
      ...input.messages.map(toOpenAIMessage),
    ],
  };
  if (input.tools.length) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  // Do not force OpenRouter reasoning:{enabled:true}. stealth/ox-alpha then
  // finishes with empty content and zero tool_calls, so the agent never acts.
  return body;
}

export function parseUsage(json: Record<string, unknown> | null | undefined): LlmUsage | null {
  const usage = json?.usage;
  if (!usage || typeof usage !== "object") return null;
  const rec = usage as Record<string, unknown>;
  const details = rec.prompt_tokens_details && typeof rec.prompt_tokens_details === "object"
    ? rec.prompt_tokens_details as Record<string, unknown>
    : {};
  const promptTokens = Number(rec.prompt_tokens ?? rec.input_tokens ?? 0) || 0;
  const completionTokens = Number(rec.completion_tokens ?? rec.output_tokens ?? 0) || 0;
  const cachedTokens = Number(
    rec.cached_tokens
    ?? details.cached_tokens
    ?? rec.cache_read_input_tokens
    ?? details.cache_read_input_tokens
    ?? 0,
  ) || 0;
  if (!promptTokens && !completionTokens && !cachedTokens) return null;
  return { promptTokens, completionTokens, cachedTokens };
}

export function collectTurn(chunks: LlmChunk[]): { text: string; toolCalls: ToolCallRequest[]; usage?: LlmUsage } {
  let text = "";
  let usage: LlmUsage | undefined;
  const tools = new Map<string, { id: string; name: string; argumentsText: string }>();
  let index = 0;
  for (const chunk of chunks) {
    if (chunk.type === "usage" && chunk.usage) usage = chunk.usage;
    if (chunk.type === "text" && chunk.text) text += chunk.text;
    if (chunk.type === "tool_call" && chunk.toolCall) {
      const key = chunk.toolCall.id || String(index++);
      const current = tools.get(key) ?? { id: key, name: "", argumentsText: "" };
      if (chunk.toolCall.id) current.id = chunk.toolCall.id;
      if (chunk.toolCall.name) current.name = cleanToolName(chunk.toolCall.name);
      if (chunk.toolCall.argumentsText) current.argumentsText = chunk.toolCall.argumentsText;
      tools.set(key, current);
    }
  }
  const toolCalls: ToolCallRequest[] = [...tools.values()]
    .filter((item) => item.name)
    .map((item) => ({
      id: item.id || crypto.randomUUID(),
      name: item.name,
      arguments: parseArgs(item.argumentsText),
    }));
  return { text, toolCalls, usage };
}

export function cleanToolName(name: string): string {
  return String(name).replace(/<[\s\S]*$/, "").replace(/[^a-zA-Z0-9_]/g, "");
}

export function extractReasoning(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning === "string" && delta.reasoning) return delta.reasoning;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) return delta.reasoning_content;
  const details = delta.reasoning_details;
  if (!Array.isArray(details)) return "";
  const parts: string[] = [];
  for (const item of details) {
    if (typeof item === "string") parts.push(item);
    else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      if (typeof rec.text === "string") parts.push(rec.text);
      else if (typeof rec.content === "string") parts.push(rec.content);
    }
  }
  return parts.join("");
}

/** OpenRouter 有时给增量，有时给整段快照；只产出新增后缀。 */
export function takeDelta(next: string, acc: string): { delta: string; acc: string } {
  if (!next) return { delta: "", acc };
  if (next === acc) return { delta: "", acc };
  if (acc && next.startsWith(acc)) return { delta: next.slice(acc.length), acc: next };
  if (next && acc.startsWith(next)) return { delta: "", acc };
  const limit = Math.min(acc.length, next.length);
  for (let i = limit; i > 0; i--) {
    if (acc.endsWith(next.slice(0, i))) {
      return { delta: next.slice(i), acc: acc + next.slice(i) };
    }
  }
  return { delta: next, acc: acc + next };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function isExhaustedQuota(error: unknown): boolean {
  return /daily limit (?:reached|exceeded)|insufficient_quota|billing_hard_limit_reached|quota (?:exhausted|depleted)/i.test(String(error));
}

export function formatLlmError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const decoded = raw.replace(/\\+"/g, "\"").replace(/\\{2,}/g, "\\");
  if (/no endpoints found that support image|does not support image input|support image input/i.test(decoded)) {
    return "模型请求失败：当前模型或接口不支持看图，请选择支持图文的模型后继续；图片未被丢弃。";
  }
  if (/tool call and result not match|tool call result does not follow/i.test(decoded)) {
    return "模型请求失败：上一轮工具结果没写完整（排查中途断了）。已自动补齐，请再发一次「继续」。";
  }
  if (isExhaustedQuota(error)) return "模型请求失败：供应方明确返回可用额度已耗尽，短时间重试无效。请等待额度重置，或切换可用模型后继续；本轮执行记录已保留。";
  if (/\b429\b|rate.?limit|too many requests/i.test(decoded)) {
    return "模型请求失败：当前模型限流或额度用尽，请稍后再试，或换一个模型。";
  }
  if (/超时|timeout/i.test(decoded) && !decoded.includes("{")) {
    return raw.startsWith("模型请求失败") ? raw : `模型请求失败：${raw.replace(/^LLM 请求失败[^：:]*[：:]\s*/, "")}`;
  }
  const leaf = deepestErrorMessage(raw);
  if (leaf && !leaf.startsWith("{")) return `模型请求失败：${leaf}`;
  const status = raw.match(/LLM 请求失败 (\d+)/)?.[1];
  return status
    ? `模型请求失败：上游返回 ${status}，请再试一次。`
    : `模型请求失败：${raw.replace(/^LLM 请求失败[^：:]*[：:]\s*/, "").slice(0, 180) || "请再试一次。"}`;
}

function deepestErrorMessage(raw: string): string {
  const start = raw.indexOf("{");
  if (start < 0) return "";
  const found: string[] = [];
  walkErrorStrings(tryJson(raw.slice(start)), found, 0);
  return found.at(-1) || "";
}

function walkErrorStrings(value: unknown, found: string[], depth: number) {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    const parsed = tryJson(value);
    if (parsed) walkErrorStrings(parsed, found, depth + 1);
    else if (value.length < 240 && /[A-Za-z\u4e00-\u9fff]/.test(value)) found.push(value);
    return;
  }
  if (typeof value !== "object") return;
  const rec = value as Record<string, unknown>;
  for (const key of ["error", "metadata", "raw", "details", "message"]) {
    if (key in rec) walkErrorStrings(rec[key], found, depth + 1);
  }
}

function tryJson(text: string): unknown {
  if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : { value };
  } catch {
    return { raw };
  }
}

export function chatHasImages(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === "user" && Boolean(message.images?.length));
}

export function isImageUnsupportedError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  return /no endpoints found that support image|does not support image input|support image input/i.test(raw);
}

export function messagesWithoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || !message.images?.length) return message;
    const note = `（附件中有 ${message.images.length} 张图片，当前模型不支持看图，未送入画面。）`;
    const { images: _images, ...rest } = message;
    return { ...rest, content: [message.content, note].filter(Boolean).join("\n\n") };
  });
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "user") {
    if (!message.images?.length) return { role: "user", content: message.content };
    return {
      role: "user",
      content: [
        { type: "text", text: message.content },
        ...message.images.map((image) => ({
          type: "image_url",
          image_url: { url: image.dataUrl },
        })),
      ],
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return {
    role: "tool",
    tool_call_id: message.toolCallId,
    content: message.content,
  };
}
