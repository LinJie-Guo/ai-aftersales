import { desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { attachmentsFromRequest } from "../agent/attachments.ts";
import { liveAgents, startAgent, userMessage } from "../agent/host.ts";
import type { UserMessage } from "../agent/types.ts";
import { redactEventForClient } from "../agent/redact.ts";
import { openTurn } from "../agent/session.ts";
import { DbSession, loadSession } from "../agent/store.ts";
import { db } from "../db/client.ts";
import { afterSaleRecord, appUser, customer, session } from "../db/schema.ts";
import { currentUser, forbidUnlessRecord, visibleCustomerIds } from "./access.ts";
import { syncRecordRounds } from "./rounds.ts";
import { configuredModel, providerCatalog } from "../agent/models.ts";
import { config } from "../config.ts";
import { ArtifactStore } from "../agent/tools/artifacts.ts";
import path from "node:path";

function messageAuthor(c: Context) {
  const user = currentUser(c);
  return { authorUsername: user.username, authorName: user.displayName || user.username };
}

function readUserPayload(body: Record<string, unknown>, fallback = ""): { text: string; attachments: UserMessage["attachments"] } {
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const textFromParts = parts
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text || ""))
    .join("\n");
  const text = String(body.content || body.text || textFromParts || fallback);
  const attachments = attachmentsFromRequest(body.attachments);
  return { text, attachments };
}

function composeUserMessage(
  body: Record<string, unknown>,
  source: UserMessage["source"],
  author: { authorUsername: string; authorName: string },
  fallback = "",
): UserMessage {
  const { text, attachments } = readUserPayload(body, fallback);
  const content = text.trim() || (attachments?.length ? "请查看附件。" : fallback);
  const modelName = typeof body.modelName === "string" ? body.modelName.trim() : undefined;
  if (modelName && (modelName.length > 200 || /[\r\n\0]/.test(modelName))) throw new Error("模型名称无效");
  return userMessage(content, source, author, { attachments, referenceKnowledge: body.referenceKnowledge === true, modelName });
}

async function handlerAuthor(handlerId?: string | null) {
  if (!handlerId) return null;
  const [user] = await db.select().from(appUser).where(eq(appUser.id, handlerId)).limit(1);
  if (!user) return null;
  return { authorUsername: user.username, authorName: user.displayName || user.username };
}

function withFallbackAuthor<T extends { type: string; data: Record<string, unknown> }>(
  event: T,
  author: { authorUsername: string; authorName: string } | null,
): T {
  if (!author || event.type !== "user/message") return event;
  const data = event.data || {};
  if (data.authorName || data.author_name || data.authorUsername || data.author_username) return event;
  return {
    ...event,
    data: {
      ...data,
      authorUsername: author.authorUsername,
      authorName: author.authorName,
      author_username: author.authorUsername,
      author_name: author.authorName,
    },
  };
}

async function recordContext(recordId: string) {
  const [row] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, recordId)).limit(1);
  if (!row) return null;
  const [cust] = await db.select().from(customer).where(eq(customer.id, row.customerId)).limit(1);
  return { row, cust };
}

