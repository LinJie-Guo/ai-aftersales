import { eq, sql } from "drizzle-orm";

import type { SessionEvent, SessionPreset } from "../shared/index.ts";

import { sanitizeForJson } from "./json-safe.ts";
import { redactEventForClient } from "./redact.ts";
import type { SessionStore } from "./types.ts";

import { db } from "../db/client.ts";
import { session, sessionEvent } from "../db/schema.ts";

export class DbSession implements SessionStore {
  events: SessionEvent[] = [];
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    public readonly id: string,
    public readonly preset: SessionPreset,
    events: SessionEvent[] = [],
  ) {
    this.events = events;
  }

  append(type: string, data: Record<string, unknown>): Promise<SessionEvent> {
    const job = this.pending.then(() => this.persist(type, data));
    this.pending = job.catch(() => {});
    return job;
  }

  private async persist(type: string, data: Record<string, unknown>): Promise<SessionEvent> {
    const event = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(session)
      .set({ nextSeq: sql`${session.nextSeq} + 1`, updatedAt: new Date() })
      .where(eq(session.id, this.id))
      .returning({ nextSeq: session.nextSeq });
    const createdAt = new Date();
    if (!row) throw new Error("会话已删除");
    const safe = sanitizeForJson(redactEventForClient(data));
    const event: SessionEvent = { seq: row.nextSeq, type, data: safe, createdAt: createdAt.toISOString() };
    try {
      await tx.insert(sessionEvent).values({
        id: crypto.randomUUID(),
        sessionId: this.id,
        seq: event.seq,
        type,
        data: safe,
        createdAt,
      });
    } catch (error) { throw error; }
    return event;
    });
    this.events.push(event);
    return event;
  }
}

export async function loadSession(id: string): Promise<DbSession | null> {
  const [row] = await db.select().from(session).where(eq(session.id, id)).limit(1);
  if (!row) return null;
  const events = await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, id));
  events.sort((a, b) => a.seq - b.seq);
  return new DbSession(
    row.id,
    row.preset as SessionPreset,
    events.map((item) => ({
      seq: item.seq,
      type: item.type,
      data: item.data,
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt ? String(item.createdAt) : undefined,
    })),
  );
}
