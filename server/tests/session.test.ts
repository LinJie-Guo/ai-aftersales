import { describe, expect, it } from "vitest";

import { conclusionFromTools, deriveMessages, foldPlanMode, MemorySession, openTurn } from "../src/agent/session.ts";

describe("session log", () => {
  it("rebuilds model history from events only", () => {
    const session = new MemorySession("s");
    session.append("user/message", { id: "u1", content: "hi", source: "human" });
    session.append("assistant/message", { content: "ok", toolCalls: [] });
    const messages = deriveMessages(session.events);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "hi" });
  });

  it("keeps attachment refs on user history", () => {
    const session = new MemorySession("s-att");
    session.append("user/message", {
      id: "u1",
      content: "看日志",
      source: "human",
      attachments: [{
        fileName: "app.log",
        storedName: "cccccccc-cccc-cccc-cccc-cccccccccccc-app.log",
        mimeType: "text/plain",
        viewUrl: "/api/v1/files/cccccccc-cccc-cccc-cccc-cccccccccccc-app.log",
      }],
    });
    const [user] = deriveMessages(session.events);
    expect(user).toMatchObject({
      role: "user",
      attachments: [expect.objectContaining({ fileName: "app.log" })],
    });
  });

  it("summarizes tool results when the model writes no conclusion", () => {
    const session = new MemorySession("s");
    session.append("turn/start", { turn: 3 });
    session.append("tool/result", { turn: 3, name: "bash", summary: "count 18：kb-api、customer-api" });
    expect(conclusionFromTools(session.events, 3)).toContain("已收到 1 项工具结果");
    expect(conclusionFromTools(session.events, 3)).not.toContain("kb-api");
    expect(conclusionFromTools(session.events, 4)).toContain("已收到 0 项工具结果");
  });

  it("detects a turn left open after process restart", () => {
    const session = new MemorySession("s");
    session.append("turn/start", { turn: 3 });
    session.append("step/start", { turn: 3, step: 1 });
    session.append("user/message", { id: "u2", content: "哪些在nacos中注册呢？", source: "human" });
    expect(openTurn(session.events)).toEqual({ turn: 3, step: 1, afterStep: false });
    session.append("turn/end", { turn: 3, reason: "completed" });
    expect(openTurn(session.events)).toBeNull();
  });

  it("keeps tool results immediately after their calls when a steer is logged mid-batch", () => {
    const session = new MemorySession("s-steer");
    session.append("user/message", { id: "u1", content: "看看我们导出项目报告有几个类型", source: "human" });
    session.append("assistant/message", {
      content: "先在代码里找",
      toolCalls: [
        { id: "c1", name: "bash", arguments: { command: "echo ok" } },
        { id: "c2", name: "grep", arguments: { pattern: "ReportType" } },
      ],
    });
    session.append("user/message", { id: "u2", content: "分别是什么格式", source: "steer" });
    session.append("tool/result", { callId: "c1", name: "bash", summary: "SSH 失败" });
    session.append("tool/result", { callId: "c2", name: "grep", summary: "path 不在代码目录" });
    const roles = deriveMessages(session.events).map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "user"]);
    const last = deriveMessages(session.events).at(-1);
    expect(last).toMatchObject({ role: "user", content: "分别是什么格式" });
  });

  it("fills in missing tool results so a crashed batch can be sent again", () => {
    const session = new MemorySession("s-gap");
    session.append("user/message", { id: "u1", content: "查一下", source: "human" });
    session.append("assistant/message", {
      content: "",
      toolCalls: [
        { id: "c1", name: "bash", arguments: { command: "echo 1" } },
        { id: "c2", name: "bash", arguments: { command: "echo 2" } },
      ],
    });
    session.append("tool/result", { callId: "c1", name: "bash", summary: "1" });
    session.append("user/message", { id: "u2", content: "继续", source: "human" });
    const messages = deriveMessages(session.events);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(messages[3]).toMatchObject({
      role: "tool",
      toolCallId: "c2",
      content: expect.stringContaining("未写入"),
    });
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "继续" });
  });

  it("closes leftover tool calls before a later assistant error message", () => {
    const session = new MemorySession("s-err");
    session.append("assistant/message", {
      content: "",
      toolCalls: [{ id: "c1", name: "bash", arguments: {} }],
    });
    session.append("assistant/message", { content: "模型请求失败：上一轮工具结果没写完整", toolCalls: [] });
    const messages = deriveMessages(session.events);
    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
  });

  it("folds plan mode from the log", () => {
    const session = new MemorySession("s");
    session.append("plan/mode", { active: true });
    session.append("plan/mode", { active: false });
    expect(foldPlanMode(session.events)).toBe(false);
  });
});
