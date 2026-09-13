import type { SessionStore } from "../types.ts";
import type { ToolSpec } from "./types.ts";

/** A model-declared outcome, not a claim that the harness can prove semantics. */
export function finishTool(session: SessionStore): ToolSpec {
  return {
    name: "finish_task", terminal: true,
    description: "结束当前轮并向用户输出 summary。completed=目标已完成，blocked=外部条件阻塞，needs_input=缺少用户必须决定的信息。做过工具排查后须用本工具明确结果。仅写计划不算完成；已有授权内的可执行下一步应继续执行。completed 必须引用实际证据；错误响应可以支持故障诊断，但不能证明未取得的数据。其他状态说明 blockers，不把失败推测当事实。单独调用，不与其他工具并行。",
    parameters: { type: "object", properties: { status: { type: "string", enum: ["completed", "blocked", "needs_input"] }, summary: { type: "string", description: "面向用户的最终答复" }, evidenceIds: { type: "array", description: "工具返回证据链接中的 callId（#evidence- 后的 ID），也接受完整证据链接或对应 Artifact ID；无需为取 ID 重读工具结果", items: { type: "string" } }, blockers: { type: "array", items: { type: "string" } } }, required: ["status", "summary", "evidenceIds"], additionalProperties: false },
    async execute(args) {
      if (!["completed", "blocked", "needs_input"].includes(String(args.status)) || typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 24000 || !Array.isArray(args.evidenceIds) || args.evidenceIds.length > 30 || args.evidenceIds.some((id) => typeof id !== "string") || args.blockers !== undefined && (!Array.isArray(args.blockers) || args.blockers.length > 20 || args.blockers.some((v) => typeof v !== "string" || !v.trim()))) return { status: "failed", summary: "任务结果字段无效" };
      const blockers = args.blockers as string[] ?? [];
      const results = session.events.filter((event) => event.type === "tool/result" && !["finish_task", "investigation_state"].includes(String(event.data.name)));
      const evidence = new Map<string, string>();
      for (const event of results) {
        const id = String(event.data.callId || "");
        if (id) { evidence.set(id, id); if (event.data.artifactId) evidence.set(String(event.data.artifactId), id); }
      }
      const evidenceIds = args.evidenceIds.map((id: string) => evidence.get(id.match(/#evidence-([^\s)]+)/)?.[1] || id));
      if (evidenceIds.some((id) => !id)) return { status: "failed", summary: `证据 ID 不存在。可用的近期工具证据：${results.slice(-8).map((e) => `${e.data.name}: ${e.data.callId}`).join("；")}。可直接引用，无需重新调用工具。` };
      if (args.status === "completed" && (blockers.length || !args.evidenceIds.length)) return { status: "failed", summary: "完成状态需要实际证据且没有未解决阻塞；否则继续工作或声明 blocked/needs_input。" };
      if (args.status !== "completed" && !blockers.length) return { status: "failed", summary: "未完成状态必须说明具体 blockers；不能仅把下一步计划当作完成。" };
      const completion = { status: args.status as "completed" | "blocked" | "needs_input", summary: args.summary, evidenceIds: [...new Set(evidenceIds)] as string[], blockers };
      return { status: "success", summary: "任务结果已记录（模型报告，需结合原始证据核验）。", completion };
    },
  };
}
