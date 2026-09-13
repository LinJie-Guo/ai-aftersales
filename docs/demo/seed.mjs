// README 专用合成数据。仅允许指定本地空库，不调用模型、Git 或 SSH。
import path from 'node:path';
const target = new URL(process.env.DATABASE_URL || 'postgres://localhost/');
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/aftersale_readme') {
  throw new Error('仅允许本地专用数据库 aftersale_readme');
}
if (path.basename(process.env.DATA_ROOT || '') !== 'aftersale-readme-demo') {
  throw new Error('DATA_ROOT 必须显式指向独立的 aftersale-readme-demo 目录');
}
if (!process.env.ADMIN_PASSWORD) throw new Error('请设置演示管理员密码');
const { db, sql } = await import('../../server/src/db/client.ts');
const { migrate } = await import('../../server/src/db/migrate.ts');
const { hashPassword } = await import('../../server/src/crypto.ts');
const s = await import('../../server/src/db/schema.ts');
const uid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (day, hour = 9) => new Date(`2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`);
try {
  const existing = await sql`select tablename from pg_tables where schemaname = 'public'`;
  if (existing.length) throw new Error('目标库必须完全为空；拒绝覆盖已有数据');
  await migrate();
  await migrate();
  await db.transaction(async (tx) => {
    await tx.insert(s.appUser).values([
      { id: uid(1), username: 'admin', displayName: '演示管理员', passwordHash: hashPassword(process.env.ADMIN_PASSWORD), role: 'admin' },
      ...['交付支持组', '平台支持组', '应用支持组'].map((name, i) => ({ id: uid(2 + i), username: `demo-support-${i + 1}`, displayName: name, passwordHash: hashPassword(crypto.randomUUID()), role: 'engineer' })),
    ]);
    const projectNames = ['企业资产管理平台', '供应链协同平台', '统一数据服务平台'];
    const repoNames = ['asset-platform', 'supply-platform', 'data-platform'];
    await tx.insert(s.project).values(projectNames.map((name, i) => ({ id: uid(10 + i), name, description: ['资产台账、设备拓扑与运维协同', '订单履约、库存协同与供应商门户', '数据接入、指标管理与报表服务'][i], createdAt: at(1 + i), updatedAt: at(10) })));
    await tx.insert(s.projectRepo).values(repoNames.flatMap((name, i) => ['web', 'api'].map((suffix, j) => ({ projectId: uid(10 + i), repoName: `${name}-${suffix}`, repoUrl: `https://git.example.com/demo/${name}-${suffix}.git`, sortOrder: j }))));
    const companyNames = ['星澜智造有限公司', '云岑供应链有限公司', '沐川数科有限公司', '栖原新材有限公司', '知屿商贸有限公司', '晴序科技有限公司'];
    await tx.insert(s.customer).values(companyNames.map((name, i) => ({ id: uid(20 + i), name, projectId: uid(10 + i % 3), branch: ['release/3.4', 'release/2.8', 'release/4.1'][i % 3], tag: ['v3.4.2', 'v2.8.1', 'v4.1.0'][i % 3], envIp: `192.0.2.${20 + i}`, workdir: `/srv/demo/${repoNames[i % 3]}`, codeStatus: 'updated', codeSyncedAt: at(12, 8), createdAt: at(2 + i), updatedAt: at(12, 8) })));
    await tx.insert(s.customerRepo).values(companyNames.flatMap((_, i) => ['web', 'api'].map((suffix, j) => ({ customerId: uid(20 + i), repoName: `${repoNames[i % 3]}-${suffix}`, repoUrl: `https://git.example.com/demo/${repoNames[i % 3]}-${suffix}.git`, branch: ['release/3.4', 'release/2.8', 'release/4.1'][i % 3], tag: ['v3.4.2', 'v2.8.1', 'v4.1.0'][i % 3], commitId: `${i + 1}${j + 1}a7bc8`, status: 'updated' }))));
    await tx.insert(s.userCustomer).values(companyNames.map((_, i) => ({ userId: uid(2 + i % 3), customerId: uid(20 + i) })));
    const titles = ['资产拓扑页面加载后节点为空', '订单同步任务出现重复重试', '日报导出缺少最近一日数据', '设备状态刷新存在短暂延迟', '库存预警阈值调整后未生效', '报表筛选结果与汇总数量不一致', '批量导入提示必填字段缺失', '单点登录回调后页面跳转异常'];
    const conclusions = ['API 与采集任务的数据目录不一致，已确认配置差异并给出修复步骤。', '重试队列缺少幂等校验，补充业务唯一键后同步恢复。', '报表时间范围采用 UTC 边界，统一业务时区后验证通过。', '缓存刷新周期过长，调整刷新策略后状态及时更新。', '规则变更后缓存未失效，增加主动刷新后验证通过。', '分页汇总与筛选条件不一致，统一查询条件后数量一致。', '导入模板列名与字段映射不一致，更新模板后导入成功。', '回调路径配置与部署前缀不一致，统一配置后登录恢复。'];
    await tx.insert(s.afterSaleRecord).values(titles.map((title, i) => ({ id: uid(100 + i), code: `AS-202609${i < 3 ? '12' : '11'}-${String(i + 1).padStart(3, '0')}`, customerId: uid(20 + i % 6), title, description: i === 0 ? '版本升级后资产拓扑无节点展示，资产台账与采集任务运行正常。请协助核对数据读取链路。' : `${companyNames[i % 6]}在版本验收中发现${title}，请结合交付版本核查。`, priority: ['p1', 'p1', 'p2', 'p2', 'p1', 'p2', 'p2', 'p1'][i], status: i < 3 ? 'processing' : 'closed', rounds: i === 0 ? 1 : 2, conclusion: conclusions[i], handlerId: uid(2 + i % 3), threadId: uid(200 + i), createdAt: at(i < 3 ? 12 : 11, 10 - i % 3), updatedAt: at(i < 3 ? 12 : 11, 11 - i % 3) })));
    await tx.insert(s.knowledge).values([1, 2, 3, 4, 5, 6].map((i) => ({ id: uid(300 + i), code: `K-20260911-${String(i).padStart(3, '0')}`, title: titles[i], sourceRecordId: uid(100 + i), customerId: uid(20 + i % 6), summary: conclusions[i], category: ['任务调度', '数据报表', '状态同步'][i % 3], scopeProject: projectNames[i % 3], confidence: 'verified', status: 'published', tags: ['版本验收', '配置核查'], symptom: titles[i], rootCause: conclusions[i].split('，')[0], steps: '核对交付版本与配置差异；在演示验证环境完成修复并记录变更。', verify: '重复执行原问题操作，核对结果与业务预期一致。', createdAt: at(11, 9 + i), updatedAt: at(11, 9 + i) })));
    await tx.insert(s.dataAsset).values({ customerId: uid(20), name: '资产拓扑接口与字段说明', assetType: 'table', content: '演示结构：asset_node(id, name, type, status)，用于说明资产节点读取关系。' });
    await tx.insert(s.modelConfig).values({ modelName: '演示排查模型', baseUrl: 'https://model.example.com/v1', apiKeyEnc: '', enabled: true, isDefault: true });
    // 对话和工具结果均为手工编写的展示样例，不代表真实模型执行记录。
    const answer = '已定位到**数据目录配置不一致**：采集任务写入新目录，API 仍读取旧目录，导致拓扑节点为空。\n\n**排查依据：**拓扑接口依赖 `DATA_WORKDIR`；API 与采集任务的目录配置不同。\n\n**处理建议：**统一为 `/srv/demo/assets`，经变更审批后重启 API。\n\n**验证标准：**拓扑节点恢复展示，节点数量与资产台账一致。';
    const events = [
      ['user/message', { id: uid(400), source: 'human', content: '星澜智造升级至 v3.4.2 后，资产拓扑页面为空，但资产台账和采集任务均正常。请结合交付代码排查原因，并给出验证步骤。', authorName: '交付支持组', referenceKnowledge: false, modelName: '演示排查模型' }],
      ['turn/start', { turn: 1 }],
      ['tool/call', { callId: 'demo-search', name: 'grep', arguments: { pattern: 'DATA_WORKDIR', path: 'asset-platform-api' } }],
      ['tool/result', { callId: 'demo-search', name: 'grep', status: 'success', summary: '演示代码：拓扑接口通过 DATA_WORKDIR 读取节点文件；API 与采集任务使用独立配置。' }],
      ['tool/call', { callId: 'demo-read', name: 'read', arguments: { file_path: 'asset-platform-api/config/deployment.yml' } }],
      ['tool/result', { callId: 'demo-read', name: 'read', status: 'success', summary: '演示配置差异：API 读取 /srv/demo/assets-previous，采集任务写入 /srv/demo/assets。' }],
      ['assistant/message', { content: answer }],
      ['turn/end', { reason: 'completed' }],
    ];
    await tx.insert(s.session).values({ id: uid(500), recordId: uid(100), preset: 'investigate', status: 'idle', nextSeq: events.length });
    await tx.insert(s.sessionEvent).values(events.map(([type, data], i) => ({ sessionId: uid(500), seq: i + 1, type, data, createdAt: new Date(at(12, 10).getTime() + i * 7000) })));
  });
  console.log('合成演示数据已创建：6 个虚构客户、8 条工单、6 条知识、1 段演示对话。');
} finally {
  await sql.end();
}
