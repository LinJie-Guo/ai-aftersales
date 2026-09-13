export type SessionPreset = "investigate" | "plan" | "general";

export type SessionEventType =
  | "turn/start"
  | "turn/end"
  | "step/start"
  | "step/end"
  | "user/message"
  | "assistant/chunk"
  | "assistant/reasoning"
  | "assistant/message"
  | "llm/request"
  | "llm/usage"
  | "tool/call"
  | "tool/result"
  | "todo/write"
  | "plan/mode"
  | "ask_user"
  | "job/update"
  | "session/status";

export interface SessionEvent {
  seq: number;
  type: SessionEventType | string;
  data: Record<string, unknown>;
  createdAt?: string;
}

export interface ContentPart {
  type: "text" | "image";
  text?: string;
  mimeType?: string;
  dataUrl?: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  repoTotal?: number;
  customerTotal?: number;
}

export interface RepoItem {
  id?: string;
  repoName: string;
  repoUrl: string;
  branch?: string;
  tag?: string;
  commitId?: string;
  status?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  repos: RepoItem[];
  customerCount: number;
  createdAt: string;
}

export interface DataAsset {
  id?: string;
  name: string;
  assetType: string;
  content?: string;
  fileUrl?: string;
}

export interface Customer {
  id: string;
  name: string;
  projectId: string;
  projectName?: string;
  branch?: string;
  tag?: string;
  envIp?: string;
  workdir?: string;
  codeStatus: string;
  codeSyncedAt?: string;
  repos: RepoItem[];
  assets?: DataAsset[];
  env?: { sshUser?: string; sshKey?: string } | null;
  createdAt: string;
}

export interface RecordItem {
  id: string;
  code: string;
  customerId: string;
  customerName?: string;
  title: string;
  priority: string;
  status: string;
  rounds: number;
  conclusion?: string;
  handlerName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeItem {
  id: string;
  code?: string;
  title: string;
  customerId?: string;
  category?: string;
  scopeProject?: string;
  scopeVersion?: string;
  confidence: string;
  status: string;
  tags?: string[];
  symptom?: string;
  rootCause?: string;
  steps?: string;
  verify?: string;
  similarDesc?: string;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_SYSTEM_PROMPT = `你是售后排查 Agent。围绕用户目标自主选择工具，根据实际结果推进工作。

仅在用户本轮勾选「参考历史知识」时，才可检索本售后系统的历史工单文档。相似经验仅提供线索，不能替代当前源码与现场证据。

优先利用已有上下文和证据选择最短有效路径；不要猜测地址、配置或结果。仅当缺少的信息无法从可用工具确定，且会实质改变目标时才询问用户。
发现失败先区分参数、执行环境、认证协议和服务响应，再决定下一步。改变请求方法、目标或凭据后可以重新验证；不要把一次失败泛化成所有路径都不可行。

凭据通过工具提供的引用使用，不打印真实值。遵守执行层权限，不规避审批。已授权且有意义的操作直接推进，不把可执行的下一步仅写成计划。完成、阻塞和需要用户输入是不同结果；引用原始证据，不把假设写成事实。用简体中文 Markdown 面向工程师作答。`;
