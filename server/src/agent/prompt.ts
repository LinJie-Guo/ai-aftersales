import { DEFAULT_SYSTEM_PROMPT } from "../shared/index.ts";

const legacyBase = `你是售后排查 Agent。根据用户问题和当前现场自主选用只读工具，根据工具结果作答。

{{knowledge}}

问题已经具体到能查代码或现场时，本轮一次查完再给结论，不要把工作留给下一次追问。
问题只有标题或范围太大（例如只有「数据问题」「报错了」），先用一两句话问清现象、报错和要查的范围，不要为了凑结论扫遍仓库和服务器。

不要编造路径、数字或现场状态。缺代码或 SSH 时直接说缺什么。调用工具的那一步不要同时给最终答复。问数量时必须查到现场数据再答。{{repeat}}用简体中文 Markdown 面向工程师作答。`;
const legacyBuiltins = [
  "本系统有历史工单沉淀的 Markdown 知识文档。遇到可能见过的问题，先 knowledge_search；高度相似则优先复用文档结论并注明来源，再决定要不要查代码或现场。",
  "仅在用户本轮勾选「参考历史知识」时，才可检索本售后系统的历史工单文档。相似经验仅提供线索，不能替代当前源码与现场证据。",
].flatMap((knowledge) => ["", "同一工具、同一参数不要重复调用；结果已经拿到就基于它继续，不要再打一遍。"].map((repeat) => legacyBase.replace("{{knowledge}}", knowledge).replace("{{repeat}}", repeat)));

/** Upgrade exact shipped defaults only; never rewrite a custom user prompt. */
export function resolveConfiguredPrompt(stored?: string | null): string {
  const prompt = stored?.trim();
  return !prompt || legacyBuiltins.includes(prompt) ? DEFAULT_SYSTEM_PROMPT : prompt;
}

export function turnKnowledgePolicy(enabled: boolean): string {
  return enabled
    ? "【本轮知识策略】用户已勾选参考历史知识；可作为线索，不代替本轮证据。"
    : "【本轮知识策略】用户未勾选参考历史知识；不得新增检索或注入知识文档。此前对话保留，旧结论不自动视为当前事实。";
}

export function renderSystemPrompt(input: {
  base?: string;
  extra?: string;
  planActive?: boolean;
  planSection?: string;
}): string {
  const parts = [input.base?.trim() || DEFAULT_SYSTEM_PROMPT];
  if (input.planActive) {
    parts.push(
      input.planSection?.trim()
        || "你当前处于 plan mode。先探查并写出可执行方案，不要直接下结论。",
    );
  }
  if (input.extra?.trim()) parts.push(input.extra.trim());
  return parts.join("\n\n");
}
