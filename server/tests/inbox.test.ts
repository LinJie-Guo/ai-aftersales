import { describe, expect, it } from "vitest";

import { Inbox } from "../src/agent/inbox.ts";
import { ReactLoop } from "../src/agent/loop.ts";
import { MemorySession } from "../src/agent/session.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";
import type { LlmChunk, LlmTransport, UserMessage } from "../src/agent/types.ts";

function user(content: string, source: UserMessage["source"] = "human"): UserMessage {
  return { id: crypto.randomUUID(), role: "user", content, source };
}

class ScriptedLlm implements LlmTransport {
  constructor(private readonly turns: LlmChunk[][]) {}
  private index = 0;
  async *stream(): AsyncIterable<LlmChunk> {
    const chunks = this.turns[this.index++] ?? [{ type: "text", text: "done" }];
    for (const chunk of chunks) yield chunk;
  }
}

describe("Inbox", () => {
  it("claims one queued prompt per turn plus pending steering", () => {
    const inbox = new Inbox();
    const first = user("第一问");
    const second = user("第二问");
    const steer = user("插话", "steer");
    inbox.splice("next-turn", 0, 0, [first, second]);
    inbox.splice("next-step", 0, 0, [steer]);
    expect(inbox.claim("next-turn").map((item) => item.content)).toEqual(["插话", "第一问"]);
    expect(inbox.claim("next-turn").map((item) => item.content)).toEqual(["第二问"]);
    expect(inbox.hasPending).toBe(false);
  });

  it("edits, removes, and snapshots queued rows", () => {
    const inbox = new Inbox();
    const message = user("原文本");
    inbox.splice("next-turn", 0, 0, [message]);
    expect(inbox.replace(message.id, { ...message, content: "改过了" })).toBe(true);
    expect(inbox.snapshot()).toEqual([
      expect.objectContaining({ id: message.id, content: "改过了", placement: "queued" }),
    ]);
    expect(inbox.remove(message.id)).toBe(true);
    expect(inbox.snapshot()).toEqual([]);
  });

  it("previews attachment-only queued rows", () => {
    const inbox = new Inbox();
    inbox.splice("next-turn", 0, 0, [{
      id: "u-att",
      role: "user",
      content: "",
      source: "human",
      attachments: [{ fileName: "error.log", storedName: "x-error.log", mimeType: "text/plain" }],
    }]);
    expect(inbox.snapshot()[0]?.preview).toContain("error.log");
  });
});

describe("ReactLoop.updateQueue", () => {
  it("steers a queued row into the current turn", async () => {
    const session = new MemorySession("s-steer-row");
    const tools = new ToolRegistry();
    tools.register({
      name: "code_search",
      description: "search",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      async execute() {
        return { status: "success", summary: "hit" };
      },
    });
    const loop = new ReactLoop(session, new ScriptedLlm([
      [{ type: "tool_call", toolCall: { id: "c1", name: "code_search", argumentsText: "{\"query\":\"a\"}" } }],
      [{ type: "text", text: "按插话继续" }],
    ]), tools);
    loop.followup(user("先查"));
    const running = loop.run();
    for await (const event of running) {
      if (event.type === "tool/call") {
        await loop.followup(user("排队问"));
        const queued = loop.inboxSnapshot().find((row) => row.placement === "queued");
        expect(queued).toBeTruthy();
        expect(await loop.updateQueue(queued!.id, { kind: "steer" })).toEqual({ ok: true });
        expect(session.events.some((event) => event.type === "user/message" && event.data.content === "排队问")).toBe(true);
      }
    }
    expect(session.events.filter((event) => event.type === "user/message" && event.data.content === "排队问")).toHaveLength(1);
  });
});
