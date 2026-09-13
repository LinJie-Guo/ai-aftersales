import { describe, expect, it } from "vitest";

import { ReactLoop } from "../src/agent/loop.ts";
import { MemorySession } from "../src/agent/session.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";
import type { LlmChunk, LlmTransport, UserMessage } from "../src/agent/types.ts";

class ScriptedLlm implements LlmTransport {
  constructor(private readonly turns: LlmChunk[][]) {}
  private index = 0;
  async *stream(): AsyncIterable<LlmChunk> {
    const chunks = this.turns[this.index++] ?? [{ type: "text", text: "done" }];
    for (const chunk of chunks) yield chunk;
  }
}

function user(content: string): UserMessage {
  return { id: crypto.randomUUID(), role: "user", content, source: "human" };
}

describe("ReactLoop", () => {
  it("does not append raw tool results after a model failure", async () => {
    const session = new MemorySession("s-failed-after-tools");
    const tools = new ToolRegistry();
    tools.register({
      name: "bash", description: "test", parameters: { type: "object", properties: {} },
      async execute() { return { status: "success", summary: "RAW_LOG_SENTINEL" }; },
    });
    let calls = 0;
    const loop = new ReactLoop(session, {
      async *stream(): AsyncIterable<LlmChunk> {
        if (calls++ === 0) yield { type: "tool_call", toolCall: { id: "c1", name: "bash", argumentsText: "{}" } };
        else throw new Error("LLM 请求失败 429: rate limit exceeded");
      },
    }, tools);
    loop.followup(user("test"));
    for await (const _event of loop.run()) { /* drain */ }
    const answers = session.events.filter((event) => event.type === "assistant/message" && !((event.data.toolCalls as unknown[])?.length));
    expect(answers).toHaveLength(1);
    expect(answers[0].data.content).toContain("模型请求失败");
    expect(answers[0].data.content).not.toContain("RAW_LOG_SENTINEL");
    expect(session.events.find((event) => event.type === "tool/result")?.data.summary).toBe("RAW_LOG_SENTINEL\n[证据](#evidence-c1)");
    expect(session.events.find((event) => event.type === "turn/end")?.data.reason).toBe("failed");
  });

  it("streams a text-only turn from followup", async () => {
    const session = new MemorySession("s1");
    const tools = new ToolRegistry();
    const loop = new ReactLoop(session, new ScriptedLlm([[{ type: "text", text: "结论：服务正常" }]]), tools);
    loop.followup(user("拓扑为空"));
    const events = [];
    for await (const event of loop.run()) events.push(event);
    expect(events.map((e) => e.type)).toContain("assistant/chunk");
    expect(session.events.some((e) => e.type === "assistant/message" && String(e.data.content).includes("服务正常"))).toBe(true);
    expect(session.events.filter((e) => e.type === "turn/start")).toHaveLength(1);
  });

  it("streams reasoning before the assistant answer", async () => {
    const session = new MemorySession("s-reason");
    const loop = new ReactLoop(
      session,
      new ScriptedLlm([[
        { type: "reasoning", text: "先查知识库" },
        { type: "text", text: "建议先搜资产拓扑" },
      ]]),
      new ToolRegistry(),
    );
    loop.followup(user("知识库查询"));
    const types: string[] = [];
    for await (const event of loop.run()) types.push(event.type);
    expect(types).toContain("assistant/reasoning");
    expect(types.indexOf("assistant/reasoning")).toBeLessThan(types.indexOf("assistant/chunk"));
  });

  it("claims steer on the next step after tools", async () => {
    const session = new MemorySession("s2");
    const tools = new ToolRegistry();
    tools.register({
      name: "code_search",
      description: "search",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      async execute() {
        return { status: "success", summary: "hit MailService" };
      },
    });
    const llm = new ScriptedLlm([
      [
        {
          type: "tool_call",
          toolCall: { id: "c1", name: "code_search", argumentsText: "{\"query\":\"mail\"}" },
        },
      ],
      [{ type: "text", text: "已按你的纠正继续查" }],
    ]);
    const loop = new ReactLoop(session, llm, tools);
    loop.followup(user("查邮件"));
    const running = loop.run();
    const first = await running.next();
    expect(first.value?.type).toBe("turn/start");
    loop.steer(user("改查登录"));
    const types: string[] = [];
    for await (const event of running) types.push(event.type);
    expect(types).toContain("tool/result");
    expect(session.events.some((e) => e.type === "user/message" && e.data.content === "改查登录")).toBe(true);
  });

  it("continues after tools so the model can write a conclusion", async () => {
    const session = new MemorySession("s-conclude");
    const tools = new ToolRegistry();
    tools.register({
      name: "knowledge_search",
      description: "search",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      async execute() {
        return { status: "success", summary: "知识库现有 11 条，未命中漏洞" };
      },
    });
    const loop = new ReactLoop(session, new ScriptedLlm([
      [{ type: "tool_call", toolCall: { id: "c1", name: "knowledge_search", argumentsText: "{\"query\":\"漏洞\"}" } }],
      [{ type: "text", text: "知识库共 11 条，没有漏洞相关条目。" }],
    ]), tools);
    loop.followup({ ...user("知识库有多少漏洞"), referenceKnowledge: true });
    for await (const _event of loop.run()) { /* drain */ }
    const answers = session.events.filter((event) => event.type === "assistant/message").map((event) => String(event.data.content || ""));
    expect(answers.some((text) => text.includes("11 条"))).toBe(true);
  });

  it("reminds after three identical tool calls without blocking them", async () => {
    const session = new MemorySession("s-dupe");
    const tools = new ToolRegistry();
    let runs = 0;
    tools.register({
      name: "code_git_log",
      description: "log",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      async execute() {
        runs += 1;
        return { status: "success", summary: "4525b0c merge" };
      },
    });
    const toolTurn = (id: string) => [{
      type: "tool_call" as const,
      toolCall: { id, name: "code_git_log", argumentsText: "{\"path\":\"kb-api\",\"limit\":1}" },
    }];
    const loop = new ReactLoop(session, new ScriptedLlm([
      toolTurn("c1"),
      toolTurn("c2"),
      toolTurn("c3"),
      [{ type: "text", text: "仓库最近一次提交是 4525b0c。" }],
    ]), tools);
    loop.followup(user("现在启动了几个服务？"));
    for await (const _event of loop.run()) { /* drain */ }
    expect(runs).toBe(3);
    const denied = session.events.filter((event) => event.type === "tool/result" && event.data.status === "denied");
    expect(denied).toHaveLength(0);
    const reminders = session.events.filter((event) =>
      event.type === "user/message"
      && event.data.source === "inject"
      && String(event.data.content).includes("repeating the exact same tool call"),
    );
    expect(reminders).toHaveLength(1);
    const answers = session.events.filter((event) => event.type === "assistant/message").map((event) => String(event.data.content || ""));
    expect(answers.some((text) => text.includes("4525b0c"))).toBe(true);
  });

  it("queues followup until the current turn ends", async () => {
    const session = new MemorySession("s-queue");
    const tools = new ToolRegistry();
    tools.register({
      name: "code_search",
      description: "search",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      async execute() {
        return { status: "success", summary: "hit MailService" };
      },
    });
    const loop = new ReactLoop(session, new ScriptedLlm([
      [{ type: "tool_call", toolCall: { id: "c1", name: "code_search", argumentsText: "{\"query\":\"mail\"}" } }],
      [{ type: "text", text: "第一轮结论" }],
      [{ type: "text", text: "第二轮按排队消息回答" }],
    ]), tools);
    loop.followup(user("查邮件"));
    const running = loop.run();
    for await (const event of running) {
      if (event.type === "tool/call") loop.followup(user("再查登录"));
    }
    const users = session.events
      .filter((event) => event.type === "user/message")
      .map((event) => String(event.data.content));
    expect(users).toEqual(["查邮件", "再查登录"]);
    expect(session.events.filter((event) => event.type === "turn/start")).toHaveLength(2);
    const answers = session.events
      .filter((event) => event.type === "assistant/message")
      .map((event) => String(event.data.content || ""));
    expect(answers.some((text) => text.includes("第一轮"))).toBe(true);
    expect(answers.some((text) => text.includes("第二轮"))).toBe(true);
  });

  it("resumes an open turn left after a crash", async () => {
    const session = new MemorySession("s-resume");
    session.append("turn/start", { turn: 3 });
    session.append("step/start", { turn: 3, step: 1 });
    session.append("user/message", { id: "u3", content: "哪些在nacos中注册呢？", source: "human" });
    const loop = new ReactLoop(session, new ScriptedLlm([[{ type: "text", text: "nacos 里注册了 kb-api 和 user-new" }]]), new ToolRegistry());
    for await (const _event of loop.run()) { /* drain */ }
    expect(session.events.filter((event) => event.type === "turn/start")).toHaveLength(1);
    expect(session.events.some((event) => event.type === "llm/request")).toBe(true);
    expect(session.events.some((event) => event.type === "assistant/message" && String(event.data.content).includes("nacos"))).toBe(true);
    expect(session.events.some((event) => event.type === "turn/end")).toBe(true);
  });

  it("inject does not start a turn by itself", async () => {
    const session = new MemorySession("s3");
    const loop = new ReactLoop(session, new ScriptedLlm([]), new ToolRegistry());
    loop.inject(user("hidden"));
    expect(loop.status).toBe("idle");
    expect(session.events).toHaveLength(0);
  });

  it("surfaces an llm failure instead of ending the turn silently", async () => {
    const session = new MemorySession("s-llm-fail");
    const loop = new ReactLoop(session, {
      async *stream() {
        throw new Error("LLM 请求失败 400: tool call result does not follow tool call");
      },
    }, new ToolRegistry());
    loop.followup(user("分别是什么格式"));
    for await (const _event of loop.run()) { /* drain */ }
    const answer = session.events.find((event) => event.type === "assistant/message");
    expect(String(answer?.data.content || "")).toBe(
      "模型请求失败：上一轮工具结果没写完整（排查中途断了）。已自动补齐，请再发一次「继续」。",
    );
    expect(session.events.some((event) => event.type === "turn/end")).toBe(true);
  });
});
