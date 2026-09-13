import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { eq, desc } from "drizzle-orm";

import { config } from "../config.ts";
import { decrypt } from "../crypto.ts";
import { db } from "../db/client.ts";
import { afterSaleRecord, customerEnv, modelConfig, uploadedFile } from "../db/schema.ts";
import { searchKnowledgeDocs } from "../knowledge/docs.ts";
import { resolveConfiguredPrompt } from "./prompt.ts";

import { collectTurn } from "./llm.ts";
import { ReactLoop } from "./loop.ts";
import { DbSession } from "./store.ts";
import { ArtifactStore, createToolRegistry, type SshTarget, type ToolGroup } from "./tools/index.ts";
import type { LlmChunk, UserMessage } from "./types.ts";
import { authorizePolicy, type ExecutionPolicy } from "./policy.ts";
import { compactContext, CHECKPOINT_INSTRUCTION, withoutImageBytes } from "./context.ts";
import { attachmentsFromMarkdown, hydrateChatMessages } from "./attachments.ts";
import { measureContextBreakdown, estimateTokens } from "./context-meter.ts";
import { resolveTurnModel, type ModelSnapshot } from "./models.ts";
import { ApprovalBroker } from "./approvals.ts";
import { investigationTool } from "./tools/investigation.ts";
import { finishTool } from "./tools/finish.ts";

export interface LiveAgent {
  loop: ReactLoop;
  waiters: Set<(event: { seq: number; type: string; data: Record<string, unknown> }) => void>;
  pump?: Promise<void>;
  approvals: ApprovalBroker;
  liveOutput: { turn: number; step: number; text: string; reasoning: string };
}

export const liveAgents = new Map<string, LiveAgent>();
const startingAgents = new Map<string, Promise<LiveAgent>>();

export function userMessage(
  content: string,
  source: UserMessage["source"] = "human",
  author?: { authorUsername?: string; authorName?: string },
  extras?: Pick<UserMessage, "attachments" | "referenceKnowledge" | "modelName">,
): UserMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content,
    source,
    ...author,
    referenceKnowledge: extras?.referenceKnowledge === true,
    modelName: extras?.modelName,
    ...(extras?.attachments?.length ? { attachments: extras.attachments } : {}),
  };
}

