-- AI 售后系统：全新 PostgreSQL 16 数据库初始化
-- 由 server/src/db/migrate.ts 在空库执行后的结构及内置角色导出。
-- 仅用于空库；已有数据库由应用启动迁移，不要重复导入。
-- 包含默认管理员 admin 的 scrypt 密码哈希（初始密码 admin123）；不含客户数据或密钥。
-- 导入：psql -X -v ON_ERROR_STOP=1 --single-transaction -d aftersale -f docs/sql/init.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: after_sale_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.after_sale_record (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying NOT NULL,
    customer_id uuid NOT NULL,
    title character varying NOT NULL,
    priority character varying DEFAULT 'p1'::character varying NOT NULL,
    priority_by character varying DEFAULT 'manual'::character varying NOT NULL,
    status character varying DEFAULT 'processing'::character varying NOT NULL,
    rounds integer DEFAULT 0 NOT NULL,
    conclusion text,
    handler_id uuid,
    thread_id character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    description text
);


--
-- Name: agent_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_id uuid NOT NULL,
    preset character varying DEFAULT 'investigate'::character varying NOT NULL,
    status character varying DEFAULT 'idle'::character varying NOT NULL,
    parent_session_id uuid,
    next_seq integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    execution_policy jsonb
);


--
-- Name: app_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_role (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying NOT NULL,
    name character varying NOT NULL,
    builtin boolean DEFAULT false NOT NULL,
    data_scope character varying DEFAULT 'assigned'::character varying NOT NULL,
    permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_user (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying NOT NULL,
    display_name character varying NOT NULL,
    password_hash character varying NOT NULL,
    role character varying DEFAULT 'engineer'::character varying NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    kind character varying NOT NULL,
    preview text NOT NULL,
    storage_path character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying NOT NULL,
    project_id uuid NOT NULL,
    branch character varying,
    tag character varying,
    env_ip character varying,
    workdir character varying,
    code_status character varying DEFAULT 'unknown'::character varying NOT NULL,
    code_synced_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_env; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_env (
    customer_id uuid NOT NULL,
    connect_type character varying DEFAULT 'ssh_compose'::character varying NOT NULL,
    workspace_path character varying,
    compose_path character varying,
    ssh_host character varying,
    ssh_user character varying,
    ssh_key_enc text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_repo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_repo (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    repo_name character varying NOT NULL,
    repo_url character varying NOT NULL,
    branch character varying,
    tag character varying,
    commit_id character varying,
    status character varying DEFAULT 'unknown'::character varying NOT NULL
);


--
-- Name: data_asset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_asset (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    name character varying NOT NULL,
    asset_type character varying NOT NULL,
    content text,
    file_url character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_counter; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_counter (
    prefix character varying NOT NULL,
    day character varying NOT NULL,
    value bigint NOT NULL
);


--
-- Name: git_credential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_credential (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    auth_type character varying DEFAULT 'ssh'::character varying NOT NULL,
    git_username character varying,
    token_enc text,
    ssh_key_enc text,
    known_hosts character varying,
    status character varying DEFAULT 'unknown'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying,
    title character varying NOT NULL,
    source_record_id uuid,
    customer_id uuid,
    category character varying,
    scope_project character varying,
    scope_version character varying,
    confidence character varying DEFAULT 'unverified'::character varying NOT NULL,
    status character varying DEFAULT 'ready'::character varying NOT NULL,
    tags jsonb,
    symptom text,
    root_cause text,
    evidence text,
    steps text,
    verify text,
    similar_desc text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    summary text,
    doc_path character varying,
    search_text text
);


--
-- Name: model_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider character varying DEFAULT 'openai_compatible'::character varying NOT NULL,
    model_name character varying NOT NULL,
    base_url character varying NOT NULL,
    api_key_enc text DEFAULT ''::text NOT NULL,
    max_context integer,
    temperature integer DEFAULT 0.2 NOT NULL,
    timeout_sec integer DEFAULT 120 NOT NULL,
    retry integer DEFAULT 2 NOT NULL,
    system_prompt text,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying NOT NULL,
    description text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    git_auth_type character varying DEFAULT 'none'::character varying NOT NULL,
    git_username character varying,
    git_token_enc text,
    git_ssh_key_enc text,
    git_host character varying
);


--
-- Name: project_repo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_repo (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    repo_name character varying NOT NULL,
    repo_url character varying NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: session_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    seq integer NOT NULL,
    type character varying NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: uploaded_file; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.uploaded_file (
    stored_name character varying NOT NULL,
    customer_id uuid,
    record_id uuid,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_customer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_customer (
    user_id uuid NOT NULL,
    customer_id uuid NOT NULL
);


--
-- Name: after_sale_record after_sale_record_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.after_sale_record
    ADD CONSTRAINT after_sale_record_code_key UNIQUE (code);


--
-- Name: after_sale_record after_sale_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.after_sale_record
    ADD CONSTRAINT after_sale_record_pkey PRIMARY KEY (id);


--
-- Name: agent_session agent_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_session
    ADD CONSTRAINT agent_session_pkey PRIMARY KEY (id);


--
-- Name: app_role app_role_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_role
    ADD CONSTRAINT app_role_code_key UNIQUE (code);


--
-- Name: app_role app_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_role
    ADD CONSTRAINT app_role_pkey PRIMARY KEY (id);


--
-- Name: app_user app_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_pkey PRIMARY KEY (id);


--
-- Name: app_user app_user_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_username_key UNIQUE (username);


--
-- Name: artifact artifact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact
    ADD CONSTRAINT artifact_pkey PRIMARY KEY (id);


--
-- Name: customer_env customer_env_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_env
    ADD CONSTRAINT customer_env_pkey PRIMARY KEY (customer_id);


--
-- Name: customer customer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer
    ADD CONSTRAINT customer_pkey PRIMARY KEY (id);


--
-- Name: customer_repo customer_repo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_repo
    ADD CONSTRAINT customer_repo_pkey PRIMARY KEY (id);


--
-- Name: data_asset data_asset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_asset
    ADD CONSTRAINT data_asset_pkey PRIMARY KEY (id);


--
-- Name: document_counter document_counter_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_counter
    ADD CONSTRAINT document_counter_pkey PRIMARY KEY (prefix, day);


--
-- Name: git_credential git_credential_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_credential
    ADD CONSTRAINT git_credential_pkey PRIMARY KEY (id);


--
-- Name: knowledge knowledge_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_code_key UNIQUE (code);


--
-- Name: knowledge knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_pkey PRIMARY KEY (id);


--
-- Name: model_config model_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_config
    ADD CONSTRAINT model_config_pkey PRIMARY KEY (id);


--
-- Name: project project_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project
    ADD CONSTRAINT project_pkey PRIMARY KEY (id);


--
-- Name: project_repo project_repo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_repo
    ADD CONSTRAINT project_repo_pkey PRIMARY KEY (id);


--
-- Name: session_event session_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_event
    ADD CONSTRAINT session_event_pkey PRIMARY KEY (id);


--
-- Name: uploaded_file uploaded_file_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uploaded_file
    ADD CONSTRAINT uploaded_file_pkey PRIMARY KEY (stored_name);


--
-- Name: user_customer user_customer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_customer
    ADD CONSTRAINT user_customer_pkey PRIMARY KEY (user_id, customer_id);


--
-- Name: knowledge_doc_search_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_doc_search_trgm ON public.knowledge USING gin (((((((((((((COALESCE(title, ''::character varying))::text || ' '::text) || COALESCE(summary, ''::text)) || ' '::text) || COALESCE(root_cause, ''::text)) || ' '::text) || COALESCE(symptom, ''::text)) || ' '::text) || COALESCE(steps, ''::text)) || ' '::text) || COALESCE(search_text, ''::text))) public.gin_trgm_ops);


--
-- Name: knowledge_search_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_search_fts ON public.knowledge USING gin (to_tsvector('simple'::regconfig, (((((((COALESCE(title, ''::character varying))::text || ' '::text) || COALESCE(summary, ''::text)) || ' '::text) || COALESCE(root_cause, ''::text)) || ' '::text) || COALESCE(symptom, ''::text))));


--
-- Name: session_event_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_event_lookup ON public.session_event USING btree (session_id, seq);


--
-- Name: after_sale_record after_sale_record_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.after_sale_record
    ADD CONSTRAINT after_sale_record_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(id);


--
-- Name: after_sale_record after_sale_record_handler_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.after_sale_record
    ADD CONSTRAINT after_sale_record_handler_id_fkey FOREIGN KEY (handler_id) REFERENCES public.app_user(id);


--
-- Name: agent_session agent_session_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_session
    ADD CONSTRAINT agent_session_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.after_sale_record(id) ON DELETE CASCADE;


--
-- Name: artifact artifact_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact
    ADD CONSTRAINT artifact_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.agent_session(id) ON DELETE CASCADE;


--
-- Name: customer_env customer_env_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_env
    ADD CONSTRAINT customer_env_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(id) ON DELETE CASCADE;


--
-- Name: customer customer_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer
    ADD CONSTRAINT customer_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.project(id);


--
-- Name: customer_repo customer_repo_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_repo
    ADD CONSTRAINT customer_repo_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(id) ON DELETE CASCADE;


--
-- Name: data_asset data_asset_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_asset
    ADD CONSTRAINT data_asset_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(id) ON DELETE CASCADE;


--
-- Name: knowledge knowledge_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(id);


--
-- Name: knowledge knowledge_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.after_sale_record(id);


--
-- Name: project_repo project_repo_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_repo
    ADD CONSTRAINT project_repo_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: session_event session_event_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_event
    ADD CONSTRAINT session_event_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.agent_session(id) ON DELETE CASCADE;


--
-- Name: uploaded_file uploaded_file_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uploaded_file
    ADD CONSTRAINT uploaded_file_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(id);


--
-- Name: uploaded_file uploaded_file_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uploaded_file
    ADD CONSTRAINT uploaded_file_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.after_sale_record(id);


--
-- Name: uploaded_file uploaded_file_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uploaded_file
    ADD CONSTRAINT uploaded_file_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.app_user(id);


--
-- Name: user_customer user_customer_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_customer
    ADD CONSTRAINT user_customer_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(id) ON DELETE CASCADE;


--
-- Name: user_customer user_customer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_customer
    ADD CONSTRAINT user_customer_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_user(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: app_role; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.app_role (id, code, name, builtin, data_scope, permissions, created_at, updated_at) VALUES ('cab0fa38-2149-4107-ac80-56fa9b5d9c7f', 'admin', '管理员', true, 'all', '["records.view", "records.write", "workbench.use", "customers.view", "customers.write", "customers.pull", "customers.ssh", "projects.view", "projects.write", "knowledge.view", "knowledge.write", "knowledge.delete", "settings.manage", "users.manage", "roles.manage"]', '2026-09-12 12:01:12.827357+00', '2026-09-12 12:01:12.827357+00');
INSERT INTO public.app_role (id, code, name, builtin, data_scope, permissions, created_at, updated_at) VALUES ('c4021353-e4fc-40a1-9239-4c2174c046de', 'engineer', '售后工程师', true, 'assigned', '["records.view", "records.write", "workbench.use", "customers.view", "customers.write", "customers.pull", "customers.ssh", "projects.view", "knowledge.view", "knowledge.write"]', '2026-09-12 12:01:12.830088+00', '2026-09-12 12:01:12.830088+00');
INSERT INTO public.app_role (id, code, name, builtin, data_scope, permissions, created_at, updated_at) VALUES ('a9bef81a-3c14-4090-8aa7-1bcdea2f63ea', 'viewer', '只读', true, 'assigned', '["records.view", "customers.view", "projects.view", "knowledge.view"]', '2026-09-12 12:01:12.832286+00', '2026-09-12 12:01:12.832286+00');


--
-- PostgreSQL database dump complete
--

-- 默认业务管理员。仅在账号不存在时创建，不覆盖现有密码。
-- 初始登录：admin / admin123；首次登录后在用户管理中修改密码。
INSERT INTO public.app_user (username, display_name, password_hash, role, active)
VALUES ('admin', '管理员', 'scrypt$567f6ca4f4fb38ac9db50cf0dd1a13b0$9f0b37a66d147493c40d4fffc278ecfa9f3f0da84f315db4326e77274d0111c1', 'admin', true)
ON CONFLICT (username) DO NOTHING;
