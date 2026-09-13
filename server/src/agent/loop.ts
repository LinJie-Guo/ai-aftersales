import type { ToolRegistry } from "./tools/registry.ts";

import { hydrateChatMessages } from "./attachments.ts";
import { Inbox } from "./inbox.ts";
import { collectTurn, formatLlmError } from "./llm.ts";
import { renderSystemPrompt } from "./prompt.ts";
import { turnKnowledgePolicy } from "./prompt.ts";
import { RepeatToolReminder } from "./repeat-reminder.ts";
import { ProgressGuard } from "./progress.ts";
import { StreamingRedactor, redactSensitiveText, redactEventForClient } from "./redact.ts";
import { conclusionFromTools, deriveMessages, foldPlanMode, openTurn } from "./session.ts";
import type {
  InboxTarget,
  LlmTransport,
  LoopHooks,
  SessionStore,
  UserMessage,
} from "./types.ts";

export class ReactLoop {
  readonly inbox: Inbox;
  private abort = new AbortController();
  private running = false;
  private lastTurn = 0;
  private readonly repeats = new RepeatToolReminder();
  private knowledgeChoice = false;
  private selectedModel?: string;
  private pendingInbox: Promise<unknown> = Promise.resolve();
  private transientSeq = 0;

  get referenceKnowledge() { return this.knowledgeChoice; }
  get modelName() { return this.selectedModel; }

  constructor(
    private readonly session: SessionStore,
    private readonly llm: LlmTransport,
    private readonly tools: ToolRegistry,
    private readonly hooks: LoopHooks = {},
  ) {
    this.inbox = new Inbox(session.events);
    this.lastTurn = session.events.findLast((event) => event.type === "turn/start")?.data.turn as number ?? 0;
    this.selectedModel = session.events.findLast((event) => event.type === "turn/settings")?.data.modelName as string | undefined;
  }

  get status(): "idle" | "running" {
    return this.running ? "running" : "idle";
  }
  get cancelled(): boolean { return this.abort.signal.aborted; }

  followup(message: UserMessage): Promise<void> {
    return this.send(message, "next-turn", true);
  }

  steer(message: UserMessage): Promise<void> {
    if (this.running && ((message.referenceKnowledge === true) !== this.knowledgeChoice || message.modelName && message.modelName !== this.selectedModel)) {
      return this.followup({ ...message, source: "human" });
    }
    return this.send(message, "next-step", true);
  }

  inject(message: UserMessage): void {
    void this.send(message, "next-step", false).catch(() => this.abort.abort(new Error("排查上下文保存失败")));
  }

  cancel(): void {
    this.abort.abort();
  }

  /** Process died mid-run: drop the stale flag so a new pump can continue. */
  releaseAbandoned(): void {
    if (!this.running) return;
    this.abort.abort();
    this.running = false;
    this.abort = new AbortController();
  }

  inboxSnapshot() {
    return this.inbox.snapshot();
  }

  async updateQueue(
    itemId: string,
    action: { kind: "edit"; content: string } | { kind: "remove" } | { kind: "steer" },
  ): Promise<{ ok: true } | { ok: false; code: "queue-item-not-found" | "steer-unavailable" }> {
    return this.inboxMutation(async () => {
    const current = this.inbox.messageAt(itemId);
    const location = this.inbox.locate(itemId);
    if (!current || !location) return { ok: false, code: "queue-item-not-found" };
    if (action.kind === "steer") {
      if (location.target !== "next-turn" || !this.running || (current.referenceKnowledge === true) !== this.knowledgeChoice || current.modelName && current.modelName !== this.selectedModel) {
        return { ok: false, code: "steer-unavailable" };
      }
      const steered = { ...current, source: "steer" as const };
      await this.appendInbox("inbox/put", { target: "next-step", message: steered });
      await this.revealUser(steered);
      return { ok: true };
    }
    if (action.kind === "edit") {
      const content = action.content.trim();
      if (!content) return { ok: false, code: "queue-item-not-found" };
      await this.appendInbox("inbox/edit", { id: itemId, content });
      return { ok: true };
    }
    await this.appendInbox("inbox/remove", { ids: [itemId], reason: "user" });
    return { ok: true };
    });
  }

  /** Persist + broadcast now so 插队 appears in the transcript before the current step ends. */
  async revealUser(message: UserMessage): Promise<void> {
    if (message.source === "inject") return;
    message = this.inbox.messageAt(message.id) || message;
    if (message.source === "human" || message.source === "steer") this.repeats.reset();
    if (this.session.events.some((event) => event.type === "user/message" && String(event.data.id) === message.id)) {
      return;
    }
    await this.emit("user/message", persistUserPayload(message));
  }

