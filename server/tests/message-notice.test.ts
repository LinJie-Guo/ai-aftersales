import { describe, expect, it } from "vitest";
import { messageNotice } from "../../web/src/messageNotice.ts";
import { projectEvents } from "../../web/src/transcript.ts";
import type { SessionEvent } from "../../web/src/api.ts";

const legacy = '本轮工具已经查到结果，模型没有写成结论，先据实汇总如下：\n\n【bash】\n{"status":401}';
const failure = "模型请求失败：当前模型限流或额度用尽，请稍后再试，或换一个模型。";
function event(seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent {
  return { seq, type, data };
}

describe("agent notices", () => {
  it("shows an actionable rate-limit notice", () => {
    expect(messageNotice(failure)).toMatchObject({ kind: "warning", title: "当前模型暂不可用", technical: "" });
    expect(messageNotice(failure)?.hint).toContain("切换模型");
  });
  it("preserves legacy raw output only as expandable technical details", () => {
    expect(messageNotice(legacy)).toMatchObject({ kind: "partial", title: "尚未生成最终结论" });
    expect(messageNotice(legacy)?.technical).toContain('{"status":401}');
    expect(messageNotice(legacy)?.detail).not.toContain("401");
  });
  it("leaves ordinary answers and quoted failure text unchanged", () => {
    expect(messageNotice("查询结果：共有 12 条漏洞记录。" )).toBeNull();
    expect(messageNotice("服务日志出现了：模型请求失败" )).toBeNull();
  });
  it("keeps image and generic failures distinct", () => {
    expect(messageNotice("模型请求失败：不支持看图")?.title).toBe("当前模型不支持图片输入");
    expect(messageNotice('模型请求失败：502 {"error":"bad gateway"}')?.technical).toContain("502");
  });
  it("deduplicates legacy fallback only when this turn's tool results remain visible", () => {
    const events = [event(1, "turn/start"), event(2, "tool/result", { callId: "c1", name: "bash", status: "error", summary: '{"status":401}' }), event(3, "assistant/message", { content: failure }), event(4, "assistant/message", { content: legacy })];
    const items = projectEvents(events);
    expect(items.filter((item) => item.kind === "assistant")).toHaveLength(1);
    expect(items.find((item) => item.kind === "tool")).toMatchObject({ summary: '{"status":401}' });
    expect(events).toHaveLength(4);
    expect(projectEvents([event(1, "assistant/message", { content: legacy })])).toHaveLength(1);
    expect(projectEvents([...events, event(5, "turn/start"), event(6, "assistant/message", { content: legacy })]).filter((item) => item.kind === "assistant")).toHaveLength(2);
  });
});
