import axios from "axios";
import { batchStream } from "./streamBatch";

export const http = axios.create({ baseURL: "/api/v1" });

http.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (resp) => resp,
  (error) => {
    if (error?.response?.status === 401) {
      localStorage.removeItem("token");
      if (location.pathname !== "/login") location.href = "/login";
    }
    return Promise.reject(error);
  },
);

export interface Project {
  id: string;
  name: string;
  description?: string;
  repos: { id?: string; repo_name: string; repo_url: string }[];
  customer_count: number;
  created_at: string;
  git_auth_type?: "none" | "ssh" | "token";
  git_username?: string;
  git_host?: string;
  has_token?: boolean;
  has_ssh_key?: boolean;
  git_token?: string;
  git_ssh_key?: string;
}

export interface CustomerRepo {
  id?: string;
  repo_name: string;
  repo_url: string;
  branch?: string;
  tag?: string;
  commit_id?: string;
  status?: string;
}

export interface DataAsset {
  id?: string;
  name: string;
  asset_type: string;
  content?: string;
  file_url?: string;
}

export interface Customer {
  id: string;
  name: string;
  project_id: string;
  project_name?: string;
  branch?: string;
  tag?: string;
  env_ip?: string;
  workdir?: string;
  code_status: string;
  code_synced_at?: string;
  repos: CustomerRepo[];
  assets?: DataAsset[];
  env?: { ssh_user?: string; ssh_key?: string } | null;
  created_at: string;
}