  async send(message: UserMessage, target: InboxTarget, _wakeup: boolean): Promise<void> {
    await this.mutateInbox("inbox/put", { target, message: { ...message, modelName: message.modelName || this.selectedModel } });
  }

  private mutateInbox(type: string, data: Record<string, unknown>): Promise<void> {
    return this.inboxMutation(() => this.appendInbox(type, data));
  }
  private inboxMutation<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.pendingInbox.then(operation);
    this.pendingInbox = job.catch(() => {});
    return job;
  }
  private async appendInbox(type: string, data: Record<string, unknown>): Promise<void> {
      if (type === "inbox/put" && this.hooks.protectInput) {
        const message = data.message as UserMessage;
        data = { ...data, message: { ...message, content: await this.hooks.protectInput(message.content) } };
      }
      if (type === "inbox/edit" && this.hooks.protectInput) data = { ...data, content: await this.hooks.protectInput(String(data.content)) };
      const event = await this.session.append(type, redactEventForClient(data));
      this.inbox.apply(event);
      await this.hooks.onEvent?.(event);
  }

  private async claim(target: InboxTarget, turn: number, step: number): Promise<UserMessage[]> {
    return this.inboxMutation(async () => {
    const messages = [...this.inbox.nextStep, ...target === "next-turn" ? this.inbox.nextTurn.slice(0, 1) : []];
    if (messages.length) await this.appendInbox("inbox/claim", { turn, step, ids: messages.map((m) => m.id), messages });
    return messages;
    });
  }

  async *run(): AsyncGenerator<ReturnType<SessionStore["append"]> extends Promise<infer T> ? T : ReturnType<SessionStore["append"]>> {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    try {
      await this.pendingInbox;
      // Claim and user-message are separately committed. Recover the narrow crash
      // window from the complete claimed payload instead of losing that input.
      for (const event of [...this.session.events]) if (event.type === "inbox/claim") {
        for (const message of event.data.messages as UserMessage[] ?? []) {
          if (!this.session.events.some((entry) => entry.type === "user/message" && entry.data.id === message.id)) await this.emit("user/message", persistUserPayload(message));
        }
      }
      const open = openTurn(this.session.events);
      if (open) {
        console.info("[agent] resume open turn", { session: this.session.id, turn: open.turn, step: open.step, afterStep: open.afterStep });
        yield* this.turn({ resume: open });
      }
      while (!this.abort.signal.aborted) {
        await this.pendingInbox;
        if (!this.inbox.hasPending) {
          await Promise.resolve();
          if (!this.inbox.hasPending) break;
        }
        yield* this.turn();
      }
    } finally {
      this.running = false;
      const status = await this.emit("session/status", { status: "idle" });
      yield status;
    }
  }

  private async *turn(opts?: { resume?: { turn: number; step: number; afterStep?: boolean } }) {
    const resume = opts?.resume;
    const turn = resume?.turn ?? ++this.lastTurn;
    if (resume) this.lastTurn = Math.max(this.lastTurn, turn);
    this.tools.beginTurn();
    if (!resume) yield await this.emit("turn/start", { turn });
    const settled = resume && this.session.events.findLast((event) => event.type === "tool/result" && event.data.turn === turn && event.data.status === "success" && event.data.completion)?.data.completion as import("./tools/types.ts").ToolResult["completion"] | undefined;
    if (settled) {
      if (!this.session.events.some((event) => event.type === "turn/outcome" && event.data.turn === turn)) yield await this.emit("turn/outcome", { turn, ...settled, basis: "model-declared" });
      if (!this.session.events.some((event) => event.type === "assistant/message" && event.data.turn === turn && event.data.content === settled.summary && !(event.data.toolCalls as unknown[])?.length)) yield await this.emit("assistant/message", { turn, step: resume!.step, content: settled.summary, toolCalls: [] });
      yield await this.emit("turn/end", { turn, reason: settled.status });
      return;
    }
    let target: InboxTarget = resume ? "next-step" : "next-turn";
    let step = resume?.step ?? 0;
    let skipClaim = !!resume && !resume.afterStep;
    let usedTools = Boolean(resume && this.session.events.some((event) => event.type === "tool/call" && event.data.turn === turn));
    let finalizationReminded = Boolean(resume && this.session.events.some((event) => event.type === "assistant/draft" && event.data.turn === turn));
    let lastText = "";
    const deadline = setTimeout(() => this.abort.abort(new Error("本轮达到时长预算，请继续执行剩余任务")), this.hooks.maxDurationMs ?? 15 * 60_000);
    let endReason = "completed";
    let extraCache: { text: string; at: number } | undefined;
    const savedSettings = resume && this.session.events.findLast((event) => event.type === "turn/settings" && event.data.turn === turn);
    this.knowledgeChoice = savedSettings ? savedSettings.data.referenceKnowledge === true : false;
    let settingsLocked = Boolean(savedSettings);
    const progress = new ProgressGuard();
    try {
      while (!this.abort.signal.aborted) {
        if (step >= (this.hooks.maxSteps ?? 40)) {
          endReason = "budget";
          yield await this.emit("assistant/message", { turn, step, content: "本轮达到步骤预算，已保存排查记录。发送「继续」可接着处理。", toolCalls: [] });
          yield await this.emit("checkpoint", { turn, step, reason: "step-budget" });
          break;
        }
        await this.hooks.authorize?.();
        const claimed = skipClaim ? [] : await this.claim(target, turn, step + 1);
        if (!settingsLocked) {
          const firstUser = claimed.find((message) => message.source === "human" || message.source === "steer");
          this.knowledgeChoice = firstUser?.referenceKnowledge === true;
          const configured = await this.hooks.configureTurn?.({ modelName: firstUser?.modelName || this.selectedModel, referenceKnowledge: this.knowledgeChoice });
          this.selectedModel = String(configured?.modelName || firstUser?.modelName || this.selectedModel || "") || undefined;
          yield await this.emit("turn/settings", { turn, referenceKnowledge: this.knowledgeChoice, ...configured, modelName: this.selectedModel });
          settingsLocked = true;
        }
        if (resume && !extraCache) await this.hooks.configureTurn?.({ modelName: this.selectedModel, referenceKnowledge: this.knowledgeChoice, resume: true });
        this.tools.setEnabled("knowledge_search", this.knowledgeChoice);
        if (!skipClaim) {
          if (step === 0 && claimed.length === 0) break;
          if (step > 0 && claimed.length === 0 && !this.inbox.hasPending) {
            // continue only when tools queued next-step work
          }
          step += 1;
          yield await this.emit("step/start", { turn, step });
          for (const message of claimed) {
            if (message.source === "human" || message.source === "steer") { this.repeats.reset(); progress.reset(); }
            if (this.session.events.some((event) => event.type === "user/message" && String(event.data.id) === message.id)) {
              continue;
            }
            yield await this.emit("user/message", persistUserPayload(message));
          }
        }
        skipClaim = false;
        if (!extraCache) extraCache = { text: (await this.hooks.assembleExtraPrompt?.({ referenceKnowledge: this.knowledgeChoice, query: claimed.find((m) => m.source === "human" || m.source === "steer")?.content })) ?? "", at: Date.now() };
        const extra = [extraCache.text, turnKnowledgePolicy(this.knowledgeChoice)].filter(Boolean).join("\n\n");
        const system = renderSystemPrompt({
          base: this.hooks.systemPrompt,
          extra,
          planActive: foldPlanMode(this.session.events),
        });
        const schemas = this.tools.schemas();
        const chunks = [];
        const redactors = { text: new StreamingRedactor(), reasoning: new StreamingRedactor() };
        const buffered = { text: "", reasoning: "" };
        let flushedAt = Date.now();
        let outputChars = 0;
        const flush = async (final = false) => {
          const emitted = [];
          for (const kind of ["reasoning", "text"] as const) {
            if (final) buffered[kind] += redactors[kind].push("", true);
            if (buffered[kind]) {
              emitted.push(await this.transient(kind === "text" ? "assistant/chunk" : "assistant/reasoning", { turn, step, text: buffered[kind] }));
              buffered[kind] = "";
            }
          }
          flushedAt = Date.now();
          return emitted;
        };
        yield await this.emit("llm/request", { turn, step });
        const startedAt = Date.now();
        console.info("[agent] llm stream start", { session: this.session.id, turn, step, messages: deriveMessages(this.session.events).length });
        try {
          const history = deriveMessages(this.session.events);
          const messages = this.hooks.prepareMessages ? await this.hooks.prepareMessages(history, system, schemas, this.abort.signal) : await hydrateChatMessages(history);
          yield await this.emit("request/header", { turn, step, ...this.hooks.requestMetadata?.(), system, tools: schemas });
          for await (const chunk of this.llm.stream({
            system,
            messages,
            tools: schemas,
            signal: this.abort.signal,
          })) {
            chunks.push(chunk);
            outputChars += chunk.text?.length ?? chunk.toolCall?.argumentsText?.length ?? 0;
            if (outputChars > 2_000_000) throw new Error("模型输出超过本轮上限，请缩小任务后继续");
            if ((chunk.type === "reasoning" || chunk.type === "text") && chunk.text) {
              buffered[chunk.type] += redactors[chunk.type].push(chunk.text);
              if (Date.now() - flushedAt >= 80 || buffered[chunk.type].length >= 1024) for (const event of await flush()) yield event;
            }
          }
          for (const event of await flush(true)) yield event;
        } catch (error) {
          for (const event of await flush(true)) yield event;
          yield await this.emit("assistant/attempt", { turn, step, content: chunks.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""), reasoning: chunks.filter((c) => c.type === "reasoning").map((c) => c.text ?? "").join(""), interrupted: true });
          if (this.abort.signal.aborted) { endReason = "aborted"; break; }
          endReason = "failed";
          const text = formatLlmError(error);
          console.error("[agent] llm stream failed", { session: this.session.id, turn, step, error: redactSensitiveText(String(error)) });
          yield await this.emit("assistant/message", { turn, step, content: text, toolCalls: [] });
          yield await this.emit("step/end", { turn, step });
          break;
        }
        console.info("[agent] llm stream end", {
          session: this.session.id,
          turn,
          step,
          ms: Date.now() - startedAt,
          chunks: chunks.length,
        });
        const collected = collectTurn(chunks);
        const reasoning = chunks.filter((c) => c.type === "reasoning").map((c) => c.text ?? "").join("");
        if (reasoning) yield await this.emit("assistant/reasoning-complete", { turn, step, text: reasoning });
        if (collected.usage) {
          const promptTokens = collected.usage.promptTokens;
          const cachedTokens = collected.usage.cachedTokens;
          const cacheHitPercent = promptTokens > 0
            ? Math.round((cachedTokens / promptTokens) * 1000) / 10
            : 0;
          console.info("[llm] usage", { session: this.session.id, turn, step, promptTokens, cachedTokens, cacheHitPercent });
          yield await this.emit("llm/usage", {
            turn,
            step,
            promptTokens,
            completionTokens: collected.usage.completionTokens,
            cachedTokens,
            cacheHitPercent,
            ms: Date.now() - startedAt,
          });
        }
        if (!collected.text && collected.toolCalls.length === 0) {
          console.warn("[agent] empty model turn", { turn, step, chunks: chunks.map((chunk) => chunk.type) });
        }
        lastText = collected.text;
        if (collected.toolCalls.length === 0) {
          if (usedTools && this.tools.hasTerminal() && !finalizationReminded) {
            finalizationReminded = true;
            yield await this.emit("assistant/draft", { turn, step, content: collected.text });
            yield await this.emit("step/end", { turn, step });
            this.inject({ id: crypto.randomUUID(), role: "user", source: "inject", content: "当前只是候选答复，任务结果尚未声明。已有授权内还有可执行步骤就继续；否则单独调用 finish_task，区分 completed、blocked、needs_input，附实际证据或具体阻塞。不要为了填状态重复查询。" });
            target = "next-step";
            continue;
          }
          if (this.tools.hasTerminal()) endReason = usedTools ? "incomplete" : "answered";
          yield await this.emit("assistant/message", {
            turn,
            step,
            content: collected.text,
            toolCalls: [],
          });
          yield await this.emit("step/end", { turn, step });
          break;
        }
        yield await this.emit("assistant/message", {
          turn,
          step,
          content: collected.text,
          toolCalls: collected.toolCalls,
        });
        usedTools = true;
        for (const call of collected.toolCalls) {
          yield await this.emit("tool/call", {
            turn,
            step,
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
          });
        }
        await this.hooks.authorize?.();
        const results = await this.tools.executeBatch(collected.toolCalls, {
          signal: this.abort.signal,
          inject: (content) => {
            this.inject({
              id: crypto.randomUUID(),
              role: "user",
              content,
              source: "inject",
            });
          },
        });
        for (const [index, call] of collected.toolCalls.entries()) {
          const result = results[index]!;
          yield await this.emit("tool/result", {
            turn,
            step,
            callId: call.id,
            name: call.name,
            status: result.status,
            summary: `${result.summary}\n[证据](#evidence-${call.id})`,
            evidenceId: call.id,
            artifactId: result.artifactId,
            data: result.data ?? {},
            ...(result.completion ? { completion: result.completion } : {}),
          });
          if (result.sessionEvents) {
            for (const extraEvent of result.sessionEvents) {
              yield await this.emit(extraEvent.type, extraEvent.data);
            }
          }
        }
        yield await this.emit("step/end", { turn, step });
        const completion = results.find((result) => result.status === "success" && result.completion)?.completion;
        if (completion) {
          endReason = completion.status;
          lastText = completion.summary;
          yield await this.emit("turn/outcome", { turn, ...completion, basis: "model-declared" });
          yield await this.emit("assistant/message", { turn, step, content: completion.summary, toolCalls: [] });
          break;
        }
        const health = progress.note(results, collected.toolCalls);
        if (health.stop) {
          endReason = "blocked";
          yield await this.emit("checkpoint", { turn, step, reason: "no-progress" });
          yield await this.emit("assistant/message", { turn, step, content: "本轮排查暂时受阻：连续多步没有取得新证据，已停止重复尝试。执行记录已保留，可展开思考过程查看具体失败原因。请补充有效配置、凭据来源或纠正排查范围后继续；尚未得到可靠结论。", toolCalls: [] });
          break;
        }
        if (health.warning) this.inject({ id: crypto.randomUUID(), role: "user", source: "inject", content: health.warning });
        for (const call of collected.toolCalls) {
          const reminder = this.repeats.note(call.name, call.arguments);
          if (!reminder) continue;
          this.inject({
            id: crypto.randomUUID(),
            role: "user",
            content: reminder,
            source: "inject",
          });
        }
        target = "next-step";
      }
      if (!lastText.trim() && usedTools && endReason === "completed" && !this.abort.signal.aborted) {
        lastText = conclusionFromTools(this.session.events, turn);
        yield await this.emit("assistant/message", { turn, step, content: lastText, toolCalls: [] });
      }
      const reminder = await this.hooks.afterTurn?.({
        turn,
        text: lastText,
        usedTools,
        events: this.session.events,
      });
      if (reminder) this.inject(reminder);
    } catch (error) {
      endReason = "failed";
      yield await this.emit("assistant/message", { turn, step, content: `本轮已停止：${redactSensitiveText(error instanceof Error ? error.message : String(error))}`, toolCalls: [] });
    } finally {
      clearTimeout(deadline);
      await this.pendingInbox;
      const injectedIds = this.inbox.nextStep.filter((m) => m.source === "inject").map((m) => m.id);
      if (injectedIds.length) await this.mutateInbox("inbox/remove", { ids: injectedIds, reason: "turn-end" });
      if (this.abort.signal.aborted) yield await this.emit("checkpoint", { turn, step, reason: String(this.abort.signal.reason ?? "cancelled") });
      yield await this.emit("turn/end", { turn, reason: this.abort.signal.aborted ? "aborted" : endReason });
    }
  }

  private async emit(type: string, data: Record<string, unknown>) {
    const event = await this.session.append(type, redactEventForClient(data));
    await this.hooks.onEvent?.(event);
    return event;
  }

  private async transient(type: string, data: Record<string, unknown>) {
    const event = { seq: -(++this.transientSeq), type, data: redactEventForClient({ ...data, transient: true }), createdAt: new Date().toISOString() };
    await (this.hooks.onTransient ?? this.hooks.onEvent)?.(event);
    return event;
  }
}

function persistUserPayload(message: UserMessage): Record<string, unknown> {
  const attachments = (message.attachments ?? []).map((item) => ({
    fileName: item.fileName,
    file_name: item.fileName,
    storedName: item.storedName,
    stored_name: item.storedName,
    mimeType: item.mimeType,
    mime_type: item.mimeType,
    viewUrl: item.viewUrl || `/api/v1/files/${item.storedName}`,
    view_url: item.viewUrl || `/api/v1/files/${item.storedName}`,
  }));
  return {
    id: message.id,
    content: message.content,
    source: message.source,
    referenceKnowledge: message.referenceKnowledge === true,
    modelName: message.modelName,
    attachments,
    authorUsername: message.authorUsername,
    authorName: message.authorName,
    author_username: message.authorUsername,
    author_name: message.authorName,
  };
}
