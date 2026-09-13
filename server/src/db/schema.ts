import { boolean, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const appRole = pgTable("app_role", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code").notNull().unique(),
  name: varchar("name").notNull(),
  builtin: boolean("builtin").notNull().default(false),
  dataScope: varchar("data_scope").notNull().default("assigned"),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  ...timestamps,
});

export const appUser = pgTable("app_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username").notNull().unique(),
  displayName: varchar("display_name").notNull(),
  passwordHash: varchar("password_hash").notNull(),
  role: varchar("role").notNull().default("engineer"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const project = pgTable("project", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name").notNull(),
  description: text("description"),
  gitAuthType: varchar("git_auth_type").notNull().default("none"),
  gitUsername: varchar("git_username"),
  gitTokenEnc: text("git_token_enc"),
  gitSshKeyEnc: text("git_ssh_key_enc"),
  gitHost: varchar("git_host"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
});

export const projectRepo = pgTable("project_repo", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  repoName: varchar("repo_name").notNull(),
  repoUrl: varchar("repo_url").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const customer = pgTable("customer", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name").notNull(),
  projectId: uuid("project_id").notNull().references(() => project.id),
  branch: varchar("branch"),
  tag: varchar("tag"),
  envIp: varchar("env_ip"),
  workdir: varchar("workdir"),
  codeStatus: varchar("code_status").notNull().default("unknown"),
  codeSyncedAt: timestamp("code_synced_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
});

export const userCustomer = pgTable("user_customer", {
  userId: uuid("user_id").notNull().references(() => appUser.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
});

export const customerRepo = pgTable("customer_repo", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  repoName: varchar("repo_name").notNull(),
  repoUrl: varchar("repo_url").notNull(),
  branch: varchar("branch"),
  tag: varchar("tag"),
  commitId: varchar("commit_id"),
  status: varchar("status").notNull().default("unknown"),
});

export const dataAsset = pgTable("data_asset", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  name: varchar("name").notNull(),
  assetType: varchar("asset_type").notNull(),
  content: text("content"),
  fileUrl: varchar("file_url"),
  ...timestamps,
});

export const customerEnv = pgTable("customer_env", {
  customerId: uuid("customer_id").primaryKey().references(() => customer.id, { onDelete: "cascade" }),
  connectType: varchar("connect_type").notNull().default("ssh_compose"),
  workspacePath: varchar("workspace_path"),
  composePath: varchar("compose_path"),
  sshHost: varchar("ssh_host"),
  sshUser: varchar("ssh_user"),
  sshKeyEnc: text("ssh_key_enc"),
  note: text("note"),
  ...timestamps,
});

export const afterSaleRecord = pgTable("after_sale_record", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code").notNull().unique(),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  title: varchar("title").notNull(),
  description: text("description"),
  priority: varchar("priority").notNull().default("p1"),
  priorityBy: varchar("priority_by").notNull().default("manual"),
  status: varchar("status").notNull().default("processing"),
  rounds: integer("rounds").notNull().default(0),
  conclusion: text("conclusion"),
  handlerId: uuid("handler_id").references(() => appUser.id),
  threadId: varchar("thread_id").notNull(),
  ...timestamps,
});

export const knowledge = pgTable("knowledge", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code").unique(),
  title: varchar("title").notNull(),
  sourceRecordId: uuid("source_record_id").references(() => afterSaleRecord.id),
  customerId: uuid("customer_id").references(() => customer.id),
  category: varchar("category"),
  scopeProject: varchar("scope_project"),
  scopeVersion: varchar("scope_version"),
  confidence: varchar("confidence").notNull().default("unverified"),
  status: varchar("status").notNull().default("pending"),
  tags: jsonb("tags").$type<string[]>(),
  symptom: text("symptom"),
  rootCause: text("root_cause"),
  evidence: text("evidence"),
  steps: text("steps"),
  verify: text("verify"),
  similarDesc: text("similar_desc"),
  summary: text("summary"),
  docPath: varchar("doc_path"),
  searchText: text("search_text"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
});

export const modelConfig = pgTable("model_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: varchar("provider").notNull().default("openai_compatible"),
  modelName: varchar("model_name").notNull(),
  baseUrl: varchar("base_url").notNull(),
  apiKeyEnc: text("api_key_enc").notNull().default(""),
  maxContext: integer("max_context"),
  temperature: integer("temperature").notNull().default(20),
  timeoutSec: integer("timeout_sec").notNull().default(120),
  retry: integer("retry").notNull().default(2),
  systemPrompt: text("system_prompt"),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  ...timestamps,
});

export const gitCredential = pgTable("git_credential", {
  id: uuid("id").primaryKey().defaultRandom(),
  authType: varchar("auth_type").notNull().default("ssh"),
  gitUsername: varchar("git_username"),
  tokenEnc: text("token_enc"),
  sshKeyEnc: text("ssh_key_enc"),
  knownHosts: varchar("known_hosts"),
  status: varchar("status").notNull().default("unknown"),
  ...timestamps,
});

export const session = pgTable("agent_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  recordId: uuid("record_id").notNull().references(() => afterSaleRecord.id, { onDelete: "cascade" }),
  preset: varchar("preset").notNull().default("investigate"),
  status: varchar("status").notNull().default("idle"),
  parentSessionId: uuid("parent_session_id"),
  executionPolicy: jsonb("execution_policy").$type<{ actorId: string; permission: "code" | "env"; knowledgeCustomerIds: string[] | null }>(),
  nextSeq: integer("next_seq").notNull().default(0),
  ...timestamps,
});

export const sessionEvent = pgTable("session_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  type: varchar("type").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const artifact = pgTable("artifact", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
  kind: varchar("kind").notNull(),
  preview: text("preview").notNull(),
  storagePath: varchar("storage_path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const uploadedFile = pgTable("uploaded_file", {
  storedName: varchar("stored_name").primaryKey(),
  customerId: uuid("customer_id").references(() => customer.id),
  recordId: uuid("record_id").references(() => afterSaleRecord.id),
  uploadedBy: uuid("uploaded_by").references(() => appUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
