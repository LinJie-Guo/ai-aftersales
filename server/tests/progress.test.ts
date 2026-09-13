import { describe, expect, it } from "vitest";
import { ProgressGuard } from "../src/agent/progress.ts";
import { ReactLoop } from "../src/agent/loop.ts";
import { MemorySession } from "../src/agent/session.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";
import { knowledgeKeys, knowledgeScore } from "../src/knowledge/ranking.ts";

describe("progress and relevance", () => {
  it("detects alternating old evidence without blocking distinct failed paths", () => {
    const guard = new ProgressGuard();
    for (let i = 0; i < 30; i++) expect(guard.note([{ status: "failed", summary: `different failure ${i}` }])).toEqual({});
    let result = {};
    for (let i = 0; i < 8; i++) result = guard.note([{ status: "success", summary: i % 2 ? "old A" : "old B" }]);
    expect(result).toEqual({ stop: true });
  });
  it("warns then stops repeated failure regardless of changed commands", async () => {
    const session = new MemorySession("no-progress"), tools = new ToolRegistry(); let requests = 0;
    tools.register({ name: "bash", description: "test", parameters: {}, async execute() { return { status: "failed", summary: "authentication required" }; } });
    const loop = new ReactLoop(session, { async *stream() {
      const step = ++requests;
      yield { type: "tool_call", toolCall: { id: `c${step}`, name: "bash", argumentsText: JSON.stringify({ command: `different-attempt-${step}` }) } };
    } }, tools);
    loop.followup({ id: "u", role: "user", source: "human", content: "查现场" });
    for await (const _ of loop.run()) { /* drain */ }
    expect(requests).toBe(6);
    expect(session.events.some((event) => event.type === "user/message" && String(event.data.content).includes("连续多步"))).toBe(true);
    expect(session.events.find((event) => event.type === "turn/end")?.data.reason).toBe("blocked");
    expect(session.events.filter((event) => event.type === "turn/start")).toHaveLength(1);
    expect(loop.inbox.hasPending).toBe(false);
  });
  it("does not cap complex investigations that keep finding new evidence", () => {
    const guard = new ProgressGuard();
    for (let step = 0; step < 50; step++) expect(guard.note([{ status: "success", summary: `new evidence ${step}` }])).toEqual({});
    for (let step = 0; step < 3; step++) guard.note([{ status: "failed", summary: "not found" }]);
    expect(guard.note([{ status: "success", summary: "located config" }])).toEqual({});
    expect(guard.note([{ status: "failed", summary: "not found" }])).toEqual({});
  });
  it("ignores changing artifact IDs when detecting identical outputs", () => {
    const guard = new ProgressGuard(); let last = {};
    for (let step = 0; step < 7; step++) last = guard.note([{ status: "success", summary: `same result\n[Artifact ${crypto.randomUUID()}，可用 artifact_read 分页读取]` }]);
    expect(last).toEqual({ stop: true });
  });
  it("does not retrieve on generic words or one incidental transcript match", () => {
    expect(knowledgeKeys("知识库 查询 统计")).toEqual([]);
    expect(knowledgeKeys("知识库 漏洞数 统计")).toEqual(["漏洞数"]);
    expect(knowledgeScore(["漏洞数"], "报告生成", "调整超时", "历史中提到漏洞数统计")).toBe(0);
    expect(knowledgeScore(["漏洞数"], "漏洞数核对", "ES 实时计数", "查询 ES")).toBeGreaterThan(0);
    expect(knowledgeScore(["marker-regression-123"], "fixture", "fixture", "仅正文命中 marker-regression-123")).toBeGreaterThan(0);
  });
});
