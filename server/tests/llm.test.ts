import { describe, expect, it } from "vitest";

import { buildChatCompletionBody, chatHasImages, cleanToolName, collectTurn, consumeOpenAISseText, extractReasoning, formatLlmError, isImageUnsupportedError, messagesWithoutImages, parseOpenAISseLine, parseUsage, takeDelta } from "../src/agent/llm.ts";

describe("reasoning stream", () => {
  it("does not concatenate the same reasoning field twice", () => {
    expect(extractReasoning({
      reasoning: "The user is asking",
      reasoning_content: "The user is asking",
    })).toBe("The user is asking");
  });

  it("only appends new suffix when provider sends snapshots", () => {
    let acc = "";
    const first = takeDelta("The", acc);
    acc = first.acc;
    const second = takeDelta("The user", acc);
    expect(second.delta).toBe(" user");
    expect(second.acc).toBe("The user");
  });

  it("strips leaked xml from tool names", () => {
    expect(cleanToolName("ask_user</tool_call>")).toBe("ask_user");
  });

  it("does not force OpenRouter reasoning when tools are present", () => {
    const body = buildChatCompletionBody({
      model: "stealth/ox-alpha",
      system: "sys",
      messages: [{ role: "user", content: "call glob" }],
      tools: [{ name: "glob", description: "list files", parameters: { type: "object", properties: {} } }],
    });
    expect(body.reasoning).toBeUndefined();
    expect(body.include_reasoning).toBeUndefined();
    expect(body.tools).toHaveLength(1);
  });

  it("keeps a final data line that has no trailing newline", () => {
    const raw = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "glob", arguments: JSON.stringify({ pattern: "*" }) } }] } }],
    })}`;
    const collected = collectTurn(consumeOpenAISseText(raw));
    expect(collected.toolCalls.map((item) => item.name)).toEqual(["glob"]);
    expect(collected.toolCalls[0]?.arguments).toEqual({ pattern: "*" });
  });

  it("flags OpenRouter network_error finish", () => {
    const state = { tools: new Map<number, { id: string; name: string; argumentsText: string }>(), reasoningAcc: "", contentAcc: "" };
    [...parseOpenAISseLine(`data: ${JSON.stringify({
      choices: [{ delta: { content: "" }, finish_reason: "stop", native_finish_reason: "network_error" }],
    })}`, state)];
    expect(state.networkError).toBe(true);
  });

  it("asks OpenRouter for usage so cache hits can be recorded", () => {
    const body = buildChatCompletionBody({
      model: "stealth/ox-alpha",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("reads cached_tokens from a usage-only SSE line", () => {
    const usage = parseUsage({
      usage: {
        prompt_tokens: 18000,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 10620 },
      },
    });
    expect(usage).toEqual({ promptTokens: 18000, completionTokens: 40, cachedTokens: 10620 });
    const collected = collectTurn(consumeOpenAISseText(`data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 18000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 10620 } },
    })}`));
    expect(collected.usage?.cachedTokens).toBe(10620);
  });

  it("reads tool calls from a non-delta message chunk", () => {
    const raw = `data: ${JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) } }] } }],
    })}`;
    const collected = collectTurn(consumeOpenAISseText(raw));
    expect(collected.toolCalls.map((item) => item.name)).toEqual(["bash"]);
  });

  it("turns nested provider 400s into a short Chinese message", () => {
    const raw = 'LLM 请求失败 400: {"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"invalid params, tool call and result not match (2013)\\"}}"}}}';
    expect(formatLlmError(new Error(raw))).toContain("工具结果没写完整");
    expect(formatLlmError(new Error("LLM 请求失败 429: rate limit"))).toContain("限流");
    expect(formatLlmError(new Error("LLM 请求失败 404: No endpoints found that support image input"))).toContain("不支持看图");
  });

  it("strips images so a text-only model can be retried", () => {
    const stripped = messagesWithoutImages([
      { id: "u1", role: "user", content: "看这张图", source: "human", images: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,xx" }] },
    ]);
    expect(chatHasImages(stripped)).toBe(false);
    expect(stripped[0]).toMatchObject({ role: "user", content: expect.stringContaining("不支持看图") });
    expect(isImageUnsupportedError(new Error("No endpoints found that support image input"))).toBe(true);
  });
});