interface StartAgentInput {
  session: DbSession;
  recordId: string;
  customerId: string;
  projectId: string;
  workdir?: string;
  envIp?: string;
  include?: ToolGroup[];
  knowledgeCustomerIds?: string[] | null;
  policy: ExecutionPolicy;
}
export async function startAgent(input: StartAgentInput): Promise<LiveAgent> {
  const existing = liveAgents.get(input.session.id);
  if (existing) return existing;
  const starting = startingAgents.get(input.session.id);
  if (starting) return starting;
  const job = createAgent(input);
  startingAgents.set(input.session.id, job);
  try { return await job; } finally { startingAgents.delete(input.session.id); }
}
async function createAgent(input: StartAgentInput): Promise<LiveAgent> {
  let knowledgeScope = await authorizePolicy(input.policy, input.recordId);

  const previous = input.session.events.findLast((event) => event.type === "turn/settings" && event.data.model)?.data.model as ModelSnapshot | undefined;
  let runtime = await resolveTurnModel(previous);
  let requestMetadata: Record<string, unknown> = {};
  const llm = { stream: (request: Parameters<typeof runtime.transport.stream>[0]) => runtime.transport.stream(request) };

  const artifacts = new ArtifactStore(path.join(config.dataRoot, "_agent", input.session.id));
  await artifacts.ready();
  const [env] = await db.select().from(customerEnv).where(eq(customerEnv.customerId, input.customerId)).limit(1);
  const ssh = await resolveSsh(env?.sshHost || input.envIp, env?.sshUser ?? undefined, env?.sshKeyEnc ?? undefined);

  const live: LiveAgent = {
    loop: null as unknown as ReactLoop,
    waiters: new Set(),
    approvals: null as unknown as ApprovalBroker,
    liveOutput: { turn: 0, step: 0, text: "", reasoning: "" },
  };
  const publish = (event: any) => {
    if (event.type === "step/start" || event.type === "turn/end") live.liveOutput = { turn: event.data.turn || 0, step: event.data.step || 0, text: "", reasoning: "" };
    if (event.type === "assistant/chunk" || event.type === "assistant/reasoning") {
      const key = event.type === "assistant/chunk" ? "text" : "reasoning";
      live.liveOutput[key] = (live.liveOutput[key] + String(event.data.text || "")).slice(-200000);
    }
    for (const waiter of live.waiters) waiter(event);
  };
  live.approvals = new ApprovalBroker(input.session, publish);
  await live.approvals.recover();

  const registry = createToolRegistry({
    reposDir: path.join(config.dataRoot, input.projectId, input.customerId, "_latest"),
    artifacts,
    customerId: input.customerId,
    workdir: input.workdir,
    ssh,
    approve: async (tool, command, signal) => {
      await authorizePolicy(input.policy, input.recordId);
      const allowed = await live.approvals.request(tool, command, ssh ? `${ssh.username}@${ssh.host}:${ssh.port}` : "未配置", signal);
      if (allowed) await authorizePolicy(input.policy, input.recordId);
      return allowed;
    },
    include: input.session.preset === "general" ? [] : input.policy.permission === "code" || input.session.preset === "plan" ? ["code", "knowledge"] : input.include,
    searchKnowledge: async (query) => {
      knowledgeScope = await authorizePolicy(input.policy, input.recordId);
      const hits = await searchKnowledgeDocs(query, 8, knowledgeScope);
      return hits.map((hit) => ({
        id: hit.id,
        title: hit.title,
        symptom: hit.summary,
        rootCause: hit.markdown,
        steps: undefined,
      }));
    },
  });
  if (input.session.preset !== "general") { registry.register(investigationTool(input.session)); registry.register(finishTool(input.session)); }

  const authorizedAttachments = new Set<string>();
  const loop = new ReactLoop(input.session, llm, registry, {
    maxContext: runtime.snapshot.maxContext,
    configureTurn: async ({ modelName }) => {
      runtime = await resolveTurnModel(runtime.snapshot, modelName);
      return { modelName: runtime.snapshot.modelName, model: runtime.snapshot, permission: input.policy.permission };
    },
    requestMetadata: () => requestMetadata,
    protectInput: (content) => artifacts.protect(content),
    prepareMessages: async (messages, system, tools, turnSignal) => {
      for (const message of messages) {
        if (message.role !== "user") continue;
        for (const attachment of [...message.attachments ?? [], ...attachmentsFromMarkdown(message.content)]) {
          if (authorizedAttachments.has(attachment.storedName)) continue;
          const [owned] = await db.select().from(uploadedFile).where(eq(uploadedFile.storedName, attachment.storedName)).limit(1);
          if (!owned || owned.customerId !== input.customerId || owned.recordId && owned.recordId !== input.recordId) throw new Error("附件不属于当前工单或客户，无法送入模型");
          authorizedAttachments.add(attachment.storedName);
        }
      }
      const max = runtime.snapshot.maxContext;
      const budget = Math.floor(max * 0.7) - estimateTokens(system) - estimateTokens(JSON.stringify(tools));
      if (budget < 2000) throw new Error("系统提示词或工具定义超出模型上下文预算，请调整配置");
      const hydrated = await hydrateChatMessages(messages);
      for (const message of hydrated) if (message.role === "user") message.content = await artifacts.protect(message.content);
      const compacted = await compactContext(hydrated, budget, artifacts, async (history) => {
        const chunks: LlmChunk[] = [];
        const signal = AbortSignal.any([turnSignal, AbortSignal.timeout(90000)]);
        let characters = 0;
        for await (const chunk of llm.stream({ system, tools: tools as any[], messages: [...history, { role: "user", id: crypto.randomUUID(), source: "system", content: CHECKPOINT_INSTRUCTION }], signal })) {
          chunks.push(chunk);
          characters += chunk.text?.length || 0;
          if (characters > 32000) throw new Error("检查点输出过长，原始历史保留");
        }
        const result = collectTurn(chunks);
        if (result.toolCalls.length) throw new Error("检查点请求返回工具调用，未执行，原始历史保留");
        await input.session.append("context/summary-usage", { ...result.usage, modelName: runtime.snapshot.modelName });
        return result.text;
      });
      if (compacted.compacted) publish(await input.session.append("context/checkpoint", { messages: compacted.messages.map(withoutImageBytes), removed: compacted.removed, artifactId: compacted.artifactId, budget }));
      const snapshot = { model: runtime.snapshot, system, tools, messages: compacted.messages.map((message) => message.role === "user" ? { ...message, images: message.images?.map((image) => ({ mimeType: image.mimeType, sha256: createHash("sha256").update(image.dataUrl).digest("hex"), source: message.attachments })) } : message) };
      const ref = await artifacts.persistText("request", JSON.stringify(snapshot), { modelName: runtime.snapshot.modelName });
      requestMetadata = { model: runtime.snapshot, requestArtifactId: ref.id, requestHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), context: measureContextBreakdown({ system, tools: tools as any[], messages: compacted.messages }) };
      return compacted.messages;
    },
    authorize: async () => { knowledgeScope = await authorizePolicy(input.policy, input.recordId); },
    assembleExtraPrompt: async ({ referenceKnowledge, query }) => {
      const reposDir = path.join(config.dataRoot, input.projectId, input.customerId, "_latest");
      let repos = "未拉取";
      try {
        const names = (await readdir(reposDir)).filter((name) => !name.startsWith("."));
        repos = names.length ? names.join("、") : "目录为空";
      } catch {
        repos = "目录不存在";
      }
      const sshState = ssh?.privateKey ? `已配置 ${ssh.username}@${ssh.host}:${ssh.port}` : input.envIp ? `有地址 ${input.envIp} 但无私钥` : "未配置";
      const site = [
        "【本工单现场】",
        `- SSH：${sshState}`,
        `- 工作目录：${input.workdir || "未配置"}`,
        `- 已拉取代码仓：${repos}`,
        "- read / grep / glob / code_git_log 操作已拉取的本地源码，相对路径从仓库名开始。",
        "- remote_read / http_request / bash 操作客户现场，可用性以本轮工具列表为准；无需再次询问是否允许使用已提供的只读工具。",
        "- 命令和 HTTP 方法的审批由执行层负责；需要审批时调用工具让系统发起确认，不在答复中索取笼统授权。",
      ].join("\n");
      const [ticket] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, input.recordId)).limit(1);
      const related = referenceKnowledge ? await searchKnowledgeDocs(query || ticket?.title || "", 5, knowledgeScope) : [];
      const wiki = related.length
        ? [
          "【历史知识候选，仅供参考；不等于本工单现场事实】",
          ...related.map((hit) => `- ${hit.title}：${hit.summary || "见文档"}`),
        ].join("\n")
        : "";
      const state = input.session.events.findLast((event) => event.type === "investigation/state")?.data;
      return [site, wiki, state ? `【上一检查点，逐条核对证据与时效】\n${JSON.stringify(state)}` : "",
        "需要时用 investigation_state 保存工作状态；工具排查结束用 finish_task 输出结果，未完成应明确 blocked/needs_input。关键结论引用 [证据](#evidence-callId)，区分观察结果和推断。",
      ].filter(Boolean).join("\n\n");
    },
    systemPrompt: resolveConfiguredPrompt(runtime.row.systemPrompt),
    onEvent: publish,
    onTransient: publish,
  });
  live.loop = loop;
  liveAgents.set(input.session.id, live);
  return live;
}

async function resolveSsh(envIp: string | undefined, sshUser: string | undefined, sshKeyEnc: string | undefined): Promise<SshTarget | null> {
  if (!envIp) return null;
  const address = envIp.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(address);
  const simple = /^([^:]+)(?::(\d+))?$/.exec(address);
  const host = bracketed?.[1] || simple?.[1] || address;
  const port = Number(bracketed?.[2] || simple?.[2] || 22);
  if (!host || /[\s\0]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH 地址或端口无效");
  let privateKey = decrypt(sshKeyEnc);
  if (!privateKey && config.sshPrivateKeyPath) {
    try {
      privateKey = await readFile(config.sshPrivateKeyPath, "utf8");
    } catch {
      privateKey = "";
    }
  }
  if (!privateKey) return { host, port, username: sshUser || config.sshDefaultUser };
  return {
    host,
    port,
    username: sshUser || config.sshDefaultUser,
    privateKey,
  };
}
