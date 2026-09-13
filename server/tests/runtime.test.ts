import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalBroker } from "../src/agent/approvals.ts";
import { MemorySession, deriveMessages } from "../src/agent/session.ts";
import { Inbox } from "../src/agent/inbox.ts";
import { ReactLoop } from "../src/agent/loop.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";
import { ArtifactStore } from "../src/agent/tools/artifacts.ts";
import { createRemoteReadTools, remoteReadCommand, esReadRequest } from "../src/agent/tools/remote-read.ts";
import { createSshEnvTools } from "../src/agent/tools/ssh.ts";
import { compactContext, contextSize } from "../src/agent/context.ts";
import { modelSnapshot } from "../src/agent/models.ts";
import { businessDay } from "../src/db/numbering.ts";
import { CredentialVault } from "../src/agent/credentials.ts";
import { StreamingRedactor, registerSecret } from "../src/agent/redact.ts";
import { investigationTool } from "../src/agent/tools/investigation.ts";
import type { ChatMessage, UserMessage } from "../src/agent/types.ts";
import type { SessionEvent } from "../src/shared/index.ts";

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function artifacts() { const dir = await mkdtemp(path.join(os.tmpdir(), "aftersale-runtime-test-")); dirs.push(dir); return { dir, store: new ArtifactStore(dir) }; }
const user = (id = "u", modelName = "model-a"): UserMessage => ({ id, role: "user", source: "human", content: `问题 ${id}`, modelName, referenceKnowledge: id === "b" });
const ctx = () => ({ signal: new AbortController().signal, inject() {} });
async function drain(loop: ReactLoop) { for await (const _ of loop.run()) {} }

describe("durable conversation settings and inbox", () => {
  it("recovers edited queue rows and independent model/knowledge snapshots", async () => {
    const session = new MemorySession("durable");
    const first = new ReactLoop(session, { async *stream() {} }, new ToolRegistry());
    await first.followup(user("a")); await first.followup(user("b", "model-b")); await first.followup(user("c"));
    await first.updateQueue("a", { kind: "edit", content: "只查 ES，不走业务接口" });
    await first.updateQueue("c", { kind: "remove" });
    expect(new Inbox(session.events).snapshot().map((r) => [r.id, r.content, r.modelName, r.referenceKnowledge])).toEqual([["a", "只查 ES，不走业务接口", "model-a", false], ["b", "问题 b", "model-b", true]]);
    const configured: string[] = [];
    const restored = new ReactLoop(session, { async *stream() { yield { type: "text", text: "done" }; } }, new ToolRegistry(), { configureTurn: async ({ modelName }) => { configured.push(modelName!); return { modelName }; } });
    await drain(restored);
    expect(configured).toEqual(["model-a", "model-b"]);
    expect(new Inbox(session.events).snapshot()).toEqual([]);
    expect(session.events.filter((e) => e.type === "user/message")).toHaveLength(2);
  });
  it("recovers a committed claim if process died before recording its user message", async () => {
    const session = new MemorySession("claim-crash");
    session.append("turn/start", { turn: 1 }); session.append("step/start", { turn: 1, step: 1 });
    session.append("inbox/claim", { turn: 1, step: 1, ids: ["a"], messages: [user("a")] });
    const loop = new ReactLoop(session, { async *stream(input) { expect(input.messages.some((m) => m.role === "user" && m.id === "a")).toBe(true); yield { type: "text", text: "恢复完成" }; } }, new ToolRegistry());
    await drain(loop); await drain(loop);
    expect(session.events.filter((e) => e.type === "user/message")).toHaveLength(1);
  });
  it("does not persist token deltas but replays complete reasoning and answer", async () => {
    const session = new MemorySession("transient"), transient: SessionEvent[] = [];
    const loop = new ReactLoop(session, { async *stream() { for (let i = 0; i < 80; i++) yield { type: "reasoning", text: "检查证据。" }; yield { type: "text", text: "结论 42" }; } }, new ToolRegistry(), { onTransient: (e) => { transient.push(e); } });
    await loop.followup(user()); await drain(loop);
    expect(transient.length).toBeGreaterThan(0);
    expect(session.events.some((e) => e.type === "assistant/chunk" || e.type === "assistant/reasoning")).toBe(false);
    expect(session.events.find((e) => e.type === "assistant/reasoning-complete")?.data.text).toBe("检查证据。".repeat(80));
    expect(deriveMessages(session.events).at(-1)?.content).toBe("结论 42");
  });
  it("never inherits image capability or capacity from a different selected model", () => {
    const row = { id: "config", modelName: "vision-a", maxContext: 999999, capabilities: { image_input: true } } as any;
    expect(modelSnapshot(row).imageInput).toBe(true);
    expect(modelSnapshot(row, "text-b")).toEqual({ configId: "config", modelName: "text-b", maxContext: 128000 });
    expect(modelSnapshot(row, "text-b", [{ id: "text-b", name: "B", imageInput: false, contextWindow: 64000 }])).toMatchObject({ imageInput: false, maxContext: 64000 });
    expect(row.modelName).toBe("vision-a");
  });
  it("serializes queued edits with claims and recovers from a rejected persistence write", async () => {
    const session = new MemorySession("queue-order");
    const loop = new ReactLoop(session, { async *stream() { yield { type: "text", text: "done" }; } }, new ToolRegistry());
    await loop.followup(user("a"));
    const edit = loop.updateQueue("a", { kind: "edit", content: "new instruction" });
    const running = drain(loop);
    expect(await edit).toEqual({ ok: true }); await running;
    expect(session.events.find((e) => e.type === "user/message")?.data.content).toBe("new instruction");
    const original = session.append.bind(session);
    session.append = () => { throw new Error("fixture write failure"); };
    await expect(loop.followup(user("b"))).rejects.toThrow("fixture write failure");
    session.append = original;
    await loop.followup(user("c"));
    expect(loop.inboxSnapshot().map((r) => r.id)).toEqual(["c"]);
  });
});