export interface RecordItem {
  id: string;
  code: string;
  customer_id: string;
  customer_name?: string;
  title: string;
  description?: string;
  priority: string;
  status: string;
  rounds: number;
  conclusion?: string;
  handler_name?: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface Knowledge {
  id: string;
  code?: string;
  title: string;
  summary?: string;
  doc_path?: string;
  markdown?: string;
  source_record_id?: string;
  customer_id?: string;
  customer_name?: string;
  created_at: string;
  updated_at: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  repo_total?: number;
  customer_total?: number;
}

export interface AppUser {
  id: string;
  username: string;
  display_name?: string;
  displayName?: string;
  role: string;
  roleName?: string;
  role_name?: string;
  dataScope?: string;
  data_scope?: string;
  active: boolean;
  permissions?: string[];
  customer_ids?: string[];
  customerIds?: string[];
  customer_names?: string[];
  customerNames?: string[];
  created_at?: string;
  createdAt?: string;
}

export interface AppRole {
  id: string;
  code: string;
  name: string;
  builtin: boolean;
  dataScope?: string;
  data_scope?: string;
  permissions: string[];
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
}

export interface PermItem {
  key: string;
  group: string;
  label: string;
}

export interface ListParams {
  page?: number;
  page_size?: number;
  keyword?: string;
  priority?: string;
  status?: string;
}

export interface SessionEvent {
  seq: number;
  type: string;
  data: Record<string, any>;
  createdAt?: string;
  created_at?: string;
}

export type AgentEvent = SessionEvent;
export type AgentResponseMode = "investigate" | "general" | "plan";
export type AgentPermission = "code" | "env";

export interface ChatAttachment {
  file_name: string;
  stored_name: string;
  view_url: string;
  mime_type: string;
  is_image: boolean;
}

export interface InboxRow {
  id: string;
  content: string;
  preview: string;
  placement: "queued" | "steering";
  referenceKnowledge?: boolean;
  modelName?: string;
}

export type InboxAction =
  | { kind: "edit"; content: string }
  | { kind: "remove" }
  | { kind: "steer" };

export interface InboxMutationResult {
  notice?: string;
  accepted: boolean;
  mode?: "queue" | "steer";
  sessionId?: string;
  item?: { id: string; content: string; placement: InboxRow["placement"] };
  items?: InboxRow[];
}

export interface ContextInfo {
  used_tokens: number;
  usedTokens?: number;
  max_tokens: number;
  maxTokens?: number;
  percent: number;
  system_tokens?: number;
  systemTokens?: number;
  tools_tokens?: number;
  toolsTokens?: number;
  message_tokens?: number;
  messageTokens?: number;
  prompt_tokens?: number;
  promptTokens?: number;
  cached_tokens?: number;
  cachedTokens?: number;
  cache_hit_percent?: number | null;
  cacheHitPercent?: number | null;
  kept_messages: number;
  compressed_messages: number;
  channels?: { code: boolean; ssh: boolean; env: boolean; assets: boolean };
  multimodal?: boolean;
}

export const api = {
  login: (username: string, password: string) => {
    const form = new URLSearchParams();
    form.set("username", username);
    form.set("password", password);
    return http.post("/auth/login", form);
  },
  me: () => http.get("/auth/me").then((r) => r.data),
  users: (params?: ListParams) => http.get<PageResult<AppUser>>("/users", { params }).then((r) => r.data),
  createUser: (data: any) => http.post<AppUser>("/users", data).then((r) => r.data),
  updateUser: (id: string, data: any) => http.put<AppUser>(`/users/${id}`, data).then((r) => r.data),
  roles: (params?: ListParams) => http.get<PageResult<AppRole>>("/roles", { params }).then((r) => r.data),
  roleCatalog: () => http.get<{ items: PermItem[] }>("/roles/catalog").then((r) => r.data),
  createRole: (data: any) => http.post<AppRole>("/roles", data).then((r) => r.data),
  updateRole: (id: string, data: any) => http.put<AppRole>(`/roles/${id}`, data).then((r) => r.data),
  deleteRole: (id: string) => http.delete(`/roles/${id}`).then((r) => r.data),
  projects: (params?: ListParams) => http.get<PageResult<Project>>("/projects", { params }).then((r) => r.data),
  createProject: (data: any) => http.post("/projects", data).then((r) => r.data),
  updateProject: (id: string, data: any) => http.put(`/projects/${id}`, data).then((r) => r.data),
  parseRepos: (text: string) =>
    http.post("/projects/parse-repos", { text }).then((r) => {
      const data = r.data;
      return Array.isArray(data) ? data : data?.items ?? [];
    }),
  testProjectGit: (data: any) => http.post("/projects/test-git", data).then((r) => r.data),
  customers: (params?: ListParams) => http.get<PageResult<Customer>>("/customers", { params }).then((r) => r.data),
  customer: (id: string) => http.get<Customer>(`/customers/${id}`).then((r) => r.data),
  createCustomer: (data: any) => http.post("/customers", data).then((r) => r.data),
  updateCustomer: (id: string, data: any) => http.put(`/customers/${id}`, data).then((r) => r.data),
  pullCode: (id: string) => http.post(`/customers/${id}/pull`).then((r) => r.data),
  testSsh: (id: string) => http.post(`/customers/${id}/test-ssh`).then((r) => r.data),
  records: (params?: ListParams) => http.get<PageResult<RecordItem>>("/records", { params }).then((r) => r.data),
  record: (id: string) => http.get(`/records/${id}`).then((r) => r.data),
  recordContext: (id: string) => http.get<ContextInfo>(`/records/${id}/context`).then((r) => r.data),
  createRecord: (data: any) => http.post("/records", data).then((r) => r.data),
  closeRecord: (id: string) => http.post(`/records/${id}/close`).then((r) => r.data),
  customerReply: (id: string) => http.post(`/records/${id}/customer-reply`).then((r) => r.data),
  knowledge: (params?: ListParams) => http.get<PageResult<Knowledge>>("/knowledge", { params }).then((r) => r.data),
  knowledgeDetail: (id: string) => http.get(`/knowledge/${id}`).then((r) => r.data),
  updateKnowledge: (id: string, data: any) => http.put(`/knowledge/${id}`, data).then((r) => r.data),
  publishKnowledge: (id: string) => http.post(`/knowledge/${id}/publish`).then((r) => r.data),
  knowledgeFromRecord: (id: string) => http.post(`/knowledge/from-record/${id}`).then((r) => r.data),
  deleteKnowledge: (id: string) => http.delete(`/knowledge/${id}`).then((r) => r.data),
  modelConfig: () => http.get("/settings/model").then((r) => r.data),
  availableModels: () => http.get("/models").then((r) => r.data),
  approvals: (id: string) => http.get(`/sessions/${id}/approvals`).then((r) => r.data),
  approveCommand: (id: string, approvalId: string, approved: boolean) => http.post(`/sessions/${id}/answer`, { approvalId, approved }).then((r) => r.data),
  artifact: (id: string, artifactId: string, offset = 0) => http.get(`/sessions/${id}/artifacts/${artifactId}`, { params: { offset } }).then((r) => r.data),
  saveModelConfig: (data: any) => http.put("/settings/model", data).then((r) => r.data),
  testModelConfig: (data: any) => http.post<{ ok: boolean; message: string; model?: string; elapsedMs?: number; upstreamStatus?: number }>("/settings/model/test", data, { timeout: 25000 }).then((r) => r.data),
  listProviderModels: (data: { base_url?: string; api_key?: string }) =>
    http.post<{ items: { id: string; name: string; contextWindow?: number; context_window?: number }[] }>("/settings/model/models", data).then((r) => r.data),
  uploadToRecord: (recordId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return http.post(`/records/${recordId}/uploads`, fd).then((r) => r.data);
  },
  uploadCustomerAsset: (customerId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return http.post(`/customers/${customerId}/uploads`, fd).then((r) => r.data);
  },
  cancelAgentRun: (_recordId: string, sessionId: string) => http.post(`/sessions/${sessionId}/cancel`).then((r) => r.data),
  sessionInbox: (
    sessionId: string,
    data: { content: string; mode: "queue" | "steer"; permission?: AgentPermission; attachments?: ChatAttachment[]; referenceKnowledge?: boolean; modelName?: string },
  ) => http.post<InboxMutationResult>(`/sessions/${sessionId}/inbox`, data).then((r) => r.data),
  sessionInboxList: (sessionId: string) =>
    http.get<{ items: InboxRow[] }>(`/sessions/${sessionId}/inbox`).then((r) => r.data),
  updateSessionInbox: (sessionId: string, itemId: string, action: InboxAction) =>
    http.post<InboxMutationResult>(`/sessions/${sessionId}/inbox/${itemId}`, action).then((r) => r.data),
  latestAgentRun: (recordId: string) => http.get(`/records/${recordId}/sessions/latest`).then((r) => r.data),
  agentRunEvents: (_recordId: string, sessionId: string, afterSeq = 0) =>
    http.get(`/sessions/${sessionId}/events`, { params: { afterSeq } }).then((r) => r.data),
  answerSession: (sessionId: string, answers: Record<string, string>) =>
    http.post(`/sessions/${sessionId}/answer`, { answers }).then((r) => r.data),
};

export interface StreamAttachResult {
  accepted?: boolean;
  sessionId?: string;
  queued?: boolean;
  attached?: boolean;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function consumeSSE(resp: Response, onEvent: (event: SessionEvent) => void) {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const batch = batchStream(onEvent);
  try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
      const line = dataLine?.replace(/^data:\s?/, "").trim() || "";
      if (!line) continue;
      try {
        const event = JSON.parse(line) as SessionEvent;
        if (typeof event.seq === "number" && event.type) batch.push(event);
      } catch {
        /* ignore */
      }
    }
  }
  } finally { batch.flush(); reader.releaseLock(); }
}