export async function createSession(c: Context) {
  const body = await c.req.json();
  const recordId = String(body.recordId || body.record_id || "");
  const ctx = await recordContext(recordId);
  if (!ctx?.cust) return c.json({ detail: "工单不存在" }, 404);
  const denied = await forbidUnlessRecord(c, ctx.row);
  if (denied) return denied;
  if (ctx.row.status === "closed") return c.json({ detail: "工单已关闭，仅可查看" }, 409);
  const preset = body.preset || "investigate";
  const permission = body.permission === "code" ? "code" : "env";
  const policy = { actorId: currentUser(c).id, permission: permission as "code" | "env", knowledgeCustomerIds: await visibleCustomerIds(c) };
  const [row] = await db.insert(session).values({
    id: crypto.randomUUID(),
    recordId,
    preset,
    status: "running",
    nextSeq: 0,
    executionPolicy: policy,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
  const store = new DbSession(row.id, preset);
  let live;
  try {
    live = await startAgent({
    session: store,
    policy,
    recordId,
    customerId: ctx.cust.id,
    projectId: ctx.cust.projectId,
    workdir: ctx.cust.workdir ?? undefined,
    envIp: ctx.cust.envIp ?? undefined,
    include: permission === "code" ? ["code", "knowledge"] : undefined,
    knowledgeCustomerIds: await visibleCustomerIds(c),
    });
  } catch (error) {
    await db.update(session).set({ status: "idle" }).where(eq(session.id, row.id));
    return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
  }
  await live.loop.followup(composeUserMessage(body, "human", messageAuthor(c), "请开始排查"));
  if (preset === "plan") {
    await store.append("plan/mode", { active: true });
  }
  return streamSession(c, live, row.id);
}

export async function followupSession(c: Context) {
  return drive(c, "followup");
}

export async function steerSession(c: Context) {
  return drive(c, "steer");
}

async function drive(c: Context, kind: "followup" | "steer") {
  const id = requiredParam(c, "id");
  const body = await c.req.json().catch(() => ({ content: "" }));
  const store = await loadSession(id);
  if (!store) return c.json({ detail: "会话不存在" }, 404);
  const [row] = await db.select().from(session).where(eq(session.id, id)).limit(1);
  if (!row) return c.json({ detail: "会话不存在" }, 404);
  const ctx = await recordContext(row.recordId);
  if (!ctx?.cust) return c.json({ detail: "工单不存在" }, 404);
  const denied = await forbidUnlessRecord(c, ctx.row);
  if (denied) return denied;
  if (ctx.row.status === "closed") return c.json({ detail: "工单已关闭，仅可查看" }, 409);
  const permission = body.permission === "code" ? "code" : body.permission === "env" ? "env" : row.executionPolicy?.permission ?? "code";
  const existing = liveAgents.get(id);
  if (existing && existing.loop.status === "idle") liveAgents.delete(id);
  const policy = existing?.loop.status === "running" && row.executionPolicy ? row.executionPolicy : { actorId: currentUser(c).id, permission: permission as "code" | "env", knowledgeCustomerIds: await visibleCustomerIds(c) };
  if (existing?.loop.status !== "running") await db.update(session).set({ executionPolicy: policy }).where(eq(session.id, id));
  const live = await startAgent({
    session: store,
    policy,
    recordId: row.recordId,
    customerId: ctx.cust.id,
    projectId: ctx.cust.projectId,
    workdir: ctx.cust.workdir ?? undefined,
    envIp: ctx.cust.envIp ?? undefined,
    include: permission === "code" ? ["code", "knowledge"] : undefined,
    knowledgeCustomerIds: await visibleCustomerIds(c),
  });
  const message = composeUserMessage(body, kind === "steer" ? "steer" : "human", messageAuthor(c));
  if (kind === "steer") await live.loop.steer(message);
  else await live.loop.followup(message);
  return streamSession(c, live, id);
}

async function loadInboxSession(c: Context) {
  const id = requiredParam(c, "id");
  const store = await loadSession(id);
  if (!store) return { error: c.json({ detail: "会话不存在" }, 404) };
  const [row] = await db.select().from(session).where(eq(session.id, id)).limit(1);
  if (!row) return { error: c.json({ detail: "会话不存在" }, 404) };
  const ctx = await recordContext(row.recordId);
  if (!ctx?.cust) return { error: c.json({ detail: "工单不存在" }, 404) };
  const denied = await forbidUnlessRecord(c, ctx.row);
  if (denied) return { error: denied };
  if (ctx.row.status === "closed") return { error: c.json({ detail: "工单已关闭，仅可查看" }, 409) };
  return { id, live: liveAgents.get(id) ?? await attachAgent(id) ?? undefined };
}

export async function listInbox(c: Context) {
  const loaded = await loadInboxSession(c);
  if ("error" in loaded) return loaded.error;
  return c.json({ items: loaded.live?.loop.inboxSnapshot() ?? [] });
}

export async function inboxSession(c: Context) {
  const loaded = await loadInboxSession(c);
  if ("error" in loaded) return loaded.error;
  const { id, live } = loaded;
  if (!live || live.loop.status !== "running") {
    return c.json({ accepted: false, reason: "idle" }, 409);
  }
  const body = await c.req.json().catch(() => ({ content: "" }));
  const draft = composeUserMessage(body, body.mode === "steer" ? "steer" : "human", messageAuthor(c));
  if (!draft.content.trim() && !draft.attachments?.length) return c.json({ detail: "消息不能为空" }, 400);
  // A turn's knowledge choice is immutable. A differently configured steer is
  // queued as a new turn, rather than changing tools under an in-flight request.
  const mode = body.mode === "steer" && draft.referenceKnowledge === live.loop.referenceKnowledge && (!draft.modelName || draft.modelName === live.loop.modelName) ? "steer" : "queue";
  const message = { ...draft, source: mode === "steer" ? "steer" as const : "human" as const };
  if (mode === "steer") {
    await live.loop.steer(message);
    await live.loop.revealUser(message);
  } else {
    await live.loop.followup(message);
  }
  return c.json({
    accepted: true,
    mode,
    notice: body.mode === "steer" && mode === "queue" ? "模型或知识选项与当前轮不同，已排队为下一轮。" : undefined,
    sessionId: id,
    item: { id: message.id, content: message.content, placement: mode === "steer" ? "steering" : "queued" },
    items: live.loop.inboxSnapshot(),
  });
}

export async function updateInbox(c: Context) {
  const loaded = await loadInboxSession(c);
  if ("error" in loaded) return loaded.error;
  const { live } = loaded;
  if (!live) return c.json({ accepted: false, code: "queue-item-not-found" }, 404);
  const itemId = requiredParam(c, "itemId");
  const body = await c.req.json().catch(() => ({}));
  const kind = body.kind === "edit" || body.kind === "steer" || body.kind === "remove" ? body.kind : "";
  if (!kind) return c.json({ detail: "不支持的操作" }, 400);
  const action = kind === "edit"
    ? { kind: "edit" as const, content: String(body.content || "") }
    : { kind };
  const result = await live.loop.updateQueue(itemId, action);
  if (!result.ok) {
    const status = result.code === "steer-unavailable" ? 409 : 404;
    return c.json({ accepted: false, code: result.code }, status);
  }
  return c.json({ accepted: true, items: live.loop.inboxSnapshot() });
}

async function forbidUnlessSession(c: Context, sessionId: string) {
  const [row] = await db.select().from(session).where(eq(session.id, sessionId)).limit(1);
  if (!row) return c.json({ detail: "会话不存在" }, 404);
  const ctx = await recordContext(row.recordId);
  if (!ctx?.cust) return c.json({ detail: "工单不存在" }, 404);
  return forbidUnlessRecord(c, ctx.row);
}

export async function cancelSession(c: Context) {
  const id = requiredParam(c, "id");
  const denied = await forbidUnlessSession(c, id);
  if (denied) return denied;
  liveAgents.get(id)?.loop.cancel();
  await db.update(session).set({ status: "cancelled" }).where(eq(session.id, id));
  return c.json({ ok: true });
}

export async function answerSession(c: Context) {
  const id = requiredParam(c, "id");
  const denied = await forbidUnlessSession(c, id);
  if (denied) return denied;
  const body = await c.req.json();
  if (typeof body.approved !== "boolean" || typeof body.approvalId !== "string") return c.json({ detail: "审批参数无效" }, 400);
  const accepted = await liveAgents.get(id)?.approvals.answer(body.approvalId, body.approved, currentUser(c).id);
  return accepted ? c.json({ ok: true }) : c.json({ detail: "审批已过期或已处理" }, 409);
}

export async function sessionApprovals(c: Context) {
  const id = requiredParam(c, "id");
  const denied = await forbidUnlessSession(c, id);
  if (denied) return denied;
  return c.json({ items: redactEventForClient(liveAgents.get(id)?.approvals.list() ?? []) });
}

export async function sessionArtifact(c: Context) {
  const id = requiredParam(c, "id");
  const denied = await forbidUnlessSession(c, id);
  if (denied) return denied;
  const store = new ArtifactStore(path.join(config.dataRoot, "_agent", id));
  const page = await store.read(requiredParam(c, "artifactId"), Number(c.req.query("offset") || 0), 12000);
  return c.json(page);
}

export async function modelCatalog(c: Context) {
  const row = await configuredModel();
  try { return c.json({ defaultModel: row.modelName, items: await providerCatalog(row) }); }
  catch { return c.json({ defaultModel: row.modelName, items: [{ id: row.modelName, name: row.modelName, contextWindow: row.maxContext }], notice: "目录暂不可用，可输入模型 ID；不会修改系统默认模型" }); }
}

export async function listSessionEvents(c: Context) {
  const id = requiredParam(c, "id");
  const denied = await forbidUnlessSession(c, id);
  if (denied) return denied;
  const afterSeq = Number(c.req.query("afterSeq") || c.req.query("after_seq") || 0);
  const store = await loadSession(id);
  if (!store) return c.json({ detail: "会话不存在" }, 404);
  const [owned] = await db.select().from(session).where(eq(session.id, id)).limit(1);
  const ctx = owned ? await recordContext(owned.recordId) : null;
  const author = await handlerAuthor(ctx?.row.handlerId);
  return c.json({ items: store.events.filter((event) => event.seq > afterSeq).map((event) => redactEventForClient(withFallbackAuthor(event, author))) });
}

export async function latestSession(c: Context) {
  const recordId = requiredParam(c, "id");
  const ctx = await recordContext(recordId);
  if (ctx?.cust) {
    const denied = await forbidUnlessRecord(c, ctx.row);
    if (denied) return denied;
  }
  const [row] = await db.select().from(session).where(eq(session.recordId, recordId)).orderBy(desc(session.createdAt)).limit(1);
  if (!row) return c.json(null);
  const store = await loadSession(row.id);
  if (store && (row.status === "running" || openTurn(store.events))) {
    await resumeSession(row.id, await visibleCustomerIds(c));
  }
  const author = await handlerAuthor(ctx?.row.handlerId);
  const [fresh] = await db.select().from(session).where(eq(session.id, row.id)).limit(1);
  return c.json({
    id: row.id,
    preset: row.preset,
    permission: row.executionPolicy?.permission || "code",
    status: fresh?.status ?? row.status,
    events: (store?.events ?? []).map((event) => redactEventForClient(withFallbackAuthor(event, author))),
  });
}

export async function replaySession(c: Context) {
  const id = requiredParam(c, "id");
  const denied = await forbidUnlessSession(c, id);
  if (denied) return denied;
  const afterSeq = Number(c.req.query("afterSeq") || c.req.query("after_seq") || 0);
  const store = await loadSession(id);
  if (!store) return c.json({ detail: "会话不存在" }, 404);
  const [owned] = await db.select().from(session).where(eq(session.id, id)).limit(1);
  let live = liveAgents.get(id);
  if (!live || live.loop.status === "idle" || !live.pump) {
    if (owned?.status === "running" || openTurn(store.events)) {
      live = await attachAgent(id, await visibleCustomerIds(c)) ?? live;
    }
  }
  const rec = owned ? await recordContext(owned.recordId) : null;
  const author = await handlerAuthor(rec?.row.handlerId);
  return streamSSE(c, async (sse) => {
    let replaying = true;
    const pending: Array<{ seq: number; type: string; data: Record<string, unknown> }> = [];
    const seen = new Set<number>();
    const write = async (event: { seq: number; type: string; data: Record<string, unknown> }) => {
      if (typeof event.seq === "number" && event.seq > 0) {
        if (event.seq <= afterSeq || seen.has(event.seq)) return;
        seen.add(event.seq);
      }
      await sse.writeSSE({ data: JSON.stringify(redactEventForClient(withFallbackAuthor(event, author))) });
    };
    let stop = () => {};
    const finished = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const wait = async (event: { seq: number; type: string; data: Record<string, unknown> }) => {
      if (replaying) { pending.push(event); return; }
      try {
        await write(event);
        if (event.type === "session/status" && event.data.status === "idle") stop();
      } catch {
        stop();
      }
    };
    const replayOutput = live ? { ...live.liveOutput } : null;
    if (live) live.waiters.add(wait);
    if (live && (owned?.status === "running" || openTurn(store.events))) ensurePump(live, id);
    try {
      for (const event of [...store.events]) await write(event);
      if (replayOutput && (replayOutput.text || replayOutput.reasoning)) await write({ seq: -1, type: "assistant/live-snapshot", data: { ...replayOutput, transient: true } });
      while (pending.length) {
        const event = pending.shift()!;
        await write(event);
        if (event.type === "session/status" && event.data.status === "idle") stop();
      }
      replaying = false;
      if (!live?.pump && live?.loop.status !== "running") return;
      await finished;
    } finally {
      live?.waiters.delete(wait);
    }
  });
}

export async function attachAgent(sessionId: string, knowledgeCustomerIds: string[] | null = null) {
  const existing = liveAgents.get(sessionId);
  if (existing) {
    if (existing.loop.status === "running" && !existing.pump) existing.loop.releaseAbandoned();
    return existing;
  }
  const store = await loadSession(sessionId);
  if (!store) return null;
  const [row] = await db.select().from(session).where(eq(session.id, sessionId)).limit(1);
  if (!row) return null;
  if (!row.executionPolicy) {
    await db.update(session).set({ status: "idle" }).where(eq(session.id, sessionId));
    return null;
  }
  const ctx = await recordContext(row.recordId);
  if (!ctx?.cust) return null;
  return startAgent({
    session: store,
    policy: row.executionPolicy,
    recordId: row.recordId,
    customerId: ctx.cust.id,
    projectId: ctx.cust.projectId,
    workdir: ctx.cust.workdir ?? undefined,
    envIp: ctx.cust.envIp ?? undefined,
    knowledgeCustomerIds,
  });
}

export async function resumeSession(sessionId: string, knowledgeCustomerIds: string[] | null = null) {
  const live = await attachAgent(sessionId, knowledgeCustomerIds);
  if (live) ensurePump(live, sessionId);
  return live;
}

export async function resumeOrphanSessions() {
  const rows = await db.select({ id: session.id, updatedAt: session.updatedAt }).from(session).where(eq(session.status, "running"));
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const row of rows) {
    const updated = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Date.parse(String(row.updatedAt ?? ""));
    if (!Number.isFinite(updated) || updated < cutoff) {
      await db.update(session).set({ status: "idle", updatedAt: new Date() }).where(eq(session.id, row.id));
      console.info("[agent] mark stale running session idle", row.id);
      continue;
    }
    try {
      console.info("[agent] resume orphan session", row.id);
      await resumeSession(row.id);
    } catch (error) {
      console.error("[agent] resume orphan failed", row.id, error);
    }
  }
}

function ensurePump(live: NonNullable<ReturnType<typeof liveAgents.get>>, sessionId: string) {
  if (live.pump) return;
  live.pump = (async () => {
    let failed = false;
    await db.update(session).set({ status: "running", updatedAt: new Date() }).where(eq(session.id, sessionId));
    try {
      for await (const _event of live.loop.run()) {
        /* persisted + broadcast via onEvent */
      }
    } catch (error) {
      failed = true;
      console.error("[agent] pump failed", error);
    } finally {
      await db.update(session).set({ status: "idle", updatedAt: new Date() }).where(eq(session.id, sessionId));
      const [owned] = await db.select({ recordId: session.recordId }).from(session).where(eq(session.id, sessionId)).limit(1);
      if (owned?.recordId) await syncRecordRounds(owned.recordId);
      live.pump = undefined;
      // A message can arrive while the previous pump is saving its final status.
      if (!failed && !live.loop.cancelled && live.loop.inboxSnapshot().length) ensurePump(live, sessionId);
    }
  })();
}

function streamSession(c: Context, live: NonNullable<ReturnType<typeof liveAgents.get>>, sessionId: string) {
  return streamSSE(c, async (sse) => {
    const seen = new Set<number>();
    const write = async (event: { seq: number; type: string; data: Record<string, unknown> }) => {
      if (typeof event.seq === "number" && event.seq > 0) {
        if (seen.has(event.seq)) return;
        seen.add(event.seq);
      }
      await sse.writeSSE({ data: JSON.stringify(redactEventForClient(event)) });
    };
    let stop = () => {};
    const finished = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const wait = async (event: { seq: number; type: string; data: Record<string, unknown> }) => {
      try {
        await write(event);
        if (event.type === "session/status" && event.data.status === "idle") stop();
      } catch {
        stop();
      }
    };
    live.waiters.add(wait);
    ensurePump(live, sessionId);
    try {
      await write({ seq: 0, type: "session/ready", data: { sessionId, session_id: sessionId } });
      if (!live.pump && live.loop.status === "idle") return;
      await finished;
    } finally {
      live.waiters.delete(wait);
    }
  });
}
import { requiredParam } from "./params.ts";
