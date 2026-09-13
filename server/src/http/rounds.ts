import { and, count, eq, sql } from "drizzle-orm";

import { db } from "../db/client.ts";
import { afterSaleRecord, session, sessionEvent } from "../db/schema.ts";

export function countInvestigationRounds(events: { type: string; data?: Record<string, unknown> | null }[]): number {
  const ended = events.filter((event) => event.type === "turn/end" && event.data?.reason !== "aborted").length;
  if (ended) return ended;
  const started = events.filter((event) => event.type === "turn/start").length;
  if (started) return started;
  return events.filter((event) => (
    event.type === "user/message"
    && (!event.data?.source || event.data.source === "human")
  )).length;
}

export async function recordRoundMap(): Promise<Map<string, number>> {
  const turns = await db
    .select({ recordId: session.recordId, n: count() })
    .from(sessionEvent)
    .innerJoin(session, eq(sessionEvent.sessionId, session.id))
    .where(and(
      eq(sessionEvent.type, "turn/end"),
      sql`coalesce(${sessionEvent.data}->>'reason', 'completed') <> 'aborted'`,
    ))
    .groupBy(session.recordId);
  const users = await db
    .select({ recordId: session.recordId, n: count() })
    .from(sessionEvent)
    .innerJoin(session, eq(sessionEvent.sessionId, session.id))
    .where(eq(sessionEvent.type, "user/message"))
    .groupBy(session.recordId);
  const map = new Map<string, number>();
  for (const row of users) map.set(row.recordId, Number(row.n));
  for (const row of turns) map.set(row.recordId, Number(row.n));
  return map;
}

export async function syncRecordRounds(recordId: string): Promise<number> {
  const sessions = await db.select({ id: session.id }).from(session).where(eq(session.recordId, recordId));
  const events = [];
  for (const item of sessions) {
    const rows = await db.select({ type: sessionEvent.type, data: sessionEvent.data }).from(sessionEvent).where(eq(sessionEvent.sessionId, item.id));
    events.push(...rows);
  }
  const rounds = countInvestigationRounds(events);
  await db.update(afterSaleRecord).set({ rounds, updatedAt: new Date() }).where(eq(afterSaleRecord.id, recordId));
  return rounds;
}
