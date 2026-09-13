import type { SessionStore } from "../types.ts";
import type { ToolSpec } from "./types.ts";

/** Durable working state, not another planner/model loop. Claims must cite an
 * existing result; failures only establish failure, not a business conclusion. */
export function investigationTool(session: SessionStore): ToolSpec {
  return {
    name: "investigation_state", description: "复杂排查时维护工作状态：目标、事实及证据 callId、已排除路径、阻塞、下一步。只记录实际已执行证据，不把 todo 当事实；推断要标记 inferred。状态在续聊和上下文压缩后保留。",
    parameters: { type: "object", properties: { goal: { type: "string" }, facts: { type: "array", items: { type: "object", properties: { claim: { type: "string" }, evidenceIds: { type: "array", items: { type: "string" } }, inferred: { type: "boolean" } }, required: ["claim", "evidenceIds"], additionalProperties: false } }, ruledOut: { type: "array", items: { type: "string" } }, blockers: { type: "array", items: { type: "string" } }, nextStep: { type: "string" } }, required: ["goal", "facts", "nextStep"], additionalProperties: false },
    async execute(args) {
      if (JSON.stringify(args).length > 12000 || typeof args.goal !== "string" || !args.goal.trim() || typeof args.nextStep !== "string" || !Array.isArray(args.facts) || args.facts.length > 20 || [args.ruledOut, args.blockers].some((items) => items !== undefined && (!Array.isArray(items) || items.length > 30 || items.some((v) => typeof v !== "string")))) return { status: "failed", summary: "状态过大或字段无效" };
      const evidence = new Map(session.events.filter((e) => e.type === "tool/result" && e.data.name !== "investigation_state").map((e) => [e.data.callId, e.data.status]));
      for (const fact of args.facts) if (!fact || typeof fact.claim !== "string" || fact.inferred !== undefined && typeof fact.inferred !== "boolean" || !Array.isArray(fact.evidenceIds) || !fact.evidenceIds.length || fact.evidenceIds.some((id: string) => !evidence.has(id))) return { status: "failed", summary: "每条记录必须引用已有工具结果的 callId；失败结果仅能证明执行失败，不能证明业务数量或状态。没有证据的内容请放入 blockers 或 nextStep" };
      const facts = args.facts.map((fact) => ({ ...fact, evidenceStatuses: fact.evidenceIds.map((id: string) => evidence.get(id)) }));
      return { status: "success", summary: "工作状态已记录；引用不等于事实已验证，失败证据只能证明失败。", sessionEvents: [{ type: "investigation/state", data: { ...args, facts } }] };
    },
  };
}
