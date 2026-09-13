import { eq } from "drizzle-orm";

import { DEFAULT_SYSTEM_PROMPT } from "../shared/index.ts";

import { config } from "../config.ts";
import { hashPassword } from "../crypto.ts";
import { db } from "./client.ts";
import { afterSaleRecord, appUser, customer, customerRepo, dataAsset, gitCredential, knowledge, modelConfig, project, projectRepo } from "./schema.ts";

export async function seed(): Promise<void> {
  const [existingAdmin] = await db.select().from(appUser).where(eq(appUser.username, config.adminUsername)).limit(1);
  if (existingAdmin && !existingAdmin.passwordHash.startsWith("scrypt$")) {
    await db.update(appUser).set({
      passwordHash: hashPassword(config.adminPassword),
      updatedAt: new Date(),
    }).where(eq(appUser.id, existingAdmin.id));
  }

  const existing = await db.select({ id: appUser.id }).from(appUser).limit(1);
  if (existing.length) {
    const models = await db.select({ id: modelConfig.id, systemPrompt: modelConfig.systemPrompt }).from(modelConfig);
    for (const row of models) {
      const text = row.systemPrompt?.trim() || "";
      if (!text || text.startsWith("你是售后排查 Agent")) {
        await db.update(modelConfig).set({ systemPrompt: DEFAULT_SYSTEM_PROMPT }).where(eq(modelConfig.id, row.id));
      }
    }
    return;
  }

  const [admin] = await db.insert(appUser).values({
    username: config.adminUsername,
    displayName: "管理员",
    passwordHash: hashPassword(config.adminPassword),
    role: "admin",
  }).returning();

  const [es] = await db.insert(project).values({ name: "企业资产管理平台", description: "资产台账、设备拓扑与运维协同（虚构示例）" }).returning();
  const [biz] = await db.insert(project).values({ name: "供应链协同平台", description: "订单履约与库存协同（虚构示例）" }).returning();
  await db.insert(projectRepo).values([
    { projectId: es.id, repoName: "es-web", repoUrl: "git@git.example.com:demo/es-web.git", sortOrder: 0 },
    { projectId: es.id, repoName: "es-api", repoUrl: "git@git.example.com:demo/es-api.git", sortOrder: 1 },
    { projectId: es.id, repoName: "es-scanner", repoUrl: "git@git.example.com:demo/es-scanner.git", sortOrder: 2 },
    { projectId: biz.id, repoName: "biz-web", repoUrl: "git@git.example.com:demo/biz-web.git", sortOrder: 0 },
    { projectId: biz.id, repoName: "biz-api", repoUrl: "git@git.example.com:demo/biz-api.git", sortOrder: 1 },
  ]);

  const [manufacturingCustomer] = await db.insert(customer).values({
    name: "星澜智造有限公司",
    projectId: es.id,
    branch: "release/es-3.4",
    tag: "v3.4.2",
    envIp: "192.0.2.20",
    workdir: "/srv/demo/assets",
    codeStatus: "updated",
  }).returning();
  const [supplyCustomer] = await db.insert(customer).values({
    name: "云岑供应链有限公司",
    projectId: biz.id,
    branch: "release/supply-3.3",
    tag: "v3.3.8",
    envIp: "192.0.2.21",
    workdir: "/srv/demo/supply",
    codeStatus: "need_update",
  }).returning();
  await db.insert(customerRepo).values([
    { customerId: manufacturingCustomer.id, repoName: "es-web", repoUrl: "git@git.example.com:demo/es-web.git", branch: "release/es-3.4", tag: "v3.4.2", commitId: "a18f7c2", status: "updated" },
    { customerId: manufacturingCustomer.id, repoName: "es-api", repoUrl: "git@git.example.com:demo/es-api.git", branch: "release/es-3.4", tag: "v3.4.2", commitId: "c92d4af", status: "updated" },
  ]);
  await db.insert(dataAsset).values([
    { customerId: manufacturingCustomer.id, name: "资产表结构", assetType: "table", content: "asset(id, name, ...)" },
    { customerId: manufacturingCustomer.id, name: "资产 ES 索引", assetType: "es", content: "index: assets" },
  ]);

  await db.insert(afterSaleRecord).values({
    code: "AS-20260703-001",
    customerId: manufacturingCustomer.id,
    title: "资产拓扑页面为空",
    priority: "p0",
    status: "processing",
    rounds: 4,
    conclusion: "API 与 worker 工作目录不一致",
    handlerId: admin.id,
    threadId: crypto.randomUUID(),
  });

  await db.insert(knowledge).values({
    code: "K-20260701-008",
    title: "资产拓扑读取旧工作目录",
    customerId: manufacturingCustomer.id,
    category: "资产",
    scopeProject: "企业资产管理平台",
    scopeVersion: "v3.4.x",
    confidence: "verified",
    status: "published",
    tags: ["资产拓扑", "DATA_WORKDIR"],
    symptom: "资产拓扑页面能打开，但节点为空；扫描任务显示正常结束。",
    rootCause: "API 与 worker 的工作目录不一致，拓扑接口读取旧目录。",
    steps: "统一 API 与 worker 的 DATA_WORKDIR，重启 API 后验证。",
    verify: "访问 /api/assets/graph 确认返回节点数量 > 0。",
    similarDesc: "升级后拓扑为空；扫描完成但资产图没有节点。",
  });

  await db.insert(modelConfig).values({
    provider: "openai_compatible",
    modelName: "aftersale-diagnosis-v1",
    baseUrl: "https://model.example.com/v1",
    apiKeyEnc: "",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    enabled: true,
    isDefault: true,
  });
  await db.insert(gitCredential).values({
    authType: "ssh",
    gitUsername: "demo-ci",
    knownHosts: "git.example.com",
    status: "saved",
  });

  void supplyCustomer;
}
