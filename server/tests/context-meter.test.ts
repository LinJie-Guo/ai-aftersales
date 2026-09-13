import { describe, expect, it } from "vitest";

import { estimateTokens, foldCacheUsage, measureContextBreakdown } from "../src/agent/context-meter.ts";

describe("context meter", () => {
  it("counts CJK heavier than latin", () => {
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("splits system, tools, and messages", () => {
    const breakdown = measureContextBreakdown({
      system: "你是排查助手",
      tools: [{ name: "grep", description: "search", parameters: { type: "object", properties: {} } }],
      messages: [{ id: "u1", role: "user", content: "查询漏洞", source: "human" }],
    });
    expect(breakdown.systemTokens).toBeGreaterThan(0);
    expect(breakdown.toolsTokens).toBeGreaterThan(0);
    expect(breakdown.messageTokens).toBeGreaterThan(0);
    expect(breakdown.usedTokens).toBe(
      breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens,
    );
  });

  it("folds cache hit across llm/usage events", () => {
    const cache = foldCacheUsage([
      { seq: 1, type: "llm/usage", data: { promptTokens: 100, cachedTokens: 40 } },
      { seq: 2, type: "llm/usage", data: { prompt_tokens: 100, cached_tokens: 80 } },
    ]);
    expect(cache).toEqual({ promptTokens: 200, cachedTokens: 120, cacheHitPercent: 60 });
  });
});
