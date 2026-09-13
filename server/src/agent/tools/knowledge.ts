import type { ToolSpec } from "./types.ts";

import type { ArtifactStore } from "./artifacts.ts";

export interface KnowledgeHit {
  id: string;
  title: string;
  symptom?: string;
  rootCause?: string;
  steps?: string;
}

export function createKnowledgeTools(input: {
  search: (query: string) => Promise<KnowledgeHit[]>;
  artifacts: ArtifactStore;
}): ToolSpec[] {
  return [
    {
      name: "knowledge_search",
      description: "用户本轮勾选参考历史知识时可用。检索本售后系统历史工单，不是客户系统的漏洞库。query 使用具体症状、服务名、报错词；只有‘知识库/查询/统计’等泛词不会返回结果。历史信息仅作线索，数量和状态须重新验证。",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(args) {
        const query = String(args.query ?? "").trim();
        if (!query) return { status: "failed", summary: "query 不能为空" };
        const hits = await input.search(query);
        const text = hits.length
          ? hits.map((hit, index) => {
            const body = hit.rootCause || hit.steps || hit.symptom || "";
            return `${index + 1}. ${hit.title}\n摘要: ${hit.symptom || "-"}\n\n${body}`.trim();
          }).join("\n\n---\n\n")
          : "未检索到相似知识";
        const ref = await input.artifacts.persistText("knowledge", text, { query });
        return { status: "success", summary: ref.preview, artifactId: ref.id, data: { count: hits.length } };
      },
    },
  ];
}