async function readSSE(path: string, body: unknown, onEvent: (event: SessionEvent) => void): Promise<StreamAttachResult> {
  const resp = await fetch(`/api/v1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Agent stream request failed: ${resp.status}`);
  const type = resp.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    return await resp.json() as StreamAttachResult;
  }
  await consumeSSE(resp, onEvent);
  return {};
}

function agentBody(
  content: string,
  permission: AgentPermission,
  extras?: { attachments?: ChatAttachment[]; recordId?: string; referenceKnowledge?: boolean; modelName?: string },
) {
  return {
    content,
    permission,
    referenceKnowledge: extras?.referenceKnowledge === true,
    modelName: extras?.modelName,
    ...(extras?.recordId ? { recordId: extras.recordId } : {}),
    ...(extras?.attachments?.length ? { attachments: extras.attachments } : {}),
  };
}

export function streamFollowup(
  recordId: string,
  content: string,
  permission: AgentPermission,
  onEvent: (event: SessionEvent) => void,
  sessionId?: string | null,
  extras?: { attachments?: ChatAttachment[]; referenceKnowledge?: boolean; modelName?: string },
) {
  if (sessionId) return readSSE(`/sessions/${sessionId}/followup`, agentBody(content, permission, extras), onEvent);
  return readSSE("/sessions", agentBody(content, permission, { ...extras, recordId }), onEvent);
}

export function streamSteer(sessionId: string, content: string, onEvent: (event: SessionEvent) => void) {
  return readSSE(`/sessions/${sessionId}/steer`, { content }, onEvent);
}

export function streamResume(
  recordId: string,
  runId: string,
  content: string,
  onEvent: (event: SessionEvent) => void,
  permission: AgentPermission = "env",
  extras?: { attachments?: ChatAttachment[]; referenceKnowledge?: boolean; modelName?: string },
) {
  return readSSE(`/sessions/${runId}/followup`, agentBody(content, permission, { ...extras, recordId }), onEvent);
}

export async function streamAttach(
  sessionId: string,
  afterSeq: number,
  onEvent: (event: SessionEvent) => void,
  signal?: AbortSignal,
) {
  const resp = await fetch(`/api/v1/sessions/${sessionId}/stream?afterSeq=${afterSeq}`, {
    headers: authHeaders(),
    signal,
  });
  if (!resp.ok) throw new Error(`Agent stream attach failed: ${resp.status}`);
  await consumeSSE(resp, onEvent);
}
