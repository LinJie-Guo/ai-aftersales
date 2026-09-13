import { describe, expect, it } from "vitest";
import { MemorySession, deriveMessages } from "../src/agent/session.ts";
import { ReactLoop } from "../src/agent/loop.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";
import { finishTool } from "../src/agent/tools/finish.ts";
import { ProgressGuard } from "../src/agent/progress.ts";
import { resolveConfiguredPrompt } from "../src/agent/prompt.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../src/shared/index.ts";
import { redactEventForClient } from "../src/agent/redact.ts";

const ctx = { signal: new AbortController().signal, inject() {} };
const user = { id: "u", role: "user" as const, source: "human" as const, content: "检查当前状态" };
const call = (id: string, name: string, args: object) => ({ type: "tool_call" as const, toolCall: { id, name, argumentsText: JSON.stringify(args) } });

describe("generic outcome and progress", () => {
  it("does not mistake a plan-only reply for completion and continues once", async () => {
    const session = new MemorySession("finish"), tools = new ToolRegistry();
    tools.register({ name: "read", description: "test", parameters: {}, async execute() { return { status: "success", summary: "available evidence" }; } });
    tools.register(finishTool(session));
    let requests = 0;
    const loop = new ReactLoop(session, { async *stream(input) {
      expect(input.system).not.toMatch(/反编译|未归类|接口计数/);
      if (++requests === 1) yield call("read-1", "read", {});
      else if (requests === 2) yield { type: "text", text: "下一步我会继续检查" };
      else if (requests === 3) {
        expect(input.messages.some((m) => m.content.includes("候选答复"))).toBe(true);
        yield call("read-2", "read", {});
      } else yield call("finish-1", "finish_task", { status: "completed", summary: "已核对当前状态 [证据](#evidence-read-2)", evidenceIds: ["read-2"] });
    } }, tools);
    await loop.followup(user); for await (const _ of loop.run()) {}
    expect(requests).toBe(4);
    expect(session.events.findLast((e) => e.type === "turn/end")?.data.reason).toBe("completed");
    expect(session.events.filter((e) => e.type === "assistant/draft")).toHaveLength(1);
    expect(deriveMessages(session.events).some((m) => m.content === "下一步我会继续检查")).toBe(true);
  });
  it("marks repeated undeclared endings incomplete instead of completed", async () => {
    const session = new MemorySession("undeclared"), tools = new ToolRegistry(); tools.register(finishTool(session));
    tools.register({ name: "read", description: "test", parameters: {}, async execute() { return { status: "failed", summary: "missing input" }; } });
    let n = 0; const loop = new ReactLoop(session, { async *stream() { if (++n === 1) yield call("r", "read", {}); else yield { type: "text", text: "请给我更多信息" }; } }, tools);
    await loop.followup(user); for await (const _ of loop.run()) {}
    expect(n).toBe(3); expect(session.events.findLast((e) => e.type === "turn/end")?.data.reason).toBe("incomplete");
  });
  it("validates outcomes, failed/self evidence, and parallel termination", async () => {
    const session = new MemorySession("outcomes"), tool = finishTool(session);
    session.append("tool/result", { callId: "failure", name: "http_request", status: "failed" });
    session.append("tool/result", { callId: "ok", name: "read", status: "success", artifactId: "artifact-1" });
    expect((await tool.execute({ status: "completed", summary: "done", evidenceIds: ["artifact-1", "[证据](#evidence-ok)"] }, ctx)).completion?.evidenceIds).toEqual(["ok"]);
    // A failed request is valid evidence for diagnosing that failure, not for claiming missing data.
    expect((await tool.execute({ status: "completed", summary: "已确认请求返回认证错误", evidenceIds: ["failure"] }, ctx)).completion?.status).toBe("completed");
    expect((await tool.execute({ status: "completed", summary: "done", evidenceIds: [] }, ctx)).status).toBe("failed");
    expect((await tool.execute({ status: "completed", summary: "done", evidenceIds: ["unknown"] }, ctx)).status).toBe("failed");
    expect((await tool.execute({ status: "completed", summary: "done", evidenceIds: ["ok"], blockers: ["missing"] }, ctx)).status).toBe("failed");
    expect((await tool.execute({ status: "blocked", summary: "request failed", evidenceIds: ["failure"], blockers: ["valid credentials unavailable"] }, ctx)).completion?.status).toBe("blocked");
    expect((await tool.execute({ status: "needs_input", summary: "which target?", evidenceIds: [], blockers: ["target choice"] }, ctx)).completion?.status).toBe("needs_input");
    const registry = new ToolRegistry(); registry.register(tool); let runs = 0;
    registry.register({ name: "read", description: "test", parameters: {}, async execute() { runs++; return { status: "success", summary: "x" }; } });
    const results = await registry.executeBatch([{ id: "f", name: "finish_task", arguments: {} }, { id: "r", name: "read", arguments: {} }], ctx);
    expect(results.every((r) => r.status === "failed")).toBe(true); expect(runs).toBe(0);
  });
  it("recovers a persisted final outcome without calling the model again", async () => {
    const session = new MemorySession("settled"); session.append("turn/start", { turn: 1 }); session.append("step/start", { turn: 1, step: 1 });
    session.append("tool/result", { turn: 1, status: "success", completion: { status: "blocked", summary: "service unavailable", evidenceIds: [], blockers: ["network"] } });
    const loop = new ReactLoop(session, { async *stream() { throw new Error("must not call"); } }, new ToolRegistry());
    for await (const _ of loop.run()) {}
    expect(session.events.findLast((e) => e.type === "turn/end")?.data.reason).toBe("blocked");
  });
  it("retains tool use and finalization reminder across a process restart", async () => {
    const session = new MemorySession("resumed-draft");
    session.append("turn/start", { turn: 1 }); session.append("step/start", { turn: 1, step: 1 });
    session.append("tool/call", { turn: 1, callId: "old", name: "read" });
    session.append("assistant/draft", { turn: 1, content: "候选答复" });
    session.append("step/end", { turn: 1, step: 1 });
    const tools = new ToolRegistry(); tools.register(finishTool(session)); let requests = 0;
    const loop = new ReactLoop(session, { async *stream() { requests++; yield { type: "text", text: "仍然没有声明" }; } }, tools);
    for await (const _ of loop.run()) {}
    expect(requests).toBe(1);
    expect(session.events.findLast((e) => e.type === "turn/end")?.data.reason).toBe("incomplete");
  });
  it("distinguishes authentication targets, methods and credentials", () => {
    const guard = new ProgressGuard();
    for (let i = 0; i < 10; i++) expect(guard.note([{ status: "failed", summary: "403", data: { failureKind: "authentication", target: `host-${i}`, operation: "GET /config", authScope: "a" } }], [{ id: `${i}`, name: "http_request", arguments: {} }])).toEqual({});
    const result = (authScope: string, operation: string) => [{ status: "failed" as const, summary: "403", data: { failureKind: "authentication", target: "same", operation, authScope } }];
    for (const [auth, method] of [["a", "GET"], ["b", "GET"], ["b", "POST"]]) expect(guard.note(result(auth, method))).toEqual({});
    let last = {}; for (let i = 0; i < 6; i++) last = guard.note(result("b", "POST"));
    expect(last).toEqual({ stop: true });
  });
  it("preserves reference objects under sensitive field names in replay", () => {
    const ref = `cred_${crypto.randomUUID()}`;
    expect(redactEventForClient({ form: { password: { secretRef: ref } }, headers: { authorization: { secretRef: ref, prefix: "Bearer " } }, password: "plaintext" })).toEqual({ form: { password: { secretRef: ref } }, headers: { authorization: { secretRef: ref, prefix: "Bearer " } }, password: "[REDACTED]" });
    expect(resolveConfiguredPrompt("custom instructions")).toBe("custom instructions");
    expect(resolveConfiguredPrompt(null)).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});
