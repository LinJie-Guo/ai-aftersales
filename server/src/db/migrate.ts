import { eq } from "drizzle-orm";

import { DEFAULT_ROLES } from "../http/permissions.ts";

import { db, sql } from "./client.ts";
import { appRole } from "./schema.ts";

export async function migrate(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS document_counter (prefix varchar NOT NULL, day varchar NOT NULL, value bigint NOT NULL, PRIMARY KEY(prefix, day))`;
  await sql`
    CREATE TABLE IF NOT EXISTS app_user (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username varchar NOT NULL UNIQUE,
      display_name varchar NOT NULL,
      password_hash varchar NOT NULL,
      role varchar NOT NULL DEFAULT 'engineer',
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS project (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar NOT NULL,
      description text,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS project_repo (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      repo_name varchar NOT NULL,
      repo_url varchar NOT NULL,
      sort_order integer NOT NULL DEFAULT 0
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS customer (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar NOT NULL,
      project_id uuid NOT NULL REFERENCES project(id),
      branch varchar,
      tag varchar,
      env_ip varchar,
      workdir varchar,
      code_status varchar NOT NULL DEFAULT 'unknown',
      code_synced_at timestamptz,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS customer_repo (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
      repo_name varchar NOT NULL,
      repo_url varchar NOT NULL,
      branch varchar,
      tag varchar,
      commit_id varchar,
      status varchar NOT NULL DEFAULT 'unknown'
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS data_asset (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
      name varchar NOT NULL,
      asset_type varchar NOT NULL,
      content text,
      file_url varchar,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS customer_env (
      customer_id uuid PRIMARY KEY REFERENCES customer(id) ON DELETE CASCADE,
      connect_type varchar NOT NULL DEFAULT 'ssh_compose',
      workspace_path varchar,
      compose_path varchar,
      ssh_host varchar,
      ssh_user varchar,
      ssh_key_enc text,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS after_sale_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code varchar NOT NULL UNIQUE,
      customer_id uuid NOT NULL REFERENCES customer(id),
      title varchar NOT NULL,
      priority varchar NOT NULL DEFAULT 'p1',
      priority_by varchar NOT NULL DEFAULT 'manual',
      status varchar NOT NULL DEFAULT 'processing',
      rounds integer NOT NULL DEFAULT 0,
      conclusion text,
      handler_id uuid REFERENCES app_user(id),
      thread_id varchar NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS knowledge (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code varchar UNIQUE,
      title varchar NOT NULL,
      source_record_id uuid REFERENCES after_sale_record(id),
      customer_id uuid REFERENCES customer(id),
      category varchar,
      scope_project varchar,
      scope_version varchar,
      confidence varchar NOT NULL DEFAULT 'unverified',
      status varchar NOT NULL DEFAULT 'pending',
      tags jsonb,
      symptom text,
      root_cause text,
      evidence text,
      steps text,
      verify text,
      similar_desc text,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS model_config (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider varchar NOT NULL DEFAULT 'openai_compatible',
      model_name varchar NOT NULL,
      base_url varchar NOT NULL,
      api_key_enc text NOT NULL DEFAULT '',
      max_context integer,
      temperature integer NOT NULL DEFAULT 20,
      timeout_sec integer NOT NULL DEFAULT 120,
      retry integer NOT NULL DEFAULT 2,
      system_prompt text,
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
      enabled boolean NOT NULL DEFAULT true,
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS git_credential (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      auth_type varchar NOT NULL DEFAULT 'ssh',
      git_username varchar,
      token_enc text,
      ssh_key_enc text,
      known_hosts varchar,
      status varchar NOT NULL DEFAULT 'unknown',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS agent_session (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      record_id uuid NOT NULL REFERENCES after_sale_record(id) ON DELETE CASCADE,
      preset varchar NOT NULL DEFAULT 'investigate',
      status varchar NOT NULL DEFAULT 'idle',
      parent_session_id uuid,
      next_seq integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS session_event (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
      seq integer NOT NULL,
      type varchar NOT NULL,
      data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS artifact (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
      kind varchar NOT NULL,
      preview text NOT NULL,
      storage_path varchar NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`ALTER TABLE agent_session ADD COLUMN IF NOT EXISTS execution_policy jsonb`;
  await sql`CREATE TABLE IF NOT EXISTS uploaded_file (
    stored_name varchar PRIMARY KEY,
    customer_id uuid REFERENCES customer(id),
    record_id uuid REFERENCES after_sale_record(id),
    uploaded_by uuid REFERENCES app_user(id),
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS session_event_lookup ON session_event(session_id, seq)`;
  await sql`CREATE INDEX IF NOT EXISTS knowledge_search_fts ON knowledge USING gin(to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(root_cause,'') || ' ' || coalesce(symptom,'')))`.catch(() => undefined);

  const tables = [
    "app_user",
    "project",
    "project_repo",
    "customer",
    "customer_repo",
    "data_asset",
    "after_sale_record",
    "knowledge",
    "model_config",
    "git_credential",
    "agent_session",
    "session_event",
    "artifact",
  ];
  for (const table of tables) {
    await sql.unsafe(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT gen_random_uuid()`).catch(() => undefined);
    await sql.unsafe(`ALTER TABLE ${table} ALTER COLUMN created_at SET DEFAULT now()`).catch(() => undefined);
    await sql.unsafe(`ALTER TABLE ${table} ALTER COLUMN updated_at SET DEFAULT now()`).catch(() => undefined);
  }
  await sql`ALTER TABLE after_sale_record ALTER COLUMN rounds SET DEFAULT 0`.catch(() => undefined);
  // Earlier deployments relied on application-side defaults. Align existing tables
  // with the current schema, not just newly created databases.
  for (const [table, column, value] of [
    ["app_user", "role", "'engineer'"], ["app_user", "active", "true"],
    ["customer", "code_status", "'unknown'"], ["project_repo", "sort_order", "0"],
    ["knowledge", "confidence", "'unverified'"], ["knowledge", "status", "'ready'"],
    ["git_credential", "auth_type", "'ssh'"], ["git_credential", "status", "'unknown'"],
    ["model_config", "provider", "'openai_compatible'"], ["model_config", "api_key_enc", "''"],
    ["model_config", "temperature", "0.2"], ["model_config", "timeout_sec", "120"],
    ["model_config", "retry", "2"], ["model_config", "enabled", "true"], ["model_config", "is_default", "false"],
  ]) await sql.unsafe(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${value}`);
  await sql`ALTER TABLE after_sale_record ALTER COLUMN priority SET DEFAULT 'p1'`.catch(() => undefined);
  await sql`ALTER TABLE after_sale_record ALTER COLUMN priority_by SET DEFAULT 'manual'`.catch(() => undefined);
  await sql`ALTER TABLE after_sale_record ALTER COLUMN status SET DEFAULT 'processing'`.catch(() => undefined);
  await sql`UPDATE after_sale_record SET status = 'processing' WHERE status IN ('located', 'await_customer')`.catch(() => undefined);
  await sql`UPDATE customer_repo SET status = 'unknown' WHERE status IS NULL`.catch(() => undefined);
  await sql`ALTER TABLE customer_repo ALTER COLUMN status SET DEFAULT 'unknown'`.catch(() => undefined);
  await sql`ALTER TABLE customer_env ALTER COLUMN connect_type SET DEFAULT 'ssh_compose'`.catch(() => undefined);
  await sql`ALTER TABLE customer_env ALTER COLUMN created_at SET DEFAULT now()`.catch(() => undefined);
  await sql`ALTER TABLE customer_env ALTER COLUMN updated_at SET DEFAULT now()`.catch(() => undefined);
  await sql`ALTER TABLE project ADD COLUMN IF NOT EXISTS git_auth_type varchar NOT NULL DEFAULT 'none'`.catch(() => undefined);
  await sql`ALTER TABLE project ADD COLUMN IF NOT EXISTS git_username varchar`.catch(() => undefined);
  await sql`ALTER TABLE project ADD COLUMN IF NOT EXISTS git_token_enc text`.catch(() => undefined);
  await sql`ALTER TABLE project ADD COLUMN IF NOT EXISTS git_ssh_key_enc text`.catch(() => undefined);
  await sql`ALTER TABLE project ADD COLUMN IF NOT EXISTS git_host varchar`.catch(() => undefined);
  await sql`ALTER TABLE after_sale_record ADD COLUMN IF NOT EXISTS description text`.catch(() => undefined);
  await sql`ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS summary text`.catch(() => undefined);
  await sql`ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS doc_path varchar`.catch(() => undefined);
  await sql`ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS search_text text`;
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
  await sql`CREATE INDEX IF NOT EXISTS knowledge_doc_search_trgm ON knowledge USING gin ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(root_cause, '') || ' ' || coalesce(symptom, '') || ' ' || coalesce(steps, '') || ' ' || coalesce(search_text, '')) gin_trgm_ops)`;
  await sql`
    CREATE TABLE IF NOT EXISTS app_role (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code varchar NOT NULL UNIQUE,
      name varchar NOT NULL,
      builtin boolean NOT NULL DEFAULT false,
      data_scope varchar NOT NULL DEFAULT 'assigned',
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  for (const role of DEFAULT_ROLES) {
    const [exists] = await db.select({ id: appRole.id }).from(appRole).where(eq(appRole.code, role.code)).limit(1);
    if (!exists) {
      await db.insert(appRole).values({
        code: role.code,
        name: role.name,
        builtin: role.builtin,
        dataScope: role.dataScope,
        permissions: role.permissions,
      });
    }
  }
  await sql`
    CREATE TABLE IF NOT EXISTS user_customer (
      user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      customer_id uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, customer_id)
    )`;
  await sql`
    UPDATE project
    SET git_auth_type = g.auth_type,
        git_username = COALESCE(project.git_username, g.git_username),
        git_token_enc = COALESCE(project.git_token_enc, g.token_enc),
        git_ssh_key_enc = COALESCE(project.git_ssh_key_enc, g.ssh_key_enc),
        git_host = COALESCE(project.git_host, g.known_hosts)
    FROM git_credential g
    WHERE project.git_auth_type = 'none'
      AND project.git_token_enc IS NULL
      AND project.git_ssh_key_enc IS NULL
      AND (NULLIF(g.token_enc, '') IS NOT NULL OR NULLIF(g.ssh_key_enc, '') IS NOT NULL)
  `.catch(() => undefined);
}
