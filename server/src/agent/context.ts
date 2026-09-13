import type { ChatMessage } from "./types.ts";
import type { ArtifactStore } from "./tools/artifacts.ts";
import { estimateMessageTokens } from "./context-meter.ts";

export function contextSize(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export const CHECKPOINT_INSTRUCTION = `将上述排查整理为可继续工作的检查点。只输出以下结构，不执行工具，不声称推测已验证：
## 用户目标与最新修正
## 已验证事实与证据引用
## 数据来源、索引/表与过滤口径
## 已排除路径与失败原因
## 关键源码、现场路径与附件引用
## 未完成事项与下一步
## 权限与约束
保留确切路径、数字、标识符和用户纠正。历史知识与现场事实分开。仅保留凭据引用，不输出密码。旧检查点与新事实合并，删除已失效推断。`;

/** One token unit throughout. Keep assistant/tool groups and the current request
 * intact; trim tool middles first, then summarize older complete groups. */
export async function compactContext(messages: ChatMessage[], budget: number, artifacts: ArtifactStore, summarize?: (history: ChatMessage[]) => Promise<string>) {
  if (contextSize(messages) <= budget) return { messages, removed: 0 };
  const source = await artifacts.persistText("context", JSON.stringify(messages.map(withoutImageBytes)), { format: "chat-history", originalMessages: messages.length });
  const working = messages.map((message): ChatMessage => {
    if (message.role !== "tool" || estimateMessageTokens(message) < Math.min(6000, budget / 4)) return message;
    const chars = Math.max(200, Math.floor(Math.min(4000, budget / 8)));
    return { ...message, content: `${message.content.slice(0, chars)}\n[中间已裁剪，完整历史 artifact_read ${source.id}]\n${message.content.slice(-chars)}` };
  });
  if (contextSize(working) <= budget) return { messages: working, removed: 0, artifactId: source.id, compacted: true };
  const groups: ChatMessage[][] = [];
  for (const message of working) {
    if (message.role === "tool" && groups.length) groups[groups.length - 1]!.push(message);
    else groups.push([message]);
  }
  const latest = working.findLast((m) => m.role === "user" && (m.source === "human" || m.source === "steer"));
  const retained = [...groups], removed: ChatMessage[] = [];
  const retainBudget = Math.floor(budget * 0.55);
  while (retained.length > 1 && contextSize(retained.flat()) > retainBudget) {
    const index = retained.findIndex((group) => !group.includes(latest!) && !group.some((m) => m.role === "user" && m.images?.length));
    if (index < 0 || index === retained.length - 1) break;
    removed.push(...retained.splice(index, 1)[0]!);
  }
  if (!removed.length) throw new Error("当前请求或图片超过上下文预算，请减少附件或选择更大上下文模型；图片未被静默丢弃");
  const summary = summarize ? await summarize(removed) : extractiveCheckpoint(removed);
  if (!summary.trim()) throw new Error("检查点生成失败，原始历史已保留，请重试");
  const prefix: ChatMessage = { role: "user", source: "system", id: `checkpoint-${source.id}`, content: `以下是此前排查检查点（模型摘要，证据以原始结果为准）。完整历史：artifact_read ${source.id}\n${summary}` };
  const result = [prefix, ...retained.flat()];
  if (contextSize(result) > budget) throw new Error("检查点与当前请求仍超过预算，原始历史已保留，请选择更大上下文模型");
  return { messages: result, removed: removed.length, artifactId: source.id, compacted: true };
}

export function withoutImageBytes(message: ChatMessage): ChatMessage {
  return message.role === "user" ? { ...message, images: undefined } : message;
}

function extractiveCheckpoint(history: ChatMessage[]): string {
  const users = history.filter((m) => m.role === "user" && m.source !== "inject").map((m) => m.content);
  const evidence = history.filter((m) => m.role === "tool").map((m) => `${m.name}: ${m.content.slice(0, 300)}`);
  return `## 用户目标与修正\n${users.join("\n").slice(0, 2400)}\n## 现场执行摘录（非最终结论）\n${evidence.slice(-6).join("\n")}\n## 待办\n结合最新问题继续，先核对原始证据，不重复已执行步骤。`;
}
