import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Context } from "hono";

import { guessMime, isImageMime, MAX_UPLOAD_BYTES } from "../agent/attachments.ts";
import { foldCacheUsage, measureContextBreakdown } from "../agent/context-meter.ts";
import { deriveMessages } from "../agent/session.ts";
import { ArtifactStore, createToolRegistry } from "../agent/tools/index.ts";
import { liveAgents } from "../agent/host.ts";
import { probeSsh, translateSshError } from "../agent/tools/ssh.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../shared/index.ts";

import { config } from "../config.ts";
import { decrypt, encrypt } from "../crypto.ts";
import { db } from "../db/client.ts";
import { nextDocumentCode } from "../db/numbering.ts";
import {
  afterSaleRecord,
  appUser,
  customer,
  customerEnv,
  customerRepo,
  dataAsset,
  gitCredential,
  knowledge,
  modelConfig,
  project,
  projectRepo,
  session,
  sessionEvent,
  userCustomer,
  uploadedFile,
} from "../db/schema.ts";
import { canSeeCustomer, canSeeRecord, currentAccess, currentUser, forbidUnlessCustomer, forbidUnlessRecord, visibleCustomerIds } from "./access.ts";
import { dual, iso, page } from "./legacy.ts";
import { probeModelConnection, resolveProbeConfig } from "./model-probe.ts";
import { countInvestigationRounds, recordRoundMap } from "./rounds.ts";
import {
  buildKnowledgeMarkdown,
  clipText,
  legacyMarkdown,
  readKnowledgeDoc,
  writeKnowledgeDoc,
  removeKnowledgeDoc,
} from "../knowledge/docs.ts";

const execFileAsync = promisify(execFile);

function gitCommandError(error: unknown): Error {
  const err = error as { message?: string; stderr?: string; stdout?: string };
  const detail = [err.stderr, err.stdout, err.message].map((part) => String(part || "").trim()).filter(Boolean).join("\n");
  return new Error(detail || "git 命令失败");
}

async function runGit(args: string[], opts: { env?: NodeJS.ProcessEnv; timeout?: number; cwd?: string }) {
  try {
    return await execFileAsync("git", args, opts);
  } catch (error) {
    throw gitCommandError(error);
  }
}

function translateGitError(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  if (/Authentication failed|Permission denied \(publickey\)|could not read Username|Invalid username or password/i.test(text)) {
    return "代码拉取失败：Git 认证失败，请在项目管理里配置该项目的授权信息。";
  }
  if (/Repository not found|not found/i.test(text) && /fatal|remote/i.test(text)) {
    return "代码拉取失败：仓库不存在或当前凭据无权访问。";
  }
  if (/Could not resolve host|Name or service not known/i.test(text)) {
    return "代码拉取失败：无法解析 Git 主机。";
  }
  if (/Could not read from remote|Connection refused|timed out|Network is unreachable/i.test(text)) {
    return "代码拉取失败：无法连接远程仓库。";
  }
  if (/Remote branch .+ not found|pathspec .+ did not match/i.test(text)) {
    return "代码拉取失败：指定分支在仓库中不存在。";
  }
  if (/代码拉取失败/.test(text)) return text;
  return `代码拉取失败：${text}`;
}

const SECRET_MASK = "******";

function modelTemperature(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0.2;
  if (raw <= 2) return raw || 0.2;
  return raw / 100;
}

function looksMasked(value: unknown): boolean {
  return !value || value === SECRET_MASK;
}

type ProjectRow = typeof project.$inferSelect;

function gitAuthValues(body: Record<string, any>, current: ProjectRow | null) {
  const authTypeRaw = body.gitAuthType ?? body.git_auth_type ?? current?.gitAuthType ?? "none";
  const authType = ["none", "ssh", "token"].includes(authTypeRaw) ? authTypeRaw : "none";
  const token = body.gitToken ?? body.git_token ?? body.token;
  const sshKey = body.gitSshKey ?? body.git_ssh_key ?? body.ssh_key ?? body.sshKey;
  return {
    gitAuthType: authType,
    gitUsername: String(body.gitUsername ?? body.git_username ?? current?.gitUsername ?? ""),
    gitHost: String(body.gitHost ?? body.git_host ?? current?.gitHost ?? ""),
    gitTokenEnc: looksMasked(token)
      ? (authType === "token" ? current?.gitTokenEnc ?? null : null)
      : (token ? encrypt(String(token)) : null),
    gitSshKeyEnc: looksMasked(sshKey)
      ? (authType === "ssh" ? current?.gitSshKeyEnc ?? null : null)
      : (sshKey ? encrypt(String(sshKey)) : null),
  };
}

function serializeProject(
  row: ProjectRow,
  repos: Array<{ id?: string; repoName?: string; repoUrl?: string }>,
  customerCount: number,
  includeSecrets = false,
) {
  const gitToken = decrypt(row.gitTokenEnc);
  const gitSshKey = decrypt(row.gitSshKeyEnc);
  return dual({
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    repos: repos.map((repo) => dual({ id: repo.id, repoName: repo.repoName, repoUrl: repo.repoUrl })),
    customerCount,
    createdAt: iso(row.createdAt),
    gitAuthType: row.gitAuthType || "none",
    gitUsername: row.gitUsername || "",
    gitHost: row.gitHost || "",
    hasToken: Boolean(gitToken),
    hasSshKey: Boolean(gitSshKey),
    gitToken: includeSecrets ? gitToken : "",
    gitSshKey: includeSecrets ? gitSshKey : "",
  });
}