describe("single-use exact-command approval", () => {
  it("waits, commits approval, then releases only the selected request", async () => {
    const session = new MemorySession("approval"), broker = new ApprovalBroker(session, () => {});
    const result = broker.request("bash", "touch /tmp/fixture", "test@fixture:22", new AbortController().signal);
    const request = broker.list()[0];
    expect(request.command).toBe("touch /tmp/fixture"); expect(request.digest).toHaveLength(64);
    expect(await broker.answer(request.id, true, "test-user")).toBe(true);
    expect(await result).toBe(true);
    expect(await broker.answer(request.id, true, "test-user")).toBe(false);
    expect(session.events.at(-1)?.data.actor).toBe("test-user");
  });
  it("cancels waiting approvals and invalidates old approvals on restart", async () => {
    const session = new MemorySession("approval-abort"), controller = new AbortController();
    const broker = new ApprovalBroker(session, () => {});
    const result = broker.request("bash", "fixture", "fixture", controller.signal); controller.abort();
    expect(await result).toBe(false); expect(broker.list()).toEqual([]);
    session.append("approval/request", { id: "orphan" });
    await new ApprovalBroker(session, () => {}).recover();
    expect(session.events.at(-1)).toMatchObject({ type: "approval/resolved", data: { id: "orphan", approved: false } });
  });
  it("does not execute arbitrary SSH commands without explicit approval", async () => {
    const { store } = await artifacts(), run = vi.fn();
    const [bash] = createSshEnvTools({ target: { host: "fixture", port: 22, username: "test" }, customerId: "fixture", artifacts: store, run });
    expect((await bash.execute({ command: "echo read-only-looking" }, ctx())).status).toBe("denied");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("safe direct ES and remote reads", () => {
  it("rejects operation/path/index injection and scripting", () => {
    expect(() => remoteReadCommand({ operation: "read", path: "/tmp/../etc/passwd" })).toThrow();
    expect(() => remoteReadCommand({ operation: "delete", path: "/tmp/a" })).toThrow();
    expect(() => remoteReadCommand({ operation: "read", path: "/proc/1/mem" })).toThrow();
    expect(() => remoteReadCommand({ operation: "logs", container: "app;touch /tmp/x" })).toThrow();
    expect(remoteReadCommand({ operation: "search", path: "/tmp/a", pattern: "'; touch /tmp/no; '" })).toContain("grep -R -n -F");
    expect(() => esReadRequest({ baseUrl: "http://fixture:9200/_delete_by_query" })).toThrow();
    expect(() => esReadRequest({ baseUrl: "http://fixture:9200", index: "vuln/_delete_by_query" })).toThrow();
    expect(() => esReadRequest({ baseUrl: "http://fixture:9200", query: { bool: { filter: { script: {} } } } })).toThrow();
    expect(esReadRequest({ baseUrl: "http://fixture:9200", index: "vuln-*", query: { term: { deleted: false } } })).toMatchObject({ body: { query: { term: { deleted: false } } } });
  });
  it("carries encrypted credential references into the direct query and hides plaintext", async () => {
    const { dir, store } = await artifacts();
    const secret = "quoted fixture # pass";
    const safe = await store.protect(`ES_PASSWORD="${secret}"`), ref = safe.match(/cred_[\w-]+/)![0];
    const restored = new ArtifactStore(dir); await restored.ready();
    expect(restored.credentials.bind([{ variable: "CRED_ES", ref }])[0].value).toBe(secret);
    expect(await readFile(path.join(dir, "credentials.enc"), "utf8")).not.toContain(secret);
    let command = "";
    const [, es] = createRemoteReadTools({ target: { host: "fixture", port: 22, username: "test" }, artifacts: restored, run: async (_target, text) => { command = text; return { output: '{"count":42}', exitCode: 0 }; } });
    const result = await es.execute({ baseUrl: "http://127.0.0.1:9200", operation: "count", index: "vulnerabilities", username: "elastic", passwordRef: ref }, ctx());
    expect(command).toContain("--request GET"); expect(command).toContain("/_count");
    expect(result.status).toBe("success"); expect(result.summary).toContain('"count":42');
    expect(JSON.stringify(result)).not.toContain(secret);
    const denied = await es.execute({ baseUrl: "https://external.example.com", operation: "count" }, ctx());
    expect(denied.status).toBe("denied");
  });
  it("preserves hash characters inside quotes and short-secret number boundaries", () => {
    const vault = new CredentialVault();
    const safe = vault.capture('password="ab # cd"');
    expect(vault.bind([{ variable: "CRED_ES", ref: safe.match(/cred_[\w-]+/)![0] }])[0].value).toBe("ab # cd");
    vault.capture("password: 123"); expect(vault.capture("数量 1234")).toContain("1234");
  });
});

describe("structured checkpoints and progress visibility", () => {
  it("summarizes old complete turns and preserves current instructions and tool pairs", async () => {
    const { store } = await artifacts();
    const history: ChatMessage[] = [user("old"), { role: "assistant", content: "历史分析".repeat(3000) }, { role: "assistant", content: "", toolCalls: [{ id: "c", name: "read", arguments: {} }] }, { role: "tool", toolCallId: "c", name: "read", content: "旧证据" }, user("latest")];
    const summary = vi.fn(async () => "## 用户目标与最新修正\n只查 ES\n## 已验证事实与证据引用\n[证据](#evidence-c)\n## 下一步\n核对过滤条件");
    const result = await compactContext(history, 2000, store, summary);
    expect(summary).toHaveBeenCalled(); expect(contextSize(result.messages)).toBeLessThanOrEqual(2000);
    expect(result.messages.at(-1)).toMatchObject({ id: "latest" });
    expect(history).toHaveLength(5); expect(result.messages[0].content).toContain("只查 ES");
  });
  it("does not silently discard current image input when it cannot fit", async () => {
    const { store } = await artifacts();
    await expect(compactContext([{ ...user(), images: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" }] }], 500, store)).rejects.toThrow(/图片/);
  });
  it("rejects facts without existing successful evidence", async () => {
    const session = new MemorySession("facts"), tool = investigationTool(session);
    const state = { goal: "统计数量", facts: [{ claim: "数量42", evidenceIds: ["c1"] }], nextStep: "核对" };
    expect((await tool.execute(state, ctx())).status).toBe("failed");
    session.append("tool/result", { callId: "c1", name: "es_query", status: "success" });
    expect((await tool.execute(state, ctx())).sessionEvents?.[0].type).toBe("investigation/state");
    session.append("tool/result", { callId: "failed-call", name: "es_query", status: "failed" });
    const failure = await tool.execute({ ...state, facts: [{ claim: "认证请求失败", evidenceIds: ["failed-call"] }] }, ctx());
    expect((failure.sessionEvents?.[0].data.facts as any[])[0].evidenceStatuses).toEqual(["failed"]);
  });
  it("streams long paragraphs before a newline without leaking split credentials", () => {
    const redactor = new StreamingRedactor();
    expect(redactor.push("普通分析。".repeat(50)).length).toBeGreaterThan(0);
    const secret = registerSecret("fixture-stream-secret-123456");
    let output = "";
    for (const char of `password="${secret}"\n${"继续分析。".repeat(80)}`) output += redactor.push(char);
    output += redactor.push("", true);
    expect(output).not.toContain(secret); expect(output).toContain("[REDACTED]");
  });
  it("uses the Shanghai business day across the UTC boundary", () => {
    expect(businessDay(new Date("2026-09-05T16:01:00Z"))).toBe("20260906");
    expect(businessDay(new Date("2026-09-05T15:59:00Z"))).toBe("20260905");
  });
});
