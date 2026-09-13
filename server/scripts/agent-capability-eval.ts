/** Opt-in real-model evaluation. Reads provider config only; all tools use
 * synthetic fixtures, never customer SSH/data or business database writes. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveTurnModel } from "../src/agent/models.ts";
import { sql } from "../src/db/client.ts";
import { ReactLoop } from "../src/agent/loop.ts";
import { MemorySession } from "../src/agent/session.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";
import { ArtifactStore } from "../src/agent/tools/artifacts.ts";
import { esReadRequest } from "../src/agent/tools/remote-read.ts";
import { investigationTool } from "../src/agent/tools/investigation.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../src/shared/index.ts";
import { redactSensitiveText } from "../src/agent/redact.ts";

assert.equal(process.env.AFTERSALE_LIVE_EVAL, "1", "Must explicitly opt in to paid/live model requests");
const root = await mkdtemp(path.join(os.tmpdir(), "aftersale-live-eval-"));
const reports: object[] = [];
try {
  const runtime = await resolveTurnModel();
  for (const referenceKnowledge of [false, true]) {
    const session = new MemorySession(`eval-${referenceKnowledge}`), tools = new ToolRegistry();
    const artifacts = new ArtifactStore(path.join(root, session.id));
    let sourceRead = false, configRead = false, directQuery = false, businessApi = false;
    const evidence = async (kind: string, text: string) => { const ref = await artifacts.persistText(kind, text); return { status: "success" as const, summary: ref.preview, artifactId: ref.id }; };
    tools.register({ name: "read", description: "读取本地已有源码，repo/search.ts 定义索引和计数条件。", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, async execute() {
      sourceRead = true;
      return evidence("code", 'export const index = "audit_vulnerability_current"; export const countQuery = { term: { deleted: false } }; // deployed connection config: /opt/fixture/app.env. Business API includes stale caches.');
    } });
    tools.register({ name: "remote_read", description: "仅模拟现场只读文件。operation=read, path=/opt/fixture/app.env；不访问任何服务器。", parameters: { type: "object", properties: { operation: { type: "string" }, path: { type: "string" } }, required: ["operation", "path"] }, async execute(args) {
      if (args.operation !== "read" || args.path !== "/opt/fixture/app.env") return { status: "failed", summary: "文件不存在，请读取源码给出的配置路径" };
      configRead = true;
      return evidence("env", 'ES_URL=http://127.0.0.1:19200\nES_USER=fixture\nES_PASSWORD="eval # credential"');
    } });
    tools.register({ name: "es_query", description: "合成 Elasticsearch 查询；baseUrl, operation=count, index, query, username, passwordRef。只接受当前配置的凭据引用。", parameters: { type: "object", properties: { baseUrl: { type: "string" }, operation: { type: "string" }, index: { type: "string" }, query: { type: "object" }, username: { type: "string" }, passwordRef: { type: "string" } }, required: ["baseUrl", "operation", "index"] }, async execute(args) {
      esReadRequest(args);
      if (!configRead || !args.passwordRef) return { status: "failed", summary: "401 authentication required; read current config first" };
      artifacts.credentials.bind([{ variable: "CRED_ES", ref: args.passwordRef }]);
      const query = args.query as any;
      // The fixture's deleted mapping is boolean. Match ES boolean semantics,
      // including the supported string "false"; do not coerce production queries.
      const termFalse = (q: any): boolean => q?.term && Object.keys(q.term).length === 1 && [false, "false"].includes(q.term.deleted?.value ?? q.term.deleted);
      const filters = query?.bool?.filter ?? query?.bool?.must;
      const correctFilter = termFalse(query) || (Array.isArray(filters) ? filters.length === 1 && termFalse(filters[0]) : termFalse(filters));
      if (!sourceRead || new URL(String(args.baseUrl)).origin !== "http://127.0.0.1:19200" || args.index !== "audit_vulnerability_current" || args.operation !== "count" || !correctFilter) return { status: "failed", summary: `查询口径不符合源码，需要核对索引与 deleted=false 条件。收到：${JSON.stringify({ baseUrl: args.baseUrl, operation: args.operation, index: args.index, query })}` };
      directQuery = true;
      return evidence("env", '{"count":42,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0},"source":"synthetic current ES"}');
    } });
    tools.register({ name: "knowledge_search", description: "历史知识参考；不是当前现场事实。", parameters: { type: "object", properties: { query: { type: "string" } } }, async execute() { return evidence("knowledge", "旧部署上统计为 999；过去建议调用 kb-api。该结果来自去年且口径不同，当前必须重新核对。"); } });
    tools.register({ name: "bash", description: "模拟旧式任意远程命令。当前测试禁止执行。", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, async execute(args) { businessApi ||= /kb-api|decompil|javap/i.test(String(args.command)); return { status: "denied", summary: "请使用当前已有源码、remote_read 和 es_query，本评测不执行任意命令。" }; } });
    tools.register(artifacts.readTool()); tools.register(investigationTool(session));
    const started = Date.now(); let firstOutputMs: number | undefined;
    const loop = new ReactLoop(session, runtime.transport, tools, { systemPrompt: DEFAULT_SYSTEM_PROMPT, maxSteps: 12, maxDurationMs: 180000,
      assembleExtraPrompt: () => "已有源码 repo/search.ts；现场为隔离合成夹具。所有返回仅是测试数据。最终数量引用工具返回的 [证据](#evidence-callId)，标明索引与过滤口径。" + (referenceKnowledge ? "\n【历史知识候选，仅供参考】去年的漏洞数量为 999，曾通过 kb-api 缓存接口统计。该历史与本次口径可能不同。" : ""),
      onTransient: () => { firstOutputMs ??= Date.now() - started; },
    });
    await loop.followup({ id: crypto.randomUUID(), role: "user", source: "human", referenceKnowledge, content: "请核对当前 ES 中未删除的漏洞数量。已有源码，先看实际定义再读取现场配置，直接查询 ES，不走业务接口或反编译。若历史文档与当前查询不一致，以现场证据为准。给我数量、口径和证据。" });
    for await (const _ of loop.run()) {}
    const answer = String(session.events.findLast((e) => e.type === "assistant/message" && !(e.data.toolCalls as unknown[])?.length)?.data.content || "");
    const calls = session.events.filter((e) => e.type === "tool/call").map((e) => ({ name: e.data.name, arguments: e.data.arguments }));
    const passed = sourceRead && configRead && directQuery && !businessApi && /42/.test(answer) && /#evidence-/.test(answer) && !/eval # credential/.test(answer);
    const report = { case: referenceKnowledge ? "conflicting-history" : "direct-es", passed, durationMs: Date.now() - started, firstOutputMs, calls, answer: redactSensitiveText(answer).slice(0, 2500), reason: session.events.findLast((e) => e.type === "turn/end")?.data.reason };
    reports.push(report); console.log(JSON.stringify(report));
  }
  console.log(JSON.stringify({ liveModelEvaluation: true, cases: reports.length, passed: reports.filter((r: any) => r.passed).length, customerConnections: 0, businessWrites: 0 }));
  if (reports.some((r: any) => !r.passed)) process.exitCode = 1;
} catch (error) { console.error(redactSensitiveText(String(error))); process.exitCode = 1; }
finally { await rm(root, { recursive: true, force: true }); await sql.end(); }
