/** HTTP/SSE regression in a disposable container and dedicated database only.
 * No business mounts, real model endpoints, or customer SSH are used. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { config } from "../src/config.ts";
import { db, sql } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { seed } from "../src/db/seed.ts";
import { project, customer, afterSaleRecord, modelConfig, knowledge, session, sessionEvent } from "../src/db/schema.ts";
import { encrypt } from "../src/crypto.ts";
import { createApp } from "../src/http/app.ts";
import { liveAgents } from "../src/agent/host.ts";
import { nextDocumentCode } from "../src/db/numbering.ts";
import { ApprovalBroker } from "../src/agent/approvals.ts";
import { loadSession } from "../src/agent/store.ts";
import { Inbox } from "../src/agent/inbox.ts";

assert.equal(process.env.AFTERSALE_ISOLATED_TEST, "1");
assert.ok(new URL(config.databaseUrl).pathname.endsWith("_regression"));
assert.ok(config.dataRoot.startsWith("/tmp/"));

let token = "", releaseSlow: (() => void) | undefined, slowStarted: (() => void) | undefined;
const requests: { enabled: boolean; system: string; model: string }[] = [];
const mock = createServer(async (req, res) => {
  try {
    if (req.url === "/v1/models") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "isolated-mock", context_length: 128000 }, { id: "isolated-other", context_length: 64000, input_modalities: ["text"] }] })); return; }
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw), messages = body.messages;
    if (body.stream === false) {
      res.setHeader("Content-Type", "application/json");
      if (body.model === "fixture-quota") { res.statusCode = 429; res.end(JSON.stringify({ error: { message: "Daily limit reached" } })); return; }
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] })); return;
    }
    const enabled = body.tools?.some((tool: any) => tool.function?.name === "knowledge_search") === true;
    requests.push({ enabled, system: messages.find((message: any) => message.role === "system")?.content || "", model: body.model });
    const last = messages.at(-1);
    if (last?.role === "user" && last.content === "fixture-rate-limit") { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "synthetic rate limit" } })); return; }
    if (last?.role === "user" && last.content === "slow-request") {
      slowStarted?.(); await new Promise<void>((resolve) => { releaseSlow = resolve; });
    }
    const blocked = last?.role === "user" && last.content === "fixture-blocked";
    const finish = last?.role === "tool" && body.tools?.some((tool: any) => tool.function?.name === "finish_task");
    const tool = blocked || finish || enabled && last?.role !== "tool";
    const delta = blocked
      ? { tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name: "finish_task", arguments: JSON.stringify({ status: "blocked", summary: "当前排查受阻：隔离服务暂不可用，尚未取得目标数据。", evidenceIds: [], blockers: ["隔离服务暂不可用"] }) } }] }
      : finish
      ? { tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name: "finish_task", arguments: JSON.stringify({ status: "completed", summary: "隔离回归完成；现场查询与历史参考分离。", evidenceIds: [last.tool_call_id] }) } }] }
      : tool
      ? { tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name: "knowledge_search", arguments: '{"query":"needle-service"}' } }] }
      : { content: "隔离回归完成；现场查询与历史参考分离。" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});

await migrate(); await seed();
await new Promise<void>((resolve) => mock.listen(19091, "127.0.0.1", resolve));
const pid = crypto.randomUUID(), cid = crypto.randomUUID(), rid = crypto.randomUUID();
await db.insert(project).values({ id: pid, name: "isolated regression" });
await db.insert(customer).values({ id: cid, projectId: pid, name: "isolated customer" });
await db.insert(afterSaleRecord).values({ id: rid, customerId: cid, threadId: rid, code: `AS-TEST-${rid}`, title: "needle-service" });
await db.insert(knowledge).values({ title: "needle-service 连接排查", summary: "仅在启用时参考的历史线索", customerId: cid });
await db.update(modelConfig).set({ enabled: false, isDefault: false });
await db.insert(modelConfig).values({ modelName: "isolated-mock", baseUrl: "http://127.0.0.1:19091/v1", apiKeyEnc: encrypt("isolated-only-key"), isDefault: true, retry: 0 });
const appServer = serve({ fetch: createApp().fetch, port: 19090, hostname: process.env.UI_PREVIEW === "1" ? "0.0.0.0" : "127.0.0.1" });
const base = "http://127.0.0.1:19090";
async function api(url: string, body?: object) {
  const response = await fetch(base + url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
  if (response.status !== 200) throw new Error(`${url}: ${response.status} ${await response.text()}`); return response;
}
async function events(response: Response) {
  return (await response.text()).split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
}
const settings = (rows: any[]) => rows.filter((row) => row.type === "turn/settings").map((row) => row.data.referenceKnowledge);

try {
  assert.deepEqual(await (await api("/health")).json(), { ok: true });
  assert.match(await (await api("/")).text(), /<html/);
  const login = await api("/api/v1/auth/login", { username: config.adminUsername, password: config.adminPassword });
  token = (await login.json()).accessToken;
  const savedBeforeProbe = await (await api("/api/v1/settings/model")).json();
  const providerModels = await (await api("/api/v1/settings/model/models", { api_key: "******" })).json();
  assert.equal(providerModels.items.length, 2);
  const probe = await (await api("/api/v1/settings/model/test", { model_name: "isolated-other", api_key: "******" })).json();
  assert.equal(probe.ok, true); assert.equal(probe.model, "isolated-other"); assert.ok(probe.message);
  const quota = await (await api("/api/v1/settings/model/test", { model_name: "fixture-quota", api_key: "******" })).json();
  assert.equal(quota.ok, false); assert.match(quota.message, /额度已耗尽/); assert.equal(quota.upstreamStatus, 429);
  const network = await (await api("/api/v1/settings/model/test", { base_url: "http://127.0.0.1:1/v1", api_key: "synthetic-key", model_name: "draft" })).json();
  assert.equal(network.ok, false); assert.match(network.message, /无法连接/);
  assert.deepEqual(await (await api("/api/v1/settings/model")).json(), savedBeforeProbe);
  console.log("PASS unsaved connection probe: success, quota, network failure; stored configuration unchanged");
  const codes = await Promise.all(Array.from({ length: 40 }, () => nextDocumentCode("AS")));
  assert.equal(new Set(codes).size, 40);
  assert.ok(codes.every((code) => /^AS-\d{8}-\d{3,}$/.test(code)));
  const later = await nextDocumentCode("AS");
  assert.ok(Number(later.split("-").at(-1)) > Math.max(...codes.map((code) => Number(code.split("-").at(-1)))));
  console.log("PASS atomic daily numbering: 40 concurrent allocations, no duplicates or reuse");
  const catalog = await (await api("/api/v1/models")).json();
  assert.equal(catalog.defaultModel, "isolated-mock");
  const first = await events(await api("/api/v1/sessions", { recordId: rid, permission: "code", content: "query" }));
  assert.deepEqual(settings(first), [false]);
  assert.equal(first.some((event) => event.type === "tool/call" && event.data.name === "knowledge_search"), false);
  assert.ok(!requests[0].system.includes("【历史知识候选"));
  const [s] = await db.select().from(session).where(eq(session.recordId, rid));
  assert.equal((await (await api(`/api/v1/records/${rid}/sessions/latest`)).json()).permission, "code");
  const on = await events(await api(`/api/v1/sessions/${s.id}/followup`, { content: "needle-service with knowledge", referenceKnowledge: true }));
  assert.deepEqual(settings(on), [true]);
  assert.ok(on.some((event) => event.type === "tool/call" && event.data.name === "knowledge_search"));
  assert.ok(requests.some((request) => request.enabled && request.system.includes("【历史知识候选")));
  const off = await events(await api(`/api/v1/sessions/${s.id}/followup`, { content: "without knowledge", referenceKnowledge: false, modelName: "isolated-other" }));
  assert.deepEqual(settings(off), [false]);
  assert.ok(!requests.at(-1)!.enabled && !requests.at(-1)!.system.includes("【历史知识候选"));
  assert.equal(requests.at(-1)!.model, "isolated-other");
  const [unchanged] = await db.select().from(modelConfig).where(eq(modelConfig.isDefault, true));
  assert.equal(unchanged.modelName, "isolated-mock");
  const header = off.find((event) => event.type === "request/header");
  assert.equal(header.data.model.maxContext, 64000);
  const context = await (await api(`/api/v1/records/${rid}/context`)).json();
  assert.equal(context.maxTokens ?? context.max_tokens, 64000);
  const snapshotPage = await (await api(`/api/v1/sessions/${s.id}/artifacts/${header.data.requestArtifactId}`)).json();
  assert.ok(snapshotPage.text.includes('"modelName":"isolated-other"'));
  console.log("PASS session model isolation, catalog capability and authorized request artifact retrieval");
  console.log("PASS HTTP create/followup, default-off, tool availability, automatic context gating");

  const started = new Promise<void>((resolve) => { slowStarted = resolve; });
  const slow = await api(`/api/v1/sessions/${s.id}/followup`, { content: "slow-request", referenceKnowledge: false });
  const consuming = events(slow);
  await started;
  const queued = await (await api(`/api/v1/sessions/${s.id}/inbox`, { content: "different options", mode: "steer", referenceKnowledge: true })).json();
  assert.equal(queued.mode, "queue"); assert.equal(queued.items[0].referenceKnowledge, true);
  const itemId = queued.items[0].id;
  const edited = await (await api(`/api/v1/sessions/${s.id}/inbox/${itemId}`, { kind: "edit", content: "edited queued text" })).json();
  assert.equal(edited.items[0].referenceKnowledge, true);
  const restored = await loadSession(s.id);
  assert.equal(new Inbox(restored!.events).snapshot()[0].content, "edited queued text");
  releaseSlow!();
  const completed = await consuming;
  assert.deepEqual(settings(completed), [false, true]);
  const persisted = await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, s.id));
  assert.deepEqual(settings(persisted.sort((a, b) => a.seq - b.seq)), [false, true, false, false, true]);
  assert.equal(persisted.some((event) => event.type === "assistant/chunk"), false);
  console.log("PASS running steer conversion, queued edit snapshot, per-turn database persistence");
  const blocked = await events(await api(`/api/v1/sessions/${s.id}/followup`, { content: "fixture-blocked", referenceKnowledge: false }));
  assert.equal(blocked.find((e) => e.type === "turn/outcome")?.data.status, "blocked");
  assert.equal(blocked.find((e) => e.type === "turn/end")?.data.reason, "blocked");
  console.log("PASS explicit blocked outcome via real HTTP/SSE and durable event storage");
  await liveAgents.get(s.id)?.pump;
  const approvalStore = (await loadSession(s.id))!;
  const live = liveAgents.get(s.id)!;
  live.approvals = new ApprovalBroker(approvalStore, (event) => { for (const listener of live.waiters) listener(event); });
  const approvedResult = live.approvals.request("bash", "synthetic command; never executed", "isolated-fixture", new AbortController().signal);
  const approval = (await (await api(`/api/v1/sessions/${s.id}/approvals`)).json()).items[0];
  await api(`/api/v1/sessions/${s.id}/answer`, { approvalId: approval.id, approved: true });
  assert.equal(await approvedResult, true);
  assert.equal((await (await api(`/api/v1/sessions/${s.id}/approvals`)).json()).items.length, 0);
  console.log("PASS HTTP single-use command approval and audit persistence; no remote command executed");
  console.log(JSON.stringify({ ok: true, turns: 6, realModelCalls: 0, customerConnections: 0 }));
  if (process.env.UI_PREVIEW === "1") {
    void live.approvals.request("bash", "docker restart fixture-service", "isolated-fixture (不会连接客户服务器)", new AbortController().signal);
    console.log(`UI_PREVIEW_READY /workbench/${rid}`);
    await new Promise<void>((resolve) => process.once("SIGTERM", resolve));
  }
} finally {
  releaseSlow?.();
  await Promise.all([...liveAgents.values()].map((live) => live.pump));
  appServer.close(); mock.close(); mock.closeAllConnections();
  await sql.end();
}