function rewriteGitUrl(url: string, username: string, token: string): string {
  const ssh = url.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@${ssh[1]}/${ssh[2]}`;
  try {
    const parsed = new URL(url);
    parsed.username = username;
    parsed.password = token;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function httpsToSshGitUrl(url: string): string {
  const https = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (https) return `git@${https[1]}:${https[2].replace(/\.git$/i, "")}.git`;
  return url;
}

type GitAuth = { type: string; username?: string; token?: string; key?: string };

function resolveProjectAuth(body: Record<string, any>, current: ProjectRow | null): GitAuth {
  const authTypeRaw = body.gitAuthType ?? body.git_auth_type ?? current?.gitAuthType ?? "none";
  const authType = ["none", "ssh", "token"].includes(authTypeRaw) ? authTypeRaw : "none";
  const tokenRaw = body.gitToken ?? body.git_token ?? body.token;
  const sshRaw = body.gitSshKey ?? body.git_ssh_key ?? body.ssh_key ?? body.sshKey;
  return {
    type: authType,
    username: String(body.gitUsername ?? body.git_username ?? current?.gitUsername ?? "git") || "git",
    token: authType === "token" ? (looksMasked(tokenRaw) ? decrypt(current?.gitTokenEnc) : String(tokenRaw || "")) : "",
    key: authType === "ssh" ? (looksMasked(sshRaw) ? decrypt(current?.gitSshKeyEnc) : String(sshRaw || "")) : "",
  };
}

async function withGitRemote<T>(url: string, auth: GitAuth, fn: (remote: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  let keyDir = "";
  const env = { ...process.env };
  let remote = url;
  try {
    if (auth.type === "token" && auth.token) {
      remote = rewriteGitUrl(url, auth.username || "git", auth.token);
    } else if (auth.type === "ssh" && auth.key) {
      remote = httpsToSshGitUrl(url);
      keyDir = await mkdtemp(path.join(os.tmpdir(), "aftersale-git-"));
      const keyPath = path.join(keyDir, "id_key");
      await writeFile(keyPath, auth.key.endsWith("\n") ? auth.key : `${auth.key}\n`, { mode: 0o600 });
      env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    }
    return await fn(remote, env);
  } finally {
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  }
}

async function hasUsableCheckout(dest: string): Promise<boolean> {
  if (!existsSync(path.join(dest, ".git"))) return false;
  try {
    const { stdout } = await execFileAsync("git", ["-C", dest, "rev-parse", "--verify", "HEAD"], { timeout: 5_000 });
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

async function clearBrokenCheckout(dest: string) {
  try {
    const st = await lstat(dest);
    const usable = await hasUsableCheckout(dest);
    if (usable) return;
    await rm(dest, { recursive: !st.isSymbolicLink(), force: true });
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function syncRepo(url: string, dest: string, auth: GitAuth, branch?: string) {
  const ref = branch?.trim() || "";
  return withGitRemote(url, auth, async (remote, env) => {
    await clearBrokenCheckout(dest);
    if (await hasUsableCheckout(dest)) {
      await runGit(["-C", dest, "remote", "set-url", "origin", remote], { env, timeout: 15_000 });
      await runGit(ref ? ["-C", dest, "fetch", "--depth", "1", "origin", ref] : ["-C", dest, "fetch", "--depth", "1"], { env, timeout: 120_000 });
      if (ref) {
        await runGit(["-C", dest, "checkout", "-B", ref, "FETCH_HEAD"], { env, timeout: 15_000 });
      }
      await runGit(["-C", dest, "remote", "set-url", "origin", url], { env, timeout: 15_000 }).catch(() => undefined);
    } else {
      const cloneArgs = ["clone", "--depth", "1"];
      if (ref) cloneArgs.push("--branch", ref);
      cloneArgs.push(remote, dest);
      await runGit(cloneArgs, { env, timeout: 180_000 });
      if (remote !== url) {
        await runGit(["-C", dest, "remote", "set-url", "origin", url], { env, timeout: 15_000 }).catch(() => undefined);
      }
    }
    return readRepoHead(dest);
  });
}

async function readRepoHead(dest: string): Promise<{ commitId: string; branch: string }> {
  const { stdout: commitId } = await runGit(["-C", dest, "rev-parse", "--short=8", "HEAD"], { timeout: 5_000 });
  const { stdout: branch } = await runGit(["-C", dest, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 5_000 });
  return { commitId: commitId.trim(), branch: branch.trim() };
}

async function probeGitRemote(url: string, auth: GitAuth) {
  await withGitRemote(url, auth, async (remote, env) => {
    await execFileAsync("git", ["ls-remote", "--heads", remote], { env, timeout: 25_000 });
  });
}

function q(c: Context) {
  return {
    page: Math.max(1, Number(c.req.query("page") || 1)),
    pageSize: Math.min(100, Math.max(1, Number(c.req.query("page_size") || c.req.query("pageSize") || 10))),
    keyword: (c.req.query("keyword") || "").trim(),
  };
}

async function assignedProjectIds(customerIds: string[]): Promise<string[]> {
  if (!customerIds.length) return [];
  const rows = await db
    .select({ projectId: customer.projectId })
    .from(customer)
    .where(and(isNull(customer.deletedAt), inArray(customer.id, customerIds)));
  return [...new Set(rows.map((row) => row.projectId).filter(Boolean))];
}

export async function listProjects(c: Context) {
  const { page: pageNo, pageSize, keyword } = q(c);
  const allowed = await visibleCustomerIds(c);
  const scopedIds = allowed === null ? null : await assignedProjectIds(allowed);
  if (scopedIds && !scopedIds.length) {
    return c.json(page([], 0, pageNo, pageSize, { repoTotal: 0, customerTotal: 0, repo_total: 0, customer_total: 0 }));
  }
  const where = and(
    isNull(project.deletedAt),
    scopedIds ? inArray(project.id, scopedIds) : undefined,
    keyword ? or(ilike(project.name, `%${keyword}%`)) : undefined,
  );
  const [{ value: total }] = await db.select({ value: count() }).from(project).where(where);
  const rows = await db.select().from(project).where(where).orderBy(desc(project.createdAt)).limit(pageSize).offset((pageNo - 1) * pageSize);
  const items = [];
  for (const row of rows) {
    const repos = await db.select().from(projectRepo).where(eq(projectRepo.projectId, row.id));
    const customerWhere = and(
      eq(customer.projectId, row.id),
      isNull(customer.deletedAt),
      allowed ? inArray(customer.id, allowed) : undefined,
    );
    const [{ value: customerCount }] = await db.select({ value: count() }).from(customer).where(customerWhere);
    items.push(serializeProject(row, repos, customerCount, currentAccess(c).has("settings.manage")));
  }
  const repoWhere = scopedIds ? inArray(projectRepo.projectId, scopedIds) : undefined;
  const [{ value: repoTotal }] = await db.select({ value: count() }).from(projectRepo).where(repoWhere);
  const customerTotalWhere = and(
    isNull(customer.deletedAt),
    allowed ? inArray(customer.id, allowed) : undefined,
  );
  const [{ value: customerTotal }] = await db.select({ value: count() }).from(customer).where(customerTotalWhere);
  return c.json(page(items, Number(total), pageNo, pageSize, { repoTotal, customerTotal, repo_total: repoTotal, customer_total: customerTotal }));
}

export async function createProject(c: Context) {
  const body = await c.req.json();
  const [row] = await db.insert(project).values({
    name: body.name,
    description: body.description || "",
    ...gitAuthValues(body, null),
  }).returning();
  const repos = (body.repos || []).map((repo: any, index: number) => ({
    projectId: row.id,
    repoName: repo.repoName || repo.repo_name,
    repoUrl: repo.repoUrl || repo.repo_url,
    sortOrder: index,
  }));
  if (repos.length) await db.insert(projectRepo).values(repos);
  return c.json(serializeProject(row, repos, 0));
}

export async function updateProject(c: Context) {
  const id = requiredParam(c, "id");
  const body = await c.req.json();
  const [current] = await db.select().from(project).where(eq(project.id, id)).limit(1);
  if (!current) return c.json({ detail: "项目不存在" }, 404);
  await db.update(project).set({
    name: body.name,
    description: body.description,
    ...gitAuthValues(body, current),
    updatedAt: new Date(),
  }).where(eq(project.id, id));
  await db.delete(projectRepo).where(eq(projectRepo.projectId, id));
  const repos = (body.repos || []).map((repo: any, index: number) => ({
    projectId: id,
    repoName: repo.repoName || repo.repo_name,
    repoUrl: repo.repoUrl || repo.repo_url,
    sortOrder: index,
  }));
  if (repos.length) await db.insert(projectRepo).values(repos);
  return c.json({ ok: true });
}

export async function testProjectGit(c: Context) {
  const body = await c.req.json();
  const projectId = body.projectId || body.project_id;
  const [current] = projectId
    ? await db.select().from(project).where(eq(project.id, projectId)).limit(1)
    : [undefined];
  const auth = resolveProjectAuth(body, current || null);
  if (auth.type === "ssh" && !auth.key) {
    return c.json({ ok: false, detail: current ? "已保存的 SSH 私钥无法解密，请重新粘贴后再测试" : "请填写 SSH 私钥后再测试" }, 400);
  }
  if (auth.type === "token" && !auth.token) return c.json({ ok: false, detail: "请填写 Access Token 后再测试" }, 400);
  const url = String(body.repoUrl || body.repo_url || body.repos?.[0]?.repoUrl || body.repos?.[0]?.repo_url || "").trim();
  if (!url) return c.json({ ok: false, detail: "请先填写或识别至少一个仓库地址" }, 400);
  try {
    await probeGitRemote(url, auth);
    const message = auth.type === "none" ? "公开仓库可访问" : "授权有效，已连通仓库";
    return c.json({ ok: true, message });
  } catch (error) {
    const detail = translateGitError(error);
    return c.json({ ok: false, detail, error: detail }, 400);
  }
}

export async function parseRepos(c: Context) {
  const body = await c.req.json();
  const text = String(body.text || "");
  const urls = text.split(/[\s,，]+/).filter((item) => /^(git@|https?:\/\/|ssh:\/\/)/i.test(item));
  return c.json({ items: urls.map((repoUrl) => ({ repoUrl, repo_url: repoUrl, repoName: repoUrl.split(/[/:]/).pop()?.replace(/\.git$/i, ""), repo_name: repoUrl.split(/[/:]/).pop()?.replace(/\.git$/i, "") })) });
}

export async function listCustomers(c: Context) {
  const { page: pageNo, pageSize, keyword } = q(c);
  const allowed = await visibleCustomerIds(c);
  const rows = await db.select().from(customer).where(isNull(customer.deletedAt)).orderBy(desc(customer.createdAt));
  const filtered = [];
  for (const row of rows) {
    if (!canSeeCustomer(allowed, row.id)) continue;
    const [proj] = await db.select().from(project).where(eq(project.id, row.projectId)).limit(1);
    if (keyword && ![row.name, proj?.name, row.branch, row.tag, row.envIp].some((value) => value?.includes(keyword))) continue;
    filtered.push({ row, proj });
  }
  const slice = filtered.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  const items = [];
  for (const { row, proj } of slice) {
    const repos = await db.select().from(customerRepo).where(eq(customerRepo.customerId, row.id));
    const assets = await db.select().from(dataAsset).where(eq(dataAsset.customerId, row.id));
    items.push(await serializeCustomer(row, proj?.name, repos, assets));
  }
  return c.json(page(items, filtered.length, pageNo, pageSize));
}

export async function getCustomer(c: Context) {
  const id = requiredParam(c, "id");
  const [row] = await db.select().from(customer).where(eq(customer.id, id)).limit(1);
  if (!row) return c.json({ detail: "客户不存在" }, 404);
  const denied = await forbidUnlessCustomer(c, row.id);
  if (denied) return denied;
  const [proj] = await db.select().from(project).where(eq(project.id, row.projectId)).limit(1);
  const repos = await db.select().from(customerRepo).where(eq(customerRepo.customerId, row.id));
  const assets = await db.select().from(dataAsset).where(eq(dataAsset.customerId, row.id));
  const access = currentAccess(c);
  return c.json(await serializeCustomer(row, proj?.name, repos, assets, access.has("customers.write") || access.has("customers.ssh")));
}

export async function createCustomer(c: Context) {
  const body = await c.req.json();
  const [row] = await db.insert(customer).values({
    name: body.name,
    projectId: body.projectId || body.project_id,
    branch: body.branch,
    tag: body.tag,
    envIp: body.envIp || body.env_ip,
    workdir: body.workdir,
    codeStatus: "unknown",
  }).returning();
  await applyCustomerChildren(row.id, body);
  const actor = currentUser(c);
  if (!currentAccess(c).allCustomers) {
    await db.insert(userCustomer).values({ userId: actor.id, customerId: row.id });
  }
  const [proj] = await db.select().from(project).where(eq(project.id, row.projectId)).limit(1);
  const repos = await db.select().from(customerRepo).where(eq(customerRepo.customerId, row.id));
  const assets = await db.select().from(dataAsset).where(eq(dataAsset.customerId, row.id));
  return c.json(await serializeCustomer(row, proj?.name, repos, assets, true));
}

export async function updateCustomer(c: Context) {
  const id = requiredParam(c, "id");
  const denied = await forbidUnlessCustomer(c, id);
  if (denied) return denied;
  const body = await c.req.json();
  await db.update(customer).set({
    name: body.name,
    projectId: body.projectId || body.project_id,
    branch: body.branch,
    tag: body.tag,
    envIp: body.envIp || body.env_ip,
    workdir: body.workdir,
    updatedAt: new Date(),
  }).where(eq(customer.id, id));
  await db.delete(customerRepo).where(eq(customerRepo.customerId, id));
  await db.delete(dataAsset).where(eq(dataAsset.customerId, id));
  await applyCustomerChildren(id, body);
  return getCustomer(c);
}

async function applyCustomerChildren(customerId: string, body: any) {
  const repos = body.repos || [];
  if (repos.length) {
    await db.insert(customerRepo).values(repos.map((repo: any) => ({
      customerId,
      repoName: repo.repoName || repo.repo_name,
      repoUrl: repo.repoUrl || repo.repo_url,
      branch: repo.branch,
      tag: repo.tag,
      commitId: repo.commitId || repo.commit_id || null,
      status: repo.status || "unknown",
    })));
  }
  const assets = body.assets || [];
  if (assets.length) {
    await db.insert(dataAsset).values(assets.filter((asset: any) => asset.name).map((asset: any) => ({
      customerId,
      name: asset.name,
      assetType: asset.assetType || asset.asset_type || "other",
      content: asset.content,
      fileUrl: asset.fileUrl || asset.file_url,
    })));
  }
  if (body.env) {
    const [existing] = await db.select().from(customerEnv).where(eq(customerEnv.customerId, customerId)).limit(1);
    const incoming = body.env.sshKey || body.env.ssh_key;
    const sshKeyEnc = incoming && incoming !== "******" ? encrypt(incoming) : existing?.sshKeyEnc || "";
    await db.delete(customerEnv).where(eq(customerEnv.customerId, customerId));
    const now = new Date();
    await db.insert(customerEnv).values({
      customerId,
      connectType: body.env.connectType || body.env.connect_type || "ssh_compose",
      sshUser: body.env.sshUser || body.env.ssh_user,
      sshKeyEnc,
      sshHost: body.envIp || body.env_ip,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
  }
}

async function serializeCustomer(row: typeof customer.$inferSelect, projectName: string | undefined, repos: any[], assets: any[], includeSshKey = false) {
  const [env] = await db.select().from(customerEnv).where(eq(customerEnv.customerId, row.id)).limit(1);
  const sshKey = includeSshKey ? decrypt(env?.sshKeyEnc) : "";
  return dual({
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    projectName,
    branch: row.branch,
    tag: row.tag,
    envIp: row.envIp,
    workdir: row.workdir,
    codeStatus: row.codeStatus,
    codeSyncedAt: iso(row.codeSyncedAt),
    repos: repos.map((repo) => dual({ id: repo.id, repoName: repo.repoName, repoUrl: repo.repoUrl, branch: repo.branch, tag: repo.tag, commitId: repo.commitId, status: repo.status })),
    assets: assets.map((asset) => dual({ id: asset.id, name: asset.name, assetType: asset.assetType, content: asset.content, fileUrl: asset.fileUrl })),
    env: { sshUser: env?.sshUser || "", sshKey },
    createdAt: iso(row.createdAt),
  });
}

export async function pullCode(c: Context) {
  const id = requiredParam(c, "id");
  const [row] = await db.select().from(customer).where(eq(customer.id, id)).limit(1);
  if (!row) return c.json({ detail: "客户不存在" }, 404);
  const denied = await forbidUnlessCustomer(c, row.id);
  if (denied) return denied;
  const [proj] = await db.select().from(project).where(eq(project.id, row.projectId)).limit(1);
  const authType = proj?.gitAuthType || "none";
  const auth = {
    type: authType,
    username: proj?.gitUsername || "git",
    token: authType === "token" ? decrypt(proj?.gitTokenEnc) : "",
    key: authType === "ssh" ? decrypt(proj?.gitSshKeyEnc) : "",
  };
  await db.update(customer).set({ codeStatus: "pulling" }).where(eq(customer.id, id));
  const repos = await db.select().from(customerRepo).where(eq(customerRepo.customerId, id));
  const root = path.join(config.dataRoot, row.projectId, row.id, "_latest");
  await mkdir(root, { recursive: true });
  try {
    const pulled = [];
    for (const repo of repos) {
      const dest = path.join(root, repo.repoName);
      const head = await syncRepo(repo.repoUrl, dest, auth, repo.branch || row.branch || undefined);
      await db.update(customerRepo).set({
        commitId: head.commitId,
        status: "updated",
      }).where(eq(customerRepo.id, repo.id));
      pulled.push(dual({
        repoName: repo.repoName,
        commitId: head.commitId,
        branch: repo.branch || row.branch || head.branch,
        status: "updated",
      }));
    }
    const syncedAt = new Date();
    await db.update(customer).set({ codeStatus: "updated", codeSyncedAt: syncedAt }).where(eq(customer.id, id));
    return c.json(dual({ ok: true, status: "updated", syncedAt: iso(syncedAt), repos: pulled }));
  } catch (error) {
    await db.update(customer).set({ codeStatus: "unknown" }).where(eq(customer.id, id));
    return c.json({ ok: false, error: translateGitError(error) }, 500);
  }
}

export async function testSsh(c: Context) {
  const id = requiredParam(c, "id");
  const [row] = await db.select().from(customer).where(eq(customer.id, id)).limit(1);
  if (!row) return c.json({ detail: "客户不存在" }, 404);
  const denied = await forbidUnlessCustomer(c, row.id);
  if (denied) return denied;
  const [env] = await db.select().from(customerEnv).where(eq(customerEnv.customerId, id)).limit(1);
  const privateKey = decrypt(env?.sshKeyEnc);
  if (!row.envIp) return c.json({ ok: false, configured: false, hasKey: Boolean(privateKey), detail: "未配置环境 IP", error: "未配置环境 IP" }, 400);
  if (!privateKey) return c.json({ ok: false, configured: true, hasKey: false, detail: "未配置 SSH 私钥", error: "未配置 SSH 私钥" }, 400);
  const [host, portText] = row.envIp.split(":");
  const port = Number(portText || 22);
  const username = env?.sshUser || "root";
  try {
    await probeSsh({ host, port, username, privateKey });
    return c.json({ ok: true, configured: true, hasKey: true, user: username, host, port, output: `已登录 ${username}@${host}:${port}` });
  } catch (error) {
    const message = translateSshError(error);
    return c.json({ ok: false, configured: true, hasKey: true, user: username, host, port, error: message, detail: message }, 400);
  }
}

export async function listRecords(c: Context) {
  const { page: pageNo, pageSize, keyword } = q(c);
  const priority = c.req.query("priority");
  const status = c.req.query("status");
  const allowed = await visibleCustomerIds(c);
  const rows = await db.select().from(afterSaleRecord).orderBy(desc(afterSaleRecord.createdAt));
  const roundsByRecord = await recordRoundMap();
  const items = [];
  for (const row of rows) {
    if (!canSeeCustomer(allowed, row.customerId)) continue;
    if (!canSeeRecord(currentAccess(c), currentUser(c).id, row.handlerId)) continue;
    if (priority && row.priority !== priority) continue;
    if (status === "closed" && row.status !== "closed") continue;
    if (status === "processing" && row.status === "closed") continue;
    const [cust] = await db.select().from(customer).where(eq(customer.id, row.customerId)).limit(1);
    if (keyword && ![row.title, row.description, row.code, cust?.name].some((value) => value?.includes(keyword))) continue;
    items.push(dual({
      id: row.id,
      code: row.code,
      customerId: row.customerId,
      customerName: cust?.name,
      title: row.title,
      description: row.description || "",
      priority: row.priority,
      status: row.status === "closed" ? "closed" : "processing",
      rounds: roundsByRecord.get(row.id) ?? row.rounds,
      handlerName: await handlerNameOf(row.handlerId),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    }));
  }
  const slice = items.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return c.json(page(slice, items.length, pageNo, pageSize));
}

async function handlerNameOf(handlerId?: string | null) {
  if (!handlerId) return undefined;
  const [handler] = await db.select().from(appUser).where(eq(appUser.id, handlerId)).limit(1);
  return handler?.displayName || handler?.username;
}

async function claimRecordHandler(recordId: string, userId: string) {
  const [row] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, recordId)).limit(1);
  if (!row) return null;
  if (row.handlerId) return row;
  const [updated] = await db.update(afterSaleRecord)
    .set({ handlerId: userId, updatedAt: new Date() })
    .where(eq(afterSaleRecord.id, recordId))
    .returning();
  return updated ?? row;
}

async function loadRecordEvents(recordId: string) {
  const sessions = await db.select().from(session).where(eq(session.recordId, recordId)).orderBy(session.createdAt);
  const events = [];
  for (const item of sessions) {
    const rows = await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, item.id));
    rows.sort((a, b) => a.seq - b.seq);
    events.push(...rows.map((row) => ({ ...row, sessionId: item.id })));
  }
  return events;
}

export async function getRecord(c: Context) {
  const id = requiredParam(c, "id");
  const [row] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, id)).limit(1);
  if (!row) return c.json({ detail: "工单不存在" }, 404);
  const denied = await forbidUnlessRecord(c, row);
  if (denied) return denied;
  const claimed = await claimRecordHandler(id, currentUser(c).id) ?? row;
  const [cust] = await db.select().from(customer).where(eq(customer.id, claimed.customerId)).limit(1);
  const events = await loadRecordEvents(id);
  const messages = [];
  for (const event of events) {
    if (event.type === "user/message" && ((event.data as any)?.source === "human" || !(event.data as any)?.source)) {
      messages.push({
        id: `u-${event.sessionId}-${event.seq}`,
        role: "user",
        content: String((event.data as any)?.content || ""),
        created_at: iso(event.createdAt),
      });
    }
    if (event.type === "assistant/message") {
      messages.push({
        id: `a-${event.sessionId}-${event.seq}`,
        role: "ai",
        content: String((event.data as any)?.content || ""),
        created_at: iso(event.createdAt),
      });
    }
  }
  return c.json(dual({
    ...claimed,
    status: claimed.status === "closed" ? "closed" : "processing",
    customerName: cust?.name,
    customer_id: claimed.customerId,
    created_at: iso(claimed.createdAt),
    updated_at: iso(claimed.updatedAt),
    rounds: countInvestigationRounds(events),
    handlerName: await handlerNameOf(claimed.handlerId),
    messages,
  }));
}

export async function createRecord(c: Context) {
  const body = await c.req.json();
  const customerId = String(body.customerId || body.customer_id || "");
  const denied = await forbidUnlessCustomer(c, customerId);
  if (denied) return denied;
  const now = new Date();
  const [row] = await db.insert(afterSaleRecord).values({
    id: crypto.randomUUID(),
    code: await nextDocumentCode("AS", now),
    customerId,
    title: body.title,
    description: String(body.description || body.question || "").trim() || null,
    priority: body.priority || "p1",
    priorityBy: "manual",
    status: "processing",
    rounds: 0,
    handlerId: currentUser(c).id,
    threadId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  }).returning();
  return c.json(dual({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }));
}

export async function closeRecord(c: Context) {
  const [row] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, requiredParam(c, "id"))).limit(1);
  if (!row) return c.json({ detail: "工单不存在" }, 404);
  const denied = await forbidUnlessRecord(c, row);
  if (denied) return denied;
  await db.update(afterSaleRecord).set({ status: "closed", updatedAt: new Date() }).where(eq(afterSaleRecord.id, row.id));
  const sessions = await db.select({ id: session.id }).from(session).where(eq(session.recordId, row.id));
  for (const item of sessions) {
    liveAgents.get(item.id)?.loop.cancel();
    await db.update(session).set({ status: "idle", updatedAt: new Date() }).where(eq(session.id, item.id));
  }
  return c.json({ ok: true });
}

export async function customerReply(c: Context) {
  const id = requiredParam(c, "id");
  const [row] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, id)).limit(1);
  if (!row) return c.json({ detail: "工单不存在" }, 404);
  const denied = await forbidUnlessRecord(c, row);
  if (denied) return denied;
  const events = await loadRecordEvents(id);
  const last = [...events].reverse().find((event) => event.type === "assistant/message");
  const reply = String((last?.data as any)?.content || "").trim()
    || `关于「${row.title}」，我们仍在排查，确认根因后会同步处理结论。`;
  return c.json({ ok: true, reply });
}

export async function recordContext(c: Context) {
  const id = requiredParam(c, "id");
  const [row] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, id)).limit(1);
  if (!row) return c.json({ detail: "工单不存在" }, 404);
  const denied = await forbidUnlessRecord(c, row);
  if (denied) return denied;

  const [latest] = await db.select().from(session).where(eq(session.recordId, id)).orderBy(desc(session.createdAt)).limit(1);
  let rawEvents = latest
    ? (await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, latest.id))).sort((a, b) => a.seq - b.seq)
    : [];
  if (!rawEvents.length) rawEvents = await loadRecordEvents(id);
  const events = rawEvents.map((event) => ({
    seq: event.seq,
    type: event.type,
    data: (event.data || {}) as Record<string, unknown>,
  }));
  const messages = deriveMessages(events);
  const [model] = await db.select().from(modelConfig).limit(1);
  const [cust] = await db.select().from(customer).where(eq(customer.id, row.customerId)).limit(1);
  const [env] = cust ? await db.select().from(customerEnv).where(eq(customerEnv.customerId, cust.id)).limit(1) : [undefined];

  const extra = [row.title, row.conclusion, cust?.envIp, cust?.workdir].filter(Boolean).join("\n");
  const system = [(model?.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim(), extra].filter(Boolean).join("\n\n");
  const tools = createToolRegistry({
    reposDir: "/tmp",
    artifacts: new ArtifactStore("/tmp"),
    customerId: row.customerId,
    ssh: null,
    searchKnowledge: async () => [],
  }).schemas();
  const request = events.findLast((event) => event.type === "request/header")?.data;
  const snapshot = request?.model as { maxContext?: number; modelName?: string } | undefined;
  const measured = request?.context as ReturnType<typeof measureContextBreakdown> | undefined;
  const breakdown = measured?.usedTokens != null ? measured : measureContextBreakdown({ system, tools, messages });
  const cache = foldCacheUsage(events);
  const configured = Number(snapshot?.maxContext ?? model?.maxContext);
  const maxTokens = configured > 1000 ? configured : 128000;
  const keptMessages = messages.filter((message) => message.role === "user" || message.role === "assistant").length;
  return c.json(dual({
    usedTokens: breakdown.usedTokens,
    maxTokens,
    percent: Math.min(100, (breakdown.usedTokens / maxTokens) * 100),
    systemTokens: breakdown.systemTokens,
    toolsTokens: breakdown.toolsTokens,
    messageTokens: breakdown.messageTokens,
    promptTokens: cache.promptTokens,
    cachedTokens: cache.cachedTokens,
    cacheHitPercent: cache.cacheHitPercent,
    keptMessages,
    compressedMessages: events.filter((event) => event.type === "context/checkpoint").reduce((sum, event) => sum + Number(event.data.removed || 0), 0),
    modelName: snapshot?.modelName ?? model?.modelName,
    measurementSource: measured ? "last-request" : "estimate",
    channels: {
      code: true,
      ssh: Boolean(cust?.envIp && env?.sshKeyEnc),
      env: Boolean(cust?.envIp),
      assets: true,
    },
    multimodal: true,
  }));
}

export async function listKnowledge(c: Context) {
  const { page: pageNo, pageSize, keyword } = q(c);
  const allowed = await visibleCustomerIds(c);
  const rows = await db.select().from(knowledge).where(isNull(knowledge.deletedAt)).orderBy(desc(knowledge.createdAt));
  const items = [];
  for (const row of rows) {
    if (!canSeeCustomer(allowed, row.customerId)) continue;
    const summary = clipText(row.summary || row.rootCause || row.symptom || row.title, 120);
    if (keyword && ![row.code, row.title, summary].some((value) => value?.includes(keyword))) continue;
    const [cust] = row.customerId
      ? await db.select().from(customer).where(eq(customer.id, row.customerId)).limit(1)
      : [undefined];
    items.push(dual({
      id: row.id,
      code: row.code || `K-${row.id.slice(0, 8)}`,
      title: row.title,
      summary,
      docPath: row.docPath,
      sourceRecordId: row.sourceRecordId,
      customerId: row.customerId,
      customerName: cust?.name,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    }));
  }
  const slice = items.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return c.json(page(slice, items.length, pageNo, pageSize));
}

export async function getKnowledge(c: Context) {
  const [row] = await db.select().from(knowledge).where(eq(knowledge.id, requiredParam(c, "id"))).limit(1);
  if (!row) return c.json({ detail: "知识不存在" }, 404);
  if (row.customerId) {
    const denied = await forbidUnlessCustomer(c, row.customerId);
    if (denied) return denied;
  }
  const markdown = (await readKnowledgeDoc(row.docPath))
    || legacyMarkdown({
      title: row.title,
      symptom: row.symptom,
      rootCause: row.rootCause,
      steps: row.steps,
      summary: row.summary,
    });
  const [cust] = row.customerId
    ? await db.select().from(customer).where(eq(customer.id, row.customerId)).limit(1)
    : [undefined];
  return c.json(dual({
    id: row.id,
    code: row.code || `K-${row.id.slice(0, 8)}`,
    title: row.title,
    summary: row.summary || clipText(row.rootCause || row.symptom || markdown),
    docPath: row.docPath,
    markdown,
    sourceRecordId: row.sourceRecordId,
    customerId: row.customerId,
    customerName: cust?.name,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }));
}

export async function updateKnowledge(c: Context) {
  const id = requiredParam(c, "id");
  const [row] = await db.select().from(knowledge).where(eq(knowledge.id, id)).limit(1);
  if (!row || row.deletedAt) return c.json({ detail: "知识不存在" }, 404);
  if (row.customerId) {
    const denied = await forbidUnlessCustomer(c, row.customerId);
    if (denied) return denied;
  }
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const title = String(body.title || row.title).trim() || row.title;
  const currentMd = (await readKnowledgeDoc(row.docPath)) || "";
  const markdown = body.markdown != null ? String(body.markdown) : currentMd;
  const summary = clipText(String(body.summary || markdown || row.summary || title), 180);
  const docPath = await writeKnowledgeDoc(row.id, markdown);
  await db.update(knowledge).set({ title, summary, docPath, updatedAt: new Date() }).where(eq(knowledge.id, row.id));
  return getKnowledge(c);
}

export async function publishKnowledge(c: Context) {
  const id = requiredParam(c, "id");
  const [row] = await db.select().from(knowledge).where(eq(knowledge.id, id)).limit(1);
  if (!row || row.deletedAt) return c.json({ detail: "知识不存在" }, 404);
  if (row.customerId) {
    const denied = await forbidUnlessCustomer(c, row.customerId);
    if (denied) return denied;
  }
  await db.update(knowledge).set({ status: "published", updatedAt: new Date() }).where(eq(knowledge.id, row.id));
  return c.json({ ok: true, status: "published" });
}

export async function deleteKnowledge(c: Context) {
  const [row] = await db.select().from(knowledge).where(eq(knowledge.id, requiredParam(c, "id"))).limit(1);
  if (!row || row.deletedAt) return c.json({ detail: "知识不存在" }, 404);
  await removeKnowledgeDoc(row.docPath);
  await db.update(knowledge).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(knowledge.id, row.id));
  return c.json({ ok: true });
}

export async function knowledgeFromRecord(c: Context) {
  const recordId = requiredParam(c, "id");
  const [row] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, recordId)).limit(1);
  if (!row) return c.json({ detail: "工单不存在" }, 404);
  const denied = await forbidUnlessRecord(c, row);
  if (denied) return denied;
  const [cust] = await db.select().from(customer).where(eq(customer.id, row.customerId)).limit(1);
  const [proj] = cust?.projectId
    ? await db.select().from(project).where(eq(project.id, cust.projectId)).limit(1)
    : [undefined];
  const events = await loadRecordEvents(recordId);
  const messages: Array<{ role: string; content: string }> = [];
  for (const event of events) {
    const data = (event.data || {}) as Record<string, unknown>;
    if (event.type === "user/message" && (data.source === "human" || !data.source)) {
      messages.push({ role: "user", content: String(data.content || "") });
    }
    if (event.type === "assistant/message") {
      const toolCalls = data.toolCalls;
      if (Array.isArray(toolCalls) && toolCalls.length) continue;
      messages.push({ role: "ai", content: String(data.content || "") });
    }
  }
  const lastAi = [...messages].reverse().find((item) => item.role === "ai" && item.content.trim());
  const conclusion = String(row.conclusion || lastAi?.content || "").trim();
  const summary = clipText(conclusion, 180) || row.title;
  const markdown = buildKnowledgeMarkdown({
    title: row.title,
    code: row.code || undefined,
    customerName: cust?.name,
    projectName: proj?.name,
    summary,
    conclusion,
    messages,
  });
  const now = new Date();
  const [existing] = await db.select().from(knowledge).where(eq(knowledge.sourceRecordId, row.id)).limit(1);
  const id = existing?.id || crypto.randomUUID();
  const docPath = await writeKnowledgeDoc(id, markdown);
  const values = {
    title: row.title,
    sourceRecordId: row.id,
    customerId: row.customerId,
    summary,
    docPath,
    status: "ready",
    confidence: "unverified",
    updatedAt: now,
    code: existing?.code || await nextDocumentCode("K", now),
  };
  const [saved] = existing
    ? await db.update(knowledge).set(values).where(eq(knowledge.id, id)).returning()
    : await db.insert(knowledge).values({ id, ...values, searchText: markdown, createdAt: now }).returning();
  return c.json(dual({
    ...saved,
    markdown,
    createdAt: iso(saved.createdAt),
    updatedAt: iso(saved.updatedAt),
  }));
}

export async function getModelConfig(c: Context) {
  const [row] = await db.select().from(modelConfig).orderBy(desc(modelConfig.isDefault)).limit(1);
  if (!row) return c.json({});
  if (!currentAccess(c).has("settings.manage")) {
    return c.json(dual({ modelName: row.modelName, enabled: row.enabled }));
  }
  const apiKey = decrypt(row.apiKeyEnc);
  return c.json(dual({
    id: row.id,
    provider: row.provider,
    modelName: row.modelName,
    baseUrl: row.baseUrl,
    apiKey: apiKey ? SECRET_MASK : "",
    capabilities: row.capabilities,
    systemPrompt: row.systemPrompt,
    temperature: modelTemperature(row.temperature),
    timeoutSec: row.timeoutSec,
    maxContext: row.maxContext,
    enabled: row.enabled,
    hasApiKey: Boolean(apiKey),
  }));
}

export async function saveModelConfig(c: Context) {
  const body = await c.req.json();
  const apiKey = body.apiKey || body.api_key;
  const [current] = await db.select().from(modelConfig).orderBy(desc(modelConfig.isDefault)).limit(1);
  const rawTemp = body.temperature ?? current?.temperature ?? 0.2;
  const parsedTemp = Number(rawTemp);
  const temperature = !Number.isFinite(parsedTemp) ? 0.2 : parsedTemp > 2 ? parsedTemp / 100 : parsedTemp;
  const values = {
    provider: body.provider || "openai_compatible",
    modelName: body.modelName || body.model_name || current?.modelName,
    baseUrl: body.baseUrl || body.base_url || current?.baseUrl,
    apiKeyEnc: apiKey && apiKey !== "******" ? encrypt(apiKey) : current?.apiKeyEnc || "",
    systemPrompt: body.systemPrompt || body.system_prompt || current?.systemPrompt,
    temperature: Number.isFinite(temperature) ? temperature : 20,
    timeoutSec: Number(body.timeoutSec ?? body.timeout_sec ?? current?.timeoutSec ?? 120) || 120,
    maxContext: await resolveMaxContext(
      String(body.modelName || body.model_name || current?.modelName || ""),
      String(body.baseUrl || body.base_url || current?.baseUrl || ""),
      apiKey && apiKey !== SECRET_MASK ? String(apiKey) : decrypt(current?.apiKeyEnc),
      current?.maxContext,
    ),
    capabilities: body.capabilities || current?.capabilities || {},
    enabled: body.enabled !== false,
    isDefault: true,
    updatedAt: new Date(),
  };
  if (current) await db.update(modelConfig).set(values).where(eq(modelConfig.id, current.id));
  else await db.insert(modelConfig).values(values);
  return getModelConfig(c);
}

export async function testModelConfig(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ ok: false, message: "测试参数必须是对象" }, 400);
  const [row] = await db.select().from(modelConfig).orderBy(desc(modelConfig.isDefault)).limit(1);
  try {
    const config = resolveProbeConfig(body, row ? { baseUrl: row.baseUrl || "", modelName: row.modelName || "", apiKey: decrypt(row.apiKeyEnc) } : undefined);
    return c.json(await probeModelConnection(config, { signal: c.req.raw.signal }));
  } catch (error) {
    return c.json({ ok: false, message: error instanceof Error ? error.message : "模型测试参数无效" }, 400);
  }
}

async function loadProviderModelCatalog(baseUrl: string, apiKey: string): Promise<Array<{ id: string; name: string; contextWindow?: number }>> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const openrouter = url.includes("openrouter.ai");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(openrouter ? { "HTTP-Referer": "http://localhost:8080", "X-Title": "AI Aftersale" } : {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 300));
  const json = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
  return (json.data || [])
    .map((item) => ({
      id: String(item.id || ""),
      name: String(item.name || item.id || ""),
      contextWindow: Number(item.context_length || item.context_window || item.max_context || 0) || undefined,
    }))
    .filter((item) => item.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function resolveMaxContext(modelName: string, baseUrl: string, apiKey: string, fallback?: number | null): Promise<number | null> {
  if (!modelName || !baseUrl || !apiKey) return fallback ?? null;
  try {
    const items = await loadProviderModelCatalog(baseUrl, apiKey);
    const hit = items.find((item) => item.id === modelName)
      || items.find((item) => item.id.endsWith(`/${modelName}`));
    if (hit?.contextWindow && hit.contextWindow > 0) return Math.round(hit.contextWindow);
  } catch {
    /* keep previous window if the catalog is unreachable */
  }
  return fallback ?? null;
}

export async function listProviderModels(c: Context) {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const [row] = await db.select().from(modelConfig).orderBy(desc(modelConfig.isDefault)).limit(1);
  const baseUrl = String(body.baseUrl || body.base_url || row?.baseUrl || "").replace(/\/$/, "");
  let apiKey = String(body.apiKey || body.api_key || "");
  if (!apiKey || apiKey === SECRET_MASK) apiKey = row ? decrypt(row.apiKeyEnc) : "";
  if (!baseUrl) return c.json({ detail: "请先填写 Base URL" }, 400);
  if (!apiKey) return c.json({ detail: "请先填写 API Key" }, 400);
  try {
    const items = await loadProviderModelCatalog(baseUrl, apiKey);
    return c.json({ items, total: items.length });
  } catch (error) {
    return c.json({ detail: `加载模型列表失败：${error instanceof Error ? error.message : String(error)}` }, 400);
  }
}

export async function getGitCredential(c: Context) {
  const [row] = await db.select().from(gitCredential).limit(1);
  return c.json(dual({
    authType: row?.authType || "ssh",
    gitUsername: row?.gitUsername || "",
    knownHosts: row?.knownHosts || "",
    status: row?.status || "unknown",
    hasToken: Boolean(decrypt(row?.tokenEnc)),
    hasSshKey: Boolean(decrypt(row?.sshKeyEnc)),
  }));
}

export async function saveGitCredential(c: Context) {
  const body = await c.req.json();
  const [current] = await db.select().from(gitCredential).limit(1);
  const values = {
    authType: body.authType || body.auth_type || "ssh",
    gitUsername: body.gitUsername || body.git_username,
    tokenEnc: body.token ? encrypt(body.token) : current?.tokenEnc,
    sshKeyEnc: body.sshKey || body.ssh_key ? encrypt(body.sshKey || body.ssh_key) : current?.sshKeyEnc,
    knownHosts: body.knownHosts || body.known_hosts,
    status: "saved",
  };
  if (current) await db.update(gitCredential).set(values).where(eq(gitCredential.id, current.id));
  else await db.insert(gitCredential).values(values);
  return getGitCredential(c);
}

export async function uploadRecord(c: Context) {
  const id = requiredParam(c, "id");
  let customerId: string | null = null;
  let recordId: string | null = null;
  if (c.req.path.includes("/records/")) {
    const [ticket] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, id)).limit(1);
    if (!ticket) return c.json({ detail: "工单不存在" }, 404);
    const denied = await forbidUnlessRecord(c, ticket);
    if (denied) return denied;
    if (ticket?.status === "closed") return c.json({ detail: "工单已关闭，仅可查看" }, 409);
    customerId = ticket.customerId;
    recordId = ticket.id;
  } else {
    const [cust] = await db.select().from(customer).where(eq(customer.id, id)).limit(1);
    if (!cust) return c.json({ detail: "客户不存在" }, 404);
    const denied = await forbidUnlessCustomer(c, cust.id);
    if (denied) return denied;
    customerId = cust.id;
  }
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ detail: "缺少文件" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ detail: `文件不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB` }, 400);
  }
  const original = file.name || "upload";
  const safe = original.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "upload";
  const stored = `${crypto.randomUUID()}-${safe}`;
  const dir = path.join(config.dataRoot, "_uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, stored), Buffer.from(await file.arrayBuffer()));
  await db.insert(uploadedFile).values({ storedName: stored, customerId, recordId, uploadedBy: currentUser(c).id });
  const mime = guessMime(original, file.type || "application/octet-stream");
  const viewUrl = `/api/v1/files/${stored}`;
  const image = isImageMime(mime, original);
  return c.json({
    fileName: original,
    file_name: original,
    storedName: stored,
    stored_name: stored,
    viewUrl,
    view_url: viewUrl,
    mimeType: mime,
    mime_type: mime,
    isImage: image,
    is_image: image,
  });
}

export async function getUploadedFile(c: Context) {
  const name = requiredParam(c, "name");
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    return c.json({ detail: "非法文件名" }, 400);
  }
  const [owned] = await db.select().from(uploadedFile).where(eq(uploadedFile.storedName, name)).limit(1);
  if (!owned) return c.json({ detail: "附件归属尚未确认" }, 403);
  if (owned.recordId) {
    const [record] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, owned.recordId)).limit(1);
    if (!record) return c.json({ detail: "工单不存在" }, 404);
    const denied = await forbidUnlessRecord(c, record);
    if (denied) return denied;
  } else if (owned.customerId) {
    const denied = await forbidUnlessCustomer(c, owned.customerId);
    if (denied) return denied;
  } else return c.json({ detail: "附件归属尚未确认" }, 403);
  const file = path.join(config.dataRoot, "_uploads", name);
  if (!existsSync(file)) return c.json({ detail: "文件不存在" }, 404);
  const buf = await readFile(file);
  const mime = guessMime(name);
  const safeInline = /^image\/(png|jpeg|gif|webp|bmp)$/.test(mime);
  return new Response(buf, { headers: { "Content-Type": mime, "Content-Disposition": safeInline ? "inline" : "attachment", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "private, no-store" } });
}
import { requiredParam } from "./params.ts";
