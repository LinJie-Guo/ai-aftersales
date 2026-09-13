/** Run inside the deployed application container. Uses isolated fixtures and removes them. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import { db, sql } from "../src/db/client.ts";
import { appUser, appRole, project, customer, userCustomer, afterSaleRecord, session, sessionEvent, uploadedFile, knowledge } from "../src/db/schema.ts";
import { config } from "../src/config.ts";
import { hashPassword } from "../src/crypto.ts";
import { attachAgent } from "../src/http/sessions.ts";
import { authorizePolicy } from "../src/agent/policy.ts";
import { writeKnowledgeDoc, searchKnowledgeDocs } from "../src/knowledge/docs.ts";
import { extractDocumentText } from "../src/agent/attachments.ts";

const base = "http://127.0.0.1:8080";
if (process.env.AFTERSALE_ISOLATED_TEST !== "1" || !new URL(config.databaseUrl).pathname.endsWith("_regression") || !config.dataRoot.startsWith("/tmp/")) {
  throw new Error("此脚本只能在专用 *_regression 数据库和 /tmp 数据目录运行，禁止向业务环境写入测试记录。");
}
const suffix = randomUUID();
const uid = randomUUID(), adminId = randomUUID(), pid = randomUUID(), cid = randomUUID(), otherCid = randomUUID(), rid = randomUUID(), otherRid = randomUUID();
const roleCode = `smoke-${suffix}`, password = randomUUID();
const files: string[] = [], sessionIds: string[] = [], knowledgeIds: string[] = [];
let token = "", adminToken = "";
const checks: string[] = [];
function passed(name: string) { checks.push(name); console.log(`PASS ${name}`); }
async function api(url: string, init: RequestInit = {}, auth = token) {
  return fetch(base + url, { ...init, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...init.headers }, signal: AbortSignal.timeout(240_000) });
}
async function login(username: string) {
  const response = await api("/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) }, "");
  assert.equal(response.status, 200); assert.match(response.headers.get("set-cookie") || "", /HttpOnly/i);
  return response;
}
async function runSession(content: string, preset = "general", attachments: unknown[] = []) {
  const started = Date.now();
  const response = await api("/api/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recordId: rid, preset, permission: "code", content, attachments }) });
  assert.equal(response.status, 200);
  const events = (await response.text()).split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
  const answer = events.filter((event) => event.type === "assistant/message").map((event) => event.data.content || "").join("\n");
  const rows = await db.select().from(session).where(eq(session.recordId, rid));
  for (const row of rows) if (!sessionIds.includes(row.id)) sessionIds.push(row.id);
  assert.ok(answer.trim(), "model returned no final answer");
  assert.ok(!/模型请求失败|模型本轮没有输出/.test(answer), `model upstream failed: ${answer.slice(0, 180)}`);
  console.log(JSON.stringify({ test: preset, durationMs: Date.now() - started, answer: answer.slice(0, 250), toolCalls: events.filter((e) => e.type === "tool/call").length }));
  return { events, answer };
}

try {
  assert.equal((await fetch(base + "/health")).status, 200);
  const home = await fetch(base + "/"); assert.equal(home.status, 200); assert.match(await home.text(), /<html/);
  passed("container health and bundled frontend");
  await db.insert(appRole).values({ code: roleCode, name: "临时回归角色", dataScope: "assigned", permissions: ["workbench.use", "records.read", "records.write", "customers.read"] });
  await db.insert(appUser).values([{ id: uid, username: roleCode, displayName: "临时回归账号", passwordHash: hashPassword(password), role: roleCode }, { id: adminId, username: `admin-${suffix}`, displayName: "临时回归管理员", passwordHash: hashPassword(password), role: "admin" }]);
  await db.insert(project).values({ id: pid, name: `部署回归-${suffix}` });
  await db.insert(customer).values([{ id: cid, projectId: pid, name: "回归客户A" }, { id: otherCid, projectId: pid, name: "回归客户B" }]);
  await db.insert(userCustomer).values({ userId: uid, customerId: cid });
  await db.insert(afterSaleRecord).values([{ id: rid, code: `SMOKE-${suffix}`, customerId: cid, handlerId: uid, threadId: rid, title: "容器回归验证" }, { id: otherRid, code: `OTHER-${suffix}`, customerId: otherCid, handlerId: adminId, threadId: otherRid, title: "隔离测试" }]);
  const logged = await login(roleCode); const cookie = logged.headers.get("set-cookie")!.split(";")[0]!; token = (await logged.json()).accessToken;
  adminToken = (await (await login(`admin-${suffix}`)).json()).accessToken;
  passed("login, JWT and HttpOnly attachment cookie");
  assert.equal((await api(`/api/v1/records/${otherRid}`)).status, 403);
  const form = new FormData(); form.append("file", new File(["fixture only"], "fixture.txt", { type: "text/plain" }));
  const upload = await api(`/api/v1/records/${rid}/uploads`, { method: "POST", body: form }); assert.equal(upload.status, 200);
  const attachment = await upload.json(); files.push(attachment.storedName);
  assert.equal((await api(attachment.viewUrl, {}, "")).status, 401);
  assert.equal((await api(attachment.viewUrl, { headers: { Cookie: cookie } }, "")).status, 200);
  await db.delete(userCustomer).where(eq(userCustomer.userId, uid));
  assert.equal((await api(attachment.viewUrl)).status, 403);
  await db.insert(userCustomer).values({ userId: uid, customerId: cid });
  passed("attachment ownership and cross-customer access denial");
  const settings = await (await api("/api/v1/settings/model", {}, adminToken)).json();
  assert.equal(settings.apiKey || settings.api_key, "******"); passed("model credentials masked in API");
  const restoredId = randomUUID(); sessionIds.push(restoredId);
  const policy = { actorId: uid, permission: "code" as const, knowledgeCustomerIds: [cid] };
  await db.insert(session).values({ id: restoredId, recordId: rid, preset: "investigate", status: "idle", executionPolicy: policy });
  const restored = await attachAgent(restoredId); assert.ok(restored);
  const schemas = (restored.loop as any).tools.schemas();
  assert.ok(schemas.some((s: any) => s.name === "read")); assert.ok(!schemas.some((s: any) => /bash|ssh|env/.test(s.name)));
  await db.update(appUser).set({ active: false }).where(eq(appUser.id, uid));
  await assert.rejects(authorizePolicy(policy, rid));
  await db.update(appUser).set({ active: true }).where(eq(appUser.id, uid));
  passed("fresh-process policy restoration and revoked-user rejection");
  for (const customerId of [cid, otherCid]) {
    const id = randomUUID(); knowledgeIds.push(id);
    await db.insert(knowledge).values({ id, customerId, title: "fixture", summary: "fixture" });
    const docPath = await writeKnowledgeDoc(id, `仅正文命中 marker-${suffix}`);
    await db.update(knowledge).set({ docPath }).where(eq(knowledge.id, id));
  }
  const hits = await searchKnowledgeDocs(`marker-${suffix}`, 8, [cid]);
  assert.equal(hits.length, 1); assert.equal(hits[0]!.id, knowledgeIds[0]);
  passed("indexed document-body search with customer scope");
  const body = "BT /F1 12 Tf 30 100 Td (Container PDF parser OK) Tj ET";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${body.length} >>\nstream\n${body}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  for (const [i, obj] of objs.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`;
  const extracted = await extractDocumentText(Buffer.from(pdf), "fixture.pdf"); assert.ok(extracted.ok && extracted.text.includes("Container PDF parser OK")); passed("real pdftotext parser inside image");
  await runSession("这是隔离部署测试，不涉及真实客户。请只回复：容器测试通过。不要调用工具。");
  passed("real configured model through deployed SSE API");
  const repos = path.join(config.dataRoot, pid, cid, "_latest"); await mkdir(repos, { recursive: true }); await writeFile(path.join(repos, "regression.txt"), "fixture_result=container_tool_success\n");
  const result = await runSession("这是隔离测试。请调用 read 工具读取 regression.txt，然后准确报告 fixture_result 的值；只读，不连接任何环境。", "investigate");
  assert.ok(result.events.some((e) => e.type === "tool/call")); assert.match(result.answer, /container_tool_success/);
  passed("real model tool-call, artifact and follow-on conclusion");
  // Synthetic PNG fixture; no user screenshots or business information leave the system.
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(data.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(32 * 97); for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) pixels[y * 97 + 1 + x * 3] = 255;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  const imageForm = new FormData(); imageForm.append("file", new File([png], "color.png", { type: "image/png" }));
  const imageResponse = await api(`/api/v1/records/${rid}/uploads`, { method: "POST", body: imageForm }); assert.equal(imageResponse.status, 200);
  const image = await imageResponse.json(); files.push(image.storedName);
  const vision = await runSession("请看附件图片，它主要是什么颜色？只回答颜色。", "general", [image]);
  assert.match(vision.answer, /红|red/i); passed("real image upload and multimodal model response");
  console.log(JSON.stringify({ ok: true, checks }));
} finally {
  const ownedSessions = await db.select({ id: session.id }).from(session).where(eq(session.recordId, rid));
  for (const row of ownedSessions) if (!sessionIds.includes(row.id)) sessionIds.push(row.id);
  if (sessionIds.length) { await db.delete(sessionEvent).where(inArray(sessionEvent.sessionId, sessionIds)); await db.delete(session).where(inArray(session.id, sessionIds)); }
  if (knowledgeIds.length) await db.delete(knowledge).where(inArray(knowledge.id, knowledgeIds));
  if (files.length) await db.delete(uploadedFile).where(inArray(uploadedFile.storedName, files));
  await db.delete(afterSaleRecord).where(inArray(afterSaleRecord.id, [rid, otherRid]));
  await db.delete(userCustomer).where(eq(userCustomer.userId, uid));
  await db.delete(customer).where(inArray(customer.id, [cid, otherCid]));
  await db.delete(project).where(eq(project.id, pid));
  await db.delete(appUser).where(inArray(appUser.id, [uid, adminId]));
  await db.delete(appRole).where(eq(appRole.code, roleCode));
  await Promise.all([...files.map((f) => path.join(config.dataRoot, "_uploads", f)), ...sessionIds.map((id) => path.join(config.dataRoot, "_agent", id)), ...knowledgeIds.map((id) => path.join(config.dataRoot, "_knowledge", `${id}.md`)), path.join(config.dataRoot, pid)].map((p) => rm(p, { recursive: true, force: true })));
  await sql.end();
}
