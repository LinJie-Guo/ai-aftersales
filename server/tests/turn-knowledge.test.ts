import { describe, expect, it, vi } from "vitest";
import { ReactLoop } from "../src/agent/loop.ts";
import { MemorySession, deriveMessages } from "../src/agent/session.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";
import type { UserMessage } from "../src/agent/types.ts";

const user = (referenceKnowledge = false): UserMessage => ({ id: crypto.randomUUID(), role: "user", source: "human", content: "核对现场数量", referenceKnowledge });
async function drain(loop: ReactLoop) { for await (const _ of loop.run()) { /* drain */ } }

describe("per-turn knowledge choice", () => {
  it("defaults off, hides the schema and refuses a hallucinated knowledge call", async () => {
    const search = vi.fn(async () => ({ status: "success" as const, summary: "history" }));
    const tools = new ToolRegistry(); tools.register({ name: "knowledge_search", description: "knowledge", parameters: {}, execute: search });
    const session = new MemorySession("off"); let requests = 0;
    const extra = vi.fn(() => "现场上下文");
    const loop = new ReactLoop(session, { async *stream(input) {
      expect(input.tools.some((tool) => tool.name === "knowledge_search")).toBe(false);
      expect(input.system).toContain("用户未勾选");
      if (requests++ === 0) yield { type: "tool_call", toolCall: { id: "k", name: "knowledge_search", argumentsText: "{}" } };
      else yield { type: "text", text: "转查现场" };
    } }, tools, { assembleExtraPrompt: extra });
    loop.followup(user()); await drain(loop);
    expect(search).not.toHaveBeenCalled();
    expect(extra).toHaveBeenCalledWith({ referenceKnowledge: false, query: "核对现场数量" });
    expect(session.events.find((event) => event.type === "tool/result")?.data.status).toBe("failed");
  });

  it("retains distinct choices on queued turns", async () => {
    const tools = new ToolRegistry(); tools.register({ name: "knowledge_search", description: "knowledge", parameters: {}, async execute() { return { status: "success", summary: "history" }; } });
    const session = new MemorySession("queue"); const choices: boolean[] = [];
    const loop = new ReactLoop(session, { async *stream(input) { choices.push(input.tools.some((tool) => tool.name === "knowledge_search")); yield { type: "text", text: "done" }; } }, tools);
    loop.followup(user(true)); loop.followup(user(false)); await drain(loop);
    expect(choices).toEqual([true, false]);
    expect(session.events.filter((event) => event.type === "turn/settings").map((event) => event.data.referenceKnowledge)).toEqual([true, false]);
    expect(deriveMessages(session.events).filter((message) => message.role === "user").map((message) => message.referenceKnowledge)).toEqual([true, false]);
  });

  it("restores an interrupted turn's persisted choice", async () => {
    const session = new MemorySession("resume");
    session.append("turn/start", { turn: 2 }); session.append("turn/settings", { turn: 2, referenceKnowledge: true });
    session.append("step/start", { turn: 2, step: 1 }); session.append("user/message", user(true));
    const tools = new ToolRegistry(); tools.register({ name: "knowledge_search", description: "knowledge", parameters: {}, async execute() { return { status: "success", summary: "history" }; } });
    const loop = new ReactLoop(session, { async *stream(input) { expect(input.tools.some((tool) => tool.name === "knowledge_search")).toBe(true); yield { type: "text", text: "done" }; } }, tools);
    await drain(loop);
    expect(session.events.filter((event) => event.type === "turn/settings")).toHaveLength(1);
  });

  it("queues a differently configured steer without changing active tools", async () => {
    const session = new MemorySession("steer"); const choices: boolean[] = [];
    const tools = new ToolRegistry(); tools.register({ name: "knowledge_search", description: "knowledge", parameters: {}, async execute() { return { status: "success", summary: "history" }; } });
    const loop = new ReactLoop(session, { async *stream(input) {
      choices.push(input.tools.some((tool) => tool.name === "knowledge_search"));
      if (choices.length === 1) loop.steer({ ...user(false), source: "steer" });
      yield { type: "text", text: "done" };
    } }, tools);
    loop.followup(user(true)); await drain(loop);
    expect(choices).toEqual([true, false]);
  });
});
